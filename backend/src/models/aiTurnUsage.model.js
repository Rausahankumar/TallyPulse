const mongoose = require("mongoose");

// One allow-listed usage record per AI chat turn (the usage store of the query engine). Usage counters only:
// no prompts, history, answers, tool results, names or figures. Never part of the chat/financial path.
const aiTurnUsageSchema = new mongoose.Schema(
  {
    ts: { type: Date, required: true, index: true },
    tenantId: { type: String, default: null, index: true },
    requestId: { type: String, default: null }, // same id as the X-Request-Id header; unique when present
    aiPath: { type: String, required: true }, // planner | engine | deterministic
    path: { type: String, default: null }, // the detailed telemetry path code
    provider: { type: String, default: null },
    plannerModel: { type: String, default: null },
    claudeCalls: { type: Number, default: 0 },
    plannerCalls: { type: Number, default: 0 },
    retryCount: { type: Number, default: null }, // null: SDK-internal retries are not observable
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    cacheWriteTokens: { type: Number, default: 0 },
    plannerInputTokens: { type: Number, default: 0 },
    plannerOutputTokens: { type: Number, default: 0 },
    plannerCacheReadTokens: { type: Number, default: 0 },
    plannerCacheWriteTokens: { type: Number, default: 0 },
    // Cache counters: null on records written before they existed (not measured); every newer record sets a number.
    // planner response cache (a hit avoided a model call; it is not counted in claudeCalls / plannerCalls)
    plannerCacheHits: { type: Number, default: null },
    plannerCacheMisses: { type: Number, default: null },
    plannerCacheBypasses: { type: Number, default: null },
    // engine executions of the turn by answer-cache status, and insight tool runs (counts only)
    queryExecutions: { type: Number, default: null },
    answerCacheHits: { type: Number, default: null },
    answerCacheMisses: { type: Number, default: null },
    answerCacheCoalesced: { type: Number, default: null },
    answerCacheBypasses: { type: Number, default: null },
    insightRuns: { type: Number, default: null },
    plannerLatencyMs: { type: Number, default: null },
    totalLatencyMs: { type: Number, default: null },
    ok: { type: Boolean, default: null },
    httpStatus: { type: Number, default: null },
    failureCategory: { type: String, default: null },
    estimatedCostUsd: { type: Number, default: null }, // null: no pricing configuration exists (cost deferred)
  },
  { versionKey: false }
);

aiTurnUsageSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: "string" } } });

module.exports = mongoose.model("AiTurnUsage", aiTurnUsageSchema);
