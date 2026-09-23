const Sale = require("../models/sales.model");
const Purchase = require("../models/purchase.model");
const reportAnalytics = require("../services/analytics/reportAnalytics");
const { buildVoucherMatchStage } = require("../services/analytics/analyticsScope");
const { getTenantReferenceDate } = require("../services/analytics/referenceDate");
const { wrapAnalyticsResult } = require("../services/analytics/trustEnvelope");
const { resolvePeriod } = require("../services/ai/tools");

// --------------------------------------------------
// Reports module. Every JSON endpoint below returns the same trust
// envelope every other analytics endpoint does ({success, state, data,
// freshness, message}) - Reports is not a separate trust model, it's the
// same Analytics Engine data shaped for a report view.
//
// Every export endpoint streams CSV built from the EXACT SAME query the
// JSON endpoint used for the same filters (same match stage, same sort,
// same field set) - never a second, drifting definition of "the report".
// Capped at MAX_EXPORT_ROWS so a company with an unusually large history
// can't turn an export click into an unbounded query - see Phase 8.
// --------------------------------------------------

const MAX_EXPORT_ROWS = 10000;

function parsePeriodFromQuery(query, referenceDate) {
  const period = query.period || "current_month";
  const PERIOD_KINDS = ["current_month", "previous_month", "custom"];

  if (!PERIOD_KINDS.includes(period)) {
    const err = new Error(`Invalid period "${period}". Expected one of: ${PERIOD_KINDS.join(", ")}.`);
    err.status = 400;
    throw err;
  }
  if (period === "custom" && (!query.from || !query.to)) {
    const err = new Error('period "custom" requires both "from" and "to" query params.');
    err.status = 400;
    throw err;
  }
  try {
    return resolvePeriod({ period, from: query.from, to: query.to }, referenceDate);
  } catch (error) {
    error.status = error.status || 400;
    throw error;
  }
}

function parsePagination(query) {
  const page = Number.parseInt(query.page, 10);
  const limit = Number.parseInt(query.limit, 10);
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 25,
  };
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 500;
      if (status === 500) console.error("REPORT ERROR:", error);
      return res.status(status).json({
        success: false,
        message: status === 500 ? "Something went wrong on the server. Please try again." : error.message,
      });
    }
  };
}

// Minimal RFC 4180 CSV field escaping - wraps in quotes and doubles any
// embedded quote whenever the field contains a comma, quote or newline
// (real party/item names can contain any of these, e.g. `M/S ABC, INC.`).
function csvField(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvRow(fields) {
  return fields.map(csvField).join(",") + "\r\n";
}

function sendCsv(res, filename, header, rows) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.write(csvRow(header));
  for (const row of rows) res.write(csvRow(row));
  res.end();
}

const getProductReport = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parsePeriodFromQuery(req.query, referenceDate);
  const { page, limit } = parsePagination(req.query);
  const sortBy = req.query.sortBy === "quantity" ? "quantity" : "amount";

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => reportAnalytics.getProductReport(tenantId, period, { page, limit, search: req.query.search, sortBy }),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getCustomerReport = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parsePeriodFromQuery(req.query, referenceDate);
  const { page, limit } = parsePagination(req.query);
  const sortBy = req.query.sortBy === "orders" ? "orders" : "amount";

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => reportAnalytics.getCustomerReport(tenantId, period, { page, limit, search: req.query.search, sortBy }),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const exportSalesReport = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parsePeriodFromQuery(req.query, referenceDate);
  const match = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });

  const docs = await Sale.find(match)
    .sort({ "header.voucherDate": -1, _id: -1 })
    .limit(MAX_EXPORT_ROWS)
    .lean();

  const rows = docs.map((d) => [
    d.header?.voucherNo,
    d.header?.voucherDate ? new Date(d.header.voucherDate).toISOString().slice(0, 10) : "",
    d.header?.partyName,
    d.header?.voucherTotalAmount,
  ]);

  sendCsv(res, "sales-report.csv", ["Voucher No", "Date", "Customer", "Amount"], rows);
});

const exportPurchaseReport = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parsePeriodFromQuery(req.query, referenceDate);
  const match = buildVoucherMatchStage({ tenantId, from: period.from, to: period.to });

  const docs = await Purchase.find(match)
    .sort({ "header.voucherDate": -1, _id: -1 })
    .limit(MAX_EXPORT_ROWS)
    .lean();

  const rows = docs.map((d) => [
    d.header?.voucherNo,
    d.header?.voucherDate ? new Date(d.header.voucherDate).toISOString().slice(0, 10) : "",
    d.header?.partyName,
    d.header?.voucherTotalAmount,
  ]);

  sendCsv(res, "purchase-report.csv", ["Voucher No", "Date", "Supplier", "Amount"], rows);
});

const exportProductReport = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parsePeriodFromQuery(req.query, referenceDate);
  const sortBy = req.query.sortBy === "quantity" ? "quantity" : "amount";

  const result = await reportAnalytics.getProductReport(tenantId, period, {
    page: 1,
    limit: MAX_EXPORT_ROWS,
    search: req.query.search,
    sortBy,
  });

  const rows = result.items.map((r) => [
    r.itemName,
    r.salesQuantity,
    r.salesAmount,
    r.purchaseQuantity,
    r.purchaseAmount,
  ]);

  sendCsv(
    res,
    "product-report.csv",
    ["Product", "Sales Quantity", "Sales Amount", "Purchase Quantity", "Purchase Amount"],
    rows
  );
});

const exportCustomerReport = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parsePeriodFromQuery(req.query, referenceDate);
  const sortBy = req.query.sortBy === "orders" ? "orders" : "amount";

  const result = await reportAnalytics.getCustomerReport(tenantId, period, {
    page: 1,
    limit: MAX_EXPORT_ROWS,
    search: req.query.search,
    sortBy,
  });

  const rows = result.items.map((r) => [r.customerName, r.orderCount, r.totalAmount]);

  sendCsv(res, "customer-report.csv", ["Customer", "Invoices", "Sales Amount"], rows);
});

module.exports = {
  getProductReport,
  getCustomerReport,
  exportSalesReport,
  exportPurchaseReport,
  exportProductReport,
  exportCustomerReport,
};
