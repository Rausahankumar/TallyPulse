"use strict";

/**
 * Legacy chat's get_customer_sales resolves the typed name with the same tenant-bound resolver as the query engine
 * ("Dhingra" -> the one stored name starting with it). Synthetic names only; the analytics call and the resolver are
 * replaced, so nothing real is read. MongoDB is connected only because the trust envelope reads sync freshness.
 *
 * Run: node verify-legacy-customer-name.js
 */

require("dotenv").config();
const mongoose = require("mongoose");

const queryChat = require("./src/services/query/queryChat");
const { createEntityResolver } = require("./src/services/query/entityResolver");
const salesAnalytics = require("./src/services/analytics/salesAnalytics");
const { TOOL_HANDLERS } = require("./src/services/ai/tools");

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"} - ${label}${!cond && detail ? ` (${detail})` : ""}`);
}

(async () => {
  await require("./src/config/db")();
  const names = { customer: ["Acme Trading Store", "Zenith Mart", "Zenith Stores", "Orbit Co", "Orbit Co Pvt"], supplier: ["Acme Supplies Ltd"], product: [], productGroup: [] };
  const resolver = createEntityResolver({ tenantId: "SYN-TENANT", sources: Object.fromEntries(Object.entries(names).map(([k, v]) => [k, async () => v])) });

  const realResolver = queryChat.getTenantResolver;
  const realAnalytics = salesAnalytics.getCustomerSales;
  const seen = [];
  salesAnalytics.getCustomerSales = async (tenantId, name) => {
    seen.push({ tenantId, name });
    return { customerFound: true, matchedNames: [name], totalSales: 1, orderCount: 1, averageOrderValue: 1, period: {}, hasData: true };
  };
  const ctx = { tenantId: "SYN-TENANT", referenceDate: new Date(2025, 8, 15, 12), coverage: null };
  const call = async (customerName) => {
    seen.length = 0;
    await TOOL_HANDLERS.get_customer_sales({ customerName, period: "all_time" }, ctx);
    return seen[0] && seen[0].name;
  };

  try {
    queryChat.getTenantResolver = () => resolver;
    check("a unique leading word reaches the analytics call as the stored name", (await call("Acme")) === "Acme Trading Store");
    check("a lower-case leading word does too", (await call("acme")) === "Acme Trading Store");
    check("an exact name is passed as stored", (await call("zenith mart")) === "Zenith Mart");
    check("a leading word shared by two names stays as typed (still not found downstream)", (await call("Zenith")) === "Zenith");
    check("a supplier-only name is never used for a customer lookup", (await call("Acme Supplies")) === "Acme Supplies");
    check("an unknown name stays as typed", (await call("Nonexistent")) === "Nonexistent");
    check("the tenant id passed to the analytics call is the context's", seen[0].tenantId === "SYN-TENANT");

    queryChat.getTenantResolver = () => {
      const failing = async () => { throw new Error("lookup down"); };
      return failing;
    };
    check("if the lookup fails the name is passed as typed (previous behaviour)", (await call("Acme")) === "Acme");
  } finally {
    queryChat.getTenantResolver = realResolver;
    salesAnalytics.getCustomerSales = realAnalytics;
    await mongoose.disconnect().catch(() => {});
  }

  console.log(`\nverify-legacy-customer-name: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
