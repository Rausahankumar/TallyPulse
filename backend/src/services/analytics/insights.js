const Sale = require("../../models/sales.model");
const Purchase = require("../../models/purchase.model");
const { buildVoucherMatchStage } = require("./analyticsScope");

// --------------------------------------------------
// Insights: discount and price analytics over the vouchers already stored. One file, plain functions, the same
// shape as salesAnalytics.js / purchaseAnalytics.js: (tenantId, period, options) -> a plain result. The REST pages and
// the Ask AI `run_insight` tool call THESE functions, so the two can never show different numbers.
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
// --------------------------------------------------

const MIN_BILLED_TO_LIST = 0.05;
const MAX_LIMIT = 50;
const UNIT_WARNING_SPREAD = 5;
const LOW_VOLUME_SHARE = 0.05;

const DISCOUNT_NOTE =
  "Discount = list value (quantity × rate) − billed line amount, per item line. Lines without a rate or quantity are left out, and a line billed below 5% of its list value (but not free) is not read as a discount. Pre-tax item values: they do not add up to invoice totals.";
const RATE_NOTE =
  "Rates are billed amount ÷ quantity (after discount, before tax). No unit of measure is stored, so a rate assumes the same unit on every voucher line of a product; a product whose sale line rates (or purchase line rates) differ among themselves by more than 5× is flagged.";

const round2 = (n) => (Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : null);
const clampLimit = (limit, fallback = 10) => {
  const n = Number.parseInt(limit, 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : fallback;
};
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const modelFor = (entity) => (entity === "purchase" ? Purchase : Sale);

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
async function discountSummary(tenantId, period, { entity = "sales", by = null, limit = 10 } = {}) {
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

  const [totalsRow] = await Model.aggregate([...prefix, { $group: { _id: null, ...DISCOUNT_GROUP } }]);
  const totals = totalsRow ? shapeDiscount(totalsRow) : shapeDiscount({ gross: 0, billed: 0, discount: 0, lines: 0, listedLines: 0, discountedLines: 0, excludedLines: 0 });

  let rows = [];
  if (keyExpr) {
    const raw = await Model.aggregate([
      ...prefix,
      { $group: { _id: keyExpr, ...DISCOUNT_GROUP } },
      // a group with no plausible priced line has nothing to say about discounts (its lines are counted in the totals)
      { $match: { gross: { $gt: 0 } } },
      by === "month" ? { $sort: { _id: 1 } } : { $sort: { discount: -1, _id: 1 } },
      { $limit: by === "month" ? 120 : clampLimit(limit) },
    ]);
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

// Per-product sale and purchase rates for the period, side by side.
async function ratesByProduct(tenantId, period, { limit = 10, product = null } = {}) {
  const match = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });
  const productMatch = product ? [{ $match: { "inventory.itemName": { $regex: `^${escapeRegex(product)}$`, $options: "i" } } }] : [];
  const side = (Model) =>
    Model.aggregate([
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
    ]);
  const [sales, purchases] = await Promise.all([side(Sale), side(Purchase)]);

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

// What each supplier charged per unit for the same product, and who is cheapest.
async function supplierRates(tenantId, period, { product = null, limit = 10 } = {}) {
  const match = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });
  const productMatch = product ? [{ $match: { "inventory.itemName": { $regex: `^${escapeRegex(product)}$`, $options: "i" } } }] : [];

  const pairs = await Purchase.aggregate([
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
  ]);

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

  const out = [...items.values()]
    .sort((a, b) => b.totalBilled - a.totalBilled || (a.product < b.product ? -1 : 1))
    .slice(0, clampLimit(limit))
    .map((it) => {
      const suppliers = it.suppliers.map((s) => ({ ...s, qtyShare: it.totalQty > 0 ? s.qty / it.totalQty : 0 }));
      suppliers.sort((a, b) => a.avgRate - b.avgRate || (a.supplier < b.supplier ? -1 : 1));
      // the cheapest supplier that actually supplies a meaningful share; a tiny one-off purchase is not "the best rate"
      const best = suppliers.find((s) => s.qtyShare >= LOW_VOLUME_SHARE) || suppliers[0];
      const saving = suppliers.reduce((sum, s) => sum + Math.max(0, s.avgRate - best.avgRate) * s.qty, 0);
      const spread = it.minRate > 0 ? it.maxRate / it.minRate : 1;
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
        })),
      };
    });

  return { rows: out, period: { from: period.from, to: period.to, label: period.label || null }, hasData: out.length > 0, disclosures: [RATE_NOTE] };
}

module.exports = { discountSummary, ratesByProduct, supplierRates, MIN_BILLED_TO_LIST, DISCOUNT_NOTE, RATE_NOTE };
