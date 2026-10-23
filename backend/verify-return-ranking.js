/**
 * Return Analytics: Top-N customer/supplier ranking by sales/purchase
 * return amount (execute.js/compile.js unchanged - groupBy+sort+limit, already generic).
 *
 * Complements verify-return-analytics.js (totals/trend/comparison) and
 * verify-return-query.js. This suite is the ranking-specific checklist:
 * top 1/5/10, no-N default, both directions, date filtering, tenant
 * isolation, zero vs missing coverage, deterministic ties and cache hits.
 * (Phrasing -> plan is the planner's job; see verify-query-planner.js.)
 *
 * SYNTHETIC fixtures for B-C; SECTION D reads real WE FOUR/Nirmal data
 * READ-ONLY - no writes, no Tally calls, no Claude calls.
 *
 * Run: node verify-return-ranking.js
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

const T1 = "TEST-TENANT-return-ranking";
const T2 = "TEST-TENANT-return-ranking-other";
const utc = (s) => new Date(`${s}T00:00:00.000Z`);
let seq = 0;
function note({ noteType, classification, party, amount, date, status = "active" }) {
  seq += 1;
  return {
    tenantId: T1,
    companyGuid: "gggggggg-return-ranking",
    header: { voucherNo: `RR-${seq}`, voucherDate: utc(date), voucherType: noteType === "credit" ? "Credit Note" : "Debit Note", voucherTotalAmount: amount, narration: "", partyName: party },
    noteType,
    classification,
    inventory: [{ itemName: "Item", quantity: 1, rate: amount, amount, accountingAllocationLedger: noteType === "credit" ? "Sales Return AC" : "Purchase Return AC" }],
    ledgers: [],
    tallyGuid: `gggggggg-return-ranking-n${seq}`,
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
    // ============================================================ B. ENGINE
    section("B. ENGINE: ranking result vs a hand-computed oracle");
    await AdjustmentNote.insertMany([
      note({ noteType: "credit", classification: "sales_return", party: "Alpha", amount: 500, date: "2026-09-05" }),
      note({ noteType: "credit", classification: "sales_return", party: "Beta", amount: 300, date: "2026-09-06" }),
      note({ noteType: "credit", classification: "sales_return", party: "Gamma", amount: 300, date: "2026-09-07" }), // ties with Beta
      note({ noteType: "credit", classification: "sales_return", party: "Delta", amount: 100, date: "2026-09-08" }),
      note({ noteType: "credit", classification: "value_adjustment", party: "Alpha", amount: 9999, date: "2026-09-05" }), // must never rank
      note({ noteType: "credit", classification: "sales_return", party: "Alpha", amount: 8888, date: "2026-09-05", status: "cancelled" }), // must never rank
      note({ noteType: "debit", classification: "purchase_return", party: "Supplier1", amount: 700, date: "2026-09-08" }),
      note({ noteType: "debit", classification: "purchase_return", party: "Supplier2", amount: 200, date: "2026-08-08" }), // outside September
    ]);
    const SEP = { kind: "custom", from: "2026-09-01", to: "2026-09-30" };

    let res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: SEP, metrics: ["returnAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "returnAmount", dir: "desc" }], limit: 1 }, { tenantId: T1 });
    check("Top 1 = Alpha 500 (value_adjustment/cancelled excluded)", res.ok && same(res.rows.map((r) => [r.key.customer, r.values.returnAmount]), [["Alpha", 500]]), JSON.stringify(res.rows || res.errors));

    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: SEP, metrics: ["returnAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "returnAmount", dir: "desc" }] }, { tenantId: T1 });
    check("full ranking = oracle [Alpha 500, Beta 300, Gamma 300, Delta 100], deterministic tie-break (Beta before Gamma, alphabetical)", res.ok && same(res.rows.map((r) => [r.key.customer, r.values.returnAmount]), [["Alpha", 500], ["Beta", 300], ["Gamma", 300], ["Delta", 100]]), JSON.stringify(res.rows || res.errors));

    res = await executeQuery({ v: 1, entity: "purchase_return", mode: "aggregate", period: SEP, metrics: ["returnAmount"], groupBy: [{ dim: "supplier" }], sort: [{ by: "returnAmount", dir: "desc" }] }, { tenantId: T1 });
    check("date filtering excludes August's Supplier2 from the September ranking", res.ok && same(res.rows.map((r) => [r.key.supplier, r.values.returnAmount]), [["Supplier1", 700]]), JSON.stringify(res.rows || res.errors));

    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: { kind: "custom", from: "2026-01-01", to: "2026-01-31" }, metrics: ["returnAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "returnAmount", dir: "desc" }] }, { tenantId: T1 });
    check("zero-result period (covered, no matching notes) -> real empty ranking, no error", res.ok && res.rows.length === 0, JSON.stringify(res.rows || res.errors));

    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: SEP, metrics: ["returnAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "returnAmount", dir: "desc" }] }, { tenantId: T2 });
    check("tenant isolation: a different tenant's ranking is empty", res.ok && res.rows.length === 0);

    // No N stated, synthetic: 12 customers in October 2026 (outside SEP and January above), amounts R01 1200 .. R12 100,
    // all distinct. The validator's default limit (10) applies, so R01..R10 come back and the result is flagged truncated.
    const OCT_RANKING = Array.from({ length: 12 }, (_, i) => [`R${String(i + 1).padStart(2, "0")}`, (12 - i) * 100]);
    await AdjustmentNote.insertMany(OCT_RANKING.map(([party, amount], i) => note({ noteType: "credit", classification: "sales_return", party, amount, date: `2026-10-${String(i + 1).padStart(2, "0")}` })));
    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: { kind: "custom", from: "2026-10-01", to: "2026-10-31" }, metrics: ["returnAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "returnAmount", dir: "desc" }] }, { tenantId: T1 });
    check("no-N ranking applies the default limit: rowLimit 10, truncated, rows = [R01 1200 .. R10 300], R11/R12 absent", res.ok && res.rowLimit === 10 && res.truncated === true && same(res.rows.map((r) => [r.key.customer, r.values.returnAmount]), OCT_RANKING.slice(0, 10)), JSON.stringify(res.ok ? { rowLimit: res.rowLimit, truncated: res.truncated, rows: res.rows.map((r) => [r.key.customer, r.values.returnAmount]) } : res.errors));

    // ============================================================ C. CACHE
    section("C. CACHE: repeat ranking query hits");
    let execCalls = 0;
    const cacheDeps = { execute: async (p, ctx) => { execCalls += 1; return executeQuery(p, ctx); }, getVersion: async () => "v1" };
    const cache = createAnswerCache();
    const rankPlan = { v: 1, entity: "sales_return", mode: "aggregate", period: SEP, metrics: ["returnAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "returnAmount", dir: "desc" }], limit: 5, filters: [] };
    let c1 = await cache.run(rankPlan, { tenantId: T1 }, cacheDeps);
    check("first ranking request is a miss and executes", c1.cache.status === "miss" && execCalls === 1);
    let c2 = await cache.run(rankPlan, { tenantId: T1 }, cacheDeps);
    check("identical top-5 ranking request is a cache hit, no re-execution", c2.cache.status === "hit" && execCalls === 1);
    let c3 = await cache.run({ ...rankPlan, limit: 10 }, { tenantId: T1 }, cacheDeps);
    check("a different N is a different cache key -> miss", c3.cache.status === "miss" && execCalls === 2);

    // ============================================================ D. REAL DATA (read-only, WE FOUR + Nirmal)
    section("D. REAL DATA oracle (read-only, no writes, no Tally, no Claude)");
    const REAL_PRESENT = (await AdjustmentNote.countDocuments({ tenantId: "6ab21418959e173f9b3f367f" })) > 0;
    if (!REAL_PRESENT) console.log("  SKIPPED - the real WE FOUR/Nirmal tenants are not present in this database");
    else {
    const WE_FOUR = "6ab21418959e173f9b3f367f";
    const NIRMAL = "6ab21fe0959e173f9b3f3682";
    const ALL_TIME = { kind: "all_time" };

    const top5CustomerOracle = await AdjustmentNote.aggregate([{ $match: { tenantId: WE_FOUR, classification: "sales_return", voucherStatus: "active" } }, { $group: { _id: "$header.partyName", amt: { $sum: "$header.voucherTotalAmount" } } }, { $sort: { amt: -1, _id: 1 } }, { $limit: 5 }]);
    const top5CustomerEngine = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "returnAmount", dir: "desc" }], limit: 5 }, { tenantId: WE_FOUR });
    const engineTop5 = top5CustomerEngine.ok ? top5CustomerEngine.rows.map((r) => [r.key.customer, Math.round(r.values.returnAmount * 100) / 100]) : null;
    const oracleTop5 = top5CustomerOracle.map((r) => [r._id, Math.round(r.amt * 100) / 100]);
    check("D1 WE FOUR top-5 customers by sales returns = independent Mongo oracle", top5CustomerEngine.ok && same(engineTop5, oracleTop5), JSON.stringify({ engine: engineTop5, oracle: oracleTop5 }));

    const top3SupplierOracle = await AdjustmentNote.aggregate([{ $match: { tenantId: WE_FOUR, classification: "purchase_return", voucherStatus: "active" } }, { $group: { _id: "$header.partyName", amt: { $sum: "$header.voucherTotalAmount" } } }, { $sort: { amt: -1, _id: 1 } }, { $limit: 3 }]);
    const top3SupplierEngine = await executeQuery({ v: 1, entity: "purchase_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnAmount"], groupBy: [{ dim: "supplier" }], sort: [{ by: "returnAmount", dir: "desc" }], limit: 3 }, { tenantId: WE_FOUR });
    const engineTop3 = top3SupplierEngine.ok ? top3SupplierEngine.rows.map((r) => [r.key.supplier, Math.round(r.values.returnAmount * 100) / 100]) : null;
    const oracleTop3 = top3SupplierOracle.map((r) => [r._id, Math.round(r.amt * 100) / 100]);
    check("D2 WE FOUR top-3 suppliers by purchase returns = independent Mongo oracle", top3SupplierEngine.ok && same(engineTop3, oracleTop3), JSON.stringify({ engine: engineTop3, oracle: oracleTop3 }));

    // No N stated: the plan leaves plan.limit unset, and validator.js applies the product's own
    // existing default (LIMITS.defaultLimit = 10, truncated: true) - not "return everything". Confirmed
    // against real data: the same 10 rows an independent oracle limited to 10 would return.
    const top10CustomerOracle = await AdjustmentNote.aggregate([{ $match: { tenantId: WE_FOUR, classification: "sales_return", voucherStatus: "active" } }, { $group: { _id: "$header.partyName", amt: { $sum: "$header.voucherTotalAmount" } } }, { $sort: { amt: -1, _id: 1 } }, { $limit: 10 }]);
    const noLimitEngine = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "returnAmount", dir: "desc" }] }, { tenantId: WE_FOUR });
    const noLimitRows = noLimitEngine.ok ? noLimitEngine.rows.map((r) => [r.key.customer, Math.round(r.values.returnAmount * 100) / 100]) : null;
    const oracleTop10 = top10CustomerOracle.map((r) => [r._id, Math.round(r.amt * 100) / 100]);
    check("D3 no-N ranking (real data) applies the product's existing default limit (10), truncated=true, matches an independent top-10 oracle", noLimitEngine.ok && noLimitEngine.truncated === true && noLimitEngine.rows.length === 10 && same(noLimitRows, oracleTop10), JSON.stringify({ engine: noLimitRows, oracle: oracleTop10, truncated: noLimitEngine.truncated }));

    const nirmalRanking = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "returnAmount", dir: "desc" }], limit: 5 }, { tenantId: NIRMAL });
    check("D4 Nirmal top-5 sales-return customers = genuine empty ranking (no Credit Notes exist)", nirmalRanking.ok && nirmalRanking.rows.length === 0);
    const nirmalPurchRanking = await executeQuery({ v: 1, entity: "purchase_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnAmount"], groupBy: [{ dim: "supplier" }], sort: [{ by: "returnAmount", dir: "desc" }], limit: 5 }, { tenantId: NIRMAL });
    check("D5 Nirmal top-5 purchase-return suppliers = genuine empty ranking", nirmalPurchRanking.ok && nirmalPurchRanking.rows.length === 0);
    }
  } catch (error) {
    fail += 1;
    console.log("  FAIL - unexpected error:", error && error.stack);
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }
  console.log(`\nverify-return-ranking: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
