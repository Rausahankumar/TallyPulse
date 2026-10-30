/**
 * AI cost path, end to end through the REAL chat controller, queryChat, the shared planner response cache, the real planner
 * client and the real Anthropic SDK - pointed at a LOCAL stand-in endpoint (eval/cost/harness.js). What this proves: the
 * application's own behaviour (what is sent, how often, what telemetry records). What it CANNOT prove: anything about the
 * provider (prompt-cache reads/writes, real token counts, real charges) - the stand-in's usage numbers are simulated. Those need
 * the live run (eval-ai-cost-live.js), which this file never makes.
 *
 * Covers (audit Tests A-I): identical request; the same question inside one conversation; equivalent wordings; contextual
 * follow-up; data change (no stale number); tenant isolation; investigation call counts and repeat; concurrent duplicates;
 * SDK-internal retries - plus the cost estimate and the cache's in-flight sharing edge cases.
 *
 * Run: node verify-ai-cost-path.js     (no database, no paid call)
 */

process.env.AI_USAGE_PERSIST = "on";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const { run } = require("./eval/cost/scenarios");
const { createPlannerResponseCache, isCachedResponse } = require("./src/services/query/plannerResponseCache");
const { estimateCost, PRICING_VERSION } = require("./src/services/query/aiPricing");
const { buildUsageRecord } = require("./src/services/query/usageStore");
const { createAnthropicPlannerClient } = require("./src/services/query/planner");
const { createStub } = require("./eval/cost/harness");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 700)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const J = (v) => JSON.stringify(v);

(async () => {
  const { out, calls } = await run();

  // ---- A. identical request, normal chat path
  const A = out.A_identical_new_chats;
  check("A-identical", "the same question in a NEW conversation: the first sends 1 provider request, the second sends none (planner response cache hit on the normal chat path)", A.requestsAfterFirst === 1 && A.requests === 1 && A.first.calls === 1 && A.second.calls === 0 && A.second.hits === 1 && A.second.sent === 0, J(A));
  check("A-model-unchanged", "the request carries the configured model at temperature 0 (the cache key includes both)", out.models.length === 1 && /^claude-sonnet-4-5-20250929@0$/.test(out.models[0]), J(out.models));

  // ---- B. the same question repeated INSIDE one conversation
  const B = out.B_same_chat_repeat;
  check("B-live-conversation", "inside one conversation the 2nd ask is a miss (its request now carries the previous plan as context), the 3rd and later hit - documented behaviour, not a bypass", J(B.requestsPerTurn) === "[1,1,0,0]" && B.turns[1].misses === 1 && B.turns[2].hits === 1, J(B.requestsPerTurn));

  // ---- C. equivalent wordings: no reuse of the model call (by design); never claimed as semantic caching
  const C = out.C_equivalent_wordings;
  check("C-equivalent-wordings", "three equivalent wordings make 3 model calls (the cache is exact-request only); each is accounted", C.requests === 3 && C.turns.every((t) => t.calls === 1 && t.hits === 0), J(C.turns.map((t) => [t.calls, t.hits])));

  // ---- D. contextual follow-up
  const D = out.D_followup;
  check("D-followup-compact", "a follow-up sends ONE model call whose user message is the scope + question (hundreds of characters), never the conversation history", D.followUp.calls === 1 && D.followUpRequestChars[0] < 1000 && D.followUpRequestChars[0] > 100, J(D.followUpRequestChars));

  // ---- E. data change: a remembered model reply carries no data, so no stale figure can be served
  const E = out.E_data_change;
  check("E-no-stale-number", "after the tenant's data changes the planner reply is reused (0 calls) but the engine runs again and the figure is new", E.second.calls === 0 && E.second.hits === 1 && E.engineExecutions === 2 && E.figures[0] !== E.figures[1], J(E.figures));

  // ---- F. tenant isolation
  const F = out.F_tenant_isolation;
  check("F-tenant-isolation", "another tenant's identical question is a miss (1 request); the first tenant's repeat still hits", F.otherTenant.calls === 1 && F.otherTenant.hits === 0 && F.sameTenantAgain.hits === 1, J(F));

  // ---- G. investigation: every model call counted, and a repeat costs nothing
  const G = out.G_investigation, G2 = out.G2_repeat_investigation;
  check("G-call-count", "'why' = 2 provider requests (query planner decline + analysis planner); 'what should I do' = 3 (+ the decision call); telemetry agrees with what the endpoint received", G.whyRequests === 2 && G.why.calls === 2 && G.why.sent === 2 && G.actRequests === 3 && G.act.calls === 3 && G.act.sent === 3, J([G.whyRequests, G.why.calls, G.actRequests, G.act.calls]));
  check("G-two-prefixes", "the cacheable prefix (tools + system) is byte-identical across questions: exactly 2 distinct prefixes in total (query planner, analysis planner), both marked cache_control", out.prefixes.length === 2 && out.cacheControl.every(([, v]) => v === '{"system":[true],"tools":[true]}'), J([out.prefixes, out.cacheControl]));
  check("G2-repeat", "the same investigation asked again in a new conversation: 0 provider requests for 'why' and for 'what should I do' (all of its model calls are remembered)", G2.whyRequests === 0 && G2.actRequests === 0 && G2.why.calls === 0 && G2.act.calls === 0, J(G2));

  // ---- I. concurrent duplicates
  const I = out.I_concurrent_duplicates;
  check("I-concurrent-duplicates", "two identical questions at the same moment send ONE provider request (the second waits for the first's reply)", I.requests === 1 && out.stats.cache.coalesced >= 1, J([I.requests, out.stats.cache]));
  const iRecs = I.turns;
  check("I-accounting", "accounting is exact: one turn made the call (1 request), the other made none (0 requests, a cache hit)", iRecs.map((t) => t.sent).sort().join() === "0,1" && iRecs.map((t) => t.calls).sort().join() === "0,1", J(iRecs.map((t) => [t.calls, t.hits, t.sent])));

  // ---- R. SDK-internal retries are visible
  const R = out.R_sdk_retry;
  check("R-retry-visible", "an overloaded reply retried by the SDK: the endpoint received 2 requests; telemetry says 2 provider requests, 1 model call, retryCount 1 (it used to say null)", R.requests === 2 && R.turn.sent === 2 && R.turn.calls === 1 && R.turn.retry === 1, J(R));
  const R2 = out.R2_retry_attribution;
  check("R2-retry-attribution", "with two turns in flight and one overloaded request, the retry is charged to that turn only", R2.failedTurn.sent === 2 && R2.failedTurn.retry === 1 && R2.otherTurn.sent === 1 && R2.otherTurn.retry === 0, J(R2));
  check("R-no-secret-in-wire-record", "the recorded request metadata holds no credential header", calls.every((c) => c.headerKeys.every((h) => !/key|authorization/i.test(h))), J(calls[0].headerKeys));

  // ---- cost estimate: arithmetic against known numbers, labelled, never guessed
  const u = { model: "claude-sonnet-4-5-20250929", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 500 };
  const est = estimateCost(u);
  check("cost-arithmetic", "1,000 in + 200 out + 3,000 cache-read + 500 cache-write on Sonnet 4.5 = $0.008775 (3 + 15 + 0.30 + 3.75 per M); the same tokens with no caching = $0.0165", est && est.usd === 0.008775 && est.uncachedUsd === 0.0165 && est.pricingVersion === PRICING_VERSION, J(est));
  check("cost-haiku", "Haiku 4.5 rows differ (1 / 5 / 0.10 / 1.25 per M)", estimateCost({ model: "claude-haiku-4-5-20251001", inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 }).usd === 1 + 5 + 0.1 + 1.25);
  check("cost-unknown-null", "a model without a listed price gets NO estimate (null), never a guess; junk token values count as 0", estimateCost({ model: "claude-unknown-9", inputTokens: 5 }) === null && estimateCost({ model: undefined }) === null && estimateCost({ model: "claude-sonnet-4-5", inputTokens: -5, outputTokens: NaN }).usd === 0);
  const evBase = { ts: new Date().toISOString(), tenantId: "T", requestId: "r1", plannerAttempts: 2, plannerHttpAttempts: 3, plannerInputTokens: 1000, plannerOutputTokens: 200, plannerCacheReadTokens: 3000, plannerCacheCreationTokens: 500, httpStatus: 200, ok: true };
  const rec = buildUsageRecord(evBase);
  check("record-cost-and-retries", "the persisted record carries provider requests (3), retries (3 - 2 calls = 1) and the labelled estimate", rec.providerRequests === 3 && rec.retryCount === 1 && rec.estimatedCostUsd === 0.008775 && rec.estimatedUncachedCostUsd === 0.0165 && rec.pricingVersion === PRICING_VERSION, J(rec));
  const zero = buildUsageRecord({ ...evBase, plannerAttempts: 0, plannerHttpAttempts: 0, plannerInputTokens: 0, plannerOutputTokens: 0, plannerCacheReadTokens: 0, plannerCacheCreationTokens: 0 });
  check("record-zero-calls", "a turn with no model call costs exactly 0 and sent 0 requests", zero.estimatedCostUsd === 0 && zero.providerRequests === 0 && zero.retryCount === 0);
  const old = buildUsageRecord({ ...evBase, plannerHttpAttempts: undefined });
  check("record-unmeasured-null", "an event without the attempts counter is NOT measured: providerRequests and retryCount stay null (not 0)", old.providerRequests === null && old.retryCount === null);
  process.env.ANTHROPIC_PLANNER_MODEL = "claude-unpriced-test-model";
  const unp = buildUsageRecord(evBase);
  delete process.env.ANTHROPIC_PLANNER_MODEL;
  check("record-unpriced-model", "a configured model with no listed price: tokens recorded, cost null", unp.estimatedCostUsd === null && unp.plannerInputTokens === 1000 && unp.pricingVersion === null, J(unp));

  // a model id is read from the environment: names every object inherits are not prices (they used to give a NaN cost, which the
  // usage writer then rejected - losing the whole record)
  check("cost-inherited-names", "model ids 'constructor', 'toString', '__proto__' have no price: null, never NaN; a record built for one keeps its tokens", ["constructor", "toString", "__proto__", "hasOwnProperty"].every((m) => estimateCost({ model: m, inputTokens: 5 }) === null) && (() => { process.env.ANTHROPIC_PLANNER_MODEL = "constructor"; const r = buildUsageRecord(evBase); delete process.env.ANTHROPIC_PLANNER_MODEL; return r.estimatedCostUsd === null && r.plannerInputTokens === 1000 && Number.isNaN(r.estimatedCostUsd) === false; })());

  // ---- provider requests when nothing completes: counted from what was SENT, not from what came back
  {
    const probe = { system: [{ type: "text", text: "s" }], tools: [{ name: "t" }], tool_choice: { type: "tool", name: "t" }, max_tokens: 10, messages: [{ role: "user", content: "q" }] };
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const err = await createAnthropicPlannerClient()(probe).then(() => null, (e) => e);
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    check("attempts-not-configured", "no API key: the call fails before any request is sent and the error says 0 provider requests (not 1)", !!err && err.code === "AI_NOT_CONFIGURED" && err.providerAttempts === 0, err && String(err.providerAttempts));
    const dead = await createStub(() => ({ status: 500, json: { type: "error", error: { type: "api_error", message: "boom" } } }));
    const failing = createAnthropicPlannerClient({ sdkOptions: { baseURL: dead.url, apiKey: "stub-key-not-a-secret" }, maxRetries: 1 });
    const err2 = await failing(probe).then(() => null, (e) => e);
    const sent = dead.calls.length;
    await dead.close();
    check("attempts-failed-call", "a call that fails after the SDK's retry still reports every request sent: the endpoint received 2, the error says 2", !!err2 && sent === 2 && err2.providerAttempts === 2, J([sent, err2 && err2.providerAttempts]));
  }

  // ---- the cache's in-flight sharing: edge cases (fake client, no network)
  const SET = () => ({ model: "m", temperature: 0 });
  const request = (q = "q") => ({ system: [{ type: "text", text: "s" }], tools: [{ name: "t" }], tool_choice: { type: "tool", name: "t" }, max_tokens: 10, messages: [{ role: "user", content: q }] });
  const good = (v = 1) => ({ content: [{ type: "tool_use", name: "t", input: { v } }], stop_reason: "tool_use", model: "m", usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const tick = () => new Promise((r) => setImmediate(r));

  {
    const cache = createPlannerResponseCache();
    const d = deferred(); let n = 0;
    const turn = (tenant) => cache.wrap(async () => { n += 1; return d.promise; }, { tenantId: tenant, settings: SET });
    const p1 = turn("A")(request()), p2 = turn("A")(request());
    await tick(); d.resolve(good(7));
    const [r1, r2] = await Promise.all([p1, p2]);
    check("flight-shared", "two concurrent identical requests: ONE client call; the follower gets the same tool input with zero usage and the cached mark", n === 1 && r1.content[0].input.v === 7 && r2.content[0].input.v === 7 && isCachedResponse(r2) && !isCachedResponse(r1) && r2.usage.input_tokens === 0 && cache.stats.coalesced === 1);
    const later = await cache.wrap(async () => { n += 1; return good(9); }, { tenantId: "A", settings: SET })(request());
    check("flight-then-cache", "afterwards the entry serves as an ordinary hit and nothing stays in flight", n === 1 && isCachedResponse(later) && cache.stats.hit === 2);
  }
  {
    const cache = createPlannerResponseCache(); const d = deferred(); let n = 0;
    const client = async () => { n += 1; if (n === 1) return d.promise; return good(2); };
    const p1 = cache.wrap(client, { tenantId: "A", settings: SET })(request());
    const p2 = cache.wrap(client, { tenantId: "A", settings: SET })(request());
    await tick(); d.reject(new Error("provider down"));
    const [s1, s2] = await Promise.allSettled([p1, p2]);
    check("flight-leader-fails", "the leader fails: the leader sees its own error; the waiting request makes its OWN call and succeeds (an error is never another request's result)", s1.status === "rejected" && /provider down/.test(s1.reason.message) && s2.status === "fulfilled" && s2.value.content[0].input.v === 2 && n === 2);
  }
  {
    const cache = createPlannerResponseCache(); const d = deferred(); let n = 0;
    const client = async () => { n += 1; return n === 1 ? d.promise : good(3); };
    const p1 = cache.wrap(client, { tenantId: "A", settings: SET })(request());
    const p2 = cache.wrap(client, { tenantId: "A", settings: SET })(request());
    await tick(); d.resolve({ ...good(1), stop_reason: "max_tokens" });
    const [r1, r2] = await Promise.all([p1, p2]);
    check("flight-leader-truncated", "a truncated (max_tokens) leader reply is not reusable: the waiting request makes its own call", n === 2 && r2.content[0].input.v === 3 && !isCachedResponse(r2) && r1.stop_reason === "max_tokens");
  }
  {
    const cache = createPlannerResponseCache(); const d = deferred(); let n = 0;
    const leaderAbort = new AbortController();
    const client = async (req, { signal } = {}) => { n += 1; if (n === 1) return new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))); return good(4); };
    const p1 = cache.wrap(client, { tenantId: "A", settings: SET })(request(), { signal: leaderAbort.signal });
    const p2 = cache.wrap(client, { tenantId: "A", settings: SET })(request());
    await tick(); leaderAbort.abort();
    const [s1, s2] = await Promise.allSettled([p1, p2]);
    check("flight-leader-cancelled", "the leader's client disconnects: the leader is cancelled, the other request is NOT cancelled with it and answers", s1.status === "rejected" && s2.status === "fulfilled" && s2.value.content[0].input.v === 4 && n === 2, J([s1.status, s2.status, n]));
  }
  {
    const cache = createPlannerResponseCache(); const d = deferred(); let n = 0;
    const followerAbort = new AbortController();
    const client = async () => { n += 1; return d.promise; };
    const p1 = cache.wrap(client, { tenantId: "A", settings: SET })(request());
    const p2 = cache.wrap(client, { tenantId: "A", settings: SET })(request(), { signal: followerAbort.signal });
    await tick(); followerAbort.abort();
    const s2 = await Promise.allSettled([p2]);
    d.resolve(good(5));
    const r1 = await p1;
    check("flight-follower-cancelled", "a cancelled WAITING request stops waiting and makes no call; the leader is unaffected and still stored its reply", s2[0].status === "rejected" && n === 1 && r1.content[0].input.v === 5 && cache.size() === 1);
  }
  {
    const cache = createPlannerResponseCache(); const d = deferred(); let n = 0;
    const client = async () => { n += 1; return d.promise; };
    const pA = cache.wrap(client, { tenantId: "A", settings: SET })(request());
    const pB = cache.wrap(client, { tenantId: "B", settings: SET })(request());
    const pC = cache.wrap(client, { tenantId: "A", settings: SET })(request("a different question"));
    await tick(); d.resolve(good(6));
    await Promise.all([pA, pB, pC]);
    check("flight-isolated", "a different tenant, or a different request, never joins another's flight: 3 calls", n === 3 && cache.stats.coalesced === 0);
  }

  console.log(`\nverify-ai-cost-path: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
