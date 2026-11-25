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
const { reclassifyAdjustmentNotes } = require("../tally/adjustmentNoteClassifier");

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
// runMasterRefreshForCompany, BEFORE that company's voucher modules in the same
// tick, under the same one-request-at-a-time rule. Before, because a Credit/Debit
// Note is classified (sales return, purchase return or value adjustment) from the
// Ledger master's account roles at the moment it is stored: with the master empty
// every note became a value adjustment and returns read zero. Stock Item GST
// history is not part of it (about 74 extra reads): that stays a manual command.
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

  // lastSyncedAt is the time of this ATTEMPT; only a successful run is a success time (lastSuccessAt). Freshness and the
  // coverage of the data both read the success time, so a failing sync never makes the data look current.
  if (status === "success") update.lastSuccessAt = update.lastSyncedAt;

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

// ---- One sync pass, in steps -------------------------------------------------------------------------------------------
// A pass is: guard -> voucher types -> plan the batch -> fetch -> verify -> persist -> advance. Each step below does one of
// those and returns either what the next step needs or an OUTCOME that ends the pass: { release, result }, where `release` is
// what the lock is released with (status / error / advanceTo - the only place the checkpoint can move) and `result` is what the
// caller gets back. The lock is released in exactly one place (runSyncForCompanyModule). verify-sync-pass-outcomes.js pins what
// every way of ending a pass returns and leaves on the checkpoint.

// A result that processed nothing; `extra` carries what a failure adds (error, companyMismatch, rejected).
const emptyResult = (extra = {}) => ({
  processed: 0,
  created: 0,
  updated: 0,
  duplicates: 0,
  skipped: 0,
  failed: 0,
  ...extra,
});

// Nothing changed since the last checkpoint: the normal steady state, so most ticks end here.
const nothingChanged = () => ({ release: { status: "success" }, result: emptyResult() });

const failedOutcome = (message, resultExtra = {}) => ({
  release: { status: "failed", error: message },
  result: emptyResult({ error: message, ...resultExtra }),
});

// Step 1 - safety gate (same product rule as addCompany/manual Sales Sync): background sync must never import whatever
// company happens to be open in Tally into a DIFFERENT tenant. Checked live, every tick, for every company - never assumed
// just because a checkpoint exists for this tenant. A mismatch/no-company-open is routine and expected in a
// shared-Tally-instance, multi-company setup (only one company can be open at a time) - treated exactly like "nothing
// changed" this tick, not a failure. Tally being genuinely unreachable is a real problem and is treated exactly like the
// fetch-failure path (recorded as failed, logged, retried next tick). Returns an outcome when the pass ends here, else null.
async function checkTallyCompany(companyGuid, baseUrl) {
  const guard = await verifyOpenTallyCompany(companyGuid, { baseUrl });

  if (guard.ok) return null;

  return guard.reason === "unreachable" ? failedOutcome(guard.message) : nothingChanged();
}

// Step 2 - generic Sales/Purchase voucher-type discovery (replaces the old hardcoded $$VchTypeSales/$$VchTypePurchase).
// Resolved fresh (or from its own short-lived cache) per company, per tick - never a per-customer hardcoded name. A
// classification that isn't cleanly "ok" (fetch/parse failure, or a genuinely ambiguous/unconfigured company) fails this tick
// closed: it is recorded as a failure with an explicit NEEDS_CONFIGURATION-prefixed reason where applicable, and this never
// falls back to the old hardcoded query. Returns { typeNames } or { outcome }.
async function resolveVoucherTypeNames({ companyGuid, baseUrl, classificationKey, voucherType }) {
  const classification = await resolveVoucherTypeClassification({
    companyGuid,
    baseUrl,
  });

  const classResult = classification[classificationKey];

  if (classResult && classResult.status === "ok") {
    return { typeNames: classResult.typeNames };
  }

  const reasonPrefix =
    classResult && classResult.status === "needs_configuration"
      ? "NEEDS_CONFIGURATION"
      : "CLASSIFICATION_ERROR";

  return {
    outcome: failedOutcome(
      `${reasonPrefix}: ${
        (classResult && classResult.reason) ||
        `Could not resolve ${voucherType} voucher-type classification for this company.`
      }`
    ),
  };
}

// Step 3 - bound this tick's batch (see batchWindow.js). A light probe lists the pending AlterIDs; a backlog larger than
// `batchSize` is fetched as one slice (checkpoint, cutOff] and the rest drains on later ticks. A small backlog is fetched
// with no cap, exactly as before. If the probe itself fails, the tick fails closed - it never falls back to the unbounded
// request this exists to prevent - and the checkpoint stays untouched. Returns { idle: true } when nothing is pending, else
//   upToAlterId      the slice's cut-off (undefined: unbounded)
//   pendingTotal     how many are pending (undefined: the module has no probe)
//   expectedAlterIds the AlterIDs the probe selected for THIS fetch; the fetch must return all of them before the checkpoint
//                    may advance (undefined for a module with no probe: nothing to validate against).
async function planBatch({ fetchPendingAlterIds, checkpoint, baseUrl, typeNames, batchSize }) {
  if (typeof fetchPendingAlterIds !== "function") {
    return { upToAlterId: undefined, pendingTotal: undefined, expectedAlterIds: undefined };
  }

  const probeResponse = await fetchPendingAlterIds({
    afterAlterId: checkpoint.lastAlterId,
    baseUrl,
    voucherTypeNames: typeNames,
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

  if (window.pending === 0) return { idle: true };

  const upToAlterId = window.bounded ? window.upToAlterId : undefined;

  return {
    upToAlterId,
    pendingTotal: window.pending,
    expectedAlterIds: window.bounded
      ? pendingAlterIds.filter((id) => id <= upToAlterId)
      : pendingAlterIds,
  };
}

// Step 4 - the heavy fetch of the planned slice, parsed to a list of vouchers.
async function fetchBatch({ fetchVouchersSinceAlterId, checkpoint, baseUrl, typeNames, upToAlterId }) {
  const tallyResponse = await fetchVouchersSinceAlterId({
    afterAlterId: checkpoint.lastAlterId,
    baseUrl,
    voucherTypeNames: typeNames,
    ...(upToAlterId !== undefined ? { upToAlterId } : {}),
  });

  const parsedPayload =
    typeof tallyResponse === "string"
      ? JSON.parse(tallyResponse)
      : tallyResponse;

  return extractVoucherCollection(parsedPayload);
}

// Step 5 - both checks run BEFORE anything is persisted or the checkpoint is considered; either one throws.
//  - Company ownership: the whole batch must belong to this tenant's configured company (Tally answers for the SELECTED
//    company, which the open-company guard above cannot pin down). One foreign/unverifiable voucher rejects the entire batch:
//    nothing is written, the checkpoint stays put, and the failure is recorded for diagnosis. In-memory, O(n), no extra
//    queries.
//  - Fetch completeness: a partial response that still parses (or a voucher edited between probe and fetch) would otherwise
//    let the checkpoint jump past vouchers that were never imported. Failing here leaves the checkpoint untouched and writes
//    nothing; the next tick re-probes and retries, so nothing is lost and no state needs undoing.
function verifyBatch({ vouchers, tenantId, companyGuid, voucherType, expectedAlterIds }) {
  assertBatchOwnership(vouchers, companyGuid, {
    tenantId,
    companyGuid,
    source: `sync:${voucherType}`,
  });

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
}

// Step 6 - persist every voucher, counting what happened to each and tracking the highest AlterID seen.
async function persistVouchers({ vouchers, processVoucher, tenantId, companyGuid, startAlterId }) {
  let maxAlterId = startAlterId;
  let created = 0;
  let updated = 0;
  let duplicates = 0;
  let skipped = 0;
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
      skipped += 1;
    }

    if (
      typeof result.tallyAlterId === "number" &&
      result.tallyAlterId > maxAlterId
    ) {
      maxAlterId = result.tallyAlterId;
    }
  }

  return { created, updated, duplicates, skipped, failed, firstFailureMessage, maxAlterId };
}

// The pass itself: runs the steps in order and returns the outcome (see the note above).
async function syncOnePass({ company, syncModule, checkpoint, baseUrl, batchSize }) {
  const tenantId = company.tenantId;
  const companyGuid = company.companyGuid;
  const {
    voucherType,
    classificationKey,
    fetchVouchersSinceAlterId,
    fetchPendingAlterIds,
    processVoucher,
  } = syncModule;

  const closed = await checkTallyCompany(companyGuid, baseUrl);
  if (closed) return closed;

  const types = await resolveVoucherTypeNames({ companyGuid, baseUrl, classificationKey, voucherType });
  if (types.outcome) return types.outcome;

  const plan = await planBatch({ fetchPendingAlterIds, checkpoint, baseUrl, typeNames: types.typeNames, batchSize });
  if (plan.idle) return nothingChanged();

  const { upToAlterId, pendingTotal, expectedAlterIds } = plan;

  const vouchers = await fetchBatch({ fetchVouchersSinceAlterId, checkpoint, baseUrl, typeNames: types.typeNames, upToAlterId });

  verifyBatch({ vouchers, tenantId, companyGuid, voucherType, expectedAlterIds });

  if (!vouchers.length) return nothingChanged();

  const persisted = await persistVouchers({
    vouchers,
    processVoucher,
    tenantId,
    companyGuid,
    startAlterId: checkpoint.lastAlterId,
  });

  const batchResult = {
    processed: vouchers.length,
    created: persisted.created,
    updated: persisted.updated,
    duplicates: persisted.duplicates,
    skipped: persisted.skipped,
    failed: persisted.failed,
    ...(pendingTotal !== undefined ? { pendingTotal } : {}),
  };

  if (persisted.failed > 0) {
    // Any failure in the batch -> the whole run is a failure for
    // checkpoint purposes. Vouchers already upserted above are not
    // rolled back (upsert is idempotent, so reprocessing them next tick
    // is a harmless no-op) - this just guarantees the failed voucher's
    // delta is retried instead of silently skipped past.
    return {
      release: {
        status: "failed",
        error: `${persisted.failed} of ${vouchers.length} voucher(s) failed to sync. First error: ${persisted.firstFailureMessage}`,
      },
      result: batchResult,
    };
  }

  // A bounded batch is complete up to its cut-off (every pending voucher
  // in (checkpoint, cutOff] was fetched and persisted, and the cut-off is
  // the AlterID of a voucher that exists), so advance to it even if the
  // last few vouchers carried no AlterID in their result (e.g. a skipped
  // tombstone) - otherwise such a batch could never make progress. An
  // unbounded batch advances exactly as before.
  const advanceTo =
    upToAlterId !== undefined ? Math.max(persisted.maxAlterId, upToAlterId) : persisted.maxAlterId;

  return { release: { status: "success", advanceTo }, result: batchResult };
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
  const { voucherType } = syncModule;

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
    const outcome = await syncOnePass({ company, syncModule, checkpoint, baseUrl, batchSize });

    // The one place the lock is released after a pass that ended normally.
    await releaseLock(tenantId, companyGuid, voucherType, outcome.release);

    return outcome.result;
  } catch (error) {
    const message =
      error && error.message ? error.message : "Unknown sync error";

    await releaseLock(tenantId, companyGuid, voucherType, {
      status: "failed",
      error: message,
    });

    return emptyResult({
      error: message,
      ...(error && error.code === "COMPANY_MISMATCH"
        ? { companyMismatch: true, rejected: error.validation.total }
        : {}),
    });
  }
}

// Refreshes one company's Stock Item and Ledger masters when they are due (see MASTER_REFRESH_MS). Never throws.
//
//   - The open-company guard runs first (one light read): if another company is open or Tally is unreachable nothing is
//     requested and the refresh stays due, so the next tick looks again. Both refreshes also verify the GUID ownership of
//     everything Tally returns, and fail closed (they write nothing, and never clear what is stored) on any problem.
//   - One request at a time, in order: Stock Items, then Ledgers (+ Groups). Stock Item GST history is NOT refreshed here.
//   - When both succeeded, Credit/Debit Notes stored as "value_adjustment" are re-checked against the Ledger master and the ones
//     it proves to be returns are upgraded (database only, no Tally call, upgrade-only: see reclassifyAdjustmentNotes). Notes
//     stored while the master was empty are fixed this way; without it returns would keep reading zero.
//   - Success: next refresh in `intervalMs`. Failure of either (or of the note re-check): retry in MASTER_RETRY_MS (30 min), not
//     on every tick.
//
// deps (tests): { verifyCompany, refreshStockItems, refreshLedgers, reclassifyNotes }.
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
  const reclassifyNotes = deps.reclassifyNotes || reclassifyAdjustmentNotes;
  const baseUrl = resolveTallyBaseUrl(company);
  const retryAt = now + Math.min(MASTER_RETRY_MS, intervalMs);

  try {
    const guard = await verifyCompany(companyGuid, { baseUrl });
    if (!guard.ok) return { skipped: true, reason: guard.reason };

    const stockItems = await refreshStockItems({ tenantId: company.tenantId, companyGuid, baseUrl, includeGst: false });
    const ledgers = await refreshLedgers({ tenantId: company.tenantId, companyGuid, baseUrl });
    const ok = Boolean(stockItems && stockItems.ok && ledgers && ledgers.ok);

    // Only when the Ledger master is known good. A failure here is reported and retried, but is not a failed master refresh.
    let notes = null;
    if (ok) {
      try {
        notes = await reclassifyNotes({ tenantId: company.tenantId, apply: true });
      } catch (error) {
        notes = { ok: false, reason: error && error.message ? error.message : String(error) };
      }
    }

    masterNextDue.set(companyGuid, ok && (!notes || notes.ok !== false) ? now + intervalMs : retryAt);
    return { ok, stockItems, ledgers, notes };
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
  const n = result.notes;
  console.log(
    `[tallySyncWorker] ${company.companyGuid} (masters): stock items fetched=${s.totalFetched} written=${s.written} unchanged=${s.unchanged}; ledgers fetched=${l.totalFetched} written=${l.written} removed=${l.removed}${l.unchanged ? " (unchanged)" : ""}${n && n.ok !== false ? `; notes re-checked=${n.scanned} upgraded to returns=${n.upgrades}` : ""}`
  );
  if (n && n.ok === false) {
    console.error(`[tallySyncWorker] ${company.companyGuid} (masters): note re-check failed - ${n.reason}; will retry later.`);
  }
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
      // Masters first (see the header comment): the Ledger master has to exist before a Credit/Debit Note is classified. It only
      // does anything when the company is due (default every 6 hours), is guarded and fail-closed, and an error here is logged
      // and never stops this company's voucher sync or any other company's.
      try {
        logMasterRefresh(company, await masterRefresh(company));
      } catch (error) {
        console.error(
          `[tallySyncWorker] Unexpected error refreshing masters for company ${company.companyGuid}:`,
          error.message
        );
      }

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

// True while a sync cycle is running (the graceful shutdown waits for it).
function isSyncCycleRunning() {
  return cycleInProgress;
}

module.exports = {
  startTallySyncWorker,
  stopTallySyncWorker,
  isSyncCycleRunning,
  runSyncForAllCompanies,
  runSyncForCompanyModule,
  runMasterRefreshForCompany,
  resolveMasterRefreshMs,
  SALES_SYNC_MODULE,
  PURCHASE_SYNC_MODULE,
  CREDIT_NOTE_SYNC_MODULE,
  DEBIT_NOTE_SYNC_MODULE,
};
