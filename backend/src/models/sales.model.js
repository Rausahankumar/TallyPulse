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

salesSchema.index(
  { tenantId: 1, "header.voucherNo": 1 },
  { unique: true }
);

module.exports = mongoose.model("Sale", salesSchema);