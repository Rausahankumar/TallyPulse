"use strict";

const { z } = require("zod");
const catalog = require("./semanticCatalog");
const { parseQueryPlan } = require("./queryPlan.schema");
const { validateQueryPlan } = require("./validator");
const { formatQueryAnswer } = require("./answerFormatter");
const { assessCoverage } = require("../analytics/coverage");
const insightTools = require("../analytics/insightTools");

// --------------------------------------------------
// Analysis plans (Milestone 1): a general-purpose, multi-step plan made of the EXISTING capabilities, and a deterministic
// executor for it. No model is called here; the chat turn runs the plans the analysis planner writes (queryChat.answerAnalysis).
//
// A plan is a short list of steps. Each step is either
//   - "query":   an ordinary Query Plan (queryPlan.schema), run by the existing query engine (validator -> compiler ->
//                executor, through the same cached executor as Ask AI), or
//   - "insight": one tool of the insight registry (analytics/insightTools.js) with its own strict arguments.
// A query step may take its filter values from an EARLIER query step's result ("inputs"): the first N group keys of that
// step (customers, suppliers, products, product groups) become an in_ci filter. That is the only dependency primitive;
// there is no per-question logic, no arithmetic on results and no way to build a pipeline from the plan.
//
// Safeguards per step: the tenant comes from the context only (plans are strict, so a tenant inside a plan is rejected);
// typed names are re-resolved against the tenant's own data; the query validator; the freshness and coverage gates the chat
// turn uses (missing data is refused, never shown as zero); the engine's own maxTimeMS and row caps; the insight tools'
// explicit maxTimeMS. A step whose input is empty or failed is SKIPPED (never run without its filter). Budgets: at most
// MAX_STEPS steps and an overall deadline; steps that would start after it are skipped.
// --------------------------------------------------

const MAX_STEPS = 4;
const MAX_INPUTS_PER_STEP = 2;
const MAX_INPUT_VALUES = catalog.LIMITS.maxInValues; // an in_ci filter takes at most this many values
const DEFAULT_DEADLINE_MS = 25000; // leaves room inside the chat's 60 s request for planning and answering
const BINDABLE_DIMS = catalog.nameDimensionIds();
const NAME_DIMS = new Set(BINDABLE_DIMS);
const VOUCHER_TYPE_BY_ENTITY = { sales: "Sales", purchase: "Purchase", sales_return: "Credit Note", purchase_return: "Debit Note" };

// A source ranked by a change (its first sort key is metric.delta or metric.deltaPct) selects the biggest falls (asc) or rises
// (desc). Sorting alone does not decide the sign: with fewer falls than `take`, the next rows are rises. Such a source must keep
// only that direction with a having on the same metric's change that excludes zero (asc: lt <= 0 or lte < 0; desc: gt >= 0 or
// gte > 0), and the binding re-checks every taken row's computed delta.
const CHANGE_SUFFIXES = new Set(["delta", "deltaPct"]);
function changeRanking(plan) {
  const s = plan && Array.isArray(plan.sort) ? plan.sort[0] : null;
  const [base, suffix] = s && typeof s.by === "string" ? s.by.split(".") : [];
  return CHANGE_SUFFIXES.has(suffix) ? { base, sign: s.dir === "asc" ? -1 : 1 } : null;
}
function keepsSign(h, ranking) {
  const [base, suffix] = h && typeof h.metric === "string" ? h.metric.split(".") : [];
  if (base !== ranking.base || !CHANGE_SUFFIXES.has(suffix) || typeof h.value !== "number") return false;
  return ranking.sign < 0 ? (h.op === "lt" && h.value <= 0) || (h.op === "lte" && h.value < 0) : (h.op === "gt" && h.value >= 0) || (h.op === "gte" && h.value > 0);
}
const directionWord = (ranking) => (ranking.sign < 0 ? "fall" : "rise");

const stepId = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/, "lowercase letters, digits and _ (max 24)");
const inputSchema = z.strictObject({ fromStep: stepId, dim: z.enum(BINDABLE_DIMS), take: z.number().int().min(1).max(MAX_INPUT_VALUES) });
const queryStepSchema = z.strictObject({
  id: stepId,
  kind: z.literal("query"),
  plan: z.record(z.string(), z.unknown()),
  inputs: z.array(inputSchema).max(MAX_INPUTS_PER_STEP).default([]),
});
const insightStepSchema = z.strictObject({
  id: stepId,
  kind: z.literal("insight"),
  tool: z.enum(insightTools.listInsightTools().map((t) => t.id)),
  args: z.record(z.string(), z.unknown()).default({}),
});
const analysisPlanSchema = z.strictObject({
  v: z.literal(1),
  steps: z.array(z.discriminatedUnion("kind", [queryStepSchema, insightStepSchema])).min(1).max(MAX_STEPS),
});

/** Structural validation of a whole plan (no database): shape, ids, dependencies, query-plan schemas. */
function parseAnalysisPlan(raw) {
  const r = analysisPlanSchema.safeParse(raw);
  if (!r.success) return { ok: false, errors: r.error.issues.slice(0, 8).map((i) => ({ code: "invalid_shape", path: i.path.join("."), message: i.message })) };
  const plan = r.data;
  const errors = [];
  const seen = new Map();
  plan.steps.forEach((step, i) => {
    if (seen.has(step.id)) errors.push({ code: "duplicate_step_id", path: `steps.${i}.id`, message: `step id "${step.id}" is used twice` });
    if (step.kind === "query") {
      const qp = parseQueryPlan(step.plan);
      if (!qp.ok) errors.push({ code: "invalid_query_plan", path: `steps.${i}.plan`, message: (qp.errors || []).slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ") });
      const dims = new Set();
      step.inputs.forEach((input, j) => {
        const src = seen.get(input.fromStep);
        if (!src) errors.push({ code: "input_from_unknown_or_later_step", path: `steps.${i}.inputs.${j}`, message: `"${input.fromStep}" is not an earlier step` });
        else if (src.kind !== "query" || !Array.isArray(src.plan.groupBy) || !src.plan.groupBy.some((g) => g && g.dim === input.dim)) {
          errors.push({ code: "input_source_not_grouped_by_dim", path: `steps.${i}.inputs.${j}`, message: `"${input.fromStep}" is not a query grouped by ${input.dim}` });
        } else {
          const ranking = changeRanking(src.plan);
          if (ranking && !(Array.isArray(src.plan.having) && src.plan.having.some((h) => keepsSign(h, ranking)))) {
            errors.push({ code: "input_change_sign_unbounded", path: `steps.${i}.inputs.${j}`, message: `"${input.fromStep}" is ranked by ${ranking.base} change but does not keep only a ${directionWord(ranking)} (having ${ranking.base}.delta ${ranking.sign < 0 ? "lt" : "gt"} 0)` });
          }
        }
        if (dims.has(input.dim) || (Array.isArray(step.plan.filters) && step.plan.filters.some((f) => f && f.dim === input.dim))) {
          errors.push({ code: "input_dimension_already_filtered", path: `steps.${i}.inputs.${j}`, message: `${input.dim} is already filtered in this step` });
        }
        dims.add(input.dim);
      });
    }
    seen.set(step.id, step);
  });
  return errors.length ? { ok: false, errors } : { ok: true, plan };
}

const stepOut = (step, status, extra = {}) => ({ id: step.id, kind: step.kind, ...(step.kind === "insight" ? { tool: step.tool } : {}), status, ...extra });
const stripDiagnostics = ({ diagnostics, ...rest }) => rest;
const ENGINE_MESSAGES = {
  query_timeout: "That calculation took too long. Try a shorter period or a narrower breakdown.",
  result_too_large: "That calculation returned too much data. Try a narrower filter or period.",
};

// never_synced blocks the step; stale or failed syncs are disclosed with the step (as the single-query answer does)
async function freshnessGate(tenantId, voucherTypes, getFreshness) {
  const notes = [];
  let state = "fresh";
  for (const vt of voucherTypes) {
    const f = await getFreshness(tenantId, vt);
    if (f && f.state === "never_synced") return { blocked: true, message: f.message || `${vt} vouchers have never been synced for this company.` };
    if (f && f.state !== "fresh") {
      notes.push(f.message);
      state = f.state === "sync_failed" || state === "sync_failed" ? "sync_failed" : "stale";
    }
  }
  return { blocked: false, notes, state };
}

async function resolveNames(plan, resolveEntity) {
  for (const f of plan.filters || []) {
    if (!NAME_DIMS.has(f.dim) || (f.op !== "eq_ci" && f.op !== "in_ci")) continue;
    const values = Array.isArray(f.value) ? f.value : [f.value];
    const canonical = [];
    for (const v of values) {
      const { matches = [] } = (await resolveEntity({ entity: plan.entity, hintDim: f.dim, text: v })) || {};
      if (matches.length !== 1) return { error: `"${String(v).slice(0, 60)}" did not match exactly one ${f.dim} of this company.` };
      canonical.push(matches[0].value);
    }
    f.value = Array.isArray(f.value) ? canonical : canonical[0];
  }
  return {};
}

async function runQueryStep(step, results, env) {
  const plan = JSON.parse(JSON.stringify(step.plan));
  plan.filters = Array.isArray(plan.filters) ? plan.filters : [];
  const literalFilters = plan.filters.length;

  // ---- inputs: the first N group keys of an earlier, successful step become an in_ci filter (never dropped)
  const bindings = [];
  for (const input of step.inputs) {
    const src = results.get(input.fromStep);
    if (!src || src.status !== "ok") return stepOut(step, "skipped", { reason: "dependency_not_available", message: `Step "${input.fromStep}" did not produce a result.` });
    const taken = src.result.rows.slice(0, input.take);
    const ranking = changeRanking(src.request);
    if (ranking && taken.some((r) => { const d = r.comparison && r.comparison[ranking.base] && r.comparison[ranking.base].delta; return typeof d !== "number" || Math.sign(d) !== ranking.sign; })) {
      return stepOut(step, "skipped", { reason: "input_change_sign_mismatch", message: `Step "${input.fromStep}" returned a ${input.dim} whose change is not a ${directionWord(ranking)}.` });
    }
    const values = [...new Set(taken.map((r) => r.key && r.key[input.dim]).filter((v) => typeof v === "string" && v))];
    if (!values.length) return stepOut(step, "skipped", { reason: "no_input_values", message: `Step "${input.fromStep}" returned no ${input.dim} to continue with.` });
    plan.filters.push({ dim: input.dim, op: "in_ci", value: values });
    bindings.push({ fromStep: input.fromStep, dim: input.dim, values });
  }

  // ---- names typed in the plan are re-resolved against the tenant's own data (bound values are already stored names)
  if (literalFilters) {
    const typed = { ...plan, filters: plan.filters.slice(0, literalFilters) };
    let named;
    try {
      named = await resolveNames(typed, env.resolveEntity);
    } catch (e) {
      return stepOut(step, "failed", { error: { code: "entity_lookup_unavailable", message: "Names could not be looked up right now." } });
    }
    if (named.error) return stepOut(step, "refused", { error: { code: "entity_not_resolved", message: named.error } });
    plan.filters = [...typed.filters, ...plan.filters.slice(literalFilters)];
  }

  const validation = validateQueryPlan(plan, { referenceDate: env.referenceDate });
  if (!validation.ok) return stepOut(step, "refused", { request: plan, error: { code: "invalid_query", codes: validation.errors.slice(0, 5).map((e) => e.code), message: "This step is not a valid query." } });

  const gate = await freshnessGate(env.tenantId, [VOUCHER_TYPE_BY_ENTITY[plan.entity] || "Sales"], env.getFreshness);
  if (gate.blocked) return stepOut(step, "refused", { request: plan, error: { code: "no_usable_data", message: gate.message } });

  const cov = assessCoverage({ entity: plan.entity, period: validation.normalized.period, comparison: validation.normalized.comparison, coverage: env.dateContext.coverage });
  if (cov.status === "outside") return stepOut(step, "refused", { request: plan, error: { code: "outside_coverage", message: cov.message } });

  const { result } = await env.execute(plan, { tenantId: env.tenantId, referenceDate: env.referenceDate });
  if (!result || result.ok !== true) {
    const code = (result && result.errors && result.errors[0] && result.errors[0].code) || "execution_failed";
    return stepOut(step, "failed", { request: plan, error: { code, message: ENGINE_MESSAGES[code] || (code === "ledger_master_missing" ? result.errors[0].message : "The calculation could not be completed.") } });
  }
  // the same notes and definitions the single-query answer carries for this plan (passed in by the chat turn)
  const contextNotes = [...cov.notes.map((message) => ({ code: "coverage_partial", message, warn: true })), ...env.periodNotes(plan, validation.normalized)];
  const formatted = formatQueryAnswer({ plan, result, contextNotes, definitionNotes: env.definitionNotes[step.id] || [], dataThrough: env.dataThrough });
  return stepOut(step, "ok", { source: "query_engine", request: plan, bindings, result: stripDiagnostics(result), facts: formatted.text, notes: [...cov.notes, ...gate.notes], dataState: gate.state });
}

async function runInsightStep(step, env) {
  const gate = await freshnessGate(env.tenantId, insightTools.insightToolVoucherTypes(step.tool, step.args), env.getFreshness);
  if (gate.blocked) return stepOut(step, "refused", { error: { code: "no_usable_data", message: gate.message } });
  // the period the tool will read (the tool's own resolution): outside the synced history it is refused BEFORE the tool runs -
  // never shown as zero, never paid for. Invalid arguments resolve to no period and are refused by the tool itself.
  const range = await insightTools.resolveInsightPeriod(step.tool, step.args, { tenantId: env.tenantId, referenceDate: env.referenceDate });
  const cov = range ? assessCoverage({ entity: step.args && step.args.entity === "purchase" ? "purchase" : "sales", period: range, comparison: null, coverage: env.dateContext.coverage }) : { status: "covered", notes: [] };
  if (cov.status === "outside") return stepOut(step, "refused", { error: { code: "outside_coverage", message: cov.message } });
  const ev = await env.runInsightTool(step.tool, step.args, { tenantId: env.tenantId, referenceDate: env.referenceDate, resolveEntity: env.resolveEntity });
  if (!ev || !ev.ok) {
    const code = (ev && ev.error && ev.error.code) || "execution_failed";
    const refused = ["invalid_arguments", "product_not_found", "unknown_tool", "tool_not_ready"].includes(code);
    return stepOut(step, refused ? "refused" : "failed", { error: { code, message: (ev && ev.error && ev.error.message) || "The calculation could not be completed." } });
  }
  return stepOut(step, "ok", { source: "insight_tool", result: ev, notes: [...cov.notes, ...gate.notes], dataState: gate.state });
}

/**
 * Run an analysis plan. Steps run in order (an input always refers to an earlier step); a refused or failed step does not
 * stop independent later steps, and a step that depends on it is skipped.
 * @param {object} raw the analysis plan
 * @param {{tenantId:string, dateContext?:object, getDateContext?:Function, execute?:Function, runInsightTool?:Function,
 *          getFreshness?:Function, resolveEntity?:Function, deadlineMs?:number, now?:Function, signal?:AbortSignal,
 *          definitionNotes?:object, periodNotes?:Function, dataThrough?:Date}} context
 *        tenantId from the authenticated company context only; the rest are injectable for tests. definitionNotes (by step id,
 *        from the analysis planner), periodNotes(plan, normalized) and dataThrough are the chat turn's own answer notes.
 */
async function executeAnalysisPlan(raw, context = {}) {
  const tenantId = context.tenantId;
  if (typeof tenantId !== "string" || !tenantId.trim()) return { ok: false, error: { code: "tenant_required", message: "An authorized company context is required." } };
  const parsed = parseAnalysisPlan(raw);
  if (!parsed.ok) return { ok: false, error: { code: "invalid_analysis_plan", message: "The analysis plan is not valid.", issues: parsed.errors } };

  const now = context.now || Date.now;
  const started = now();
  const deadlineMs = Number.isInteger(context.deadlineMs) && context.deadlineMs > 0 ? Math.min(context.deadlineMs, DEFAULT_DEADLINE_MS) : DEFAULT_DEADLINE_MS;
  const dateContext = context.dateContext || (await (context.getDateContext || require("../analytics/referenceDate").getTenantDateContext)(tenantId));
  const env = {
    tenantId,
    dateContext,
    referenceDate: dateContext.referenceDate,
    execute: context.execute || ((plan, ctx) => defaultExecutor().execute(plan, ctx)),
    runInsightTool: context.runInsightTool || insightTools.runInsightTool,
    getFreshness: context.getFreshness || require("../analytics/freshness").getFreshness,
    resolveEntity: context.resolveEntity || require("./entityResolver").createEntityResolver({ tenantId }),
    definitionNotes: context.definitionNotes || {},
    periodNotes: typeof context.periodNotes === "function" ? context.periodNotes : () => [],
    dataThrough: context.dataThrough || null,
  };

  const results = new Map();
  const steps = [];
  for (const step of parsed.plan.steps) {
    let out;
    // the user stopped the turn: nothing more is run for an answer nobody will receive
    if (context.signal && context.signal.aborted) out = stepOut(step, "skipped", { reason: "cancelled", message: "The request was cancelled." });
    else if (now() - started > deadlineMs) out = stepOut(step, "skipped", { reason: "deadline_exceeded", message: "The analysis time budget was used up before this step." });
    else {
      try {
        out = step.kind === "query" ? await runQueryStep(step, results, env) : await runInsightStep(step, env);
      } catch (error) {
        out = stepOut(step, "failed", { error: { code: "execution_failed", message: "The calculation could not be completed." } });
      }
    }
    results.set(step.id, out);
    steps.push(out);
  }
  return {
    ok: true,
    steps,
    budget: { maxSteps: MAX_STEPS, steps: steps.length, ran: steps.filter((s) => s.status === "ok" || s.status === "failed").length, deadlineMs, elapsedMs: now() - started },
  };
}

let sharedExecutor = null;
function defaultExecutor() {
  if (!sharedExecutor) sharedExecutor = require("./answerCache").createDefaultCachedExecutor();
  return sharedExecutor;
}

module.exports = { parseAnalysisPlan, executeAnalysisPlan, analysisPlanSchema, MAX_STEPS, MAX_INPUT_VALUES, DEFAULT_DEADLINE_MS };
