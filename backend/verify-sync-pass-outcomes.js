/**
 * runSyncForCompanyModule: what ONE sync pass returns and what it leaves on the checkpoint, for every way a pass can end.
 * The pass has many exits (company guard, classification, probe, fetch, ownership, completeness, persist, advance) and each one
 * releases the lock with its own status/error/advance. This pins all of them, so the function can be split into smaller steps
 * (one release in one place) without changing any outcome.
 *
 * For each case it records the returned result and the checkpoint after the pass (status, error text, lastAlterId, isRunning,
 * lockedAt, whether lastSuccessAt was set) as canonical JSON and compares its SHA-256 with GOLDEN, taken from the code before
 * the split. Offline: Tally is not contacted (the open-company guard and the voucher-type classification are stubbed, the
 * module's fetch/probe/persist functions are plain stubs); the checkpoint lives in a LOOPBACK test MongoDB only.
 *
 * Run: MONGODB_URI=mongodb://127.0.0.1:27017/tallypulse_test node verify-sync-pass-outcomes.js
 *      ... --print     prints each case as readable JSON (to inspect, or to refresh GOLDEN after an intended change)
 */
process.env.AI_USAGE_PERSIST = "off";
const crypto = require("crypto");
const path = require("path");
const mongoose = require("mongoose");
const { connectGuarded } = (() => { const m = require("./src/config/db"); return { connectGuarded: m.connectGuarded }; })();

// ---- stubs for the two Tally-facing calls the pass makes before it reaches the module's own functions
let guardAnswer = { ok: true };
let classAnswer = { sales: { status: "ok", typeNames: ["Sales"] }, purchase: { status: "ok", typeNames: ["Purchase"] } };
const stub = (rel, exports) => { const file = require.resolve(path.join(__dirname, "src", rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
stub("services/auth/tallyCompanyGuard.js", { verifyOpenTallyCompany: async () => guardAnswer, resolveSelectedOpenCompany: async () => ({ ok: false }), detectOpenTallyCompany: async () => ({ ok: false }) });
stub("services/tally/voucherTypeClassifier.js", { resolveVoucherTypeClassification: async () => classAnswer, clearVoucherTypeClassificationCache: () => {} });

const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const { runSyncForCompanyModule } = require("./src/services/sync/tallySyncWorker");

const TENANT = "verify-pass-outcomes-tenant";
const GUID = "verify-pass-outcomes-guid";
const company = { tenantId: TENANT, companyGuid: GUID };
const VT = "Purchase";

const sha = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const v = (i, alter, guid = `${GUID}-${i}`) => ({ guid, alterid: String(alter), vouchernumber: `V-${i}` });
const rows = (list) => ({ data: { collection: list } });

// a module whose probe/fetch/persist behave as the case says
function mod({ probe, fetch, persist, noProbe = false } = {}) {
  const m = {
    voucherType: VT,
    classificationKey: "purchase",
    fetchVouchersSinceAlterId: fetch || (async () => rows([])),
    processVoucher: persist || (async (voucher) => ({ status: "created", tallyAlterId: Number(voucher.alterid) })),
  };
  if (!noProbe) m.fetchPendingAlterIds = probe || (async () => rows([]));
  return m;
}
const ids = (...a) => rows(a.map((n) => ({ alterid: String(n) })));

async function freshCheckpoint(over = {}) {
  await SyncCheckpoint.deleteMany({ tenantId: TENANT });
  await SyncCheckpoint.create({ tenantId: TENANT, companyGuid: GUID, voucherType: VT, lastAlterId: 100, lastRunStatus: "never_run", isRunning: false, lockedAt: null, ...over });
}

const CASES = [
  ["locked: another run holds a fresh lock", { pre: { isRunning: true, lockedAt: new Date() }, mod: mod() }],
  ["guard: Tally unreachable", { guard: { ok: false, reason: "unreachable", message: "Tally is not reachable." }, mod: mod() }],
  ["guard: another company is open (routine, not a failure)", { guard: { ok: false, reason: "mismatch", message: "different company open" }, mod: mod() }],
  ["classification: needs configuration, with its reason", { cls: { purchase: { status: "needs_configuration", reason: "two Purchase roots" } }, mod: mod() }],
  ["classification: failed, with its reason", { cls: { purchase: { status: "error", reason: "master read failed" } }, mod: mod() }],
  ["classification: missing for this module (default message)", { cls: {}, mod: mod() }],
  ["probe: nothing pending (steady state)", { mod: mod({ probe: async () => ids() }) }],
  ["probe: throws", { mod: mod({ probe: async () => { throw new Error("probe timeout"); } }) }],
  ["probe: rows without readable AlterIDs", { mod: mod({ probe: async () => rows([{ x: 1 }, { x: 2 }]) }) }],
  ["fetch: throws", { mod: mod({ probe: async () => ids(101, 102), fetch: async () => { throw new Error("fetch timeout"); } }) }],
  ["fetch: returns nothing although the probe listed vouchers is an incomplete fetch", { mod: mod({ probe: async () => ids(101, 102), fetch: async () => rows([]) }) }],
  ["no probe: fetch returns nothing (steady state)", { mod: mod({ noProbe: true, fetch: async () => rows([]) }) }],
  ["ownership: a voucher that is not this company's rejects the whole batch", { mod: mod({ probe: async () => ids(101, 102), fetch: async () => rows([v(1, 101), v(2, 102, "some-other-company-guid-9")]) }) }],
  ["completeness: one expected AlterID missing", { mod: mod({ probe: async () => ids(101, 102, 103), fetch: async () => rows([v(1, 101), v(3, 103)]) }) }],
  ["persist: some vouchers fail (checkpoint stays)", { mod: mod({ probe: async () => ids(101, 102, 103), fetch: async () => rows([v(1, 101), v(2, 102), v(3, 103)]), persist: async (x) => (x.alterid === "102" ? { status: "failed", message: "bad party" } : { status: "created", tallyAlterId: Number(x.alterid) }) }) }],
  ["success: unbounded batch advances to the highest AlterID", { mod: mod({ probe: async () => ids(101, 105, 103), fetch: async () => rows([v(1, 101), v(2, 105), v(3, 103)]) }) }],
  ["success: every status counted (created, updated, duplicate, skipped)", { mod: mod({ probe: async () => ids(101, 102, 103, 104), fetch: async () => rows([v(1, 101), v(2, 102), v(3, 103), v(4, 104)]), persist: async (x) => ({ status: ["created", "updated", "duplicate", "skipped"][Number(x.alterid) - 101], tallyAlterId: Number(x.alterid) }) }) }],
  ["success: bounded slice advances to its cut-off even if the last vouchers carry no AlterID", { batchSize: 2, mod: mod({ probe: async () => ids(101, 102, 103, 104, 105), fetch: async () => rows([v(1, 101), v(2, 102)]), persist: async (x) => ({ status: "skipped" }) }) }],
  ["success: module without a probe advances to the highest returned AlterID", { mod: mod({ noProbe: true, fetch: async () => rows([v(1, 150), v(2, 120)]) }) }],
];

async function runCase(spec) {
  guardAnswer = spec.guard || { ok: true };
  classAnswer = spec.cls || { sales: { status: "ok", typeNames: ["Sales"] }, purchase: { status: "ok", typeNames: ["Purchase"] } };
  await freshCheckpoint(spec.pre);
  const warn = console.warn, err = console.error; console.warn = () => {}; console.error = () => {};
  let result;
  try { result = await runSyncForCompanyModule(company, spec.mod, { batchSize: spec.batchSize || 500, intervalSeconds: 60 }); } finally { console.warn = warn; console.error = err; }
  const c = await SyncCheckpoint.findOne({ tenantId: TENANT, companyGuid: GUID, voucherType: VT }).lean();
  return { result, checkpoint: { lastRunStatus: c.lastRunStatus, lastError: c.lastError || null, lastAlterId: c.lastAlterId, isRunning: c.isRunning, lockedAt: c.lockedAt ? "set" : null, lastSuccessAt: c.lastSuccessAt ? "set" : null } };
}

// Recorded from the code BEFORE the pass was split into steps (refresh with --print only for an intended change).
const GOLDEN = {
  "locked: another run holds a fresh lock": "b5ad7286c86a4c84147b10b3af8730d591c1ef6eb4837491af0f43edbaa6dedb",
  "guard: Tally unreachable": "21fa04e90ccc8bcdc3bd790dbdca30a7df543e729f090b69466761854809e95a",
  "guard: another company is open (routine, not a failure)": "1bba1091b56787fc067ae78ac8dde3ef67f5c617b0362c547c65c964c10fca94",
  "classification: needs configuration, with its reason": "31a3f4a00226d5f7111148a4b19d87533889118eac63e52b72905483ff066972",
  "classification: failed, with its reason": "a166d516a3169ac1ec93f05b3245af046a960b20f2e99456bbdc84e22961e110",
  "classification: missing for this module (default message)": "ab1a2ac4d666a5e0efaf4bef38ec9db5e2a82b4df4cef2b21d27f0159eb183f7",
  "probe: nothing pending (steady state)": "1bba1091b56787fc067ae78ac8dde3ef67f5c617b0362c547c65c964c10fca94",
  "probe: throws": "069244546158343fefc7c490607586bafc47ae55f09ed502ace7d7f861454b61",
  "probe: rows without readable AlterIDs": "94fe6d735d08ab0e28a3b7ce30b9e42b9d0c71a0bcea62e3a9f343933dc8d4ef",
  "fetch: throws": "9a435d70dbd4bdae94f29d38e0bc7ad13eb6955ca3a4a8177fb9e7da56919da0",
  "fetch: returns nothing although the probe listed vouchers is an incomplete fetch": "fbc4346d66016efec553c4856f1c0dbe76aceba207470e0db4fbb032c7a0987c",
  "no probe: fetch returns nothing (steady state)": "1bba1091b56787fc067ae78ac8dde3ef67f5c617b0362c547c65c964c10fca94",
  "ownership: a voucher that is not this company's rejects the whole batch": "bf75c840d9c5de58ed5ff98a2b40c1f5f4a214928bd308d7874b5eaf92928799",
  "completeness: one expected AlterID missing": "31c9c80fc771908da111886627351a0b06bbe2aa2520cfa67f6569b9d0251382",
  "persist: some vouchers fail (checkpoint stays)": "a9b59ceaffc54b13d1a5918d396e67ee131730865c6d97adb966b8eb3b6892dc",
  "success: unbounded batch advances to the highest AlterID": "8e2ed1fee869a0a2ec0bf7035a0f1be4503d20bb86483fdf936f2f77e0fa7104",
  "success: every status counted (created, updated, duplicate, skipped)": "36cecd1f4c95ebe55b863add7b89f1e247addc44f1ba4bc2ab8eaca966306340",
  "success: bounded slice advances to its cut-off even if the last vouchers carry no AlterID": "47d07c143e7f02085d731fe7db804b36cb18be6eedb678955aeb194ff7f033df",
  "success: module without a probe advances to the highest returned AlterID": "d85fb2687a8caa35ff82c2ffa5e402617277cc6225f6200f241c080faca4c281"
};

(async () => {
  await connectGuarded();
  let pass = 0, fail = 0;
  const printing = process.argv.includes("--print");
  const out = {};
  try {
    for (const [name, spec] of CASES) {
      const got = await runCase(spec);
      out[name] = got;
      if (printing) { console.log(`\n## ${name}\n${JSON.stringify(got)}`); continue; }
      const ok = GOLDEN[name] === sha(got);
      console.log(`${ok ? "PASS" : "FAIL"} | ${name}${ok ? "" : `\n      got ${JSON.stringify(got)}`}`);
      ok ? pass++ : fail++;
    }
  } finally {
    await SyncCheckpoint.deleteMany({ tenantId: TENANT });
    await mongoose.disconnect();
  }
  if (printing) { console.log("\n## GOLDEN\n" + JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, x]) => [k, sha(x)])), null, 2)); return; }
  console.log(`\nverify-sync-pass-outcomes: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
