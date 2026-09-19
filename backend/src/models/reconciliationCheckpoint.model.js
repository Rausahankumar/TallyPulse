const mongoose = require("mongoose");

// Tracking for the reconciliation safety-net, deliberately kept as its
// own collection - NOT a field added to SyncCheckpoint. Reconciliation
// is a conceptually separate job from the AlterID incremental sync (it
// runs on a slower cadence, it never advances an AlterID, and a failed
// reconciliation run must never be confused with a failed incremental
// sync in freshness reporting). Mirrors SyncCheckpoint's lock/staleness
// shape (proven pattern, reused deliberately) without sharing its
// document or its lastAlterId semantics.
const reconciliationCheckpointSchema = new mongoose.Schema(
  {
    tenantId: {
      type: String,
      required: true,
    },

    companyGuid: {
      type: String,
      required: true,
    },

    voucherType: {
      type: String,
      required: true,
    },

    lastRunAt: {
      type: Date,
      default: null,
    },

    lastRunStatus: {
      type: String,
      enum: ["never_run", "success", "failed", "aborted_unsafe"],
      default: "never_run",
    },

    lastError: {
      type: String,
      default: null,
    },

    // Observability: what the last run actually did, so a human can see
    // "reconciliation ran, checked N Tally guids against M Mongo
    // vouchers, marked K deleted" without digging through logs.
    lastTallyGuidCount: { type: Number, default: null },
    lastMongoActiveCount: { type: Number, default: null },
    lastMarkedDeletedCount: { type: Number, default: null },

    // Repair marker for the data/checkpoint self-heal (selfHeal.js): when it
    // last tried, what came of it, and how much is still missing. Drives the
    // cooldown so the same gap is not re-checked against Tally every tick.
    selfHealLastAttemptAt: { type: Date, default: null },
    selfHealLastOutcome: {
      type: String,
      enum: [null, "completed", "partial", "noop", "failed", "aborted"],
      default: null,
    },
    selfHealLastRecovered: { type: Number, default: null },
    selfHealLastRemaining: { type: Number, default: null },
    selfHealLastReason: { type: String, default: null },

    // Same Mongo-backed mutex pattern as SyncCheckpoint.
    isRunning: {
      type: Boolean,
      default: false,
    },

    lockedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

reconciliationCheckpointSchema.index(
  { tenantId: 1, companyGuid: 1, voucherType: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  "ReconciliationCheckpoint",
  reconciliationCheckpointSchema
);
