"use strict";

// --------------------------------------------------
// Claude PLANNER for the Sales/Purchase Query Engine (Phase 1F).
//
// Role: turn a question the deterministic router could not handle
// (status "needs_planner") into a Query DSL plan - and nothing else.
//
//   question --router--> supported / unsupported  -> Claude is NOT called
//                        needs_planner            -> ONE structured call
//   Claude's answer is only ever DATA:
//     tool input -> strict schema (layer 1) -> semantic validator (layer 2)
//     -> tenant-scoped entity resolution -> plan handed to the same
//     compiler/executor/cache as every other plan.
//
// What Claude can never do here (structurally, not by instruction):
//   * reach MongoDB: it has no tool except submit_query_plan, and that tool's
//     input is a closed schema (unknown keys rejected, ids are enums);
//   * choose tenant/company: neither concept exists in the prompt, the tool
//     schema, or any function signature in this file - tenant scope is applied
//     later by the server-side executor;
//   * write raw MongoDB: operators/expressions are not representable;
//   * invent entities: every customer/supplier/product/group name in a filter
//     is re-resolved against the tenant's own data (injected resolver) and
//     replaced with the stored spelling, or the plan is refused.
//
// Token discipline: one call, forced tool choice, no history, no tenant data,
// static system prompt + tool schema marked cacheable, max_tokens capped.
// --------------------------------------------------

const catalog = require("./semanticCatalog");
const { parseQueryPlan, queryPlanJsonSchema } = require("./queryPlan.schema");
const { validateQueryPlan } = require("./validator");
const { routeQuestion, isUnsafeQuestion, mentionsRevenue, REVENUE_ASSUMPTION, NEW_PARTY_REASON, NOTES } = require("./localRouter");

const { CATALOG, LIMITS } = catalog;

const PLANNER_TOOL_NAME = "submit_query_plan";
const PLANNER_MAX_TOKENS = 700;
const PLANNER_MAX_QUESTION_CHARS = 600;
// Bounded planner call (the chat frontend gives up after 60s; the rest of the turn - router, freshness,
// engine with its 8s maxTimeMS, persistence - must still fit). One SDK retry at most, each attempt capped,
// and an overall deadline that aborts the request whatever the SDK is doing.
const PLANNER_ATTEMPT_TIMEOUT_MS = 15000;
const PLANNER_MAX_RETRIES = 1;
const PLANNER_DEADLINE_MS = 30000;
const DEFAULT_PLANNER_MODEL = "claude-sonnet-4-5-20250929";
const MAX_REPAIRS_CAP = 1;
const VALIDATION_FALLBACK_REF = new Date(2025, 0, 15, 12, 0, 0);

const DECLINE_CODES = ["unsupported_domain", "needs_clarification", "not_a_data_query"];
const NAME_DIMENSIONS = new Set(["customer", "supplier", "product", "productGroup"]);

// Router outcomes where Claude cannot add anything the router did not already know:
// the name does not exist, or the missing fact (year / period / window) is the USER's to state.
// Guessing those would be an invented assumption about financial scope, so no call is made.
const SKIP_ROUTER_CODES = new Set([
  "entity_not_resolved",
  "question_too_long",
  "year_missing",
  "ambiguous_period",
  "invalid_fy",
  "unsupported_window",
  "period_missing",
  // period wording the DSL cannot express; the planner has no reference date, so it could only guess dates
  "period_label_unsupported",
  "relative_offset_unsupported",
  "open_ended_range",
  // P-SF: the missing fact is which party / which direction / which measure - the user's to state
  "who_ambiguous",
  "threshold_direction_missing",
  "vague_performance",
]);

// ---------------------------------------------------------------- prompt + tool (built once from the catalog)

let memo = null;

function buildCatalogDigest() {
  const metricLines = Object.values(CATALOG.metrics)
    .filter((m) => m.status === "supported")
    .map((m) => `${m.id} (${m.entities.join("/")}; ${m.grain})`);
  const dimLines = Object.values(CATALOG.dimensions).map((d) => {
    const extra = d.id === "date" ? ` buckets ${d.buckets.join("|")}` : "";
    return `${d.id} (${d.entities.join("/")}; ${(d.grains || []).join("+")})${extra}`;
  });
  return [
    "You translate ONE business question about Sales or Purchase data into ONE query plan by calling submit_query_plan. Never answer in prose. Never state figures.",
    `Entities: ${Object.values(CATALOG.entities).map((e) => `${e.id} (party dimension: ${e.partyDimension})`).join(", ")}. One entity per plan.`,
    `Metrics: ${metricLines.join("; ")}.`,
    `Dimensions (groupBy, max ${LIMITS.maxGroupBy}): ${dimLines.join("; ")}.`,
    "Rules: invoice-grain metrics (amount/count/average) cannot be grouped or filtered by product or productGroup - use lineAmount/quantity for those. Never mix invoice-grain and line-grain metrics in one plan. A date groupBy needs a bucket and cannot be combined with compare.",
    `Period kinds: ${catalog.PERIOD_KINDS.filter((k) => k !== "ytd").join(", ")}; custom needs from/to as YYYY-MM-DD; specific_fy needs fy like 2024-25. compare modes: ${CATALOG.compare.modes.join(", ")} (custom needs a period). all_time cannot be compared. Financial year is April-March.`,
    "having/sort may reference a selected metric or, when compare is set, metric.previous / metric.delta / metric.deltaPct. limit <= " + LIMITS.maxLimit + ".",
    '"Revenue" has one fixed meaning: the pre-tax value of the items sold = entity sales with metric lineAmount (never invoiceAmount, invoiceCount or averageInvoiceValue). If a revenue question needs purchases or an invoice-level metric, decline.',
    "Copy customer/supplier/product/group names exactly as the user wrote them; never invent names. Never add a period the user did not state unless the question clearly implies one.",
    'If the question needs anything else (tax/GST, profit, returns/credit notes, payments/outstanding, orders, stock valuation, forecasts, explanations) or is truly ambiguous (for example "this year" without saying financial or calendar), do NOT guess: send decline {code, message}. Otherwise send plan, plus up to 3 short assumptions you made.',
  ].join("\n");
}

function getPlannerPrompt() {
  if (!memo) {
    memo = {
      system: [{ type: "text", text: buildCatalogDigest(), cache_control: { type: "ephemeral" } }],
      tool: {
        name: PLANNER_TOOL_NAME,
        description: "Submit the query plan for the question, or decline it. Call exactly once.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            plan: queryPlanJsonSchema(),
            decline: {
              type: "object",
              additionalProperties: false,
              properties: {
                code: { type: "string", enum: DECLINE_CODES },
                message: { type: "string", maxLength: 200 },
              },
              required: ["code"],
            },
            assumptions: { type: "array", maxItems: 3, items: { type: "string", maxLength: 160 } },
          },
        },
        cache_control: { type: "ephemeral" },
      },
    };
  }
  return memo;
}

// ---------------------------------------------------------------- helpers

const CONTROL = /[\u0000-\u001f\u007f]/g;
// Anything Claude wrote is untrusted display text: no control chars, bounded, never fed to the engine.
function cleanText(value, max) {
  return typeof value === "string" ? value.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== "object") return;
  for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    if (Number.isFinite(usage[k])) total[k] += usage[k];
  }
}

function newUsage() {
  return { calls: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

const REVENUE_BASIS_REFUSAL = 'Revenue in TallyPulse means the pre-tax value of the items sold, and this question can\'t be answered on that basis. Ask for revenue on its own (for example "revenue last month" or "top 5 customers by revenue this month"), or ask for sales if you want tax-inclusive invoice totals.';

function isRevenuePlan(plan) {
  const metrics = plan.metrics || [];
  return plan.entity === "sales" && metrics.includes("lineAmount") && metrics.every((m) => CATALOG.metrics[m] && CATALOG.metrics[m].grain === "line");
}

// Years the user actually wrote: 2025, '25, 2025-26, 24-25 (both years of an FY label).
function statedYears(text) {
  const years = new Set();
  for (const m of text.matchAll(/\b(20\d{2})\b/g)) years.add(Number(m[1]));
  for (const m of text.matchAll(/\b(?:20)?(\d{2})\s*-\s*(\d{2})\b/g)) {
    years.add(2000 + Number(m[1]));
    years.add(2000 + Number(m[2]));
  }
  for (const m of text.matchAll(/'(\d{2})\b/g)) years.add(2000 + Number(m[1]));
  return years;
}

function datesStated(plan, text) {
  const years = statedYears(String(text));
  const ok = (p) => {
    if (!p) return true;
    if (p.kind === "custom") return years.has(Number(p.from.slice(0, 4))) && years.has(Number(p.to.slice(0, 4)));
    if (p.kind === "specific_fy") return years.has(Number(p.fy.slice(0, 4))) || years.has(Number(p.fy.slice(0, 4)) + 1);
    return true; // relative kinds stay symbolic: the server resolves them with the tenant reference date
  };
  return ok(plan.period) && (!plan.compare || plan.compare.mode !== "custom" || ok(plan.compare.period));
}

// Product rules the planner's plan must follow, enforced here (never left to Claude):
//  decision 2 - "this month vs last month" compares with the COMPLETE previous month unless the user asked for the
//               same days; decision 3 - "new customer/supplier" (absent in the comparison period) is not answerable
//               without the party master.
const SAME_DAYS_WORDING = /\b(?:same (?:period|days|dates|date range|number of days|day count|elapsed days)|like[- ]for[- ]like|month[- ]to[- ]date|lmtd|same[- ]day[- ]count)\b/i;
const isNewPartyPlan = (plan) =>
  (plan.groupBy || []).some((g) => g.dim === "customer" || g.dim === "supplier") &&
  (plan.having || []).some((h) => /\.previous$/.test(h.metric) && h.op === "eq" && h.value === 0);

const failed = (code, reason, usage, extra = {}) => ({ status: "planner_failed", route: "honest_response", source: "claude_planner", code, reason, usage, ...extra });

// ---------------------------------------------------------------- the planner

/**
 * @param {string} question
 * @param {object} options
 * @param {Function} options.claudeClient async ({system, messages, tools, tool_choice, max_tokens}) => Anthropic-shaped response
 * @param {Function} [options.resolveEntity] tenant-scoped resolver (server-supplied); re-verifies every name Claude used
 * @param {Date} [options.referenceDate] only for running the semantic validator
 * @param {string} [options.routerCode] the router's needs_planner code (optional one-word hint)
 * @param {number} [options.maxRepairs=0] 0 or 1: one extra call that returns only validator error codes
 */
async function planQuestion(question, options = {}) {
  const { claudeClient, resolveEntity, referenceDate, routerCode } = options;
  if (typeof claudeClient !== "function") throw new Error("planQuestion requires a claudeClient function.");
  const maxRepairs = Math.min(MAX_REPAIRS_CAP, Math.max(0, Number.isInteger(options.maxRepairs) ? options.maxRepairs : 0));
  const usage = newUsage();

  // ---- gate: Claude never sees unsafe, empty or oversized text
  if (typeof question !== "string" || !question.trim()) return { status: "unsupported", route: "honest_response", source: "planner_gate", code: "empty_question", reason: "The question is empty.", usage };
  if (isUnsafeQuestion(question)) return { status: "unsupported", route: "honest_response", source: "planner_gate", code: "unsafe_input", reason: "The question contains characters or terms that cannot be processed.", usage };
  const text = question.replace(/\s+/g, " ").trim();
  if (text.length > PLANNER_MAX_QUESTION_CHARS) return { status: "needs_clarification", route: "honest_response", source: "planner_gate", code: "question_too_long", reason: "Please shorten the question.", usage };

  const prompt = getPlannerPrompt();
  const hint = typeof routerCode === "string" && /^[a-z_]{3,40}$/.test(routerCode) ? `\n(router hint: ${routerCode})` : "";
  let messages = [{ role: "user", content: `${text}${hint}` }];
  let lastFailure = null;

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    let response;
    usage.calls += 1;
    try {
      response = await claudeClient({
        system: prompt.system,
        messages,
        tools: [prompt.tool],
        tool_choice: { type: "tool", name: PLANNER_TOOL_NAME },
        max_tokens: PLANNER_MAX_TOKENS,
      });
    } catch (error) {
      const timedOut = !!error && (error.code === "PLANNER_DEADLINE_EXCEEDED" || /timeout|timed out|abort/i.test(`${error.name} ${error.message}`));
      return timedOut
        ? failed("planner_timeout", "The planning service did not respond in time.", usage, { retryable: true })
        : failed("planner_call_failed", "The planning service is unavailable right now.", usage, { retryable: true });
    }
    addUsage(usage, response && response.usage);

    // ---- protocol: exactly one submit_query_plan tool_use, nothing else that matters
    const blocks = response && Array.isArray(response.content) ? response.content : [];
    const toolUses = blocks.filter((b) => b && b.type === "tool_use");
    if (toolUses.length !== 1 || toolUses[0].name !== PLANNER_TOOL_NAME || !isPlainObject(toolUses[0].input)) {
      return failed("planner_protocol_violation", "The planner did not return exactly one structured plan.", usage);
    }
    const input = toolUses[0].input;
    const extraKeys = Object.keys(input).filter((k) => !["plan", "decline", "assumptions"].includes(k));
    const hasPlan = Object.prototype.hasOwnProperty.call(input, "plan");
    const hasDecline = Object.prototype.hasOwnProperty.call(input, "decline");
    if (extraKeys.length || hasPlan === hasDecline) {
      return failed("planner_protocol_violation", "The planner output had an unexpected shape.", usage);
    }

    // ---- decline
    if (hasDecline) {
      const d = input.decline;
      if (!isPlainObject(d) || !DECLINE_CODES.includes(d.code)) return failed("planner_protocol_violation", "The planner decline was malformed.", usage);
      const message = cleanText(d.message, 200) || "This question cannot be answered with the available Sales/Purchase queries.";
      return d.code === "needs_clarification"
        ? { status: "needs_clarification", route: "honest_response", source: "claude_planner", code: "planner_needs_clarification", reason: message, usage }
        : { status: "unsupported", route: "honest_response", source: "claude_planner", code: `planner_${d.code}`, reason: message, usage };
    }

    // ---- plan: schema -> validator (same layers the engine enforces again at execution)
    const parsed = parseQueryPlan(input.plan);
    let errors = null;
    let validation = null;
    if (!parsed.ok) errors = (parsed.errors || []).map((e) => ({ code: e.code, path: e.path }));
    else {
      validation = validateQueryPlan(parsed.plan, { referenceDate: referenceDate || VALIDATION_FALLBACK_REF });
      if (!validation.ok) errors = validation.errors.map((e) => ({ code: e.code, path: e.path }));
    }
    if (errors) {
      lastFailure = errors;
      if (attempt < maxRepairs) {
        // One repair round: only OUR validator's codes go back (no user data, no tenant data).
        messages = [
          messages[0],
          { role: "assistant", content: [toolUses[0]] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: toolUses[0].id, is_error: true, content: `Rejected by validator: ${errors.slice(0, 5).map((e) => `${e.code}@${e.path || "/"}`).join(", ")}. Resubmit a corrected plan or decline.` }] },
        ];
        continue;
      }
      return failed("planner_invalid_plan", "The planner produced a plan the query engine cannot run.", usage, { errors: errors.slice(0, 5) });
    }

    // ---- revenue basis: enforced here, not trusted to the prompt. A revenue question may only become the
    // pre-tax item-value plan (sales + lineAmount, no invoice-level metric); anything else is refused -
    // never answered as the tax-inclusive Sales total.
    const revenue = mentionsRevenue(text);
    if (revenue && !isRevenuePlan(parsed.plan)) {
      return { status: "unsupported", route: "honest_response", source: "revenue_guard", code: "revenue_basis_unsupported", reason: REVENUE_BASIS_REFUSAL, usage };
    }

    // ---- dates (P-SF): the planner is never given a date, so a literal year in its plan that the user did not
    // write would be invented. Custom ranges and specific FYs must use years stated in the question.
    if (!datesStated(parsed.plan, text)) {
      return { status: "needs_clarification", route: "honest_response", source: "date_guard", code: "year_missing", reason: "Which year do you mean?", usage };
    }

    // ---- entity names: re-resolved against the tenant's own data
    let plan = JSON.parse(JSON.stringify(parsed.plan));
    if (typeof resolveEntity === "function" && Array.isArray(plan.filters)) {
      for (const f of plan.filters) {
        if (!NAME_DIMENSIONS.has(f.dim) || (f.op !== "eq_ci" && f.op !== "in_ci")) continue;
        const values = Array.isArray(f.value) ? f.value : [f.value];
        const canonical = [];
        for (const v of values) {
          let matches = [];
          try {
            matches = ((await resolveEntity({ entity: plan.entity, hintDim: f.dim, text: v })) || {}).matches || [];
          } catch (e) {
            return failed("planner_entity_check_failed", "Names in the plan could not be verified.", usage);
          }
          if (matches.length !== 1) return failed("planner_entity_not_resolved", `"${cleanText(v, 60)}" did not match a known ${f.dim}.`, usage);
          canonical.push(matches[0].value);
        }
        f.value = Array.isArray(f.value) ? canonical : canonical[0];
      }
      const again = validateQueryPlan(plan, { referenceDate: referenceDate || VALIDATION_FALLBACK_REF });
      const reparsed = parseQueryPlan(plan);
      if (!again.ok || !reparsed.ok) return failed("planner_invalid_plan", "The plan was not valid after name verification.", usage);
      validation = again;
      plan = JSON.parse(JSON.stringify(reparsed.plan));
    }

    if (isNewPartyPlan(plan)) {
      return { status: "unsupported", route: "honest_response", source: "new_party_guard", code: "unsupported_new_party", reason: NEW_PARTY_REASON, usage };
    }
    const definitionNotes = revenue ? [REVENUE_ASSUMPTION] : [];
    if (plan.period.kind === "current_month" && plan.compare && plan.compare.mode === "like_for_like" && !SAME_DAYS_WORDING.test(text)) {
      plan.compare = { mode: "full_previous" };
      validation = validateQueryPlan(plan, { referenceDate: referenceDate || VALIDATION_FALLBACK_REF });
      if (!validation.ok) return failed("planner_invalid_plan", "The plan was not valid after applying the month comparison rule.", usage);
      definitionNotes.push(NOTES.MONTH_FULL_NOTE);
    }

    const plannerAssumptions = (Array.isArray(input.assumptions) ? input.assumptions : []).slice(0, 3).map((a) => cleanText(a, 160)).filter(Boolean);
    return {
      status: "supported",
      route: "query_engine",
      source: "claude_planner",
      plan,
      plannerAssumptions,
      definitionNotes,
      assumptions: validation.assumptions,
      warnings: validation.warnings,
      usage,
    };
  }
  return failed("planner_invalid_plan", "The planner produced a plan the query engine cannot run.", usage, { errors: (lastFailure || []).slice(0, 5) });
}

// ---------------------------------------------------------------- router -> planner

/**
 * The deterministic router always goes first. Claude is called ONLY when it says needs_planner
 * (and not for the dead-end codes in SKIP_ROUTER_CODES). No tenant argument exists here.
 */
async function routeAndPlan(question, { resolveEntity, claudeClient, referenceDate, maxRepairs } = {}) {
  const route = await routeQuestion(question, { resolveEntity, referenceDate });
  if (route.status !== "needs_planner") return { route, planner: null, final: route, claudeCalled: false };
  if (SKIP_ROUTER_CODES.has(route.code)) {
    const final = { status: "needs_clarification", route: "honest_response", source: "router", code: route.code, reason: route.reason };
    return { route, planner: null, final, claudeCalled: false };
  }
  const planner = await planQuestion(question, { claudeClient, resolveEntity, referenceDate, routerCode: route.code, maxRepairs });
  return { route, planner, final: planner, claudeCalled: planner.usage.calls > 0 };
}

// ---------------------------------------------------------------- real Anthropic client (not used by tests)

/**
 * Production planner client: same request shape the fake client receives. Lazily reads the key.
 * Bounded: explicit maxRetries (never the SDK default), a per-attempt timeout, and an overall deadline
 * that aborts the in-flight request and rejects with code PLANNER_DEADLINE_EXCEEDED.
 * `sdkOptions` exists only so tests can point a real SDK client at a local stub (never api.anthropic.com).
 */
function createAnthropicPlannerClient({ attemptTimeoutMs = PLANNER_ATTEMPT_TIMEOUT_MS, maxRetries = PLANNER_MAX_RETRIES, deadlineMs = PLANNER_DEADLINE_MS, sdkOptions = {} } = {}) {
  let client = null;
  return async function anthropicPlannerClient(request) {
    if (!client) {
      const Anthropic = require("@anthropic-ai/sdk");
      const apiKey = sdkOptions.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        const err = new Error("AI planner is not configured: ANTHROPIC_API_KEY is missing on the backend.");
        err.code = "AI_NOT_CONFIGURED";
        throw err;
      }
      client = new Anthropic({ ...sdkOptions, apiKey, maxRetries, timeout: attemptTimeoutMs });
    }
    const controller = new AbortController();
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Planner deadline of ${deadlineMs}ms exceeded.`);
        err.code = "PLANNER_DEADLINE_EXCEEDED";
        controller.abort(err);
        reject(err);
      }, deadlineMs);
    });
    try {
      return await Promise.race([
        client.messages.create(
          { model: process.env.ANTHROPIC_PLANNER_MODEL || process.env.ANTHROPIC_MODEL || DEFAULT_PLANNER_MODEL, temperature: 0, ...request },
          { timeout: attemptTimeoutMs, maxRetries, signal: controller.signal }
        ),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = {
  planQuestion,
  routeAndPlan,
  createAnthropicPlannerClient,
  getPlannerPrompt,
  PLANNER_TOOL_NAME,
  PLANNER_MAX_TOKENS,
  PLANNER_MAX_QUESTION_CHARS,
  PLANNER_ATTEMPT_TIMEOUT_MS,
  PLANNER_MAX_RETRIES,
  PLANNER_DEADLINE_MS,
  SKIP_ROUTER_CODES,
  DECLINE_CODES,
};
