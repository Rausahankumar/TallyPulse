/**
 * Cache and AI-cost baseline (Phase 0, measurement only): one fixed, scripted conversation run through the REAL chat turn
 * (queryChat.tryAnswerWithQueryEngine), twice - with the planner response cache and the answer cache OFF, then ON - and the
 * per-turn counters the turn itself reports (telemetry event -> AiTurnUsage record): model calls, planner-cache
 * hits/misses/bypasses, engine executions by answer-cache status, insight runs.
 *
 * Offline and deterministic: a scripted model (no network, no paid call), an in-memory engine (no database), synthetic names,
 * fixed reference dates. It reports CALL COUNTS, never money (no pricing basis is approved). Real savings depend on the
 * configured model and on how often identical requests recur in production; this does not measure either.
 *
 * Run: node eval-cache-baseline.js        (prints the table; exit 1 if an invariant breaks)
 * Used by verify-cache-telemetry.js (runBaseline).
 */

process.env.AI_USAGE_PERSIST = "off";

const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");
const { createPlannerResponseCache } = require("./src/services/query/plannerResponseCache");
const { createAnswerCache } = require("./src/services/query/answerCache");
const { validateQueryPlan } = require("./src/services/query/validator");
const { buildTurnEvent } = require("./src/services/query/turnTelemetry");
const { buildUsageRecord } = require("./src/services/query/usageStore");
const { PLANNER_TOOL_NAME } = require("./src/services/query/planner");
const { EVIDENCE_LEAD } = require("./src/services/query/analysisPlanner"); // marks the investigation's follow-up request

const sales = (p) => ({ v: 1, entity: "sales", mode: "aggregate", groupBy: [], filters: [], metrics: ["invoiceAmount"], ...p });
const AUG = { kind: "custom", from: "2025-08-01", to: "2025-08-31" };
const OCT = { kind: "custom", from: "2025-10-01", to: "2025-10-31" };
const SEP = { kind: "custom", from: "2025-09-01", to: "2025-09-30" };
const PLANS = {
  aug: sales({ period: AUG }),
  byCustomer: sales({ period: AUG, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 10 }),
  lastMonth: sales({ period: { kind: "previous_month" } }),
  why: { v: 1, steps: [{ id: "tot", kind: "query", plan: sales({ period: OCT, compare: { mode: "custom", period: SEP } }) }, { id: "disc", kind: "insight", tool: "discount_summary", args: { period: OCT } }] },
};
const Q = {
  aug: "sales August 2025",
  augParaphrase: "how much did we sell in August 2025",
  byCustomer: "and by customer?",
  why: "Why did sales fall in October 2025 compared with September 2025, and what should I do?",
  lastMonth: "sales last month",
};

/** The scripted model: a reply chosen from the request (the question and the tool), like a perfect planner would. */
function scriptedModel() {
  const model = async (req) => {
    model.calls += 1;
    const text = JSON.stringify(req.messages);
    let input;
    if (req.tool_choice.name === PLANNER_TOOL_NAME) {
      if (text.includes("Why did sales fall")) input = { decline: { code: "needs_analysis", message: "several analyses" } };
      else if (text.includes(Q.byCustomer)) input = { plan: PLANS.byCustomer };
      else if (text.includes(Q.lastMonth)) input = { plan: PLANS.lastMonth };
      else input = { plan: PLANS.aug };
    } else {
      // the investigation's follow-up call carries the findings summary; the first analysis call does not
      input = text.includes(JSON.stringify(EVIDENCE_LEAD).slice(1, -1)) ? { decline: { code: "not_a_data_query", message: "the findings are enough" } } : { analysis: PLANS.why, actions: true };
    }
    return { content: [{ type: "tool_use", id: `tu${model.calls}`, name: req.tool_choice.name, input }], stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 100 } };
  };
  model.calls = 0;
  return model;
}

/** The engine: the period from the plan and the turn's own reference date (as the executor resolves it); counts computes. */
function engine(state) {
  return async (plan, ctx) => {
    state.computes += 1;
    const n = validateQueryPlan(plan, { referenceDate: ctx.referenceDate }).normalized;
    const grouped = (plan.groupBy || []).length > 0;
    return {
      ok: true, entity: plan.entity, mode: "aggregate", metrics: plan.metrics, groupBy: plan.groupBy || [], truncated: false, warnings: [], assumptions: [], rowLimit: plan.limit || 10,
      amountBasis: { invoiceAmount: "voucher_total_incl_tax" },
      period: { from: n.period.from.toISOString(), to: n.period.to.toISOString(), label: n.period.label || null },
      comparison: n.comparison ? { from: n.comparison.from.toISOString(), to: n.comparison.to.toISOString(), label: n.comparison.label || null } : null,
      rows: grouped ? [{ key: { customer: "Synthetic Alpha" }, values: { invoiceAmount: 700 } }, { key: { customer: "Synthetic Beta" }, values: { invoiceAmount: 300 } }] : [],
      totals: n.comparison ? { values: { invoiceAmount: 800 }, comparison: { invoiceAmount: { previous: 1000, delta: -200, deltaPct: -20 } } } : { values: { invoiceAmount: 1000 } },
    };
  };
}

const DC = (ref) => ({ referenceDate: ref, source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 31), coverage: { earliest: new Date(2025, 0, 1), latest: new Date(2025, 11, 31), lastSyncedAt: null } });
const REF = new Date(2026, 9, 28, 23, 59, 59, 999); // end of a local day, as referenceDate.js makes it
const HISTORY = [{ role: "user", content: "(earlier)" }, { role: "assistant", content: "(answer)" }];

/**
 * @param {{caches: boolean}} options caches on = the production arrangement (planner response cache + answer cache)
 * @returns {Promise<{caches:boolean, turns:object[], totals:object}>}
 */
async function runBaseline({ caches }) {
  const model = scriptedModel();
  const state = { computes: 0, version: "v1" };
  const plannerCache = caches ? createPlannerResponseCache() : null;
  const answers = caches ? createAnswerCache() : null;
  const compute = engine(state);
  const execute = caches
    ? (plan, ctx) => answers.run(plan, ctx, { execute: compute, getVersion: async () => state.version })
    : async (plan, ctx) => ({ result: await compute(plan, ctx), cache: { status: "bypass", reason: "disabled" } });
  const insight = async () => ({ ok: false, error: { code: "tool_not_ready", message: "Synthetic: not run offline." } });
  const turns = [];
  const chats = {};
  async function ask(label, question, { chat = null, tenantId = "T-BASE", ref = REF } = {}) {
    const previousQuery = chat && chats[chat] ? chats[chat] : null;
    const callsBefore = model.calls, computesBefore = state.computes;
    const out = await tryAnswerWithQueryEngine({
      context: { tenantId, userId: "u" }, userMessage: question, conversationHistory: previousQuery ? HISTORY : [], previousQuery,
      deps: { plannerClient: model, plannerResponseCache: plannerCache, analysisEnabled: true, execute, runInsightTool: insight, getFreshness: async () => ({ state: "fresh", message: "", dataAsOf: null }), getDateContext: async () => DC(ref), resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) },
    });
    if (chat) chats[chat] = out.queryContext || null;
    const record = buildUsageRecord(buildTurnEvent({ tenantId, requestId: null, metrics: { ...out.telemetry, ok: true, httpStatus: 200, totalLatencyMs: 0 } }));
    turns.push({
      label, status: out.structured.details.queryEngine.status,
      modelCallsActual: model.calls - callsBefore, engineComputesActual: state.computes - computesBefore,
      claudeCalls: record.claudeCalls, plannerCacheHits: record.plannerCacheHits, plannerCacheMisses: record.plannerCacheMisses, plannerCacheBypasses: record.plannerCacheBypasses,
      queryExecutions: record.queryExecutions, answerCacheHits: record.answerCacheHits, answerCacheMisses: record.answerCacheMisses, answerCacheCoalesced: record.answerCacheCoalesced, answerCacheBypasses: record.answerCacheBypasses, insightRuns: record.insightRuns,
      record,
    });
  }
  await ask("1 first question", Q.aug, { chat: "A" });
  await ask("2 exact repeat, new chat", Q.aug, { chat: "B" });
  await ask("3 paraphrase, new chat", Q.augParaphrase, { chat: "C" });
  await ask("4 same-chat repeat #1", Q.aug, { chat: "A" });
  await ask("5 same-chat repeat #2", Q.aug, { chat: "A" });
  await ask("6 follow-up (by customer)", Q.byCustomer, { chat: "A" });
  await ask("7 why question", Q.why, { chat: "D" });
  await ask("8 why question repeated", Q.why, { chat: "E" });
  state.version = "v2"; // a sync wrote data
  await ask("9 after a data change", Q.aug, { chat: "F" });
  await ask("10 last month, 23:59:50", Q.lastMonth, { chat: "G", ref: new Date(2025, 9, 31, 23, 59, 50) });
  await ask("11 last month, 00:00:10", Q.lastMonth, { chat: "H", ref: new Date(2025, 10, 1, 0, 0, 10) });
  await ask("12 other company, same words", Q.aug, { chat: "I", tenantId: "T-OTHER" });
  const sum = (k) => turns.reduce((t, x) => t + (x[k] || 0), 0);
  const totals = Object.fromEntries(["modelCallsActual", "claudeCalls", "plannerCacheHits", "plannerCacheMisses", "plannerCacheBypasses", "engineComputesActual", "queryExecutions", "answerCacheHits", "answerCacheMisses", "answerCacheCoalesced", "answerCacheBypasses", "insightRuns"].map((k) => [k, sum(k)]));
  return { caches, turns, totals };
}

function table(run) {
  const cols = ["status", "modelCallsActual", "claudeCalls", "plannerCacheHits", "plannerCacheMisses", "engineComputesActual", "queryExecutions", "answerCacheHits", "answerCacheMisses", "insightRuns"];
  const short = { status: "status", modelCallsActual: "model", claudeCalls: "claude", plannerCacheHits: "pHit", plannerCacheMisses: "pMiss", engineComputesActual: "engine", queryExecutions: "exec", answerCacheHits: "aHit", answerCacheMisses: "aMiss", insightRuns: "insight" };
  const lines = [`caches ${run.caches ? "ON" : "OFF"}`, ["turn".padEnd(30), ...cols.map((c) => short[c].padStart(9))].join("")];
  for (const t of run.turns) lines.push([t.label.padEnd(30), ...cols.map((c) => String(t[c]).padStart(9))].join(""));
  lines.push(["TOTAL".padEnd(30), "".padStart(9), ...cols.slice(1).map((c) => String(run.totals[c]).padStart(9))].join(""));
  return lines.join("\n");
}

/** Invariants that must hold in both runs: reported model calls are actual model calls, never cache hits. */
function invariants(run) {
  const broken = [];
  for (const t of run.turns) {
    if (t.claudeCalls !== t.modelCallsActual) broken.push(`${t.label}: claudeCalls ${t.claudeCalls} != actual ${t.modelCallsActual}`);
    if (t.plannerCacheMisses !== (run.caches ? t.modelCallsActual : 0)) broken.push(`${t.label}: planner misses ${t.plannerCacheMisses} vs actual calls ${t.modelCallsActual}`);
    if (!run.caches && t.plannerCacheHits) broken.push(`${t.label}: a hit with the cache off`);
    if (t.answerCacheMisses + t.answerCacheBypasses !== t.engineComputesActual) broken.push(`${t.label}: engine computes ${t.engineComputesActual} != misses+bypasses ${t.answerCacheMisses + t.answerCacheBypasses}`);
    if (t.answerCacheHits + t.answerCacheMisses + t.answerCacheCoalesced + t.answerCacheBypasses !== t.queryExecutions) broken.push(`${t.label}: executions do not add up`);
    if (t.status !== "answered") broken.push(`${t.label}: not answered (${t.status})`);
  }
  return broken;
}

module.exports = { runBaseline, invariants, table, Q };

if (require.main === module) {
  (async () => {
    const off = await runBaseline({ caches: false });
    const on = await runBaseline({ caches: true });
    console.log(table(off));
    console.log("");
    console.log(table(on));
    console.log(`\nModel calls: ${off.totals.modelCallsActual} with caches off, ${on.totals.modelCallsActual} with caches on (call counts only; no money: no pricing basis is approved).`);
    console.log(`Engine computes: ${off.totals.engineComputesActual} off, ${on.totals.engineComputesActual} on.`);
    const broken = [...invariants(off), ...invariants(on)];
    if (broken.length) {
      console.log(`\nINVARIANTS BROKEN:\n${broken.join("\n")}`);
      process.exit(1);
    }
    console.log("\nInvariants held: reported model calls = actual model calls in every turn; engine computes = answer-cache misses + bypasses.");
  })().catch((e) => { console.error(e); process.exit(1); });
}
