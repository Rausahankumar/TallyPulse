/**
 * Planner response cache (plannerResponseCache.js): a remembered model REPLY for an identical model request, per tenant.
 * Offline, scripted models only (no network, no database, no paid call). Checks: hits/misses/bypasses, tenant isolation, the
 * key (model, temperature, system, tools, tool_choice, max_tokens, messages), what is never stored (errors, timeouts, aborts,
 * malformed / unexpected / truncated replies), bounds (per tenant, total, bytes, TTL, deterministic eviction), truthful
 * usage (a hit is no model call and no tokens), and - through the real chat turn - that every planner call path goes through
 * it while names are re-resolved, dates re-resolved, the engine and the answer cache run as before, and same-chat follow-ups
 * behave as designed.
 *
 * Run: node verify-planner-response-cache.js
 */

process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const { createPlannerResponseCache, isCachedResponse } = require("./src/services/query/plannerResponseCache");
const { planQuestion, plannerRequestSettings, PLANNER_TOOL_NAME } = require("./src/services/query/planner");
const { planAnalysis } = require("./src/services/query/analysisPlanner");
const { createAnswerCache } = require("./src/services/query/answerCache");
const { validateQueryPlan } = require("./src/services/query/validator");
const { buildTurnEvent } = require("./src/services/query/turnTelemetry");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 900)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const settings = () => ({ model: "model-a", temperature: 0 });
const REQ = { system: [{ type: "text", text: "SYSTEM v1" }], messages: [{ role: "user", content: "sales august 2025" }], tools: [{ name: "submit_query_plan", input_schema: { type: "object" } }], tool_choice: { type: "tool", name: "submit_query_plan" }, max_tokens: 700 };
const ok = (input = { plan: { v: 1 } }, name = "submit_query_plan") => ({ content: [{ type: "tool_use", id: "tu1", name, input }], stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } });
function counting(reply) {
  const c = async (req, opts) => { c.calls += 1; c.requests.push(req); return typeof reply === "function" ? reply(req, opts) : JSON.parse(JSON.stringify(reply)); };
  c.calls = 0; c.requests = [];
  return c;
}

(async () => {
  // ---------------------------------------------------------------------------------------------- 1. the cache itself
  {
    const cache = createPlannerResponseCache();
    const inner = counting(ok());
    const counters = { hit: 0, miss: 0, bypass: 0 };
    const a = cache.wrap(inner, { tenantId: "T-A", settings, counters });
    const first = await a(REQ, { signal: null });
    const second = await a(JSON.parse(JSON.stringify(REQ)), { signal: null });
    check("hit", "an identical request is answered from memory: one model call, the same reply", inner.calls === 1 && JSON.stringify(second.content) === JSON.stringify(first.content) && counters.hit === 1 && counters.miss === 1);
    check("hit-truthful", "a hit is marked, carries zero usage and is not the stored object (a clone)", isCachedResponse(second) && !isCachedResponse(first) && Object.values(second.usage).every((v) => v === 0));
    const settingsInRequest = await a({ ...REQ, model: "model-z" }, {});
    check("key-request-model", "a model carried by the request itself is part of the key (no cross-model hit)", !isCachedResponse(settingsInRequest) && inner.calls === 2);
    inner.calls -= 1; // keep the call arithmetic below unchanged
    second.content[0].input.plan.v = 99;
    const third = await a(REQ, {});
    check("hit-clone", "changing a returned hit does not change what is remembered", third.content[0].input.plan.v === 1);
    const keyOrder = await a({ max_tokens: 700, tool_choice: REQ.tool_choice, tools: REQ.tools, messages: REQ.messages, system: REQ.system }, {});
    check("key-order", "key order does not matter (stable hashing)", isCachedResponse(keyOrder) && inner.calls === 1);

    const b = cache.wrap(inner, { tenantId: "T-B", settings, counters: {} });
    await b(REQ, {});
    check("tenant", "another tenant never sees the reply: it calls the model", inner.calls === 2);

    const variants = [
      ["model", REQ, () => ({ model: "model-b", temperature: 0 })],
      ["temperature", REQ, () => ({ model: "model-a", temperature: 1 })],
      ["system", { ...REQ, system: [{ type: "text", text: "SYSTEM v2" }] }, settings],
      ["tools", { ...REQ, tools: [{ name: "submit_query_plan", input_schema: { type: "object", properties: {} } }] }, settings],
      ["tool_choice", { ...REQ, tool_choice: { type: "tool", name: "submit_analysis_plan" } }, settings],
      ["max_tokens", { ...REQ, max_tokens: 1500 }, settings],
      ["messages", { ...REQ, messages: [{ role: "user", content: "sales august 2025 by customer" }] }, settings],
      ["context", { ...REQ, messages: [{ role: "user", content: "Previous plan: {...}\nsales august 2025" }] }, settings],
    ];
    for (const [what, req, s] of variants) {
      const before = inner.calls;
      const r = await cache.wrap(inner, { tenantId: "T-A", settings: s, counters: {} })(req, {});
      check(`key-${what}`, `a different ${what} is a miss (the model is called)`, inner.calls === before + 1 && !isCachedResponse(r));
    }
    const bypass = { hit: 0, miss: 0, bypass: 0 };
    const before = inner.calls;
    await cache.wrap(inner, { tenantId: "", settings, counters: bypass })(REQ, {});
    await cache.wrap(inner, { tenantId: "T-A", settings: () => null, counters: bypass })(REQ, {});
    check("bypass", "no tenant or no model settings: straight to the model, counted as bypass, nothing stored", inner.calls === before + 2 && bypass.bypass === 2 && bypass.hit === 0);
  }

  // ---------------------------------------------------------------------------------------------- 2. never stored
  {
    const cases = [
      ["no tool call", { content: [{ type: "text", text: "Sure" }], stop_reason: "end_turn" }],
      ["two tool calls", { content: [ok().content[0], ok().content[0]], stop_reason: "tool_use" }],
      ["unexpected tool", ok({ plan: {} }, "other_tool")],
      ["input not an object", { content: [{ type: "tool_use", id: "x", name: "submit_query_plan", input: "plan" }], stop_reason: "tool_use" }],
      ["truncated (max_tokens)", { ...ok(), stop_reason: "max_tokens" }],
      ["not an object", null],
    ];
    for (const [what, reply] of cases) {
      const cache = createPlannerResponseCache();
      const inner = counting(reply);
      const w = cache.wrap(inner, { tenantId: "T", settings });
      await w(REQ, {});
      await w(REQ, {});
      check(`not-stored-${what.replace(/\W+/g, "-")}`, `${what}: never remembered (the model is asked again)`, inner.calls === 2 && cache.size() === 0);
    }
    for (const [what, err] of [["error", Object.assign(new Error("529 overloaded"), { status: 529 })], ["timeout", Object.assign(new Error("Planner deadline of 30000ms exceeded."), { code: "PLANNER_DEADLINE_EXCEEDED" })]]) {
      const cache = createPlannerResponseCache();
      let calls = 0;
      const w = cache.wrap(async () => { calls += 1; throw err; }, { tenantId: "T", settings });
      let thrown = 0;
      for (let i = 0; i < 2; i += 1) await w(REQ, {}).catch((e) => { if (e === err) thrown += 1; });
      check(`not-stored-${what}`, `${what}: the same error reaches the caller, nothing is stored`, thrown === 2 && calls === 2 && cache.size() === 0);
    }
    const cache = createPlannerResponseCache();
    const inner = counting(ok());
    const ctl = new AbortController();
    ctl.abort();
    const err = await cache.wrap(inner, { tenantId: "T", settings })(REQ, { signal: ctl.signal }).catch((e) => e);
    check("aborted-before", "a stopped request: no lookup, no model call, an abort error (as the SDK gives)", inner.calls === 0 && err && err.name === "AbortError");
    const late = new AbortController();
    await cache.wrap(counting((req) => { late.abort(); return ok(); }), { tenantId: "T", settings })(REQ, { signal: late.signal });
    check("aborted-during", "a request stopped while the model answered is not remembered", cache.size() === 0);
    const sig = new AbortController();
    const seen = counting((req, opts) => { seen.signal = opts.signal; return ok(); });
    await cache.wrap(seen, { tenantId: "T2", settings })(REQ, { signal: sig.signal });
    check("signal-passed", "the caller's cancellation signal reaches the real client unchanged", seen.signal === sig.signal);
  }

  // ---------------------------------------------------------------------------------------------- 3. bounds and expiry
  {
    let t = 0;
    const cache = createPlannerResponseCache({ maxEntriesPerTenant: 2, maxEntries: 3, ttlMs: 1000, now: () => t });
    const inner = counting(ok());
    const ask = (tenantId, q) => cache.wrap(inner, { tenantId, settings })({ ...REQ, messages: [{ role: "user", content: q }] }, {});
    await ask("T1", "q1"); t += 1; await ask("T1", "q2"); t += 1; await ask("T1", "q3");
    let calls = inner.calls;
    await ask("T1", "q1");
    check("evict-tenant", "the per-tenant cap evicts the oldest entry first (deterministic)", inner.calls === calls + 1 && cache.size() <= 2);
    calls = inner.calls; t += 1;
    await ask("T2", "x1"); t += 1; await ask("T2", "x2");
    check("evict-total", "the total cap holds across tenants", cache.size() === 3 && cache.stats.evicted >= 2);
    calls = inner.calls;
    await ask("T2", "x2");
    check("lru-hit", "a recent entry is still remembered", inner.calls === calls);
    t += 5000;
    await ask("T2", "x2");
    check("ttl", "an expired entry is not used (the model is asked again)", inner.calls === calls + 1);
    const zero = createPlannerResponseCache({ maxEntriesPerTenant: 0 });
    const zc = counting(ok());
    await zero.wrap(zc, { tenantId: "T", settings })(REQ, {});
    await zero.wrap(zc, { tenantId: "T", settings })(REQ, {});
    check("cap-zero", "a cap below 1 stores nothing and never hangs", zc.calls === 2 && zero.size() === 0);
    let t2 = 0;
    const one = createPlannerResponseCache({ ttlMs: 10, now: () => t2 });
    await one.wrap(counting(ok()), { tenantId: "T-GONE", settings })(REQ, {});
    t2 = 100;
    await one.wrap(counting(ok()), { tenantId: "T-GONE", settings: () => ({ model: "model-q", temperature: 0 }) })(REQ, {});
    await one.wrap(counting(ok()), { tenantId: "T-GONE", settings })(REQ, {}); // looks up the expired entry: dropped
    check("no-empty-partitions", "expired entries are dropped and leave no empty tenant partition behind", one.size() === 2);
    const small = createPlannerResponseCache({ maxEntryBytes: 50 });
    const big = counting(ok({ plan: { v: 1, note: "x".repeat(200) } }));
    const w = small.wrap(big, { tenantId: "T", settings });
    await w(REQ, {}); await w(REQ, {});
    check("bytes", "a reply larger than the per-entry cap is not stored", big.calls === 2 && small.size() === 0);
  }

  // ---------------------------------------------------------------------------------------------- 4. usage stays truthful in the planners
  {
    const cache = createPlannerResponseCache();
    const plan = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, metrics: ["invoiceAmount"], groupBy: [], filters: [] };
    const inner = counting(() => ({ content: [{ type: "tool_use", id: "q", name: PLANNER_TOOL_NAME, input: { plan } }], stop_reason: "tool_use", usage: { input_tokens: 2900, output_tokens: 80 } }));
    const w = cache.wrap(inner, { tenantId: "T", settings: plannerRequestSettings });
    const a = await planQuestion("sales August 2025", { claudeClient: w });
    const b = await planQuestion("sales August 2025", { claudeClient: w });
    check("query-planner-usage", "query planner: first 1 call and its tokens; repeat 0 calls and 0 tokens, the same plan", a.status === "supported" && a.usage.calls === 1 && a.usage.input_tokens === 2900 && b.status === "supported" && b.usage.calls === 0 && b.usage.input_tokens === 0 && JSON.stringify(a.plan) === JSON.stringify(b.plan) && inner.calls === 1, JSON.stringify([a.usage, b.usage]));
    // analysis planner with its repair round: an invalid plan, then a valid one; the repeat replays BOTH without a call
    const REF = new Date(2025, 10, 15, 12);
    const OCT = { kind: "custom", from: "2025-10-01", to: "2025-10-31" };
    const bad = { v: 1, steps: [{ id: "m", kind: "insight", tool: "product_margin", args: { period: OCT, sortBy: "galaxy" } }] };
    const good = { v: 1, steps: [{ id: "s", kind: "query", plan: { v: 1, entity: "sales", mode: "aggregate", period: OCT, metrics: ["invoiceAmount"], groupBy: [], filters: [] } }] };
    const replies = [{ analysis: bad }, { analysis: good }];
    const am = counting((req) => ({ content: [{ type: "tool_use", id: `a${am.calls}`, name: req.tool_choice.name, input: replies[am.calls - 1] }], stop_reason: "tool_use", usage: { input_tokens: 4600, output_tokens: 300 } }));
    const aw = cache.wrap(am, { tenantId: "T", settings: plannerRequestSettings });
    const r1 = await planAnalysis("sales in October 2025", { claudeClient: aw, referenceDate: REF });
    const r2 = await planAnalysis("sales in October 2025", { claudeClient: aw, referenceDate: REF });
    check("analysis-repair", "analysis planner: invalid plan + repair = 2 calls; the repeat replays both from memory (0 calls, 0 tokens), same plan", r1.status === "supported" && r1.usage.calls === 2 && r2.status === "supported" && r2.usage.calls === 0 && r2.usage.input_tokens === 0 && am.calls === 2 && JSON.stringify(r1.analysis) === JSON.stringify(r2.analysis), JSON.stringify([r1.status, r1.usage, r2.status, r2.usage, am.calls]));
    const ev = await planAnalysis("sales in October 2025", { claudeClient: aw, referenceDate: REF, maxRepairs: 0, evidence: "Open: one breakdown. Findings: total fell." });
    check("investigation-key", "an investigation call (evidence attached) is a different request: a miss, never the plain plan", ev.usage.calls === 1 && am.calls === 3);
  }

  // ---------------------------------------------------------------------------------------------- 5. through the real chat turn
  const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");
  const DC = (ref) => ({ referenceDate: ref, source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 31), coverage: { earliest: new Date(2025, 0, 1), latest: new Date(2025, 11, 31), lastSyncedAt: null } });
  const REF = new Date(2026, 9, 28, 12);
  const sales = (p) => ({ v: 1, entity: "sales", mode: "aggregate", groupBy: [], filters: [], metrics: ["invoiceAmount"], ...p });
  const AUGPLAN = sales({ period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, filters: [{ dim: "customer", op: "eq_ci", value: "Synthetic Traders" }] });
  // the engine: computes the period from the plan and the turn's own reference date (as the real executor does)
  const engine = (log) => async (plan, ctx) => {
    log.push({ plan, referenceDate: ctx.referenceDate });
    const v = validateQueryPlan(plan, { referenceDate: ctx.referenceDate });
    const n = v.normalized;
    return { result: { ok: true, entity: plan.entity, mode: "aggregate", metrics: plan.metrics, groupBy: [], rows: [], truncated: false, warnings: [], assumptions: [], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, period: { kind: n.period.kind, from: n.period.from.toISOString(), to: n.period.to.toISOString(), label: n.period.label }, comparison: null, totals: { values: { invoiceAmount: 1000 } } }, cache: { status: "miss" } };
  };
  const knows = (names) => async ({ hintDim, text }) => ({ matches: names.includes(text) ? [{ dim: hintDim, value: text }] : [] });
  const turn = async ({ tenantId = "T-CHAT", question = "Synthetic Traders sales August 2025", model, cache, log = [], ref = REF, previousQuery = null, resolve = knows(["Synthetic Traders"]), execute, analysisEnabled }) => {
    const out = await tryAnswerWithQueryEngine({ context: { tenantId, userId: "u" }, userMessage: question, conversationHistory: previousQuery ? [{ role: "user", content: "(earlier)" }, { role: "assistant", content: "(answer)" }] : [], previousQuery, deps: { plannerClient: model, plannerResponseCache: cache, getFreshness: async () => ({ state: "fresh", message: "", dataAsOf: null }), getDateContext: async () => DC(ref), execute: execute || engine(log), resolveEntity: resolve, ...(analysisEnabled ? { analysisEnabled: true } : {}) } });
    return { s: out.structured, meta: out.structured && out.structured.details.queryEngine, tm: out.telemetry, queryContext: out.queryContext, log };
  };
  const scripted = (input) => counting((req) => ({ content: [{ type: "tool_use", id: "p", name: req.tool_choice.name, input: typeof input === "function" ? input(req) : input }], stop_reason: "tool_use", usage: { input_tokens: 2900, output_tokens: 60 } }));
  {
    const cache = createPlannerResponseCache();
    const model = scripted({ plan: AUGPLAN });
    const t1 = await turn({ model, cache });
    const t2 = await turn({ model, cache });
    check("chat-repeat", "the same question in a fresh chat: answered again, 0 model calls, the same text; the engine still ran", t1.meta.status === "answered" && t2.meta.status === "answered" && model.calls === 1 && t2.meta.claudeCalls === 0 && t2.s.answer === t1.s.answer && t1.log.length === 1 && t2.log.length === 1, JSON.stringify([t1.meta.claudeCalls, t2.meta.claudeCalls, model.calls]));
    const ev = buildTurnEvent({ metrics: t2.tm });
    check("chat-telemetry", "telemetry: hit counted apart, claudeCalls 0, no tokens, and no question text", ev.claudeCalls === 0 && ev.plannerCacheHits === 1 && ev.plannerCacheMisses === 0 && (ev.plannerInputTokens || 0) === 0 && !/Synthetic|August/i.test(JSON.stringify(ev)), JSON.stringify(ev));
    const ev1 = buildTurnEvent({ metrics: t1.tm });
    check("chat-telemetry-miss", "the first turn: one miss, one model call with its tokens", ev1.claudeCalls === 1 && ev1.plannerCacheMisses === 1 && ev1.plannerInputTokens === 2900, JSON.stringify(ev1));
    const other = await turn({ model, cache, tenantId: "T-OTHER" });
    check("chat-tenant", "another company asking the same words: its own model call", other.meta.status === "answered" && model.calls === 2);
    const gone = await turn({ model, cache, resolve: knows([]) });
    check("chat-names", "a remembered reply naming a customer the company no longer has: still refused by the name check, nothing run", gone.meta.status !== "answered" && gone.log.length === 0 && model.calls === 2, JSON.stringify(gone.meta));
  }
  {
    // midnight: "last month" is resolved by the server with each turn's own date, even when the reply is remembered
    const cache = createPlannerResponseCache();
    const model = scripted({ plan: sales({ period: { kind: "previous_month" } }) });
    const before = await turn({ model, cache, question: "sales last month", ref: new Date(2025, 9, 31, 23, 59, 50) });
    const after = await turn({ model, cache, question: "sales last month", ref: new Date(2025, 10, 1, 0, 0, 10) });
    const f = (t) => t.log[0] && new Date(t.log[0].referenceDate).getDate();
    check("chat-midnight", "across midnight the remembered plan is resolved to the new month: September before, October after, 1 model call", model.calls === 1 && f(before) === 31 && f(after) === 1 && /September 2025|2025-09-01/.test(before.s.answer) && /October 2025|2025-10-01/.test(after.s.answer), `${before.s.answer.split("\n")[0]} || ${after.s.answer.split("\n")[0]}`);
  }
  {
    // data version: the real answer cache still decides whether the engine runs; the planner cache never caches results
    const cache = createPlannerResponseCache();
    const model = scripted({ plan: AUGPLAN });
    const answers = createAnswerCache();
    let version = "v1", computed = 0;
    const log = [];
    const inner = engine(log);
    const execute = (plan, ctx) => answers.run(plan, ctx, { execute: async (p, c) => { computed += 1; return (await inner(p, c)).result; }, getVersion: async () => version });
    await turn({ model, cache, execute });
    await turn({ model, cache, execute });
    const sameVersion = computed;
    version = "v2";
    await turn({ model, cache, execute });
    check("chat-data-version", "same data: engine result from the answer cache; data changed: the engine runs again; the model was called once", sameVersion === 1 && computed === 2 && model.calls === 1, JSON.stringify({ sameVersion, computed, calls: model.calls }));
  }
  {
    // same-chat follow-up: the previous turn's plan is part of the request, so the first repeat in the same chat is a miss
    // (different request) and the next identical one is a hit - pinned so a change to this is a deliberate decision
    const cache = createPlannerResponseCache();
    const model = scripted({ plan: AUGPLAN });
    const t1 = await turn({ model, cache });
    const t2 = await turn({ model, cache, previousQuery: t1.queryContext });
    const t3 = await turn({ model, cache, previousQuery: t2.queryContext });
    check("chat-same-chat", "same chat: 1st ask = call, 2nd ask (now with the previous plan as context) = call, 3rd ask = remembered", model.calls === 2 && t2.meta.claudeCalls === 1 && t3.meta.claudeCalls === 0 && t3.meta.status === "answered", JSON.stringify([t1.meta.claudeCalls, t2.meta.claudeCalls, t3.meta.claudeCalls]));
  }
  {
    // the analysis path (query planner decline -> analysis planner -> investigation's model call) all go through the cache
    const cache = createPlannerResponseCache();
    const OCT = { kind: "custom", from: "2025-10-01", to: "2025-10-31" };
    const SEP = { kind: "custom", from: "2025-09-01", to: "2025-09-30" };
    const plan = { v: 1, steps: [{ id: "tot", kind: "query", plan: sales({ period: OCT, compare: { mode: "custom", period: SEP } }) }] };
    const model = scripted((req) => (req.tool_choice.name === PLANNER_TOOL_NAME ? { decline: { code: "needs_analysis", message: "several analyses" } } : /Evidence|evidence|Open/.test(JSON.stringify(req.messages)) ? { decline: { code: "not_a_data_query", message: "enough" } } : { analysis: plan, actions: true }));
    const cmpEngine = async (p, ctx) => {
      const v = validateQueryPlan(p, { referenceDate: ctx.referenceDate }).normalized;
      return { result: { ok: true, entity: "sales", mode: "aggregate", metrics: p.metrics, groupBy: [], rows: [], truncated: false, warnings: [], assumptions: [], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, period: { from: v.period.from.toISOString(), to: v.period.to.toISOString(), label: "October 2025" }, comparison: v.comparison ? { from: v.comparison.from.toISOString(), to: v.comparison.to.toISOString(), label: "September 2025" } : null, totals: { values: { invoiceAmount: 800 }, comparison: { invoiceAmount: { previous: 1000, delta: -200, deltaPct: -20 } } } }, cache: { status: "miss" } };
    };
    const q = "Why did sales fall in October 2025 and what should I do?";
    const a1 = await turn({ model, cache, question: q, execute: cmpEngine, analysisEnabled: true });
    const firstCalls = model.calls;
    const a2 = await turn({ model, cache, question: q, execute: cmpEngine, analysisEnabled: true });
    const kinds = model.requests.map((r) => (r.tool_choice.name === PLANNER_TOOL_NAME ? "query" : /Open|Evidence|evidence/.test(JSON.stringify(r.messages)) ? "investigation" : "analysis"));
    check("chat-analysis", "a 'why' turn: query planner + analysis planner (+ investigation) calls on the first ask; the repeat makes 0 calls and answers the same", a1.meta.status === "answered" && a2.meta.status === "answered" && firstCalls >= 2 && model.calls === firstCalls && a2.meta.claudeCalls === 0 && a1.meta.claudeCalls === firstCalls && a2.s.answer === a1.s.answer, JSON.stringify({ kinds, firstCalls, total: model.calls, m1: a1.meta.claudeCalls, m2: a2.meta.claudeCalls, s1: a1.meta.status }));
    check("chat-analysis-paths", "the first ask's calls went through the cache wrapper (misses = model calls)", buildTurnEvent({ metrics: a1.tm }).plannerCacheMisses === firstCalls && buildTurnEvent({ metrics: a2.tm }).plannerCacheHits === firstCalls, JSON.stringify([buildTurnEvent({ metrics: a1.tm }).plannerCacheMisses, buildTurnEvent({ metrics: a2.tm }).plannerCacheHits, kinds]));
    console.log(`  (info) first 'why' turn: ${firstCalls} model calls (${kinds.join(", ")}); repeat: 0`);
  }
  {
    // an injected test client without an injected cache is never cached (existing suites keep their scripted replies)
    const model = scripted({ plan: AUGPLAN });
    await turn({ model, cache: undefined });
    await turn({ model, cache: undefined });
    check("injected-client-uncached", "an injected client is not fronted by the shared cache", model.calls === 2);
  }

  console.log(`\nverify-planner-response-cache: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
