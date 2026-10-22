"use strict";

const { parseQueryPlan, queryPlanJsonSchema } = require("./queryPlan.schema");
const { validateQueryPlan } = require("./validator");
const planner = require("./planner");
const { parseAnalysisPlan, MAX_STEPS, MAX_INPUT_VALUES } = require("./analysisPlan");
const insightTools = require("../analytics/insightTools");
const catalog = require("./semanticCatalog");

// --------------------------------------------------
// Analysis planner (Milestone 2): turns ONE question the query planner declined with `needs_analysis` into an analysis plan
// (analysisPlan.js) - several existing query steps and insight-tool steps - with ONE forced tool call (submit_analysis_plan)
// and at most ONE repair call that carries only our own validator codes. No question-specific logic: the model composes
// steps from capabilities that are GENERATED from the same catalog digest, Query Plan schema and insight-tool schemas.
//
// Every step is checked before anything runs: the analysis-plan structure (ids, dependencies, budgets), each query step with
// the query validator and the SAME question-level guards as the query planner (planner.checkPlannedQuery: decided terms,
// revenue basis, years the user never wrote, new-party comparisons), each insight step with its strict argument schema and
// the year guard. The tenant is never part of a plan. Names, freshness, coverage and execution limits are applied by the
// executor (analysisPlan.executeAnalysisPlan).
// --------------------------------------------------

const ANALYSIS_TOOL_NAME = "submit_analysis_plan";
const ANALYSIS_MAX_TOKENS = 1500; // up to 4 steps of query plans
const MAX_REPAIRS_CAP = 1;
const DECLINE_CODES = ["unsupported_domain", "needs_clarification", "not_a_data_query"];
// Insight tools offered to the model (an explicit allowlist over the registry). product_margin is an INDICATIVE margin only:
// a question about accounting profit, COGS or gross/net margin is refused even when the plan asks for it (checkAnalysis).
const ANALYSIS_TOOL_IDS = ["discount_summary", "product_rates", "product_margin", "product_trend", "supplier_rates"];
// Catalog limitations of ONE query that an analysis plan removes by construction: sales and purchases can be measured in
// separate steps (each result is shown as measured; no figure is ever computed across entities).
const ANALYSIS_LIFTS = new Set(catalog.CATALOG.unsupported.filter((u) => u.multiStep).map((u) => u.id)); // from the catalog's multiStep flag

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const cleanText = (value, max) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const newUsage = () => ({ calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
function addUsage(total, usage) {
  if (!usage) return;
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) total[k] += Number(usage[k]) || 0;
}
const failed = (code, reason, usage, extra = {}) => ({ status: "planner_failed", route: "honest_response", source: "analysis_planner", code, reason, usage, ...extra });

// ---------------------------------------------------------------- prompt + tool (built once, generated)

let memo = null;

function buildAnalysisPrompt() {
  // The query planner's catalog digest (metrics, dimensions, rules, periods, vocabulary) is reused as it is, without its
  // first line (its own task) and its last line (its own decline rule): both are replaced below.
  const lines = planner.buildCatalogDigest().split("\n");
  if (!lines[0].startsWith("You translate ") || !lines[lines.length - 1].startsWith("If the question needs something")) {
    throw new Error("analysis prompt: the catalog digest layout changed (first/last line)");
  }
  const tools = insightTools.listInsightTools().filter((t) => ANALYSIS_TOOL_IDS.includes(t.id));
  const unsupported = catalog.CATALOG.unsupported.filter((u) => !ANALYSIS_LIFTS.has(u.id)).map((u) => catalog.unsupportedLabel(u)).join("; ");
  return [
    `You turn ONE business question into an analysis plan of 1-${MAX_STEPS} steps by calling ${ANALYSIS_TOOL_NAME}. Never answer in prose. Never state figures or causes: steps only measure.`,
    `Step kinds: "query" = one query plan (rules below); "insight" = one tool: ${tools.map((t) => `${t.id} (${t.description})`).join(" ")}`,
    `A query step may have inputs [{fromStep, dim, take<=${MAX_INPUT_VALUES}}]: the first take group keys of an EARLIER query step grouped by dim become its filter. An earlier step ranked by change (sort metric.delta/deltaPct) must also keep only that direction with having (asc: metric.delta lt 0; desc: gt 0). Use the fewest steps that measure what the question asks; prefer query steps.`,
    ...lines.slice(1, -1),
    `If the data cannot answer it (${unsupported}), or it needs a forecast, or is truly ambiguous, send decline {code, message}.`,
  ].join("\n");
}

function buildAnalysisTool() {
  const argSchemas = insightTools.insightToolArgsJsonSchemas();
  const stepId = { type: "string", pattern: "^[a-z][a-z0-9_]{0,23}$" };
  const querySchema = queryPlanJsonSchema();
  const insightSteps = ANALYSIS_TOOL_IDS.map((id) => ({
    type: "object",
    additionalProperties: false,
    properties: { id: stepId, kind: { const: "insight" }, tool: { const: id }, args: argSchemas[id] },
    required: ["id", "kind", "tool", "args"],
  }));
  return {
    name: ANALYSIS_TOOL_NAME,
    description: "Submit the analysis plan for the question, or decline it. Call exactly once.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        analysis: {
          type: "object",
          additionalProperties: false,
          properties: {
            v: { const: 1 },
            steps: {
              type: "array",
              minItems: 1,
              maxItems: MAX_STEPS,
              items: {
                anyOf: [
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      id: stepId,
                      kind: { const: "query" },
                      plan: querySchema,
                      inputs: {
                        type: "array",
                        maxItems: 2,
                        items: { type: "object", additionalProperties: false, properties: { fromStep: stepId, dim: { enum: ["customer", "supplier", "product", "productGroup"] }, take: { type: "integer", minimum: 1, maximum: MAX_INPUT_VALUES } }, required: ["fromStep", "dim", "take"] },
                      },
                    },
                    required: ["id", "kind", "plan"],
                  },
                  ...insightSteps,
                ],
              },
            },
          },
          required: ["v", "steps"],
        },
        decline: { type: "object", additionalProperties: false, properties: { code: { type: "string", enum: DECLINE_CODES }, message: { type: "string", maxLength: 200 } }, required: ["code"] },
        assumptions: { type: "array", maxItems: 3, items: { type: "string", maxLength: 160 } },
      },
    },
    cache_control: { type: "ephemeral" },
  };
}

function getAnalysisPrompt() {
  if (!memo) memo = { system: [{ type: "text", text: buildAnalysisPrompt(), cache_control: { type: "ephemeral" } }], tool: buildAnalysisTool() };
  return memo;
}

// ---------------------------------------------------------------- validation (no database)

/**
 * Everything that can be checked before execution. Returns { errors } (repairable: our own codes), { refusal } (a decided
 * rule: final, never repaired) or { plan, notes } (the plan after the decided rewrites; definition notes by step id).
 */
function checkAnalysis(question, rawAnalysis, referenceDate) {
  const parsed = parseAnalysisPlan(rawAnalysis);
  if (!parsed.ok) return { errors: parsed.errors.map((e) => ({ code: e.code, path: e.path })) };
  // An indicative margin is never the answer to an accounting-profit question (profit, COGS, gross/net margin): refused with
  // the catalog's own reason, exactly like the query planner's profit refusal. Final, never repaired.
  if (parsed.plan.steps.some((s) => s.kind === "insight" && s.tool === "product_margin") && planner.mentionsAccountingProfit(question)) {
    const reason = (catalog.CATALOG.unsupported.find((u) => u.id === "profit_margin") || {}).reason || "Accounting profit cannot be calculated.";
    return { refusal: { status: "unsupported", source: "profit_guard", code: "profit_margin_unsupported", reason } };
  }
  const errors = [];
  for (const [i, step] of parsed.plan.steps.entries()) {
    if (step.kind === "insight") {
      if (!ANALYSIS_TOOL_IDS.includes(step.tool)) { errors.push({ code: "insight_tool_not_offered", path: `steps.${i}.tool` }); continue; }
      const args = insightTools.validateInsightArgs(step.tool, step.args);
      if (!args.ok) { for (const issue of args.issues) errors.push({ code: "invalid_insight_args", path: `steps.${i}.args.${issue.path}` }); continue; }
      const refusal = planner.checkPlannedQuery(question, { period: step.args.period, metrics: [], groupBy: [], having: [] });
      if (refusal) return { refusal };
      continue;
    }
    const qp = parseQueryPlan(step.plan);
    const v = validateQueryPlan(qp.plan, { referenceDate });
    if (!v.ok) { for (const e of v.errors.slice(0, 3)) errors.push({ code: e.code, path: `steps.${i}.plan.${e.path || ""}` }); continue; }
    const refusal = planner.checkPlannedQuery(question, qp.plan);
    if (refusal) return { refusal };
  }
  if (errors.length) return { errors };
  // The query planner's decided rewrites and definition notes (applyPlanRules, one implementation) for every query step, so a
  // step gives the same numbers and notes as the same plan asked on its own.
  const revenueNote = planner.mentionsRevenue(question) ? [planner.REVENUE_ASSUMPTION] : [];
  const notes = {};
  const steps = [];
  for (const [i, step] of parsed.plan.steps.entries()) {
    if (step.kind !== "query") { steps.push(step); continue; }
    const ruled = planner.applyPlanRules(question, parseQueryPlan(step.plan).plan, { referenceDate });
    if (ruled.error) return { errors: [{ code: "invalid_query_plan", path: `steps.${i}.plan` }] };
    if (revenueNote.length || ruled.notes.length) notes[step.id] = [...revenueNote, ...ruled.notes];
    steps.push({ ...step, plan: ruled.plan });
  }
  const final = parseAnalysisPlan({ ...parsed.plan, steps });
  if (!final.ok) return { errors: final.errors.map((e) => ({ code: e.code, path: e.path })) };
  return { plan: final.plan, notes };
}

// ---------------------------------------------------------------- the analysis planner

/**
 * @param {string} question the user's question (already through the query planner's safety gate)
 * @param {{claudeClient: Function, referenceDate: Date, maxRepairs?: number, signal?: AbortSignal}} options
 */
async function planAnalysis(question, options = {}) {
  const { claudeClient, referenceDate } = options;
  if (typeof claudeClient !== "function") throw new Error("planAnalysis requires a claudeClient function.");
  const maxRepairs = Math.min(MAX_REPAIRS_CAP, Math.max(0, Number.isInteger(options.maxRepairs) ? options.maxRepairs : 1));
  const usage = newUsage();
  const text = String(question || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > planner.PLANNER_MAX_QUESTION_CHARS) return { status: "unsupported", route: "honest_response", source: "analysis_planner", code: "empty_or_long_question", reason: "Please ask a shorter question.", usage };
  const prompt = getAnalysisPrompt();
  let messages = [{ role: "user", content: text }];

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    if (options.signal && options.signal.aborted) return failed("planner_call_failed", "The request was cancelled.", usage, { retryable: true });
    let response;
    usage.calls += 1;
    try {
      response = await claudeClient({ system: prompt.system, messages, tools: [prompt.tool], tool_choice: { type: "tool", name: ANALYSIS_TOOL_NAME }, max_tokens: ANALYSIS_MAX_TOKENS }, { signal: options.signal || null });
    } catch (error) {
      const timedOut = !!error && (error.code === "PLANNER_DEADLINE_EXCEEDED" || /timeout|timed out|abort/i.test(`${error.name} ${error.message}`));
      return timedOut ? failed("planner_timeout", "The planning service did not respond in time.", usage, { retryable: true }) : failed("planner_call_failed", "The planning service is unavailable right now.", usage, { retryable: true });
    }
    addUsage(usage, response && response.usage);

    const blocks = response && Array.isArray(response.content) ? response.content : [];
    const toolUses = blocks.filter((b) => b && b.type === "tool_use");
    if (toolUses.length !== 1 || toolUses[0].name !== ANALYSIS_TOOL_NAME || !isPlainObject(toolUses[0].input)) return failed("planner_protocol_violation", "The planner did not return exactly one structured analysis plan.", usage);
    const input = toolUses[0].input;
    const extra = Object.keys(input).filter((k) => !["analysis", "decline", "assumptions"].includes(k));
    const hasPlan = Object.prototype.hasOwnProperty.call(input, "analysis");
    const hasDecline = Object.prototype.hasOwnProperty.call(input, "decline");
    if (extra.length || hasPlan === hasDecline) return failed("planner_protocol_violation", "The planner output had an unexpected shape.", usage);

    if (hasDecline) {
      const d = input.decline;
      if (!isPlainObject(d) || !DECLINE_CODES.includes(d.code)) return failed("planner_protocol_violation", "The planner decline was malformed.", usage);
      const message = cleanText(d.message, 200) || "This question cannot be answered with the available Sales/Purchase analyses.";
      return d.code === "needs_clarification"
        ? { status: "needs_clarification", route: "honest_response", source: "analysis_planner", code: "analysis_needs_clarification", reason: message, usage }
        : { status: "unsupported", route: "honest_response", source: "analysis_planner", code: `analysis_${d.code}`, reason: message, usage };
    }

    const checked = checkAnalysis(text, input.analysis, referenceDate);
    if (checked.refusal) return { ...checked.refusal, route: "honest_response", usage };
    if (checked.plan) {
      const assumptions = (Array.isArray(input.assumptions) ? input.assumptions : []).slice(0, 3).map((a) => cleanText(a, 160)).filter(Boolean);
      return { status: "supported", route: "analysis", source: "analysis_planner", analysis: checked.plan, definitionNotes: checked.notes, assumptions, usage };
    }
    if (attempt < maxRepairs) {
      // One repair round: only OUR codes and paths go back (no data, no tenant).
      messages = [
        messages[0],
        { role: "assistant", content: [toolUses[0]] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUses[0].id, is_error: true, content: `Rejected: ${checked.errors.slice(0, 6).map((e) => `${e.code}@${e.path || "/"}`).join(", ")}. Resubmit a corrected analysis plan or decline.` }] },
      ];
      continue;
    }
    return failed("analysis_invalid_plan", "The planner produced an analysis plan that cannot be run.", usage, { errors: checked.errors.slice(0, 6) });
  }
  return failed("analysis_invalid_plan", "The planner produced an analysis plan that cannot be run.", usage);
}

module.exports = { planAnalysis, getAnalysisPrompt, checkAnalysis, ANALYSIS_TOOL_NAME, ANALYSIS_TOOL_IDS, ANALYSIS_MAX_TOKENS };
