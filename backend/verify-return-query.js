/**
 * Sales/purchase return query capability (LedgerMaster phase follow-on):
 * the sales_return/purchase_return catalog entities end-to-end against real
 * synthetic AdjustmentNote documents (engine vs a hand-computed oracle).
 * (Phrasing -> plan is the planner's job; see verify-query-planner.js.)
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
