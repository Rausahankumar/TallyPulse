"use strict";

/**
 * Analytics data-layer verification (synthetic data only; no Claude, no Tally):
 *   - voucher identity (tenantId + tallyGuid, not voucherNo)
 *   - analytics scope (tenant + active-only filtering, fails closed)
 *   - trust envelope states (valid/zero/stale/failed/never-synced/error)
 *   - company-context authorization
 *
 * Every fixture is a clearly-labelled synthetic document (VERIFY-* voucher numbers, a synthetic Company/User) created
 * and removed around each test, regardless of pass/fail. The one write under TENANT_A (an orphaned tenant id that no
 * Company document owns any more) is an opaque scoping key for the voucher-identity check; nothing real is read.
 *
 * Run: node verify-analytics-scope.js
 */
require("dotenv").config();
const connectDB = require("./src/config/db");
const mongoose = require("mongoose");

const Company = require("./src/models/company");
const Purchase = require("./src/models/purchase.model");
const Sale = require("./src/models/sales.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const { processSinglePurchaseVoucher } = require("./src/services/import/tallyPurchaseImport");
const { resolveAuthorizedCompany } = require("./src/services/auth/companyContext");
const { buildVoucherMatchStage } = require("./src/services/analytics/analyticsScope");
const { wrapAnalyticsResult } = require("./src/services/analytics/trustEnvelope");
const salesAnalytics = require("./src/services/analytics/salesAnalytics");
const dateRanges = require("./src/services/analytics/dateRanges");

const TENANT_A = "6a8e75cdf5f2a9694ed20472";

// Fully isolated synthetic identity - never a real production/dev
// company - used only by the company-authorization and tool/chat security
// tests below (see the file-level comment for why each one needs it, or
// doesn't need a real company at all but benefits from not depending on
// TENANT_A's drifting historical data).
const SYNTHETIC_TENANT = "verify-analytics-ai-tenant";
const SYNTHETIC_COMPANY_GUID = "verify-analytics-ai-company-guid";

// One Sale + a fresh, successful Sales checkpoint for the synthetic
// tenant; testTrustEnvelope then ages/fails the checkpoint to reach the
// other freshness states. Removed by cleanupSyntheticCompany().
async function seedTrustEnvelopeFixture() {
  await cleanupSyntheticData();
  await Sale.create({
    tenantId: SYNTHETIC_TENANT,
    header: {
      voucherNo: "VERIFY-TRUST-1",
      voucherDate: new Date("2026-09-01"),
      voucherType: "Sales",
      voucherTotalAmount: 100,
      partyName: "Verify Trust Party",
    },
    inventory: [],
    ledgers: [],
    tallyGuid: "verify-trust-guid-1",
    tallyAlterId: 1,
    voucherStatus: "active",
  });
  await SyncCheckpoint.create({
    tenantId: SYNTHETIC_TENANT,
    companyGuid: SYNTHETIC_COMPANY_GUID,
    voucherType: "Sales",
    lastAlterId: 1,
    lastRunStatus: "success",
    lastSyncedAt: new Date(),
    isRunning: false,
    lockedAt: null,
  });
}

async function cleanupSyntheticData() {
  await Sale.deleteMany({ tenantId: SYNTHETIC_TENANT });
  await SyncCheckpoint.deleteMany({ tenantId: SYNTHETIC_TENANT });
}

async function setupSyntheticCompany() {
  await cleanupSyntheticData();
  await Company.deleteOne({ companyGuid: SYNTHETIC_COMPANY_GUID });
  await Company.create({
    companyName: "Verify Analytics AI Test Co",
    sourceType: "tally",
    companyGuid: SYNTHETIC_COMPANY_GUID,
    tenantId: SYNTHETIC_TENANT,
    isActive: true,
  });
}

async function cleanupSyntheticCompany() {
  await cleanupSyntheticData();
  await Company.deleteOne({ companyGuid: SYNTHETIC_COMPANY_GUID });
}

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail ? ` (${detail})` : ""}`);
  }
}

async function testVoucherIdentity() {
  console.log("\n=== Voucher identity: same voucherNo, different tallyGuid -> two documents ===");

  const guidA = "verify-guid-AAA";
  const guidB = "verify-guid-BBB";
  const voucherNo = "VERIFY-01";

  await Purchase.deleteMany({ tenantId: TENANT_A, tallyGuid: { $in: [guidA, guidB] } });

  const voucherA = {
    vouchernumber: voucherNo, date: "20260905", partyname: "Verify Vendor A", vouchertypename: "Purchase",
    guid: guidA, alterid: "500001",
    ledgerentries: [{ ledgername: "Purchase AC", amount: "100.00", isdeemedpositive: true }, { ledgername: "Verify Vendor A", amount: "-100.00", isdeemedpositive: false }],
  };
  const voucherB = {
    vouchernumber: voucherNo, date: "20260906", partyname: "Verify Vendor B", vouchertypename: "Purchase",
    guid: guidB, alterid: "500002",
    ledgerentries: [{ ledgername: "Purchase AC", amount: "200.00", isdeemedpositive: true }, { ledgername: "Verify Vendor B", amount: "-200.00", isdeemedpositive: false }],
  };

  const r1 = await processSinglePurchaseVoucher(voucherA, TENANT_A);
  const r2 = await processSinglePurchaseVoucher(voucherB, TENANT_A);
  check("voucher A created", r1.status === "created", r1.status);
  check("voucher B created (not treated as update to A)", r2.status === "created", r2.status);

  const docs = await Purchase.find({ tenantId: TENANT_A, "header.voucherNo": voucherNo }).lean();
  check("exactly two separate documents exist", docs.length === 2, `found ${docs.length}`);

  // Idempotency: same guid, same alterid -> duplicate, still 2 docs.
  const r3 = await processSinglePurchaseVoucher(voucherA, TENANT_A);
  check("re-processing same guid+alterid is idempotent", r3.status === "duplicate", r3.status);
  const docsAfter = await Purchase.find({ tenantId: TENANT_A, "header.voucherNo": voucherNo }).lean();
  check("still exactly two documents after re-processing", docsAfter.length === 2, `found ${docsAfter.length}`);

  await Purchase.deleteMany({ tenantId: TENANT_A, tallyGuid: { $in: [guidA, guidB] } });
}

async function testAnalyticsScope() {
  console.log("\n=== Analytics scope: fails closed, excludes non-active vouchers ===");

  let threw = false;
  try {
    buildVoucherMatchStage({});
  } catch (e) {
    threw = true;
  }
  check("missing tenantId throws rather than building a tenant-less query", threw);

  const match = buildVoucherMatchStage({ tenantId: TENANT_A });
  check("default scope excludes cancelled/deleted vouchers", JSON.stringify(match.voucherStatus) === JSON.stringify({ $in: ["active"] }));
}

async function testTrustEnvelope() {
  console.log("\n=== Trust envelope: distinct states for zero / never-synced / error ===");

  const wide = dateRanges.customRange("2020-01-01", "2030-01-01");
  const empty = dateRanges.customRange("1999-01-01", "1999-02-01");

  // Freshness comes from the tenant's SyncCheckpoint, so these checks
  // used to depend on a live background worker keeping TENANT_A's
  // checkpoint fresh. That tenant is orphaned (no Company document, so
  // no worker syncs it) and its checkpoint is frozen, so the "real data"
  // check could only ever return stale_data. Now each state is produced
  // deterministically from a seeded fixture under the isolated
  // SYNTHETIC_TENANT: one Sale plus a controlled Sales checkpoint.
  await seedTrustEnvelopeFixture();

  const valid = await wrapAnalyticsResult({ tenantId: SYNTHETIC_TENANT, voucherType: "Sales", run: () => salesAnalytics.getSalesSummary(SYNTHETIC_TENANT, wide) });
  check("real data + fresh sync -> valid_data", valid.state === "valid_data", valid.state);

  const zero = await wrapAnalyticsResult({ tenantId: SYNTHETIC_TENANT, voucherType: "Sales", run: () => salesAnalytics.getSalesSummary(SYNTHETIC_TENANT, empty) });
  check("empty period + fresh sync -> zero_result", zero.state === "zero_result", zero.state);

  const STALE_MINUTES = 20; // beyond the 15-minute default freshness threshold
  await SyncCheckpoint.updateOne(
    { tenantId: SYNTHETIC_TENANT, companyGuid: SYNTHETIC_COMPANY_GUID, voucherType: "Sales" },
    { $set: { lastSyncedAt: new Date(Date.now() - STALE_MINUTES * 60 * 1000) } }
  );
  const stale = await wrapAnalyticsResult({ tenantId: SYNTHETIC_TENANT, voucherType: "Sales", run: () => salesAnalytics.getSalesSummary(SYNTHETIC_TENANT, wide) });
  check("real data + sync older than the freshness threshold -> stale_data", stale.state === "stale_data", stale.state);

  await SyncCheckpoint.updateOne(
    { tenantId: SYNTHETIC_TENANT, companyGuid: SYNTHETIC_COMPANY_GUID, voucherType: "Sales" },
    { $set: { lastSyncedAt: new Date(), lastRunStatus: "failed", lastError: "verify: simulated failure" } }
  );
  const failed = await wrapAnalyticsResult({ tenantId: SYNTHETIC_TENANT, voucherType: "Sales", run: () => salesAnalytics.getSalesSummary(SYNTHETIC_TENANT, wide) });
  check("real data + last sync failed -> sync_failed", failed.state === "sync_failed", failed.state);

  const neverSynced = await wrapAnalyticsResult({ tenantId: "verify-never-synced-tenant", voucherType: "Sales", run: () => salesAnalytics.getSalesSummary("verify-never-synced-tenant", wide) });
  check("never-synced tenant -> no_usable_data (not zero_result)", neverSynced.state === "no_usable_data", neverSynced.state);

  const errored = await wrapAnalyticsResult({ tenantId: TENANT_A, voucherType: "Sales", run: () => salesAnalytics.getSalesSummary(undefined, wide) });
  check("internal error -> analytics_error, no fabricated result", errored.state === "analytics_error" && errored.data === null);
}


async function testCompanyContext() {
  console.log("\n=== Company context authorization ===");

  // Fixture updated 2026-09-21 (audit F-06): company access is now checked against
  // the LIVE account, so the token payload needs a real user id and that user's
  // default company - a payload with no user behind it is (correctly) refused.
  // The assertions below are unchanged.
  const User = require("./src/models/user.model");
  const FIXTURE_EMAIL = "verify-analytics-company-context@example.test";
  await User.deleteMany({ email: FIXTURE_EMAIL });
  const fixtureUser = await User.create({ name: "Verify Context", email: FIXTURE_EMAIL, password: "not-a-real-hash", companyGuId: SYNTHETIC_COMPANY_GUID });

  try {
    const authUser = { id: String(fixtureUser._id), companyGuId: SYNTHETIC_COMPANY_GUID, tenantId: SYNTHETIC_TENANT };

    const own = await resolveAuthorizedCompany(authUser);
    check("resolves own company by default", own.tenantId === SYNTHETIC_TENANT);

    let rejected = false;
    try {
      await resolveAuthorizedCompany(authUser, "some-other-company-guid");
    } catch (e) {
      rejected = e.status === 403;
    }
    check("requesting a different company is rejected 403", rejected);
  } finally {
    await User.deleteMany({ email: FIXTURE_EMAIL });
  }
}


async function main() {
  await connectDB();

  try {
    await setupSyntheticCompany();

    await testVoucherIdentity();
    await testAnalyticsScope();
    await testTrustEnvelope();
    await testCompanyContext();
  } finally {
    await cleanupSyntheticCompany();
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);

  await mongoose.connection.close();
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(async (error) => {
  console.error("Verification script crashed:", error);
  try {
    await cleanupSyntheticCompany();
  } catch (_) {}
  try {
    await mongoose.connection.close();
  } catch (_) {}
  process.exitCode = 1;
});
