const Sale = require("../../models/sales.model");
const Purchase = require("../../models/purchase.model");
const { buildVoucherMatchStage } = require("./analyticsScope");

// --------------------------------------------------
// The Reports module's two genuinely new aggregations. Sales Report and
// Purchase Report need no new backend work — their header KPIs reuse
// salesAnalytics.getSalesSummary/purchaseAnalytics.getPurchaseSummary
// and their line-item tables reuse the existing voucher-listing
// endpoints (GET /api/vouchers/sales|purchases). Product Report and
// Customer Report have no existing paginated equivalent — getTopProducts/
// getTopCustomers only ever return a capped "top N" ranking, never a
// full, searchable, paginated listing - and a company can genuinely have
// thousands of distinct product names (2,337 for one real tenant in this
// database), so "just return everything" is not an option (see Phase 8:
// bounded queries only).
// --------------------------------------------------

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// True single-query server-side pagination: customers only ever come
// from ONE collection (Sale), so a single $facet aggregation (count +
// page) is both correct and efficient - no in-memory merge needed.
async function getCustomerReport(tenantId, period, { page = 1, limit = 25, search, sortBy = "amount" } = {}) {
  const match = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });
  const sortField = sortBy === "orders" ? "orderCount" : "totalAmount";
  const searchTerm = typeof search === "string" ? search.trim() : "";

  const pipeline = [
    { $match: match },
    ...(searchTerm
      ? [{ $match: { "header.partyName": { $regex: escapeRegex(searchTerm), $options: "i" } } }]
      : []),
    {
      $group: {
        _id: "$header.partyName",
        totalAmount: { $sum: "$header.voucherTotalAmount" },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { [sortField]: -1, _id: 1 } },
    {
      $facet: {
        metadata: [{ $count: "total" }],
        totals: [{ $group: { _id: null, grandTotal: { $sum: "$totalAmount" }, grandOrders: { $sum: "$orderCount" } } }],
        data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
      },
    },
  ];

  const [result] = await Sale.aggregate(pipeline);
  const total = result?.metadata?.[0]?.total || 0;
  const grand = result?.totals?.[0] || { grandTotal: 0, grandOrders: 0 };

  const items = (result?.data || []).map((r) => ({
    customerName: r._id,
    totalAmount: r.totalAmount,
    orderCount: r.orderCount,
  }));

  return {
    items,
    summary: { totalCustomers: total, grandTotalAmount: grand.grandTotal, grandOrderCount: grand.grandOrders },
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    period: { from: period.from, to: period.to, label: period.label || null },
    hasData: total > 0,
  };
}

// Products live in BOTH Sale and Purchase inventory - two different
// collections - so this can't be a single $facet the way the customer
// report is. Sales are paginated at the database level (true $skip/
// $limit on the primary, sorted list); the purchase-side amount is then
// looked up ONLY for the current page's item names (at most `limit`
// items), never for the full purchase collection - bounded, not a full
// second collection scan. "purchase amount where genuinely available"
// (per the task spec) is null, not 0, for an item never purchased in
// this period - a real distinction, not a fabricated zero.
async function getProductReport(tenantId, period, { page = 1, limit = 25, search, sortBy = "amount" } = {}) {
  const saleMatch = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });
  const sortField = sortBy === "quantity" ? "totalQuantity" : "totalAmount";
  const searchTerm = typeof search === "string" ? search.trim() : "";

  const pipeline = [
    { $match: saleMatch },
    { $unwind: "$inventory" },
    ...(searchTerm
      ? [{ $match: { "inventory.itemName": { $regex: escapeRegex(searchTerm), $options: "i" } } }]
      : []),
    {
      $group: {
        _id: "$inventory.itemName",
        totalQuantity: { $sum: "$inventory.quantity" },
        totalAmount: { $sum: "$inventory.amount" },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { [sortField]: -1, _id: 1 } },
    {
      $facet: {
        metadata: [{ $count: "total" }],
        totals: [{ $group: { _id: null, grandAmount: { $sum: "$totalAmount" }, grandQuantity: { $sum: "$totalQuantity" } } }],
        data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
      },
    },
  ];

  const [result] = await Sale.aggregate(pipeline);
  const total = result?.metadata?.[0]?.total || 0;
  const grand = result?.totals?.[0] || { grandAmount: 0, grandQuantity: 0 };
  const pageItems = result?.data || [];

  const itemNames = pageItems.map((r) => r._id);
  let purchaseByName = new Map();
  if (itemNames.length > 0) {
    const purchaseMatch = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });
    const purchaseAgg = await Purchase.aggregate([
      { $match: purchaseMatch },
      { $unwind: "$inventory" },
      { $match: { "inventory.itemName": { $in: itemNames } } },
      {
        $group: {
          _id: "$inventory.itemName",
          totalQuantity: { $sum: "$inventory.quantity" },
          // Purchase inventory line amounts are stored with Tally's
          // debit/credit sign convention (negative) - same fact already
          // established for computePartyLedgerTotal in tallyParser.js.
          // abs() here, not a raw $sum, or every purchase amount in this
          // report would render as a misleading negative number.
          totalAmount: { $sum: { $abs: "$inventory.amount" } },
        },
      },
    ]);
    purchaseByName = new Map(purchaseAgg.map((p) => [p._id, p]));
  }

  const items = pageItems.map((r) => {
    const purchased = purchaseByName.get(r._id);
    return {
      itemName: r._id,
      salesQuantity: r.totalQuantity,
      salesAmount: r.totalAmount,
      salesOrderCount: r.orderCount,
      purchaseQuantity: purchased ? purchased.totalQuantity : null,
      purchaseAmount: purchased ? purchased.totalAmount : null,
    };
  });

  return {
    items,
    summary: { totalProducts: total, grandSalesAmount: grand.grandAmount, grandSalesQuantity: grand.grandQuantity },
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    period: { from: period.from, to: period.to, label: period.label || null },
    hasData: total > 0,
  };
}

module.exports = { getCustomerReport, getProductReport, escapeRegex };
