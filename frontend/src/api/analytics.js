import client from "./client";

// GET /api/analytics/* — backend/src/routes/analyticsRoutes.js, backed
// directly by the existing deterministic Analytics Engine
// (backend/src/services/analytics/*). Every call returns the engine's
// own trust envelope: { success, state, data, freshness, message }.
// `state` is one of valid_data | zero_result | stale_data | sync_failed
// | no_usable_data | analytics_error — callers must render based on
// `state`, never assume `data` is populated just because the request
// succeeded (a 200 with state !== "valid_data"/"stale_data" often has
// data: null, by design — see trustEnvelope.js).
//
// Tenant/company scoping happens entirely server-side from the caller's
// JWT — nothing here ever sends a tenantId or companyId.

function buildPeriodParams({ period, from, to } = {}) {
  if (from && to) return { period: "custom", from, to };
  return { period: period || "current_month" };
}

async function get(path, params) {
  const { data } = await client.get(path, { params });
  return data; // { success, state, data, freshness, message }
}

export function getSalesSummary({ from, to, period } = {}) {
  return get("/analytics/sales/summary", buildPeriodParams({ period, from, to }));
}

export function getSalesComparison({ comparisonType } = {}) {
  return get("/analytics/sales/comparison", { comparisonType });
}

export function getTopProducts({ from, to, period, limit } = {}) {
  return get("/analytics/sales/top-products", { ...buildPeriodParams({ period, from, to }), limit });
}

export function getGrowingProducts({ comparisonType, limit } = {}) {
  return get("/analytics/sales/growing-products", { comparisonType, limit });
}

export function getDecliningProducts({ comparisonType, limit } = {}) {
  return get("/analytics/sales/declining-products", { comparisonType, limit });
}

export function getTopCustomers({ from, to, period, limit } = {}) {
  return get("/analytics/sales/top-customers", { ...buildPeriodParams({ period, from, to }), limit });
}

// Monthly totals over a range - the default (no from/to) is the
// backend's own last-6-months-of-real-data window, not a wall-clock
// assumption made here.
export function getSalesTrend({ from, to } = {}) {
  return get("/analytics/sales/trend", from && to ? { from, to } : {});
}

// Discount given (entity "sales", by customer|product|month) or received (entity "purchase", by supplier|product|month).
// Same calculation the Ask AI chat uses (backend/src/services/analytics/insights.js).
export function getDiscountSummary({ from, to, period, entity, by, limit } = {}) {
  return get("/analytics/discounts", { ...buildPeriodParams({ period, from, to }), entity, by, limit });
}

// Per product: average sale rate, average purchase rate and the gap between them (a price gap, not a profit).
export function getProductRates({ from, to, period, limit, product } = {}) {
  return get("/analytics/products/rates", { ...buildPeriodParams({ period, from, to }), limit, product });
}

// Per product sold: average sale rate vs average purchase cost, margin per unit, margin % and indicative profit (not Tally stock valuation).
// sortBy: "profit" | "marginPct"; order: "desc" | "asc".
export function getProductMargin({ from, to, period, limit, sortBy, order } = {}) {
  return get("/analytics/products/margin", { ...buildPeriodParams({ period, from, to }), limit, sortBy, order });
}

// One product, month by month: quantity bought and sold, net movement and its running total (a movement, not a stock balance).
export function getProductTrend({ product, from, to } = {}) {
  return get("/analytics/products/trend", { product, ...(from && to ? { from, to } : {}) });
}

// Per product: what each supplier charged per unit, and who is cheapest.
export function getSupplierRates({ from, to, period, limit, product } = {}) {
  return get("/analytics/purchases/supplier-rates", { ...buildPeriodParams({ period, from, to }), limit, product });
}

export function getCustomerCounts({ from, to, period } = {}) {
  return get("/analytics/sales/customer-counts", buildPeriodParams({ period, from, to }));
}

export function getPurchaseSummary({ from, to, period } = {}) {
  return get("/analytics/purchases/summary", buildPeriodParams({ period, from, to }));
}

export function getPurchaseComparison({ comparisonType } = {}) {
  return get("/analytics/purchases/comparison", { comparisonType });
}

export function getTopSuppliers({ from, to, period, limit } = {}) {
  return get("/analytics/purchases/top-suppliers", { ...buildPeriodParams({ period, from, to }), limit });
}

export function getPurchaseTrend({ from, to } = {}) {
  return get("/analytics/purchases/trend", from && to ? { from, to } : {});
}
