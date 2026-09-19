const SyncCheckpoint = require("../../models/syncCheckpoint.model");

// --------------------------------------------------
// Data freshness, derived from the existing SyncCheckpoint model - no
// new persistence, just reading what the sync worker already records
// (lastSyncedAt, lastRunStatus, lastAlterId, isRunning/lockedAt).
//
// States (deliberately distinct - see the master spec's "do not
// confuse zero / no data / stale / sync failure"):
//   "fresh"        - last successful sync within the freshness threshold
//   "stale"        - last successful sync exists but is older than the
//                    threshold (worker may be slow, or ticks have been
//                    skipped)
//   "sync_failed"  - the most recent run recorded status "failed"
//   "never_synced" - no checkpoint exists yet for this
//                    {tenant, voucherType} at all
// --------------------------------------------------

const DEFAULT_FRESHNESS_THRESHOLD_MINUTES =
  Number(process.env.ANALYTICS_FRESHNESS_THRESHOLD_MINUTES) || 15;

async function getFreshness(tenantId, voucherType, { thresholdMinutes } = {}) {
  const threshold = thresholdMinutes || DEFAULT_FRESHNESS_THRESHOLD_MINUTES;

  const checkpoint = await SyncCheckpoint.findOne({
    tenantId,
    voucherType,
  }).lean();

  if (!checkpoint) {
    return {
      state: "never_synced",
      dataAsOf: null,
      lastRunStatus: null,
      lastError: null,
      lastAlterId: null,
      minutesSinceLastSync: null,
      message: `No ${voucherType} sync has ever run for this company yet.`,
    };
  }

  if (checkpoint.lastRunStatus === "failed") {
    return {
      state: "sync_failed",
      dataAsOf: checkpoint.lastSyncedAt,
      lastRunStatus: checkpoint.lastRunStatus,
      lastError: checkpoint.lastError,
      lastAlterId: checkpoint.lastAlterId,
      minutesSinceLastSync: checkpoint.lastSyncedAt
        ? Math.round((Date.now() - new Date(checkpoint.lastSyncedAt).getTime()) / 60000)
        : null,
      message: `The last ${voucherType} sync attempt failed. Any data shown reflects the last successful sync${checkpoint.lastSyncedAt ? ` (${checkpoint.lastSyncedAt.toISOString()})` : ""}, which may now be outdated.`,
    };
  }

  if (!checkpoint.lastSyncedAt) {
    // Checkpoint exists (e.g. created on first lock acquisition) but no
    // run has actually completed successfully yet.
    return {
      state: "never_synced",
      dataAsOf: null,
      lastRunStatus: checkpoint.lastRunStatus,
      lastError: checkpoint.lastError,
      lastAlterId: checkpoint.lastAlterId,
      minutesSinceLastSync: null,
      message: `No successful ${voucherType} sync has completed yet for this company.`,
    };
  }

  const minutesSinceLastSync = Math.round(
    (Date.now() - new Date(checkpoint.lastSyncedAt).getTime()) / 60000
  );

  const state = minutesSinceLastSync <= threshold ? "fresh" : "stale";

  return {
    state,
    dataAsOf: checkpoint.lastSyncedAt,
    lastRunStatus: checkpoint.lastRunStatus,
    lastError: checkpoint.lastError,
    lastAlterId: checkpoint.lastAlterId,
    minutesSinceLastSync,
    message:
      state === "fresh"
        ? `Data is current as of ${checkpoint.lastSyncedAt.toISOString()}.`
        : `Data was last synced ${minutesSinceLastSync} minutes ago (${checkpoint.lastSyncedAt.toISOString()}), which is beyond the ${threshold}-minute freshness threshold.`,
  };
}

// Combines Sales + Purchase freshness for a company into one overall
// state - useful for a "Give me a business performance summary" answer
// that touches both. Overall state is the WORSE of the two (fresh only
// if both are fresh; sync_failed if either failed; etc.) - never hides
// one voucher type's problem behind the other's good state.
const STATE_SEVERITY = { fresh: 0, stale: 1, sync_failed: 2, never_synced: 3 };

async function getOverallFreshness(tenantId, { thresholdMinutes } = {}) {
  const [sales, purchase] = await Promise.all([
    getFreshness(tenantId, "Sales", { thresholdMinutes }),
    getFreshness(tenantId, "Purchase", { thresholdMinutes }),
  ]);

  const worse =
    STATE_SEVERITY[sales.state] >= STATE_SEVERITY[purchase.state] ? sales : purchase;

  return {
    overallState: worse.state,
    sales,
    purchase,
  };
}

module.exports = {
  getFreshness,
  getOverallFreshness,
  DEFAULT_FRESHNESS_THRESHOLD_MINUTES,
};
