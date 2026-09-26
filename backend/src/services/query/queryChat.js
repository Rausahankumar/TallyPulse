"use strict";

// --------------------------------------------------
// Chat wiring for the Sales/Purchase Query Engine (Phase 1G).
//
//   question -> deterministic router
//        supported            -> validated plan ---------------------\
//        unsupported          -> honest message (NO Claude)           |
//        needs_planner:                                               v
//            with chat history -> not handled here (legacy chat path keeps follow-up context)
//            dead-end code     -> clarification message (NO Claude)
//            otherwise         -> freshness gate (both entities) -> ONE bounded Claude planner call
//                                 -> validated plan | decline | honest failure message (never legacy chat)
//   plan -> freshness gate -> answer cache -> executor (tenant-scoped) -> deterministic text
//
// Fail-safe: anything this module cannot answer returns {handled:false} and the
// existing chat path runs exactly as before - EXCEPT once the planner has been
// called: then the turn always ends here, so no second Claude path is paid for.
// It never throws to the caller.
// Tenant scope comes ONLY from `context.tenantId` (set by the authorization
// middleware); no tenant value is read from the question, the planner or the plan.
// --------------------------------------------------

const { routeQuestion, mentionsRevenue } = require("./localRouter");
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
 * @param {object} [p.deps] injectable for tests: {resolveEntity, entityIndex, execute(plan, {tenantId}, timing), plannerClient, getFreshness}
 * @returns {Promise<{handled:false, reason:string} | {handled:true, structured:object}>}
 */
async function tryAnswerWithQueryEngine(args) {
  const tm = newTurnMetrics();
  const t0 = now();
  const out = await answerTurn(args, tm);
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
  else if (meta.status === "revenue_not_answered") tm.path = "revenue_guard";
  else if (meta.route === "planner") tm.path = meta.status === "planner_failed" ? "planner_failed" : meta.status === "unsupported" || meta.status === "needs_clarification" ? "planner_declined" : "planner";
  else if (meta.status === "unsupported") tm.path = "router_unsupported";
  else if (meta.status === "needs_clarification") tm.path = "router_clarification";
  else if (meta.status === "no_usable_data") tm.path = "no_usable_data";
  else tm.path = "router_supported";
}

async function answerTurn({ context, userMessage, conversationHistory = [], deps = {} }, tm) {
  try {
    if (disabled()) return { handled: false, reason: "disabled" };
    if (!context || typeof context.tenantId !== "string" || !context.tenantId) return { handled: false, reason: "no_tenant_context" };
    if (typeof userMessage !== "string") return { handled: false, reason: "invalid_message" };
    const tenantId = context.tenantId;

    const tenantResolver = deps.resolveEntity || getTenantResolver(tenantId);
    const resolveEntity = timeResolver(tenantResolver, tm);
    // P1-2: the same tenant-bound resolver's name index lets the router keep known names opaque to its grammar.
    const entityIndex = timeEntityIndex(deps.entityIndex || tenantResolver.spanIndex, tm);
    const route = await routeQuestion(userMessage, { resolveEntity, entityIndex });
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

    let plan;
    let source;
    let plannerAssumptions = [];
    let routerAssumptions = [];
    let plannerUsage = null;
    let preFreshness = null; // freshness read BEFORE the planner, keyed by entity
    const getFreshness = deps.getFreshness || require("../analytics/freshness").getFreshness;

    if (route.status === "supported") {
      plan = route.plan;
      source = "router";
      routerAssumptions = route.assumptions || [];
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
      const planned = await planQuestion(userMessage, { claudeClient: deps.plannerClient || getPlannerClient(), resolveEntity, routerCode: route.code });
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
    }

    // ---- freshness gate: never present numbers for a company that never synced
    const voucherType = plan.entity === "sales" ? "Sales" : "Purchase";
    const freshness = preFreshness ? preFreshness[plan.entity] : await getFreshness(tenantId, voucherType);
    tm.freshnessStatus = freshness.state;
    const meta = { route: source, status: "answered", claudeCalls: plannerUsage ? plannerUsage.calls : 0, usage: plannerUsage || undefined };
    if (freshness.state === "never_synced") {
      return { handled: true, structured: baseResponse(freshness.message, { toolCalls: [{ toolName: "query_engine", state: "no_usable_data" }], warnings: [freshness.message], freshness, meta: { ...meta, status: "no_usable_data" } }) };
    }

    // ---- cache + engine (tenant-scoped executor; tenantId comes from the middleware context only)
    const exec = deps.execute || ((p, c, timing) => getSharedExecutor().execute(p, c, timing));
    const timing = {}; // filled by the production cached executor: when the engine started and how long it ran
    const te = now();
    const { result, cache } = await exec(plan, { tenantId }, timing);
    recordExecution(tm, { te, done: now(), timing, cache, result });
    if (!result || result.ok !== true) {
      const code = result && result.errors && result.errors[0] && result.errors[0].code;
      if (NO_FALLBACK_EXEC_ERRORS.has(code)) {
        const msg = code === "query_timeout" ? "That question took too long to compute. Try a shorter period or a narrower breakdown." : "That question returned too much data to summarise. Try a narrower filter or period.";
        return { handled: true, structured: baseResponse(msg, { warnings: [], freshness, meta: { ...meta, status: "execution_failed", code, cache: cache && cache.status } }) };
      }
      if (source === "planner") {
        // Already paid for the planner: do not add a second Claude path on top of an engine failure.
        return { handled: true, structured: baseResponse(COMPUTE_FAILED_MESSAGE, { warnings: [], freshness, meta: { ...meta, status: "execution_failed", code: code || "failed", cache: cache && cache.status } }) };
      }
      if (mentionsRevenue(userMessage)) return revenueNoLegacy(COMPUTE_FAILED_MESSAGE, `execution_${code || "failed"}`, freshness);
      return { handled: false, reason: `execution_${code || "failed"}` };
    }

    const formatted = formatQueryAnswer({ plan, result, routerAssumptions, plannerAssumptions, source });
    const warnings = [...formatted.warnings];
    if (freshness.state !== "fresh") warnings.push(freshness.message);
    const state = freshness.state !== "fresh" ? FRESH_TO_STATE[freshness.state] : formatted.zero ? "zero_result" : "valid_data";
    return {
      handled: true,
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

module.exports = { tryAnswerWithQueryEngine, getTenantResolver, chatTelemetry };
