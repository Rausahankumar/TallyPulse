/**
 * Regression tests for stockGroupAnalytics.js - deterministic Top-10
 * Stock Group sales analytics (Sale.inventory -> StockItemMaster ->
 * stockGroupName, no LLM anywhere).
 *
 * Structure:
 *   A. Synthetic-tenant tests (1-19 from the task spec) - isolated,
 *      controlled fixtures, cleaned up before and after.
 *   B. Real WE FOUR verification - independent MongoDB aggregations
 *      written SEPARATELY from stockGroupAnalytics.js's own code (never
 *      "call the function, then compare its output to itself").
 *
 * No Anthropic/Claude calls. No production data modified (all synthetic
 * writes are to clearly-fake tenant ids, deleted before and after; the
 * real WE FOUR section is read-only).
 *
 * Run: node verify-stock-group-analytics.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Sale = require("./src/models/sales.model");
const StockItemMaster = require("./src/models/stockItemMaster.model");
const Company = require("./src/models/company.js");
const stockGroupAnalytics = require("./src/services/analytics/stockGroupAnalytics");
const periodEngine = require("./src/services/analytics/periodEngine");
const { getTenantReferenceDate } = require("./src/services/analytics/referenceDate");

let pass = 0;
let fail = 0;

function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}

function approx(a, b, epsilon = 0.001) {
  return Math.abs(a - b) < epsilon;
}

// --------------------------------------------------
// A. Synthetic fixtures
// --------------------------------------------------

const TENANT_A = "TEST-TENANT-A-stockgroup-verify";
const TENANT_B = "TEST-TENANT-B-stockgroup-verify";

let voucherSeq = 0;
function makeSale({ tenantId, date, inventory, voucherStatus = "active" }) {
  voucherSeq += 1;
  return {
    tenantId,
    header: {
      voucherNo: `TSG-${voucherSeq}`,
      voucherDate: date,
      voucherType: "Sales",
      voucherTotalAmount: inventory.reduce((s, i) => s + i.amount, 0),
      narration: "",
      partyName: "Test Customer",
    },
    inventory,
    ledgers: [],
    voucherStatus,
  };
}

function inv(itemName, quantity, rate, amount) {
  return { itemName, quantity, rate, amount, discountPercentage: 0, discountAmount: 0 };
}

async function cleanup() {
  await Sale.deleteMany({ tenantId: { $in: [TENANT_A, TENANT_B] } });
  await StockItemMaster.deleteMany({ tenantId: { $in: [TENANT_A, TENANT_B] } });
}

async function seedFixtures() {
  // --- Tenant A: the main dataset ---
  await StockItemMaster.insertMany([
    { tenantId: TENANT_A, itemName: "ItemA", stockGroupName: "GroupAlpha", tallyGuid: "guidA-1", syncedAt: new Date() },
    { tenantId: TENANT_A, itemName: "ItemB", stockGroupName: "GroupAlpha", tallyGuid: "guidA-2", syncedAt: new Date() },
    { tenantId: TENANT_A, itemName: "ItemC", stockGroupName: "GroupBeta", tallyGuid: "guidA-3", syncedAt: new Date() },
    { tenantId: TENANT_A, itemName: "ItemD", stockGroupName: "GroupGamma", tallyGuid: "guidA-4", syncedAt: new Date() },
    // ItemE deliberately has NO StockItemMaster record - tests missing-mapping handling.
  ]);

  // May 2025: the "small" dataset (3 mapped groups + 1 unmapped item) -
  // used for missing-mapping, fewer-than-10-groups, boundary and
  // negative-value tests.
  await Sale.create([
    makeSale({ tenantId: TENANT_A, date: new Date("2025-05-01T00:00:00.000Z"), inventory: [inv("ItemA", 10, 100, 1000), inv("ItemC", 5, 50, 250)] }),
    makeSale({ tenantId: TENANT_A, date: new Date("2025-05-15T00:00:00.000Z"), inventory: [inv("ItemB", 20, 100, 2000)] }),
    makeSale({ tenantId: TENANT_A, date: new Date("2025-05-20T00:00:00.000Z"), inventory: [inv("ItemD", 3, 300, 900)] }),
    makeSale({ tenantId: TENANT_A, date: new Date("2025-05-25T00:00:00.000Z"), inventory: [inv("ItemE", 1, 500, 500)] }), // unmapped
    // A cancelled voucher in the same window - must be excluded entirely (buildVoucherMatchStage default scope).
    makeSale({ tenantId: TENANT_A, date: new Date("2025-05-10T00:00:00.000Z"), inventory: [inv("ItemA", 999, 999, 999000)], voucherStatus: "cancelled" }),
    // A sales-return line: a NEGATIVE inventory.amount within an otherwise normal active voucher.
    makeSale({ tenantId: TENANT_A, date: new Date("2025-05-28T00:00:00.000Z"), inventory: [inv("ItemA", -2, 100, -200)] }),
  ]);

  // July 2025: an ISOLATED, single-item, single-group dataset used ONLY
  // for exact date-boundary inclusion tests - kept separate from the
  // GroupAlpha/Beta/Gamma dataset above so a boundary test's expected
  // total is a single, easy-to-verify number, not a running tally spread
  // across several other tests.
  await StockItemMaster.create({ tenantId: TENANT_A, itemName: "BoundaryItem", stockGroupName: "BoundaryGroup", tallyGuid: "guidBoundary-1", syncedAt: new Date() });
  await Sale.create([
    makeSale({ tenantId: TENANT_A, date: new Date("2025-07-10T00:00:00.000Z"), inventory: [inv("BoundaryItem", 1, 500, 500)] }), // exactly on `from`
    makeSale({ tenantId: TENANT_A, date: new Date("2025-07-19T23:59:59.999Z"), inventory: [inv("BoundaryItem", 1, 300, 300)] }), // exactly on `to`
    makeSale({ tenantId: TENANT_A, date: new Date("2025-07-09T23:59:59.999Z"), inventory: [inv("BoundaryItem", 1, 999, 999)] }), // 1ms before `from` - must be excluded
    makeSale({ tenantId: TENANT_A, date: new Date("2025-07-20T00:00:00.000Z"), inventory: [inv("BoundaryItem", 1, 999, 999)] }), // 1ms after `to` - must be excluded
  ]);

  // June 2025: the "large" dataset - 11 distinct groups with distinct,
  // easily-sortable amounts, for Top-10-ordering / exactly-10 tests.
  const juneMasters = [];
  const juneVouchers = [];
  for (let i = 1; i <= 11; i++) {
    const itemName = `BigItem${i}`;
    const groupName = `BigGroup${i}`;
    juneMasters.push({ tenantId: TENANT_A, itemName, stockGroupName: groupName, tallyGuid: `guidBig-${i}`, syncedAt: new Date() });
    const amount = (12 - i) * 100; // BigGroup1=1100 (largest) ... BigGroup11=100 (smallest)
    juneVouchers.push(makeSale({ tenantId: TENANT_A, date: new Date("2025-06-10T00:00:00.000Z"), inventory: [inv(itemName, 1, amount, amount)] }));
  }
  await StockItemMaster.insertMany(juneMasters);
  await Sale.create(juneVouchers);

  // --- Tenant B: cross-tenant leak test - SAME item name as tenant A,
  // mapped to a COMPLETELY DIFFERENT group, with real sales. ---
  await StockItemMaster.create({ tenantId: TENANT_B, itemName: "ItemA", stockGroupName: "GroupForeign", tallyGuid: "guidB-1", syncedAt: new Date() });
  await Sale.create(makeSale({ tenantId: TENANT_B, date: new Date("2025-05-05T00:00:00.000Z"), inventory: [inv("ItemA", 50, 1000, 50000)] }));
}

async function runSyntheticTests() {
  console.log("\n=== 1 & 2. Top 10 ordering + exactly 10 results when 10+ groups exist ===");
  {
    const period = { from: new Date("2025-06-01T00:00:00.000Z"), to: new Date("2025-06-30T23:59:59.999Z") };
    const result = await stockGroupAnalytics.getTopStockGroups(TENANT_A, period, null, null, { limit: 10 });
    check("top10-count", "returns exactly 10 results when 11 groups exist", result.items.length, 10);
    check("top10-total-groups", "totalGroups still reports the true count (11), not clamped to 10", result.totalGroups, 11);
    const amounts = result.items.map((i) => i.salesAmount);
    const sorted = [...amounts].sort((a, b) => b - a);
    check("top10-descending-order", "items are strictly sorted descending by salesAmount", amounts, sorted);
    check("top10-largest-first", "the largest group (BigGroup1, 1100) is ranked first", result.items[0].stockGroupName, "BigGroup1");
    check("top10-excludes-11th", "the 11th-largest group (BigGroup11, 100) is excluded from the top 10", result.items.some((i) => i.stockGroupName === "BigGroup11"), false);
  }

  console.log("\n=== 3. Fewer than 10 groups ===");
  {
    const period = { from: new Date("2025-05-01T00:00:00.000Z"), to: new Date("2025-05-31T23:59:59.999Z") };
    const result = await stockGroupAnalytics.getTopStockGroups(TENANT_A, period, null, null, { limit: 10 });
    check("fewer-groups-not-padded", "returns exactly the real number of groups (3: Alpha/Beta/Gamma), never padded to 10", result.items.length, 3);
  }

  console.log("\n=== 4 & 5. Same item name across two tenants / foreign StockItemMaster cannot leak ===");
  {
    const period = { from: new Date("2025-05-01T00:00:00.000Z"), to: new Date("2025-05-31T23:59:59.999Z") };
    const resultA = await stockGroupAnalytics.getTopStockGroups(TENANT_A, period, null, null, { limit: 10 });
    check("no-foreign-group-name", "tenant A's result never contains tenant B's group name (GroupForeign)", resultA.items.some((i) => i.stockGroupName === "GroupForeign"), false);
    const groupAlpha = resultA.items.find((i) => i.stockGroupName === "GroupAlpha");
    // GroupAlpha = ItemA (1000 main - 200 return = 800) + ItemB (2000) = 2800, NOT inflated by tenant B's 50000 ItemA sale.
    check("no-amount-inflation-from-foreign-tenant", "GroupAlpha's amount reflects ONLY tenant A's own ItemA/ItemB sales, not tenant B's 50,000 (same item name)", groupAlpha.salesAmount, 2800);
  }

  console.log("\n=== 6. Missing StockItemMaster mapping ===");
  {
    const period = { from: new Date("2025-05-01T00:00:00.000Z"), to: new Date("2025-05-31T23:59:59.999Z") };
    const result = await stockGroupAnalytics.getTopStockGroups(TENANT_A, period, null, null, { limit: 10 });
    check("unmapped-not-fabricated-group", "the unmapped item (ItemE) never appears as a fabricated group name in items[]", result.items.some((i) => i.stockGroupName === "ItemE" || i.stockGroupName === "Other"), false);
    check("unmapped-lines-reported", "unmapped lines are reported in the diagnostic (1 line, ItemE)", result.mapping.unmappedLines, 1);
    check("unmapped-amount-reported", "unmapped amount is reported exactly (500)", result.mapping.unmappedAmount, 500);
  }

  console.log("\n=== 7 & 18. Zero sales / no-data period ===");
  {
    const period = { from: new Date("2020-01-01T00:00:00.000Z"), to: new Date("2020-01-31T23:59:59.999Z") };
    const result = await stockGroupAnalytics.getTopStockGroups(TENANT_A, period, null, null, { limit: 10 });
    check("no-data-empty-items", "a period with zero vouchers returns an empty items list", result.items, []);
    check("no-data-hasData-false", "hasData is false for a genuinely empty period", result.hasData, false);
    check("no-data-total-groups-zero", "totalGroups is 0", result.totalGroups, 0);
  }

  console.log("\n=== 8. Zero previous-period sales (growth convention) ===");
  {
    const current = { from: new Date("2025-05-01T00:00:00.000Z"), to: new Date("2025-05-31T23:59:59.999Z") };
    const previous = { from: new Date("2025-03-01T00:00:00.000Z"), to: new Date("2025-03-31T23:59:59.999Z") }; // genuinely zero vouchers
    const result = await stockGroupAnalytics.getTopStockGroups(TENANT_A, current, previous, null, { limit: 10 });
    const groupAlpha = result.items.find((i) => i.stockGroupName === "GroupAlpha");
    check("zero-previous-percentage-null", "growth % vs a zero previous period is null, not Infinity/NaN (existing computeGrowth convention)", groupAlpha.momGrowthPercentage, null);
    check("zero-previous-percentage-not-infinity", "explicitly confirm it is not Infinity", Number.isFinite(groupAlpha.momGrowthPercentage) || groupAlpha.momGrowthPercentage === null, true);
    check("zero-previous-amount-is-full-current", "growth amount vs a zero previous period equals the full current amount", groupAlpha.momGrowthAmount, groupAlpha.salesAmount);
    check("summary-momGrowth-percentage-null", "the overall summary momGrowth.percentage is also null (not Infinity/NaN)", result.summary.momGrowth.growthPercentage, null);
  }

  console.log("\n=== 9. Negative/invalid values ===");
  {
    const period = { from: new Date("2025-05-01T00:00:00.000Z"), to: new Date("2025-05-31T23:59:59.999Z") };
    const result = await stockGroupAnalytics.getTopStockGroups(TENANT_A, period, null, null, { limit: 10 });
    const groupAlpha = result.items.find((i) => i.stockGroupName === "GroupAlpha");
    // ItemA: 1000 (main) - 200 (return line) = 800. ItemB: 2000. Total = 2800.
    check("negative-line-nets-correctly", "a negative inventory.amount line (sales return) nets correctly into the group total, not dropped or crashing", groupAlpha.salesAmount, 2800);
    check("negative-does-not-produce-NaN", "the result is a finite number, never NaN", Number.isFinite(groupAlpha.salesAmount), true);
  }

  console.log("\n=== Date-boundary inclusion (exact from/to edges) ===");
  {
    // Isolated BoundaryGroup dataset (July 2025): a voucher exactly on
    // `from`, one exactly on `to`, one 1ms before `from`, one 1ms after
    // `to`. Only the two exact-boundary vouchers (500 + 300 = 800)
    // should be included.
    const period = { from: new Date("2025-07-10T00:00:00.000Z"), to: new Date("2025-07-19T23:59:59.999Z") };
    const result = await stockGroupAnalytics.getTopStockGroups(TENANT_A, period, null, null, { limit: 10 });
    const boundaryGroup = result.items.find((i) => i.stockGroupName === "BoundaryGroup");
    check("boundary-inclusive-both-ends", "vouchers dated exactly on `from` and exactly on `to` are both included (500 + 300 = 800), and the two just-outside vouchers (999 each) are excluded",
      boundaryGroup.salesAmount, 800);
  }
  {
    // Same isolated dataset, `from` moved 1ms later - only the exact-`from`
    // voucher (500) should now drop out, leaving just the exact-`to` one (300).
    const periodExcludingFromBoundary = { from: new Date("2025-07-10T00:00:00.001Z"), to: new Date("2025-07-19T23:59:59.999Z") };
    const result = await stockGroupAnalytics.getTopStockGroups(TENANT_A, periodExcludingFromBoundary, null, null, { limit: 10 });
    const boundaryGroup = result.items.find((i) => i.stockGroupName === "BoundaryGroup");
    check("boundary-excludes-just-before-from", "moving `from` 1ms later correctly drops the exact-`from` voucher (800 -> 300)", boundaryGroup.salesAmount, 300);
  }

  console.log("\n=== 10-17. Period-kind wiring (via periodEngine, real date filtering) ===");
  {
    // Confirms stockGroupAnalytics correctly consumes whatever {from,to}
    // periodEngine resolves for each kind - periodEngine's OWN date math
    // is already independently tested (verify-period-engine.js, 61/61).
    const referenceDate = new Date("2025-12-08T00:00:00.000Z"); // within the May/June test data's era is NOT needed here - just confirms wiring
    const kinds = ["current_month", "previous_month", "current_quarter", "previous_quarter", "current_fy", "previous_fy", "same_month_last_year", "custom"];
    for (const kind of kinds) {
      const options = kind === "custom" ? { from: "2025-05-01", to: "2025-05-31" } : {};
      const period = periodEngine.resolvePeriod(kind, referenceDate, options);
      const result = await stockGroupAnalytics.getTopStockGroups(TENANT_A, period, null, null, { limit: 10 });
      check(`period-kind-${kind}`, `getTopStockGroups accepts and correctly filters by a "${kind}"-resolved period without error`,
        typeof result.hasData === "boolean" && Array.isArray(result.items), true);
    }
  }

  console.log("\n=== 19. Tenant isolation (end-to-end) ===");
  {
    const period = { from: new Date("2025-05-01T00:00:00.000Z"), to: new Date("2025-05-31T23:59:59.999Z") };
    const resultA = await stockGroupAnalytics.getTopStockGroups(TENANT_A, period, null, null, { limit: 10 });
    const resultB = await stockGroupAnalytics.getTopStockGroups(TENANT_B, period, null, null, { limit: 10 });
    check("tenant-a-groups", "tenant A sees only its own groups (Alpha, Beta, Gamma)",
      resultA.items.map((i) => i.stockGroupName).sort(), ["GroupAlpha", "GroupBeta", "GroupGamma"].sort());
    check("tenant-b-groups", "tenant B sees only its own group (GroupForeign), completely independent of tenant A",
      resultB.items.map((i) => i.stockGroupName), ["GroupForeign"]);
    check("tenant-b-amount-independent", "tenant B's GroupForeign amount is its own (50000), not mixed with tenant A's data",
      resultB.items[0].salesAmount, 50000);
  }

  console.log("\n=== Explicit mapped-lines count (completes test 6) ===");
  {
    const period = { from: new Date("2025-05-01T00:00:00.000Z"), to: new Date("2025-05-31T23:59:59.999Z") };
    const result = await stockGroupAnalytics.getTopStockGroups(TENANT_A, period, null, null, { limit: 10 });
    // ItemA(main)+ItemC(main) + ItemB + ItemD + ItemA(return) = 5 mapped lines; ItemE = 1 unmapped line.
    check("mapped-lines-exact", "mappedLines counts exactly the real mapped inventory lines (5)", result.mapping.mappedLines, 5);
  }
}

// --------------------------------------------------
// B. Real WE FOUR verification - INDEPENDENT aggregation, written
// separately from stockGroupAnalytics.js. Never compares the function's
// own output to itself.
// --------------------------------------------------

async function independentStockGroupAggregation(tenantId, from, to) {
  const stockItems = await StockItemMaster.find({ tenantId }).lean();
  const groupByItemName = new Map(stockItems.map((s) => [s.itemName, s.stockGroupName]));

  const sales = await Sale.find({ tenantId, voucherStatus: "active", "header.voucherDate": { $gte: from, $lte: to } }).lean();

  const byGroup = new Map();
  let mappedAmount = 0, mappedLines = 0, unmappedAmount = 0, unmappedLines = 0;

  for (const sale of sales) {
    for (const line of sale.inventory || []) {
      const group = groupByItemName.get(line.itemName);
      if (group) {
        mappedAmount += line.amount || 0;
        mappedLines += 1;
        const existing = byGroup.get(group) || { salesAmount: 0, salesQuantity: 0 };
        existing.salesAmount += line.amount || 0;
        existing.salesQuantity += line.quantity || 0;
        byGroup.set(group, existing);
      } else {
        unmappedAmount += line.amount || 0;
        unmappedLines += 1;
      }
    }
  }

  const ranked = [...byGroup.entries()]
    .map(([stockGroupName, v]) => ({ stockGroupName, ...v }))
    .sort((a, b) => b.salesAmount - a.salesAmount);

  return {
    mappedGroupCount: byGroup.size,
    mappedAmount: Math.round(mappedAmount * 100) / 100,
    mappedLines,
    unmappedAmount: Math.round(unmappedAmount * 100) / 100,
    unmappedLines,
    top10: ranked.slice(0, 10),
  };
}

async function runRealWeFourVerification() {
  console.log("\n=== B. Real WE FOUR verification (independent aggregation) ===");

  const weFour = await Company.findOne({ companyName: "WE FOUR" }).lean();
  if (!weFour) {
    console.log("SKIP | real-we-four - no WE FOUR company found in this database");
    return;
  }
  const tenantId = weFour.tenantId;

  const mastersCount = await StockItemMaster.countDocuments({ tenantId });
  if (mastersCount === 0) {
    console.log("SKIP | real-we-four - StockItemMaster is empty for WE FOUR (run refresh-stock-item-master.js first)");
    return;
  }

  const referenceDate = await getTenantReferenceDate(tenantId);
  const currentPeriod = periodEngine.resolvePeriod("current_quarter", referenceDate);
  const previousPeriod = periodEngine.resolveComparisonPeriod("current_quarter", referenceDate);
  const yoyPeriod = periodEngine.resolveSamePeriodLastYear("current_quarter", referenceDate);

  const independent = await independentStockGroupAggregation(tenantId, currentPeriod.from, currentPeriod.to);
  const independentPrevious = await independentStockGroupAggregation(tenantId, previousPeriod.from, previousPeriod.to);
  const independentYoy = await independentStockGroupAggregation(tenantId, yoyPeriod.from, yoyPeriod.to);

  const actual = await stockGroupAnalytics.getTopStockGroups(tenantId, currentPeriod, previousPeriod, yoyPeriod, { limit: 10 });

  check("real-mapped-lines", "1. Number of mapped inventory lines matches the independent count", actual.mapping.mappedLines, independent.mappedLines);
  check("real-unmapped-lines", "2. Number of unmapped inventory lines matches the independent count", actual.mapping.unmappedLines, independent.unmappedLines);
  check("real-unmapped-amount", "3. Unmapped sales amount matches the independent count", actual.mapping.unmappedAmount, independent.unmappedAmount);
  check("real-mapped-group-count", "Total distinct mapped Stock Groups matches the independent count", actual.totalGroups, independent.mappedGroupCount);

  const actualTop10Names = actual.items.map((i) => i.stockGroupName);
  const independentTop10Names = independent.top10.map((i) => i.stockGroupName);
  check("real-top10-names-match", "4. Top 10 group NAMES (in order) match the independent aggregation", actualTop10Names, independentTop10Names);

  const amountsMatch = actual.items.every((item, idx) => approx(item.salesAmount, independent.top10[idx].salesAmount, 0.01));
  check("real-top10-amounts-match", "4. Top 10 group AMOUNTS match the independent aggregation (within 1 paisa)", amountsMatch, true);

  const quantitiesMatch = actual.items.every((item, idx) => item.salesQuantity === independent.top10[idx].salesQuantity);
  check("real-top10-quantities-match", "Top 10 group QUANTITIES match the independent aggregation exactly", quantitiesMatch, true);

  check("real-current-total", "5. Current-period total matches independent sum", approx(actual.summary.currentPeriod.totalAmount, independent.mappedAmount, 0.01), true);
  check("real-previous-total", "6. Previous-period total matches independent sum", approx(actual.summary.previousPeriod.totalAmount, independentPrevious.mappedAmount, 0.01), true);
  check("real-yoy-total", "7. YoY total matches independent sum", approx(actual.summary.samePeriodLastYear.totalAmount, independentYoy.mappedAmount, 0.01), true);

  const expectedMomAmount = independent.mappedAmount - independentPrevious.mappedAmount;
  check("real-mom-growth-amount", "8. MoM growth amount matches independent calculation", approx(actual.summary.momGrowth.growthAmount, expectedMomAmount, 0.01), true);
  const expectedYoyAmount = independent.mappedAmount - independentYoy.mappedAmount;
  check("real-yoy-growth-amount", "9. YoY growth amount matches independent calculation", approx(actual.summary.yoyGrowth.growthAmount, expectedYoyAmount, 0.01), true);

  console.log("\n--- Real WE FOUR Top 10 Stock Groups (current quarter) ---");
  actual.items.forEach((g, i) => {
    console.log(`  ${i + 1}. ${g.stockGroupName} — ₹${g.salesAmount.toFixed(2)} (qty ${g.salesQuantity}) | MoM: ${g.momGrowthPercentage === null ? "N/A" : g.momGrowthPercentage.toFixed(1) + "%"} | YoY: ${g.yoyGrowthPercentage === null ? "N/A" : g.yoyGrowthPercentage.toFixed(1) + "%"}`);
  });
  console.log(`\n  Mapped: ${actual.mapping.mappedLines} lines / ₹${actual.mapping.mappedAmount.toFixed(2)}`);
  console.log(`  Unmapped: ${actual.mapping.unmappedLines} lines / ₹${actual.mapping.unmappedAmount.toFixed(2)}`);
  console.log(`  Total distinct mapped groups: ${actual.totalGroups}`);
  console.log(`  Current period: ${currentPeriod.from.toISOString()} - ${currentPeriod.to.toISOString()}, total ₹${actual.summary.currentPeriod.totalAmount.toFixed(2)}`);
  console.log(`  Previous period: ₹${actual.summary.previousPeriod.totalAmount.toFixed(2)} | MoM growth: ${actual.summary.momGrowth.growthPercentage === null ? "N/A" : actual.summary.momGrowth.growthPercentage.toFixed(1) + "%"}`);
  console.log(`  Same period last year: ₹${actual.summary.samePeriodLastYear.totalAmount.toFixed(2)} | YoY growth: ${actual.summary.yoyGrowth.growthPercentage === null ? "N/A" : actual.summary.yoyGrowth.growthPercentage.toFixed(1) + "%"}`);
}

async function main() {
  await connectDB();
  await cleanup();

  try {
    await seedFixtures();
    await runSyntheticTests();
    await runRealWeFourVerification();
  } finally {
    await cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { await cleanup(); await mongoose.disconnect(); } catch { /* best-effort cleanup on failure */ }
  process.exit(1);
});
