/**
 * Historical-deletion behavior of the EXISTING reconciliation
 * (reconciliation.js + reconciliationWorker.js), end to end.
 *
 * Scenario: a voucher synced a month ago is later deleted in Tally. The
 * incremental AlterID checkpoint is far ahead, so incremental sync never sees
 * the deletion. Reconciliation must catch it:
 *   Tally current GUID registry -> compare with Mongo active GUIDs ->
 *   missing -> mark deleted (never physically removed) -> analytics excludes it
 * without touching the incremental SyncCheckpoint.
 *
 * Fully offline: a local stub answers only the VoucherType master
 * (classification); the Tally GUID fetch is a substituted mock. The worker,
 * classification, persistence, MongoDB and analytics are real, under isolated
 * synthetic tenants cleaned up at start, end and on crash. No live Tally.
 *
 * Run: node verify-reconciliation-history.js
 */

require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const ReconciliationCheckpoint = require("./src/models/reconciliationCheckpoint.model");
const { runReconciliationForCompanyModule } = require("./src/services/sync/reconciliationWorker");
const { recoverMissingVouchers } = require("./src/services/sync/voucherRecovery");
const { processSingleVoucher } = require("./src/services/import/tallySalesImport");
const { processSinglePurchaseVoucher } = require("./src/services/import/tallyPurchaseImport");
const salesAnalytics = require("./src/services/analytics/salesAnalytics");
const purchaseAnalytics = require("./src/services/analytics/purchaseAnalytics");
const dateRanges = require("./src/services/analytics/dateRanges");
const { clearVoucherTypeClassificationCache } = require("./src/services/tally/voucherTypeClassifier");

const T1 = "verify-recon-hist-tenant";
const G1 = "verify-recon-hist-company-guid";
const T2 = "verify-recon-hist-other-tenant";
const G2 = "verify-recon-hist-other-company-guid";
const WIDE = dateRanges.customRange("2020-01-01", "2030-01-01");
const DAY = 24 * 60 * 60 * 1000;

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

// openGuid = the company this stub reports as open in Tally (null = none open).
function startStub(openGuid = G1) {
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
            { metadata: { name: "Sales", reservedname: "Sales" }, parent: { value: "Sales" } },
            { metadata: { name: "Purchase", reservedname: "Purchase" }, parent: { value: "Purchase" } },
          ] },
        }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

// ---- fixtures: Sales and Purchase share indexes; GUIDs are namespaced by kind ----
const KINDS = {
  Sales: {
    Model: Sale, persist: processSingleVoucher, classificationKey: "sales", analytics: () => salesAnalytics,
    summary: (t) => salesAnalytics.getSalesSummary(t, WIDE),
    guid: (i) => `verify-rh-sales-${i}`,
  },
  Purchase: {
    Model: Purchase, persist: processSinglePurchaseVoucher, classificationKey: "purchase", analytics: () => purchaseAnalytics,
    summary: (t) => purchaseAnalytics.getPurchaseSummary(t, WIDE),
    guid: (i) => `verify-rh-purchase-${i}`,
  },
};

function rawVoucher(kind, i, alter, amount = 100) {
  const party = "Verify Party";
  const own = kind === "Sales" ? "Sales" : "Purchase AC";
  return {
    vouchernumber: `VERIFY-RH-${kind}-${i}`,
    date: "20260801",
    partyname: party,
    vouchertypename: kind,
    guid: KINDS[kind].guid(i),
    alterid: String(alter),
    ledgerentries: [
      { ledgername: party, amount: String((-amount).toFixed(2)), isdeemedpositive: true },
      { ledgername: own, amount: String(amount.toFixed(2)), isdeemedpositive: false },
    ],
  };
}

// Seed n vouchers synced "a month ago" (backdated timestamps).
async function seed(kind, n, tenantId, offset = 0) {
  const k = KINDS[kind];
  for (let i = offset; i < offset + n; i += 1) await k.persist(rawVoucher(kind, i, 1000 + i), tenantId);
  const past = new Date(Date.now() - 30 * DAY);
  await k.Model.collection.updateMany({ tenantId }, { $set: { createdAt: past, updatedAt: past } });
}

const statusOf = async (kind, tenantId, i) => (await KINDS[kind].Model.findOne({ tenantId, tallyGuid: KINDS[kind].guid(i) }).lean());
const countAll = (kind, tenantId) => KINDS[kind].Model.countDocuments({ tenantId });
const countStatus = (kind, tenantId, status) => KINDS[kind].Model.countDocuments({ tenantId, voucherStatus: status });

async function cleanup() {
  for (const t of [T1, T2]) {
    await Sale.deleteMany({ tenantId: t });
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

  const company1 = { tenantId: T1, companyGuid: G1, tallyConnection: { baseUrl: stub.url } };
  const company2 = { tenantId: T2, companyGuid: G2, tallyConnection: { baseUrl: stub.url } };

  // A reconciliation module whose Tally GUID list is `tallyGuids()` (mocked).
  const moduleFor = (kind, tallyGuids, calls = { fetch: 0 }) => ({
    voucherType: kind,
    classificationKey: KINDS[kind].classificationKey,
    Model: KINDS[kind].Model,
    fetchAllGuidsBase: async () => {
      calls.fetch += 1;
      const g = typeof tallyGuids === "function" ? tallyGuids() : tallyGuids;
      return typeof g === "string" || (g && g.raw !== undefined) ? (g.raw !== undefined ? g.raw : g) : { data: { collection: g.map((guid) => ({ guid })) } };
    },
  });
  const reconcile = (company, kind, tallyGuids, calls) => runReconciliationForCompanyModule(company, moduleFor(kind, tallyGuids, calls), { intervalMinutes: 20 });
  const allGuids = (kind, n, except = []) => Array.from({ length: n }, (_, i) => i).filter((i) => !except.includes(i)).map((i) => KINDS[kind].guid(i));

  const seedCheckpoint = (kind) =>
    SyncCheckpoint.create({
      tenantId: T1, companyGuid: G1, voucherType: kind, lastAlterId: 999999, lastRunStatus: "success",
      lastSyncedAt: new Date("2026-09-01T00:00:00Z"), isRunning: false,
    });
  const cpSnapshot = async (kind) => JSON.stringify(await SyncCheckpoint.findOne({ tenantId: T1, voucherType: kind }).lean());

  try {
    for (const kind of ["Sales", "Purchase"]) {
      console.log(`\n=== ${kind.toUpperCase()}: a month-old voucher is deleted in Tally; the incremental checkpoint is far ahead ===`);
      await cleanup();
      await seedCheckpoint(kind);
      await seed(kind, 20, T1);
      const cpBefore = await cpSnapshot(kind);
      const before = await KINDS[kind].summary(T1);

      const r = await reconcile(company1, kind, allGuids(kind, 20, [7])); // voucher 7 no longer in Tally
      const rc = await ReconciliationCheckpoint.findOne({ tenantId: T1, voucherType: kind }).lean();

      check("reconciliation detects the historical deletion regardless of the checkpoint (1 marked, run success)", r.status === "success" && r.markedDeletedCount === 1 && rc.lastRunStatus === "success" && rc.lastMarkedDeletedCount === 1, JSON.stringify(r));
      const doc = await statusOf(kind, T1, 7);
      check("the document is marked voucherStatus=deleted, NOT physically removed", !!doc && doc.voucherStatus === "deleted" && (await countAll(kind, T1)) === 20);
      check("the other 19 stay active", (await countStatus(kind, T1, "active")) === 19);
      const after = await KINDS[kind].summary(T1);
      check("analytics excludes the deleted voucher (count and total drop)", before.orderCount === 20 && after.orderCount === 19, `${before.orderCount} -> ${after.orderCount}`);
      check("the normal SyncCheckpoint is byte-for-byte unchanged (not rewound, not advanced)", (await cpSnapshot(kind)) === cpBefore);
      check("the deletion is recorded on the separate ReconciliationCheckpoint only", !!rc && rc.lastTallyGuidCount === 19 && rc.lastMongoActiveCount === 20);

      const again = await reconcile(company1, kind, allGuids(kind, 20, [7]));
      check("re-running is idempotent (nothing more marked)", again.status === "success" && again.markedDeletedCount === 0 && (await countStatus(kind, T1, "deleted")) === 1);
    }

    console.log("\n=== SALES and PURCHASE are independent ===");
    await cleanup();
    await seed("Sales", 10, T1);
    await seed("Purchase", 10, T1);
    {
      const rs = await reconcile(company1, "Sales", allGuids("Sales", 10, [2]));
      check("Sales deletion marks only Sales", rs.markedDeletedCount === 1 && (await countStatus("Sales", T1, "deleted")) === 1 && (await countStatus("Purchase", T1, "deleted")) === 0);
      const failing = { raw: null };
      const boom = { voucherType: "Sales", classificationKey: "sales", Model: Sale, fetchAllGuidsBase: async () => { throw new Error("tally down"); } };
      const rf = await runReconciliationForCompanyModule(company1, boom, { intervalMinutes: 20 });
      const rp = await reconcile(company1, "Purchase", allGuids("Purchase", 10, [5]));
      check("a failing Sales reconciliation does not block Purchase", rf.status === "failed" && rp.status === "success" && rp.markedDeletedCount === 1);
      check("Purchase deletion marks only Purchase; Sales unchanged by it", (await countStatus("Purchase", T1, "deleted")) === 1 && (await countStatus("Sales", T1, "deleted")) === 1);
      const cps = await ReconciliationCheckpoint.find({ tenantId: T1 }).lean();
      check("each type has its own ReconciliationCheckpoint", cps.length === 2 && new Set(cps.map((c) => c.voucherType)).size === 2);
    }

    console.log("\n=== FALSE-DELETION PROTECTION (via the worker path) ===");
    for (const [label, tally, expected] of [
      ["Tally unavailable (fetch throws)", () => { throw new Error("connect ECONNREFUSED"); }, "failed"],
      ["malformed (non-JSON) snapshot", { raw: "<html>not json {{{" }, "failed"],
      ["empty snapshot while Mongo has active vouchers", [], "aborted_unsafe"],
      ["JSON with no voucher collection at all", { raw: { status: "1", note: "no data" } }, "aborted_unsafe"],
      ["vouchers without GUIDs (unreadable snapshot)", { raw: { data: { collection: [{ name: "x" }, { name: "y" }] } } }, "aborted_unsafe"],
    ]) {
      await cleanup();
      await seed("Sales", 10, T1);
      const mod = { voucherType: "Sales", classificationKey: "sales", Model: Sale, fetchAllGuidsBase: async () => { if (typeof tally === "function") return tally(); return tally.raw !== undefined ? tally.raw : { data: { collection: tally } }; } };
      const r = await runReconciliationForCompanyModule(company1, mod, { intervalMinutes: 20 });
      check(`${label} -> ${expected}, nothing marked deleted`, r.status === expected && (await countStatus("Sales", T1, "deleted")) === 0 && (await countStatus("Sales", T1, "active")) === 10, JSON.stringify(r));
    }
    await cleanup();
    await seed("Sales", 10, T1);
    {
      const r = await reconcile(company1, "Sales", allGuids("Sales", 10, [0, 1, 2, 3, 4, 5]));
      check("60% of vouchers missing (> 50% threshold) -> aborted_unsafe, nothing deleted", r.status === "aborted_unsafe" && (await countStatus("Sales", T1, "deleted")) === 0, JSON.stringify(r));
      const rc = await ReconciliationCheckpoint.findOne({ tenantId: T1, voucherType: "Sales" }).lean();
      check("the abort is visible on the checkpoint (status + reason)", rc.lastRunStatus === "aborted_unsafe" && /threshold/.test(rc.lastError || ""));
      const r2 = await reconcile(company1, "Sales", allGuids("Sales", 10, [0, 1, 2, 3, 4]));
      check("exactly 50% missing is applied (threshold is strictly greater than 50%) - documented behaviour", r2.status === "success" && r2.markedDeletedCount === 5);
    }

    console.log("\n=== RECOVERY does not restore intentionally deleted Tally vouchers ===");
    await cleanup();
    await seed("Sales", 12, T1);
    {
      await reconcile(company1, "Sales", allGuids("Sales", 12, [7])); // 7 deleted in Tally -> marked deleted in Mongo
      // Tally now: 0..11 except 7 (deleted), and 9 physically lost from Mongo by an accident.
      await Sale.deleteOne({ tenantId: T1, tallyGuid: KINDS.Sales.guid(9) });
      const tallyRows = allGuids("Sales", 12, [7]).map((g) => ({ guid: g, alterid: String(1000 + Number(g.split("-").pop())), vouchertypename: "Sales" }));
      const fetched = [];
      const deps = {
        fetchRegistry: async () => ({ data: { collection: tallyRows } }),
        fetchByAlterIds: async ({ alterIds }) => {
          fetched.push(...alterIds);
          return { data: { collection: alterIds.map((a) => rawVoucher("Sales", a - 1000, a)) } };
        },
      };
      const rec = await recoverMissingVouchers({ company: company1, voucherType: "Sales", apply: true, deps });
      check("recovery restores the accidentally lost voucher (9) that Tally still has", rec.recovered === 1 && !!(await statusOf("Sales", T1, 9)));
      check("recovery does NOT touch the voucher deleted in Tally: not requested, still voucherStatus=deleted", !fetched.includes(1007) && (await statusOf("Sales", T1, 7)).voucherStatus === "deleted");
      check("only the missing voucher was requested from Tally", JSON.stringify(fetched) === JSON.stringify([1009]));

      // Explicit-restore boundary: a reconciliation-deleted doc whose voucher reappears in Tally.
      const back = allGuids("Sales", 12).map((g) => ({ guid: g, alterid: String(1000 + Number(g.split("-").pop())), vouchertypename: "Sales" }));
      const rec2 = await recoverMissingVouchers({ company: company1, voucherType: "Sales", apply: false, deps: { fetchRegistry: async () => ({ data: { collection: back } }) } });
      check("a voucher marked deleted but present in Tally again counts as present: recovery never silently revives it", rec2.found === 0 && (await statusOf("Sales", T1, 7)).voucherStatus === "deleted");
    }

    console.log("\n=== MULTI-COMPANY isolation ===");
    await cleanup();
    await seed("Sales", 10, T1);
    await seed("Sales", 10, T2); // SAME GUIDs, another tenant
    {
      const r = await reconcile(company1, "Sales", allGuids("Sales", 10, [3]));
      check("T1's deletion marks only T1's document", r.markedDeletedCount === 1 && (await countStatus("Sales", T1, "deleted")) === 1);
      check("T2's document with the identical GUID stays active (updates are tenant-scoped)", (await countStatus("Sales", T2, "deleted")) === 0 && (await countStatus("Sales", T2, "active")) === 10);
    }
    await cleanup();
    await seed("Sales", 10, T2, 100); // T2 = a different company (GUIDs 100..109)
    {
      const calls = { fetch: 0 };
      // Tally currently has company G1 open (the stub says so); its GUID set is unrelated to T2's.
      const r = await reconcile(company2, "Sales", allGuids("Sales", 10), calls);
      check("no T2 voucher is marked deleted while another company is open (saved by the >50% threshold)", (await countStatus("Sales", T2, "deleted")) === 0);
      check("reconciliation verifies the open Tally company FIRST and never compares against a different one", calls.fetch === 0 && r.skipped === true && r.reason === "company_not_open", `fetchCalls=${calls.fetch} result=${JSON.stringify(r)}`);
    }

    console.log("\n=== COMPANY GUARD: skip quietly / preserve the last real result / fail only when unreachable ===");
    const stubNone = await startStub(null); // Tally with NO company open
    const company2None = { ...company2, tallyConnection: { baseUrl: stubNone.url } };
    const company2Dead = { ...company2, tallyConnection: { baseUrl: "http://127.0.0.1:1" } }; // Tally unreachable
    try {
      // T2 has a REAL previous result on record that a skip must not overwrite.
      const seedResult = async () => {
        await cleanup();
        await seed("Sales", 10, T2, 100);
        await ReconciliationCheckpoint.create({
          tenantId: T2, companyGuid: G2, voucherType: "Sales", lastRunStatus: "aborted_unsafe",
          lastError: "previous real result", lastRunAt: new Date("2026-09-01T00:00:00Z"),
          lastTallyGuidCount: 55, lastMongoActiveCount: 60, lastMarkedDeletedCount: 3, isRunning: false,
        });
      };
      const cpState = async () => {
        const { updatedAt, __v, ...rest } = await ReconciliationCheckpoint.findOne({ tenantId: T2, voucherType: "Sales" }).lean();
        return JSON.stringify(rest);
      };
      const tenGuids = allGuids("Sales", 10).map((g) => g.replace(/\d+$/, (n) => String(Number(n) + 100)));

      for (const [label, comp] of [["a DIFFERENT company is open", company2], ["NO company is open", company2None]]) {
        await seedResult();
        const before = await cpState();
        const calls = { fetch: 0 };
        const r = await runReconciliationForCompanyModule(comp, moduleFor("Sales", tenGuids.slice(0, 2), calls), { intervalMinutes: 20 });
        const rc = await ReconciliationCheckpoint.findOne({ tenantId: T2, voucherType: "Sales" }).lean();
        check(`${label}: skipped quietly (no comparison, no Tally GUID fetch)`, r.skipped === true && r.reason === "company_not_open" && calls.fetch === 0, JSON.stringify(r));
        check(`${label}: nothing marked deleted, all 10 still active`, (await countStatus("Sales", T2, "deleted")) === 0 && (await countStatus("Sales", T2, "active")) === 10);
        check(`${label}: lock released`, rc.isRunning === false && rc.lockedAt === null);
        check(`${label}: the last real result is preserved exactly (status, error, counts, lastRunAt) - no fake success or abort`, (await cpState()) === before && rc.lastRunStatus === "aborted_unsafe" && rc.lastError === "previous real result");
      }

      await seedResult();
      {
        const calls = { fetch: 0 };
        const r = await runReconciliationForCompanyModule(company2Dead, moduleFor("Sales", tenGuids, calls), { intervalMinutes: 20 });
        const rc = await ReconciliationCheckpoint.findOne({ tenantId: T2, voucherType: "Sales" }).lean();
        check("Tally unreachable: recorded as failed (existing behaviour), nothing fetched or deleted", r.status === "failed" && rc.lastRunStatus === "failed" && !!rc.lastError && calls.fetch === 0 && (await countStatus("Sales", T2, "deleted")) === 0, JSON.stringify(r));
        check("Tally unreachable: lock released", rc.isRunning === false && rc.lockedAt === null);
      }

      await seedResult();
      {
        // The correct company IS open (stub reports G2): reconciliation proceeds normally.
        const stubG2 = await startStub(G2);
        try {
          const comp = { ...company2, tallyConnection: { baseUrl: stubG2.url } };
          clearVoucherTypeClassificationCache(G2);
          const r = await runReconciliationForCompanyModule(comp, moduleFor("Sales", tenGuids.filter((_, i) => i !== 4)), { intervalMinutes: 20 });
          check("correct company open: reconciliation runs normally and marks exactly the one deleted voucher", r.status === "success" && r.markedDeletedCount === 1 && (await countStatus("Sales", T2, "deleted")) === 1, JSON.stringify(r));
        } finally {
          stubG2.server.close();
        }
      }
    } finally {
      stubNone.server.close();
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
  console.error("Reconciliation history verification crashed:", error);
  try { await cleanup(); } catch (_) {}
  try { await mongoose.connection.close(); } catch (_) {}
  process.exitCode = 1;
});
