"use strict";

// --------------------------------------------------
// TenantDataVersion (Phase 1E).
//
// A monotonically increasing per-tenant counter, bumped AFTER every committed
// write to Sales / Purchase / Stock Item master. Installed as a Mongoose
// plugin on those three schemas, so EVERY write path - voucher sync, deleted/
// cancelled marking, self-heal, recovery, reconciliation, imports, master
// refresh, any future writer that goes through the models - invalidates the
// cache without each caller having to remember to do it.
//
// Fail-closed rules:
//  * a write that cannot be attributed to one tenant bumps the GLOBAL counter
//    ("*"), which invalidates every tenant's cache;
//  * if the counter write itself fails, a process-local epoch is bumped (this
//    process stops serving cached answers) and the failure is logged; the
//    cache TTL bounds staleness in any other process;
//  * the counter is stored in MongoDB, so it is shared by every process.
//
// Known limit: writes that bypass Mongoose (raw driver / mongosh) are not
// seen. The cache TTL is the backstop for those.
// --------------------------------------------------

const mongoose = require("mongoose");

const GLOBAL_KEY = "*";

const localEpochs = new Map(); // process-local per-key counters (key = tenantId or "*")
const listeners = new Set();
const stats = { bumps: 0, globalBumps: 0, failures: 0 };

function getModel() {
  return require("../../models/tenantDataVersion.model");
}

function log(message) {
  // eslint-disable-next-line no-console
  console.error(`[tenantDataVersion] ${message}`);
}

async function bumpTenantVersion(tenantId) {
  const key = typeof tenantId === "string" && tenantId && tenantId !== GLOBAL_KEY ? tenantId : GLOBAL_KEY;
  stats.bumps += 1;
  if (key === GLOBAL_KEY) stats.globalBumps += 1;
  localEpochs.set(key, (localEpochs.get(key) || 0) + 1); // this process is invalidated immediately, even before the DB round trip
  for (const fn of listeners) {
    try {
      fn(key);
    } catch (e) {
      /* listeners must never break a write path */
    }
  }
  try {
    await getModel().updateOne({ tenantId: key }, { $inc: { version: 1 }, $set: { updatedAt: new Date() } }, { upsert: true });
  } catch (error) {
    stats.failures += 1;
    log(`bump failed for ${key}: ${error && error.message}`);
  }
}

/** Version token for a tenant: changes whenever its data (or the global counter) changes. */
async function getTenantVersion(tenantId) {
  if (typeof tenantId !== "string" || !tenantId || tenantId === GLOBAL_KEY) throw new Error("getTenantVersion: tenantId is required");
  const docs = await getModel()
    .find({ tenantId: { $in: [tenantId, GLOBAL_KEY] } })
    .select("tenantId version")
    .lean();
  const v = (id) => (docs.find((d) => d.tenantId === id) || {}).version || 0;
  return `${v(GLOBAL_KEY)}.${v(tenantId)}.${localEpochs.get(GLOBAL_KEY) || 0}.${localEpochs.get(tenantId) || 0}`;
}

/** Synchronous invalidation hook for in-process caches (called before the DB counter round trip). */
function onBump(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------- tenant attribution

function tenantFrom(value) {
  return typeof value === "string" && value && value !== GLOBAL_KEY ? value : null;
}

// Every tenantId value a write could touch: the one it is filtered by AND any tenantId it assigns
// (a $set / replacement / pipeline stage that MOVES a document to another tenant must invalidate
// both sides). A non-string tenantId anywhere (operator object, null) is unattributable.
function collectTenants(value, into, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return;
  for (const key of Object.keys(value)) {
    if (key === "tenantId") {
      const t = tenantFrom(value[key]);
      if (t) into.tenants.add(t);
      else into.unknown = true;
    } else collectTenants(value[key], into, depth + 1);
  }
}

function tenantsOfWrite(filter, update) {
  const into = { tenants: new Set(), unknown: false };
  const t = tenantFrom(filter && filter.tenantId);
  if (t) into.tenants.add(t);
  else into.unknown = true; // no plain tenantId in the filter: cannot attribute
  collectTenants(update, into);
  return { tenants: [...into.tenants], unknown: into.unknown };
}

function tenantsFromOps(ops) {
  const out = new Set();
  let unknown = false;
  if (!Array.isArray(ops)) return { tenants: [], unknown: true };
  for (const op of ops) {
    const kind = Object.keys(op || {})[0];
    const body = (op && op[kind]) || {};
    const r =
      kind === "insertOne"
        ? tenantsOfWrite({ tenantId: body.document && body.document.tenantId }, null)
        : tenantsOfWrite(body.filter, body.update || body.replacement);
    r.tenants.forEach((t) => out.add(t));
    if (r.unknown) unknown = true;
  }
  return { tenants: [...out], unknown };
}

async function bumpFor(tenants, unknown) {
  await Promise.all([...tenants.map(bumpTenantVersion), ...(unknown ? [bumpTenantVersion(GLOBAL_KEY)] : [])]);
}

// ---------------------------------------------------------------- plugin

function tenantDataVersionPlugin(schema) {
  const queryOps = ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany"];

  // Error-handling variants (the 3-argument form) matter as much as the success hooks: a write that
  // reports an error may still have PARTLY applied (unordered/partial inserts, a dropped connection
  // after the server executed it), so a failed write invalidates too. They return normally, which
  // leaves the original error to propagate untouched.
  async function bumpForQuery() {
    const filter = typeof this.getFilter === "function" ? this.getFilter() : {};
    const update = typeof this.getUpdate === "function" ? this.getUpdate() : null;
    const { tenants, unknown } = tenantsOfWrite(filter, update);
    await bumpFor(tenants, unknown);
  }
  schema.post(queryOps, async function afterQueryWrite() {
    await bumpForQuery.call(this);
  });
  schema.post(queryOps, async function afterQueryWriteError(error, res, next) {
    await bumpForQuery.call(this);
  });

  // A save that changes an existing document's tenantId moves it between tenants: also invalidate
  // the old side (unknown here, so the global counter).
  schema.pre("save", function beforeSave() {
    if (!this.isNew && this.isModified("tenantId")) this.$locals.tdvMoved = true;
  });
  schema.post("save", async function afterSave(doc) {
    const d = doc || this;
    await bumpFor([tenantFrom(d.tenantId)].filter(Boolean), !tenantFrom(d.tenantId) || !!(d.$locals && d.$locals.tdvMoved));
  });
  schema.post("save", async function afterSaveError(error, doc, next) {
    const d = doc || this;
    await bumpFor([tenantFrom(d && d.tenantId)].filter(Boolean), !tenantFrom(d && d.tenantId) || !!(d && d.$locals && d.$locals.tdvMoved));
  });

  schema.post("deleteOne", { document: true, query: false }, async function afterDocDelete() {
    await bumpTenantVersion(tenantFrom(this.tenantId));
  });

  schema.post("insertMany", async function afterInsertMany(docs) {
    const list = Array.isArray(docs) ? docs : [];
    const tenants = new Set(list.map((d) => tenantFrom(d && d.tenantId)));
    await bumpFor([...tenants].filter(Boolean), tenants.has(null) || list.length === 0);
  });
  // On a failed insertMany the inserted subset is not visible here: invalidate everyone (rare path).
  schema.post("insertMany", async function afterInsertManyError(error, docs, next) {
    await bumpTenantVersion(GLOBAL_KEY);
  });
  // Mongoose SKIPS the insertMany post hooks when `rawResult: true` or `populate` is passed (it returns
  // before them), so hooks alone can be bypassed. This thin wrapper bumps after EVERY insertMany call,
  // success or failure, from the input documents' tenantIds.
  const originalInsertMany = mongoose.Model.insertMany;
  schema.static("insertMany", async function insertManyWithVersion(arr, options) {
    try {
      return await originalInsertMany.call(this, arr, options);
    } finally {
      const list = Array.isArray(arr) ? arr : [arr];
      const tenants = new Set(list.map((d) => tenantFrom(d && d.tenantId)));
      await bumpFor([...tenants].filter(Boolean), tenants.has(null) || list.length === 0);
    }
  });

  // bulkWrite: the ops are only visible in the pre hook, and the post hook cannot tell which call it
  // belongs to. So concurrent calls share one pending set and every completion bumps the whole set
  // (over-invalidation is safe; missing a tenant is not).
  // A hook must never break a write: any surprise here just widens invalidation.
  schema.pre("bulkWrite", function beforeBulk(ops) {
    try {
      const { tenants, unknown } = tenantsFromOps(ops);
      bulkPending.count += 1;
      tenants.forEach((t) => bulkPending.tenants.add(t));
      if (unknown || !Array.isArray(ops)) bulkPending.unknown = true;
    } catch (e) {
      bulkPending.count += 1;
      bulkPending.unknown = true;
    }
  });
  schema.post("bulkWrite", async function afterBulk() {
    await finishBulk(true);
  });
  schema.post("bulkWrite", async function afterBulkError(error, res, next) {
    // A failed bulk write may have partly applied, so it invalidates too. Returning normally (NOT calling
    // next(error), whose rejection nobody awaits) lets Mongoose rethrow the original error to the caller.
    await finishBulk(true);
  });
}

const bulkPending = { count: 0, tenants: new Set(), unknown: false };
async function finishBulk(bump) {
  const tenants = [...bulkPending.tenants];
  const unknown = bulkPending.unknown;
  bulkPending.count = Math.max(0, bulkPending.count - 1);
  if (bulkPending.count === 0) {
    bulkPending.tenants.clear();
    bulkPending.unknown = false;
  }
  if (bump) await bumpFor(tenants, unknown);
}

module.exports = { tenantDataVersionPlugin, bumpTenantVersion, getTenantVersion, onBump, GLOBAL_KEY, stats };
