const Sale = require("../../models/sales.model");
const Purchase = require("../../models/purchase.model");
const { buildVoucherMatchStage } = require("./analyticsScope");

// --------------------------------------------------
// Insights: discount and price analytics over the vouchers already stored. One file, plain functions, the same
// shape as salesAnalytics.js / purchaseAnalytics.js: (tenantId, period, options) -> a plain result. Called by the REST
// pages (controllers/analyticsController.js) and, for Ask AI analysis plans, through analytics/insightTools.js: the same
// functions, so the two can never show different numbers.
//
// Bounded execution (all optional, REST passes none and keeps its behaviour):
//   - options.maxTimeMS: a MongoDB time limit applied to EVERY aggregation a function runs (parallel ones included). A
//     timeout is thrown as code "query_timeout" with a plain message (never the driver's text), like query/execute.js.
//   - per-product (and per product-supplier) groupings return at most MAX_GROUP_ROWS rows to this process; one row more
//     is refused as code "result_too_large", never truncated. This caps what the APPLICATION holds and sorts; MongoDB
//     still builds every group of the $group stage before $limit applies (only maxTimeMS bounds that work).
//
// Every function goes through buildVoucherMatchStage (tenant + active vouchers + calendar-day dates), computes only from
// the stored item lines (quantity, rate, amount) and never from Claude. No Tally data, no database write.
//
// Meanings (disclosed in every result):
//   - list value of a line   = |quantity x rate|            (rate is the price BEFORE discount)
//   - billed value of a line = |amount|                      (already after discount; pre-tax)
//   - discount of a line     = list value - billed value, counted only when it is plausible: the line has a rate and a
//     quantity, and it is either free (billed 0) or billed at 5% of list value or more. A line billed below 5% of its
//     list value (but not free) is far more likely another unit than a 95% discount, so it is left out and counted.
//   - rate (net)             = billed value / quantity       (what was really paid per unit)
// No unit of measure is stored, so a rate assumes the same unit on every line of a product; `rateSpread` (highest line
// rate / lowest, sales and purchases measured separately) flags products where that is doubtful.
//   - indicative margin (productMargin, and per supplier in supplierRates) = average sale rate - average purchase cost per
//     unit. The cost is the same-period average purchase rate, else the 12 months before the period (`costSource`). It is not
//     Tally's stock valuation (no opening / closing stock, no valuation method), so it is a direction, not accounting profit.
//   - product trend (productTrend) = quantity bought and sold per month and the net movement (bought - sold) with its running
//     total from the first month shown. It is a movement, never a stock balance.
// --------------------------------------------------

const MIN_BILLED_TO_LIST = 0.05;
const MAX_LIMIT = 50;
const UNIT_WARNING_SPREAD = 5;
const LOW_VOLUME_SHARE = 0.05;

const DISCOUNT_NOTE =
  "Discount = list value (quantity × rate) − billed line amount, per item line. Lines without a rate or quantity are left out, and a line billed below 5% of its list value (but not free) is not read as a discount. Pre-tax item values: they do not add up to invoice totals.";
const RATE_NOTE =
  "Rates are billed amount ÷ quantity (after discount, before tax). No unit of measure is stored, so a rate assumes the same unit on every voucher line of a product; a product whose sale line rates (or purchase line rates) differ among themselves by more than 5× is flagged.";

const MARGIN_NOTE =
  "Indicative margin = average sale rate − average purchase cost, per unit, both after discount and before tax. The cost is the quantity-weighted average purchase rate of the same product in the same period, or, when nothing was bought in the period, in the 12 months before it. It is NOT Tally's stock valuation: opening and closing stock, the valuation method (FIFO / average), stock journals and returns are not used. Treat it as a direction, not as accounting profit. A product whose line rates differ among themselves by more than 5× is flagged: its unit of measure may differ between vouchers.";
const TREND_NOTE =
  "Quantity bought and sold per month, from Sales and Purchase vouchers (free goods count as quantity). Net movement = bought − sold; the running total starts at zero in the first month shown. It is a movement, not a stock balance: opening stock, stock journals, returns and Tally's closing stock are not in these vouchers.";
const SUPPLIER_MARGIN_NOTE =
  "Margin per unit if the product were bought only from this supplier at its average rate and sold at the average sale rate of the same period (both after discount, before tax). Indicative: it assumes the supplier could supply it all at that rate.";
const EARLIER_COST_DAYS = 365;
const MARGIN_SORTS = { profit: "indicativeProfit", marginPct: "marginPct" };
const MAX_TREND_MONTHS = 120;

const round2 = (n) => (Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : null);
// Calendar-day arithmetic on the local-midnight Dates the period engine produces (buildVoucherMatchStage reads the local day).
const daysBefore = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - n);
const clampLimit = (limit, fallback = 10) => {
  const n = Number.parseInt(limit, 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : fallback;
};
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const modelFor = (entity) => (entity === "purchase" ? Purchase : Sale);

// ---- bounded execution (see the header)
// Same size as the query engine's per-item roll-up cap (LIMITS.maxRollupRows in services/query/semanticCatalog.js); kept
// here as a constant so the analytics layer does not depend on the query layer.
const MAX_GROUP_ROWS = 50000;
const MAX_TIME_MS_CEILING = 600000;
const TIMEOUT_MESSAGE = "The calculation took too long. Choose a shorter period or a narrower filter.";
// The same test as services/query/execute.js isTimeout: MongoDB code 50 (MaxTimeMSExpired) or its message.
const isTimeout = (error) => !!error && (error.code === 50 || /exceeded time limit|MaxTimeMSExpired/i.test(String(error.message || "")));

function readMaxTimeMS(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIME_MS_CEILING) {
    throw Object.assign(new Error(`Invalid "maxTimeMS". Expected a whole number of milliseconds from 1 to ${MAX_TIME_MS_CEILING}.`), { status: 400 });
  }
  return value;
}

// Every aggregation in this file goes through here: the optional time limit, and a timeout turned into "query_timeout".
function aggregate(Model, pipeline, maxTimeMS) {
  const agg = Model.aggregate(pipeline);
  if (maxTimeMS) agg.option({ maxTimeMS });
  return agg.exec().catch((error) => {
    throw isTimeout(error) ? Object.assign(new Error(TIMEOUT_MESSAGE), { code: "query_timeout" }) : error;
  });
}

function capRows(rows, what) {
  if (rows.length > MAX_GROUP_ROWS) {
    throw Object.assign(new Error(`More than ${MAX_GROUP_ROWS} ${what} are involved. Choose a shorter period or filter by a product.`), { code: "result_too_large" });
  }
  return rows;
}

// Per item line, computed inside the pipeline (after $unwind of inventory).
const LINE_STAGE = {
  $addFields: {
    _hasList: { $and: [{ $gt: ["$inventory.rate", 0] }, { $gt: ["$inventory.quantity", 0] }] },
    _net: { $abs: "$inventory.amount" },
    _gross: { $abs: { $multiply: ["$inventory.quantity", "$inventory.rate"] } },
  },
};
const LINE_FLAGS_STAGE = {
  $addFields: {
    _plausible: {
      $and: [
        "$_hasList",
        { $or: [{ $eq: ["$_net", 0] }, { $gte: ["$_net", { $multiply: ["$_gross", MIN_BILLED_TO_LIST] }] }] },
      ],
    },
  },
};
const DISCOUNT_GROUP = {
  // gross, billed and discount all cover the SAME lines (the plausible ones), so gross - billed = discount; the others are counted apart
  gross: { $sum: { $cond: ["$_plausible", "$_gross", 0] } },
  billed: { $sum: { $cond: ["$_plausible", "$_net", 0] } },
  discount: { $sum: { $cond: ["$_plausible", { $max: [0, { $subtract: ["$_gross", "$_net"] }] }, 0] } },
  lines: { $sum: 1 },
  listedLines: { $sum: { $cond: ["$_hasList", 1, 0] } },
  discountedLines: { $sum: { $cond: [{ $and: ["$_plausible", { $gt: [{ $subtract: ["$_gross", "$_net"] }, 0.005] }] }, 1, 0] } },
  excludedLines: { $sum: { $cond: [{ $and: ["$_hasList", { $not: ["$_plausible"] }] }, 1, 0] } },
};

const shapeDiscount = (g) => ({
  grossAmount: round2(g.gross),
  billedAmount: round2(g.billed),
  discountAmount: round2(g.discount),
  discountPct: g.gross > 0 ? round2((g.discount / g.gross) * 100) : 0,
  lines: g.lines,
  listedLines: g.listedLines,
  discountedLines: g.discountedLines,
  excludedLines: g.excludedLines,
});

/**
 * Discount given (sales) or received (purchase): totals, and optionally a breakdown.
 * @param {string} tenantId
 * @param {{from: Date, to: Date, label?: string}} period
 * @param {{entity?: "sales"|"purchase", by?: "customer"|"supplier"|"product"|"month"|null, limit?: number}} [options]
 */
async function discountSummary(tenantId, period, { entity = "sales", by = null, limit = 10, maxTimeMS } = {}) {
  const timeLimit = readMaxTimeMS(maxTimeMS);
  const match = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });
  const Model = modelFor(entity);
  const prefix = [{ $match: match }, { $unwind: "$inventory" }, LINE_STAGE, LINE_FLAGS_STAGE];

  const keyExpr = {
    customer: "$header.partyName",
    supplier: "$header.partyName",
    product: "$inventory.itemName",
    month: { $dateTrunc: { date: "$header.voucherDate", unit: "month", timezone: "UTC" } },
  }[by];
  if (by && !keyExpr) throw Object.assign(new Error(`Unknown breakdown "${by}".`), { status: 400 });

  const [totalsRow] = await aggregate(Model, [...prefix, { $group: { _id: null, ...DISCOUNT_GROUP } }], timeLimit);
  const totals = totalsRow ? shapeDiscount(totalsRow) : shapeDiscount({ gross: 0, billed: 0, discount: 0, lines: 0, listedLines: 0, discountedLines: 0, excludedLines: 0 });

  let rows = [];
  if (keyExpr) {
    const raw = await aggregate(Model, [
      ...prefix,
      { $group: { _id: keyExpr, ...DISCOUNT_GROUP } },
      // a group with no plausible priced line has nothing to say about discounts (its lines are counted in the totals)
      { $match: { gross: { $gt: 0 } } },
      by === "month" ? { $sort: { _id: 1 } } : { $sort: { discount: -1, _id: 1 } },
      { $limit: by === "month" ? 120 : clampLimit(limit) },
    ], timeLimit);
    rows = raw.map((r) => ({ key: by === "month" ? r._id.toISOString().slice(0, 7) : r._id, ...shapeDiscount(r) }));
  }

  return {
    entity,
    by,
    totals,
    rows,
    period: { from: period.from, to: period.to, label: period.label || null },
    hasData: totals.lines > 0,
    disclosures: [DISCOUNT_NOTE],
  };
}

// One side (sales or purchases) per product: priced lines only (a rate needs a billed amount), quantity-weighted.
// At most MAX_GROUP_ROWS products come back; one more is refused (result_too_large) before any in-memory sorting.
async function sideTotals(Model, match, productMatch = [], timeLimit) {
  const rows = await aggregate(Model, [
    { $match: match },
    { $unwind: "$inventory" },
    ...productMatch,
    LINE_STAGE,
    { $match: { "inventory.quantity": { $gt: 0 }, _net: { $gt: 0 } } },
    {
      $group: {
        _id: "$inventory.itemName",
        qty: { $sum: "$inventory.quantity" },
        billed: { $sum: "$_net" },
        gross: { $sum: { $cond: ["$_hasList", "$_gross", "$_net"] } },
        minRate: { $min: { $divide: ["$_net", "$inventory.quantity"] } },
        maxRate: { $max: { $divide: ["$_net", "$inventory.quantity"] } },
      },
    },
    { $limit: MAX_GROUP_ROWS + 1 },
  ], timeLimit);
  return capRows(rows, "products");
}

// Per-product sale and purchase rates for the period, side by side.
async function ratesByProduct(tenantId, period, { limit = 10, product = null, maxTimeMS } = {}) {
  const timeLimit = readMaxTimeMS(maxTimeMS);
  const match = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });
  const productMatch = product ? [{ $match: { "inventory.itemName": { $regex: `^${escapeRegex(product)}$`, $options: "i" } } }] : [];
  const [sales, purchases] = await Promise.all([sideTotals(Sale, match, productMatch, timeLimit), sideTotals(Purchase, match, productMatch, timeLimit)]);

  const byName = new Map();
  const slot = (name) => {
    if (!byName.has(name)) byName.set(name, { product: name, saleQty: 0, saleBilled: 0, saleList: 0, purchaseQty: 0, purchaseBilled: 0, spread: 1 });
    return byName.get(name);
  };
  for (const s of sales) {
    const r = slot(s._id);
    r.saleQty = s.qty; r.saleBilled = s.billed; r.saleList = s.gross;
    r.spread = Math.max(r.spread, s.minRate > 0 ? s.maxRate / s.minRate : 1);
  }
  for (const p of purchases) {
    const r = slot(p._id);
    r.purchaseQty = p.qty; r.purchaseBilled = p.billed;
    r.spread = Math.max(r.spread, p.minRate > 0 ? p.maxRate / p.minRate : 1);
  }

  const rows = [...byName.values()]
    .sort((a, b) => b.saleBilled - a.saleBilled || b.purchaseBilled - a.purchaseBilled || (a.product < b.product ? -1 : 1))
    .slice(0, clampLimit(limit))
    .map((r) => {
      const saleRate = r.saleQty > 0 ? r.saleBilled / r.saleQty : null;
      const purchaseRate = r.purchaseQty > 0 ? r.purchaseBilled / r.purchaseQty : null;
      return {
        product: r.product,
        saleQty: round2(r.saleQty),
        saleRate: round2(saleRate),
        saleListRate: r.saleQty > 0 ? round2(r.saleList / r.saleQty) : null,
        purchaseQty: round2(r.purchaseQty),
        purchaseRate: round2(purchaseRate),
        // sale rate minus purchase rate of the SAME product in the SAME period: a price gap, not a profit (no stock cost is used)
        rateGap: saleRate !== null && purchaseRate !== null ? round2(saleRate - purchaseRate) : null,
        rateSpread: round2(r.spread),
        unitWarning: r.spread > UNIT_WARNING_SPREAD,
      };
    });

  return { rows, period: { from: period.from, to: period.to, label: period.label || null }, hasData: rows.length > 0, disclosures: [RATE_NOTE] };
}

/**
 * Indicative margin per product sold in the period: average sale rate vs average purchase cost (see MARGIN_NOTE).
 * @param {{sortBy?: "profit"|"marginPct", order?: "desc"|"asc", limit?: number}} [options]
 */
async function productMargin(tenantId, period, { limit = 10, sortBy = "profit", order = "desc", maxTimeMS } = {}) {
  if (!MARGIN_SORTS[sortBy]) throw Object.assign(new Error(`Unknown sort "${sortBy}". Expected one of: ${Object.keys(MARGIN_SORTS).join(", ")}.`), { status: 400 });
  if (order !== "asc" && order !== "desc") throw Object.assign(new Error('Invalid "order". Expected asc or desc.'), { status: 400 });

  const timeLimit = readMaxTimeMS(maxTimeMS);
  const match = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });
  const earlierMatch = buildVoucherMatchStage({ tenantId, from: daysBefore(period.from, EARLIER_COST_DAYS), to: daysBefore(period.from, 1) });
  const [sales, purchases, earlier] = await Promise.all([sideTotals(Sale, match, [], timeLimit), sideTotals(Purchase, match, [], timeLimit), sideTotals(Purchase, earlierMatch, [], timeLimit)]);
  const purchaseBy = new Map(purchases.map((p) => [p._id, p]));
  const earlierBy = new Map(earlier.map((p) => [p._id, p]));

  const all = sales.map((s) => {
    const saleRate = s.billed / s.qty;
    let cost = purchaseBy.get(s._id) || null;
    let costSource = cost ? "period" : null;
    if (!cost && earlierBy.has(s._id)) { cost = earlierBy.get(s._id); costSource = "earlier"; }
    const costRate = cost ? cost.billed / cost.qty : null;
    const unitMargin = costRate !== null ? saleRate - costRate : null;
    const spread = Math.max(s.minRate > 0 ? s.maxRate / s.minRate : 1, cost && cost.minRate > 0 ? cost.maxRate / cost.minRate : 1);
    return {
      product: s._id, soldQty: s.qty, saleAmount: s.billed, saleRate, costRate, costSource, unitMargin, spread,
      marginPct: unitMargin !== null && saleRate > 0 ? (unitMargin / saleRate) * 100 : null,
      indicativeProfit: unitMargin !== null ? unitMargin * s.qty : null,
    };
  });

  // products with no cost always come last, whatever the order asked for
  const key = MARGIN_SORTS[sortBy], dir = order === "asc" ? 1 : -1;
  const ranked = all.slice().sort((a, b) => {
    if ((a[key] === null) !== (b[key] === null)) return a[key] === null ? 1 : -1;
    if (a[key] !== null && a[key] !== b[key]) return (a[key] - b[key]) * dir;
    return b.saleAmount - a.saleAmount || (a.product < b.product ? -1 : 1);
  });

  const costed = all.filter((r) => r.indicativeProfit !== null);
  const costedSale = costed.reduce((sum, r) => sum + r.saleAmount, 0);
  const profit = costed.reduce((sum, r) => sum + r.indicativeProfit, 0);
  const summary = {
    products: all.length,
    costedProducts: costed.length,
    withoutCost: all.length - costed.length,
    belowCost: costed.filter((r) => r.unitMargin < 0).length,
    saleAmount: round2(all.reduce((sum, r) => sum + r.saleAmount, 0)),
    costedSaleAmount: round2(costedSale),
    indicativeProfit: round2(profit),
    marginPct: costedSale > 0 ? round2((profit / costedSale) * 100) : null,
  };

  const rows = ranked.slice(0, clampLimit(limit)).map((r) => ({
    product: r.product,
    soldQty: round2(r.soldQty),
    saleAmount: round2(r.saleAmount),
    saleRate: round2(r.saleRate),
    costRate: round2(r.costRate),
    costSource: r.costSource,
    unitMargin: round2(r.unitMargin),
    marginPct: round2(r.marginPct),
    indicativeProfit: round2(r.indicativeProfit),
    belowCost: r.unitMargin !== null && r.unitMargin < 0,
    rateSpread: round2(r.spread),
    unitWarning: r.spread > UNIT_WARNING_SPREAD,
  }));

  return { rows, summary, sortBy, order, period: { from: period.from, to: period.to, label: period.label || null }, hasData: all.length > 0, disclosures: [MARGIN_NOTE] };
}

/**
 * Month-by-month quantity bought and sold for ONE product, with the net movement (bought − sold) and its running total.
 * Months with no voucher between the first and the last active month are shown with zeros. See TREND_NOTE.
 */
async function productTrend(tenantId, period, { product, maxTimeMS } = {}) {
  if (typeof product !== "string" || !product.trim()) throw Object.assign(new Error('"product" is required.'), { status: 400 });
  const wanted = product.trim();
  const timeLimit = readMaxTimeMS(maxTimeMS);
  const match = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });
  // One group per month of the period (at most the period's months). The per-month voucher-id set is left as it is: it is
  // the exact distinct-voucher count, and replacing it would change the calculation (see the header).
  const side = (Model) =>
    aggregate(Model, [
      { $match: match },
      { $unwind: "$inventory" },
      { $match: { "inventory.itemName": { $regex: `^${escapeRegex(wanted)}$`, $options: "i" }, "inventory.quantity": { $gt: 0 } } },
      { $addFields: { _net: { $abs: "$inventory.amount" } } },
      {
        $group: {
          _id: { $dateTrunc: { date: "$header.voucherDate", unit: "month", timezone: "UTC" } },
          name: { $max: "$inventory.itemName" },
          qty: { $sum: "$inventory.quantity" },
          amount: { $sum: "$_net" },
          // a rate needs a billed amount: free goods count as quantity but not as a priced unit
          pricedQty: { $sum: { $cond: [{ $gt: ["$_net", 0] }, "$inventory.quantity", 0] } },
          vouchers: { $addToSet: "$_id" },
        },
      },
    ], timeLimit);
  const [sales, purchases] = await Promise.all([side(Sale), side(Purchase)]);

  const byMonth = new Map();
  let displayName = null;
  const absorb = (rows, kind) => {
    for (const r of rows) {
      const month = r._id.toISOString().slice(0, 7);
      const slot = byMonth.get(month) || { month };
      slot[kind] = { qty: r.qty, amount: r.amount, pricedQty: r.pricedQty, vouchers: r.vouchers.length };
      byMonth.set(month, slot);
      displayName = displayName || r.name;
    }
  };
  absorb(sales, "sale");
  absorb(purchases, "purchase");

  // every month from the first to the last one with activity, gaps as zeros
  const months = [...byMonth.keys()].sort();
  const filled = [];
  if (months.length) {
    const [y0, m0] = months[0].split("-").map(Number);
    const last = months[months.length - 1];
    for (let i = 0; i < MAX_TREND_MONTHS; i += 1) {
      const d = new Date(Date.UTC(y0, m0 - 1 + i, 1));
      const key = d.toISOString().slice(0, 7);
      filled.push(byMonth.get(key) || { month: key });
      if (key === last) break;
    }
  }

  const rate = (side) => (side && side.pricedQty > 0 ? round2(side.amount / side.pricedQty) : null);
  let running = 0;
  const rows = filled.map((m) => {
    const sold = m.sale ? m.sale.qty : 0, bought = m.purchase ? m.purchase.qty : 0;
    running += bought - sold;
    return {
      month: m.month,
      saleQty: round2(sold), saleAmount: round2(m.sale ? m.sale.amount : 0), saleRate: rate(m.sale), saleVouchers: m.sale ? m.sale.vouchers : 0,
      purchaseQty: round2(bought), purchaseAmount: round2(m.purchase ? m.purchase.amount : 0), purchaseRate: rate(m.purchase), purchaseVouchers: m.purchase ? m.purchase.vouchers : 0,
      netQty: round2(bought - sold),
      cumulativeNetQty: round2(running),
    };
  });

  const sum = (f) => rows.reduce((total, r) => total + f(r), 0);
  const total = (kind) => [...byMonth.values()].reduce((acc, m) => (m[kind] ? { amount: acc.amount + m[kind].amount, pricedQty: acc.pricedQty + m[kind].pricedQty } : acc), { amount: 0, pricedQty: 0 });
  const totals = {
    saleQty: round2(sum((r) => r.saleQty)), saleAmount: round2(sum((r) => r.saleAmount)), saleRate: rate(total("sale")),
    purchaseQty: round2(sum((r) => r.purchaseQty)), purchaseAmount: round2(sum((r) => r.purchaseAmount)), purchaseRate: rate(total("purchase")),
    netQty: round2(sum((r) => r.netQty)),
  };

  return { product: displayName || wanted, rows, totals, period: { from: period.from, to: period.to, label: period.label || null }, hasData: rows.length > 0, disclosures: [TREND_NOTE] };
}

// What each supplier charged per unit for the same product, and who is cheapest.
async function supplierRates(tenantId, period, { product = null, limit = 10, maxTimeMS } = {}) {
  const timeLimit = readMaxTimeMS(maxTimeMS);
  const match = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });
  const productMatch = product ? [{ $match: { "inventory.itemName": { $regex: `^${escapeRegex(product)}$`, $options: "i" } } }] : [];

  // One row per (product, supplier) pair: at most MAX_GROUP_ROWS come back, one more is refused before any in-memory work.
  // The per-pair voucher-id set is left as it is (the exact distinct-purchase count; see the header).
  const pairs = capRows(await aggregate(Purchase, [
    { $match: match },
    { $unwind: "$inventory" },
    ...productMatch,
    LINE_STAGE,
    { $match: { "inventory.quantity": { $gt: 0 }, _net: { $gt: 0 } } },
    { $addFields: { _unit: { $divide: ["$_net", "$inventory.quantity"] } } },
    {
      $group: {
        _id: { item: "$inventory.itemName", supplier: "$header.partyName" },
        qty: { $sum: "$inventory.quantity" },
        billed: { $sum: "$_net" },
        gross: { $sum: { $cond: ["$_hasList", "$_gross", "$_net"] } },
        minRate: { $min: "$_unit" },
        maxRate: { $max: "$_unit" },
        // the latest purchase is chosen by DATE with an explicit sort key, never by the order the documents arrive in
        lastRate: { $bottom: { sortBy: { "header.voucherDate": 1, _id: 1 }, output: "$_unit" } },
        lastDate: { $max: "$header.voucherDate" },
        vouchers: { $addToSet: "$_id" },
      },
    },
    { $limit: MAX_GROUP_ROWS + 1 },
  ], timeLimit), "product-supplier pairs");

  const items = new Map();
  for (const p of pairs) {
    const name = p._id.item;
    if (!items.has(name)) items.set(name, { product: name, suppliers: [], totalQty: 0, totalBilled: 0, minRate: Infinity, maxRate: 0 });
    const it = items.get(name);
    it.totalQty += p.qty; it.totalBilled += p.billed;
    it.minRate = Math.min(it.minRate, p.minRate); it.maxRate = Math.max(it.maxRate, p.maxRate);
    it.suppliers.push({
      supplier: p._id.supplier,
      qty: p.qty,
      billed: p.billed,
      avgRate: p.billed / p.qty,
      avgListRate: p.gross / p.qty,
      minRate: p.minRate,
      lastRate: p.lastRate,
      lastDate: p.lastDate,
      purchases: p.vouchers.length,
    });
  }

  const selected = [...items.values()]
    .sort((a, b) => b.totalBilled - a.totalBilled || (a.product < b.product ? -1 : 1))
    .slice(0, clampLimit(limit));

  // average sale rate of the SAME products in the SAME period, to show what each supplier's rate would leave per unit
  const soldRows = selected.length
    ? await aggregate(Sale, [
        { $match: match },
        { $unwind: "$inventory" },
        { $match: { "inventory.itemName": { $in: selected.map((it) => it.product) } } },
        LINE_STAGE,
        { $match: { "inventory.quantity": { $gt: 0 }, _net: { $gt: 0 } } },
        { $group: { _id: "$inventory.itemName", qty: { $sum: "$inventory.quantity" }, billed: { $sum: "$_net" } } },
      ], timeLimit)
    : [];
  const saleRateBy = new Map(soldRows.map((r) => [r._id, r.billed / r.qty]));

  const out = selected.map((it) => {
    const suppliers = it.suppliers.map((s) => ({ ...s, qtyShare: it.totalQty > 0 ? s.qty / it.totalQty : 0 }));
    suppliers.sort((a, b) => a.avgRate - b.avgRate || (a.supplier < b.supplier ? -1 : 1));
    // the cheapest supplier that actually supplies a meaningful share; a tiny one-off purchase is not "the best rate"
    const best = suppliers.find((s) => s.qtyShare >= LOW_VOLUME_SHARE) || suppliers[0];
    const saving = suppliers.reduce((sum, s) => sum + Math.max(0, s.avgRate - best.avgRate) * s.qty, 0);
    const spread = it.minRate > 0 ? it.maxRate / it.minRate : 1;
    const saleRate = saleRateBy.has(it.product) ? saleRateBy.get(it.product) : null;
    const marginOf = (rate) => (saleRate !== null ? round2(saleRate - rate) : null);
    const marginPctOf = (rate) => (saleRate !== null && saleRate > 0 ? round2(((saleRate - rate) / saleRate) * 100) : null);
    return {
      product: it.product,
      totalQty: round2(it.totalQty),
      avgRate: round2(it.totalBilled / it.totalQty),
      bestSupplier: best.supplier,
      bestRate: round2(best.avgRate),
      // what would have been saved if every unit had been bought at the best supplier's average rate (indicative: assumes they could supply it all)
      savingIfAllAtBest: round2(saving),
      supplierCount: suppliers.length,
      rateSpread: round2(spread),
      unitWarning: spread > UNIT_WARNING_SPREAD,
      // null when the product was not sold in the period
      saleRate: round2(saleRate),
      bestUnitMargin: marginOf(best.avgRate),
      bestMarginPct: marginPctOf(best.avgRate),
      suppliers: suppliers.slice(0, 8).map((s) => ({
        supplier: s.supplier,
        qty: round2(s.qty),
        avgRate: round2(s.avgRate),
        avgListRate: round2(s.avgListRate),
        minRate: round2(s.minRate),
        lastRate: round2(s.lastRate),
        lastDate: s.lastDate ? s.lastDate.toISOString().slice(0, 10) : null,
        purchases: s.purchases,
        qtyShare: round2(s.qtyShare * 100),
        lowVolume: s.qtyShare < LOW_VOLUME_SHARE,
        isBest: s.supplier === best.supplier,
        unitMargin: marginOf(s.avgRate),
        marginPct: marginPctOf(s.avgRate),
      })),
    };
  });

  return { rows: out, period: { from: period.from, to: period.to, label: period.label || null }, hasData: out.length > 0, disclosures: [RATE_NOTE, SUPPLIER_MARGIN_NOTE] };
}

module.exports = { discountSummary, ratesByProduct, productMargin, productTrend, supplierRates, MIN_BILLED_TO_LIST, MAX_GROUP_ROWS, DISCOUNT_NOTE, RATE_NOTE, MARGIN_NOTE, TREND_NOTE, SUPPLIER_MARGIN_NOTE };
