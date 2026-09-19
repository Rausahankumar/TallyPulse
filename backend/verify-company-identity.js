/**
 * Company identity: the same Tally company GUID keeps the same TallyPulse
 * tenant across remove / re-register (companyIdentity.js + register/addCompany).
 *
 * Scenario: a company is removed (record deleted or deactivated) and registered
 * again. Its SyncCheckpoints and vouchers live under the old tenantId, so a new
 * random tenantId would strand them and re-sync from AlterID 0. The GUID - never
 * the display name - must map back to the old tenant, only after live proof the
 * company is open in Tally, and never by guessing.
 *
 * Offline: a local stub answers the company-GUID guard (TALLY_URL points at
 * it); MongoDB is real under synthetic GUIDs/emails that are cleaned up at
 * start, end and on crash. No live Tally.
 *
 * Run: node verify-company-identity.js
 */

require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");

// The stub must exist BEFORE odbcService is first required (it reads TALLY_URL
// at load time), so everything Tally-facing is required lazily in main().
let openGuid = null; // what the stub reports as the open company (null = none)
let stubDown = false;

function startStub() {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (stubDown) return req.socket.destroy();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "1",
        data: { collection: openGuid ? [{ name: { value: "Verify Co" }, guid: { value: openGuid } }] : [] },
      }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

const PREFIX = "verify-ident-";
const GUID = (n) => `${PREFIX}guid-${n}`;
const EMAIL = (n) => `${PREFIX}${n}@example.test`;

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
  const { verifyOpenTallyCompany } = require("./src/services/auth/tallyCompanyGuard");
  const { register, addCompany } = require("./src/controllers/authController");

  const guidRx = new RegExp(`^${PREFIX}`);

  async function cleanup() {
    await Company.deleteMany({ companyGuid: guidRx });
    await User.deleteMany({ email: guidRx });
    await UserCompanyAccess.deleteMany({ companyGuid: guidRx });
    await SyncCheckpoint.deleteMany({ companyGuid: guidRx });
    await ReconciliationCheckpoint.deleteMany({ companyGuid: guidRx });
  }

  const proofOk = () => ({ calls: 0, fn() { this.calls += 1; return Promise.resolve({ ok: true, reason: "ok" }); } });
  const proofWith = (result) => ({ calls: 0, fn() { this.calls += 1; return Promise.resolve(result); } });

  await connectDB();
  await cleanup();

  try {
    // ---------------------------------------------------------------- service
    console.log("\n1. A brand-new GUID gets a fresh tenant (unchanged behaviour)");
    {
      const proof = proofOk();
      const r = await ensureCompanyForGuid({ companyGuid: GUID("new"), companyName: "New Co", proveTallyPossession: () => proof.fn() });
      check("created", r.ok && r.created === true && r.reactivated === false);
      check("tenant is fresh, not reused", r.tenantReused === false && typeof r.company.tenantId === "string" && r.company.tenantId.length > 0);
      check("no Tally proof needed for a brand-new company", proof.calls === 0);
    }

    console.log("\n2. An ACTIVE company is returned as is");
    {
      const proof = proofOk();
      const first = await Company.findOne({ companyGuid: GUID("new") });
      const r = await ensureCompanyForGuid({ companyGuid: GUID("new"), companyName: "Whatever", proveTallyPossession: () => proof.fn() });
      check("same record and tenant", r.ok && String(r.company._id) === String(first._id) && r.company.tenantId === first.tenantId);
      check("not created, not reactivated, no proof", !r.created && !r.reactivated && proof.calls === 0);
    }

    console.log("\n3. Company record removed, checkpoints remain -> re-register reuses the SAME tenant");
    {
      const G = GUID("removed");
      const OLD = "verify-ident-old-tenant-A";
      await SyncCheckpoint.create({ tenantId: OLD, companyGuid: G, voucherType: "Sales", lastAlterId: 403536, lastRunStatus: "success" });
      await SyncCheckpoint.create({ tenantId: OLD, companyGuid: G, voucherType: "Purchase", lastAlterId: 403530, lastRunStatus: "success" });
      await ReconciliationCheckpoint.create({ tenantId: OLD, companyGuid: G, voucherType: "Sales" });

      const proof = proofOk();
      const r = await ensureCompanyForGuid({ companyGuid: G, companyName: "Removed Co", proveTallyPossession: () => proof.fn() });
      check("re-registered with the OLD tenantId", r.ok && r.company.tenantId === OLD, r.company && r.company.tenantId);
      check("flagged as tenant reuse", r.tenantReused === true && r.created === true);
      check("live Tally proof was required", proof.calls === 1);

      const sc = await SyncCheckpoint.find({ companyGuid: G }).lean();
      const sales = sc.find((c) => c.voucherType === "Sales");
      const purchase = sc.find((c) => c.voucherType === "Purchase");
      check("checkpoints preserved (no reset to 0, no duplicates)", sc.length === 2 && sales.lastAlterId === 403536 && purchase.lastAlterId === 403530);
      check("reconciliation checkpoint preserved", (await ReconciliationCheckpoint.countDocuments({ companyGuid: G })) === 1);
    }

    console.log("\n4. Tenant reuse is refused without proof; nothing is created");
    {
      const G = GUID("noproof");
      await SyncCheckpoint.create({ tenantId: "verify-ident-old-tenant-B", companyGuid: G, voucherType: "Sales", lastAlterId: 10 });

      const mismatch = proofWith({ ok: false, reason: "mismatch", message: "wrong company open" });
      const r1 = await ensureCompanyForGuid({ companyGuid: G, companyName: "X", proveTallyPossession: () => mismatch.fn() });
      check("wrong company open -> refused (400)", !r1.ok && r1.status === 400);

      const down = proofWith({ ok: false, reason: "unreachable", message: "Tally down" });
      const r2 = await ensureCompanyForGuid({ companyGuid: G, companyName: "X", proveTallyPossession: () => down.fn() });
      check("Tally unreachable -> refused (503)", !r2.ok && r2.status === 503);

      const r3 = await ensureCompanyForGuid({ companyGuid: G, companyName: "X" });
      check("no proof function at all -> refused", !r3.ok);
      check("no Company record was created by any refusal", (await Company.countDocuments({ companyGuid: G })) === 0);
    }

    console.log("\n5. A different GUID with the SAME display name never reuses a tenant");
    {
      const proof = proofOk();
      const r = await ensureCompanyForGuid({ companyGuid: GUID("same-name-other-guid"), companyName: "Removed Co", proveTallyPossession: () => proof.fn() });
      const reused = await Company.findOne({ companyGuid: GUID("removed") }).lean();
      check("fresh tenant, not the removed company's", r.ok && r.tenantReused === false && r.company.tenantId !== reused.tenantId);
      check("no proof requested (nothing to reuse)", proof.calls === 0);
    }

    console.log("\n6. INACTIVE company: reactivated with its tenant, only for a previous member (or if abandoned)");
    {
      const G = GUID("inactive");
      const memberId = new mongoose.Types.ObjectId();
      const strangerId = new mongoose.Types.ObjectId();
      const company = await Company.create({ companyName: "Inactive Co", companyGuid: G, tenantId: "verify-ident-tenant-inactive", isActive: false });
      await UserCompanyAccess.create({ userId: memberId, companyId: company._id, companyGuid: G, tenantId: company.tenantId });
      await SyncCheckpoint.create({ tenantId: company.tenantId, companyGuid: G, voucherType: "Purchase", lastAlterId: 777 });

      const proof = proofOk();
      const stranger = await ensureCompanyForGuid({ companyGuid: G, companyName: "x", requesterUserId: strangerId, proveTallyPossession: () => proof.fn() });
      check("a non-member cannot take over a company that has members (403)", !stranger.ok && stranger.status === 403);
      check("company still inactive", (await Company.findById(company._id).lean()).isActive === false);
      check("no Tally proof was even attempted for the refused stranger", proof.calls === 0);

      const noProof = await ensureCompanyForGuid({ companyGuid: G, companyName: "x", requesterUserId: memberId, proveTallyPossession: () => proofWith({ ok: false, reason: "mismatch", message: "m" }).fn() });
      check("a member without Tally proof is refused", !noProof.ok && (await Company.findById(company._id).lean()).isActive === false);

      const member = await ensureCompanyForGuid({ companyGuid: G, companyName: "x", requesterUserId: memberId, proveTallyPossession: () => proof.fn() });
      const after = await Company.findById(company._id).lean();
      check("previous member reactivates it", member.ok && member.reactivated === true && after.isActive === true);
      check("same record, same tenant (no new tenant minted)", String(after._id) === String(company._id) && after.tenantId === "verify-ident-tenant-inactive");
      check("checkpoint untouched", (await SyncCheckpoint.findOne({ companyGuid: G }).lean()).lastAlterId === 777);

      const G2 = GUID("abandoned");
      const abandoned = await Company.create({ companyName: "Abandoned", companyGuid: G2, tenantId: "verify-ident-tenant-abandoned", isActive: false });
      const claim = await ensureCompanyForGuid({ companyGuid: G2, companyName: "x", requesterUserId: strangerId, proveTallyPossession: () => proofOk().fn() });
      check("an inactive company with NO members can be reclaimed (with Tally proof)", claim.ok && claim.reactivated === true && claim.company.tenantId === abandoned.tenantId);
    }

    console.log("\n7. Ambiguous or owned tenant evidence is never guessed");
    {
      const G = GUID("ambiguous");
      await SyncCheckpoint.create({ tenantId: "verify-ident-amb-1", companyGuid: G, voucherType: "Sales", lastAlterId: 1 });
      await SyncCheckpoint.create({ tenantId: "verify-ident-amb-2", companyGuid: G, voucherType: "Sales", lastAlterId: 2 });
      const proof = proofOk();
      const warn = console.warn; console.warn = () => {};
      const r = await ensureCompanyForGuid({ companyGuid: G, companyName: "Amb", proveTallyPossession: () => proof.fn() });
      console.warn = warn;
      check("two candidate tenants -> fresh tenant issued, no guessing", r.ok && r.tenantReused === false && !["verify-ident-amb-1", "verify-ident-amb-2"].includes(r.company.tenantId));

      const G3 = GUID("owned");
      await Company.create({ companyName: "Other", companyGuid: GUID("other-owner"), tenantId: "verify-ident-owned-tenant", isActive: true });
      await SyncCheckpoint.create({ tenantId: "verify-ident-owned-tenant", companyGuid: G3, voucherType: "Sales", lastAlterId: 5 });
      const r2 = await ensureCompanyForGuid({ companyGuid: G3, companyName: "Y", proveTallyPossession: () => proof.fn() });
      check("a tenant already owned by another company is not reused", r2.ok && r2.tenantReused === false && r2.company.tenantId !== "verify-ident-owned-tenant");
    }

    // ------------------------------------------------------------- controller
    console.log("\n8. register(): remove the company and register it again -> same tenant, nothing re-syncs from 0");
    {
      const G = GUID("wefour");
      openGuid = G;

      const res1 = fakeRes();
      await register({ body: { name: "A", email: EMAIL("a"), password: "pw-123456", companyName: "We Four", companyGuId: G } }, res1);
      check("first registration succeeds", res1.code === 201, JSON.stringify(res1.body));
      const c1 = await Company.findOne({ companyGuid: G }).lean();
      const u1 = await User.findOne({ email: EMAIL("a") }).lean();
      check("user carries the company's tenant", u1 && c1 && u1.tenantId === c1.tenantId);

      await SyncCheckpoint.create({ tenantId: c1.tenantId, companyGuid: G, voucherType: "Sales", lastAlterId: 403536 });
      await SyncCheckpoint.create({ tenantId: c1.tenantId, companyGuid: G, voucherType: "Purchase", lastAlterId: 403530 });

      // The scenario from the field: the company (and its user) are removed.
      await Company.deleteOne({ _id: c1._id });
      await User.deleteOne({ _id: u1._id });
      await UserCompanyAccess.deleteMany({ companyGuid: G });

      const res2 = fakeRes();
      await register({ body: { name: "A2", email: EMAIL("a2"), password: "pw-123456", companyName: "We Four", companyGuId: G } }, res2);
      check("re-registration succeeds", res2.code === 201, JSON.stringify(res2.body));
      const c2 = await Company.findOne({ companyGuid: G }).lean();
      const u2 = await User.findOne({ email: EMAIL("a2") }).lean();
      check("re-registered company has the SAME tenantId", c2 && c2.tenantId === c1.tenantId, c2 && c2.tenantId);
      check("new user is bound to that tenant", u2 && u2.tenantId === c1.tenantId);
      const cps = await SyncCheckpoint.find({ companyGuid: G }).lean();
      check("sync checkpoints preserved (still advanced, not reset, not duplicated)", cps.length === 2 && cps.every((c) => c.lastAlterId >= 403530) && cps.every((c) => c.tenantId === c1.tenantId));
    }

    console.log("\n9. register(): a wrong company open in Tally cannot reclaim an old tenant");
    {
      const G = GUID("hijack");
      await SyncCheckpoint.create({ tenantId: "verify-ident-victim-tenant", companyGuid: G, voucherType: "Sales", lastAlterId: 9 });
      openGuid = GUID("someone-else");

      const res = fakeRes();
      await register({ body: { name: "H", email: EMAIL("h"), password: "pw-123456", companyName: "Hijack", companyGuId: G } }, res);
      check("refused (400)", res.code === 400, `${res.code} ${JSON.stringify(res.body)}`);
      check("no company, user or access created", (await Company.countDocuments({ companyGuid: G })) === 0 && (await User.countDocuments({ email: EMAIL("h") })) === 0);

      openGuid = null;
      stubDown = true;
      const res2 = fakeRes();
      await register({ body: { name: "H", email: EMAIL("h"), password: "pw-123456", companyName: "Hijack", companyGuId: G } }, res2);
      stubDown = false;
      check("Tally unreachable -> refused, nothing created", res2.code === 503 && (await Company.countDocuments({ companyGuid: G })) === 0, `${res2.code}`);
    }

    console.log("\n10. register(): active duplicate is still rejected; brand-new company needs no Tally");
    {
      const G = GUID("wefour");
      const res = fakeRes();
      await register({ body: { name: "D", email: EMAIL("d"), password: "pw-123456", companyName: "We Four", companyGuId: G } }, res);
      check("active company -> 'already registered' (400)", res.code === 400 && /already registered/i.test(res.body.message));

      openGuid = null; // nothing open in Tally at all
      const res2 = fakeRes();
      await register({ body: { name: "N", email: EMAIL("n"), password: "pw-123456", companyName: "Brand New", companyGuId: GUID("brand-new") } }, res2);
      check("a never-seen GUID still registers exactly as before", res2.code === 201, JSON.stringify(res2.body));
    }

    console.log("\n11. addCompany(): a previous member reconnects an inactive company (tenant + checkpoints intact)");
    {
      const G = GUID("reconnect");
      openGuid = G;
      const ru = fakeRes();
      await register({ body: { name: "R", email: EMAIL("r"), password: "pw-123456", companyName: "Recon Co", companyGuId: GUID("reconnect-home") } }, ru);
      const user = await User.findOne({ email: EMAIL("r") }).lean();

      const company = await Company.create({ companyName: "Reconnect Co", companyGuid: G, tenantId: "verify-ident-tenant-reconnect", isActive: false });
      await UserCompanyAccess.create({ userId: user._id, companyId: company._id, companyGuid: G, tenantId: company.tenantId });
      await SyncCheckpoint.create({ tenantId: company.tenantId, companyGuid: G, voucherType: "Sales", lastAlterId: 4242 });

      const res = fakeRes();
      await addCompany({ user: { id: String(user._id) }, body: { password: "pw-123456", companyName: "Reconnect Co", companyGuId: G } }, res);
      const after = await Company.findById(company._id).lean();
      check("reactivated (200)", res.code === 200 && res.body.success === true, `${res.code} ${JSON.stringify(res.body)}`);
      check("same tenant, active again", after.isActive === true && after.tenantId === "verify-ident-tenant-reconnect");
      check("checkpoint preserved", (await SyncCheckpoint.findOne({ companyGuid: G }).lean()).lastAlterId === 4242);

      // A different account cannot reactivate it.
      await Company.updateOne({ _id: company._id }, { isActive: false });
      const ru2 = fakeRes();
      openGuid = GUID("reconnect-home-2");
      await register({ body: { name: "S", email: EMAIL("s"), password: "pw-123456", companyName: "Home 2", companyGuId: GUID("reconnect-home-2") } }, ru2);
      const stranger = await User.findOne({ email: EMAIL("s") }).lean();
      openGuid = G;
      const res2 = fakeRes();
      await addCompany({ user: { id: String(stranger._id) }, body: { password: "pw-123456", companyName: "Reconnect Co", companyGuId: G } }, res2);
      check("another account is refused (403) and the company stays inactive", res2.code === 403 && (await Company.findById(company._id).lean()).isActive === false, `${res2.code}`);
    }

    console.log("\n12. Two different GUIDs stay isolated (multi-company invariant)");
    {
      const a = await Company.findOne({ companyGuid: GUID("wefour") }).lean();
      const b = await Company.findOne({ companyGuid: GUID("brand-new") }).lean();
      check("different GUIDs -> different tenants", a && b && a.tenantId !== b.tenantId);
      check("one tenant per company record", (await Company.distinct("tenantId", { companyGuid: guidRx })).length === (await Company.countDocuments({ companyGuid: guidRx })));
    }

    // Independent sanity: the guard used as proof is the real one.
    openGuid = GUID("guard-check");
    check("proof helper is the real Tally company guard", (await verifyOpenTallyCompany(GUID("guard-check"))).ok === true);
  } finally {
    await cleanup();
    const leftovers =
      (await Company.countDocuments({ companyGuid: guidRx })) +
      (await User.countDocuments({ email: guidRx })) +
      (await SyncCheckpoint.countDocuments({ companyGuid: guidRx })) +
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
