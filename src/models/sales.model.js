const mongoose = require("mongoose");

const salesSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
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
        min: 0,
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
          min: 0,
        },

        rate: {
          type: Number,
          required: true,
          min: 0,
        },

        amount: {
          type: Number,
          required: true,
          min: 0,
        },

        discountPercentage: {
          type: Number,
          default: 0,
          min: 0,
          max: 100,
        },

        discountAmount: {
          type: Number,
          default: 0,
          min: 0,
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