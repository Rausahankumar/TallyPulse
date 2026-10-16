/**
 * Sales import pipeline, end to end against MongoDB: importTallySales (the function behind
 * POST /api/import/tally-json) -> resolveTenantContext (Company) -> extractVoucherCollection ->
 * importParsedVouchers -> processSingleVoucher (voucherPersistence.js, Sale model). The background
 * sync worker and "Run Sales Sync Now" (importTallySalesFromTally) end in the same processSingleVoucher.
 *
 * Covers: a multi-voucher file is persisted, the stored document matches the mapper contract, a
 * re-import is idempotent (duplicates, no new documents), a newer AlterID updates in place, the tenant
 * always comes from the Company record (never from the file), two tenants with identical GUIDs and
 * voucher numbers stay separate, and two vouchers sharing a voucher number but not a GUID are never merged.
 *
 * Synthetic data only, isolated test database only (src/config/db.js refuses anything but a loopback
 * tallypulse_ci / tallypulse_test* database). No Tally, no network. Cleans up only its own records.
 *
 * Run: node verify-sales-import.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Company = require("./src/models/company");
const Sale = require("./src/models/sales.model");
const { importTallySales } = require("./src/services/import/tallySalesImport");

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 300)})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);

const TENANT_A = "TEST-TENANT-sales-import-a";
const TENANT_B = "TEST-TENANT-sales-import-b";
const TENANT_INACTIVE = "TEST-TENANT-sales-import-inactive";
const GUID_A = "verify-sales-import-company-a";
const GUID_B = "verify-sales-import-company-b";
const GUID_INACTIVE = "verify-sales-import-company-inactive";
const TENANTS = [TENANT_A, TENANT_B, TENANT_INACTIVE];
const COMPANY_GUIDS = [GUID_A, GUID_B, GUID_INACTIVE];

// Raw-Tally-shaped voucher (same shape as verify-sales-mapper.js): lowercase keys, string amounts.
// The party ledger total (1189) is the voucher total; the inventory subtotal (1009.20) is not.
const raw = ({ no, guid, alter, date = "20260905", partyAmount = "-1189", extra = {} }) => ({
  vouchernumber: no,
  date,
  partyname: "Test Customer",
  vouchertypename: "Sales",
  guid,
  alterid: String(alter),
  narration: "synthetic voucher",
  inventoryentries: [
    { stockitemname: "Item A", actualqty: "6", rate: "151.53", amount: "909.20" },
    { stockitemname: "Item B", actualqty: "2", rate: "50", amount: "100" },
  ],
  ledgerentries: [
    { ledgername: "Test Customer", amount: partyAmount, isdeemedpositive: "Yes" },
    { ledgername: "Sales Account", amount: "1009.20", isdeemedpositive: "No" },
    { ledgername: "CGST", amount: "89.9", isdeemedpositive: "No" },
    { ledgername: "SGST", amount: "89.9", isdeemedpositive: "No" },
  ],
  ...extra,
});

// The JSON text a Tally export would contain, imported exactly as an uploaded file's text would be.
const asFileText = (vouchers) => JSON.stringify({ tallymessage: vouchers });

const salesOf = (tenantId) => Sale.find({ tenantId }).sort({ tallyGuid: 1 }).lean();

async function cleanup() {
  await Sale.deleteMany({ tenantId: { $in: TENANTS } });
  await Company.deleteMany({ companyGuid: { $in: COMPANY_GUIDS } });
}

async function expectThrow(promise, pattern) {
  try {
    await promise;
    return { threw: false, message: null };
  } catch (e) {
    return { threw: pattern.test(e.message), message: e.message };
  }
}

(async () => {
  await connectDB();
  await cleanup();
  try {
    await Company.create([
      { companyName: "Verify Sales Import A", companyGuid: GUID_A, tenantId: TENANT_A, isActive: true },
      { companyName: "Verify Sales Import B", companyGuid: GUID_B, tenantId: TENANT_B, isActive: true },
      { companyName: "Verify Sales Import Inactive", companyGuid: GUID_INACTIVE, tenantId: TENANT_INACTIVE, isActive: false },
    ]);

    const v1 = raw({ no: "SI-1", guid: "vsi-guid-1", alter: 7 });
    const v2 = raw({ no: "SI-2", guid: "vsi-guid-2", alter: 9, date: "20260906", partyAmount: "-500" });

    // ------------------------------------------------------------------ 1
    section("1. a two-voucher file is imported and both vouchers are persisted");
    let r = await importTallySales({ rawData: asFileText([v1, v2]), companyGuId: GUID_A });
    check("summary: total 2, created 2, nothing else", r.total === 2 && r.created === 2 && r.updated === 0 && r.duplicates === 0 && r.skipped === 0 && r.failed === 0, JSON.stringify(r));
    check("summary lists each voucher with status created and a saleId", Array.isArray(r.results) && r.results.length === 2 && r.results.every((x) => x.status === "created" && typeof x.saleId === "string") && r.results.map((x) => x.voucherNo).sort().join(",") === "SI-1,SI-2", JSON.stringify(r.results));
    let docsA = await salesOf(TENANT_A);
    check("exactly two Sale documents exist for tenant A", docsA.length === 2, `found ${docsA.length}`);

    // ------------------------------------------------------------------ 2
    section("2. the stored documents match the mapper/model contract");
    const d1 = docsA.find((d) => d.tallyGuid === "vsi-guid-1");
    const d2 = docsA.find((d) => d.tallyGuid === "vsi-guid-2");
    check("tenant comes from the Company record (tenant A)", d1 && d2 && d1.tenantId === TENANT_A && d2.tenantId === TENANT_A);
    check("Tally identity: tallyGuid and numeric tallyAlterId", d1 && d1.tallyGuid === "vsi-guid-1" && d1.tallyAlterId === 7 && d2.tallyAlterId === 9, JSON.stringify(d1 && { g: d1.tallyGuid, a: d1.tallyAlterId }));
    check("header: voucher number and type", d1 && d1.header.voucherNo === "SI-1" && d1.header.voucherType === "Sales" && d2.header.voucherNo === "SI-2");
    check("voucher date is UTC midnight of the Tally date", d1 && d1.header.voucherDate.toISOString() === "2026-09-05T00:00:00.000Z" && d2.header.voucherDate.toISOString() === "2026-09-06T00:00:00.000Z", d1 && d1.header.voucherDate);
    check("voucherTotalAmount is the party ledger total (1189 / 500), not the inventory subtotal", d1 && d1.header.voucherTotalAmount === 1189 && d2.header.voucherTotalAmount === 500, JSON.stringify(d1 && d1.header));
    check("an ordinary voucher is stored active", d1 && d1.voucherStatus === "active" && d2.voucherStatus === "active");
    check("inventory lines are stored", d1 && Array.isArray(d1.inventory) && d1.inventory.length === 2 && d1.inventory[0].itemName === "Item A");

    // ------------------------------------------------------------------ 3
    section("3. re-importing the same file is idempotent; a newer AlterID updates in place");
    const idsBefore = docsA.map((d) => String(d._id)).sort().join(",");
    r = await importTallySales({ rawData: asFileText([v1, v2]), companyGuId: GUID_A });
    check("same AlterIDs again: reported as 2 duplicates, nothing created or updated", r.total === 2 && r.duplicates === 2 && r.created === 0 && r.updated === 0 && r.failed === 0, JSON.stringify(r));
    docsA = await salesOf(TENANT_A);
    check("still exactly two documents, same _ids", docsA.length === 2 && docsA.map((d) => String(d._id)).sort().join(",") === idsBefore, `found ${docsA.length}`);

    const v1Edited = raw({ no: "SI-1", guid: "vsi-guid-1", alter: 8, partyAmount: "-1300" });
    r = await importTallySales({ rawData: asFileText([v1Edited, v2]), companyGuId: GUID_A });
    check("a newer AlterID for one voucher: 1 updated, 1 duplicate", r.updated === 1 && r.duplicates === 1 && r.created === 0 && r.failed === 0, JSON.stringify(r));
    docsA = await salesOf(TENANT_A);
    const d1After = docsA.find((d) => d.tallyGuid === "vsi-guid-1");
    check("the update is in place: same _id, new AlterID and amount, still two documents", docsA.length === 2 && d1After && String(d1After._id) === String(d1._id) && d1After.tallyAlterId === 8 && d1After.header.voucherTotalAmount === 1300, JSON.stringify(d1After && { a: d1After.tallyAlterId, t: d1After.header.voucherTotalAmount }));

    // A single-voucher file returns the single-result shape (importParsedVouchers' one-voucher branch).
    r = await importTallySales({ rawData: asFileText([raw({ no: "SI-3", guid: "vsi-guid-3", alter: 3 })]), companyGuId: GUID_A });
    check("a one-voucher file returns a single result with status created and a saleId", r.status === "created" && r.created === true && typeof r.saleId === "string" && r.tenantId === TENANT_A, JSON.stringify({ s: r.status, c: r.created, t: r.tenantId }));

    // ------------------------------------------------------------------ 4
    section("4. tenant isolation: the tenant comes only from the Company, never from the file");
    const aSnapshot = JSON.stringify((await salesOf(TENANT_A)).map((d) => [String(d._id), d.tallyGuid, d.tallyAlterId, d.header.voucherTotalAmount, d.tenantId]));
    // Tenant B imports vouchers with the SAME GUIDs and voucher numbers as tenant A, plus a field that
    // claims to be tenant A - the stored tenant must still be B and A must be untouched.
    const spoof = { tenantId: TENANT_A, tenantid: TENANT_A };
    const b1 = raw({ no: "SI-1", guid: "vsi-guid-1", alter: 1, partyAmount: "-111", extra: spoof });
    const b2 = raw({ no: "SI-2", guid: "vsi-guid-2", alter: 1, partyAmount: "-222", extra: spoof });
    r = await importTallySales({ rawData: asFileText([b1, b2]), companyGuId: GUID_B });
    check("tenant B: both vouchers created (A's documents with the same GUIDs are not 'found')", r.created === 2 && r.duplicates === 0 && r.updated === 0 && r.failed === 0, JSON.stringify(r));
    const docsB = await salesOf(TENANT_B);
    check("tenant B has exactly its two documents, stamped tenant B despite the spoofed field", docsB.length === 2 && docsB.every((d) => d.tenantId === TENANT_B) && docsB.map((d) => d.header.voucherTotalAmount).sort((x, y) => x - y).join(",") === "111,222", JSON.stringify(docsB.map((d) => [d.tenantId, d.header.voucherTotalAmount])));
    const aAfter = JSON.stringify((await salesOf(TENANT_A)).map((d) => [String(d._id), d.tallyGuid, d.tallyAlterId, d.header.voucherTotalAmount, d.tenantId]));
    check("tenant A's documents are byte-for-byte unchanged by tenant B's import", aAfter === aSnapshot, aAfter);
    check("each shared GUID now exists exactly once per tenant", (await Sale.countDocuments({ tallyGuid: "vsi-guid-1", tenantId: { $in: [TENANT_A, TENANT_B] } })) === 2);

    let t = await expectThrow(importTallySales({ rawData: asFileText([v1]), companyGuId: "verify-sales-import-no-such-company" }), /Company not found/);
    check("an unknown company GUID is refused before anything is written", t.threw, t.message);
    t = await expectThrow(importTallySales({ rawData: asFileText([v1]), companyGuId: GUID_INACTIVE }), /Company is inactive/);
    check("an inactive company is refused", t.threw, t.message);
    check("...and the refused imports wrote nothing for the inactive tenant", (await Sale.countDocuments({ tenantId: TENANT_INACTIVE })) === 0);

    // ------------------------------------------------------------------ 5
    section("5. voucher identity: same voucher number, different GUID -> two documents");
    const dupNo1 = raw({ no: "SI-DUP", guid: "vsi-guid-dup-1", alter: 5 });
    const dupNo2 = raw({ no: "SI-DUP", guid: "vsi-guid-dup-2", alter: 6, partyAmount: "-42" });
    r = await importTallySales({ rawData: asFileText([dupNo1, dupNo2]), companyGuId: GUID_A });
    check("both created, not merged into one", r.created === 2 && r.updated === 0 && r.duplicates === 0 && r.failed === 0, JSON.stringify(r));
    const dupDocs = await Sale.find({ tenantId: TENANT_A, "header.voucherNo": "SI-DUP" }).lean();
    check("two documents share voucher number SI-DUP, one per GUID", dupDocs.length === 2 && new Set(dupDocs.map((d) => d.tallyGuid)).size === 2, JSON.stringify(dupDocs.map((d) => d.tallyGuid)));
    r = await importTallySales({ rawData: asFileText([dupNo1, dupNo2]), companyGuId: GUID_A });
    check("re-importing them: 2 duplicates, still two documents", r.duplicates === 2 && r.created === 0 && (await Sale.countDocuments({ tenantId: TENANT_A, "header.voucherNo": "SI-DUP" })) === 2, JSON.stringify(r));

    // ------------------------------------------------------------------ 6
    section("6. malformed input fails loudly and writes nothing");
    const countA = await Sale.countDocuments({ tenantId: TENANT_A });
    t = await expectThrow(importTallySales({ rawData: "{ not json", companyGuId: GUID_A }), /Invalid JSON in Tally file/);
    check("invalid JSON text is refused with a clear message", t.threw, t.message);
    t = await expectThrow(importTallySales({ rawData: JSON.stringify({ tallymessage: [] }), companyGuId: GUID_A }), /No Tally voucher data found/);
    check("an empty voucher list is refused", t.threw, t.message);
    check("...and tenant A's document count is unchanged", (await Sale.countDocuments({ tenantId: TENANT_A })) === countA);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL - unexpected error: ${e && e.stack ? e.stack : e}`);
  } finally {
    await cleanup();
    await mongoose.connection.close();
  }
  console.log(`\nverify-sales-import: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});
