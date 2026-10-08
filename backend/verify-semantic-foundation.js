"use strict";

/**
 * Semantic Foundation & Context (P-SF) - focused deterministic suite.
 *
 * There is no deterministic router: the planner interprets every question. This suite pins what the product does with
 * a correct interpretation (the plan fixtures below), independent of the language that produced it:
 *   A. ONE tenant reference date per turn: the rule, future-dated vouchers (rule kept + disclosed), memoisation,
 *      and the SAME period boundaries through the engine and the planner
 *   B. relative periods: engine boundaries vs an INDEPENDENT calendar oracle at month-end, 29 Feb, FY-start and
 *      mid-month anchors
 *   C. data coverage (>= 30 plans): covered / partial / outside, deterministic refusals and caveats, never a zero
 *   H. month comparisons (decision 2, enforced by the planner): complete period vs same days disclosed, never silently changed
 *   I. synthetic tenant (real MongoDB, real engine): no-data vs zero, coverage, growth, new/lost and a controller
 *      round trip, every figure checked against an INDEPENDENT oracle (plain arithmetic over the inserted vouchers)
 *   J. safety: plans carry no tenant/operator fields, stored context is untrusted, no network at all
 *
 * Writes ONLY a synthetic tenant ("verify-semantic-foundation-*": vouchers through the raw driver, one chat) and
 * deletes it afterwards. Real tenants are not read. No Anthropic, no Tally (all network is disabled).
 * Run: node verify-semantic-foundation.js
 */

require("dotenv").config();
const http = require("http");
const https = require("https");

let netCalls = 0;
const savedNet = { fetch: global.fetch, h: http.request, s: https.request };
global.fetch = async () => { netCalls += 1; throw new Error("network disabled in this suite"); };
http.request = () => { netCalls += 1; throw new Error("network disabled in this suite"); };
https.request = () => { netCalls += 1; throw new Error("network disabled in this suite"); };

// Freshness is not what this suite tests: every entity is "fresh" (the freshness gate has its own suites).
const freshPath = require.resolve("./src/services/analytics/freshness");
require.cache[freshPath] = { id: freshPath, filename: freshPath, loaded: true, exports: { getFreshness: async () => ({ state: "fresh", dataAsOf: new Date("2025-06-30T10:00:00Z"), message: "Data is current." }) } };

const fs = require("fs");
const { validateQueryPlan } = require("./src/services/query/validator");
const { parseQueryPlan } = require("./src/services/query/queryPlan.schema");
const { createEntityResolver } = require("./src/services/query/entityResolver");
const { planQuestion, PLANNER_TOOL_NAME } = require("./src/services/query/planner");
// The controller round trip (section I) reaches the planner through queryChat's lazily created client: that factory is
// replaced BEFORE queryChat loads by a scripted client; sections that call queryChat directly inject their own.
const plannerModule = require("./src/services/query/planner");
const controllerPlanner = { impl: async () => { throw Object.assign(new Error("no planner scripted"), { code: "AI_NOT_CONFIGURED" }); } };
plannerModule.createAnthropicPlannerClient = () => async (request, opts) => controllerPlanner.impl(request, opts);
const { tryAnswerWithQueryEngine, createTurnDates } = require("./src/services/query/queryChat");
const { readQueryState } = require("./src/services/query/followUp");
const { formatQueryAnswer, fmtMoney } = require("./src/services/query/answerFormatter");
const { buildDateContext } = require("./src/services/analytics/referenceDate");
const { classifyRange, assessCoverage } = require("./src/services/analytics/coverage");
const dateRanges = require("./src/services/analytics/dateRanges");
const salesAnalytics = require("./src/services/analytics/salesAnalytics");

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 400)})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);
const ymd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const range = (r) => (r && r.from ? `${ymd(r.from)}..${ymd(r.to)}` : "none");
const U = (y, m, d) => new Date(Date.UTC(y, m - 1, d)); // voucher dates are stored as UTC midnight

// Semantic signature: entity:metric | dimension | direction | comparison | period [| limit][| filter]
function sig(p) {
  const h = p.having || [];
  const find = (m, op) => h.find((x) => x.metric.endsWith(m) && x.op === op);
  let dir = "-";
  if (h.some((x) => /\.previous$/.test(x.metric) && x.op === "eq") && h.some((x) => !/\./.test(x.metric) && x.op === "gt")) dir = "new";
  else if (h.some((x) => !/\./.test(x.metric) && x.op === "eq") && h.some((x) => /\.previous$/.test(x.metric) && x.op === "gt")) dir = "lost";
  else if (find(".deltaPct", "gt")) dir = `pct>${find(".deltaPct", "gt").value}`;
  else if (find(".deltaPct", "lt")) dir = `pct<${find(".deltaPct", "lt").value}`;
  else if (find(".delta", "gt")) dir = "up";
  else if (find(".delta", "lt")) dir = "down";
  const dim = p.groupBy && p.groupBy.length ? p.groupBy.map((g) => g.dim + (g.bucket ? ":" + g.bucket : "")).join("+") : "total";
  const period = p.period.kind === "custom" ? `${p.period.from}..${p.period.to}` : p.period.kind === "specific_fy" ? `fy${p.period.fy}` : p.period.kind;
  const cmp = p.compare ? (p.compare.mode === "custom" ? `vs ${p.compare.period.from}..${p.compare.period.to}` : p.compare.mode) : "none";
  let out = `${p.entity}:${p.metrics ? p.metrics[0] : "list"}|${dim}|${dir}|${cmp}|${period}`;
  if (p.limit !== undefined) out += `|L${p.limit}`;
  for (const f of p.filters || []) out += `|${f.dim}=${f.value}`;
  return out;
}

// synthetic names only
const NAMES = { customer: ["Aarav Traders", "Bluebell Mart"], supplier: ["Crescent Supplies"], product: ["Widget Alpha"], productGroup: ["Hardware"] };
const resolver = createEntityResolver({ tenantId: "SF-PURE", sources: Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [k, async () => v])) });

// date contexts (pure)
const WINDOW = buildDateContext({ sales: { earliest: U(2025, 4, 1), latest: U(2025, 12, 8) }, purchase: { earliest: U(2025, 4, 3), latest: U(2025, 12, 5) } }, new Date(2025, 11, 8, 12)); // today = 8 Dec 2025
const forbiddenPlanner = async () => { throw new Error("Claude must NOT be called"); };
function fakeEngine() {
  const calls = [];
  const fn = async (plan, ctx) => {
    calls.push({ plan, ctx });
    const v = validateQueryPlan(plan, { referenceDate: ctx.referenceDate });
    const n = v.normalized;
    const out = (r) => (r && r.from ? { from: r.from.toISOString(), to: r.to.toISOString(), label: r.label, isPartial: r.isPartial } : r ? { label: r.label } : null);
    return { result: { ok: true, entity: plan.entity, mode: plan.mode, period: out(n.period), comparison: n.comparison ? { ...out(n.comparison), mode: plan.compare.mode } : null, metrics: n.metrics, groupBy: n.groupBy, amountBasis: {}, rows: [], totals: { values: Object.fromEntries(n.metrics.map((m) => [m, 1])), comparison: n.comparison ? Object.fromEntries(n.metrics.map((m) => [m, { previous: 1, delta: 0, deltaPct: 0 }])) : null }, truncated: false, rowLimit: n.limit, warnings: v.warnings, assumptions: v.assumptions }, cache: { status: "miss" } };
  };
  fn.calls = calls;
  return fn;
}
// ---------------------------------------------------------------- the planner's scripted answers (plan fixtures)
// There is no router: every question is interpreted by the planner. These are the plans a correct interpretation
// produces for each question (the engine inputs); the suite checks what the engine, the planner's product rules and
// the chat wiring then do with them. Periods stay symbolic unless the question states dates.
const plan = (entity, period, o = {}) => ({
  v: 1, entity, mode: "aggregate", period,
  metrics: o.metrics || (entity === "purchase" ? ["purchaseAmount", "purchaseInvoiceCount"] : ["invoiceAmount", "invoiceCount"]),
  groupBy: o.groupBy || [], filters: o.filters || [],
  ...(o.compare ? { compare: o.compare } : {}), ...(o.having ? { having: o.having } : {}), ...(o.sort ? { sort: o.sort } : {}), ...(o.limit ? { limit: o.limit } : {}),
});
const K = (kind) => ({ kind });
const C = (from, to) => ({ kind: "custom", from, to });
const LFL = { mode: "like_for_like" };
const FULL = { mode: "full_previous" };
const SPLY = { mode: "same_period_last_year" };
const vs = (from, to) => ({ mode: "custom", period: C(from, to) });
const byCust = { groupBy: [{ dim: "customer" }] };
const down = { ...byCust, having: [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }] };
const grew20 = { ...byCust, having: [{ metric: "invoiceAmount.deltaPct", op: "gt", value: 20 }], sort: [{ by: "invoiceAmount.deltaPct", dir: "desc" }] };
const stopped = { ...byCust, having: [{ metric: "invoiceAmount", op: "eq", value: 0 }, { metric: "invoiceAmount.previous", op: "gt", value: 0 }], sort: [{ by: "invoiceAmount.previous", dir: "desc" }] };
const newProducts = { metrics: ["lineAmount"], groupBy: [{ dim: "product" }], having: [{ metric: "lineAmount.previous", op: "eq", value: 0 }, { metric: "lineAmount", op: "gt", value: 0 }], sort: [{ by: "lineAmount", dir: "desc" }] };
const topCust = (n) => ({ ...byCust, sort: [{ by: "invoiceAmount", dir: "desc" }], limit: n });
const cust = (name) => [{ dim: "customer", op: "eq_ci", value: name }];
const MAR_APR = [vs("2025-03-20", "2025-04-20")];

// question -> the plan a correct interpretation produces
const PLANS = {
  "sales this month": plan("sales", K("current_month")),
  "sales last month": plan("sales", K("previous_month")),
  "sales this month vs last month": plan("sales", K("current_month"), { compare: LFL }),
  "sales this month vs same month last year": plan("sales", K("current_month"), { compare: SPLY }),
  "top 5 customers by sales": plan("sales", K("all_time"), topCust(5)),
  "sales from 2026-10-01 to 2026-10-31": plan("sales", C("2026-10-01", "2026-10-31")),
  // coverage (section C): [question] -> plan
  "Sales in January 2025 vs January 2024": plan("sales", C("2025-01-01", "2025-01-31"), { compare: vs("2024-01-01", "2024-01-31") }),
  "Sales in April 2025 vs April 2024": plan("sales", C("2025-04-01", "2025-04-30"), { compare: vs("2024-04-01", "2024-04-30") }),
  "sales FY 2024-25": plan("sales", { kind: "specific_fy", fy: "2024-25" }),
  "sales this fy vs last fy": plan("sales", K("current_fy"), { compare: LFL }),
  "sales in March 2025": plan("sales", C("2025-03-01", "2025-03-31")),
  "sales in January 2026": plan("sales", C("2026-01-01", "2026-01-31")),
  "sales for Aarav Traders in January 2025": plan("sales", C("2025-01-01", "2025-01-31"), { filters: cust("Aarav Traders") }),
  "customers who stopped buying this month vs same month last year": plan("sales", K("current_month"), { ...stopped, compare: SPLY }),
  "new products sold in May 2025 vs March 2025": plan("sales", C("2025-05-01", "2025-05-31"), { ...newProducts, compare: vs("2025-03-01", "2025-03-31") }),
  "purchases in February 2025": plan("purchase", C("2025-02-01", "2025-02-28")),
  "revenue in December 2024": plan("sales", C("2024-12-01", "2024-12-31"), { metrics: ["lineAmount"] }),
  "top 5 customers by sales in 2025-01-01 to 2025-03-31": plan("sales", C("2025-01-01", "2025-03-31"), topCust(5)),
  "sales yoy this quarter": plan("sales", K("current_quarter"), { compare: SPLY }),
  "sales from 2025-03-15 to 2025-04-15": plan("sales", C("2025-03-15", "2025-04-15")),
  "sales in December 2025": plan("sales", C("2025-12-01", "2025-12-31")),
  "sales from 2025-05-01 to 2025-05-31 vs 2025-03-20 to 2025-04-20": plan("sales", C("2025-05-01", "2025-05-31"), { compare: MAR_APR[0] }),
  "sales in April 2025": plan("sales", C("2025-04-01", "2025-04-30")),
  "sales this quarter vs last quarter": plan("sales", K("current_quarter"), { compare: LFL }),
  "sales last 90 days": plan("sales", K("last_90_days")),
  "new products sold this month": plan("sales", K("current_month"), { ...newProducts, compare: FULL }),
  "Who bought less this month than last month?": plan("sales", K("current_month"), { ...down, compare: LFL }),
  "sales growth percentage this month vs last month": plan("sales", K("current_month"), { compare: LFL }),
  "top 10 customers by sales": plan("sales", K("all_time"), topCust(10)),
  "sales for Aarav Traders this month": plan("sales", K("current_month"), { filters: cust("Aarav Traders") }),
  "purchases last month vs the month before": plan("purchase", K("previous_month"), { compare: LFL }),
  "sales in November 2025 vs October 2025": plan("sales", C("2025-11-01", "2025-11-30"), { compare: vs("2025-10-01", "2025-10-31") }),
  "sales this fy": plan("sales", K("current_fy")),
  "customers whose sales grew by more than 20% this month vs last month": plan("sales", K("current_month"), { ...grew20, compare: LFL }),
  "sales in May 2025 vs April 2025": plan("sales", C("2025-05-01", "2025-05-31"), { compare: vs("2025-04-01", "2025-04-30") }),
  "sales from 2025-12-01 to 2025-12-31 vs 2025-11-01 to 2025-11-30": plan("sales", C("2025-12-01", "2025-12-31"), { compare: vs("2025-11-01", "2025-11-30") }),
  // synthetic tenant (section I)
  "Sales this month vs last month": plan("sales", K("current_month"), { compare: LFL }),
  "Sales from 2025-07-01 to 2025-07-31": plan("sales", C("2025-07-01", "2025-07-31")),
  "Sales this month vs same period last month": plan("sales", K("current_month"), { compare: LFL }),
  "Sales growth percentage this month vs last month": plan("sales", K("current_month"), { compare: LFL }),
  "new customers this month": plan("sales", K("current_month"), { ...byCust, filters: [{ dim: "customer", op: "new_in_period", value: "period" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }),
  "customers who stopped buying this month vs last month": plan("sales", K("current_month"), { ...stopped, compare: LFL }),
  "sales for Cedar Stores this month vs last month": plan("sales", K("current_month"), { filters: cust("Cedar Stores"), compare: LFL }),
  "Sales in March 2025": plan("sales", C("2025-03-01", "2025-03-31")),
  "Sales from 2025-04-01 to 2025-04-30 vs 2025-03-01 to 2025-03-31": plan("sales", C("2025-04-01", "2025-04-30"), { compare: vs("2025-03-01", "2025-03-31") }),
  "Sales from 2025-03-01 to 2025-03-31 vs 2025-02-01 to 2025-02-28": plan("sales", C("2025-03-01", "2025-03-31"), { compare: vs("2025-02-01", "2025-02-28") }),
  "Sales from 2025-01-01 to 2025-01-31": plan("sales", C("2025-01-01", "2025-01-31")),
  "Sales from 2025-02-01 to 2025-02-28 vs 2025-01-01 to 2025-01-31": plan("sales", C("2025-02-01", "2025-02-28"), { compare: vs("2025-01-01", "2025-01-31") }),
  "Sales in June 2025 vs June 2024": plan("sales", C("2025-06-01", "2025-06-30"), { compare: vs("2024-06-01", "2024-06-30") }),
  "Sales in December 2024 vs December 2023": plan("sales", C("2024-12-01", "2024-12-31"), { compare: vs("2023-12-01", "2023-12-31") }),
  "sales for Aarav Traders in December 2024": plan("sales", C("2024-12-01", "2024-12-31"), { filters: cust("Aarav Traders") }),
  "purchases this month vs last month": plan("purchase", K("current_month"), { compare: LFL }),
  "Show sales this month vs last month": plan("sales", K("current_month"), { compare: LFL }),
  "and by customer?": plan("sales", K("current_month"), { ...byCust, compare: FULL, sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 10 }),
};
const P = (q, planOverride) => async () => {
  const p = planOverride || PLANS[q];
  if (!p) throw new Error(`no plan fixture for: ${q}`);
  return { content: [{ type: "tool_use", id: "p", name: PLANNER_TOOL_NAME, input: { plan: p } }], usage: { input_tokens: 1, output_tokens: 1 } };
};

const askPure = (q, { dates = WINDOW, history = [], previousQuery = null, execute = fakeEngine(), plannerClient = null, plan: planOverride = null } = {}) =>
  tryAnswerWithQueryEngine({ context: { tenantId: "SF-PURE" }, userMessage: q, conversationHistory: history, previousQuery, deps: { resolveEntity: resolver, getFreshness: async () => ({ state: "fresh", dataAsOf: null, message: "ok" }), plannerClient: plannerClient || P(q, planOverride), execute, getDateContext: async () => dates } });

// ---------------------------------------------------------------- independent calendar oracle (no project code)
const D = (y, m, d) => new Date(y, m, d);
const dim = (y, m) => new Date(y, m + 1, 0).getDate();
const shiftM = (x, k) => { const t = x.getMonth() + k; const y = x.getFullYear() + Math.floor(t / 12); const m = ((t % 12) + 12) % 12; return D(y, m, Math.min(x.getDate(), dim(y, m))); };
const addD = (x, k) => D(x.getFullYear(), x.getMonth(), x.getDate() + k);
const fyStart = (x) => D(x.getMonth() >= 3 ? x.getFullYear() : x.getFullYear() - 1, 3, 1);
const qStart = (x) => D(x.getFullYear(), Math.floor(x.getMonth() / 3) * 3, 1);
const monday = (x) => addD(x, -((x.getDay() + 6) % 7));
const R = (a, b) => `${ymd(a)}..${ymd(b)}`;
function oracle(kind, mode, r) {
  const cur = {
    current_month: [D(r.getFullYear(), r.getMonth(), 1), r],
    previous_month: [shiftM(D(r.getFullYear(), r.getMonth(), 1), -1), D(r.getFullYear(), r.getMonth(), 0)],
    current_quarter: [qStart(r), r],
    previous_quarter: [shiftM(qStart(r), -3), addD(qStart(r), -1)],
    current_fy: [fyStart(r), r],
    previous_fy: [shiftM(fyStart(r), -12), addD(fyStart(r), -1)],
    current_week: [monday(r), r],
    previous_week: [addD(monday(r), -7), addD(monday(r), -1)],
    today: [r, r],
    yesterday: [addD(r, -1), addD(r, -1)],
    last_7_days: [addD(r, -6), r],
    last_30_days: [addD(r, -29), r],
    last_90_days: [addD(r, -89), r],
  }[kind];
  let prev = null;
  const unitShift = { current_month: 1, current_quarter: 3, current_fy: 12 }[kind];
  if (mode === "like_for_like") {
    if (unitShift) prev = [shiftM(cur[0], -unitShift), shiftM(cur[1], -unitShift)];
    else if (kind === "previous_month") prev = [shiftM(cur[0], -1), D(cur[0].getFullYear(), cur[0].getMonth(), 0)];
    else if (kind === "previous_quarter") prev = [shiftM(cur[0], -3), addD(cur[0], -1)];
    else if (kind === "current_week") prev = [addD(cur[0], -7), addD(cur[1], -7)];
    else if (/^last_(\d+)_days$/.test(kind)) { const n = Number(kind.split("_")[1]); prev = [addD(cur[0], -n), addD(cur[1], -n)]; }
  } else if (mode === "same_period_last_year") prev = [shiftM(cur[0], -12), shiftM(cur[1], -12)];
  else if (mode === "full_previous") prev = { current_month: [shiftM(cur[0], -1), addD(cur[0], -1)], current_quarter: [shiftM(cur[0], -3), addD(cur[0], -1)], current_fy: [shiftM(cur[0], -12), addD(cur[0], -1)] }[kind];
  return { cur: R(cur[0], cur[1]), prev: prev ? R(prev[0], prev[1]) : "none" };
}

(async () => {
  // =============================================================== A
  section("A. ONE tenant reference date per turn (rule, future dates, memoisation, cross-path consistency)");
  {
    // Decision 1 (final, 2026-09-28): the reporting reference date is TODAY; vouchers never move it
    const NOW = new Date(2026, 8, 28, 12); // 28-Sep-2026, noon
    const a = buildDateContext({ sales: { earliest: U(2025, 4, 1), latest: U(2025, 12, 8) }, purchase: { earliest: U(2025, 3, 15), latest: U(2025, 12, 10) } }, NOW);
    check("rule: reference date = end of TODAY (28 Sep 2026 23:59:59.999 local), whatever the vouchers say (source today)", a.referenceDate.getTime() === new Date(2026, 8, 28, 23, 59, 59, 999).getTime() && a.source === "today");
    check("coverage window: first voucher of EITHER type .. last voucher (no sync recorded); per-entity bounds kept", ymd(a.coverage.earliest) === "2025-03-15" && ymd(a.coverage.latest) === "2025-12-10" && ymd(a.coverage.sales.earliest) === "2025-04-01");
    check("the coverage window is expressed in calendar days (local midnight of each stored UTC-midnight voucher date), so it compares with period boundaries in any server zone", a.coverage.earliest.getHours() === 0 && a.coverage.earliest.getMinutes() === 0 && a.coverage.sales.latest.getHours() === 0);
    const synced = buildDateContext({ sales: { earliest: U(2025, 4, 1), latest: U(2026, 9, 20) }, purchase: {}, lastSyncedAt: new Date(2026, 8, 28, 9, 30) }, NOW);
    check("coverage window ends at the later of the last voucher and the last successful sync (a synced day with no vouchers is a real zero)", ymd(synced.coverage.latest) === "2026-09-28");
    const b = buildDateContext({ sales: { earliest: U(2025, 4, 1), latest: U(2025, 12, 8) }, purchase: { earliest: U(2025, 3, 15), latest: U(2025, 12, 10) } }, NOW);
    check("deterministic: same inputs -> identical context", JSON.stringify(a) === JSON.stringify(b));
    const none = buildDateContext({ sales: {}, purchase: {} }, NOW);
    check("no vouchers at all: still today, no coverage window, no future vouchers", ymd(none.referenceDate) === "2026-09-28" && none.coverage.earliest === null && none.coverage.latest === null && !none.futureVouchers);

    // test 1-3: today 28-Sep-2026 with a future voucher dated 1-Oct-2026
    const future = buildDateContext({ sales: { earliest: U(2026, 8, 1), latest: U(2026, 10, 1) }, purchase: { earliest: U(2026, 8, 3), latest: U(2026, 9, 20) } }, NOW);
    check("(1) future voucher 1-Oct-2026: the reference date stays 28-Sep-2026 (flagged futureVouchers)", ymd(future.referenceDate) === "2026-09-28" && future.futureVouchers === true && ymd(future.latestVoucher) === "2026-10-01");
    const sameDay = buildDateContext({ sales: { earliest: U(2026, 8, 1), latest: U(2026, 9, 28) }, purchase: {} }, new Date(2026, 8, 28, 23, 50));
    check("a voucher dated today is not a future voucher", sameDay.futureVouchers === false);
    const eng = fakeEngine();
    const r = await askPure("sales this month", { dates: future, execute: eng });
    const cm = validateQueryPlan(eng.calls[0].plan, { referenceDate: eng.calls[0].ctx.referenceDate }).normalized.period;
    check("(2) current month on 28-Sep-2026 = 1-Sep-2026 .. 28-Sep-2026 (the engine gets the SAME reference date)", range(cm) === "2026-09-01..2026-09-28" && eng.calls[0].ctx.referenceDate.getTime() === future.referenceDate.getTime(), range(cm));
    check("(3) a voucher dated 1-Oct-2026 is outside every relative period (the boundary is today), and the answer says future-dated vouchers exist and are excluded", U(2026, 10, 1).getTime() > cm.to.getTime() && /Relative periods end today \(28 Sept? 2026\)\. This company also has vouchers dated after today \(latest 1 Oct 2026\); they are not included/.test(r.structured.answer), r.structured.answer);
    const rAll = await askPure("top 5 customers by sales", { dates: future });
    check("...no such note on a question without a relative period (all history)", !/after today/.test(rAll.structured.answer));
    const lit = fakeEngine();
    await askPure("sales from 2026-10-01 to 2026-10-31", { dates: future, execute: lit });
    const ln = validateQueryPlan(lit.calls[0].plan, { referenceDate: lit.calls[0].ctx.referenceDate }).normalized.period;
    check("(4) an explicit future date range keeps its explicit meaning (1-Oct-2026 .. 31-Oct-2026 is queried as asked)", range(ln) === "2026-10-01..2026-10-31", range(ln));

    // memoised per turn
    let loads = 0;
    const get = createTurnDates("T", async () => ((loads += 1), WINDOW));
    await Promise.all([get(), get(), get()]);
    check("createTurnDates: read at most once per turn, value visible to telemetry via peek()", loads === 1 && get.peek() === WINDOW);
    let loads2 = 0;
    const lazy = createTurnDates("T", async () => ((loads2 += 1), WINDOW));
    void lazy;
    check("...and not read at all until something needs it", loads2 === 0);

    // no wall-clock "today" left on the request/AI paths
    let refusedPeriod = false;
    try { dateRanges.resolveRequestPeriod({ period: "previous_month" }); } catch (e) { refusedPeriod = true; }
    let refusedCmp = false;
    try { dateRanges.resolveRequestComparison("vs_previous_month"); } catch (e) { refusedCmp = true; }
    check("REST period helpers refuse to run without the tenant date (no silent wall clock)", refusedPeriod && refusedCmp);
    const ctl = fs.readFileSync(require.resolve("./src/controllers/chatController.js"), "utf8");
    check("controller: ONE createTurnDates per turn, handed to the query engine (getDateContext: turnDates)", (ctl.match(/createTurnDates\(tenantId\)/g) || []).length === 1 && (ctl.match(/getDateContext: turnDates/g) || []).length === 1);
    const srcs = ["src/services/query/queryChat.js", "src/services/query/followUp.js", "src/services/query/planner.js", "src/services/analytics/coverage.js"].map((f) => [f, fs.readFileSync(f, "utf8")]);
    const wall = srcs.filter(([, t]) => /new Date\(\)/.test(t.replace(/\/\/.*$/gm, "")));
    check("no `new Date()` (wall clock) in the AI query/coverage code", wall.length === 0, wall.map(([f]) => f).join(","));

    // the SAME question -> the SAME boundaries through the engine and the planner
    const anchors = [U(2026, 4, 30), U(2026, 3, 31), U(2024, 2, 29), U(2026, 4, 1), U(2025, 12, 8)];
    const CROSS = {
      "sales this month": plan("sales", K("current_month")),
      "sales last month": plan("sales", K("previous_month")),
      "sales this month vs last month": plan("sales", K("current_month"), { compare: FULL }),
      "sales this month vs same month last year": plan("sales", K("current_month"), { compare: SPLY }),
    };
    const QS = Object.keys(CROSS);
    let same = 0;
    const diffs = [];
    for (const ref of anchors) {
      const dates = buildDateContext({ sales: { earliest: U(2020, 1, 1), latest: ref }, purchase: {} }, ref); // "today" = the anchor
      for (const q of QS) {
        const x = { plan: CROSS[q] };
        const v = validateQueryPlan(x.plan, { referenceDate: dates.referenceDate }).normalized;
        // the planner path: Claude's (scripted) plan is the plan; validated + executed with the turn's date
        const eng = fakeEngine();
        const planner = async () => ({ content: [{ type: "tool_use", id: "p", name: PLANNER_TOOL_NAME, input: { plan: x.plan } }], usage: { input_tokens: 1, output_tokens: 1 } });
        await tryAnswerWithQueryEngine({ context: { tenantId: "SF-PURE" }, userMessage: q.replace("sales", "total sales"), conversationHistory: [], deps: { resolveEntity: resolver, getFreshness: async () => ({ state: "fresh", dataAsOf: null, message: "ok" }), plannerClient: planner, execute: eng, getDateContext: async () => dates } });
        const pv = eng.calls.length ? validateQueryPlan(eng.calls[0].plan, { referenceDate: eng.calls[0].ctx.referenceDate }).normalized : null;
        const e = `${range(v.period)} / ${range(v.comparison)}`;
        const p = pv ? `${range(pv.period)} / ${range(pv.comparison)}` : "no plan";
        if (e === p && eng.calls[0].ctx.referenceDate.getTime() === dates.referenceDate.getTime()) same += 1;
        else diffs.push(`${ymd(ref)} "${q}": engine ${e} | planner ${p}`);
      }
    }
    check(`same question -> same boundaries via the engine and the planner path: ${same}/${anchors.length * QS.length} (month-end, 31 Mar, 29 Feb, FY start, mid-month)`, same === anchors.length * QS.length, diffs.slice(0, 3).join(" | "));
  }
  // =============================================================== B
  section("B. relative periods: engine boundaries vs an independent calendar oracle");
  {
    const RP = [
      ["sales this month", "sales", "current_month", "none"], ["sales last month", "sales", "previous_month", "none"],
      ["sales mtd", "sales", "current_month", "none"], ["sales month to date", "sales", "current_month", "none"],
      ["sales previous month", "sales", "previous_month", "none"], ["sales this month vs last month", "sales", "current_month", "full_previous"],
      ["sales this month compared with last month", "sales", "current_month", "full_previous"], ["sales this month vs same month last year", "sales", "current_month", "same_period_last_year"],
      ["sales this month yoy", "sales", "current_month", "same_period_last_year"], ["sales this quarter", "sales", "current_quarter", "none"],
      ["sales last quarter", "sales", "previous_quarter", "none"], ["sales qtd", "sales", "current_quarter", "none"],
      ["sales this quarter vs last quarter", "sales", "current_quarter", "like_for_like"], ["sales this fy", "sales", "current_fy", "none"],
      ["sales last fy", "sales", "previous_fy", "none"], ["sales this financial year vs last financial year", "sales", "current_fy", "like_for_like"],
      ["sales fytd", "sales", "current_fy", "none"], ["sales this week", "sales", "current_week", "none"],
      ["sales last week", "sales", "previous_week", "none"], ["sales today", "sales", "today", "none"],
      ["sales yesterday", "sales", "yesterday", "none"], ["purchases this month", "purchase", "current_month", "none"],
      ["purchases last month vs the month before", "purchase", "previous_month", "like_for_like"], ["purchases this quarter vs same quarter last year", "purchase", "current_quarter", "same_period_last_year"],
      ["revenue last month", "sales", "previous_month", "none"], ["revenue this month vs last month", "sales", "current_month", "full_previous"],
      ["sales invoice count last month", "sales", "previous_month", "none"], ["sales last 7 days", "sales", "last_7_days", "none"],
      ["sales last 30 days", "sales", "last_30_days", "none"], ["sales last 90 days", "sales", "last_90_days", "none"],
      ["sales this month vs full last month", "sales", "current_month", "full_previous"], ["how much did we sell last month", "sales", "previous_month", "none"],
      ["what were purchases in the previous quarter", "purchase", "previous_quarter", "none"], ["sales this week vs last week", "sales", "current_week", "like_for_like"],
      // decision 2: explicit same-days wording keeps like-for-like; the reversed order is the same comparison
      ["sales this month vs same period last month", "sales", "current_month", "like_for_like"], ["sales mtd vs lmtd", "sales", "current_month", "like_for_like"],
      ["compare sales previous month vs current month", "sales", "current_month", "full_previous"], ["sales this month vs last month like for like", "sales", "current_month", "like_for_like"],
    ];
    const anchors = [new Date(2026, 3, 30), new Date(2026, 2, 31), new Date(2024, 1, 29), new Date(2026, 3, 1), new Date(2026, 0, 1), new Date(2025, 11, 8)];
    let valid = 0;
    let bounds = 0;
    const bad = [];
    for (const [q, entity, kind, mode] of RP) {
      const p = plan(entity, K(kind), mode === "none" ? {} : { compare: { mode } });
      if (parseQueryPlan(p).ok) valid += 1;
      else { bad.push(`${q}: ${JSON.stringify(parseQueryPlan(p).errors)}`); continue; }
      for (const ref of anchors) {
        const v = validateQueryPlan(p, { referenceDate: ref });
        if (!v.ok) { bad.push(`${ymd(ref)} ${q}: ${v.errors.map((e) => e.code).join(",")}`); continue; }
        const n = v.normalized;
        const o = oracle(kind, mode, ref);
        if (range(n.period) === o.cur && range(n.comparison) === o.prev) bounds += 1;
        else bad.push(`${ymd(ref)} ${q}: engine ${range(n.period)} / ${range(n.comparison)} vs oracle ${o.cur} / ${o.prev}`);
      }
    }
    check(`${RP.length} period/comparison combinations are valid plans`, valid === RP.length, bad.slice(0, 3).join(" | "));
    check(`engine boundaries = independent oracle: ${bounds}/${RP.length * anchors.length} (30 Apr, 31 Mar, 29 Feb, 1 Apr, 1 Jan, 8 Dec)`, bounds === RP.length * anchors.length, bad.slice(0, 3).join(" | "));
  }

  // =============================================================== C
  section("C. data coverage: covered / partial / outside (window 1 Apr 2025 - 8 Dec 2025, anchor 8 Dec 2025)");
  {
    const cls = (from, to) => classifyRange({ from: new Date(from), to: new Date(to) }, WINDOW.coverage);
    check("classifier: inside / before / after / straddling start / straddling end / unbounded / no history", cls("2025-05-01T00:00", "2025-05-31T23:59") === "covered" && cls("2025-01-01T00:00", "2025-01-31T23:59") === "before_history" && cls("2026-01-01T00:00", "2026-01-31T23:59") === "after_latest_data" && cls("2025-03-15T00:00", "2025-04-15T23:59") === "partly_before_history" && cls("2025-12-01T00:00", "2025-12-31T23:59") === "partly_after_latest_data" && classifyRange({}, WINDOW.coverage) === "unbounded" && classifyRange({ from: new Date(), to: new Date() }, { earliest: null, latest: null }) === "no_history");
    // [question, expected: covered | partial | outside:<subject|comparison>]
    const CQ = [
      ["Sales in January 2025 vs January 2024", "outside:subject_before_history"], ["Sales in April 2025 vs April 2024", "outside:comparison_before_history"],
      ["sales this month vs same month last year", "outside:comparison_before_history"], ["sales FY 2024-25", "outside:subject_before_history"],
      ["sales this fy vs last fy", "outside:comparison_before_history"], ["sales in March 2025", "outside:subject_before_history"],
      ["sales in January 2026", "outside:subject_after_latest_data"], ["sales for Aarav Traders in January 2025", "outside:subject_before_history"],
      ["customers who stopped buying this month vs same month last year", "outside:comparison_before_history"], ["new products sold in May 2025 vs March 2025", "outside:comparison_before_history"],
      ["purchases in February 2025", "outside:subject_before_history"], ["revenue in December 2024", "outside:subject_before_history"],
      ["top 5 customers by sales in 2025-01-01 to 2025-03-31", "outside:subject_before_history"], ["sales yoy this quarter", "outside:comparison_before_history"],
      ["sales from 2025-03-15 to 2025-04-15", "partial"], ["sales in December 2025", "partial"],
      ["sales from 2025-05-01 to 2025-05-31 vs 2025-03-20 to 2025-04-20", "partial"], ["sales in April 2025", "covered"],
      ["sales this month vs last month", "covered"], ["sales this quarter vs last quarter", "covered"],
      ["sales last 90 days", "covered"], ["new products sold this month", "covered"],
      ["Who bought less this month than last month?", "covered"], ["sales growth percentage this month vs last month", "covered"],
      ["top 10 customers by sales", "covered"], ["sales for Aarav Traders this month", "covered"],
      ["purchases last month vs the month before", "covered"], ["sales in November 2025 vs October 2025", "covered"],
      ["sales this fy", "covered"], ["customers whose sales grew by more than 20% this month vs last month", "covered"],
      ["sales in May 2025 vs April 2025", "covered"], ["sales from 2025-12-01 to 2025-12-31 vs 2025-11-01 to 2025-11-30", "partial"],
    ];
    let ok = 0;
    const bad = [];
    let refusedWithoutEngine = 0;
    let deterministic = 0;
    for (const [q, want] of CQ) {
      const eng = fakeEngine();
      const r = await askPure(q, { execute: eng });
      const meta = r.structured.details.queryEngine;
      const text = r.structured.answer;
      let got;
      if (meta.status === "outside_coverage") got = `outside:${meta.code}`;
      else if (meta.status === "answered") got = /Coverage: /.test(text) ? "partial" : "covered";
      else got = `${meta.status}/${meta.code}`;
      if (got === want) ok += 1;
      else bad.push(`${q}: ${got} (want ${want})`);
      if (want.startsWith("outside")) {
        if (eng.calls.length === 0 && meta.claudeCalls === 1 && /missing data, not zero|false zero baseline/.test(text)) refusedWithoutEngine += 1;
        const again = await askPure(q);
        if (again.structured.answer === text) deterministic += 1;
      }
      if (want === "partial" && !(r.structured.warnings || []).some((w) => /^Coverage: /.test(w))) bad.push(`${q}: partial caveat missing from warnings`);
    }
    const outside = CQ.filter(([, w]) => w.startsWith("outside")).length;
    check(`coverage outcome for ${CQ.length} questions (${outside} outside, ${CQ.filter(([, w]) => w === "partial").length} partial, ${CQ.filter(([, w]) => w === "covered").length} covered)`, ok === CQ.length && bad.length === 0, bad.slice(0, 4).join(" | "));
    check(`outside coverage: the planner is paid for once, then the coverage gate refuses BEFORE the engine runs, saying the data is missing (not zero): ${refusedWithoutEngine}/${outside}`, refusedWithoutEngine === outside);
    check(`coverage messages are deterministic (identical on a second ask): ${deterministic}/${outside}`, deterministic === outside);
    const r = await askPure("Sales in April 2025 vs April 2024");
    check("comparison outside: names the missing range, the synced window and offers the subject alone", /1 Apr 2024 – 30 Apr 2024/.test(r.structured.answer) && /1 Apr 2025 – 8 Dec 2025/.test(r.structured.answer) && /on its own/.test(r.structured.answer) && r.structured.details.toolCalls[0].state === "no_usable_data", r.structured.answer);
    const cust = await askPure("sales for Aarav Traders in January 2025");
    check("a named customer outside coverage: 'no data', never 'no sales for Aarav Traders' / 'couldn't find'", /TallyPulse has no data for 1 Jan 2025 – 31 Jan 2025/.test(cust.structured.answer) && !/couldn.t find|no matching/i.test(cust.structured.answer));
    const noHist = await askPure("sales this month", { dates: buildDateContext({ sales: {}, purchase: {} }, new Date(2026, 8, 28)) });
    check("a tenant with no vouchers at all: honest 'no data yet', not a zero", /no synced Sales or Purchase vouchers/.test(noHist.structured.answer) && noHist.structured.details.queryEngine.status === "outside_coverage");
    const pure = assessCoverage({ entity: "purchase", period: { from: new Date(2025, 0, 1), to: new Date(2025, 0, 31, 23, 59) }, comparison: null, coverage: WINDOW.coverage });
    check("purchase wording: 'not zero purchases'", /not zero purchases/.test(pure.message));
  }

  // =============================================================== H
  section("H. month comparisons (decision 2, enforced by the planner): this month to date vs the COMPLETE previous month; same days only when asked");
  {
    // "today" = the given day; history from 2023 so every comparison is covered
    const at = (y, m, d) => buildDateContext({ sales: { earliest: U(2023, 4, 1), latest: U(y, m, d) }, purchase: {} }, new Date(y, m - 1, d, 12));
    // `claudePlan` is what a model would naively answer; the planner's product rules decide what reaches the engine.
    const resolved = async (q, dates, claudePlan = plan("sales", K("current_month"), { compare: LFL })) => {
      const eng = fakeEngine();
      const r = await askPure(q, { dates, execute: eng, plan: claudePlan });
      if (!eng.calls.length) return { r, cur: "none", prev: "none" };
      const n = validateQueryPlan(eng.calls[0].plan, { referenceDate: eng.calls[0].ctx.referenceDate }).normalized;
      return { r, cur: range(n.period), prev: range(n.comparison), mode: eng.calls[0].plan.compare && eng.calls[0].plan.compare.mode };
    };
    // test 5: the product decision's own example
    const ex = await resolved("Compare sales previous month vs current month", at(2026, 9, 28));
    check("(5) 28-Sep-2026 'Compare sales previous month vs current month': current 1-Sep..28-Sep, previous 1-Aug..31-Aug", ex.cur === "2026-09-01..2026-09-28" && ex.prev === "2026-08-01..2026-08-31", `${ex.cur} vs ${ex.prev}`);
    check("...and both ranges are visible in the answer", /1 Sept? 2026 – 28 Sept? 2026/.test(ex.r.structured.answer) && /1 Aug 2026 – 31 Aug 2026/.test(ex.r.structured.answer), ex.r.structured.answer);
    for (const q of ["sales this month vs last month", "sales growth over last month", "Sales this month vs last month"]) {
      const x = await resolved(q, at(2026, 9, 28));
      check("(5) 28-Sep-2026 '" + q + "': 1-Sep..28-Sep vs the complete August, the default stated", x.cur === "2026-09-01..2026-09-28" && x.prev === "2026-08-01..2026-08-31" && x.mode === "full_previous" && /compared with the complete previous month/.test(x.r.structured.answer), `${x.cur} vs ${x.prev}`);
    }
    // test 6: month-ends (the current month is complete on its last day; the previous one is always complete)
    const ends = [[2026, 3, 31, "2026-03-01..2026-03-31", "2026-02-01..2026-02-28"], [2026, 4, 30, "2026-04-01..2026-04-30", "2026-03-01..2026-03-31"], [2026, 5, 31, "2026-05-01..2026-05-31", "2026-04-01..2026-04-30"], [2026, 6, 30, "2026-06-01..2026-06-30", "2026-05-01..2026-05-31"], [2026, 7, 31, "2026-07-01..2026-07-31", "2026-06-01..2026-06-30"], [2026, 8, 31, "2026-08-01..2026-08-31", "2026-07-01..2026-07-31"], [2026, 9, 30, "2026-09-01..2026-09-30", "2026-08-01..2026-08-31"], [2026, 10, 31, "2026-10-01..2026-10-31", "2026-09-01..2026-09-30"], [2026, 11, 30, "2026-11-01..2026-11-30", "2026-10-01..2026-10-31"], [2026, 12, 31, "2026-12-01..2026-12-31", "2026-11-01..2026-11-30"], [2027, 1, 31, "2027-01-01..2027-01-31", "2026-12-01..2026-12-31"], [2027, 2, 28, "2027-02-01..2027-02-28", "2027-01-01..2027-01-31"], [2024, 2, 29, "2024-02-01..2024-02-29", "2024-01-01..2024-01-31"], [2024, 3, 1, "2024-03-01..2024-03-01", "2024-02-01..2024-02-29"]];
    const endBad = [];
    let noteless = 0;
    for (const [y, m, d, cur, prev] of ends) {
      const x = await resolved("sales this month vs last month", at(y, m, d));
      if (x.cur !== cur || x.prev !== prev) endBad.push(`${y}-${m}-${d}: ${x.cur} vs ${x.prev}`);
      if (!/is complete .* but is compared with the same days/.test(x.r.structured.answer)) noteless += 1;
    }
    check(`(6) month-ends (31 Mar, 30 Apr, 31 May, 30 Jun, 31 Jul, 31 Aug, 30 Sep ... 29 Feb, 1 Mar): this month vs the complete previous month on all ${ends.length}`, endBad.length === 0 && noteless === ends.length, endBad.join(" | "));
    // test 7: explicit same-period / same-day-count / like-for-like / full wording keeps its meaning
    const explicit = [
      ["sales this month vs same period last month", at(2026, 9, 28), plan("sales", K("current_month"), { compare: LFL }), "like_for_like", "2026-08-01..2026-08-28"],
      ["sales this month vs the same days last month", at(2026, 9, 28), plan("sales", K("current_month"), { compare: LFL }), "like_for_like", "2026-08-01..2026-08-28"],
      ["sales this month vs last month like for like", at(2026, 9, 28), plan("sales", K("current_month"), { compare: LFL }), "like_for_like", "2026-08-01..2026-08-28"],
      ["sales mtd vs lmtd", at(2026, 9, 28), plan("sales", K("current_month"), { compare: LFL }), "like_for_like", "2026-08-01..2026-08-28"],
      ["sales this month vs same number of days last month", at(2026, 9, 28), plan("sales", K("current_month"), { compare: LFL }), "like_for_like", "2026-08-01..2026-08-28"],
      ["sales this month vs full last month", at(2026, 9, 28), plan("sales", K("current_month"), { compare: FULL }), "full_previous", "2026-08-01..2026-08-31"],
      ["sales this month vs same month last year", at(2026, 9, 28), plan("sales", K("current_month"), { compare: SPLY }), "same_period_last_year", "2025-09-01..2025-09-28"],
      ["sales from 2026-08-01 to 2026-08-15 vs 2026-07-01 to 2026-07-15", at(2026, 9, 28), plan("sales", C("2026-08-01", "2026-08-15"), { compare: vs("2026-07-01", "2026-07-15") }), "custom", "2026-07-01..2026-07-15"],
    ];
    const exBad = [];
    for (const [q, dates, p, mode, prev] of explicit) {
      const x = await resolved(q, dates, p);
      if (x.mode !== mode || x.prev !== prev) exBad.push(`${q}: ${x.mode} ${x.prev}`);
    }
    check(`(7) explicit same-period / same-day-count / full / same-month-last-year / literal ranges keep their explicit meaning (${explicit.length})`, exBad.length === 0, exBad.join(" | "));
    // other units keep like-for-like (decision 2 is about months); a complete period vs a shorter baseline is disclosed
    const q = await resolved("sales this quarter vs last quarter", at(2026, 6, 30), plan("sales", K("current_quarter"), { compare: LFL }));
    check("quarters unchanged (like-for-like): 30 Jun quarter vs 1 Jan..30 Mar, with the complete-period disclosure", q.mode === "like_for_like" && q.prev === "2026-01-01..2026-03-30" && /is complete .* but is compared with the same days/.test(q.r.structured.answer));
    const same = await resolved("sales this month vs same period last month", at(2026, 4, 30), plan("sales", K("current_month"), { compare: LFL }));
    check("explicit same days at a month-end: 1-30 Apr vs 1-30 Mar, disclosed with how to get complete months", same.prev === "2026-03-01..2026-03-30" && /1 Mar 2026 – 31 Mar 2026/.test(same.r.structured.answer) && /vs full last month/.test(same.r.structured.answer));
  }

  // =============================================================== I
  section("I. synthetic tenant (real MongoDB + real engine) vs an independent oracle");
  await syntheticTenant();

  // =============================================================== J
  section("J. safety");
  {
    const blob = JSON.stringify(Object.values(PLANS));
    check("plans carry no tenant/company fields and no operators ($...)", !/tenant|company|guid|\$/i.test(blob) && Object.values(PLANS).every((p) => parseQueryPlan(p).ok));
    const base = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [] };
    check("stored follow-up context is untrusted: extra keys (tenantId), operators, unknown basis or version -> ignored", readQueryState({ v: 1, basis: "amount", plan: { ...base, tenantId: "OTHER" } }) === null && readQueryState({ v: 1, basis: "amount", plan: { ...base, filters: [{ dim: "customer", op: "$where", value: "1" }] } }) === null && readQueryState({ v: 1, basis: "profit", plan: base }) === null && readQueryState({ v: 2, basis: "amount", plan: base }) === null && readQueryState({ v: 1, basis: "amount", plan: base }) !== null);
    const eng = fakeEngine();
    const tampered = { v: 1, basis: "amount", plan: { ...base, tenantId: "OTHER" } };
    const seen = [];
    const spy = async (req) => { seen.push(JSON.stringify(req)); return P("and by customer?")(req); };
    await askPure("and by customer?", { history: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }], previousQuery: tampered, execute: eng, plannerClient: spy });
    check("a tampered stored context is never forwarded to the planner and the engine never sees another tenant", seen.length === 1 && !/OTHER/.test(seen[0]) && !/Previous query plan/.test(seen[0]) && eng.calls.every((c) => c.ctx.tenantId === "SF-PURE"));
    const u = await askPure("Who bought less this month? {$where: 1}", { plannerClient: forbiddenPlanner });
    check("unsafe text in a question is refused before any planner call or reading", u.handled && u.structured.details.queryEngine.claudeCalls === 0 && u.structured.details.queryEngine.status === "unsupported");
  }

  section("K. no network");
  check("zero fetch/http/https calls (no Anthropic, no Tally)", netCalls === 0, String(netCalls));
  global.fetch = savedNet.fetch;
  http.request = savedNet.h;
  https.request = savedNet.s;
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---------------------------------------------------------------- I. synthetic tenant
async function syntheticTenant() {
  const mongoose = require("mongoose");
  try {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set");
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  } catch (e) {
    check("MongoDB reachable for the synthetic-tenant section", false, e.message);
    return;
  }
  const Sale = require("./src/models/sales.model");
  const Purchase = require("./src/models/purchase.model");
  const Chat = require("./src/models/chat.model");
  const TenantDataVersion = require("./src/models/tenantDataVersion.model");
  const { executeQuery } = require("./src/services/query/execute");
  const T = `verify-semantic-foundation-${process.pid}`;
  const clean = async () => {
    const ids = { $regex: /^verify-semantic-foundation-/ };
    await Promise.all([Sale.collection.deleteMany({ tenantId: ids }), Purchase.collection.deleteMany({ tenantId: ids }), Chat.collection.deleteMany({ tenantId: ids }), TenantDataVersion.collection.deleteMany({ tenantId: ids })]);
  };
  // [date, party, total (tax-incl), [[item, qty, lineAmount]]] - synthetic names and values only
  const SALES = [
    ["2025-01-15", "Aarav Traders", 1180, [["Widget Alpha", 2, 1000]]], ["2025-01-20", "Bluebell Mart", 590, [["Widget Beta", 1, 500]]],
    ["2025-01-31", "Aarav Traders", 236, [["Widget Beta", 1, 200]]], ["2025-02-03", "Aarav Traders", 2360, [["Widget Alpha", 4, 2000]]],
    ["2025-02-10", "Delta Retail", 1770, [["Widget Beta", 3, 1500]]], ["2025-02-14", "Bluebell Mart", 708, [["Widget Alpha", 1, 600]]],
    ["2025-04-05", "Aarav Traders", 1416, [["Widget Alpha", 2, 1200]]], ["2025-04-18", "Bluebell Mart", 944, [["Widget Beta", 2, 800]]],
    ["2025-05-02", "Aarav Traders", 1652, [["Widget Alpha", 3, 1400]]], ["2025-05-15", "Bluebell Mart", 472, [["Widget Beta", 1, 400]]],
    ["2025-05-31", "Emerald Co", 3540, [["Widget Alpha", 5, 3000]]], ["2025-06-03", "Aarav Traders", 1298, [["Widget Alpha", 2, 1100]]],
    ["2025-06-10", "Cedar Stores", 826, [["Widget Beta", 1, 700]]], ["2025-06-20", "Delta Retail", 1062, [["Widget Alpha", 1, 900]]],
    ["2025-06-30", "Emerald Co", 2950, [["Widget Beta", 5, 2500]]],
    // post-dated: after "today" (30 Jun 2025, fixed below) - never inside a relative period (decision 1)
    ["2025-07-02", "Aarav Traders", 5000, [["Widget Alpha", 5, 4237]]],
  ];
  const PURCHASES = [
    ["2025-01-16", "Crescent Supplies", 5900, [["Widget Alpha", 10, 5000]]], ["2025-03-10", "Crescent Supplies", 3540, [["Widget Beta", 6, 3000]]],
    ["2025-05-20", "Dune Wholesale", 2360, [["Widget Alpha", 4, 2000]]], ["2025-06-12", "Crescent Supplies", 4720, [["Widget Alpha", 8, 4000]]],
  ];
  const doc = (x, i, kind) => ({
    tenantId: T, tallyGuid: `${T}-${kind}-${i}`, tallyAlterId: i + 1, voucherStatus: "active",
    header: { voucherNo: `${kind}-${i + 1}`, voucherDate: new Date(`${x[0]}T00:00:00.000Z`), voucherType: "Invoice", voucherTotalAmount: x[2], narration: "", partyName: x[1] },
    inventory: x[3].map(([itemName, quantity, amount]) => ({ itemName, quantity, rate: amount / quantity, amount })), ledgers: [],
  });
  // ---- the oracle: plain filtering + sums over the rows above (no project code)
  const inR = (d, a, b) => d >= a && d <= b;
  const sumOf = (rows, a, b, party) => rows.filter((x) => inR(x[0], a, b) && (!party || x[1] === party)).reduce((s, x) => s + x[2], 0);
  const countOf = (rows, a, b) => rows.filter((x) => inR(x[0], a, b)).length;
  const byParty = (rows, a, b) => rows.filter((x) => inR(x[0], a, b)).reduce((m, x) => ((m[x[1]] = (m[x[1]] || 0) + x[2]), m), {});
  const near = (x, y) => (x === null || y === null ? x === y : Math.abs(x - y) < 0.01);
  const pctOf = (cur, prev) => (prev === 0 ? null : ((cur - prev) / prev) * 100);

  let captured = null;
  const execute = async (plan, ctx) => {
    const result = await executeQuery(plan, ctx);
    captured = { plan, ctx, result };
    return { result, cache: { status: "miss" } };
  };
    // "today" is fixed at 30 Jun 2025 through the REAL date-context function (real vouchers, real sync checkpoints)
  const NOW = new Date(2025, 5, 30, 12);
  const refMod = require("./src/services/analytics/referenceDate");
  const datesAtNow = (tenantId) => refMod.getTenantDateContext(tenantId, { now: NOW });
  const ask = async (q) => {
    captured = null;
    const r = await tryAnswerWithQueryEngine({ context: { tenantId: T }, userMessage: q, conversationHistory: [], deps: { plannerClient: P(q), execute, getDateContext: datesAtNow } });
    return { r, meta: r.structured.details.queryEngine, text: r.structured.answer, ran: captured };
  };
  try {
    await clean();
    await Sale.collection.insertMany(SALES.map((x, i) => doc(x, i, "S")));
    await Purchase.collection.insertMany(PURCHASES.map((x, i) => doc(x, i, "P")));
    console.log(`    synthetic tenant: ${SALES.length} sales + ${PURCHASES.length} purchase vouchers, 15 Jan 2025 - 30 Jun 2025 + one post-dated 2 Jul 2025 (no sales in March, purchases in March), 5 customers: steady, lost, first-ever, reactivated, month-end buyer; today = 30 Jun 2025`);

    // 1. both periods covered: this month vs last month at the 30 Jun anchor
    let x = await ask("Sales this month vs last month");
    const jun = sumOf(SALES, "2025-06-01", "2025-06-30");
    const mayFull = sumOf(SALES, "2025-05-01", "2025-05-31");
    const mayLfl = sumOf(SALES, "2025-05-01", "2025-05-30");
    const t = x.ran && x.ran.result.totals;
    check(`this month vs last month: June 1-30 ₹${jun} (${countOf(SALES, "2025-06-01", "2025-06-30")} invoices) vs the COMPLETE May ₹${mayFull} = oracle; reference date = today (30 Jun 2025), not the 2 Jul voucher`, x.ran && ymd(x.ran.ctx.referenceDate) === "2025-06-30" && near(t.values.invoiceAmount, jun) && t.values.invoiceCount === countOf(SALES, "2025-06-01", "2025-06-30") && near(t.comparison.invoiceAmount.previous, mayFull) && near(t.comparison.invoiceAmount.deltaPct, pctOf(jun, mayFull)) && x.text.includes(fmtMoney(jun)), x.text);
    check("...the post-dated 2 Jul voucher is NOT in 'this month' (total excludes it) and the answer says post-dated vouchers exist; no coverage caveat", !x.text.includes(fmtMoney(jun + 5000)) && /vouchers dated after today \(latest 2 Jul 2025\); they are not included/.test(x.text) && !/Coverage:/.test(x.text) && x.meta.claudeCalls === 1, x.text);
    x = await ask("Sales from 2025-07-01 to 2025-07-31");
    check("an explicit range that names the post-dated day returns it (explicit intent kept): ₹5,000.00", x.ran && near(x.ran.result.totals.values.invoiceAmount, sumOf(SALES, "2025-07-01", "2025-07-31")) && x.ran.result.totals.values.invoiceAmount === 5000);
    x = await ask("Sales this month vs same period last month");
    check(`explicit same period: June vs 1-30 May ₹${mayLfl} = oracle, with the complete-period disclosure`, x.ran && near(x.ran.result.totals.comparison.invoiceAmount.previous, mayLfl) && /is complete .* but is compared with the same days/.test(x.text));
    x = await ask("Sales growth percentage this month vs last month");
    check(`total %: ${pctOf(jun, mayFull).toFixed(1)}% vs the complete May = oracle, shown in the answer`, x.ran && near(x.ran.result.totals.comparison.invoiceAmount.deltaPct, pctOf(jun, mayFull)) && x.text.includes(`${pctOf(jun, mayFull) > 0 ? "+" : ""}${pctOf(jun, mayFull).toFixed(1)}%`), x.text);

    // 2. "who" on real data
    x = await ask("Who bought less this month than last month?");
    const cur = byParty(SALES, "2025-06-01", "2025-06-30");
    const prev = byParty(SALES, "2025-05-01", "2025-05-31"); // decision 2: complete May
    const down = [...new Set([...Object.keys(cur), ...Object.keys(prev)])].map((k) => [k, (cur[k] || 0) - (prev[k] || 0)]).filter(([, d]) => d < 0).sort((a, b) => a[1] - b[1]).map(([k]) => k);
    const rows = x.ran ? x.ran.result.rows.map((r) => r.key.customer) : [];
    check(`"Who bought less ..." = customers whose sales fell, most first: ${down.join(", ")} (oracle)`, JSON.stringify(rows) === JSON.stringify(down), JSON.stringify(rows));

    // 3. new / lost with a genuinely new customer, a reactivated one and a month-end buyer
    x = await ask("new customers this month");
    check("decision 3: tenant without a synced ledger master -> final honest answer (ledger_master_missing), so Delta Retail (bought in Feb, back in June) is never labelled new", x.r.handled && x.meta.status === "unsupported" && x.meta.code === "ledger_master_missing" && /ledger master has not been synced/.test(x.text) && !/Delta Retail|Cedar Stores/.test(x.text));
    x = await ask("customers who stopped buying this month vs last month");
    const lost = Object.keys(prev).filter((k) => !cur[k]);
    check(`lost customers = bought in the complete May, nothing in June: ${lost.join(", ")} (oracle)`, x.ran && JSON.stringify(x.ran.result.rows.map((r) => r.key.customer)) === JSON.stringify(lost));
    x = await ask("sales for Cedar Stores this month vs last month");
    check("a genuinely new customer: previous ₹0 is a real zero (covered), % change explained, no coverage caveat", x.ran && x.ran.result.totals.comparison.invoiceAmount.previous === 0 && x.ran.result.totals.comparison.invoiceAmount.deltaPct === null && /% change n\/a: the comparison value is zero/.test(x.text) && !/Coverage:/.test(x.text), x.text);

    // 4. zero inside coverage vs no data outside it
    x = await ask("Sales in March 2025");
    check("a covered month with no sales (purchases were synced that month): 'no matching records' - a real zero, answered", x.meta.status === "answered" && x.r.structured.details.toolCalls[0].state === "zero_result" && x.ran && x.ran.result.totals.values.invoiceCount === 0 && !/Coverage:/.test(x.text));
    x = await ask("Sales from 2025-04-01 to 2025-04-30 vs 2025-03-01 to 2025-03-31");
    const apr = sumOf(SALES, "2025-04-01", "2025-04-30");
    check(`April vs a genuinely zero March: ₹${apr} vs ₹0, % change n/a (zero baseline), no coverage caveat`, x.ran && near(x.ran.result.totals.values.invoiceAmount, apr) && x.ran.result.totals.comparison.invoiceAmount.previous === 0 && /% change n\/a/.test(x.text) && !/Coverage:/.test(x.text));
    x = await ask("Sales from 2025-03-01 to 2025-03-31 vs 2025-02-01 to 2025-02-28");
    check("one period with zero transactions: March ₹0 vs February = oracle, -100.0%", x.ran && near(x.ran.result.totals.comparison.invoiceAmount.previous, sumOf(SALES, "2025-02-01", "2025-02-28")) && /-100\.0%/.test(x.text));
    x = await ask("Sales from 2025-01-01 to 2025-01-31");
    check(`current period partly covered (history starts 15 Jan): ₹${sumOf(SALES, "2025-01-01", "2025-01-31")} = oracle, with the caveat in text AND warnings`, x.ran && near(x.ran.result.totals.values.invoiceAmount, sumOf(SALES, "2025-01-01", "2025-01-31")) && /synced data starts on 15 Jan 2025/.test(x.text) && x.r.structured.warnings.some((w) => /15 Jan 2025/.test(w)));
    x = await ask("Sales from 2025-02-01 to 2025-02-28 vs 2025-01-01 to 2025-01-31");
    check("comparison period partly covered: figures = oracle, comparison caveat stated", x.ran && near(x.ran.result.totals.comparison.invoiceAmount.previous, sumOf(SALES, "2025-01-01", "2025-01-31")) && /comparison period 1 Jan 2025 – 31 Jan 2025 is only partly covered/.test(x.text));
    x = await ask("Sales in June 2025 vs June 2024");
    check("comparison completely outside: refused, the engine never ran, no false zero baseline", x.meta.status === "outside_coverage" && x.ran === null && /false zero baseline/.test(x.text) && /15 Jan 2025/.test(x.text));
    x = await ask("sales this month vs same month last year");
    check("YoY at the anchor (June 2024 has no data): refused, not 'everyone grew from ₹0'", x.meta.status === "outside_coverage" && x.ran === null);
    x = await ask("Sales in December 2024 vs December 2023");
    check("both periods outside: 'TallyPulse has no data for 1 Dec 2024 – 31 Dec 2024' (missing, not zero)", x.meta.status === "outside_coverage" && /no data for 1 Dec 2024 – 31 Dec 2024/.test(x.text) && /not zero sales/.test(x.text));
    x = await ask("sales for Aarav Traders in December 2024");
    check("a real customer outside coverage: no-data refusal, not 'Aarav Traders had no sales' and not 'couldn't find'", x.meta.status === "outside_coverage" && !/couldn.t find|no matching/i.test(x.text));
    x = await ask("purchases this month vs last month");
    check("purchases: June vs the complete May = oracle", x.ran && near(x.ran.result.totals.values.purchaseAmount, sumOf(PURCHASES, "2025-06-01", "2025-06-30")) && near(x.ran.result.totals.comparison.purchaseAmount.previous, sumOf(PURCHASES, "2025-05-01", "2025-05-31")));

    // 5. controller round trip: the plan is stored on the assistant message and drives the follow-up
    const refPath = require.resolve("./src/services/analytics/referenceDate");
    const realRef = require.cache[refPath];
    require.cache[refPath] = { id: refPath, filename: refPath, loaded: true, exports: { ...refMod, getTenantDateContext: (tid) => refMod.getTenantDateContext(tid, { now: NOW }) } };
    delete require.cache[require.resolve("./src/controllers/chatController")];
    const { sendChatMessage } = require("./src/controllers/chatController");
    const userId = new mongoose.Types.ObjectId();
    const send = async (message, chatId) => {
      const res = { code: 0, body: null, on() { return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
      await sendChatMessage({ body: { message }, params: chatId ? { chatId } : {}, user: { id: String(userId) }, companyContext: { tenantId: T, companyGuid: "synthetic" } }, res);
      return res;
    };
    const plannerSeen = [];
    controllerPlanner.impl = async (req) => {
      plannerSeen.push(req.messages[0].content);
      const m = /Question: (.*)$/m.exec(req.messages[0].content);
      return P(m ? m[1] : req.messages[0].content)();
    };
    const a = await send("Show sales this month vs last month");
    const b = await send("and by customer?", a.body.chatId);
    const saved = await Chat.findOne({ _id: a.body.chatId, tenantId: T, userId }).lean();
    const stored = saved && saved.messages[3] && saved.messages[3].queryContext;
    check("controller: the engine's plan is persisted on the assistant message (server-side), the follow-up keeps period + comparison and groups by customer", a.code === 200 && b.code === 200 && saved.messages[1].queryContext && saved.messages[1].queryContext.basis === "amount" && stored && stored.plan.groupBy[0].dim === "customer" && stored.plan.period.kind === "current_month" && stored.plan.compare.mode === "full_previous" && /by customer/.test(b.body.data.answer) && plannerSeen.length === 2 && /Previous query plan/.test(plannerSeen[1]) && !/Previous query plan/.test(plannerSeen[0]), JSON.stringify(stored));
    check("controller: the stored context is not in the API response", !JSON.stringify(a.body).includes("queryContext"));
    require.cache[refPath] = realRef;
  } catch (e) {
    check("synthetic tenant section ran without an exception", false, e && e.stack);
  } finally {
    await clean();
    const left = (await Sale.collection.countDocuments({ tenantId: T })) + (await Purchase.collection.countDocuments({ tenantId: T })) + (await Chat.collection.countDocuments({ tenantId: T }));
    check("synthetic tenant removed (vouchers + chat)", left === 0, String(left));
    await mongoose.disconnect().catch(() => {});
  }
}
