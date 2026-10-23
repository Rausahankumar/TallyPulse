const Sale = require("../../models/sales.model");
const Purchase = require("../../models/purchase.model");
const { buildVoucherMatchStage } = require("./analyticsScope");

// --------------------------------------------------
// Anchors "current period" to the tenant's own most recent synced
// voucher instead of the wall clock.
//
// Why this exists: a tenant's real Tally data can lag far behind the
// system clock (sync paused for months, a demo/staging clock set ahead
// of the source data, etc.). If "current month" always means "the
// system clock's calendar month", every current-month/vs-last-month
// query for such a tenant is permanently, silently empty - not because
// anything is broken, but because nobody's data lines up with the
// clock. That reads as a broken product, not an honest empty state.
//
// Anchoring "current" to the latest voucher date this tenant actually
// has is the correct fix: it is not fabricated data, it is a legitimate
// redefinition of "current" as "the most recent period we have real
// synced data for" - what any analyst reviewing this dataset by hand
// would do. Falls back to the real wall clock only when the tenant has
// no active vouchers in EITHER collection at all - there is nothing to
// anchor to, and the wall clock will correctly, honestly surface as a
// zero_result rather than a mysterious one.
// --------------------------------------------------
async function getTenantReferenceDate(tenantId) {
  const match = buildVoucherMatchStage({ tenantId });

  const [[saleMax], [purchaseMax]] = await Promise.all([
    Sale.aggregate([{ $match: match }, { $group: { _id: null, max: { $max: "$header.voucherDate" } } }]),
    Purchase.aggregate([{ $match: match }, { $group: { _id: null, max: { $max: "$header.voucherDate" } } }]),
  ]);

  const candidates = [saleMax?.max, purchaseMax?.max].filter(Boolean).map((d) => new Date(d).getTime());
  if (candidates.length === 0) return new Date();

  return new Date(Math.max(...candidates));
}

module.exports = { getTenantReferenceDate };
