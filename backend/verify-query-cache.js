"use strict";

/**
 * Phase 1E verification: answer cache + TenantDataVersion.
 *
 * Sections A-B are deterministic (no database). Sections C-F use MongoDB with
 * clearly synthetic tenants (removed at the end) and a local stub standing in
 * for Tally; they never touch real business data, Tally, or Anthropic.
 *
 *   A. cache behaviour (fake executor/version)
 *   B. tenant isolation + fail-closed rules of the cache
 *   C. TenantDataVersion bumps on every write kind (model plugin)
 *   D. invalidation through the REAL write paths: sync, cancel/delete
 *      marking, recovery, reconciliation, Stock Item master refresh
 *   E. no over-invalidation of other tenants; concurrency / race safety
 *   F. cached answers are byte-identical to uncached engine answers
 *
 * Run: node verify-query-cache.js
 */

require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const StockItemMaster = require("./src/models/stockItemMaster.model");
const TenantDataVersion = require("./src/models/tenantDataVersion.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");

const { createAnswerCache, stableStringify } = require("./src/services/query/answerCache");
const dataVersion = require("./src/services/query/dataVersion");
const { executeQuery } = require("./src/services/query/execute");
const { reconcileVoucherType } = require("./src/services/sync/reconciliation");
const { recoverMissingVouchers } = require("./src/services/sync/voucherRecovery");
const { processSinglePurchaseVoucher } = require("./src/services/import/tallyPurchaseImport");
const { refreshStockItemMasters } = require("./src/services/tally/stockItemMaster");
const { clearVoucherTypeClassificationCache } = require("./src/services/tally/voucherTypeClassifier");

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${detail})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);

const PLAN_SALES = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "all_time" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [] };
const PLAN_PURCHASE = { v: 1, entity: "purchase", mode: "aggregate", period: { kind: "all_time" }, metrics: ["purchaseAmount", "purchaseInvoiceCount"], filters: [] };
const PLAN_GROUP = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "all_time" }, metrics: ["lineAmount"], groupBy: [{ dim: "productGroup" }], filters: [] };

// ================================================================== A/B: fake-driven cache tests

async function fakeSection() {
  section("A. cache behaviour (fake executor, no DB)");
  let execCalls = 0;
  const versions = new Map();
  const getVersion = async (t) => `v${versions.get(t) || 0}`;
  const execute = async (plan, ctx) => {
    execCalls += 1;
    return { ok: true, tenant: ctx.tenantId, n: execCalls, rows: [{ x: 1 }] };
  };
  const deps = { execute, getVersion };
  const cache = createAnswerCache();
  const run = (plan, tenantId = "T1", extra = {}) => cache.run(plan, { tenantId, ...extra }, deps);

  let r = await run(PLAN_SALES);
  check("first request is a miss and executes", r.cache.status === "miss" && execCalls === 1 && r.cache.stored === true);
  r = await run(PLAN_SALES);
  check("identical request is a hit and does NOT execute", r.cache.status === "hit" && execCalls === 1 && r.result.n === 1);
  r = await run({ ...PLAN_SALES, metrics: ["invoiceAmount", "invoiceCount"], filters: [] });
  check("same plan, different key order -> hit (canonical key)", r.cache.status === "hit" && execCalls === 1);
  const reordered = JSON.parse(`{"filters":[],"metrics":["invoiceAmount","invoiceCount"],"period":{"kind":"all_time"},"mode":"aggregate","entity":"sales","v":1}`);
  r = await run(reordered);
  check("JSON key order does not matter", r.cache.status === "hit");
  r = await run({ ...PLAN_SALES, metrics: ["invoiceCount", "invoiceAmount"] });
  check("different metric order is a different question -> miss", r.cache.status === "miss");
  r = await run({ ...PLAN_SALES, period: { kind: "current_month" } });
  check("different period -> miss", r.cache.status === "miss");
  r = await run(PLAN_SALES, "T1", { referenceDate: new Date("2026-01-01T00:00:00Z") });
  check("explicit reference date is part of the key -> miss", r.cache.status === "miss");
  r = await run(PLAN_SALES, "T1", { referenceDate: new Date("2026-01-01T00:00:00Z") });
  check("same explicit reference date -> hit", r.cache.status === "hit");
  r = await run(PLAN_SALES, "T1", { referenceDate: new Date("2026-01-02T00:00:00Z") });
  check("different reference date -> miss", r.cache.status === "miss");

  versions.set("T1", 1);
  const before = execCalls;
  r = await run(PLAN_SALES);
  check("data version changed -> miss and re-executes", r.cache.status === "miss" && execCalls === before + 1);
  r = await run(PLAN_SALES);
  check("...then cached again under the new version", r.cache.status === "hit");

  // catalog change
  const c2 = createAnswerCache({ fingerprint: "a-different-catalog-fingerprint" });
  await c2.run(PLAN_SALES, { tenantId: "T1" }, deps);
  const before2 = execCalls;
  const c3 = createAnswerCache({ fingerprint: "another" });
  const rr = await c3.run(PLAN_SALES, { tenantId: "T1" }, deps);
  check("catalog fingerprint is part of the key (other fingerprint never shares entries)", rr.cache.status === "miss" && execCalls === before2 + 1);

  // never cache failures
  const failingCache = createAnswerCache();
  let n = 0;
  const flaky = { getVersion, execute: async () => (++n === 1 ? { ok: false, stage: "execution", errors: [{ code: "query_timeout" }] } : { ok: true, n }) };
  const f1 = await failingCache.run(PLAN_SALES, { tenantId: "T1" }, flaky);
  const f2 = await failingCache.run(PLAN_SALES, { tenantId: "T1" }, flaky);
  check("a failed/timed-out result is never cached", f1.result.ok === false && f2.cache.status === "miss" && f2.result.ok === true);
  const f3 = await failingCache.run(PLAN_SALES, { tenantId: "T1" }, flaky);
  check("a later success is cached", f3.cache.status === "hit");

  // immutability
  const hit = await run(PLAN_SALES, "T1");
  let threw = false;
  try {
    "use strict";
    hit.result.rows.push({ evil: 1 });
  } catch (e) {
    threw = true;
  }
  check("cached answers are frozen (callers cannot mutate them)", threw && Object.isFrozen(hit.result) && Object.isFrozen(hit.result.rows));
  const again = await run(PLAN_SALES, "T1");
  check("cache still returns the original after a mutation attempt", again.result.rows.length === 1);

  // TTL
  let clock = 1000;
  const ttlCache = createAnswerCache({ ttlMs: 100, now: () => clock });
  await ttlCache.run(PLAN_SALES, { tenantId: "T1" }, deps);
  clock += 50;
  const t1 = await ttlCache.run(PLAN_SALES, { tenantId: "T1" }, deps);
  clock += 100;
  const t2 = await ttlCache.run(PLAN_SALES, { tenantId: "T1" }, deps);
  check("entry served before TTL, expired after TTL", t1.cache.status === "hit" && t2.cache.status === "miss");

  // bounds
  const small = createAnswerCache({ maxEntries: 5, maxEntriesPerTenant: 3 });
  for (let i = 0; i < 10; i += 1) await small.run({ ...PLAN_SALES, limit: undefined, period: { kind: "custom", from: `2026-01-${String(i + 1).padStart(2, "0")}`, to: "2026-02-01" } }, { tenantId: "T1" }, deps);
  check("per-tenant entry cap enforced (LRU)", small._partitions.get("T1").size <= 3 && small.size() <= 3, String(small.size()));
  for (let i = 0; i < 4; i += 1) await small.run({ ...PLAN_SALES, period: { kind: "custom", from: `2026-03-0${i + 1}`, to: "2026-04-01" } }, { tenantId: "T2" }, deps);
  for (let i = 0; i < 4; i += 1) await small.run({ ...PLAN_SALES, period: { kind: "custom", from: `2026-05-0${i + 1}`, to: "2026-06-01" } }, { tenantId: "T3" }, deps);
  check("global entry cap enforced across tenants", small.size() <= 5, String(small.size()));
  const big = createAnswerCache({ maxEntryBytes: 50 });
  const bigDeps = { getVersion, execute: async () => ({ ok: true, blob: "x".repeat(500) }) };
  const b1 = await big.run(PLAN_SALES, { tenantId: "T1" }, bigDeps);
  const b2 = await big.run(PLAN_SALES, { tenantId: "T1" }, bigDeps);
  check("oversized answers are not cached", b1.cache.stored === false && b2.cache.status === "miss" && big.size() === 0);

  section("B. tenant isolation + fail-closed rules (no DB)");
  const iso = createAnswerCache();
  const isoDeps = { getVersion, execute: async (p, ctx) => ({ ok: true, owner: ctx.tenantId }) };
  const a = await iso.run(PLAN_SALES, { tenantId: "TENANT-A" }, isoDeps);
  const bRes = await iso.run(PLAN_SALES, { tenantId: "TENANT-B" }, isoDeps);
  check("identical plan + identical version, different tenant -> separate entries", a.result.owner === "TENANT-A" && bRes.result.owner === "TENANT-B" && bRes.cache.status === "miss");
  const a2 = await iso.run(PLAN_SALES, { tenantId: "TENANT-A" }, isoDeps);
  const b2b = await iso.run(PLAN_SALES, { tenantId: "TENANT-B" }, isoDeps);
  check("each tenant hits only its own entry", a2.result.owner === "TENANT-A" && b2b.result.owner === "TENANT-B" && a2.cache.status === "hit" && b2b.cache.status === "hit");
  check("entries live in per-tenant partitions", iso._partitions.has("TENANT-A") && iso._partitions.has("TENANT-B") && iso._partitions.get("TENANT-A") !== iso._partitions.get("TENANT-B"));
  // Even a forced key collision cannot cross tenants: lookup is partitioned by tenant.
  const keyA = [...iso._partitions.get("TENANT-A").keys()][0];
  check("tenant B partition does not contain tenant A's key as a shared entry", iso._partitions.get("TENANT-B").get(keyA) === undefined || iso._partitions.get("TENANT-B").get(keyA).value.owner === "TENANT-B");
  iso.invalidateTenant("TENANT-A");
  const a3 = await iso.run(PLAN_SALES, { tenantId: "TENANT-A" }, isoDeps);
  const b3 = await iso.run(PLAN_SALES, { tenantId: "TENANT-B" }, isoDeps);
  check("invalidating tenant A does not touch tenant B", a3.cache.status === "miss" && b3.cache.status === "hit");

  for (const bad of [undefined, null, "", "   ", 5, {}, { $ne: "" }]) {
    let calls = 0;
    const c = createAnswerCache();
    const res = await c.run(PLAN_SALES, { tenantId: bad }, { getVersion, execute: async () => (calls += 1, { ok: false, errors: [{ code: "tenant_context_required" }] }) });
    check(`no valid tenant (${JSON.stringify(bad)}) -> bypass, nothing stored`, res.cache.status === "bypass" && c.size() === 0 && calls === 1);
  }
  const inv = createAnswerCache();
  const invRes = await inv.run({ v: 1, entity: "sales", $where: "1" }, { tenantId: "T1" }, { getVersion, execute: async () => ({ ok: false, stage: "schema" }) });
  check("invalid plan -> bypass (structured error from the engine), never stored", invRes.cache.status === "bypass" && inv.size() === 0);
  const noVer = createAnswerCache();
  let vcalls = 0;
  const nv = await noVer.run(PLAN_SALES, { tenantId: "T1" }, { getVersion: async () => { throw new Error("mongo down"); }, execute: async () => (vcalls += 1, { ok: true }) });
  const nv2 = await noVer.run(PLAN_SALES, { tenantId: "T1" }, { getVersion: async () => { throw new Error("mongo down"); }, execute: async () => (vcalls += 1, { ok: true }) });
  check("version unreadable -> fail closed: bypass, executes every time, stores nothing", nv.cache.status === "bypass" && nv2.cache.status === "bypass" && vcalls === 2 && noVer.size() === 0);

  // version moves while the query runs -> result returned, not stored
  const racy = createAnswerCache();
  let ver = 0;
  const racyDeps = { getVersion: async () => `r${ver}`, execute: async () => { ver += 1; return { ok: true, stale: "maybe" }; } };
  const rr1 = await racy.run(PLAN_SALES, { tenantId: "T1" }, racyDeps);
  check("write during the query: answer returned but NOT cached", rr1.result.ok && rr1.cache.stored === false && racy.size() === 0);
  const rr2 = await racy.run(PLAN_SALES, { tenantId: "T1" }, { getVersion: racyDeps.getVersion, execute: async () => ({ ok: true, fresh: true }) });
  check("...and the next request recomputes under the new version", rr2.cache.status === "miss" && rr2.result.fresh === true);

  // single flight
  const sf = createAnswerCache();
  let sfCalls = 0;
  const sfDeps = { getVersion, execute: async () => { sfCalls += 1; await new Promise((r) => setTimeout(r, 30)); return { ok: true, id: sfCalls }; } };
  const many = await Promise.all(Array.from({ length: 8 }, () => sf.run(PLAN_SALES, { tenantId: "T1" }, sfDeps)));
  check("8 concurrent identical requests -> ONE execution", sfCalls === 1 && many.every((m) => m.result.id === 1));
  const other = await Promise.all([sf.run(PLAN_SALES, { tenantId: "T9" }, sfDeps), sf.run(PLAN_SALES, { tenantId: "T10" }, sfDeps)]);
  check("concurrent identical plans for DIFFERENT tenants are never coalesced", sfCalls === 3 && other.every((o) => o.cache.status === "miss"));

  check("stableStringify is order-independent", stableStringify({ b: 1, a: [{ d: 1, c: 2 }] }) === stableStringify({ a: [{ c: 2, d: 1 }], b: 1 }));
}

// ================================================================== DB sections

const TA = "verify-cache-tenant-a";
const TB = "verify-cache-tenant-b";
const GA = "verify-cache-company-guid-a";
const GB = "verify-cache-company-guid-b";

const saleDoc = (tenantId, guid, no, amount = 100, extra = {}) => ({
  tenantId,
  header: { voucherNo: no, voucherDate: new Date("2026-09-01"), voucherType: "Sales", voucherTotalAmount: amount, partyName: "Cache Verify Party" },
  inventory: [{ itemName: "Cache Item 1", quantity: 1, rate: amount, amount }],
  ledgers: [],
  tallyGuid: guid,
  tallyAlterId: 1,
  voucherStatus: "active",
  ...extra,
});

async function cleanup() {
  for (const t of [TA, TB]) {
    await Sale.collection.deleteMany({ tenantId: t }); // raw driver: cleanup must not itself bump versions
    await Purchase.collection.deleteMany({ tenantId: t });
    await StockItemMaster.collection.deleteMany({ tenantId: t });
    await SyncCheckpoint.deleteMany({ tenantId: t });
    await TenantDataVersion.deleteMany({ tenantId: t });
  }
}

const ver = (t) => dataVersion.getTenantVersion(t);
const parts = (v) => v.split(".").map(Number);
const tenantPart = (v) => parts(v)[1];
const globalPart = (v) => parts(v)[0];

async function bumps(label, tenant, action, { other = TB } = {}) {
  const before = await ver(tenant);
  const otherBefore = await ver(other);
  await action();
  const after = await ver(tenant);
  const otherAfter = await ver(other);
  check(`${label}: tenant version bumped`, tenantPart(after) > tenantPart(before), `${before} -> ${after}`);
  check(`${label}: other tenant version untouched`, tenantPart(otherAfter) === tenantPart(otherBefore) && globalPart(otherAfter) === globalPart(otherBefore));
}

async function writeKindsSection() {
  section("C. TenantDataVersion bumps on every write kind (model plugin)");
  await bumps("Sale.create / save", TA, () => Sale.create(saleDoc(TA, `${GA}-1`, "C-1")));
  await bumps("Sale.insertMany", TA, () => Sale.insertMany([saleDoc(TA, `${GA}-2`, "C-2"), saleDoc(TA, `${GA}-3`, "C-3")]));
  await bumps("Sale.findOneAndUpdate (upsert)", TA, () => Sale.findOneAndUpdate({ tenantId: TA, tallyGuid: `${GA}-4` }, { $set: saleDoc(TA, `${GA}-4`, "C-4") }, { upsert: true, returnDocument: "after" }));
  await bumps("Sale.updateOne", TA, () => Sale.updateOne({ tenantId: TA, tallyGuid: `${GA}-1` }, { $set: { "header.voucherTotalAmount": 555 } }));
  await bumps("Sale.updateMany", TA, () => Sale.updateMany({ tenantId: TA, voucherStatus: "active" }, { $set: { tallyAlterId: 9 } }));
  await bumps("Sale document.save (modify)", TA, async () => {
    const d = await Sale.findOne({ tenantId: TA, tallyGuid: `${GA}-1` });
    d.header.partyName = "Changed";
    await d.save();
  });
  await bumps("Sale.findOneAndDelete", TA, () => Sale.findOneAndDelete({ tenantId: TA, tallyGuid: `${GA}-4` }));
  await bumps("Sale.deleteOne", TA, () => Sale.deleteOne({ tenantId: TA, tallyGuid: `${GA}-3` }));
  await bumps("Sale.deleteMany", TA, () => Sale.deleteMany({ tenantId: TA, tallyGuid: `${GA}-2` }));
  await bumps("Sale.bulkWrite", TA, () => Sale.bulkWrite([{ insertOne: { document: saleDoc(TA, `${GA}-5`, "C-5") } }, { updateOne: { filter: { tenantId: TA, tallyGuid: `${GA}-1` }, update: { $set: { tallyAlterId: 2 } } } }]));
  await bumps("Purchase.create", TB, () => Purchase.create({ ...saleDoc(TB, `${GB}-1`, "CP-1"), header: { voucherNo: "CP-1", voucherDate: new Date("2026-09-01"), voucherType: "Purchase", voucherTotalAmount: 10, partyName: "Cache Verify Vendor" } }), { other: TA });
  await bumps("StockItemMaster.bulkWrite", TA, () => StockItemMaster.bulkWrite([{ updateOne: { filter: { tenantId: TA, tallyGuid: `${GA}-M1` }, update: { $set: { tenantId: TA, itemName: "Cache Item 1", stockGroupName: "Cache Group", tallyGuid: `${GA}-M1` } }, upsert: true } }], { ordered: false }));

  // ---- review hardening: paths that previously could bypass invalidation
  const quiet = console.error;
  const swallow = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  const changed = async (label, tenant, action, { global = false } = {}) => {
    const b = await ver(tenant);
    await action();
    const a = await ver(tenant);
    check(label, global ? globalPart(a) > globalPart(b) || tenantPart(a) > tenantPart(b) : tenantPart(a) > tenantPart(b), `${b} -> ${a}`);
  };
  await changed("Sale.insertMany({rawResult:true}) (Mongoose skips its post hooks) still bumps", TA, () => Sale.insertMany([saleDoc(TA, `${GA}-20`, "H-20")], { rawResult: true }));
  await changed("Sale.insertMany({lean:true}) bumps", TA, () => Sale.insertMany([saleDoc(TA, `${GA}-21`, "H-21")], { lean: true }));
  await changed("Sale.create([...]) bumps", TA, () => Sale.create([saleDoc(TA, `${GA}-22`, "H-22")]));
  await changed("Sale.replaceOne bumps", TA, () => Sale.replaceOne({ tenantId: TA, tallyGuid: `${GA}-20` }, saleDoc(TA, `${GA}-20`, "H-20r")));
  await changed("Sale.findOneAndReplace bumps", TA, () => Sale.findOneAndReplace({ tenantId: TA, tallyGuid: `${GA}-20` }, saleDoc(TA, `${GA}-20`, "H-20rr")));
  await changed("Sale.findByIdAndUpdate (no tenant in filter) invalidates via global", TA, async () => Sale.findByIdAndUpdate((await Sale.findOne({ tenantId: TA, tallyGuid: `${GA}-20` }))._id, { $set: { tallyAlterId: 3 } }), { global: true });
  await changed("document.updateOne bumps (global: filter is _id)", TA, async () => (await Sale.findOne({ tenantId: TA, tallyGuid: `${GA}-20` })).updateOne({ $set: { tallyAlterId: 4 } }), { global: true });
  await changed("Sale.bulkSave bumps", TA, async () => {
    const d = await Sale.findOne({ tenantId: TA, tallyGuid: `${GA}-20` });
    d.tallyAlterId = 5;
    await Sale.bulkSave([d]);
  }, { global: true });

  // moving a document between tenants invalidates BOTH sides
  const a1 = await ver(TA);
  const b1 = await ver(TB);
  await Sale.updateOne({ tenantId: TA, tallyGuid: `${GA}-21` }, { $set: { tenantId: TB } });
  check("updateOne that $sets a different tenantId bumps the source AND the destination tenant", tenantPart(await ver(TA)) > tenantPart(a1) && tenantPart(await ver(TB)) > tenantPart(b1));
  const a2 = await ver(TA);
  const b2 = await ver(TB);
  const moved = await Sale.findOne({ tenantId: TB, tallyGuid: `${GA}-21` });
  moved.tenantId = TA;
  await moved.save();
  check("document.save() that changes tenantId invalidates both tenants (destination directly, source via global)", tenantPart(await ver(TA)) > tenantPart(a2) && (tenantPart(await ver(TB)) > tenantPart(b2) || globalPart(await ver(TB)) > globalPart(b2)));

  // a FAILED write may have partly applied: it must still invalidate, and the original error must reach the caller
  console.error = () => {};
  const f0 = await ver(TA);
  const e1 = await swallow(() => Sale.insertMany([saleDoc(TA, `${GA}-30`, "F-30"), saleDoc(TA, `${GA}-30`, "F-30dup")]));
  check("failed (partly applied) insertMany: error still thrown to the caller", !!e1 && e1.code === 11000);
  check("...and it invalidated (the first document really was inserted)", (await ver(TA)) !== f0 && (await Sale.countDocuments({ tenantId: TA, tallyGuid: `${GA}-30` })) === 1);
  const f1 = await ver(TA);
  const e2 = await swallow(() => Sale.bulkWrite([{ insertOne: { document: saleDoc(TA, `${GA}-31`, "F-31") } }, { insertOne: { document: saleDoc(TA, `${GA}-31`, "F-31dup") } }], { ordered: true }));
  check("failed (partly applied) bulkWrite: original error reaches the caller (no crash / unhandled rejection)", !!e2 && e2.code === 11000);
  check("...and it invalidated", tenantPart(await ver(TA)) > tenantPart(f1));
  const f2 = await ver(TA);
  const e3 = await swallow(() => Sale.create(saleDoc(TA, `${GA}-31`, "F-31dup2")));
  check("failed save (duplicate key): error propagates and the tenant is invalidated", !!e3 && e3.code === 11000 && tenantPart(await ver(TA)) > tenantPart(f2));
  const f3 = await ver(TA);
  const e4 = await swallow(() => Sale.updateOne({ tenantId: TA }, { $badOp: 1 }));
  check("failed query write: error propagates and the tenant is invalidated", !!e4 && tenantPart(await ver(TA)) > tenantPart(f3));
  console.error = quiet;

  // concurrent bulk writes for different tenants each invalidate their own tenant
  const c0a = await ver(TA);
  const c0b = await ver(TB);
  await Promise.all([Sale.bulkWrite([{ insertOne: { document: saleDoc(TA, `${GA}-40`, "K-40") } }]), StockItemMaster.bulkWrite([{ updateOne: { filter: { tenantId: TB, tallyGuid: `${GB}-M9` }, update: { $set: { tenantId: TB, itemName: "K item", stockGroupName: "K", tallyGuid: `${GB}-M9` } }, upsert: true } }], { ordered: false })]);
  check("concurrent bulkWrites for two tenants (different models) bump both tenants", tenantPart(await ver(TA)) > tenantPart(c0a) && tenantPart(await ver(TB)) > tenantPart(c0b));

  // multi-tenant bulk write bumps both
  const a0 = await ver(TA);
  const b0 = await ver(TB);
  await Sale.bulkWrite([{ insertOne: { document: saleDoc(TA, `${GA}-6`, "C-6") } }, { insertOne: { document: saleDoc(TB, `${GB}-6`, "C-6b") } }]);
  check("bulkWrite touching two tenants bumps both", tenantPart(await ver(TA)) > tenantPart(a0) && tenantPart(await ver(TB)) > tenantPart(b0));

  // A no-effect read must not bump
  const r0 = await ver(TA);
  await Sale.find({ tenantId: TA }).lean();
  await Sale.countDocuments({ tenantId: TA });
  await Sale.aggregate([{ $match: { tenantId: TA } }]);
  check("reads (find/count/aggregate) never bump the version", (await ver(TA)) === r0);

  // unattributable write -> global, invalidates everyone (fail closed)
  const g0 = await ver(TA);
  const gb0 = await ver(TB);
  await Sale.updateMany({ "header.voucherNo": "NO-SUCH-VOUCHER-1E" }, { $set: { tallyAlterId: 1 } });
  const g1 = await ver(TA);
  const gb1 = await ver(TB);
  check("write with no tenant in its filter bumps the GLOBAL counter (all tenants invalidated)", globalPart(g1) > globalPart(g0) && globalPart(gb1) > globalPart(gb0));
  const g2 = await ver(TA);
  await Sale.deleteMany({ tenantId: { $in: [TA] }, "header.voucherNo": "NO-SUCH-VOUCHER-1E" });
  check("write with an operator in tenantId (not a plain string) is also treated as unattributable -> global", globalPart(await ver(TA)) > globalPart(g2));

  // counter write failure -> process-local epoch still invalidates
  const orig = TenantDataVersion.updateOne;
  const l0 = await ver(TA);
  TenantDataVersion.updateOne = async () => { throw new Error("simulated mongo failure"); };
  const errWrite = console.error;
  console.error = () => {};
  try {
    await Sale.updateOne({ tenantId: TA, tallyGuid: `${GA}-1` }, { $set: { tallyAlterId: 77 } });
  } finally {
    TenantDataVersion.updateOne = orig;
    console.error = errWrite;
  }
  check("if the counter write fails, the write itself succeeds and this process's version still changes", (await ver(TA)) !== l0 && (await Sale.findOne({ tenantId: TA, tallyGuid: `${GA}-1` }).lean()).tallyAlterId === 77);
  check("failure is counted", dataVersion.stats.failures >= 1);

  let threw = false;
  try { await dataVersion.getTenantVersion(""); } catch (e) { threw = true; }
  let threw2 = false;
  try { await dataVersion.getTenantVersion("*"); } catch (e) { threw2 = true; }
  check("getTenantVersion refuses empty and reserved tenant ids", threw && threw2);
}

// ---- real write paths --------------------------------------------------------

function startStub() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const id = req.headers.id;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (id === "RTS Company Guid Collection") res.end(JSON.stringify({ status: "1", data: { collection: [{ name: { value: "Cache Verify Co" }, guid: { value: GA } }] } }));
      else if (id === "RTS VoucherType Master Collection")
        res.end(JSON.stringify({ status: "1", data: { collection: [
          { metadata: { name: "Sales", reservedname: "Sales" }, parent: { value: "Sales" }, guid: { value: `${GA}-1` } },
          { metadata: { name: "Purchase", reservedname: "Purchase" }, parent: { value: "Purchase" }, guid: { value: `${GA}-2` } },
        ] } }));
      else res.end(JSON.stringify({ status: "1", data: { collection: [] } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const rawPurchase = (i) => ({
  vouchernumber: `CACHE-P-${i}`,
  date: "20260905",
  partyname: "Cache Verify Vendor",
  vouchertypename: "Purchase",
  guid: `${GA}-${i}`,
  alterid: String(1000 + i * 7),
  ledgerentries: [
    { ledgername: "Purchase AC", amount: "100.00", isdeemedpositive: true },
    { ledgername: "Cache Verify Vendor", amount: "-100.00", isdeemedpositive: false },
  ],
});

async function realPathsSection() {
  section("D. invalidation through the REAL write paths");
  await cleanup();
  const { cache, execute } = (() => {
    const c = createAnswerCache();
    return { cache: c, execute: (plan, tenantId) => c.run(plan, { tenantId }, { execute: executeQuery, getVersion: dataVersion.getTenantVersion }) };
  })();
  const unsub = dataVersion.onBump((t) => (t === "*" ? cache.invalidateAll() : cache.invalidateTenant(t)));
  const fresh = (plan, tenantId) => executeQuery(plan, { tenantId });
  const total = (r) => r.totals && r.totals.values;

  // seed both tenants (Sales) - via the model so versions move naturally
  await Sale.insertMany([saleDoc(TA, `${GA}-101`, "D-1", 100), saleDoc(TA, `${GA}-102`, "D-2", 200), saleDoc(TA, `${GA}-103`, "D-3", 300), saleDoc(TA, `${GA}-104`, "D-4", 400)]);
  await Sale.insertMany([saleDoc(TB, `${GB}-201`, "DB-1", 1000)]);

  const prime = async (plan, t) => {
    const a = await execute(plan, t);
    const b = await execute(plan, t);
    return { miss: a, hit: b };
  };
  const pa = await prime(PLAN_SALES, TA);
  const pb = await prime(PLAN_SALES, TB);
  check("baseline: tenant A answer cached (miss then hit)", pa.miss.cache.status === "miss" && pa.hit.cache.status === "hit" && total(pa.hit.result).invoiceCount === 4 && total(pa.hit.result).invoiceAmount === 1000, JSON.stringify(total(pa.hit.result)));
  check("baseline: tenant B answer cached separately", pb.hit.cache.status === "hit" && total(pb.hit.result).invoiceCount === 1);

  // 1) SYNC: real sync persistence path (processSinglePurchaseVoucher -> upsert)
  await Purchase.insertMany([{ ...saleDoc(TA, `${GA}-300`, "DP-0", 50), header: { voucherNo: "DP-0", voucherDate: new Date("2026-09-01"), voucherType: "Purchase", voucherTotalAmount: 50, partyName: "Cache Verify Vendor" } }]);
  const pp = await prime(PLAN_PURCHASE, TA);
  check("baseline purchase cached (1 invoice)", pp.hit.cache.status === "hit" && total(pp.hit.result).purchaseInvoiceCount === 1);
  const syncOutcome = await processSinglePurchaseVoucher(rawPurchase(1), TA);
  check("sync path wrote a new voucher", syncOutcome.created === true || syncOutcome.status === "created", JSON.stringify(syncOutcome).slice(0, 120));
  let r = await execute(PLAN_PURCHASE, TA);
  check("SYNC: next purchase question is a MISS and sees the new voucher (2 invoices)", r.cache.status === "miss" && total(r.result).purchaseInvoiceCount === 2, `${r.cache.status} ${JSON.stringify(total(r.result))}`);
  r = await execute(PLAN_PURCHASE, TA);
  check("...and is cached again afterwards", r.cache.status === "hit");
  const syncDup = await processSinglePurchaseVoucher(rawPurchase(1), TA);
  r = await execute(PLAN_PURCHASE, TA);
  check("re-syncing an identical voucher (skipped duplicate, no write) leaves the cache intact", syncDup.duplicate === true && r.cache.status === "hit");

  // 2) sync of a CANCELLED/DELETED marker (real persistence branch)
  const delRaw = { ...rawPurchase(1), isdeleted: true, alterid: "9999" };
  const delOutcome = await processSinglePurchaseVoucher(delRaw, TA);
  r = await execute(PLAN_PURCHASE, TA);
  check("SYNC of a deleted-voucher marker: miss and the voucher no longer counts (1 invoice)", r.cache.status === "miss" && total(r.result).purchaseInvoiceCount === 1, `${JSON.stringify(delOutcome).slice(0, 100)} ${JSON.stringify(total(r.result))}`);
  await execute(PLAN_PURCHASE, TA);

  // 3) RECOVERY (real recoverMissingVouchers against a local Tally stub)
  const stub = await startStub();
  clearVoucherTypeClassificationCache(GA);
  try {
    const vouchers = [5, 6, 7];
    const deps = {
      fetchRegistry: async () => ({ data: { collection: vouchers.map((i) => ({ vouchertypename: "Purchase", guid: `${GA}-${i}`, alterid: String(1000 + i * 7) })) } }),
      fetchByAlterIds: async ({ alterIds }) => ({ data: { collection: vouchers.filter((i) => alterIds.includes(1000 + i * 7)).map(rawPurchase) } }),
    };
    const before = await execute(PLAN_PURCHASE, TA);
    const rec = await recoverMissingVouchers({ company: { tenantId: TA, companyGuid: GA, tallyConnection: { baseUrl: stub.url } }, voucherType: "Purchase", apply: true, deps });
    check("recovery wrote the missing vouchers", rec.recovered === 3, JSON.stringify(rec).slice(0, 200));
    r = await execute(PLAN_PURCHASE, TA);
    check("RECOVERY: next question is a MISS and includes the 3 recovered vouchers", before.cache.status === "hit" && r.cache.status === "miss" && total(r.result).purchaseInvoiceCount === 4, `${r.cache.status} ${JSON.stringify(total(r.result))}`);
    check("...answer equals a fresh uncached engine run", JSON.stringify(total(r.result)) === JSON.stringify(total(await fresh(PLAN_PURCHASE, TA))));
    const dry = await execute(PLAN_PURCHASE, TA);
    await recoverMissingVouchers({ company: { tenantId: TA, companyGuid: GA, tallyConnection: { baseUrl: stub.url } }, voucherType: "Purchase", apply: false, deps });
    const afterDry = await execute(PLAN_PURCHASE, TA);
    check("recovery dry run (no write) does not invalidate", dry.cache.status === "hit" && afterDry.cache.status === "hit");
  } finally {
    stub.server.close();
  }

  // 4) RECONCILIATION (real reconcileVoucherType marking a Tally-deleted voucher)
  r = await execute(PLAN_SALES, TA);
  check("before reconciliation: tenant A sales answer cached", r.cache.status === "hit" || r.cache.status === "miss");
  await execute(PLAN_SALES, TA);
  const tallyHas = [101, 102, 103].map((i) => ({ guid: `${GA}-${i}` })); // 104 was deleted in Tally
  const recon = await reconcileVoucherType({ tenantId: TA, companyGuid: GA, Model: Sale, fetchAllGuids: async () => ({ data: { collection: tallyHas } }) });
  check("reconciliation marked the deleted voucher", recon.status === "success" && recon.markedDeletedCount === 1, JSON.stringify(recon).slice(0, 160));
  r = await execute(PLAN_SALES, TA);
  check("RECONCILIATION: next question is a MISS and drops the deleted voucher (3 invoices / 600)", r.cache.status === "miss" && total(r.result).invoiceCount === 3 && total(r.result).invoiceAmount === 600, JSON.stringify(total(r.result)));
  const noop = await reconcileVoucherType({ tenantId: TA, companyGuid: GA, Model: Sale, fetchAllGuids: async () => ({ data: { collection: tallyHas } }) });
  await execute(PLAN_SALES, TA);
  const afterNoop = await execute(PLAN_SALES, TA);
  check("reconciliation with nothing to change does not invalidate", noop.markedDeletedCount === 0 && afterNoop.cache.status === "hit");
  const abortedBefore = await execute(PLAN_SALES, TA);
  const aborted = await reconcileVoucherType({ tenantId: TA, companyGuid: GA, Model: Sale, fetchAllGuids: async () => ({ data: { collection: [] } }) });
  const abortedAfter = await execute(PLAN_SALES, TA);
  check("aborted (unsafe) reconciliation writes nothing and leaves the cache valid", aborted.status === "aborted_unsafe" && abortedBefore.cache.status === "hit" && abortedAfter.cache.status === "hit");

  // 5) Stock Item master refresh (product-group answers depend on it)
  const master = (group) => async () => ({ status: "1", data: { collection: [{ metadata: { type: "Stock Item", name: "Cache Item 1", reservedname: "" }, guid: { type: "String", value: `${GA}-M1` }, parent: { type: "String", value: group } }] } });
  await refreshStockItemMasters({ tenantId: TA, companyGuid: GA, fetcher: master("Group One") });
  const g1 = await prime(PLAN_GROUP, TA);
  const groupNames = (res) => (res.rows || []).map((x) => x.key || (x.dims && x.dims.productGroup) || JSON.stringify(x)).join("|");
  check("baseline: product-group answer cached", g1.hit.cache.status === "hit" && /Group One/.test(JSON.stringify(g1.hit.result.rows)), JSON.stringify(g1.hit.result.rows).slice(0, 160));
  await refreshStockItemMasters({ tenantId: TA, companyGuid: GA, fetcher: master("Group Two") });
  r = await execute(PLAN_GROUP, TA);
  check("STOCK ITEM REFRESH: item moved to another group -> MISS and the answer changes", r.cache.status === "miss" && /Group Two/.test(JSON.stringify(r.result.rows)) && !/Group One/.test(JSON.stringify(r.result.rows)), JSON.stringify(r.result.rows).slice(0, 160));
  void groupNames;

  // ================================================================ E. isolation + concurrency
  section("E. no over-invalidation, concurrency and race safety");
  const bStill = await execute(PLAN_SALES, TB);
  check("all the writes above (Tenant A only) left Tenant B's cached answer valid", bStill.cache.status === "hit" && total(bStill.result).invoiceCount === 1);
  await execute(PLAN_SALES, TA); // prime A (the master refresh above had invalidated it)
  check("A primed and cached before B is written", (await execute(PLAN_SALES, TA)).cache.status === "hit");
  await Sale.create(saleDoc(TB, `${GB}-202`, "DB-2", 1));
  const bAfter = await execute(PLAN_SALES, TB);
  const aStill = await execute(PLAN_SALES, TA);
  check("a write for Tenant B invalidates B (2 invoices) and not A", bAfter.cache.status === "miss" && total(bAfter.result).invoiceCount === 2 && aStill.cache.status === "hit");
  const aRes = total(aStill.result);
  const bRes = total(bAfter.result);
  check("tenant answers never bleed into each other", aRes.invoiceCount === 3 && bRes.invoiceCount === 2 && aRes.invoiceAmount === 600 && bRes.invoiceAmount === 1001);

  // race: write lands while an identical query is running; the pre-write answer must not survive
  const slowExec = async (plan, ctx) => {
    const res = await executeQuery(plan, ctx);
    await Sale.create(saleDoc(TA, `${GA}-900`, "RACE-1", 7)); // write commits after the read
    return res;
  };
  const raceCache = createAnswerCache();
  const unsubRace = dataVersion.onBump((t) => (t === "*" ? raceCache.invalidateAll() : raceCache.invalidateTenant(t)));
  const before = await raceCache.run(PLAN_SALES, { tenantId: TA }, { execute: slowExec, getVersion: dataVersion.getTenantVersion });
  const later = await raceCache.run(PLAN_SALES, { tenantId: TA }, { execute: executeQuery, getVersion: dataVersion.getTenantVersion });
  check("race: answer computed before a concurrent write is not stored", before.cache.stored === false && later.cache.status === "miss" && total(later.result).invoiceCount === 4, `${before.cache.stored} ${later.cache.status} ${JSON.stringify(total(later.result))}`);
  unsubRace();

  // concurrent identical requests + concurrent write: never more stale than the read/write order allows
  const cc = createAnswerCache();
  const ccDeps = { execute: executeQuery, getVersion: dataVersion.getTenantVersion };
  const burst = await Promise.all([...Array.from({ length: 6 }, () => cc.run(PLAN_SALES, { tenantId: TA }, ccDeps)), Sale.create(saleDoc(TA, `${GA}-901`, "RACE-2", 3))]);
  await new Promise((res) => setTimeout(res, 50));
  const settled = await cc.run(PLAN_SALES, { tenantId: TA }, ccDeps);
  const truth = await fresh(PLAN_SALES, TA);
  check("after a burst with a concurrent write, the cache serves the fresh truth", JSON.stringify(total(settled.result)) === JSON.stringify(total(truth)) && total(truth).invoiceCount === 5, `${JSON.stringify(total(settled.result))} vs ${JSON.stringify(total(truth))} (burst=${burst.length})`);

  // ================================================================ F. parity
  section("F. cached answers equal uncached engine answers");
  const plans = [PLAN_SALES, PLAN_PURCHASE, PLAN_GROUP, { ...PLAN_SALES, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 5 }, { v: 1, entity: "sales", mode: "list", period: { kind: "all_time" }, filters: [], sort: [{ by: "date", dir: "desc" }], limit: 3 }];
  for (const [i, p] of plans.entries()) {
    await execute(p, TA);
    const cached = await execute(p, TA);
    const truth2 = await fresh(p, TA);
    const strip = (o) => JSON.stringify(o, (k, v) => (k === "diagnostics" ? undefined : v));
    check(`plan ${i + 1}: cached hit is identical to a fresh engine run`, cached.cache.status === "hit" && strip(cached.result) === strip(truth2));
  }

  unsub();
}

// ================================================================== main

(async () => {
  await fakeSection();
  await connectDB();
  try {
    await cleanup();
    await writeKindsSection();
    await cleanup();
    await realPathsSection();
  } catch (e) {
    console.error(e);
    check("no unexpected exception in DB sections", false, e.message);
  } finally {
    await cleanup();
    await mongoose.disconnect().catch(() => {});
  }
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
