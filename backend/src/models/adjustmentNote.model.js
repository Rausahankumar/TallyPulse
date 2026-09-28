const mongoose = require("mongoose");

// --------------------------------------------------
// Normalized Credit Note + Debit Note storage (one model, not two - see
// docs/PROJECT_CONTEXT.md and the CN/DN diagnostic). noteType is the raw
// Tally family (credit/debit); classification is the DETERMINISTIC,
// evidence-based reading (adjustmentNoteClassifier.js) - never inferred
// from the voucher type name alone, and never sales_return/purchase_return
// merely because noteType says credit/debit.
// --------------------------------------------------

const adjustmentNoteInventorySchema = new mongoose.Schema(
  {
    itemName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true },
    rate: { type: Number, required: true },
    amount: { type: Number, required: true },
    // The ledger this line's amount is booked to (Tally accountingallocations),
    // e.g. "Sales Accounts" or a child ledger of it. null when the line had no
    // single resolvable allocation - see adjustmentNoteParser.js.
    accountingAllocationLedger: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const adjustmentNoteLedgerSchema = new mongoose.Schema(
  {
    ledgerName: { type: String, required: true, trim: true },
    ledgerAmount: { type: Number, required: true },
    entryType: { type: String, required: true, enum: ["Debit", "Credit"] },
  },
  { _id: false }
);

const adjustmentNoteSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    companyGuid: { type: String, required: true },

    header: {
      voucherNo: { type: String, required: true, trim: true },
      voucherDate: { type: Date, required: true },
      voucherType: { type: String, required: true, trim: true }, // Tally's own type name (may be renamed)
      voucherTotalAmount: { type: Number, required: true },
      narration: { type: String, default: "" },
      partyName: { type: String, required: true, trim: true },
    },

    // "credit" | "debit" - the Tally voucher family. Never itself the
    // return classification (see decision doc: CN != sales return, DN !=
    // purchase return without evidence).
    noteType: { type: String, required: true, enum: ["credit", "debit"] },

    // Deterministic, evidence-based classification - see
    // adjustmentNoteClassifier.js. "unclassified" is reserved for a
    // structurally unreadable voucher and should be rare/never in practice;
    // "value_adjustment" is the safe default when return evidence is
    // insufficient.
    classification: {
      type: String,
      required: true,
      enum: ["sales_return", "purchase_return", "value_adjustment", "unclassified"],
    },

    inventory: [adjustmentNoteInventorySchema],
    ledgers: [adjustmentNoteLedgerSchema],

    // Original invoice reference, ONLY when Tally's own "Agst Ref" bill
    // allocation on the party ledger line names one. null otherwise -
    // never inferred from voucher number/date/party/amount proximity.
    originalVoucherNumber: { type: String, default: null, trim: true },

    tallyGuid: { type: String, default: null },
    tallyAlterId: { type: Number, default: null },

    // Same soft-state convention as Sale/Purchase: never removed from
    // Mongo, only marked.
    voucherStatus: { type: String, enum: ["active", "cancelled", "deleted"], default: "active" },

    syncedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true }
);

// Same identity convention as Sale/Purchase: {tenantId, tallyGuid}, not
// voucherNo (not guaranteed unique - see sales.model.js).
adjustmentNoteSchema.index({ tenantId: 1, tallyGuid: 1 }, { unique: true, partialFilterExpression: { tallyGuid: { $type: "string" } } });
adjustmentNoteSchema.index({ tenantId: 1, "header.voucherNo": 1 });
// Serves the query engine's tenant + active-status + date-range scope
// (analyticsScope.buildVoucherMatchStage), same shape as sales.model.js.
adjustmentNoteSchema.index({ tenantId: 1, voucherStatus: 1, "header.voucherDate": 1 });
// Serves noteType/classification breakdowns (returns by type, by classification).
adjustmentNoteSchema.index({ tenantId: 1, noteType: 1, classification: 1, "header.voucherDate": 1 });
adjustmentNoteSchema.index({ tenantId: 1, "header.partyName": 1 });

// Bumps the per-tenant data version after every write so cached answers can never go stale.
adjustmentNoteSchema.plugin(require("../services/query/dataVersion").tenantDataVersionPlugin);

module.exports = mongoose.model("AdjustmentNote", adjustmentNoteSchema);
