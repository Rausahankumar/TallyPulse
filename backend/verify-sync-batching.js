/**
 * Bounded incremental sync batches (batchWindow.js + tallySyncWorker.js +
 * odbcService AlterID window).
 *
 * Problem this guards against: a large backlog made the worker request
 * EVERY pending voucher (with inventory/ledger detail) in one Tally call,
 * which timed out, never advanced the checkpoint, and repeated every tick,
 * keeping Tally busy. Each tick must now request a bounded slice, advance
 * the checkpoint only after the whole slice persists, and drain the rest
 * over later ticks.
 *
 * Fully offline and deterministic - NO live Tally queries: a tiny local
 * stub answers the company-GUID guard and the VoucherType master
 * (classification), and the Tally fetch functions are substituted mocks.
 * Everything else is real: the worker, lock, checkpoint, parser, mapper,
 * persistence and MongoDB, under isolated synthetic tenants that are
 * cleaned up at the start, the end, and on crash.
 *
 * Sections: UNIT (batch math), QUERY (odbcService request bodies against
 * the stub), WORKER (drain / small backlog / failure / probe failure /
 * lock / multi-company / legacy module), MASTERS (the slow, per-company
 * Stock Item + Ledger master refresh that runs BEFORE the voucher modules:
 * when it is due, the open-company guard, one request at a time, retry
 * after a failure, never throws, runs inside the all-companies tick).
 *
 * Run: node verify-sync-batching.js
 */

require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Purchase = require("./src/models/purchase.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const { computeBatchWindow, resolveBatchSize, findMissingAlterIds, DEFAULT_BATCH_SIZE } = require("./src/services/sync/batchWindow");
const { runSyncForCompanyModule, runSyncForAllCompanies, runMasterRefreshForCompany, resolveMasterRefreshMs } = require("./src/services/sync/tallySyncWorker");
const Company = require("./src/models/company");
const { processSinglePurchaseVoucher } = require("./src/services/import/tallyPurchaseImport");
const {
  getSalesVouchersSinceAlterId,
  getPendingVoucherAlterIds,
} = require("./src/services/odbc/odbcService");
const { clearVoucherTypeClassificationCache } = require("./src/services/tally/voucherTypeClassifier");

const T1 = "verify-batching-tenant";
const G1 = "verify-batching-company-guid";
const T2 = "verify-batching-other-tenant";
const G2 = "verify-batching-other-company-guid";

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

// ---- stub Tally: guard + classification only; records the last request body per collection ID ----
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
        res.end(JSON.stringify({ status: "1", data: { collection: [{ name: { value: "Verify Batching Co" }, guid: { value: G1 } }] } }));
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
function rawVoucher(i, alter, { party = "Verify Vendor" } = {}) {
  return {
    vouchernumber: `VERIFY-BATCH-${i}`,
    date: "20260905",
    partyname: party,
    vouchertypename: "Purchase",
    guid: `${G1}-${i}`,
    alterid: String(alter),
    ledgerentries: [
      { ledgername: "Purchase AC", amount: "100.00", isdeemedpositive: true },
      { ledgername: party || "x", amount: "-100.00", isdeemedpositive: false },
    ],
  };
}

// Non-contiguous AlterIDs (real AlterIDs are shared across every object type).
function makeBacklog(n) {
  return Array.from({ length: n }, (_, i) => ({ i, alter: 1000 + i * 7 }));
}

function makeModule(backlog, overrides = {}) {
  const calls = { probe: [], heavy: [] };
  const badParty = overrides.badParty || new Set();
  const mod = {
    voucherType: "Purchase",
    classificationKey: "purchase",
    processVoucher: processSinglePurchaseVoucher,
    fetchPendingAlterIds: async (args) => {
      calls.probe.push(args);
      if (overrides.probeThrows) throw new Error("probe timeout simulated");
      const rows = backlog.filter((b) => b.alter > args.afterAlterId);
      if (overrides.probeNoAlterIds) return { data: { collection: rows.map(() => ({ vouchertypename: "Purchase" })) } };
      return { data: { collection: rows.map((b) => ({ vouchertypename: "Purchase", alterid: String(b.alter) })) } };
    },
    fetchVouchersSinceAlterId: async (args) => {
      calls.heavy.push(args);
      const drop = overrides.drop || new Set();
      const rows = backlog.filter(
        (b) => b.alter > args.afterAlterId && (args.upToAlterId === undefined || b.alter <= args.upToAlterId) && !drop.has(b.alter)
      );
      // "extra": vouchers Tally returns that the probe did not list (e.g. created after the probe).
      rows.push(...(overrides.extra || []));
      return { data: { collection: rows.map((b) => rawVoucher(b.i, b.alter, { party: badParty.has(b.i) ? "" : "Verify Vendor" })) } };
    },
  };
  if (overrides.legacy) delete mod.fetchPendingAlterIds;
  return { mod, calls };
}

const checkpointOf = (tenantId, guid) =>
  SyncCheckpoint.findOne({ tenantId, companyGuid: guid, voucherType: "Purchase" }).lean();

async function cleanup() {
  for (const t of [T1, T2]) {
    await Purchase.deleteMany({ tenantId: t });
    await SyncCheckpoint.deleteMany({ tenantId: t });
  }
}

// ==================== UNIT ====================
function unitTests() {
  console.log("\n=== UNIT: computeBatchWindow / resolveBatchSize ===");
  const w0 = computeBatchWindow([], 100);
  check("empty backlog -> pending 0, unbounded", w0.pending === 0 && !w0.bounded && w0.upToAlterId === null);

  const w1 = computeBatchWindow([5, 3, 9], 100);
  check("small backlog -> unbounded, no cap (fetched exactly as before)", !w1.bounded && w1.upToAlterId === null && w1.batchCount === 3);

  const ids100 = Array.from({ length: 100 }, (_, i) => 10 + i);
  check("backlog exactly == batchSize -> unbounded", !computeBatchWindow(ids100, 100).bounded);

  const w2 = computeBatchWindow([...ids100, 500], 100);
  check("backlog = batchSize+1 -> bounded, cut-off is the 100th smallest", w2.bounded && w2.upToAlterId === 109 && w2.batchCount === 100 && w2.pending === 101, JSON.stringify(w2));

  const w3 = computeBatchWindow([50, 10, 40, 20, 30], 2);
  check("unsorted input is sorted before cutting", w3.bounded && w3.upToAlterId === 20 && w3.batchCount === 2, JSON.stringify(w3));

  check("findMissingAlterIds: nothing missing when all expected are returned", findMissingAlterIds([3, 1, 2], [1, 2, 3]).length === 0);
  check("findMissingAlterIds: returns the missing IDs ascending", JSON.stringify(findMissingAlterIds([5, 1, 3], [1])) === "[3,5]");
  check("findMissingAlterIds: a superset (extra returned IDs) is allowed", findMissingAlterIds([1, 2], [1, 2, 99]).length === 0);
  check("findMissingAlterIds: empty expectation is trivially complete", findMissingAlterIds([], [7]).length === 0);

  check("resolveBatchSize accepts a positive integer", resolveBatchSize("25") === 25);
  check(
    "resolveBatchSize rejects 0 / negative / non-integer / junk / undefined -> default (bounding can't be disabled)",
    [0, -5, 2.5, "abc", undefined, null].every((v) => resolveBatchSize(v) === DEFAULT_BATCH_SIZE)
  );
}

// ==================== QUERY ====================
async function queryTests(stub) {
  console.log("\n=== QUERY: AlterID window + light probe request bodies (offline stub) ===");
  const filterOf = (id) => stub.recorded[id].tdlmessage[0].definitions[1].value;

  await getSalesVouchersSinceAlterId({ afterAlterId: 5, baseUrl: stub.url, voucherTypeNames: ["Sales"] });
  check(
    "no cap -> identical to the pre-existing incremental filter",
    filterOf("RTS Sales AlterID Collection") === '($AlterID > 5) AND ($VoucherTypeName = "Sales")',
    filterOf("RTS Sales AlterID Collection")
  );

  await getSalesVouchersSinceAlterId({ afterAlterId: 5, upToAlterId: 50, baseUrl: stub.url, voucherTypeNames: ["Sales", "Invoice"] });
  check(
    "cap -> (AlterID > after) AND (AlterID <= upTo) AND (type names), one explicit formula",
    filterOf("RTS Sales AlterID Collection") === '($AlterID > 5) AND ($AlterID <= 50) AND ($VoucherTypeName = "Sales" OR $VoucherTypeName = "Invoice")',
    filterOf("RTS Sales AlterID Collection")
  );

  let threw = "";
  try { await getSalesVouchersSinceAlterId({ afterAlterId: 10, upToAlterId: 10, baseUrl: stub.url, voucherTypeNames: ["Sales"] }); } catch (e) { threw = e.message; }
  check("cap <= after is rejected (no empty/inverted window)", /Invalid AlterID window/.test(threw), threw);

  await getPendingVoucherAlterIds({ afterAlterId: 7, baseUrl: stub.url, voucherTypeNames: ["Purchase"] });
  const probeBody = stub.recorded["RTS Pending AlterIDs Collection"];
  check(
    "probe is light: only VoucherTypeName + AlterID, no inventory/ledger walk",
    probeBody.tdlmessage[0].definitions[0].attributes.some((a) => a["Native Method"] === "VoucherTypeName, AlterID") &&
      !JSON.stringify(probeBody).includes("inventoryentries")
  );
  check("probe filters on AlterID and the resolved type names", filterOf("RTS Pending AlterIDs Collection") === '($AlterID > 7) AND ($VoucherTypeName = "Purchase")');
}

// ==================== WORKER ====================
async function workerTests(stub) {
  const company = { tenantId: T1, companyGuid: G1, tallyConnection: { baseUrl: stub.url } };
  const run = (mod, opts = {}) => runSyncForCompanyModule(company, mod, { intervalSeconds: 60, batchSize: 100, ...opts });

  console.log("\n=== WORKER: large backlog drains in bounded batches ===");
  await cleanup();
  clearVoucherTypeClassificationCache(G1);
  {
    const backlog = makeBacklog(250);
    const { mod, calls } = makeModule(backlog);
    const sortedAlters = backlog.map((b) => b.alter);

    const r1 = await run(mod);
    const cp1 = await checkpointOf(T1, G1);
    check("tick 1: exactly one bounded fetch capped at the 100th AlterID", calls.heavy.length === 1 && calls.heavy[0].upToAlterId === sortedAlters[99], JSON.stringify(calls.heavy));
    check("tick 1: processed 100 of 250 pending, all created", r1.processed === 100 && r1.created === 100 && r1.pendingTotal === 250, JSON.stringify(r1));
    check("tick 1: checkpoint advanced to the cut-off only", cp1.lastAlterId === sortedAlters[99] && cp1.lastRunStatus === "success" && cp1.isRunning === false, JSON.stringify(cp1));

    const r2 = await run(mod);
    const cp2 = await checkpointOf(T1, G1);
    check("tick 2: next slice starts after the checkpoint, capped at the 200th AlterID", calls.heavy[1].afterAlterId === sortedAlters[99] && calls.heavy[1].upToAlterId === sortedAlters[199]);
    check("tick 2: processed 100, checkpoint at the 200th AlterID", r2.processed === 100 && cp2.lastAlterId === sortedAlters[199]);

    const r3 = await run(mod);
    const cp3 = await checkpointOf(T1, G1);
    check("tick 3: remaining 50 fit one batch -> fetched with no cap (legacy shape)", calls.heavy[2].upToAlterId === undefined && r3.processed === 50);
    check("tick 3: checkpoint at the newest AlterID", cp3.lastAlterId === sortedAlters[249]);

    const before = calls.heavy.length;
    const r4 = await run(mod);
    check("tick 4 (caught up): light probe only, NO heavy fetch, success", calls.heavy.length === before && r4.processed === 0 && !r4.error);

    check("no fetch ever requested more than batchSize vouchers", [r1, r2, r3].every((r) => r.processed <= 100));
    check("all 250 vouchers persisted exactly once, none lost", (await Purchase.countDocuments({ tenantId: T1 })) === 250);
    check("the heavy fetch was never asked for the whole backlog at once", calls.heavy.every((c) => c.upToAlterId !== undefined || c.afterAlterId >= sortedAlters[199]));
  }

  console.log("\n=== WORKER: small / boundary backlog behaves exactly as before ===");
  await cleanup();
  {
    const { mod, calls } = makeModule(makeBacklog(30));
    const r = await run(mod);
    const cp = await checkpointOf(T1, G1);
    check("30 pending <= batchSize: single unbounded fetch (no cap)", calls.heavy.length === 1 && calls.heavy[0].upToAlterId === undefined && r.processed === 30);
    check("checkpoint advances to the newest AlterID", cp.lastAlterId === 1000 + 29 * 7);
  }
  await cleanup();
  {
    const { mod, calls } = makeModule(makeBacklog(100));
    const r = await run(mod);
    check("exactly batchSize pending: still unbounded, one fetch", calls.heavy.length === 1 && calls.heavy[0].upToAlterId === undefined && r.processed === 100);
  }

  console.log("\n=== WORKER: failed batch leaves the checkpoint unchanged; retry succeeds ===");
  await cleanup();
  {
    const backlog = makeBacklog(5);
    const bad = new Set([2]);
    const { mod: badMod, calls: badCalls } = makeModule(backlog, { badParty: bad });
    const r1 = await run(badMod, { batchSize: 3 }); // first batch = vouchers 0,1,2 (2 is bad)
    const cp1 = await checkpointOf(T1, G1);
    check("batch with one unmappable voucher reports failed=1", r1.failed === 1 && r1.processed === 3, JSON.stringify(r1));
    check("checkpoint NOT advanced, status failed, lock released", cp1.lastAlterId === 0 && cp1.lastRunStatus === "failed" && cp1.isRunning === false, JSON.stringify(cp1));
    check("vouchers persisted before the failure are kept (idempotent upsert)", (await Purchase.countDocuments({ tenantId: T1 })) === 2);

    const { mod: goodMod } = makeModule(backlog); // source data corrected
    const r2 = await run(goodMod, { batchSize: 3 });
    const cp2 = await checkpointOf(T1, G1);
    check("retry re-fetches the SAME slice: earlier ones are duplicates, the fixed one is created", r2.duplicates === 2 && r2.created === 1 && r2.failed === 0, JSON.stringify(r2));
    check("checkpoint now advances to the cut-off", cp2.lastAlterId === 1000 + 2 * 7 && cp2.lastRunStatus === "success");
  }

  console.log("\n=== WORKER: fetch completeness - complete bounded batch advances ===");
  await cleanup();
  {
    const backlog = makeBacklog(250);
    const { mod } = makeModule(backlog);
    const r = await run(mod);
    const cp = await checkpointOf(T1, G1);
    check("every probed AlterID in the window returned -> batch persisted and checkpoint advanced to the cut-off", r.processed === 100 && r.failed === 0 && !r.error && cp.lastAlterId === backlog[99].alter);
  }

  console.log("\n=== WORKER: fetch completeness - missing AlterID fails the batch, then retry succeeds ===");
  await cleanup();
  {
    const backlog = makeBacklog(250);
    const drop = new Set([backlog[42].alter]);
    const { mod: shortMod, calls } = makeModule(backlog, { drop });

    const r1 = await run(shortMod);
    const cp1 = await checkpointOf(T1, G1);
    check("bounded batch missing one probed AlterID -> tick fails with an incomplete-fetch error", /Incomplete Tally fetch: 1 of 100 expected/.test(r1.error || "") && r1.processed === 0, JSON.stringify(r1));
    check("checkpoint NOT advanced, status failed, lock released", cp1.lastAlterId === 0 && cp1.lastRunStatus === "failed" && cp1.isRunning === false, JSON.stringify(cp1));
    check("error message is recorded on the checkpoint", /Incomplete Tally fetch/.test(cp1.lastError || ""));
    check("nothing was persisted from the incomplete response (fails before any write)", (await Purchase.countDocuments({ tenantId: T1 })) === 0);

    drop.clear(); // Tally now returns the full window (partial response / edit race resolved)
    const r2 = await run(shortMod);
    const cp2 = await checkpointOf(T1, G1);
    check("retry fetches the same window again", calls.heavy.length === 2 && calls.heavy[1].afterAlterId === 0 && calls.heavy[1].upToAlterId === backlog[99].alter, JSON.stringify(calls.heavy));
    check("retry now complete: 100 created, checkpoint advanced, status success", r2.created === 100 && r2.failed === 0 && cp2.lastAlterId === backlog[99].alter && cp2.lastRunStatus === "success");
    const r3 = await run(shortMod);
    check("next tick continues with the following window (no vouchers skipped or repeated)", r3.processed === 100 && r3.created === 100 && (await Purchase.countDocuments({ tenantId: T1 })) === 200);
    check("the previously missing voucher was imported once the response was complete", !!(await Purchase.findOne({ tenantId: T1, tallyGuid: `${G1}-${backlog[42].i}` })));
  }

  console.log("\n=== WORKER: fetch completeness - small (unbounded) batch, empty response, superset ===");
  await cleanup();
  {
    const backlog = makeBacklog(30);
    const { mod } = makeModule(backlog, { drop: new Set([backlog[29].alter]) }); // newest one missing
    const r = await run(mod);
    const cp = await checkpointOf(T1, G1);
    check("small backlog missing its NEWEST AlterID -> fails, checkpoint not advanced past it", /Incomplete Tally fetch: 1 of 30/.test(r.error || "") && cp.lastAlterId === 0 && (await Purchase.countDocuments({ tenantId: T1 })) === 0, JSON.stringify(r));
  }
  await cleanup();
  {
    const backlog = makeBacklog(5);
    const { mod } = makeModule(backlog, { drop: new Set(backlog.map((b) => b.alter)) }); // probe lists 5, fetch returns none
    const r = await run(mod);
    const cp = await checkpointOf(T1, G1);
    check("probe lists pending vouchers but the fetch returns none -> fails (not a quiet 'nothing changed' success)", /Incomplete Tally fetch: 5 of 5/.test(r.error || "") && cp.lastRunStatus === "failed" && cp.lastAlterId === 0, JSON.stringify(r));
  }
  await cleanup();
  {
    const { mod } = makeModule(makeBacklog(10), { extra: [{ i: 500, alter: 99999 }] }); // created after the probe: returned, not probed
    const r = await run(mod);
    const cp = await checkpointOf(T1, G1);
    check("a superset (extra newer voucher not in the probe) is allowed and imported", r.processed === 11 && !r.error && cp.lastAlterId === 99999 && cp.lastRunStatus === "success", JSON.stringify(r));
  }

  console.log("\n=== WORKER: module without a probe is not subject to the completeness check ===");
  await cleanup();
  {
    const backlog = makeBacklog(10);
    const { mod } = makeModule(backlog, { legacy: true, drop: new Set([backlog[9].alter]) });
    const r = await run(mod);
    check("legacy (no probe) has nothing to validate against: behaves exactly as before", !r.error && r.processed === 9);
  }

  console.log("\n=== WORKER: probe failure fails closed (no unbounded fallback) ===");
  await cleanup();
  {
    const { mod, calls } = makeModule(makeBacklog(250), { probeThrows: true });
    const r = await run(mod);
    const cp = await checkpointOf(T1, G1);
    check("probe error -> tick failed with the error, checkpoint untouched, lock released", !!r.error && cp.lastAlterId === 0 && cp.lastRunStatus === "failed" && cp.isRunning === false, JSON.stringify(r));
    check("the heavy fetch was NOT attempted as a fallback", calls.heavy.length === 0);
  }
  await cleanup();
  {
    const { mod, calls } = makeModule(makeBacklog(10), { probeNoAlterIds: true });
    const r = await run(mod);
    const cp = await checkpointOf(T1, G1);
    check("probe rows without readable AlterIDs -> fail closed, no heavy fetch", !!r.error && calls.heavy.length === 0 && cp.lastRunStatus === "failed" && cp.lastAlterId === 0, JSON.stringify(r));
  }

  console.log("\n=== WORKER: nothing pending ===");
  await cleanup();
  {
    const { mod, calls } = makeModule([]);
    const r = await run(mod);
    const cp = await checkpointOf(T1, G1);
    check("empty backlog: success, no heavy fetch, checkpoint unchanged", r.processed === 0 && !r.error && calls.heavy.length === 0 && cp.lastAlterId === 0 && cp.lastRunStatus === "success");
  }

  console.log("\n=== WORKER: lock still respected ===");
  await cleanup();
  {
    await SyncCheckpoint.create({ tenantId: T1, companyGuid: G1, voucherType: "Purchase", lastAlterId: 0, isRunning: true, lockedAt: new Date() });
    const { mod, calls } = makeModule(makeBacklog(10));
    const r = await run(mod);
    check("fresh lock -> tick skipped, no Tally call at all", r.skipped === true && calls.probe.length === 0 && calls.heavy.length === 0, JSON.stringify(r));
  }

  console.log("\n=== WORKER: multi-company isolation (guard) ===");
  await cleanup();
  {
    const other = { tenantId: T2, companyGuid: G2, tallyConnection: { baseUrl: stub.url } }; // stub reports G1 as the open company
    const { mod, calls } = makeModule(makeBacklog(10));
    const r = await runSyncForCompanyModule(other, mod, { intervalSeconds: 60, batchSize: 100 });
    check("company that is not the open Tally company: nothing probed, fetched or imported", r.processed === 0 && calls.probe.length === 0 && calls.heavy.length === 0 && (await Purchase.countDocuments({ tenantId: T2 })) === 0);
    const cp = await checkpointOf(T2, G2);
    check("its checkpoint is untouched (quiet success, lastAlterId 0)", cp.lastAlterId === 0 && cp.lastRunStatus === "success");
    check("the other tenant's data is unaffected", (await Purchase.countDocuments({ tenantId: T1 })) === 0);
  }

  console.log("\n=== WORKER: module without a probe (legacy shape) is unbounded, unchanged ===");
  await cleanup();
  {
    const { mod, calls } = makeModule(makeBacklog(250), { legacy: true });
    const r = await run(mod);
    check("no probe function -> single unbounded fetch of the whole backlog, as before", calls.heavy.length === 1 && calls.heavy[0].upToAlterId === undefined && r.processed === 250);
  }
}

// ==================== MASTERS ====================
// Stock Item + Ledger masters are refreshed by the same worker, per company, on a slow cadence, BEFORE that company's voucher modules.
async function masterTests(stub) {
  const H = 3600 * 1000;
  const MIN = 60 * 1000;
  const T0 = 1_800_000_000_000; // an arbitrary fixed "now"
  let seq = 0;
  // port 9: nothing may ever be sent there, the Tally calls below are injected. A fresh company per scenario (the schedule is per company GUID).
  const mkCompany = () => ({ tenantId: `verify-masters-tenant-${++seq}`, companyGuid: `verify-masters-guid-${seq}`, tallyConnection: { baseUrl: "http://127.0.0.1:9" } });
  const scenario = (o = {}) => {
    const log = [];
    const stockArgs = [];
    const ledgerArgs = [];
    const noteArgs = [];
    const deps = {
      verifyCompany: async () => { log.push("guard"); return o.guard || { ok: true, reason: "ok" }; },
      refreshStockItems: async (p) => { log.push("stock"); stockArgs.push(p); if (o.stockThrows) throw new Error("boom stock"); return o.stock || { ok: true, totalFetched: 3, written: 1, unchanged: 2 }; },
      refreshLedgers: async (p) => { log.push("ledgers"); ledgerArgs.push(p); return o.ledgers || { ok: true, totalFetched: 4, written: 0, removed: 0, unchanged: true }; },
      reclassifyNotes: async (p) => { log.push("notes"); noteArgs.push(p); if (o.notesThrows) throw new Error("boom notes"); return o.notes || { ok: true, scanned: 150, upgrades: 0 }; },
    };
    return { log, stockArgs, ledgerArgs, noteArgs, deps };
  };
  const go = (company, s, at, extra = {}) => runMasterRefreshForCompany(company, { now: T0 + at, intervalMs: 6 * H, deps: s.deps, ...extra });

  console.log("\n=== MASTERS: when a refresh is due, and what it asks Tally ===");
  {
    const c = mkCompany();
    const s = scenario();
    const r = await go(c, s, 0);
    check("the first tick refreshes both masters, one request at a time, in order: guard, Stock Items, Ledgers, then the note re-check", r.ok === true && s.log.join(",") === "guard,stock,ledgers,notes", s.log.join(","));
    const url = c.tallyConnection.baseUrl;
    check("each refresh gets this company's own tenantId, GUID and Tally URL; Stock Item GST history is NOT part of it",
      JSON.stringify([s.stockArgs[0], s.ledgerArgs[0]]) === JSON.stringify([{ tenantId: c.tenantId, companyGuid: c.companyGuid, baseUrl: url, includeGst: false }, { tenantId: c.tenantId, companyGuid: c.companyGuid, baseUrl: url }]));
    const r2 = await go(c, s, 1 * H);
    check("one hour later nothing is due: no request at all", r2.skipped === true && r2.reason === "not_due" && s.log.length === 4);
    const r3 = await go(c, s, 6 * H - 1);
    check("still not due one millisecond before the 6th hour", r3.skipped === true && s.log.length === 4);
    const r4 = await go(c, s, 6 * H);
    check("due again at 6 hours", r4.ok === true && s.log.length === 8);
    const r5 = await go(c, s, 6 * H + MIN, { force: true });
    check("force refreshes even when it is not due", r5.ok === true && s.log.length === 12);
  }

  console.log("\n=== MASTERS: the open-company guard ===");
  {
    const c = mkCompany();
    const mismatch = scenario({ guard: { ok: false, reason: "mismatch" } });
    const r = await go(c, mismatch, 0);
    check("another company open in Tally: nothing is requested, skipped", r.skipped === true && r.reason === "mismatch" && mismatch.log.join(",") === "guard");
    const r2 = await go(c, scenario(), 1 * MIN);
    check("...and it stays due: the next tick that finds the right company open refreshes at once", r2.ok === true);
    const down = scenario({ guard: { ok: false, reason: "unreachable" } });
    const r3 = await go(mkCompany(), down, 0);
    check("Tally unreachable: skipped, no master request", r3.skipped === true && r3.reason === "unreachable" && down.log.join(",") === "guard");
  }

  console.log("\n=== MASTERS: failures never escape and retry soon, not on every tick ===");
  {
    const c = mkCompany();
    const s = scenario({ stock: { ok: false, reason: "Tally returned zero Stock Items" } });
    const r = await go(c, s, 0);
    check("a failed Stock Item refresh is reported, and the Ledger refresh still gets its turn", r.ok === false && s.log.join(",") === "guard,stock,ledgers", s.log.join(","));
    const r2 = await go(c, s, 29 * MIN);
    check("after a failure the retry waits 30 minutes (not every 60 s tick)", r2.skipped === true && r2.reason === "not_due" && s.log.length === 3);
    const r3 = await go(c, s, 31 * MIN);
    check("...and tries again after that", r3.ok === false && s.log.length === 6);
    check("a failed Ledger refresh also counts as a failure", (await go(mkCompany(), scenario({ ledgers: { ok: false, reason: "Refusing refresh" } }), 0)).ok === false);

    const t = mkCompany();
    const st = scenario({ stockThrows: true });
    const rt = await go(t, st, 0);
    check("an exception inside a refresh never escapes: it is reported (ok false, with its message)", rt.ok === false && /boom stock/.test(rt.error) && st.log.join(",") === "guard,stock", JSON.stringify(rt));
    const early = await go(t, st, 20 * MIN);
    const later = await go(t, st, 31 * MIN);
    check("...and is retried after 30 minutes", early.skipped === true && later.ok === false && st.log.length === 4);

    const q = mkCompany();
    const sq = scenario({ stock: { ok: false, reason: "x" } });
    await go(q, sq, 0, { intervalMs: 10 * MIN });
    const a = await go(q, sq, 9 * MIN, { intervalMs: 10 * MIN });
    const b = await go(q, sq, 11 * MIN, { intervalMs: 10 * MIN });
    check("the retry delay never exceeds a short refresh interval (10 min interval: not due at 9, due at 11)", a.skipped === true && b.ok === false);
  }

  console.log("\n=== MASTERS: the Credit/Debit Note re-check after a good refresh ===");
  {
    const c = mkCompany();
    const s = scenario();
    const r = await go(c, s, 0);
    check("once both masters are good the note re-check runs once, for this tenant, and may write", r.ok === true && s.log.join(",") === "guard,stock,ledgers,notes" && JSON.stringify(s.noteArgs) === JSON.stringify([{ tenantId: c.tenantId, apply: true }]), s.log.join(","));
    check("its result is returned with the refresh", r.notes && r.notes.ok === true && r.notes.scanned === 150);
    const badLedgers = scenario({ ledgers: { ok: false, reason: "x" } });
    await go(mkCompany(), badLedgers, 0);
    const badStock = scenario({ stock: { ok: false, reason: "x" } });
    await go(mkCompany(), badStock, 0);
    check("the re-check is NOT run when a master refresh failed (it must only trust a known-good Ledger master)", badLedgers.log.join(",") === "guard,stock,ledgers" && badStock.log.join(",") === "guard,stock,ledgers");

    const t = mkCompany();
    const thrown = scenario({ notesThrows: true });
    const rt = await go(t, thrown, 0);
    check("an exception in the note re-check does not turn the master refresh into a failure; it is reported", rt.ok === true && rt.notes.ok === false && /boom notes/.test(rt.notes.reason), JSON.stringify(rt.notes));
    const early = await go(t, thrown, 20 * MIN);
    const later = await go(t, thrown, 31 * MIN);
    check("...and the re-check is retried after 30 minutes, not after the full 6 hours", early.skipped === true && later.ok === true && thrown.log.filter((x) => x === "notes").length === 2);

    const t2 = mkCompany();
    const reported = scenario({ notes: { ok: false, reason: "db busy" } });
    await go(t2, reported, 0);
    check("a re-check that reports ok false is also retried after 30 minutes", (await go(t2, reported, 29 * MIN)).skipped === true && (await go(t2, reported, 31 * MIN)).ok === true);

    const t3 = mkCompany();
    const fine = scenario();
    await go(t3, fine, 0);
    check("a successful re-check keeps the normal 6 hour schedule", (await go(t3, fine, 2 * H)).skipped === true && (await go(t3, fine, 6 * H)).ok === true);
  }

  console.log("\n=== MASTERS: switching it off, and the setting ===");
  {
    const s = scenario();
    const r = await go(mkCompany(), s, 0, { intervalMs: 0 });
    check("interval 0 switches the periodic refresh off: no request", r.skipped === true && r.reason === "disabled" && s.log.length === 0);
    check("TALLY_MASTER_REFRESH_HOURS: default 6 h, 0 = off, fractions allowed, junk and negatives fall back to the default",
      JSON.stringify([resolveMasterRefreshMs(undefined), resolveMasterRefreshMs(""), resolveMasterRefreshMs("0"), resolveMasterRefreshMs("1.5"), resolveMasterRefreshMs("abc"), resolveMasterRefreshMs("-3")]),
      JSON.stringify([6 * H, 6 * H, 0, 1.5 * H, 6 * H, 6 * H]));
  }

  console.log("\n=== MASTERS: inside the all-companies tick ===");
  await Company.deleteMany({ companyGuid: { $in: [G1, G2] } });
  await Company.create([
    { companyName: "Verify Masters A", companyGuid: G1, tenantId: T1, tallyConnection: { baseUrl: stub.url } },
    { companyName: "Verify Masters B", companyGuid: G2, tenantId: T2, tallyConnection: { baseUrl: stub.url } },
  ]);
  try {
    await cleanup();
    clearVoucherTypeClassificationCache(G1);
    const order = [];
    const seen = [];
    let active = 0;
    let maxActive = 0;
    const { mod } = makeModule(makeBacklog(3));
    const orderedMod = { ...mod, fetchVouchersSinceAlterId: async (a) => { order.push("vouchers"); return mod.fetchVouchersSinceAlterId(a); } };
    const masterRefresh = async (company) => {
      if (company.companyGuid !== G1 && company.companyGuid !== G2) return { skipped: true }; // a company left by another suite: not ours
      order.push(`masters:${company.companyGuid}`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      seen.push(company.companyGuid);
      if (company.companyGuid === G1) throw new Error("master refresh exploded");
      return { ok: true, stockItems: { totalFetched: 1, written: 0, unchanged: 1 }, ledgers: { totalFetched: 1, written: 0, removed: 0, unchanged: true } };
    };
    await runSyncForAllCompanies({ intervalSeconds: 60, modules: [orderedMod], masterRefresh });
    check("a company's masters are refreshed BEFORE its vouchers (a Credit/Debit Note is classified from the Ledger master when it is stored)", order.indexOf(`masters:${G1}`) >= 0 && order.indexOf(`masters:${G1}`) < order.indexOf("vouchers"), order.join(","));
    check("the voucher sync of the open company still ran and stored its vouchers although its master step threw", (await Purchase.countDocuments({ tenantId: T1 })) === 3);
    check("every active company gets its master step, even after the first company's refresh threw", seen.includes(G1) && seen.includes(G2), seen.join(","));
    check("one company at a time: never two master refreshes at once", maxActive === 1, String(maxActive));
    const again = [];
    await runSyncForAllCompanies({ intervalSeconds: 60, modules: [], masterRefresh: async (c) => { if (c.companyGuid === G1 || c.companyGuid === G2) again.push(c.companyGuid); return { skipped: true }; } });
    check("an exception in the master step does not wedge the worker: the next tick still runs", again.length === 2, again.join(","));

    // the real wiring (no injected master step): the open company's Stock Items, then Ledgers and Groups are requested; GST history is not
    for (const id of ["RTS StockItem Master Collection", "RTS Ledger Master Collection", "RTS Group Master Collection", "RTS StockItem GST Collection"]) delete stub.recorded[id];
    await runSyncForAllCompanies({ intervalSeconds: 60, modules: [] });
    check("default wiring: the real refresh asks Tally for Stock Items, Ledgers and Groups of the open company", ["RTS StockItem Master Collection", "RTS Ledger Master Collection", "RTS Group Master Collection"].every((id) => stub.recorded[id]), Object.keys(stub.recorded).join(" | "));
    check("default wiring: Stock Item GST history is not requested by the periodic refresh", stub.recorded["RTS StockItem GST Collection"] === undefined);
  } finally {
    await Company.deleteMany({ companyGuid: { $in: [G1, G2] } });
    await cleanup();
  }
}

async function main() {
  await connectDB();
  await cleanup();
  const stub = await startStub();
  try {
    unitTests();
    await queryTests(stub);
    await workerTests(stub);
    await masterTests(stub);
  } finally {
    stub.server.close();
    await cleanup();
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  await mongoose.connection.close();
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(async (error) => {
  console.error("Sync batching verification crashed:", error);
  try { await cleanup(); } catch (_) {}
  try { await mongoose.connection.close(); } catch (_) {}
  process.exitCode = 1;
});
