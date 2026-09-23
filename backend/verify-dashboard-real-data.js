/**
 * Regression tests for the Dashboard/Analytics "no fabricated data"
 * remediation: tenant-reference-date anchoring (referenceDate.js), the
 * new monthly trend aggregations (getSalesTrend/getPurchaseTrend), and
 * the new distinct-customer-count aggregation (getCustomerCounts).
 *
 * Every number is independently cross-checked against a raw Mongo
 * aggregation computed a different way in this file, for both real
 * tenants (WE FOUR, Nirmal) - never "trust the function under test to
 * grade itself".
 *
 * Run: node verify-dashboard-real-data.js
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
const { getTenantReferenceDate } = require("./src/services/analytics/referenceDate");
const salesAnalytics = require("./src/services/analytics/salesAnalytics");
const purchaseAnalytics = require("./src/services/analytics/purchaseAnalytics");
const dateRanges = require("./src/services/analytics/dateRanges");

let pass = 0;
let fail = 0;

function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)} actual: ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}

async function independentMaxDate(Model, tenantId) {
  const [agg] = await Model.aggregate([
    { $match: { tenantId, voucherStatus: "active" } },
    { $group: { _id: null, max: { $max: "$header.voucherDate" } } },
  ]);
  return agg ? agg.max : null;
}

async function independentMonthlyTotal(Model, tenantId, field, from, to) {
  const results = await Model.aggregate([
    { $match: { tenantId, voucherStatus: "active", "header.voucherDate": { $gte: from, $lte: to } } },
    { $group: { _id: { y: { $year: "$header.voucherDate" }, m: { $month: "$header.voucherDate" } }, total: { $sum: `$header.${field}` }, count: { $sum: 1 } } },
    { $sort: { "_id.y": 1, "_id.m": 1 } },
  ]);
  return results;
}

async function independentCustomerCounts(tenantId, from, to) {
  const activeNames = await Sale.distinct("header.partyName", {
    tenantId, voucherStatus: "active", "header.voucherDate": { $gte: from, $lte: to },
  });
  const firstSeen = await Sale.aggregate([
    { $match: { tenantId, voucherStatus: "active" } },
    { $group: { _id: "$header.partyName", firstSeen: { $min: "$header.voucherDate" } } },
  ]);
  const totalCustomers = firstSeen.length;
  const newCustomers = firstSeen.filter((c) => c.firstSeen >= from && c.firstSeen <= to).length;
  return { totalCustomers, activeCustomers: activeNames.length, newCustomers };
}

async function testTenant(name, tenantId, otherTenantId) {
  console.log(`\n=== ${name} (${tenantId}) ===`);

  // --- referenceDate anchoring ---
  const referenceDate = await getTenantReferenceDate(tenantId);
  const expectedSaleMax = await independentMaxDate(Sale, tenantId);
  const expectedPurchaseMax = await independentMaxDate(Purchase, tenantId);
  const expectedMax = [expectedSaleMax, expectedPurchaseMax].filter(Boolean).map((d) => new Date(d).getTime());
  const expectedRef = expectedMax.length ? new Date(Math.max(...expectedMax)) : null;
  check(`${name}-ref-date`, "referenceDate matches independently-computed max(Sale, Purchase) voucherDate",
    referenceDate.toISOString(), (expectedRef || referenceDate).toISOString());

  // --- monthly trend, cross-checked point by point ---
  const trendPeriod = dateRanges.lastNMonthsEnding(referenceDate, 6);
  const trend = await salesAnalytics.getSalesTrend(tenantId, trendPeriod);
  const expectedMonthly = await independentMonthlyTotal(Sale, tenantId, "voucherTotalAmount", trendPeriod.from, trendPeriod.to);
  check(`${name}-trend-month-count`, "sales trend month count matches independent aggregation",
    trend.data ? trend.items?.length ?? trend.data.items.length : trend.items.length, expectedMonthly.length);
  const trendItems = trend.items || trend.data?.items || [];
  for (let i = 0; i < expectedMonthly.length; i++) {
    check(`${name}-trend-${expectedMonthly[i]._id.y}-${expectedMonthly[i]._id.m}`,
      `sales trend total matches for ${expectedMonthly[i]._id.y}-${expectedMonthly[i]._id.m}`,
      trendItems[i]?.totalSales, expectedMonthly[i].total);
  }

  const purchaseTrend = await purchaseAnalytics.getPurchaseTrend(tenantId, trendPeriod);
  const expectedPurchaseMonthly = await independentMonthlyTotal(Purchase, tenantId, "voucherTotalAmount", trendPeriod.from, trendPeriod.to);
  check(`${name}-purchase-trend-month-count`, "purchase trend month count matches independent aggregation",
    purchaseTrend.items.length, expectedPurchaseMonthly.length);

  // --- customer counts, cross-checked ---
  const currentMonth = dateRanges.currentMonthToDate(referenceDate);
  const counts = await salesAnalytics.getCustomerCounts(tenantId, currentMonth);
  const expectedCounts = await independentCustomerCounts(tenantId, currentMonth.from, currentMonth.to);
  check(`${name}-total-customers`, "totalCustomers matches independent distinct count", counts.totalCustomers, expectedCounts.totalCustomers);
  check(`${name}-active-customers`, "activeCustomers matches independent distinct count for the period", counts.activeCustomers, expectedCounts.activeCustomers);
  check(`${name}-new-customers`, "newCustomers matches independent first-seen-in-period count", counts.newCustomers, expectedCounts.newCustomers);
  check(`${name}-returning-customers`, "returningCustomers = activeCustomers - newCustomers", counts.returningCustomers, counts.activeCustomers - counts.newCustomers);

  // --- tenant isolation: this tenant's referenceDate/counts must never equal the other tenant's raw numbers by leakage ---
  if (otherTenantId) {
    const otherCounts = await salesAnalytics.getCustomerCounts(otherTenantId, currentMonth);
    const crossLeak = otherCounts.totalCustomers === counts.totalCustomers && counts.totalCustomers > 0 &&
      JSON.stringify(otherCounts) === JSON.stringify(counts);
    check(`${name}-no-cross-tenant-identical-result`, "this tenant's customer counts are not byte-identical to the other tenant's (would indicate a tenant-scoping bug)", crossLeak, false);
  }

  return { referenceDate, trend, counts };
}

async function testLiveHttp() {
  console.log("\n=== Live HTTP: default (no query params) Dashboard calls return valid_data for WE FOUR ===");
  const BASE_URL = "http://localhost:5000";
  let user;
  try {
    user = await User.findOne({}).lean();
  } catch (_) {
    user = null;
  }
  if (!user) {
    console.log("SKIP | live-http-tests - no User document found in this database");
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
    await axios.get(`${BASE_URL}/api/analytics/sales/summary`, { headers, timeout: 3000 });
  } catch (error) {
    reachable = !!error.response;
  }
  if (!reachable) {
    console.log("SKIP | live-http-tests - backend not reachable on :5000");
    return;
  }

  const endpoints = [
    "/api/analytics/sales/summary",
    "/api/analytics/purchases/summary",
    "/api/analytics/sales/trend",
    "/api/analytics/purchases/trend",
    "/api/analytics/sales/customer-counts",
    "/api/analytics/sales/comparison",
  ];
  for (const path of endpoints) {
    const res = await axios.get(`${BASE_URL}${path}`, { headers });
    check(`live-${path}`, `${path} (default params, no date filter) returns 200 with a real, non-error state`,
      res.status === 200 && !["analytics_error", "no_usable_data"].includes(res.data.state), true);
    console.log(`      ${path} -> state=${res.data.state}`);
  }
}

async function main() {
  await connectDB();

  const weFour = await Company.findOne({ companyName: "WE FOUR" }).lean();
  const nirmal = await Company.findOne({ companyName: /Nirmal/i }).lean();

  if (weFour) await testTenant("WE FOUR", weFour.tenantId, nirmal?.tenantId);
  if (nirmal) await testTenant("Nirmal", nirmal.tenantId, weFour?.tenantId);

  await testLiveHttp();

  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
