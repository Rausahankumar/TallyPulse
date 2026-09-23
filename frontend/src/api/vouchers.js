import client from "./client";

// GET /api/vouchers/sales, GET /api/vouchers/purchases —
// backend/src/routes/voucherRoutes.js. Server-side paginated + searchable
// voucher listing. Tenant/company scoping happens entirely server-side
// from the caller's JWT (liveCompanyContext) — nothing here ever sends a
// tenantId or companyId. Response: { success, data: [...], pagination:
// { page, limit, total, totalPages } }.

async function list(path, { page, limit, search, from, to } = {}) {
  const { data } = await client.get(path, { params: { page, limit, search, from, to } });
  return data;
}

export function listSalesVouchers(params) {
  return list("/vouchers/sales", params);
}

export function listPurchaseVouchers(params) {
  return list("/vouchers/purchases", params);
}
