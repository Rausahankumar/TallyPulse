/**
 * Multi-company-per-account verification, over the real HTTP routes, with the
 * "Connect Tally" flow (no GUID typed anywhere).
 *
 * Product rules under test:
 *   - one TallyPulse account (email) can hold several companies; connecting one
 *     never needs a second email
 *   - the company connected is whichever one TallyPrime has open - detected by
 *     the backend, never supplied by the client
 *   - the first company needs only the session, further ones re-check the password
 *   - switching between the account's own companies needs no password
 *   - another account can never reach this account's companies, by connecting,
 *     switching or knowing an identifier
 *   - a session without a company cannot read company data
 *
 * Self-contained and offline: an in-process copy of the API (same routers and
 * middleware as server.js, no background workers) talks to a stub TallyPrime
 * (TALLY_URL) and the real MongoDB under synthetic data that is cleaned up at
 * start, end and on crash. It no longer depends on the dev server on :5000, on
 * a live Tally, or on which company happens to be open.
 *
 * Run: node verify-multi-company.js
 */

require("dotenv").config();
const http = require("http");
const axios = require("axios");
const express = require("express");
const mongoose = require("mongoose");

let openCompanies = [];

function startStub() {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "1",
        data: { collection: openCompanies.map((c) => ({ name: { value: c.name }, guid: { value: c.guid } })) },
      }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  );
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

const SUFFIX = Date.now();
const PREFIX = "verify-multi-company-";
const EMAIL_1 = `${PREFIX}${SUFFIX}-1@example.com`;
const EMAIL_2 = `${PREFIX}${SUFFIX}-2@example.com`;
const PASSWORD = "Verify!Pass123";
const GUID_A = `${PREFIX}guid-a-${SUFFIX}`;
const GUID_B = `${PREFIX}guid-b-${SUFFIX}`;
const GUID_C = `${PREFIX}guid-c-${SUFFIX}`;
const NAME_A = "Verify Company A";
const NAME_B = "Verify Company B";
const NAME_C = "Verify Company C";

const decode = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
const bearer = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

async function main() {
  const stub = await startStub();
  process.env.TALLY_URL = stub.url;

  const connectDB = require("./src/config/db");
  const User = require("./src/models/user.model");
  const Company = require("./src/models/company");
  const UserCompanyAccess = require("./src/models/userCompanyAccess.model");

  const guidRx = new RegExp(`^${PREFIX}`);

  async function cleanup() {
    await User.deleteMany({ email: guidRx });
    await UserCompanyAccess.deleteMany({ companyGuid: guidRx });
    await Company.deleteMany({ companyGuid: guidRx });
  }

  await connectDB();
  await cleanup();

  const app = express();
  app.use(express.json());
  app.use("/api/auth", require("./src/routes/authRoutes"));
  app.use("/api/chat", require("./src/routes/chatRoutes"));
  const api = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
  const client = axios.create({ baseURL: `http://127.0.0.1:${api.port}/api`, validateStatus: () => true });

  try {
    console.log("\n=== Register an account: name + email + password only ===");
    const registerRes = await client.post("/auth/register", { name: "Verify User", email: EMAIL_1, password: PASSWORD });
    check("register succeeds with no company details", registerRes.status === 201, JSON.stringify(registerRes.data));
    const user = await User.findOne({ email: EMAIL_1 }).lean();
    check("the account has no company yet", !!user && !user.companyGuId && (await UserCompanyAccess.countDocuments({ userId: user._id })) === 0);

    console.log("\n=== Log in with email + password (no company id) ===");
    const loginRes = await client.post("/auth/login", { email: EMAIL_1, password: PASSWORD });
    check("login succeeds", loginRes.status === 200 && !!loginRes.data.token && loginRes.data.hasCompany === false, JSON.stringify(loginRes.data));
    const bareToken = loginRes.data.token;

    console.log("\n=== A session without a company cannot read company data ===");
    const chatBare = await client.get("/chat/", bearer(bareToken));
    check("company data is refused (401)", chatBare.status === 401, `${chatBare.status}`);
    const renameBare = await client.patch("/auth/company", { companyName: "x" }, bearer(bareToken));
    check("renaming a company is refused (401)", renameBare.status === 401, `${renameBare.status}`);

    console.log("\n=== Connect Tally: no company open / several open ===");
    openCompanies = [];
    const noneRes = await client.post("/auth/companies", {}, bearer(bareToken));
    check("nothing open -> friendly 400", noneRes.status === 400 && noneRes.data.message === "Please open your company in TallyPrime and try again.", JSON.stringify(noneRes.data));
    openCompanies = [{ name: NAME_A, guid: GUID_A }, { name: NAME_B, guid: GUID_B }];
    const manyRes = await client.post("/auth/companies", {}, bearer(bareToken));
    check("two open -> 409, no guessing", manyRes.status === 409, JSON.stringify(manyRes.data));
    check("nothing was created by those attempts", (await Company.countDocuments({ companyGuid: guidRx })) === 0);

    console.log("\n=== Connect Tally: the first company needs only the session ===");
    openCompanies = [{ name: NAME_A, guid: GUID_A }];
    const firstRes = await client.post("/auth/companies", {}, bearer(bareToken));
    check("first company connected (201) from an empty request", firstRes.status === 201, JSON.stringify(firstRes.data));
    check("the company is named and identified from Tally", firstRes.data?.data?.companyName === NAME_A && (await Company.findOne({ companyGuid: GUID_A }).lean())?.companyName === NAME_A);
    check("response does not expose a tenant id", !JSON.stringify(firstRes.data).includes("tenantId"));
    const tokenA = firstRes.data.token;
    check("the returned token is scoped to company A", decode(tokenA).companyGuId === GUID_A);
    const authA = bearer(tokenA);
    const chatA = await client.get("/chat/", authA);
    check("company data now works", chatA.status === 200, `${chatA.status}`);

    console.log("\n=== A second company needs the password again ===");
    openCompanies = [{ name: NAME_B, guid: GUID_B }];
    const noPass = await client.post("/auth/companies", {}, authA);
    check("no password -> 401", noPass.status === 401, JSON.stringify(noPass.data));
    const wrongPass = await client.post("/auth/companies", { password: "totally-wrong" }, authA);
    check("wrong password -> 401", wrongPass.status === 401);
    check("still exactly ONE account for this email", (await User.countDocuments({ email: EMAIL_1 })) === 1);

    const wrongGuid = await client.post("/auth/companies", { password: PASSWORD, companyGuId: `not-the-open-company-${SUFFIX}` }, authA);
    check("a client-supplied GUID that is not the open company is rejected (400)", wrongGuid.status === 400 && /does not match/i.test(wrongGuid.data?.message), JSON.stringify(wrongGuid.data));

    const addRes = await client.post("/auth/companies", { password: PASSWORD }, authA);
    check("correct password -> company B connected on the SAME account", addRes.status === 201 && addRes.data?.data?.companyName === NAME_B, JSON.stringify(addRes.data));
    check("still ONE account after adding a second company", (await User.countDocuments({ email: EMAIL_1 })) === 1);

    console.log("\n=== listCompanies shows both companies, without tenant ids ===");
    const listRes = await client.get("/auth/companies", authA);
    const listed = listRes.data.data || [];
    check("both companies are listed", listed.length === 2 && listed.some((c) => c.companyGuid === GUID_A) && listed.some((c) => c.companyGuid === GUID_B));
    check("company A is the default", listed.find((c) => c.companyGuid === GUID_A)?.isDefault === true);
    check("no tenant id in the list", !JSON.stringify(listRes.data).includes("tenantId"));

    console.log("\n=== Switching between the account's own companies needs no password ===");
    const switchRes = await client.post("/auth/switch-company", { companyGuId: GUID_B }, authA);
    check("switch succeeds", switchRes.status === 200 && !!switchRes.data.token, JSON.stringify(switchRes.data));
    const decodedB = decode(switchRes.data.token);
    check("the new token is scoped to company B, same user", decodedB.companyGuId === GUID_B && decodedB.id === String(user._id));
    const chatB = await client.get("/chat/", bearer(switchRes.data.token));
    check("company data works under company B's token", chatB.status === 200, `${chatB.status}`);

    console.log("\n=== Reconnecting a company the account already has is fine ===");
    openCompanies = [{ name: NAME_A, guid: GUID_A }];
    const again = await client.post("/auth/companies", { password: PASSWORD }, authA);
    check("reconnect -> 200, no duplicate", again.status === 200 && (await UserCompanyAccess.countDocuments({ userId: user._id, companyGuid: GUID_A })) === 1, JSON.stringify(again.data));

    console.log("\n=== Another account cannot reach these companies ===");
    await client.post("/auth/register", { name: "Other User", email: EMAIL_2, password: PASSWORD });
    const other = await User.findOne({ email: EMAIL_2 }).lean();
    const otherLogin = await client.post("/auth/login", { email: EMAIL_2, password: PASSWORD });
    const otherBare = otherLogin.data.token;

    const steal = await client.post("/auth/companies", {}, bearer(otherBare));
    check("connecting company A (open in Tally) from another account -> 403", steal.status === 403 && /don't have access/i.test(steal.data?.message), JSON.stringify(steal.data));
    const stealWithGuid = await client.post("/auth/companies", { companyGuId: GUID_A }, bearer(otherBare));
    check("knowing its identifier does not help (403)", stealWithGuid.status === 403);
    const stealSwitch = await client.post("/auth/switch-company", { companyGuId: GUID_A }, bearer(otherBare));
    check("switching into it is refused (403)", stealSwitch.status === 403);
    check("no access was granted", (await UserCompanyAccess.countDocuments({ userId: other._id })) === 0 && !(await User.findById(other._id).lean()).companyGuId);
    const viaHeader = await client.get("/chat/", { headers: { Authorization: `Bearer ${otherBare}`, "x-company-guid": GUID_A } });
    check("the company header cannot smuggle access either", viaHeader.status !== 200, `${viaHeader.status}`);

    console.log("\n=== The other account connects its OWN company; the two stay isolated ===");
    openCompanies = [{ name: NAME_C, guid: GUID_C }];
    const otherConnect = await client.post("/auth/companies", {}, bearer(otherBare));
    check("other account connects company C (201)", otherConnect.status === 201, JSON.stringify(otherConnect.data));
    const toC = await client.post("/auth/switch-company", { companyGuId: GUID_C }, authA);
    check("the first account cannot switch into company C (403)", toC.status === 403);
    const otherList = await client.get("/auth/companies", bearer(otherConnect.data.token));
    check("the other account lists only its own company", (otherList.data.data || []).length === 1 && otherList.data.data[0].companyGuid === GUID_C);
    check("tenants differ", (await Company.findOne({ companyGuid: GUID_C }).lean()).tenantId !== (await Company.findOne({ companyGuid: GUID_A }).lean()).tenantId);

    console.log("\n=== Switching to a company this account was never given is rejected ===");
    const unrelated = await client.post("/auth/switch-company", { companyGuId: "some-completely-unrelated-guid" }, authA);
    check("unrelated company switch rejected with 403", unrelated.status === 403, JSON.stringify(unrelated.data));

    console.log("\n=== Renaming the active company is a REAL backend save ===");
    const renameRes = await client.patch("/auth/company", { companyName: "Verify Company A Renamed" }, authA);
    check("rename succeeds", renameRes.status === 200, JSON.stringify(renameRes.data));
    check("the rename is persisted in MongoDB", (await Company.findOne({ companyGuid: GUID_A }).lean()).companyName === "Verify Company A Renamed");
  } finally {
    await cleanup();
    const leftovers = (await User.countDocuments({ email: guidRx })) + (await Company.countDocuments({ companyGuid: guidRx })) + (await UserCompanyAccess.countDocuments({ companyGuid: guidRx }));
    check("no test data left in MongoDB", leftovers === 0, leftovers);
    api.server.close();
    stub.server.close();
    await mongoose.connection.close();
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(async (error) => {
  console.error("Multi-company verification crashed:", error);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exitCode = 1;
});
