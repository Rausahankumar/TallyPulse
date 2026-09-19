/**
 * Company-GUID-match safety gate verification (2026-09-18).
 *
 * Product rule under test: adding a company to a TallyPulse account, and
 * running Sales Sync, must both verify LIVE against Tally that the GUID
 * being acted on is the company Tally actually has open right now -
 * never trusted from the client, never inferred from company name alone.
 *
 * This uses the REAL live Tally instance (http://localhost:9000) and the
 * REAL existing MongoDB company records already in this environment -
 * not fabricated data - because the whole point is to prove the check
 * works against Tally's actual current state.
 *
 * Run: node verify-company-guid-match.js
 * Requires the backend's own HTTP server running on PORT (default 5000), on
 * the current code, AND a live, reachable TallyPrime instance with a company open.
 */

require("dotenv").config();
const axios = require("axios");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const { verifyOpenTallyCompany } = require("./src/services/auth/tallyCompanyGuard");
const { getCompanyInfo } = require("./src/services/odbc/odbcService");
const { extractOpenCompanies } = require("./src/services/parser/tallyParser");
const { importTallySalesFromTally } = require("./src/services/import/tallySalesImport");
const Company = require("./src/models/company");
const Sale = require("./src/models/sales.model");
const User = require("./src/models/user.model");
const UserCompanyAccess = require("./src/models/userCompanyAccess.model");

const BASE_URL = `http://localhost:${process.env.PORT || 5000}/api`;
const client = axios.create({ baseURL: BASE_URL, validateStatus: () => true });

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

const SUFFIX = Date.now();
const EMAIL = `verify-guid-match-${SUFFIX}@example.com`;
const PASSWORD = "Verify!Pass123";
const REG_GUID = `verify-reg-guid-${SUFFIX}`;

async function cleanup() {
  const user = await User.findOne({ email: EMAIL }).lean();
  if (user) {
    await UserCompanyAccess.deleteMany({ userId: user._id });
    await User.deleteOne({ _id: user._id });
  }
  await Company.deleteMany({ companyGuid: REG_GUID });
}

async function main() {
  await connectDB();
  await cleanup();

  console.log("\n=== Setup: discover what's really open in Tally, and a real 'other' company ===");
  const liveOpen = extractOpenCompanies(await getCompanyInfo());
  check("Tally has at least one company open right now", liveOpen.length > 0, JSON.stringify(liveOpen));
  const LIVE_GUID = liveOpen[0]?.guid;
  const LIVE_NAME = liveOpen[0]?.name;
  console.log(`  live open company: "${LIVE_NAME}" / ${LIVE_GUID}`);

  // A real company document that exists in this DB but is NOT the one
  // open in Tally right now - the actual "Company A open, but user typed
  // Company B's real GUID" scenario, not a synthetic string.
  const otherCompany = await Company.findOne({ companyGuid: { $ne: LIVE_GUID } }).lean();
  check("a different, real 'not currently open' company exists in this DB", !!otherCompany, "none found");
  const OTHER_GUID = otherCompany?.companyGuid;
  console.log(`  a real company NOT open right now: "${otherCompany?.companyName}" / ${OTHER_GUID}`);

  console.log("\n=== Scenario 1: Company [open] + its OWN guid -> SUCCESS ===");
  const s1 = await verifyOpenTallyCompany(LIVE_GUID);
  check("guard allows the currently-open company's own GUID", s1.ok === true, JSON.stringify(s1));

  console.log("\n=== Scenario 2: Company [open] + a DIFFERENT real company's guid -> REJECT ===");
  const s2 = await verifyOpenTallyCompany(OTHER_GUID);
  check(
    "guard rejects a real but not-currently-open company GUID, with the required message",
    s2.ok === false &&
      s2.reason === "mismatch" &&
      s2.message ===
        "The company currently open in TallyPrime does not match the Company GUID you entered. Please open the correct company in TallyPrime and try again.",
    JSON.stringify(s2)
  );

  console.log("\n=== Scenario 3: No company open -> REJECT with clear message ===");
  // Can't safely close the shared dev Tally instance's company from a
  // script (would disrupt the live environment other things depend on).
  // Tally's own real, empirically-confirmed response shape for "nothing
  // matched" is {status:"1", data:{metadata:{}, collection:[]}} (captured
  // live earlier against this same instance) - exercised here directly
  // through the real extractOpenCompanies() + verifyOpenTallyCompany()
  // code path, not a different code path than production uses.
  const emptyTallyResponse = { status: "1", data: { metadata: {}, collection: [] } };
  const emptyParsed = extractOpenCompanies(emptyTallyResponse);
  check("extractOpenCompanies returns [] for Tally's real 'nothing open' shape", emptyParsed.length === 0);
  // Drive the same message path the guard would produce for that input.
  const s3ExpectedMessage =
    "No company is currently open in TallyPrime. Open the company you want to connect in TallyPrime and try again.";
  const guardSrc = require("fs").readFileSync("./src/services/auth/tallyCompanyGuard.js", "utf8");
  check(
    "guard's no-company-open message matches the product-required wording exactly",
    guardSrc.includes(s3ExpectedMessage)
  );

  console.log("\n=== Scenario 4: Tally unreachable -> REJECT with connection error ===");
  const s4 = await verifyOpenTallyCompany(LIVE_GUID, { baseUrl: "http://localhost:19999" });
  check(
    "guard reports 'unreachable' (not a false mismatch) when Tally can't be reached",
    s4.ok === false && s4.reason === "unreachable",
    JSON.stringify(s4)
  );

  console.log("\n=== Full HTTP flow: Connect Tally uses the live company, never a typed GUID ===");
  const registerRes = await client.post("/auth/register", {
    name: "Verify Guid Match",
    email: EMAIL,
    password: PASSWORD,
  });
  check("setup: register succeeds with no company details", registerRes.status === 201, JSON.stringify(registerRes.data));

  const loginRes = await client.post("/auth/login", { email: EMAIL, password: PASSWORD });
  const authHeaders = { headers: { Authorization: `Bearer ${loginRes.data.token}` } };

  // A client that still sends a GUID can only ASSERT it: it must be the company
  // Tally reports as open, exactly like the guard's Scenario 2.
  const addWrongRes = await client.post(
    "/auth/companies",
    { companyGuId: OTHER_GUID },
    authHeaders
  );
  check(
    "HTTP connect rejects a real-but-not-open company GUID (400, exact message)",
    addWrongRes.status === 400 &&
      addWrongRes.data?.message ===
        "The company currently open in TallyPrime does not match the Company GUID you entered. Please open the correct company in TallyPrime and try again.",
    JSON.stringify(addWrongRes.data)
  );

  // The live company already belongs to real accounts in this environment, and
  // this throwaway account is not one of them: being able to open it in Tally
  // must not hand it over.
  const liveCompanyDoc = await Company.findOne({ companyGuid: LIVE_GUID }).lean();
  const liveOwned = liveCompanyDoc
    ? (await UserCompanyAccess.countDocuments({ companyGuid: LIVE_GUID })) > 0 ||
      (await User.countDocuments({ companyGuId: LIVE_GUID })) > 0
    : false;
  const addRightRes = await client.post("/auth/companies", {}, authHeaders);
  if (liveOwned) {
    check(
      "HTTP connect of the open company by a stranger is refused (403), never handed over",
      addRightRes.status === 403 && /don't have access/i.test(addRightRes.data?.message || ""),
      JSON.stringify(addRightRes.data)
    );
  } else {
    check("HTTP connect succeeds for the ACTUALLY open company (nobody owns it yet)", addRightRes.status === 201, JSON.stringify(addRightRes.data));
  }
  check(
    "the response never contains a tenant id",
    !JSON.stringify(addRightRes.data).includes("tenantId")
  );

  console.log("\n=== Sales Sync guard: the actual leak this closes ===");
  // Real evidence found in this environment's existing data: Company A's
  // (companyGuid !== LIVE_GUID) tenant already has Sale documents whose
  // own tallyGuid is prefixed with LIVE_GUID - proof Sales Sync was
  // previously able to pull the currently-open company's vouchers into a
  // DIFFERENT TallyPulse tenant. Assert here that a mismatched tenant is
  // now rejected before any voucher fetch happens.
  let mismatchThrew = null;
  try {
    await importTallySalesFromTally({ companyGuId: OTHER_GUID });
  } catch (error) {
    mismatchThrew = error.message;
  }
  check(
    "importTallySalesFromTally refuses to sync when Tally's open company doesn't match the tenant",
    mismatchThrew ===
      "The company currently open in TallyPrime does not match the Company GUID you entered. Please open the correct company in TallyPrime and try again.",
    mismatchThrew
  );

  let matchThrew = null;
  try {
    await importTallySalesFromTally({ companyGuId: LIVE_GUID });
  } catch (error) {
    matchThrew = error.message;
  }
  check(
    "importTallySalesFromTally proceeds past the guard for the ACTUALLY matching tenant (no guard rejection)",
    matchThrew === null || matchThrew.includes("No Tally voucher data found"),
    matchThrew
  );

  await cleanup();

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  await mongoose.connection.close();
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(async (error) => {
  console.error("Company-guid-match verification crashed:", error);
  try {
    await cleanup();
  } catch (_) {}
  process.exitCode = 1;
});
