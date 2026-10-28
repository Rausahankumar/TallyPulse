"use strict";

/**
 * REAL-DATA VALIDATION of the analysis findings (services/query/evidence.js), READ-ONLY.
 *
 * Fixed, scripted analysis plans (no model) run through the real executeAnalysisPlan and formatAnalysisAnswer on ONE
 * real company, and every figure is checked against an INDEPENDENTLY written aggregate (its own date bounds, grouping and
 * sums; no engine code). Acceptance criteria:
 *   A1 numbers     - figures in findings equal the reference aggregates to the paisa; breakdowns add up to their change
 *   A2 incomplete  - a period ending after the latest voucher (dc.latestVoucher) is never presented as a full-period change
 *   A3 contributors- a list ordered against a change names no contributor; two lists of one change give one breakdown
 *   A4 empty       - steps with no records give no finding; a measured zero (nothing now, something before) still does
 *   A5 data state  - freshness, sync checkpoints and the latest voucher are reported (stale books are not performance)
 *   A6 safety      - another tenant's run never shows this company's names; zero writes; bounded reads; no model, no Tally
 * Expectations are DERIVED from the reference aggregates (which direction a change has, whether a list is cut, whether a
 * period is complete), never hard-coded to a date, customer or amount.
 *
 * Modes:
 *   (default)              DRY RUN. No connection: validates every plan, the write trap, the host guard and the network
 *                          block. Safe anywhere.
 *   --approve-atlas-read   LIVE READ. Connects to MONGODB_URI read-only; requires --expect-host=<exact host>,
 *                          --expect-db=<database>, --expect-tenant=<tenant id> and --expect-guid=<company GUID>; proves the write trap on the real driver first; refuses unless the company named --company (default "WE FOUR")
 *                          has that GUID. Never run without the owner's approval for that run.
 * Exit codes: 0 all checks passed, 1 a check failed, 2 refused (guard), 3 NOT RUN (company absent), 4 internal error.
 *
 * Never writes: every driver write method (and $out/$merge) throws before reaching the server, index/collection creation
 * is off, reads are capped (MAX_READS) and every reference aggregate has maxTimeMS. No Claude, no Tally, no network.
 *
 * Run: node eval-findings-real.js
 *      node eval-findings-real.js --approve-atlas-read --expect-host=<host> --expect-db=<db> --expect-tenant=<id> --expect-guid=<guid>   (approved runs only)
 */

// ---- arguments: an allow-list, each flag at most once, no positional arguments; anything else is refused (fail closed)
const VALUE_FLAGS = ["expect-host", "expect-db", "expect-tenant", "expect-guid", "company", "only"];
const BOOLEAN_FLAGS = ["approve-atlas-read"];
const ONLY_MODES = ["a4-measured-zero"];
function parseArgs(argv) {
  const values = {}, flags = {};
  for (const a of argv) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(a);
    if (!m) return { ok: false, error: `unexpected argument "${a}"` };
    const [, name, value] = m;
    if (BOOLEAN_FLAGS.includes(name) && value === undefined) {
      if (flags[name]) return { ok: false, error: `--${name} given twice` };
      flags[name] = true;
    } else if (VALUE_FLAGS.includes(name) && value !== undefined) {
      if (name in values) return { ok: false, error: `--${name} given twice` };
      if (!value.trim()) return { ok: false, error: `--${name} is empty` };
      values[name] = value;
    } else return { ok: false, error: `unknown or malformed flag "--${name}"` };
  }
  if ("only" in values && !ONLY_MODES.includes(values.only)) return { ok: false, error: `--only must be one of: ${ONLY_MODES.join(", ")}` };
  return { ok: true, values, flags };
}
const PARSED = parseArgs(process.argv.slice(2));
const opt = (name) => (PARSED.ok && name in PARSED.values ? PARSED.values[name] : null);
const flag = (name) => !!(PARSED.ok && PARSED.flags[name]);
const LIVE = flag("approve-atlas-read");

// ---- what a live run executes. Full: every section. --only=a4-measured-zero: the Dec-vs-Nov step and its two reference
// aggregates, the A4 measured-zero assertion only, the company looked up by its own name (no other company or tenant is
// read), a tighter read cap. Assertions outside the scope throw (see check), so a slip ends the run instead of widening it.
const ALL_SECTIONS = ["a5-data-state", "monthly", "two-lists", "increase-lists", "dec-vs-nov", "empty", "difference", "isolation"];
function runScope(only) {
  if (!only) return { only: null, sections: ALL_SECTIONS, checks: null, companyLookup: "all", otherTenant: true, maxReads: 400 };
  if (only === "a4-measured-zero") return { only, sections: ["dec-vs-nov"], checks: ["A4-measured-zero"], companyLookup: "by-name", otherTenant: false, maxReads: 40 };
  return null; // unknown: never reached (parseArgs refuses it), and never widened to a full run
}
let allowedChecks = null; // set by a scoped live run
const EXIT = { PASS: 0, FAIL: 1, REFUSED: 2, NOT_RUN: 3, ERROR: 4 };
const MAX_READS = 400; // driver read calls for the whole run (the engine issues several per step)
let readCap = MAX_READS; // lowered by a scoped run (runScope)
const ORACLE_MAX_TIME_MS = 20000;

// ---- no network at all: no model, no Tally (the database driver uses its own sockets)
{
  const axios = require("axios");
  for (const m of ["get", "post", "put", "patch", "delete", "request"]) axios[m] = () => { throw new Error("NETWORK BLOCKED (eval-findings-real)"); };
}

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  if (allowedChecks && !allowedChecks.has(id)) throw new Error(`SCOPE VIOLATION: check ${id} is outside --only=${opt("only")}`);
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n         ${String(detail).slice(0, 700)}`}`);
  if (ok) pass += 1; else fail += 1;
}

// ---------------------------------------------------------------- write trap and read budget (driver level)
const WRITE_METHODS = ["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete", "bulkWrite", "createIndex", "createIndexes", "dropIndex", "dropIndexes", "drop", "rename"];
const READ_METHODS = ["aggregate", "find", "findOne", "countDocuments", "estimatedDocumentCount", "distinct"];
const io = { writesAttempted: 0, reads: 0 };
const TRAPPED = new Set(); // the installed write blockers, by identity
function installTrap(mongodb) {
  const proto = mongodb.Collection.prototype;
  for (const m of WRITE_METHODS) {
    if (typeof proto[m] !== "function") continue;
    proto[m] = function blockedWrite() { io.writesAttempted += 1; throw new Error(`WRITE BLOCKED: ${m} on ${this && this.collectionName}`); };
    TRAPPED.add(proto[m]);
  }
  for (const m of READ_METHODS) {
    const original = proto[m];
    if (typeof original !== "function") continue;
    proto[m] = function countedRead(...a) {
      io.reads += 1;
      if (io.reads > readCap) throw new Error(`READ BUDGET EXCEEDED (${readCap})`);
      if (m === "aggregate" && Array.isArray(a[0]) && a[0].some((s) => s && (s.$out || s.$merge))) { io.writesAttempted += 1; throw new Error("WRITE BLOCKED: $out/$merge"); }
      return original.apply(this, a);
    };
  }
  for (const m of ["createCollection", "dropDatabase", "renameCollection", "dropCollection"]) {
    if (typeof mongodb.Db.prototype[m] === "function") {
      mongodb.Db.prototype[m] = function blockedDb() { io.writesAttempted += 1; throw new Error(`WRITE BLOCKED: ${m}`); };
      TRAPPED.add(mongodb.Db.prototype[m]);
    }
  }
}

/**
 * Is the trap in place? Checked WITHOUT issuing any database operation: every write method of the driver's Collection
 * (and the collection-level Db methods) is an installed blocker (by identity), a collection object from the live
 * connection - if given; creating one sends nothing - resolves its write methods to those blockers, and a blocker called
 * on a detached stand-in (not a collection) throws. Returns the problems found (empty = armed).
 */
function trapProblems(mongodb, liveCollection = null) {
  const problems = [];
  const proto = mongodb.Collection.prototype;
  for (const m of WRITE_METHODS) if (typeof proto[m] === "function" && !TRAPPED.has(proto[m])) problems.push(`Collection.${m}`);
  for (const m of ["createCollection", "dropDatabase", "renameCollection", "dropCollection"]) if (typeof mongodb.Db.prototype[m] === "function" && !TRAPPED.has(mongodb.Db.prototype[m])) problems.push(`Db.${m}`);
  if (liveCollection) for (const m of WRITE_METHODS) if (typeof liveCollection[m] === "function" && !TRAPPED.has(liveCollection[m])) problems.push(`instance.${m}`);
  const before = io.writesAttempted;
  let threw = false;
  try { proto.deleteMany.call({ collectionName: "detached-stand-in" }); } catch (e) { threw = /WRITE BLOCKED/.test(e.message); }
  io.writesAttempted = before; // a deliberate, detached probe: not a write attempt of the run
  if (!threw) problems.push("detached call did not throw");
  return problems;
}

/**
 * A measured-absence finding ("<scope>: none recorded in <period> for A (₹x in <before>), B (₹y in <before>) and N more.")
 * against the independently computed reference: name -> previous-period value of every LISTED customer with nothing in
 * the period. Order-free: every named customer must be in the reference set, named once, with the reference previous
 * value, and named + N must equal the reference count. Returns the problems found (empty = valid).
 */
function absenceProblems(text, reference) {
  const m = /none recorded in .+? for (.+?)(?: and (\d+) more)?\. The data shows the absence, not its reason\./.exec(text || "");
  if (!m) return ["the finding is not a measured-absence sentence"];
  const named = [];
  const item = /(?:^|, )(.+?) \(₹(-?[\d,]+\.\d{2}) in [^)]*\)/g;
  let it, consumed = 0;
  while ((it = item.exec(m[1]))) {
    if (it.index !== consumed) break;
    named.push({ name: it[1], previous: Number(it[2].replace(/,/g, "")) });
    consumed = item.lastIndex;
  }
  const problems = [];
  if (!named.length || consumed !== m[1].length) problems.push("the named customers could not be read completely");
  const seen = new Set();
  for (const { name, previous } of named) {
    if (seen.has(name)) problems.push(`named twice: ${name}`);
    seen.add(name);
    if (!reference.has(name)) problems.push(`not in the reference set: ${name}`);
    else if (Math.abs(reference.get(name) - previous) >= 0.005) problems.push(`previous value of ${name} is ${previous}, reference ${reference.get(name)}`);
  }
  const more = m[2] ? Number(m[2]) : 0;
  if (named.length + more !== reference.size) problems.push(`named ${named.length} + "and ${more} more" = ${named.length + more}, reference ${reference.size}`);
  return problems;
}

/** Which company the run reads: exactly one company of that name whose GUID is the expected one; anything else fails closed. */
function companyGuard(companies, name, expectGuid, expectTenant) {
  if (!expectGuid || !expectTenant) return { status: "refused", reason: "--expect-guid=<company GUID> and --expect-tenant=<tenant id> are required for a live read." };
  const matches = companies.filter((c) => c.companyName === name);
  if (!matches.length) return { status: "not_run", reason: `company "${name}" is not present in this database.` };
  if (matches.length > 1) return { status: "refused", reason: `more than one company is named "${name}".` };
  const co = matches[0];
  if (co.companyGuid !== expectGuid) return { status: "refused", reason: "the company's GUID is not the expected one." };
  if (typeof co.tenantId !== "string" || !co.tenantId) return { status: "refused", reason: "the company has no tenant." };
  if (co.tenantId !== expectTenant) return { status: "refused", reason: "the company's tenant is not the expected one." };
  return { status: "ok", co };
}

/** The connection target: the exact expected host AND database, never shown with credentials. */
function checkTarget(uri, expectHost, expectDb, parseMongoUri) {
  if (!expectHost || !expectDb) return { ok: false, reason: "--expect-host=<exact host> and --expect-db=<database> are required for a live read." };
  const parsed = parseMongoUri(uri);
  if (!parsed) return { ok: false, reason: "MONGODB_URI is not a usable connection string." };
  if (parsed.hosts.length !== 1 || parsed.host !== expectHost) return { ok: false, reason: "MONGODB_URI does not point at the expected host." };
  if (parsed.dbName !== expectDb) return { ok: false, reason: "MONGODB_URI does not name the expected database." };
  return { ok: true, host: parsed.host, dbName: parsed.dbName };
}

// ---------------------------------------------------------------- the scripted plans (fixed periods of the live transcript)
const P = (from, to) => ({ kind: "custom", from, to });
const q = (o) => ({ v: 1, entity: "sales", mode: "aggregate", metrics: ["invoiceAmount"], groupBy: [], filters: [], ...o });
const byCustomer = (dir, limit) => ({ groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir }], limit });
const NOVDEC = P("2025-11-01", "2025-12-31"), SEPOCT = P("2025-09-01", "2025-10-31"), MAYJUN = P("2025-05-01", "2025-06-30");
const CASES = {
  // A1/A2: month by month May-Dec 2025
  monthly: { v: 1, steps: [{ id: "months", kind: "query", plan: q({ period: P("2025-05-01", "2025-12-31"), groupBy: [{ dim: "date", bucket: "month" }], sort: [{ by: "date", dir: "asc" }], limit: 12 }) }] },
  // A2/A3 (Q6 shape): one change, listed by largest increase AND by largest fall
  twoLists: { v: 1, steps: [
    { id: "total", kind: "query", plan: q({ period: NOVDEC, compare: { mode: "custom", period: SEPOCT } }) },
    { id: "up", kind: "query", plan: q({ period: NOVDEC, compare: { mode: "custom", period: SEPOCT }, ...byCustomer("desc", 20) }) },
    { id: "down", kind: "query", plan: q({ period: NOVDEC, compare: { mode: "custom", period: SEPOCT }, ...byCustomer("asc", 20) }) },
  ] },
  // A3 (Q5 shape): customers and products, both listed by largest increase
  increaseLists: { v: 1, steps: [
    { id: "customers", kind: "query", plan: q({ period: NOVDEC, compare: { mode: "custom", period: MAYJUN }, ...byCustomer("desc", 20) }) },
    { id: "products", kind: "query", plan: q({ period: NOVDEC, compare: { mode: "custom", period: MAYJUN }, metrics: ["lineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount.delta", dir: "desc" }], limit: 20 }) },
  ] },
  // A2/A3/A4 (Q4 shape): Dec vs Nov, largest fall first, first 100
  decVsNov: { v: 1, steps: [{ id: "customers", kind: "query", plan: q({ period: P("2025-12-01", "2025-12-31"), compare: { mode: "custom", period: P("2025-11-01", "2025-11-30") }, ...byCustomer("asc", 100) }) }] },
  // A4: periods with no records
  empty: { v: 1, steps: [
    { id: "after_data", kind: "query", plan: q({ period: P("2025-12-09", "2025-12-31"), groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 10 }) },
    { id: "later_compared", kind: "query", plan: q({ period: P("2026-10-01", "2026-10-20"), compare: { mode: "custom", period: P("2026-09-01", "2026-09-20") }, ...byCustomer("asc", 10) }) },
    { id: "sales_later", kind: "query", plan: q({ period: P("2026-10-01", "2026-10-20") }) },
    { id: "purchases_later", kind: "query", plan: q({ entity: "purchase", metrics: ["purchaseAmount"], period: P("2026-10-01", "2026-10-20") }) },
  ] },
  // A1: sales minus purchases in a complete month
  difference: { v: 1, steps: [
    { id: "sales", kind: "query", plan: q({ period: P("2025-11-01", "2025-11-30") }) },
    { id: "purchases", kind: "query", plan: q({ entity: "purchase", metrics: ["purchaseAmount"], period: P("2025-11-01", "2025-11-30") }) },
  ] },
};
// What a scoped run may READ (checked before every query): its plans, on the guarded tenant only, and its reference sums.
const SCOPE_READS = {
  "a4-measured-zero": { plans: [CASES.decVsNov], references: ["sales|2025-12-01|2025-12-31|customer|invoice", "sales|2025-11-01|2025-11-30|customer|invoice"] },
};
/** Throws unless this analysis plan, on this tenant, is allowed by the scope (a full run allows every plan and the isolation tenant). */
function assertPlanInScope(scope, plan, tenantId, guardedTenantId) {
  if (!scope.only) return;
  if (tenantId !== guardedTenantId) throw new Error("SCOPE VIOLATION: a scoped run reads only the guarded company's tenant");
  if (!SCOPE_READS[scope.only].plans.includes(plan)) throw new Error("SCOPE VIOLATION: plan outside the scope");
}
/** The reference aggregates a scoped run may use; any other reference query throws before it is sent. */
function scopedOracle(scope, oracle) {
  if (!scope.only) return oracle;
  const allowed = new Set(SCOPE_READS[scope.only].references);
  return {
    sums: (entity, from, to, by, value) => {
      if (!allowed.has([entity, from, to, by, value].join("|"))) throw new Error(`SCOPE VIOLATION: reference ${[entity, from, to, by, value].join("|")}`);
      return oracle.sums(entity, from, to, by, value);
    },
    total: () => { throw new Error("SCOPE VIOLATION: reference total outside the scope"); },
    latestDay: () => { throw new Error("SCOPE VIOLATION: reference latest-day outside the scope"); },
  };
}
// A6: the same customer list for another tenant
const ISOLATION_PLAN = { v: 1, steps: [{ id: "customers", kind: "query", plan: q({ period: P("2025-05-01", "2025-12-31"), groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 100 }) }] };

// ---------------------------------------------------------------- independent reference aggregates (no engine code)
const r2 = (n) => Math.round(n * 100) / 100;
const near = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.005;
const dayStart = (iso) => new Date(`${iso}T00:00:00.000Z`); // vouchers are stored at UTC midnight of their Tally date
const dayEnd = (iso) => new Date(`${iso}T23:59:59.999Z`);
const LINE_VALUE = { sales: 1, purchase: -1 }; // pre-tax line value read as a positive figure on both sides

function makeOracle({ Sale, Purchase }, tenantId) {
  const model = (entity) => (entity === "purchase" ? Purchase : Sale);
  /** Sum per key over [from, to]: by "customer" | "product" | "month" | null (one total); value "invoice" | "line". */
  async function sums(entity, from, to, by, value) {
    const pipeline = [{ $match: { tenantId, voucherStatus: "active", "header.voucherDate": { $gte: dayStart(from), $lte: dayEnd(to) } } }];
    if (value === "line") pipeline.push({ $unwind: "$inventory" });
    const key = by === "customer" ? "$header.partyName" : by === "product" ? "$inventory.itemName" : by === "month" ? { $dateToString: { format: "%Y-%m", date: "$header.voucherDate", timezone: "UTC" } } : null;
    const amount = value === "line" ? { $multiply: [LINE_VALUE[entity], "$inventory.amount"] } : "$header.voucherTotalAmount";
    pipeline.push({ $group: { _id: key, v: { $sum: amount }, n: { $sum: 1 } } });
    const rows = await model(entity).aggregate(pipeline).option({ maxTimeMS: ORACLE_MAX_TIME_MS });
    return new Map(rows.map((x) => [x._id === null ? "" : x._id, { v: r2(x.v), n: x.n }]));
  }
  const total = async (entity, from, to, value = "invoice") => ((await sums(entity, from, to, null, value)).get("") || { v: 0, n: 0 });
  async function latestDay() {
    const last = async (M) => (await M.aggregate([{ $match: { tenantId, voucherStatus: "active" } }, { $group: { _id: null, d: { $max: "$header.voucherDate" } } }]).option({ maxTimeMS: ORACLE_MAX_TIME_MS }))[0];
    const ds = [await last(Sale), await last(Purchase)].filter((x) => x && x.d).map((x) => x.d.toISOString().slice(0, 10));
    return ds.sort().pop() || null;
  }
  return { sums, total, latestDay };
}

// ---------------------------------------------------------------- live run
async function live() {
  const scope = runScope(opt("only"));
  if (!scope) { console.log("REFUSED: the requested scope is not known."); return EXIT.REFUSED; }
  readCap = scope.maxReads;
  const want = (section) => scope.sections.includes(section);
  require("dotenv").config({ quiet: true });
  const mongoose = require("mongoose");
  const { parseMongoUri } = require("./src/config/db");
  const target = checkTarget(process.env.MONGODB_URI, opt("expect-host"), opt("expect-db"), parseMongoUri);
  if (!target.ok) { console.log(`REFUSED: ${target.reason}`); return EXIT.REFUSED; }
  if (!opt("expect-guid") || !opt("expect-tenant")) { console.log("REFUSED: --expect-guid=<company GUID> and --expect-tenant=<tenant id> are required for a live read."); return EXIT.REFUSED; }
  installTrap(mongoose.mongo);
  const unarmed = trapProblems(mongoose.mongo);
  if (unarmed.length) { console.log(`REFUSED: the write trap is not active (${unarmed.slice(0, 5).join(", ")}); nothing was connected.`); return EXIT.REFUSED; }
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
  try {
    // the live connection's collections resolve their writes to the trap (a collection handle sends nothing to the server)
    const instanceProblems = trapProblems(mongoose.mongo, mongoose.connection.db.collection("companies"));
    if (instanceProblems.length) { console.log(`REFUSED: the write trap is not active on the connection (${instanceProblems.slice(0, 5).join(", ")}).`); return EXIT.REFUSED; }
    console.log("write trap armed on the database driver (checked without any database operation)");
    const Company = require("./src/models/company");
    const Sale = require("./src/models/sales.model");
    const Purchase = require("./src/models/purchase.model");
    const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
    const companyName = opt("company") || "WE FOUR";
    // a scoped run reads only the company records carrying that name (duplicates are still detected and refused)
    const companies = await Company.find(scope.companyLookup === "by-name" ? { companyName } : {}).select({ companyName: 1, companyGuid: 1, tenantId: 1 }).lean();
    const guard = companyGuard(companies, companyName, opt("expect-guid"), opt("expect-tenant"));
    if (guard.status === "not_run") { console.log(`NOT RUN: ${guard.reason}`); return EXIT.NOT_RUN; }
    if (guard.status !== "ok") { console.log(`REFUSED: ${guard.reason}`); return EXIT.REFUSED; }
    const co = guard.co;
    const other = scope.otherTenant ? companies.find((c) => c.tenantId && c.tenantId !== co.tenantId) : null;
    allowedChecks = scope.checks ? new Set(scope.checks) : null;
    console.log(`company "${companyName}" (GUID and tenant verified) on ${target.host}/${target.dbName}; read-only; writes trapped; reads capped at ${readCap}${scope.only ? `; scope --only=${scope.only}: ${scope.sections.join(", ")} -> ${scope.checks.join(", ")}` : ""}`);

    const { executeAnalysisPlan } = require("./src/services/query/analysisPlan");
    const { formatAnalysisAnswer } = require("./src/services/query/analysisAnswer");
    const { getTenantDateContext } = require("./src/services/analytics/referenceDate");
    const { getFreshness } = require("./src/services/analytics/freshness");
    const { fmtMoney } = require("./src/services/query/answerFormatter");
    const oracle = scopedOracle(scope, makeOracle({ Sale, Purchase }, co.tenantId));
    const dc = await getTenantDateContext(co.tenantId);
    const pad = (n) => String(n).padStart(2, "0");
    const localDay = (d) => (d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null);
    const dataDay = localDay(dc.latestVoucher);
    const run = async (tenantId, plan, dateContext = dc) => {
      assertPlanInScope(scope, plan, tenantId, co.tenantId);
      const execution = await executeAnalysisPlan(plan, { tenantId, dateContext, dataThrough: dateContext.latestVoucher });
      const formatted = execution.ok ? formatAnalysisAnswer(execution, { referenceDate: dateContext.referenceDate, dataThrough: dateContext.latestVoucher }) : null;
      return { execution, formatted, evidence: formatted ? formatted.evidence : null };
    };
    const contributors = (e) => e.findings.filter((f) => f.label === "contributor");

    // ---- A5: data state (reported; describes the books, not business performance)
    if (want("a5-data-state")) {
    console.log("\n=== A5. Data state ===");
    const fresh = { sales: await getFreshness(co.tenantId, "Sales"), purchase: await getFreshness(co.tenantId, "Purchase") };
    const checkpoints = await SyncCheckpoint.find({ tenantId: co.tenantId }).select({ voucherType: 1, lastRunStatus: 1, lastSyncedAt: 1, _id: 0 }).lean();
    console.log(`  latest voucher ${dataDay}; reference date ${localDay(dc.referenceDate)}; freshness sales=${fresh.sales.state} purchase=${fresh.purchase.state}`);
    for (const c of checkpoints) console.log(`  checkpoint ${c.voucherType}: ${c.lastRunStatus || "?"} at ${c.lastSyncedAt ? new Date(c.lastSyncedAt).toISOString() : "never"}`);
    const oracleLatest = await oracle.latestDay();
    check("A5-latest-voucher", "the findings' data date (dc.latestVoucher) is the latest active voucher day found independently", dataDay === oracleLatest, `${dataDay} vs ${oracleLatest}`);
    check("A5-state-known", "freshness of both voucher types is known (stale/failed syncs are reported, never read as performance)", !!fresh.sales.state && !!fresh.purchase.state, JSON.stringify([fresh.sales.state, fresh.purchase.state]));
    }

    // ---- A1/A2: month by month
    if (want("monthly")) {
      console.log("\n=== A1/A2. Month by month, May-Dec 2025 ===");
      const { execution, evidence } = await run(co.tenantId, CASES.monthly);
      const st = execution.steps[0];
      const ref = await oracle.sums("sales", "2025-05-01", "2025-12-31", "month", "invoice");
      const rows = (st.result && st.result.rows) || [];
      check("A1-month-values", "every monthly invoice total equals the reference aggregate", st.status === "ok" && rows.length === ref.size && rows.every((r) => ref.has(r.key.date.label) && near(r.values.invoiceAmount, ref.get(r.key.date.label).v)), JSON.stringify(rows.map((r) => [r.key.date.label, r.values.invoiceAmount])));
      const text = evidence.findings.map((f) => f.text).join("\n");
      const months = [...ref.keys()].sort();
      const lastMonth = months[months.length - 1];
      const lastEnd = lastMonth ? new Date(Date.UTC(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5, 7)), 0)).toISOString().slice(0, 10) : null;
      const incomplete = !!(lastEnd && dataDay && lastEnd > dataDay);
      const shownMonths = months.filter((m) => !(incomplete && m === lastMonth));
      check("A1-month-pairs", "each listed month's figure in the findings is the reference figure", shownMonths.slice(1).every((m) => text.includes(fmtMoney(ref.get(m).v))), text);
      if (incomplete) {
        check("A2-month-incomplete", `${lastMonth} ends after the latest voucher (${dataDay}): not compared, and stated as a gap`, !new RegExp(`${monthName(lastMonth)} ${fmtMoney(ref.get(lastMonth).v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} vs`).test(text) && evidence.gaps.some((g) => g.text.includes(`may be incomplete (data up to ${dataDay})`)), JSON.stringify(evidence.gaps));
      } else console.log(`  NOTE - the latest month (${lastMonth}) is complete in this data; A2 is checked by the comparison cases`);
    }

    // ---- A1/A2/A3: one change listed both ways (Q6 shape)
    if (want("two-lists")) {
      console.log("\n=== A1/A2/A3. Nov-Dec vs Sep-Oct 2025, listed by largest increase and by largest fall ===");
      const { execution, evidence } = await run(co.tenantId, CASES.twoLists);
      const [tot, up, down] = execution.steps;
      const cur = await oracle.sums("sales", "2025-11-01", "2025-12-31", "customer", "invoice");
      const prev = await oracle.sums("sales", "2025-09-01", "2025-10-31", "customer", "invoice");
      const T = r2([...cur.values()].reduce((s, x) => s + x.v, 0) - [...prev.values()].reduce((s, x) => s + x.v, 0));
      const tc = tot.result && tot.result.totals && tot.result.totals.comparison && tot.result.totals.comparison.invoiceAmount;
      check("A1-total-change", "the compared total change equals the reference (current - previous)", !!tc && near(tc.delta, T), `${tc && tc.delta} vs ${T}`);
      const deltaOf = (name) => r2(((cur.get(name) || {}).v || 0) - ((prev.get(name) || {}).v || 0));
      check("A1-row-deltas", "every listed customer's change equals the reference", [up, down].every((s) => s.status === "ok" && s.result.rows.every((r) => near(r.comparison.invoiceAmount.delta, deltaOf(r.key.customer)))));
      const ks = contributors(evidence);
      const rankedStep = T < 0 ? 3 : 2;
      check("A3-one-breakdown", `one change listed both ways gives ONE breakdown, from the list ordered in the change's direction (step ${rankedStep})`, T === 0 || (ks.length === 1 && ks[0].steps.join() === String(rankedStep)), JSON.stringify(ks.map((k) => [k.steps, k.text.slice(0, 120)])));
      if (ks.length === 1) {
        const v = ks[0].values;
        check("A1-reconciles", "the breakdown's parts add up to the reference change exactly", near(v.total, T) && near(r2(v.named + v.otherListed + v.notListed), T), JSON.stringify(v));
        const ranked = rankedStep === 3 ? down : up;
        check("A3-limit-stated", "the breakdown states its list size and whether more exist", ks[0].text.includes(ranked.result.truncated ? `first ${ranked.result.rows.length} shown, more exist` : `${ranked.result.rows.length} shown`), ks[0].text);
      }
      const periodIncomplete = dataDay && "2025-12-31" > dataDay;
      if (periodIncomplete) {
        check("A2-compare-incomplete", `Nov-Dec runs past the latest voucher (${dataDay}): the change is flagged incomplete and gapped`, evidence.findings.some((f) => f.text.includes(`(incomplete: data only up to ${dataDay})`)) && evidence.gaps.some((g) => g.text.includes("not a full-period change")), JSON.stringify(evidence));
        check("A2-no-cause", "no possible cause is drawn from the incomplete period", !evidence.findings.some((f) => f.label === "possible_cause"));
      }
    }

    // ---- A3: two lists, both ordered by largest increase (Q5 shape)
    if (want("increase-lists")) {
      console.log("\n=== A3. Nov-Dec vs May-Jun 2025, customers and products listed by largest increase ===");
      const { execution, evidence } = await run(co.tenantId, CASES.increaseLists);
      const Tc = r2((await oracle.total("sales", "2025-11-01", "2025-12-31")).v - (await oracle.total("sales", "2025-05-01", "2025-06-30")).v);
      const Tp = r2((await oracle.total("sales", "2025-11-01", "2025-12-31", "line")).v - (await oracle.total("sales", "2025-05-01", "2025-06-30", "line")).v);
      const ks = contributors(evidence);
      for (const [n, T, label] of [[1, Tc, "customers (invoice amount)"], [2, Tp, "products (pre-tax line amount)"]]) {
        const k = ks.find((f) => f.steps.join() === String(n));
        const st = execution.steps[n - 1];
        check(`A1-total-${n}`, `${label}: the breakdown's total is the reference change`, !!k && near(k.values.total, T), `${k && k.values.total} vs ${T}`);
        if (!k) continue;
        check(`A1-reconciles-${n}`, `${label}: parts add up to the change`, near(r2(k.values.named + k.values.otherListed + k.values.notListed), T), JSON.stringify(k.values));
        if (T < 0 && st.result.truncated) {
          check(`A3-opposite-${n}`, `${label}: listed by largest increase but the change is a fall - names no contributor, says it cannot show what drove it`, k.values.named === 0 && /the opposite direction/.test(k.text) && /cannot show what drove it/.test(k.text) && !st.result.rows.some((r) => k.text.includes(String(r.key.customer || r.key.product))), k.text);
        } else console.log(`  NOTE - ${label}: the change is ${T >= 0 ? "a rise" : "a fall with a complete list"}, so this list is not ordered against it`);
      }
    }

    // ---- A1/A2/A3/A4: Dec vs Nov, largest fall first (Q4 shape); measured zeros
    if (want("dec-vs-nov")) {
      console.log("\n=== A2/A3/A4. Dec vs Nov 2025, largest fall first ===");
      const { execution, evidence } = await run(co.tenantId, CASES.decVsNov);
      const st = execution.steps[0];
      const cur = await oracle.sums("sales", "2025-12-01", "2025-12-31", "customer", "invoice");
      const prev = await oracle.sums("sales", "2025-11-01", "2025-11-30", "customer", "invoice");
      // the data caveat travels with the result (from what the run already read; no extra query)
      console.log(`  data through ${dataDay}; step status ${st.status}, data state ${st.dataState || "fresh"}; Dec 2025 ${dataDay && "2025-12-31" > dataDay ? "is INCOMPLETE: a customer with nothing in it is not a lost customer" : "is complete"}`);
      const k = contributors(evidence)[0];
      const T = r2([...cur.values()].reduce((s, x) => s + x.v, 0) - [...prev.values()].reduce((s, x) => s + x.v, 0));
      if (!scope.only) check("A1-dec-total", "the breakdown's total is the reference Dec - Nov change, and its parts add up", !!k && near(k.values.total, T) && near(r2(k.values.named + k.values.otherListed + k.values.notListed), T), JSON.stringify(k && k.values));
      if (!scope.only && k && T < 0) check("A3-ranked", "ordered by largest fall for a fall: 'Largest contributors', with the list size stated", /^Largest contributors/.test(k.text) && k.text.includes(st.result.truncated ? `first ${st.result.rows.length} shown, more exist` : `${st.result.rows.length} shown`), k.text);
      const listed = new Set(st.result.rows.map((r) => r.key.customer));
      // reference: every LISTED customer with nothing in Dec and something in Nov (name -> Nov value); order is irrelevant
      const zeroNow = new Map([...prev.entries()].filter(([name, x]) => listed.has(name) && !(cur.get(name) && cur.get(name).v) && x.v > 0).map(([name, x]) => [name, x.v]));
      const inactive = evidence.findings.filter((f) => /none recorded in/.test(f.text));
      const problems = inactive.length === 1 ? absenceProblems(inactive[0].text, zeroNow) : [];
      check("A4-measured-zero", "listed customers with nothing in Dec after buying in Nov are ONE measured absence: every named customer is in the reference set with its Nov value, none twice, and named + 'and N more' = the reference count", zeroNow.size === 0 ? inactive.length === 0 : inactive.length === 1 && inactive[0].label === "measured" && problems.length === 0, `${zeroNow.size} reference zeros; ${inactive.length} absence findings; ${problems.slice(0, 5).join("; ")}`);
      if (!scope.only && dataDay && "2025-12-31" > dataDay) check("A2-dec-incomplete", `Dec 2025 runs past the latest voucher (${dataDay}): flagged incomplete`, evidence.gaps.some((g) => g.text.includes("not a full-period change")), JSON.stringify(evidence.gaps));
    }

    // ---- A4: empty periods
    if (want("empty")) {
      console.log("\n=== A4. Periods with no records ===");
      const counts = await Promise.all([["sales", "2025-12-09", "2025-12-31"], ["sales", "2026-10-01", "2026-10-20"], ["sales", "2026-09-01", "2026-09-20"], ["purchase", "2026-10-01", "2026-10-20"]].map(([e, f, t]) => oracle.total(e, f, t).then((x) => x.n)));
      const { execution, evidence } = await run(co.tenantId, CASES.empty);
      console.log(`  reference voucher counts: after-data ${counts[0]}, Oct-2026 sales ${counts[1]}, Sep-2026 sales ${counts[2]}, Oct-2026 purchases ${counts[3]}; step statuses ${execution.steps.map((s) => s.status).join("/")}`);
      if (counts.every((n) => n === 0)) {
        check("A4-no-findings", "steps with no records give no finding at all (no zero change, no 0 - 0 difference)", evidence.findings.length === 0, JSON.stringify(evidence.findings));
      } else console.log("  NOTE - some of these periods have records in this data; A4 empty-step checks are covered by the cases whose reference count is 0 only");
    }

    // ---- A1: sales minus purchases
    if (want("difference")) {
      console.log("\n=== A1. Sales minus purchases, Nov 2025 ===");
      const { evidence } = await run(co.tenantId, CASES.difference);
      const s = (await oracle.total("sales", "2025-11-01", "2025-11-30")).v, p = (await oracle.total("purchase", "2025-11-01", "2025-11-30")).v;
      const f = evidence.findings.find((x) => x.values && typeof x.values.diff === "number");
      check("A1-difference", "sales minus purchases equals the reference, and is disclosed as not profit", !!f && near(f.values.diff, r2(s - p)) && evidence.gaps.some((g) => /not profit/.test(g.text)), `${f && f.values.diff} vs ${r2(s - p)}`);
    }

    // ---- A6: tenant isolation and safety
    if (scope.only) {
      // a scoped run asserts nothing else; its safety is enforced (trap, read cap) and reported in the summary line
      if (io.writesAttempted !== 0) { console.log(`FAIL: ${io.writesAttempted} write attempt(s) were blocked`); return EXIT.FAIL; }
      return fail ? EXIT.FAIL : EXIT.PASS;
    }
    console.log("\n=== A6. Isolation and safety ===");
    if (want("isolation") && other) {
      const otherDc = await getTenantDateContext(other.tenantId);
      const { execution, formatted } = await run(other.tenantId, ISOLATION_PLAN, otherDc);
      const mine = await oracle.sums("sales", "2025-05-01", "2025-12-31", "customer", "invoice");
      const theirs = await makeOracle({ Sale, Purchase }, other.tenantId).sums("sales", "2025-05-01", "2025-12-31", "customer", "invoice");
      const onlyMine = [...mine.keys()].filter((name) => name && name.length > 5 && !theirs.has(name));
      const rows = (execution.steps[0].result && execution.steps[0].result.rows) || [];
      check("A6-isolation", "another tenant's run lists only its own customers and shows none of this company's", rows.every((r) => theirs.has(r.key.customer)) && !onlyMine.some((name) => formatted.text.includes(name)), `${rows.length} rows`);
    } else console.log("  NOT RUN - A6-isolation: no second tenant in this database");
    check("A6-no-writes", "no write reached (or was attempted against) the database", io.writesAttempted === 0, `${io.writesAttempted} attempted`);
    check("A6-bounded-reads", `reads stayed within the budget (${io.reads} of ${readCap})`, io.reads <= readCap);
    return fail ? EXIT.FAIL : EXIT.PASS;
  } finally {
    await mongoose.disconnect();
  }
}
function monthName(iso) { return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`; }

// ---------------------------------------------------------------- dry run (no connection)
function dryRun() {
  console.log("DRY RUN - no database connection, no network, no model\n");
  if (opt("only")) {
    const s = runScope(opt("only"));
    console.log(`a live run with --only=${s.only} would execute: section ${s.sections.join(", ")}; assertion ${s.checks.join(", ")}; company lookup by name only; other tenant: none; read cap ${s.maxReads}\n`);
  }
  const { parseAnalysisPlan } = require("./src/services/query/analysisPlan");
  const { validateQueryPlan } = require("./src/services/query/validator");
  const ref = new Date(2026, 9, 26, 23, 59, 59, 999);
  const all = { ...CASES, isolation: ISOLATION_PLAN };
  for (const [id, plan] of Object.entries(all)) {
    const parsed = parseAnalysisPlan(plan);
    const invalid = parsed.ok ? parsed.plan.steps.map((s) => [s.id, validateQueryPlan(s.plan, { referenceDate: ref })]).filter(([, v]) => !v.ok).map(([sid, v]) => `${sid}: ${v.errors.map((e) => e.code).join(",")}`) : ["unparsed"];
    check(`D1-plan-${id}`, `the "${id}" plan parses and every step passes the query validator`, parsed.ok && invalid.length === 0, parsed.ok ? invalid.join("; ") : JSON.stringify(parsed.errors));
  }
  // the write trap on a stand-in driver: every write throws before any I/O; reads are counted; $merge is refused
  const calls = [];
  class Collection { insertOne() { calls.push("insertOne"); } updateMany() { calls.push("updateMany"); } createIndex() { calls.push("createIndex"); } aggregate() { calls.push("aggregate"); return []; } find() { calls.push("find"); return []; } }
  class Db { createCollection() { calls.push("createCollection"); } }
  installTrap({ Collection, Db });
  const c = new Collection();
  const blocked = ["insertOne", "updateMany", "createIndex"].filter((m) => { try { c[m](); return false; } catch (e) { return /WRITE BLOCKED/.test(e.message); } });
  let mergeBlocked = false;
  try { c.aggregate([{ $merge: { into: "x" } }]); } catch (e) { mergeBlocked = /WRITE BLOCKED/.test(e.message); }
  let dbBlocked = false;
  try { new Db().createCollection(); } catch (e) { dbBlocked = /WRITE BLOCKED/.test(e.message); }
  c.find(); c.aggregate([{ $match: {} }]);
  check("D2-write-trap", "writes, index creation, collection creation and $merge throw before reaching the driver; reads pass and are counted", blocked.length === 3 && mergeBlocked && dbBlocked && JSON.stringify(calls) === JSON.stringify(["find", "aggregate"]) && io.reads === 3 && io.writesAttempted === 5, JSON.stringify({ blocked, mergeBlocked, dbBlocked, calls, io }));
  // the trap on the REAL driver classes (no connection is made): armed by identity; an untrapped driver is detected
  const realDriver = require("mongoose").mongo;
  const fresh = { Collection: class { deleteMany() {} insertOne() {} }, Db: class {} };
  const beforeReal = trapProblems(realDriver);
  installTrap(realDriver);
  check("D2-real-driver-trap", "on the real MongoDB driver, every write method is replaced by a blocker (checked by identity, no database operation); an untrapped driver is reported", beforeReal.length > 0 && trapProblems(realDriver).length === 0 && trapProblems(fresh).length > 0 && io.writesAttempted === 5, JSON.stringify({ beforeReal: beforeReal.length, after: trapProblems(realDriver), untrapped: trapProblems(fresh), writes: io.writesAttempted }));
  // the company / GUID / tenant guard fails closed
  const cos = [{ companyName: "Co A", companyGuid: "g-a", tenantId: "t-a" }, { companyName: "Twin", companyGuid: "g-1", tenantId: "t-1" }, { companyName: "Twin", companyGuid: "g-2", tenantId: "t-2" }, { companyName: "No Tenant", companyGuid: "g-n", tenantId: "" }];
  const cg = (name, guid, tenant = { "Co A": "t-a", Twin: "t-1", "No Tenant": "" }[name] || "t") => companyGuard(cos, name, guid, tenant).status;
  check("D6-company-guard", "company guard: absent -> NOT RUN; no GUID or tenant, wrong GUID, wrong tenant, two companies of that name, or no tenant -> REFUSED; only an exact single match runs", cg("Missing", "g") === "not_run" && cg("Co A", "g-a", "t-other") === "refused" && cg("Co A", "g-a", null) === "refused" && cg("Co A", null) === "refused" && cg("Co A", "g-x") === "refused" && cg("Twin", "g-1") === "refused" && cg("No Tenant", "g-n") === "refused" && cg("Co A", "g-a") === "ok");
  // the host guard
  const { parseMongoUri } = require("./src/config/db");
  const g = (uri, host, db = "db") => checkTarget(uri, host, db, parseMongoUri).ok;
  check("D3-host-guard", "the live read needs --expect-host and --expect-db and refuses another host or database, several hosts or an unusable URI", !g("mongodb+srv://u:p@a.example.net/db", null) && !g("mongodb+srv://u:p@a.example.net/db", "b.example.net") && !g("mongodb://h1:1,h2:2/db", "h1") && !g("not a uri", "a") && !g("mongodb+srv://u:p@a.example.net/db", "a.example.net", "other") && !g("mongodb+srv://u:p@a.example.net/db", "a.example.net", null) && g("mongodb+srv://u:p@a.example.net/db", "a.example.net"));
  let netBlocked = false;
  try { require("axios").post("http://127.0.0.1"); } catch (e) { netBlocked = /NETWORK BLOCKED/.test(e.message); }
  check("D4-network-blocked", "HTTP is blocked (no model, no Tally)", netBlocked);
  // the measured-absence check, on a REAL finding (production buildEvidence on an in-memory step; no database)
  {
    const { buildEvidence } = require("./src/services/query/evidence");
    const local = (y, m, d, end) => (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
    const absenceText = (rows) => {
      const step = { id: "c", kind: "query", status: "ok", request: { v: 1, entity: "sales", mode: "aggregate", metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], filters: [], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 100 }, result: { period: { from: local(2025, 12, 1), to: local(2025, 12, 31, true) }, comparison: { from: local(2025, 11, 1), to: local(2025, 11, 30, true) }, truncated: false, rows: rows.map(([name, c, p]) => ({ key: { customer: name }, values: { invoiceAmount: c }, comparison: { invoiceAmount: { previous: p, delta: r2(c - p) } } })), totals: null } };
      const f = buildEvidence({ steps: [step] }, { referenceDate: new Date(2026, 9, 26) }).findings.find((x) => /none recorded in/.test(x.text));
      return f ? f.text : "";
    };
    const ZEROS = [["Samrat Stationery Mart", 142072], ["SP STATIONERY MART ( Manesar)", 92203], ["Gupta, Sons & Co", 89861.5], ["S.S Traders", 86636], ["Mangla and Company (Books & Stationery Shop)", 5000], ["APJ ENTERPRISES", 4000], ["Kala Sansar", 4250]];
    const text = absenceText([...ZEROS.map(([n, p]) => [n, 0, p]), ["Active Co", 500, 100]]);
    const shuffled = new Map([...ZEROS].reverse().sort((a, b) => (a[0].length % 3) - (b[0].length % 3))); // an arbitrary order, unlike the finding's
    const names = ZEROS.map(([n]) => n);
    const problemsFor = (t, ref = shuffled) => absenceProblems(t, ref);
    check("D7-absence-valid", "a real absence finding (5 named, 'and 2 more'; names with brackets, commas, '&') is valid against the reference in ANY order", /and 2 more/.test(text) && problemsFor(text).length === 0 && problemsFor(text, new Map([...shuffled].reverse())).length === 0, `${text}\n${problemsFor(text).join("; ")}`);
    const named = names.filter((n) => text.includes(`${n} (₹`));
    const ghost = text.replace(`${named[1]} (₹`, "Ghost Traders (₹");
    check("D7-absence-unknown", "an unknown customer in the finding is rejected", problemsFor(ghost).some((p) => /not in the reference set: Ghost Traders/.test(p)), problemsFor(ghost).join("; "));
    const twice = text.replace(`${named[2]} (₹`, `${named[0]} (₹`);
    check("D7-absence-duplicate", "a customer named twice is rejected", problemsFor(twice).some((p) => /named twice/.test(p)), problemsFor(twice).join("; "));
    const wrongMore = text.replace("and 2 more", "and 3 more");
    const fewerMore = text.replace("and 2 more", "and 1 more");
    check("D7-absence-remainder", "a wrong 'and N more' (too many or too few for the reference set) is rejected", problemsFor(wrongMore).some((p) => /= 8, reference 7/.test(p)) && problemsFor(fewerMore).some((p) => /= 6, reference 7/.test(p)), `${problemsFor(wrongMore).join("; ")} | ${problemsFor(fewerMore).join("; ")}`);
    const extraRef = new Map([...shuffled, ["Unlisted Absent Co", 10]]);
    check("D7-absence-missing", "a reference customer the finding never accounts for is rejected (named + N must equal the reference count)", problemsFor(text, extraRef).some((p) => /reference 8/.test(p)));
    const wrongValue = text.replace(`${named[0]} (₹1,42,072.00`, `${named[0]} (₹1,42,073.00`);
    check("D7-absence-value", "a named customer with the wrong previous value is rejected", wrongValue !== text && problemsFor(wrongValue).some((p) => /previous value of Samrat Stationery Mart/.test(p)), problemsFor(wrongValue).join("; "));
    const few = absenceText([["A One", 0, 10], ["B Two", 0, 20], ["Active Co", 5, 1]]);
    check("D7-absence-no-remainder", "with fewer names than the cap there is no 'and N more' and the count still has to match", !/more\./.test(few) && problemsFor(few, new Map([["B Two", 20], ["A One", 10]])).length === 0 && problemsFor(few, new Map([["A One", 10]])).length > 0);
    check("D7-absence-unparseable", "a text that is not an absence finding is rejected, never passed", problemsFor("Sales rose by ₹10.").length > 0 && problemsFor("").length > 0);
  }
  // --only: strict arguments, the exact scope, and the fail-closed backstop
  {
    const p = (...a) => parseArgs(a);
    check("D8-args", "arguments: unknown, positional, malformed, empty, repeated or an unknown --only value -> refused; the targeted live set parses", !p("--bogus").ok && !p("extra").ok && !p("--approve-atlas-read=yes").ok && !p("--expect-host").ok && !p("--only=").ok && !p("--only=a4-measured-zero", "--only=a4-measured-zero").ok && !p("--only=all").ok && !p("--approve-atlas-read", "--approve-atlas-read").ok && p("--approve-atlas-read", "--only=a4-measured-zero", "--expect-host=h", "--expect-db=d", "--expect-tenant=t", "--expect-guid=g").ok);
    const s = runScope("a4-measured-zero"), full = runScope(null);
    check("D9-scope-a4", "--only=a4-measured-zero runs exactly one section (dec-vs-nov), exactly one assertion (A4-measured-zero), looks the company up by name only, reads no other tenant, caps reads at 40", JSON.stringify(s.sections) === '["dec-vs-nov"]' && JSON.stringify(s.checks) === '["A4-measured-zero"]' && s.companyLookup === "by-name" && s.otherTenant === false && s.maxReads === 40 && runScope("unknown") === null, JSON.stringify(s));
    check("D9-scope-full", "without --only the full suite runs, unchanged (all eight sections, every assertion, isolation tenant, 400 reads)", full.sections.length === 8 && full.checks === null && full.otherTenant === true && full.maxReads === MAX_READS);
    check("D9-scope-plan", "the only plan a scoped run executes is the one-step Dec-vs-Nov plan on the guarded company (no isolation plan)", CASES.decVsNov.steps.length === 1 && !s.sections.includes("isolation") && !s.sections.includes("a5-data-state"));
    const saved = allowedChecks, savedPass = pass, savedLog = console.log;
    allowedChecks = new Set(s.checks);
    let blocked = false, allowed = false;
    try { check("A1-dec-total", "out of scope", true); } catch (e) { blocked = /SCOPE VIOLATION/.test(e.message); }
    console.log = () => {}; // the in-scope probe is not a test result: silent, and not counted
    try { check("A4-measured-zero", "probe", true); allowed = true; } catch (e) { allowed = false; } finally { console.log = savedLog; }
    allowedChecks = saved;
    pass = savedPass;
    check("D10-scope-backstop", "in a scoped run, any assertion outside the scope throws (the run ends instead of widening); the in-scope assertion runs", blocked && allowed);
    // reads: only the Dec-vs-Nov plan on the guarded tenant, and only its two reference sums (each refused BEFORE a query)
    const throwsScope = (f) => { try { f(); return false; } catch (e) { return /SCOPE VIOLATION/.test(e.message); } };
    const calls = [];
    const fakeOracle = { sums: (...a) => (calls.push(a.join("|")), new Map()), total: () => calls.push("total"), latestDay: () => calls.push("latest") };
    const so = scopedOracle(s, fakeOracle);
    so.sums("sales", "2025-12-01", "2025-12-31", "customer", "invoice"); so.sums("sales", "2025-11-01", "2025-11-30", "customer", "invoice");
    const refused = [() => so.sums("sales", "2025-05-01", "2025-12-31", "month", "invoice"), () => so.sums("purchase", "2025-12-01", "2025-12-31", "customer", "invoice"), () => so.total("sales", "2025-11-01", "2025-11-30"), () => so.latestDay()].every(throwsScope);
    check("D12-scope-reads", "a scoped run may send only the two Dec/Nov customer reference sums; every other reference query is refused before it reaches the oracle", refused && JSON.stringify(calls) === JSON.stringify(["sales|2025-12-01|2025-12-31|customer|invoice", "sales|2025-11-01|2025-11-30|customer|invoice"]) && scopedOracle(full, fakeOracle) === fakeOracle, JSON.stringify(calls));
    check("D12-scope-plans", "a scoped run executes only the Dec-vs-Nov plan and only on the guarded tenant (another tenant or plan is refused before execution)", !throwsScope(() => assertPlanInScope(s, CASES.decVsNov, "t-guarded", "t-guarded")) && throwsScope(() => assertPlanInScope(s, CASES.decVsNov, "t-other", "t-guarded")) && throwsScope(() => assertPlanInScope(s, ISOLATION_PLAN, "t-guarded", "t-guarded")) && throwsScope(() => assertPlanInScope(s, CASES.empty, "t-guarded", "t-guarded")) && !throwsScope(() => assertPlanInScope(full, ISOLATION_PLAN, "t-other", "t-guarded")));
    // the guards still refuse BEFORE any connection when --only is given (child processes; a fake URI that can never be used)
    const { spawnSync } = require("child_process");
    const env = { ...process.env, MONGODB_URI: "mongodb://guard-check.invalid:27017/nodb" };
    const runChild = (...a) => { const r = spawnSync(process.execPath, [__filename, ...a], { env, encoding: "utf8", timeout: 30000 }); return { code: r.status, out: (r.stdout || "").split("\n")[0] }; };
    const live = ["--approve-atlas-read", "--only=a4-measured-zero"];
    const cases = [
      ["no expect flags", runChild(...live), /REFUSED: --expect-host/],
      ["wrong host", runChild(...live, "--expect-host=other.invalid", "--expect-db=nodb", "--expect-tenant=t", "--expect-guid=g"), /REFUSED: MONGODB_URI does not point at the expected host/],
      ["wrong database", runChild(...live, "--expect-host=guard-check.invalid", "--expect-db=other", "--expect-tenant=t", "--expect-guid=g"), /REFUSED: MONGODB_URI does not name the expected database/],
      ["no tenant", runChild(...live, "--expect-host=guard-check.invalid", "--expect-db=nodb", "--expect-guid=g"), /REFUSED: --expect-guid=<company GUID> and --expect-tenant/],
      ["unknown --only", runChild("--approve-atlas-read", "--only=everything"), /REFUSED: --only must be one of/],
      ["conflicting --only", runChild(...live, "--only=a4-measured-zero"), /REFUSED: --only given twice/],
      ["unknown flag", runChild(...live, "--skip-guards"), /REFUSED: unknown or malformed flag/],
    ];
    const bad = cases.filter(([, r, re]) => !(r.code === EXIT.REFUSED && re.test(r.out)));
    check("D11-guards-with-only", "with --only, every host/database/tenant/GUID guard and the argument checks still refuse (exit 2) before any connection", bad.length === 0, JSON.stringify(bad.map(([n, r]) => [n, r])));
  }
  check("D5-oracle-bounds", "reference date bounds are the stored UTC-midnight days, inclusive of the whole last day", dayStart("2025-12-01").toISOString() === "2025-12-01T00:00:00.000Z" && dayEnd("2025-12-31").toISOString() === "2025-12-31T23:59:59.999Z");
  return fail ? EXIT.FAIL : EXIT.PASS;
}

(async () => {
  let code;
  try {
    if (!PARSED.ok) { console.log(`REFUSED: ${PARSED.error}`); code = EXIT.REFUSED; }
    else code = LIVE ? await live() : dryRun();
  } catch (e) {
    console.log(`ERROR: ${e && e.message}`);
    code = EXIT.ERROR;
  }
  const verdict = { 0: "PASS", 1: "FAIL", 2: "REFUSED", 3: "NOT RUN", 4: "ERROR" }[code];
  console.log(`\neval-findings-real (${LIVE ? "live read" : "dry run"}): ${verdict} - ${pass} passed, ${fail} failed${LIVE ? `; reads ${io.reads}, writes attempted ${io.writesAttempted}` : ""}`);
  process.exit(code);
})();
