const mongoose = require("mongoose");

// Mirrors Sale's shape (header/inventory/ledgers/sync-identity fields) as
// its own collection rather than sharing Sale's — Tally voucher numbers
// are only guaranteed unique within a voucher type's own numbering
// series, so a Sales voucher and a Purchase voucher could legitimately
// both be numbered "1" for the same tenant. A single shared collection
// keyed on {tenantId, header.voucherNo} would risk a false collision
// between the two; separate collections avoid that entirely and match
// how a Sales Register vs Purchase Register are naturally separate in
// accounting practice.
const purchaseSchema = new mongoose.Schema(
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

      // The supplier/vendor ledger name. Kept as "partyName" (not
      // "supplierName") to match the field the shared parser already
      // produces (parseTallyVoucher doesn't distinguish customer vs.
      // supplier - it just reads the party ledger generically).
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

    // Tally sync identity - same convention as Sale. Populated by the
    // incremental sync worker.
    tallyGuid: {
      type: String,
      default: null,
    },

    tallyAlterId: {
      type: Number,
      default: null,
    },

    // "cancelled"/"deleted" are soft states driven by Tally's
    // $IsCancelled/$IsDeleted flags - the document is never removed from
    // MongoDB when Tally reports either, to preserve the audit trail.
    // Same confirmed-vs-unverified caveats as Sale; see tallyParser.js.
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

// Identity: {tenantId, tallyGuid} - see sales.model.js for the full
// rationale (same fix, same reasoning, applied identically to Purchase).
purchaseSchema.index(
  { tenantId: 1, tallyGuid: 1 },
  { unique: true, partialFilterExpression: { tallyGuid: { $type: "string" } } }
);

// voucherNo is now a plain business/display field, not identity.
purchaseSchema.index({ tenantId: 1, "header.voucherNo": 1 });

// See sales.model.js for the full rationale - matches
// analyticsScope.buildVoucherMatchStage's filter shape exactly.
purchaseSchema.index({ tenantId: 1, voucherStatus: 1, "header.voucherDate": 1 });

module.exports = mongoose.model("Purchase", purchaseSchema);
