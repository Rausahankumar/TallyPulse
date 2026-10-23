/**
 * TallyPulse security audit - executable probes (no production code is changed).
 *
 * Each probe states the SECURE behaviour it expects and reports either
 *   [SECURE]      the application behaved securely, or
 *   [VULNERABLE]  the application did NOT (this is an audit finding, not a test
 *                 bug - the run does not fail the process unless --strict).
 * It backs the evidence in docs/TallyPulse-Security-Audit.md (probe ids SEC-xx).
 *
 * Safe by construction: an in-process copy of the API (same routers/middleware
 * as server.js, no cron workers), a stub TallyPrime (TALLY_URL) with THREE open
 * companies, and synthetic data under the prefix "verify-sec-" that is removed
 * at start, end and on crash. It never contacts a real Tally and never issues an
 * operator that could match a real company (regex ^verify-sec-... only).
 *
 * Run:  node verify-security-audit.js            (report)
 *       node verify-security-audit.js --strict   (exit 1 if anything is VULNERABLE)
 */

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const out = console.log.bind(console);
const STRICT = process.argv.includes("--strict");

let secure = 0;
let vulnerable = 0;
const findings = [];
function probe(id, description, isSecure, detail) {
  if (isSecure) {
    secure += 1;
    out(`  [SECURE]     ${id} ${description}`);
  } else {
    vulnerable += 1;
    findings.push(id);
    out(`  [VULNERABLE] ${id} ${description}${detail !== undefined ? `\n               -> ${detail}` : ""}`);
  }
}
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 170 ? `${s.slice(0, 170)}...` : s; };

// ------------------------------------------------------------------ stub TallyPrime
// THREE companies open at once; Tally answers for the SELECTED one only.
const P = "verify-sec-";
const NIR = `${P}nirmal-guid`;
const WF = `${P}wefour-guid`;
const IC = `${P}intellicart-guid`;
const OPEN = [
  { name: "Intelli-Cart", guid: IC },
  { name: "Nirmal", guid: NIR },
  { name: "WE FOUR", guid: WF },
];
let selected = NIR;          // which company Tally currently answers for
let rowsFor = null;          // override: whose vouchers a voucher query returns (default = selected)
let flipAfterMasters = null; // TOCTOU: after the first master query, switch selection to this company
let lastVoucherQuery = null; // last non-company/non-master request body (to inspect the date range sent)

const voucherRow = (company, n = 1) => ({
  vouchernumber: `SEC-${n}`, date: "20260905", partyname: "Audit Customer", vouchertypename: "Sales",
  guid: `${company}-000003${n}d`, alterid: String(2000 + n),
  ledgerentries: [
    { ledgername: "Audit Customer", amount: "-100.00", isdeemedpositive: true },
    { ledgername: "Sales AC", amount: "100.00", isdeemedpositive: false },
  ],
});

function startStub() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const id = req.headers.id;
      if (id === "RTS Company Guid Collection") {
        return res.end(JSON.stringify({ status: "1", data: { collection: OPEN.map((c) => ({ name: { value: c.name }, guid: { value: c.guid } })) } }));
      }
      if (id === "RTS VoucherType Master Collection") {
        const answeredFor = selected;
        if (flipAfterMasters) { selected = flipAfterMasters; flipAfterMasters = null; }
        return res.end(JSON.stringify({ status: "1", data: { collection: [
          { metadata: { name: "Sales", reservedname: "Sales" }, parent: { value: "Sales" }, guid: { value: `${answeredFor}-1` } },
          { metadata: { name: "Purchase", reservedname: "Purchase" }, parent: { value: "Purchase" }, guid: { value: `${answeredFor}-2` } },
        ] } }));
      }
      try { lastVoucherQuery = JSON.parse(body); } catch (_) { lastVoucherQuery = { raw: body.slice(0, 200) }; }
      res.end(JSON.stringify({ status: "1", data: { collection: [voucherRow(rowsFor || selected)] } }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

async function main() {
  const stub = await startStub();
  process.env.TALLY_URL = stub.url;
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required to run the audit probes.");

  const connectDB = require("./src/config/db");
  const User = require("./src/models/user.model");
  const Company = require("./src/models/company");
  const Access = require("./src/models/userCompanyAccess.model");
  const Sale = require("./src/models/sales.model");
  const Purchase = require("./src/models/purchase.model");
  const Chat = require("./src/models/chat.model");
  const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
  const ReconCheckpoint = require("./src/models/reconciliationCheckpoint.model");
  const { verifyOpenTallyCompany } = require("./src/services/auth/tallyCompanyGuard");
  const { runSyncForCompanyModule } = require("./src/services/sync/tallySyncWorker");
  const { recoverMissingVouchers } = require("./src/services/sync/voucherRecovery");
  const { runReconciliationForCompanyModule } = require("./src/services/sync/reconciliationWorker");
  const { processSinglePurchaseVoucher } = require("./src/services/import/tallyPurchaseImport");
  const { importTallySalesFromTally } = require("./src/services/import/tallySalesImport");
  const { resolveVoucherTypeClassification, clearVoucherTypeClassificationCache } = require("./src/services/tally/voucherTypeClassifier");

  const { resetAllRateLimiters } = require("./src/middleware/rateLimit");
  const SECRET = process.env.JWT_SECRET;
  const guidRx = new RegExp(`^${P}`);
  const emailRx = new RegExp(`^${P}`);
  const uploadsDir = path.join(__dirname, "uploads");
  const uploadsBefore = new Set(fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : []);

  async function cleanup() {
    await User.deleteMany({ email: emailRx });
    await Access.deleteMany({ companyGuid: guidRx });
    await Company.deleteMany({ companyGuid: guidRx });
    await Sale.deleteMany({ tenantId: guidRx });
    await Purchase.deleteMany({ tenantId: guidRx });
    await Chat.deleteMany({ tenantId: guidRx });
    await SyncCheckpoint.deleteMany({ tenantId: guidRx });
    await ReconCheckpoint.deleteMany({ tenantId: guidRx });
    if (fs.existsSync(uploadsDir)) {
      for (const f of fs.readdirSync(uploadsDir)) if (!uploadsBefore.has(f) && /verify-sec/.test(f)) fs.unlinkSync(path.join(uploadsDir, f));
    }
  }

  await connectDB();
  await cleanup();

  // ---- in-process API: same middleware order and routers as server.js, no workers
  const app = express();
  require("./src/middleware/httpSecurity").applyHttpSecurity(app); // same security headers + CORS allow-list as server.js
  app.use(require("./src/middleware/requestId")); // same request id as server.js
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/api/auth", require("./src/routes/authRoutes"));
  app.use("/api/import", require("./src/routes/importRoutes"));
  app.use("/api/odbc", require("./src/routes/odbcRoutes"));
  app.use("/api/chat", require("./src/routes/chatRoutes"));
  app.use("/api/sync", require("./src/routes/syncRoutes"));
  app.use("/api/analytics", require("./src/routes/analyticsRoutes"));
  const { errorHandler, notFoundHandler } = require("./src/middleware/errorHandler");
  app.use(notFoundHandler);
  app.use(errorHandler); // same error handler as server.js
  const api = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve({ s, port: s.address().port })); });
  const http_ = axios.create({ baseURL: `http://127.0.0.1:${api.port}`, validateStatus: () => true, maxBodyLength: Infinity });
  const A = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

  // silence application chatter so the report stays readable
  console.log = () => {}; console.info = () => {}; console.warn = () => {}; console.error = () => {};

  // ---- synthetic fixtures
  const PW = "Audit!Pass123";
  const hash = await bcrypt.hash(PW, 10);
  const mkUser = (n) => User.create({ name: n, email: `${P}${n}@example.test`, password: hash });
  // Order matters for SEC-INJ: the victim's company is created FIRST (first in natural order).
  const mkCompany = (guid, name, tenantId) => Company.create({ companyName: name, companyGuid: guid, tenantId, isActive: true });
  const link = async (user, company) => {
    await Access.create({ userId: user._id, companyId: company._id, companyGuid: company.companyGuid, tenantId: company.tenantId });
    if (!user.companyGuId) await User.updateOne({ _id: user._id }, { companyGuId: company.companyGuid, companyName: company.companyName, companyId: company._id, tenantId: company.tenantId });
  };
  const tokenFor = (user, company, extra = {}) => jwt.sign({ id: String(user._id), role: "user", ...(company ? { companyGuId: company.companyGuid, tenantId: company.tenantId } : {}), ...extra }, SECRET, { expiresIn: "1h" });

  const victimCo = await mkCompany(`${P}0-victim-guid`, "Victim Traders", `${P}tenant-victim`);
  const attackerCo = await mkCompany(`${P}9-attacker-guid`, "Attacker Co", `${P}tenant-attacker`);
  const victim = await mkUser("victim"); await link(victim, victimCo);
  const attacker = await mkUser("attacker"); await link(attacker, attackerCo);
  await Sale.create({ tenantId: victimCo.tenantId, tallyGuid: `${victimCo.companyGuid}-0000001`, tallyAlterId: 1, voucherStatus: "active",
    header: { voucherNo: "VICTIM-SECRET-001", voucherDate: new Date(), voucherType: "Sales", voucherTotalAmount: 999999, partyName: "Victim Confidential Customer" }, inventory: [], ledgers: [] });
  // a fresh sync checkpoint so the other tenant's analytics are not suppressed as 'no usable data'
  await SyncCheckpoint.create({ tenantId: victimCo.tenantId, companyGuid: victimCo.companyGuid, voucherType: "Sales", lastAlterId: 5, lastRunStatus: "success", lastSyncedAt: new Date() });
  const victimChat = await Chat.create({ tenantId: victimCo.tenantId, userId: victim._id, title: "victim private chat", messages: [{ role: "user", text: "victim confidential question" }] });
  const attackerToken = tokenFor(attacker, attackerCo);
  const victimToken = tokenFor(victim, victimCo);

  // ==================================================================== 1. AUTHENTICATION
  out("\n1. AUTHENTICATION");
  const protectedCalls = [
    ["GET", "/api/analytics/sales/summary"], ["GET", "/api/chat/"], ["POST", "/api/import/tally-live"],
    ["GET", "/api/sync/status"], ["POST", "/api/sync/recovery"], ["GET", "/api/auth/companies"],
    ["PATCH", "/api/auth/company"], ["POST", "/api/auth/switch-company"], ["POST", "/api/auth/companies"],
  ];
  const unauth = [];
  for (const [m, u] of protectedCalls) { const r = await http_.request({ method: m, url: u }); if (r.status !== 401) unauth.push(`${m} ${u}=${r.status}`); }
  probe("SEC-AUTH-1", "every auth-required route rejects a request with no token (401)", unauth.length === 0, unauth.join(", "));

  const noAuthOdbcCompany = await http_.get("/api/odbc/company");
  const noAuthOdbcSales = await http_.get("/api/odbc/sales");
  probe("SEC-AUTH-2", "/api/odbc/company requires authentication", noAuthOdbcCompany.status === 401, `answered ${noAuthOdbcCompany.status} with the open-company list to an anonymous caller`);
  probe("SEC-AUTH-3", "/api/odbc/sales (raw Tally sales vouchers) requires authentication", noAuthOdbcSales.status === 401,
    `answered ${noAuthOdbcSales.status}; anonymous body contains a voucher: ${JSON.stringify(noAuthOdbcSales.data).includes("Audit Customer")}`);

  const expired = jwt.sign({ id: String(attacker._id), companyGuId: attackerCo.companyGuid, tenantId: attackerCo.tenantId }, SECRET, { expiresIn: -60 });
  const wrongSecret = jwt.sign({ id: String(attacker._id), companyGuId: attackerCo.companyGuid }, "not-the-secret");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const algNone = `${b64({ alg: "none", typ: "JWT" })}.${b64({ id: String(attacker._id), companyGuId: attackerCo.companyGuid, tenantId: attackerCo.tenantId })}.`;
  const [h, pl, sg] = attackerToken.split(".");
  const tampered = `${h}.${b64({ ...JSON.parse(Buffer.from(pl, "base64url").toString()), companyGuId: victimCo.companyGuid, tenantId: victimCo.tenantId })}.${sg}`;
  const badTokens = { expired, wrongSecret, algNone, tampered, garbage: "abc.def.ghi", empty: "" };
  const accepted = [];
  for (const [k, t] of Object.entries(badTokens)) { const r = await http_.get("/api/analytics/sales/summary", A(t)); if (r.status !== 401) accepted.push(`${k}=${r.status}`); }
  probe("SEC-AUTH-4", "expired / wrong-secret / alg:none / tampered-payload / malformed tokens are all rejected (401)", accepted.length === 0, accepted.join(", "));
  const lower = await http_.get("/api/analytics/sales/summary", { headers: { Authorization: `bearer ${attackerToken}` } });
  probe("SEC-AUTH-5", "a valid token is only accepted with the exact 'Bearer ' scheme", lower.status === 401, `lower-case scheme -> ${lower.status}`);

  const ghost = await mkUser("ghost"); const ghostCo = await mkCompany(`${P}ghost-guid`, "Ghost Co", `${P}tenant-ghost`); await link(ghost, ghostCo);
  const ghostToken = tokenFor(ghost, ghostCo);
  const beforeDelete = await http_.get("/api/analytics/sales/summary", A(ghostToken));
  await User.deleteOne({ _id: ghost._id });
  const afterDelete = await http_.get("/api/analytics/sales/summary", A(ghostToken));
  probe("SEC-AUTH-6", "a token stops working once its user account is deleted (revocation)", !(beforeDelete.status === 200 && afterDelete.status === 200),
    `before delete ${beforeDelete.status}, after the account is deleted ${afterDelete.status} (token valid for its full 7-day life)`);

  const reg = await http_.post("/api/auth/register", { name: "Mallory", email: `${P}mallory@example.test`, password: "Mallory!12345", role: "admin", companyGuId: victimCo.companyGuid, tenantId: victimCo.tenantId });
  const mallory = await User.findOne({ email: `${P}mallory@example.test` }).lean();
  probe("SEC-AUTH-7", "registration ignores client-supplied role / companyGuId / tenantId (no mass assignment)", reg.status === 201 && mallory && mallory.role === "user" && !mallory.companyGuId && !mallory.tenantId, `role=${mallory && mallory.role} company=${mallory && mallory.companyGuId}`);
  probe("SEC-AUTH-8", "passwords are stored as bcrypt hashes, never plaintext", !!mallory && /^\$2[aby]\$\d\d\$/.test(mallory.password) && mallory.password !== "Mallory!12345", "hash prefix " + (mallory && mallory.password.slice(0, 7)));
  const weakA = await http_.post("/api/auth/register", { name: "w", email: `${P}weak1@example.test`, password: "a" });
  const weak7 = await http_.post("/api/auth/register", { name: "w", email: `${P}weak7@example.test`, password: "1234567" });
  const okPw = await http_.post("/api/auth/register", { name: "w", email: `${P}okpw8@example.test`, password: "12345678" });
  const tooLong = await http_.post("/api/auth/register", { name: "w", email: `${P}toolong@example.test`, password: "x".repeat(73) });
  probe("SEC-AUTH-9", "registration enforces a minimum password strength (1 and 7 characters refused; 8 accepted; over 72 bytes refused)",
    weakA.status === 400 && weak7.status === 400 && okPw.status === 201 && tooLong.status === 400,
    `1 char -> ${weakA.status}, 7 chars -> ${weak7.status}, 8 chars -> ${okPw.status}, 73 chars -> ${tooLong.status}`);
  // F-08: raising User.tokenVersion signs the account out everywhere (tokens issued before stop working)
  const tvUser = await mkUser("tvuser"); const tvCo = await mkCompany(`${P}tv-guid`, "TV Co", `${P}tenant-tv`); await link(tvUser, tvCo);
  const tvLogin = await http_.post("/api/auth/login", { email: `${P}tvuser@example.test`, password: PW });
  const tvOld = tvLogin.data && tvLogin.data.token;
  const tvBefore = await http_.get("/api/analytics/sales/summary", A(tvOld));
  await User.updateOne({ _id: tvUser._id }, { $inc: { tokenVersion: 1 } });
  const tvAfter = await http_.get("/api/analytics/sales/summary", A(tvOld));
  const tvRelogin = await http_.post("/api/auth/login", { email: `${P}tvuser@example.test`, password: PW });
  const tvNew = await http_.get("/api/analytics/sales/summary", A(tvRelogin.data && tvRelogin.data.token));
  probe("SEC-AUTH-13", "raising an account's session version signs it out everywhere: old tokens are refused (401), a fresh login works", tvBefore.status === 200 && tvAfter.status === 401 && tvNew.status === 200,
    `old token: ${tvBefore.status} before, ${tvAfter.status} after the bump; token from a new login: ${tvNew.status}`);
  const ghostFresh = await http_.get("/api/odbc/company", A(ghostToken));
  probe("SEC-AUTH-14", "a deleted user's token is refused even on a route that only needs a login (/api/odbc/company)", ghostFresh.status === 401, `HTTP ${ghostFresh.status}`);

  const dupe = await http_.post("/api/auth/register", { name: "x", email: `${P}mallory@example.test`, password: "Xx!123456" });
  probe("SEC-AUTH-10", "registering an existing email does not reveal that the email exists (no account enumeration)", !/already registered/i.test(JSON.stringify(dupe.data)), short(dupe.data));

  // ==================================================================== 2. AUTHORIZATION / IDOR
  out("\n2. AUTHORIZATION (IDOR / BOLA)");
  const viaHeader = await http_.get("/api/analytics/sales/summary", { headers: { Authorization: `Bearer ${attackerToken}`, "x-company-guid": victimCo.companyGuid } });
  probe("SEC-AUTHZ-1", "an x-company-guid header naming another user's company is refused (403)", viaHeader.status === 403, `status ${viaHeader.status}`);
  const viaQuery = await http_.get(`/api/analytics/sales/summary?companyGuId=${encodeURIComponent(victimCo.companyGuid)}`, A(attackerToken));
  probe("SEC-AUTHZ-2", "a ?companyGuId= query naming another user's company is refused (403)", viaQuery.status === 403, `status ${viaQuery.status}`);
  const switchOther = await http_.post("/api/auth/switch-company", { companyGuId: victimCo.companyGuid }, A(attackerToken));
  probe("SEC-AUTHZ-3", "switch-company to another user's company (plain string GUID) is refused (403) and issues no token", switchOther.status === 403 && !switchOther.data.token, `status ${switchOther.status}`);
  const chatGet = await http_.get(`/api/chat/${victimChat._id}`, A(attackerToken));
  const chatDel = await http_.delete(`/api/chat/${victimChat._id}`, A(attackerToken));
  probe("SEC-AUTHZ-4", "another tenant's chat cannot be read or deleted by id (404, chat still exists)", chatGet.status === 404 && chatDel.status === 404 && !!(await Chat.findById(victimChat._id)), `read ${chatGet.status}, delete ${chatDel.status}`);
  const chatList = await http_.get("/api/chat/", A(attackerToken));
  probe("SEC-AUTHZ-5", "the chat list contains only the caller's own tenant/user chats", chatList.status === 200 && !JSON.stringify(chatList.data).includes("victim private chat"), `status ${chatList.status}`);
  const stStatus = await http_.get(`/api/sync/status?tenantId=${victimCo.tenantId}&companyGuId=${victimCo.companyGuid}`, { headers: { Authorization: `Bearer ${attackerToken}`, "x-company-guid": victimCo.companyGuid } });
  probe("SEC-AUTHZ-6", "client-supplied tenantId / companyGuId / header are ignored by /api/sync/status (returns only the caller's tenant)", stStatus.status === 200 && !JSON.stringify(stStatus.data).includes("VICTIM-SECRET-001"), short(stStatus.data.data ? { totalSales: stStatus.data.data.totalSales } : stStatus.data));
  const dataNoCompany = await http_.get("/api/sync/status", A(jwt.sign({ id: String(attacker._id) }, SECRET, { expiresIn: "1h" })));
  probe("SEC-AUTHZ-7", "a company-less token cannot read company data (401)", dataNoCompany.status === 401, `status ${dataNoCompany.status}`);

  // stale access: the JWT company claim is trusted without re-checking access
  const stale = await mkUser("stale"); const staleCo = await mkCompany(`${P}stale-guid`, "Stale Co", `${P}tenant-stale`); await link(stale, staleCo);
  const staleToken = tokenFor(stale, staleCo);
  await Access.deleteMany({ userId: stale._id }); await User.updateOne({ _id: stale._id }, { companyGuId: null });
  const staleCall = await http_.get("/api/analytics/sales/summary", A(staleToken));
  const staleStatus = await http_.get("/api/sync/status", A(staleToken));
  probe("SEC-AUTHZ-8", "removing a user's access to a company takes effect immediately (not only at token expiry)", !(staleCall.status === 200 || staleStatus.status === 200), `after all access rows and default were removed: analytics ${staleCall.status}, sync/status ${staleStatus.status}`);

  // a token scoped (via switch-company) to a NON-default company must stop working when that access row is removed
  const multi = await mkUser("multi"); const multiA = await mkCompany(`${P}multi-a-guid`, "Multi A", `${P}tenant-multia`); const multiB = await mkCompany(`${P}multi-b-guid`, "Multi B", `${P}tenant-multib`);
  await link(multi, multiA); await Access.create({ userId: multi._id, companyId: multiB._id, companyGuid: multiB.companyGuid, tenantId: multiB.tenantId });
  const multiBToken = tokenFor(multi, multiB);
  const multiBefore = await http_.get("/api/analytics/sales/summary", A(multiBToken));
  await Access.deleteOne({ userId: multi._id, companyGuid: multiB.companyGuid });
  const multiAfter = await http_.get("/api/analytics/sales/summary", A(multiBToken));
  probe("SEC-AUTHZ-9", "a token scoped to a non-default company stops working when that company's access row is removed", multiBefore.status === 200 && multiAfter.status === 403, `before ${multiBefore.status}, after removal ${multiAfter.status}`);

  // a removed user is stopped BEFORE the upload middleware runs, so nothing is stored on disk
  const revokedFd = new FormData();
  revokedFd.append("file", new Blob([JSON.stringify({ data: { collection: [] } })], { type: "application/json" }), "verify-sec-revoked.json");
  const revokedUp = await http_.post("/api/import/tally-json", revokedFd, A(staleToken));
  const revokedFiles = fs.readdirSync(uploadsDir).filter((f) => !uploadsBefore.has(f) && /verify-sec-revoked/.test(f));
  probe("SEC-AUTHZ-10", "a user whose access was removed cannot upload a file (refused before anything is stored)", revokedUp.status === 403 && revokedFiles.length === 0, `HTTP ${revokedUp.status}, ${revokedFiles.length} file(s) stored`);

  // ==== 3. INPUT TYPES REACHING MONGO FILTERS
  out("\n3. INPUT-TYPE VALIDATION (a value that must be a string must not be an object or an array)");
  // switchCompany and the company-context middleware hand the request's company identifier to Mongo filters.
  // Secure behaviour: anything that is not a plain string is refused with a 4xx and never changes which tenant a
  // session is scoped to. Synthetic companies only.
  const sw = await http_.post("/api/auth/switch-company", { companyGuId: { $in: [attackerCo.companyGuid, victimCo.companyGuid] } }, A(attackerToken));
  const swClaims = sw.data && sw.data.token ? jwt.decode(sw.data.token) : null;
  probe("SEC-INJ-1", "switch-company rejects a non-string companyGuId (object in the JSON body) with a 4xx", sw.status >= 400 && sw.status < 500, `HTTP ${sw.status}${swClaims ? " - a session token was issued" : ""}`);
  probe("SEC-INJ-2", "no request shape makes switch-company issue a session for a tenant the user has no access to", !swClaims || swClaims.tenantId === attackerCo.tenantId,
    swClaims ? `the issued session is scoped to tenant ${swClaims.tenantId === victimCo.tenantId ? "of ANOTHER account" : "(own)"}` : "no token issued");

  const dup = await http_.get(`/api/analytics/sales/summary?period=custom&from=2020-01-01&to=2030-01-01&companyGuId=${encodeURIComponent(attackerCo.companyGuid)}&companyGuId=${encodeURIComponent(victimCo.companyGuid)}`, A(attackerToken));
  const dupTotal = dup.data && dup.data.data && dup.data.data.totalSales;
  probe("SEC-INJ-3", "a repeated ?companyGuId= query parameter is refused (4xx) and never scopes the request to another tenant", dup.status >= 400 && dup.status < 500 && !dupTotal, `HTTP ${dup.status}; totalSales seen by the caller: ${dupTotal}`);

  const form = await http_.post("/api/auth/switch-company", `companyGuId[$in][]=${encodeURIComponent(attackerCo.companyGuid)}&companyGuId[$in][]=${encodeURIComponent(victimCo.companyGuid)}`, { headers: { Authorization: `Bearer ${attackerToken}`, "Content-Type": "application/x-www-form-urlencoded" } });
  const formClaims = form.data && form.data.token ? jwt.decode(form.data.token) : null;
  probe("SEC-INJ-4", "the same non-string value sent form-encoded (nested by express.urlencoded extended:true) is also refused", form.status >= 400 && form.status < 500 && !formClaims, `HTTP ${form.status}`);

  const loginObj = await http_.post("/api/auth/login", { email: { $regex: `^${P}victim@` }, password: PW });
  probe("SEC-INJ-5", "login rejects a non-string e-mail (object) with a 4xx instead of using it as a database filter", loginObj.status >= 400 && loginObj.status < 500 && !(loginObj.data && loginObj.data.token), `HTTP ${loginObj.status}${loginObj.data && loginObj.data.token ? " - a session was issued for the account matched by the object" : ""}`);
  const loginNe = await http_.post("/api/auth/login", { email: { $ne: null }, password: "definitely-wrong" });
  probe("SEC-INJ-6", "login answers a non-string e-mail with 400 (input error), not 401 (a credential check that ran a query)", loginNe.status === 400, `HTTP ${loginNe.status}`);

  // ==================================================================== 4. INPUT VALIDATION / ERRORS
  out("\n4. INPUT VALIDATION AND ERROR HANDLING");
  const pwObj = await http_.post("/api/auth/login", { email: `${P}victim@example.test`, password: { a: 1 } });
  probe("SEC-VAL-1", "a non-string password yields a clean 4xx without internal error text", pwObj.status < 500, `HTTP ${pwObj.status}: ${short(pwObj.data.message)}`);
  const nameObj = await http_.patch("/api/auth/company", { companyName: { a: 1 } }, A(attackerToken));
  probe("SEC-VAL-2", "a non-string companyName yields a clean 4xx without internal error text", nameObj.status < 500, `HTTP ${nameObj.status}: ${short(nameObj.data.message)}`);
  const badId = await http_.get("/api/chat/not-an-object-id", A(attackerToken));
  probe("SEC-VAL-3", "an invalid chat id yields a clean 4xx without database/schema details", badId.status < 500 && !/Cast to ObjectId|model/i.test(JSON.stringify(badId.data)), `HTTP ${badId.status}: ${short(badId.data.message)}`);
  const badJson = await http_.post("/api/auth/login", "{not json", { headers: { "Content-Type": "application/json" } });
  probe("SEC-VAL-4", "malformed JSON gets our own plain message (no parser internals such as the offending token or position)", badJson.status === 400 && !/Unexpected|Expected|token|position|SyntaxError/i.test(JSON.stringify(badJson.data)), `HTTP ${badJson.status}: ${short(badJson.data.message)}`);
  const big = await http_.post("/api/auth/login", { email: "a@b.c", password: "x".repeat(300000) });
  probe("SEC-VAL-5", "an oversized request body is refused (413)", big.status === 413, `HTTP ${big.status}`);
  const limits = [];
  for (const q of ["limit=-1", "limit=999", "limit=abc", "period=bogus", "period=custom&from=x&to=y", "period=custom&from=2026-02-01&to=2026-01-01"]) {
    const r = await http_.get(`/api/analytics/sales/top-products?${q}`, A(attackerToken)); if (r.status !== 400) limits.push(`${q} -> ${r.status}`);
  }
  probe("SEC-VAL-6", "analytics query parameters are validated (bad limit / period / dates -> 400)", limits.length === 0, limits.join("; "));
  // (an unknown extra parameter such as comparisonType on /top-products is simply ignored - it is not an input the route takes)
  const cmpBad = [];
  for (const u of ["/api/analytics/sales/comparison", "/api/analytics/sales/growing-products", "/api/analytics/sales/declining-products", "/api/analytics/purchases/comparison"]) {
    const r = await http_.get(`${u}?comparisonType=zzz`, A(attackerToken)); if (r.status !== 400) cmpBad.push(`${u} -> ${r.status}`);
  }
  probe("SEC-VAL-15", "comparisonType is validated on every route that takes it (sales comparison, growing / declining products, purchase comparison -> 400)", cmpBad.length === 0, cmpBad.join("; ") || "all four routes answered 400");
  const arrPeriod = await http_.get("/api/analytics/sales/summary?period[]=custom&period[]=x", A(attackerToken));
  probe("SEC-VAL-7", "array-valued query parameters do not crash the API (no 5xx)", arrPeriod.status < 500, `HTTP ${arrPeriod.status}`);
  const recBody = await http_.post("/api/sync/recovery", { voucherType: { $ne: "x" } }, A(attackerToken));
  const recBad = await http_.post("/api/sync/recovery", { voucherType: "Sales", apply: "yes" }, A(attackerToken));
  probe("SEC-VAL-8", "recovery rejects an operator object / non-boolean apply (400)", recBody.status === 400 && recBad.status === 400, `voucherType-object -> ${recBody.status}, apply:"yes" -> ${recBad.status}`);

  // ---- manual live import: date-range abuse (the stub records what would be sent to Tally)
  selected = attackerCo.companyGuid; OPEN.push({ name: "Attacker Co", guid: attackerCo.companyGuid });
  clearVoucherTypeClassificationCache();
  const wide = await http_.post("/api/import/tally-live?fromDate=1990-01-01&toDate=2026-01-01", null, A(attackerToken));
  const sentBody = JSON.stringify(lastVoucherQuery || {});
  const rangeForwarded = /1990/.test(sentBody) || /1-Jan-1990|19900101/.test(sentBody);
  probe("SEC-VAL-9", "a 36-year date range on the live import is capped/refused before it is sent to the customer's Tally", !rangeForwarded, `HTTP ${wide.status}; the full range was forwarded to Tally (a 10-year range is known to hang Tally)`);
  lastVoucherQuery = null;
  const ok92 = await http_.post("/api/import/tally-live?fromDate=2026-01-01&toDate=2026-04-02", null, A(attackerToken)); // exactly 92 days
  const sent92 = lastVoucherQuery !== null;
  lastVoucherQuery = null;
  const over93 = await http_.post("/api/import/tally-live?fromDate=2026-01-01&toDate=2026-04-03", null, A(attackerToken)); // 93 days
  const reversed = await http_.post("/api/import/tally-live?fromDate=2026-02-01&toDate=2026-01-01", null, A(attackerToken));
  const twoDates = await http_.post("/api/import/tally-live?fromDate=2026-01-01&fromDate=1990-01-01&toDate=2026-01-02", null, A(attackerToken));
  probe("SEC-VAL-14", "a range of up to 92 days is accepted and forwarded; 93 days, a reversed range and a repeated date parameter are refused (400) before Tally is asked",
    sent92 && over93.status === 400 && reversed.status === 400 && twoDates.status === 400 && lastVoucherQuery === null,
    `92 days -> forwarded: ${sent92} (HTTP ${ok92.status}); 93 days -> ${over93.status}; reversed -> ${reversed.status}; repeated parameter -> ${twoDates.status}; range sent to Tally afterwards: ${lastVoucherQuery !== null}`);
  OPEN.pop();

  // ---- file upload
  const fd = new FormData();
  fd.append("file", new Blob([JSON.stringify({ data: { collection: [] } })], { type: "application/json" }), "../../verify-sec-traversal.json");
  const up = await http_.post("/api/import/tally-json", fd, A(attackerToken));
  const created = fs.readdirSync(uploadsDir).filter((f) => !uploadsBefore.has(f) && /verify-sec/.test(f));
  probe("SEC-VAL-10", "an upload filename containing ../ cannot escape the uploads directory", created.length <= 1 && !fs.existsSync(path.join(__dirname, "..", "verify-sec-traversal.json")), `stored as: ${created.join(",") || "(none)"} (HTTP ${up.status})`);
  probe("SEC-LIFE-1", "an uploaded business file is deleted after it has been processed (no indefinite retention on disk)", created.length === 0, `${created.length} file(s) remain in uploads/ after the request; the directory already holds ${uploadsBefore.size} older customer files`);
  const brokenFd = new FormData();
  brokenFd.append("file", new Blob(["{ this is not json"], { type: "application/json" }), "verify-sec-broken.json");
  const brokenUp = await http_.post("/api/import/tally-json", brokenFd, A(attackerToken));
  const brokenLeft = fs.readdirSync(uploadsDir).filter((f) => /verify-sec-broken/.test(f));
  probe("SEC-LIFE-2", "an upload that FAILS processing is also deleted from disk", brokenLeft.length === 0 && brokenUp.status >= 400, `HTTP ${brokenUp.status}: ${short(brokenUp.data.message)}; ${brokenLeft.length} file(s) left`);
  const bigFd = new FormData();
  bigFd.append("file", new Blob(["x".repeat(11 * 1024 * 1024)], { type: "application/json" }), "verify-sec-big.json");
  const bigUp = await http_.post("/api/import/tally-json", bigFd, A(attackerToken));
  const bigLeft = fs.readdirSync(uploadsDir).filter((f) => /verify-sec-big/.test(f));
  probe("SEC-VAL-13", "an over-size upload (11 MB) is refused with 413 and a plain message, and nothing is left on disk", bigUp.status === 413 && !/Multer|LIMIT_|field/i.test(JSON.stringify(bigUp.data)) && bigLeft.length === 0, `HTTP ${bigUp.status}: ${short(bigUp.data.message)}; ${bigLeft.length} file(s) left`);
  const nonJson = new FormData(); nonJson.append("file", new Blob(["x"], { type: "text/plain" }), "evil.exe");
  const upBad = await http_.post("/api/import/tally-json", nonJson, A(attackerToken));
  probe("SEC-VAL-11", "a non-JSON upload is refused with a client error", upBad.status >= 400 && upBad.status < 500, `HTTP ${upBad.status}: ${short(upBad.data.message)}`);

  // ==================================================================== 5. HTTP HARDENING
  out("\n5. HTTP / CORS / ABUSE");
  const cr = await http_.get("/api/auth/companies", { headers: { Origin: "https://evil.example", Authorization: `Bearer ${attackerToken}` } });
  probe("SEC-HTTP-1", "CORS only allows the application's own origin(s)", cr.headers["access-control-allow-origin"] !== "*", `Access-Control-Allow-Origin: ${cr.headers["access-control-allow-origin"]}`);
  const hd = (await http_.get("/api/auth/companies", A(attackerToken))).headers;
  const missing = ["strict-transport-security", "x-content-type-options", "x-frame-options", "content-security-policy"].filter((k) => !hd[k]);
  const boom = express();
  boom.use(require("./src/middleware/requestId"));
  boom.get("/boom", () => { throw new Error('Cast to ObjectId failed for value "x" (type string) at path "_id" for model "Chat"'); });
  boom.use(require("./src/middleware/errorHandler").errorHandler);
  const boomSrv = await new Promise((resolve) => { const sv = boom.listen(0, "127.0.0.1", () => resolve(sv)); });
  const boomRes = await axios.get(`http://127.0.0.1:${boomSrv.address().port}/boom`, { validateStatus: () => true });
  boomSrv.close();
  probe("SEC-VAL-12", "an unexpected internal error is answered with a generic 500 (no library / model text, no stack)", boomRes.status === 500 && !/Cast|model|Chat|\bat \w/.test(JSON.stringify(boomRes.data)), `HTTP ${boomRes.status}: ${short(boomRes.data.message)}`);
  const idAny = await http_.get("/api/auth/companies", A(attackerToken));
  const idEcho = await http_.get("/api/auth/companies", { headers: { Authorization: `Bearer ${attackerToken}`, "X-Request-Id": "audit-trace-12345678" } });
  const idUnsafe = await http_.get("/api/auth/companies", { headers: { Authorization: `Bearer ${attackerToken}`, "X-Request-Id": "bad id with spaces <x>" } });
  probe("SEC-LOG-1", "every response carries X-Request-Id; a plain client id is echoed, an unsafe one is replaced; server errors repeat the id in the body",
    !!idAny.headers["x-request-id"] && idEcho.headers["x-request-id"] === "audit-trace-12345678" && idUnsafe.headers["x-request-id"] !== "bad id with spaces <x>" && !!boomRes.data.requestId && boomRes.data.requestId === boomRes.headers["x-request-id"],
    `generated: ${idAny.headers["x-request-id"]}; echoed: ${idEcho.headers["x-request-id"]}; unsafe replaced by: ${idUnsafe.headers["x-request-id"]}; 500 body requestId present: ${!!boomRes.data.requestId}`);
  probe("SEC-HTTP-2", "standard security headers are set by the application (helmet-style)", missing.length === 0, `missing: ${missing.join(", ")}; x-powered-by: ${hd["x-powered-by"]}`);
  resetAllRateLimiters();
  const ownOrigin = await http_.get("/api/auth/companies", { headers: { Origin: "http://localhost:5173", Authorization: `Bearer ${attackerToken}` } });
  probe("SEC-HTTP-3", "the application's own frontend origin is still allowed (allow-list works) and X-Powered-By is not sent", ownOrigin.headers["access-control-allow-origin"] === "http://localhost:5173" && !hd["x-powered-by"] && cr.status === 200,
    `Access-Control-Allow-Origin for http://localhost:5173: ${ownOrigin.headers["access-control-allow-origin"]}; x-powered-by: ${hd["x-powered-by"]}`);
  let okLogins = 0;
  for (let i = 0; i < 15; i++) { const r = await http_.post("/api/auth/login", { email: `${P}victim@example.test`, password: PW }); if (r.status === 200) okLogins += 1; }
  probe("SEC-ABUSE-2", "successful logins do not use up the failed-attempt budget (15 correct logins in a row all succeed)", okLogins === 15, `${okLogins} of 15 succeeded`);
  const warnLines = []; const silentWarn = console.warn; console.warn = (...a) => { warnLines.push(a.join(" ")); };
  let limited = 0; let n = 0; let retryAfter = null;
  const t0 = Date.now();
  for (let i = 0; i < 25; i++) { const r = await http_.post("/api/auth/login", { email: `${P}victim@example.test`, password: `wrong-${i}` }); n += 1; if (r.status === 429) { limited += 1; retryAfter = retryAfter || r.headers["retry-after"]; } }
  probe("SEC-ABUSE-1", "repeated wrong-password logins for one account are throttled (429, with a Retry-After header)", limited > 0 && !!retryAfter, `${n} consecutive wrong passwords in ${Date.now() - t0} ms, ${limited} throttled, Retry-After: ${retryAfter}`);
  console.warn = silentWarn;
  const rlLines = warnLines.filter((l) => l.includes("[rateLimit]")); const flLines = warnLines.filter((l) => l.includes("[auth] failed login"));
  probe("SEC-LOG-2", "security events are logged with a request id (one rate-limit line per window, one line per failed login) and no line contains the e-mail address or the password tried",
    rlLines.length >= 1 && rlLines.length <= 2 && flLines.length > 0 && flLines.every((l) => /request=[0-9a-f-]{36}/.test(l)) && warnLines.every((l) => !l.includes(`${P}victim@example.test`) && !l.includes("wrong-")),
    `${rlLines.length} rate-limit line(s), ${flLines.length} failed-login line(s); sample: ${short(flLines[0] || "")}`);
  const otherOk = await http_.post("/api/auth/login", { email: `${P}attacker@example.test`, password: PW });
  probe("SEC-ABUSE-3", "throttling one account does not lock other accounts out (per account + client, not global)", otherOk.status === 200, `another account logged in with HTTP ${otherOk.status} while the first was throttled`);
  resetAllRateLimiters();
  let regLimited = 0;
  for (let i = 0; i < 25; i++) { const r = await http_.post("/api/auth/register", { name: "flood", email: `${P}flood${i}@example.test`, password: "Flood!Pass123" }); if (r.status === 429) regLimited += 1; }
  probe("SEC-ABUSE-4", "a flood of account creations from one client is throttled (429)", regLimited > 0, `25 registrations, ${regLimited} throttled`);
  resetAllRateLimiters();

  // ==================================================================== 6. TALLY COMPANY ISOLATION - three companies open
  out("\n6. TALLY ISOLATION - Nirmal, WE FOUR and Intelli-Cart all open; Nirmal selected");
  const mkTenant = async (guid, name) => { const c = await mkCompany(guid, name, `${P}tenant-${name.toLowerCase().replace(/\W/g, "")}`); return { c, company: { tenantId: c.tenantId, companyGuid: guid, tallyConnection: { baseUrl: stub.url } } }; };
  const T = { NIR: await mkTenant(NIR, "Nirmal"), WF: await mkTenant(WF, "WeFour"), IC: await mkTenant(IC, "IntelliCart") };
  selected = NIR; rowsFor = null; clearVoucherTypeClassificationCache();
  const guardResults = {};
  for (const [k, g] of Object.entries({ NIR, WF, IC })) guardResults[k] = (await verifyOpenTallyCompany(g)).ok;
  out(`  [INFO]       SEC-TALLY-0 the open-company guard alone passes for all three tenants while only Nirmal is selected (${JSON.stringify(guardResults)}) - so it cannot be the isolation control; the ownership guard is`);

  // /api/odbc/sales returns raw vouchers of the company Tally has SELECTED: only that company's owner may read it
  const nirUser = await mkUser("nirowner"); await link(nirUser, T.NIR.c);
  const wfUser = await mkUser("wfowner"); await link(wfUser, T.WF.c);
  const salesWf = await http_.get("/api/odbc/sales", A(tokenFor(wfUser, T.WF.c)));
  const salesNir = await http_.get("/api/odbc/sales", A(tokenFor(nirUser, T.NIR.c)));
  const noCompanyTok = await http_.get("/api/odbc/sales", A(jwt.sign({ id: String(nirUser._id) }, SECRET, { expiresIn: "1h" })));
  probe("SEC-AUTH-11", "/api/odbc/sales refuses a signed-in user whose company is NOT the one Tally has selected (403, no vouchers)", salesWf.status === 403 && !JSON.stringify(salesWf.data).includes("Audit Customer"), `WE FOUR user while Nirmal is selected -> ${salesWf.status}`);
  probe("SEC-AUTH-12", "/api/odbc/sales still works for the owner of the selected company, and refuses a company-less token", salesNir.status === 200 && noCompanyTok.status === 401, `Nirmal owner -> ${salesNir.status}, company-less token -> ${noCompanyTok.status}`);

  const idOf = (i) => (0x3d6 + i).toString(16).padStart(8, "0");
  const raw = (co, i) => ({ vouchernumber: `SEC-${i}`, date: "20260905", partyname: "Audit Vendor", vouchertypename: "Purchase", guid: `${co}-${idOf(i)}`, alterid: String(100 + i),
    ledgerentries: [{ ledgername: "Purchase AC", amount: "100.00", isdeemedpositive: true }, { ledgername: "Audit Vendor", amount: "-100.00", isdeemedpositive: false }] });
  const rowsOf = (co, ids) => ids.map((i) => ({ guid: `${co}-${idOf(i)}`, alterid: String(100 + i), vouchertypename: "Purchase" }));
  const syncMod = (fetchCompany) => ({ voucherType: "Purchase", classificationKey: "purchase",
    fetchPendingAlterIds: async () => ({ data: { collection: rowsOf(fetchCompany, [1, 2, 3]) } }),
    fetchVouchersSinceAlterId: async () => ({ data: { collection: [1, 2, 3].map((i) => raw(fetchCompany, i)) } }),
    processVoucher: processSinglePurchaseVoucher });
  const setCk = (t, g) => SyncCheckpoint.findOneAndUpdate({ tenantId: t.company.tenantId, companyGuid: g, voucherType: "Purchase" }, { $set: { lastAlterId: 50, lastRunStatus: "success", isRunning: false, lockedAt: null } }, { upsert: true });
  const docs = (t) => Purchase.countDocuments({ tenantId: t.company.tenantId });
  const ck = async (t, g) => (await SyncCheckpoint.findOne({ tenantId: t.company.tenantId, companyGuid: g, voucherType: "Purchase" }).lean()).lastAlterId;

  // direction 1: Nirmal selected, WE FOUR / Intelli-Cart tenants are handed Nirmal's vouchers
  for (const k of ["NIR", "WF", "IC"]) await setCk(T[k], { NIR, WF, IC }[k]);
  const g1 = { NIR, WF, IC };
  const r = {};
  for (const k of ["NIR", "WF", "IC"]) { clearVoucherTypeClassificationCache(); r[k] = await runSyncForCompanyModule(T[k].company, syncMod(NIR), { intervalSeconds: 60, batchSize: 100 }); }
  probe("SEC-TALLY-1", "sync: the selected company (Nirmal) receives its own vouchers (control)", r.NIR.created === 3 && (await docs(T.NIR)) === 3, short(r.NIR));
  probe("SEC-TALLY-2", "sync: WE FOUR and Intelli-Cart tenants refuse Nirmal's vouchers - 0 writes, checkpoint unchanged",
    (await docs(T.WF)) === 0 && (await docs(T.IC)) === 0 && (await ck(T.WF, WF)) === 50 && (await ck(T.IC, IC)) === 50, `WF docs=${await docs(T.WF)} ckpt=${await ck(T.WF, WF)}; IC docs=${await docs(T.IC)} ckpt=${await ck(T.IC, IC)}`);

  // the voucher guard itself (masters pre-cached while the tenant's own company was selected, then selection moves)
  clearVoucherTypeClassificationCache();
  for (const k of ["WF", "IC"]) { selected = g1[k]; await resolveVoucherTypeClassification({ companyGuid: g1[k] }); }
  selected = NIR;
  const rc = {};
  for (const k of ["WF", "IC"]) rc[k] = await runSyncForCompanyModule(T[k].company, syncMod(NIR), { intervalSeconds: 60, batchSize: 100 });
  probe("SEC-TALLY-3", "sync (masters cached earlier, selection then moves to Nirmal): the VOUCHER ownership check refuses the batch", rc.WF.companyMismatch === true && rc.IC.companyMismatch === true && (await docs(T.WF)) === 0 && (await docs(T.IC)) === 0, short(rc));

  // recovery
  const recDeps = (rows) => ({ fetchRegistry: async () => ({ data: { collection: rows } }), fetchByAlterIds: async () => ({ data: { collection: [1, 2, 3].map((i) => raw(NIR, i)) } }) });
  selected = WF; clearVoucherTypeClassificationCache(); await resolveVoucherTypeClassification({ companyGuid: WF });
  const rec = await recoverMissingVouchers({ company: T.WF.company, voucherType: "Purchase", apply: true, deps: recDeps(rowsOf(NIR, [1, 2, 3])) });
  probe("SEC-TALLY-4", "recovery: Nirmal's vouchers never become 'missing' for WE FOUR and are never imported", rec.status === "aborted" && (await docs(T.WF)) === 0, `status ${rec.status} ${rec.reasonCode}`);
  const recSelf = await recoverMissingVouchers({ company: T.WF.company, voucherType: "Purchase", apply: true, deps: recDeps(rowsOf(WF, [1, 2, 3])) });
  probe("SEC-TALLY-5", "recovery: a clean registry whose fetched batch is contaminated is rejected, 0 written", recSelf.batches.failed === 1 && (await docs(T.WF)) === 0, `batches ${JSON.stringify(recSelf.batches)}`);
  const ckAfterRec = await ck(T.WF, WF);
  probe("SEC-TALLY-6", "recovery never touches SyncCheckpoint", ckAfterRec === 50, `WE FOUR checkpoint ${ckAfterRec}`);

  // reconciliation
  for (const i of [1, 2, 3, 4]) await processSinglePurchaseVoucher(raw(IC, i), T.IC.company.tenantId);
  selected = IC; clearVoucherTypeClassificationCache(); await resolveVoucherTypeClassification({ companyGuid: IC });
  const recon = await runReconciliationForCompanyModule(T.IC.company, { voucherType: "Purchase", classificationKey: "purchase", Model: Purchase, fetchAllGuidsBase: async () => ({ data: { collection: [1, 2, 3, 4].map((i) => ({ guid: `${NIR}-${idOf(i)}` })) } }) });
  probe("SEC-TALLY-7", "reconciliation: a wrong-company GUID list is aborted_unsafe - nothing is marked deleted", recon.status === "aborted_unsafe" && (await Purchase.countDocuments({ tenantId: T.IC.company.tenantId, voucherStatus: "active" })) === 4, short(recon));
  const rcRow = await ReconCheckpoint.findOne({ tenantId: T.IC.company.tenantId, voucherType: "Purchase" }).lean();
  probe("SEC-TALLY-8", "reconciliation: the wrong-company response is recorded as aborted_unsafe with the mismatch reason", rcRow && rcRow.lastRunStatus === "aborted_unsafe" && /Company mismatch/.test(rcRow.lastError || ""), rcRow && rcRow.lastRunStatus);

  // manual import
  selected = NIR; clearVoucherTypeClassificationCache();
  let mi1 = null; try { await importTallySalesFromTally({ companyGuId: WF }); } catch (e) { mi1 = e.message; }
  probe("SEC-TALLY-9", "manual import: WE FOUR importing while Nirmal is selected is refused (masters mismatch), 0 sales written", !!mi1 && /Company mismatch/.test(mi1) && (await Sale.countDocuments({ tenantId: T.WF.company.tenantId })) === 0, short(mi1));
  selected = WF; flipAfterMasters = NIR; clearVoucherTypeClassificationCache(); // TOCTOU: masters answered for WE FOUR, vouchers then for Nirmal
  let mi2 = null; try { await importTallySalesFromTally({ companyGuId: WF }); } catch (e) { mi2 = e.message; }
  probe("SEC-TALLY-10", "manual import TOCTOU: masters answered for WE FOUR, then the selection moves - the voucher check still refuses, 0 sales written", !!mi2 && /Company mismatch/.test(mi2) && (await Sale.countDocuments({ tenantId: T.WF.company.tenantId })) === 0, short(mi2));

  // reverse direction (do not assume it is safe)
  selected = WF; rowsFor = null; clearVoucherTypeClassificationCache();
  await setCk(T.NIR, NIR); await Purchase.deleteMany({ tenantId: T.NIR.company.tenantId });
  const rev = await runSyncForCompanyModule(T.NIR.company, syncMod(WF), { intervalSeconds: 60, batchSize: 100 });
  probe("SEC-TALLY-11", "REVERSE direction: WE FOUR selected, Nirmal's tenant is refused (0 writes, checkpoint unchanged)", (await docs(T.NIR)) === 0 && (await ck(T.NIR, NIR)) === 50, short(rev));

  // master-data cache isolation
  clearVoucherTypeClassificationCache(); selected = NIR;
  const cNir = await resolveVoucherTypeClassification({ companyGuid: NIR });
  const cWfWhileNir = await resolveVoucherTypeClassification({ companyGuid: WF });
  selected = WF;
  const cWf = await resolveVoucherTypeClassification({ companyGuid: WF });
  const cNirAgain = await resolveVoucherTypeClassification({ companyGuid: NIR });
  probe("SEC-MASTER-1", "voucher-type masters for the non-selected company are refused and NOT cached; each company's cache entry stays its own",
    cNir.sales.status === "ok" && cWfWhileNir.sales.status === "error" && cWf.sales.status === "ok" && cWf.source === "live" && cNirAgain.source === "cache", `NIR ${cNir.sales.status}, WF-while-NIR ${cWfWhileNir.sales.status}, WF-after-select ${cWf.source}, NIR-again ${cNirAgain.source}`);
  const noKey = await resolveVoucherTypeClassification({});
  probe("SEC-MASTER-2", "there is no shared 'default' cache key: a request without a company GUID is refused", noKey.sales.status === "error", noKey.sales.reason);

  // concurrent workers, same tenant
  selected = NIR; rowsFor = null; clearVoucherTypeClassificationCache(); await setCk(T.NIR, NIR); await Purchase.deleteMany({ tenantId: T.NIR.company.tenantId });
  const two = await Promise.all([runSyncForCompanyModule(T.NIR.company, syncMod(NIR), { intervalSeconds: 60, batchSize: 100 }), runSyncForCompanyModule(T.NIR.company, syncMod(NIR), { intervalSeconds: 60, batchSize: 100 })]);
  probe("SEC-WORKER-1", "two workers started at the same instant for one tenant: only one runs (Mongo lock), no duplicate documents", two.filter((x) => x.skipped).length === 1 && (await docs(T.NIR)) === 3, `skipped=${two.filter((x) => x.skipped).length}, docs=${await docs(T.NIR)}`);

  // ==================================================================== 7. TALLY DESTINATION, CONFIGURATION, DEPENDENCIES
  out("\n7. TALLY DESTINATION, REPOSITORY CONFIGURATION, DEPENDENCIES");
  const { isSafeTallyUrl } = require("./src/services/odbc/tallyUrl");
  const okUrls = ["http://localhost:9000", "http://127.0.0.1:9000", "http://192.168.1.20:9000", "https://tally.example.com:9443"];
  const badUrls = ["http://169.254.169.254/latest/meta-data", "http://[fe80::1]:9000", "http://[::ffff:169.254.169.254]/", "http://metadata.google.internal/", "file:///etc/passwd", "gopher://localhost:70", "http://user:pass@localhost:9000", "not a url"];
  probe("SEC-TALLY-12", "a Tally address must be http(s) without credentials and not link-local / metadata (localhost and LAN addresses stay allowed)",
    okUrls.every(isSafeTallyUrl) && badUrls.every((u) => !isSafeTallyUrl(u)), `wrongly refused: [${okUrls.filter((u) => !isSafeTallyUrl(u))}]; wrongly allowed: [${badUrls.filter(isSafeTallyUrl)}]`);
  const { getCompanyInfo } = require("./src/services/odbc/odbcService");
  let refusedAtUse = false; try { await getCompanyInfo({ baseUrl: "http://169.254.169.254/" }); } catch (e) { refusedAtUse = /Invalid Tally connection URL|not allowed/i.test(e.message); }
  let refusedAtSave = false; try { await Company.create({ companyName: "Bad URL Co", companyGuid: `${P}badurl-guid`, tenantId: `${P}badurl-tenant`, tallyConnection: { baseUrl: "http://169.254.169.254/" } }); } catch (e) { refusedAtSave = e.name === "ValidationError"; }
  probe("SEC-TALLY-13", "an unsafe tallyConnection.baseUrl is refused when a company is saved AND again at the moment a Tally request would be made (fails closed)", refusedAtUse && refusedAtSave, `refused at use: ${refusedAtUse}; refused at save: ${refusedAtSave}`);

  const { execFileSync } = require("child_process");
  const repoRoot = path.join(__dirname, "..");
  const isIgnored = (f) => { try { execFileSync("git", ["check-ignore", "-q", f], { cwd: repoRoot }); return true; } catch (_) { return false; } };
  const mustIgnore = [".env", "backend/.env", "frontend/.env", "frontend/.env.production", "backend/.env.staging", "backend/uploads/x.json"];
  const notIgnored = mustIgnore.filter((f) => !isIgnored(f));
  probe("SEC-CONF-1", "a real .env (repository root, backend/, frontend/, any .env.<name>) and uploaded files are git-ignored; .env.example stays committable", notIgnored.length === 0 && !isIgnored(".env.example") && !isIgnored("backend/.env.example"), notIgnored.length ? `not ignored: ${notIgnored.join(", ")}` : "all ignored");
  const pkgJson = require("./package.json");
  const stillThere = ["bcrypt", "joi", "winston", "odbc"].filter((n) => (pkgJson.dependencies || {})[n] || fs.existsSync(path.join(__dirname, "node_modules", n)));
  probe("SEC-DEP-1", "the unused packages bcrypt, joi, winston and odbc are no longer declared or installed", stillThere.length === 0, stillThere.length ? `still present: ${stillThere.join(", ")}` : "none of the four remain");

  // ==================================================================== SUMMARY
  console.log = out;
  out(`\nRESULT: ${secure} secure, ${vulnerable} vulnerable`);
  if (vulnerable) out(`Findings: ${findings.join(", ")}`);

  await cleanup();
  const left = (await User.countDocuments({ email: emailRx })) + (await Company.countDocuments({ companyGuid: guidRx })) + (await Sale.countDocuments({ tenantId: guidRx })) + (await Purchase.countDocuments({ tenantId: guidRx })) + (await Chat.countDocuments({ tenantId: guidRx })) + (await SyncCheckpoint.countDocuments({ tenantId: guidRx }));
  const leftFiles = fs.readdirSync(uploadsDir).filter((f) => /verify-sec/.test(f)).length;
  out(`Cleanup: ${left} synthetic documents and ${leftFiles} uploaded test files left behind.`);
  api.s.close(); stub.server.close(); await mongoose.disconnect();
  process.exit(STRICT && vulnerable ? 1 : 0);
}

main().catch(async (error) => {
  console.log = out;
  out("CRASH:", error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
