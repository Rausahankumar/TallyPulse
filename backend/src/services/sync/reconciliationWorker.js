const cron = require("node-cron");

const Company = require("../../models/company");
const Sale = require("../../models/sales.model");
const Purchase = require("../../models/purchase.model");
const ReconciliationCheckpoint = require("../../models/reconciliationCheckpoint.model");
const {
  getAllSalesVoucherGuids,
  getAllPurchaseVoucherGuids,
} = require("../odbc/odbcService");
const { reconcileVoucherType } = require("./reconciliation");
const {
  resolveVoucherTypeClassification,
} = require("../tally/voucherTypeClassifier");
const { verifyOpenTallyCompany } = require("../auth/tallyCompanyGuard");
const { maybeSelfHeal } = require("./selfHeal");

// --------------------------------------------------
// Background reconciliation worker - the deletion safety-net described
// in reconciliation.js. Deliberately separate from tallySyncWorker.js:
// different cadence (slower - this is a full scan, not a cheap delta),
// different checkpoint model (ReconciliationCheckpoint, never touches
// SyncCheckpoint/lastAlterId), own lock. The AlterID incremental sync is
// completely unmodified by this file.
// --------------------------------------------------

// classificationKey selects which side of voucherTypeClassifier's
// per-company result (sales/purchase) this module resolves voucher-type
// names from before calling fetchAllGuidsBase - same generic
// classification tallySyncWorker.js uses, kept independent per module
// (Sales classification failing never blocks Purchase reconciliation, and
// vice versa).
const RECONCILIATION_MODULES = [
  {
    voucherType: "Sales",
    classificationKey: "sales",
    Model: Sale,
    fetchAllGuidsBase: getAllSalesVoucherGuids,
  },
  {
    voucherType: "Purchase",
    classificationKey: "purchase",
    Model: Purchase,
    fetchAllGuidsBase: getAllPurchaseVoucherGuids,
  },
];

const DEFAULT_INTERVAL_MINUTES =
  Number(process.env.RECONCILIATION_INTERVAL_MINUTES) || 20;

// Same staleness-multiple idea as the incremental worker's lock, applied
// to this job's own (much longer) interval.
const LOCK_STALE_MULTIPLIER = 3;

let scheduledTask = null;
let cycleInProgress = false;

function resolveTallyBaseUrl(company) {
  return (company.tallyConnection && company.tallyConnection.baseUrl) || undefined;
}

async function ensureCheckpointExists(tenantId, companyGuid, voucherType) {
  await ReconciliationCheckpoint.findOneAndUpdate(
    { tenantId, companyGuid, voucherType },
    {
      $setOnInsert: {
        tenantId,
        companyGuid,
        voucherType,
        lastRunStatus: "never_run",
        isRunning: false,
        lockedAt: null,
      },
    },
    { upsert: true }
  );
}

async function acquireLock(tenantId, companyGuid, voucherType, intervalMinutes) {
  const staleCutoff = new Date(
    Date.now() - intervalMinutes * 60 * 1000 * LOCK_STALE_MULTIPLIER
  );

  return ReconciliationCheckpoint.findOneAndUpdate(
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

async function releaseLock(tenantId, companyGuid, voucherType, update) {
  await ReconciliationCheckpoint.findOneAndUpdate(
    { tenantId, companyGuid, voucherType },
    {
      $set: {
        isRunning: false,
        lockedAt: null,
        lastRunAt: new Date(),
        ...update,
      },
    }
  );
}

// Releases the lock and nothing else - used when a run is skipped, so the
// last real result (status, error, counts, lastRunAt) is preserved.
async function releaseLockWithoutResult(tenantId, companyGuid, voucherType) {
  await ReconciliationCheckpoint.findOneAndUpdate(
    { tenantId, companyGuid, voucherType },
    { $set: { isRunning: false, lockedAt: null } }
  );
}

// Runs one reconciliation pass for a single {company, voucher type}.
// Never throws.
async function runReconciliationForCompanyModule(
  company,
  module_,
  { intervalMinutes = DEFAULT_INTERVAL_MINUTES } = {}
) {
  const tenantId = company.tenantId;
  const companyGuid = company.companyGuid;
  const { voucherType, classificationKey, Model, fetchAllGuidsBase } = module_;

  await ensureCheckpointExists(tenantId, companyGuid, voucherType);

  const checkpoint = await acquireLock(tenantId, companyGuid, voucherType, intervalMinutes);

  if (!checkpoint) {
    return { skipped: true, reason: "locked" };
  }

  const baseUrl = resolveTallyBaseUrl(company);

  // Company guard (same rule and helper as tallySyncWorker.js): Tally serves
  // one open company, so without this a tenant's MongoDB would be compared
  // against a DIFFERENT company's voucher GUIDs, and only the mass-delete
  // threshold would stand between that and wrongly marking vouchers deleted.
  // Checked live, before classification or any GUID fetch.
  //   - a different company (or none) open is routine in a multi-company
  //     setup: skip quietly. The lock is released but the last REAL
  //     reconciliation result is left exactly as it was - no fake "success",
  //     no "aborted_unsafe", no lastRunAt bump - and nothing is compared or
  //     marked deleted.
  //   - Tally unreachable is a genuine problem: recorded as "failed", like
  //     any other Tally fetch failure.
  const guard = await verifyOpenTallyCompany(companyGuid, { baseUrl });

  if (!guard.ok) {
    if (guard.reason === "unreachable") {
      await releaseLock(tenantId, companyGuid, voucherType, {
        lastRunStatus: "failed",
        lastError: guard.message,
      });

      return {
        status: "failed",
        reason: guard.message,
        tallyGuidCount: null,
        mongoActiveCount: null,
        markedDeletedCount: 0,
      };
    }

    await releaseLockWithoutResult(tenantId, companyGuid, voucherType);

    return { skipped: true, reason: "company_not_open", detail: guard.message };
  }

  // Same generic Sales/Purchase voucher-type discovery tallySyncWorker.js
  // uses (shared cache, keyed by companyGuid) - never a per-customer
  // hardcoded name, and never falls back to the old
  // $$VchTypeSales/$$VchTypePurchase behavior if this can't be resolved.
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
      lastRunStatus: "failed",
      lastError: message,
    });

    return {
      status: "failed",
      reason: message,
      tallyGuidCount: null,
      mongoActiveCount: null,
      markedDeletedCount: 0,
    };
  }

  const result = await reconcileVoucherType({
    tenantId,
    Model,
    fetchAllGuids: ({ baseUrl: fetchBaseUrl }) =>
      fetchAllGuidsBase({ baseUrl: fetchBaseUrl, voucherTypeNames: classResult.typeNames }),
    baseUrl,
  });

  // Data/checkpoint self-heal (selfHeal.js): only after a SUCCESSFUL pass,
  // still holding this {tenant, voucher type} lock. Never throws and never
  // changes the reconciliation result recorded below.
  const heal = await maybeSelfHeal({
    company,
    voucherType,
    Model,
    reconcileResult: result,
    checkpoint,
    deps: module_.selfHealDeps,
  });

  if (heal.attempted) {
    console.log(
      `[reconciliationWorker] ${companyGuid} (${voucherType}): self-heal ${heal.outcome} (recovered ${heal.update.selfHealLastRecovered}, still missing ${heal.update.selfHealLastRemaining})${heal.update.selfHealLastReason ? ` - ${heal.update.selfHealLastReason}` : ""}`
    );
  }

  await releaseLock(tenantId, companyGuid, voucherType, {
    lastRunStatus: result.status,
    lastError: result.reason,
    lastTallyGuidCount: result.tallyGuidCount,
    lastMongoActiveCount: result.mongoActiveCount,
    lastMarkedDeletedCount: result.markedDeletedCount,
    ...heal.update,
  });

  return result;
}

async function runReconciliationForAllCompanies(
  { intervalMinutes = DEFAULT_INTERVAL_MINUTES } = {}
) {
  if (cycleInProgress) {
    console.log(
      "[reconciliationWorker] Previous reconciliation cycle still running; skipping this tick."
    );
    return;
  }

  cycleInProgress = true;

  try {
    const companies = await Company.find({ isActive: true }).lean();

    for (const company of companies) {
      for (const module_ of RECONCILIATION_MODULES) {
        try {
          const result = await runReconciliationForCompanyModule(company, module_, {
            intervalMinutes,
          });

          if (result && result.skipped) continue;

          if (result.status === "aborted_unsafe") {
            console.warn(
              `[reconciliationWorker] ${company.companyGuid} (${module_.voucherType}): ABORTED (unsafe) - ${result.reason}`
            );
            continue;
          }

          if (result.status === "failed") {
            console.error(
              `[reconciliationWorker] ${company.companyGuid} (${module_.voucherType}): failed - ${result.reason}`
            );
            continue;
          }

          if (result.markedDeletedCount > 0) {
            console.log(
              `[reconciliationWorker] ${company.companyGuid} (${module_.voucherType}): marked ${result.markedDeletedCount} voucher(s) deleted (Tally guids=${result.tallyGuidCount}, Mongo active=${result.mongoActiveCount})`
            );
          }
        } catch (error) {
          console.error(
            `[reconciliationWorker] Unexpected error reconciling company ${company.companyGuid} (${module_.voucherType}):`,
            error.message
          );
        }
      }
    }
  } finally {
    cycleInProgress = false;
  }
}

function buildCronExpression(intervalMinutes) {
  // Minute-granularity cron is sufficient at this cadence (default 20
  // min) - no need for the incremental worker's seconds-level handling.
  return `*/${intervalMinutes} * * * *`;
}

function startReconciliationWorker(
  { intervalMinutes = DEFAULT_INTERVAL_MINUTES } = {}
) {
  if (scheduledTask) {
    return scheduledTask;
  }

  const cronExpression = buildCronExpression(intervalMinutes);

  if (!cron.validate(cronExpression)) {
    throw new Error(
      `Invalid RECONCILIATION_INTERVAL_MINUTES (${intervalMinutes}) produced an invalid cron expression: ${cronExpression}`
    );
  }

  console.log(
    `[reconciliationWorker] Starting deletion-reconciliation worker (every ${intervalMinutes}m).`
  );

  scheduledTask = cron.schedule(cronExpression, () => {
    runReconciliationForAllCompanies({ intervalMinutes }).catch((error) => {
      console.error(
        "[reconciliationWorker] Unexpected error in reconciliation cycle:",
        error.message
      );
    });
  });

  return scheduledTask;
}

function stopReconciliationWorker() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

module.exports = {
  startReconciliationWorker,
  stopReconciliationWorker,
  runReconciliationForAllCompanies,
  runReconciliationForCompanyModule,
  RECONCILIATION_MODULES,
};
