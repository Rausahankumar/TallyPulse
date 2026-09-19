const Sale = require("../../models/sales.model");
const { buildVoucherMatchStage } = require("./analyticsScope");

// --------------------------------------------------
// Deterministic Sales analytics. No Claude involved anywhere in this
// file - every number here is a plain MongoDB aggregation result.
// Every function's $match stage is built exclusively via
// buildVoucherMatchStage(), so tenant scoping + active-voucher-only
// filtering is structurally impossible to forget.
//
// A "category" metric (which stock-item group/category generated the
// most sales) is NOT implemented here. The current Sale schema's
// inventory items only carry {itemName, quantity, rate, amount,
// discountPercentage, discountAmount} - no category/group field is
// captured by the parser or mapper. Implementing it would mean
// fabricating a grouping that doesn't exist in the stored data, which
// the working rules explicitly prohibit ("do not implement metrics
// that cannot be reliably calculated from the current stored data").
// See the final report for what parser/mapper change would be needed.
// --------------------------------------------------

async function getSalesSummary(tenantId, period) {
  const match = buildVoucherMatchStage({
    tenantId,
    from: period.from,
    to: period.to,
  });

  const [agg] = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalSales: { $sum: "$header.voucherTotalAmount" },
        orderCount: { $sum: 1 },
      },
    },
  ]);

  const totalSales = agg ? agg.totalSales : 0;
  const orderCount = agg ? agg.orderCount : 0;

  return {
    totalSales,
    orderCount,
    averageOrderValue: orderCount > 0 ? totalSales / orderCount : 0,
    period: {
      from: period.from,
      to: period.to,
      label: period.label || null,
      isPartial: !!period.isPartial,
    },
    hasData: orderCount > 0,
  };
}

function computeGrowth(current, previous) {
  const growthAmount = current - previous;
  // Avoid divide-by-zero: if the previous period was genuinely zero,
  // percentage growth is undefined (not infinite, not zero) - report it
  // explicitly rather than returning a misleading number.
  const growthPercentage =
    previous === 0 ? null : (growthAmount / Math.abs(previous)) * 100;

  return { growthAmount, growthPercentage };
}

async function getSalesComparison(tenantId, currentPeriod, previousPeriod) {
  const [current, previous] = await Promise.all([
    getSalesSummary(tenantId, currentPeriod),
    getSalesSummary(tenantId, previousPeriod),
  ]);

  const { growthAmount, growthPercentage } = computeGrowth(
    current.totalSales,
    previous.totalSales
  );

  return {
    current,
    previous,
    growthAmount,
    growthPercentage,
    // Explicit warning surfaced to the caller (and ultimately Claude) so
    // a partial-vs-partial comparison is never silently presented as a
    // full-vs-full one.
    comparisonNote:
      current.period.isPartial || previous.period.isPartial
        ? "One or both periods are month-to-date (partial), not complete calendar months."
        : null,
  };
}

// Convenience wrapper matching the "sales growth" phrasing directly -
// same underlying calculation as getSalesComparison, just named for the
// specific "this month vs last month, same date range" question.
async function getSalesGrowthVsPreviousMonth(tenantId, referenceDate) {
  const dateRanges = require("./dateRanges");
  return getSalesComparison(
    tenantId,
    dateRanges.currentMonthToDate(referenceDate),
    dateRanges.previousMonthSameRange(referenceDate)
  );
}

async function getSalesGrowthVsSameMonthLastYear(tenantId, referenceDate) {
  const dateRanges = require("./dateRanges");
  return getSalesComparison(
    tenantId,
    dateRanges.currentMonthToDate(referenceDate),
    dateRanges.sameMonthLastYearToDate(referenceDate)
  );
}

async function getTopProducts(tenantId, period, { limit = 10 } = {}) {
  const match = buildVoucherMatchStage({
    tenantId,
    from: period.from,
    to: period.to,
  });

  const results = await Sale.aggregate([
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

// Shared core for product growth / declining products: per-item sales in
// two periods, ranked by percentage change. Products with no sales in
// the earlier period get growthPercentage: null (new product - "infinite"
// growth is not a meaningful number, so it's reported as null +
// isNew:true rather than fabricated).
async function getProductPeriodComparison(tenantId, currentPeriod, previousPeriod) {
  const currentMatch = buildVoucherMatchStage({
    tenantId,
    from: currentPeriod.from,
    to: currentPeriod.to,
  });
  const previousMatch = buildVoucherMatchStage({
    tenantId,
    from: previousPeriod.from,
    to: previousPeriod.to,
  });

  const [currentByItem, previousByItem] = await Promise.all([
    Sale.aggregate([
      { $match: currentMatch },
      { $unwind: "$inventory" },
      { $group: { _id: "$inventory.itemName", totalAmount: { $sum: "$inventory.amount" } } },
    ]),
    Sale.aggregate([
      { $match: previousMatch },
      { $unwind: "$inventory" },
      { $group: { _id: "$inventory.itemName", totalAmount: { $sum: "$inventory.amount" } } },
    ]),
  ]);

  const previousMap = new Map(previousByItem.map((p) => [p._id, p.totalAmount]));
  const currentMap = new Map(currentByItem.map((c) => [c._id, c.totalAmount]));

  const allItemNames = new Set([...previousMap.keys(), ...currentMap.keys()]);

  const comparisons = [...allItemNames].map((itemName) => {
    const current = currentMap.get(itemName) || 0;
    const previous = previousMap.has(itemName) ? previousMap.get(itemName) : null;

    if (previous === null) {
      return {
        itemName,
        current,
        previous: 0,
        growthAmount: current,
        growthPercentage: null,
        isNew: true,
      };
    }

    const { growthAmount, growthPercentage } = computeGrowth(current, previous);
    return { itemName, current, previous, growthAmount, growthPercentage, isNew: false };
  });

  return comparisons;
}

async function getTopGrowingProducts(tenantId, currentPeriod, previousPeriod, { limit = 10 } = {}) {
  const comparisons = await getProductPeriodComparison(tenantId, currentPeriod, previousPeriod);

  // Rank by absolute growth amount when percentage is null (new
  // products) can't be meaningfully compared to a percentage-ranked
  // list - sort by percentage where available, treating "new" as
  // maximal growth (they went from nothing to something).
  const ranked = comparisons
    .filter((c) => c.growthAmount > 0)
    .sort((a, b) => {
      if (a.isNew && !b.isNew) return -1;
      if (!a.isNew && b.isNew) return 1;
      return (b.growthPercentage ?? 0) - (a.growthPercentage ?? 0);
    })
    .slice(0, limit);

  return { items: ranked, hasData: ranked.length > 0 };
}

async function getDecliningProducts(tenantId, currentPeriod, previousPeriod, { limit = 10 } = {}) {
  const comparisons = await getProductPeriodComparison(tenantId, currentPeriod, previousPeriod);

  const ranked = comparisons
    .filter((c) => !c.isNew && c.growthAmount < 0)
    .sort((a, b) => (a.growthPercentage ?? 0) - (b.growthPercentage ?? 0))
    .slice(0, limit);

  return { items: ranked, hasData: ranked.length > 0 };
}

async function getTopCustomers(tenantId, period, { limit = 10 } = {}) {
  const match = buildVoucherMatchStage({
    tenantId,
    from: period.from,
    to: period.to,
  });

  const results = await Sale.aggregate([
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
        customerName: "$_id",
        totalAmount: 1,
        orderCount: 1,
      },
    },
  ]);

  return {
    customers: results,
    period: { from: period.from, to: period.to, label: period.label || null },
    hasData: results.length > 0,
  };
}

// Explicitly NOT implemented - see file header. Returns a typed
// "unsupported" result rather than a fabricated/empty one, so callers
// (and ultimately Claude) can distinguish "no data" from "this feature
// doesn't exist yet."
async function getCategoryPerformance() {
  return {
    supported: false,
    reason:
      "Stock item category/group is not captured by the current Tally parser/mapper - Sale.inventory items only store itemName, quantity, rate, amount, discountPercentage, discountAmount. Category-level analytics would require a parser/mapper change to extract and store the item's stock group, which has not been made.",
  };
}

module.exports = {
  getSalesSummary,
  getSalesComparison,
  getSalesGrowthVsPreviousMonth,
  getSalesGrowthVsSameMonthLastYear,
  getTopProducts,
  getTopGrowingProducts,
  getDecliningProducts,
  getTopCustomers,
  getCategoryPerformance,
  computeGrowth,
};
