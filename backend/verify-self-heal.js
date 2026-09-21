/**
 * Data/checkpoint self-heal (selfHeal.js, wired into reconciliationWorker.js).
 *
 * Scenario: the incremental SyncCheckpoint is far ahead, but MongoDB lost
 * vouchers Tally still has (manual delete, restore...). The normal sync will
 * never fetch them again. After a SUCCESSFUL reconciliation pass the worker
 * compares Tally's voucher GUIDs with the tenant's MongoDB GUIDs (identities,
 * never counts) and repairs the difference through the existing recovery
 * service - bounded, on a cooldown, never touching SyncCheckpoint, never
 * reviving vouchers Tally has cancelled/deleted, never crossing tenants,
 * failing closed on anything odd.
 *
 * Fully offline and deterministic - NO live Tally: a local stub answers the
 * company-GUID guard and the VoucherType master; the registry / fetch / GUID-
 * list calls are mocks. Recovery, worker, persistence and MongoDB are real,
 * under isolated synthetic tenants, cleaned up at start, end and on crash.
 *
 * Run: node verify-self-heal.js
 */

require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Purchase = require("./src/models/purchase.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const ReconciliationCheckpoint = require("./src/models/reconciliationCheckpoint.model");
const { maybeSelfHeal } = require("./src/services/sync/selfHeal");
const { recoverMissingVouchers } = require("./src/services/sync/voucherRecovery");
const { runReconciliationForCompanyModule } = require("./src/services/sync/reconciliationWorker");
const { processSinglePurchaseVoucher } = require("./src/services/import/tallyPurchaseImport");
const { clearVoucherTypeClassificationCache } = require("./src/services/tally/voucherTypeClassifier");

const T1 = "verify-selfheal-tenant";
const T2 = "verify-selfheal-other-tenant";
const G1 = "verify-selfheal-company-guid";
const G2 = "verify-selfheal-other-company-guid";

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

let openGuid = G1;

function startStub() {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.headers.id === "RTS Company Guid Collection") {
        res.end(JSON.stringify({ status: "1", data: { collection: openGuid ? [{ name: { value: "Verify Co" }, guid: { value: openGuid } }] : [] } }));
      } else {
        res.end(JSON.stringify({
          status: "1",
          data: { collection: [
            { metadata: { name: "Sales", reservedname: "Sales" }, parent: { value: "Sales" }, guid: { value: `${openGuid}-1` } },
            { metadata: { name: "Purchase", reservedname: "Purchase" }, parent: { value: "Purchase" }, guid: { value: `${openGuid}-2` } },
          ] },
        }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

// ---- fixtures ----
const alterOf = (i) => 1000 + i * 7;
const guidOf = (i) => `${G1}-${i}`;

const rawVoucher = (i) => ({
  vouchernumber: `VERIFY-SH-${i}`,
  date: "20260905",
  partyname: "Verify Vendor",
  vouchertypename: "Purchase",
  guid: guidOf(i),
  alterid: String(alterOf(i)),
  ledgerentries: [
    { ledgername: "Purchase AC", amount: "100.00", isdeemedpositive: true },
    { ledgername: "Verify Vendor", amount: "-100.00", isdeemedpositive: false },
  ],
});

// vouchers = [{i, cancelled?}] currently in Tally.
function makeTally(vouchers, opts = {}) {
  const calls = { registry: 0, fetch: 0 };
  const drop = opts.drop || new Set();
  const deps = {
    fetchRegistry: async () => {
      calls.registry += 1;
      if (opts.registryThrows) throw new Error("registry timeout simulated");
      return { data: { collection: vouchers.map((v) => ({
        vouchertypename: "Purchase", guid: guidOf(v.i), alterid: String(alterOf(v.i)),
        ...(v.cancelled ? { iscancelled: true } : {}),
      })) } };
    },
    fetchByAlterIds: async (args) => {
      calls.fetch += 1;
      if (opts.fetchThrows) throw new Error("fetch timeout simulated");
      const wanted = new Set(args.alterIds);
      return { data: { collection: vouchers
        .filter((v) => wanted.has(alterOf(v.i)) && !drop.has(alterOf(v.i)))
        .map((v) => rawVoucher(v.i)) } };
    },
  };
  // The reconciliation worker's GUID-list query (every voucher, cancelled included).
  const allGuids = async () => ({ data: { collection: vouchers.map((v) => ({ guid: guidOf(v.i) })) } });
  return { deps, calls, allGuids };
}

const range = (n) => Array.from({ length: n }, (_, i) => ({ i }));
const count = (tenantId = T1) => Purchase.countDocuments({ tenantId });
const guidsOf = async (tenantId = T1) => (await Purchase.find({ tenantId }).select("tallyGuid").lean()).map((d) => d.tallyGuid);
const setCheckpoint = (lastAlterId) =>
  SyncCheckpoint.findOneAndUpdate(
    { tenantId: T1, companyGuid: G1, voucherType: "Purchase" },
    { $set: { lastAlterId, lastRunStatus: "success" } },
    { upsert: true }
  );
const getCheckpoint = () => SyncCheckpoint.findOne({ tenantId: T1, companyGuid: G1, voucherType: "Purchase" }).lean();
const seed = async (idxs, tenantId = T1) => { for (const i of idxs) await processSinglePurchaseVoucher(rawVoucher(i), tenantId); };

async function cleanup() {
  for (const t of [T1, T2]) {
    await Purchase.deleteMany({ tenantId: t });
    await SyncCheckpoint.deleteMany({ tenantId: t });
    await ReconciliationCheckpoint.deleteMany({ tenantId: t });
  }
}

async function main() {
  await connectDB();
  await cleanup();
  const stub = await startStub();
  clearVoucherTypeClassificationCache(G1);
  clearVoucherTypeClassificationCache(G2);

  const company = { tenantId: T1, companyGuid: G1, tallyConnection: { baseUrl: stub.url } };
  // What reconcileVoucherType hands over after a successful pass: the exact GUID set Tally reported.
  const success = (guids) => ({ status: "success", tallyGuidCount: guids.length, mongoActiveCount: 0, markedDeletedCount: 0, tallyGuids: new Set(guids) });
  const guidsFor = (idxs) => idxs.map(guidOf);

  try {
    // ------------------------------------------------------------- gating
    console.log("\n1. Detection is by GUID identity (mock recovery, no Tally)");
    {
      let calls = [];
      const recover = async (args) => { calls.push(args); return { status: "completed", found: 3, recovered: 3, remainingMissing: 0, reason: null }; };
      const model = (lastAlterId) => ({ findOne: () => ({ lean: async () => (lastAlterId === null ? null : { lastAlterId }) }) });
      const heal = (p) => maybeSelfHeal({
        company, voucherType: "Purchase", Model: p.Model === undefined ? Purchase : p.Model,
        deps: { recover, SyncCheckpointModel: model(p.ckpt === undefined ? 5000 : p.ckpt), now: () => p.now || new Date() },
        config: p.config, reconcileResult: p.rr, checkpoint: p.marker,
      });

      await cleanup();
      let r = await heal({ rr: success(guidsFor([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])) });
      check("Tally has 10 GUIDs, Mongo holds none of them -> recovery runs", r.attempted && r.outcome === "completed" && r.candidates === 10);
      check("recovery is APPLY, scoped to the sync checkpoint, bounded and capped",
        calls[0].apply === true && calls[0].upToAlterId === 5000 && calls[0].maxBatches === 3 && calls[0].maxMissing === 20000, JSON.stringify(calls[0]));
      check("repair marker returned for persistence", r.update.selfHealLastOutcome === "completed" && r.update.selfHealLastRecovered === 3);

      await seed(range(10).map((v) => v.i));
      calls = [];
      r = await heal({ rr: success(guidsFor(range(10).map((v) => v.i))) });
      check("Mongo already holds every GUID -> nothing missing, recovery NOT called", !r.attempted && r.skipReason === "no_missing_guids" && calls.length === 0);

      // Same COUNT, different identities: Mongo has 0..8 plus a stale 99; Tally has 0..9.
      await Purchase.deleteMany({ tenantId: T1, tallyGuid: guidOf(9) });
      await seed([99]);
      const held = await count();
      calls = [];
      r = await heal({ rr: { ...success(guidsFor(range(10).map((v) => v.i))), mongoActiveCount: held } });
      check("equal counts (10 vs 10) but voucher 9 is missing -> still detected by GUID", held === 10 && r.attempted && r.candidates === 1 && calls.length === 1, `${held} ${r.skipReason}`);

      // A voucher reconciliation marked 'deleted' is HELD, not missing.
      await cleanup();
      await seed(range(4).map((v) => v.i));
      await Purchase.updateOne({ tenantId: T1, tallyGuid: guidOf(2) }, { $set: { voucherStatus: "deleted" } });
      calls = [];
      r = await heal({ rr: success(guidsFor([0, 1, 2, 3])) });
      check("a voucher marked deleted in Mongo is not treated as missing (never resurrected)", !r.attempted && r.skipReason === "no_missing_guids" && calls.length === 0);

      await cleanup();
      for (const status of ["failed", "aborted_unsafe"]) {
        calls = [];
        r = await heal({ rr: { status, tallyGuidCount: 10, mongoActiveCount: 0, markedDeletedCount: 0, tallyGuids: new Set(guidsFor([0, 1])) } });
        check(`reconciliation ${status} -> no repair`, !r.attempted && calls.length === 0);
      }

      calls = [];
      r = await heal({ rr: { status: "success", tallyGuidCount: 10, mongoActiveCount: 0, markedDeletedCount: 0 } });
      check("no GUID list from reconciliation -> no repair (counts alone are never used)", !r.attempted && calls.length === 0);
      r = await heal({ rr: success(guidsFor([0, 1])), Model: null });
      check("no tenant scope / model -> no repair", !r.attempted && calls.length === 0);

      r = await heal({ rr: success(guidsFor([0, 1])), ckpt: 0 });
      check("checkpoint at 0 (first sync still running) -> not a mismatch", !r.attempted && r.skipReason === "checkpoint_not_advanced");
      r = await heal({ rr: success(guidsFor([0, 1])), ckpt: null });
      check("no checkpoint at all -> not a mismatch", !r.attempted && calls.length === 0);

      r = await heal({ rr: success(guidsFor([0, 1])), config: { enabled: false } });
      check("can be switched off", !r.attempted && r.skipReason === "disabled");
    }

    console.log("\n2. Cooldown stops the same gap being re-checked every tick");
    {
      await cleanup();
      let n = 0;
      const recover = async () => { n += 1; return { status: "completed", found: 0, recovered: 0, remainingMissing: 0, reason: null }; };
      const SyncCheckpointModel = { findOne: () => ({ lean: async () => ({ lastAlterId: 5000 }) }) };
      const at = new Date("2026-09-19T12:00:00Z");
      const run = (marker, now) => maybeSelfHeal({ company, voucherType: "Purchase", Model: Purchase, reconcileResult: success(guidsFor([0, 1, 2])), checkpoint: marker, deps: { recover, SyncCheckpointModel, now: () => now } });

      let r = await run(null, at);
      check("first attempt runs; nothing to recover (e.g. cancelled) -> outcome noop", r.attempted && r.outcome === "noop" && n === 1);

      const marker = { selfHealLastAttemptAt: at, selfHealLastOutcome: "noop" };
      r = await run(marker, new Date(at.getTime() + 20 * 60 * 1000));
      check("20 minutes later (next reconciliation tick) -> cooldown, no Tally load", !r.attempted && r.skipReason === "cooldown" && n === 1);

      r = await run(marker, new Date(at.getTime() + 7 * 3600 * 1000));
      check("after the cooldown it checks again", r.attempted && n === 2);

      for (const outcome of ["failed", "aborted"]) {
        r = await run({ selfHealLastAttemptAt: at, selfHealLastOutcome: outcome }, new Date(at.getTime() + 60 * 1000));
        check(`a ${outcome} attempt also cools down`, !r.attempted && r.skipReason === "cooldown");
      }

      r = await run({ selfHealLastAttemptAt: at, selfHealLastOutcome: "partial" }, new Date(at.getTime() + 60 * 1000));
      check("a PARTIAL repair (progress, more to do) continues on the next tick", r.attempted);
    }

    console.log("\n3. Recovery failures fail closed and never throw");
    {
      const SyncCheckpointModel = { findOne: () => ({ lean: async () => ({ lastAlterId: 5000 }) }) };
      const go = (recover) => maybeSelfHeal({ company, voucherType: "Purchase", Model: Purchase, reconcileResult: success(guidsFor([0, 1, 2])), deps: { recover, SyncCheckpointModel } });

      let r = await go(async () => ({ status: "aborted", reasonCode: "company_mismatch", reason: "wrong company", found: 0 }));
      check("aborted recovery -> outcome aborted, reason kept", r.outcome === "aborted" && r.update.selfHealLastReason === "wrong company");

      r = await go(async () => { throw new Error("boom"); });
      check("a throwing recovery is contained -> outcome failed", r.outcome === "failed" && /boom/.test(r.update.selfHealLastReason));

      r = await go(async () => ({ status: "failed", found: 4, recovered: 0, remainingMissing: 4, reason: "x" }));
      check("a failed repair is reported as failed", r.outcome === "failed");
    }

    // --------------------------------------------- real recovery, real Mongo
    console.log("\n4. Real repair: data gone behind the checkpoint, Tally still has it");
    {
      await cleanup();
      await setCheckpoint(2000);
      const before = await getCheckpoint();
      const vouchers = range(10).map((v) => (v.i === 3 ? { i: 3, cancelled: true } : v));
      const tally = makeTally(vouchers);
      const recover = (args) => recoverMissingVouchers({ ...args, deps: tally.deps });
      const heal = (rr, marker) => maybeSelfHeal({ company, voucherType: "Purchase", Model: Purchase, reconcileResult: rr, checkpoint: marker, deps: { recover } });
      const allTallyGuids = guidsFor(vouchers.map((v) => v.i));

      let r = await heal(success(allTallyGuids));
      const guids = await guidsOf();
      check("the 9 live vouchers are recovered", r.outcome === "completed" && r.result.recovered === 9 && guids.length === 9, `${r.outcome} ${guids.length}`);
      check("the CANCELLED voucher was not revived", !guids.includes(guidOf(3)));
      check("no duplicate GUIDs", new Set(guids).size === guids.length);
      const after = await getCheckpoint();
      check("SyncCheckpoint untouched (still 2000, same document, never moved)", after.lastAlterId === 2000 && String(after._id) === String(before._id) && after.updatedAt.getTime() === before.updatedAt.getTime());

      r = await heal(success(allTallyGuids), { selfHealLastAttemptAt: new Date(), selfHealLastOutcome: "completed" });
      check("Tally's cancelled voucher is still a GUID 'candidate', but recovery settles it: noop, nothing added", r.attempted && r.outcome === "noop" && (await count()) === 9);

      const registryCallsBefore = tally.calls.registry;
      r = await heal(success(allTallyGuids), { selfHealLastAttemptAt: new Date(), selfHealLastOutcome: "noop" });
      check("and then sits in cooldown without touching Tally", !r.attempted && tally.calls.registry === registryCallsBefore);
      await cleanup();
    }

    console.log("\n5. Scope: only vouchers the normal sync can no longer reach");
    {
      await setCheckpoint(alterOf(4)); // vouchers 0..4 are behind the checkpoint, 5..9 ahead of it
      const tally = makeTally(range(10));
      const recover = (args) => recoverMissingVouchers({ ...args, deps: tally.deps });
      const r = await maybeSelfHeal({ company, voucherType: "Purchase", Model: Purchase, reconcileResult: success(guidsFor(range(10).map((v) => v.i))), deps: { recover } });
      const guids = await guidsOf();
      check("only the 5 behind the checkpoint are recovered", r.result.recovered === 5 && guids.length === 5, guids.length);
      check("the ones AHEAD of the checkpoint are left to the normal sync", r.result.outOfScope === 5 && !guids.includes(guidOf(7)));
      check("checkpoint not moved", (await getCheckpoint()).lastAlterId === alterOf(4));
      await cleanup();
    }

    console.log("\n6. Bounded: a large gap is repaired a slice per pass, not all at once");
    {
      await setCheckpoint(5000);
      const tally = makeTally(range(9));
      const recover = (args) => recoverMissingVouchers({ ...args, deps: tally.deps });
      const cfg = { batchSize: 2, maxBatches: 2 };
      const rr = success(guidsFor(range(9).map((v) => v.i)));
      let r = await maybeSelfHeal({ company, voucherType: "Purchase", Model: Purchase, reconcileResult: rr, config: cfg, deps: { recover } });
      check("first pass recovers one bounded slice (2 batches x 2)", r.outcome === "partial" && r.result.recovered === 4 && (await count()) === 4, `${r.outcome} ${await count()}`);
      check("marker says 5 still missing", r.update.selfHealLastRemaining === 5);

      const marker = { selfHealLastAttemptAt: new Date(), selfHealLastOutcome: r.outcome };
      r = await maybeSelfHeal({ company, voucherType: "Purchase", Model: Purchase, reconcileResult: rr, checkpoint: marker, config: cfg, deps: { recover } });
      check("a partial repair continues immediately on the next pass", r.attempted && (await count()) === 8);
      r = await maybeSelfHeal({ company, voucherType: "Purchase", Model: Purchase, reconcileResult: rr, checkpoint: { selfHealLastAttemptAt: new Date(), selfHealLastOutcome: r.outcome }, config: cfg, deps: { recover } });
      const guids = await guidsOf();
      check("completes without duplicating anything", guids.length === 9 && new Set(guids).size === 9);
      await cleanup();
    }

    console.log("\n7. An unreasonably large gap is refused, not repaired");
    {
      await setCheckpoint(5000);
      const tally = makeTally(range(9));
      const recover = (args) => recoverMissingVouchers({ ...args, deps: tally.deps });
      const r = await maybeSelfHeal({ company, voucherType: "Purchase", Model: Purchase, reconcileResult: success(guidsFor(range(9).map((v) => v.i))), config: { maxAutoRecover: 3 }, deps: { recover } });
      check("aborted with too_many_missing, nothing written", r.outcome === "aborted" && r.result.reasonCode === "too_many_missing" && (await count()) === 0);
      check("no fetch of voucher bodies was made", tally.calls.fetch === 0);
      await cleanup();
    }

    console.log("\n8. Fail closed: wrong company open / Tally unavailable / incomplete Tally answer");
    {
      await setCheckpoint(5000);
      const rr = success(guidsFor(range(5).map((v) => v.i)));
      const heal = (tally) => maybeSelfHeal({ company, voucherType: "Purchase", Model: Purchase, reconcileResult: rr, deps: { recover: (args) => recoverMissingVouchers({ ...args, deps: tally.deps }) } });

      openGuid = G2;
      let tally = makeTally(range(5));
      let r = await heal(tally);
      check("a different company open -> aborted (company_mismatch), nothing written", r.outcome === "aborted" && r.result.reasonCode === "company_mismatch" && (await count()) === 0);
      check("Tally's voucher data was never even queried", tally.calls.registry === 0 && tally.calls.fetch === 0);
      openGuid = G1;

      tally = makeTally(range(5), { registryThrows: true });
      r = await heal(tally);
      check("Tally unavailable while listing -> aborted, nothing written", r.outcome === "aborted" && (await count()) === 0);

      tally = makeTally(range(5), { fetchThrows: true });
      r = await heal(tally);
      check("Tally fails while fetching -> failed, nothing written", r.outcome === "failed" && (await count()) === 0);

      tally = makeTally(range(5), { drop: new Set([alterOf(2)]) });
      r = await heal(tally);
      check("incomplete Tally answer -> failed, nothing from that batch written", r.outcome === "failed" && (await count()) === 0);
      await cleanup();
    }

    console.log("\n9. Tenant isolation: another tenant's vouchers neither count as held nor get touched");
    {
      await setCheckpoint(5000);
      await seed(range(10).map((v) => v.i), T2); // the OTHER tenant holds the very same GUIDs
      const t2Before = await guidsOf(T2);
      const tally = makeTally(range(10));
      const r = await maybeSelfHeal({ company, voucherType: "Purchase", Model: Purchase, reconcileResult: success(guidsFor(range(10).map((v) => v.i))), deps: { recover: (args) => recoverMissingVouchers({ ...args, deps: tally.deps }) } });
      const t1 = await guidsOf(T1);
      const t2After = await guidsOf(T2);
      check("this tenant is repaired from Tally even though another tenant holds the same GUIDs", r.outcome === "completed" && t1.length === 10, `${r.outcome} ${t1.length}`);
      check("the other tenant's documents are exactly as they were", t2After.length === 10 && JSON.stringify(t2After.sort()) === JSON.stringify(t2Before.sort()));
      check("every recovered document belongs to this tenant", (await Purchase.countDocuments({ tenantId: T1 })) === 10 && (await Purchase.countDocuments({ tenantId: { $nin: [T1, T2] }, tallyGuid: /^verify-selfheal/ })) === 0);
      await cleanup();
    }

    // --------------------------------------------------- through the worker
    console.log("\n10. Through the reconciliation worker: intentional Tally deletion is NOT undone");
    {
      await setCheckpoint(5000);
      // Mongo: 0..6, 8, 9 (voucher 7 lost). Tally: everything except 5 (deleted there on purpose).
      await seed([0, 1, 2, 3, 4, 5, 6, 8, 9]);
      const tally = makeTally(range(10).filter((v) => v.i !== 5));
      const module_ = {
        voucherType: "Purchase", classificationKey: "purchase", Model: Purchase,
        fetchAllGuidsBase: tally.allGuids,
        selfHealDeps: { recover: (args) => recoverMissingVouchers({ ...args, deps: tally.deps }) },
      };

      const result = await runReconciliationForCompanyModule(company, module_);
      const five = await Purchase.findOne({ tenantId: T1, tallyGuid: guidOf(5) }).lean();
      const seven = await Purchase.findOne({ tenantId: T1, tallyGuid: guidOf(7) }).lean();
      check("reconciliation result itself is unchanged (1 marked deleted)", result.status === "success" && result.markedDeletedCount === 1);
      check("voucher deleted in Tally stays 'deleted' - not resurrected", five && five.voucherStatus === "deleted");
      check("the voucher lost from Mongo was restored", seven && seven.voucherStatus === "active");
      const guids = await guidsOf();
      check("no duplicates, 10 documents in total", guids.length === 10 && new Set(guids).size === 10, guids.length);

      const marker = await ReconciliationCheckpoint.findOne({ tenantId: T1, voucherType: "Purchase" }).lean();
      check("repair marker persisted on the reconciliation checkpoint", marker.selfHealLastOutcome === "completed" && marker.selfHealLastRecovered === 1 && marker.selfHealLastAttemptAt instanceof Date);
      check("reconciliation status recorded as success", marker.lastRunStatus === "success" && marker.isRunning === false);
      check("SyncCheckpoint still untouched", (await getCheckpoint()).lastAlterId === 5000);

      // Same state again: every Tally GUID is held -> no repair, no extra Tally load.
      const registryBefore = tally.calls.registry;
      await runReconciliationForCompanyModule(company, module_);
      check("next pass: no missing GUID, no repeated recovery load", tally.calls.registry === registryBefore && (await count()) === 10);
      await cleanup();
    }

    console.log("\n11. Through the worker: wrong company open -> reconciliation skipped, so no repair either");
    {
      await setCheckpoint(5000);
      openGuid = G2;
      const tally = makeTally(range(6));
      const module_ = {
        voucherType: "Purchase", classificationKey: "purchase", Model: Purchase,
        fetchAllGuidsBase: tally.allGuids,
        selfHealDeps: { recover: (args) => recoverMissingVouchers({ ...args, deps: tally.deps }) },
      };
      const result = await runReconciliationForCompanyModule(company, module_);
      openGuid = G1;
      check("skipped as company_not_open", result.skipped === true && result.reason === "company_not_open");
      check("nothing written, no voucher query", (await count()) === 0 && tally.calls.registry === 0 && tally.calls.fetch === 0);
      await cleanup();
    }
  } finally {
    await cleanup();
    const leftovers =
      (await Purchase.countDocuments({ tenantId: { $in: [T1, T2] } })) +
      (await SyncCheckpoint.countDocuments({ tenantId: { $in: [T1, T2] } })) +
      (await ReconciliationCheckpoint.countDocuments({ tenantId: { $in: [T1, T2] } }));
    check("no test data left in MongoDB", leftovers === 0, leftovers);
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
