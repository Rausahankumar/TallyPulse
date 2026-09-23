import client from "./client";

// GET /api/reports/* — backend/src/routes/reportRoutes.js. Product/
// Customer reports return the same trust envelope every other analytics
// endpoint does. Tenant scoping happens entirely server-side from the
// caller's JWT — nothing here ever sends a tenantId or companyId.

function buildPeriodParams({ period, from, to } = {}) {
  if (from && to) return { period: "custom", from, to };
  return { period: period || "current_month" };
}

export function getProductReport({ from, to, period, page, limit, search, sortBy } = {}) {
  return client
    .get("/reports/products", { params: { ...buildPeriodParams({ period, from, to }), page, limit, search, sortBy } })
    .then((r) => r.data);
}

export function getCustomerReport({ from, to, period, page, limit, search, sortBy } = {}) {
  return client
    .get("/reports/customers", { params: { ...buildPeriodParams({ period, from, to }), page, limit, search, sortBy } })
    .then((r) => r.data);
}

// Export endpoints stream a file, not JSON — an authenticated request
// (the JWT header) can't be a plain <a href>, so this fetches the CSV as
// a blob and triggers the browser's normal save-file flow from it.
async function downloadCsv(path, params, filename) {
  const response = await client.get(path, { params, responseType: "blob" });
  const url = URL.createObjectURL(response.data);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function exportSalesReport({ from, to, period } = {}) {
  return downloadCsv("/reports/sales/export", buildPeriodParams({ period, from, to }), "sales-report.csv");
}

export function exportPurchaseReport({ from, to, period } = {}) {
  return downloadCsv("/reports/purchases/export", buildPeriodParams({ period, from, to }), "purchase-report.csv");
}

export function exportProductReport({ from, to, period, search, sortBy } = {}) {
  return downloadCsv(
    "/reports/products/export",
    { ...buildPeriodParams({ period, from, to }), search, sortBy },
    "product-report.csv"
  );
}

export function exportCustomerReport({ from, to, period, search, sortBy } = {}) {
  return downloadCsv(
    "/reports/customers/export",
    { ...buildPeriodParams({ period, from, to }), search, sortBy },
    "customer-report.csv"
  );
}
