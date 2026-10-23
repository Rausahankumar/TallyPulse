const Sale = require("../../models/sales.model");
const StockItemMaster = require("../../models/stockItemMaster.model");
const { buildVoucherMatchStage } = require("./analyticsScope");
const { computeGrowth } = require("./salesAnalytics");

// --------------------------------------------------
// Deterministic Top-10-Stock-Group sales analytics. No LLM anywhere in
// this file - every number is a plain MongoDB aggregation, growth is
// computed via the same computeGrowth() every other analytics function
// already uses (never a separate/invented formula).
//
// AMOUNT SOURCE (deliberately not ambiguous - see the accompanying
// report for the full reasoning): this aggregates
// Sale.inventory.amount, the real, stored, LINE-LEVEL item value -
// exactly the same field reportAnalytics.getProductReport already uses
// for per-product sales amount, with the same caveat: it is the
// pre-tax item subtotal, not the tax/freight/rounding-corrected
// header.voucherTotalAmount (which only exists at voucher level and
// has no stored per-line breakdown - allocating it down to lines would
// require inventing a formula, which is exactly what this file must
// never do). Every result carries this caveat forward as
// `amountBasis: "line_item_pre_tax"` rather than leaving it implicit.
//
// TENANT-SAFE LOOKUP: the $lookup below matches on tenantId AND
// itemName together (via $expr inside the lookup's own pipeline, not a
// later filter) - a Stock Item name that happens to collide across two
// tenants can never resolve to the wrong tenant's Stock Group. See
// verify-stock-group-analytics.js's dedicated cross-tenant test.
// --------------------------------------------------

const STOCK_ITEM_MASTER_COLLECTION = StockItemMaster.collection.collectionName;
const AMOUNT_BASIS = "line_item_pre_tax";

// One tenant-scoped period's worth of {stockGroupName -> {salesAmount,
// salesQuantity}}, plus mapped/unmapped diagnostics for that same
// period. Pure aggregation, no growth math here - growth is computed by
// the caller once it has two or three of these results to compare.
async function aggregateStockGroupSales(tenantId, period) {
  const match = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });

  const pipeline = [
    { $match: match },
    { $unwind: "$inventory" },
    {
      // Pipeline-form $lookup (not localField/foreignField) so the
      // tenant check lives INSIDE the join condition itself, not a
      // filter applied after the fact - structurally impossible to
      // forget, matching this codebase's existing "fail closed by
      // construction" pattern (see analyticsScope.js).
      $lookup: {
        from: STOCK_ITEM_MASTER_COLLECTION,
        let: { itemName: "$inventory.itemName", tid: "$tenantId" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ["$tenantId", "$$tid"] }, { $eq: ["$itemName", "$$itemName"] }],
              },
            },
          },
          { $project: { _id: 0, stockGroupName: 1 } },
        ],
        as: "matchedStockItem",
      },
    },
    {
      $addFields: {
        // null (not "", not "Other", not the item name) when no
        // tenant-scoped StockItemMaster record matches - $arrayElemAt on
        // an empty array is null in MongoDB, which is exactly the
        // "unmapped" signal the rest of this pipeline branches on.
        stockGroupName: { $arrayElemAt: ["$matchedStockItem.stockGroupName", 0] },
      },
    },
    {
      $facet: {
        byGroup: [
          { $match: { stockGroupName: { $ne: null } } },
          {
            $group: {
              _id: "$stockGroupName",
              salesAmount: { $sum: "$inventory.amount" },
              salesQuantity: { $sum: "$inventory.quantity" },
              lineCount: { $sum: 1 },
            },
          },
        ],
        unmapped: [
          { $match: { stockGroupName: null } },
          { $group: { _id: null, unmappedAmount: { $sum: "$inventory.amount" }, unmappedLines: { $sum: 1 } } },
        ],
        mapped: [
          { $match: { stockGroupName: { $ne: null } } },
          { $group: { _id: null, mappedAmount: { $sum: "$inventory.amount" }, mappedLines: { $sum: 1 } } },
        ],
      },
    },
  ];

  const [result] = await Sale.aggregate(pipeline);

  const byGroup = (result?.byGroup || []).map((r) => ({
    stockGroupName: r._id,
    salesAmount: r.salesAmount,
    salesQuantity: r.salesQuantity,
    lineCount: r.lineCount,
  }));

  return {
    byGroup,
    unmapped: result?.unmapped?.[0] || { unmappedAmount: 0, unmappedLines: 0 },
    mapped: result?.mapped?.[0] || { mappedAmount: 0, mappedLines: 0 },
  };
}

function sumBy(rows, key) {
  return rows.reduce((sum, r) => sum + (r[key] || 0), 0);
}

/**
 * Top-N Stock Groups by sales amount for `currentPeriod`, with
 * MoM-style growth vs `previousPeriod` and YoY growth vs
 * `samePeriodLastYear` - both OPTIONAL (pass null when the caller's
 * period kind has no natural comparison, e.g. a custom range's MoM -
 * see periodEngine.js). Never guesses a comparison when one wasn't
 * given.
 *
 * @param {string} tenantId
 * @param {{from:Date,to:Date}} currentPeriod
 * @param {{from:Date,to:Date}|null} previousPeriod
 * @param {{from:Date,to:Date}|null} samePeriodLastYear
 * @param {{limit?: number}} [options]
 */
async function getTopStockGroups(tenantId, currentPeriod, previousPeriod, samePeriodLastYear, { limit = 10 } = {}) {
  const [current, previous, yoy] = await Promise.all([
    aggregateStockGroupSales(tenantId, currentPeriod),
    previousPeriod ? aggregateStockGroupSales(tenantId, previousPeriod) : null,
    samePeriodLastYear ? aggregateStockGroupSales(tenantId, samePeriodLastYear) : null,
  ]);

  const previousByGroup = new Map((previous?.byGroup || []).map((g) => [g.stockGroupName, g]));
  const yoyByGroup = new Map((yoy?.byGroup || []).map((g) => [g.stockGroupName, g]));

  const ranked = [...current.byGroup].sort((a, b) => b.salesAmount - a.salesAmount);

  const items = ranked.slice(0, limit).map((g) => {
    const prev = previousByGroup.get(g.stockGroupName) || null;
    const yoyMatch = yoyByGroup.get(g.stockGroupName) || null;

    // previous===null (whole period unavailable) is kept distinct from
    // prev===null-but-period-available (this group had zero sales in a
    // real, queried comparison period) - the first yields a null
    // growth field ("not computed"), the second a real 0 (a genuine
    // answer, per computeGrowth's own zero-denominator convention).
    const momGrowth = previous ? computeGrowth(g.salesAmount, prev ? prev.salesAmount : 0) : null;
    const yoyGrowth = yoy ? computeGrowth(g.salesAmount, yoyMatch ? yoyMatch.salesAmount : 0) : null;

    return {
      stockGroupName: g.stockGroupName,
      salesAmount: g.salesAmount,
      salesQuantity: g.salesQuantity,
      previousPeriodAmount: previous ? (prev ? prev.salesAmount : 0) : null,
      previousPeriodQuantity: previous ? (prev ? prev.salesQuantity : 0) : null,
      samePeriodLastYearAmount: yoy ? (yoyMatch ? yoyMatch.salesAmount : 0) : null,
      samePeriodLastYearQuantity: yoy ? (yoyMatch ? yoyMatch.salesQuantity : 0) : null,
      momGrowthAmount: momGrowth ? momGrowth.growthAmount : null,
      momGrowthPercentage: momGrowth ? momGrowth.growthPercentage : null,
      yoyGrowthAmount: yoyGrowth ? yoyGrowth.growthAmount : null,
      yoyGrowthPercentage: yoyGrowth ? yoyGrowth.growthPercentage : null,
    };
  });

  const currentTotalAmount = sumBy(current.byGroup, "salesAmount");
  const currentTotalQuantity = sumBy(current.byGroup, "salesQuantity");
  const previousTotalAmount = previous ? sumBy(previous.byGroup, "salesAmount") : null;
  const previousTotalQuantity = previous ? sumBy(previous.byGroup, "salesQuantity") : null;
  const yoyTotalAmount = yoy ? sumBy(yoy.byGroup, "salesAmount") : null;
  const yoyTotalQuantity = yoy ? sumBy(yoy.byGroup, "salesQuantity") : null;

  const overallMomGrowth = previous ? computeGrowth(currentTotalAmount, previousTotalAmount) : null;
  const overallYoyGrowth = yoy ? computeGrowth(currentTotalAmount, yoyTotalAmount) : null;

  const mappedLines = current.mapped.mappedLines;
  const unmappedLines = current.unmapped.unmappedLines;
  const mappedAmount = current.mapped.mappedAmount;
  const unmappedAmount = current.unmapped.unmappedAmount;

  return {
    items,
    totalGroups: current.byGroup.length,
    amountBasis: AMOUNT_BASIS,
    summary: {
      currentPeriod: { from: currentPeriod.from, to: currentPeriod.to, totalAmount: currentTotalAmount, totalQuantity: currentTotalQuantity },
      previousPeriod: previous
        ? { from: previousPeriod.from, to: previousPeriod.to, totalAmount: previousTotalAmount, totalQuantity: previousTotalQuantity }
        : null,
      samePeriodLastYear: yoy
        ? { from: samePeriodLastYear.from, to: samePeriodLastYear.to, totalAmount: yoyTotalAmount, totalQuantity: yoyTotalQuantity }
        : null,
      momGrowth: overallMomGrowth,
      yoyGrowth: overallYoyGrowth,
    },
    mapping: {
      mappedLines,
      unmappedLines,
      mappedAmount,
      unmappedAmount,
      // Real classification is always CURRENT Tally state, never a
      // historical snapshot at voucher-sync time - see
      // stockItemMaster.model.js and the investigation report for why.
      classificationBasis: "current_stock_item_master",
    },
    // True when this period had ANY real sales activity (mapped or
    // not) - deliberately NOT "were there any mapped groups", so a
    // period with substantial genuine sales that all happen to be
    // unmapped is never collapsed into a misleading "zero_result"
    // alongside a period with no sales at all.
    hasData: mappedLines + unmappedLines > 0,
  };
}

module.exports = {
  aggregateStockGroupSales,
  getTopStockGroups,
  AMOUNT_BASIS,
};
