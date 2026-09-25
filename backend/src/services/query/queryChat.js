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

const { routeQuestion } = require("./localRouter");
const { planQuestion, SKIP_ROUTER_CODES, createAnthropicPlannerClient } = require("./planner");
const { createEntityResolver } = require("./entityResolver");
const { formatQueryAnswer, formatNonAnswer, SCOPE_HINT } = require("./answerFormatter");

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

const FRESH_TO_STATE = { stale: "stale_data", sync_failed: "sync_failed", never_synced: "no_usable_data" };

// Honest, fixed text for a planner that failed. Only the entity-check message carries planner output, and that
// text is already sanitised and length-capped by the planner.
function plannerFailureMessage(planned) {
  if (planned.code === "planner_timeout" || planned.code === "planner_call_failed") {
    return "The AI query planner is unavailable right now, so I couldn't answer this. Please try again shortly, or ask a direct question such as \"sales last month\" or \"top 5 customers this month\".";
  }
  if (planned.code === "planner_entity_not_resolved") {
    return `${planned.reason} Please check the name and try again.`;
  }
  return "I couldn't turn this question into a query I can run safely. Please rephrase it, for example by naming the period and whether it is about sales or purchases.";
}

// ---------------------------------------------------------------- main entry

/**
 * @param {object} p
 * @param {{tenantId:string}} p.context  authorization-verified context from the middleware
 * @param {string} p.userMessage
 * @param {Array} [p.conversationHistory]
 * @param {object} [p.deps] injectable for tests: {resolveEntity, execute(plan, {tenantId}), plannerClient, getFreshness}
 * @returns {Promise<{handled:false, reason:string} | {handled:true, structured:object}>}
 */
async function tryAnswerWithQueryEngine({ context, userMessage, conversationHistory = [], deps = {} }) {
  try {
    if (disabled()) return { handled: false, reason: "disabled" };
    if (!context || typeof context.tenantId !== "string" || !context.tenantId) return { handled: false, reason: "no_tenant_context" };
    if (typeof userMessage !== "string") return { handled: false, reason: "invalid_message" };
    const tenantId = context.tenantId;

    const resolveEntity = deps.resolveEntity || getTenantResolver(tenantId);
    const route = await routeQuestion(userMessage, { resolveEntity });

    // ---- Claude-free honest answers
    if (route.status === "unsupported") {
      return { handled: true, structured: baseResponse(formatNonAnswer(route), { meta: { route: "router", status: "unsupported", code: route.code, claudeCalls: 0 } }) };
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
      if (conversationHistory.length > 0) return { handled: false, reason: "follow_up_uses_legacy_chat" };
      if (SKIP_ROUTER_CODES.has(route.code)) {
        return { handled: true, structured: baseResponse(formatNonAnswer({ status: "needs_clarification", code: route.code, reason: route.reason }), { meta: { route: "router", status: "needs_clarification", code: route.code, claudeCalls: 0 } }) };
      }
      // Freshness gate BEFORE paying for the planner. The planner decides sales vs purchase, so both are read;
      // if neither has ever synced, no plan could be answered and the planner is not called.
      const [salesFreshness, purchaseFreshness] = await Promise.all([getFreshness(tenantId, "Sales"), getFreshness(tenantId, "Purchase")]);
      preFreshness = { sales: salesFreshness, purchase: purchaseFreshness };
      if (salesFreshness.state === "never_synced" && purchaseFreshness.state === "never_synced") {
        const msg = `${salesFreshness.message} ${purchaseFreshness.message}`.trim();
        return { handled: true, structured: baseResponse(msg, { toolCalls: [{ toolName: "query_engine", state: "no_usable_data" }], warnings: [msg], freshness: salesFreshness, meta: { route: "router", status: "no_usable_data", claudeCalls: 0 } }) };
      }

      const planned = await planQuestion(userMessage, { claudeClient: deps.plannerClient || getPlannerClient(), resolveEntity, routerCode: route.code });
      plannerUsage = planned.usage;
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
    }

    // ---- freshness gate: never present numbers for a company that never synced
    const voucherType = plan.entity === "sales" ? "Sales" : "Purchase";
    const freshness = preFreshness ? preFreshness[plan.entity] : await getFreshness(tenantId, voucherType);
    const meta = { route: source, status: "answered", claudeCalls: plannerUsage ? plannerUsage.calls : 0, usage: plannerUsage || undefined };
    if (freshness.state === "never_synced") {
      return { handled: true, structured: baseResponse(freshness.message, { toolCalls: [{ toolName: "query_engine", state: "no_usable_data" }], warnings: [freshness.message], freshness, meta: { ...meta, status: "no_usable_data" } }) };
    }

    // ---- cache + engine (tenant-scoped executor; tenantId comes from the middleware context only)
    const exec = deps.execute || ((p, c) => getSharedExecutor().execute(p, c));
    const { result, cache } = await exec(plan, { tenantId });
    if (!result || result.ok !== true) {
      const code = result && result.errors && result.errors[0] && result.errors[0].code;
      if (NO_FALLBACK_EXEC_ERRORS.has(code)) {
        const msg = code === "query_timeout" ? "That question took too long to compute. Try a shorter period or a narrower breakdown." : "That question returned too much data to summarise. Try a narrower filter or period.";
        return { handled: true, structured: baseResponse(msg, { warnings: [], freshness, meta: { ...meta, status: "execution_failed", code, cache: cache && cache.status } }) };
      }
      if (source === "planner") {
        // Already paid for the planner: do not add a second Claude path on top of an engine failure.
        return { handled: true, structured: baseResponse("I couldn't compute that answer right now. Please try again shortly.", { warnings: [], freshness, meta: { ...meta, status: "execution_failed", code: code || "failed", cache: cache && cache.status } }) };
      }
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
    return { handled: false, reason: "exception" };
  }
}

module.exports = { tryAnswerWithQueryEngine, getTenantResolver };
