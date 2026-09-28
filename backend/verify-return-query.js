/**
 * Sales/purchase return query capability (LedgerMaster phase follow-on):
 * router phrasing (routeReturnQuestion in localRouter.js) and the
 * sales_return/purchase_return catalog entities end-to-end against real
 * synthetic AdjustmentNote documents (engine vs a hand-computed oracle).
 *
 * Complements verify-adjustment-note.js (sync pipeline) and
 * verify-query-engine.js/verify-query-dsl.js (unaffected regression,
 * already re-run for this phase). Synthetic tenant only.
 *
 * Run: node verify-return-query.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const AdjustmentNote = require("./src/models/adjustmentNote.model");
const { routeQuestion } = require("./src/services/query/localRouter");
const { createEntityResolver } = require("./src/services/query/entityResolver");
const { executeQuery } = require("./src/services/query/execute");

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

const T1 = "TEST-TENANT-return-query";
const REF = new Date(2025, 9, 20, 12, 0, 0); // 20 Oct 2025, local noon

const resolver = createEntityResolver({ tenantId: "TEST-TENANT", sources: { customer: async () => [], supplier: async () => [], product: async () => [], productGroup: async () => [] } });
const route = (q) => routeQuestion(q, { resolveEntity: resolver, referenceDate: REF });

const utc = (s) => new Date(`${s}T00:00:00.000Z`);
let seq = 0;
function note({ noteType, classification, party, amount, date, status = "active" }) {
  seq += 1;
  return {
    tenantId: T1,
    companyGuid: "gggggggg-return-query",
    header: { voucherNo: `RQ-${seq}`, voucherDate: utc(date), voucherType: noteType === "credit" ? "Credit Note" : "Debit Note", voucherTotalAmount: amount, narration: "", partyName: party },
    noteType,
    classification,
    inventory: [{ itemName: "Item", quantity: 1, rate: amount, amount, accountingAllocationLedger: noteType === "credit" ? "Sales Return AC" : "Purchase Return AC" }],
    ledgers: [],
    tallyGuid: `gggggggg-return-query-n${seq}`,
    tallyAlterId: seq,
    voucherStatus: status,
  };
}

async function cleanup() {
  await AdjustmentNote.deleteMany({ tenantId: T1 });
}

(async () => {
  await connectDB();
  await cleanup();
  try {
    // ============================================================ ROUTER
    section("ROUTER: routeReturnQuestion phrasings");
    const supportedPlan = async (q) => {
      const r = await route(q);
      return r.status === "supported" ? r.plan : `${r.status}/${r.code}`;
    };

    check("total sales return amount, explicit month+year", same(await supportedPlan("How much sales return did we have in August 2025?"), { v: 1, entity: "sales_return", mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, metrics: ["returnAmount"] }));
    check("total purchase return amount, last month", same(await supportedPlan("What were our purchase returns last month?"), { v: 1, entity: "purchase_return", mode: "aggregate", period: { kind: "previous_month" }, metrics: ["returnAmount"] }));
    check("this quarter", same(await supportedPlan("Show sales returns this quarter"), { v: 1, entity: "sales_return", mode: "aggregate", period: { kind: "current_quarter" }, metrics: ["returnAmount"] }));
    check('"vs last month" applies decision 2 (MTD vs complete previous month)', same(await supportedPlan("sales returns this month vs last month"), { v: 1, entity: "sales_return", mode: "aggregate", period: { kind: "current_month" }, metrics: ["returnAmount"], compare: { mode: "full_previous" } }));
    check('"how many" -> returnCount', same(await supportedPlan("How many purchase returns this month?"), { v: 1, entity: "purchase_return", mode: "aggregate", period: { kind: "current_month" }, metrics: ["returnCount"] }));
    check("by customer -> grouped + sorted", same(await supportedPlan("sales returns by customer this month"), { v: 1, entity: "sales_return", mode: "aggregate", period: { kind: "current_month" }, metrics: ["returnAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "returnAmount", dir: "desc" }] }));
    check("by supplier -> grouped on purchase_return", same(await supportedPlan("purchase returns by supplier this month"), { v: 1, entity: "purchase_return", mode: "aggregate", period: { kind: "current_month" }, metrics: ["returnAmount"], groupBy: [{ dim: "supplier" }], sort: [{ by: "returnAmount", dir: "desc" }] }));

    for (const [q, wantCode] of [
      // "Which products were returned the most?" and "sales returns by product this month" are now
      // SUPPORTED (Product-Level Return Analytics phase) - see verify-product-return-analytics.js.
      ["most returned products this month", "net_of_returns"], // no direction word at all - stays ambiguous, refused
      ["return reasons this month", "net_of_returns"],
      ["what is our return rate this month", "net_of_returns"],
      ["net sales after returns this month", "net_of_returns"],
      ["partial returns this month", "net_of_returns"],
      ["GST impact of sales returns this month", "unsupported_return_detail"], // "sales returns" gives a direction, then GST is refused specifically
      ["credit notes this month", "net_of_returns"],
      ["sales returns and purchase returns this month", "return_direction_ambiguous"],
    ]) {
      const r = await route(q);
      const got = r.code === "unsupported_capability" ? r.capability : r.code;
      check(`"${q}" -> unsupported/${wantCode}`, r.status === "unsupported" && got === wantCode, `${r.status}/${r.code}/${r.capability}`);
    }
    {
      const r = await route("sales returns");
      check('"sales returns" with no period -> needs_planner/period_missing', r.status === "needs_planner" && r.code === "period_missing", `${r.status}/${r.code}`);
    }
    {
      // "returning customers" (reactivation wording) must NOT be caught by "customer returns?" (word order differs).
      const r = await route("returning customers this quarter");
      check("'returning customers' (reactivation) is unaffected by the return branch", r.status === "unsupported" && r.code === "unsupported_reactivation", `${r.status}/${r.code}`);
    }

    // ============================================================ ENGINE
    section("ENGINE: sales_return/purchase_return vs a hand-computed oracle");
    await AdjustmentNote.insertMany([
      note({ noteType: "credit", classification: "sales_return", party: "Alpha", amount: 100, date: "2025-10-05" }),
      note({ noteType: "credit", classification: "sales_return", party: "Alpha", amount: 50, date: "2025-10-15" }),
      note({ noteType: "credit", classification: "sales_return", party: "Beta", amount: 30, date: "2025-10-20" }),
      note({ noteType: "credit", classification: "value_adjustment", party: "Alpha", amount: 9999, date: "2025-10-10" }), // must NEVER be counted
      note({ noteType: "credit", classification: "sales_return", party: "Alpha", amount: 8888, date: "2025-10-10", status: "cancelled" }), // must NEVER be counted
      note({ noteType: "credit", classification: "sales_return", party: "Gamma", amount: 20, date: "2025-09-25" }), // outside period
      note({ noteType: "debit", classification: "purchase_return", party: "Supplier1", amount: 70, date: "2025-10-08" }),
      note({ noteType: "debit", classification: "value_adjustment", party: "Supplier1", amount: 7777, date: "2025-10-08" }), // must NEVER be counted
    ]);

    const OCT = { kind: "custom", from: "2025-10-01", to: "2025-10-31" };
    let res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: OCT, metrics: ["returnAmount", "returnCount"] }, { tenantId: T1 });
    check("total sales_return amount = 180 (100+50+30), excludes value_adjustment/cancelled/outside-period", res.ok && res.totals.values.returnAmount === 180 && res.totals.values.returnCount === 3, JSON.stringify(res.totals || res.errors));

    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: OCT, metrics: ["returnAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "returnAmount", dir: "desc" }] }, { tenantId: T1 });
    check("by customer = oracle [Alpha 150, Beta 30]", res.ok && same(res.rows.map((r) => [r.key.customer, r.values.returnAmount]), [["Alpha", 150], ["Beta", 30]]), JSON.stringify(res.rows || res.errors));

    res = await executeQuery({ v: 1, entity: "purchase_return", mode: "aggregate", period: OCT, metrics: ["returnAmount"] }, { tenantId: T1 });
    check("purchase_return total = 70, excludes the value_adjustment debit note", res.ok && res.totals.values.returnAmount === 70, JSON.stringify(res.totals || res.errors));

    // A tampered plan cannot widen the forced classification match - forcedMatch is baked into the pipeline,
    // never sourced from plan.filters (there is no classification filter dimension at all).
    const { parseQueryPlan } = require("./src/services/query/queryPlan.schema");
    const parsed = parseQueryPlan({ v: 1, entity: "sales_return", mode: "aggregate", period: OCT, metrics: ["returnAmount"] });
    check("classification is not an exposed/filterable dimension", !parsed.ok || !("classification" in (require("./src/services/query/semanticCatalog").CATALOG.dimensions)));

    res = await executeQuery({ v: 1, entity: "sales_return", mode: "aggregate", period: OCT, metrics: ["returnAmount"] }, { tenantId: "TEST-TENANT-return-query-OTHER" });
    check("tenant isolation: a different tenant sees zero", res.ok && res.totals.values.returnAmount === 0);
  } catch (error) {
    fail += 1;
    console.log("  FAIL - unexpected error:", error && error.stack);
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }
  console.log(`\nverify-return-query: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
