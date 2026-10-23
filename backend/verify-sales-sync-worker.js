/**
 * Sales sync worker, end to end: runSyncForCompanyModule(company, SALES_SYNC_MODULE) with the REAL module - the real
 * odbcService fetchers (getPendingVoucherAlterIds, getSalesVouchersSinceAlterId) talking HTTP to a Tally-shaped stub on
 * 127.0.0.1, the open-company guard, voucher-type classification, batch ownership, and the real Sales persistence
 * (processSingleVoucher -> Sale). verify-sync-batching.js covers batching with injected Purchase fetchers; this suite
 * covers the Sales module itself, which no other CI suite runs (verify-sync-worker-guard.js needs a live TallyPrime).
 *
 * Ticks: first sync creates and advances the checkpoint; a quiet tick does no heavy fetch; an edited voucher (newer
 * AlterID) updates in place; another company open in Tally means nothing is fetched or written; a batch with a foreign
 * company GUID is rejected whole and the checkpoint stays put.
 *
 * Synthetic data only, isolated test database only (src/config/db.js refuses anything but a loopback
 * tallypulse_ci / tallypulse_test* database). No live Tally. Cleans up only its own records.
 *
 * Run: node verify-sales-sync-worker.js
 */

require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Sale = require("./src/models/sales.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const { runSyncForCompanyModule, SALES_SYNC_MODULE } = require("./src/services/sync/tallySyncWorker");
const { clearVoucherTypeClassificationCache } = require("./src/services/tally/voucherTypeClassifier");

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 300)})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);

const T1 = "TEST-TENANT-sales-sync-worker";
const G1 = "verify-sales-sync-worker-company";
const G_OTHER = "verify-sales-sync-worker-other-company";

// Raw-Tally-shaped Sales voucher (same shape as verify-sales-mapper.js). The GUID is "<companyGuid>-<id>", which is what
// the worker's batch-ownership check requires; the party ledger total is the voucher total.
const raw = ({ i, alter, partyAmount = "-1189", companyGuid = G1 }) => ({
  vouchernumber: `SW-${i}`,
  date: "20260905",
  partyname: "Test Customer",
  vouchertypename: "Sales",
  guid: `${companyGuid}-${i}`,
  alterid: String(alter),
  narration: "synthetic voucher",
  inventoryentries: [
    { stockitemname: "Item A", actualqty: "6", rate: "151.53", amount: "909.20" },
    { stockitemname: "Item B", actualqty: "2", rate: "50", amount: "100" },
  ],
  ledgerentries: [
    { ledgername: "Test Customer", amount: partyAmount, isdeemedpositive: "Yes" },
    { ledgername: "Sales Account", amount: "1009.20", isdeemedpositive: "No" },
    { ledgername: "CGST", amount: "89.9", isdeemedpositive: "No" },
    { ledgername: "SGST", amount: "89.9", isdeemedpositive: "No" },
  ],
});

// ---- Tally-shaped stub: answers by the request's collection ID, like verify-adjustment-note.js. The probe and the
// heavy fetch honour the AlterID window in the request's own filter, so only vouchers newer than the checkpoint return.
function startStub() {
  const state = { openCompanyGuid: G1, backlog: [], requests: {}, bodies: {} };
  const windowOf = (filter) => {
    const after = Number((/\$AlterID > (\d+)/.exec(filter) || [])[1] || 0);
    const upTo = (/\$AlterID <= (\d+)/.exec(filter) || [])[1];
    return (v) => Number(v.alterid) > after && (upTo === undefined || Number(v.alterid) <= Number(upTo));
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const id = req.headers.id;
      state.requests[id] = (state.requests[id] || 0) + 1;
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (_) {}
      state.bodies[id] = parsed;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (id === "RTS Company Guid Collection") {
        res.end(JSON.stringify({ status: "1", data: { collection: [{ name: { value: "Verify Sales Worker Co" }, guid: { value: state.openCompanyGuid } }] } }));
      } else if (id === "RTS VoucherType Master Collection") {
        res.end(JSON.stringify({
          status: "1",
          data: { collection: [
            { metadata: { name: "Sales", reservedname: "Sales" }, parent: { value: "Sales" }, guid: { value: `${G1}-vt1` } },
            { metadata: { name: "Purchase", reservedname: "Purchase" }, parent: { value: "Purchase" }, guid: { value: `${G1}-vt2` } },
          ] },
        }));
      } else if (id === "RTS Pending AlterIDs Collection" || id === "RTS Sales AlterID Collection") {
        const filter = parsed && parsed.tdlmessage[0].definitions[1].value;
        const rows = state.backlog.filter(windowOf(filter || ""));
        const collection = id === "RTS Pending AlterIDs Collection"
          ? rows.map((v) => ({ vouchertypename: "Sales", alterid: v.alterid }))
          : rows;
        res.end(JSON.stringify({ status: "1", data: { collection } }));
      } else {
        res.end(JSON.stringify({ status: "1", data: { collection: [] } }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, state }))
  );
}

const checkpoint = () => SyncCheckpoint.findOne({ tenantId: T1, companyGuid: G1, voucherType: "Sales" }).lean();
const sales = () => Sale.find({ tenantId: T1 }).sort({ tallyGuid: 1 }).lean();

async function cleanup() {
  await Sale.deleteMany({ tenantId: T1 });
  await SyncCheckpoint.deleteMany({ tenantId: T1 });
}

(async () => {
  await connectDB();
  await cleanup();
  clearVoucherTypeClassificationCache(G1);
  const stub = await startStub();
  const company = { tenantId: T1, companyGuid: G1, tallyConnection: { baseUrl: stub.url } };
  const tick = () => runSyncForCompanyModule(company, SALES_SYNC_MODULE, { intervalSeconds: 60, batchSize: 100 });
  const heavy = () => stub.state.requests["RTS Sales AlterID Collection"] || 0;
  const probes = () => stub.state.requests["RTS Pending AlterIDs Collection"] || 0;

  try {
    // ------------------------------------------------------------------ 1
    section("1. first tick: three Sales vouchers are fetched, persisted and the checkpoint advances");
    stub.state.backlog = [raw({ i: 1, alter: 1000 }), raw({ i: 2, alter: 1007, partyAmount: "-500" }), raw({ i: 3, alter: 1014 })];
    let r = await tick();
    check("result: processed 3, created 3, no failure", r.processed === 3 && r.created === 3 && r.updated === 0 && r.duplicates === 0 && r.failed === 0 && !r.error, JSON.stringify(r));
    let docs = await sales();
    check("three Sale documents exist for the tenant", docs.length === 3, `found ${docs.length}`);
    check("every document is stamped with the company's tenant and its Tally GUID", docs.every((d) => d.tenantId === T1) && docs.map((d) => d.tallyGuid).join(",") === `${G1}-1,${G1}-2,${G1}-3`, JSON.stringify(docs.map((d) => d.tallyGuid)));
    const d2 = docs.find((d) => d.tallyGuid === `${G1}-2`);
    check("mapped fields: voucher number, type, AlterID and party-ledger total", d2 && d2.header.voucherNo === "SW-2" && d2.header.voucherType === "Sales" && d2.tallyAlterId === 1007 && d2.header.voucherTotalAmount === 500 && d2.voucherStatus === "active", JSON.stringify(d2 && d2.header));
    let cp = await checkpoint();
    check("checkpoint: lastAlterId 1014, status success, lock released", cp && cp.lastAlterId === 1014 && cp.lastRunStatus === "success" && cp.isRunning === false, JSON.stringify(cp && { a: cp.lastAlterId, s: cp.lastRunStatus, r: cp.isRunning }));
    const fetchFilter = stub.state.bodies["RTS Sales AlterID Collection"].tdlmessage[0].definitions[1].value;
    check("the real Sales fetch was used, filtered from the checkpoint and on the classified type name", fetchFilter === '($AlterID > 0) AND ($VoucherTypeName = "Sales")', fetchFilter);

    // ------------------------------------------------------------------ 2
    section("2. a quiet tick: light probe only, no heavy fetch, nothing written");
    const heavyBefore = heavy();
    const probesBefore = probes();
    r = await tick();
    check("result: nothing processed", r.processed === 0 && r.created === 0 && r.failed === 0 && !r.error, JSON.stringify(r));
    check("the probe ran but the heavy voucher fetch did not", probes() === probesBefore + 1 && heavy() === heavyBefore, `probes ${probesBefore}->${probes()} heavy ${heavyBefore}->${heavy()}`);
    cp = await checkpoint();
    check("checkpoint unchanged at 1014, status success", cp.lastAlterId === 1014 && cp.lastRunStatus === "success");
    check("still three documents", (await Sale.countDocuments({ tenantId: T1 })) === 3);

    // ------------------------------------------------------------------ 3
    section("3. an edited voucher (newer AlterID) is updated in place");
    stub.state.backlog = [raw({ i: 1, alter: 1000 }), raw({ i: 2, alter: 1030, partyAmount: "-777" }), raw({ i: 3, alter: 1014 })];
    r = await tick();
    check("result: processed 1, updated 1, nothing created", r.processed === 1 && r.updated === 1 && r.created === 0 && r.failed === 0, JSON.stringify(r));
    docs = await sales();
    const d2After = docs.find((d) => d.tallyGuid === `${G1}-2`);
    check("same document, new AlterID and amount; still three documents", docs.length === 3 && d2After && String(d2After._id) === String(d2._id) && d2After.tallyAlterId === 1030 && d2After.header.voucherTotalAmount === 777, JSON.stringify(d2After && { a: d2After.tallyAlterId, t: d2After.header.voucherTotalAmount }));
    cp = await checkpoint();
    check("checkpoint advanced to 1030", cp.lastAlterId === 1030 && cp.lastRunStatus === "success");

    // ------------------------------------------------------------------ 4
    section("4. another company is open in Tally: nothing is fetched or written");
    stub.state.openCompanyGuid = G_OTHER;
    stub.state.backlog = [...stub.state.backlog, raw({ i: 4, alter: 1040 })];
    const before4 = { heavy: heavy(), probes: probes(), count: await Sale.countDocuments({ tenantId: T1 }) };
    r = await tick();
    check("result: nothing processed, not reported as an error", r.processed === 0 && r.created === 0 && r.failed === 0 && !r.error, JSON.stringify(r));
    check("no probe and no voucher fetch was sent", heavy() === before4.heavy && probes() === before4.probes, `probes ${before4.probes}->${probes()} heavy ${before4.heavy}->${heavy()}`);
    check("no document written and the checkpoint did not move", (await Sale.countDocuments({ tenantId: T1 })) === before4.count && (await checkpoint()).lastAlterId === 1030);
    stub.state.openCompanyGuid = G1;

    // ------------------------------------------------------------------ 5
    section("5. a batch carrying another company's GUID is rejected whole");
    stub.state.backlog = [raw({ i: 4, alter: 1040 }), raw({ i: 5, alter: 1041, companyGuid: G_OTHER })];
    const count5 = await Sale.countDocuments({ tenantId: T1 });
    r = await tick();
    check("result: rejected as a company mismatch with an error", r.companyMismatch === true && !!r.error && r.created === 0, JSON.stringify(r));
    check("zero documents written (not even the valid voucher in the same batch)", (await Sale.countDocuments({ tenantId: T1 })) === count5 && !(await Sale.findOne({ tenantId: T1, tallyGuid: `${G1}-4` })));
    cp = await checkpoint();
    check("checkpoint did not advance and the tick is recorded as failed, lock released", cp.lastAlterId === 1030 && cp.lastRunStatus === "failed" && cp.isRunning === false, JSON.stringify(cp && { a: cp.lastAlterId, s: cp.lastRunStatus, r: cp.isRunning }));
  } catch (e) {
    fail += 1;
    console.log(`  FAIL - unexpected error: ${e && e.stack ? e.stack : e}`);
  } finally {
    await new Promise((resolve) => stub.server.close(resolve));
    await cleanup();
    await mongoose.connection.close();
  }
  console.log(`\nverify-sales-sync-worker: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});
