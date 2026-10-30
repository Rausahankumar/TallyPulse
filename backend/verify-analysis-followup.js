/**
 * Follow-up context after an ANALYSIS turn (Phase 2): the scope every executed query step shares is saved as the turn's
 * queryContext (followUp.buildAnalysisState), re-read strictly (readQueryState) on the next turn, and given to the analysis
 * planner (planAnalysis previousScope), whose per-step guards read it like a previous plan.
 *
 * The REAL controller (sendChatMessage), chat turn, planners' checks and executor run; the model replies are scripted, the
 * engine is in memory and the Chat model's database calls are captured (no database, no network, no model).
 * Checks: the state builder keeps only shared scope (conflicts are dropped, never merged); strict re-reading of tampered
 * states; the controller saves the state and the next turn's planner request carries it - and a planner that USES it plans
 * the elliptical follow-up on the right product and periods; a tampered saved state is ignored; the query planner still
 * gets previous plans only from single-query turns; no tenant or result rows in what the model is sent.
 *
 * Run: node verify-analysis-followup.js
 */

process.env.AI_USAGE_PERSIST = "off";
process.env.ASK_AI_ANALYSIS = "on";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const followUp = require("./src/services/query/followUp");
const ap = require("./src/services/query/analysisPlanner");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 800)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const r2 = (n) => Math.round(n * 100) / 100;
const TENANT = "T-FOLLOWUP-0001";
const APPLE = "Apple Shimla 1kg";

// ---------------------------------------------------------------- 1. the state builder: shared scope only
{
  const q = (o) => ({ v: 1, entity: "sales", mode: "aggregate", metrics: ["lineAmount"], groupBy: [], filters: [{ dim: "product", op: "eq_ci", value: APPLE }], period: { kind: "custom", from: "2025-10-01", to: "2025-10-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" } }, ...o });
  const ok = (request) => ({ kind: "query", status: "ok", request });
  const full = followUp.buildAnalysisState([ok(q({})), ok(q({ groupBy: [{ dim: "customer" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 }))]);
  check("state-shared", "steps agreeing on entity, periods, comparison, product filter and metric carry all of them", JSON.stringify(full.carried) === JSON.stringify(["entity", "period", "compare", "filters", "metrics"]) && full.source === "analysis" && full.plan.filters[0].value === APPLE && full.plan.groupBy.length === 0 && !full.plan.sort, JSON.stringify(full));
  check("state-roundtrip", "the state re-reads strictly through readQueryState (JSON round trip) and scopeOf gives only the carried parts", (() => { const back = followUp.readQueryState(JSON.parse(JSON.stringify(full))); return !!back && JSON.stringify(followUp.scopeOf(back)) === JSON.stringify({ entity: "sales", period: full.plan.period, compare: full.plan.compare, filters: full.plan.filters, metrics: ["lineAmount"] }); })());
  const periods = followUp.buildAnalysisState([ok(q({ period: { kind: "all_time" }, compare: null, groupBy: [{ dim: "date", bucket: "month" }] })), ok(q({}))]);
  check("state-period-conflict", "steps over different periods: no period or comparison is carried (never picked), the product filter still is", JSON.stringify(periods.carried) === JSON.stringify(["entity", "filters", "metrics"]) && !followUp.scopeOf(periods).period && !followUp.scopeOf(periods).compare, JSON.stringify(periods));
  check("state-entity-conflict", "sales and purchase steps share no entity (nor a metric) but still their period, comparison and product filter: those are carried, never the entity", (() => { const s = followUp.buildAnalysisState([ok(q({})), ok(q({ entity: "purchase" }))]); return !!s && JSON.stringify(s.carried) === JSON.stringify(["period", "compare", "filters"]) && !("entity" in followUp.scopeOf(s)) && !!followUp.readQueryState(JSON.parse(JSON.stringify(s))); })());
  const products = followUp.buildAnalysisState([ok(q({})), ok(q({ filters: [{ dim: "product", op: "eq_ci", value: "Orange" }] }))]);
  check("state-filter-conflict", "different product filters: no filter carried (never merged)", !products.carried.includes("filters"), JSON.stringify(products));
  const bound = followUp.buildAnalysisState([ok(q({ groupBy: [{ dim: "customer" }] })), ok(q({ filters: [{ dim: "product", op: "eq_ci", value: APPLE }, { dim: "customer", op: "in_ci", value: ["Sharma Fruits"] }] }))]);
  check("state-bound-filter", "a filter bound from an earlier step's rows (one step only) is not carried; the shared product filter is", JSON.stringify(bound.plan.filters) === JSON.stringify([{ dim: "product", op: "eq_ci", value: APPLE }]));
  check("state-metric-conflict", "different metrics: no metric carried (basis falls back to amount), the state still re-reads strictly, and its scope shows no metric", (() => { const s = followUp.buildAnalysisState([ok(q({})), ok(q({ metrics: ["lineAmount", "quantity"] }))]); const back = followUp.readQueryState(JSON.parse(JSON.stringify(s))); return !s.carried.includes("metrics") && s.basis === "amount" && !!back && !("metrics" in followUp.scopeOf(back)); })());
  check("state-all-conflicts-readable", "every partial state the builder makes re-reads strictly (the schema fillers are valid; nothing partial is silently lost)", [periods, products, bound].every((s) => !!followUp.readQueryState(JSON.parse(JSON.stringify(s)))));
  check("state-no-query", "a turn with no successful query step saves nothing", followUp.buildAnalysisState([{ kind: "insight", status: "ok" }, { kind: "query", status: "failed", request: q({}) }]) === null);

  // strict re-reading: tampered states are ignored
  const bad = (patch) => followUp.readQueryState({ ...JSON.parse(JSON.stringify(full)), ...patch });
  check("read-tampered", "unknown carried key, nothing carried, a metric without its entity, duplicates, comparison without period, unknown source, or an invalid plan -> ignored", bad({ carried: ["entity", "tenantId"] }) === null && bad({ carried: [] }) === null && bad({ carried: ["metrics"] }) === null && bad({ carried: ["entity", "entity"] }) === null && bad({ carried: ["entity", "compare"] }) === null && bad({ source: "admin" }) === null && bad({ carried: "entity" }) === null && bad({ plan: { ...full.plan, entity: "ledger" } }) === null);
  const single = followUp.buildQueryState(q({}));
  check("read-single-unchanged", "a single-query state reads exactly as before (no source, no carried)", JSON.stringify(followUp.readQueryState(single)) === JSON.stringify({ plan: single.plan, basis: single.basis }));
  const pend = followUp.withPendingQuestion(followUp.readQueryState(periods), "which customers?");
  check("pending-keeps-marks", "a clarification keeps the analysis marks, so a partial scope never becomes a full plan", pend.source === "analysis" && JSON.stringify(pend.carried) === JSON.stringify(periods.carried) && JSON.stringify(followUp.readQueryState(pend).carried) === JSON.stringify(periods.carried));

  // the per-step year guard reads the carried periods like a previous plan
  const REF = new Date(2026, 9, 26);
  const stepPlan = { v: 1, steps: [{ id: "c", kind: "query", plan: q({ groupBy: [{ dim: "customer" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 }) }] };
  const noScope = ap.checkAnalysis("Which customers are behind this?", stepPlan, REF);
  const withScope = ap.checkAnalysis("Which customers are behind this?", stepPlan, REF, followUp.scopeOf(full));
  const notCarried = ap.checkAnalysis("Which customers are behind this?", stepPlan, REF, followUp.scopeOf(periods));
  check("guard-years", "a follow-up keeping the carried 2025 periods passes the year guard; without the scope - or with a scope that carried no period - it asks which year", !!noScope.refusal && noScope.refusal.code === "year_missing" && !!withScope.plan && !!notCarried.refusal && notCarried.refusal.code === "year_missing", JSON.stringify({ noScope: noScope.refusal, withScope: !!withScope.plan, notCarried: notCarried.refusal }));
}

// ---------------------------------------------------------------- 2. end to end through the real controller
(async () => {
  // in-memory engine: per product, sales by customer and purchases by supplier, [Oct, Sep] - Apple falls, Banana is flat
  const SALES = { [APPLE]: { "Sharma Fruits": [0, 4000], "Gupta Mart": [0, 3000], "Rao Traders": [1600, 1500] }, "Banana Robusta": { "Khan Stores": [2000, 2000], "Rao Traders": [500, 500] } };
  const BUYS = { [APPLE]: { "Himachal Orchards": [1800, 6000] }, "Banana Robusta": { "Fresh Farms": [2500, 2500] } };
  const day = (y, m, d, end) => (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
  const executed = [];
  const execute = async (plan, ctx) => {
    executed.push({ plan: JSON.parse(JSON.stringify(plan)), tenantId: ctx.tenantId });
    const source = plan.entity === "purchase" ? BUYS : SALES;
    const pf = (plan.filters || []).find((f) => f.dim === "product");
    const products = Object.keys(source).filter((p) => !pf || p === (Array.isArray(pf.value) ? pf.value[0] : pf.value));
    const dim = plan.groupBy[0] && plan.groupBy[0].dim;
    const m = plan.metrics[0];
    const groups = {};
    for (const p of products) for (const [party, [c, v]] of Object.entries(source[p])) { const k = dim ? party : ""; groups[k] = groups[k] || [0, 0]; groups[k][0] += c; groups[k][1] += v; }
    const rows = dim ? Object.entries(groups).map(([k, [c, v]]) => ({ key: { [dim]: k }, values: { [m]: c }, comparison: { [m]: { previous: v, delta: r2(c - v), deltaPct: null } } })).sort((a, b) => a.comparison[m].delta - b.comparison[m].delta) : [];
    const cur = Object.values(groups).reduce((t, x) => t + x[0], 0), prev = Object.values(groups).reduce((t, x) => t + x[1], 0);
    return { result: { ok: true, entity: plan.entity, mode: "aggregate", period: { from: day(2025, 10, 1), to: day(2025, 10, 31, true), label: "October 2025" }, comparison: plan.compare ? { from: day(2025, 9, 1), to: day(2025, 9, 30, true), label: "September 2025" } : null, metrics: plan.metrics, groupBy: plan.groupBy, rows, totals: { values: { [m]: cur }, comparison: { [m]: { previous: prev, delta: r2(cur - prev), deltaPct: null } } }, truncated: false, rowLimit: plan.limit || 10, warnings: [], assumptions: [] } };
  };
  const DC = { referenceDate: new Date(2026, 9, 26, 23, 59, 59, 999), source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 31), coverage: { earliest: new Date(2025, 0, 1), latest: new Date(2026, 9, 26), lastSyncedAt: null } };

  // the model: scripted replies; the follow-up's analysis reply is built FROM the scope it receives (a planner that uses it)
  const requests = [];
  const PERIODS = { period: { kind: "custom", from: "2025-10-01", to: "2025-10-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" } } };
  const DECLINE = { decline: { code: "needs_analysis", message: "several analyses" } };
  const turn1 = { v: 1, steps: [
    { id: "total", kind: "query", plan: { v: 1, entity: "sales", mode: "aggregate", ...PERIODS, metrics: ["lineAmount"], filters: [{ dim: "product", op: "eq_ci", value: APPLE }] } },
    { id: "customers", kind: "query", plan: { v: 1, entity: "sales", mode: "aggregate", ...PERIODS, metrics: ["lineAmount"], groupBy: [{ dim: "customer" }], filters: [{ dim: "product", op: "eq_ci", value: APPLE }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 } },
  ] };
  const scopeIn = (text) => { const m = /Previous turn's analysis scope[^\n]*\n(\{[^\n]*\})\n/.exec(text || ""); return m ? JSON.parse(m[1]) : null; };
  const usesScope = (req) => {
    const scope = scopeIn(req.messages[0].content);
    const base = scope ? { period: scope.period, compare: scope.compare, filters: scope.filters || [] } : { period: { kind: "previous_month" }, compare: { mode: "full_previous" }, filters: [] };
    const plan = (entity, metric, dim) => ({ v: 1, entity, mode: "aggregate", period: base.period, compare: base.compare, metrics: [metric], groupBy: [{ dim }], filters: base.filters, sort: [{ by: `${metric}.delta`, dir: "asc" }], limit: 5 });
    return { analysis: { v: 1, steps: [{ id: "who", kind: "query", plan: plan("sales", "lineAmount", "customer") }, { id: "supply", kind: "query", plan: plan("purchase", "lineAmount", "supplier") }] } };
  };
  let script = [];
  const model = async (req) => {
    requests.push(req);
    const next = script.shift();
    const input = typeof next === "function" ? next(req) : next;
    return { content: [{ type: "tool_use", name: req.tool_choice.name, input }], usage: { input_tokens: 1, output_tokens: 1 } };
  };

  // the real controller, with the real chat turn given these deps; the Chat model's database calls are captured
  const queryChat = require("./src/services/query/queryChat");
  const realTurn = queryChat.tryAnswerWithQueryEngine;
  queryChat.tryAnswerWithQueryEngine = (args) => realTurn({ ...args, getDateContext: async () => DC, deps: { plannerClient: model, analysisEnabled: true, execute, getFreshness: async () => ({ state: "fresh", message: "" }), getDateContext: async () => DC, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) } });
  const Chat = require("./src/models/chat.model");
  const saved = [];
  Chat.prototype.save = async function save() { saved.push(JSON.parse(JSON.stringify(this.toObject()))); return this; };
  let stored = null;
  Chat.findOne = async (filter) => (stored && filter.tenantId === TENANT && String(filter._id) === String(stored._id) ? Chat.hydrate(JSON.parse(JSON.stringify(stored))) : null);
  const { sendChatMessage } = require("./src/controllers/chatController");
  const mkRes = () => ({ statusCode: 0, body: null, destroyed: false, closed: false, writableFinished: false, on() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.writableFinished = true; return this; } });
  const mkReq = (message, chatId) => ({ id: "req-followup", body: { message }, params: chatId ? { chatId } : {}, companyContext: { tenantId: TENANT, companyGuid: "guid-followup" }, user: { id: "64b000000000000000000001" } });

  // turn 1: an analysis answer
  script = [DECLINE, { analysis: turn1 }];
  let res = mkRes();
  await sendChatMessage(mkReq("Why are apple sales declining in October 2025 compared with September 2025?"), res);
  const doc1 = saved[saved.length - 1];
  const qc = doc1 && doc1.messages[1] && doc1.messages[1].queryContext;
  check("persist-state", "the controller saves the analysis turn's queryContext on the assistant message (source analysis, scope carried)", res.statusCode === 200 && !!qc && qc.source === "analysis" && JSON.stringify(qc.carried) === JSON.stringify(["entity", "period", "compare", "filters", "metrics"]), JSON.stringify({ status: res.statusCode, qc }));
  check("persist-roundtrip", "the saved state re-reads strictly and holds no tenant, figures or rows", !!followUp.readQueryState(qc) && !JSON.stringify(qc).includes(TENANT) && !/Sharma|Gupta|4000|previous/.test(JSON.stringify(qc.plan.filters)), JSON.stringify(qc));

  // turn 2: the elliptical follow-up, through the controller on the saved chat
  stored = { ...doc1, _id: "64b0000000000000000000aa" };
  requests.length = 0; executed.length = 0;
  script = [DECLINE, usesScope];
  res = mkRes();
  await sendChatMessage(mkReq("Which customers and suppliers are behind this?", stored._id), res);
  const [qReq, aReq] = requests;
  const aText = aReq && aReq.messages[0].content;
  check("followup-query-planner", "the query planner gets the analysis scope in its own framing (never presented as a complete previous plan)", !!qReq && /^Previous turn's analysis scope/.test(qReq.messages[0].content) && !/Previous query plan/.test(qReq.messages[0].content) && /Question: Which customers and suppliers are behind this\?$/.test(qReq.messages[0].content), qReq && qReq.messages[0].content.slice(0, 300));
  check("followup-scope-sent", "the analysis planner's request carries the saved scope (product, periods, comparison) before the question", !!aText && /^Previous turn's analysis scope/.test(aText) && aText.includes(APPLE) && aText.includes("2025-09-01") && /Question: Which customers and suppliers are behind this\?$/.test(aText), aText);
  check("followup-no-leak", "nothing else is sent: no tenant id, no customer or supplier from the previous turn's rows", !!aText && !aText.includes(TENANT) && !/Sharma|Gupta|Rao|Himachal/.test(aText), aText);
  const ans = res.body && res.body.data && res.body.data.answer;
  check("followup-used", "the follow-up was planned and run on the carried scope: every query is restricted to the apple product over Oct vs Sep 2025, for this tenant", executed.length === 2 && executed.every((e) => e.tenantId === TENANT && e.plan.filters.some((f) => f.dim === "product" && f.value === APPLE) && e.plan.period.from === "2025-10-01" && e.plan.compare.period.from === "2025-09-01"), JSON.stringify(executed.map((e) => e.plan)));
  check("followup-answer", "the answer names apple's customers and supplier (Sharma Fruits, Gupta Mart, Himachal Orchards) and none of the banana-only parties", res.statusCode === 200 && /Sharma Fruits/.test(ans) && /Gupta Mart/.test(ans) && /Himachal Orchards/.test(ans) && !/Khan Stores|Fresh Farms/.test(ans), ans && ans.slice(0, 900));
  const doc2 = saved[saved.length - 1];
  check("followup-new-state", "the follow-up saves its own state: its sales and purchase steps share the period, comparison and product, not an entity or metric (never merged)", doc2.messages.length === 4 && JSON.stringify(doc2.messages[3].queryContext.carried) === JSON.stringify(["period", "compare", "filters"]), JSON.stringify(doc2.messages[3] && doc2.messages[3].queryContext));

  // a tampered saved state is ignored: no scope is sent, the turn still answers (company-wide)
  const tampered = JSON.parse(JSON.stringify(doc1));
  tampered.messages[1].queryContext.carried = ["entity", "tenantId"];
  stored = { ...tampered, _id: "64b0000000000000000000bb" };
  requests.length = 0; executed.length = 0;
  script = [DECLINE, usesScope];
  res = mkRes();
  await sendChatMessage(mkReq("Which customers and suppliers are behind this?", stored._id), res);
  check("followup-tampered", "a tampered saved state is ignored: no scope reaches the planner and nothing is restricted by it; the turn still answers", res.statusCode === 200 && requests.length === 2 && !/Previous turn's analysis scope/.test(requests[1].messages[0].content) && executed.every((e) => !e.plan.filters.length), JSON.stringify({ status: res.statusCode, filters: executed.map((e) => e.plan.filters) }));

  queryChat.tryAnswerWithQueryEngine = realTurn;
  console.log(`\nverify-analysis-followup: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
