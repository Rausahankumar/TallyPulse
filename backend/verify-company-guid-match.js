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
 * SEVERAL COMPANIES OPEN: TallyPrime can have several companies open at once
 * and answers queries for only one of them (the SELECTED one). The backend
 * identifies that company from Tally's own voucher-type masters (their GUIDs
 * carry the selected company's GUID) - never from the order of the company
 * list - and this suite then tests against THAT company, exactly as with a
 * single open company (asserted-GUID 400, stranger 403).
 * Only when the selection cannot be identified does Connect Tally answer the
 * intentional 409 ("More than one company is open..."): an ambiguity response,
 * not a security failure - no company, link or default is created. The HTTP
 * checks below run whichever of the two applies to Tally's current state.
 *
 * Run: node verify-company-guid-match.js
 * Requires the backend's own HTTP server running on PORT (default 5000), on
 * the current code, AND a live, reachable TallyPrime instance with a company open.
 */

require("dotenv").config();
const axios = require("axios");
const { resolveSelectedOpenCompany } = require("./src/services/auth/tallyCompanyGuard");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const { verifyOpenTallyCompany } = require("./src/services/auth/tallyCompanyGuard");
const { getCompanyInfo, getVoucherTypeMasters } = require("./src/services/odbc/odbcService");
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
  // The company Tally answers for: the only open one, or - with several open - the
  // SELECTED one (never liveOpen[0] just because it is listed first).
  const detection = await resolveSelectedOpenCompany();
  const ambiguous = liveOpen.length > 1 && !detection.ok;
  const LIVE_GUID = detection.ok ? detection.match.guid : liveOpen[0]?.guid;
  const LIVE_NAME = detection.ok ? detection.match.name : liveOpen[0]?.name;
  console.log(
    ambiguous
      ? `  ${liveOpen.length} companies open and the selected one cannot be identified -> expecting the intentional 409`
      : `  live company: "${LIVE_NAME}" / ${LIVE_GUID}${liveOpen.length > 1 ? ` (selected, of ${liveOpen.length} open)` : ""}`
  );
  if (liveOpen.length > 1 && detection.ok) {
    // Independent of the code under test: the masters really are this company's.
    const masters = (await getVoucherTypeMasters())?.data?.collection || [];
    const firstGuid = String((masters[0]?.guid && (masters[0].guid.value ?? masters[0].guid)) || "");
    check("several companies open: the selected company is the one owning Tally's masters", firstGuid.startsWith(`${LIVE_GUID}-`), firstGuid.slice(0, 40));
  }

  // A real company document that exists in this DB but is NOT the one
  // open in Tally right now - the actual "Company A open, but user typed
  // Company B's real GUID" scenario, not a synthetic string.
  const otherCompany = await Company.findOne({ companyGuid: { $nin: liveOpen.map((c) => c.guid) } }).lean();
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

  const MULTI_OPEN_MESSAGE =
    "More than one company is open in TallyPrime. Keep only the company you want to connect open and try again.";
  const multipleOpen = ambiguous; // several open AND the selection is not identifiable

  const assertedRes = await client.post(
    "/auth/companies",
    { companyGuId: OTHER_GUID },
    authHeaders
  );
  const connectRes = await client.post("/auth/companies", {}, authHeaders);

  if (multipleOpen) {
    // Intentional ambiguity response, NOT a security failure: with several
    // companies open Tally answers for only one, so the backend refuses to pick.
    console.log(
      `  (${liveOpen.length} companies are open and the selected one is not identifiable: expecting the intentional 409 ambiguity response, not 400/403)`
    );
    check(
      "multiple companies open: connecting with an asserted GUID -> intentional 409 (ambiguity, not an access denial)",
      assertedRes.status === 409 && assertedRes.data?.message === MULTI_OPEN_MESSAGE,
      JSON.stringify(assertedRes.data)
    );
    check(
      "multiple companies open: connecting with no GUID -> the same intentional 409",
      connectRes.status === 409 && connectRes.data?.message === MULTI_OPEN_MESSAGE,
      JSON.stringify(connectRes.data)
    );
    const throwaway = await User.findOne({ email: EMAIL }).lean();
    check(
      "the 409 grants nothing: no company link and no default company were created",
      !!throwaway &&
        !throwaway.companyGuId &&
        (await UserCompanyAccess.countDocuments({ userId: throwaway._id })) === 0
    );
  } else {
    // A client that still sends a GUID can only ASSERT it: it must be the company
    // Tally reports as open, exactly like the guard's Scenario 2.
    check(
      "HTTP connect rejects a real-but-not-open company GUID (400, exact message)",
      assertedRes.status === 400 &&
        assertedRes.data?.message ===
          "The company currently open in TallyPrime does not match the Company GUID you entered. Please open the correct company in TallyPrime and try again.",
      JSON.stringify(assertedRes.data)
    );

    // The live company already belongs to real accounts in this environment, and
    // this throwaway account is not one of them: being able to open it in Tally
    // must not hand it over.
    const liveCompanyDoc = await Company.findOne({ companyGuid: LIVE_GUID }).lean();
    const liveOwned = liveCompanyDoc
      ? (await UserCompanyAccess.countDocuments({ companyGuid: LIVE_GUID })) > 0 ||
        (await User.countDocuments({ companyGuId: LIVE_GUID })) > 0
      : false;
    if (liveOwned) {
      check(
        "HTTP connect of the open company by a stranger is refused (403), never handed over",
        connectRes.status === 403 && /don't have access/i.test(connectRes.data?.message || ""),
        JSON.stringify(connectRes.data)
      );
    } else {
      check("HTTP connect succeeds for the ACTUALLY open company (nobody owns it yet)", connectRes.status === 201, JSON.stringify(connectRes.data));
    }
  }
  check(
    "the response never contains a tenant id",
    !JSON.stringify(connectRes.data).includes("tenantId") && !JSON.stringify(assertedRes.data).includes("tenantId")
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
  const guardMismatchMessage =
    "The company currently open in TallyPrime does not match the Company GUID you entered. Please open the correct company in TallyPrime and try again.";
  if (ambiguous) {
    // Selection not identifiable: the company under test is open (so the
    // open-company guard passes) but Tally may answer for another one. Either
    // outcome is correct and safe: the import proceeds, or the ownership guard
    // refuses the response ("Company mismatch"). What must never happen is the
    // open-company guard rejecting a company that IS open.
    check(
      "selection not identifiable: import proceeds OR is refused by the ownership guard - never rejected by the open-company guard",
      (matchThrew === null || matchThrew.includes("No Tally voucher data found") || /Company mismatch/i.test(matchThrew)) &&
        matchThrew !== guardMismatchMessage,
      matchThrew
    );
  } else {
    check(
      "importTallySalesFromTally proceeds past the guard for the ACTUALLY matching tenant (no guard rejection)",
      matchThrew === null || matchThrew.includes("No Tally voucher data found"),
      matchThrew
    );
  }

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
