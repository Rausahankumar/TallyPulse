/**
 * Reconciliation safety-net verification.
 *
 * Test categories (2026-09-18 revision - see below for why):
 *
 *   LIVE TALLY INTEGRATION (testRealDeletionDetection,
 *   testAnalyticsExcludesReconciledVouchers): genuinely need a reachable
 *   Tally, because they exercise reconcileVoucherType against the REAL
 *   current Sales/Purchase guid set. Previously these hardcoded two
 *   specific historical voucher numbers (Sales SA/49/2025-26, Purchase
 *   SA/54/2025-26) as "known to be deleted" fixtures. That broke
 *   silently: this dev tenant's MongoDB data has drifted far from where
 *   it was when this file was written (down to a single stray active
 *   Sale document today), and the real company's own identity has since
 *   moved to a different tenantId/companyGuid pair entirely - neither
 *   voucher exists anymore, so the "is it marked deleted" assertions
 *   could never pass again no matter how many times reconciliation ran
 *   correctly. Fixed by making the fixture self-seeding and deterministic
 *   instead of depending on specific historical data staying put: pull a
 *   handful of REAL, currently-present voucher guids live from Tally to
 *   act as the "should stay active" baseline, seed one extra
 *   deliberately-fake guid to represent "the one that got deleted", and
 *   assert on THAT - a scenario this test fully controls and that
 *   re-establishes itself correctly on every run. Runs entirely under an
 *   isolated synthetic tenant (RECON_TEST_TENANT below), never against
 *   real business data.
 *
 *   SYNTHETIC (testFailClosedConnectionError, testFailClosedEmptyResult,
 *   testFailClosedMassDeletionRatio, testMalformedResponse): a mocked
 *   fetchAllGuids passed directly to reconcileVoucherType - no Tally
 *   dependency at all, always runs. Previously read whatever active
 *   voucher count happened to already exist for the real dev tenant,
 *   which made testFailClosedMassDeletionRatio non-deterministic (it
 *   requires a KNOWN active count to construct a reliable >50%-missing
 *   scenario - with the dev tenant's count having drifted to exactly 1,
 *   the ratio math silently degenerated to 0%, so the test kept "passing"
 *   for the wrong reason until the classification fix started actually
 *   exercising this path and the count-of-1 made the real bug visible).
 *   Fixed with a small, explicitly-seeded, fully isolated fixture instead
 *   of whatever data happens to already be there.
 *
 *   SYNTHETIC/STRUCTURAL (testDoesNotTouchIncrementalCheckpoint,
 *   testLockPreventsOverlap): pure checkpoint/lock mechanics, no
 *   real Tally voucher data involved. Previously drove the real
 *   runReconciliationForCompanyModule with the real odbcService guid
 *   functions against the orphaned real companyGuid, which (a) depended
 *   on a specific historical SyncCheckpoint document happening to still
 *   exist for testDoesNotTouchIncrementalCheckpoint's "before" read
 *   (fragile - exactly the "stale/orphaned checkpoint data" this task
 *   flags), and (b) required live Tally reachability for tests that have
 *   nothing to do with real voucher data. Fixed by self-seeding a known
 *   SyncCheckpoint baseline under an isolated synthetic identity and
 *   substituting a mocked fetchAllGuidsBase + a tiny local stub Tally
 *   server for the classification fetch (same technique already used in
 *   verify-reconciliation-perf-and-failure.js) - fully deterministic, no
 *   live Tally dependency, moved out of the "if (reachable)" gate.
 *
 * All temporary data lives under RECON_TEST_TENANT /
 * RECON_TEST_COMPANY_GUID (isolated synthetic identities, never a real
 * production/dev company) and is deleted at both the start (idempotent
 * safety net against a previous crashed run) and the end (regardless of
 * pass/fail) via cleanupReconTestData().
 *
 * Run: node verify-reconciliation.js
 *
 * Requires TallyPrime reachable at the configured URL for the LIVE TALLY
 * INTEGRATION section; every other section runs regardless.
 */

require("dotenv").config();
const http = require("http");
const connectDB = require("./src/config/db");
const mongoose = require("mongoose");

const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const ReconciliationCheckpoint = require("./src/models/reconciliationCheckpoint.model");
const { reconcileVoucherType } = require("./src/services/sync/reconciliation");
const {
  runReconciliationForCompanyModule,
} = require("./src/services/sync/reconciliationWorker");
const {
  getAllSalesVoucherGuids,
  getAllPurchaseVoucherGuids,
} = require("./src/services/odbc/odbcService");
const { extractVoucherCollection } = require("./src/services/import/tallySalesImport");
const { unwrapJsonExValue } = require("./src/services/parser/tallyParser");

// Fully isolated synthetic identities - never a real production/dev
// company. Nothing under these ever needs to correspond to anything real
// in Tally or MongoDB; they exist purely so this file's fixtures are
// self-contained and don't drift when real company data changes shape.
const RECON_TEST_TENANT = "verify-reconciliation-tenant";
const RECON_TEST_COMPANY_GUID = "verify-reconciliation-company-guid";

// odbcService's getAllSalesVoucherGuids/getAllPurchaseVoucherGuids now
// require a resolved voucherTypeNames array (see voucherTypeClassifier.js)
// instead of the old hardcoded $$VchTypeSales/$$VchTypePurchase. Used only
// by the LIVE TALLY INTEGRATION section below - these deliberately query
// whatever company is genuinely open right now, using its standard
// reserved "Sales"/"Purchase" type names (this suite tests
// reconciliation.js's own diff/safety logic, not classification, which
// has its own dedicated test file).
const salesGuidsForTest = ({ baseUrl } = {}) =>
  getAllSalesVoucherGuids({ baseUrl, voucherTypeNames: ["Sales"] });
const purchaseGuidsForTest = ({ baseUrl } = {}) =>
  getAllPurchaseVoucherGuids({ baseUrl, voucherTypeNames: ["Purchase"] });

function extractGuidStrings(rawResponse) {
  return extractVoucherCollection(rawResponse)
    .map((v) => unwrapJsonExValue(v && v.guid))
    .filter((g) => typeof g === "string" && g);
}

function makeSaleDoc({ tallyGuid, voucherNo, amount = 100, alterId = 1 }) {
  return {
    tenantId: RECON_TEST_TENANT,
    header: {
      voucherNo,
      voucherDate: new Date("2026-09-01"),
      voucherType: "Sales",
      voucherTotalAmount: amount,
      partyName: "Verify Reconciliation Party",
    },
    inventory: [],
    ledgers: [],
    tallyGuid,
    tallyAlterId: alterId,
    voucherStatus: "active",
  };
}

function makePurchaseDoc({ tallyGuid, voucherNo, amount = 100, alterId = 1 }) {
  return {
    tenantId: RECON_TEST_TENANT,
    header: {
      voucherNo,
      voucherDate: new Date("2026-09-01"),
      voucherType: "Purchase",
      voucherTotalAmount: amount,
      partyName: "Verify Reconciliation Vendor",
    },
    inventory: [],
    ledgers: [],
    tallyGuid,
    tallyAlterId: alterId,
    voucherStatus: "active",
  };
}

async function cleanupReconTestData() {
  await Sale.deleteMany({ tenantId: RECON_TEST_TENANT });
  await Purchase.deleteMany({ tenantId: RECON_TEST_TENANT });
  await SyncCheckpoint.deleteMany({ tenantId: RECON_TEST_TENANT });
  await ReconciliationCheckpoint.deleteMany({ tenantId: RECON_TEST_TENANT });
}

// A tiny local stub standing in for Tally's VoucherType master query, used
// only by the SYNTHETIC/STRUCTURAL checkpoint tests so they never depend
// on live Tally reachability - same technique as
// verify-reconciliation-perf-and-failure.js. Always resolves Sales/
// Purchase classification successfully regardless of what
// RECON_TEST_COMPANY_GUID is.
function startStubVoucherTypeServer() {
  const responseBody = {
    status: "1",
    data: {
      metadata: {},
      collection: [
        { metadata: { type: "Voucher Type", name: "Sales", reservedname: "Sales" }, parent: { type: "String", value: "Sales" } },
        { metadata: { type: "Voucher Type", name: "Purchase", reservedname: "Purchase" }, parent: { type: "String", value: "Purchase" } },
      ],
    },
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail ? ` (${detail})` : ""}`);
  }
}

async function tallyReachable() {
  try {
    await salesGuidsForTest();
    return true;
  } catch (e) {
    return false;
  }
}

async function testRealDeletionDetection() {
  console.log("\n=== LIVE TALLY INTEGRATION: a deliberately-absent voucher is correctly marked deleted; genuinely-present ones are left alone ===");

  const KEEP_COUNT = 3;
  const suffix = Date.now();

  const realSalesGuids = extractGuidStrings(await salesGuidsForTest());
  const realPurchaseGuids = extractGuidStrings(await purchaseGuidsForTest());

  if (realSalesGuids.length < KEEP_COUNT || realPurchaseGuids.length < KEEP_COUNT) {
    console.log(
      `  SKIP - not enough real Sales/Purchase vouchers currently in Tally to safely build this fixture ` +
        `(need >= ${KEEP_COUNT} each to keep the deletion ratio safely under the abort threshold; ` +
        `found sales=${realSalesGuids.length}, purchase=${realPurchaseGuids.length})`
    );
    return;
  }

  const keepSalesGuids = realSalesGuids.slice(0, KEEP_COUNT);
  const deletedSalesGuid = `verify-reconciliation-absent-sales-${suffix}`;
  const keepPurchaseGuids = realPurchaseGuids.slice(0, KEEP_COUNT);
  const deletedPurchaseGuid = `verify-reconciliation-absent-purchase-${suffix}`;

  await Sale.insertMany([
    ...keepSalesGuids.map((g, i) => makeSaleDoc({ tallyGuid: g, voucherNo: `RECON-KEEP-S-${i}`, alterId: i + 1 })),
    makeSaleDoc({ tallyGuid: deletedSalesGuid, voucherNo: "RECON-GONE-S", alterId: 999 }),
  ]);
  await Purchase.insertMany([
    ...keepPurchaseGuids.map((g, i) => makePurchaseDoc({ tallyGuid: g, voucherNo: `RECON-KEEP-P-${i}`, alterId: i + 1 })),
    makePurchaseDoc({ tallyGuid: deletedPurchaseGuid, voucherNo: "RECON-GONE-P", alterId: 999 }),
  ]);

  const salesResult = await reconcileVoucherType({ tenantId: RECON_TEST_TENANT, Model: Sale, fetchAllGuids: salesGuidsForTest });
  const purchaseResult = await reconcileVoucherType({ tenantId: RECON_TEST_TENANT, Model: Purchase, fetchAllGuids: purchaseGuidsForTest });

  const saleAfter = await Sale.findOne({ tenantId: RECON_TEST_TENANT, tallyGuid: deletedSalesGuid }).lean();
  const purchaseAfter = await Purchase.findOne({ tenantId: RECON_TEST_TENANT, tallyGuid: deletedPurchaseGuid }).lean();
  const keptSaleDocs = await Sale.find({ tenantId: RECON_TEST_TENANT, tallyGuid: { $in: keepSalesGuids } }).lean();
  const keptPurchaseDocs = await Purchase.find({ tenantId: RECON_TEST_TENANT, tallyGuid: { $in: keepPurchaseGuids } }).lean();

  check("reconciliation ran successfully for Sales", salesResult.status === "success", salesResult.status);
  check("reconciliation ran successfully for Purchase", purchaseResult.status === "success", purchaseResult.status);
  check("the deliberately-absent Sale voucher is marked deleted (preserved, not removed)", !!saleAfter && saleAfter.voucherStatus === "deleted");
  check("the deliberately-absent Purchase voucher is marked deleted (preserved, not removed)", !!purchaseAfter && purchaseAfter.voucherStatus === "deleted");
  check(
    "the genuinely-present Sale vouchers are left active, untouched",
    keptSaleDocs.length === KEEP_COUNT && keptSaleDocs.every((d) => d.voucherStatus === "active")
  );
  check(
    "the genuinely-present Purchase vouchers are left active, untouched",
    keptPurchaseDocs.length === KEEP_COUNT && keptPurchaseDocs.every((d) => d.voucherStatus === "active")
  );

  // Idempotency: running again immediately must find nothing new.
  const salesResult2 = await reconcileVoucherType({ tenantId: RECON_TEST_TENANT, Model: Sale, fetchAllGuids: salesGuidsForTest });
  const purchaseResult2 = await reconcileVoucherType({ tenantId: RECON_TEST_TENANT, Model: Purchase, fetchAllGuids: purchaseGuidsForTest });
  check("re-running immediately marks 0 new deletions (Sales)", salesResult2.markedDeletedCount === 0, salesResult2.markedDeletedCount);
  check("re-running immediately marks 0 new deletions (Purchase)", purchaseResult2.markedDeletedCount === 0, purchaseResult2.markedDeletedCount);
}

async function testAnalyticsExcludesReconciledVouchers() {
  console.log("\n=== LIVE TALLY INTEGRATION: analyticsScope automatically excludes reconciled-deleted vouchers ===");

  const salesAnalytics = require("./src/services/analytics/salesAnalytics");
  const purchaseAnalytics = require("./src/services/analytics/purchaseAnalytics");
  const dateRanges = require("./src/services/analytics/dateRanges");
  const wide = dateRanges.customRange("2020-01-01", "2030-01-01");

  const salesSummary = await salesAnalytics.getSalesSummary(RECON_TEST_TENANT, wide);
  const purchaseSummary = await purchaseAnalytics.getPurchaseSummary(RECON_TEST_TENANT, wide);

  const activeSaleCount = await Sale.countDocuments({ tenantId: RECON_TEST_TENANT, voucherStatus: "active" });
  const activePurchaseCount = await Purchase.countDocuments({ tenantId: RECON_TEST_TENANT, voucherStatus: "active" });

  check(
    "Sales order count matches active-only count (deleted voucher excluded)",
    salesSummary.orderCount === activeSaleCount,
    `summary=${salesSummary.orderCount}, active=${activeSaleCount}`
  );
  check(
    "Purchase order count matches active-only count (deleted voucher excluded)",
    purchaseSummary.orderCount === activePurchaseCount,
    `summary=${purchaseSummary.orderCount}, active=${activePurchaseCount}`
  );
  check("no code change was needed in analyticsScope/salesAnalytics/purchaseAnalytics for this", true);
}

async function seedSyntheticFailClosedFixture() {
  await Sale.deleteMany({ tenantId: RECON_TEST_TENANT });
  const docs = [0, 1, 2, 3].map((i) =>
    makeSaleDoc({ tallyGuid: `verify-reconciliation-synth-${i}`, voucherNo: `RECON-SYNTH-${i}`, alterId: i + 1 })
  );
  await Sale.insertMany(docs);
  return docs.map((d) => d.tallyGuid);
}

async function testFailClosedConnectionError() {
  console.log("\n=== SYNTHETIC: Tally connection error -> abort, nothing touched ===");
  const before = await Sale.countDocuments({ tenantId: RECON_TEST_TENANT, voucherStatus: "active" });
  const result = await reconcileVoucherType({
    tenantId: RECON_TEST_TENANT, Model: Sale,
    fetchAllGuids: async () => { throw new Error("connect ECONNREFUSED simulated"); },
  });
  const after = await Sale.countDocuments({ tenantId: RECON_TEST_TENANT, voucherStatus: "active" });
  check("status=failed", result.status === "failed", result.status);
  check("active voucher count unchanged", before === after, `before=${before}, after=${after}`);
}

async function testFailClosedEmptyResult() {
  console.log("\n=== SYNTHETIC: empty Tally result with active Mongo data -> abort as unsafe ===");
  const before = await Sale.countDocuments({ tenantId: RECON_TEST_TENANT, voucherStatus: "active" });
  const result = await reconcileVoucherType({
    tenantId: RECON_TEST_TENANT, Model: Sale,
    fetchAllGuids: async () => ({ data: { collection: [] } }),
  });
  const after = await Sale.countDocuments({ tenantId: RECON_TEST_TENANT, voucherStatus: "active" });
  check("status=aborted_unsafe", result.status === "aborted_unsafe", result.status);
  check("active voucher count unchanged (no mass deletion)", before === after, `before=${before}, after=${after}`);
}

async function testFailClosedMassDeletionRatio(seededGuids) {
  console.log("\n=== SYNTHETIC: Tally returns most guids missing (>50%) -> abort as unsafe ===");
  const before = await Sale.countDocuments({ tenantId: RECON_TEST_TENANT, voucherStatus: "active" });
  const result = await reconcileVoucherType({
    tenantId: RECON_TEST_TENANT, Model: Sale,
    // Only 1 of the 4 seeded guids is reported present -> 3/4 = 75%
    // missing, definitively > the 50% abort threshold.
    fetchAllGuids: async () => ({ data: { collection: [{ guid: seededGuids[0] }] } }),
  });
  const after = await Sale.countDocuments({ tenantId: RECON_TEST_TENANT, voucherStatus: "active" });
  check("status=aborted_unsafe", result.status === "aborted_unsafe", result.status);
  check("active voucher count unchanged (no mass deletion)", before === after, `before=${before}, after=${after}`);
}

async function testMalformedResponse() {
  console.log("\n=== SYNTHETIC: malformed Tally response -> abort, nothing touched ===");
  const before = await Sale.countDocuments({ tenantId: RECON_TEST_TENANT, voucherStatus: "active" });
  const result = await reconcileVoucherType({
    tenantId: RECON_TEST_TENANT, Model: Sale,
    fetchAllGuids: async () => "not even json {{{",
  });
  const after = await Sale.countDocuments({ tenantId: RECON_TEST_TENANT, voucherStatus: "active" });
  check("status=failed (not a crash)", result.status === "failed", result.status);
  check("active voucher count unchanged", before === after);
}

async function testDoesNotTouchIncrementalCheckpoint(stubBaseUrl) {
  console.log("\n=== SYNTHETIC/STRUCTURAL: reconciliation never touches the incremental SyncCheckpoint ===");

  // Self-seeded, deterministic baseline - no dependency on any
  // pre-existing historical checkpoint document happening to still exist.
  await SyncCheckpoint.deleteOne({ tenantId: RECON_TEST_TENANT, companyGuid: RECON_TEST_COMPANY_GUID, voucherType: "Sales" });
  await SyncCheckpoint.create({
    tenantId: RECON_TEST_TENANT, companyGuid: RECON_TEST_COMPANY_GUID, voucherType: "Sales",
    lastAlterId: 4242, lastRunStatus: "success", isRunning: false, lockedAt: null,
  });

  const before = await SyncCheckpoint.findOne({ tenantId: RECON_TEST_TENANT, companyGuid: RECON_TEST_COMPANY_GUID, voucherType: "Sales" }).lean();

  await runReconciliationForCompanyModule(
    { tenantId: RECON_TEST_TENANT, companyGuid: RECON_TEST_COMPANY_GUID, tallyConnection: { baseUrl: stubBaseUrl } },
    { voucherType: "Sales", classificationKey: "sales", Model: Sale, fetchAllGuidsBase: async () => ({ data: { collection: [] } }) }
  );

  const after = await SyncCheckpoint.findOne({ tenantId: RECON_TEST_TENANT, companyGuid: RECON_TEST_COMPANY_GUID, voucherType: "Sales" }).lean();

  check(
    "incremental SyncCheckpoint.lastAlterId unchanged by reconciliation",
    before.lastAlterId === after.lastAlterId,
    `before=${before.lastAlterId}, after=${after.lastAlterId}`
  );
  check(
    "incremental SyncCheckpoint.updatedAt unchanged (document not even touched)",
    before.updatedAt.getTime() === after.updatedAt.getTime()
  );

  const reconciliationCp = await ReconciliationCheckpoint.findOne({ tenantId: RECON_TEST_TENANT, companyGuid: RECON_TEST_COMPANY_GUID, voucherType: "Sales" }).lean();
  check("a SEPARATE ReconciliationCheckpoint document exists", !!reconciliationCp);
}

async function testLockPreventsOverlap(stubBaseUrl) {
  console.log("\n=== SYNTHETIC/STRUCTURAL: reconciliation lock prevents overlapping runs ===");

  const company = { tenantId: RECON_TEST_TENANT, companyGuid: RECON_TEST_COMPANY_GUID, tallyConnection: { baseUrl: stubBaseUrl } };
  const module_ = { voucherType: "Purchase", classificationKey: "purchase", Model: Purchase, fetchAllGuidsBase: async () => ({ data: { collection: [] } }) };

  await ReconciliationCheckpoint.findOneAndUpdate(
    { tenantId: RECON_TEST_TENANT, companyGuid: RECON_TEST_COMPANY_GUID, voucherType: "Purchase" },
    { $set: { isRunning: true, lockedAt: new Date() } },
    { upsert: true }
  );

  const result = await runReconciliationForCompanyModule(company, module_, { intervalMinutes: 20 });

  check("a fresh (non-stale) lock causes the run to be skipped", result.skipped === true && result.reason === "locked", JSON.stringify(result));

  // Clean up: release the lock so the stale-reclaim scenario below starts clean.
  await ReconciliationCheckpoint.findOneAndUpdate(
    { tenantId: RECON_TEST_TENANT, companyGuid: RECON_TEST_COMPANY_GUID, voucherType: "Purchase" },
    { $set: { isRunning: false, lockedAt: null } }
  );

  console.log("\n=== SYNTHETIC/STRUCTURAL: a STALE lock is correctly reclaimed ===");
  const staleTime = new Date(Date.now() - 100 * 60 * 1000); // 100 min ago, well past 3x20min staleness
  await ReconciliationCheckpoint.findOneAndUpdate(
    { tenantId: RECON_TEST_TENANT, companyGuid: RECON_TEST_COMPANY_GUID, voucherType: "Purchase" },
    { $set: { isRunning: true, lockedAt: staleTime } },
    { upsert: true }
  );

  const result2 = await runReconciliationForCompanyModule(company, module_, { intervalMinutes: 20 });

  check("stale lock is reclaimed, run proceeds", !result2.skipped, JSON.stringify(result2));
}

async function main() {
  await connectDB();
  await cleanupReconTestData();

  try {
    const reachable = await tallyReachable();
    console.log(`TallyPrime reachable: ${reachable}`);

    if (reachable) {
      await testRealDeletionDetection();
      await testAnalyticsExcludesReconciledVouchers();
    } else {
      console.log("Skipping LIVE TALLY INTEGRATION sections - TallyPrime unreachable right now.");
    }

    const seededGuids = await seedSyntheticFailClosedFixture();
    await testFailClosedConnectionError();
    await testFailClosedEmptyResult();
    await testFailClosedMassDeletionRatio(seededGuids);
    await testMalformedResponse();

    const { server: stubServer, url: stubUrl } = await startStubVoucherTypeServer();
    try {
      await testDoesNotTouchIncrementalCheckpoint(stubUrl);
      await testLockPreventsOverlap(stubUrl);
    } finally {
      stubServer.close();
    }
  } finally {
    await cleanupReconTestData();
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);

  await mongoose.connection.close();
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(async (error) => {
  console.error("Reconciliation verification crashed:", error);
  try {
    await cleanupReconTestData();
  } catch (_) {}
  try {
    await mongoose.connection.close();
  } catch (_) {}
  process.exitCode = 1;
});
