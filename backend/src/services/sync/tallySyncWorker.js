const cron = require("node-cron");

const Company = require("../../models/company");
const SyncCheckpoint = require("../../models/syncCheckpoint.model");
const { getSalesVouchersSinceAlterId } = require("../odbc/odbcService");
const {
  extractVoucherCollection,
  processSingleVoucher,
} = require("../import/tallySalesImport");

// --------------------------------------------------
// Background incremental sync worker.
//
// TallyPrime -> (poll) -> detect vouchers changed since the last checkpoint
// via $AlterID -> existing parser/mapper/validation -> tenant-safe
// MongoDB upsert (processSingleVoucher, shared with the manual import
// endpoints) -> advance the checkpoint, but ONLY on a fully successful
// batch.
//
// Runs entirely in-process via node-cron; started from server.js once
// MongoDB is connected. Each company is synced independently so one
// tenant's Tally/Mongo failure never blocks the others.
// --------------------------------------------------

const VOUCHER_TYPE = "Sales";

const DEFAULT_INTERVAL_SECONDS =
  Number(process.env.TALLY_SYNC_INTERVAL_SECONDS) || 60;

// If a lock has been held longer than this, assume the process that took
// it crashed mid-run and reclaim it, rather than wedging that company's
// sync forever. A generous multiple of the poll interval, independent of
// how long a single Tally call is allowed to take (odbcService's own
// 30s axios timeout bounds that separately).
const LOCK_STALE_MULTIPLIER = 5;

let scheduledTask = null;
let cycleInProgress = false;

function resolveTallyBaseUrl(company) {
  // undefined -> odbcService falls back to its own DEFAULT_TALLY_URL.
  // This is the seam that lets each Company eventually point at its own
  // TallyPrime instance without any worker code changes.
  return (
    (company.tallyConnection && company.tallyConnection.baseUrl) ||
    undefined
  );
}

async function ensureCheckpointExists(tenantId, companyGuid) {
  await SyncCheckpoint.findOneAndUpdate(
    { tenantId, companyGuid, voucherType: VOUCHER_TYPE },
    {
      $setOnInsert: {
        tenantId,
        companyGuid,
        voucherType: VOUCHER_TYPE,
        lastAlterId: 0,
        lastRunStatus: "never_run",
        isRunning: false,
        lockedAt: null,
      },
    },
    { upsert: true }
  );
}

// Atomically acquire the per-company lock. Returns the checkpoint doc if
// acquired, or null if another run currently holds a non-stale lock (in
// which case this tick simply skips that company).
async function acquireLock(tenantId, companyGuid, intervalSeconds) {
  const staleCutoff = new Date(
    Date.now() - intervalSeconds * 1000 * LOCK_STALE_MULTIPLIER
  );

  return SyncCheckpoint.findOneAndUpdate(
    {
      tenantId,
      companyGuid,
      voucherType: VOUCHER_TYPE,
      $or: [
        { isRunning: false },
        { lockedAt: null },
        { lockedAt: { $lt: staleCutoff } },
      ],
    },
    { $set: { isRunning: true, lockedAt: new Date() } },
    { returnDocument: "after" }
  );
}

async function releaseLock(
  tenantId,
  companyGuid,
  { status, error = null, advanceTo } = {}
) {
  const update = {
    isRunning: false,
    lockedAt: null,
    lastRunStatus: status,
    lastSyncedAt: new Date(),
    lastError: error,
  };

  // The one rule that matters: the checkpoint only ever advances here, on
  // an explicitly successful run. A failed run leaves lastAlterId
  // untouched, so the next tick safely re-fetches the same delta.
  if (advanceTo !== undefined) {
    update.lastAlterId = advanceTo;
  }

  await SyncCheckpoint.findOneAndUpdate(
    { tenantId, companyGuid, voucherType: VOUCHER_TYPE },
    { $set: update }
  );
}

// Runs one incremental sync pass for a single company. Never throws —
// failures are recorded on the checkpoint and returned in the result so
// the caller can log them and move on to the next company.
async function runSyncForCompany(
  company,
  { intervalSeconds = DEFAULT_INTERVAL_SECONDS } = {}
) {
  const tenantId = company.tenantId;
  const companyGuid = company.companyGuid;

  await ensureCheckpointExists(tenantId, companyGuid);

  const checkpoint = await acquireLock(
    tenantId,
    companyGuid,
    intervalSeconds
  );

  if (!checkpoint) {
    return { skipped: true, reason: "locked" };
  }

  const baseUrl = resolveTallyBaseUrl(company);

  try {
    const tallyResponse = await getSalesVouchersSinceAlterId({
      afterAlterId: checkpoint.lastAlterId,
      baseUrl,
    });

    const parsedPayload =
      typeof tallyResponse === "string"
        ? JSON.parse(tallyResponse)
        : tallyResponse;

    const vouchers = extractVoucherCollection(parsedPayload);

    if (!vouchers.length) {
      // Nothing changed since the last checkpoint. Normal steady state,
      // not an error - most ticks will land here.
      await releaseLock(tenantId, companyGuid, { status: "success" });
      return {
        processed: 0,
        created: 0,
        updated: 0,
        duplicates: 0,
        skipped: 0,
        failed: 0,
      };
    }

    let maxAlterId = checkpoint.lastAlterId;
    let created = 0;
    let updated = 0;
    let duplicates = 0;
    let skippedCount = 0;
    let failed = 0;
    let firstFailureMessage = null;

    for (const voucher of vouchers) {
      const result = await processSingleVoucher(voucher, tenantId);

      if (result.status === "failed") {
        failed += 1;
        if (!firstFailureMessage) firstFailureMessage = result.message;
      } else if (result.status === "created") {
        created += 1;
      } else if (result.status === "updated") {
        updated += 1;
      } else if (result.status === "duplicate") {
        duplicates += 1;
      } else if (result.status === "skipped") {
        skippedCount += 1;
      }

      if (
        typeof result.tallyAlterId === "number" &&
        result.tallyAlterId > maxAlterId
      ) {
        maxAlterId = result.tallyAlterId;
      }
    }

    const batchResult = {
      processed: vouchers.length,
      created,
      updated,
      duplicates,
      skipped: skippedCount,
      failed,
    };

    if (failed > 0) {
      // Any failure in the batch -> the whole run is a failure for
      // checkpoint purposes. Vouchers already upserted above are not
      // rolled back (upsert is idempotent, so reprocessing them next tick
      // is a harmless no-op) - this just guarantees the failed voucher's
      // delta is retried instead of silently skipped past.
      await releaseLock(tenantId, companyGuid, {
        status: "failed",
        error: `${failed} of ${vouchers.length} voucher(s) failed to sync. First error: ${firstFailureMessage}`,
      });
      return batchResult;
    }

    await releaseLock(tenantId, companyGuid, {
      status: "success",
      advanceTo: maxAlterId,
    });

    return batchResult;
  } catch (error) {
    const message =
      error && error.message ? error.message : "Unknown sync error";

    await releaseLock(tenantId, companyGuid, {
      status: "failed",
      error: message,
    });

    return {
      processed: 0,
      created: 0,
      updated: 0,
      duplicates: 0,
      skipped: 0,
      failed: 0,
      error: message,
    };
  }
}

async function runSyncForAllCompanies(
  { intervalSeconds = DEFAULT_INTERVAL_SECONDS } = {}
) {
  if (cycleInProgress) {
    console.log(
      "[tallySyncWorker] Previous sync cycle still running; skipping this tick."
    );
    return;
  }

  cycleInProgress = true;

  try {
    const companies = await Company.find({ isActive: true }).lean();

    for (const company of companies) {
      try {
        const result = await runSyncForCompany(company, {
          intervalSeconds,
        });

        if (result && result.skipped) {
          continue;
        }

        if (result && result.error) {
          console.error(
            `[tallySyncWorker] ${company.companyGuid}: sync failed - ${result.error}`
          );
          continue;
        }

        if (
          result &&
          (result.processed > 0 ||
            result.created ||
            result.updated ||
            result.failed)
        ) {
          console.log(
            `[tallySyncWorker] ${company.companyGuid}: processed=${result.processed} created=${result.created} updated=${result.updated} duplicates=${result.duplicates} skipped=${result.skipped} failed=${result.failed}`
          );
        }
      } catch (error) {
        // Defense in depth - runSyncForCompany already catches its own
        // errors, but a bug here must still never take down other
        // companies' syncs.
        console.error(
          `[tallySyncWorker] Unexpected error syncing company ${company.companyGuid}:`,
          error.message
        );
      }
    }
  } finally {
    cycleInProgress = false;
  }
}

function buildCronExpression(intervalSeconds) {
  if (intervalSeconds >= 60 && intervalSeconds % 60 === 0) {
    return `*/${intervalSeconds / 60} * * * *`;
  }

  return `*/${intervalSeconds} * * * * *`;
}

function startTallySyncWorker(
  { intervalSeconds = DEFAULT_INTERVAL_SECONDS } = {}
) {
  if (scheduledTask) {
    return scheduledTask;
  }

  const cronExpression = buildCronExpression(intervalSeconds);

  if (!cron.validate(cronExpression)) {
    throw new Error(
      `Invalid TALLY_SYNC_INTERVAL_SECONDS (${intervalSeconds}) produced an invalid cron expression: ${cronExpression}`
    );
  }

  console.log(
    `[tallySyncWorker] Starting incremental Tally sync worker (every ${intervalSeconds}s).`
  );

  scheduledTask = cron.schedule(cronExpression, () => {
    runSyncForAllCompanies({ intervalSeconds }).catch((error) => {
      console.error(
        "[tallySyncWorker] Unexpected error in sync cycle:",
        error.message
      );
    });
  });

  return scheduledTask;
}

function stopTallySyncWorker() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

module.exports = {
  startTallySyncWorker,
  stopTallySyncWorker,
  runSyncForAllCompanies,
  runSyncForCompany,
};
