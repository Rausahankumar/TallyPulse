const mongoose = require("mongoose");

// --------------------------------------------------
// Tally Ledger master (parties and every other ledger), refreshed on demand
// from Tally by services/tally/ledgerMaster.js - never from the incremental
// voucher sync, never inferred from voucher party names.
//
// Vouchers carry only header.partyName (Tally PartyLedgerName); a party's
// identity is resolved through this collection by EXACT name (Tally ledger
// names are unique within a company). It exists so "new customer/supplier"
// can be answered from Tally's own ledger CreatedDate instead of a history
// scan or a name guess.
// --------------------------------------------------

const ledgerMasterSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, trim: true },

    // Trusted company GUID (from the Company record); every ledgerGuid was
    // verified against it by validateMasterOwnership before any write.
    companyGuid: { type: String, required: true, trim: true },

    // "<companyGuid>-<masterId>" - identity, so a renamed ledger updates the
    // same document instead of leaving a stale duplicate.
    ledgerGuid: { type: String, required: true, trim: true },

    name: { type: String, required: true, trim: true },

    // Tally's own $Parent (the ledger's group).
    parentGroup: { type: String, default: null, trim: true },

    // Derived from the group chain at refresh: under the reserved "Sundry
    // Debtors" / "Sundry Creditors" group, else "other". A classification of
    // the ledger only - the role in a question comes from the transaction
    // side (sales vs purchase), since one party can be both.
    partyRole: { type: String, enum: ["debtor", "creditor", "other"], required: true },

    // Derived the same way, under the reserved "Sales Accounts" / "Purchase
    // Accounts" group instead. Used by adjustmentNoteClassifier.js to read an
    // inventory line's accounting-allocation ledger, never the party's group.
    accountRole: { type: String, enum: ["sales_accounts", "purchase_accounts", "other"], default: "other" },

    alterId: { type: Number, default: null },
    masterId: { type: Number, default: null },

    // Tally $CreatedDate (UTC midnight, same convention as voucher dates).
    // null when Tally has none: such a ledger is never counted as new.
    createdDate: { type: Date, default: null },

    syncedAt: { type: Date, required: true, default: Date.now },

    // Set when a full refresh no longer returns this ledger (deleted in
    // Tally). Kept, never hard-deleted; excluded from every read.
    removedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ledgerMasterSchema.index({ tenantId: 1, companyGuid: 1, ledgerGuid: 1 }, { unique: true });
// Name -> ledger lookups. Not unique: a refresh must never fail on a
// same-name pair, and readers refuse ambiguous names instead.
ledgerMasterSchema.index({ tenantId: 1, name: 1 });
// "new party in period" reads.
ledgerMasterSchema.index({ tenantId: 1, createdDate: 1 });

// Bumps the per-tenant data version after every write so cached answers can never go stale.
ledgerMasterSchema.plugin(require("../services/query/dataVersion").tenantDataVersionPlugin);

module.exports = mongoose.model("LedgerMaster", ledgerMasterSchema);
