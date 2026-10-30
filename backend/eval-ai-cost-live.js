/**
 * LIVE provider verification of the AI cost path (paid, small, capped). It answers what no offline test can: does the provider's
 * prompt cache actually write and read for TallyPulse's requests, and what do real turns cost?
 *
 *   ANTHROPIC_API_KEY=<your key> node eval-ai-cost-live.js --confirm-spend [--max-usd=0.50] [--ttl-probe]
 *
 * Guards (all enforced before the first paid call):
 *  - refuses without --confirm-spend; prints the plan and the worst-case spend first;
 *  - the key must already be in the process environment: this script NEVER reads .env or any file for credentials, and never
 *    prints the key;
 *  - a hard spend cap (default $0.50, never above $1.00), checked before every turn against the cost computed from the provider's
 *    own usage numbers; the run stops when the next turn could exceed it;
 *  - the data side is SYNTHETIC (eval/cost/harness.js): no tenant data, no database, no Tally;
 *  - the output holds only counts, token usage, request ids and costs - no prompts, no answers.
 * ANTHROPIC_BASE_URL may be unset, https://api.anthropic.com, or a local address (then it is a dry run against the local
 * stand-in, eval/cost/stub-server.js, and spends nothing); any other URL is refused.
 *
 * Cost is an ESTIMATE: provider-reported tokens x published list price (src/services/query/aiPricing.js); the API returns no
 * charge. Application-level planner-cache hits (no request sent) are reported apart from provider prompt-cache reads.
 */

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };

const base = process.env.ANTHROPIC_BASE_URL || "";
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(base);
const official = /^https:\/\/api\.anthropic\.com\/?$/.test(base);
if (base && !local && !official) { console.error("Refusing: ANTHROPIC_BASE_URL is neither the official provider endpoint (https://api.anthropic.com) nor a local address."); process.exit(2); }
const CAP = Math.min(1, Math.max(0.01, Number(opt("max-usd", "0.50")) || 0.5));
const TTL_PROBE = flag("ttl-probe");

const { estimateCost, PRICING_VERSION } = require("./src/services/query/aiPricing");
const MODEL = require("./src/services/query/planner").plannerRequestSettings().model;

const PLAN = [
  ["L1  query planner, COLD (first request of this prefix)", "What are my sales this month?"],
  ["L2  query planner, different question, same prefix (provider cache read expected)", "How much have I sold in the current month?"],
  ["L3  first question again in a NEW chat (application cache hit expected: no request)", "What are my sales this month?"],
  ["L4  investigation: query planner decline + analysis planner", "Why did sales decline in August 2025?"],
  ["L5  investigation + decision call", "What should I do about the sales decline in August 2025?"],
];
const WORST_CASE_PER_REQUEST = 0.035; // ~9K uncached input tokens + 400 output at the listed price: a deliberately high bound
const REQUESTS_PLANNED = 9 + (TTL_PROBE ? 1 : 0);

if (!flag("confirm-spend")) {
  console.log(`Plan (nothing was sent):\n  model: ${MODEL}\n  pricing: ${PRICING_VERSION}\n  turns: ${PLAN.length}${TTL_PROBE ? " + one request after a 5m05s wait (cache expiry probe)" : ""}\n  at most ~${REQUESTS_PLANNED} provider requests; worst case ~$${(REQUESTS_PLANNED * WORST_CASE_PER_REQUEST).toFixed(2)}, hard cap $${CAP.toFixed(2)}\nRe-run with --confirm-spend to execute.`);
  process.exit(0);
}
if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY is not set in the environment (this script does not read .env). Nothing was sent."); process.exit(2); }

// ---- raw usage at the transport layer (the authoritative per-request record; the key is never touched)
const wire = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init);
  if (/\/v1\/messages$/.test(String(url).split("?")[0])) {
    const clone = res.clone();
    const rec = { status: res.status, requestId: res.headers.get("request-id") || null };
    wire.push(rec);
    clone.json().then((j) => Object.assign(rec, { usage: j.usage || null, model: j.model || null, stop: j.stop_reason || null })).catch(() => {});
  }
  return res;
};

const cost = (u) => (u ? estimateCost({ model: MODEL, inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens, cacheWriteTokens: u.cache_creation_input_tokens }) : null);
const sum = (list) => list.reduce((t, c) => t + (c ? c.usd : 0), 0);

(async () => {
  const { createHarness } = require("./eval/cost/harness");
  const h = createHarness({ baseUrl: local ? base : null });
  const Anthropic = require("@anthropic-ai/sdk");
  const sdk = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, ...(local ? { baseURL: base } : {}) });

  // ---- 1. the cacheable prefixes: real token counts (free endpoint) -> provider eligibility (Sonnet 4.5: 1,024-token minimum)
  const planner = require("./src/services/query/planner"), analysis = require("./src/services/query/analysisPlanner");
  const prefixes = {};
  for (const [name, p] of [["query_planner", planner.getPlannerPrompt()], ["analysis_planner", analysis.getAnalysisPrompt()]]) {
    try {
      const r = await sdk.messages.countTokens({ model: MODEL, system: p.system, tools: [p.tool], messages: [{ role: "user", content: "x" }] });
      prefixes[name] = { tokens: r.input_tokens, eligible: r.input_tokens >= 1024 };
    } catch (e) { prefixes[name] = { error: String(e && e.status ? `HTTP ${e.status}` : e && e.name) }; }
  }
  console.log("prefix tokens (count_tokens, free):", JSON.stringify(prefixes));

  // ---- 2. the turns, through the real controller
  const rows = [];
  let spent = 0, stopped = null, unparsedTotal = 0;
  const run = async (label, question, tenant = "T-COST-LIVE") => {
    if (spent + 3 * WORST_CASE_PER_REQUEST > CAP) { stopped = `stopped before "${label.slice(0, 2)}": next turn could exceed the $${CAP.toFixed(2)} cap (spent ~$${spent.toFixed(4)})`; return false; }
    const w0 = wire.length;
    const t = await h.ask(tenant, question);
    await new Promise((r) => setTimeout(r, 400)); // let the response bodies finish parsing
    const mine = wire.slice(w0);
    const costs = mine.map((m) => cost(m.usage));
    const unparsed = mine.filter((m) => m.status === 200 && !m.usage).length; // billed but unmeasured: count the worst case, not $0
    spent += sum(costs) + unparsed * WORST_CASE_PER_REQUEST;
    unparsedTotal += unparsed;
    rows.push({ label, status: t.status, requestsSent: mine.length, telemetryCalls: t.record && t.record.claudeCalls, telemetryProviderRequests: t.record && t.record.providerRequests, appCacheHits: t.record && t.record.plannerCacheHits, requests: mine.map((m, i) => ({ http: m.status, requestId: m.requestId, usage: m.usage, estUsd: costs[i] && costs[i].usd, estUncachedUsd: costs[i] && costs[i].uncachedUsd })), telemetryUsd: t.record && t.record.estimatedCostUsd, ms: t.ms });
    console.log(`${label}\n   requests=${mine.length} appCacheHits=${t.record && t.record.plannerCacheHits} est=$${sum(costs).toFixed(5)} (uncached would be $${mine.reduce((tt, m) => tt + ((cost(m.usage) || {}).uncachedUsd || 0), 0).toFixed(5)})  cumulative=$${spent.toFixed(5)}`);
    return true;
  };
  for (const [label, q] of PLAN) if (!(await run(label, q))) break;

  // ---- 3. optional: the 5-minute cache lifetime (one request after the prefix has gone idle)
  if (TTL_PROBE && !stopped) {
    console.log("waiting 5m05s to let the 5-minute prompt cache expire ...");
    await new Promise((r) => setTimeout(r, 305000));
    await run("L6  query planner after 5m05s idle (cache write expected again)", "Show total sales for this month.", "T-COST-LIVE-2");
  }

  // ---- 4. what the numbers say
  const all = wire.filter((w) => w.usage);
  const read = all.reduce((t, w) => t + (w.usage.cache_read_input_tokens || 0), 0), write = all.reduce((t, w) => t + (w.usage.cache_creation_input_tokens || 0), 0);
  const total = all.map((w) => cost(w.usage)), costWith = sum(total), costWithout = total.reduce((t, c) => t + (c ? c.uncachedUsd : 0), 0);
  const report = {
    model: MODEL, pricing: PRICING_VERSION, costBasis: "ESTIMATE = provider-reported tokens x published list price; the API returns no charge",
    providerRequests: wire.length, withUsage: all.length, appCacheHits: rows.reduce((t, r) => t + (r.appCacheHits || 0), 0),
    providerCacheWriteTokens: write, providerCacheReadTokens: read,
    estimatedCostWithCacheUsd: Number(costWith.toFixed(6)), estimatedCostWithoutCacheUsd: Number(costWithout.toFixed(6)),
    providerCacheNetEffectUsd: Number((costWith - costWithout).toFixed(6)), spentUsdApprox: Number(spent.toFixed(6)), capUsd: CAP, stopped, unparsedResponsesCountedAtWorstCase: unparsedTotal,
    telemetryAgreesWithWire: rows.every((r) => r.telemetryProviderRequests === r.requestsSent),
    prefixes,
  };
  // break-even: a prefix of P tokens is written once (1.25x) and read k more times within 5 minutes (0.1x each) vs paid in full each time
  const p = (prefixes.query_planner && prefixes.query_planner.tokens) || 0;
  report.breakEvenQueryPlanner = p ? [0, 1, 2, 5, 10].map((k) => ({ readsWithin5Min: k, withCacheMultiplier: Number(((1.25 + 0.1 * k) / (1 + k)).toFixed(3)) })) : null;
  console.log("\nREPORT " + JSON.stringify(report, null, 2));
  console.log("\nPER-TURN " + JSON.stringify(rows.map((r) => ({ ...r, requests: r.requests.map((q) => ({ ...q, requestId: q.requestId && q.requestId.slice(0, 12) + "…" })) })), null, 2));
  process.exit(0);
})().catch((e) => { console.error("live run failed:", e && e.name, e && e.message && String(e.message).slice(0, 200)); process.exit(1); });
