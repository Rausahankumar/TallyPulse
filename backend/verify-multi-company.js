/**
 * Multi-company-per-account verification.
 *
 * Product rule under test: a user registers ONE TallyPulse account.
 * Adding another company must NOT require a second email/account - it
 * must use the same account, re-authorized with the existing password,
 * and the company becomes switchable without re-login.
 *
 * Covers:
 *   - register creates a UserCompanyAccess row for the first company
 *   - addCompany requires the correct password (wrong password rejected)
 *   - addCompany requires the GUID to be the company Tally has open RIGHT
 *     NOW, verified live on the backend (a GUID that isn't open is
 *     rejected, even with the correct password)
 *   - addCompany links a SECOND company to the SAME user (no new email)
 *   - listCompanies returns both companies for that one account
 *   - switchCompany issues a new JWT scoped to the second company, no password
 *   - switchCompany rejects a company the user was never given access to
 *   - resolveAuthorizedCompany (via a protected route) accepts the switched
 *     company and rejects an unrelated one
 *   - updateCompanyName actually persists (real backend save, not local-only)
 *
 * Run: node verify-multi-company.js
 * Requires the backend's own HTTP server running on PORT (default 5000).
 */

require("dotenv").config();
const axios = require("axios");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const User = require("./src/models/user.model");
const Company = require("./src/models/company");
const UserCompanyAccess = require("./src/models/userCompanyAccess.model");
const { getCompanyInfo } = require("./src/services/odbc/odbcService");
const { extractOpenCompanies } = require("./src/services/parser/tallyParser");

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
const EMAIL = `verify-multi-company-${SUFFIX}@example.com`;
const PASSWORD = "Verify!Pass123";
const GUID_A = `verify-guid-a-${SUFFIX}`;
const NAME_A = "Verify Company A";

// addCompany() now requires the requested GUID to be the company Tally
// actually has open right now (2026-09-18 product change), so "add
// company B" below must use the REAL live company - fetched here, never
// hardcoded - rather than a fabricated GUID. Company A above is
// unaffected: register() doesn't gate on Tally.
let GUID_B = null;
let NAME_B = null;

async function cleanup() {
  const user = await User.findOne({ email: EMAIL }).lean();
  if (user) {
    // Only removes this test user's access link, never the Company
    // document itself - GUID_B is the real shared dev company (Tally's
    // actual open company), not test-owned, and must survive this script.
    await UserCompanyAccess.deleteMany({ userId: user._id });
    await User.deleteOne({ _id: user._id });
  }
  await Company.deleteMany({ companyGuid: GUID_A });
}

async function main() {
  await connectDB();
  await cleanup();

  console.log("\n=== Discover the REAL company currently open in Tally (live) ===");
  const openCompanies = extractOpenCompanies(await getCompanyInfo());
  check("at least one company is open in Tally right now", openCompanies.length > 0, JSON.stringify(openCompanies));
  GUID_B = openCompanies[0]?.guid;
  NAME_B = openCompanies[0]?.name;
  console.log(`  (using live company "${NAME_B}" / ${GUID_B})`);

  console.log("\n=== Register the ONE account with its first company (A) ===");
  const registerRes = await client.post("/auth/register", {
    name: "Verify User",
    email: EMAIL,
    password: PASSWORD,
    companyName: NAME_A,
    companyGuId: GUID_A,
  });
  check("register succeeds", registerRes.status === 201, JSON.stringify(registerRes.data));

  const user = await User.findOne({ email: EMAIL }).lean();
  check("exactly one User document exists for this email", !!user);

  const accessAfterRegister = await UserCompanyAccess.find({ userId: user._id }).lean();
  check(
    "register mirrors the first company into UserCompanyAccess",
    accessAfterRegister.length === 1 && accessAfterRegister[0].companyGuid === GUID_A,
    JSON.stringify(accessAfterRegister)
  );

  console.log("\n=== Log in with company A ===");
  const loginRes = await client.post("/auth/login", { email: EMAIL, password: PASSWORD, companyGuId: GUID_A });
  check("login succeeds", loginRes.status === 200 && !!loginRes.data.token);
  const tokenA = loginRes.data.token;
  const authA = { headers: { Authorization: `Bearer ${tokenA}` } };

  console.log("\n=== Adding a company with the WRONG password is rejected ===");
  const wrongPassRes = await client.post(
    "/auth/companies",
    { password: "totally-wrong", companyName: NAME_B, companyGuId: GUID_B },
    authA
  );
  check("wrong password rejected with 401", wrongPassRes.status === 401, JSON.stringify(wrongPassRes.data));
  const usersWithEmail = await User.countDocuments({ email: EMAIL });
  check("still exactly ONE account for this email (no second account created)", usersWithEmail === 1);

  console.log("\n=== Adding a company whose GUID is NOT the one open in Tally is rejected ===");
  const wrongGuidRes = await client.post(
    "/auth/companies",
    { password: PASSWORD, companyName: "Some Other Company", companyGuId: `not-the-open-company-${SUFFIX}` },
    authA
  );
  check(
    "mismatched GUID rejected with 400 and the exact product-required message",
    wrongGuidRes.status === 400 &&
      wrongGuidRes.data?.message ===
        "The company currently open in TallyPrime does not match the Company GUID you entered. Please open the correct company in TallyPrime and try again.",
    JSON.stringify(wrongGuidRes.data)
  );

  console.log("\n=== Adding company B with the CORRECT password succeeds - SAME account, no new email ===");
  const addRes = await client.post(
    "/auth/companies",
    { password: PASSWORD, companyName: NAME_B, companyGuId: GUID_B },
    authA
  );
  check("addCompany succeeds", addRes.status === 201, JSON.stringify(addRes.data));
  check(
    "addCompany returns company B's real data",
    addRes.data?.data?.companyGuid === GUID_B && addRes.data?.data?.companyName === NAME_B
  );

  const usersWithEmailAfterAdd = await User.countDocuments({ email: EMAIL });
  check(
    "STILL exactly ONE account for this email after adding a second company",
    usersWithEmailAfterAdd === 1,
    `count=${usersWithEmailAfterAdd}`
  );

  console.log("\n=== listCompanies shows both companies for the one account ===");
  const listRes = await client.get("/auth/companies", authA);
  const guids = (listRes.data.data || []).map((c) => c.companyGuid);
  check("both companies are listed", guids.includes(GUID_A) && guids.includes(GUID_B), JSON.stringify(guids));
  check(
    "company A is flagged as the default/original company",
    listRes.data.data.find((c) => c.companyGuid === GUID_A)?.isDefault === true
  );

  console.log("\n=== Switching to company B needs NO password, just the existing session ===");
  const switchRes = await client.post("/auth/switch-company", { companyGuId: GUID_B }, authA);
  check("switch succeeds", switchRes.status === 200 && !!switchRes.data.token, JSON.stringify(switchRes.data));
  const tokenB = switchRes.data.token;
  const decodedB = JSON.parse(Buffer.from(tokenB.split(".")[1], "base64url").toString());
  check("the new token is scoped to company B", decodedB.companyGuId === GUID_B, JSON.stringify(decodedB));
  check("the new token is for the SAME user id", decodedB.id === user._id.toString());

  console.log("\n=== A protected route (chat list) accepts the switched company B context ===");
  const chatListB = await client.get("/chat/", { headers: { Authorization: `Bearer ${tokenB}` } });
  check("chat list works under company B's token", chatListB.status === 200, JSON.stringify(chatListB.data));

  console.log("\n=== Switching to a company this account was never given access to is rejected ===");
  const unrelatedRes = await client.post(
    "/auth/switch-company",
    { companyGuId: "some-completely-unrelated-guid" },
    authA
  );
  check("unrelated company switch rejected with 403", unrelatedRes.status === 403, JSON.stringify(unrelatedRes.data));

  console.log("\n=== Re-adding the SAME company again is rejected (no duplicate links) ===");
  const dupRes = await client.post(
    "/auth/companies",
    { password: PASSWORD, companyName: NAME_B, companyGuId: GUID_B },
    authA
  );
  check("duplicate add rejected with 400", dupRes.status === 400, JSON.stringify(dupRes.data));

  console.log("\n=== Renaming the active company is a REAL backend save (not local-only) ===");
  const renameRes = await client.patch(
    "/auth/company",
    { companyName: "Verify Company A Renamed" },
    authA
  );
  check("rename succeeds", renameRes.status === 200, JSON.stringify(renameRes.data));
  const companyADoc = await Company.findOne({ companyGuid: GUID_A }).lean();
  check(
    "the rename is actually persisted in MongoDB",
    companyADoc.companyName === "Verify Company A Renamed",
    companyADoc.companyName
  );

  await cleanup();

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  await mongoose.connection.close();
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(async (error) => {
  console.error("Multi-company verification crashed:", error);
  try {
    await cleanup();
  } catch (_) {}
  process.exitCode = 1;
});
