/**
 * Company registration WITHOUT a manual Tally GUID, and company identity
 * (authController.js "Connect Tally" + companyIdentity.js + tallyCompanyGuard.js).
 *
 * Product flow under test:
 *   register (name/email/password) -> login -> Connect Tally -> the backend
 *   detects the company open in Tally and uses ITS GUID internally.
 *
 * Also: the same GUID keeps the same tenant (reactivation / orphan reuse, sync
 * checkpoints preserved), and knowing or being able to open a company never
 * grants access to another account's company.
 *
 * Offline: a local stub plays TallyPrime (TALLY_URL points at it); MongoDB is
 * real under synthetic GUIDs/emails cleaned up at start, end and on crash.
 * No live Tally.
 *
 * Run: node verify-company-identity.js
 */

require("dotenv").config();
const http = require("http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// The stub must exist BEFORE odbcService is first required (it reads TALLY_URL
// at load time), so everything Tally-facing is required lazily in main().
let openCompanies = []; // [{name, guid}] the stub reports as open
let stubDown = false;
const seenBodies = [];

function startStub() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (stubDown) return req.socket.destroy();
      seenBodies.push({ id: req.headers.id, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.headers.id === "RTS VoucherType Master Collection") {
        res.end(JSON.stringify({
          status: "1",
          data: { collection: [
            { metadata: { name: "Sales", reservedname: "Sales" }, parent: { value: "Sales" } },
            { metadata: { name: "Purchase", reservedname: "Purchase" }, parent: { value: "Purchase" } },
          ] },
        }));
      } else if (req.headers.id === "RTS Company Guid Collection") {
        res.end(JSON.stringify({
          status: "1",
          data: { collection: openCompanies.map((c) => ({ name: { value: c.name }, guid: { value: c.guid } })) },
        }));
      } else {
        res.end(JSON.stringify({ status: "1", data: { collection: [] } }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

const PREFIX = "verify-ident-";
const GUID = (n) => `${PREFIX}guid-${n}`;
const EMAIL = (n) => `${PREFIX}${n}@example.test`;
const PW = "pw-123456";

let pass = 0;
let fail = 0;
function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${detail})` : ""}`);
  }
}

function fakeRes() {
  return {
    code: 200,
    body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function main() {
  const stub = await startStub();
  process.env.TALLY_URL = stub.url;

  const connectDB = require("./src/config/db");
  const Company = require("./src/models/company");
  const User = require("./src/models/user.model");
  const UserCompanyAccess = require("./src/models/userCompanyAccess.model");
  const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
  const ReconciliationCheckpoint = require("./src/models/reconciliationCheckpoint.model");
  const { ensureCompanyForGuid } = require("./src/services/auth/companyIdentity");
  const { detectOpenTallyCompany } = require("./src/services/auth/tallyCompanyGuard");
  const { resolveAuthorizedCompany } = require("./src/services/auth/companyContext");
  const { runSyncForCompanyModule } = require("./src/services/sync/tallySyncWorker");
  const { clearVoucherTypeClassificationCache } = require("./src/services/tally/voucherTypeClassifier");
  const { register, login, addCompany, listCompanies, switchCompany } = require("./src/controllers/authController");

  const guidRx = new RegExp(`^${PREFIX}`);

  async function cleanup() {
    await Company.deleteMany({ companyGuid: guidRx });
    await User.deleteMany({ email: guidRx });
    await UserCompanyAccess.deleteMany({ companyGuid: guidRx });
    await SyncCheckpoint.deleteMany({ companyGuid: guidRx });
    await ReconciliationCheckpoint.deleteMany({ companyGuid: guidRx });
  }

  // ---- controller helpers ----
  const open = (...companies) => { openCompanies = companies; };
  async function signUp(n) {
    const res = fakeRes();
    await register({ body: { name: `User ${n}`, email: EMAIL(n), password: PW } }, res);
    return { res, user: await User.findOne({ email: EMAIL(n) }) };
  }
  async function connect(user, body = {}) {
    const res = fakeRes();
    await addCompany({ user: { id: String(user._id) }, body }, res);
    return res;
  }
  const claimsOf = (token) => jwt.decode(token);
  const accessCount = (userId, guid) => UserCompanyAccess.countDocuments({ userId, companyGuid: guid });
  const companyCount = (guid) => Company.countDocuments({ companyGuid: guid });

  await connectDB();
  await cleanup();
  clearVoucherTypeClassificationCache(GUID("wefour"));

  try {
    // ======================================================== A. registration
    console.log("\nA. Registration asks for name + email + password only");
    let u1;
    {
      const { res, user } = await signUp("owner");
      u1 = user;
      check("registers with just name, email, password (201)", res.code === 201, JSON.stringify(res.body));
      check("no company, tenant or GUID exists yet", user && !user.companyGuId && !user.tenantId && !user.companyId);
      check("no Company record was created", (await Company.countDocuments({ companyGuid: guidRx })) === 0);

      const legacy = fakeRes();
      await register({ body: { name: "L", email: EMAIL("legacy"), password: PW, companyName: "Ignored Co", companyGuId: GUID("legacy-ignored") } }, legacy);
      check("a client that still sends companyName/companyGuId does not create a company from them", legacy.code === 201 && (await companyCount(GUID("legacy-ignored"))) === 0);

      const missing = fakeRes();
      await register({ body: { name: "M", email: EMAIL("missing") } }, missing);
      check("password is required (400)", missing.code === 400);

      const dup = fakeRes();
      await register({ body: { name: "D", email: EMAIL("owner"), password: PW } }, dup);
      check("duplicate email rejected (400)", dup.code === 400 && /already registered/i.test(dup.body.message));
    }

    console.log("\nB. Login is email + password; a new account has no company yet");
    {
      const res = fakeRes();
      await login({ body: { email: EMAIL("owner"), password: PW } }, res);
      const claims = claimsOf(res.body.token);
      check("login succeeds without any GUID", res.code === 200 && res.body.success === true);
      check("token identifies the account but has no company", claims.id === String(u1._id) && !claims.companyGuId && !claims.tenantId && res.body.hasCompany === false);

      let rejected = null;
      try { await resolveAuthorizedCompany(claims); } catch (e) { rejected = e; }
      check("a company-less token cannot open company data (401)", rejected && rejected.status === 401);

      const bad = fakeRes();
      await login({ body: { email: EMAIL("owner"), password: "nope" } }, bad);
      check("wrong password -> 401", bad.code === 401);
      const unknown = fakeRes();
      await login({ body: { email: EMAIL("nobody"), password: PW } }, unknown);
      check("unknown email -> 401", unknown.code === 401);
    }

    // ================================================== C. Tally detection
    console.log("\nC. Connect Tally: friendly failures, and nothing is created");
    {
      open();
      let res = await connect(u1);
      check("no company open -> asks the user to open one (400)", res.code === 400 && res.body.message === "Please open your company in TallyPrime and try again.", `${res.code} ${res.body && res.body.message}`);

      stubDown = true;
      res = await connect(u1);
      stubDown = false;
      check("TallyPrime unreachable -> 503 with a clear message", res.code === 503 && /unreachable/i.test(res.body.message), `${res.code} ${res.body && res.body.message}`);

      open({ name: "A", guid: GUID("multi-a") }, { name: "B", guid: GUID("multi-b") });
      res = await connect(u1);
      check("two companies open -> refuses to guess (409)", res.code === 409 && /more than one/i.test(res.body.message));

      const direct = await detectOpenTallyCompany();
      check("detection reports the ambiguity itself", direct.ok === false && direct.reason === "multiple_open");
      check("none of those attempts created a company or a link", (await Company.countDocuments({ companyGuid: guidRx })) === 0 && (await UserCompanyAccess.countDocuments({ userId: u1._id })) === 0);
    }

    console.log("\nD. Connect Tally detects the company - the user types nothing");
    {
      open({ name: "We Four", guid: GUID("wefour") });
      const res = await connect(u1); // empty body: no name, no GUID
      const company = await Company.findOne({ companyGuid: GUID("wefour") }).lean();
      check("connected (201) with an empty request body", res.code === 201 && res.body.success === true, JSON.stringify(res.body));
      check("company created from what Tally reported (name + internal GUID)", company && company.companyName === "We Four" && company.isActive === true);
      check("response shows the company name and no tenant id", res.body.data.companyName === "We Four" && !("tenantId" in res.body.data) && !("tenantId" in res.body));
      const claims = claimsOf(res.body.token);
      check("returned session is scoped to the connected company", claims.companyGuId === GUID("wefour") && claims.tenantId === company.tenantId);
      const refreshed = await User.findById(u1._id).lean();
      check("first company became the account's default", refreshed.companyGuId === GUID("wefour") && refreshed.tenantId === company.tenantId);
      check("account can now use the company context", (await resolveAuthorizedCompany(claims)).tenantId === company.tenantId);

      const again = fakeRes();
      await login({ body: { email: EMAIL("owner"), password: PW } }, again);
      check("next login opens straight on that company", again.body.hasCompany === true && claimsOf(again.body.token).companyGuId === GUID("wefour"));

      const asserted = await connect(u1, { password: PW, companyGuId: GUID("something-else") });
      check("a client-supplied GUID is only an assertion: a different one is rejected (400)", asserted.code === 400 && /does not match/i.test(asserted.body.message));
    }

    // ============================================================ E. security
    console.log("\nE. Security: another account cannot take this company");
    {
      const { user: u2 } = await signUp("stranger");
      open({ name: "We Four", guid: GUID("wefour") });
      const before = await Company.findOne({ companyGuid: GUID("wefour") }).lean();

      let res = await connect(u2);
      check("a stranger connecting while that company is open -> 403", res.code === 403 && /don't have access/i.test(res.body.message), `${res.code} ${res.body && res.body.message}`);
      check("no access link, no default company was granted", (await accessCount(u2._id, GUID("wefour"))) === 0 && !(await User.findById(u2._id).lean()).companyGuId);

      res = await connect(u2, { companyGuId: GUID("wefour") });
      check("knowing the GUID does not help (still 403)", res.code === 403);

      const sw = fakeRes();
      await switchCompany({ user: { id: String(u2._id) }, body: { companyGuId: GUID("wefour") } }, sw);
      check("switching to it is refused (403)", sw.code === 403);

      const list = fakeRes();
      await listCompanies({ user: { id: String(u2._id) } }, list);
      check("the stranger sees no companies", list.body.data.length === 0);
      const after = await Company.findOne({ companyGuid: GUID("wefour") }).lean();
      check("the company itself is untouched", after.tenantId === before.tenantId && after.isActive === true);
      check("the real owner's access is unaffected", (await accessCount(u1._id, GUID("wefour"))) === 1);
    }

    // ============================================== F. multiple companies
    console.log("\nF. A second company: password re-check, isolation, same name != same company");
    {
      open({ name: "Second Co", guid: GUID("second") });
      let res = await connect(u1);
      check("no password -> 401", res.code === 401, `${res.code}`);
      res = await connect(u1, { password: "wrong" });
      check("wrong password -> 401", res.code === 401);
      check("nothing was created by those refusals", (await companyCount(GUID("second"))) === 0);

      res = await connect(u1, { password: PW });
      const second = await Company.findOne({ companyGuid: GUID("second") }).lean();
      const first = await Company.findOne({ companyGuid: GUID("wefour") }).lean();
      check("correct password -> connected (201)", res.code === 201 && second && second.companyName === "Second Co");
      check("different GUID -> different tenant", second.tenantId !== first.tenantId);

      open({ name: "We Four", guid: GUID("wefour-lookalike") }); // same display name, different GUID
      res = await connect(u1, { password: PW });
      const lookalike = await Company.findOne({ companyGuid: GUID("wefour-lookalike") }).lean();
      check("same display name but different GUID stays a separate company and tenant", res.code === 201 && lookalike && lookalike.tenantId !== first.tenantId && lookalike.tenantId !== second.tenantId);

      const list = fakeRes();
      await listCompanies({ user: { id: String(u1._id) } }, list);
      check("account lists its 3 companies, without tenant ids", list.body.data.length === 3 && list.body.data.every((c) => !("tenantId" in c)));

      open({ name: "We Four", guid: GUID("wefour") });
      res = await connect(u1, { password: PW });
      check("reconnecting a company the account already has is fine (200)", res.code === 200 && /reconnected/i.test(res.body.message));
      check("...and adds no duplicate link", (await accessCount(u1._id, GUID("wefour"))) === 1);
    }

    // ==================================== G. same GUID keeps its tenant
    console.log("\nG. Same company connected again: same tenant, checkpoints and data preserved");
    const G1 = GUID("wefour");
    const T1 = (await Company.findOne({ companyGuid: G1 }).lean()).tenantId;
    await SyncCheckpoint.create({ tenantId: T1, companyGuid: G1, voucherType: "Sales", lastAlterId: 403536, lastRunStatus: "success" });
    await SyncCheckpoint.create({ tenantId: T1, companyGuid: G1, voucherType: "Purchase", lastAlterId: 403530, lastRunStatus: "success" });
    await ReconciliationCheckpoint.create({ tenantId: T1, companyGuid: G1, voucherType: "Sales" });
    const checkpoints = async () => {
      const rows = await SyncCheckpoint.find({ companyGuid: G1 }).lean();
      return { count: rows.length, sales: (rows.find((r) => r.voucherType === "Sales") || {}).lastAlterId, purchase: (rows.find((r) => r.voucherType === "Purchase") || {}).lastAlterId, tenants: [...new Set(rows.map((r) => r.tenantId))] };
    };
    open({ name: "We Four", guid: G1 });
    {
      await Company.updateOne({ companyGuid: G1 }, { isActive: false });
      const res = await connect(u1, { password: PW });
      const c = await Company.findOne({ companyGuid: G1 }).lean();
      const cp = await checkpoints();
      check("deactivated company is reactivated, not recreated", res.code === 201 && res.body.data.reactivated === true && c.isActive === true && (await companyCount(G1)) === 1);
      check("same tenant (no T2)", c.tenantId === T1);
      check("Sales and Purchase checkpoints preserved and independent", cp.count === 2 && cp.sales === 403536 && cp.purchase === 403530 && cp.tenants.length === 1 && cp.tenants[0] === T1);
      check("reconciliation checkpoint preserved", (await ReconciliationCheckpoint.countDocuments({ companyGuid: G1 })) === 1);
    }
    {
      await Company.deleteOne({ companyGuid: G1 }); // company record hard-deleted; account, links, checkpoints remain
      const res = await connect(u1, { password: PW });
      const c = await Company.findOne({ companyGuid: G1 }).lean();
      const cp = await checkpoints();
      check("hard-deleted company record + one unambiguous history -> the OLD tenant is reused", (res.code === 200 || res.code === 201) && res.body.data.created === true && c && c.tenantId === T1, `${res.code} ${c && c.tenantId}`);
      check("checkpoints untouched", cp.count === 2 && cp.sales === 403536 && cp.purchase === 403530);
    }

    console.log("\nH. Normal incremental sync continues from the checkpoint - not from zero");
    {
      // Sales/Purchase modules never fetch old vouchers: the probe asks for AlterID > checkpoint.
      const company = await Company.findOne({ companyGuid: G1 }).lean();
      const calls = [];
      const mod = (voucherType, key) => ({
        voucherType,
        classificationKey: key,
        fetchPendingAlterIds: async (args) => { calls.push({ voucherType, ...args }); return { data: { collection: [] } }; },
        fetchVouchersSinceAlterId: async (args) => { calls.push({ voucherType, heavy: true, ...args }); return { data: { collection: [] } }; },
        processVoucher: async () => ({ status: "skipped" }),
      });
      const cfg = { intervalSeconds: 60, batchSize: 100 };
      const local = { ...company, tallyConnection: { baseUrl: stub.url } };

      await runSyncForCompanyModule(local, mod("Purchase", "purchase"), cfg);
      await runSyncForCompanyModule(local, mod("Sales", "sales"), cfg);
      const purchaseProbe = calls.find((c) => c.voucherType === "Purchase");
      const salesProbe = calls.find((c) => c.voucherType === "Sales");
      check("Purchase asks Tally only for AlterID > 403530", purchaseProbe && purchaseProbe.afterAlterId === 403530, JSON.stringify(purchaseProbe));
      check("Sales asks Tally only for AlterID > 403536 (independent)", salesProbe && salesProbe.afterAlterId === 403536, JSON.stringify(salesProbe));
      const cp = await checkpoints();
      check("nothing new in Tally -> checkpoints stay exactly where they were", cp.sales === 403536 && cp.purchase === 403530);
    }

    console.log("\nI. Removed company AND account: a new account reconnecting the same company reuses the tenant");
    {
      await Company.deleteOne({ companyGuid: G1 });
      await User.deleteOne({ _id: u1._id });
      await UserCompanyAccess.deleteMany({ companyGuid: G1 });
      const { user: u3 } = await signUp("newowner");
      open({ name: "We Four", guid: G1 });
      const res = await connect(u3);
      const c = await Company.findOne({ companyGuid: G1 }).lean();
      const cp = await checkpoints();
      check("nobody else owns it, one unambiguous tenant -> reused (201)", res.code === 201 && c && c.tenantId === T1, `${res.code} ${res.body && res.body.message}`);
      check("checkpoints preserved (not restarted at 0)", cp.count === 2 && cp.sales === 403536 && cp.purchase === 403530);
    }

    console.log("\nJ. Ambiguous or foreign history is never guessed or merged");
    {
      const { user: u4 } = await signUp("ambiguous");
      const GA = GUID("ambiguous");
      await SyncCheckpoint.create({ tenantId: "verify-ident-amb-1", companyGuid: GA, voucherType: "Sales", lastAlterId: 1 });
      await SyncCheckpoint.create({ tenantId: "verify-ident-amb-2", companyGuid: GA, voucherType: "Sales", lastAlterId: 2 });
      open({ name: "Amb", guid: GA });
      const warn = console.warn; console.warn = () => {};
      const res = await connect(u4);
      console.warn = warn;
      check("two candidate tenants -> 409 'ambiguous; contact administrator'", res.code === 409 && /ambiguous/i.test(res.body.message), `${res.code} ${res.body && res.body.message}`);
      check("no company, no fresh tenant, no link was created", (await companyCount(GA)) === 0 && (await accessCount(u4._id, GA)) === 0);

      // history owned by ANOTHER live account
      const GB = GUID("foreign-history");
      const { user: owner } = await signUp("foreignowner");
      await User.updateOne({ _id: owner._id }, { companyGuId: GB, tenantId: "verify-ident-foreign-tenant" });
      await SyncCheckpoint.create({ tenantId: "verify-ident-foreign-tenant", companyGuid: GB, voucherType: "Sales", lastAlterId: 9 });
      open({ name: "Foreign", guid: GB });
      let res2 = await connect(u4);
      check("history belonging to another live account -> 403, not reused", res2.code === 403 && (await companyCount(GB)) === 0);
      res2 = await connect(owner, { password: PW });
      const c = await Company.findOne({ companyGuid: GB }).lean();
      check("its own owner gets it back with the same tenant", res2.code === 201 && c && c.tenantId === "verify-ident-foreign-tenant");
    }

    // ======================================== K. service-level guarantees
    console.log("\nK. Service level: proof is mandatory and refusals create nothing");
    {
      const { user } = await signUp("service");
      const GS = GUID("service");
      const calls = { n: 0 };
      const ok = async () => { calls.n += 1; return { ok: true, reason: "ok" }; };

      let r = await ensureCompanyForGuid({ companyGuid: GS, companyName: "S", requesterUserId: user._id });
      check("no Tally proof at all -> refused", !r.ok && (await companyCount(GS)) === 0);
      r = await ensureCompanyForGuid({ companyGuid: GS, companyName: "S", requesterUserId: user._id, proveTallyPossession: async () => ({ ok: false, reason: "mismatch", message: "wrong" }) });
      check("wrong company open -> 400, nothing created", !r.ok && r.status === 400 && (await companyCount(GS)) === 0);
      r = await ensureCompanyForGuid({ companyGuid: GS, companyName: "S", requesterUserId: user._id, proveTallyPossession: async () => ({ ok: false, reason: "unreachable", message: "down" }) });
      check("Tally unreachable -> 503, nothing created", !r.ok && r.status === 503 && (await companyCount(GS)) === 0);
      r = await ensureCompanyForGuid({ companyGuid: GS, companyName: "S", requesterUserId: user._id, proveTallyPossession: ok });
      check("with proof a company is created", r.ok && r.created && calls.n === 1);

      // inactive company owned by someone else
      const { user: other } = await signUp("service-other");
      await Company.updateOne({ companyGuid: GS }, { isActive: false });
      await UserCompanyAccess.create({ userId: user._id, companyId: r.company._id, companyGuid: GS, tenantId: r.company.tenantId });
      r = await ensureCompanyForGuid({ companyGuid: GS, companyName: "S", requesterUserId: other._id, proveTallyPossession: ok });
      check("inactive company with a live owner cannot be taken by another account (403)", !r.ok && r.status === 403 && (await Company.findOne({ companyGuid: GS }).lean()).isActive === false);
      r = await ensureCompanyForGuid({ companyGuid: GS, companyName: "S", requesterUserId: user._id, proveTallyPossession: ok });
      check("its owner reactivates it", r.ok && r.reactivated === true);

      // access rows of users that no longer exist own nothing
      const GD = GUID("dead-owner");
      await UserCompanyAccess.create({ userId: new mongoose.Types.ObjectId(), companyId: new mongoose.Types.ObjectId(), companyGuid: GD, tenantId: "verify-ident-dead-tenant" });
      r = await ensureCompanyForGuid({ companyGuid: GD, companyName: "D", requesterUserId: other._id, proveTallyPossession: ok });
      check("a link left by a deleted account does not block reconnecting (tenant reused)", r.ok && r.company.tenantId === "verify-ident-dead-tenant");
    }
  } finally {
    await cleanup();
    const leftovers =
      (await Company.countDocuments({ companyGuid: guidRx })) +
      (await User.countDocuments({ email: guidRx })) +
      (await SyncCheckpoint.countDocuments({ companyGuid: guidRx })) +
      (await ReconciliationCheckpoint.countDocuments({ companyGuid: guidRx })) +
      (await UserCompanyAccess.countDocuments({ companyGuid: guidRx }));
    check("no test data left in MongoDB", leftovers === 0, leftovers);
    stub.server.close();
    await mongoose.disconnect();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("CRASH:", error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
