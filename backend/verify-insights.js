/**
 * Insights (services/analytics/insights.js): discount, product rates, supplier rates, indicative margin per product and per
 * supplier, and the month-by-month product trend, and their REST handlers.
 *
 * Every figure is checked against an INDEPENDENT oracle: plain JavaScript loops over the same synthetic vouchers, written
 * from the definitions in insights.js (not from its pipeline), with dates compared as YYYY-MM-DD strings. Also checked:
 * cancelled vouchers and other tenants never count, both period edge days are inclusive, free goods, lines without a rate,
 * the implausible-line rule, tiny-volume suppliers never win "best rate", mixed-unit products are flagged, and the
 * handlers validate their input and answer through the trust envelope.
 *
 * Synthetic data only. Writes go to clearly synthetic tenants and are removed at the end. Refuses to run against anything
 * but a loopback MongoDB.
 *
 * Run: node verify-insights.js
 */

require("dotenv").config();
{
  const uri = process.env.MONGODB_URI || "";
  const host = (/^mongodb:\/\/(?:[^@/]*@)?\[?([^\]/:,]+)\]?(?::\d+)?[/?]/.exec(uri) || [])[1];
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || /mongodb\+srv|mongodb\.net|atlas/i.test(uri)) {
    console.error("REFUSED: verify-insights.js only runs against a loopback MongoDB. Nothing was touched.");
    process.exit(2);
  }
  require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };
}

const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const insights = require("./src/services/analytics/insights");
const controller = require("./src/controllers/analyticsController");

let pass = 0;
let fail = 0;
function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const TA = "TEST-TENANT-A-insights";
const TB = "TEST-TENANT-B-insights";
const GUID_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const GUID_B = "bbbbbbbb-0000-4000-8000-0000000000b2";

// ---------------------------------------------------------------- fixtures (names, numbers and dates are synthetic)
// A line: [item, quantity, rate, amount as Tally stores it (purchase amounts negative)]
let n = 0;
const V = (kind, tenant, date, party, lines, status = "active") => ({ kind, tenant, date, party, lines, status, no: `${kind[0].toUpperCase()}${++n}`, guid: `${tenant === TA ? GUID_A : GUID_B}-0000${String(n).padStart(4, "0")}` });
const VOUCHERS = [
  V("sale", TA, "2025-08-01", "Cust One", [["Item Alpha", 440, 20.9, 7264.84], ["Item Beta", 10, 100, 1000]]),
  V("sale", TA, "2025-08-15", "Cust Two", [["Item Alpha", 100, 20.9, 1881], ["Item Gamma", 5, 50, 0], ["Item Delta", 10, 100, 20], ["Item NoRate", 3, 0, 300]]),
  V("sale", TA, "2025-09-02", "Cust One", [["Item Alpha", 50, 21, 1050], ["Item Beta", 20, 100, 1800]]),
  V("sale", TA, "2025-08-31", "Cust Two", [["Item Beta", 1, 100, 90]]), // last day of August: included
  V("sale", TA, "2025-09-01", "Cust Two", [["Item Beta", 1, 100, 50]]), // first day of September: not in August
  V("sale", TA, "2025-08-10", "Cust One", [["Item Alpha", 1000, 20, 100]], "cancelled"), // never counted
  V("sale", TB, "2025-08-05", "Cust One", [["Item Alpha", 10, 100, 500]]), // another tenant: never counted for A
  V("purchase", TA, "2025-08-05", "Sup X", [["Item Alpha", 1000, 18, -16200], ["Item Beta", 50, 80, -4000]]),
  V("purchase", TA, "2025-08-20", "Sup Y", [["Item Alpha", 500, 17, -8500], ["Item Beta", 10, 85, -850]]),
  V("purchase", TA, "2025-08-02", "Sup Y", [["Item Alpha", 100, 17, -1700]]), // stored AFTER the 20 Aug one but dated EARLIER: the "last" purchase must be chosen by date, not by storage order
  V("purchase", TA, "2025-09-03", "Sup X", [["Item Alpha", 200, 19, -3800]]),
  V("purchase", TA, "2025-08-25", "Sup Z", [["Item Alpha", 5, 10, -50]]), // lowest rate but a tiny one-off
  V("purchase", TA, "2025-08-12", "Sup X", [["Item Mixed", 100, 10, -1000], ["Item Mixed", 1, 1000, -1000]]), // two different units under one name
  V("purchase", TB, "2025-08-06", "Sup X", [["Item Alpha", 10, 1, -10]]),

  // ---- margin fixtures: June 2026 (cost window = the 365 days before it). Other dates than the August/September data above, so none of the earlier hand checks move.
  V("sale", TA, "2026-06-10", "Cust One", [["Item Edge", 5, 30, 150]]),
  V("purchase", TA, "2025-05-31", "Sup X", [["Item Edge", 100, 50, -5000]]), // one day BEFORE the cost window: ignored
  V("purchase", TA, "2025-06-01", "Sup X", [["Item Edge", 10, 30, -300]]), // first day of the window: counts
  V("purchase", TA, "2026-05-31", "Sup X", [["Item Edge", 10, 10, -100]]), // last day before the period: counts
  V("sale", TA, "2026-06-05", "Cust One", [["Item InPeriod", 10, 20, 200]]),
  V("purchase", TA, "2026-06-02", "Sup Y", [["Item InPeriod", 20, 15, -300]]),
  V("purchase", TA, "2026-04-01", "Sup Y", [["Item InPeriod", 10, 5, -50]]), // an earlier purchase is ignored when the period has its own
  V("sale", TA, "2026-06-09", "Cust Two", [["Item InPeriod", 100, 1000, 100000]], "cancelled"), // never counted
  V("sale", TA, "2026-06-06", "Cust Two", [["Item Loss", 4, 10, 40]]),
  V("purchase", TA, "2026-06-03", "Sup X", [["Item Loss", 4, 20, -80]]),
  V("sale", TA, "2026-06-07", "Cust One", [["Item NoCost", 3, 30, 90]]), // sold but never bought: no cost
  V("sale", TA, "2026-06-08", "Cust One", [["Item Unit", 1, 1000, 1000]]),
  V("sale", TA, "2026-06-08", "Cust Two", [["Item Unit", 100, 10, 1000]]), // 1000 and 10 per unit under one name: possible mixed units
  V("purchase", TA, "2026-06-04", "Sup Y", [["Item Unit", 50, 10, -500]]),
  V("sale", TA, "2026-06-11", "Cust Two", [["Item Free", 2, 50, 0]]), // free goods only: no rate, not a priced product
  V("sale", TB, "2026-06-05", "Cust One", [["Item InPeriod", 1, 1, 1]]), // another tenant
  // ---- trend fixtures: January to March 2026, nothing in February
  V("sale", TA, "2026-01-10", "Cust One", [["Item Trend", 5, 10, 50]]),
  V("sale", TA, "2026-01-20", "Cust Two", [["Item Trend", 3, 10, 0]]), // free goods: quantity out, no price
  V("sale", TA, "2026-03-15", "Cust One", [["Item Trend", 4, 12, 48]]),
  V("sale", TA, "2026-02-10", "Cust One", [["Item Trend", 100, 10, 1000]], "cancelled"), // never counted: February stays empty
  V("sale", TB, "2026-02-05", "Cust One", [["Item Trend", 7, 10, 70]]), // another tenant
  V("purchase", TA, "2026-01-02", "Sup X", [["Item Trend", 20, 6, -120]]),
  V("purchase", TA, "2026-03-01", "Sup Y", [["Item Trend", 10, 8, -80]]),
];

// ---------------------------------------------------------------- the independent oracle (plain JS, from the definitions)
const inRange = (v, from, to) => v.date >= from && v.date <= to;
function oracleDiscount(kind, tenant, from, to, keyOf) {
  const groups = new Map();
  const add = (key, line) => {
    const g = groups.get(key) || { gross: 0, billed: 0, discount: 0, lines: 0, listed: 0, discounted: 0, excluded: 0 };
    groups.set(key, g);
    const [, q, r, amt] = line;
    g.lines += 1;
    if (!(r > 0 && q > 0)) return;
    g.listed += 1;
    const gross = Math.abs(q * r), net = Math.abs(amt);
    if (!(net === 0 || net >= gross * 0.05)) { g.excluded += 1; return; }
    g.gross += gross; g.billed += net;
    const d = Math.max(0, gross - net);
    g.discount += d;
    if (d > 0.005) g.discounted += 1;
  };
  for (const v of VOUCHERS) {
    if (v.kind !== kind || v.tenant !== tenant || v.status !== "active" || !inRange(v, from, to)) continue;
    for (const line of v.lines) { add("ALL", line); if (keyOf) add(keyOf(v, line), line); }
  }
  const shape = (g) => ({ grossAmount: r2(g.gross), billedAmount: r2(g.billed), discountAmount: r2(g.discount), discountPct: g.gross > 0 ? r2((g.discount / g.gross) * 100) : 0, lines: g.lines, listedLines: g.listed, discountedLines: g.discounted, excludedLines: g.excluded });
  return { all: shape(groups.get("ALL") || { gross: 0, billed: 0, discount: 0, lines: 0, listed: 0, discounted: 0, excluded: 0 }), by: new Map([...groups].filter(([k, g]) => k !== "ALL" && g.gross > 0).map(([k, g]) => [k, shape(g)])) };
}
function oracleRates(tenant, from, to) {
  const rows = new Map();
  const slot = (name) => { if (!rows.has(name)) rows.set(name, { sq: 0, sb: 0, sl: 0, pq: 0, pb: 0, saleRates: [], purchaseRates: [] }); return rows.get(name); };
  for (const v of VOUCHERS) {
    if (v.tenant !== tenant || v.status !== "active" || !inRange(v, from, to)) continue;
    for (const [item, q, rate, amt] of v.lines) {
      const net = Math.abs(amt);
      if (!(q > 0 && net > 0)) continue; // free goods have no rate
      const s = slot(item);
      (v.kind === "sale" ? s.saleRates : s.purchaseRates).push(net / q);
      if (v.kind === "sale") { s.sq += q; s.sb += net; s.sl += rate > 0 ? Math.abs(q * rate) : net; } else { s.pq += q; s.pb += net; }
    }
  }
  return [...rows].map(([product, s]) => ({
    product,
    saleQty: r2(s.sq), saleRate: s.sq > 0 ? r2(s.sb / s.sq) : null, saleListRate: s.sq > 0 ? r2(s.sl / s.sq) : null,
    purchaseQty: r2(s.pq), purchaseRate: s.pq > 0 ? r2(s.pb / s.pq) : null,
    rateGap: s.sq > 0 && s.pq > 0 ? r2(s.sb / s.sq - s.pb / s.pq) : null,
    // measured per side: a normal margin (buying at 16, selling at 20) must not look like mixed units
    rateSpread: r2(Math.max(...[s.saleRates, s.purchaseRates].filter((a) => a.length).map((a) => Math.max(...a) / Math.min(...a)))),
    _sortKey: s.sb,
  })).sort((a, b) => b._sortKey - a._sortKey || (a.product < b.product ? -1 : 1)).map(({ _sortKey, ...rest }) => rest);
}
function oracleSuppliers(tenant, item, from, to) {
  const per = new Map();
  for (const v of VOUCHERS) {
    if (v.kind !== "purchase" || v.tenant !== tenant || v.status !== "active" || !inRange(v, from, to)) continue;
    for (const [name, q, rate, amt] of v.lines) {
      if (name !== item || !(q > 0) || Math.abs(amt) === 0) continue;
      const p = per.get(v.party) || { qty: 0, billed: 0, last: null, vouchers: new Set() };
      per.set(v.party, p);
      p.qty += q; p.billed += Math.abs(amt); p.vouchers.add(v.no);
      if (!p.last || v.date >= p.last.date) p.last = { date: v.date, rate: Math.abs(amt) / q };
    }
  }
  const total = [...per.values()].reduce((s, p) => s + p.qty, 0);
  const sup = [...per].map(([supplier, p]) => ({ supplier, avg: p.billed / p.qty, qty: p.qty, share: p.qty / total, lastRate: p.last.rate, lastDate: p.last.date, purchases: p.vouchers.size })).sort((a, b) => a.avg - b.avg);
  const best = sup.find((s) => s.share >= 0.05) || sup[0];
  return { suppliers: sup, best, saving: r2(sup.reduce((s, x) => s + Math.max(0, x.avg - best.avg) * x.qty, 0)) };
}

const addDays = (day, k) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
// Indicative margin per product sold in [from, to]: sale rate vs purchase cost (same-period purchases, else the 365 days before `from`).
function oracleMargin(tenant, from, to) {
  const sold = new Map(), bought = new Map(), early = new Map();
  const put = (map, item, q, net) => { const s = map.get(item) || { q: 0, b: 0, rates: [] }; map.set(item, s); s.q += q; s.b += net; s.rates.push(net / q); };
  for (const v of VOUCHERS) {
    if (v.tenant !== tenant || v.status !== "active") continue;
    for (const [item, q, , amt] of v.lines) {
      const net = Math.abs(amt);
      if (!(q > 0 && net > 0)) continue;
      if (v.kind === "sale" && inRange(v, from, to)) put(sold, item, q, net);
      if (v.kind === "purchase" && inRange(v, from, to)) put(bought, item, q, net);
      if (v.kind === "purchase" && inRange(v, addDays(from, -365), addDays(from, -1))) put(early, item, q, net);
    }
  }
  const spreadOf = (s) => (s ? Math.max(...s.rates) / Math.min(...s.rates) : 1);
  return [...sold].map(([product, s]) => {
    const cost = bought.get(product) || early.get(product) || null;
    const source = bought.has(product) ? "period" : early.has(product) ? "earlier" : null;
    const saleRate = s.b / s.q, costRate = cost ? cost.b / cost.q : null;
    return { product, soldQty: s.q, saleAmount: s.b, saleRate, costRate, source, unitMargin: cost ? saleRate - costRate : null, pct: cost ? ((saleRate - costRate) / saleRate) * 100 : null, profit: cost ? (saleRate - costRate) * s.q : null, spread: Math.max(spreadOf(s), spreadOf(cost)) };
  });
}
// Same ordering rule, written differently: costless products last, then the chosen key, ties by sale amount (desc) and name.
function oracleMarginOrder(rows, key, dir) {
  const withCost = rows.filter((r) => r[key] !== null).sort((a, b) => (a[key] === b[key] ? b.saleAmount - a.saleAmount || (a.product < b.product ? -1 : 1) : dir === "asc" ? a[key] - b[key] : b[key] - a[key]));
  const without = rows.filter((r) => r[key] === null).sort((a, b) => b.saleAmount - a.saleAmount || (a.product < b.product ? -1 : 1));
  return [...withCost, ...without];
}
const marginShape = (r) => [r.product, r2(r.soldQty), r2(r.saleAmount), r2(r.saleRate), r.costRate === null ? null : r2(r.costRate), r.source, r.unitMargin === null ? null : r2(r.unitMargin), r.pct === null ? null : r2(r.pct), r.profit === null ? null : r2(r.profit), r.unitMargin !== null && r.unitMargin < 0, r.spread > 5];
// Month by month quantities for one product (names matched case-insensitively), gaps between the first and last active month as zeros.
function oracleTrend(tenant, item, from, to) {
  const months = new Map();
  for (const v of VOUCHERS) {
    if (v.tenant !== tenant || v.status !== "active" || !inRange(v, from, to)) continue;
    for (const [name, q, , amt] of v.lines) {
      if (name.toLowerCase() !== item.toLowerCase() || !(q > 0)) continue;
      const m = months.get(v.date.slice(0, 7)) || { sq: 0, sa: 0, sp: 0, sv: new Set(), pq: 0, pa: 0, pp: 0, pv: new Set() };
      months.set(v.date.slice(0, 7), m);
      const net = Math.abs(amt);
      if (v.kind === "sale") { m.sq += q; m.sa += net; if (net > 0) m.sp += q; m.sv.add(v.no); } else { m.pq += q; m.pa += net; if (net > 0) m.pp += q; m.pv.add(v.no); }
    }
  }
  const keys = [...months.keys()].sort();
  const out = [];
  if (keys.length) {
    for (let [y, mo] = keys[0].split("-").map(Number); ; mo += 1) {
      if (mo > 12) { y += 1; mo = 1; }
      const key = `${y}-${String(mo).padStart(2, "0")}`;
      out.push([key, months.get(key) || { sq: 0, sa: 0, sp: 0, sv: new Set(), pq: 0, pa: 0, pp: 0, pv: new Set() }]);
      if (key === keys[keys.length - 1]) break;
    }
  }
  let run = 0;
  return out.map(([month, m]) => { run += m.pq - m.sq; return { month, saleQty: r2(m.sq), saleAmount: r2(m.sa), saleRate: m.sp > 0 ? r2(m.sa / m.sp) : null, saleVouchers: m.sv.size, purchaseQty: r2(m.pq), purchaseAmount: r2(m.pa), purchaseRate: m.pp > 0 ? r2(m.pa / m.pp) : null, purchaseVouchers: m.pv.size, netQty: r2(m.pq - m.sq), cumulativeNetQty: r2(run) }; });
}
// Unrounded average net sale rate of one product in a period (what the supplier margin is measured against).
function oracleSaleRate(tenant, item, from, to) {
  let q = 0, b = 0;
  for (const v of VOUCHERS) {
    if (v.kind !== "sale" || v.tenant !== tenant || v.status !== "active" || !inRange(v, from, to)) continue;
    for (const [name, lq, , amt] of v.lines) if (name === item && lq > 0 && Math.abs(amt) > 0) { q += lq; b += Math.abs(amt); }
  }
  return q > 0 ? b / q : null;
}

const period = (from, to) => ({ from: new Date(`${from}T00:00:00`), to: new Date(`${to}T00:00:00`), label: `${from}..${to}` }); // local calendar days, as the period engine produces them
const AUG = ["2025-08-01", "2025-08-31"], AUG_SEP = ["2025-08-01", "2025-09-30"];
const JUN26 = ["2026-06-01", "2026-06-30"], Q1_26 = ["2026-01-01", "2026-03-31"];

async function cleanup() {
  const ids = { $in: [TA, TB] };
  await Promise.all([Sale.deleteMany({ tenantId: ids }), Purchase.deleteMany({ tenantId: ids }), SyncCheckpoint.deleteMany({ tenantId: ids })]);
}

async function main() {
  await connectDB();
  await cleanup();
  try {
    for (const v of VOUCHERS) {
      const Model = v.kind === "sale" ? Sale : Purchase;
      await Model.create({
        tenantId: v.tenant,
        header: { voucherNo: v.no, voucherDate: new Date(`${v.date}T00:00:00Z`), voucherType: v.kind === "sale" ? "Invoice" : "Purchase", partyName: v.party, voucherTotalAmount: 1, narration: "" },
        inventory: v.lines.map(([itemName, quantity, rate, amount]) => ({ itemName, quantity, rate, amount })),
        ledgers: [],
        tallyGuid: v.guid,
        tallyAlterId: n,
        voucherStatus: v.status,
      });
    }
    for (const t of [TA, TB]) for (const voucherType of ["Sales", "Purchase"]) {
      await SyncCheckpoint.create({ tenantId: t, companyGuid: t === TA ? GUID_A : GUID_B, voucherType, lastAlterId: 999, lastRunStatus: "success", lastSyncedAt: new Date(), isRunning: false });
    }

    // ---------------------------------------------------------- discount
    console.log("=== 1. Discount (sales) ===");
    const o = oracleDiscount("sale", TA, ...AUG, (v) => v.party);
    const d = await insights.discountSummary(TA, period(...AUG), { by: "customer" });
    check("disc-totals", "August totals equal the oracle (gross, billed, discount, %, line counters)", d.totals, o.all);
    check("disc-hand", "hand check: discount 1,931.16 + 209 + 250 (free goods) + 10 = 2,400.16 on 12,636.00 list value; 1 implausible line left out", [d.totals.discountAmount, d.totals.grossAmount, d.totals.excludedLines, d.totals.discountedLines], [2400.16, 12636, 1, 4]);
    check("disc-identity", "gross - billed = discount (same lines)", r2(d.totals.grossAmount - d.totals.billedAmount), d.totals.discountAmount);
    check("disc-by-customer", "breakdown by customer equals the oracle, biggest discount first", d.rows.map((r) => [r.key, r.discountAmount]), [...o.by].sort((a, b) => b[1].discountAmount - a[1].discountAmount).map(([k, v]) => [k, v.discountAmount]));
    check("disc-by-customer-full", "...with every figure per customer", d.rows.map(({ key, ...rest }) => [key, rest]), [...o.by].sort((a, b) => b[1].discountAmount - a[1].discountAmount).map(([k, v]) => [k, v]));
    check("disc-edge-days", "both edge days: 31 Aug is in August, 1 Sep is not", [d.totals.lines, (await insights.discountSummary(TA, period("2025-09-01", "2025-09-01"))).totals.lines], [7, 1]);
    check("disc-cancelled", "a cancelled voucher's discount is never counted (it would add 19,900)", d.totals.grossAmount < 20000, true);
    check("disc-tenant", "another tenant's vouchers never count: B sees only its own 500 discount (10 x 100 billed 500), A's 2,400.16 is unchanged", [(await insights.discountSummary(TB, period(...AUG))).totals.discountAmount, d.totals.discountAmount], [500, 2400.16]);

    const op = oracleDiscount("sale", TA, ...AUG_SEP, (v, l) => l[0]);
    const byProduct = await insights.discountSummary(TA, period(...AUG_SEP), { by: "product", limit: 10 });
    check("disc-by-product", "breakdown by product over two months equals the oracle", byProduct.rows.map(({ key, ...rest }) => [key, rest]).sort((a, b) => (a[0] < b[0] ? -1 : 1)), [...op.by].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    const byMonth = await insights.discountSummary(TA, period(...AUG_SEP), { by: "month" });
    const om = oracleDiscount("sale", TA, ...AUG_SEP, (v) => v.date.slice(0, 7));
    check("disc-by-month", "breakdown by month is in date order and equals the oracle", byMonth.rows.map(({ key, ...rest }) => [key, rest]), [...om.by].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    check("disc-limit", "limit is honoured and capped at 50", [(await insights.discountSummary(TA, period(...AUG_SEP), { by: "product", limit: 2 })).rows.length, (await insights.discountSummary(TA, period(...AUG_SEP), { by: "product", limit: 9999 })).rows.length <= 50], [2, true]);
    let threw = null;
    try { await insights.discountSummary(TA, period(...AUG), { by: "galaxy" }); } catch (e) { threw = e.status; }
    check("disc-bad-by", "an unknown breakdown is refused (400)", threw, 400);
    check("disc-empty", "a period with no vouchers is an honest empty result", [(await insights.discountSummary(TA, period("2030-01-01", "2030-01-31"))).hasData, (await insights.discountSummary(TA, period("2030-01-01", "2030-01-31"))).totals.discountAmount], [false, 0]);
    check("disc-disclosure", "the meaning of 'discount' is stated in the result", /list value/.test(d.disclosures[0]), true);

    console.log("\n=== 2. Discount received (purchase) ===");
    const pd = await insights.discountSummary(TA, period(...AUG), { entity: "purchase", by: "supplier" });
    const opd = oracleDiscount("purchase", TA, ...AUG, (v) => v.party);
    check("pdisc-totals", "purchase totals equal the oracle (amounts stored negative are read as positive)", pd.totals, opd.all);
    check("pdisc-hand", "hand check: Alpha from Sup X 18,000 list billed 16,200 = 1,800 discount is the only discount", pd.totals.discountAmount, 1800);
    check("pdisc-by-supplier", "by supplier equals the oracle", pd.rows.map(({ key, ...rest }) => [key, rest]).sort((a, b) => (a[0] < b[0] ? -1 : 1)), [...opd.by].sort((a, b) => (a[0] < b[0] ? -1 : 1)));

    // ---------------------------------------------------------- rates by product
    console.log("\n=== 3. Sale and purchase rate per product ===");
    const rates = await insights.ratesByProduct(TA, period(...AUG), { limit: 20 });
    const orates = oracleRates(TA, ...AUG);
    const strip = (r) => ({ product: r.product, saleQty: r.saleQty, saleRate: r.saleRate, saleListRate: r.saleListRate, purchaseQty: r.purchaseQty, purchaseRate: r.purchaseRate, rateGap: r.rateGap, rateSpread: r.rateSpread });
    check("rates-oracle", "every product's quantities, rates, list rate, gap and spread equal the oracle, in the same order", rates.rows.map(strip), orates);
    const alpha = rates.rows.find((r) => r.product === "Item Alpha");
    check("rates-hand", "hand check Alpha (Aug): sold 540 at 16.94, bought 1,605 at 16.48, gap 0.46; list rate 20.90", [alpha.saleQty, alpha.saleRate, alpha.purchaseQty, alpha.purchaseRate, alpha.rateGap, alpha.saleListRate], [540, 16.94, 1605, 16.48, 0.46, 20.9]);
    check("rates-free-goods", "free goods (billed 0) have no rate and do not appear as a sold product", rates.rows.some((r) => r.product === "Item Gamma"), false);
    check("rates-one-sided", "a product only bought has no sale rate and no gap (null, never 0)", (({ saleRate, rateGap, purchaseRate }) => [saleRate, rateGap, purchaseRate])(rates.rows.find((r) => r.product === "Item Mixed")), [null, null, 19.8]);
    check("rates-unit-warning", "a product whose line rates differ 100x is flagged as a possible mixed-unit product; a normal one is not", [rates.rows.find((r) => r.product === "Item Mixed").unitWarning, alpha.unitWarning], [true, false]);
    check("rates-product-filter", "a product filter is case-insensitive and exact (not a prefix)", [(await insights.ratesByProduct(TA, period(...AUG), { product: "item alpha" })).rows.map((r) => r.product), (await insights.ratesByProduct(TA, period(...AUG), { product: "Item Al" })).rows.length], [["Item Alpha"], 0]);
    check("rates-regex-safe", "regex characters in a product filter are literal", (await insights.ratesByProduct(TA, period(...AUG), { product: ".*" })).rows.length, 0);
    check("rates-tenant", "another tenant's vouchers never count", (await insights.ratesByProduct(TB, period(...AUG))).rows.map((r) => [r.product, r.saleQty, r.purchaseQty]), [["Item Alpha", 10, 10]]);

    // ---------------------------------------------------------- supplier rates
    console.log("\n=== 4. Best purchase rate by supplier ===");
    for (const [label, range] of [["August", AUG], ["Aug-Sep", AUG_SEP]]) {
      const sr = await insights.supplierRates(TA, period(...range), { product: "Item Alpha" });
      const os = oracleSuppliers(TA, "Item Alpha", ...range);
      const row = sr.rows[0];
      check(`sup-${label}-order`, `${label}: suppliers are listed cheapest first`, row.suppliers.map((s) => s.supplier), os.suppliers.map((s) => s.supplier));
      check(`sup-${label}-rates`, `${label}: average, last rate, last date and purchases per supplier equal the oracle`,
        row.suppliers.map((s) => [s.supplier, s.avgRate, s.lastRate, s.lastDate, s.purchases]), os.suppliers.map((s) => [s.supplier, r2(s.avg), r2(s.lastRate), s.lastDate, s.purchases]));
      check(`sup-${label}-best`, `${label}: best supplier and indicative saving equal the oracle (a tiny one-off at a lower rate is not 'best')`, [row.bestSupplier, row.bestRate, row.savingIfAllAtBest], [os.best.supplier, r2(os.best.avg), os.saving]);
    }
    const aug = (await insights.supplierRates(TA, period(...AUG), { product: "Item Alpha" })).rows[0];
    check("sup-hand", "hand check (Aug): Sup X 16.20, Sup Y 17.00 (two purchases; the later date counts as the last), Sup Z 10.00 (0.3% of volume, low volume); best = Sup X; saving if all at best = 480", [aug.bestSupplier, aug.bestRate, aug.savingIfAllAtBest, aug.suppliers.find((s) => s.supplier === "Sup Z").lowVolume, aug.suppliers.find((s) => s.supplier === "Sup X").isBest], ["Sup X", 16.2, 480, true, true]);
    const all = await insights.supplierRates(TA, period(...AUG), { limit: 10 });
    check("sup-last-by-date", "Sup Y's last purchase is 20 Aug even though the 2 Aug one was stored later", (({ lastDate, purchases }) => [lastDate, purchases])(aug.suppliers.find((s) => s.supplier === "Sup Y")), ["2025-08-20", 2]);
    check("sup-products-order", "without a product filter, products come biggest purchase value first", all.rows.map((r) => r.product), ["Item Alpha", "Item Beta", "Item Mixed"]);
    check("sup-mixed-flag", "a mixed-unit product is flagged here too", all.rows.find((r) => r.product === "Item Mixed").unitWarning, true);
    check("sup-tenant", "another tenant's purchases never count", (await insights.supplierRates(TB, period(...AUG))).rows.map((r) => [r.product, r.suppliers.length]), [["Item Alpha", 1]]);
    check("sup-no-sales-leak", "sales vouchers never appear as supplier purchases", all.rows.some((r) => r.suppliers.some((s) => /Cust/.test(s.supplier))), false);

    // ---------------------------------------------------------- indicative margin
    console.log("\n=== 5. Indicative margin per product (average sale rate vs average purchase cost) ===");
    const om5 = oracleMargin(TA, ...JUN26);
    const apiMargin = (r) => [r.product, r.soldQty, r.saleAmount, r.saleRate, r.costRate, r.costSource, r.unitMargin, r.marginPct, r.indicativeProfit, r.belowCost, r.unitWarning];
    const mg = await insights.productMargin(TA, period(...JUN26), { limit: 20 });
    check("mg-oracle", "June 2026: every figure per product (quantity, amounts, rates, cost and its source, margin, %, profit, flags) equals the oracle, biggest profit first", mg.rows.map(apiMargin), oracleMarginOrder(om5, "profit", "desc").map(marginShape));
    check("mg-oracle-aug", "August 2025 (products bought and sold in the same month, and some never bought): equals the oracle too",
      (await insights.productMargin(TA, period(...AUG), { limit: 20 })).rows.map(apiMargin), oracleMarginOrder(oracleMargin(TA, ...AUG), "profit", "desc").map(marginShape));
    const orderOf = async (sortBy, order) => (await insights.productMargin(TA, period(...JUN26), { limit: 20, sortBy, order })).rows.map((r) => r.product);
    check("mg-orders", "profit ascending, margin % descending and ascending all follow the oracle, and the product with no cost is always last",
      [await orderOf("profit", "asc"), await orderOf("marginPct", "desc"), await orderOf("marginPct", "asc")],
      [oracleMarginOrder(om5, "profit", "asc"), oracleMarginOrder(om5, "pct", "desc"), oracleMarginOrder(om5, "pct", "asc")].map((rows) => rows.map((r) => r.product)));
    const by5 = Object.fromEntries(mg.rows.map((r) => [r.product, r]));
    const pick5 = (name) => (({ saleRate, costRate, costSource, unitMargin, marginPct, indicativeProfit }) => [saleRate, costRate, costSource, unitMargin, marginPct, indicativeProfit])(by5[name]);
    check("mg-hand-edge", "hand check Edge: sold at 30; cost (300 + 100) / 20 = 20 from the 12 months before (the purchase one day outside the window is ignored, the first and last day of the window count); margin 10 = 33.33%, profit 50", pick5("Item Edge"), [30, 20, "earlier", 10, 33.33, 50]);
    check("mg-hand-period", "hand check InPeriod: cost 15 is the period's own purchase (an earlier purchase at 5 and a cancelled voucher are ignored); margin 5 = 25%, profit 50", pick5("Item InPeriod"), [20, 15, "period", 5, 25, 50]);
    check("mg-hand-loss", "hand check Loss: sold at 10, bought at 20: margin -10 (-100%), profit -40, flagged below cost", [...pick5("Item Loss"), by5["Item Loss"].belowCost], [10, 20, "period", -10, -100, -40, true]);
    check("mg-hand-nocost", "hand check NoCost: sold but never bought: cost, margin and profit are null (never 0), and it is listed last", [...pick5("Item NoCost"), mg.rows[mg.rows.length - 1].product], [30, null, null, null, null, null, "Item NoCost"]);
    check("mg-hand-unit", "hand check Unit: 1 at 1000 and 100 at 10 under one name = 101 units for 2,000 (19.80), cost 10, profit exactly 990, flagged as possible mixed units; Edge is not flagged", [by5["Item Unit"].saleRate, by5["Item Unit"].indicativeProfit, by5["Item Unit"].unitWarning, by5["Item Edge"].unitWarning], [19.8, 990, true, false]);
    const costedO = om5.filter((r) => r.profit !== null);
    const costedSale = costedO.reduce((s, r) => s + r.saleAmount, 0), costedProfit = costedO.reduce((s, r) => s + r.profit, 0);
    check("mg-summary", "the summary equals the oracle", mg.summary, { products: om5.length, costedProducts: costedO.length, withoutCost: om5.length - costedO.length, belowCost: costedO.filter((r) => r.unitMargin < 0).length, saleAmount: r2(om5.reduce((s, r) => s + r.saleAmount, 0)), costedSaleAmount: r2(costedSale), indicativeProfit: r2(costedProfit), marginPct: r2((costedProfit / costedSale) * 100) });
    check("mg-summary-hand", "hand check: 5 products, 4 with a cost, 1 without, 1 below cost; sales 2,480 (2,390 with a cost); profit 990 + 50 + 50 - 40 = 1,050 = 43.93% of 2,390",
      [mg.summary.products, mg.summary.costedProducts, mg.summary.withoutCost, mg.summary.belowCost, mg.summary.saleAmount, mg.summary.costedSaleAmount, mg.summary.indicativeProfit, mg.summary.marginPct], [5, 4, 1, 1, 2480, 2390, 1050, 43.93]);
    check("mg-free-and-cancelled", "free goods are not a priced product, a cancelled voucher adds nothing (InPeriod sold 10, not 110)", [mg.rows.some((r) => r.product === "Item Free"), by5["Item InPeriod"].soldQty], [false, 10]);
    check("mg-tenant", "another tenant's voucher never counts: B sees only its own 1 unit, and no cost", (await insights.productMargin(TB, period(...JUN26))).rows.map((r) => [r.product, r.soldQty, r.costRate]), [["Item InPeriod", 1, null]]);
    check("mg-limit", "a limit shortens the list but the summary still covers every product", (({ rows, summary }) => [rows.length, summary.products])(await insights.productMargin(TA, period(...JUN26), { limit: 2 })), [2, 5]);
    check("mg-empty", "a period with no sales is an honest empty result", (({ hasData, rows, summary }) => [hasData, rows.length, summary.products, summary.marginPct])(await insights.productMargin(TA, period("2030-01-01", "2030-01-31"))), [false, 0, 0, null]);
    let badSort = null, badOrder = null;
    try { await insights.productMargin(TA, period(...JUN26), { sortBy: "galaxy" }); } catch (e) { badSort = e.status; }
    try { await insights.productMargin(TA, period(...JUN26), { order: "sideways" }); } catch (e) { badOrder = e.status; }
    check("mg-bad-input", "an unknown sort or order is refused (400)", [badSort, badOrder], [400, 400]);
    check("mg-disclosure", "the result says this is not Tally's stock valuation", /NOT Tally's stock valuation/.test(mg.disclosures[0]), true);

    // ---------------------------------------------------------- product trend
    console.log("\n=== 6. Product trend: quantity bought and sold per month ===");
    const tr = await insights.productTrend(TA, period(...Q1_26), { product: "item trend" });
    check("tr-oracle", "every month (quantities, amounts, rates, voucher counts, net movement, running total) equals the oracle; the product match ignores case", tr.rows, oracleTrend(TA, "Item Trend", ...Q1_26));
    check("tr-hand", "hand check: Jan sold 8 (5 priced at 10 + 3 free), bought 20 at 6, net +12; Feb empty (the cancelled voucher is ignored), running 12; Mar sold 4 at 12, bought 10 at 8, net +6, running 18",
      tr.rows.map((r) => [r.month, r.saleQty, r.saleRate, r.purchaseQty, r.purchaseRate, r.netQty, r.cumulativeNetQty]), [["2026-01", 8, 10, 20, 6, 12, 12], ["2026-02", 0, null, 0, null, 0, 12], ["2026-03", 4, 12, 10, 8, 6, 18]]);
    check("tr-totals", "totals: sold 12 for 98 (10.89 on the 9 priced units), bought 30 for 200 (6.67), net 18", tr.totals, { saleQty: 12, saleAmount: 98, saleRate: 10.89, purchaseQty: 30, purchaseAmount: 200, purchaseRate: 6.67, netQty: 18 });
    check("tr-name", "the product is shown as stored, not as typed", tr.product, "Item Trend");
    const trPart = await insights.productTrend(TA, period("2026-01-15", "2026-03-31"), { product: "Item Trend" });
    check("tr-partial", "a period starting 15 Jan leaves out the 10 Jan sale and the 2 Jan purchase: January is only the 3 free units (net -3), running total 3 after March",
      trPart.rows.map((r) => [r.month, r.saleQty, r.saleAmount, r.saleRate, r.purchaseQty, r.netQty, r.cumulativeNetQty]), [["2026-01", 3, 0, null, 0, -3, -3], ["2026-02", 0, 0, null, 0, 0, -3], ["2026-03", 4, 48, 12, 10, 6, 3]]);
    check("tr-oracle-aug", "a product bought and sold across August and September equals the oracle", (await insights.productTrend(TA, period(...AUG_SEP), { product: "Item Alpha" })).rows, oracleTrend(TA, "Item Alpha", ...AUG_SEP));
    check("tr-tenant", "another tenant's voucher never counts: B sees only its own 7 units in February", (await insights.productTrend(TB, period(...Q1_26), { product: "Item Trend" })).rows.map((r) => [r.month, r.saleQty, r.purchaseQty]), [["2026-02", 7, 0]]);
    check("tr-empty", "a period with no movement is an honest empty result", (({ hasData, rows, totals }) => [hasData, rows.length, totals.netQty])(await insights.productTrend(TA, period("2026-02-01", "2026-02-28"), { product: "Item Trend" })), [false, 0, 0]);
    check("tr-regex-safe", "regex characters in the product are literal", (await insights.productTrend(TA, period(...Q1_26), { product: ".*" })).hasData, false);
    let noProduct = null, blankProduct = null;
    try { await insights.productTrend(TA, period(...Q1_26), {}); } catch (e) { noProduct = e.status; }
    try { await insights.productTrend(TA, period(...Q1_26), { product: "  " }); } catch (e) { blankProduct = e.status; }
    check("tr-requires-product", "a missing or blank product is refused (400)", [noProduct, blankProduct], [400, 400]);
    check("tr-disclosure", "the result says this is a movement, not a stock balance", /not a stock balance/.test(tr.disclosures[0]), true);

    // ---------------------------------------------------------- supplier margin
    console.log("\n=== 7. Margin per supplier (indicative) ===");
    const supAll = await insights.supplierRates(TA, period(...AUG), { limit: 10 });
    const alphaRow = supAll.rows.find((r) => r.product === "Item Alpha");
    const alphaSale = oracleSaleRate(TA, "Item Alpha", ...AUG), alphaSup = oracleSuppliers(TA, "Item Alpha", ...AUG);
    const marginOf = (rate) => r2(alphaSale - rate), pctOf = (rate) => r2(((alphaSale - rate) / alphaSale) * 100);
    check("supm-oracle", "each supplier's margin per unit and % equal the oracle (average sale rate minus that supplier's average rate)", alphaRow.suppliers.map((s) => [s.supplier, s.unitMargin, s.marginPct]), alphaSup.suppliers.map((s) => [s.supplier, marginOf(s.avg), pctOf(s.avg)]));
    check("supm-row", "the row carries the average sale rate and the margin at the best supplier", [alphaRow.saleRate, alphaRow.bestUnitMargin, alphaRow.bestMarginPct], [r2(alphaSale), marginOf(alphaSup.best.avg), pctOf(alphaSup.best.avg)]);
    const supBy = Object.fromEntries(alphaRow.suppliers.map((s) => [s.supplier, [s.unitMargin, s.marginPct]]));
    check("supm-hand", "hand check: Alpha sold at 16.94; Sup X at 16.20 leaves 0.74 (4.35%), Sup Y at 17.00 loses 0.06 (-0.37%), Sup Z at 10.00 would leave 6.94 (40.96%)", [alphaRow.saleRate, supBy["Sup X"], supBy["Sup Y"], supBy["Sup Z"]], [16.94, [0.74, 4.35], [-0.06, -0.37], [6.94, 40.96]]);
    check("supm-all-products", "every product's sale rate equals the oracle, and a product not sold in the period has no sale rate or margin (null, never 0)",
      supAll.rows.map((r) => [r.product, r.saleRate, r.suppliers.map((s) => s.unitMargin)]),
      supAll.rows.map((r) => { const sr = oracleSaleRate(TA, r.product, ...AUG); return [r.product, sr === null ? null : r2(sr), r.suppliers.map((s) => (sr === null ? null : r2(sr - s.avgRate)))]; }));
    check("supm-unsold", "Item Mixed is bought but not sold in August", (({ saleRate, bestUnitMargin, bestMarginPct }) => [saleRate, bestUnitMargin, bestMarginPct])(supAll.rows.find((r) => r.product === "Item Mixed")), [null, null, null]);
    check("supm-disclosure", "the result says the margin is indicative", /Indicative/.test(supAll.disclosures[1]), true);

    // ---------------------------------------------------------- REST handlers
    console.log("\n=== 8. REST handlers: validation and the trust envelope ===");
    const call = async (handler, tenantId, query) => {
      const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      await handler({ companyContext: { tenantId }, query }, res);
      return res;
    };
    const ok = await call(controller.getDiscountSummary, TA, { period: "custom", from: AUG[0], to: AUG[1], by: "customer", limit: "5" });
    check("rest-discounts", "GET discounts: 200, state valid_data, the same numbers as the function", [ok.code, ok.body.success, ok.body.state, ok.body.data.totals.discountAmount, ok.body.data.rows.length], [200, true, "valid_data", 2400.16, 2]);
    check("rest-freshness", "the freshness block is present", typeof ok.body.freshness.state, "string");
    check("rest-bad-by", "an invalid breakdown for the entity is a 400 (supplier is not a sales breakdown)", (await call(controller.getDiscountSummary, TA, { period: "custom", from: AUG[0], to: AUG[1], by: "supplier" })).code, 400);
    check("rest-bad-limit", "an invalid limit is a 400", (await call(controller.getDiscountSummary, TA, { period: "custom", from: AUG[0], to: AUG[1], limit: "999" })).code, 400);
    check("rest-bad-period", "custom without from/to is a 400", (await call(controller.getProductRates, TA, { period: "custom" })).code, 400);
    const rr = await call(controller.getProductRates, TA, { period: "custom", from: AUG[0], to: AUG[1], limit: "3" });
    check("rest-rates", "GET product rates: 200 and at most the requested rows", [rr.code, rr.body.data.rows.length], [200, 3]);
    const sr = await call(controller.getSupplierRates, TA, { period: "custom", from: AUG[0], to: AUG[1], product: "Item Alpha" });
    check("rest-supplier-rates", "GET supplier rates for a product: best supplier named", [sr.code, sr.body.data.rows[0].bestSupplier], [200, "Sup X"]);
    const pr = await call(controller.getDiscountSummary, TA, { entity: "purchase", period: "custom", from: AUG[0], to: AUG[1], by: "supplier" });
    check("rest-purchase-discounts", "entity=purchase reads purchases", pr.body.data.totals.discountAmount, 1800);
    const other = await call(controller.getDiscountSummary, TB, { period: "custom", from: AUG[0], to: AUG[1] });
    check("rest-tenant-scope", "the tenant comes only from the company context: tenant B sees only its own numbers", other.body.data.totals.discountAmount, 500);
    const mgRest = await call(controller.getProductMargin, TA, { period: "custom", from: JUN26[0], to: JUN26[1], sortBy: "marginPct", order: "asc", limit: "2" });
    check("rest-margin", "GET product margin: 200 through the trust envelope, sorted by margin % ascending and limited to 2 (the summary still covers all 5 products)", [mgRest.code, mgRest.body.state, mgRest.body.data.rows.map((r) => r.product), mgRest.body.data.summary.products], [200, "valid_data", ["Item Loss", "Item InPeriod"], 5]);
    check("rest-margin-bad-input", "an unknown sortBy, an unknown order or a bad limit is a 400", [
      (await call(controller.getProductMargin, TA, { period: "custom", from: JUN26[0], to: JUN26[1], sortBy: "galaxy" })).code,
      (await call(controller.getProductMargin, TA, { period: "custom", from: JUN26[0], to: JUN26[1], order: "sideways" })).code,
      (await call(controller.getProductMargin, TA, { period: "custom", from: JUN26[0], to: JUN26[1], limit: "999" })).code,
    ], [400, 400, 400]);
    const trRest = await call(controller.getProductTrend, TA, { product: "Item Trend", from: Q1_26[0], to: Q1_26[1] });
    check("rest-trend", "GET product trend: 200 and the three months, the same numbers as the function", [trRest.code, trRest.body.state, trRest.body.data.rows.map((r) => r.month), trRest.body.data.totals.netQty], [200, "valid_data", ["2026-01", "2026-02", "2026-03"], 18]);
    check("rest-trend-needs-product", "a missing or blank product is a 400", [(await call(controller.getProductTrend, TA, { from: Q1_26[0], to: Q1_26[1] })).code, (await call(controller.getProductTrend, TA, { product: "   ", from: Q1_26[0], to: Q1_26[1] })).code], [400, 400]);
    check("rest-trend-tenant-scope", "the tenant comes only from the company context: B sees only its own 7 units", (await call(controller.getProductTrend, TB, { product: "Item Trend", from: Q1_26[0], to: Q1_26[1] })).body.data.totals.saleQty, 7);
    const spm = await call(controller.getSupplierRates, TA, { period: "custom", from: AUG[0], to: AUG[1], product: "Item Alpha" });
    check("rest-supplier-margin", "GET supplier rates now also returns the sale rate and each supplier's margin", [spm.body.data.rows[0].saleRate, spm.body.data.rows[0].suppliers.find((s) => s.supplier === "Sup X").unitMargin], [16.94, 0.74]);
  } finally {
    await cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { await cleanup(); await mongoose.disconnect(); } catch { /* best-effort */ }
  process.exit(1);
});
