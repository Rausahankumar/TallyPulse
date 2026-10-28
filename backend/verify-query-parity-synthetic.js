"use strict";

/**
 * The PARITY SUITE (verify-query-parity.js) on synthetic data, so it runs in CI.
 *
 * verify-query-parity.js compares the generic Query Engine with the existing analytics (salesAnalytics,
 * purchaseAnalytics, stockGroupAnalytics) and with independently written JS oracles. Its comparisons are data-driven
 * (customer/product names, periods and rankings all come from the tenant's own vouchers), but its real-data run needs
 * the WE FOUR tenant, so it is NOT RUN in CI. This suite seeds two synthetic tenants into the isolated test database
 * and runs the SAME runParity() - every parity, ranking and assertion case unchanged - on them:
 *   - a large tenant (extended run): 140 Sales + 90 Purchase vouchers over Apr-Oct 2025, mapped and unmapped items,
 *     ~4% cancelled vouchers (must be excluded), purchase item amounts stored negative (Tally's sign), and four vouchers
 *     on the edges of the fixed August-2025 window (31 Jul, 1 Aug, 31 Aug, 1 Sep);
 *   - a small tenant whose customer names never overlap (cross-tenant isolation cases).
 * A third, hand-built tenant pins product VALUE across the three paths that compute it - the engine (`lineAmount`), the
 * REST top-products and the insights (ratesByProduct / productMargin) - including an opposite-sign line on each side and
 * an ambiguous line. It documents CURRENT behaviour: insights sum |amount| where the engine and REST net the sign, and
 * leave ambiguous lines out of the sale value (disclosed as uncertain). Changing either is a deliberate semantic change.
 * The reference date is the tenant's latest voucher, so the relative periods are deterministic.
 *
 * What this does NOT prove: that the engine matches real WE FOUR data shapes. The real-data run of
 * verify-query-parity.js stays as it is, for local runs against real data.
 *
 * Synthetic data only, isolated test database only (src/config/db.js refuses anything but a loopback
 * tallypulse_ci / tallypulse_test* database). No Tally, no Claude. Cleans up only its own records.
 *
 * Run: node verify-query-parity-synthetic.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const StockItemMaster = require("./src/models/stockItemMaster.model");
const Company = require("./src/models/company");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const { runParity } = require("./verify-query-parity");
const { executeQuery } = require("./src/services/query/execute");
const salesAnalytics = require("./src/services/analytics/salesAnalytics");
const purchaseAnalytics = require("./src/services/analytics/purchaseAnalytics");
const insights = require("./src/services/analytics/insights");

let fail = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  PASS - ${label}`);
  else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 300)})` : ""}`);
  }
}

const BIG = { name: "Synthetic Parity Big Co", tenantId: "TEST-TENANT-parity-synthetic-big", guid: "verify-parity-synthetic-big", sales: 140, purchases: 90, suffix: "" };
const SMALL = { name: "Synthetic Parity Small Co", tenantId: "TEST-TENANT-parity-synthetic-small", guid: "verify-parity-synthetic-small", sales: 25, purchases: 15, suffix: " (Small Co)" };
const TENANTS = [BIG, SMALL];
const INSIGHTS_TENANT = "TEST-TENANT-parity-synthetic-insights";

// Deterministic pseudo-random sequence: the same fixture on every run.
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const addDays = (date, n) => new Date(date.getTime() + n * 86400000);

const ITEMS = ["Alpha Widget", "Beta Widget", "Gamma Cable", "Delta Cable", "Epsilon Box", "Zeta Box", "Eta Pipe", "Theta Pipe", "Iota Gear", "Kappa Gear", "Lambda Tape", "Mu Tape", "Nu Paint", "Xi Paint", "Unmapped Item One", "Unmapped Item Two"];
// The last two items have no stock group (unmapped lines are excluded from group breakdowns and disclosed).
const GROUPS = { "Alpha Widget": "Widgets", "Beta Widget": "Widgets", "Gamma Cable": "Cables", "Delta Cable": "Cables", "Epsilon Box": "Boxes", "Zeta Box": "Boxes", "Eta Pipe": "Pipes", "Theta Pipe": "Pipes", "Iota Gear": "Gears", "Kappa Gear": "Gears", "Lambda Tape": "Tapes", "Mu Tape": "Tapes", "Nu Paint": "Paints", "Xi Paint": "Paints" };
const CUSTOMERS = ["Synthetic Customer A", "Synthetic Customer B", "Synthetic Customer C", "Synthetic Customer D", "Synthetic Customer E", "Synthetic Customer F", "Synthetic Customer G"];
const SUPPLIERS = ["Synthetic Supplier P", "Synthetic Supplier Q", "Synthetic Supplier R", "Synthetic Supplier S"];

let guidSeq = 0;
function voucher(tenantId, kind, date, suffix, status) {
  guidSeq += 1;
  const lines = [];
  const n = 1 + Math.floor(rnd() * 3);
  let sum = 0;
  for (let l = 0; l < n; l += 1) {
    const qty = 1 + Math.floor(rnd() * 40);
    const rate = 10 + Math.floor(rnd() * 90);
    const amt = qty * rate;
    sum += amt;
    lines.push({ itemName: pick(ITEMS), quantity: qty, rate, amount: kind === "purchase" ? -amt : amt });
  }
  return {
    tenantId,
    tallyGuid: `syn-${tenantId}-${kind}-${guidSeq}`,
    tallyAlterId: guidSeq,
    voucherStatus: status || (rnd() < 0.04 ? "cancelled" : "active"),
    header: {
      voucherNo: `${kind === "purchase" ? "P" : "S"}-${guidSeq}`,
      voucherDate: date,
      voucherType: kind === "purchase" ? "Purchase" : "Invoice",
      voucherTotalAmount: Math.round(sum * 1.18 * 100) / 100,
      narration: "",
      partyName: pick(kind === "purchase" ? SUPPLIERS : CUSTOMERS) + suffix,
    },
    inventory: lines,
    ledgers: [],
  };
}

function vouchers(t, kind, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(voucher(t.tenantId, kind, addDays(utc(2025, 3, 1), Math.floor(rnd() * 200)), t.suffix));
  return out;
}

// Active vouchers exactly on and just outside the edges of the fixed custom_aug_2025 window (2025-08-01 .. 2025-08-31).
const BOUNDARY_DAYS = [utc(2025, 6, 31), utc(2025, 7, 1), utc(2025, 7, 31), utc(2025, 8, 1)];

// Engine vs REST vs insights on hand-built lines (October 2025). P1 has an opposite-sign line on each side (a negative
// Sales line, a positive Purchase line), P2 an ambiguous Sales line (billed below quantity x rate, no discount recorded),
// P3 is clean. Pins the CURRENT behaviour of each path, see the header.
async function insightsParity() {
  const T = INSIGHTS_TENANT;
  const OCT = { from: new Date(2025, 9, 1), to: new Date(2025, 9, 31), label: "Oct 2025" };
  const line = (itemName, quantity, rate, amount) => ({ itemName, quantity, rate, amount, discountPercentage: 0, discountAmount: 0 });
  let n = 0;
  const v = (type, party, lines) => ({
    tenantId: T, voucherStatus: "active", tallyGuid: `syn-ins-${++n}`, tallyAlterId: n, ledgers: [], inventory: lines,
    header: { voucherNo: `INS-${n}`, voucherDate: utc(2025, 9, 10), voucherType: type, partyName: party, voucherTotalAmount: Math.abs(lines.reduce((s, l) => s + l.amount, 0)) },
  });
  await Sale.insertMany([
    v("Sales", "Synthetic Insight Customer A", [line("P1", 10, 100, 1000), line("P3", 3, 100, 300)]),
    v("Sales", "Synthetic Insight Customer B", [line("P1", 2, 100, -200)]), // opposite sign on the Sales side
    v("Sales", "Synthetic Insight Customer C", [line("P2", 10, 100, 500)]), // ambiguous: 10 x 100 billed 500, no discount
  ]);
  await Purchase.insertMany([
    v("Purchase", "Synthetic Insight Supplier X", [line("P1", 20, 50, -1000), line("P2", 10, 40, -400), line("P3", 3, 40, -120)]),
    v("Purchase", "Synthetic Insight Supplier Y", [line("P1", 6, 50, 300)]), // opposite sign on the Purchase side
  ]);

  const plan = (entity) => ({ v: 1, entity, mode: "aggregate", period: { kind: "custom", from: "2025-10-01", to: "2025-10-31" }, metrics: ["lineAmount"], groupBy: [{ dim: "product" }], filters: [], sort: [{ by: "lineAmount", dir: "desc" }], limit: 10 });
  const engine = async (entity) => Object.fromEntries((await executeQuery(plan(entity), { tenantId: T, referenceDate: new Date(2025, 10, 15) })).rows.map((r) => [r.key.product, r.values.lineAmount]));
  const byItem = (res) => Object.fromEntries(res.items.map((p) => [p.itemName, p.totalAmount]));
  const engSale = await engine("sales"), engBuy = await engine("purchase");
  const restSale = byItem(await salesAnalytics.getTopProducts(T, OCT, { limit: 10 }));
  const restBuy = byItem(await purchaseAnalytics.getTopPurchasedProducts(T, OCT, { limit: 10 }));
  const rates = await insights.ratesByProduct(T, OCT, { limit: 10 });
  const margin = await insights.productMargin(T, OCT, { limit: 10 });
  const rateRow = Object.fromEntries(rates.rows.map((r) => [r.product, r]));
  const marginRow = Object.fromEntries(margin.rows.map((r) => [r.product, r]));
  const show = (x) => JSON.stringify(x);

  check("engine and REST agree on product sales value, sign netted (P1 1000 - 200 = 800, P2 500, P3 300)", show(engSale) === show({ P1: 800, P2: 500, P3: 300 }) && show(restSale) === show(engSale), `engine ${show(engSale)} rest ${show(restSale)}`);
  check("engine and REST agree on product purchase value, sign netted (P1 1000 - 300 = 700, P2 400, P3 120)", show(engBuy) === show({ P1: 700, P2: 400, P3: 120 }) && show(restBuy) === show(engBuy), `engine ${show(engBuy)} rest ${show(restBuy)}`);
  const p3 = marginRow.P3, p3r = rateRow.P3;
  check("clean product: insights sale value, sale rate and cost basis match the engine (P3: 300, 100, 3 x 40 = 120)", p3 && p3.saleAmount === engSale.P3 && p3.saleRate === 100 && p3.costRate === 40 && p3r && p3r.purchaseRate * p3r.purchaseQty === engBuy.P3, show({ p3, p3r }));
  check("CURRENT: opposite-sign Sales line - insights margin sums |amount| (P1 sale value 1200 over 12 units) where the engine nets 800", marginRow.P1 && marginRow.P1.saleAmount === 1200 && marginRow.P1.soldQty === 12 && engSale.P1 === 800, show(marginRow.P1));
  check("CURRENT: opposite-sign Purchase line - insights cost basis sums |amount| (P1 26 units x 50 = 1300) where the engine nets 700", rateRow.P1 && rateRow.P1.purchaseQty === 26 && rateRow.P1.purchaseRate === 50 && engBuy.P1 === 700, show(rateRow.P1));
  check("ambiguous Sales line: counted by the engine (P2 500), left out of the insights sale value and rate, disclosed as uncertain", engSale.P2 === 500 && !marginRow.P2 && rateRow.P2 && rateRow.P2.saleRate === null && margin.summary.uncertain.saleLines === 1 && margin.summary.uncertain.saleValue === 500, show({ p2: rateRow.P2, uncertain: margin.summary.uncertain }));
  // engine total = insights sale value + uncertain value - twice each opposite-sign Sales line (counted + instead of -)
  const engTotal = Object.values(engSale).reduce((a, b) => a + b, 0);
  check("the difference reconciles exactly: engine 1600 = insights 1500 + uncertain 500 - 2 x 200 (the opposite-sign line)", engTotal === 1600 && margin.summary.saleAmount + margin.summary.uncertain.saleValue - 2 * 200 === engTotal, `engine ${engTotal}, insights ${margin.summary.saleAmount}, uncertain ${margin.summary.uncertain.saleValue}`);
}

async function cleanup() {
  const tenantIds = [...TENANTS.map((t) => t.tenantId), INSIGHTS_TENANT];
  await Promise.all([
    Sale.deleteMany({ tenantId: { $in: tenantIds } }),
    Purchase.deleteMany({ tenantId: { $in: tenantIds } }),
    StockItemMaster.deleteMany({ tenantId: { $in: tenantIds } }),
    SyncCheckpoint.deleteMany({ tenantId: { $in: tenantIds } }),
  ]);
  await Company.deleteMany({ companyGuid: { $in: TENANTS.map((t) => t.guid) } });
}

async function seedTenant(t, extraSales = []) {
  await Company.create({ companyName: t.name, sourceType: "tally", companyGuid: t.guid, tenantId: t.tenantId, isActive: true });
  for (const voucherType of ["Sales", "Purchase", "Credit Note", "Debit Note"]) {
    await SyncCheckpoint.create({ tenantId: t.tenantId, companyGuid: t.guid, voucherType, lastAlterId: 1000, lastSyncedAt: new Date(), lastRunStatus: "success" });
  }
  await StockItemMaster.insertMany(Object.entries(GROUPS).map(([itemName, stockGroupName]) => ({ tenantId: t.tenantId, itemName, stockGroupName, tallyGuid: `syn-m-${t.tenantId}-${itemName}`, syncedAt: new Date() })));
  await Sale.insertMany([...vouchers(t, "sales", t.sales), ...extraSales]);
  await Purchase.insertMany(vouchers(t, "purchase", t.purchases));
}

(async () => {
  await connectDB();
  await cleanup();
  let parityFailures = 1;
  try {
    console.log("\n=== Seeding two synthetic tenants ===");
    await seedTenant(BIG, BOUNDARY_DAYS.map((d) => voucher(BIG.tenantId, "sales", d, BIG.suffix, "active")));
    await seedTenant(SMALL);

    const count = async (Model, t, extra = {}) => Model.countDocuments({ tenantId: t.tenantId, ...extra });
    check("large tenant: 144 Sales (140 + 4 boundary) and 90 Purchase vouchers seeded", (await count(Sale, BIG)) === 144 && (await count(Purchase, BIG)) === 90);
    check("small tenant: 25 Sales and 15 Purchase vouchers seeded", (await count(Sale, SMALL)) === 25 && (await count(Purchase, SMALL)) === 15);
    check("the fixture contains cancelled vouchers (active-only scope is exercised)", (await count(Sale, BIG, { voucherStatus: "cancelled" })) > 0);
    check("purchase item amounts are stored negative, as Tally sends them", (await Purchase.countDocuments({ tenantId: BIG.tenantId, "inventory.amount": { $gt: 0 } })) === 0);
    const perBoundaryDay = await Promise.all(BOUNDARY_DAYS.map((d) => Sale.countDocuments({ tenantId: BIG.tenantId, voucherStatus: "active", "header.voucherDate": d })));
    check("every August-window boundary day (31 Jul, 1 Aug, 31 Aug, 1 Sep) has an active Sales voucher", perBoundaryDay.every((n) => n >= 1), JSON.stringify(perBoundaryDay));
    const bigNames = new Set(await Sale.distinct("header.partyName", { tenantId: BIG.tenantId }));
    const smallNames = await Sale.distinct("header.partyName", { tenantId: SMALL.tenantId });
    check("the two tenants share no customer name (precondition of the cross-tenant cases)", smallNames.length > 0 && smallNames.every((n) => !bigNames.has(n)));

    console.log("\n=== Parity suite on the synthetic tenants (same cases as verify-query-parity.js) ===");
    parityFailures = await runParity({
      big: { tenantId: BIG.tenantId, name: BIG.name },
      other: { tenantId: SMALL.tenantId, name: SMALL.name },
    });
    check("the parity suite reports zero failed cases on the synthetic tenants", parityFailures === 0, `${parityFailures} failed`);

    console.log("\n=== Product value: engine vs REST vs insights (opposite-sign and ambiguous lines) ===");
    await insightsParity();
  } catch (e) {
    fail += 1;
    console.log(`  FAIL - unexpected error: ${e && e.stack ? e.stack : e}`);
  } finally {
    await cleanup();
    await mongoose.connection.close();
  }
  console.log(`\nverify-query-parity-synthetic: ${fail === 0 ? "all checks passed" : `${fail} failed`}`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});
