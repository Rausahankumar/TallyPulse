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

async function getPurchaseGrowthVsPreviousMonth(tenantId, referenceDate) {
  const dateRanges = require("./dateRanges");
  return getPurchaseComparison(
    tenantId,
    dateRanges.currentMonthToDate(referenceDate),
    dateRanges.previousMonthSameRange(referenceDate)
  );
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

module.exports = {
  getPurchaseSummary,
  getPurchaseComparison,
  getPurchaseGrowthVsPreviousMonth,
  getTopPurchasedProducts,
};
