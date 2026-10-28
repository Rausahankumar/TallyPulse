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
  const stats = { hit: 0, miss: 0, stored: 0, bypass: 0, evicted: 0 };

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
    if (Buffer.byteLength(value, "utf8") > cfg.maxEntryBytes) return false;
    if (!(cfg.maxEntriesPerTenant >= 1 && cfg.maxEntries >= 1)) return false; // a cap below 1 stores nothing (never loops)
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
    return true;
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
      stats.miss += 1;
      count("miss");
      const response = await client(request, callOptions); // errors and timeouts propagate unchanged and are never stored
      if (!(signal && signal.aborted) && isCacheableResponse(request, response)) store(tenantId, key, response);
      return response;
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
