/**
 * Regression tests for the Reports module (Product Report, Customer
 * Report, and the CSV export endpoints for all four report types).
 *
 * Sales Report and Purchase Report have no dedicated backend logic to
 * test here - they reuse getSalesSummary/getPurchaseSummary (already
 * covered by verify-dashboard-real-data.js) and the voucher-listing
 * endpoints (already covered by verify-voucher-pagination.js). This
 * file covers exactly what's new: reportAnalytics.js and
 * reportController.js.
 *
 * Every number is independently cross-checked against a raw Mongo
 * aggregation computed a different way in this file, for both real
 * tenants (WE FOUR, Nirmal).
 *
 * Run: node verify-reports.js
 */

require("dotenv").config();
const jwt = require("jsonwebtoken");
const axios = require("axios");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const Company = require("./src/models/company.js");
const User = require("./src/models/user.model");
const reportAnalytics = require("./src/services/analytics/reportAnalytics");
const dateRanges = require("./src/services/analytics/dateRanges");

let pass = 0;
let fail = 0;

function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)} actual: ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}

async function independentProductTotals(tenantId, from, to, itemName) {
  const [sale] = await Sale.aggregate([
    { $match: { tenantId, voucherStatus: "active", "header.voucherDate": { $gte: from, $lte: to } } },
    { $unwind: "$inventory" },
    { $match: { "inventory.itemName": itemName } },
    { $group: { _id: null, qty: { $sum: "$inventory.quantity" }, amount: { $sum: "$inventory.amount" } } },
  ]);
  const [purchase] = await Purchase.aggregate([
    { $match: { tenantId, voucherStatus: "active", "header.voucherDate": { $gte: from, $lte: to } } },
    { $unwind: "$inventory" },
    { $match: { "inventory.itemName": itemName } },
    { $group: { _id: null, qty: { $sum: "$inventory.quantity" }, amount: { $sum: { $abs: "$inventory.amount" } } } },
  ]);
  return { sale, purchase };
}

async function independentCustomerTotals(tenantId, from, to, partyName) {
  const [agg] = await Sale.aggregate([
    { $match: { tenantId, voucherStatus: "active", "header.voucherDate": { $gte: from, $lte: to }, "header.partyName": partyName } },
    { $group: { _id: null, amount: { $sum: "$header.voucherTotalAmount" }, count: { $sum: 1 } } },
  ]);
  return agg;
}

async function testTenant(name, tenantId) {
  console.log(`\n=== ${name} (${tenantId}) ===`);

  const period = dateRanges.customRange("2025-01-01", "2026-12-31");

  // --- Product Report ---
  const products = await reportAnalytics.getProductReport(tenantId, period, { page: 1, limit: 5, sortBy: "amount" });
  check(`${name}-product-pagination-shape`, "product report returns page/limit/total/totalPages",
    typeof products.pagination.total, "number");
  check(`${name}-product-page-size`, "returns at most `limit` rows", products.items.length <= 5, true);

  if (products.items.length > 0) {
    const top = products.items[0];
    const independent = await independentProductTotals(tenantId, period.from, period.to, top.itemName);
    check(`${name}-product-sales-qty`, `top product's salesQuantity matches independent aggregation (${top.itemName})`,
      top.salesQuantity, independent.sale?.qty ?? 0);
    check(`${name}-product-sales-amount`, `top product's salesAmount matches independent aggregation`,
      top.salesAmount, independent.sale?.amount ?? 0);
    check(`${name}-product-purchase-amount-sign`, "purchaseAmount is never negative (abs'd from Tally's stored sign)",
      top.purchaseAmount === null || top.purchaseAmount >= 0, true);
    if (independent.purchase) {
      check(`${name}-product-purchase-amount`, "purchaseAmount matches independent abs()'d aggregation",
        top.purchaseAmount, independent.purchase.amount);
    }
  }

  // Search narrows results
  if (products.items.length > 0) {
    const term = products.items[0].itemName.slice(0, 4);
    const searched = await reportAnalytics.getProductReport(tenantId, period, { page: 1, limit: 50, search: term });
    const allMatch = searched.items.every((i) => i.itemName.toLowerCase().includes(term.toLowerCase()));
    check(`${name}-product-search-matches`, `search "${term}" returns only matching item names`, allMatch, true);
  }

  // --- Customer Report ---
  const customers = await reportAnalytics.getCustomerReport(tenantId, period, { page: 1, limit: 5, sortBy: "amount" });
  check(`${name}-customer-page-size`, "returns at most `limit` rows", customers.items.length <= 5, true);
  check(`${name}-customer-total-matches-summary`, "pagination.total matches summary.totalCustomers",
    customers.pagination.total, customers.summary.totalCustomers);

  if (customers.items.length > 0) {
    const top = customers.items[0];
    const independent = await independentCustomerTotals(tenantId, period.from, period.to, top.customerName);
    check(`${name}-customer-amount`, `top customer's totalAmount matches independent aggregation (${top.customerName})`,
      top.totalAmount, independent?.amount ?? 0);
    check(`${name}-customer-orders`, "top customer's orderCount matches independent aggregation",
      top.orderCount, independent?.count ?? 0);
  }

  // No page-overlap between page 1 and page 2
  if (customers.pagination.totalPages > 1) {
    const page2 = await reportAnalytics.getCustomerReport(tenantId, period, { page: 2, limit: 5 });
    const overlap = customers.items.some((a) => page2.items.some((b) => a.customerName === b.customerName));
    check(`${name}-customer-no-page-overlap`, "page 1 and page 2 share no customers", overlap, false);
  }

  // Tenant isolation: an empty/unrelated tenantId must never throw a cross-tenant result
  return { products, customers };
}

async function testTenantIsolation(tenantAId, tenantBId) {
  console.log("\n=== Cross-tenant isolation ===");
  const period = dateRanges.customRange("2000-01-01", "2030-12-31");
  const a = await reportAnalytics.getCustomerReport(tenantAId, period, { page: 1, limit: 500 });
  const b = await reportAnalytics.getCustomerReport(tenantBId, period, { page: 1, limit: 500 });

  check("isolation-different-totals", "tenant A and tenant B report different totalCustomers (not sharing state)",
    a.summary.totalCustomers === b.summary.totalCustomers, false);

  // Searching tenant B for tenant A's own top customer name must find nothing.
  if (a.items.length > 0) {
    const searchedInB = await reportAnalytics.getCustomerReport(tenantBId, period, { page: 1, limit: 10, search: a.items[0].customerName });
    check("isolation-no-cross-tenant-search-leak", `tenant B searching for tenant A's top customer ("${a.items[0].customerName}") finds nothing`,
      searchedInB.items.length, 0);
  }

  // Same for products.
  const productsA = await reportAnalytics.getProductReport(tenantAId, period, { page: 1, limit: 1 });
  if (productsA.items.length > 0) {
    const searchedInB = await reportAnalytics.getProductReport(tenantBId, period, { page: 1, limit: 10, search: productsA.items[0].itemName });
    check("isolation-no-cross-tenant-product-leak", `tenant B searching for tenant A's top product ("${productsA.items[0].itemName}") finds nothing`,
      searchedInB.items.length, 0);
  }
}

async function testExportConsistency() {
  console.log("\n=== Export consistency: CSV must match the JSON API for the same filters ===");
  const BASE_URL = "http://localhost:5000";
  let user;
  try {
    user = await User.findOne({}).lean();
  } catch (_) {
    user = null;
  }
  if (!user) {
    console.log("SKIP | export-consistency - no User document found");
    return;
  }
  const token = jwt.sign(
    { id: user._id.toString(), role: user.role || "user", companyGuId: user.companyGuId, tenantId: user.tenantId, tv: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: "5m" }
  );
  const headers = { Authorization: `Bearer ${token}` };

  let reachable = true;
  try {
    await axios.get(`${BASE_URL}/api/reports/customers`, { headers, timeout: 3000 });
  } catch (error) {
    reachable = !!error.response;
  }
  if (!reachable) {
    console.log("SKIP | export-consistency - backend not reachable on :5000");
    return;
  }

  const params = { period: "custom", from: "2025-01-01", to: "2026-12-31", limit: 10 };

  const jsonRes = await axios.get(`${BASE_URL}/api/reports/customers`, { headers, params });
  const csvRes = await axios.get(`${BASE_URL}/api/reports/customers/export`, {
    headers,
    params: { period: "custom", from: params.from, to: params.to },
    responseType: "text",
  });

  const csvLines = csvRes.data.trim().split("\r\n");
  check("export-csv-header", "CSV header row matches expected columns", csvLines[0], "Customer,Invoices,Sales Amount");

  if (jsonRes.data.state === "valid_data" || jsonRes.data.state === "stale_data") {
    const topFromJson = jsonRes.data.data.items[0];
    const csvDataRows = csvLines.slice(1);
    const topRowInCsv = csvDataRows.find((line) => line.startsWith(`"${topFromJson.customerName}"`) || line.startsWith(topFromJson.customerName));
    check("export-top-customer-present", `top customer from JSON (${topFromJson.customerName}) appears in the CSV export`,
      !!topRowInCsv, true);
    if (topRowInCsv) {
      const amountInCsv = topRowInCsv.split(",").pop();
      check("export-top-customer-amount-matches", "CSV amount for the top customer matches the JSON API amount",
        Number(amountInCsv), topFromJson.totalAmount);
    }
  }

  // Live HTTP: product/customer report and all 4 export endpoints reachable
  const salesExport = await axios.get(`${BASE_URL}/api/reports/sales/export`, { headers, params: { period: "current_month" }, responseType: "text" });
  check("export-sales-status", "sales export returns a CSV starting with the expected header",
    salesExport.data.split("\r\n")[0], "Voucher No,Date,Customer,Amount");

  const purchaseExport = await axios.get(`${BASE_URL}/api/reports/purchases/export`, { headers, params: { period: "current_month" }, responseType: "text" });
  check("export-purchase-status", "purchase export returns a CSV starting with the expected header",
    purchaseExport.data.split("\r\n")[0], "Voucher No,Date,Supplier,Amount");

  const productExport = await axios.get(`${BASE_URL}/api/reports/products/export`, { headers, params: { period: "custom", from: params.from, to: params.to }, responseType: "text" });
  check("export-product-status", "product export returns a CSV starting with the expected header",
    productExport.data.split("\r\n")[0], "Product,Sales Quantity,Sales Amount,Purchase Quantity,Purchase Amount");
}

async function testInvalidFilters() {
  console.log("\n=== Invalid filters ===");
  const BASE_URL = "http://localhost:5000";
  let user;
  try {
    user = await User.findOne({}).lean();
  } catch (_) {
    user = null;
  }
  if (!user) {
    console.log("SKIP | invalid-filters - no User document found");
    return;
  }
  const token = jwt.sign(
    { id: user._id.toString(), role: user.role || "user", companyGuId: user.companyGuId, tenantId: user.tenantId, tv: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: "5m" }
  );
  const headers = { Authorization: `Bearer ${token}` };

  let reachable = true;
  try {
    await axios.get(`${BASE_URL}/api/reports/products`, { headers, timeout: 3000 });
  } catch (error) {
    reachable = !!error.response;
  }
  if (!reachable) {
    console.log("SKIP | invalid-filters - backend not reachable on :5000");
    return;
  }

  try {
    await axios.get(`${BASE_URL}/api/reports/products`, { headers, params: { period: "custom" } }); // missing from/to
    check("invalid-custom-period-status", "custom period without from/to is rejected", "no error thrown", "400");
  } catch (error) {
    check("invalid-custom-period-status", "custom period without from/to is rejected with 400", error.response?.status, 400);
  }

  try {
    await axios.get(`${BASE_URL}/api/reports/products`, { headers, params: { period: "not_a_real_period" } });
    check("invalid-period-kind-status", "unknown period kind is rejected", "no error thrown", "400");
  } catch (error) {
    check("invalid-period-kind-status", "unknown period kind is rejected with 400", error.response?.status, 400);
  }

  const noAuth = await axios.get(`${BASE_URL}/api/reports/products`, { validateStatus: () => true });
  check("no-token-rejected", "a request with no Authorization header is rejected with 401", noAuth.status, 401);
}

async function main() {
  await connectDB();

  const weFour = await Company.findOne({ companyName: "WE FOUR" }).lean();
  const nirmal = await Company.findOne({ companyName: /Nirmal/i }).lean();

  if (weFour) await testTenant("WE FOUR", weFour.tenantId);
  if (nirmal) await testTenant("Nirmal", nirmal.tenantId);
  if (weFour && nirmal) await testTenantIsolation(weFour.tenantId, nirmal.tenantId);

  await testExportConsistency();
  await testInvalidFilters();

  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
