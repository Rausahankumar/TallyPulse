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

async function cleanup() {
  const ids = { $in: [T1, T2, T3, T3_OTHER] };
  await Promise.all([AdjustmentNote.deleteMany({ tenantId: ids }), LedgerMaster.deleteMany({ tenantId: ids }), SyncCheckpoint.deleteMany({ tenantId: ids })]);
}

// ---------------------------------------------------------------- raw voucher fixture (matches the diagnostic's confirmed shape)
function rawNote({ i, alter, noteType, party = "Test Party", partyLedgerAmount = -1000, lines, agstRef = null, cancelled = false, companyGuid = G1 }) {
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
    isdeleted: false,
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
      { ledgername: lines[0].accountLedger, amount: String(-partyLedgerAmount), isdeemedpositive: { type: "Logical", value: partyLedgerAmount < 0 }, ispartyledger: false },
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
        mk(10, "credit", "value_adjustment", ["Sales Return AC"], { voucherStatus: "cancelled" }), // status does not matter to the rule
        mk(11, "credit", "value_adjustment", ["No Such Ledger"]), // a ledger the master does not know
      ]);
      await AdjustmentNote.insertMany([{ ...mk(12, "credit", "value_adjustment", ["Sales Return AC"]), tenantId: T3_OTHER }]);
      const before = await stored();

      const dry = await reclassifyAdjustmentNotes({ tenantId: T3 });
      check("dry run (the default): counts the upgrades but writes nothing", dry.ok && dry.applied === false && dry.upgrades === 3 && JSON.stringify(await stored()) === JSON.stringify(before), JSON.stringify(dry));
      const wet = await reclassifyAdjustmentNotes({ tenantId: T3, apply: true });
      const after = await stored();
      check("apply: exactly the three provable returns are upgraded (credit+Sales, debit+Purchase, and the cancelled one)", wet.upgrades === 3 && wet.scanned === 9 && after.RC1 === "sales_return" && after.RC2 === "purchase_return" && after.RC10 === "sales_return", JSON.stringify([wet, after]));
      check("transitions are reported", JSON.stringify(wet.byTransition) === JSON.stringify({ "value_adjustment->sales_return": 2, "value_adjustment->purchase_return": 1 }), JSON.stringify(wet.byTransition));
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
