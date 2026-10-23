const Sale = require("../../models/sales.model");
const { buildVoucherMatchStage } = require("./analyticsScope");

// --------------------------------------------------
// Deterministic Sales analytics. No Claude involved anywhere in this
// file - every number here is a plain MongoDB aggregation result.
// Every function's $match stage is built exclusively via
// buildVoucherMatchStage(), so tenant scoping + active-voucher-only
// filtering is structurally impossible to forget.
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
    // Explicit warning surfaced to the caller so
    // a partial-vs-partial comparison is never silently presented as a
    // full-vs-full one.
    comparisonNote:
      current.period.isPartial || previous.period.isPartial
        ? "One or both periods are month-to-date (partial), not complete calendar months."
        : null,
  };
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

// Sales for ONE specific named customer - distinct from getTopCustomers,
// which ranks/lists customers within a period and cannot look up a
// single customer by name. Matching is case-insensitive but full-STRING
// anchored (^...$), never substring: "DHINGRA GENERAL STORE" and
// "Dhingra General Store" match as the same real-world party (ordinary
// data-entry casing variation), but "ABC TRADERS" and
// "ABC TRADERS PVT LTD" never do, since neither is a full-string match of
// the other - this is deliberate: safe normalization, never fuzzy
// merging of genuinely different customers.
//
// Existence is checked separately from the requested period (an all-time,
// unbounded Sale.distinct lookup) so a narrow-period zero result can never
// be confused with "this customer doesn't exist" - see customerFound in
// the return shape. hasData is always true here (even when orderCount is
// 0): a zero total for a real customer in a real period IS the correct,
// valid answer, not an empty-result state - wrapAnalyticsResult must not
// collapse it into its generic "no matching records" message, which
// would erase the found/not-found distinction.
// AMOUNT SOURCE: totalSales sums header.voucherTotalAmount - the
// GST/tax-inclusive voucher total, the SAME field getTopCustomers above
// already uses - not the pre-tax line-item subtotal
// (Sale.inventory.amount) that stockGroupAnalytics.js's Top-Stock-Group
// analytics deliberately uses instead. These two modules answer
// different questions ("what did this customer pay us, in total" vs
// "what did this product group sell, before tax") and are intentionally
// on different amount bases - never make them match just for
// consistency. Exposed as CUSTOMER_SALES_AMOUNT_BASIS below (mirroring
// stockGroupAnalytics's own exported AMOUNT_BASIS) so a caller/tool
// consumer is never left guessing.
const CUSTOMER_SALES_AMOUNT_BASIS = "voucher_total_incl_tax";

async function getCustomerSales(tenantId, rawCustomerName, period) {
  const customerName =
    typeof rawCustomerName === "string" ? rawCustomerName.trim() : "";

  const periodInfo = {
    from: period.from,
    to: period.to,
    label: period.label || null,
    isPartial: !!period.isPartial,
  };

  const notFound = {
    customerFound: false,
    matchedNames: [],
    totalSales: null,
    orderCount: null,
    averageOrderValue: null,
    period: periodInfo,
    hasData: true,
  };

  if (!customerName) return notFound;

  // Regex-escape the customer name before using it in $regex - it's real
  // party-name text (often containing ".", "(", "&", etc., e.g.
  // "M/S ABC (INDIA) PVT. LTD."), not a pattern, and must never be
  // interpreted as one.
  const escaped = customerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameFilter = { $regex: `^${escaped}$`, $options: "i" };

  // All-time existence check, active vouchers only, same tenant scope as
  // every other analytics query. One cheap aggregation-layer call
  // (Sale.distinct), not a document fetch.
  const existsMatch = buildVoucherMatchStage({ tenantId });
  existsMatch["header.partyName"] = nameFilter;
  const matchedNames = await Sale.distinct("header.partyName", existsMatch);

  if (matchedNames.length === 0) return notFound;

  const periodMatch = buildVoucherMatchStage({
    tenantId,
    from: period.from,
    to: period.to,
  });
  periodMatch["header.partyName"] = nameFilter;

  const [agg] = await Sale.aggregate([
    { $match: periodMatch },
    {
      $group: {
        _id: null, // sum across every case-variant spelling as one customer
        totalSales: { $sum: "$header.voucherTotalAmount" },
        orderCount: { $sum: 1 },
      },
    },
  ]);

  const totalSales = agg ? agg.totalSales : 0;
  const orderCount = agg ? agg.orderCount : 0;

  return {
    customerFound: true,
    matchedNames,
    totalSales,
    orderCount,
    averageOrderValue: orderCount > 0 ? totalSales / orderCount : 0,
    amountBasis: CUSTOMER_SALES_AMOUNT_BASIS,
    period: periodInfo,
    hasData: true,
  };
}

function monthLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

// Monthly sales totals across a date range - the real aggregation
// behind the Sales Trend chart. Grouped by calendar month of
// header.voucherDate (the corrected voucher total, same field every
// other Sales metric uses), scoped to the requested window. Empty
// months within the range are NOT synthesized as zero-filled points -
// only months with at least one active voucher appear, so the chart
// never implies data exists where it doesn't.
async function getSalesTrend(tenantId, period) {
  const match = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });

  const results = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        _id: { y: { $year: "$header.voucherDate" }, m: { $month: "$header.voucherDate" } },
        totalSales: { $sum: "$header.voucherTotalAmount" },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { "_id.y": 1, "_id.m": 1 } },
  ]);

  const items = results.map((r) => ({
    year: r._id.y,
    month: r._id.m,
    label: monthLabel(r._id.y, r._id.m),
    totalSales: r.totalSales,
    orderCount: r.orderCount,
  }));

  return {
    items,
    period: { from: period.from, to: period.to, label: period.label || null },
    hasData: items.length > 0,
  };
}

// Distinct-customer counts, all legitimately derivable from
// header.partyName on real Sale vouchers - no invented "customer"
// concept beyond "a distinct party name we've sold to":
//   totalCustomers    - distinct parties across the tenant's ENTIRE
//                        history (not scoped to `period` - a stable,
//                        always-available headline number).
//   activeCustomers   - distinct parties with at least one sale WITHIN
//                        `period`.
//   newCustomers      - of those active-in-period parties, how many had
//                        their first-ever sale (all-time) within
//                        `period` (i.e. acquired during this window).
//                        null when `period` is unbounded (all-time),
//                        since "new" is meaningless without a window to
//                        be new relative to.
async function getCustomerCounts(tenantId, period) {
  const periodMatch = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });
  const allTimeMatch = buildVoucherMatchStage({ tenantId });

  const [activeNames, firstSeenByParty] = await Promise.all([
    Sale.distinct("header.partyName", periodMatch),
    Sale.aggregate([
      { $match: allTimeMatch },
      { $group: { _id: "$header.partyName", firstSeen: { $min: "$header.voucherDate" } } },
    ]),
  ]);

  const totalCustomers = firstSeenByParty.length;
  const activeCustomers = activeNames.length;

  let newCustomers = null;
  if (period.from && period.to) {
    const from = new Date(period.from).getTime();
    const to = new Date(period.to).getTime();
    newCustomers = firstSeenByParty.filter((c) => {
      const t = new Date(c.firstSeen).getTime();
      return t >= from && t <= to;
    }).length;
  }

  return {
    totalCustomers,
    activeCustomers,
    newCustomers,
    returningCustomers: newCustomers === null ? null : activeCustomers - newCustomers,
    period: { from: period.from, to: period.to, label: period.label || null },
    hasData: totalCustomers > 0,
  };
}

module.exports = {
  getSalesSummary,
  getSalesComparison,
  getTopProducts,
  getTopGrowingProducts,
  getDecliningProducts,
  getTopCustomers,
  getCustomerSales,
  getSalesTrend,
  getCustomerCounts,
  computeGrowth,
  CUSTOMER_SALES_AMOUNT_BASIS,
};
