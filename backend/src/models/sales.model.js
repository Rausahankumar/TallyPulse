const mongoose = require("mongoose");

const salesSchema = new mongoose.Schema(
  {
    tenantId: {
      type: String,
      required: true,
      index: true,
    },

    header: {
      voucherNo: {
        type: String,
        required: true,
        trim: true,
      },

      voucherDate: {
        type: Date,
        required: true,
      },

      voucherType: {
        type: String,
        required: true,
        trim: true,
      },

      voucherTotalAmount: {
        type: Number,
        required: true,
      },

      narration: {
        type: String,
        default: "",
      },

      partyName: {
        type: String,
        required: true,
        trim: true,
      },
    },

    inventory: [
      {
        itemName: {
          type: String,
          required: true,
          trim: true,
        },

        quantity: {
          type: Number,
          required: true,
        },

        rate: {
          type: Number,
          required: true,
        },

        amount: {
          type: Number,
          required: true,
        },

        discountPercentage: {
          type: Number,
          default: 0,
        },

        discountAmount: {
          type: Number,
          default: 0,
        },
      },
    ],

    ledgers: [
      {
        ledgerName: {
          type: String,
          required: true,
          trim: true,
        },

        ledgerAmount: {
          type: Number,
          required: true,
        },

        entryType: {
          type: String,
          required: true,
          enum: ["Debit", "Credit"],
        },
      },
    ],

    // Tally sync identity. Populated by the incremental sync worker (and,
    // when present in the source JSON, by manual imports too). Optional /
    // null for documents created before this existed or via a plain file
    // upload with no AlterID in the payload.
    tallyGuid: {
      type: String,
      default: null,
    },

    tallyAlterId: {
      type: Number,
      default: null,
    },

    // "cancelled"/"deleted" are soft states driven by Tally's $IsCancelled /
    // $IsDeleted flags — the document is never removed from MongoDB when
    // Tally reports either, to preserve the audit trail. See
    // salesMapper.js and tallyParser.js for what's confirmed vs.
    // unverified about $IsDeleted specifically.
    voucherStatus: {
      type: String,
      enum: ["active", "cancelled", "deleted"],
      default: "active",
    },
  },
  {
    timestamps: true,
  }
);

// Identity: {tenantId, tallyGuid} - Tally's own stable per-voucher-master
// identifier, NOT voucherNo. Two distinct voucher masters can legitimately
// share a voucherNo (confirmed empirically against a live TallyPrime
// instance - see migrate-voucher-identity.js for the full rationale).
// Partial (tallyGuid must be a real string) so legacy/guid-less documents
// never collide on a shared "null" identity.
salesSchema.index(
  { tenantId: 1, tallyGuid: 1 },
  { unique: true, partialFilterExpression: { tallyGuid: { $type: "string" } } }
);

// voucherNo is now a plain business/display field, not identity - kept
// indexed (non-unique) for lookups, not for uniqueness.
salesSchema.index({ tenantId: 1, "header.voucherNo": 1 });

// Matches analyticsScope.buildVoucherMatchStage's filter shape exactly
// ({tenantId, voucherStatus, header.voucherDate range}) - every analytics
// query goes through that one function, so this is the index that
// actually serves them, rather than falling back to a tenantId-only scan
// filtered in memory. Added because it was identified as a real gap
// (analytics worked correctly at today's small data volume without it,
// but would not scale) - not a broad index redesign.
salesSchema.index({ tenantId: 1, voucherStatus: 1, "header.voucherDate": 1 });

// Bumps the per-tenant data version after every write so cached answers can never go stale.
salesSchema.plugin(require("../services/query/dataVersion").tenantDataVersionPlugin);

module.exports = mongoose.model("Sale", salesSchema);