const mongoose = require("mongoose");
const { stockItemGstSchema } = require("./gstSchemas");

// --------------------------------------------------
// Stock Item -> Stock Group master data, refreshed on demand from Tally
// (never from the incremental voucher sync, never inferred from an item
// name). One document per {tenantId, itemName}, always reflecting
// Tally's CURRENT $Parent for that item as of the last refresh -
// stockGroupName is a live classification snapshot, not a historical
// fact about any particular voucher.
//
// Deliberately a SEPARATE collection from Sale/Purchase, not a
// denormalized field on their inventory subdocuments: group membership
// can change in Tally after a voucher has already synced, and this way
// a re-classification never requires touching (or migrating) a single
// already-synced voucher document. See the accompanying investigation
// report for the full reasoning.
// --------------------------------------------------

const stockItemMasterSchema = new mongoose.Schema(
  {
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },

    itemName: {
      type: String,
      required: true,
      trim: true,
    },

    // Tally's own $Parent for this Stock Item - the real, unmodified
    // Stock Group name. Never fabricated, never inferred from itemName.
    stockGroupName: {
      type: String,
      required: true,
      trim: true,
    },

    // "<companyGuid>-<masterId>" - same identity convention as every
    // other synced Tally record, verified via validateMasterOwnership
    // before this document is ever written.
    tallyGuid: {
      type: String,
      required: true,
      trim: true,
    },

    syncedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },

    // The item's GST master configuration with its full dated history, refreshed by
    // services/tally/stockItemGst.js. Absent on items that have not been through a GST
    // refresh. This is the item's CURRENT master data, not what any voucher charged:
    // vouchers keep their own inventory[].gst, and nothing derives a tax amount from this.
    gst: {
      type: stockItemGstSchema,
      default: undefined,
    },
  },
  {
    timestamps: true,
  }
);

// The join this collection exists to serve
// (Sale.inventory.itemName -> StockItemMaster.itemName) MUST always be
// tenant-scoped on both sides - this index is what makes that lookup
// fast and is also the uniqueness boundary: one Stock Item per tenant
// resolves to exactly one current Stock Group.
stockItemMasterSchema.index({ tenantId: 1, itemName: 1 }, { unique: true });

// Identity: one row per real Tally master record per tenant - lets a
// refresh use tallyGuid (not itemName) as the upsert key, so a Stock
// Item RENAMED in Tally updates the same document instead of leaving a
// stale duplicate under the old name.
stockItemMasterSchema.index({ tenantId: 1, tallyGuid: 1 }, { unique: true });

// Bumps the per-tenant data version after every write so cached answers can never go stale.
stockItemMasterSchema.plugin(require("../services/query/dataVersion").tenantDataVersionPlugin);

module.exports = mongoose.model("StockItemMaster", stockItemMasterSchema);
