const Purchase = require("../../models/purchase.model");

const { mapTallyPurchase } = require("../mapper/purchaseMapper");
const { createVoucherPersistence } = require("../sync/voucherPersistence");

// Reused as-is — both are already voucher-type-agnostic (no Sales-specific
// logic), so there's no reason to duplicate them for Purchase.
const {
  extractVoucherCollection,
  resolveTenantContext,
} = require("./tallySalesImport");

// Same shared upsert/idempotency-guard/cancel-tombstone-fallback core
// Sales uses (see voucherPersistence.js), bound to the Purchase model and
// mapper.
const { processSingleVoucher: processSinglePurchaseVoucher } =
  createVoucherPersistence({
    Model: Purchase,
    mapVoucher: mapTallyPurchase,
    entityLabel: "Purchase",
  });

module.exports = {
  extractVoucherCollection,
  resolveTenantContext,
  processSinglePurchaseVoucher,
};
