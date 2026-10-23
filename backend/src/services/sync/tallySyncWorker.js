const cron = require("node-cron");

const Company = require("../../models/company");
const SyncCheckpoint = require("../../models/syncCheckpoint.model");
const {
  getSalesVouchersSinceAlterId,
  getPurchaseVouchersSinceAlterId,
  getAdjustmentNoteVouchersSinceAlterId,
  getPendingVoucherAlterIds,
} = require("../odbc/odbcService");
const { parseTallyId } = require("../parser/tallyParser");
const {
  resolveBatchSize,
  computeBatchWindow,
  findMissingAlterIds,
} = require("./batchWindow");
const {
  extractVoucherCollection,
  processSingleVoucher,
} = require("../import/tallySalesImport");
const {
  processSinglePurchaseVoucher,
} = require("../import/tallyPurchaseImport");
const { createAdjustmentNotePersistence } = require("./adjustmentNotePersistence");
const { verifyOpenTallyCompany } = require("../auth/tallyCompanyGuard");
const { assertBatchOwnership } = require("../tally/companyOwnership");
const {
  resolveVoucherTypeClassification,
} = require("../tally/voucherTypeClassifier");
const { refreshStockItemMasters } = require("../tally/stockItemMaster");
const { refreshLedgerMasters } = require("../tally/ledgerMaster");

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
//
// Master data (Stock Items, Ledgers) is not voucher-shaped: Tally gives no usable
// change feed for it and deletions are invisible, so it is refreshed in FULL on a
// much slower cadence (TALLY_MASTER_REFRESH_HOURS, default 6, 0 = off) by
// runMasterRefreshForCompany, AFTER that company's voucher modules in the same
// tick, under the same one-request-at-a-time rule. Stock Item GST history is not
// part of it (about 74 extra reads): that stays a manual command.
//
// fetchPendingAlterIds (optional) is the light probe used to bound each
// tick's batch - see batchWindow.js. A module without it is fetched
// unbounded, exactly as before.
const SALES_SYNC_MODULE = {
  voucherType: "Sales",
  classificationKey: "sales",
  fetchVouchersSinceAlterId: getSalesVouchersSinceAlterId,
  fetchPendingAlterIds: getPendingVoucherAlterIds,
  processVoucher: processSingleVoucher,
};

const PURCHASE_SYNC_MODULE = {
  voucherType: "Purchase",
  classificationKey: "purchase",
  fetchVouchersSinceAlterId: getPurchaseVouchersSinceAlterId,
  fetchPendingAlterIds: getPendingVoucherAlterIds,
  processVoucher: processSinglePurchaseVoucher,
};

// Credit Note / Debit Note - two modules (own checkpoint, own lock each,
// matching the Sales/Purchase convention exactly) sharing one Tally fetch
// shape (getAdjustmentNoteVouchersSinceAlterId) and one persistence factory
// (adjustmentNotePersistence.js), parameterized by noteType.
const { processSingleAdjustmentNoteVoucher: processCreditNote } = createAdjustmentNotePersistence({ noteType: "credit" });
const { processSingleAdjustmentNoteVoucher: processDebitNote } = createAdjustmentNotePersistence({ noteType: "debit" });

const CREDIT_NOTE_SYNC_MODULE = {
  voucherType: "Credit Note",
  classificationKey: "creditNote",
  fetchVouchersSinceAlterId: getAdjustmentNoteVouchersSinceAlterId,
  fetchPendingAlterIds: getPendingVoucherAlterIds,
  processVoucher: processCreditNote,
};

const DEBIT_NOTE_SYNC_MODULE = {
  voucherType: "Debit Note",
  classificationKey: "debitNote",
  fetchVouchersSinceAlterId: getAdjustmentNoteVouchersSinceAlterId,
  fetchPendingAlterIds: getPendingVoucherAlterIds,
  processVoucher: processDebitNote,
};

const SYNC_MODULES = [SALES_SYNC_MODULE, PURCHASE_SYNC_MODULE, CREDIT_NOTE_SYNC_MODULE, DEBIT_NOTE_SYNC_MODULE];

const DEFAULT_INTERVAL_SECONDS =
  Number(process.env.TALLY_SYNC_INTERVAL_SECONDS) || 60;

// Max vouchers requested from Tally per {company, voucher type} per tick.
// A larger backlog drains over successive ticks. Configurable via
// TALLY_SYNC_BATCH_SIZE (positive integer; invalid values fall back to the
// default rather than disabling bounding).
const DEFAULT_SYNC_BATCH_SIZE = resolveBatchSize(process.env.TALLY_SYNC_BATCH_SIZE);

// If a lock has been held longer than this, assume the process that took
// it crashed mid-run and reclaim it, rather than wedging that company's
// sync forever. A generous multiple of the poll interval, independent of
// how long a single Tally call is allowed to take (odbcService's own
// 30s axios timeout bounds that separately).
const LOCK_STALE_MULTIPLIER = 5;

// How often a company's Stock Item and Ledger masters are re-read in full. Configurable via TALLY_MASTER_REFRESH_HOURS
// (hours; 0 switches the periodic refresh off; a missing, negative or non-numeric value falls back to the default).
const DEFAULT_MASTER_REFRESH_HOURS = 6;
// After a failed master refresh the next attempt comes sooner than a full interval, but not on every 60 s tick.
const MASTER_RETRY_MS = 30 * 60 * 1000;

function resolveMasterRefreshMs(value) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_MASTER_REFRESH_HOURS * 3600 * 1000;
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= 0 ? hours * 3600 * 1000 : DEFAULT_MASTER_REFRESH_HOURS * 3600 * 1000;
}

const MASTER_REFRESH_MS = resolveMasterRefreshMs(process.env.TALLY_MASTER_REFRESH_HOURS);

let scheduledTask = null;
let cycleInProgress = false;
// companyGuid -> epoch ms of the next master refresh. In memory on purpose: after a restart the first tick simply refreshes
// once (a few light reads, idempotent writes), so there is no extra persisted state to keep correct.
const masterNextDue = new Map();

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
  {
    intervalSeconds = DEFAULT_INTERVAL_SECONDS,
    batchSize = DEFAULT_SYNC_BATCH_SIZE,
  } = {}
) {
  const tenantId = company.tenantId;
  const companyGuid = company.companyGuid;
  const {
    voucherType,
    classificationKey,
    fetchVouchersSinceAlterId,
    fetchPendingAlterIds,
    processVoucher,
  } = syncModule;

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

    // Bound this tick's batch (see batchWindow.js). A light probe lists the
    // pending AlterIDs; a backlog larger than `batchSize` is fetched as one
    // slice (checkpoint, cutOff] and the rest drains on later ticks. A
    // small backlog is fetched with no cap, exactly as before. If the probe
    // itself fails, the tick fails closed - it never falls back to the
    // unbounded request this exists to prevent - and the checkpoint stays
    // untouched.
    let upToAlterId;
    let pendingTotal;
    // AlterIDs the probe selected for THIS fetch; the fetch must return all
    // of them before the checkpoint may advance. Undefined for a module
    // with no probe (nothing to validate against).
    let expectedAlterIds;

    if (typeof fetchPendingAlterIds === "function") {
      const probeResponse = await fetchPendingAlterIds({
        afterAlterId: checkpoint.lastAlterId,
        baseUrl,
        voucherTypeNames: classResult.typeNames,
      });

      const probePayload =
        typeof probeResponse === "string"
          ? JSON.parse(probeResponse)
          : probeResponse;

      const probeRows = extractVoucherCollection(probePayload);
      const pendingAlterIds = probeRows
        .map((row) => parseTallyId(row && (row.alterid ?? row.alterId)))
        .filter((id) => id !== null);

      if (probeRows.length > 0 && pendingAlterIds.length === 0) {
        throw new Error(
          "Could not read AlterIDs from the pending-vouchers probe; refusing to fetch an unbounded batch."
        );
      }

      const window = computeBatchWindow(pendingAlterIds, batchSize);
      pendingTotal = window.pending;

      if (window.pending === 0) {
        // Nothing changed since the last checkpoint - the normal steady
        // state, so most ticks end here after one light request.
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

      if (window.bounded) {
        upToAlterId = window.upToAlterId;
      }

      expectedAlterIds = window.bounded
        ? pendingAlterIds.filter((id) => id <= upToAlterId)
        : pendingAlterIds;
    }

    const tallyResponse = await fetchVouchersSinceAlterId({
      afterAlterId: checkpoint.lastAlterId,
      baseUrl,
      voucherTypeNames: classResult.typeNames,
      ...(upToAlterId !== undefined ? { upToAlterId } : {}),
    });

    const parsedPayload =
      typeof tallyResponse === "string"
        ? JSON.parse(tallyResponse)
        : tallyResponse;

    const vouchers = extractVoucherCollection(parsedPayload);

    // Company ownership, BEFORE anything is written or the checkpoint is
    // considered: the whole batch must belong to this tenant's configured
    // company (Tally answers for the SELECTED company, which the open-company
    // guard above cannot pin down). One foreign/unverifiable voucher rejects
    // the entire batch: nothing is written, the checkpoint stays put, and the
    // failure is recorded for diagnosis. In-memory, O(n), no extra queries.
    assertBatchOwnership(vouchers, companyGuid, {
      tenantId,
      companyGuid,
      source: `sync:${voucherType}`,
    });

    // Fetch completeness: checked BEFORE anything is persisted or the
    // checkpoint considered. A partial response that still parses (or a
    // voucher edited between probe and fetch) would otherwise let the
    // checkpoint jump past vouchers that were never imported. Failing here
    // leaves the checkpoint untouched and writes nothing; the next tick
    // re-probes and retries, so nothing is lost and no state needs undoing.
    if (expectedAlterIds !== undefined) {
      const returnedAlterIds = vouchers
        .map((voucher) => parseTallyId(voucher && (voucher.alterid ?? voucher.alterId)))
        .filter((id) => id !== null);

      const missing = findMissingAlterIds(expectedAlterIds, returnedAlterIds);

      if (missing.length > 0) {
        throw new Error(
          `Incomplete Tally fetch: ${missing.length} of ${expectedAlterIds.length} expected AlterID(s) were not returned (first missing: ${missing[0]}). Checkpoint not advanced; will retry.`
        );
      }
    }

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
      // companyGuid is passed through too (Sales/Purchase mappers ignore the
      // extra argument) - AdjustmentNote's mapper needs it, and it must come
      // from this trusted, already-ownership-verified scope, never guessed.
      const result = await processVoucher(voucher, tenantId, companyGuid);

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
      ...(pendingTotal !== undefined ? { pendingTotal } : {}),
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

    // A bounded batch is complete up to its cut-off (every pending voucher
    // in (checkpoint, cutOff] was fetched and persisted, and the cut-off is
    // the AlterID of a voucher that exists), so advance to it even if the
    // last few vouchers carried no AlterID in their result (e.g. a skipped
    // tombstone) - otherwise such a batch could never make progress. An
    // unbounded batch advances exactly as before.
    const advanceTo =
      upToAlterId !== undefined ? Math.max(maxAlterId, upToAlterId) : maxAlterId;

    await releaseLock(tenantId, companyGuid, voucherType, {
      status: "success",
      advanceTo,
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
      ...(error && error.code === "COMPANY_MISMATCH"
        ? { companyMismatch: true, rejected: error.validation.total }
        : {}),
    };
  }
}

// Refreshes one company's Stock Item and Ledger masters when they are due (see MASTER_REFRESH_MS). Never throws.
//
//   - The open-company guard runs first (one light read): if another company is open or Tally is unreachable nothing is
//     requested and the refresh stays due, so the next tick looks again. Both refreshes also verify the GUID ownership of
//     everything Tally returns, and fail closed (they write nothing, and never clear what is stored) on any problem.
//   - One request at a time, in order: Stock Items, then Ledgers (+ Groups). Stock Item GST history is NOT refreshed here.
//   - Success: next refresh in `intervalMs`. Failure of either: retry in MASTER_RETRY_MS (30 min), not on every tick.
//
// deps (tests): { verifyCompany, refreshStockItems, refreshLedgers }.
async function runMasterRefreshForCompany(
  company,
  { now = Date.now(), force = false, intervalMs = MASTER_REFRESH_MS, deps = {} } = {}
) {
  if (!(intervalMs > 0)) return { skipped: true, reason: "disabled" };

  const companyGuid = company.companyGuid;
  if (!force && (masterNextDue.get(companyGuid) || 0) > now) return { skipped: true, reason: "not_due" };

  const verifyCompany = deps.verifyCompany || verifyOpenTallyCompany;
  const refreshStockItems = deps.refreshStockItems || refreshStockItemMasters;
  const refreshLedgers = deps.refreshLedgers || refreshLedgerMasters;
  const baseUrl = resolveTallyBaseUrl(company);
  const retryAt = now + Math.min(MASTER_RETRY_MS, intervalMs);

  try {
    const guard = await verifyCompany(companyGuid, { baseUrl });
    if (!guard.ok) return { skipped: true, reason: guard.reason };

    const stockItems = await refreshStockItems({ tenantId: company.tenantId, companyGuid, baseUrl, includeGst: false });
    const ledgers = await refreshLedgers({ tenantId: company.tenantId, companyGuid, baseUrl });
    const ok = Boolean(stockItems && stockItems.ok && ledgers && ledgers.ok);

    masterNextDue.set(companyGuid, ok ? now + intervalMs : retryAt);
    return { ok, stockItems, ledgers };
  } catch (error) {
    masterNextDue.set(companyGuid, retryAt);
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

function logMasterRefresh(company, result) {
  if (!result || result.skipped) return;

  if (!result.ok) {
    const why =
      result.error ||
      [result.stockItems, result.ledgers]
        .filter((r) => r && r.ok === false)
        .map((r) => r.reason)
        .join(" | ");
    console.error(`[tallySyncWorker] ${company.companyGuid} (masters): refresh failed - ${why}; will retry later.`);
    return;
  }

  const s = result.stockItems;
  const l = result.ledgers;
  console.log(
    `[tallySyncWorker] ${company.companyGuid} (masters): stock items fetched=${s.totalFetched} written=${s.written} unchanged=${s.unchanged}; ledgers fetched=${l.totalFetched} written=${l.written} removed=${l.removed}${l.unchanged ? " (unchanged)" : ""}`
  );
}

async function runSyncForAllCompanies(
  {
    intervalSeconds = DEFAULT_INTERVAL_SECONDS,
    // overridable for tests: which voucher modules to run, and the master refresh step
    modules = SYNC_MODULES,
    masterRefresh = runMasterRefreshForCompany,
  } = {}
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
      for (const syncModule of modules) {
      try {
        const startedAt = Date.now();
        const result = await runSyncForCompanyModule(company, syncModule, {
          intervalSeconds,
        });
        const durationMs = Date.now() - startedAt;

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
            `[tallySyncWorker] ${company.companyGuid} (${syncModule.voucherType}): processed=${result.processed} created=${result.created} updated=${result.updated} duplicates=${result.duplicates} skipped=${result.skipped} failed=${result.failed} ms=${durationMs}${result.pendingTotal !== undefined && result.pendingTotal > result.processed ? ` (backlog: ${result.pendingTotal} pending, draining in batches)` : ""}`
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

      // Masters last: a slow or failing master read can never delay or block this company's voucher sync, and it only
      // does anything when the company is due (default every 6 hours; see runMasterRefreshForCompany).
      try {
        logMasterRefresh(company, await masterRefresh(company));
      } catch (error) {
        console.error(
          `[tallySyncWorker] Unexpected error refreshing masters for company ${company.companyGuid}:`,
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
  runSyncForCompanyModule,
  runMasterRefreshForCompany,
  resolveMasterRefreshMs,
  SALES_SYNC_MODULE,
  PURCHASE_SYNC_MODULE,
  CREDIT_NOTE_SYNC_MODULE,
  DEBIT_NOTE_SYNC_MODULE,
};
