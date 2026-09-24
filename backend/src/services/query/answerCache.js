"use strict";

// --------------------------------------------------
// Answer cache for the Query Engine (Phase 1E). In-process, no Redis.
//
// Correctness first: an answer is served from cache only if ALL of these
// are identical to when it was computed -
//   tenantId                  (entries live in a per-tenant partition, so a
//                              key collision can never cross tenants)
//   canonical plan            (strict-schema parsed, sorted-key JSON)
//   catalog fingerprint       (a catalog/definition change misses)
//   reference date override   (only when the caller supplies one)
//   TenantDataVersion         (bumped after every Sales/Purchase/Stock Item
//                              master write - see dataVersion.js)
// The version is read BEFORE computing and again AFTER; if it moved while the
// query ran, the result is returned but NOT stored. Only successful answers
// are cached (never errors, timeouts or refusals). Concurrent identical
// requests share one computation ("single flight"). Entries expire (TTL) as a
// backstop for writes that bypass Mongoose, and the cache is size-bounded (LRU).
// Cached values are deep-frozen clones: callers cannot mutate a cached answer.
// --------------------------------------------------

const crypto = require("crypto");
const { parseQueryPlan } = require("./queryPlan.schema");
const { computeFingerprint } = require("./semanticCatalog");

const DEFAULTS = { maxEntries: 500, maxEntriesPerTenant: 200, maxEntryBytes: 256 * 1024, ttlMs: 10 * 60 * 1000 };

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

function createAnswerCache(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const now = options.now || (() => Date.now());
  const fingerprint = options.fingerprint || computeFingerprint();
  const tenants = new Map(); // tenantId -> Map(key -> {value, expires})
  const inflight = new Map(); // tenantId + key -> Promise
  const stats = { hits: 0, misses: 0, stores: 0, skippedChangedVersion: 0, skippedNotCacheable: 0, evictions: 0, invalidations: 0, bypass: 0, coalesced: 0 };
  let total = 0;

  function keyFor(plan, referenceDate, version) {
    const ref = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime()) ? referenceDate.toISOString() : "";
    return crypto.createHash("sha256").update(`${fingerprint}|${stableStringify(plan)}|${ref}|${version}`).digest("hex");
  }

  function partition(tenantId) {
    if (!tenants.has(tenantId)) tenants.set(tenantId, new Map());
    return tenants.get(tenantId);
  }

  function evictOldest(map) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
      total -= 1;
      stats.evictions += 1;
    }
  }

  function store(tenantId, key, value) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > cfg.maxEntryBytes) {
      stats.skippedNotCacheable += 1;
      return false;
    }
    const part = partition(tenantId);
    if (part.has(key)) {
      part.delete(key);
      total -= 1;
    }
    while (part.size >= cfg.maxEntriesPerTenant) evictOldest(part);
    while (total >= cfg.maxEntries) {
      // evict from the largest partition first so one tenant cannot starve the rest
      let biggest = null;
      for (const m of tenants.values()) if (!biggest || m.size > biggest.size) biggest = m;
      if (!biggest || biggest.size === 0) break;
      evictOldest(biggest);
    }
    part.set(key, { value: deepFreeze(JSON.parse(JSON.stringify(value))), expires: now() + cfg.ttlMs });
    total += 1;
    stats.stores += 1;
    return true;
  }

  function lookup(tenantId, key) {
    const part = tenants.get(tenantId);
    const entry = part && part.get(key);
    if (!entry) return null;
    if (entry.expires <= now()) {
      part.delete(key);
      total -= 1;
      return null;
    }
    part.delete(key); // refresh LRU position
    part.set(key, entry);
    return entry;
  }

  function invalidateTenant(tenantId) {
    const part = tenants.get(tenantId);
    if (part) {
      total -= part.size;
      part.clear();
      stats.invalidations += 1;
    }
  }

  function invalidateAll() {
    tenants.forEach((p) => p.clear());
    total = 0;
    stats.invalidations += 1;
  }

  /**
   * @param {object} rawPlan
   * @param {{tenantId:string, referenceDate?:Date}} context
   * @param {{execute:Function, getVersion:Function}} deps  execute(rawPlan, context) => result; getVersion(tenantId) => token
   * @returns {Promise<{result:object, cache:{status:string, version?:string, reason?:string}}>}
   */
  async function run(rawPlan, context, deps) {
    const { tenantId, referenceDate } = context || {};
    const bypass = async (reason) => {
      stats.bypass += 1;
      return { result: await deps.execute(rawPlan, context), cache: { status: "bypass", reason } };
    };
    if (typeof tenantId !== "string" || !tenantId.trim()) return bypass("no_tenant"); // executor answers tenant_context_required
    const parsed = parseQueryPlan(rawPlan);
    if (!parsed.ok) return bypass("invalid_plan"); // executor returns the structured error

    let version;
    try {
      version = await deps.getVersion(tenantId);
    } catch (e) {
      return bypass("version_unavailable"); // fail closed: freshness cannot be proven -> never use the cache
    }
    const key = keyFor(parsed.plan, referenceDate, version);

    const hit = lookup(tenantId, key);
    if (hit) {
      stats.hits += 1;
      return { result: hit.value, cache: { status: "hit", version } };
    }

    const flightKey = `${tenantId}\u0000${key}`;
    if (inflight.has(flightKey)) {
      stats.coalesced += 1;
      const shared = await inflight.get(flightKey);
      return { result: shared.result, cache: { status: "coalesced", version } };
    }

    stats.misses += 1;
    const flight = (async () => {
      const result = await deps.execute(rawPlan, context);
      let stored = false;
      if (result && result.ok === true) {
        let after = null;
        try {
          after = await deps.getVersion(tenantId);
        } catch (e) {
          after = null;
        }
        if (after === version) {
          stored = store(tenantId, key, result);
        } else stats.skippedChangedVersion += 1;
      } else stats.skippedNotCacheable += 1;
      return { result, stored };
    })();
    inflight.set(flightKey, flight);
    try {
      const done = await flight;
      return { result: done.result, cache: { status: "miss", version, stored: done.stored } };
    } finally {
      inflight.delete(flightKey);
    }
  }

  return { run, invalidateTenant, invalidateAll, stats, size: () => total, _partitions: tenants };
}

/** Production wiring: real executor + Mongo-backed version. Not used by chat yet. */
function createDefaultCachedExecutor(options = {}) {
  const cache = createAnswerCache(options);
  const { getTenantVersion, onBump } = require("./dataVersion");
  const { executeQuery } = require("./execute");
  onBump((tenantId) => (tenantId === "*" ? cache.invalidateAll() : cache.invalidateTenant(tenantId)));
  return { cache, execute: (plan, context) => cache.run(plan, context, { execute: executeQuery, getVersion: getTenantVersion }) };
}

module.exports = { createAnswerCache, createDefaultCachedExecutor, stableStringify, DEFAULTS };
