const mongoose = require("mongoose");

// One checkpoint document per {tenant, company, voucherType}. Scoped by
// voucherType so future voucher types (Purchase, Receipt, ...) can each
// get their own independent incremental position without redesigning this
// model. lastAlterId only ever advances after a fully successful sync
// batch for that company — see tallySyncWorker.js.
const syncCheckpointSchema = new mongoose.Schema(
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
      default: "Sales",
    },

    lastAlterId: {
      type: Number,
      required: true,
      default: 0,
    },

    // The time of the last sync ATTEMPT that finished (success or failure): releaseLock sets it either way.
    lastSyncedAt: {
      type: Date,
      default: null,
    },

    // The time of the last SUCCESSFUL sync, set only by a successful run. Checkpoints written before this field existed have none:
    // for those, freshness.successTimeOf falls back to lastSyncedAt when the last run did not fail.
    lastSuccessAt: {
      type: Date,
      default: null,
    },

    lastRunStatus: {
      type: String,
      enum: ["never_run", "success", "failed"],
      default: "never_run",
    },

    lastError: {
      type: String,
      default: null,
    },

    // Simple Mongo-backed mutex so overlapping cron ticks (or, later,
    // multiple worker processes) can't run the same company's sync
    // concurrently. lockedAt lets a crashed run's lock be reclaimed after
    // a staleness timeout instead of wedging that company's sync forever.
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

syncCheckpointSchema.index(
  { tenantId: 1, companyGuid: 1, voucherType: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  "SyncCheckpoint",
  syncCheckpointSchema
);
