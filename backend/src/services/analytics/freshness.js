const SyncCheckpoint = require("../../models/syncCheckpoint.model");

// --------------------------------------------------
// Data freshness, derived from the existing SyncCheckpoint model - no
// new persistence, just reading what the sync worker already records
// (lastSuccessAt / lastSyncedAt, lastRunStatus, lastAlterId, isRunning/lockedAt).
// lastSyncedAt is the time of the last ATTEMPT (a failed run sets it too); only lastSuccessAt is a success time.
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

/**
 * When the last SUCCESSFUL sync happened, or null when it is not known. lastSuccessAt, else - for a checkpoint written before that
 * field existed - lastSyncedAt unless the last run failed (then lastSyncedAt is only the time of the failed attempt).
 */
function successTimeOf(checkpoint) {
  if (!checkpoint) return null;
  if (checkpoint.lastSuccessAt) return checkpoint.lastSuccessAt;
  return checkpoint.lastRunStatus !== "failed" && checkpoint.lastSyncedAt ? checkpoint.lastSyncedAt : null;
}

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
    // the data is as old as the last SUCCESS, not as the failed attempt (which is why lastSyncedAt is not used here)
    const at = successTimeOf(checkpoint);
    return {
      state: "sync_failed",
      dataAsOf: at,
      lastAttemptAt: checkpoint.lastSyncedAt || null,
      lastRunStatus: checkpoint.lastRunStatus,
      lastError: checkpoint.lastError,
      lastAlterId: checkpoint.lastAlterId,
      minutesSinceLastSync: at ? Math.round((Date.now() - new Date(at).getTime()) / 60000) : null,
      message: at
        ? `The last ${voucherType} sync attempt failed. Any data shown reflects the last successful sync (${at.toISOString()}), which may now be outdated.`
        : `The last ${voucherType} sync attempt failed. Any data shown reflects an earlier sync, and when one last succeeded is not recorded, so it may be outdated.`,
    };
  }

  const successAt = successTimeOf(checkpoint) || checkpoint.lastSyncedAt;
  if (!successAt) {
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
    (Date.now() - new Date(successAt).getTime()) / 60000
  );

  const state = minutesSinceLastSync <= threshold ? "fresh" : "stale";

  return {
    state,
    dataAsOf: successAt,
    lastRunStatus: checkpoint.lastRunStatus,
    lastError: checkpoint.lastError,
    lastAlterId: checkpoint.lastAlterId,
    minutesSinceLastSync,
    message:
      state === "fresh"
        ? `Data is current as of ${new Date(successAt).toISOString()}.`
        : `Data was last synced ${minutesSinceLastSync} minutes ago (${new Date(successAt).toISOString()}), which is beyond the ${threshold}-minute freshness threshold.`,
  };
}

module.exports = {
  getFreshness,
  successTimeOf,
  DEFAULT_FRESHNESS_THRESHOLD_MINUTES,
};
