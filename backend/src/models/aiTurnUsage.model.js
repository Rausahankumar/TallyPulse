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
    providerRequests: { type: Number, default: null }, // provider requests actually sent, SDK-internal retries included (null: not measured)
    retryCount: { type: Number, default: null }, // providerRequests beyond one per model call (null: not measured)
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
    // ESTIMATES (provider-reported tokens x published list price, aiPricing.js), never a provider-reported charge; null when the
    // model has no listed price. Uncached = the same tokens priced with no prompt caching, to read the cache's effect on the bill.
    // Counts only tokens the provider reported: a request that errored or timed out returns no usage, so it adds $0 here even though
    // the provider may have billed it (providerRequests / retryCount show that such requests happened).
    estimatedCostUsd: { type: Number, default: null },
    estimatedUncachedCostUsd: { type: Number, default: null },
    pricingVersion: { type: String, default: null },
  },
  { versionKey: false }
);

aiTurnUsageSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: "string" } } });

module.exports = mongoose.model("AiTurnUsage", aiTurnUsageSchema);
