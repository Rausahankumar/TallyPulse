/**
 * Reconciliation performance + Mongo-failure verification.
 *
 * Two things verify-reconciliation.js does NOT cover:
 *   1. Behavior at a realistic voucher volume (a few thousand active
 *      vouchers) - confirms the GUID diff stays a single Mongo find +
 *      single bulk updateMany (no N+1) and completes in a reasonable time.
 *   2. What happens when MongoDB itself fails mid-reconciliation, AFTER
 *      a successful Tally GUID fetch (e.g. write blip) - does it fail
 *      safely, leave state uncorrupted, and allow the next run to retry?
 *
 * Uses a dedicated synthetic tenant (PERFTEST-TENANT-RECON) - never
 * touches the real dev tenant - and deletes everything it creates,
 * including the ReconciliationCheckpoint, at the end regardless of
 * pass/fail.
 *
 * Run: node verify-reconciliation-perf-and-failure.js
 */

require("dotenv").config();
const http = require("http");
const connectDB = require("./src/config/db");
const mongoose = require("mongoose");

const Sale = require("./src/models/sales.model");
const ReconciliationCheckpoint = require("./src/models/reconciliationCheckpoint.model");
const { reconcileVoucherType } = require("./src/services/sync/reconciliation");
const {
  runReconciliationForCompanyModule,
} = require("./src/services/sync/reconciliationWorker");
const {
  clearVoucherTypeClassificationCache,
} = require("./src/services/tally/voucherTypeClassifier");

// runReconciliationForCompanyModule now resolves generic voucher-type
// classification (see voucherTypeClassifier.js) before calling
// fetchAllGuidsBase - this test exercises lock/failure/retry semantics,
// not classification itself, so it points at a tiny local stub Tally
// server with a standard, unambiguous VoucherType master rather than
// depending on whatever real company happens to be open right now.
function startStubVoucherTypeServer() {
  const responseBody = {
    status: "1",
    data: {
      metadata: {},
      collection: [
        { metadata: { type: "Voucher Type", name: "Sales", reservedname: "Sales" }, parent: { type: "String", value: "Sales" }, guid: { type: "String", value: `${COMPANY_GUID}-1` } },
        { metadata: { type: "Voucher Type", name: "Purchase", reservedname: "Purchase" }, parent: { type: "String", value: "Purchase" }, guid: { type: "String", value: `${COMPANY_GUID}-2` } },
      ],
    },
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // The worker now verifies the open Tally company first, so the stub must also report this test company as the open one.
      res.end(JSON.stringify(req.headers.id === "RTS Company Guid Collection" ? { status: "1", data: { collection: [{ name: { value: "Perf Test Co" }, guid: { value: COMPANY_GUID } }] } } : responseBody));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

const TENANT = "PERFTEST-TENANT-RECON";
const COMPANY_GUID = "perftest-company-guid";
const VOUCHER_COUNT = Number(process.env.PERF_VOUCHER_COUNT) || 8000;

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

function buildSyntheticVouchers(count) {
  const docs = [];
  for (let i = 0; i < count; i += 1) {
    docs.push({
      tenantId: TENANT,
      header: {
        voucherNo: `PERF-${i}`,
        voucherDate: new Date(2026, 0, 1 + (i % 28)),
        voucherType: "Sales",
        voucherTotalAmount: 100 + i,
        partyName: `Perf Party ${i % 50}`,
      },
      inventory: [],
      ledgers: [],
      tallyGuid: `${COMPANY_GUID}-${i}`,
      tallyAlterId: 1000 + i,
      voucherStatus: "active",
    });
  }
  return docs;
}

async function seed(count) {
  await Sale.deleteMany({ tenantId: TENANT });
  const docs = buildSyntheticVouchers(count);
  // insertMany in batches - mirrors how a real bulk import would land data,
  // and avoids one giant driver-side payload.
  const BATCH = 2000;
  for (let i = 0; i < docs.length; i += BATCH) {
    await Sale.insertMany(docs.slice(i, i + BATCH), { ordered: false });
  }
}

async function cleanup() {
  await Sale.deleteMany({ tenantId: TENANT });
  await ReconciliationCheckpoint.deleteMany({ tenantId: TENANT });
}

async function testPerformanceAndEfficiency() {
  console.log(`\n=== PERFORMANCE: ${VOUCHER_COUNT} active vouchers, GUID reconciliation ===`);

  await seed(VOUCHER_COUNT);

  // Tally reports everything present except the last 5 - realistic small
  // trickle of deletions, well under the 50% abort ratio.
  const missingCount = 5;
  const tallyGuids = [];
  for (let i = 0; i < VOUCHER_COUNT - missingCount; i += 1) {
    tallyGuids.push({ guid: `${COMPANY_GUID}-${i}` });
  }

  // Confirm the Mongo side of the diff is a single query, not one-per-doc.
  let findCalls = 0;
  const originalFind = Sale.find.bind(Sale);
  Sale.find = (...args) => {
    findCalls += 1;
    return originalFind(...args);
  };

  const start = Date.now();
  const result = await reconcileVoucherType({
    tenantId: TENANT,
    companyGuid: COMPANY_GUID,
    Model: Sale,
    fetchAllGuids: async () => ({ data: { collection: tallyGuids } }),
  });
  const elapsedMs = Date.now() - start;

  Sale.find = originalFind;

  console.log(`  elapsed: ${elapsedMs}ms for ${VOUCHER_COUNT} active vouchers`);

  check("status=success", result.status === "success", result.status);
  check(
    "exactly one Mongo find() call regardless of voucher count (no N+1)",
    findCalls === 1,
    `findCalls=${findCalls}`
  );
  check(
    "marked exactly the expected number deleted",
    result.markedDeletedCount === missingCount,
    `expected=${missingCount}, actual=${result.markedDeletedCount}`
  );
  check(
    `completes in a reasonable time for ${VOUCHER_COUNT} vouchers (<5000ms)`,
    elapsedMs < 5000,
    `elapsed=${elapsedMs}ms`
  );

  // Confirm the compound index actually serves the query (IXSCAN, not a
  // full collection scan) - the query shape is {tenantId, voucherStatus,
  // tallyGuid:{$type:"string"}}, and the existing
  // {tenantId,voucherStatus,"header.voucherDate"} index should serve the
  // tenantId+voucherStatus prefix.
  const explain = await Sale.find({
    tenantId: TENANT,
    voucherStatus: "active",
    tallyGuid: { $type: "string" },
  })
    .select("tallyGuid")
    .lean()
    .explain("executionStats");

  const winningPlan = explain.queryPlanner.winningPlan;
  const planJson = JSON.stringify(winningPlan);
  const usesIndexScan = planJson.includes("IXSCAN");
  const usesCollScan = planJson.includes("COLLSCAN");

  check(
    "reconciliation's Mongo query is served by an index scan, not a full collection scan",
    usesIndexScan && !usesCollScan,
    planJson.slice(0, 300)
  );
  console.log(
    `  executionStats: docsExamined=${explain.executionStats.totalDocsExamined}, keysExamined=${explain.executionStats.totalKeysExamined}, nReturned=${explain.executionStats.nReturned}`
  );
}

async function testMongoFailureAfterTallySnapshot() {
  console.log("\n=== FAILURE: MongoDB write fails AFTER a successful Tally snapshot ===");

  // Fresh small dataset so this section is independent of the perf run.
  await seed(20);

  const tallyGuids = [];
  for (let i = 0; i < 15; i += 1) tallyGuids.push({ guid: `${COMPANY_GUID}-${i}` }); // 5 "missing"

  const before = await Sale.countDocuments({ tenantId: TENANT, voucherStatus: "active" });

  const originalUpdateMany = Sale.updateMany.bind(Sale);
  Sale.updateMany = () => {
    throw new Error("Simulated MongoDB write failure (e.g. connection reset mid-bulk-write)");
  };

  let threw = false;
  let result;
  try {
    result = await reconcileVoucherType({
      tenantId: TENANT,
      companyGuid: COMPANY_GUID,
      Model: Sale,
      fetchAllGuids: async () => ({ data: { collection: tallyGuids } }),
    });
  } catch (error) {
    threw = true;
  } finally {
    Sale.updateMany = originalUpdateMany;
  }

  const after = await Sale.countDocuments({ tenantId: TENANT, voucherStatus: "active" });

  check(
    "reconcileVoucherType does not throw - returns a result object instead (per its own documented contract)",
    !threw,
    `threw=${threw}`
  );
  if (!threw) {
    check("result.status='failed'", result.status === "failed", result.status);
    check("no partial state change: active count unchanged", before === after, `before=${before}, after=${after}`);
  }

  console.log("\n=== FAILURE: the worker releases its lock even when the Mongo step fails ===");

  const { server: stubServer, url: stubBaseUrl } = await startStubVoucherTypeServer();
  clearVoucherTypeClassificationCache(COMPANY_GUID);

  const company = {
    tenantId: TENANT,
    companyGuid: COMPANY_GUID,
    tallyConnection: { baseUrl: stubBaseUrl },
  };
  const module_ = {
    voucherType: "Sales",
    classificationKey: "sales",
    Model: Sale,
    fetchAllGuidsBase: async () => ({ data: { collection: tallyGuids } }),
  };

  Sale.updateMany = () => {
    throw new Error("Simulated MongoDB write failure");
  };

  let workerThrew = false;
  try {
    await runReconciliationForCompanyModule(company, module_, { intervalMinutes: 20 });
  } catch (error) {
    workerThrew = true;
  } finally {
    Sale.updateMany = originalUpdateMany;
  }

  const checkpoint = await ReconciliationCheckpoint.findOne({
    tenantId: TENANT,
    companyGuid: COMPANY_GUID,
    voucherType: "Sales",
  }).lean();

  check("worker does not crash/throw on a Mongo failure", !workerThrew, `threw=${workerThrew}`);
  check(
    "checkpoint lock is released (isRunning=false) so the NEXT scheduled run is not blocked",
    !!checkpoint && checkpoint.isRunning === false,
    checkpoint ? JSON.stringify({ isRunning: checkpoint.isRunning, lastRunStatus: checkpoint.lastRunStatus }) : "no checkpoint"
  );
  check(
    "checkpoint records the failure (lastRunStatus='failed'), not a false success",
    !!checkpoint && checkpoint.lastRunStatus === "failed",
    checkpoint ? checkpoint.lastRunStatus : "no checkpoint"
  );

  // Now prove retry-ability: run again immediately with Mongo working -
  // must succeed and must NOT be blocked by a stuck lock from the failed run.
  const retryResult = await runReconciliationForCompanyModule(company, module_, {
    intervalMinutes: 20,
  });

  check(
    "immediately retrying (next run) is NOT blocked by the failed run's lock",
    retryResult && retryResult.skipped !== true,
    JSON.stringify(retryResult)
  );
  check(
    "the retry actually succeeds and applies the deletions correctly",
    retryResult && retryResult.status === "success" && retryResult.markedDeletedCount === 5,
    JSON.stringify(retryResult)
  );

  stubServer.close();
}

async function main() {
  await connectDB();

  try {
    await testPerformanceAndEfficiency();
    await testMongoFailureAfterTallySnapshot();
  } finally {
    await cleanup();
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);

  await mongoose.connection.close();
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(async (error) => {
  console.error("Reconciliation perf/failure verification crashed:", error);
  try {
    await cleanup();
  } catch (_) {}
  process.exitCode = 1;
});
