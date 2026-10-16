/**
 * Credit Note / Debit Note -> AdjustmentNote pipeline (LedgerMaster phase
 * follow-on). Sections: PARSE (adjustmentNoteParser, pure), CLASSIFY
 * (adjustmentNoteClassifier, pure + one Mongo lookup), MODEL (schema),
 * PERSISTENCE (idempotency/tombstone/ambiguity/tenant isolation, real
 * Mongo), SYNC/SECURITY (runSyncForCompanyModule end-to-end against a
 * local Tally-shaped HTTP stub - ownership rejection, checkpoint behavior,
 * minimal-field requests - mirrors verify-sync-batching.js's pattern).
 *
 * Fixtures match the exact raw shape confirmed live in the CN/DN
 * diagnostic (accountingallocations, billallocations, wrapped Logical
 * values) - see docs/../generic-tumbling-magpie.md sections 2-3. All
 * synthetic: no real tenant/company/party names or GUIDs.
 *
 * Run: node verify-adjustment-note.js
 */

require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const AdjustmentNote = require("./src/models/adjustmentNote.model");
const LedgerMaster = require("./src/models/ledgerMaster.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");

const { parseAdjustmentNoteVoucher } = require("./src/services/parser/adjustmentNoteParser");
const { mapAdjustmentNote } = require("./src/services/mapper/adjustmentNoteMapper");
const { classifyAdjustmentNote, resolveAccountRoles, reclassifyAdjustmentNotes } = require("./src/services/tally/adjustmentNoteClassifier");
const { createAdjustmentNotePersistence } = require("./src/services/sync/adjustmentNotePersistence");
const { runSyncForCompanyModule, CREDIT_NOTE_SYNC_MODULE, DEBIT_NOTE_SYNC_MODULE } = require("./src/services/sync/tallySyncWorker");
const { clearVoucherTypeClassificationCache } = require("./src/services/tally/voucherTypeClassifier");

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

const T1 = "TEST-TENANT-adj-note-1";
const T2 = "TEST-TENANT-adj-note-2";
const G1 = "gggggggg-1111-2222-3333-444444444444";
const G2 = "gggggggg-5555-6666-7777-888888888888";

const T3 = "verify-adjnote-reclassify-tenant";
const T3_OTHER = "verify-adjnote-reclassify-other";
// Separate tenant that reuses T1's voucher GUIDs: proves a cancellation for T1 never touches it.
const T_ISO = "TEST-TENANT-adj-note-isolation";

async function cleanup() {
  const ids = { $in: [T1, T2, T3, T3_OTHER, T_ISO] };
  await Promise.all([AdjustmentNote.deleteMany({ tenantId: ids }), LedgerMaster.deleteMany({ tenantId: ids }), SyncCheckpoint.deleteMany({ tenantId: ids })]);
}

// ---------------------------------------------------------------- raw voucher fixture (matches the diagnostic's confirmed shape)
function rawNote({ i, alter, noteType, party = "Test Party", partyLedgerAmount = -1000, lines, agstRef = null, cancelled = false, deleted = false, companyGuid = G1 }) {
  const guid = `${companyGuid}-note${i}`;
  return {
    metadata: { type: "Voucher", vchtype: noteType === "credit" ? "Credit Note" : "Debit Note" },
    date: "20250910",
    vouchernumber: `NOTE-${i}`,
    vouchertypename: noteType === "credit" ? "Credit Note" : "Debit Note",
    partyname: party,
    partyledgername: party,
    guid,
    alterid: String(alter),
    iscancelled: cancelled,
    isdeleted: deleted,
    inventoryentries: lines.map((l, idx) => ({
      stockitemname: l.itemName,
      actualqty: `${l.quantity} Pcs`,
      rate: `${l.rate}/Pcs`,
      amount: String(l.amount),
      accountingallocations: l.allocations === undefined ? [{ ledgername: l.accountLedger, amount: String(l.amount) }] : l.allocations,
    })),
    ledgerentries: [
      {
        ledgername: party,
        amount: String(partyLedgerAmount),
        isdeemedpositive: { type: "Logical", value: partyLedgerAmount >= 0 },
        ispartyledger: true,
        billallocations: agstRef ? [{ name: agstRef, billtype: "Agst Ref", amount: String(partyLedgerAmount) }] : [{ name: "", billtype: "New Ref", amount: String(partyLedgerAmount) }],
      },
      // The counter-ledger entry needs a line to name it; a sparse fixture (lines: []) has none, so it gets only the party entry.
      ...(lines.length ? [{ ledgername: lines[0].accountLedger, amount: String(-partyLedgerAmount), isdeemedpositive: { type: "Logical", value: partyLedgerAmount < 0 }, ispartyledger: false }] : []),
    ],
  };
}

(async () => {
  await connectDB();
  await cleanup();
  try {
    // ============================================================ PARSE
    section("PARSE: adjustmentNoteParser (pure)");
    const cn = rawNote({ i: 1, alter: 501, noteType: "credit", lines: [{ itemName: "Item A", quantity: 10, rate: 55, amount: -466.13, accountLedger: "Sales Return AC" }], agstRef: "INV-100" });
    const p1 = parseAdjustmentNoteVoucher(cn);
    check("header parsed", p1.header.voucherNo === "NOTE-1" && p1.header.voucherDate.toISOString() === "2025-09-10T00:00:00.000Z" && p1.header.partyName === "Test Party" && p1.header.voucherType === "Credit Note");
    check("voucherTotalAmount from the party ledger (abs)", p1.header.voucherTotalAmount === 1000);
    check("inventory line resolves its single accounting-allocation ledger", p1.inventory[0].accountingAllocationLedger === "Sales Return AC");
    check("Agst Ref bill allocation becomes originalVoucherNumber", p1.originalVoucherNumber === "INV-100");
    check("sync flags", p1.sync.guid === `${G1}-note1` && p1.sync.alterId === 501 && p1.sync.isCancelled === false);

    const noRef = rawNote({ i: 2, alter: 502, noteType: "credit", lines: [{ itemName: "Item A", quantity: 1, rate: 10, amount: -10, accountLedger: "Sales Return AC" }] });
    check("no Agst Ref -> originalVoucherNumber null (never inferred)", parseAdjustmentNoteVoucher(noRef).originalVoucherNumber === null);

    const split = rawNote({ i: 3, alter: 503, noteType: "credit", lines: [{ itemName: "Item A", quantity: 1, rate: 10, amount: -10, accountLedger: null, allocations: [{ ledgername: "L1", amount: "-5" }, { ledgername: "L2", amount: "-5" }] }] });
    check("a split accounting allocation (>1 ledger) resolves to null, never guessed", parseAdjustmentNoteVoucher(split).inventory[0].accountingAllocationLedger === null);

    let threw = false;
    try { parseAdjustmentNoteVoucher("not an object"); } catch (e) { threw = true; }
    check("non-object voucher throws", threw);

    // ============================================================ CLASSIFY
    section("CLASSIFY: adjustmentNoteClassifier (pure + LedgerMaster lookup)");
    await LedgerMaster.insertMany([
      { tenantId: T1, companyGuid: G1, ledgerGuid: `${G1}-la1`, name: "Sales Return AC", parentGroup: "Sales Accounts", partyRole: "other", accountRole: "sales_accounts", syncedAt: new Date() },
      { tenantId: T1, companyGuid: G1, ledgerGuid: `${G1}-la2`, name: "Purchase Return AC", parentGroup: "Purchase Accounts", partyRole: "other", accountRole: "purchase_accounts", syncedAt: new Date() },
      { tenantId: T1, companyGuid: G1, ledgerGuid: `${G1}-la3`, name: "Freight Ledger", parentGroup: "Indirect Expenses", partyRole: "other", accountRole: "other", syncedAt: new Date() },
      { tenantId: T1, companyGuid: G1, ledgerGuid: `${G1}-la4`, name: "Dup Ledger", parentGroup: "Sales Accounts", partyRole: "other", accountRole: "sales_accounts", syncedAt: new Date() },
      { tenantId: T1, companyGuid: G1, ledgerGuid: `${G1}-la5`, name: "Dup Ledger", parentGroup: "Sales Accounts", partyRole: "other", accountRole: "sales_accounts", syncedAt: new Date() },
    ]);
    const roles = await resolveAccountRoles(T1, ["Sales Return AC", "Purchase Return AC", "Freight Ledger", "Dup Ledger", "Unknown Ledger"]);
    check("resolveAccountRoles reads sales_accounts/purchase_accounts/other", roles.get("Sales Return AC") === "sales_accounts" && roles.get("Purchase Return AC") === "purchase_accounts" && roles.get("Freight Ledger") === "other");
    check("an unknown ledger resolves to other (never guessed)", roles.get("Unknown Ledger") === "other");
    check("a ledger name shared by two ledgers resolves to other, never one of the two", roles.get("Dup Ledger") === "other");

    const pv = (accountLedger, noteType = "credit") => ({ inventory: [{ itemName: "X", quantity: 1, rate: 1, amount: 1, accountingAllocationLedger: accountLedger }] });
    check("credit + Sales Accounts line -> sales_return", classifyAdjustmentNote(pv("Sales Return AC"), "credit", roles) === "sales_return");
    check("debit + Purchase Accounts line -> purchase_return", classifyAdjustmentNote(pv("Purchase Return AC", "debit"), "debit", roles) === "purchase_return");
    check("credit + non-Sales-Accounts line -> value_adjustment (never guessed)", classifyAdjustmentNote(pv("Freight Ledger"), "credit", roles) === "value_adjustment");
    check("debit + Sales Accounts line (wrong pattern) -> value_adjustment, not purchase_return", classifyAdjustmentNote(pv("Sales Return AC", "debit"), "debit", roles) === "value_adjustment");
    check("credit + unresolved allocation ledger (null) -> value_adjustment", classifyAdjustmentNote(pv(null), "credit", roles) === "value_adjustment");
    check("no inventory at all -> unclassified (pure ledger adjustment)", classifyAdjustmentNote({ inventory: [] }, "credit", roles) === "unclassified");
    const mixed = { inventory: [{ itemName: "A", accountingAllocationLedger: "Sales Return AC" }, { itemName: "B", accountingAllocationLedger: "Freight Ledger" }] };
    check("mixed lines (one matching, one not) -> value_adjustment, not a partial return", classifyAdjustmentNote(mixed, "credit", roles) === "value_adjustment");

    // ============================================================ MODEL
    section("MODEL: mapAdjustmentNote + schema");
    const mapped = mapAdjustmentNote(p1, { tenantId: T1, companyGuid: G1, noteType: "credit", classification: "sales_return" });
    check("mapped doc carries tenant/company/noteType/classification/originalVoucherNumber", mapped.tenantId === T1 && mapped.companyGuid === G1 && mapped.noteType === "credit" && mapped.classification === "sales_return" && mapped.originalVoucherNumber === "INV-100");
    check("cancelled parsed voucher maps to voucherStatus cancelled", mapAdjustmentNote({ ...p1, sync: { ...p1.sync, isCancelled: true } }, { tenantId: T1, companyGuid: G1, noteType: "credit", classification: "sales_return" }).voucherStatus === "cancelled");
    for (const bad of [{ tenantId: null }, { companyGuid: null }, { noteType: "refund" }, { classification: null }]) {
      let mThrew = false;
      try { mapAdjustmentNote(p1, { tenantId: T1, companyGuid: G1, noteType: "credit", classification: "sales_return", ...bad }); } catch (e) { mThrew = true; }
      check(`mapAdjustmentNote refuses to guess a missing/invalid ${Object.keys(bad)[0]}`, mThrew);
    }
    const doc = new AdjustmentNote(mapped);
    let validateErr = null;
    try { await doc.validate(); } catch (e) { validateErr = e; }
    check("a fully mapped doc validates against the schema", validateErr === null, validateErr && validateErr.message);

    // ============================================================ PERSISTENCE
    section("PERSISTENCE: createAdjustmentNotePersistence (idempotency, tombstones, tenant isolation)");
    const { processSingleAdjustmentNoteVoucher: processCredit } = createAdjustmentNotePersistence({ noteType: "credit" });
    const { processSingleAdjustmentNoteVoucher: processDebit } = createAdjustmentNotePersistence({ noteType: "debit" });

    const cnVoucher = rawNote({ i: 10, alter: 601, noteType: "credit", lines: [{ itemName: "Item A", quantity: 10, rate: 50, amount: -500, accountLedger: "Sales Return AC" }] });
    let r = await processCredit(cnVoucher, T1, G1);
    check("valid Credit Note creates a doc with sales_return classification", r.status === "created" && r.classification === "sales_return", JSON.stringify(r));

    const dnVoucher = rawNote({ i: 11, alter: 602, noteType: "debit", party: "A Debtor Party", lines: [{ itemName: "Item B", quantity: 5, rate: 20, amount: 100, accountLedger: "Purchase Return AC" }] });
    r = await processDebit(dnVoucher, T1, G1);
    check("valid Debit Note against a DEBTOR party still classifies purchase_return (party role not required)", r.status === "created" && r.classification === "purchase_return", JSON.stringify(r));

    r = await processCredit(cnVoucher, T1, G1);
    check("re-processing the same AlterID -> duplicate, no rewrite", r.status === "duplicate");

    const cnUpdated = rawNote({ i: 10, alter: 605, noteType: "credit", lines: [{ itemName: "Item A", quantity: 20, rate: 50, amount: -1000, accountLedger: "Sales Return AC" }] });
    r = await processCredit(cnUpdated, T1, G1);
    check("a newer AlterID for the same GUID -> updated", r.status === "updated");
    const afterUpdate = await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note10` }).lean();
    check("the update actually changed the stored amount", afterUpdate.header.voucherTotalAmount === 1000);

    // A cancelled voucher with genuinely unusable header data (no party name)
    // - the same "sparse cancelled voucher" case the Sales/Purchase tombstone
    // path exists for. A cancelled voucher with a FULL header (the common
    // case) is created normally below, with voucherStatus cancelled.
    const cnCancelledSparse = { ...rawNote({ i: 12, alter: 606, noteType: "credit", cancelled: true, lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Sales Return AC" }] }), partyname: "", partyledgername: "", ledgerentries: [] };
    r = await processCredit(cnCancelledSparse, T1, G1);
    check("a sparse cancelled note with nothing synced before it -> skipped, not written as a return", r.status === "skipped", JSON.stringify(r));
    check("...and nothing was written", (await AdjustmentNote.countDocuments({ tenantId: T1, tallyGuid: `${G1}-note12` })) === 0);

    const cnCancelledFull = rawNote({ i: 13, alter: 607, noteType: "credit", cancelled: true, lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Sales Return AC" }] });
    r = await processCredit(cnCancelledFull, T1, G1);
    check("a cancelled note with a full header is still stored, marked cancelled (audit trail preserved)", r.status === "created");
    check("...voucherStatus is cancelled, never active", (await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note13` }).lean()).voucherStatus === "cancelled");
    // Store time: a cancelled note must not get a return classification, even when its ledger says Sales Accounts.
    check("...and a cancelled credit note is never classified as a return (stored as unclassified)", (await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note13` }).lean()).classification === "unclassified");

    const dnCancelledFull = rawNote({ i: 18, alter: 613, noteType: "debit", cancelled: true, lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Purchase Return AC" }] });
    r = await processDebit(dnCancelledFull, T1, G1);
    check("a cancelled debit note (purchase ledger) is stored as unclassified, not purchase_return", r.status === "created" && (await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note18` }).lean()).classification === "unclassified");

    const dn18 = await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note18` }).lean();
    check("the cancelled debit note is voucherStatus cancelled AND classification unclassified", !!dn18 && dn18.voucherStatus === "cancelled" && dn18.classification === "unclassified", JSON.stringify(dn18 && { v: dn18.voucherStatus, c: dn18.classification }));

    // Active -> cancelled later (update path): the stored return must stop being one.
    const cnActiveThenCancelled = rawNote({ i: 17, alter: 611, noteType: "credit", lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Sales Return AC" }] });
    r = await processCredit(cnActiveThenCancelled, T1, G1);
    check("an active credit note is stored", r.status === "created" && (await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note17` }).lean()).voucherStatus === "active");
    const cnNowCancelled = rawNote({ i: 17, alter: 612, noteType: "credit", cancelled: true, lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Sales Return AC" }] });
    r = await processCredit(cnNowCancelled, T1, G1);
    const nowCancelled = await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note17` }).lean();
    check("the same note cancelled later: voucherStatus cancelled and classification unclassified", r.status === "updated" && nowCancelled.voucherStatus === "cancelled" && nowCancelled.classification === "unclassified", JSON.stringify({ status: r.status, v: nowCancelled.voucherStatus, c: nowCancelled.classification }));

    const n17Count = await AdjustmentNote.countDocuments({ tenantId: T1, tallyGuid: `${G1}-note17` });
    check("the cancelled note is still exactly one voucher (updated in place, no duplicate)", n17Count === 1, `count=${n17Count}`);
    check("the cancelled note has tallyAlterId 612 (the cancellation's alter id)", nowCancelled.tallyAlterId === 612, `alter=${nowCancelled.tallyAlterId}`);

    // An active note that is only a value adjustment (no Sales/Purchase ledger) keeps value_adjustment.
    const cnFreight = rawNote({ i: 19, alter: 614, noteType: "credit", lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Freight Ledger" }] });
    r = await processCredit(cnFreight, T1, G1);
    check("an active value-adjustment note stays value_adjustment (not unclassified, not a return)", (await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note19` }).lean()).classification === "value_adjustment");

    // Tombstone path: an active return stored earlier, then a sparse cancellation for the same voucher.
    const cnTombstoneBase = rawNote({ i: 21, alter: 616, noteType: "credit", lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Sales Return AC" }] });
    r = await processCredit(cnTombstoneBase, T1, G1);
    check("the tombstone base return is stored active", r.status === "created");
    // Same GUID under a separate tenant: the T1 cancellation below must leave this one exactly as it is.
    await processCredit(cnTombstoneBase, T_ISO, G1);
    const isoBefore = await AdjustmentNote.findOne({ tenantId: T_ISO, tallyGuid: `${G1}-note21` }).lean();
    const tombBefore = await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note21` }).lean();
    const cnTombstoneSparse = { ...rawNote({ i: 21, alter: 617, noteType: "credit", cancelled: true, lines: [] }), partyname: "", partyledgername: "", ledgerentries: [] };
    r = await processCredit(cnTombstoneSparse, T1, G1);
    const tomb = await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note21` }).lean();
    check("the sparse cancellation returns the tombstone outcome (updated, not created)", r.updated === true && r.created === false, JSON.stringify({ created: r.created, updated: r.updated, message: r.message }));
    check("the tombstone leaves exactly one voucher for this GUID", (await AdjustmentNote.countDocuments({ tenantId: T1, tallyGuid: `${G1}-note21` })) === 1);
    check("the tombstone sets tallyAlterId to 617", tomb && tomb.tallyAlterId === 617, `alter=${tomb && tomb.tallyAlterId}`);
    check("the tombstone keeps inventory exactly as it was before the cancellation", tomb && JSON.stringify(tomb.inventory) === JSON.stringify(tombBefore.inventory) && tomb.inventory.length === 1);
    check("the tombstone keeps header.voucherTotalAmount and header.voucherNo unchanged", tomb && tomb.header.voucherTotalAmount === tombBefore.header.voucherTotalAmount && tomb.header.voucherNo === tombBefore.header.voucherNo, JSON.stringify(tomb && tomb.header));
    const isoAfter = await AdjustmentNote.findOne({ tenantId: T_ISO, tallyGuid: `${G1}-note21` }).lean();
    check("tenant isolation: the other tenant's note with the same GUID is untouched by the T1 cancellation", !!isoAfter && isoAfter.voucherStatus === "active" && isoAfter.classification === isoBefore.classification && isoAfter.tallyAlterId === isoBefore.tallyAlterId && JSON.stringify(isoAfter.inventory) === JSON.stringify(isoBefore.inventory), JSON.stringify(isoAfter && { v: isoAfter.voucherStatus, c: isoAfter.classification, a: isoAfter.tallyAlterId }));
    check("a sparse cancellation of a stored return marks it cancelled and unclassified", !!tomb && tomb.voucherStatus === "cancelled" && tomb.classification === "unclassified", JSON.stringify(tomb && { v: tomb.voucherStatus, c: tomb.classification }));

    // ---- deletion (isdeleted) regression: a deleted voucher is never a return, and its lifecycle is recorded as "deleted".
    // Precondition: the ledgers really are Sales/Purchase Accounts in this tenant's master, so a voucher that ignored its
    // deletion status WOULD be classified as a return. Without this, the assertions below could pass for the wrong reason.
    const salesRetRole = await LedgerMaster.findOne({ tenantId: T1, name: "Sales Return AC", removedAt: null }).lean();
    const purRetRole = await LedgerMaster.findOne({ tenantId: T1, name: "Purchase Return AC", removedAt: null }).lean();
    check("precondition: T1's 'Sales Return AC' is a sales_accounts ledger in the master", salesRetRole && salesRetRole.accountRole === "sales_accounts", JSON.stringify(salesRetRole && salesRetRole.accountRole));
    check("precondition: T1's 'Purchase Return AC' is a purchase_accounts ledger in the master", purRetRole && purRetRole.accountRole === "purchase_accounts", JSON.stringify(purRetRole && purRetRole.accountRole));
    const cnDeletedFull = rawNote({ i: 30, alter: 630, noteType: "credit", deleted: true, lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Sales Return AC" }] });
    r = await processCredit(cnDeletedFull, T1, G1);
    const cn30 = await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note30` }).lean();
    check("a deleted Credit Note is stored with voucherStatus deleted and is NOT sales_return", r.status === "created" && cn30 && cn30.voucherStatus === "deleted" && cn30.classification !== "sales_return" && cn30.classification === "unclassified", JSON.stringify(cn30 && { v: cn30.voucherStatus, c: cn30.classification }));

    const dnDeletedFull = rawNote({ i: 31, alter: 631, noteType: "debit", deleted: true, lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Purchase Return AC" }] });
    r = await processDebit(dnDeletedFull, T1, G1);
    const dn31 = await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note31` }).lean();
    check("a deleted Debit Note is stored with voucherStatus deleted and is NOT sales_return", r.status === "created" && dn31 && dn31.voucherStatus === "deleted" && dn31.classification !== "sales_return" && dn31.classification === "unclassified", JSON.stringify(dn31 && { v: dn31.voucherStatus, c: dn31.classification }));

    // An active stored note that is later deleted (update path): one voucher, lifecycle "deleted", classification unclassified, alter 633.
    const cnActiveThenDeleted = rawNote({ i: 32, alter: 632, noteType: "credit", lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Sales Return AC" }] });
    r = await processCredit(cnActiveThenDeleted, T1, G1);
    const before32 = await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note32` }).lean();
    check("an active note is stored before it is deleted", r.status === "created" && before32.voucherStatus === "active");
    r = await processCredit(rawNote({ i: 32, alter: 633, noteType: "credit", deleted: true, lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Sales Return AC" }] }), T1, G1);
    const after32 = await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note32` }).lean();
    check("the stored active note becomes deleted: exactly one voucher, voucherStatus deleted, classification unclassified, tallyAlterId 633", r.status === "updated" && (await AdjustmentNote.countDocuments({ tenantId: T1, tallyGuid: `${G1}-note32` })) === 1 && after32.voucherStatus === "deleted" && after32.classification === "unclassified" && after32.tallyAlterId === 633, JSON.stringify({ status: r.status, v: after32.voucherStatus, c: after32.classification, a: after32.tallyAlterId }));

    // Sparse deleted-voucher tombstone of a stored return: existing fields must survive; only lifecycle changes.
    const baseDel = rawNote({ i: 33, alter: 634, noteType: "credit", lines: [{ itemName: "Item A", quantity: 7, rate: 100, amount: -700, accountLedger: "Sales Return AC" }] });
    await processCredit(baseDel, T_ISO, G1);
    const isoDelBefore = await AdjustmentNote.findOne({ tenantId: T_ISO, tallyGuid: `${G1}-note33` }).lean();
    r = await processCredit(baseDel, T1, G1);
    check("the base note for the sparse deleted tombstone is stored", r.status === "created");
    const delBefore = await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note33` }).lean();
    const sparseDeleted = { ...rawNote({ i: 33, alter: 635, noteType: "credit", deleted: true, lines: [] }), partyname: "", partyledgername: "", ledgerentries: [] };
    r = await processCredit(sparseDeleted, T1, G1);
    const delAfter = await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note33` }).lean();
    check("the sparse deleted tombstone reports an update (not a creation)", r.updated === true && r.created === false, JSON.stringify({ created: r.created, updated: r.updated }));
    check("the sparse deleted tombstone: voucherStatus deleted, classification unclassified, tallyAlterId 635", delAfter && delAfter.voucherStatus === "deleted" && delAfter.classification === "unclassified" && delAfter.tallyAlterId === 635, JSON.stringify(delAfter && { v: delAfter.voucherStatus, c: delAfter.classification, a: delAfter.tallyAlterId }));
    check("the sparse deleted tombstone keeps voucherNo, voucherTotalAmount, inventory and one voucher", delAfter && delAfter.header.voucherNo === delBefore.header.voucherNo && delAfter.header.voucherTotalAmount === delBefore.header.voucherTotalAmount && JSON.stringify(delAfter.inventory) === JSON.stringify(delBefore.inventory) && delAfter.inventory.length === 1 && (await AdjustmentNote.countDocuments({ tenantId: T1, tallyGuid: `${G1}-note33` })) === 1);
    const isoDelAfter = await AdjustmentNote.findOne({ tenantId: T_ISO, tallyGuid: `${G1}-note33` }).lean();
    check("tenant isolation: a deleted voucher for T1 does not change the same GUID under another tenant", !!isoDelAfter && isoDelAfter.voucherStatus === "active" && isoDelAfter.classification === isoDelBefore.classification && isoDelAfter.tallyAlterId === isoDelBefore.tallyAlterId && JSON.stringify(isoDelAfter.inventory) === JSON.stringify(isoDelBefore.inventory), JSON.stringify(isoDelAfter && { v: isoDelAfter.voucherStatus, c: isoDelAfter.classification, a: isoDelAfter.tallyAlterId }));

    // Reclassification after the cancellations, in apply mode: cancelled notes must not be upgraded to a return.
    const reclassT1 = await reclassifyAdjustmentNotes({ tenantId: T1, apply: true });
    check("the reclassification run succeeds", reclassT1.ok === true, JSON.stringify({ ok: reclassT1.ok, scanned: reclassT1.scanned, upgrades: reclassT1.upgrades }));
    const cancelledNotes = await AdjustmentNote.find({ tenantId: T1, tallyGuid: { $in: [`${G1}-note13`, `${G1}-note17`, `${G1}-note18`, `${G1}-note21`] } }).lean();
    check("after apply, every cancelled or tombstoned note is still unclassified (none upgraded to a return)", cancelledNotes.length === 4 && cancelledNotes.every((n) => n.voucherStatus !== "active" && n.classification === "unclassified"), JSON.stringify(cancelledNotes.map((n) => [n.tallyGuid.slice(-7), n.voucherStatus, n.classification])));
    const activeFreight = await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note19` }).lean();
    check("an active value adjustment is still not upgraded by the same run (no Sales/Purchase ledger)", activeFreight && activeFreight.classification === "value_adjustment");

    const cnCancelled = rawNote({ i: 10, alter: 610, noteType: "credit", cancelled: true, lines: [{ itemName: "Item A", quantity: 20, rate: 50, amount: -1000, accountLedger: "Sales Return AC" }] });
    r = await processCredit(cnCancelled, T1, G1);
    check("cancelling an existing note marks it cancelled (tombstone, not removed)", r.status === "updated");
    const cancelledDoc = await AdjustmentNote.findOne({ tenantId: T1, tallyGuid: `${G1}-note10` }).lean();
    check("...voucherStatus is cancelled", cancelledDoc.voucherStatus === "cancelled");

    // Two ALREADY-EXISTING documents sharing a voucherNo (e.g. two distinct
    // voucher masters, or a legacy no-GUID import) - the same ambiguity the
    // Sales/Purchase pipeline refuses to guess through.
    await AdjustmentNote.insertMany([
      mapAdjustmentNote(p1, { tenantId: T1, companyGuid: G1, noteType: "credit", classification: "sales_return" }),
      { ...mapAdjustmentNote(p1, { tenantId: T1, companyGuid: G1, noteType: "credit", classification: "sales_return" }), tallyGuid: null, tallyAlterId: 998 },
    ].map((d) => ({ ...d, header: { ...d.header, voucherNo: "NOTE-AMBIG" }, tallyGuid: d.tallyGuid === null ? null : `${G1}-ambigA` })));
    const noGuid = { ...rawNote({ i: 20, alter: 620, noteType: "credit", lines: [{ itemName: "X", quantity: 1, rate: 1, amount: -1, accountLedger: "Sales Return AC" }] }), guid: "", vouchernumber: "NOTE-AMBIG" };
    r = await processCredit(noGuid, T1, G1);
    check("no GUID + voucherNo already shared by two existing docs -> refuses to guess which to update (fails closed)", r.status === "failed" && /Ambiguous/.test(r.error), JSON.stringify(r));

    r = await processCredit(cnVoucher, T1, null);
    check("no companyGuid -> failed, never guessed", r.status === "failed");

    const sameGuidOtherTenant = rawNote({ i: 10, alter: 601, noteType: "credit", lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Sales Return AC" }] });
    await LedgerMaster.insertMany([{ tenantId: T2, companyGuid: G1, ledgerGuid: `${G1}-t2-la1`, name: "Sales Return AC", parentGroup: "Sales Accounts", partyRole: "other", accountRole: "sales_accounts", syncedAt: new Date() }]);
    r = await processCredit(sameGuidOtherTenant, T2, G1);
    check("the same tallyGuid under a DIFFERENT tenant does not collide", r.status === "created" && (await AdjustmentNote.countDocuments({ tallyGuid: `${G1}-note10` })) === 2);

    // ============================================================ RECLASSIFY
    section("RECLASSIFY: notes stored while the Ledger master was empty are upgraded to returns (upgrade only, no Tally)");
    {
      await LedgerMaster.insertMany([
        { tenantId: T3, companyGuid: G1, ledgerGuid: `${G1}-r1`, name: "Sales Return AC", parentGroup: "Sales Accounts", partyRole: "other", accountRole: "sales_accounts", syncedAt: new Date() },
        { tenantId: T3, companyGuid: G1, ledgerGuid: `${G1}-r2`, name: "Purchase Return AC", parentGroup: "Purchase Accounts", partyRole: "other", accountRole: "purchase_accounts", syncedAt: new Date() },
        { tenantId: T3, companyGuid: G1, ledgerGuid: `${G1}-r3`, name: "Freight Ledger", parentGroup: "Indirect Expenses", partyRole: "other", accountRole: "other", syncedAt: new Date() },
        { tenantId: T3, companyGuid: G1, ledgerGuid: `${G1}-r4`, name: "Dup Ledger", parentGroup: "Sales Accounts", partyRole: "other", accountRole: "sales_accounts", syncedAt: new Date() },
        { tenantId: T3, companyGuid: G1, ledgerGuid: `${G1}-r5`, name: "Dup Ledger", parentGroup: "Sales Accounts", partyRole: "other", accountRole: "sales_accounts", syncedAt: new Date() },
      ]);
      const mk = (n, noteType, classification, ledgers, extra = {}) => ({
        tenantId: T3, companyGuid: G1, tallyGuid: `${G1}-rc${n}`, tallyAlterId: 9000 + n, voucherStatus: "active",
        header: { voucherNo: `RC${n}`, voucherDate: new Date("2025-09-10T00:00:00Z"), voucherType: noteType === "credit" ? "Credit Note" : "Debit Note", voucherTotalAmount: 100, narration: "", partyName: "Party" },
        noteType, classification, inventory: ledgers.map((l) => ({ itemName: "Item", quantity: 1, rate: 1, amount: -1, accountingAllocationLedger: l })), ledgers: [], ...extra,
      });
      const stored = async () => Object.fromEntries((await AdjustmentNote.find({ tenantId: T3 }).lean()).map((d) => [d.header.voucherNo, d.classification]));
      const noRoles = await reclassifyAdjustmentNotes({ tenantId: T3, apply: true });
      check("with no notes at all the re-check is a quiet no-op", noRoles.ok && noRoles.scanned === 0 && noRoles.upgrades === 0);

      await AdjustmentNote.insertMany([
        mk(1, "credit", "value_adjustment", ["Sales Return AC"]), // a sales return stored before the master knew the role
        mk(2, "debit", "value_adjustment", ["Purchase Return AC"]), // a purchase return, same
        mk(3, "credit", "value_adjustment", ["Freight Ledger"]), // really a value adjustment
        mk(4, "credit", "value_adjustment", ["Sales Return AC", "Freight Ledger"]), // mixed lines: never a partial return
        mk(5, "debit", "value_adjustment", ["Sales Return AC"]), // wrong role for a debit note
        mk(6, "credit", "value_adjustment", [null]), // no resolvable ledger: no evidence
        mk(7, "credit", "value_adjustment", ["Dup Ledger"]), // ambiguous ledger name resolves to other
        mk(8, "credit", "unclassified", []), // no inventory lines: never touched
        mk(9, "credit", "sales_return", ["Freight Ledger"]), // already stored as a return: never downgraded
        mk(10, "credit", "value_adjustment", ["Sales Return AC"], { voucherStatus: "cancelled" }), // cancelled: not eligible, so never upgraded (only active vouchers are reclassified)
        mk(11, "credit", "value_adjustment", ["No Such Ledger"]), // a ledger the master does not know
      ]);
      await AdjustmentNote.insertMany([{ ...mk(12, "credit", "value_adjustment", ["Sales Return AC"]), tenantId: T3_OTHER }]);
      const before = await stored();

      const dry = await reclassifyAdjustmentNotes({ tenantId: T3 });
      check("dry run (the default): counts the upgrades but writes nothing", dry.ok && dry.applied === false && dry.upgrades === 2 && JSON.stringify(await stored()) === JSON.stringify(before), JSON.stringify(dry));
      const wet = await reclassifyAdjustmentNotes({ tenantId: T3, apply: true });
      const after = await stored();
      check("apply: exactly the two provable active returns are upgraded (credit+Sales, debit+Purchase); the cancelled one is not", wet.upgrades === 2 && wet.scanned === 8 && after.RC1 === "sales_return" && after.RC2 === "purchase_return" && after.RC10 === "value_adjustment", JSON.stringify([wet, after]));
      check("transitions are reported", JSON.stringify(wet.byTransition) === JSON.stringify({ "value_adjustment->sales_return": 1, "value_adjustment->purchase_return": 1 }), JSON.stringify(wet.byTransition));
      check("everything without proof stays value_adjustment (freight, mixed, wrong role, no ledger, ambiguous name, unknown ledger)", ["RC3", "RC4", "RC5", "RC6", "RC7", "RC11"].every((k) => after[k] === "value_adjustment"), JSON.stringify(after));
      check("unclassified and an already-stored return are never touched", after.RC8 === "unclassified" && after.RC9 === "sales_return");
      check("another tenant's note is never touched", (await AdjustmentNote.findOne({ tenantId: T3_OTHER }).lean()).classification === "value_adjustment");
      const again = await reclassifyAdjustmentNotes({ tenantId: T3, apply: true });
      check("running it again changes nothing (idempotent)", again.upgrades === 0 && JSON.stringify(await stored()) === JSON.stringify(after));

      // a ledger deleted from Tally later must not rewrite history: the stored return stays
      await LedgerMaster.updateOne({ tenantId: T3, name: "Sales Return AC" }, { $set: { removedAt: new Date() } });
      const gone = await reclassifyAdjustmentNotes({ tenantId: T3, apply: true });
      check("a ledger marked removed later does NOT downgrade stored returns", gone.upgrades === 0 && (await stored()).RC1 === "sales_return");
      await LedgerMaster.updateOne({ tenantId: T3, name: "Sales Return AC" }, { $set: { removedAt: null } });

      // a note whose ledger is later corrected becomes provable; tiny batches page by _id and still reach every note
      await AdjustmentNote.updateOne({ tenantId: T3, "header.voucherNo": "RC3" }, { $set: { "inventory.0.accountingAllocationLedger": "Sales Return AC" } });
      const raced = await reclassifyAdjustmentNotes({ tenantId: T3, apply: true, batchSize: 1 });
      check("small batches (paging by _id) reach every note; the freshly provable one is upgraded", raced.upgrades === 1 && (await stored()).RC3 === "sales_return" && raced.scanned >= 5, JSON.stringify(raced));
      // a note changed by someone else between the read and the write is not overwritten (the write is conditional on value_adjustment)
      await AdjustmentNote.insertMany([mk(13, "credit", "value_adjustment", ["Sales Return AC"])]);
      const realFind = LedgerMaster.find;
      LedgerMaster.find = function patchedFind(...a) {
        LedgerMaster.find = realFind;
        const q = realFind.apply(this, a);
        return { lean: async () => { const docs = await q.lean(); await AdjustmentNote.updateOne({ tenantId: T3, "header.voucherNo": "RC13" }, { $set: { classification: "purchase_return" } }); return docs; } };
      };
      try {
        await reclassifyAdjustmentNotes({ tenantId: T3, apply: true });
      } finally {
        LedgerMaster.find = realFind;
      }
      check("a note changed concurrently (after it was read) is not overwritten by the upgrade", (await stored()).RC13 === "purchase_return", JSON.stringify((await stored()).RC13));
      const noTenant = await reclassifyAdjustmentNotes({ apply: true });
      check("no tenantId -> refused, nothing written", noTenant.ok === false && noTenant.upgrades === 0);
      await AdjustmentNote.deleteMany({ tenantId: { $in: [T3, T3_OTHER] } });
    }

    // ============================================================ SYNC / SECURITY
    section("SYNC/SECURITY: runSyncForCompanyModule against a Tally-shaped stub (real worker code path)");
    clearVoucherTypeClassificationCache();
    const recorded = {};
    const backlogByType = { "Credit Note": [], "Debit Note": [] };
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const id = req.headers.id;
        try { recorded[id] = JSON.parse(body); } catch (_) {}
        res.writeHead(200, { "Content-Type": "application/json" });
        if (id === "RTS Company Guid Collection") {
          res.end(JSON.stringify({ status: "1", data: { collection: [{ name: { value: "Verify AdjNote Co" }, guid: { value: G1 } }] } }));
        } else if (id === "RTS VoucherType Master Collection") {
          res.end(JSON.stringify({
            status: "1",
            data: {
              collection: [
                { metadata: { name: "Credit Note", reservedname: "Credit Note" }, parent: { value: "Credit Note" }, guid: { value: `${G1}-vt1` } },
                { metadata: { name: "Debit Note", reservedname: "Debit Note" }, parent: { value: "Debit Note" }, guid: { value: `${G1}-vt2` } },
              ],
            },
          }));
        } else if (id === "RTS Pending AlterIDs Collection" || id === "RTS Adjustment Note AlterID Collection") {
          const filter = body && JSON.parse(body).tdlmessage[0].definitions[1].value;
          const wantType = /"Credit Note"/.test(filter) ? "Credit Note" : /"Debit Note"/.test(filter) ? "Debit Note" : null;
          const rows = wantType ? backlogByType[wantType] : [];
          if (id === "RTS Pending AlterIDs Collection") {
            res.end(JSON.stringify({ status: "1", data: { collection: rows.map((v) => ({ vouchertypename: wantType, alterid: v.alterid })) } } ));
          } else {
            res.end(JSON.stringify({ status: "1", data: { collection: rows } }));
          }
        } else {
          res.end(JSON.stringify({ status: "1", data: { collection: [] } }));
        }
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const company = { tenantId: T1, companyGuid: G1, tallyConnection: { baseUrl } };

    backlogByType["Credit Note"] = [rawNote({ i: 30, alter: 700, noteType: "credit", lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Sales Return AC" }] })];
    let res1 = await runSyncForCompanyModule(company, CREDIT_NOTE_SYNC_MODULE, { intervalSeconds: 60, batchSize: 100 });
    check("Credit Note module: one voucher synced end-to-end through the real worker", res1.created === 1 && res1.failed === 0, JSON.stringify(res1));
    check("...and its Native Method request is bounded (no full-voucher '*' dump)", !JSON.stringify(recorded["RTS Adjustment Note AlterID Collection"]).includes('"*"') && JSON.stringify(recorded["RTS Adjustment Note AlterID Collection"]).includes("accountingallocations"));
    let cp = await SyncCheckpoint.findOne({ tenantId: T1, companyGuid: G1, voucherType: "Credit Note" }).lean();
    check("checkpoint advanced for Credit Note only", cp.lastAlterId === 700);

    backlogByType["Debit Note"] = [rawNote({ i: 31, alter: 750, noteType: "debit", lines: [{ itemName: "Item B", quantity: 1, rate: 1, amount: 1, accountLedger: "Purchase Return AC" }] })];
    let res2 = await runSyncForCompanyModule(company, DEBIT_NOTE_SYNC_MODULE, { intervalSeconds: 60, batchSize: 100 });
    check("Debit Note module: independent checkpoint/lock, unaffected by the Credit Note run", res2.created === 1);

    // Foreign-company batch: one voucher's GUID belongs to a different company.
    backlogByType["Credit Note"] = [
      rawNote({ i: 32, alter: 800, noteType: "credit", lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Sales Return AC" }] }),
      { ...rawNote({ i: 33, alter: 801, noteType: "credit", lines: [{ itemName: "Item A", quantity: 1, rate: 1, amount: -1, accountLedger: "Sales Return AC" }], companyGuid: G2 }), guid: `${G2}-foreign` },
    ];
    const beforeCount = await AdjustmentNote.countDocuments({ tenantId: T1 });
    const cpBefore = await SyncCheckpoint.findOne({ tenantId: T1, companyGuid: G1, voucherType: "Credit Note" }).lean();
    const res3 = await runSyncForCompanyModule(company, CREDIT_NOTE_SYNC_MODULE, { intervalSeconds: 60, batchSize: 100 });
    const afterCount = await AdjustmentNote.countDocuments({ tenantId: T1 });
    const cpAfter = await SyncCheckpoint.findOne({ tenantId: T1, companyGuid: G1, voucherType: "Credit Note" }).lean();
    check("a batch with ANY foreign-company GUID is rejected whole: zero Mongo writes", afterCount === beforeCount, `before=${beforeCount} after=${afterCount}`);
    check("...and the checkpoint does not advance", cpAfter.lastAlterId === cpBefore.lastAlterId, JSON.stringify(res3));
    check("...and the tick is recorded as a failure, not a silent success", !!res3.error);

    await new Promise((resolve) => server.close(resolve));
  } catch (error) {
    fail += 1;
    console.log("  FAIL - unexpected error:", error && error.stack);
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }
  console.log(`\nverify-adjustment-note: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
