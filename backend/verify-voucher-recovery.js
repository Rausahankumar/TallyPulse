/**
 * Missing-data recovery (voucherRecovery.js + odbcService recovery queries +
 * POST /api/sync/recovery contract helpers).
 *
 * Scenario: Tally still has vouchers whose MongoDB documents are gone while
 * the incremental checkpoint has already moved past them. Recovery must find
 * exactly those, re-import them through the existing pipeline, never
 * duplicate, never touch the checkpoint, and fail safe.
 *
 * Fully offline and deterministic - NO live Tally: a local stub answers the
 * company-GUID guard and the VoucherType master, and the registry / fetch
 * functions are substituted mocks. Everything else is real (recovery service,
 * worker, parser, mapper, persistence, MongoDB) under isolated synthetic
 * tenants, cleaned up at start, end and on crash.
 *
 * Run: node verify-voucher-recovery.js
 */

require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Purchase = require("./src/models/purchase.model");
const Company = require("./src/models/company");
const { runVoucherRecovery } = require("./src/controllers/syncRecoveryController");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const { recoverMissingVouchers } = require("./src/services/sync/voucherRecovery");
const { runSyncForCompanyModule } = require("./src/services/sync/tallySyncWorker");
const { processSinglePurchaseVoucher } = require("./src/services/import/tallyPurchaseImport");
const { getPendingVoucherAlterIds, getVouchersByAlterIds } = require("./src/services/odbc/odbcService");
const { clearVoucherTypeClassificationCache } = require("./src/services/tally/voucherTypeClassifier");

const T1 = "verify-recovery-tenant";
const G1 = "verify-recovery-company-guid";
const T2 = "verify-recovery-other-tenant";
const G2 = "verify-recovery-other-company-guid";

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

function startStub() {
  const recorded = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const id = req.headers.id;
      try { recorded[id] = JSON.parse(body); } catch (_) {}
      res.writeHead(200, { "Content-Type": "application/json" });
      if (id === "RTS Company Guid Collection") {
        res.end(JSON.stringify({ status: "1", data: { collection: [{ name: { value: "Verify Recovery Co" }, guid: { value: G1 } }] } }));
      } else if (id === "RTS VoucherType Master Collection") {
        res.end(JSON.stringify({
          status: "1",
          data: { collection: [
            { metadata: { name: "Sales", reservedname: "Sales" }, parent: { value: "Sales" }, guid: { value: `${G1}-1` } },
            { metadata: { name: "Purchase", reservedname: "Purchase" }, parent: { value: "Purchase" }, guid: { value: `${G1}-2` } },
          ] },
        }));
      } else {
        res.end(JSON.stringify({ status: "1", data: { collection: [] } }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, recorded }))
  );
}

// ---- fixtures ----
const alterOf = (i) => 1000 + i * 7;
const guidOf = (i) => `${G1}-${i}`;

function rawVoucher(i, { party = "Verify Vendor" } = {}) {
  return {
    vouchernumber: `VERIFY-REC-${i}`,
    date: "20260905",
    partyname: party,
    vouchertypename: "Purchase",
    guid: guidOf(i),
    alterid: String(alterOf(i)),
    ledgerentries: [
      { ledgername: "Purchase AC", amount: "100.00", isdeemedpositive: true },
      { ledgername: party || "x", amount: "-100.00", isdeemedpositive: false },
    ],
  };
}

const registryRow = (i, { cancelled = false, deleted = false } = {}) => ({
  vouchertypename: "Purchase",
  guid: guidOf(i),
  alterid: String(alterOf(i)),
  ...(cancelled ? { iscancelled: true } : {}),
  ...(deleted ? { isdeleted: true } : {}),
});

// Tally = list of {i, cancelled?, deleted?}; returns mocks + call log.
function makeTally(vouchers, opts = {}) {
  const calls = { registry: [], fetch: [] };
  const drop = opts.drop || new Set(); // AlterIDs Tally silently omits
  const bad = opts.bad || new Set(); // voucher indexes returned unmappable
  const deps = {
    fetchRegistry: async (args) => {
      calls.registry.push(args);
      if (opts.registryThrows) throw new Error("registry timeout simulated");
      if (opts.registryNoGuid) return { data: { collection: [{ alterid: "5" }] } };
      return { data: { collection: vouchers.map((v) => registryRow(v.i, v)) } };
    },
    fetchByAlterIds: async (args) => {
      calls.fetch.push(args);
      if (opts.fetchThrows) throw new Error("fetch timeout simulated");
      if (opts.beforeReturn) await opts.beforeReturn(args);
      const wanted = new Set(args.alterIds);
      const rows = vouchers
        .filter((v) => wanted.has(alterOf(v.i)) && !drop.has(alterOf(v.i)))
        .map((v) => rawVoucher(v.i, { party: bad.has(v.i) ? "" : "Verify Vendor" }));
      rows.push(...(opts.extra || []));
      return { data: { collection: rows } };
    },
  };
  return { deps, calls };
}

const range = (n) => Array.from({ length: n }, (_, i) => ({ i }));

async function seed(indexes, tenantId = T1) {
  for (const i of indexes) await processSinglePurchaseVoucher(rawVoucher(i), tenantId);
}

const count = (tenantId = T1) => Purchase.countDocuments({ tenantId });
const guidsOf = async (tenantId = T1) => (await Purchase.find({ tenantId }).select("tallyGuid").lean()).map((d) => d.tallyGuid).sort();

async function cleanup() {
  for (const t of [T1, T2]) {
    await Purchase.deleteMany({ tenantId: t });
    await SyncCheckpoint.deleteMany({ tenantId: t });
  }
}

async function main() {
  await connectDB();
  await cleanup();
  const stub = await startStub();
  clearVoucherTypeClassificationCache(G1);
  clearVoucherTypeClassificationCache(G2);

  const company1 = { tenantId: T1, companyGuid: G1, tallyConnection: { baseUrl: stub.url } };
  const company2 = { tenantId: T2, companyGuid: G2, tallyConnection: { baseUrl: stub.url } };
  const recover = (tally, opts = {}, company = company1) =>
    recoverMissingVouchers({ company, voucherType: "Purchase", deps: tally.deps, ...opts });

  // The checkpoint recovery must never touch: far ahead of everything, "running".
  const seedCheckpoint = () =>
    SyncCheckpoint.create({
      tenantId: T1, companyGuid: G1, voucherType: "Purchase",
      lastAlterId: 999999, lastRunStatus: "success", lastSyncedAt: new Date("2026-01-01T00:00:00Z"),
      isRunning: true, lockedAt: new Date("2026-01-02T00:00:00Z"),
    });
  const checkpointSnapshot = async () => {
    const cp = await SyncCheckpoint.findOne({ tenantId: T1, companyGuid: G1, voucherType: "Purchase" }).lean();
    return cp ? JSON.stringify(cp) : null;
  };

  try {
    console.log("\n=== QUERY: recovery request bodies (offline stub) ===");
    const filterOf = (id) => stub.recorded[id].tdlmessage[0].definitions[1].value;

    await getVouchersByAlterIds({ alterIds: [10, 20, 20, 30], baseUrl: stub.url, voucherTypeNames: ["Purchase", "CK Purchase"] });
    check(
      "fetch-by-AlterIDs: one explicit formula, de-duplicated ids AND type names",
      filterOf("RTS Recovery Vouchers Collection") === '($AlterID = 10 OR $AlterID = 20 OR $AlterID = 30) AND ($VoucherTypeName = "Purchase" OR $VoucherTypeName = "CK Purchase")',
      filterOf("RTS Recovery Vouchers Collection")
    );
    check(
      "fetch-by-AlterIDs requests the same full field set as the incremental fetch (parser-compatible)",
      JSON.stringify(stub.recorded["RTS Recovery Vouchers Collection"]).includes("inventoryentries.* , ledgerentries.*") &&
        JSON.stringify(stub.recorded["RTS Recovery Vouchers Collection"]).includes("IsCancelled")
    );
    const bad = [[], [1.5], [0], ["7"], Array.from({ length: 201 }, (_, i) => i + 1), undefined];
    let allRejected = true;
    for (const ids of bad) {
      try { await getVouchersByAlterIds({ alterIds: ids, baseUrl: stub.url, voucherTypeNames: ["Purchase"] }); allRejected = false; } catch (_) {}
    }
    check("empty / non-integer / zero / string / >200 / missing AlterID lists are rejected", allRejected);

    await getPendingVoucherAlterIds({ afterAlterId: 0, baseUrl: stub.url, voucherTypeNames: ["Purchase"], withCancelledFlag: true });
    check("registry probe with the flag adds only IsCancelled (still light)", JSON.stringify(stub.recorded["RTS Pending AlterIDs Collection"]).includes("VoucherTypeName, AlterID, IsCancelled") && !JSON.stringify(stub.recorded["RTS Pending AlterIDs Collection"]).includes("inventoryentries"));
    await getPendingVoucherAlterIds({ afterAlterId: 0, baseUrl: stub.url, voucherTypeNames: ["Purchase"] });
    check("the sync worker's probe is unchanged by default", JSON.stringify(stub.recorded["RTS Pending AlterIDs Collection"]).includes('"VoucherTypeName, AlterID"'));

    console.log("\n=== RECOVERY: missing vouchers recovered; checkpoint untouched ===");
    await cleanup();
    {
      await seedCheckpoint();
      const cpBefore = await checkpointSnapshot();
      await seed([0, 1, 2, 5, 6, 7, 8, 9]); // Mongo lost vouchers 3 and 4
      const tally = makeTally(range(10));

      const dry = await recover(tally);
      check("dry run: identifies exactly 2 missing, 8 present, writes nothing, fetches nothing", dry.status === "dry_run" && dry.found === 2 && dry.alreadyPresent === 8 && dry.recovered === 0 && tally.calls.fetch.length === 0 && (await count()) === 8, JSON.stringify(dry));
      check("dry run is the default (apply must be explicit)", dry.dryRun === true);

      const r = await recover(tally, { apply: true });
      check("apply: both missing vouchers recovered, status completed, nothing remaining", r.status === "completed" && r.recovered === 2 && r.failed === 0 && r.remainingMissing === 0 && r.found === 2, JSON.stringify(r));
      check("only the missing AlterIDs were requested from Tally (present vouchers not re-fetched)", tally.calls.fetch.length === 1 && JSON.stringify(tally.calls.fetch[0].alterIds) === JSON.stringify([alterOf(3), alterOf(4)]), JSON.stringify(tally.calls.fetch));
      check("MongoDB now has all 10, one document per GUID (no duplicates)", (await count()) === 10 && new Set(await guidsOf()).size === 10);
      check("recovered documents carry the original Tally GUID and AlterID", !!(await Purchase.findOne({ tenantId: T1, tallyGuid: guidOf(3), tallyAlterId: alterOf(3) })));
      check("the normal sync checkpoint is byte-for-byte unchanged (position, status, lock)", (await checkpointSnapshot()) === cpBefore);
      check("registry probe asked for the cancelled flag and the resolved type names", tally.calls.registry[0].withCancelledFlag === true && tally.calls.registry[0].voucherTypeNames.includes("Purchase"));

      console.log("\n=== RECOVERY: repeated recovery is idempotent ===");
      const again = await recover(tally, { apply: true });
      check("second run: nothing missing, nothing fetched, nothing written", again.status === "completed" && again.found === 0 && again.recovered === 0 && again.alreadyPresent === 10 && tally.calls.fetch.length === 1 && (await count()) === 10, JSON.stringify(again));
    }

    console.log("\n=== RECOVERY: a document appearing mid-run is not duplicated ===");
    await cleanup();
    {
      await seed([0, 1]);
      const tally = makeTally(range(5), {
        beforeReturn: async () => { await seed([3]); }, // e.g. the incremental sync writes voucher 3 after the comparison
      });
      const r = await recover(tally, { apply: true });
      check("voucher written concurrently is counted as already present, not recovered", r.recovered === 2 && r.alreadyPresent === 2 + 1 && r.status === "completed", JSON.stringify(r));
      check("exactly one document per voucher (5), no duplicate", (await count()) === 5 && new Set(await guidsOf()).size === 5);
    }

    console.log("\n=== RECOVERY: cancelled / deleted Tally vouchers are not recovered ===");
    await cleanup();
    {
      const tally = makeTally([{ i: 0 }, { i: 1, cancelled: true }, { i: 2, deleted: true }, { i: 3 }, { i: 4, cancelled: true }]);
      const r = await recover(tally, { apply: true });
      check("3 vouchers reported as cancelled/deleted, 2 active recovered", r.tally.total === 5 && r.tally.cancelledOrDeleted === 3 && r.found === 2 && r.recovered === 2, JSON.stringify(r));
      check("cancelled/deleted AlterIDs were never requested", JSON.stringify(tally.calls.fetch[0].alterIds) === JSON.stringify([alterOf(0), alterOf(3)]));
      check("only the active vouchers exist in MongoDB", JSON.stringify(await guidsOf()) === JSON.stringify([guidOf(0), guidOf(3)]));
    }

    console.log("\n=== RECOVERY: incomplete Tally fetch does not report success ===");
    await cleanup();
    {
      await seedCheckpoint();
      const cpBefore = await checkpointSnapshot();
      const drop = new Set([alterOf(2)]);
      const tally = makeTally(range(6), { drop });
      const r = await recover(tally, { apply: true });
      check("one requested AlterID missing from the response -> not completed", r.status === "failed" && /Incomplete Tally fetch: 1 of 6/.test(r.errors[0] || ""), JSON.stringify(r));
      check("nothing was written from the incomplete response", r.recovered === 0 && (await count()) === 0);
      check("remaining missing reflects reality (all 6), checkpoint untouched", r.remainingMissing === 6 && (await checkpointSnapshot()) === cpBefore);
      drop.clear();
      const r2 = await recover(tally, { apply: true });
      check("retry once Tally returns the full set completes", r2.status === "completed" && r2.recovered === 6 && (await count()) === 6);
    }

    console.log("\n=== RECOVERY: a failing batch stops safely; state is not corrupted ===");
    await cleanup();
    {
      await seedCheckpoint();
      const cpBefore = await checkpointSnapshot();
      const badSet = new Set([4]);
      const tally = makeTally(range(9), { bad: badSet });
      const r = await recover(tally, { apply: true, batchSize: 3 });
      check("batch 2 has an unmappable voucher: run is partial, not success", r.status === "partial" && r.failed === 1 && r.batches.attempted === 2 && r.batches.succeeded === 1 && r.batches.failed === 1, JSON.stringify(r));
      check("stopped at the first failed batch (batch 3 never requested)", tally.calls.fetch.length === 2);
      check("vouchers from the good batch stay; failed voucher not stored; no duplicates", (await count()) === 5 && !(await Purchase.findOne({ tenantId: T1, tallyGuid: guidOf(4) })));
      check("remaining missing = the failed voucher + the untouched batch 3 (4)", r.remainingMissing === 4, r.remainingMissing);
      check("checkpoint untouched by the failure", (await checkpointSnapshot()) === cpBefore);
      badSet.clear(); // source data fixed
      const r2 = await recover(tally, { apply: true, batchSize: 3 });
      check("re-run recovers the rest, still no duplicates", r2.status === "completed" && (await count()) === 9 && new Set(await guidsOf()).size === 9, JSON.stringify(r2));
    }

    console.log("\n=== RECOVERY: bounded per call (batch limit) ===");
    await cleanup();
    {
      const tally = makeTally(range(250));
      const r1 = await recover(tally, { apply: true, batchSize: 100, maxBatches: 1 });
      check("one batch of 100 recovered, status partial with a batch-limit reason", r1.status === "partial" && r1.recovered === 100 && r1.remainingMissing === 150 && r1.reasonCode === "batch_limit", JSON.stringify(r1));
      check("no request ever asked for more than the batch size", tally.calls.fetch.every((c) => c.alterIds.length <= 100));
      const r2 = await recover(tally, { apply: true, batchSize: 100, maxBatches: 5 });
      check("next call continues where it stopped and completes", r2.status === "completed" && r2.recovered === 150 && (await count()) === 250, JSON.stringify(r2));
    }

    console.log("\n=== RECOVERY: tenant / company isolation ===");
    await cleanup();
    {
      await seed([0, 1], T2); // another tenant already holds the SAME GUIDs
      const t2Before = JSON.stringify(await Purchase.find({ tenantId: T2 }).sort({ tallyGuid: 1 }).lean());
      const tally = makeTally(range(4));
      const r = await recover(tally, { apply: true });
      check("another tenant's identical GUIDs do not count as present: T1 recovers all 4", r.found === 4 && r.recovered === 4 && (await count(T1)) === 4);
      check("the other tenant's documents are untouched", JSON.stringify(await Purchase.find({ tenantId: T2 }).sort({ tallyGuid: 1 }).lean()) === t2Before && (await count(T2)) === 2);

      const tally2 = makeTally(range(4));
      const mism = await recover(tally2, { apply: true }, company2); // stub reports G1 as the open company
      check("company not open in Tally -> aborted (company_mismatch), no Tally query, no writes", mism.status === "aborted" && mism.reasonCode === "company_mismatch" && tally2.calls.registry.length === 0 && tally2.calls.fetch.length === 0 && (await count(T2)) === 2, JSON.stringify(mism));
    }

    console.log("\n=== RECOVERY: fail-closed on unreadable / failing Tally responses ===");
    await cleanup();
    {
      for (const [label, opts, code] of [
        ["registry fetch error", { registryThrows: true }, "registry_fetch_failed"],
        ["registry rows without a GUID", { registryNoGuid: true }, "registry_unreadable"],
      ]) {
        const t = makeTally(range(3), opts);
        const r = await recover(t, { apply: true });
        check(`${label} -> aborted (${code}), nothing fetched or written`, r.status === "aborted" && r.reasonCode === code && t.calls.fetch.length === 0 && (await count()) === 0, JSON.stringify(r));
      }
      const t = makeTally(range(3), { fetchThrows: true });
      const r = await recover(t, { apply: true });
      check("batch fetch error -> failed, nothing written", r.status === "failed" && r.batches.failed === 1 && (await count()) === 0 && r.remainingMissing === 3, JSON.stringify(r));
    }

    console.log("\n=== RECOVERY: unexpected vouchers in a response are ignored ===");
    await cleanup();
    {
      const tally = makeTally(range(3), { extra: [rawVoucher(77)] });
      const r = await recover(tally, { apply: true });
      check("a voucher Tally returns that was not requested is not imported", r.recovered === 3 && r.ignoredUnexpected === 1 && !(await Purchase.findOne({ tenantId: T1, tallyGuid: guidOf(77) })));
    }

    console.log("\n=== RECOVERY: overlapping runs for the same company are refused ===");
    await cleanup();
    {
      const tally = makeTally(range(3));
      const [a, b] = await Promise.all([recover(tally, { apply: true }), recover(tally, { apply: true })]);
      const statuses = [a.status, b.status].sort();
      check("the second overlapping call is aborted (already_running), the first completes", statuses[0] === "aborted" && statuses[1] === "completed" && (a.reasonCode === "already_running" || b.reasonCode === "already_running"));
      check("no duplicates from the overlap", (await count()) === 3);
    }

    console.log("\n=== NORMAL SYNC: unaffected by recovery ===");
    await cleanup();
    {
      const all = range(15);
      // Worker had synced 0..9 (checkpoint at voucher 9); Mongo lost 3 and 4.
      await SyncCheckpoint.create({ tenantId: T1, companyGuid: G1, voucherType: "Purchase", lastAlterId: alterOf(9), lastRunStatus: "success", lastSyncedAt: new Date(), isRunning: false });
      await seed([0, 1, 2, 5, 6, 7, 8, 9]);
      const cpBefore = await checkpointSnapshot();

      const rec = await recover(makeTally(all), { apply: true });
      check("recovery also fills vouchers beyond the checkpoint that are missing from Mongo (7 missing here: 3, 4 and 10-14)", rec.found === 7 && rec.recovered === 7 && (await count()) === 15, JSON.stringify(rec));
      check("checkpoint still exactly as the worker left it", (await checkpointSnapshot()) === cpBefore);

      // Fresh scenario for the worker: recovery for old gaps, then a normal tick for genuinely new vouchers.
      await cleanup();
      await SyncCheckpoint.create({ tenantId: T1, companyGuid: G1, voucherType: "Purchase", lastAlterId: alterOf(9), lastRunStatus: "success", lastSyncedAt: new Date(), isRunning: false });
      await seed([0, 1, 2, 5, 6, 7, 8, 9]);
      const oldOnly = makeTally(range(10)); // Tally as of the gap: vouchers 0..9
      const rec2 = await recover(oldOnly, { apply: true });
      check("recovery fills just the 2 old gaps", rec2.recovered === 2 && (await count()) === 10);

      const backlog = all.map((v) => ({ i: v.i, alter: alterOf(v.i) }));
      const workerCalls = { probe: 0, heavy: [] };
      const mod = {
        voucherType: "Purchase",
        classificationKey: "purchase",
        processVoucher: processSinglePurchaseVoucher,
        fetchPendingAlterIds: async (a) => {
          workerCalls.probe += 1;
          return { data: { collection: backlog.filter((b) => b.alter > a.afterAlterId).map((b) => ({ alterid: String(b.alter) })) } };
        },
        fetchVouchersSinceAlterId: async (a) => {
          workerCalls.heavy.push(a);
          return { data: { collection: backlog.filter((b) => b.alter > a.afterAlterId && (a.upToAlterId === undefined || b.alter <= a.upToAlterId)).map((b) => rawVoucher(b.i)) } };
        },
      };
      const w = await runSyncForCompanyModule(company1, mod, { intervalSeconds: 60, batchSize: 100 });
      const cpAfter = await SyncCheckpoint.findOne({ tenantId: T1, companyGuid: G1, voucherType: "Purchase" }).lean();
      check("the incremental tick still works normally after a recovery: fetches only vouchers beyond its checkpoint", w.processed === 5 && w.created === 5 && workerCalls.heavy[0].afterAlterId === alterOf(9), JSON.stringify(w));
      check("...and advances its own checkpoint as usual, releasing its lock", cpAfter.lastAlterId === alterOf(14) && cpAfter.lastRunStatus === "success" && cpAfter.isRunning === false);
      check("total documents = 15, no duplicates from either mechanism", (await count()) === 15 && new Set(await guidsOf()).size === 15);
    }

    console.log("\n=== API: POST /api/sync/recovery contract (controller, stub Tally) ===");
    await cleanup();
    await Company.deleteMany({ companyGuid: { $in: [G1, G2] } });
    try {
      await Company.create({ companyName: "Verify Recovery Co", sourceType: "tally", companyGuid: G1, tenantId: T1, isActive: true, tallyConnection: { baseUrl: stub.url } });
      await Company.create({ companyName: "Verify Recovery Other", sourceType: "tally", companyGuid: G2, tenantId: T2, isActive: true, tallyConnection: { baseUrl: stub.url } });
      const call = async (user, body) => {
        let out = { status: null, body: null };
        const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
        await runVoucherRecovery({ user, body }, res);
        return out;
      };
      check("no company in the token -> 401", (await call({}, { voucherType: "Sales" })).status === 401);
      check("unknown voucherType -> 400", (await call({ companyGuId: G1 }, { voucherType: "Journal" })).status === 400);
      check("apply must be a boolean (a truthy string is rejected) -> 400", (await call({ companyGuId: G1 }, { voucherType: "Sales", apply: "yes" })).status === 400);
      const dry = await call({ companyGuId: G1 }, { voucherType: "Sales" });
      check("omitting apply is a dry run: 200, success, nothing written", dry.status === 200 && dry.body.success === true && dry.body.data.dryRun === true && dry.body.data.status === "dry_run");
      const mism = await call({ companyGuId: G2 }, { voucherType: "Sales", apply: true });
      check("company that is not the one open in Tally -> 409 with the aborted result", mism.status === 409 && mism.body.success === false && mism.body.data.reasonCode === "company_mismatch");
      check("unknown company -> 404", (await call({ companyGuId: "no-such-company" }, { voucherType: "Sales" })).status === 404);
    } finally {
      await Company.deleteMany({ companyGuid: { $in: [G1, G2] } });
    }
  } finally {
    stub.server.close();
    await cleanup();
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  await mongoose.connection.close();
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(async (error) => {
  console.error("Voucher recovery verification crashed:", error);
  try { await cleanup(); } catch (_) {}
  try { await mongoose.connection.close(); } catch (_) {}
  process.exitCode = 1;
});
