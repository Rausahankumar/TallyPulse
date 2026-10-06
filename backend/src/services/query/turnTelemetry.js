"use strict";

// --------------------------------------------------
// Per-turn AI/query telemetry (P1-1): ONE structured line per chat turn, written through the existing
// console logging (no new logging infrastructure). Instrumentation only - nothing here can change an
// answer, a route, a cache decision or a Claude call.
//
// Privacy by construction: the event is built from an allow-list of fields, and every string value except
// tenantId must be a short machine code (/^[a-z][a-z0-9_]*$/). Free text - the question, history, prompts,
// Claude output, plan contents, customer/supplier/product/company names, figures - cannot pass that check.
// No question identifier is logged (there is no established salted-hash convention to reuse).
// --------------------------------------------------

const { performance } = require("perf_hooks");

const EVENT_NAME = "tallypulse.ai.turn";
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TENANT_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

const now = () => performance.now();
const ms = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : null);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const code = (v) => (typeof v === "string" && CODE_RE.test(v) ? v : v === null || v === undefined ? null : "invalid_code");
const bool = (v) => (typeof v === "boolean" ? v : null);

// Field -> sanitiser. Anything not listed here is never emitted.
const FIELDS = {
  path: code, route: code, outcome: code, answerSource: code,
  claudeCalls: int, claudeReason: code,
  plannerStatus: code, plannerCode: code, plannerLatencyMs: ms, plannerAttempts: int,
  plannerInputTokens: int, plannerOutputTokens: int, plannerCacheReadTokens: int, plannerCacheCreationTokens: int,
  answerCache: code, answerCacheHit: bool, answerCacheLookupMs: ms, answerCacheStored: bool,
  executeMs: ms, engineRan: bool, engineLatencyMs: ms, engineStatus: code, engineErrorCode: code,
  resolverCalled: bool, resolverCalls: int, resolverLatencyMs: ms, resolverStatus: code,
  freshnessStatus: code,
  referenceDateSource: code, futureVouchersPresent: bool, coverageStatus: code, followUp: code,
  queryEngineMs: ms, totalLatencyMs: ms, httpStatus: int, ok: bool, clientAborted: bool,
};

/** Mutable per-turn metrics bag filled in by queryChat; plain numbers/codes only. */
function newTurnMetrics() {
  return { resolverCalled: false, resolverCalls: 0, resolverLatencyMs: 0, resolverStatus: "not_called" };
}

/** Pass-through resolver wrapper: same arguments, same result, same error - only timed and counted. */
function timeResolver(resolveEntity, tm) {
  if (typeof resolveEntity !== "function") return resolveEntity;
  return async (arg) => {
    const t0 = now();
    tm.resolverCalled = true;
    tm.resolverCalls += 1;
    try {
      const out = await resolveEntity(arg);
      if (tm.resolverStatus !== "unavailable") tm.resolverStatus = "ok";
      return out;
    } catch (error) {
      tm.resolverStatus = "unavailable";
      throw error;
    } finally {
      tm.resolverLatencyMs += now() - t0;
    }
  };
}

/** Answer-cache deps with the engine call timed (same functions, arguments and results). */
function timeEngineDeps(deps, timing) {
  if (!timing || typeof timing !== "object") return deps;
  return {
    getVersion: deps.getVersion,
    execute: async (...args) => {
      timing.engineStartedAt = now();
      try {
        return await deps.execute(...args);
      } finally {
        timing.engineMs = now() - timing.engineStartedAt;
      }
    },
  };
}

let sink = (line) => console.log(line);
/** Tests only: replace the sink (returns the previous one). */
function setTelemetrySink(fn) {
  const prev = sink;
  sink = typeof fn === "function" ? fn : (line) => console.log(line);
  return prev;
}

/** Build the allow-listed event. Pure; exported so tests can inspect exactly what would be logged. */
function buildTurnEvent({ tenantId, requestId, metrics = {} }) {
  // P0 cost-forensics (Phase 8): the same id already returned on every response as X-Request-Id
  // (middleware/requestId.js) - carried into this line so a specific network request can be matched
  // to the exact Claude-cost decision that answered it, without adding a new telemetry system.
  const event = {
    event: EVENT_NAME,
    ts: new Date().toISOString(),
    tenantId: typeof tenantId === "string" && TENANT_RE.test(tenantId) ? tenantId : null,
    requestId: typeof requestId === "string" && TENANT_RE.test(requestId) ? requestId : null,
  };
  for (const [field, clean] of Object.entries(FIELDS)) {
    const v = clean(metrics[field]);
    event[field] = v === undefined ? null : v;
  }
  return event;
}

/** Emit one event. Never throws: telemetry failure must not affect the chat turn. */
function emitTurnEvent(input) {
  try {
    const event = buildTurnEvent(input);
    sink(JSON.stringify(event));
    // Durable copy of the same allow-listed event (fire-and-forget; never throws, never awaited).
    require("./usageStore").persistTurnUsage(event);
  } catch (error) {
    try {
      console.error("TELEMETRY ERROR:", error && error.name);
    } catch (e) {
      /* nothing else is safe to do */
    }
  }
}

/**
 * Controller hook: adds the turn-level facts (latency, status, date context) to the query-engine metrics and emits once.
 * Never throws.
 */
function emitChatTurn(input) {
  try {
    const { tenantId, requestId, metrics, totalMs, httpStatus, dates, clientAborted } = input || {};
    const m = { ...(metrics || {}) };
    // The turn's one tenant date context, when it was read.
    if (dates && typeof dates === "object") {
      m.referenceDateSource = dates.source;
      m.futureVouchersPresent = dates.futureVouchers;
    }
    m.totalLatencyMs = totalMs;
    m.clientAborted = clientAborted === true;
    m.httpStatus = httpStatus;
    m.ok = httpStatus === 200;
    emitTurnEvent({ tenantId, requestId, metrics: m });
  } catch (e) {
    /* telemetry must never affect the turn */
  }
}

module.exports = { EVENT_NAME, now, newTurnMetrics, timeResolver, timeEngineDeps, buildTurnEvent, emitTurnEvent, emitChatTurn, setTelemetrySink };
