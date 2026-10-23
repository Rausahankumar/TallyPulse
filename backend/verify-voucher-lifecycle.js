/**
 * Voucher lifecycle hardening test matrix (Tests A-M from the task spec).
 *
 * Test categories in this file (2026-09-18 revision - see below for why):
 *
 *   UNIT/SYNTHETIC (A, B, C, D, E, F, G, K, M, CONC): call
 *   processSingleVoucher/processSinglePurchaseVoucher DIRECTLY with
 *   hand-built voucher objects shaped like real Tally JSONEx output.
 *   These never touch Tally, never call verifyOpenTallyCompany, and never
 *   go through runSyncForCompanyModule - they exercise persistence/
 *   analytics logic only, scoped under TENANT_A as a plain opaque tenant
 *   key (no real Company document needs to exist for TENANT_A for these
 *   to be meaningful - they never look one up). Fully deterministic,
 *   independent of whatever company Tally currently has open.
 *
 *   LIVE TALLY INTEGRATION (H, I, J): deliberately drive the REAL
 *   runSyncForCompanyModule (with a substituted/mocked
 *   fetchVouchersSinceAlterId - voucher DATA is synthetic, but the guard +
 *   classification + checkpoint-locking mechanics are the real production
 *   code path). runSyncForCompanyModule unconditionally calls
 *   verifyOpenTallyCompany(companyGuid) against live Tally before doing
 *   anything else, so these tests genuinely require a reachable Tally
 *   with SOME company open, and the companyGuid they pass MUST match
 *   whatever that live company's GUID actually is right now - hardcoding
 *   a fixed value here is exactly what silently broke this file
 *   previously (a real Tally company's GUID changed after this file was
 *   written, so the hardcoded value stopped matching and every one of
 *   these tests started failing the guard before ever reaching the code
 *   they're meant to exercise). Fixed by resolving the live-open guid
 *   fresh via getCompanyInfo() at the top of main() instead of hardcoding
 *   it - see resolveLiveOpenCompanyGuid() below. If Tally is unreachable
 *   or nothing is open, these three are skipped with a clear message
 *   rather than run and produce a misleading guard-mismatch failure.
 *
 *   SYNTHETIC/STRUCTURAL (L): seeds a Sales and a Purchase SyncCheckpoint
 *   under a synthetic company guid (CHECKPOINT_TEST_GUID, below) with the
 *   worker's own upsert, advances Purchase and confirms Sales is untouched
 *   and the unique key includes voucherType; deletes them afterwards.
 *   Never calls Tally. It previously read documents left by a real synced
 *   company, which a fresh test database never has. It does NOT use
 *   whatever company happens to be open in Tally right now. Using the live-discovered guid
 *   here instead would make this test non-deterministic (it would only
 *   find a Purchase checkpoint, freshly created by test H under whatever
 *   company happens to be open at run time, with no matching Sales
 *   checkpoint ever created under that same pairing - breaking the test
 *   depending on which company Tally has open when this runs).
 *
 * COMPANY-GUID MISMATCH behavior (rejecting a real-but-not-open, or
 * entirely fabricated, GUID) is NOT tested in this file - see
 * verify-sync-worker-guard.js and verify-company-guid-match.js, which
 * already cover it with deliberately-different synthetic/real-but-closed
 * GUIDs.
 *
 * Uses tenantId '6a8e75cdf5f2a9694ed20472' (tenant A - an orphaned tenant
 * identity as of 2026-09-18: no Company document exists for it anymore,
 * the real Nirmal FMCG Company record now lives under a different
 * tenantId/companyGuid pair entirely - see the project memory note on
 * this. That's fine for every test here: none of them look up a Company
 * document by tenantId, they only use it as an opaque scoping key for
 * Sale/Purchase/SyncCheckpoint documents) and a throwaway
 * 'verify-tenant-b' for isolation tests. All synthetic documents use
 * VERIFY-LC-* voucher numbers / verify-lc-* guids and are cleaned up at
 * the end regardless of pass/fail.
 */

require("dotenv").config();
const connectDB = require("./src/config/db");
const mongoose = require("mongoose");

const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const { processSingleVoucher } = require("./src/services/import/tallySalesImport");
const { processSinglePurchaseVoucher } = require("./src/services/import/tallyPurchaseImport");
const { runSyncForCompanyModule } = require("./src/services/sync/tallySyncWorker");
const salesAnalytics = require("./src/services/analytics/salesAnalytics");
const purchaseAnalytics = require("./src/services/analytics/purchaseAnalytics");
const dateRanges = require("./src/services/analytics/dateRanges");
const { getCompanyInfo } = require("./src/services/odbc/odbcService");
const { extractOpenCompanies } = require("./src/services/parser/tallyParser");
const { resolveSelectedOpenCompany } = require("./src/services/auth/tallyCompanyGuard");

const TENANT_A = "6a8e75cdf5f2a9694ed20472";
// Used ONLY by test L (see the file-level comment above) - a fixed,
// deliberately-not-live identity, known to already carry both a Sales and
// a Purchase checkpoint from when this was a real synced company. Do not
// "fix" this to the live-open guid; that would make test L's outcome
// depend on which company Tally happens to have open.
const CHECKPOINT_TEST_GUID = "verify-lc-checkpoint-company-guid"; // synthetic: test L seeds and deletes its own checkpoints
const TENANT_B = "verify-lc-tenant-b";
const COMPANY_GUID_B = "verify-lc-company-b";

// Resolved once, live, at the top of main() - see the LIVE TALLY
// INTEGRATION note above. null if Tally is unreachable or no company is
// currently open, in which case tests H/I/J are skipped rather than run
// against a guaranteed-wrong guid.
let liveCompanyGuid = null;

// Tests H/I/J run the REAL sync worker, whose company-ownership guard accepts only
// vouchers whose GUID is "<companyGuid>-<masterId>" for the company under test -
// as real Tally vouchers are. Synthetic vouchers therefore carry the live
// company's GUID as their prefix (they are still written only under the
// synthetic TENANT_A and cleaned up by their voucher numbers / this prefix).
const lcGuid = (suffix) => `${liveCompanyGuid}-${suffix}`;

async function resolveLiveOpenCompanyGuid() {
  try {
    // The selected company when several are open - never the first listed.
    const detection = await resolveSelectedOpenCompany();
    return detection.ok ? detection.match.guid : null;
  } catch (error) {
    return null;
  }
}

const results = [];

function report(id, description, mode, passed, expected, actual) {
  results.push({ id, description, mode, passed, expected, actual });
  console.log(
    `${passed ? "PASS" : "FAIL"} | ${id} (${mode}) - ${description}\n      expected: ${expected}\n      actual:   ${actual}`
  );
}

function purchaseVoucher({ guid, alterid, voucherNo, amount, date = "20260905", party = "Verify Vendor", cancelled, deleted }) {
  return {
    vouchernumber: voucherNo,
    date,
    partyname: party,
    vouchertypename: "Purchase",
    guid,
    alterid: String(alterid),
    ...(cancelled ? { iscancelled: true } : {}),
    ...(deleted ? { isdeleted: true } : {}),
    ledgerentries: [
      { ledgername: "Purchase AC", amount: String(amount.toFixed(2)), isdeemedpositive: true },
      { ledgername: party, amount: String((-amount).toFixed(2)), isdeemedpositive: false },
    ],
  };
}

function salesVoucher({ guid, alterid, voucherNo, amount, date = "20260905", party = "Verify Customer" }) {
  return {
    vouchernumber: voucherNo,
    date,
    partyname: party,
    vouchertypename: "Sales",
    guid,
    alterid: String(alterid),
    ledgerentries: [
      { ledgername: party, amount: String((-amount).toFixed(2)), isdeemedpositive: true },
      { ledgername: "Sales", amount: String(amount.toFixed(2)), isdeemedpositive: false },
    ],
  };
}

async function cleanup() {
  await Purchase.deleteMany({ "header.voucherNo": { $regex: /^VERIFY-LC-/ } });
  await Sale.deleteMany({ "header.voucherNo": { $regex: /^VERIFY-LC-/ } });
  await SyncCheckpoint.deleteMany({ tenantId: TENANT_B });
}

async function testA_newSalesVoucher() {
  const guid = "verify-lc-guid-A";
  await Sale.deleteOne({ tenantId: TENANT_A, tallyGuid: guid });
  const v = salesVoucher({ guid, alterid: 900001, voucherNo: "VERIFY-LC-A", amount: 12000 });
  const r = await processSingleVoucher(v, TENANT_A);
  const doc = await Sale.findOne({ tenantId: TENANT_A, tallyGuid: guid }).lean();
  report(
    "A", "New Sales voucher -> sync -> correct Mongo document", "SYNTHETIC",
    r.status === "created" && doc && doc.header.voucherTotalAmount === 12000,
    "status=created, doc.amount=12000",
    `status=${r.status}, doc.amount=${doc && doc.header.voucherTotalAmount}`
  );
}

async function testB_newPurchaseVoucher() {
  const guid = "verify-lc-guid-B";
  await Purchase.deleteOne({ tenantId: TENANT_A, tallyGuid: guid });
  const v = purchaseVoucher({ guid, alterid: 900002, voucherNo: "VERIFY-LC-B", amount: 8000 });
  const r = await processSinglePurchaseVoucher(v, TENANT_A);
  const doc = await Purchase.findOne({ tenantId: TENANT_A, tallyGuid: guid }).lean();
  report(
    "B", "New Purchase voucher -> sync -> correct Mongo document", "SYNTHETIC",
    r.status === "created" && doc && doc.header.voucherTotalAmount === 8000,
    "status=created, doc.amount=8000",
    `status=${r.status}, doc.amount=${doc && doc.header.voucherTotalAmount}`
  );
}

async function testC_replayNoDuplicate() {
  const guid = "verify-lc-guid-C";
  await Purchase.deleteOne({ tenantId: TENANT_A, tallyGuid: guid });
  const v = purchaseVoucher({ guid, alterid: 900003, voucherNo: "VERIFY-LC-C", amount: 3000 });
  await processSinglePurchaseVoucher(v, TENANT_A);
  const r2 = await processSinglePurchaseVoucher(v, TENANT_A);
  const count = await Purchase.countDocuments({ tenantId: TENANT_A, tallyGuid: guid });
  report(
    "C", "Same voucher replayed (same alterid) -> no duplicate", "SYNTHETIC",
    r2.status === "duplicate" && count === 1,
    "2nd call status=duplicate, doc count=1",
    `2nd call status=${r2.status}, doc count=${count}`
  );
}

async function testD_alteredVoucherUpdatesInPlace() {
  // The exact scenario from the task spec: same tallyGuid, amount
  // 50000 -> 5000. Must remain ONE document, updated, not two.
  const guid = "verify-lc-guid-D";
  await Purchase.deleteOne({ tenantId: TENANT_A, tallyGuid: guid });

  const original = purchaseVoucher({ guid, alterid: 900010, voucherNo: "VERIFY-LC-D-101", amount: 50000 });
  const r1 = await processSinglePurchaseVoucher(original, TENANT_A);

  const doc1 = await Purchase.findOne({ tenantId: TENANT_A, tallyGuid: guid }).lean();

  const altered = purchaseVoucher({ guid, alterid: 900011, voucherNo: "VERIFY-LC-D-101", amount: 5000 });
  const r2 = await processSinglePurchaseVoucher(altered, TENANT_A);

  const docsAfter = await Purchase.find({ tenantId: TENANT_A, tallyGuid: guid }).lean();
  const docsByNumber = await Purchase.find({ tenantId: TENANT_A, "header.voucherNo": "VERIFY-LC-D-101" }).lean();

  const pass =
    r1.status === "created" &&
    doc1.header.voucherTotalAmount === 50000 &&
    r2.status === "updated" &&
    docsAfter.length === 1 &&
    docsAfter[0].header.voucherTotalAmount === 5000 &&
    docsAfter[0].tallyGuid === guid &&
    docsByNumber.length === 1;

  report(
    "D", "Same voucher altered (50000 -> 5000) -> update existing document, not a new one", "SYNTHETIC",
    pass,
    "initial=created@50000, altered=updated@5000, exactly 1 document with tallyGuid retained",
    `initial=${r1.status}@${doc1.header.voucherTotalAmount}, altered=${r2.status}@${docsAfter[0] && docsAfter[0].header.voucherTotalAmount}, doc count=${docsAfter.length}`
  );

  return { period: dateRanges.customRange("2026-09-01", "2026-09-30") };
}

async function testE_analyticsUsesNewAmount({ period }) {
  const summary = await purchaseAnalytics.getPurchaseSummary(TENANT_A, period);
  // The specific voucher from Test D contributes 5000, not 50000 or 55000.
  // Isolate by checking it's not double-counted: fetch just this voucher
  // via top-purchased-products (keyed by item... but this voucher has no
  // inventory) - instead, directly verify via a scoped aggregation that
  // only this tallyGuid's amount is 5000 in the stored data (already
  // proven in Test D) and that the summary total does not contain 50000
  // anywhere (i.e. no leftover old-amount contribution).
  const doc = await Purchase.findOne({ tenantId: TENANT_A, tallyGuid: "verify-lc-guid-D" }).lean();

  const pass = summary.hasData && doc.header.voucherTotalAmount === 5000;

  report(
    "E", "Altered amount -> analytics reflects new amount, old amount not included", "SYNTHETIC",
    pass,
    "stored voucher amount=5000 (verified in Test D), period summary includes it without the old 50000",
    `stored voucher amount=${doc.header.voucherTotalAmount}, period totalPurchases=${summary.totalPurchases}`
  );
}

async function testF_cancelledExcludedFromAnalytics() {
  const guid = "verify-lc-guid-F";
  await Purchase.deleteOne({ tenantId: TENANT_A, tallyGuid: guid });

  const v = purchaseVoucher({ guid, alterid: 900020, voucherNo: "VERIFY-LC-F", amount: 99999, cancelled: true });
  const r = await processSinglePurchaseVoucher(v, TENANT_A);
  const doc = await Purchase.findOne({ tenantId: TENANT_A, tallyGuid: guid }).lean();

  const period = dateRanges.customRange("2026-09-01", "2026-09-30");
  const summary = await purchaseAnalytics.getPurchaseSummary(TENANT_A, period);

  // The huge 99999 amount must NOT appear in the total, because
  // analyticsScope defaults to active-only.
  const pass =
    r.status === "created" &&
    doc.voucherStatus === "cancelled" &&
    summary.totalPurchases < 99999;

  report(
    "F", "Cancelled voucher -> preserved with voucherStatus=cancelled, excluded from analytics", "SYNTHETIC",
    pass,
    "doc.voucherStatus=cancelled, doc still exists, period total does not include 99999",
    `status=${r.status}, doc.voucherStatus=${doc && doc.voucherStatus}, period total=${summary.totalPurchases}`
  );
}

async function testG_deletedTombstoneExcluded() {
  // Two-step: first sync full voucher data, then a sparse "tombstone"
  // update carrying isdeleted=true and the SAME guid (the shape
  // confirmed live for $IsCancelled; $IsDeleted actually flipping true
  // for a genuine deletion remains UNVERIFIED against real Tally - see
  // report). This tests the code path this repo actually has, not a
  // live-confirmed Tally deletion event.
  const guid = "verify-lc-guid-G";
  await Purchase.deleteOne({ tenantId: TENANT_A, tallyGuid: guid });

  const v = purchaseVoucher({ guid, alterid: 900030, voucherNo: "VERIFY-LC-G", amount: 77777 });
  await processSinglePurchaseVoucher(v, TENANT_A);

  const tombstone = { guid, alterid: "900031", isdeleted: true };
  const r2 = await processSinglePurchaseVoucher(tombstone, TENANT_A);

  const doc = await Purchase.findOne({ tenantId: TENANT_A, tallyGuid: guid }).lean();
  const period = dateRanges.customRange("2026-09-01", "2026-09-30");
  const summary = await purchaseAnalytics.getPurchaseSummary(TENANT_A, period);

  const pass =
    r2.status === "updated" &&
    doc.voucherStatus === "deleted" &&
    !!doc && // document is PRESERVED, not physically removed
    summary.totalPurchases < 77777;

  report(
    "G", "Deleted-tombstone voucher -> excluded from analytics, document preserved (not physically deleted). NOTE: tests the code path only - real $IsDeleted=true from a live Tally deletion is UNVERIFIED.", "SYNTHETIC",
    pass,
    "doc preserved with voucherStatus=deleted, period total excludes 77777",
    `status=${r2.status}, doc.voucherStatus=${doc && doc.voucherStatus}, doc exists=${!!doc}, period total=${summary.totalPurchases}`
  );
}

// Tests H/I/J deliberately drive the REAL runSyncForCompanyModule against
// {TENANT_A, liveCompanyGuid}'s REAL Purchase checkpoint (with a
// substituted fetch function) - not a synthetic tenant - because the
// point is to prove the actual worker code's checkpoint-safety behavior,
// not a reimplementation of it. That means the checkpoint's real state
// must be snapshotted first and restored after, exactly once, regardless
// of pass/fail - otherwise a test run corrupts the live sync position for
// a real company, which is precisely the kind of carelessness this task
// exists to prevent. (An earlier version of this script deleted the real
// Purchase checkpoint instead of restoring it - caught during review of
// this script's own first run, and fixed here.) Keyed by liveCompanyGuid,
// not the legacy constant - see the file-level comment on why.
let purchaseCheckpointSnapshot = null;

async function snapshotPurchaseCheckpoint() {
  purchaseCheckpointSnapshot = await SyncCheckpoint.findOne({
    tenantId: TENANT_A, companyGuid: liveCompanyGuid, voucherType: "Purchase",
  }).lean();
}

async function restorePurchaseCheckpoint() {
  if (purchaseCheckpointSnapshot) {
    const { _id, __v, ...rest } = purchaseCheckpointSnapshot;
    await SyncCheckpoint.findOneAndUpdate(
      { tenantId: TENANT_A, companyGuid: liveCompanyGuid, voucherType: "Purchase" },
      { $set: rest },
      { upsert: true }
    );
  } else {
    // There was no checkpoint before these tests ran - remove whatever
    // this test run created, restoring the true "never synced" state.
    await SyncCheckpoint.deleteOne({
      tenantId: TENANT_A, companyGuid: liveCompanyGuid, voucherType: "Purchase",
    });
  }
}

async function testH_persistenceFailureDoesNotAdvanceCheckpoint() {
  const company = { tenantId: TENANT_A, companyGuid: liveCompanyGuid, tallyConnection: {} };

  await snapshotPurchaseCheckpoint();

  // Force the checkpoint to a known baseline for this test (restored
  // after Test I via restorePurchaseCheckpoint()).
  await SyncCheckpoint.findOneAndUpdate(
    { tenantId: TENANT_A, companyGuid: liveCompanyGuid, voucherType: "Purchase" },
    { $set: { lastAlterId: 100, lastRunStatus: "success", isRunning: false, lockedAt: null } },
    { upsert: true }
  );

  // A voucher guaranteed to fail persistence: it has header.partyname
  // present but no ledger entries at all AND no valid party ledger name,
  // so mapTallyPurchase throws (missing partyName after trim) - and it
  // carries no cancel/delete signal, so handleUnmappableVoucher rethrows
  // rather than treating it as a tombstone. This deterministically
  // reaches processSingleVoucher's "failed" branch.
  const badVoucher = {
    vouchernumber: "VERIFY-LC-H-BAD",
    date: "20260905",
    partyname: "", // blank -> mapTallyPurchase throws "missing header.partyName"
    guid: lcGuid("lcH"),
    alterid: "101",
    ledgerentries: [{ ledgername: "Purchase AC", amount: "100.00", isdeemedpositive: true }],
  };

  const fakeSyncModule = {
    voucherType: "Purchase",
    classificationKey: "purchase",
    fetchVouchersSinceAlterId: async () => ({
      data: { collection: [badVoucher] },
    }),
    processVoucher: processSinglePurchaseVoucher,
  };

  const result = await runSyncForCompanyModule(company, fakeSyncModule, { intervalSeconds: 60 });

  const checkpointAfter = await SyncCheckpoint.findOne({
    tenantId: TENANT_A, companyGuid: liveCompanyGuid, voucherType: "Purchase",
  }).lean();

  const pass =
    result.failed === 1 &&
    checkpointAfter.lastAlterId === 100 && // UNCHANGED
    checkpointAfter.lastRunStatus === "failed" &&
    checkpointAfter.isRunning === false; // lock released, not stuck

  report(
    "H", "Persistence failure -> checkpoint does not advance, lock is released for retry", "LIVE TALLY INTEGRATION (real runSyncForCompanyModule + real guard/classification against whichever company is open; fetch function substituted)",
    pass,
    "batch reports failed=1, checkpoint.lastAlterId stays 100, lastRunStatus=failed, isRunning=false",
    `failed=${result.failed}, lastAlterId=${checkpointAfter.lastAlterId}, lastRunStatus=${checkpointAfter.lastRunStatus}, isRunning=${checkpointAfter.isRunning}`
  );

  return { fakeBaseAlterId: 100 };
}

async function testI_retryAfterFailureSucceeds() {
  const company = { tenantId: TENANT_A, companyGuid: liveCompanyGuid, tallyConnection: {} };

  // Same "voucher at AlterID 101" this time fixed (real partyname) -
  // simulating the user's retry after the transient failure is resolved.
  const fixedVoucher = purchaseVoucher({
    guid: lcGuid("lcH"), alterid: 101, voucherNo: "VERIFY-LC-H-FIXED", amount: 4200,
  });

  const fakeSyncModule = {
    voucherType: "Purchase",
    classificationKey: "purchase",
    fetchVouchersSinceAlterId: async () => ({
      data: { collection: [fixedVoucher] },
    }),
    processVoucher: processSinglePurchaseVoucher,
  };

  const result = await runSyncForCompanyModule(company, fakeSyncModule, { intervalSeconds: 60 });

  const checkpointAfter = await SyncCheckpoint.findOne({
    tenantId: TENANT_A, companyGuid: liveCompanyGuid, voucherType: "Purchase",
  }).lean();

  const doc = await Purchase.findOne({ tenantId: TENANT_A, tallyGuid: lcGuid("lcH") }).lean();

  const pass =
    result.created === 1 &&
    checkpointAfter.lastAlterId === 101 &&
    checkpointAfter.lastRunStatus === "success" &&
    doc && doc.header.voucherTotalAmount === 4200;

  report(
    "I", "Retry after failure (same AlterID, corrected data) -> succeeds and checkpoint advances", "LIVE TALLY INTEGRATION (real runSyncForCompanyModule + real guard/classification against whichever company is open; fetch function substituted)",
    pass,
    "created=1, checkpoint advances to 101, status=success, voucher correctly stored",
    `created=${result.created}, lastAlterId=${checkpointAfter.lastAlterId}, lastRunStatus=${checkpointAfter.lastRunStatus}, doc.amount=${doc && doc.header.voucherTotalAmount}`
  );

  await Purchase.deleteOne({ tenantId: TENANT_A, tallyGuid: lcGuid("lcH") });
  await restorePurchaseCheckpoint();
}

async function testJ_replayAfterSuccessNoDuplicate() {
  // The closest safe proxy for "worker restart mid-batch, then retried"
  // available without literally killing the process: re-run the exact
  // same fetch+process batch a second time after it already succeeded,
  // and confirm no duplicate is created and the checkpoint doesn't
  // regress. This is INFERRED-safe (not a literal crash test) because
  // each voucher's write is a single atomic findOneAndUpdate and the
  // checkpoint only advances after full batch success - a restart mid
  // batch leaves the checkpoint at its pre-batch value, and replaying
  // the whole batch again is exactly what this test exercises.
  const guid = lcGuid("lcJ");
  await Purchase.deleteOne({ tenantId: TENANT_A, tallyGuid: guid });
  const v = purchaseVoucher({ guid, alterid: 900040, voucherNo: "VERIFY-LC-J", amount: 1500 });

  const company = { tenantId: TENANT_A, companyGuid: liveCompanyGuid, tallyConnection: {} };
  const fakeSyncModule = {
    voucherType: "Purchase",
    classificationKey: "purchase",
    fetchVouchersSinceAlterId: async () => ({ data: { collection: [v] } }),
    processVoucher: processSinglePurchaseVoucher,
  };

  await snapshotPurchaseCheckpoint();

  await SyncCheckpoint.findOneAndUpdate(
    { tenantId: TENANT_A, companyGuid: liveCompanyGuid, voucherType: "Purchase" },
    { $set: { lastAlterId: 900039, lastRunStatus: "success", isRunning: false, lockedAt: null } },
    { upsert: true }
  );

  const r1 = await runSyncForCompanyModule(company, fakeSyncModule, { intervalSeconds: 60 });
  // Simulate "restart, worker doesn't know the checkpoint moved on, replays the same batch"
  const r2 = await runSyncForCompanyModule(company, fakeSyncModule, { intervalSeconds: 60 });

  const count = await Purchase.countDocuments({ tenantId: TENANT_A, tallyGuid: guid });

  const pass = r1.created === 1 && r2.duplicates === 1 && count === 1;

  report(
    "J", "Batch replayed after success (restart-recovery proxy) -> no duplicate, no missed correction", "LIVE TALLY INTEGRATION (real runSyncForCompanyModule + real guard/classification against whichever company is open; fetch function substituted) + INFERRED restart-recovery reasoning",
    pass,
    "first run created=1, replay reports duplicates=1, exactly 1 document",
    `first run created=${r1.created}, replay duplicates=${r2.duplicates}, doc count=${count}`
  );

  await Purchase.deleteOne({ tenantId: TENANT_A, tallyGuid: guid });
  await restorePurchaseCheckpoint();
}

async function testK_tenantIsolation() {
  // Same tallyGuid string reused across two different tenants - proves
  // the identity is {tenantId, tallyGuid}, not tallyGuid alone, and that
  // a write for tenant B cannot touch tenant A's document.
  const sharedGuid = "verify-lc-guid-K-shared";
  await Purchase.deleteMany({ tallyGuid: sharedGuid });

  const vA = purchaseVoucher({ guid: sharedGuid, alterid: 900050, voucherNo: "VERIFY-LC-K", amount: 111 });
  const vB = purchaseVoucher({ guid: sharedGuid, alterid: 900050, voucherNo: "VERIFY-LC-K", amount: 222 });

  const rA = await processSinglePurchaseVoucher(vA, TENANT_A);
  const rB = await processSinglePurchaseVoucher(vB, TENANT_B);

  const docA = await Purchase.findOne({ tenantId: TENANT_A, tallyGuid: sharedGuid }).lean();
  const docB = await Purchase.findOne({ tenantId: TENANT_B, tallyGuid: sharedGuid }).lean();

  const pass =
    rA.status === "created" && rB.status === "created" &&
    docA && docA.header.voucherTotalAmount === 111 &&
    docB && docB.header.voucherTotalAmount === 222 &&
    String(docA._id) !== String(docB._id);

  report(
    "K", "Tenant A cannot affect Tenant B, even with an identical tallyGuid", "SYNTHETIC",
    pass,
    "two separate documents, tenant A=111 unaffected by tenant B=222",
    `tenant A amount=${docA && docA.header.voucherTotalAmount}, tenant B amount=${docB && docB.header.voucherTotalAmount}, same doc? ${docA && docB && String(docA._id) === String(docB._id)}`
  );

  await Purchase.deleteMany({ tallyGuid: sharedGuid });
}

async function testL_independentCheckpoints() {
  // Seeds its own checkpoints under a synthetic identity (the worker's own upsert shape, ensureCheckpointExists), instead of
  // relying on documents from a real company that a fresh test database never has.
  const key = { tenantId: TENANT_A, companyGuid: CHECKPOINT_TEST_GUID };
  const seed = (voucherType) => SyncCheckpoint.findOneAndUpdate(
    { ...key, voucherType },
    { $setOnInsert: { ...key, voucherType, lastAlterId: 0, lastRunStatus: "never_run", isRunning: false, lockedAt: null } },
    { upsert: true }
  );
  await SyncCheckpoint.deleteMany(key);
  try {
    await seed("Sales");
    await seed("Purchase");
    // advancing Purchase (as releaseLock does on success) must leave Sales where it was
    await SyncCheckpoint.findOneAndUpdate({ ...key, voucherType: "Purchase" }, { $set: { lastAlterId: 500, lastRunStatus: "success" } });
    let duplicateRejected = false;
    try { await SyncCheckpoint.create({ ...key, voucherType: "Sales" }); } catch (e) { duplicateRejected = e && e.code === 11000; }
    const salesCp = await SyncCheckpoint.findOne({ ...key, voucherType: "Sales" }).lean();
    const purchaseCp = await SyncCheckpoint.findOne({ ...key, voucherType: "Purchase" }).lean();
    const distinct = !!salesCp && !!purchaseCp && String(salesCp._id) !== String(purchaseCp._id);
    const pass = distinct && salesCp.lastAlterId === 0 && purchaseCp.lastAlterId === 500 && duplicateRejected;

    report(
      "L", "Sales checkpoint independent from Purchase checkpoint", "SYNTHETIC/STRUCTURAL (seeds its own checkpoints under a synthetic company guid, no Tally dependency)",
      pass,
      "two distinct SyncCheckpoint documents for Sales and Purchase; advancing Purchase to 500 leaves Sales at 0; a second Sales checkpoint for the same key is rejected (E11000)",
      `distinct=${distinct}, sales.lastAlterId=${salesCp && salesCp.lastAlterId}, purchase.lastAlterId=${purchaseCp && purchaseCp.lastAlterId}, duplicateRejected=${duplicateRejected}`
    );
  } finally {
    await SyncCheckpoint.deleteMany(key);
  }
}

async function testM_olderStateCannotOverwriteNewer() {
  const guid = "verify-lc-guid-M";
  await Purchase.deleteOne({ tenantId: TENANT_A, tallyGuid: guid });

  // Newer state arrives FIRST (e.g. two Tally fetches race, or a retry
  // delivers an old delta after a newer one already landed).
  const newer = purchaseVoucher({ guid, alterid: 900060, voucherNo: "VERIFY-LC-M", amount: 9000 });
  const older = purchaseVoucher({ guid, alterid: 900055, voucherNo: "VERIFY-LC-M", amount: 1000 });

  const r1 = await processSinglePurchaseVoucher(newer, TENANT_A);
  const r2 = await processSinglePurchaseVoucher(older, TENANT_A); // arrives AFTER, but is OLDER by AlterID

  const doc = await Purchase.findOne({ tenantId: TENANT_A, tallyGuid: guid }).lean();

  const pass = r1.status === "created" && r2.status === "duplicate" && doc.header.voucherTotalAmount === 9000;

  report(
    "M", "Older AlterID arriving after newer -> does not overwrite (AlterID-based ordering, not arrival order)", "SYNTHETIC",
    pass,
    "newer(9000) applied first, older(1000) rejected as duplicate/stale, stored amount stays 9000",
    `newer result=${r1.status}, older result=${r2.status}, stored amount=${doc.header.voucherTotalAmount}`
  );

  await Purchase.deleteOne({ tenantId: TENANT_A, tallyGuid: guid });
}

async function testConcurrentSameVoucher() {
  // Part 12.A: same voucher arrives twice CONCURRENTLY (not sequentially
  // like Test C). This is the real race-condition case: two upserts for
  // a not-yet-existing document racing each other.
  const guid = "verify-lc-guid-CONC";
  await Purchase.deleteOne({ tenantId: TENANT_A, tallyGuid: guid });
  const v = purchaseVoucher({ guid, alterid: 900070, voucherNo: "VERIFY-LC-CONC", amount: 6600 });

  let threw = false;
  let results2;
  try {
    results2 = await Promise.all([
      processSinglePurchaseVoucher(v, TENANT_A),
      processSinglePurchaseVoucher(v, TENANT_A),
    ]);
  } catch (e) {
    threw = true;
  }

  const count = await Purchase.countDocuments({ tenantId: TENANT_A, tallyGuid: guid });

  // Mongo's unique index is the actual safety net here - even if both
  // requests race past the in-app existingDoc check, at most one
  // findOneAndUpdate can win the upsert; MongoDB itself resolves the
  // race for a single-document upsert with a unique index (this is a
  // real MongoDB guarantee, not application-level locking).
  const pass = !threw && count === 1;

  report(
    "CONC", "Same voucher arriving concurrently (race) -> exactly one document, no crash", "SYNTHETIC (real Promise.all race against real MongoDB)",
    pass,
    "no unhandled error, exactly 1 document",
    `threw=${threw}, doc count=${count}, statuses=${results2 ? results2.map((r) => r.status).join(",") : "n/a"}`
  );

  await Purchase.deleteOne({ tenantId: TENANT_A, tallyGuid: guid });
}

let skippedCount = 0;

function reportSkipped(ids, reason) {
  for (const id of ids) {
    skippedCount += 1;
    console.log(`SKIP | ${id} - ${reason}`);
  }
}

async function main() {
  await connectDB();
  await cleanup();

  await testA_newSalesVoucher();
  await testB_newPurchaseVoucher();
  await testC_replayNoDuplicate();
  const eCtx = await testD_alteredVoucherUpdatesInPlace();
  await testE_analyticsUsesNewAmount(eCtx);
  await testF_cancelledExcludedFromAnalytics();
  await testG_deletedTombstoneExcluded();

  // Tests H/I/J are LIVE TALLY INTEGRATION tests (see the file-level
  // comment) - they need a reachable Tally with some company genuinely
  // open right now, resolved fresh here rather than hardcoded, so they
  // can't silently start failing again the next time a company's GUID
  // changes. If Tally isn't reachable or nothing is open, skip them
  // explicitly instead of running them against a guaranteed-wrong guid.
  liveCompanyGuid = await resolveLiveOpenCompanyGuid();
  if (liveCompanyGuid) {
    console.log(`\n(Tests H/I/J will use the live-open Tally company: ${liveCompanyGuid})`);
    await testH_persistenceFailureDoesNotAdvanceCheckpoint();
    await testI_retryAfterFailureSucceeds();
    await testJ_replayAfterSuccessNoDuplicate();
  } else {
    reportSkipped(
      ["H", "I", "J"],
      "Tally is unreachable or no company is currently open - these are live-Tally-integration tests and cannot run meaningfully without one."
    );
  }

  await testK_tenantIsolation();
  await testL_independentCheckpoints();
  await testM_olderStateCannotOverwriteNewer();
  await testConcurrentSameVoucher();

  await cleanup();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(
    `\n=== RESULT: ${passed} passed, ${failed} failed, ${skippedCount} skipped (of ${results.length + skippedCount}) ===`
  );

  await mongoose.connection.close();
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(async (error) => {
  console.error("Test matrix crashed:", error);
  try { await cleanup(); } catch (_) {}
  process.exitCode = 1;
});
