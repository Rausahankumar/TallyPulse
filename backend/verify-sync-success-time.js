/**
 * A failed sync attempt must never look like a successful one: freshness and the data coverage read the SUCCESS time
 * (lastSuccessAt), not the attempt time (lastSyncedAt). Offline: pure function + the model, no database needed.
 */
const assert = require("assert");
const { successTimeOf } = require("./src/services/analytics/freshness");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");

const earlier = new Date("2026-10-01T10:00:00Z");
const attempt = new Date("2026-10-28T10:00:00Z");

// success time wins over the attempt time, even when the last run failed
assert.strictEqual(successTimeOf({ lastSuccessAt: earlier, lastSyncedAt: attempt, lastRunStatus: "failed" }), earlier);
// a checkpoint from before the field existed: a failed run's attempt time is NOT a success time
assert.strictEqual(successTimeOf({ lastSyncedAt: attempt, lastRunStatus: "failed" }), null);
// ... but a run that did not fail is trusted (legacy rows)
assert.strictEqual(successTimeOf({ lastSyncedAt: attempt, lastRunStatus: "success" }), attempt);
assert.strictEqual(successTimeOf(null), null);
assert.strictEqual(successTimeOf({}), null);

// the model carries the field, defaulting to unknown
assert.ok(SyncCheckpoint.schema.path("lastSuccessAt"), "model has lastSuccessAt");
assert.strictEqual(new SyncCheckpoint({}).lastSuccessAt, null);

console.log("verify-sync-success-time: all checks passed");
