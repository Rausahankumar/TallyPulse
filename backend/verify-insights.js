/**
 * Insights (services/analytics/insights.js): discount, product rates and supplier rates, and their REST handlers.
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

const period = (from, to) => ({ from: new Date(`${from}T00:00:00`), to: new Date(`${to}T00:00:00`), label: `${from}..${to}` }); // local calendar days, as the period engine produces them
const AUG = ["2025-08-01", "2025-08-31"], AUG_SEP = ["2025-08-01", "2025-09-30"];

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

    // ---------------------------------------------------------- REST handlers
    console.log("\n=== 5. REST handlers: validation and the trust envelope ===");
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
