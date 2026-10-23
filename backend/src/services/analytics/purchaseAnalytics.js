const Purchase = require("../../models/purchase.model");
const { buildVoucherMatchStage } = require("./analyticsScope");
const { computeGrowth } = require("./salesAnalytics");

// --------------------------------------------------
// Deterministic Purchase analytics - same scope/date-range machinery as
// Sales, applied to the Purchase collection. Kept as its own module
// (not merged with salesAnalytics.js) since Sale and Purchase are
// separate collections/models by design (see purchase.model.js) - this
// mirrors that separation at the analytics layer too.
// --------------------------------------------------

async function getPurchaseSummary(tenantId, period) {
  const match = buildVoucherMatchStage({
    tenantId,
    from: period.from,
    to: period.to,
  });

  const [agg] = await Purchase.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalPurchases: { $sum: "$header.voucherTotalAmount" },
        orderCount: { $sum: 1 },
      },
    },
  ]);

  const totalPurchases = agg ? agg.totalPurchases : 0;
  const orderCount = agg ? agg.orderCount : 0;

  return {
    totalPurchases,
    orderCount,
    averageOrderValue: orderCount > 0 ? totalPurchases / orderCount : 0,
    period: {
      from: period.from,
      to: period.to,
      label: period.label || null,
      isPartial: !!period.isPartial,
    },
    hasData: orderCount > 0,
  };
}

async function getPurchaseComparison(tenantId, currentPeriod, previousPeriod) {
  const [current, previous] = await Promise.all([
    getPurchaseSummary(tenantId, currentPeriod),
    getPurchaseSummary(tenantId, previousPeriod),
  ]);

  const { growthAmount, growthPercentage } = computeGrowth(
    current.totalPurchases,
    previous.totalPurchases
  );

  return {
    current,
    previous,
    growthAmount,
    growthPercentage,
    comparisonNote:
      current.period.isPartial || previous.period.isPartial
        ? "One or both periods are month-to-date (partial), not complete calendar months."
        : null,
  };
}

// Only implemented if the underlying data supports it: Purchase.inventory
// carries itemName/quantity/rate/amount, same shape as Sale - so this IS
// reliably calculable, unlike category performance.
async function getTopPurchasedProducts(tenantId, period, { limit = 10 } = {}) {
  const match = buildVoucherMatchStage({
    tenantId,
    from: period.from,
    to: period.to,
  });

  const results = await Purchase.aggregate([
    { $match: match },
    { $unwind: "$inventory" },
    {
      $group: {
        _id: "$inventory.itemName",
        totalAmount: { $sum: "$inventory.amount" },
        totalQuantity: { $sum: "$inventory.quantity" },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { totalAmount: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        itemName: "$_id",
        totalAmount: 1,
        totalQuantity: 1,
        orderCount: 1,
      },
    },
  ]);

  return {
    items: results,
    period: { from: period.from, to: period.to, label: period.label || null },
    hasData: results.length > 0,
  };
}

// Mirrors salesAnalytics.getTopCustomers exactly, on the Purchase
// collection - the supplier/vendor ledger name (header.partyName) is the
// counterpart to a Sales voucher's customer name.
async function getTopSuppliers(tenantId, period, { limit = 10 } = {}) {
  const match = buildVoucherMatchStage({
    tenantId,
    from: period.from,
    to: period.to,
  });

  const results = await Purchase.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$header.partyName",
        totalAmount: { $sum: "$header.voucherTotalAmount" },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { totalAmount: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        supplierName: "$_id",
        totalAmount: 1,
        orderCount: 1,
      },
    },
  ]);

  return {
    suppliers: results,
    period: { from: period.from, to: period.to, label: period.label || null },
    hasData: results.length > 0,
  };
}

function monthLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

// Mirrors salesAnalytics.getSalesTrend exactly, on the Purchase
// collection - same monthly-aggregation-of-corrected-totals approach.
async function getPurchaseTrend(tenantId, period) {
  const match = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });

  const results = await Purchase.aggregate([
    { $match: match },
    {
      $group: {
        _id: { y: { $year: "$header.voucherDate" }, m: { $month: "$header.voucherDate" } },
        totalPurchases: { $sum: "$header.voucherTotalAmount" },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { "_id.y": 1, "_id.m": 1 } },
  ]);

  const items = results.map((r) => ({
    year: r._id.y,
    month: r._id.m,
    label: monthLabel(r._id.y, r._id.m),
    totalPurchases: r.totalPurchases,
    orderCount: r.orderCount,
  }));

  return {
    items,
    period: { from: period.from, to: period.to, label: period.label || null },
    hasData: items.length > 0,
  };
}

module.exports = {
  getPurchaseSummary,
  getPurchaseComparison,
  getTopPurchasedProducts,
  getTopSuppliers,
  getPurchaseTrend,
};
