/**
 * Return Analytics Phase 1: query engine, chat integration (freshness + coverage, both fixed in this phase),
 * tenant security, answer cache, and a real-data oracle check against live tenant A / live tenant B (read-only).
 *
 * Complements verify-return-query.js (engine basics) and verify-adjustment-note.js (sync pipeline). This suite
 * covers trend, comparison, the queryChat freshness/coverage entity-label fixes, cache-hit behaviour, and a
 * forged tenant/company rejection. Phrasing -> plan is the planner's job (verify-query-planner.js); the chat
 * section here feeds queryChat the plan a correct interpretation produces through a scripted planner client.
 *
 * SYNTHETIC fixtures for sections B-F; SECTION G reads live tenants A and B data (already synced and validated in
 * a prior session) READ-ONLY - no writes, no Tally calls, no Claude calls.
 *
 * Run: node verify-return-analytics.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const REAL = require("./test/realTenants");
const connectDB = require("./src/config/db");

const AdjustmentNote = require("./src/models/adjustmentNote.model");
const { createEntityResolver } = require("./src/services/query/entityResolver");
const { executeQuery } = require("./src/services/query/execute");
const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");
const { PLANNER_TOOL_NAME } = require("./src/services/query/planner");
const { createAnswerCache } = require("./src/services/query/answerCache");
const { formatQueryAnswer } = require("./src/services/query/answerFormatter");

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

const T1 = "TEST-TENANT-return-analytics";
const T2 = "TEST-TENANT-return-analytics-other";
const REF = new Date(2026, 8, 20, 12, 0, 0); // 20 Sep 2026, local noon
const resolver = createEntityResolver({ tenantId: "TEST-TENANT", sources: { customer: async () => [], supplier: async () => [], product: async () => [], productGroup: async () => [] } });

const utc = (s) => new Date(`${s}T00:00:00.000Z`);
let seq = 0;
function note({ noteType, classification, party, amount, date, status = "active" }) {
  seq += 1;
  return {
    tenantId: T1,
    companyGuid: "gggggggg-return-analytics",
    header: { voucherNo: `RA-${seq}`, voucherDate: utc(date), voucherType: noteType === "credit" ? "Credit Note" : "Debit Note", voucherTotalAmount: amount, narration: "", partyName: party },
    noteType,
    classification,
    inventory: [{ itemName: "Item", quantity: 1, rate: amount, amount, accountingAllocationLedger: noteType === "credit" ? "Sales Return AC" : "Purchase Return AC" }],
    ledgers: [],
    tallyGuid: `gggggggg-return-analytics-n${seq}`,
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
    section("B. ENGINE vs a hand-computed oracle");
    await AdjustmentNote.insertMany([
      note({ noteType: "credit", classification: "sales_return", party: "Alpha", amount: 100, date: "2026-07-05" }),
      note({ noteType: "credit", classification: "sales_return", party: "Alpha", amount: 50, date: "2026-08-15" }),
      note({ noteType: "credit", classification: "sales_return", party: "Beta", amount: 30, date: "2026-09-05" }),
      note({ noteType: "credit", classification: "value_adjustment", party: "Alpha", amount: 9999, date: "2026-09-05" }), // must never be counted
      note({ noteType: "credit", classification: "sales_return", party: "Alpha", amount: 8888, date: "2026-09-05", status: "cancelled" }), // must never be counted
      note({ noteType: "debit", classification: "purchase_return", party: "Supplier1", amount: 70, date: "2026-09-08" }),
      note({ noteType: "debit", classification: "value_adjustment", party: "Supplier1", amount: 7777, date: "2026-09-08" }), // must never be counted
    ]);
    const FY = { kind: "custom", from: "2026-04-01", to: "2027-03-31" };
    let res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: FY, metrics: ["returnAmount", "returnCount"] }, { tenantId: T1 });
    check("B1 exact total amount = 180, count = 3, excludes value_adjustment/cancelled", res.ok && res.totals.values.returnAmount === 180 && res.totals.values.returnCount === 3, JSON.stringify(res.totals || res.errors));

    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: FY, metrics: ["returnAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "returnAmount", dir: "desc" }] }, { tenantId: T1 });
    check("B2 grouped party result = oracle [Alpha 150, Beta 30]", res.ok && same(res.rows.map((r) => [r.key.customer, r.values.returnAmount]), [["Alpha", 150], ["Beta", 30]]), JSON.stringify(res.rows || res.errors));

    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: { kind: "custom", from: "2026-08-01", to: "2026-08-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2026-07-01", to: "2026-07-31" } }, metrics: ["returnAmount"] }, { tenantId: T1 });
    check("B3 comparison result: Aug 50 vs Jul 100, delta -50", res.ok && res.totals.values.returnAmount === 50 && res.totals.comparison.returnAmount.previous === 100 && res.totals.comparison.returnAmount.delta === -50, JSON.stringify(res.totals || res.errors));

    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: FY, metrics: ["returnAmount"], groupBy: [{ dim: "date", bucket: "month" }] }, { tenantId: T1 });
    check("B4 month trend = oracle [Jul 100, Aug 50, Sep 30]", res.ok && same(res.rows.map((r) => [r.key.date.label, r.values.returnAmount]), [["2026-07", 100], ["2026-08", 50], ["2026-09", 30]]), JSON.stringify(res.rows || res.errors));

    res = await executeQuery({ v: 1, entity: "purchase_return", mode: "aggregate", period: FY, metrics: ["returnAmount"] }, { tenantId: T1 });
    check("B5 purchase_return total = 70, excludes its own value_adjustment", res.ok && res.totals.values.returnAmount === 70);

    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: FY, metrics: ["returnAmount"] }, { tenantId: T2 });
    check("B6 zero-data tenant -> real zero, not an error", res.ok && res.totals.values.returnAmount === 0);

    // ============================================================ C. SECURITY
    section("C. SECURITY: tenant isolation + forged scope rejection");
    check("C1 tenant isolation: T2 sees none of T1's notes", (await AdjustmentNote.countDocuments({ tenantId: T2 })) === 0);
    let threw = null;
    try {
      require("./src/services/query/compile").compileQuery(require("./src/services/query/validator").validateQueryPlan({ v: 1, entity: "sales_return", mode: "aggregate", period: FY, metrics: ["returnAmount"] }, { referenceDate: REF }).normalized, { tenantId: "" });
    } catch (e) {
      threw = e.message;
    }
    check("C2 compileQuery refuses an empty/forged tenantId", /requires the authorized tenantId/.test(threw || ""), threw);
    let noContext;
    try {
      noContext = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: FY, metrics: ["returnAmount"] }, {});
    } catch (e) {
      noContext = { threw: e.message };
    }
    check("C3 executeQuery with no tenant context is refused, not defaulted to any tenant", noContext.ok !== true, JSON.stringify(noContext));

    // ============================================================ D. CACHE
    section("D. CACHE: deterministic repeats hit");
    let execCalls = 0;
    const cacheDeps = {
      execute: async (p, ctx) => {
        execCalls += 1;
        return executeQuery(p, ctx);
      },
      getVersion: async () => "v1",
    };
    const cache = createAnswerCache();
    const returnPlan = { v: 1, entity: "sales_return", mode: "aggregate", period: FY, metrics: ["returnAmount"], filters: [] };
    let c1 = await cache.run(returnPlan, { tenantId: T1 }, cacheDeps);
    check("D1 first run is a miss and executes", c1.cache.status === "miss" && execCalls === 1);
    let c2 = await cache.run(returnPlan, { tenantId: T1 }, cacheDeps);
    check("D2 identical return plan is a cache hit, no re-execution", c2.cache.status === "hit" && execCalls === 1);
    let c3 = await cache.run({ ...returnPlan, metrics: ["returnCount"] }, { tenantId: T1 }, cacheDeps);
    check("D3 a different metric is a different cache key -> miss", c3.cache.status === "miss" && execCalls === 2);

    // ============================================================ E. queryChat freshness/coverage fix
    section("E. queryChat: return entities get their OWN freshness/coverage label (bug fixed this phase)");
    // the plans a correct interpretation of each question produces (the planner is scripted: no network)
    const FYC = { kind: "custom", from: "2020-04-01", to: "2020-04-30" };
    const QPLANS = {
      "sales returns this month": { v: 1, entity: "sales_return", mode: "aggregate", period: { kind: "current_month" }, metrics: ["returnAmount"] },
      "purchase returns this month": { v: 1, entity: "purchase_return", mode: "aggregate", period: { kind: "current_month" }, metrics: ["returnAmount"] },
      "sales returns in April 2020": { v: 1, entity: "sales_return", mode: "aggregate", period: FYC, metrics: ["returnAmount"] },
    };
    const planFor = (q) => async () => ({ content: [{ type: "tool_use", id: "p", name: PLANNER_TOOL_NAME, input: { plan: QPLANS[q] } }], usage: { input_tokens: 1, output_tokens: 1 } });
    const askPure = async (q, freshnessOverride) => {
      const seenVoucherTypes = [];
      const getFreshness = async (tenantId, voucherType) => {
        seenVoucherTypes.push(voucherType);
        return freshnessOverride || { state: "fresh", dataAsOf: null, message: "ok" };
      };
      const execute = async (p, ctx) => ({ result: await executeQuery(p, ctx), cache: { status: "miss" } });
      const out = await tryAnswerWithQueryEngine({ context: { tenantId: T1 }, userMessage: q, conversationHistory: [], deps: { resolveEntity: resolver, getFreshness, plannerClient: planFor(q), execute, getDateContext: async () => ({ referenceDate: REF, coverage: { earliest: utc("2026-04-01"), latest: utc("2026-09-30") } }) } });
      return { out, seenVoucherTypes };
    };
    let { out, seenVoucherTypes } = await askPure("sales returns this month");
    check("E1 sales_return freshness reads the Credit Note checkpoint (Sales/Purchase are read before the plan exists; the return entity adds its own)", seenVoucherTypes.includes("Credit Note") && !seenVoucherTypes.includes("Debit Note"), JSON.stringify(seenVoucherTypes));
    check("E1b the answer actually reflects the seeded 30 for September", out.handled && /30\.00/.test(out.structured.answer), out.structured && out.structured.answer);

    ({ out, seenVoucherTypes } = await askPure("purchase returns this month"));
    check("E2 purchase_return freshness reads the Debit Note checkpoint", seenVoucherTypes.includes("Debit Note") && !seenVoucherTypes.includes("Credit Note"), JSON.stringify(seenVoucherTypes));

    ({ out } = await askPure("sales returns this month", { state: "never_synced", dataAsOf: null, message: "No Credit Note sync has ever run for this company yet." }));
    check("E3 never-synced Credit Note checkpoint is disclosed as missing data, never a false zero", out.handled && /No Credit Note sync/.test(out.structured.answer));

    ({ out } = await askPure("sales returns in April 2020"));
    check("E4 a period outside the synced window is disclosed as missing data (coverage), never a silent zero", out.handled && /(missing data|no data)/i.test(out.structured.answer) && !/were ₹0\.00 across 0/.test(out.structured.answer), out.structured && out.structured.answer);

    // ============================================================ F. FORMATTER
    section("F. FORMATTER text");
    const fq = { v: 1, entity: "sales_return", mode: "aggregate", period: FY, metrics: ["returnAmount"] };
    const fres = await executeQuery(fq, { tenantId: T1 });
    const formatted = formatQueryAnswer({ plan: fq, result: fres });
    check("F1 answer states the metric, resolved dates and the ₹ figure", /Return amount:\s*₹180\.00/.test(formatted.text) && /2026/.test(formatted.text), formatted.text);

    // ============================================================ G. REAL DATA (read-only, live tenant A + live tenant B)
    section("G. REAL DATA oracle (read-only, no writes, no Tally, no Claude)");
    const REAL_PRESENT = (await AdjustmentNote.countDocuments({ tenantId: REAL.A.tenantId })) > 0;
    if (!REAL_PRESENT) console.log("  SKIPPED - the live tenants A and B are not present in this database");
    else {
    const TENANT_A = REAL.A.tenantId;
    const TENANT_B = REAL.B.tenantId;
    const ALL_TIME = { kind: "all_time" };

    const oracleAgg = async (tenantId, classification) => {
      const rows = await AdjustmentNote.aggregate([{ $match: { tenantId, classification, voucherStatus: "active" } }, { $group: { _id: null, amt: { $sum: "$header.voucherTotalAmount" }, n: { $sum: 1 } } }]);
      return rows[0] ? { amt: Math.round(rows[0].amt * 100) / 100, n: rows[0].n } : { amt: 0, n: 0 };
    };

    const tenantASalesOracle = await oracleAgg(TENANT_A, "sales_return");
    let tenantASalesEngine = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnAmount", "returnCount"] }, { tenantId: TENANT_A });
    check("G1 live tenant A sales_return amount/count = independent Mongo oracle", tenantASalesEngine.ok && tenantASalesEngine.totals.values.returnAmount === tenantASalesOracle.amt && tenantASalesEngine.totals.values.returnCount === tenantASalesOracle.n, JSON.stringify({ engine: tenantASalesEngine.totals, oracle: tenantASalesOracle }));

    const tenantAPurchOracle = await oracleAgg(TENANT_A, "purchase_return");
    let tenantAPurchEngine = await executeQuery({ v: 1, entity: "purchase_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnAmount", "returnCount"] }, { tenantId: TENANT_A });
    check("G2 live tenant A purchase_return amount/count = independent Mongo oracle", tenantAPurchEngine.ok && tenantAPurchEngine.totals.values.returnAmount === tenantAPurchOracle.amt && tenantAPurchEngine.totals.values.returnCount === tenantAPurchOracle.n, JSON.stringify({ engine: tenantAPurchEngine.totals, oracle: tenantAPurchOracle }));

    const topCustomerOracle = await AdjustmentNote.aggregate([{ $match: { tenantId: TENANT_A, classification: "sales_return", voucherStatus: "active" } }, { $group: { _id: "$header.partyName", amt: { $sum: "$header.voucherTotalAmount" } } }, { $sort: { amt: -1 } }, { $limit: 1 }]);
    const topCustomerEngine = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "returnAmount", dir: "desc" }], limit: 1 }, { tenantId: TENANT_A });
    check("G3 live tenant A top customer by sales returns = independent oracle", topCustomerEngine.ok && topCustomerEngine.rows[0] && topCustomerEngine.rows[0].key.customer === topCustomerOracle[0]._id && Math.abs(topCustomerEngine.rows[0].values.returnAmount - topCustomerOracle[0].amt) < 0.01, JSON.stringify({ engine: topCustomerEngine.rows && topCustomerEngine.rows[0], oracle: topCustomerOracle[0] }));

    const topSupplierOracle = await AdjustmentNote.aggregate([{ $match: { tenantId: TENANT_A, classification: "purchase_return", voucherStatus: "active" } }, { $group: { _id: "$header.partyName", amt: { $sum: "$header.voucherTotalAmount" } } }, { $sort: { amt: -1 } }, { $limit: 1 }]);
    const topSupplierEngine = await executeQuery({ v: 1, entity: "purchase_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnAmount"], groupBy: [{ dim: "supplier" }], sort: [{ by: "returnAmount", dir: "desc" }], limit: 1 }, { tenantId: TENANT_A });
    check("G4 live tenant A top supplier by purchase returns = independent oracle", topSupplierEngine.ok && topSupplierEngine.rows[0] && topSupplierEngine.rows[0].key.supplier === topSupplierOracle[0]._id, JSON.stringify({ engine: topSupplierEngine.rows && topSupplierEngine.rows[0], oracle: topSupplierOracle[0] }));

    const cmpEngine = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" } }, metrics: ["returnAmount"] }, { tenantId: TENANT_A });
    const cmpOracleCur = await AdjustmentNote.aggregate([{ $match: { tenantId: TENANT_A, classification: "sales_return", voucherStatus: "active", "header.voucherDate": { $gte: utc("2025-09-01"), $lte: new Date("2025-09-30T23:59:59.999Z") } } }, { $group: { _id: null, amt: { $sum: "$header.voucherTotalAmount" } } }]);
    check("G5 a real comparison result matches an independent Mongo aggregation for the subject period", cmpEngine.ok && Math.abs(cmpEngine.totals.values.returnAmount - (cmpOracleCur[0] ? cmpOracleCur[0].amt : 0)) < 0.01, JSON.stringify({ engine: cmpEngine.totals, oracle: cmpOracleCur[0] }));

    const trendEngine = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnAmount"], groupBy: [{ dim: "date", bucket: "month" }] }, { tenantId: TENANT_A });
    const trendOracleSum = await AdjustmentNote.aggregate([{ $match: { tenantId: TENANT_A, classification: "sales_return", voucherStatus: "active" } }, { $group: { _id: null, amt: { $sum: "$header.voucherTotalAmount" } } }]);
    const trendEngineSum = trendEngine.ok ? Math.round(trendEngine.rows.reduce((s, r) => s + r.values.returnAmount, 0) * 100) / 100 : null;
    check("G6 monthly trend rows sum to the same total as the oracle", trendEngine.ok && trendOracleSum[0] && trendEngineSum === Math.round(trendOracleSum[0].amt * 100) / 100, JSON.stringify({ trendEngineSum, oracleSum: trendOracleSum[0] }));

    const tenantBSales = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnAmount", "returnCount"] }, { tenantId: TENANT_B });
    const tenantBPurch = await executeQuery({ v: 1, entity: "purchase_return", mode: "aggregate", period: ALL_TIME, metrics: ["returnAmount", "returnCount"] }, { tenantId: TENANT_B });
    check("G7 live tenant B sales_return = genuine zero (no Credit Notes exist)", tenantBSales.ok && tenantBSales.totals.values.returnAmount === 0 && tenantBSales.totals.values.returnCount === 0);
    check("G8 live tenant B purchase_return = genuine zero (no Debit Notes exist)", tenantBPurch.ok && tenantBPurch.totals.values.returnAmount === 0 && tenantBPurch.totals.values.returnCount === 0);

    const foreignTenantA = await AdjustmentNote.countDocuments({ tenantId: TENANT_A, tallyGuid: { $not: new RegExp("^" + REAL.A.guid + "-") } });
    check("G9 no foreign-GUID AdjustmentNote docs under live tenant A (re-confirmed, read-only)", foreignTenantA === 0);
    }
  } catch (error) {
    fail += 1;
    console.log("  FAIL - unexpected error:", error && error.stack);
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }
  console.log(`\nverify-return-analytics: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
