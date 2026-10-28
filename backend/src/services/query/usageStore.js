"use strict";

// Durable per-turn AI usage (P0 cost measurement). Derives ONE allow-listed record from the existing
// `tallypulse.ai.turn` event (turnTelemetry.buildTurnEvent) and writes it to MongoDB, fire-and-forget:
// the chat turn never waits for it and a failure here can never change or break a response.
// Usage counters only; cost is NOT computed (no pricing configuration exists in the app).

const PROVIDER = "anthropic";
// Mirrors the model expression at the Claude call site (planner.js);
// verify-ai-usage-persist.js checks it against the source so a change there cannot silently drift.
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const MODEL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const model = (v) => (typeof v === "string" && MODEL_RE.test(v) ? v : null);
const plannerModel = () => model(process.env.ANTHROPIC_PLANNER_MODEL || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL);

const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

function aiPathOf(plannerCalls, engineRan) {
  if (plannerCalls > 0) return "planner";
  return engineRan ? "engine" : "deterministic";
}

function failureCategoryOf(e) {
  if (e.clientAborted) return "client_aborted";
  if (e.ok) return null;
  return e.plannerCode || e.engineErrorCode || (e.httpStatus ? `http_${e.httpStatus}` : "unknown");
}

/** Pure: the persisted document, built only from the already-sanitised telemetry event. */
function buildUsageRecord(event) {
  if (!event || typeof event !== "object") return null;
  const plannerCalls = n(event.plannerAttempts);
  const rec = {
    ts: new Date(event.ts),
    tenantId: event.tenantId || null,
    requestId: event.requestId || null,
    aiPath: aiPathOf(plannerCalls, event.engineRan === true),
    path: event.path || null,
    provider: plannerCalls > 0 ? PROVIDER : null,
    plannerModel: plannerCalls > 0 ? plannerModel() : null,
    claudeCalls: plannerCalls,
    plannerCalls,
    retryCount: null,
    plannerInputTokens: n(event.plannerInputTokens),
    plannerOutputTokens: n(event.plannerOutputTokens),
    plannerCacheReadTokens: n(event.plannerCacheReadTokens),
    plannerCacheWriteTokens: n(event.plannerCacheCreationTokens),
    // planner response cache: a hit avoided a model call and is NOT in claudeCalls/plannerCalls above
    plannerCacheHits: n(event.plannerCacheHits),
    plannerCacheMisses: n(event.plannerCacheMisses),
    plannerCacheBypasses: n(event.plannerCacheBypasses),
    // engine executions of the turn by answer-cache status, and insight tool runs (counts only)
    queryExecutions: n(event.queryExecutions),
    answerCacheHits: n(event.answerCacheHits),
    answerCacheMisses: n(event.answerCacheMisses),
    answerCacheCoalesced: n(event.answerCacheCoalesced),
    answerCacheBypasses: n(event.answerCacheBypasses),
    insightRuns: n(event.insightRuns),
    plannerLatencyMs: event.plannerLatencyMs,
    totalLatencyMs: event.totalLatencyMs,
    ok: event.ok,
    httpStatus: event.httpStatus,
    failureCategory: failureCategoryOf(event),
    estimatedCostUsd: null,
  };
  rec.inputTokens = rec.plannerInputTokens;
  rec.outputTokens = rec.plannerOutputTokens;
  rec.cacheReadTokens = rec.plannerCacheReadTokens;
  rec.cacheWriteTokens = rec.plannerCacheWriteTokens;
  return Number.isNaN(rec.ts.getTime()) ? null : rec;
}

// Default writer: upsert on requestId ($setOnInsert) so a repeated emit for one request never duplicates;
// no request id -> plain insert. Dropped when Mongo is not connected, so it can never block on buffering.
let writer = async (rec) => {
  const mongoose = require("mongoose");
  if (mongoose.connection.readyState !== 1) return;
  const Model = require("../../models/aiTurnUsage.model");
  if (rec.requestId) await Model.updateOne({ requestId: rec.requestId }, { $setOnInsert: rec }, { upsert: true });
  else await Model.create(rec);
};

/** Tests only: replace the writer (returns the previous one). */
function setUsageWriter(fn) {
  const prev = writer;
  if (typeof fn === "function") writer = fn;
  return prev;
}

/** Fire-and-forget. Never throws; the caller never awaits it. */
function persistTurnUsage(event) {
  try {
    if (process.env.AI_USAGE_PERSIST === "off") return;
    const rec = buildUsageRecord(event);
    if (!rec) return;
    Promise.resolve()
      .then(() => writer(rec))
      .catch((error) => {
        try {
          console.error("AI USAGE PERSIST ERROR:", error && error.name);
        } catch (e) {
          /* nothing else is safe to do */
        }
      });
  } catch (e) {
    /* usage persistence never affects the turn */
  }
}

module.exports = { buildUsageRecord, persistTurnUsage, setUsageWriter, plannerModel };
