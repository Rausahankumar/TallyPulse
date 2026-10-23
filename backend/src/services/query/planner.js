"use strict";

// --------------------------------------------------
// Claude PLANNER for the Sales/Purchase Query Engine (Phase 1F).
//
// Role: turn a question into a Query DSL plan - and nothing else. It is the ONLY natural-language
// interpreter: there is no deterministic router in front of it.
//
//   question (+ the previous turn's structured plan, for follow-ups) -> ONE structured call
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
// Token discipline: one call, forced tool choice, no chat history (only the previous structured plan), no tenant data,
// static system prompt + tool schema marked cacheable, max_tokens capped.
// --------------------------------------------------

const catalog = require("./semanticCatalog");
const { parseQueryPlan, queryPlanJsonSchema } = require("./queryPlan.schema");
const { validateQueryPlan } = require("./validator");

// ---------------------------------------------------------------- safety gate + product definitions (shared policy)

// Input containing operator characters, tenant/company/database terms or prompt-injection phrasing is refused outright:
// Claude never sees it.
const UNSAFE_INPUT = [
  /[${}`\\<>;|[\]]/, // Mongo operators, JSON, JS/shell/HTML/pipeline characters
  /[\u0000-\u001f\u007f]/,
  /\b(?:tenant\s*id|tenantid|tenant|company\s*guid|companyguid|company\s*id|companyid|guid|objectid|mongo\w*|mongoose|db\s*\.\s*\w+)\b/i,
  /__proto__|\bconstructor\b|\bprototype\b/i,
  /\b(?:ignore|disregard|forget)\b.{0,30}\b(?:previous|prior|above|earlier|all)\b.{0,30}\b(?:instructions?|rules?|prompts?)\b/i,
  /\b(?:system\s+prompt|jailbreak|you\s+are\s+now|act\s+as|developer\s+mode)\b/i,
  /\b(?:drop|delete|truncate|update|insert)\s+(?:table|collection|database|from)\b/i,
];

/** The safety gate applied before any Claude call. */
function isUnsafeQuestion(question) {
  return typeof question !== "string" || UNSAFE_INPUT.some((re) => re.test(question));
}

// "Revenue" has ONE fixed meaning in TallyPulse: the pre-tax value of the items on active sales invoices
// (lineAmount). Stated on every answer so the basis is never hidden.
const REVENUE_ASSUMPTION = {
  code: "revenue_is_pre_tax_item_value",
  message: "Revenue = pre-tax value of the items sold (excludes GST, freight and other non-item charges, and invoices without item lines); gross of returns.",
};
// Same word test on every AI path (planner guard, chat fallbacks), so "revenue" can never reach a
// path that reads it as the tax-inclusive Sales total.
const REVENUE_RE = /\brevenues?\b/i;
const mentionsRevenue = (text) => typeof text === "string" && REVENUE_RE.test(text);

// "New customer/supplier" needs the ledger master; it cannot be read off a comparison of two periods.
const NEW_PARTY_REASON = 'A "new customer" (or supplier) is one whose Tally ledger was created in the period and who traded in it. That cannot be read off a comparison of two periods (a returning customer is not new), so ask it directly with one period, for example "new customers this month".';
// Decision 2 (final, 2026-09-28): "this month vs last month" = month to date vs the COMPLETE previous calendar month.
const MONTH_FULL_NOTE = { code: "month_vs_complete_previous_month", message: 'This month so far is compared with the complete previous month (the product\'s standard month comparison). Ask for "same period last month" to compare the same days.' };

const { CATALOG, LIMITS } = catalog;

const PLANNER_TOOL_NAME = "submit_query_plan";
const PLANNER_MAX_TOKENS = 700;
const PLANNER_MAX_QUESTION_CHARS = 600;
// Bounded planner call (the chat frontend gives up after 60s; the rest of the turn - freshness,
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

// The previous STRUCTURED plan of the conversation (follow-ups). It is untrusted input: it must pass the same strict
// schema as any plan, otherwise it is ignored (the question is then planned exactly as without one). Only the plan -
// never chat text, answers, tool results or figures - and it is shown to Claude without its default fields.
function readPreviousPlan(previousPlan) {
  if (previousPlan === undefined || previousPlan === null) return null;
  const parsed = parseQueryPlan(previousPlan);
  if (!parsed.ok) return null;
  const compact = {};
  for (const [k, v] of Object.entries(parsed.plan)) {
    if (v === null || (Array.isArray(v) && v.length === 0)) continue;
    if ((k === "totals" && v === true) || (k === "explain" && v === "none")) continue;
    compact[k] = v;
  }
  return { plan: parsed.plan, json: JSON.stringify(compact) };
}

function previousPlanMessage(json, text) {
  return [
    "Previous query plan (structured JSON). The question below may refine or modify it:",
    json,
    "Interpret the question in that context and return one complete new plan that follows the same rules. Keep whatever the question does not change. If the question is not a follow-up, ignore the previous plan.",
    `Question: ${text}`,
  ].join("\n");
}

// Years in the previous plan's own dates were stated by the user in an earlier turn (and validated then), so a follow-up
// that keeps that period is not "inventing" a year.
function plannedYears(plan) {
  const years = new Set();
  const add = (p) => {
    if (!p) return;
    if (p.kind === "custom") {
      years.add(Number(p.from.slice(0, 4)));
      years.add(Number(p.to.slice(0, 4)));
    } else if (p.kind === "specific_fy") {
      years.add(Number(p.fy.slice(0, 4)));
      years.add(Number(p.fy.slice(0, 4)) + 1);
    }
  };
  add(plan.period);
  if (plan.compare && plan.compare.mode === "custom") add(plan.compare.period);
  return years;
}

function datesStated(plan, text, previous = null) {
  const years = statedYears(String(text));
  if (previous) for (const y of plannedYears(previous)) years.add(y);
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
 * @param {number} [options.maxRepairs=0] 0 or 1: one extra call that returns only validator error codes
 * @param {object} [options.previousPlan] the previous query plan of the conversation (structured plan only, optional). When it passes
 *        the plan schema it is added to the user message as JSON for follow-ups; when invalid it is ignored.
 */
async function planQuestion(question, options = {}) {
  const { claudeClient, resolveEntity, referenceDate } = options;
  const previous = readPreviousPlan(options.previousPlan);
  if (typeof claudeClient !== "function") throw new Error("planQuestion requires a claudeClient function.");
  const maxRepairs = Math.min(MAX_REPAIRS_CAP, Math.max(0, Number.isInteger(options.maxRepairs) ? options.maxRepairs : 0));
  const usage = newUsage();

  // ---- gate: Claude never sees unsafe, empty or oversized text
  if (typeof question !== "string" || !question.trim()) return { status: "unsupported", route: "honest_response", source: "planner_gate", code: "empty_question", reason: "The question is empty.", usage };
  if (isUnsafeQuestion(question)) return { status: "unsupported", route: "honest_response", source: "planner_gate", code: "unsafe_input", reason: "The question contains characters or terms that cannot be processed.", usage };
  const text = question.replace(/\s+/g, " ").trim();
  if (text.length > PLANNER_MAX_QUESTION_CHARS) return { status: "needs_clarification", route: "honest_response", source: "planner_gate", code: "question_too_long", reason: "Please shorten the question.", usage };

  const prompt = getPlannerPrompt();
  let messages = [{ role: "user", content: previous ? previousPlanMessage(previous.json, text) : text }];
  let lastFailure = null;

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    // Client disconnected (Stop): no first call and no repair call.
    if (options.signal && options.signal.aborted) return failed("planner_call_failed", "The request was cancelled.", usage, { retryable: true });
    let response;
    usage.calls += 1;
    try {
      response = await claudeClient(
        {
          system: prompt.system,
          messages,
          tools: [prompt.tool],
          tool_choice: { type: "tool", name: PLANNER_TOOL_NAME },
          max_tokens: PLANNER_MAX_TOKENS,
        },
        { signal: options.signal || null }
      );
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
    if (!datesStated(parsed.plan, text, previous && previous.plan)) {
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
      definitionNotes.push(MONTH_FULL_NOTE);
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

// ---------------------------------------------------------------- real Anthropic client (not used by tests)

/**
 * Production planner client: same request shape the fake client receives. Lazily reads the key.
 * Bounded: explicit maxRetries (never the SDK default), a per-attempt timeout, and an overall deadline
 * that aborts the in-flight request and rejects with code PLANNER_DEADLINE_EXCEEDED.
 * `sdkOptions` exists only so tests can point a real SDK client at a local stub (never api.anthropic.com).
 */
function createAnthropicPlannerClient({ attemptTimeoutMs = PLANNER_ATTEMPT_TIMEOUT_MS, maxRetries = PLANNER_MAX_RETRIES, deadlineMs = PLANNER_DEADLINE_MS, sdkOptions = {} } = {}) {
  let client = null;
  return async function anthropicPlannerClient(request, { signal } = {}) {
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
    // The caller's signal (client disconnected) aborts the same in-flight request as the deadline does.
    const onClientAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) onClientAbort();
      else signal.addEventListener("abort", onClientAbort, { once: true });
    }
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
      if (signal) signal.removeEventListener("abort", onClientAbort);
    }
  };
}

module.exports = {
  planQuestion,
  createAnthropicPlannerClient,
  getPlannerPrompt,
  PLANNER_TOOL_NAME,
  PLANNER_MAX_TOKENS,
  PLANNER_MAX_QUESTION_CHARS,
  PLANNER_ATTEMPT_TIMEOUT_MS,
  PLANNER_MAX_RETRIES,
  PLANNER_DEADLINE_MS,
  DECLINE_CODES,
  REVENUE_ASSUMPTION,
};
