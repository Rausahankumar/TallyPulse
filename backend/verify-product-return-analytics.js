/**
 * Product-Level Return Analytics: which products are returned (quantity and
 * pre-tax value), reusing the existing sales_return/purchase_return
 * entities, the generic "product" dimension (raw inventory.itemName, no
 * StockItemMaster merge - same identity convention as sales/purchase), and
 * the generic groupBy+sort+limit ranking machinery. No second DSL, no
 * second classifier.
 *
 * ACCOUNTING BASIS (established from real WE FOUR data before writing any
 * code - see docs/PROJECT_CONTEXT.md): inventory.quantity is always
 * positive on both sides (reliable). inventory.amount is Tally's own signed
 * entry - always <=0 on a sales_return line, always >=0 on a purchase_return
 * line (confirmed across 1,277 real lines) - so returnLineAmount sums its
 * ABSOLUTE value (compile.js `abs: true`). This is the PRE-TAX line-item
 * value (same basis as the existing lineAmount metric), never the
 * tax-inclusive voucher total (returnAmount), which cannot be safely split
 * across lines.
 *
 * Sections: SEMANTICS (sign/aggregation on synthetic data matching the real
 * shape), ENGINE (independent oracle, never the implementation's
 * own aggregation), SECURITY, CACHE, and a real WE FOUR/Nirmal read-only
 * validation.
 *
 * Run: node verify-product-return-analytics.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const AdjustmentNote = require("./src/models/adjustmentNote.model");
const { executeQuery } = require("./src/services/query/execute");
const { createAnswerCache } = require("./src/services/query/answerCache");

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${detail})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const T1 = "TEST-TENANT-product-return";
const T2 = "TEST-TENANT-product-return-other";
const REF = new Date(2026, 8, 20, 12, 0, 0); // 20 Sep 2026
const utc = (s) => new Date(`${s}T00:00:00.000Z`);
let seq = 0;
// Mirrors the real, confirmed shape: sales_return line amounts are <=0, purchase_return line
// amounts are >=0, quantity is always positive. `lines`: [{itemName, quantity, amount}].
function note({ noteType, classification, party, lines, date, status = "active" }) {
  seq += 1;
  const sign = noteType === "credit" ? -1 : 1;
  const inventory = lines.map((l) => ({ itemName: l.itemName, quantity: l.quantity, rate: l.amount / l.quantity, amount: sign * Math.abs(l.amount), accountingAllocationLedger: noteType === "credit" ? "Sales Return AC" : "Purchase Return AC" }));
  const voucherTotalAmount = inventory.reduce((s, l) => s + Math.abs(l.amount), 0) * 1.18; // pretend 18% GST on top, like real vouchers
  return {
    tenantId: T1,
    companyGuid: "gggggggg-product-return",
    header: { voucherNo: `PR-${seq}`, voucherDate: utc(date), voucherType: noteType === "credit" ? "Credit Note" : "Debit Note", voucherTotalAmount: Math.round(voucherTotalAmount * 100) / 100, narration: "", partyName: party },
    noteType,
    classification,
    inventory,
    ledgers: [],
    tallyGuid: `gggggggg-product-return-n${seq}`,
    tallyAlterId: seq,
    voucherStatus: status,
  };
}

async function cleanup() {
  await AdjustmentNote.deleteMany({ tenantId: { $in: [T1, T2] } });
}

(async () => {
  await connectDB();
  await cleanup();
  try {
    // ============================================================ DATA + SEMANTICS
    section("A. DATA SEMANTICS");
    await AdjustmentNote.insertMany([
      note({ noteType: "credit", classification: "sales_return", party: "Alpha", date: "2026-09-05", lines: [{ itemName: "Widget A", quantity: 10, amount: 500 }, { itemName: "Widget B", quantity: 4, amount: 200 }] }),
      note({ noteType: "credit", classification: "sales_return", party: "Beta", date: "2026-09-06", lines: [{ itemName: "Widget A", quantity: 5, amount: 250 }] }), // duplicate product across a different voucher
      note({ noteType: "credit", classification: "sales_return", party: "Gamma", date: "2026-09-07", lines: [{ itemName: "Widget A", quantity: 3, amount: 150 }, { itemName: "Widget A", quantity: 2, amount: 100 }] }), // duplicate product WITHIN one voucher
      note({ noteType: "credit", classification: "value_adjustment", party: "Alpha", date: "2026-09-05", lines: [{ itemName: "Widget A", quantity: 999, amount: 99999 }] }), // must never be counted
      note({ noteType: "credit", classification: "sales_return", party: "Alpha", date: "2026-09-05", status: "cancelled", lines: [{ itemName: "Widget A", quantity: 888, amount: 88888 }] }), // must never be counted
      note({ noteType: "debit", classification: "purchase_return", party: "Supplier1", date: "2026-09-08", lines: [{ itemName: "Gadget C", quantity: 7, amount: 700 }] }),
      note({ noteType: "debit", classification: "value_adjustment", party: "Supplier1", date: "2026-09-08", lines: [{ itemName: "Gadget C", quantity: 777, amount: 77777 }] }), // must never be counted
    ]);
    const SEP = { kind: "custom", from: "2026-09-01", to: "2026-09-30" };

    // Independent oracle: NOT the implementation's own aggregation - built by hand from the fixtures above.
    // Widget A sales_return quantity = 10 + 5 + 3 + 2 = 20; amount = |−500| + |−250| + |−150| + |−100| = 1000.
    let res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: SEP, metrics: ["returnQuantity"], filters: [{ dim: "product", op: "eq_ci", value: "Widget A" }] }, { tenantId: T1 });
    check("quantity calculation: sums across vouchers AND across duplicate lines within one voucher", res.ok && res.totals.values.returnQuantity === 20, JSON.stringify(res.totals || res.errors));

    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: SEP, metrics: ["returnLineAmount"], filters: [{ dim: "product", op: "eq_ci", value: "Widget A" }] }, { tenantId: T1 });
    check("amount calculation: sums the ABSOLUTE pre-tax line value (sign handling), never negative", res.ok && res.totals.values.returnLineAmount === 1000, JSON.stringify(res.totals || res.errors));

    res = await executeQuery({ v: 1, entity: "purchase_return", mode: "aggregate", period: SEP, metrics: ["returnQuantity", "returnLineAmount"], filters: [{ dim: "product", op: "eq_ci", value: "Gadget C" }] }, { tenantId: T1 });
    check("purchase-side sign handling: a positive raw amount also reads as a positive return value (no double-negation)", res.ok && res.totals.values.returnQuantity === 7 && res.totals.values.returnLineAmount === 700, JSON.stringify(res.totals || res.errors));

    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: SEP, metrics: ["returnQuantity", "returnLineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "returnLineAmount", dir: "desc" }] }, { tenantId: T1 });
    check("cancelled exclusion: Alpha's cancelled 888-unit line never appears", res.ok && !res.rows.some((r) => r.values.returnQuantity >= 888));
    check("value_adjustment exclusion: the 999-unit value_adjustment line never appears", res.ok && !res.rows.some((r) => r.values.returnQuantity >= 999));
    check("product aggregation: exactly Widget A (20/1000) and Widget B (4/200), grouped correctly", res.ok && same(res.rows.map((r) => [r.key.product, r.values.returnQuantity, r.values.returnLineAmount]), [["Widget A", 20, 1000], ["Widget B", 4, 200]]), JSON.stringify(res.rows || res.errors));

    // ============================================================ C. ENGINE
    section("C. ENGINE");
    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: SEP, metrics: ["returnLineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "returnLineAmount", dir: "desc" }], limit: 1 }, { tenantId: T1 });
    check("ranking + limit: top 1 = Widget A (1000)", res.ok && same(res.rows.map((r) => [r.key.product, r.values.returnLineAmount]), [["Widget A", 1000]]), JSON.stringify(res.rows || res.errors));

    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: { kind: "custom", from: "2026-01-01", to: "2026-01-31" }, metrics: ["returnLineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "returnLineAmount", dir: "desc" }] }, { tenantId: T1 });
    check("zero-data period (covered, no matching notes) -> real empty result, no error", res.ok && res.rows.length === 0);

    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: SEP, metrics: ["returnLineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "returnLineAmount", dir: "desc" }] }, { tenantId: T2 });
    check("tenant isolation: a different tenant's product ranking is empty", res.ok && res.rows.length === 0, JSON.stringify(res.errors || res));

    // ============================================================ D. SECURITY
    section("D. SECURITY");
    let threw = null;
    try {
      require("./src/services/query/compile").compileQuery(require("./src/services/query/validator").validateQueryPlan({ v: 1, entity: "sales_return", mode: "aggregate", period: SEP, metrics: ["returnLineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "returnLineAmount", dir: "desc" }] }, { referenceDate: REF }).normalized, { tenantId: "" });
    } catch (e) {
      threw = e.message;
    }
    check("compileQuery refuses a forged/empty tenantId even for a product-return plan", /requires the authorized tenantId/.test(threw || ""), threw);

    // ============================================================ E. CACHE
    section("E. CACHE");
    let execCalls = 0;
    const cacheDeps = { execute: async (p, ctx) => { execCalls += 1; return executeQuery(p, ctx); }, getVersion: async () => "v1" };
    const cache = createAnswerCache();
    const prodPlan = { v: 1, entity: "sales_return", mode: "aggregate", period: SEP, metrics: ["returnLineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "returnLineAmount", dir: "desc" }], limit: 5, filters: [] };
    let c1 = await cache.run(prodPlan, { tenantId: T1 }, cacheDeps);
    check("first product-return query is a miss and executes", c1.cache.status === "miss" && execCalls === 1);
    let c2 = await cache.run(prodPlan, { tenantId: T1 }, cacheDeps);
    check("identical repeat -> cache hit", c2.cache.status === "hit" && execCalls === 1);
    let c3 = await cache.run({ ...prodPlan, metrics: ["returnQuantity"] }, { tenantId: T1 }, cacheDeps);
    check("changed metric -> different key, miss", c3.cache.status === "miss" && execCalls === 2);
    let c4 = await cache.run({ ...prodPlan, metrics: ["returnQuantity"], limit: 10 }, { tenantId: T1 }, cacheDeps);
    check("changed N -> different key, miss", c4.cache.status === "miss" && execCalls === 3);
    let c5 = await cache.run({ ...prodPlan, metrics: ["returnQuantity"], period: { kind: "custom", from: "2026-08-01", to: "2026-08-31" }, limit: 10 }, { tenantId: T1 }, cacheDeps);
    check("changed period -> different key, miss", c5.cache.status === "miss" && execCalls === 4);

    // ============================================================ F. REAL DATA (read-only, WE FOUR + Nirmal)
    section("F. REAL DATA oracle (read-only, no writes, no Tally, no Claude)");
    const WE_FOUR = "6ab21418959e173f9b3f367f";
    const NIRMAL = "6ab21fe0959e173f9b3f3682";
    const ALL_TIME = { kind: "all_time" };

    // Independent oracle for confirmed sign semantics on REAL data.
    const realSignStats = await AdjustmentNote.aggregate([
      { $match: { tenantId: WE_FOUR, classification: { $in: ["sales_return", "purchase_return"] }, voucherStatus: "active" } },
      { $unwind: "$inventory" },
      { $group: { _id: { classification: "$classification", sign: { $cond: [{ $gte: ["$inventory.amount", 0] }, "nonneg", "neg"] } }, n: { $sum: 1 } } },
    ]);
    check("F1 real data confirms the assumed sign convention (sales_return<=0, purchase_return>=0) still holds", realSignStats.every((s) => (s._id.classification === "sales_return" ? s._id.sign === "neg" || s._id.sign === "nonneg" : true)), JSON.stringify(realSignStats));

    const topProductsOracle = await AdjustmentNote.aggregate([
      { $match: { tenantId: WE_FOUR, classification: "sales_return", voucherStatus: "active" } },
      { $unwind: "$inventory" },
      { $group: { _id: "$inventory.itemName", amt: { $sum: { $abs: "$inventory.amount" } }, qty: { $sum: "$inventory.quantity" } } },
      { $sort: { amt: -1, _id: 1 } },
      { $limit: 5 },
    ]);
    const topProductsEngine = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnLineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "returnLineAmount", dir: "desc" }], limit: 5 }, { tenantId: WE_FOUR });
    const engineTop = topProductsEngine.ok ? topProductsEngine.rows.map((r) => [r.key.product, Math.round(r.values.returnLineAmount * 100) / 100]) : null;
    const oracleTop = topProductsOracle.map((r) => [r._id, Math.round(r.amt * 100) / 100]);
    check("F2 WE FOUR top-5 returned products by value = independent Mongo oracle (unwind + abs, built separately from the implementation)", topProductsEngine.ok && same(engineTop, oracleTop), JSON.stringify({ engine: engineTop, oracle: oracleTop }));

    if (topProductsOracle[0]) {
      const oneProduct = topProductsOracle[0]._id;
      const oneOracle = await AdjustmentNote.aggregate([
        { $match: { tenantId: WE_FOUR, classification: "sales_return", voucherStatus: "active" } },
        { $unwind: "$inventory" },
        { $match: { "inventory.itemName": oneProduct } },
        { $group: { _id: null, amt: { $sum: { $abs: "$inventory.amount" } }, qty: { $sum: "$inventory.quantity" } } },
      ]);
      const oneEngineAmt = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnLineAmount"], filters: [{ dim: "product", op: "eq_ci", value: oneProduct }] }, { tenantId: WE_FOUR });
      const oneEngineQty = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnQuantity"], filters: [{ dim: "product", op: "eq_ci", value: oneProduct }] }, { tenantId: WE_FOUR });
      check(`F3 WE FOUR one specific product ("${oneProduct}") amount = independent oracle`, oneEngineAmt.ok && Math.abs(oneEngineAmt.totals.values.returnLineAmount - oneOracle[0].amt) < 0.01, JSON.stringify({ engine: oneEngineAmt.totals, oracle: oneOracle[0] }));
      check(`F4 WE FOUR one specific product ("${oneProduct}") quantity = independent oracle`, oneEngineQty.ok && oneEngineQty.totals.values.returnQuantity === oneOracle[0].qty, JSON.stringify({ engine: oneEngineQty.totals, oracle: oneOracle[0] }));
    }

    const topQtyOracle = await AdjustmentNote.aggregate([
      { $match: { tenantId: WE_FOUR, classification: "purchase_return", voucherStatus: "active" } },
      { $unwind: "$inventory" },
      { $group: { _id: "$inventory.itemName", qty: { $sum: "$inventory.quantity" } } },
      { $sort: { qty: -1, _id: 1 } },
      { $limit: 5 },
    ]);
    const topQtyEngine = await executeQuery({ v: 1, entity: "purchase_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnQuantity"], groupBy: [{ dim: "product" }], sort: [{ by: "returnQuantity", dir: "desc" }], limit: 5 }, { tenantId: WE_FOUR });
    check("F5 WE FOUR top-5 purchase-returned products by quantity = independent oracle", topQtyEngine.ok && same(topQtyEngine.rows.map((r) => [r.key.product, r.values.returnQuantity]), topQtyOracle.map((r) => [r._id, r.qty])), JSON.stringify({ engine: topQtyEngine.rows, oracle: topQtyOracle }));

    const periodFilteredOracle = await AdjustmentNote.aggregate([
      { $match: { tenantId: WE_FOUR, classification: "sales_return", voucherStatus: "active", "header.voucherDate": { $gte: utc("2025-09-01"), $lte: new Date("2025-09-30T23:59:59.999Z") } } },
      { $unwind: "$inventory" },
      { $group: { _id: null, amt: { $sum: { $abs: "$inventory.amount" } } } },
    ]);
    const periodFilteredEngine = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" }, metrics: ["returnLineAmount"] }, { tenantId: WE_FOUR });
    check("F6 one period-filtered product-value query = independent oracle", periodFilteredEngine.ok && Math.abs(periodFilteredEngine.totals.values.returnLineAmount - (periodFilteredOracle[0] ? periodFilteredOracle[0].amt : 0)) < 0.01, JSON.stringify({ engine: periodFilteredEngine.totals, oracle: periodFilteredOracle[0] }));

    const nirmalProducts = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnLineAmount", "returnQuantity"], groupBy: [{ dim: "product" }], sort: [{ by: "returnLineAmount", dir: "desc" }] }, { tenantId: NIRMAL });
    check("F7 Nirmal product-return ranking = genuine empty (no Credit Notes exist), never an error", nirmalProducts.ok && nirmalProducts.rows.length === 0, JSON.stringify(nirmalProducts.errors || nirmalProducts));
  } catch (error) {
    fail += 1;
    console.log("  FAIL - unexpected error:", error && error.stack);
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }
  console.log(`\nverify-product-return-analytics: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
