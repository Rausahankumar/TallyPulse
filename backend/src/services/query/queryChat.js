"use strict";

// --------------------------------------------------
// Chat wiring for the Sales/Purchase Query Engine - the ONLY answer path of the chat.
//
//   turn date context (tenant reference date + synced coverage window, ONE read per turn)
//   question (+ the previous turn's structured plan, when the stored state is valid)
//        -> freshness gate (both entities) -> ONE bounded Claude planner call
//        -> validated plan | decline | honest failure message
//   plan -> freshness gate -> coverage gate (no data is never shown as zero) -> answer cache -> executor
//        (tenant-scoped, same reference date) -> deterministic text + presentation model
//
// The planner is the only natural-language interpreter, and every number comes from the engine. Raw chat
// history is never sent to Claude - only the previous structured plan.
//
// Every turn ends here with an honest answer: a figure, a clarification, a refusal or a fixed failure message.
// The one exception is a client that already disconnected (Stop): {handled:false, reason:'client_aborted'} and
// nothing is answered. It never throws to the caller.
// Tenant scope comes ONLY from `context.tenantId` (set by the authorization
// middleware); no tenant value is read from the question, the planner or the plan.
// --------------------------------------------------

const { validateQueryPlan } = require("./validator");
const { assessCoverage, rangeText, fmtDay } = require("../analytics/coverage");
const followUp = require("./followUp");
const { CATALOG } = require("./semanticCatalog");
const { planQuestion, createAnthropicPlannerClient, REVENUE_ASSUMPTION } = require("./planner");
const { createEntityResolver } = require("./entityResolver");
const { formatQueryAnswer, formatNonAnswer, SCOPE_HINT } = require("./answerFormatter");
const { buildPresentation } = require("./presentation");
const turnTelemetry = require("./turnTelemetry");

const { now, newTurnMetrics, timeResolver } = turnTelemetry;

const RESOLVER_TTL_MS = 5 * 60 * 1000;
const NO_FALLBACK_EXEC_ERRORS = new Set(["query_timeout", "result_too_large", "tenant_context_required"]);

// ---------------------------------------------------------------- singletons (lazy)

let sharedExecutor = null;
function getSharedExecutor() {
  if (!sharedExecutor) sharedExecutor = require("./answerCache").createDefaultCachedExecutor();
  return sharedExecutor;
}

let plannerClient = null;
function getPlannerClient() {
  if (!plannerClient) plannerClient = createAnthropicPlannerClient();
  return plannerClient;
}

// Per-tenant entity resolver. Its name lists are dropped whenever that tenant's data version moves
// (same signal the answer cache uses), plus a TTL as a backstop.
const resolvers = new Map();
let bumpHooked = false;
function getTenantResolver(tenantId, now = Date.now()) {
  if (!bumpHooked) {
    bumpHooked = true;
    require("./dataVersion").onBump((key) => (key === "*" ? resolvers.clear() : resolvers.delete(key)));
  }
  const hit = resolvers.get(tenantId);
  if (hit && hit.expires > now) return hit.resolver;
  const resolver = createEntityResolver({ tenantId });
  resolvers.set(tenantId, { resolver, expires: now + RESOLVER_TTL_MS });
  return resolver;
}

// ---------------------------------------------------------------- the turn's date context

/**
 * ONE tenant date context per chat turn (reference date + coverage window), read lazily and at most once, then
 * shared by planner validation, coverage, the executor and telemetry.
 * @param {string} tenantId
 * @param {Function} [fetch] (tenantId) => date context; defaults to analytics/referenceDate getTenantDateContext
 */
function createTurnDates(tenantId, fetch) {
  let pending = null;
  let value = null;
  const get = () => {
    if (!pending) {
      const load = fetch || require("../analytics/referenceDate").getTenantDateContext;
      pending = Promise.resolve()
        .then(() => load(tenantId))
        .then((dc) => (value = dc));
    }
    return pending;
  };
  get.peek = () => value;
  return get;
}

// ---------------------------------------------------------------- helpers

function baseResponse(answer, { toolCalls = [], warnings = [], freshness = null, dataAsOf = null, meta = {}, visualization = null } = {}) {
  // The chat shows warnings under the answer: one the answer text already states (missing data, a coverage note) is not
  // shown twice. Warnings the text does not contain (a stale or failed sync) are kept, once each.
  const text = typeof answer === "string" ? answer : "";
  return {
    answer,
    insights: [],
    visualization,
    details: { toolCalls, queryEngine: meta },
    dataAsOf,
    freshness,
    warnings: [...new Set(warnings)].filter((w) => typeof w === "string" && w && !text.includes(w)),
  };
}

const LOOKUP_UNAVAILABLE_MESSAGE = "I couldn't look up customer, supplier and product names right now, so I can't answer this yet. Please try again in a moment.";

const COMPUTE_FAILED_MESSAGE = "I couldn't compute that answer right now. Please try again shortly.";

// Clarifications that ask for MISSING information (which year, financial or calendar, which measure): the user's reply completes
// the same question, so it is kept as pending. A term clarification ("orders are not invoices") explains a definition instead;
// its words would trigger the same guard again, so the reply is planned as a new question.
const ASKS_FOR_MISSING_INFO = new Set(["planner_needs_clarification", "year_missing", "analysis_needs_clarification"]);

// The query planner said one query cannot answer this (several analyses), and analysis plans are switched off (ASK_AI_ANALYSIS).
const NEEDS_ANALYSIS_OFF_MESSAGE = "This question needs several separate analyses (for example a comparison and then its customers or products, or sales next to purchases). Multi-step analysis is not switched on, so please ask one part at a time.";

const FRESH_TO_STATE = { stale: "stale_data", sync_failed: "sync_failed", never_synced: "no_usable_data" };
const RELATIVE_KIND = (kind) => kind !== "all_time" && kind !== "custom" && kind !== "specific_fy";
const DAY = (d) => {
  const x = new Date(d);
  return x.getFullYear() * 10000 + (x.getMonth() + 1) * 100 + x.getDate();
};

// Month-end (P-SF, disclosure only - the comparison itself is unchanged): a COMPLETE current period compared
// like-for-like can meet a SHORTER previous period (30 Apr -> 1-30 Mar). Say so instead of hiding it.
function completePeriodNote(plan, n, referenceDate) {
  if (!plan.compare || plan.compare.mode !== "like_for_like" || !n.comparison || n.period.isPartial) return null;
  const support = CATALOG.periods.comparisonSupport[plan.period.kind];
  // only current_X kinds have a separate full previous period ({kind}); others are already complete
  if (!support || !support.fullPrevious || typeof support.fullPrevious !== "object" || !support.fullPrevious.kind) return null;
  const full = require("../analytics/periodEngine").resolvePeriod(support.fullPrevious.kind, referenceDate);
  if (DAY(n.comparison.to) >= DAY(full.to)) return null;
  return {
    code: "complete_period_vs_same_days",
    message: `This period is complete (${rangeText(n.period)}) but is compared with the same days of the previous period (${rangeText(n.comparison)}), not all of it (${rangeText(full)}). Say "vs full last month" (or quarter, week, FY) to compare complete periods.`,
  };
}

// Future-dated vouchers (decision 1): relative periods end TODAY; vouchers dated later exist and are not in them.
function futureVouchersNote(plan, dc) {
  if (!dc || !dc.futureVouchers || !RELATIVE_KIND(plan.period.kind)) return null;
  return {
    code: "future_vouchers_excluded",
    message: `Relative periods end today (${fmtDay(dc.wallClock)}). This company also has vouchers dated after today (latest ${fmtDay(dc.latestVoucher)}); they are not included - ask with explicit dates to see them.`,
  };
}

// Honest, fixed text for a planner that failed. Only the entity-check message carries planner output, and that
// text is already sanitised and length-capped by the planner.
function plannerFailureMessage(planned) {
  if (planned.code === "planner_timeout" || planned.code === "planner_call_failed") {
    return "The AI query planner is unavailable right now, so I couldn't answer this. Please try again shortly, or ask a direct question such as \"sales last month\" or \"top 5 customers this month\".";
  }
  if (planned.code === "planner_entity_check_failed") return LOOKUP_UNAVAILABLE_MESSAGE;
  if (planned.code === "planner_entity_not_resolved") {
    const names = Array.isArray(planned.suggestions) ? planned.suggestions : [];
    if (names.length) {
      const quoted = names.map((n) => `"${n}"`);
      const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}` : quoted[0];
      return `${planned.reason} Did you mean ${list}?`;
    }
    return `${planned.reason} Please check the name and try again.`;
  }
  return "I couldn't turn this question into a query I can run safely. Please rephrase it, for example by naming the period and whether it is about sales or purchases.";
}

// ---------------------------------------------------------------- analysis plans (several existing analyses for one question)

// Off unless ASK_AI_ANALYSIS=on (or a test passes deps.analysisEnabled): the single-query path is unchanged by default.
const analysisEnabled = (deps) => (deps && typeof deps.analysisEnabled === "boolean" ? deps.analysisEnabled : process.env.ASK_AI_ANALYSIS === "on");

async function answerAnalysis(a, tm) {
  const { planAnalysis } = require("./analysisPlanner");
  const { executeAnalysisPlan } = require("./analysisPlan");
  const { formatAnalysisAnswer } = require("./analysisAnswer");
  const ta = now();
  const ap = await planAnalysis(a.userMessage, { claudeClient: a.deps.plannerClient || getPlannerClient(), referenceDate: a.referenceDate, signal: a.signal });
  tm.plannerLatencyMs = (tm.plannerLatencyMs || 0) + (now() - ta);
  const usage = { ...a.plannerUsage };
  for (const k of ["calls", "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) usage[k] = (Number(usage[k]) || 0) + (Number(ap.usage && ap.usage[k]) || 0);
  tm.plannerAttempts = usage.calls;
  tm.plannerInputTokens = usage.input_tokens;
  tm.plannerOutputTokens = usage.output_tokens;
  tm.plannerCacheReadTokens = usage.cache_read_input_tokens;
  tm.plannerCacheCreationTokens = usage.cache_creation_input_tokens;
  tm.plannerStatus = ap.status;
  tm.plannerCode = ap.code || null;
  const meta = { route: "analysis", claudeCalls: usage.calls, usage };

  if (ap.status === "needs_clarification" || ap.status === "unsupported") {
    const answer = ap.status === "unsupported" ? `${ap.reason}\n\n${SCOPE_HINT}` : ap.reason;
    return { handled: true, structured: baseResponse(answer, { meta: { ...meta, status: ap.status, code: ap.code } }) };
  }
  if (ap.status !== "supported") return { handled: true, structured: baseResponse(plannerFailureMessage(ap), { meta: { ...meta, status: "planner_failed", code: ap.code } }) };
  if (a.signal && a.signal.aborted) return { handled: false, reason: "client_aborted" };

  const exec = a.deps.execute || ((p, c, timing) => getSharedExecutor().execute(p, c, timing));
  const execution = await executeAnalysisPlan(ap.analysis, {
    tenantId: a.tenantId,
    dateContext: a.dc,
    execute: exec,
    resolveEntity: a.resolveEntity,
    getFreshness: a.getFreshness,
    runInsightTool: a.deps.runInsightTool,
    signal: a.signal,
    // each query step carries the notes the single-query answer would carry for the same plan
    definitionNotes: ap.definitionNotes,
    periodNotes: (plan, n) => [completePeriodNote(plan, n, a.referenceDate), futureVouchersNote(plan, a.dc)].filter(Boolean),
    dataThrough: a.dc && a.dc.latestVoucher ? a.dc.latestVoucher : null,
  });
  if (a.signal && a.signal.aborted) return { handled: false, reason: "client_aborted" };
  if (!execution.ok) return { handled: true, structured: baseResponse(COMPUTE_FAILED_MESSAGE, { meta: { ...meta, status: "execution_failed", code: execution.error.code } }) };
  const formatted = formatAnalysisAnswer(execution, { assumptions: ap.assumptions });
  const ran = execution.steps.filter((s) => s.status === "ok");
  const dataState = ran.some((s) => s.dataState === "sync_failed") ? "sync_failed" : ran.some((s) => s.dataState === "stale") ? "stale" : null;
  return {
    handled: true,
    structured: baseResponse(formatted.text, {
      toolCalls: [{ toolName: "analysis_plan", state: !formatted.answered ? "no_usable_data" : dataState ? FRESH_TO_STATE[dataState] : "valid_data" }],
      warnings: formatted.warnings,
      meta: { ...meta, status: formatted.answered ? "answered" : "execution_failed", steps: execution.steps.map((s) => s.status) },
    }),
  };
}

// Telemetry only. Engine timing is known when the executor reports it (production wiring); otherwise null.
function recordExecution(tm, { te, done, timing, cache, result }) {
  const status = cache && cache.status;
  const engineRan = Number.isFinite(timing.engineMs);
  tm.executeMs = done - te;
  tm.answerCache = status || null;
  tm.answerCacheHit = status ? status === "hit" : null;
  tm.answerCacheStored = cache && typeof cache.stored === "boolean" ? cache.stored : null;
  tm.engineRan = engineRan ? true : status === "hit" || status === "coalesced" ? false : null;
  tm.engineLatencyMs = engineRan ? timing.engineMs : null;
  tm.answerCacheLookupMs = engineRan && Number.isFinite(timing.engineStartedAt) ? timing.engineStartedAt - te : status === "hit" || status === "coalesced" ? done - te : null;
  tm.engineStatus = result && result.ok === true ? "ok" : "failed";
  tm.engineErrorCode = (result && result.ok !== true && result.errors && result.errors[0] && result.errors[0].code) || null;
}

// ---------------------------------------------------------------- main entry

/**
 * @param {object} p
 * @param {{tenantId:string}} p.context  authorization-verified context from the middleware
 * @param {string} p.userMessage
 * @param {Array} [p.conversationHistory] only its length is used (a previous plan can exist only after an earlier turn); never sent to Claude
 * @param {object} [p.previousQuery] the previous assistant message's stored query state (followUp.buildQueryState)
 * @param {Function} [p.getDateContext] the turn's shared date context (createTurnDates); created here when omitted
 * @param {object} [p.deps] injectable for tests: {resolveEntity, execute(plan, {tenantId, referenceDate}, timing), plannerClient, getFreshness, getDateContext(tenantId)}
 * @returns {Promise<{handled:false, reason:'client_aborted'} | {handled:true, structured:object}>}
 */
async function tryAnswerWithQueryEngine(args) {
  const tm = newTurnMetrics();
  const t0 = now();
  const out = await answerTurn(args, tm);
  // A clarification answers nothing: the earlier plan (if any) carries forward, and the question being clarified is kept as
  // `pending`, so the user's reply is planned together with it next turn (never across a refused turn).
  const status = out && out.handled && out.structured && out.structured.details && out.structured.details.queryEngine && out.structured.details.queryEngine.status;
  if (out && !out.queryContext && status === "needs_clarification") {
    const prev = followUp.readQueryState(args && args.previousQuery);
    const code = out.structured.details.queryEngine.code;
    if (ASKS_FOR_MISSING_INFO.has(code)) {
      const state = followUp.withPendingQuestion(prev, followUp.clarifiedQuestion(args && args.userMessage, prev));
      if (state) out.queryContext = state;
    } else if (prev) out.queryContext = args.previousQuery; // a term clarification (orders vs invoices): the reply is a new question
  }
  if (out && out.queryContext) {
    // Server-side only (the controller persists it for follow-ups); never part of the visible result.
    const qc = out.queryContext;
    delete out.queryContext;
    Object.defineProperty(out, "queryContext", { value: qc, enumerable: false });
  }
  try {
    finishTurnMetrics(tm, out);
    tm.queryEngineMs = now() - t0;
    // Non-enumerable: the visible result (and everything the controller persists or returns) is unchanged.
    Object.defineProperty(out, "telemetry", { value: tm, enumerable: false });
  } catch (e) {
    /* telemetry must never affect the turn */
  }
  return out;
}

// Classifies the finished turn from what the turn itself reported (meta) - no re-derivation of routing.
function finishTurnMetrics(tm, out) {
  tm.claudeCalls = tm.plannerAttempts || 0;
  tm.claudeReason = tm.claudeCalls > 0 ? "planner" : null;
  if (!out.handled) {
    tm.path = "client_aborted";
    tm.route = "client_aborted";
    tm.outcome = "client_aborted";
    tm.answerSource = null;
    return;
  }
  const meta = (out.structured && out.structured.details && out.structured.details.queryEngine) || {};
  tm.route = meta.route;
  tm.outcome = meta.status;
  tm.answerSource = meta.status === "answered" ? "deterministic" : "fixed_message";
  if (meta.status === "outside_coverage") tm.path = "coverage_refused";
  // analysis-plan turns keep their own path (the persisted usage record has `path`, not `route`), so they can be told apart
  else if (meta.route === "analysis") tm.path = meta.status === "answered" ? "analysis" : meta.status === "unsupported" || meta.status === "needs_clarification" ? "analysis_declined" : "analysis_failed";
  else if (meta.route === "planner") tm.path = meta.status === "planner_failed" ? "planner_failed" : meta.status === "unsupported" || meta.status === "needs_clarification" ? "planner_declined" : "planner";
  else if (meta.status === "no_usable_data") tm.path = "no_usable_data";
  else tm.path = "planner";
}

async function answerTurn({ context, userMessage, conversationHistory = [], previousQuery = null, getDateContext = null, deps = {}, signal = null }, tm) {
  try {
    if (!context || typeof context.tenantId !== "string" || !context.tenantId) throw new Error("an authorized tenant context is required");
    if (typeof userMessage !== "string") throw new Error("the question must be a string");
    const tenantId = context.tenantId;

    const tenantResolver = deps.resolveEntity || getTenantResolver(tenantId);
    const resolveEntity = timeResolver(tenantResolver, tm);
    // ONE reference date for the whole turn (planner validation, coverage, executor).
    const turnDates = typeof getDateContext === "function" ? getDateContext : createTurnDates(tenantId, deps.getDateContext);
    const dc = await turnDates();
    const referenceDate = dc.referenceDate;
    tm.referenceDateSource = dc.source;
    tm.futureVouchersPresent = dc.futureVouchers;

    const getFreshness = deps.getFreshness || require("../analytics/freshness").getFreshness;

    // The previous turn's structured plan (follow-ups). A stored state is untrusted: strict schema re-parse, else ignored.
    const prevState = conversationHistory.length > 0 ? followUp.readQueryState(previousQuery) : null;
    if (prevState) tm.followUp = prevState.pending ? "clarification" : "previous_plan";
    // A reply to a clarification is planned together with the question it clarifies (same guards, same years stated).
    const question = followUp.clarifiedQuestion(userMessage, prevState);

    // The client already disconnected (Stop): never pay for a planner call nobody will receive. The
    // controller sees the aborted signal and ends the turn without answering.
    if (signal && signal.aborted) return { handled: false, reason: "client_aborted" };

    // Freshness gate BEFORE paying for the planner. The planner decides sales vs purchase, so both are read;
    // if neither has ever synced, no plan could be answered and the planner is not called.
    const [salesFreshness, purchaseFreshness] = await Promise.all([getFreshness(tenantId, "Sales"), getFreshness(tenantId, "Purchase")]);
    const preFreshness = { sales: salesFreshness, purchase: purchaseFreshness };
    if (salesFreshness.state === "never_synced" && purchaseFreshness.state === "never_synced") {
      tm.freshnessStatus = "never_synced";
      const msg = `${salesFreshness.message} ${purchaseFreshness.message}`.trim();
      return { handled: true, structured: baseResponse(msg, { toolCalls: [{ toolName: "query_engine", state: "no_usable_data" }], warnings: [msg], freshness: salesFreshness, meta: { route: "planner", status: "no_usable_data", claudeCalls: 0 } }) };
    }

    const tp = now();
    // Validated against the SAME tenant reference date (the date is never sent to Claude).
    const planned = await planQuestion(question, { claudeClient: deps.plannerClient || getPlannerClient(), resolveEntity, previousPlan: prevState && prevState.plan ? prevState.plan : undefined, referenceDate, signal });
    tm.plannerLatencyMs = now() - tp;
    const plannerUsage = planned.usage;
    tm.plannerStatus = planned.status;
    tm.plannerCode = planned.code || null;
    if (plannerUsage) {
      tm.plannerAttempts = plannerUsage.calls;
      tm.plannerInputTokens = plannerUsage.input_tokens;
      tm.plannerOutputTokens = plannerUsage.output_tokens;
      tm.plannerCacheReadTokens = plannerUsage.cache_read_input_tokens;
      tm.plannerCacheCreationTokens = plannerUsage.cache_creation_input_tokens;
    }
    // The query planner said the question needs several analyses: with analysis plans enabled, the analysis planner composes
    // them (one more model call, at most one repair). Disabled (the default), it stays the planner's decline, exactly as before.
    // A plan the validator could not accept even after the planner's own repairs is the same signal ("one query cannot express
    // this"): with analysis plans on it goes to the analysis planner too, which composes steps or declines. Accounting-profit
    // questions never get here as a failure (planQuestion already turned them into the profit refusal).
    const needsSteps = planned.code === "planner_needs_analysis" || (planned.status === "planner_failed" && planned.code === "planner_invalid_plan");
    if (needsSteps && analysisEnabled(deps)) {
      return answerAnalysis({ tenantId, userMessage: question, dc, referenceDate, resolveEntity, getFreshness, deps, signal, plannerUsage }, tm);
    }
    // Analysis plans off: one fixed, honest answer instead of the model's own wording (which varied from question to question).
    if (planned.code === "planner_needs_analysis") {
      return { handled: true, structured: baseResponse(`${NEEDS_ANALYSIS_OFF_MESSAGE}\n\n${SCOPE_HINT}`, { meta: { route: "planner", status: "unsupported", code: planned.code, claudeCalls: plannerUsage.calls, usage: plannerUsage } }) };
    }
    if (planned.status === "needs_clarification" || planned.status === "unsupported") {
      const answer = planned.status === "unsupported" ? `${planned.reason}\n\n${SCOPE_HINT}` : formatNonAnswer(planned);
      return { handled: true, structured: baseResponse(answer, { meta: { route: "planner", status: planned.status, code: planned.code, claudeCalls: plannerUsage.calls, usage: plannerUsage } }) };
    }
    if (planned.status !== "supported") {
      // Planner failure / timeout / unusable plan: answer honestly. Never hand the question to another Claude path.
      return { handled: true, structured: baseResponse(plannerFailureMessage(planned), { meta: { route: "planner", status: "planner_failed", code: planned.code, claudeCalls: plannerUsage.calls, usage: plannerUsage } }) };
    }
    const plan = planned.plan;
    const plannerAssumptions = planned.plannerAssumptions || [];
    const definitionNotes = planned.definitionNotes || []; // fixed server-side definitions (e.g. the revenue basis)
    const revenueBasis = definitionNotes.some((a) => a.code === REVENUE_ASSUMPTION.code);
    // The structured context a follow-up needs (stored on the assistant message by the controller; never sent to Claude as chat).
    const queryContext = followUp.buildQueryState(plan, { revenue: revenueBasis });

    // ---- freshness gate: never present numbers for a company that never synced
    // sales_return/purchase_return freshness tracks the Credit/Debit Note sync checkpoints
    // (tallySyncWorker.js's CREDIT_NOTE_SYNC_MODULE/DEBIT_NOTE_SYNC_MODULE), never Sales/Purchase's.
    const VOUCHER_TYPE_BY_ENTITY = { sales: "Sales", purchase: "Purchase", sales_return: "Credit Note", purchase_return: "Debit Note" };
    const voucherType = VOUCHER_TYPE_BY_ENTITY[plan.entity] || "Sales";
    const freshness = preFreshness[plan.entity] || (await getFreshness(tenantId, voucherType));
    tm.freshnessStatus = freshness.state;
    const meta = { route: "planner", status: "answered", claudeCalls: plannerUsage.calls, usage: plannerUsage };
    if (freshness.state === "never_synced") {
      return { handled: true, structured: baseResponse(freshness.message, { toolCalls: [{ toolName: "query_engine", state: "no_usable_data" }], warnings: [freshness.message], freshness, meta: { ...meta, status: "no_usable_data" } }) };
    }

    // ---- coverage gate: a period outside the synced history is MISSING data, never a zero (fixed text, no Claude)
    const contextNotes = [];
    const resolved = validateQueryPlan(plan, { referenceDate });
    if (resolved.ok) {
      const cov = assessCoverage({ entity: plan.entity, period: resolved.normalized.period, comparison: resolved.normalized.comparison, coverage: dc.coverage });
      tm.coverageStatus = cov.code;
      if (cov.status === "outside") {
        return {
          handled: true,
          queryContext,
          structured: baseResponse(cov.message, {
            toolCalls: [{ toolName: "query_engine", state: "no_usable_data" }],
            warnings: [cov.message],
            freshness,
            dataAsOf: freshness.dataAsOf ? new Date(freshness.dataAsOf) : null,
            meta: { ...meta, status: "outside_coverage", code: cov.code },
          }),
        };
      }
      for (const message of cov.notes) contextNotes.push({ code: "coverage_partial", message, warn: true });
      const complete = completePeriodNote(plan, resolved.normalized, referenceDate);
      if (complete) contextNotes.push(complete);
    }
    const ahead = futureVouchersNote(plan, dc);
    if (ahead) contextNotes.push(ahead);

    // ---- cache + engine (tenant-scoped executor; tenantId comes from the middleware context only)
    const exec = deps.execute || ((p, c, timing) => getSharedExecutor().execute(p, c, timing));
    const timing = {}; // filled by the production cached executor: when the engine started and how long it ran
    const te = now();
    const { result, cache } = await exec(plan, { tenantId, referenceDate }, timing);
    recordExecution(tm, { te, done: now(), timing, cache, result });
    if (!result || result.ok !== true) {
      const code = result && result.errors && result.errors[0] && result.errors[0].code;
      if (NO_FALLBACK_EXEC_ERRORS.has(code)) {
        const msg = code === "query_timeout" ? "That question took too long to compute. Try a shorter period or a narrower breakdown." : "That question returned too much data to summarise. Try a narrower filter or period.";
        return { handled: true, structured: baseResponse(msg, { warnings: [], freshness, meta: { ...meta, status: "execution_failed", code, cache: cache && cache.status } }) };
      }
      if (code === "ledger_master_missing") {
        // Final: "new party" needs the ledger master; it is never guessed from voucher history.
        return { handled: true, structured: baseResponse(result.errors[0].message, { warnings: [], freshness, meta: { ...meta, status: "unsupported", code, cache: cache && cache.status } }) };
      }
      // Already paid for the planner: do not add a second Claude path on top of an engine failure.
      return { handled: true, structured: baseResponse(COMPUTE_FAILED_MESSAGE, { warnings: [], freshness, meta: { ...meta, status: "execution_failed", code: code || "failed", cache: cache && cache.status } }) };
    }

    const formatted = formatQueryAnswer({ plan, result, definitionNotes, plannerAssumptions, contextNotes, dataThrough: dc && dc.latestVoucher ? dc.latestVoucher : null });
    const warnings = [...contextNotes.filter((n) => n.warn).map((n) => n.message), ...formatted.warnings];
    if (freshness.state !== "fresh") warnings.push(freshness.message);
    const state = freshness.state !== "fresh" ? FRESH_TO_STATE[freshness.state] : formatted.zero ? "zero_result" : "valid_data";
    return {
      handled: true,
      queryContext,
      structured: baseResponse(formatted.text, {
        toolCalls: [{ toolName: "query_engine", state }],
        warnings,
        freshness,
        dataAsOf: freshness.dataAsOf ? new Date(freshness.dataAsOf) : null,
        meta: { ...meta, cache: cache && cache.status },
        // Presentation only (tables/charts for the frontend): built from this same result, never changes the text.
        visualization: buildPresentation({ plan, result, notes: formatted.notes, zero: formatted.zero }),
      }),
    };
  } catch (error) {
    // Never break chat: log name/message only (no question, no data) and answer with the fixed failure message.
    console.error("QUERY ENGINE CHAT error:", error && error.name, error && error.message);
    return { handled: true, structured: baseResponse(COMPUTE_FAILED_MESSAGE, { meta: { route: "planner", status: "execution_failed", code: "exception", claudeCalls: tm.plannerAttempts || 0 } }) };
  }
}

// The controller's per-turn telemetry hooks, re-exported so queryChat stays its single entry point into services/query.
const chatTelemetry = { now, emitChatTurn: turnTelemetry.emitChatTurn };

module.exports = { tryAnswerWithQueryEngine, getTenantResolver, createTurnDates, chatTelemetry };
