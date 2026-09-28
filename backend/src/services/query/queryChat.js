"use strict";

// --------------------------------------------------
// Chat wiring for the Sales/Purchase Query Engine (Phase 1G).
//
//   turn date context (tenant reference date + synced coverage window, ONE read per turn, shared with legacy chat)
//   previous engine answer's plan + a follow-up fragment -> deterministic merge (followUp.js) -> plan
//   question -> deterministic router
//        supported            -> validated plan ---------------------\
//        unsupported          -> honest message (NO Claude)           |
//        needs_planner:                                               v
//            with chat history -> not handled here (legacy chat path keeps follow-up context)
//            dead-end code     -> clarification message (NO Claude)
//            otherwise         -> freshness gate (both entities) -> ONE bounded Claude planner call
//                                 -> validated plan | decline | honest failure message (never legacy chat)
//   plan -> freshness gate -> coverage gate (no data is never shown as zero) -> answer cache -> executor
//        (tenant-scoped, same reference date) -> deterministic text
//
// Fail-safe: anything this module cannot answer returns {handled:false} and the
// existing chat path runs exactly as before - EXCEPT once the planner has been
// called: then the turn always ends here, so no second Claude path is paid for.
// It never throws to the caller.
// Tenant scope comes ONLY from `context.tenantId` (set by the authorization
// middleware); no tenant value is read from the question, the planner or the plan.
// --------------------------------------------------

const { routeQuestion, mentionsRevenue, hasContinuationCue, readFollowUpSlots, REVENUE_ASSUMPTION } = require("./localRouter");
const { validateQueryPlan } = require("./validator");
const { assessCoverage, rangeText, fmtDay } = require("../analytics/coverage");
const followUp = require("./followUp");
const { CATALOG } = require("./semanticCatalog");
const { planQuestion, SKIP_ROUTER_CODES, createAnthropicPlannerClient } = require("./planner");
const { createEntityResolver } = require("./entityResolver");
const { formatQueryAnswer, formatNonAnswer, SCOPE_HINT } = require("./answerFormatter");
const turnTelemetry = require("./turnTelemetry");

const { now, newTurnMetrics, timeResolver, timeEntityIndex } = turnTelemetry;

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
 * shared by the router, planner validation, coverage, the executor, legacy chat and telemetry.
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

const disabled = () => String(process.env.QUERY_ENGINE_CHAT || "").toLowerCase() === "off";

function baseResponse(answer, { toolCalls = [], warnings = [], freshness = null, dataAsOf = null, meta = {} } = {}) {
  return {
    answer,
    insights: [],
    visualization: null,
    details: { toolCalls, queryEngine: meta },
    dataAsOf,
    freshness,
    warnings,
  };
}

const LOOKUP_UNAVAILABLE_MESSAGE = "I couldn't look up customer, supplier and product names right now, so I can't answer this yet. Please try again in a moment.";

const COMPUTE_FAILED_MESSAGE = "I couldn't compute that answer right now. Please try again shortly.";
const REVENUE_FOLLOW_UP_MESSAGE = 'Revenue (the pre-tax value of the items sold) can only be answered from a complete question. Please ask it in full, for example "revenue last month" or "top 5 customers by revenue in August 2025".';

// A revenue question never falls through to legacy chat, whose totals are tax-inclusive Sales amounts.
function revenueNoLegacy(message, code, freshness = null) {
  return { handled: true, structured: baseResponse(message, { freshness, meta: { route: "router", status: "revenue_not_answered", code, claudeCalls: 0 } }) };
}

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

function followUpNote(merged) {
  const kept = merged.kept.length ? `kept the ${merged.kept.join(", ")}` : "kept nothing else";
  return { code: "follow_up_applied", message: `Follow-up to your previous question: ${kept}; changed: ${merged.changed.join(", ")}.` };
}

// A fragment that names both a period and sales/purchases/revenue is a new question in its own right.
function isSelfContained(slots) {
  return !!(slots && slots.periods.length > 0 && (slots.entities.length > 0 || slots.revenue));
}

// Honest, fixed text for a planner that failed. Only the entity-check message carries planner output, and that
// text is already sanitised and length-capped by the planner.
function plannerFailureMessage(planned) {
  if (planned.code === "planner_timeout" || planned.code === "planner_call_failed") {
    return "The AI query planner is unavailable right now, so I couldn't answer this. Please try again shortly, or ask a direct question such as \"sales last month\" or \"top 5 customers this month\".";
  }
  if (planned.code === "planner_entity_check_failed") return LOOKUP_UNAVAILABLE_MESSAGE;
  if (planned.code === "planner_entity_not_resolved") {
    return `${planned.reason} Please check the name and try again.`;
  }
  return "I couldn't turn this question into a query I can run safely. Please rephrase it, for example by naming the period and whether it is about sales or purchases.";
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
 * @param {Array} [p.conversationHistory]
 * @param {object} [p.previousQuery] the previous assistant message's stored query state (followUp.buildQueryState)
 * @param {Function} [p.getDateContext] the turn's shared date context (createTurnDates); created here when omitted
 * @param {object} [p.deps] injectable for tests: {resolveEntity, entityIndex, execute(plan, {tenantId, referenceDate}, timing), plannerClient, getFreshness, getDateContext(tenantId)}
 * @returns {Promise<{handled:false, reason:string} | {handled:true, structured:object}>}
 */
async function tryAnswerWithQueryEngine(args) {
  const tm = newTurnMetrics();
  const t0 = now();
  const out = await answerTurn(args, tm);
  // A clarification answers nothing, so the conversation's last question is still the previous one: its context
  // carries forward (never across a legacy or a refused turn).
  const status = out && out.handled && out.structured && out.structured.details && out.structured.details.queryEngine && out.structured.details.queryEngine.status;
  if (out && !out.queryContext && status === "needs_clarification" && followUp.readQueryState(args && args.previousQuery)) out.queryContext = args.previousQuery;
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
    tm.path = "legacy_chat";
    tm.route = "legacy_chat";
    tm.outcome = "legacy_chat";
    tm.answerSource = "legacy_chat";
    tm.legacyReason = out.reason;
    return;
  }
  const meta = (out.structured && out.structured.details && out.structured.details.queryEngine) || {};
  tm.route = meta.route;
  tm.outcome = meta.status;
  tm.answerSource = meta.status === "answered" ? "deterministic" : "fixed_message";
  if (meta.status === "temporarily_unavailable") tm.path = "resolver_unavailable";
  else if (meta.status === "outside_coverage") tm.path = "coverage_refused";
  else if (meta.route === "follow_up") tm.path = meta.status === "answered" ? "follow_up" : "follow_up_clarification";
  else if (meta.status === "revenue_not_answered") tm.path = "revenue_guard";
  else if (meta.route === "planner") tm.path = meta.status === "planner_failed" ? "planner_failed" : meta.status === "unsupported" || meta.status === "needs_clarification" ? "planner_declined" : "planner";
  else if (meta.status === "unsupported") tm.path = "router_unsupported";
  else if (meta.status === "needs_clarification") tm.path = "router_clarification";
  else if (meta.status === "no_usable_data") tm.path = "no_usable_data";
  else tm.path = "router_supported";
}

async function answerTurn({ context, userMessage, conversationHistory = [], previousQuery = null, getDateContext = null, deps = {} }, tm) {
  try {
    if (disabled()) return { handled: false, reason: "disabled" };
    if (!context || typeof context.tenantId !== "string" || !context.tenantId) return { handled: false, reason: "no_tenant_context" };
    if (typeof userMessage !== "string") return { handled: false, reason: "invalid_message" };
    const tenantId = context.tenantId;

    const tenantResolver = deps.resolveEntity || getTenantResolver(tenantId);
    const resolveEntity = timeResolver(tenantResolver, tm);
    // P1-2: the same tenant-bound resolver's name index lets the router keep known names opaque to its grammar.
    const entityIndex = timeEntityIndex(deps.entityIndex || tenantResolver.spanIndex, tm);
    // ONE reference date for the whole turn (router validation, planner validation, coverage, executor).
    const turnDates = typeof getDateContext === "function" ? getDateContext : createTurnDates(tenantId, deps.getDateContext);
    const dc = await turnDates();
    const referenceDate = dc.referenceDate;
    tm.referenceDateSource = dc.source;
    tm.futureVouchersPresent = dc.futureVouchers;

    let plan;
    let source;
    let plannerAssumptions = [];
    let routerAssumptions = [];
    let plannerUsage = null;
    let preFreshness = null; // freshness read BEFORE the planner, keyed by entity
    let revenueBasis = false;
    const getFreshness = deps.getFreshness || require("../analytics/freshness").getFreshness;
    const clarification = (code, message) => ({
      handled: true,
      structured: baseResponse(message || formatNonAnswer({ status: "needs_clarification", code, reason: followUp.MESSAGES.followup_not_applicable }), { meta: { route: "follow_up", status: "needs_clarification", code, claudeCalls: 0 } }),
    });

    // ---- a follow-up to the previous ENGINE answer: merged into that plan, never answered as a new question
    const prevState = conversationHistory.length > 0 ? followUp.readQueryState(previousQuery) : null;
    const slots = conversationHistory.length > 0 ? readFollowUpSlots(userMessage) : null;
    if (prevState && slots && !slots.blocked && !isSelfContained(slots)) {
      const merged = await followUp.mergeFollowUp(prevState, userMessage, { resolveEntity });
      if (merged.status === "unavailable") {
        tm.followUp = "unavailable";
        return { handled: true, structured: baseResponse(LOOKUP_UNAVAILABLE_MESSAGE, { meta: { route: "follow_up", status: "temporarily_unavailable", code: "entity_lookup_unavailable", claudeCalls: 0 } }) };
      }
      if (merged.status === "clarify") {
        tm.followUp = "clarified";
        return clarification(merged.code, merged.message);
      }
      if (merged.status === "merged") {
        if (!validateQueryPlan(merged.plan, { referenceDate }).ok) {
          tm.followUp = "clarified";
          return clarification("followup_not_applicable", followUp.MESSAGES.followup_not_applicable);
        }
        tm.followUp = "merged";
        plan = merged.plan;
        source = "follow_up";
        revenueBasis = merged.basis === "revenue";
        routerAssumptions = [followUpNote(merged), ...merged.notes];
      }
    }

    const route = plan ? { status: "supported", plan } : await routeQuestion(userMessage, { resolveEntity, entityIndex, referenceDate });
    tm.routeStatus = route.status;
    tm.routeCode = route.code || null;

    // ---- Claude-free honest answers
    if (route.status === "unsupported") {
      return { handled: true, structured: baseResponse(formatNonAnswer(route), { meta: { route: "router", status: "unsupported", code: route.code, claudeCalls: 0 } }) };
    }
    // Name lookup failed for infrastructure reasons: answer honestly. No planner, no legacy chat - an
    // unresolved name must never be handed to Claude to guess.
    if (route.status === "temporarily_unavailable") {
      return { handled: true, structured: baseResponse(LOOKUP_UNAVAILABLE_MESSAGE, { meta: { route: "router", status: "temporarily_unavailable", code: route.code, claudeCalls: 0 } }) };
    }

    if (source === "follow_up") {
      // merged above
    } else if (route.status === "supported") {
      // A continuation ("and by customer?") the router can read on its own would silently drop the previous
      // question's period/measure. Without a usable previous plan it goes to legacy chat, which has the history.
      if (conversationHistory.length > 0 && hasContinuationCue(userMessage) && !isSelfContained(slots)) {
        tm.followUp = "legacy";
        if (mentionsRevenue(userMessage)) return revenueNoLegacy(REVENUE_FOLLOW_UP_MESSAGE, "revenue_follow_up");
        return { handled: false, reason: "follow_up_uses_legacy_chat" };
      }
      plan = route.plan;
      source = "router";
      routerAssumptions = route.assumptions || [];
      revenueBasis = routerAssumptions.some((a) => a.code === REVENUE_ASSUMPTION.code);
    } else {
      // needs_planner
      if (conversationHistory.length > 0) {
        // Legacy chat's totals are tax-inclusive invoice amounts, so it cannot answer revenue on its defined basis.
        if (mentionsRevenue(userMessage)) return revenueNoLegacy(REVENUE_FOLLOW_UP_MESSAGE, "revenue_follow_up");
        return { handled: false, reason: "follow_up_uses_legacy_chat" };
      }
      if (SKIP_ROUTER_CODES.has(route.code)) {
        return { handled: true, structured: baseResponse(formatNonAnswer({ status: "needs_clarification", code: route.code, reason: route.reason }), { meta: { route: "router", status: "needs_clarification", code: route.code, claudeCalls: 0 } }) };
      }
      // Freshness gate BEFORE paying for the planner. The planner decides sales vs purchase, so both are read;
      // if neither has ever synced, no plan could be answered and the planner is not called.
      const [salesFreshness, purchaseFreshness] = await Promise.all([getFreshness(tenantId, "Sales"), getFreshness(tenantId, "Purchase")]);
      preFreshness = { sales: salesFreshness, purchase: purchaseFreshness };
      if (salesFreshness.state === "never_synced" && purchaseFreshness.state === "never_synced") {
        tm.freshnessStatus = "never_synced";
        const msg = `${salesFreshness.message} ${purchaseFreshness.message}`.trim();
        return { handled: true, structured: baseResponse(msg, { toolCalls: [{ toolName: "query_engine", state: "no_usable_data" }], warnings: [msg], freshness: salesFreshness, meta: { route: "router", status: "no_usable_data", claudeCalls: 0 } }) };
      }

      const tp = now();
      // Validated against the SAME tenant reference date (the date is never sent to Claude).
      const planned = await planQuestion(userMessage, { claudeClient: deps.plannerClient || getPlannerClient(), resolveEntity, routerCode: route.code, referenceDate });
      tm.plannerLatencyMs = now() - tp;
      plannerUsage = planned.usage;
      tm.plannerStatus = planned.status;
      tm.plannerCode = planned.code || null;
      if (plannerUsage) {
        tm.plannerAttempts = plannerUsage.calls;
        tm.plannerInputTokens = plannerUsage.input_tokens;
        tm.plannerOutputTokens = plannerUsage.output_tokens;
        tm.plannerCacheReadTokens = plannerUsage.cache_read_input_tokens;
        tm.plannerCacheCreationTokens = plannerUsage.cache_creation_input_tokens;
      }
      if (planned.status === "needs_clarification" || planned.status === "unsupported") {
        const answer = planned.status === "unsupported" ? `${planned.reason}\n\n${SCOPE_HINT}` : formatNonAnswer(planned);
        return { handled: true, structured: baseResponse(answer, { meta: { route: "planner", status: planned.status, code: planned.code, claudeCalls: plannerUsage.calls, usage: plannerUsage } }) };
      }
      if (planned.status !== "supported") {
        // Planner failure / timeout / unusable plan: answer honestly. Never hand the question to another Claude path.
        return { handled: true, structured: baseResponse(plannerFailureMessage(planned), { meta: { route: "planner", status: "planner_failed", code: planned.code, claudeCalls: plannerUsage.calls, usage: plannerUsage } }) };
      }
      plan = planned.plan;
      source = "planner";
      plannerAssumptions = planned.plannerAssumptions || [];
      routerAssumptions = planned.definitionNotes || []; // fixed server-side definitions (e.g. revenue basis), same text as the router's
      revenueBasis = routerAssumptions.some((a) => a.code === REVENUE_ASSUMPTION.code);
    }
    // The structured context a follow-up needs (stored on the assistant message by the controller; never sent to Claude).
    const queryContext = followUp.buildQueryState(plan, { revenue: revenueBasis });

    // ---- freshness gate: never present numbers for a company that never synced
    // sales_return/purchase_return freshness tracks the Credit/Debit Note sync checkpoints
    // (tallySyncWorker.js's CREDIT_NOTE_SYNC_MODULE/DEBIT_NOTE_SYNC_MODULE), never Sales/Purchase's.
    const VOUCHER_TYPE_BY_ENTITY = { sales: "Sales", purchase: "Purchase", sales_return: "Credit Note", purchase_return: "Debit Note" };
    const voucherType = VOUCHER_TYPE_BY_ENTITY[plan.entity] || "Sales";
    const freshness = preFreshness ? preFreshness[plan.entity] : await getFreshness(tenantId, voucherType);
    tm.freshnessStatus = freshness.state;
    const meta = { route: source, status: "answered", claudeCalls: plannerUsage ? plannerUsage.calls : 0, usage: plannerUsage || undefined };
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
        // Final: "new party" needs the ledger master; the legacy chat must never guess it from voucher history.
        return { handled: true, structured: baseResponse(result.errors[0].message, { warnings: [], freshness, meta: { ...meta, status: "unsupported", code, cache: cache && cache.status } }) };
      }
      if (source === "planner" || source === "follow_up") {
        // Already paid for the planner: do not add a second Claude path on top of an engine failure.
        return { handled: true, structured: baseResponse(COMPUTE_FAILED_MESSAGE, { warnings: [], freshness, meta: { ...meta, status: "execution_failed", code: code || "failed", cache: cache && cache.status } }) };
      }
      if (mentionsRevenue(userMessage)) return revenueNoLegacy(COMPUTE_FAILED_MESSAGE, `execution_${code || "failed"}`, freshness);
      return { handled: false, reason: `execution_${code || "failed"}` };
    }

    const formatted = formatQueryAnswer({ plan, result, routerAssumptions, plannerAssumptions, source, contextNotes });
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
      }),
    };
  } catch (error) {
    // Never break chat: log name/message only (no question, no data) and let the legacy path run.
    console.error("QUERY ENGINE CHAT fallback:", error && error.name, error && error.message);
    if (mentionsRevenue(userMessage)) return revenueNoLegacy(COMPUTE_FAILED_MESSAGE, "exception");
    return { handled: false, reason: "exception" };
  }
}

// The controller's per-turn telemetry hooks, re-exported so queryChat stays its single entry point into services/query.
const chatTelemetry = { now, meterClaudeClient: turnTelemetry.meterClaudeClient, emitChatTurn: turnTelemetry.emitChatTurn };

module.exports = { tryAnswerWithQueryEngine, getTenantResolver, createTurnDates, chatTelemetry };
