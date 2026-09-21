/**
 * Company ownership / tenant-context guard (companyOwnership.js) across every
 * path that consumes Tally data: incremental sync, recovery, reconciliation,
 * self-heal and voucher-type master data.
 *
 * Scenario (confirmed live): two companies are open in TallyPrime and one is
 * SELECTED. The open-company guard passes for BOTH tenants, but voucher and
 * master queries answer for the selected company only - so a tenant can be
 * handed the other company's data. The invariant under test: data may only
 * change a tenant's MongoDB state after the WHOLE response has been proven to
 * belong to that tenant's configured company.
 *
 * Fully offline and deterministic (stub Tally + real MongoDB under synthetic
 * tenants, cleaned up at start, end and on crash). No live Tally.
 *
 * Run: node verify-company-ownership.js
 */

require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Purchase = require("./src/models/purchase.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const ReconciliationCheckpoint = require("./src/models/reconciliationCheckpoint.model");
const own = require("./src/services/tally/companyOwnership");
const { runSyncForCompanyModule } = require("./src/services/sync/tallySyncWorker");
const { recoverMissingVouchers } = require("./src/services/sync/voucherRecovery");
const { runReconciliationForCompanyModule } = require("./src/services/sync/reconciliationWorker");
const { maybeSelfHeal } = require("./src/services/sync/selfHeal");
const { reconcileVoucherType } = require("./src/services/sync/reconciliation");
const { processSinglePurchaseVoucher } = require("./src/services/import/tallyPurchaseImport");
const { resolveVoucherTypeClassification, clearVoucherTypeClassificationCache } = require("./src/services/tally/voucherTypeClassifier");

const TA = "verify-own-tenant-a";
const TB = "verify-own-tenant-b";
const GA = "aaaaaaaa-1111-2222-3333-444444444444";
const GB = "bbbbbbbb-1111-2222-3333-444444444444";

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

// ---- stub TallyPrime: BOTH companies open; masters follow the SELECTED one ----
let selected = GA;
let masterHits = 0;
function startStub() {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.headers.id === "RTS Company Guid Collection") {
        res.end(JSON.stringify({ status: "1", data: { collection: [
          { name: { value: "Company A" }, guid: { value: GA } },
          { name: { value: "Company B" }, guid: { value: GB } },
        ] } }));
      } else {
        masterHits += 1;
        res.end(JSON.stringify({ status: "1", data: { collection: [
          { metadata: { name: "Sales", reservedname: "Sales" }, guid: { value: `${selected}-1` }, parent: { value: "Sales" } },
          { metadata: { name: "Purchase", reservedname: "Purchase" }, guid: { value: `${selected}-2` }, parent: { value: "Purchase" } },
        ] } }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

// ---- fixtures ----
const alterOf = (i) => 1000 + i * 7;
const idOf = (i) => (0x3d6 + i).toString(16).padStart(8, "0");
const guidFor = (company, i) => `${company}-${idOf(i)}`;
const rawVoucher = (company, i) => ({
  vouchernumber: `OWN-${i}`,
  date: "20260905",
  partyname: "Verify Vendor",
  vouchertypename: "Purchase",
  guid: guidFor(company, i),
  alterid: String(alterOf(i)),
  ledgerentries: [
    { ledgername: "Purchase AC", amount: "100.00", isdeemedpositive: true },
    { ledgername: "Verify Vendor", amount: "-100.00", isdeemedpositive: false },
  ],
});
const rows = (company, idxs) => idxs.map((i) => ({ guid: guidFor(company, i), alterid: String(alterOf(i)), vouchertypename: "Purchase" }));
const range = (n, from = 0) => Array.from({ length: n }, (_, i) => i + from);

const count = (t) => Purchase.countDocuments({ tenantId: t });
const ckpt = (t, g) => SyncCheckpoint.findOne({ tenantId: t, companyGuid: g, voucherType: "Purchase" }).lean();
const setCkpt = (t, g, lastAlterId) => SyncCheckpoint.findOneAndUpdate(
  { tenantId: t, companyGuid: g, voucherType: "Purchase" },
  { $set: { lastAlterId, lastRunStatus: "success", isRunning: false, lockedAt: null } }, { upsert: true });

async function cleanup() {
  for (const t of [TA, TB]) {
    await Purchase.deleteMany({ tenantId: t });
    await SyncCheckpoint.deleteMany({ tenantId: t });
    await ReconciliationCheckpoint.deleteMany({ tenantId: t });
  }
}

// A sync module whose Tally answers are scripted per call.
function syncModule({ probe, fetch }) {
  const calls = { probe: 0, fetch: 0 };
  return {
    calls,
    mod: {
      voucherType: "Purchase",
      classificationKey: "purchase",
      fetchPendingAlterIds: async (a) => { calls.probe += 1; return { data: { collection: await probe(a) } }; },
      fetchVouchersSinceAlterId: async (a) => { calls.fetch += 1; return { data: { collection: await fetch(a) } }; },
      processVoucher: processSinglePurchaseVoucher,
    },
  };
}

async function main() {
  await connectDB();
  await cleanup();
  const stub = await startStub();
  clearVoucherTypeClassificationCache();
  const companyA = { tenantId: TA, companyGuid: GA, tallyConnection: { baseUrl: stub.url } };
  const companyB = { tenantId: TB, companyGuid: GB, tallyConnection: { baseUrl: stub.url } };
  const silence = (fn) => async (...a) => { const w = console.warn; console.warn = () => {}; try { return await fn(...a); } finally { console.warn = w; } };

  try {
    // ================================================= 1. the validator itself
    console.log("\n1. Ownership validator (pure, in-memory)");
    {
      const ok = own.validateBatchOwnership(rows(GA, range(5)), GA);
      check("every voucher of the tenant's company -> accepted", ok.ok && ok.total === 5);

      const foreign = own.validateBatchOwnership(rows(GB, range(3)), GA);
      check("another company's vouchers -> rejected as foreign", !foreign.ok && foreign.foreign === 3);

      const missing = own.validateBatchOwnership([{ alterid: "1" }, { guid: "" }, { guid: { value: "  " } }], GA);
      check("missing / blank GUID -> rejected", !missing.ok && missing.missing === 3);

      const malformed = own.validateBatchOwnership([{ guid: "not-a-guid" }, { guid: `${GA}-` }, { guid: `${GA}-000 bad` }, { guid: "x" }], GA);
      check("malformed GUIDs (no master id, bad characters, garbage) -> rejected", !malformed.ok && malformed.malformed === 4, JSON.stringify(malformed));

      const boundary = own.validateBatchOwnership([{ guid: `${GA}x-00000001` }, { guid: `${GA.slice(0, 35)}-00000001` }], GA);
      check("wrong prefix boundary (GUID that merely starts with / is a prefix of the company GUID) -> rejected", !boundary.ok && boundary.foreign + boundary.malformed === 2, JSON.stringify(boundary));

      const mixed = own.validateBatchOwnership([...rows(GA, range(499)), ...rows(GB, [999])], GA);
      check("499 valid + 1 foreign -> the ENTIRE batch is rejected", !mixed.ok && mixed.foreign === 1 && mixed.total === 500);
      check("diagnostics carry counts and a truncated GUID prefix only", mixed.sample.length === 1 && mixed.sample[0] === `${GB.slice(0, 8)}...` && !JSON.stringify(mixed).includes(GB));

      const dup = own.validateBatchOwnership([...rows(GA, [1, 2]), ...rows(GA, [1])], GA, { rejectDuplicates: true });
      check("a duplicated GUID is rejected where a list must be unique", !dup.ok && dup.duplicates === 1);
      check("...and tolerated where it is not requested", own.validateBatchOwnership([...rows(GA, [1]), ...rows(GA, [1])], GA).ok);

      check("no trusted company GUID -> nothing is accepted", !own.validateBatchOwnership(rows(GA, [1]), "").ok && !own.validateBatchOwnership(rows(GA, [1]), undefined).ok);
      check("JSONEx-wrapped GUIDs are read", own.validateBatchOwnership([{ guid: { type: "String", value: guidFor(GA, 1) } }], GA).ok);
      check("an empty batch is vacuously fine (callers decide what empty means)", own.validateBatchOwnership([], GA).ok);
    }

    console.log("\n2. Cost: pure, O(n), no database or network calls, no batch copies");
    {
      const big = rows(GA, range(100000));
      const spies = { exec: 0, save: 0 };
      const origExec = mongoose.Query.prototype.exec;
      const origSave = mongoose.Model.prototype.save;
      mongoose.Query.prototype.exec = function (...a) { spies.exec += 1; return origExec.apply(this, a); };
      mongoose.Model.prototype.save = function (...a) { spies.save += 1; return origSave.apply(this, a); };
      const heapBefore = process.memoryUsage().heapUsed;
      const t0 = process.hrtime.bigint();
      const r = own.validateBatchOwnership(big, GA);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const heapDelta = (process.memoryUsage().heapUsed - heapBefore) / 1e6;
      mongoose.Query.prototype.exec = origExec;
      mongoose.Model.prototype.save = origSave;
      check("100,000 vouchers validated", r.ok && r.total === 100000);
      check("zero database calls during validation", spies.exec === 0 && spies.save === 0);
      check(`fast (${ms.toFixed(0)} ms for 100k)`, ms < 1500, ms);
      check(`no batch copy: heap grew ${heapDelta.toFixed(1)} MB`, heapDelta < 25, heapDelta);
      console.log(`  (measured: ${(ms / 100000 * 1000).toFixed(2)} us/voucher)`);
    }

    // ================================================= 3. incremental sync
    console.log("\n3. Incremental sync: wrong-company voucher -> whole batch rejected, nothing written, checkpoint stays");
    {
      await cleanup();
      await setCkpt(TA, GA, 500);
      const good = range(9);
      const contaminated = [...good.map((i) => rawVoucher(GA, i)), rawVoucher(GB, 50)]; // Tally is answering for B for one voucher
      const pending = [...rows(GA, good), ...rows(GA, [50]).map((r) => ({ ...r, alterid: String(alterOf(50)) }))];
      const s = syncModule({ probe: async () => pending, fetch: async () => contaminated });

      selected = GA;
      const r = await silence(runSyncForCompanyModule)(companyA, s.mod, { intervalSeconds: 60, batchSize: 100 });
      const cp = await ckpt(TA, GA);
      check("rejected as a company mismatch", r.companyMismatch === true && /Company mismatch/.test(r.error || ""), JSON.stringify(r));
      check("0 vouchers written (not even the 9 valid ones)", (await count(TA)) === 0);
      check("checkpoint did NOT advance", cp.lastAlterId === 500);
      check("failure recorded for diagnosis, lock released", cp.lastRunStatus === "failed" && /Company mismatch/.test(cp.lastError || "") && cp.isRunning === false);
      check("nothing was written to the other tenant either", (await count(TB)) === 0);

      // Same tenant, response now clean: retry succeeds and the checkpoint moves.
      const clean = syncModule({ probe: async () => rows(GA, good), fetch: async () => good.map((i) => rawVoucher(GA, i)) });
      const r2 = await runSyncForCompanyModule(companyA, clean.mod, { intervalSeconds: 60, batchSize: 100 });
      const cp2 = await ckpt(TA, GA);
      check("retry with a clean response writes all 9 and advances", r2.created === 9 && (await count(TA)) === 9 && cp2.lastAlterId === alterOf(8), JSON.stringify(r2));
    }

    console.log("\n4. Incremental sync: a batch that is ENTIRELY the other company's (the confirmed live scenario)");
    {
      await cleanup();
      await setCkpt(TB, GB, 100);
      // B's voucher types were legitimately cached while B was selected; the user then selects A.
      selected = GB;
      await resolveVoucherTypeClassification({ companyGuid: GB, baseUrl: stub.url });
      selected = GA;
      const s = syncModule({ probe: async () => rows(GA, range(5)), fetch: async () => range(5).map((i) => rawVoucher(GA, i)) });
      const r = await silence(runSyncForCompanyModule)(companyB, s.mod, { intervalSeconds: 60, batchSize: 100 });
      check("tenant B refuses company A's vouchers although B is 'open' in Tally", r.companyMismatch === true && (await count(TB)) === 0 && (await ckpt(TB, GB)).lastAlterId === 100, JSON.stringify(r));
    }

    console.log("\n5. Checkpoint safety: it never moves past unprocessed data");
    {
      await cleanup();
      await setCkpt(TA, GA, 500);
      const idxs = range(6);
      const full = () => idxs.map((i) => rawVoucher(GA, i));

      // timeout while fetching
      let s = syncModule({ probe: async () => rows(GA, idxs), fetch: async () => { throw new Error("timeout of 30000ms exceeded"); } });
      let r = await runSyncForCompanyModule(companyA, s.mod, { intervalSeconds: 60, batchSize: 100 });
      check("Tally timeout -> nothing written, checkpoint unchanged", !!r.error && (await count(TA)) === 0 && (await ckpt(TA, GA)).lastAlterId === 500);

      // transformation failure on one voucher
      const bad = full(); bad[3] = { ...bad[3], vouchernumber: undefined, date: "garbage", ledgerentries: [] };
      s = syncModule({ probe: async () => rows(GA, idxs), fetch: async () => bad });
      r = await runSyncForCompanyModule(companyA, s.mod, { intervalSeconds: 60, batchSize: 100 });
      check("a voucher that cannot be transformed -> run failed, checkpoint unchanged", r.failed >= 1 && (await ckpt(TA, GA)).lastAlterId === 500, JSON.stringify(r));

      // MongoDB write failure
      await cleanup(); await setCkpt(TA, GA, 500);
      const origFind = Purchase.findOneAndUpdate;
      let n = 0;
      Purchase.findOneAndUpdate = function (...a) { n += 1; if (n === 3) return Promise.reject(new Error("Simulated MongoDB write failure")); return origFind.apply(this, a); };
      s = syncModule({ probe: async () => rows(GA, idxs), fetch: async () => full() });
      r = await runSyncForCompanyModule(companyA, s.mod, { intervalSeconds: 60, batchSize: 100 });
      Purchase.findOneAndUpdate = origFind;
      const cpFail = await ckpt(TA, GA);
      check("MongoDB write failure mid-batch -> run failed, checkpoint unchanged", r.failed === 1 && cpFail.lastAlterId === 500 && cpFail.lastRunStatus === "failed", JSON.stringify(r));
      const partial = await count(TA);
      check(`earlier upserts (${partial}) are idempotent leftovers, not a partial checkpoint`, partial === 5);

      // restart/retry: the same delta is re-fetched and completes without duplicates
      s = syncModule({ probe: async () => rows(GA, idxs), fetch: async () => full() });
      r = await runSyncForCompanyModule(companyA, s.mod, { intervalSeconds: 60, batchSize: 100 });
      const guids = (await Purchase.find({ tenantId: TA }).select("tallyGuid").lean()).map((d) => d.tallyGuid);
      check("retry completes the batch, no duplicate documents, checkpoint advances only now", r.failed === 0 && guids.length === 6 && new Set(guids).size === 6 && (await ckpt(TA, GA)).lastAlterId === alterOf(5));

      // crashed run: a stale lock is reclaimed and the checkpoint was never touched
      await SyncCheckpoint.updateOne({ tenantId: TA, companyGuid: GA, voucherType: "Purchase" }, { $set: { isRunning: true, lockedAt: new Date(Date.now() - 3600 * 1000) } });
      s = syncModule({ probe: async () => [], fetch: async () => [] });
      r = await runSyncForCompanyModule(companyA, s.mod, { intervalSeconds: 60, batchSize: 100 });
      check("process restart: a stale lock is reclaimed and the run proceeds", !r.skipped && (await ckpt(TA, GA)).isRunning === false);
    }

    // ================================================= 6. recovery
    console.log("\n6. Recovery: a wrong-company voucher never becomes 'missing' and is never imported");
    {
      await cleanup();
      selected = GA;
      await setCkpt(TA, GA, 5000);
      const deps = (registry, fetchRows) => {
        const calls = { registry: 0, fetch: 0 };
        return { calls, deps: {
          fetchRegistry: async () => { calls.registry += 1; return { data: { collection: registry } }; },
          fetchByAlterIds: async (a) => { calls.fetch += 1; return { data: { collection: fetchRows(a) } }; },
        } };
      };
      const recover = (d, opts = {}) => silence(recoverMissingVouchers)({ company: companyA, voucherType: "Purchase", deps: d.deps, ...opts });

      // registry contains B's vouchers (Tally answering for the selected company B)
      let d = deps(rows(GB, range(4)), () => []);
      let r = await recover(d, { apply: false });
      check("dry run: an all-foreign registry -> aborted company_mismatch, found = 0", r.status === "aborted" && r.reasonCode === "company_mismatch" && r.found === 0, JSON.stringify(r));
      r = await recover(deps(rows(GB, range(4)), () => []), { apply: true });
      check("apply: the same -> nothing imported, no voucher fetch attempted", r.status === "aborted" && (await count(TA)) === 0);

      d = deps([...rows(GA, range(5)), ...rows(GB, [77])], () => []);
      r = await recover(d, { apply: true });
      check("registry with ONE foreign row among 5 valid -> aborted, none of the 5 recovered", r.status === "aborted" && (await count(TA)) === 0 && d.calls.fetch === 0);

      d = deps([...rows(GA, [1, 2]), ...rows(GA, [1])], () => []);
      r = await recover(d, { apply: false });
      check("a duplicated registry row is refused", r.status === "aborted");

      // clean registry, but the fetched batch is contaminated
      const registry = rows(GA, range(4));
      d = deps(registry, (a) => [rawVoucher(GA, 0), rawVoucher(GA, 1), rawVoucher(GB, 2), rawVoucher(GA, 3)]);
      r = await recover(d, { apply: true });
      check("fetched batch with one foreign voucher -> batch rejected, 0 written", r.batches.failed === 1 && r.recovered === 0 && (await count(TA)) === 0 && /Company mismatch/.test(r.errors[0] || ""), JSON.stringify(r));
      check("checkpoint untouched by recovery", (await ckpt(TA, GA)).lastAlterId === 5000);

      d = deps(registry, () => range(4).map((i) => rawVoucher(GA, i)));
      r = await recover(d, { apply: true });
      check("a clean fetch recovers all 4 (control)", r.status === "completed" && r.recovered === 4 && (await count(TA)) === 4);
    }

    // ================================================= 7. reconciliation
    console.log("\n7. Reconciliation: a wrong-company response is never read as mass deletion");
    {
      await cleanup();
      selected = GA;
      await setCkpt(TA, GA, 5000);
      for (const i of range(10)) await processSinglePurchaseVoucher(rawVoucher(GA, i), TA);
      const cpBefore = JSON.stringify(await ckpt(TA, GA));

      // direct: foreign-only, and mixed
      const direct = async (guids) => reconcileVoucherType({ tenantId: TA, companyGuid: GA, Model: Purchase, fetchAllGuids: async () => ({ data: { collection: guids.map((guid) => ({ guid })) } }) });
      let r = await silence(direct)(range(3).map((i) => guidFor(GB, i)));
      check("all-foreign GUID list -> aborted, nothing marked deleted", r.status === "aborted_unsafe" && r.companyMismatch === true && r.markedDeletedCount === 0);
      r = await silence(direct)([...range(9).map((i) => guidFor(GA, i)), guidFor(GB, 1)]);
      check("mixed list (9 own + 1 foreign) -> aborted, nothing marked deleted", r.status === "aborted_unsafe" && r.markedDeletedCount === 0);
      check("all 10 still active", (await Purchase.countDocuments({ tenantId: TA, voucherStatus: "active" })) === 10);

      // through the worker
      const module_ = { voucherType: "Purchase", classificationKey: "purchase", Model: Purchase, fetchAllGuidsBase: async () => ({ data: { collection: rows(GB, range(10)).map((x) => ({ guid: x.guid })) } }) };
      r = await silence(runReconciliationForCompanyModule)(companyA, module_);
      const rc = await ReconciliationCheckpoint.findOne({ tenantId: TA, voucherType: "Purchase" }).lean();
      check("worker: recorded as aborted_unsafe with the mismatch reason", r.status === "aborted_unsafe" && rc.lastRunStatus === "aborted_unsafe" && /Company mismatch/.test(rc.lastError || "") && rc.isRunning === false);
      check("worker: no voucher marked deleted, none removed", (await Purchase.countDocuments({ tenantId: TA, voucherStatus: "active" })) === 10 && (await count(TA)) === 10);
      check("worker: SyncCheckpoint unchanged", JSON.stringify(await ckpt(TA, GA)) === cpBefore);

      // self-heal never acts on it
      const heal = await maybeSelfHeal({ company: companyA, voucherType: "Purchase", Model: Purchase, reconcileResult: r, deps: { recover: async () => { throw new Error("must not run"); } } });
      check("self-heal does nothing after an unsafe reconciliation", heal.attempted === false && heal.skipReason === "reconciliation_not_successful");

      // and the legitimate result is unchanged (control)
      module_.fetchAllGuidsBase = async () => ({ data: { collection: range(10).filter((i) => i !== 4).map((i) => ({ guid: guidFor(GA, i) })) } });
      r = await runReconciliationForCompanyModule(companyA, module_);
      check("control: the company's own GUID list still reconciles and marks the one deleted voucher", r.status === "success" && r.markedDeletedCount === 1);
    }

    // ================================================= 8. master data
    console.log("\n8. Master data: wrong-company voucher types are refused and never cached under another tenant");
    {
      clearVoucherTypeClassificationCache();
      masterHits = 0;
      selected = GB; // Tally's selected company is B
      const rA = await silence(resolveVoucherTypeClassification)({ companyGuid: GA, baseUrl: stub.url });
      check("tenant A asks while B is selected -> refused (never classified)", rA.sales.status === "error" && /different company|Company mismatch/i.test(rA.sales.reason || ""), JSON.stringify(rA.sales));

      const rB = await resolveVoucherTypeClassification({ companyGuid: GB, baseUrl: stub.url });
      check("tenant B (the selected company) gets its own types", rB.sales.status === "ok" && rB.source === "live");

      const hits = masterHits;
      const rA2 = await silence(resolveVoucherTypeClassification)({ companyGuid: GA, baseUrl: stub.url });
      check("A's refusal was NOT cached: asking again goes back to Tally", masterHits === hits + 1 && rA2.sales.status === "error");

      selected = GA; // the user selects company A
      const rA3 = await resolveVoucherTypeClassification({ companyGuid: GA, baseUrl: stub.url });
      check("once A is selected, A resolves normally (live)", rA3.sales.status === "ok" && rA3.source === "live");
      const rB2 = await resolveVoucherTypeClassification({ companyGuid: GB, baseUrl: stub.url });
      check("B's cached entry is still B's (served from cache, no cross-tenant reuse)", rB2.source === "cache" && rB2.sales.status === "ok");

      const noGuid = await resolveVoucherTypeClassification({ baseUrl: stub.url });
      check("no company GUID -> refused (no shared 'default' cache key)", noGuid.sales.status === "error");
    }

    // ================================================= 9. concurrency
    console.log("\n9. Two tenants' workers running at the same time never share context");
    {
      await cleanup();
      selected = GA;
      await setCkpt(TA, GA, 500);
      await setCkpt(TB, GB, 500);
      const slow = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
      const sA = syncModule({ probe: async () => slow(30, rows(GA, range(6))), fetch: async () => slow(20, range(6).map((i) => rawVoucher(GA, i))) });
      // B's Tally answer is contaminated with A's vouchers (the selected company is A)
      const sB = syncModule({ probe: async () => slow(5, rows(GA, range(6))), fetch: async () => slow(5, range(6).map((i) => rawVoucher(GA, i))) });
      const [rA, rB] = await silence(Promise.all.bind(Promise))([runSyncForCompanyModule(companyA, sA.mod, { intervalSeconds: 60, batchSize: 100 }), runSyncForCompanyModule(companyB, sB.mod, { intervalSeconds: 60, batchSize: 100 })]);
      check("A (its own vouchers) synced normally while B ran", rA.created === 6 && (await count(TA)) === 6);
      check("B (handed A's vouchers) was refused; B has nothing", rB.companyMismatch === true && (await count(TB)) === 0);
      const foreignInA = await Purchase.countDocuments({ tenantId: TA, tallyGuid: new RegExp(`^${GB}`) });
      check("no document of either tenant carries the other company's GUID", foreignInA === 0 && (await Purchase.countDocuments({ tenantId: TB })) === 0);
      check("each tenant's checkpoint moved (or not) independently", (await ckpt(TA, GA)).lastAlterId === alterOf(5) && (await ckpt(TB, GB)).lastAlterId === 500);
    }
  } finally {
    await cleanup();
    const left = (await Purchase.countDocuments({ tenantId: { $in: [TA, TB] } })) + (await SyncCheckpoint.countDocuments({ tenantId: { $in: [TA, TB] } })) + (await ReconciliationCheckpoint.countDocuments({ tenantId: { $in: [TA, TB] } }));
    check("no test data left in MongoDB", left === 0, left);
    stub.server.close();
    await mongoose.disconnect();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("CRASH:", error);
  try { await cleanup(); await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
