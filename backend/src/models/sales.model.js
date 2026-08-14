const mongoose = require('mongoose');

const salesSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      indexed: true,
    },
    source: {
      sourceType: {
        type: String,
        default: 'tally',
        enum: ['tally'],
      },
      companyGuid: {
        type: String,
        required: true,
      },
      companyName: {
        type: String,
        required: true,
      },
      sourceAlterId: {
        type: String,
        required: true,
      },
    },
    invoice: {
      number: {
        type: String,
        required: true,
      },
      date: {
        type: Date,
        required: true,
      },
      type: {
        type: String,
        required: true,
        enum: ['sales', 'credit-note', 'debit-note'],
      },
    },
    customer: {
      sourceId: {
        type: String,
        required: true,
      },
      name: {
        type: String,
        required: true,
      },
    },
    items: [
      {
        sourceId: {
          type: String,
          required: true,
        },
        name: {
          type: String,
          required: true,
        },
        quantity: {
          type: Number,
          required: true,
          min: 0,
        },
        unit: {
          type: String,
          required: true,
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
      },
    ],
    totals: {
      taxable: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
      },
      tax: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
      },
      discount: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
      },
      grandTotal: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
      },
    },
    sync: {
      syncedAt: {
        type: Date,
        required: true,
        default: Date.now,
      },
      sourceAlterId: {
        type: String,
        required: true,
      },
    },
  },
  { timestamps: true }
);

// Indexes
salesSchema.index({ tenantId: 1 });
salesSchema.index({ tenantId: 1, 'invoice.number': 1 }, { unique: true });
salesSchema.index({ 'sync.sourceAlterId': 1 });

const Sales = mongoose.model('Sales', salesSchema);

module.exports = Sales;