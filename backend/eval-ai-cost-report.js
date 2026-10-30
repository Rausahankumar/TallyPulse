/**
 * Read-only cost report from the persisted per-turn usage records (AiTurnUsage): what the AI flow cost and whether the prompt
 * cache and the planner response cache paid. ONE aggregation, aggregates only - no document, prompt, answer, tenant id or request id
 * is printed, and nothing is written.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27017/tallypulse_test node eval-ai-cost-report.js [--since=2026-10-01]
 *   (a non-loopback URI, e.g. production Atlas, is refused unless --confirm-read-only-aggregate is also given)
 *
 * Cost is an ESTIMATE: recorded tokens x published list price (aiPricing.js), recomputed here from the token totals so records
 * written before the cost field existed are covered too. Records of a model without a listed price are counted, not priced.
 * The provider prompt cache's net effect = estimate with its cache terms minus the same tokens priced with no caching.
 */

const args = process.argv.slice(2);
const opt = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const uri = process.env.MONGODB_URI;
if (!uri) { console.error("MONGODB_URI is not set (this script does not read .env)."); process.exit(2); }
const loopback = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri);
if (!loopback && !args.includes("--confirm-read-only-aggregate")) {
  console.error("Refusing a non-loopback MONGODB_URI without --confirm-read-only-aggregate (this script only reads one aggregate, but it must be your decision).");
  process.exit(2);
}
const since = opt("since") ? new Date(opt("since")) : null;
if (since && Number.isNaN(since.getTime())) { console.error("--since must be a date, e.g. 2026-10-01"); process.exit(2); }

const { estimateCost, PRICING_VERSION } = require("./src/services/query/aiPricing");

(async () => {
  const mongoose = require("mongoose");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const col = mongoose.connection.db.collection("aiturnusages");
  const n = (f) => ({ $sum: { $ifNull: [`$${f}`, 0] } });
  const when = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  const rows = await col.aggregate([
    ...(since ? [{ $match: { ts: { $gte: since } } }] : []),
    { $group: {
      _id: "$plannerModel",
      turns: { $sum: 1 }, modelCalls: n("claudeCalls"), providerRequests: n("providerRequests"), turnsWithRequestCount: when({ $isNumber: "$providerRequests" }), retries: n("retryCount"),
      modelCallsWhereRequestsMeasured: { $sum: { $cond: [{ $isNumber: "$providerRequests" }, { $ifNull: ["$claudeCalls", 0] }, 0] } }, // like with like: requests are comparable only with the calls of the turns that measured them
      inputTokens: n("inputTokens"), outputTokens: n("outputTokens"), cacheReadTokens: n("cacheReadTokens"), cacheWriteTokens: n("cacheWriteTokens"),
      appCacheHits: n("plannerCacheHits"), appCacheMisses: n("plannerCacheMisses"),
      turnsZeroCalls: when({ $eq: ["$claudeCalls", 0] }),
      turnsWithCacheWriteOnly: when({ $and: [{ $gt: ["$cacheWriteTokens", 0] }, { $eq: ["$cacheReadTokens", 0] }] }),
      turnsWithCacheRead: when({ $gt: ["$cacheReadTokens", 0] }),
      turnsFailed: when({ $ne: ["$ok", true] }),
      first: { $min: "$ts" }, last: { $max: "$ts" },
    } },
  ]).toArray();
  await mongoose.disconnect();

  const out = rows.map((r) => {
    const model = r._id;
    const est = model ? estimateCost({ model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens }) : null;
    const lookups = r.appCacheHits + r.appCacheMisses;
    return {
      model: model || "(no model call)", turns: r.turns, modelCalls: r.modelCalls,
      providerRequests: r.turnsWithRequestCount ? { requests: r.providerRequests, inTurnsThatMeasuredIt: r.turnsWithRequestCount, modelCallsInThoseTurns: r.modelCallsWhereRequestsMeasured, retriesBeyondOnePerCall: r.retries } : "not recorded for these turns (written before the counter existed)",
      tokens: { input: r.inputTokens, output: r.outputTokens, cacheRead: r.cacheReadTokens, cacheWrite: r.cacheWriteTokens },
      plannerResponseCache: lookups ? { hits: r.appCacheHits, misses: r.appCacheMisses, hitRate: Number((r.appCacheHits / lookups).toFixed(3)) } : "not recorded",
      providerPromptCache: { turnsWithReads: r.turnsWithCacheRead, turnsWithWriteOnly: r.turnsWithCacheWriteOnly, readTokens: r.cacheReadTokens, writeTokens: r.cacheWriteTokens },
      estimatedUsd: est ? est.usd : model ? "no listed price" : 0,
      estimatedUsdWithoutAnyCaching: est ? est.uncachedUsd : null,
      providerCacheNetEffectUsd: est ? Number((est.usd - est.uncachedUsd).toFixed(6)) : null,
      turnsWithNoModelCall: r.turnsZeroCalls, failedTurns: r.turnsFailed, period: [r.first, r.last],
    };
  });
  console.log(JSON.stringify({ pricing: PRICING_VERSION, note: "ESTIMATES from recorded tokens x list price; a negative net effect means the prompt cache SAVED money, positive means it cost more", since: since || "all", byModel: out }, null, 2));
  process.exit(0);
})().catch((e) => { console.error("report failed:", e && e.name, e && String(e.message).slice(0, 160)); process.exit(1); });
