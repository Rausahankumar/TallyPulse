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
