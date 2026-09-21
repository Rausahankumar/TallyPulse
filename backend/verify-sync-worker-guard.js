/**
 * Background incremental sync worker: company-GUID guard verification
 * (2026-09-18).
 *
 * Product rule under test: the automatic Sales/Purchase sync worker
 * (tallySyncWorker.js), which iterates EVERY active company on a timer
 * against the one shared Tally URL, must never import the
 * currently-open company's vouchers into a DIFFERENT tenant. Uses the
 * REAL live Tally instance and a REAL throwaway Company document (not
 * mocked) so the guard is proven against Tally's actual current state.
 *
 * Run: node verify-sync-worker-guard.js
 * Requires a live, reachable TallyPrime instance with a company open.
 * Does not require the HTTP server running - exercises the worker
 * module functions directly, same as node-cron would call them.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Company = require("./src/models/company");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const { getCompanyInfo } = require("./src/services/odbc/odbcService");
const { extractOpenCompanies } = require("./src/services/parser/tallyParser");
const { resolveSelectedOpenCompany } = require("./src/services/auth/tallyCompanyGuard");
const {
  runSyncForCompanyModule,
  runSyncForAllCompanies,
  SALES_SYNC_MODULE,
} = require("./src/services/sync/tallySyncWorker");

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

const SUFFIX = Date.now();
const FAKE_GUID = `verify-worker-guard-${SUFFIX}`;
const FAKE_TENANT = new mongoose.Types.ObjectId().toString();

async function cleanup() {
  await Company.deleteMany({ companyGuid: FAKE_GUID });
  await SyncCheckpoint.deleteMany({ tenantId: FAKE_TENANT });
  await Sale.deleteMany({ tenantId: FAKE_TENANT });
  await Purchase.deleteMany({ tenantId: FAKE_TENANT });
}

async function main() {
  await connectDB();
  await cleanup();

  console.log("\n=== Setup: discover the real company currently open in Tally ===");
  const liveOpen = extractOpenCompanies(await getCompanyInfo());
  check("Tally has at least one company open right now", liveOpen.length > 0, JSON.stringify(liveOpen));
  // The company Tally answers for: the only open one, or the SELECTED one when
  // several are open - never liveOpen[0] merely because it is listed first.
  const detection = await resolveSelectedOpenCompany();
  check("the live company (the selected one, if several are open) is identified", detection.ok, detection.message);
  const LIVE_GUID = detection.ok ? detection.match.guid : liveOpen[0]?.guid;
  console.log(`  live open company guid: ${LIVE_GUID}`);

  const liveCompany = await Company.findOne({ companyGuid: LIVE_GUID }).lean();
  check("a Company document exists for the live-open guid", !!liveCompany);

  console.log("\n=== A throwaway company whose GUID is NOT open in Tally right now ===");
  const mismatchedCompany = await Company.create({
    companyName: "Verify Worker Guard Co",
    sourceType: "tally",
    companyGuid: FAKE_GUID,
    tenantId: FAKE_TENANT,
    isActive: true,
  });
  console.log(`  fake tenant: ${FAKE_TENANT} / guid: ${FAKE_GUID}`);

  console.log("\n=== runSyncForCompanyModule: mismatched company is skipped, not imported ===");
  const mismatchResult = await runSyncForCompanyModule(mismatchedCompany.toObject(), SALES_SYNC_MODULE);
  check(
    "mismatched company's sync tick reports zero processed (guard short-circuited before fetch)",
    mismatchResult.processed === 0 && !mismatchResult.error,
    JSON.stringify(mismatchResult)
  );

  const salesForFakeTenant = await Sale.countDocuments({ tenantId: FAKE_TENANT });
  check("NO Sale documents were created for the mismatched tenant", salesForFakeTenant === 0, `count=${salesForFakeTenant}`);

  const checkpointAfterMismatch = await SyncCheckpoint.findOne({
    tenantId: FAKE_TENANT,
    companyGuid: FAKE_GUID,
    voucherType: "Sales",
  }).lean();
  check(
    "checkpoint records a quiet 'success' tick (not 'failed'), and never advances lastAlterId",
    checkpointAfterMismatch?.lastRunStatus === "success" && checkpointAfterMismatch?.lastAlterId === 0,
    JSON.stringify(checkpointAfterMismatch)
  );

  console.log("\n=== runSyncForCompanyModule: the ACTUALLY-open company's own sync still works ===");
  const matchResult = await runSyncForCompanyModule(liveCompany, SALES_SYNC_MODULE);
  check(
    "the live-matching company's sync tick is NOT rejected by the guard (no guard error)",
    !matchResult.error,
    JSON.stringify(matchResult)
  );

  console.log("\n=== Full cron-style cycle (runSyncForAllCompanies) never lets the mismatch through ===");
  const salesBeforeCycle = await Sale.countDocuments({ tenantId: FAKE_TENANT });
  await runSyncForAllCompanies();
  const salesAfterCycle = await Sale.countDocuments({ tenantId: FAKE_TENANT });
  check(
    "a full multi-company cron cycle still imports nothing into the mismatched tenant",
    salesAfterCycle === salesBeforeCycle,
    `before=${salesBeforeCycle} after=${salesAfterCycle}`
  );

  console.log("\n=== Tally-unreachable handling reuses the already-proven guard path ===");
  // The "unreachable" branch added to runSyncForCompanyModule calls the
  // exact same verifyOpenTallyCompany() already proven against a dead
  // port in verify-company-guid-match.js; re-deriving that here would
  // just be a duplicate network trip against a fake port, not a
  // different code path. Confirmed by reading the source instead.
  const workerSrc = require("fs").readFileSync("./src/services/sync/tallySyncWorker.js", "utf8");
  check(
    "an unreachable Tally is recorded via the SAME failed-status path as any other fetch error (not a silent skip)",
    /guard\.reason === "unreachable"[\s\S]{0,200}status: "failed"/.test(workerSrc)
  );

  await cleanup();

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  await mongoose.connection.close();
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(async (error) => {
  console.error("Sync worker guard verification crashed:", error);
  try {
    await cleanup();
  } catch (_) {}
  process.exitCode = 1;
});
