/**
 * Regression tests for the Stock Item -> Stock Group master layer
 * (Part 2 of the Stock Group analytics foundation):
 *   - stockItemMaster.js's parsing (reuses voucherTypeClassifier's
 *     parseVoucherTypeMasterList - proven to work on this exact shape
 *     against a real, live TallyPrime instance, see the investigation
 *     report)
 *   - Stock Group extraction from Tally's own $Parent
 *   - missing-Parent / malformed-record handling
 *   - company GUID ownership validation (validateMasterOwnership, reused
 *     unchanged from companyOwnership.js) and foreign-company rejection
 *   - tenant-aware persistence into StockItemMaster, including the
 *     same item name existing under two different tenants without
 *     collision
 *
 * Synthetic fixtures only, built to the EXACT shape confirmed live in
 * this project's own Tally-verification investigation
 * ({status, data:{collection:[{metadata:{name}, guid:{value}, parent:{value}}]}}).
 * No live Tally connection required to run this suite (refreshStockItemMasters'
 * `fetcher` is injected). Writes to MongoDB use clearly-synthetic tenant
 * ids (never WE FOUR / Nirmal), and are deleted again at the end -
 * never a production write left behind.
 *
 * Run: node verify-stock-item-master.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const StockItemMaster = require("./src/models/stockItemMaster.model");
const { parseStockItemMasterList, findUnusableStockItemEntries, refreshStockItemMasters } = require("./src/services/tally/stockItemMaster");
const { validateMasterOwnership } = require("./src/services/tally/companyOwnership");

let pass = 0;
let fail = 0;

function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}

// Matches the exact shape empirically confirmed against a real,
// connected TallyPrime instance for "Type": "StockItem",
// "Native Method": "Name, Parent, Guid".
function stockItemRecord({ name, parent, guid }) {
  const record = { metadata: { type: "Stock Item", name: name ?? "", reservedname: "" } };
  if (guid !== undefined) record.guid = { type: "String", value: guid };
  if (parent !== undefined) record.parent = { type: "String", value: parent };
  return record;
}

function tallyResponse(collection) {
  return { status: "1", data: { metadata: {}, collection } };
}

const COMPANY_A_GUID = "d46f1002-00d9-4559-b3e1-afcf8674c7b1"; // real WE FOUR guid, used only as a realistic PREFIX shape - no real data touched
const COMPANY_B_GUID = "09f68f6a-ace7-4ab4-bee8-ddea59ad0731"; // real Nirmal guid, same reasoning

console.log("=== 1. Stock Item response parsing ===");
{
  const response = tallyResponse([
    stockItemRecord({ name: "FEVICOL MR", parent: "Fevikwik", guid: `${COMPANY_A_GUID}-00000001` }),
    stockItemRecord({ name: "TATA SALT", parent: "Grocery", guid: `${COMPANY_A_GUID}-00000002` }),
  ]);
  const items = parseStockItemMasterList(response);
  check("parse-count", "parses the correct number of records", items.length, 2);
  check("parse-fields", "each record maps to {itemName, stockGroupName, tallyGuid}",
    items[0], { itemName: "FEVICOL MR", stockGroupName: "Fevikwik", tallyGuid: `${COMPANY_A_GUID}-00000001` });
}

console.log("\n=== 2. Stock Group extraction from $Parent ===");
{
  const response = tallyResponse([
    stockItemRecord({ name: "3M Command Hook", parent: "3M Command", guid: `${COMPANY_A_GUID}-00000003` }),
  ]);
  const items = parseStockItemMasterList(response);
  check("group-from-parent", "stockGroupName comes from Tally's own $Parent verbatim, never renamed/generalized",
    items[0].stockGroupName, "3M Command");
}

console.log("\n=== 3. Missing Parent handling ===");
{
  const response = tallyResponse([
    stockItemRecord({ name: "Has Group", parent: "Adhesives", guid: `${COMPANY_A_GUID}-00000004` }),
    stockItemRecord({ name: "No Group At All", guid: `${COMPANY_A_GUID}-00000005` }), // parent field absent entirely
    stockItemRecord({ name: "Empty Group String", parent: "", guid: `${COMPANY_A_GUID}-00000006` }),
  ]);
  const items = parseStockItemMasterList(response);
  check("missing-parent-excluded", "items with no usable Parent are excluded from the usable list (never assigned a fabricated group)",
    items.map((i) => i.itemName), ["Has Group"]);

  const unusable = findUnusableStockItemEntries(response);
  check("missing-parent-reported", "excluded items are still reported (visible, not silently dropped)",
    unusable.length, 2);
}

console.log("\n=== 4. Malformed Stock Item handling ===");
{
  const response = tallyResponse([
    stockItemRecord({ name: "Valid Item", parent: "Stationery", guid: `${COMPANY_A_GUID}-00000007` }),
    stockItemRecord({ parent: "Orphan Group", guid: `${COMPANY_A_GUID}-00000008` }), // no name at all
    stockItemRecord({ name: "No Guid Item", parent: "Some Group" }), // guid field absent entirely
    { metadata: {} }, // completely malformed / empty record
  ]);
  const items = parseStockItemMasterList(response);
  check("malformed-records-excluded", "malformed records (no name, no guid, empty) are excluded, not partially trusted",
    items.map((i) => i.itemName), ["Valid Item"]);
  check("malformed-does-not-throw", "a malformed collection doesn't crash parsing - it's excluded, not fatal", true, true);
}
{
  // A non-array/garbage response must parse to an empty, safe list, not throw.
  const items = parseStockItemMasterList({ status: "1", data: {} });
  check("garbage-response-safe", "a response with no collection array parses to an empty list, not an error", items, []);
}

console.log("\n=== 5. Company GUID ownership validation ===");
{
  const response = tallyResponse([
    stockItemRecord({ name: "Item 1", parent: "Group A", guid: `${COMPANY_A_GUID}-00000009` }),
    stockItemRecord({ name: "Item 2", parent: "Group B", guid: `${COMPANY_A_GUID}-0000000a` }),
  ]);
  const raw = parseStockItemMasterList(response); // has {tallyGuid} not {guid} - use the shared parser's own field name for ownership check
  const rawForOwnership = raw.map((i) => ({ guid: i.tallyGuid }));
  const ownership = validateMasterOwnership(rawForOwnership, COMPANY_A_GUID);
  check("ownership-passes-for-own-company", "records whose guid is prefixed with the trusted company GUID pass ownership validation",
    ownership.ok, true);
  check("ownership-verified-count", "every record is counted as verified", ownership.verified, 2);
}

console.log("\n=== 6. Foreign-company rejection ===");
{
  const response = tallyResponse([
    stockItemRecord({ name: "Item 1", parent: "Group A", guid: `${COMPANY_A_GUID}-0000000b` }),
    stockItemRecord({ name: "Foreign Item", parent: "Group X", guid: `${COMPANY_B_GUID}-0000000c` }), // wrong company's guid
  ]);
  const raw = parseStockItemMasterList(response);
  const rawForOwnership = raw.map((i) => ({ guid: i.tallyGuid }));
  const ownership = validateMasterOwnership(rawForOwnership, COMPANY_A_GUID);
  check("foreign-record-rejects-whole-batch", "even ONE foreign-company record rejects the whole batch (fail closed, not partial accept)",
    ownership.ok, false);
  check("foreign-count-reported", "the foreign record is counted and reported", ownership.foreign, 1);
}

// ---------------------------------------------------------------
// 7 & 8: tenant-aware persistence - real (but synthetic, cleaned-up)
// MongoDB writes via the full refreshStockItemMasters flow, with a
// fake `fetcher` standing in for live Tally.
// ---------------------------------------------------------------

const TENANT_A = "TEST-TENANT-A-stockitem-verify";
const TENANT_B = "TEST-TENANT-B-stockitem-verify";

async function cleanupSyntheticData() {
  await StockItemMaster.deleteMany({ tenantId: { $in: [TENANT_A, TENANT_B] } });
}

async function runPersistenceTests() {
  console.log("\n=== 7. Tenant-aware persistence ===");

  const fakeFetcherA = async () => tallyResponse([
    stockItemRecord({ name: "Shared Item Name", parent: "Group Alpha", guid: `${COMPANY_A_GUID}-10000001` }),
    stockItemRecord({ name: "Only In Tenant A", parent: "Group Beta", guid: `${COMPANY_A_GUID}-10000002` }),
  ]);

  const resultA = await refreshStockItemMasters({
    tenantId: TENANT_A,
    companyGuid: COMPANY_A_GUID,
    fetcher: fakeFetcherA,
  });

  check("persist-a-ok", "refresh for tenant A succeeds", resultA.ok, true);
  check("persist-a-written-count", "writes exactly the 2 usable items", resultA.usable, 2);

  const docsA = await StockItemMaster.find({ tenantId: TENANT_A }).lean();
  check("persist-a-doc-count", "exactly 2 documents exist for tenant A", docsA.length, 2);

  const sharedDocA = docsA.find((d) => d.itemName === "Shared Item Name");
  check("persist-a-tenant-tagged", "every persisted document carries the correct tenantId", sharedDocA.tenantId, TENANT_A);
  check("persist-a-group-correct", "the persisted stockGroupName matches Tally's $Parent exactly", sharedDocA.stockGroupName, "Group Alpha");

  console.log("\n=== 8. Same item name across two tenants ===");

  const fakeFetcherB = async () => tallyResponse([
    // SAME itemName as tenant A's "Shared Item Name", but a DIFFERENT
    // Stock Group and a DIFFERENT (company B) guid - a real scenario:
    // two unrelated businesses both happen to sell a same-named product.
    stockItemRecord({ name: "Shared Item Name", parent: "Completely Different Group", guid: `${COMPANY_B_GUID}-20000001` }),
  ]);

  const resultB = await refreshStockItemMasters({
    tenantId: TENANT_B,
    companyGuid: COMPANY_B_GUID,
    fetcher: fakeFetcherB,
  });

  check("persist-b-ok", "refresh for tenant B succeeds independently", resultB.ok, true);

  const docsB = await StockItemMaster.find({ tenantId: TENANT_B }).lean();
  check("persist-b-doc-count", "exactly 1 document exists for tenant B", docsB.length, 1);
  check("persist-b-group-independent", "tenant B's document for the SAME item name has its OWN, different group - no collision with tenant A",
    docsB[0].stockGroupName, "Completely Different Group");

  // The critical invariant the task explicitly calls out: a lookup MUST
  // be tenant-aware (tenantId AND itemName), never itemName alone.
  const byNameOnly = await StockItemMaster.find({ itemName: "Shared Item Name" }).lean();
  check("same-name-both-tenants-coexist", "both tenants' documents for the same item name coexist without overwriting each other",
    byNameOnly.length, 2);

  const wrongJoin = byNameOnly.filter((d) => d.tenantId === TENANT_A);
  check("tenant-scoped-join-isolates-correctly", "filtering by {tenantId: A, itemName} returns ONLY tenant A's group, never tenant B's",
    wrongJoin.length === 1 && wrongJoin[0].stockGroupName === "Group Alpha", true);

  // Re-running the refresh (idempotency) must not create duplicates.
  const resultARerun = await refreshStockItemMasters({
    tenantId: TENANT_A,
    companyGuid: COMPANY_A_GUID,
    fetcher: fakeFetcherA,
  });
  const docsAAfterRerun = await StockItemMaster.find({ tenantId: TENANT_A }).lean();
  check("persist-idempotent", "re-running the refresh with identical data does not create duplicate documents",
    docsAAfterRerun.length, 2);
  check("persist-rerun-ok", "the re-run itself reports success", resultARerun.ok, true);

  console.log("\n=== Fail-closed: foreign-company response never writes/clears anything ===");

  const fakeFetcherForeign = async () => tallyResponse([
    stockItemRecord({ name: "Should Never Be Written", parent: "Nope", guid: `${COMPANY_B_GUID}-30000001` }), // wrong company for tenant A
  ]);

  const beforeCount = await StockItemMaster.countDocuments({ tenantId: TENANT_A });
  const resultForeign = await refreshStockItemMasters({
    tenantId: TENANT_A,
    companyGuid: COMPANY_A_GUID, // trusted guid for tenant A, but the fetcher returns company B's data
    fetcher: fakeFetcherForeign,
  });
  const afterCount = await StockItemMaster.countDocuments({ tenantId: TENANT_A });

  check("foreign-fetch-fails-closed", "a foreign-company response is rejected, not accepted", resultForeign.ok, false);
  check("foreign-fetch-writes-nothing", "a rejected foreign-company response writes zero new documents", resultForeign.written, 0);
  check("foreign-fetch-does-not-clear-existing", "existing valid data for the tenant is completely untouched by the rejected attempt",
    afterCount, beforeCount);
}

async function main() {
  await connectDB();
  await cleanupSyntheticData(); // start from a clean slate in case a prior run was interrupted

  try {
    await runPersistenceTests();
  } finally {
    await cleanupSyntheticData(); // never leave synthetic test data behind
  }

  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { await cleanupSyntheticData(); await mongoose.disconnect(); } catch { /* best-effort cleanup on failure */ }
  process.exit(1);
});
