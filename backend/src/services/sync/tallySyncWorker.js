const cron = require("node-cron");

const Company = require("../../models/company");
const SyncCheckpoint = require("../../models/syncCheckpoint.model");
const {
  getSalesVouchersSinceAlterId,
  getPurchaseVouchersSinceAlterId,
} = require("../odbc/odbcService");
const {
  extractVoucherCollection,
  processSingleVoucher,
} = require("../import/tallySalesImport");
const {
  processSinglePurchaseVoucher,
} = require("../import/tallyPurchaseImport");
const { verifyOpenTallyCompany } = require("../auth/tallyCompanyGuard");
const {
  resolveVoucherTypeClassification,
} = require("../tally/voucherTypeClassifier");

// --------------------------------------------------
// Background incremental sync worker.
//
// TallyPrime -> (poll) -> detect vouchers changed since the last checkpoint
// via $AlterID -> existing parser/mapper/validation -> tenant-safe
// MongoDB upsert (processSingleVoucher/processSinglePurchaseVoucher,
// shared with the manual import endpoints) -> advance the checkpoint, but
// ONLY on a fully successful batch.
//
// Runs entirely in-process via node-cron; started from server.js once
// MongoDB is connected. Each {company, voucher type} combination is
// synced independently — its own checkpoint, its own lock — so one
// tenant's Tally/Mongo failure never blocks another tenant, and a
// Purchase sync failure for a company never blocks that same company's
// Sales sync (or vice versa).
//
// Every run also re-verifies, live against Tally, that the company it's
// about to fetch is the one actually open right now (see
// tallyCompanyGuard) - all active companies share one global Tally URL
// today, so without this a tick would import whichever company happens
// to be open into every tenant it iterates over. A mismatch is routine
// (only one company can be open at a time) and is treated as "nothing
// to sync this tick," not a failure.
//
// Sync modules: a small descriptor per voucher type, so adding a new
// voucher type later (Receipt, Payment, ...) means adding one entry here,
// not another copy of the worker.
//
// classificationKey selects which side of voucherTypeClassifier's per-
// company result (sales/purchase) this module's fetch should use — see
// resolveClassificationForModule below.
const SALES_SYNC_MODULE = {
  voucherType: "Sales",
  classificationKey: "sales",
  fetchVouchersSinceAlterId: getSalesVouchersSinceAlterId,
  processVoucher: processSingleVoucher,
};

const PURCHASE_SYNC_MODULE = {
  voucherType: "Purchase",
  classificationKey: "purchase",
  fetchVouchersSinceAlterId: getPurchaseVouchersSinceAlterId,
  processVoucher: processSinglePurchaseVoucher,
};

const SYNC_MODULES = [SALES_SYNC_MODULE, PURCHASE_SYNC_MODULE];

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

async function ensureCheckpointExists(tenantId, companyGuid, voucherType) {
  await SyncCheckpoint.findOneAndUpdate(
    { tenantId, companyGuid, voucherType },
    {
      $setOnInsert: {
        tenantId,
        companyGuid,
        voucherType,
        lastAlterId: 0,
        lastRunStatus: "never_run",
        isRunning: false,
        lockedAt: null,
      },
    },
    { upsert: true }
  );
}

// Atomically acquire the per-{company, voucher type} lock. Returns the
// checkpoint doc if acquired, or null if another run currently holds a
// non-stale lock (in which case this tick simply skips that combination).
async function acquireLock(tenantId, companyGuid, voucherType, intervalSeconds) {
  const staleCutoff = new Date(
    Date.now() - intervalSeconds * 1000 * LOCK_STALE_MULTIPLIER
  );

  return SyncCheckpoint.findOneAndUpdate(
    {
      tenantId,
      companyGuid,
      voucherType,
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
  voucherType,
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
    { tenantId, companyGuid, voucherType },
    { $set: update }
  );
}

// Runs one incremental sync pass for a single {company, sync module}
// combination. Never throws — failures are recorded on the checkpoint and
// returned in the result so the caller can log them and move on.
async function runSyncForCompanyModule(
  company,
  syncModule,
  { intervalSeconds = DEFAULT_INTERVAL_SECONDS } = {}
) {
  const tenantId = company.tenantId;
  const companyGuid = company.companyGuid;
  const { voucherType, classificationKey, fetchVouchersSinceAlterId, processVoucher } = syncModule;

  await ensureCheckpointExists(tenantId, companyGuid, voucherType);

  const checkpoint = await acquireLock(
    tenantId,
    companyGuid,
    voucherType,
    intervalSeconds
  );

  if (!checkpoint) {
    return { skipped: true, reason: "locked" };
  }

  const baseUrl = resolveTallyBaseUrl(company);

  try {
    // Safety gate (same product rule as addCompany/manual Sales Sync):
    // background sync must never import whatever company happens to be
    // open in Tally into a DIFFERENT tenant. Checked live, every tick,
    // for every company - never assumed just because a checkpoint exists
    // for this tenant. A mismatch/no-company-open is routine and expected
    // in a shared-Tally-instance, multi-company setup (only one company
    // can be open at a time) - treated exactly like "nothing changed"
    // this tick, not a failure. Tally being genuinely unreachable is a
    // real problem and is treated exactly like the existing fetch-failure
    // path below (recorded as failed, logged, retried next tick).
    const guard = await verifyOpenTallyCompany(companyGuid, { baseUrl });

    if (!guard.ok) {
      if (guard.reason === "unreachable") {
        await releaseLock(tenantId, companyGuid, voucherType, {
          status: "failed",
          error: guard.message,
        });

        return {
          processed: 0,
          created: 0,
          updated: 0,
          duplicates: 0,
          skipped: 0,
          failed: 0,
          error: guard.message,
        };
      }

      await releaseLock(tenantId, companyGuid, voucherType, { status: "success" });
      return {
        processed: 0,
        created: 0,
        updated: 0,
        duplicates: 0,
        skipped: 0,
        failed: 0,
      };
    }

    // Generic Sales/Purchase voucher-type discovery (replaces the old
    // hardcoded $$VchTypeSales/$$VchTypePurchase). Resolved fresh (or from
    // its own short-lived cache) per company, per tick - never a
    // per-customer hardcoded name. A classification that isn't cleanly
    // "ok" (fetch/parse failure, or a genuinely ambiguous/unconfigured
    // company) fails this tick closed: it is recorded as a failure with an
    // explicit NEEDS_CONFIGURATION-prefixed reason where applicable, and
    // this function never falls back to the old hardcoded query.
    const classification = await resolveVoucherTypeClassification({
      companyGuid,
      baseUrl,
    });

    const classResult = classification[classificationKey];

    if (!classResult || classResult.status !== "ok") {
      const reasonPrefix =
        classResult && classResult.status === "needs_configuration"
          ? "NEEDS_CONFIGURATION"
          : "CLASSIFICATION_ERROR";
      const message = `${reasonPrefix}: ${
        (classResult && classResult.reason) ||
        `Could not resolve ${voucherType} voucher-type classification for this company.`
      }`;

      await releaseLock(tenantId, companyGuid, voucherType, {
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

    const tallyResponse = await fetchVouchersSinceAlterId({
      afterAlterId: checkpoint.lastAlterId,
      baseUrl,
      voucherTypeNames: classResult.typeNames,
    });

    const parsedPayload =
      typeof tallyResponse === "string"
        ? JSON.parse(tallyResponse)
        : tallyResponse;

    const vouchers = extractVoucherCollection(parsedPayload);

    if (!vouchers.length) {
      // Nothing changed since the last checkpoint. Normal steady state,
      // not an error - most ticks will land here.
      await releaseLock(tenantId, companyGuid, voucherType, { status: "success" });
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
      const result = await processVoucher(voucher, tenantId);

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
      await releaseLock(tenantId, companyGuid, voucherType, {
        status: "failed",
        error: `${failed} of ${vouchers.length} voucher(s) failed to sync. First error: ${firstFailureMessage}`,
      });
      return batchResult;
    }

    await releaseLock(tenantId, companyGuid, voucherType, {
      status: "success",
      advanceTo: maxAlterId,
    });

    return batchResult;
  } catch (error) {
    const message =
      error && error.message ? error.message : "Unknown sync error";

    await releaseLock(tenantId, companyGuid, voucherType, {
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

// Sales-only entry point, kept with its original name/signature/behavior
// for backward compatibility (anything already calling runSyncForCompany
// the old way — including this file's own exports — keeps working
// unchanged). Purely a thin wrapper over the generic function above.
async function runSyncForCompany(
  company,
  { intervalSeconds = DEFAULT_INTERVAL_SECONDS } = {}
) {
  return runSyncForCompanyModule(company, SALES_SYNC_MODULE, { intervalSeconds });
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
      for (const syncModule of SYNC_MODULES) {
      try {
        const result = await runSyncForCompanyModule(company, syncModule, {
          intervalSeconds,
        });

        if (result && result.skipped) {
          continue;
        }

        if (result && result.error) {
          console.error(
            `[tallySyncWorker] ${company.companyGuid} (${syncModule.voucherType}): sync failed - ${result.error}`
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
            `[tallySyncWorker] ${company.companyGuid} (${syncModule.voucherType}): processed=${result.processed} created=${result.created} updated=${result.updated} duplicates=${result.duplicates} skipped=${result.skipped} failed=${result.failed}`
          );
        }
      } catch (error) {
        // Defense in depth - runSyncForCompanyModule already catches its
        // own errors, but a bug here must still never take down other
        // companies' or voucher types' syncs.
        console.error(
          `[tallySyncWorker] Unexpected error syncing company ${company.companyGuid} (${syncModule.voucherType}):`,
          error.message
        );
      }
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
  runSyncForCompanyModule,
  SALES_SYNC_MODULE,
  PURCHASE_SYNC_MODULE,
};
