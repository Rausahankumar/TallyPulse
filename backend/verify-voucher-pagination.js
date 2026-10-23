/**
 * Regression tests for the paginated/searchable voucher-list endpoints
 * (GET /api/vouchers/sales, GET /api/vouchers/purchases) added as part
 * of the frontend production-readiness work.
 *
 * Two layers:
 *   A. Direct controller calls (mock req/res, no HTTP/JWT) against REAL
 *      synced data for both real tenants (WE FOUR, Nirmal) - pagination
 *      math, search correctness, date filtering, tenant isolation, all
 *      independently cross-checked against raw Mongo aggregations.
 *   B. A real HTTP round-trip (against a live `node server.js`) using a
 *      locally-minted JWT for the real dev account, proving the full
 *      auth + liveCompanyContext + controller chain works end-to-end,
 *      not just the controller function in isolation. Skipped
 *      gracefully if the backend isn't running on :5000 or the dev
 *      account doesn't exist (e.g. in CI) - never a false failure for
 *      an environment that simply doesn't have this specific tenant.
 *
 * Run: node verify-voucher-pagination.js
 */

require("dotenv").config();
const jwt = require("jsonwebtoken");
const axios = require("axios");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const User = require("./src/models/user.model");
const { listSalesVouchers, listPurchaseVouchers } = require("./src/controllers/voucherController");

let pass = 0;
let fail = 0;

function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)} actual: ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

async function call(handler, tenantId, query) {
  const req = { companyContext: { tenantId }, query };
  const res = mockRes();
  await handler(req, res);
  return res;
}

// --------------------------------------------------------------------
// A. Direct controller tests, against real synced data.
// --------------------------------------------------------------------
async function testDirectController() {
  const companies = await mongoose.connection.collection("companies").find({}).limit(2).toArray();
  if (companies.length === 0) {
    console.log("SKIP | direct-controller-tests - no Company documents found in this database");
    return;
  }
  const [companyA, companyB] = companies;

  // A1: pagination total matches an independent countDocuments.
  {
    const res = await call(listSalesVouchers, companyA.tenantId, { page: "1", limit: "25" });
    const gt = await Sale.countDocuments({ tenantId: companyA.tenantId, voucherStatus: "active" });
    check("A1-pagination-total", "pagination.total matches independent countDocuments", res.body.pagination.total, gt);
    check("A1-page-size", "returns at most `limit` rows", res.body.data.length <= 25, true);
  }

  // A2: page 1 and page 2 never overlap.
  {
    const p1 = await call(listSalesVouchers, companyA.tenantId, { page: "1", limit: "10" });
    const p2 = await call(listSalesVouchers, companyA.tenantId, { page: "2", limit: "10" });
    const ids1 = new Set(p1.body.data.map((d) => d.tallyGuid));
    const overlap = p2.body.data.filter((d) => ids1.has(d.tallyGuid));
    check("A2-no-page-overlap", "page 1 and page 2 share no records", overlap.length, 0);
  }

  // A3: search matches an independent regex countDocuments.
  {
    const sample = await Sale.findOne({ tenantId: companyA.tenantId, voucherStatus: "active" }).lean();
    if (sample) {
      const term = sample.header.partyName.slice(0, 5);
      const res = await call(listSalesVouchers, companyA.tenantId, { search: term, limit: "5" });
      const gt = await Sale.countDocuments({
        tenantId: companyA.tenantId,
        voucherStatus: "active",
        "header.partyName": { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" },
      });
      check("A3-search-matches-ground-truth", `search "${term}" matches independent regex count`, res.body.pagination.total, gt);
    }
  }

  // A4: search is case-insensitive.
  {
    const sample = await Sale.findOne({ tenantId: companyA.tenantId, voucherStatus: "active" }).lean();
    if (sample) {
      const term = sample.header.partyName.slice(0, 5);
      const lower = await call(listSalesVouchers, companyA.tenantId, { search: term.toLowerCase(), limit: "5" });
      const upper = await call(listSalesVouchers, companyA.tenantId, { search: term.toUpperCase(), limit: "5" });
      check("A4-case-insensitive", "lower/upper case search return the same total", lower.body.pagination.total, upper.body.pagination.total);
    }
  }

  // A5: unknown search term -> zero results, not an error.
  {
    const res = await call(listSalesVouchers, companyA.tenantId, { search: "ZZZ_NO_SUCH_PARTY_XYZ_12345" });
    check("A5-unknown-search-status", "unknown search term returns 200, not an error", res.statusCode, 200);
    check("A5-unknown-search-empty", "unknown search term returns zero results", res.body.pagination.total, 0);
  }

  // A6: regex special characters in search never crash the request.
  {
    const res = await call(listSalesVouchers, companyA.tenantId, { search: "A(B)C.*[D]\\E" });
    check("A6-regex-chars-safe", "regex-special-character search does not error", res.statusCode, 200);
  }

  // A7: invalid date -> 400, not a crash.
  {
    const res = await call(listSalesVouchers, companyA.tenantId, { from: "not-a-date" });
    check("A7-invalid-date-status", "invalid `from` date returns 400", res.statusCode, 400);
  }

  // A8: date-range filter matches an independent count.
  {
    const res = await call(listSalesVouchers, companyA.tenantId, { from: "2025-04-01", to: "2025-04-30" });
    const gt = await Sale.countDocuments({
      tenantId: companyA.tenantId,
      voucherStatus: "active",
      "header.voucherDate": { $gte: new Date("2025-04-01"), $lte: new Date("2025-04-30") },
    });
    check("A8-date-range", "from/to date filter matches independent count", res.body.pagination.total, gt);
  }

  // A9/A10: tenant isolation, both directions, if a second real company exists.
  if (companyB) {
    const resB = await call(listSalesVouchers, companyB.tenantId, { limit: "100" });
    const leaked = resB.body.data.some((d) => d.tallyGuid && d.tallyGuid.startsWith(companyA.companyGuid));
    check("A9-tenant-isolation-no-leak", "tenant B's results never contain tenant A's voucher guids", leaked, false);

    const sampleA = await Sale.findOne({ tenantId: companyA.tenantId, voucherStatus: "active" }).lean();
    if (sampleA) {
      const crossSearch = await call(listSalesVouchers, companyB.tenantId, { search: sampleA.header.partyName });
      check("A10-tenant-isolation-search", "tenant B searching for tenant A's own party name finds nothing", crossSearch.body.pagination.total, 0);
    }
  } else {
    console.log("SKIP | A9/A10-tenant-isolation - only one Company document exists in this database");
  }

  // A11: empty tenant -> empty result, not an error.
  {
    const res = await call(listSalesVouchers, "nonexistent-tenant-id-for-testing-xyz", { page: "1", limit: "10" });
    check("A11-empty-tenant-status", "a tenant with no data returns 200", res.statusCode, 200);
    check("A11-empty-tenant-data", "a tenant with no data returns an empty array", res.body.data, []);
    check("A11-empty-tenant-total", "a tenant with no data reports total 0", res.body.pagination.total, 0);
  }

  // A12: purchase endpoint sanity (same code path, different model).
  {
    const res = await call(listPurchaseVouchers, companyA.tenantId, { page: "1", limit: "5" });
    const gt = await Purchase.countDocuments({ tenantId: companyA.tenantId, voucherStatus: "active" });
    check("A12-purchase-endpoint", "purchase endpoint total matches independent count", res.body.pagination.total, gt);
  }
}

// --------------------------------------------------------------------
// B. Real HTTP round-trip against a live backend, if one is running.
// --------------------------------------------------------------------
async function testLiveHttp() {
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
    await axios.get(`${BASE_URL}/api/vouchers/sales`, { headers, params: { limit: 1 }, timeout: 3000 });
  } catch (error) {
    reachable = error.response ? true : false; // a real HTTP error response still means "reachable"
  }

  if (!reachable) {
    console.log(`SKIP | live-http-tests - backend not reachable at ${BASE_URL} (not currently running)`);
    return;
  }

  {
    const res = await axios.get(`${BASE_URL}/api/vouchers/sales`, { headers, params: { page: 1, limit: 5 } });
    check("B1-live-http-status", "GET /api/vouchers/sales returns 200 over real HTTP", res.status, 200);
    check("B1-live-http-shape", "response has data[] and pagination{}", !!res.data.data && !!res.data.pagination, true);
  }

  {
    try {
      await axios.get(`${BASE_URL}/api/vouchers/sales`);
      check("B2-no-token-rejected", "a request with no Authorization header is rejected", "no error thrown", "401");
    } catch (error) {
      check("B2-no-token-rejected", "a request with no Authorization header is rejected with 401", error.response?.status, 401);
    }
  }

  {
    const res = await axios.get(`${BASE_URL}/api/vouchers/purchases`, { headers, params: { page: 1, limit: 5 } });
    check("B3-purchases-live-http", "GET /api/vouchers/purchases returns 200 over real HTTP", res.status, 200);
  }
}

async function main() {
  await connectDB();

  console.log("=== A. Direct controller tests (real data, both tenants if available) ===");
  await testDirectController();

  console.log("\n=== B. Live HTTP tests (real backend + real JWT, skipped if not running) ===");
  await testLiveHttp();

  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("TEST SUITE ERROR:", err);
  process.exit(1);
});
