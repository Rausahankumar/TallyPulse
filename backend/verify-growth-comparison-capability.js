"use strict";

/**
 * Real-user growth & comparison semantics AUDIT (read-only). Written as a snapshot of the audit findings; updated by the
 * Semantic Foundation checkpoint (P-SF, 2026-09-28): the defects it pinned (three "todays", % totals refused, no coverage
 * model) are asserted FIXED. The month-end and new/lost facts in B are unchanged on purpose (product decisions,
 * docs/SEMANTIC_FOUNDATION.md).
 *
 * There is no deterministic router: the planner interprets every question (verify-query-planner.js, verify-nlu-eval.js).
 * This audit pins what the ENGINE does with a correct interpretation, so every question below is run as the explicit
 * plan that interpretation produces.
 *
 *   A. architecture facts: where the reference date comes from and which paths ever see it
 *   B. semantic sweeps: month-end like-for-like truncation, new/lost baselines
 *   C. synthetic tenant: engine results vs an INDEPENDENT oracle (plain calendar arithmetic + in-memory sums)
 *      across month-end, February, leap-day, FY, quarter and year boundaries
 *   D. data coverage: zero baselines that are really "no data" (prototype classifier = the proposed design)
 *   E. no network
 *
 * Section C writes ONLY a synthetic tenant ("verify-growth-audit-*") through the raw driver and deletes it afterwards;
 * real tenants are only counted (read-only), never named. No Anthropic, no Tally.
 * Run: node verify-growth-comparison-capability.js
 */

require("dotenv").config();
const http = require("http");
const https = require("https");

let netCalls = 0;
const savedNet = { fetch: global.fetch, h: http.request, s: https.request };
global.fetch = async () => { netCalls += 1; throw new Error("network disabled in this audit"); };
http.request = () => { netCalls += 1; throw new Error("network disabled in this audit"); };
https.request = () => { netCalls += 1; throw new Error("network disabled in this audit"); };

const fs = require("fs");
const { validateQueryPlan } = require("./src/services/query/validator");
const { getPlannerPrompt } = require("./src/services/query/planner");
const periodEngine = require("./src/services/analytics/periodEngine");
const dateRanges = require("./src/services/analytics/dateRanges");

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail ? ` (${detail})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);
const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
(async () => {
  // =============================================================== A
  section("A. architecture facts: ONE tenant reference date per turn (the audit found three; fixed by P-SF)");
  {
    const system = getPlannerPrompt().system.map((b) => b.text).join("\n");
    check("planner: its prompt carries no date / reference date (relative wording can only become SYMBOLIC periods; the date never reaches Claude)", !/reference date|today is|current date|20\d\d-\d\d-\d\d/i.test(system));
    const qc = fs.readFileSync(require.resolve("./src/services/query/queryChat.js"), "utf8");
    check("P-SF: queryChat reads the turn's date context ONCE and hands the SAME referenceDate to the planner's guards, validation and executor", /const dc = await turnDates\(\);/.test(qc) && /planQuestion\(userMessage, \{[^}]*referenceDate, signal \}\)/.test(qc) && /validateQueryPlan\(plan, \{ referenceDate \}\)/.test(qc) && /exec\(plan, \{ tenantId, referenceDate \}, timing\)/.test(qc));
    const { buildDateContext } = require("./src/services/analytics/referenceDate");
    const d = (y, m, dd) => new Date(Date.UTC(y, m - 1, dd));
    const dc = buildDateContext({ sales: { earliest: d(2025, 4, 1), latest: d(2025, 12, 8) }, purchase: { earliest: d(2025, 3, 15), latest: d(2025, 12, 10) } }, new Date(2026, 8, 28, 12));
    const none = buildDateContext({ sales: {}, purchase: {} }, new Date(2026, 8, 28, 12));
    // Decision 1 (2026-09-28): the reference date is TODAY (end of the local day), never the latest voucher
    check("reference date = today (decision 1), not the latest voucher; synced window starts at the earlier first voucher; no vouchers -> no window", dc.referenceDate.getTime() === new Date(2026, 8, 28, 23, 59, 59, 999).getTime() && dc.source === "today" && dc.coverage.earliest.getTime() === d(2025, 3, 15).getTime() && none.coverage.earliest === null && none.coverage.latest === null);
    const lag = new Date(2025, 11, 8, 0, 0); // a tenant whose sync ends 8 Dec 2025
    const engineMonth = periodEngine.resolvePeriod("current_month", lag);
    const restMonth = dateRanges.resolveRequestPeriod({ period: "current_month" }, lag);
    let refused = false;
    try {
      dateRanges.resolveRequestPeriod({ period: "current_month" });
    } catch (e) {
      refused = true;
    }
    check(`P-SF: the REST period helpers resolve "this month" from the SAME tenant date as the engine (${ymdLocal(restMonth.from)}); without it they refuse instead of using the wall clock`, ymdLocal(engineMonth.from) === "2025-12-01" && restMonth.from.getTime() === engineMonth.from.getTime() && restMonth.to.getTime() === engineMonth.to.getTime() && refused);
    const v = validateQueryPlan({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount"], filters: [] }, {});
    check("relative periods become absolute dates ONLY in the validator, with the tenant reference date (refused without it)", !v.ok && v.errors.some((e) => e.code === "reference_date_required"));
  }

  // =============================================================== B
  section("B. semantic sweeps (pure): what 'like-for-like' and 'new/lost' actually compare");
  {
    const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
    let monthEnd = 0;
    const truncated = [];
    let quarterEndTrunc = [];
    for (let y = 2024; y <= 2026; y += 1) for (let m = 0; m < 12; m += 1) {
      const ref = new Date(y, m, daysIn(y, m), 12);
      monthEnd += 1;
      const lfl = periodEngine.resolveComparisonPeriod("current_month", ref);
      const full = periodEngine.resolvePeriod("previous_month", ref);
      const cur = periodEngine.resolvePeriod("current_month", ref);
      if (!cur.isPartial && ymdLocal(lfl.to) !== ymdLocal(full.to)) truncated.push(`${ymdLocal(ref)} (vs ${ymdLocal(lfl.from)}..${ymdLocal(lfl.to)})`);
      if ([2, 5, 8, 11].includes(m)) {
        const q = periodEngine.resolveComparisonPeriod("current_quarter", ref);
        const pq = periodEngine.resolvePeriod("previous_quarter", ref);
        if (ymdLocal(q.to) !== ymdLocal(pq.to)) quarterEndTrunc.push(`${ymdLocal(ref)} (vs ${ymdLocal(q.from)}..${ymdLocal(q.to)})`);
      }
    }
    console.log(`    on a month's LAST day the month is complete, yet like-for-like drops the previous month's extra days: ${truncated.length}/${monthEnd} month-ends 2024-2026`);
    console.log(`      e.g. ${truncated.slice(0, 4).join(", ")}`);
    console.log(`    same at quarter end: ${quarterEndTrunc.join(", ")}`);
    check("documented: complete month vs TRUNCATED previous month on 15 of 36 month-ends (Feb/Apr/Jun/Sep/Nov ends); quarter end on 30 Jun", truncated.length === 15 && quarterEndTrunc.length === 3 && quarterEndTrunc.every((s) => /-06-30/.test(s)), `${truncated.length} / ${quarterEndTrunc.length}`);
    const n = validateQueryPlan({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_quarter" }, metrics: ["invoiceAmount"], filters: [], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], compare: { mode: "like_for_like" }, having: [{ metric: "invoiceAmount.previous", op: "eq", value: 0 }, { metric: "invoiceAmount", op: "gt", value: 0 }] }, { referenceDate: new Date(2026, 8, 18, 12) }).normalized;
    check(`"new customers this quarter" (18 Sep) = no purchase in ${ymdLocal(n.comparison.from)}..${ymdLocal(n.comparison.to)} only - a customer who bought on 25 Jun counts as NEW`, ymdLocal(n.comparison.from) === "2026-04-01" && ymdLocal(n.comparison.to) === "2026-06-18");
  }

  // =============================================================== C + D
  section("C. synthetic tenant: engine vs an INDEPENDENT oracle across calendar boundaries");
  await engineVsOracle();

  // =============================================================== E
  section("E. no network was used");
  check("zero fetch/http calls (no Anthropic, no Tally)", netCalls === 0, String(netCalls));
  Object.assign(global, { fetch: savedNet.fetch });
  http.request = savedNet.h;
  https.request = savedNet.s;
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ================================================================ C / D implementation
// Synthetic data is generated IN MEMORY; the oracle sums that array with its own calendar arithmetic. Nothing is shared
// with dateRanges / periodEngine / compile / execute.
const T = "verify-growth-audit-tenant";
const T_EMPTY = "verify-growth-audit-empty";
const T_ONE = "verify-growth-audit-one";

const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // m 0-based
const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addMonth = (y, m, k) => { const t = y * 12 + m + k; return [Math.floor(t / 12), ((t % 12) + 12) % 12]; };
const addDays = (s, k) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const r2 = (v) => Math.round(v * 100) / 100;

function buildData() {
  const sales = [];
  const purchases = [];
  let seq = 0;
  const v = (list, date, party, total, lines) => {
    seq += 1;
    list.push({ date, party, total: r2(total), lines: lines.map(([item, qty, amt]) => [item, qty, r2(amt)]), no: `GA-${seq}` });
  };
  const pre = (t) => t / 1.18; // pre-tax item value of a tax-inclusive total
  for (let i = 0; i < 26; i += 1) {
    const [y, m] = addMonth(2024, 0, i); // Jan 2024 .. Feb 2026
    const last = daysIn(y, m);
    v(sales, ymd(y, m, 5), "Grower Co", 1000 + 100 * i, [["Item A", 2, pre(1000 + 100 * i) * 0.6], ["Item C", 1, pre(1000 + 100 * i) * 0.4]]);
    v(sales, ymd(y, m, 20), "Grower Co", 500 + 50 * i, [["Item B", 1, pre(500 + 50 * i)]]);
    v(sales, ymd(y, m, 10), "Decliner Co", Math.max(200, 5000 - 120 * i), [["Item B", 3, pre(Math.max(200, 5000 - 120 * i))]]);
    v(sales, ymd(y, m, 15), "Flat Co", 2000, [["Item A", 4, pre(2000)]]);
    v(sales, ymd(y, m, 1), "Boundary Co", 300, [["Item C", 1, pre(300)]]); // first day of every month
    v(sales, ymd(y, m, last), "Boundary Co", 700, [["Item C", 2, pre(700)]]); // last day (incl. 29 Feb 2024, 31 Mar, 31 Dec)
    if (m % 2 === 0) v(sales, ymd(y, m, 12), "Seasonal Co", 900, [["Item D", 1, pre(900)]]); // Jan, Mar, May, ... (new/lost churn)
    if (y * 12 + m >= 2025 * 12 + 5) v(sales, ymd(y, m, 25), "Latecomer Co", 1500 + 10 * i, [["Item A", 1, pre(1500 + 10 * i)]]); // from Jun 2025
    if (y === 2024) v(sales, ymd(y, m, 8), "Gone Co", 800, [["Item B", 1, pre(800)]]); // lost from Jan 2025
    if ((y === 2024 && m <= 2) || y * 12 + m >= 2025 * 12 + 8) v(sales, ymd(y, m, 18), "Returner Co", 1200, [["Item D", 2, pre(1200)]]); // reactivated Sep 2025
    v(purchases, ymd(y, m, 3), "Supply North", 3000 + 75 * i, [["Item A", 10, pre(3000 + 75 * i)]]);
    if (m % 3 !== 1) v(purchases, ymd(y, m, 28), "Supply South", 1800, [["Item B", 6, pre(1800)]]);
  }
  return { sales, purchases };
}
const GROUP = { "Item A": "Group One", "Item B": "Group One", "Item C": "Group Two", "Item D": "Group Two" };

// oracle periods (plain calendar arithmetic on [y, m, d])
function ranges(kind, [y, m, d]) {
  const clamp = (yy, mm, dd) => ymd(yy, mm, Math.min(dd, daysIn(yy, mm)));
  const [py, pm] = addMonth(y, m, -1);
  const [p2y, p2m] = addMonth(y, m, -2);
  const qs = m - (m % 3);
  const [pqy, pqm] = addMonth(y, qs, -3);
  const [lqy, lqm] = addMonth(y, m, -3);
  const fyStart = m >= 3 ? y : y - 1;
  const cur = (from, to) => ({ from, to });
  switch (kind) {
    case "month_lfl": return [cur(ymd(y, m, 1), ymd(y, m, d)), cur(ymd(py, pm, 1), clamp(py, pm, d))];
    case "month_full": return [cur(ymd(y, m, 1), ymd(y, m, d)), cur(ymd(py, pm, 1), ymd(py, pm, daysIn(py, pm)))];
    case "month_sply": return [cur(ymd(y, m, 1), ymd(y, m, d)), cur(ymd(y - 1, m, 1), clamp(y - 1, m, d))];
    case "quarter_lfl": return [cur(ymd(y, qs, 1), ymd(y, m, d)), cur(ymd(pqy, pqm, 1), clamp(lqy, lqm, d))];
    case "fy_lfl": return [cur(ymd(fyStart, 3, 1), ymd(y, m, d)), cur(ymd(fyStart - 1, 3, 1), clamp(y - 1, m, d))];
    case "prev_months": return [cur(ymd(py, pm, 1), ymd(py, pm, daysIn(py, pm))), cur(ymd(p2y, p2m, 1), ymd(p2y, p2m, daysIn(p2y, p2m)))];
    case "last30": { const to = ymd(y, m, d); return [cur(addDays(to, -29), to), cur(addDays(to, -59), addDays(to, -30))]; }
    default: throw new Error(kind);
  }
}

// [question, oracle range kind, entity, breakdown, measure, filter, sort]
// Decision 2 (2026-09-28): "this month vs last month" = month to date vs the COMPLETE previous month (month_full); the
// same days are compared only when asked ("same period last month" = month_lfl). Decision 3: new CUSTOMERS are refused
// (party master not synced), so the "new" oracle row uses products.
const QUESTIONS = [
  ["Which customers grew this month vs last month?", "month_full", "sales", "customer", "invoice", "up", "delta desc"],
  ["Which customers grew this month vs the same period last month?", "month_lfl", "sales", "customer", "invoice", "up", "delta desc"],
  ["Which customers declined this month vs the full last month?", "month_full", "sales", "customer", "invoice", "down", "delta asc"],
  ["Which customers grew this month compared to same month last year?", "month_sply", "sales", "customer", "invoice", "up", "delta desc"],
  ["Which customers grew this quarter vs last quarter?", "quarter_lfl", "sales", "customer", "invoice", "up", "delta desc"],
  ["Which customers grew this financial year vs last financial year?", "fy_lfl", "sales", "customer", "invoice", "up", "delta desc"],
  ["Sales last month vs the month before", "prev_months", "sales", null, "invoice", null, null],
  ["New products sold this month vs last month", "month_full", "sales", "product", "line", "new", "current desc"],
  ["Which customers stopped buying this month vs last month?", "month_full", "sales", "customer", "invoice", "lost", "previous desc"],
  ["Which customers grew by more than 20% this month vs last month?", "month_full", "sales", "customer", "invoice", "pct>20", "pct desc"],
  ["Products whose revenue declined this quarter vs last quarter", "quarter_lfl", "sales", "product", "line", "down", "delta asc"],
  ["Which product groups increased their sales this quarter vs last quarter?", "quarter_lfl", "sales", "productGroup", "line", "up", "delta desc"],
  ["Suppliers whose purchases grew this month vs last month", "month_full", "purchase", "supplier", "invoice", "up", "delta desc"],
  ["Which customers grew in the last 30 days?", "last30", "sales", "customer", "invoice", "up", "delta desc"],
  ["Revenue this fy vs last fy", "fy_lfl", "sales", null, "line", null, null],
];
// The plan a correct interpretation of each spec produces (the planner interprets; this audit checks the ENGINE).
const KINDS = {
  month_full: [{ kind: "current_month" }, { mode: "full_previous" }],
  month_lfl: [{ kind: "current_month" }, { mode: "like_for_like" }],
  month_sply: [{ kind: "current_month" }, { mode: "same_period_last_year" }],
  quarter_lfl: [{ kind: "current_quarter" }, { mode: "like_for_like" }],
  fy_lfl: [{ kind: "current_fy" }, { mode: "like_for_like" }],
  prev_months: [{ kind: "previous_month" }, { mode: "like_for_like" }],
  last30: [{ kind: "last_30_days" }, { mode: "like_for_like" }],
};
function planOfSpec(q) {
  const [, kind, entity, dim, measure, filter, sort] = q;
  const [period, compare] = KINDS[kind];
  const metrics = measure === "line" ? ["lineAmount", "quantity"] : entity === "sales" ? ["invoiceAmount", "invoiceCount"] : ["purchaseAmount", "purchaseInvoiceCount"];
  const ma = metrics[0];
  const plan = { v: 1, entity, mode: "aggregate", period, metrics, filters: [], compare };
  if (!dim) return plan;
  plan.groupBy = [{ dim }];
  const having = {
    up: [{ metric: `${ma}.delta`, op: "gt", value: 0 }],
    down: [{ metric: `${ma}.delta`, op: "lt", value: 0 }],
    new: [{ metric: `${ma}.previous`, op: "eq", value: 0 }, { metric: ma, op: "gt", value: 0 }],
    lost: [{ metric: ma, op: "eq", value: 0 }, { metric: `${ma}.previous`, op: "gt", value: 0 }],
    "pct>20": [{ metric: `${ma}.deltaPct`, op: "gt", value: 20 }],
  }[filter];
  if (having) plan.having = having;
  const by = { "delta desc": [`${ma}.delta`, "desc"], "delta asc": [`${ma}.delta`, "asc"], "current desc": [ma, "desc"], "previous desc": [`${ma}.previous`, "desc"], "pct desc": [`${ma}.deltaPct`, "desc"] }[sort];
  if (by) plan.sort = [{ by: by[0], dir: by[1] }];
  return plan;
}

// anchors = the tenant's latest-voucher date (stored as UTC midnight, exactly like real synced vouchers)
const ANCHORS = ["2024-02-29", "2024-03-31", "2024-12-31", "2025-01-01", "2025-03-31", "2025-04-01", "2025-06-30", "2025-10-15", "2026-02-28"];

function oracleResult(data, q, anchor) {
  const [, kind, entity, dim, measure, filter, sort] = q;
  const [y, m, d] = anchor.split("-").map(Number);
  const [cur, prev] = ranges(kind, [y, m - 1, d]);
  const list = entity === "sales" ? data.sales : data.purchases;
  const inRange = (r) => (x) => x.date >= r.from && x.date <= r.to;
  const sums = (r) => {
    const out = new Map();
    const add = (key, a, b) => { const e = out.get(key) || { a: 0, b: 0 }; e.a += a; e.b += b; out.set(key, e); };
    for (const x of list.filter(inRange(r))) {
      if (measure === "invoice") add(dim ? x.party : "_", x.total, 1);
      else for (const [item, qty, amt] of x.lines) add(dim === "product" ? item : dim === "productGroup" ? GROUP[item] : dim ? x.party : "_", amt, qty);
    }
    return out;
  };
  const c = sums(cur);
  const p = sums(prev);
  const keys = [...new Set([...c.keys(), ...p.keys()])];
  let rows = keys.map((k) => {
    const cv = c.get(k) || { a: 0, b: 0 };
    const pv = p.get(k) || { a: 0, b: 0 };
    return { k, cur: cv.a, curB: cv.b, prev: pv.a, prevB: pv.b, delta: cv.a - pv.a, pct: pv.a === 0 ? null : ((cv.a - pv.a) / Math.abs(pv.a)) * 100 };
  });
  const keep = { up: (r) => r.delta > 0, down: (r) => r.delta < 0, new: (r) => r.prev === 0 && r.cur > 0, lost: (r) => r.cur === 0 && r.prev > 0, "pct>20": (r) => r.pct !== null && r.pct > 20 };
  if (filter) rows = rows.filter(keep[filter]);
  const rd6 = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);
  const val = { "delta desc": (r) => [r.delta, -1], "delta asc": (r) => [r.delta, 1], "current desc": (r) => [r.cur, -1], "previous desc": (r) => [r.prev, -1], "pct desc": (r) => [r.pct, -1] };
  if (sort) {
    rows.sort((a, b) => {
      const [rawA, dir] = val[sort](a); // dir: 1 = ascending, -1 = descending
      const va = rd6(rawA);
      const vb = rd6(val[sort](b)[0]);
      if (va !== vb) {
        if (va === null) return 1; // nulls last, either direction
        if (vb === null) return -1;
        return (va < vb ? -1 : 1) * dir;
      }
      const ka = JSON.stringify({ [dim]: a.k });
      const kb = JSON.stringify({ [dim]: b.k });
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  const total = (map) => [...map.values()].reduce((s, e) => ({ a: s.a + e.a, b: s.b + e.b }), { a: 0, b: 0 });
  return { cur, prev, rows: rows.slice(0, 10), truncated: rows.length > 10, total: total(c), totalPrev: total(p), all: rows.length, newCount: rows.filter((r) => r.prev === 0).length };
}

// PROPOSED coverage classification (design reference only - not production code)
function classifyCoverage(range, coverage) {
  if (!coverage.earliest) return "no_data";
  if (range.to < coverage.earliest) return "before_history";
  if (range.from > coverage.latest) return "after_latest_data";
  if (range.from < coverage.earliest) return "partly_before_history";
  if (range.to > coverage.latest) return "partly_after_latest_data";
  return "covered";
}

async function engineVsOracle() {
  const mongoose = require("mongoose");
  try {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set");
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  } catch (e) {
    console.log("  SKIPPED - MongoDB not reachable (sections A-B are complete without it)");
    return;
  }
  const Sale = require("./src/models/sales.model");
  const Purchase = require("./src/models/purchase.model");
  const StockItemMaster = require("./src/models/stockItemMaster.model");
  const { executeQuery } = require("./src/services/query/execute");
  const { getTenantReferenceDate } = require("./src/services/analytics/referenceDate");
  const clean = async () => {
    const ids = { $in: [T, T_EMPTY, T_ONE] };
    // raw driver: synthetic tenant only, no model hooks (no TenantDataVersion writes)
    await Promise.all([Sale.collection.deleteMany({ tenantId: ids }), Purchase.collection.deleteMany({ tenantId: ids }), StockItemMaster.collection.deleteMany({ tenantId: ids })]);
  };
  const data = buildData();
  const doc = (tenantId, x) => ({
    tenantId, tallyGuid: `${tenantId}-${x.no}`, tallyAlterId: Number(x.no.slice(3)), voucherStatus: "active",
    header: { voucherNo: x.no, voucherDate: new Date(`${x.date}T00:00:00.000Z`), voucherType: "Invoice", voucherTotalAmount: x.total, narration: "", partyName: x.party },
    inventory: x.lines.map(([itemName, quantity, amount]) => ({ itemName, quantity, rate: quantity ? amount / quantity : 0, amount })), ledgers: [],
  });
  let oracleMatches = 0;
  let oracleRuns = 0;
  try {
    await clean();
    await Sale.collection.insertMany(data.sales.map((x) => doc(T, x)));
    await Purchase.collection.insertMany(data.purchases.map((x) => doc(T, x)));
    await StockItemMaster.collection.insertMany(Object.entries(GROUP).map(([itemName, stockGroupName]) => ({ tenantId: T, itemName, stockGroupName, tallyGuid: `${T}-m-${itemName}`, syncedAt: new Date() })));
    await Sale.collection.insertOne(doc(T_ONE, { no: "GA-1", date: "2025-06-10", party: "Solo Co", total: 500, lines: [["Item A", 1, 423.73]] }));
    console.log(`    synthetic tenant: ${data.sales.length} sales + ${data.purchases.length} purchase vouchers, Jan 2024 - Feb 2026, 8 customer behaviours (growing, declining, flat, month-boundary days, alternating, new, lost, reactivated)`);

    const near = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.01);
    const fmt = (s) => ymdLocal(new Date(s));
    const problems = [];
    for (const anchor of ANCHORS) {
      const referenceDate = new Date(`${anchor}T00:00:00.000Z`);
      for (const q of QUESTIONS) {
        oracleRuns += 1;
        const plan = planOfSpec(q);
        const res = await executeQuery(plan, { tenantId: T, referenceDate });
        const exp = oracleResult(data, q, anchor);
        const issues = [];
        if (!res.ok) issues.push(`engine ${JSON.stringify(res.errors)}`);
        else {
          if (fmt(res.period.from) !== exp.cur.from || fmt(res.period.to) !== exp.cur.to) issues.push(`subject ${fmt(res.period.from)}..${fmt(res.period.to)} vs oracle ${exp.cur.from}..${exp.cur.to}`);
          if (fmt(res.comparison.from) !== exp.prev.from || fmt(res.comparison.to) !== exp.prev.to) issues.push(`baseline ${fmt(res.comparison.from)}..${fmt(res.comparison.to)} vs oracle ${exp.prev.from}..${exp.prev.to}`);
          const [ma, mb] = plan.metrics;
          if (q[3]) {
            if (res.rows.length !== exp.rows.length) issues.push(`rows ${res.rows.length} vs ${exp.rows.length}`);
            res.rows.forEach((row, i) => {
              const e = exp.rows[i];
              if (!e || row.key[q[3]] !== e.k) return issues.push(`row ${i}: ${row.key[q[3]]} vs ${e && e.k}`);
              if (!near(row.values[ma], e.cur) || !near(row.comparison[ma].previous, e.prev) || !near(row.comparison[ma].delta, e.delta) || !near(row.comparison[ma].deltaPct, e.pct)) issues.push(`row ${i} ${e.k} values`);
              if (mb && !near(row.values[mb], e.curB)) issues.push(`row ${i} ${e.k} ${mb}`);
            });
            if (res.truncated !== exp.truncated) issues.push("truncated flag");
          }
          if (res.totals) {
            if (!near(res.totals.values[ma], exp.total.a)) issues.push(`total ${res.totals.values[ma]} vs ${exp.total.a}`);
            if (res.totals.comparison && !near(res.totals.comparison[ma].previous, exp.totalPrev.a)) issues.push(`total previous ${res.totals.comparison[ma].previous} vs ${exp.totalPrev.a}`);
          }
        }
        if (issues.length) problems.push(`${anchor} "${q[0]}": ${issues.slice(0, 3).join("; ")}`);
        else oracleMatches += 1;
      }
    }
    check(`engine = independent oracle for ${oracleMatches}/${oracleRuns} runs (${QUESTIONS.length} questions x ${ANCHORS.length} boundary anchors: month-end, 29 Feb, FY end/start, quarter end, year end/start, mid-month)`, problems.length === 0, problems.slice(0, 5).join(" | "));

    // ---------- F. coverage: "no sales" vs "no data"
    section("D. data coverage: when a zero baseline means 'no data', not 'no sales'");
    const refT = await getTenantReferenceDate(T);
    const [minDoc] = await Sale.collection.find({ tenantId: T, voucherStatus: "active" }).sort({ "header.voucherDate": 1 }).limit(1).toArray();
    const coverage = { earliest: minDoc.header.voucherDate.toISOString().slice(0, 10), latest: refT.toISOString().slice(0, 10) };
    check(`coverage is derivable from existing data: earliest ${coverage.earliest}, latest ${coverage.latest} (latest = the reference date)`, coverage.earliest === "2024-01-01" && coverage.latest === "2026-02-28");
    // 1. comparison entirely before history: every active customer "grew" from 0 and NOTHING says the baseline has no data
    const a1 = new Date("2024-02-29T00:00:00.000Z");
    const p1 = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount"], filters: [], groupBy: [{ dim: "customer" }], compare: { mode: "same_period_last_year" }, having: [{ metric: "invoiceAmount.delta", op: "gt", value: 0 }], sort: [{ by: "invoiceAmount.delta", dir: "desc" }] }; // "Which customers grew this month compared to same month last year?"
    const e1 = await executeQuery(p1, { tenantId: T, referenceDate: a1 });
    const cmp1 = { from: fmt(e1.comparison.from), to: fmt(e1.comparison.to) };
    check(`comparison ${cmp1.from}..${cmp1.to} lies BEFORE history (${classifyCoverage(cmp1, coverage)}): all ${e1.rows.length} rows show previous = 0, and the result carries no coverage warning`, classifyCoverage(cmp1, coverage) === "before_history" && e1.rows.length > 0 && e1.rows.every((r) => r.comparison.invoiceAmount.previous === 0) && !(e1.warnings || []).some((w) => /coverage|history|before/i.test(w.code || "")));
    // 2. comparison partly before history
    const a2 = new Date("2025-01-31T00:00:00.000Z");
    const p2 = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_fy" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [], compare: { mode: "like_for_like" } }; // "Sales this financial year vs last financial year"
    const e2 = await executeQuery(p2, { tenantId: T, referenceDate: a2 });
    const cmp2 = { from: fmt(e2.comparison.from), to: fmt(e2.comparison.to) };
    check(`comparison ${cmp2.from}..${cmp2.to} is PARTLY before history (${classifyCoverage(cmp2, coverage)}): growth is overstated, no warning`, classifyCoverage(cmp2, coverage) === "partly_before_history" && e2.totals.comparison.invoiceAmount.delta > 0);
    // 3. subject partly after the latest data (explicit range reaching past the anchor)
    const p3 = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2026-02-01", to: "2026-03-31" }, metrics: ["invoiceAmount"], filters: [] }; // "Sales from 2026-02-01 to 2026-03-31"
    const r3 = validateQueryPlan(p3, { referenceDate: refT });
    check(`an explicit range past the latest synced voucher is classified "${classifyCoverage({ from: "2026-02-01", to: "2026-03-31" }, coverage)}" (sync lag, not zero sales)`, r3.ok && classifyCoverage({ from: "2026-02-01", to: "2026-03-31" }, coverage) === "partly_after_latest_data");
    // 4. fully covered comparison: a zero really is zero
    const cmp4 = ranges("month_lfl", [2025, 9, 15]);
    check(`fully covered comparison (${cmp4[1].from}..${cmp4[1].to}): a 0 for a customer is a genuine "no sales"`, classifyCoverage(cmp4[1], coverage) === "covered");
    // 5-10. behaviours inside covered history
    // oracle specs: parties absent in / gone from the comparison month
    const ABSENT_BEFORE = ["(oracle) customers absent in the comparison month", "month_full", "sales", "customer", "invoice", "new", "current desc"];
    const GONE = ["(oracle) customers absent in this month", "month_full", "sales", "customer", "invoice", "lost", "previous desc"];
    const o = oracleResult(data, ABSENT_BEFORE, "2025-06-30");
    check(`a customer whose first voucher is inside history (Latecomer Co, 2025-06-25) is absent in May 2025 - a real zero`, o.rows.some((r) => r.k === "Latecomer Co"));
    const o2 = oracleResult(data, ABSENT_BEFORE, "2025-09-30");
    check("a returning customer (Returner Co, silent Apr 2024 - Aug 2025) is equally absent from the comparison month - why decision 3 refuses 'new customer' without the party master", o2.rows.some((r) => r.k === "Returner Co"));
    const o3 = oracleResult(data, GONE, "2025-01-31");
    check("lost customer (Gone Co, last voucher Dec 2024) shows as 'stopped buying' in Jan 2025", o3.rows.some((r) => r.k === "Gone Co"));
    // 11. tenant with no data: the reference date falls back to the wall clock; every period is empty
    const refEmpty = await getTenantReferenceDate(T_EMPTY);
    check("tenant with NO data: reference date falls back to the wall clock (freshness 'never_synced' is what stops an answer)", Math.abs(refEmpty.getTime() - Date.now()) < 60000);
    // 12. tenant with one voucher: the reference date is that voucher; last month is 'before history'
    const refOne = await getTenantReferenceDate(T_ONE);
    const pOne = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [], compare: { mode: "full_previous" } }; // "Sales this month vs last month"
    const eOne = await executeQuery(pOne, { tenantId: T_ONE, referenceDate: refOne });
    check(`tenant with ONE voucher (${refOne.toISOString().slice(0, 10)}): this month = 500 vs last month 0 - a 'no data' baseline presented as growth`, eOne.ok && eOne.totals.values.invoiceAmount === 500 && eOne.totals.comparison.invoiceAmount.previous === 0 && eOne.totals.comparison.invoiceAmount.deltaPct === null);
  } finally {
    await clean();
    const left = await Promise.all([Sale.collection.countDocuments({ tenantId: { $in: [T, T_EMPTY, T_ONE] } }), Purchase.collection.countDocuments({ tenantId: { $in: [T, T_EMPTY, T_ONE] } }), StockItemMaster.collection.countDocuments({ tenantId: { $in: [T, T_EMPTY, T_ONE] } })]);
    check("synthetic tenants removed (0 documents left)", left.every((n) => n === 0), JSON.stringify(left));
    // real tenants: counts only, never names
    const Company = require("./src/models/company");
    const tenants = await Company.find({ isActive: true }, { tenantId: 1 }).lean();
    const cov = [];
    for (const c of tenants) {
      const [mn] = await Sale.collection.find({ tenantId: c.tenantId, voucherStatus: "active" }).sort({ "header.voucherDate": 1 }).limit(1).toArray();
      const ref = await getTenantReferenceDate(c.tenantId);
      if (mn) cov.push(`${mn.header.voucherDate.toISOString().slice(0, 10)}..${ref.toISOString().slice(0, 10)}`);
    }
    console.log(`    real tenants (read-only, unnamed): synced coverage ${cov.join(", ")} - a YoY question at their anchor compares against a year with NO synced data`);
    await mongoose.disconnect();
  }
}
