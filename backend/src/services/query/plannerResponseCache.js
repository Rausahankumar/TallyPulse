"use strict";

// --------------------------------------------------
// Planner response cache: in-process, no Redis (same conventions as answerCache.js).
//
// It sits in front of the model client used by the query planner, the analysis planner (incl. its repair round) and the
// investigation's model follow-up, and remembers a model REPLY for an IDENTICAL model request. Nothing derived from a reply
// is cached here: on a hit the reply goes through exactly the same parsing, guards, name re-resolution against the
// tenant's current data, period resolution with the turn's own reference date, validation and engine execution as a fresh
// reply. The model request carries no date and no data (periods are resolved server-side), so the reply to an identical
// request does not depend on either.
//
// Key: SHA-256 of the complete request the model sees - model, temperature, system prompt, tools, tool_choice, max_tokens
// and messages (stable key order) - inside a per-tenant partition, so a reply can never cross companies. The question is
// never kept in a key (only its hash) or in telemetry.
// Stored: only a reply with exactly one tool call of the forced tool, a plain-object input and a complete stop reason.
// Never errors, timeouts, cancelled requests, truncated (max_tokens) or malformed replies.
// Bounded: entries per tenant and in total (oldest evicted first), bytes per entry, and a TTL.
// A hit returns a deep clone with zero usage and the CACHED_RESPONSE mark, so callers count no model call and no tokens.
// Concurrent IDENTICAL requests of one tenant (a double click, two tabs) share ONE model call: the first leads, the others wait for
// its reply and are served like hits. If the leader fails, is cancelled or returns something not reusable, each waiting request
// makes its own call - an error or a cancellation of one request never becomes another request's result.
// --------------------------------------------------

const crypto = require("crypto");
const { stableStringify } = require("./answerCache");

const DEFAULTS = { maxEntries: 500, maxEntriesPerTenant: 100, maxEntryBytes: 64 * 1024, ttlMs: 24 * 60 * 60 * 1000 };
const CACHED_RESPONSE = Symbol("tallypulse.plannerResponseCache.hit");
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/** True for a reply served from this cache (it was not a model call). */
const isCachedResponse = (response) => !!(response && response[CACHED_RESPONSE]);

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** A reply worth remembering: exactly one call of the forced tool with an object input, not cut off. */
function isCacheableResponse(request, response) {
  if (!isPlainObject(response) || !Array.isArray(response.content)) return false;
  if (response.stop_reason && response.stop_reason !== "tool_use" && response.stop_reason !== "end_turn") return false;
  const forced = request && request.tool_choice && request.tool_choice.type === "tool" ? request.tool_choice.name : null;
  const uses = response.content.filter((b) => b && b.type === "tool_use");
  return !!forced && uses.length === 1 && uses[0].name === forced && isPlainObject(uses[0].input);
}

/** Resolves/rejects like `promise`, but rejects at once when `signal` aborts (a waiting request that was cancelled stops waiting). */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); }
    );
  });
}

function abortError(signal) {
  const err = new Error("The planner request was aborted.");
  err.name = "AbortError";
  if (signal && signal.reason !== undefined) err.cause = signal.reason;
  return err;
}

/**
 * @param {{maxEntries?:number, maxEntriesPerTenant?:number, maxEntryBytes?:number, ttlMs?:number, now?:() => number}} [options]
 */
function createPlannerResponseCache(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const now = typeof options.now === "function" ? options.now : Date.now;
  const tenants = new Map(); // tenantId -> Map(key -> {value, expires})
  let total = 0;
  const stats = { hit: 0, miss: 0, stored: 0, bypass: 0, evicted: 0, coalesced: 0 };
  const inflight = new Map(); // `${tenantId}\0${key}` -> Promise<stored value | null> of the request currently leading that key

  function keyFor(request, settings) {
    const { system, tools, tool_choice, max_tokens, messages } = request;
    // what the real client sends: its settings, overridden by any model/temperature the request itself carries
    const model = request.model !== undefined ? request.model : settings.model;
    const temperature = request.temperature !== undefined ? request.temperature : settings.temperature;
    return crypto.createHash("sha256").update(stableStringify({ model, temperature, system, tools, tool_choice, max_tokens, messages })).digest("hex");
  }
  function drop(tenantId, part, key) {
    part.delete(key);
    total -= 1;
    if (!part.size) tenants.delete(tenantId); // no empty partitions left behind
  }
  function evictOldest(tenantId, part) {
    const oldest = part.keys().next().value;
    if (oldest === undefined) return false;
    drop(tenantId, part, oldest);
    stats.evicted += 1;
    return true;
  }
  function lookup(tenantId, key) {
    const part = tenants.get(tenantId);
    const entry = part && part.get(key);
    if (!entry) return null;
    if (entry.expires <= now()) {
      drop(tenantId, part, key);
      return null;
    }
    part.delete(key); // refresh its LRU position
    part.set(key, entry);
    return entry.value;
  }
  function store(tenantId, key, response) {
    const value = JSON.stringify({ content: response.content, stop_reason: response.stop_reason || null, model: response.model || null });
    if (Buffer.byteLength(value, "utf8") > cfg.maxEntryBytes) return null;
    if (!(cfg.maxEntriesPerTenant >= 1 && cfg.maxEntries >= 1)) return null; // a cap below 1 stores nothing (never loops)
    let part = tenants.get(tenantId);
    if (part && part.has(key)) drop(tenantId, part, key);
    part = tenants.get(tenantId);
    while (part && part.size >= cfg.maxEntriesPerTenant && evictOldest(tenantId, part)) part = tenants.get(tenantId);
    while (total >= cfg.maxEntries) {
      // the globally oldest entry: the first entry of the partition whose first entry expires soonest
      let victim = null;
      for (const [id, p] of tenants) {
        const first = p.values().next().value;
        if (first && (!victim || first.expires < victim.first.expires)) victim = { id, p, first };
      }
      if (!victim || !evictOldest(victim.id, victim.p)) break;
    }
    part = tenants.get(tenantId);
    if (!part) tenants.set(tenantId, (part = new Map()));
    part.set(key, { value, expires: now() + cfg.ttlMs });
    total += 1;
    stats.stored += 1;
    return value;
  }
  /** The response to hand back on a hit: a fresh clone, zero usage, marked as not a model call. */
  function revive(value) {
    const r = JSON.parse(value);
    const out = { ...r, usage: { ...ZERO_USAGE } };
    Object.defineProperty(out, CACHED_RESPONSE, { value: true, enumerable: false });
    return out;
  }

  /**
   * A model client for ONE turn of ONE tenant: same signature as planner.createAnthropicPlannerClient's client.
   * @param {Function} client the real client: (request, {signal}) => response
   * @param {{tenantId:string, settings:() => {model:string, temperature:number}, counters?:{hit:number, miss:number, bypass:number}}} turn
   */
  function wrap(client, { tenantId, settings, counters }) {
    const count = (k) => {
      if (counters) counters[k] = (counters[k] || 0) + 1;
    };
    return async (request, callOptions = {}) => {
      const signal = callOptions && callOptions.signal;
      if (signal && signal.aborted) throw abortError(signal); // cancelled: no lookup, no call, nothing stored
      const s = typeof settings === "function" ? settings() : null;
      if (typeof tenantId !== "string" || !tenantId.trim() || !s || typeof s.model !== "string" || !isPlainObject(request)) {
        stats.bypass += 1;
        count("bypass");
        return client(request, callOptions);
      }
      const key = keyFor(request, s);
      const hit = lookup(tenantId, key);
      if (hit) {
        stats.hit += 1;
        count("hit");
        return revive(hit);
      }
      const flightKey = `${tenantId}\u0000${key}`;
      const leader = inflight.get(flightKey);
      if (leader) {
        let value = null;
        try {
          value = await untilAborted(leader, signal); // a cancelled waiting request stops waiting (and never calls)
        } catch (error) {
          if (signal && signal.aborted) throw error;
        }
        if (value) {
          stats.hit += 1;
          stats.coalesced += 1;
          count("hit"); // it avoided a model call, like a hit
          return revive(value);
        }
        // the leader produced nothing reusable: this request makes its own call below
      }
      stats.miss += 1;
      count("miss");
      let settle = () => {};
      const lead = !inflight.has(flightKey);
      if (lead) inflight.set(flightKey, new Promise((resolve) => { settle = resolve; }));
      try {
        const response = await client(request, callOptions); // errors and timeouts propagate unchanged and are never stored
        const value = !(signal && signal.aborted) && isCacheableResponse(request, response) ? store(tenantId, key, response) : null;
        settle(value);
        return response;
      } catch (error) {
        settle(null);
        throw error;
      } finally {
        if (lead) inflight.delete(flightKey);
      }
    };
  }

  function invalidateTenant(tenantId) {
    const part = tenants.get(tenantId);
    if (part) {
      total -= part.size;
      tenants.delete(tenantId);
    }
  }
  function invalidateAll() {
    tenants.clear();
    total = 0;
  }
  const size = () => total;
  return { wrap, invalidateTenant, invalidateAll, size, stats, config: cfg };
}

let shared = null;
/** The process-wide cache used by the production planner client (PLANNER_RESPONSE_CACHE=off disables it). */
function getSharedPlannerResponseCache() {
  if (process.env.PLANNER_RESPONSE_CACHE === "off") return null;
  if (!shared) shared = createPlannerResponseCache();
  return shared;
}

module.exports = { createPlannerResponseCache, getSharedPlannerResponseCache, isCachedResponse, isCacheableResponse, CACHED_RESPONSE, DEFAULTS };
