"use strict";

/**
 * P1-1: per-turn AI/query telemetry (`tallypulse.ai.turn`).
 *
 * Fakes only: no MongoDB connection, no Anthropic, no Tally, no network. The controller tests stub the
 * Chat model, the date context and freshness in require.cache, so nothing is read or written anywhere.
 * Run: node verify-ai-telemetry.js
 */

const http = require("http");
const https = require("https");

let netCalls = 0;
const savedNet = { fetch: global.fetch, h: http.request, s: https.request };
global.fetch = async () => { netCalls += 1; throw new Error("network disabled in this test"); };
http.request = () => { netCalls += 1; throw new Error("network disabled in this test"); };
https.request = () => { netCalls += 1; throw new Error("network disabled in this test"); };

const telemetry = require("./src/services/query/turnTelemetry");
const { tryAnswerWithQueryEngine: realTryAnswer } = require("./src/services/query/queryChat");
// P-SF: the engine now reads ONE tenant date context per turn. Synthetic (fake-resolver) turns have no database,
// so they get a fixed one (latest voucher 2025-12-08 = the fake freshness date; history from 2024-04-01).
const { buildDateContext } = require("./src/services/analytics/referenceDate");
const SYNTH_DATES = buildDateContext({ sales: { earliest: new Date(2024, 3, 1), latest: new Date(2025, 11, 8) }, purchase: { earliest: new Date(2024, 3, 1), latest: new Date(2025, 11, 8) } }, new Date(2025, 11, 8, 18));
const tryAnswerWithQueryEngine = (a) => realTryAnswer(a && a.deps && a.deps.resolveEntity && !a.deps.getDateContext ? { ...a, deps: { ...a.deps, getDateContext: async () => SYNTH_DATES } } : a);
const { createEntityResolver } = require("./src/services/query/entityResolver");
const { createAnswerCache } = require("./src/services/query/answerCache");
const { PLANNER_TOOL_NAME } = require("./src/services/query/planner");

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail ? ` (${detail})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- every emitted line is captured (and later scanned for leaks)
const emitted = [];
telemetry.setTelemetrySink((line) => emitted.push(line));
const lastEvent = () => JSON.parse(emitted[emitted.length - 1]);

// ---- fakes
const NAMES = { customer: ["Dhingra General Store"], supplier: ["Acme Foods Pvt Ltd"], product: ["Maggi Noodles"], productGroup: ["Snacks"] };
const sources = (failDim) => Object.fromEntries(Object.entries(NAMES).map(([d, v]) => [d, async () => { await sleep(2); if (d === failDim) throw new Error("MongoNetworkError: secret-host:27017"); return v; }]));
const resolver = () => createEntityResolver({ tenantId: "TEST-TENANT", sources: sources() });
const fresh = async () => ({ state: "fresh", dataAsOf: new Date("2025-12-08T10:00:00Z"), message: "Data is current." });
const okResult = (plan) => ({ ok: true, entity: plan.entity, mode: "aggregate", period: { kind: plan.period.kind, label: "Previous month (complete)", isPartial: false }, comparison: null, metrics: plan.metrics, groupBy: [], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, rows: [], totals: { values: { invoiceAmount: 1234567.5, invoiceCount: 42 } }, truncated: false, rowLimit: 10, warnings: [], assumptions: [] });
// Production-shaped executor: a real answer cache whose engine call is timed exactly like the production wiring.
function cachedExecutor(engineMs = 12, result = okResult) {
  const cache = createAnswerCache();
  const engine = async (plan) => { engine.calls += 1; await sleep(engineMs); return typeof result === "function" ? result(plan) : result; };
  engine.calls = 0;
  const exec = (plan, ctx, timing) => cache.run(plan, ctx, telemetry.timeEngineDeps({ execute: engine, getVersion: async () => "v1" }, timing));
  exec.engine = engine;
  return exec;
}
function fakePlanner(input, { delay = 15, usage = { input_tokens: 440, output_tokens: 190, cache_read_input_tokens: 2694, cache_creation_input_tokens: 0 } } = {}) {
  const fn = async () => { fn.calls += 1; await sleep(delay); if (input instanceof Error) throw input; return { content: [{ type: "tool_use", id: "t1", name: PLANNER_TOOL_NAME, input }], usage }; };
  fn.calls = 0;
  return fn;
}
const forbiddenPlanner = async () => { throw new Error("Claude must NOT be called"); };
const NAME_FILTER = [{ dim: "customer", op: "eq_ci", value: "Dhingra General Store" }];
const planOf = (o) => ({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "previous_month" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [], ...o });
const CTX = { tenantId: "TEST-TENANT" };
// every turn is also emitted (exactly as the controller would), so the privacy scan in J covers all of them
const ask = async (q, deps = {}, history = []) => {
  const r = await tryAnswerWithQueryEngine({ context: CTX, userMessage: q, conversationHistory: history, deps: { resolveEntity: resolver(), getFreshness: fresh, plannerClient: fakePlanner({ plan: planOf({}) }), ...deps } });
  telemetry.emitChatTurn({ tenantId: CTX.tenantId, metrics: r.telemetry, totalMs: 1, httpStatus: 200 });
  return r;
};
// what the controller would emit for this turn (same helper the controller uses)
const emitFor = (r, extra = {}) => { telemetry.emitChatTurn({ tenantId: CTX.tenantId, metrics: r.telemetry, totalMs: 5, httpStatus: 200, ...extra }); return lastEvent(); };

(async () => {
  section("A. a question answered through the planner and the engine");
  {
    const exec = cachedExecutor(12);
    const p = fakePlanner({ plan: planOf({ metrics: ["invoiceAmount"], filters: NAME_FILTER }) }, { delay: 20 });
    const r = await ask("Sales from Dhingra General Store last month", { execute: exec, plannerClient: p });
    const t = r.telemetry;
    check("result shape unchanged: telemetry is not an enumerable key", JSON.stringify(Object.keys(r)) === JSON.stringify(["handled", "structured"]) && r.handled === true);
    check("path planner, route planner, exactly 1 Claude call (the planner), deterministic answer", t.path === "planner" && t.route === "planner" && t.claudeCalls === 1 && t.claudeReason === "planner" && t.plannerStatus === "supported" && t.answerSource === "deterministic" && t.outcome === "answered" && p.calls === 1);
    check("planner latency >= the planner's own 20ms; attempts 1", t.plannerLatencyMs >= 18 && t.plannerAttempts === 1, JSON.stringify(t));
    check("tokens come from the usage the client already returned", t.plannerInputTokens === 440 && t.plannerOutputTokens === 190 && t.plannerCacheReadTokens === 2694 && t.plannerCacheCreationTokens === 0);
    check("engine timing present and real (>= the engine's own 12ms)", t.engineRan === true && t.engineLatencyMs >= 10 && t.executeMs >= t.engineLatencyMs && t.engineStatus === "ok" && t.engineErrorCode === null, JSON.stringify(t));
    check("resolver recorded: the planner's name re-check is counted, timed, ok", t.resolverCalled === true && t.resolverCalls === 1 && t.resolverLatencyMs > 0 && t.resolverStatus === "ok", String(t.resolverCalls));
    check("no router fields exist on the turn", !("routeStatus" in t) && !("routeCode" in t));
    check("freshness + query-engine time recorded", t.freshnessStatus === "fresh" && t.queryEngineMs >= t.executeMs);
    const e = emitFor(r);
    check("emitted event: tallypulse.ai.turn with tenantId and planner token fields", e.event === "tallypulse.ai.turn" && e.tenantId === "TEST-TENANT" && e.plannerInputTokens === 440 && e.plannerCacheReadTokens === 2694 && e.claudeCalls === 1 && !("legacyClaudeCalls" in e) && !("legacyReason" in e) && e.ok === true && e.totalLatencyMs === 5 && !("routeCode" in e) && !("routeStatus" in e));
    const r2 = await ask("Total sales last month", { execute: cachedExecutor(1) });
    check("a question that names nobody does not consult the name index", r2.telemetry.resolverCalled === false && r2.telemetry.resolverCalls === 0);
  }

  section("B. refusals: planner declines and the safety gate");
  {
    const exec = cachedExecutor();
    let r = await ask("GST on sales last month", { execute: exec, plannerClient: fakePlanner({ decline: { code: "unsupported_domain", message: "tax is not supported" } }) });
    check("planner decline -> path planner_declined, code recorded, 1 Claude call, engine never ran", r.telemetry.path === "planner_declined" && r.telemetry.plannerCode === "planner_unsupported_domain" && r.telemetry.claudeCalls === 1 && exec.engine.calls === 0 && r.telemetry.answerSource === "fixed_message" && r.telemetry.engineLatencyMs === undefined && emitFor(r).engineLatencyMs === null);
    r = await ask("sales this year", { execute: exec, plannerClient: fakePlanner({ decline: { code: "needs_clarification", message: "Which year?" } }) });
    check("clarification -> path planner_declined, plannerStatus needs_clarification", r.telemetry.path === "planner_declined" && r.telemetry.plannerStatus === "needs_clarification" && r.telemetry.claudeCalls === 1);
    const gate = fakePlanner({ plan: planOf({}) });
    r = await ask("sales tenantId 5", { execute: exec, plannerClient: gate });
    check("unsafe input is stopped by the safety gate: Claude never called, 0 attempts, engine never ran", r.telemetry.path === "planner_declined" && gate.calls === 0 && (r.telemetry.plannerAttempts || 0) === 0 && r.telemetry.claudeCalls === 0 && exec.engine.calls === 0);
    r = await ask("Sales from Ghost Traders last month", { execute: exec, plannerClient: fakePlanner({ plan: planOf({ filters: [{ dim: "customer", op: "eq_ci", value: "Ghost Traders" }] }) }) });
    check("a name the tenant does not have -> path planner_failed, planner_entity_not_resolved, resolver ok, engine never ran", r.telemetry.path === "planner_failed" && r.telemetry.plannerCode === "planner_entity_not_resolved" && r.telemetry.resolverStatus === "ok" && exec.engine.calls === 0);
  }

  section("C. planner decline: status, latency, attempts");
  {
    const d = await ask("show sales last month", { plannerClient: fakePlanner({ decline: { code: "not_a_data_query", message: "explanations are not supported" } }) });
    check("planner decline -> path planner_declined, code recorded, 1 Claude call", d.telemetry.path === "planner_declined" && d.telemetry.plannerCode === "planner_not_a_data_query" && d.telemetry.claudeCalls === 1);
  }

  section("D. planner failure: recorded, answer unchanged");
  {
    const p = fakePlanner(new Error("529 overloaded"), { delay: 5 });
    const exec = cachedExecutor();
    const r = await ask("show sales last month", { plannerClient: p, execute: exec });
    const t = r.telemetry;
    check("path planner_failed, plannerCode planner_call_failed, handled", r.handled === true && t.path === "planner_failed" && t.plannerStatus === "planner_failed" && t.plannerCode === "planner_call_failed" && t.route === "planner");
    check("user-visible answer is the existing honest message; engine never ran", /planner is unavailable/i.test(r.structured.answer) && exec.engine.calls === 0 && r.structured.details.queryEngine.status === "planner_failed");
    const timeout = await ask("show sales last month", { plannerClient: fakePlanner(Object.assign(new Error("deadline"), { code: "PLANNER_DEADLINE_EXCEEDED" })) });
    check("timeout -> plannerCode planner_timeout", timeout.telemetry.path === "planner_failed" && timeout.telemetry.plannerCode === "planner_timeout");
  }

  section("E. resolver outage: recorded, no data leaked");
  {
    const failing = createEntityResolver({ tenantId: "TEST-TENANT", sources: sources("customer") });
    const r = await ask("Sales from Dhingra General Store last month", { resolveEntity: failing, plannerClient: fakePlanner({ plan: planOf({ filters: NAME_FILTER }) }) });
    const t = r.telemetry;
    check("path planner_failed (planner_entity_check_failed), resolverStatus unavailable, resolver timed, handled", r.handled === true && t.path === "planner_failed" && t.plannerCode === "planner_entity_check_failed" && t.resolverStatus === "unavailable" && t.resolverCalled === true && t.resolverLatencyMs > 0);
    check("P0-1 answer unchanged ('try again'), engine never ran", /try again/i.test(r.structured.answer) && r.structured.details.queryEngine.status === "planner_failed");
    const line = JSON.stringify(emitFor(r));
    check("event carries no name and no DB detail", !/Dhingra|General Store|Mongo|secret-host/i.test(line));
    const mid = await ask("Sales from Dhingra General Store last month", { resolveEntity: createEntityResolver({ tenantId: "TEST-TENANT", sources: sources("customer") }), plannerClient: fakePlanner({ plan: planOf({ filters: NAME_FILTER }) }) }, [{ role: "user", content: "hi" }]);
    check("mid-conversation outage: still planner_failed", mid.handled === true && mid.telemetry.path === "planner_failed");
  }

  section("F/G. answer cache: miss then hit (the planner is still called on a hit)");
  {
    const exec = cachedExecutor(15);
    const q = "Sales from Dhingra General Store last month";
    const p = fakePlanner({ plan: planOf({ filters: NAME_FILTER }) });
    const miss = await ask(q, { execute: exec, plannerClient: p });
    check("G. first run: answerCache miss, hit=false, stored, engine ran (timed)", miss.telemetry.answerCache === "miss" && miss.telemetry.answerCacheHit === false && miss.telemetry.answerCacheStored === true && miss.telemetry.engineRan === true && miss.telemetry.engineLatencyMs >= 13);
    check("   lookup time measured up to the engine start (small, >= 0)", miss.telemetry.answerCacheLookupMs >= 0 && miss.telemetry.answerCacheLookupMs < miss.telemetry.executeMs);
    const hit = await ask(q, { execute: exec, plannerClient: p });
    check("F. second run: answerCache hit, engine NOT run, engineLatencyMs null", hit.telemetry.answerCache === "hit" && hit.telemetry.answerCacheHit === true && hit.telemetry.engineRan === false && hit.telemetry.engineLatencyMs === null && exec.engine.calls === 1);
    check("   the cache saves the engine, not the planner: a hit still costs one planner call", p.calls === 2 && hit.telemetry.claudeCalls === 1);
    check("   hit lookup time = the whole (fast) cache call", hit.telemetry.answerCacheLookupMs === hit.telemetry.executeMs && hit.telemetry.executeMs < miss.telemetry.engineLatencyMs);
    check("   same user-visible answer on hit and miss", hit.structured.answer === miss.structured.answer);
    const failing = await ask("Total sales last month", { execute: cachedExecutor(1, { ok: false, errors: [{ code: "query_timeout" }] }) });
    check("engine failure: engineStatus failed + engineErrorCode recorded (answer unchanged)", failing.telemetry.engineStatus === "failed" && failing.telemetry.engineErrorCode === "query_timeout" && /took too long/.test(failing.structured.answer));
    const injected = await ask("Total sales last month", { execute: async (plan) => ({ result: okResult(plan), cache: { status: "miss" } }) });
    check("an executor that does not report engine timing -> engineLatencyMs null (never invented)", injected.telemetry.engineLatencyMs === null && injected.telemetry.engineRan === null && Number.isFinite(injected.telemetry.executeMs));
  }

  section("H/I. controller: one event per AI turn; telemetry failure never breaks the turn");
  {
    // stubs: no DB, no Claude
    const chatPath = require.resolve("./src/models/chat.model");
    const saved = [];
    class FakeChat {
      constructor(o) { Object.assign(this, o); this._id = `chat${saved.length + 1}`; this.messages = o.messages || []; }
      async save() { saved.push(this); return this; }
      static async findOne() { return null; }
    }
    require.cache[chatPath] = { id: chatPath, filename: chatPath, loaded: true, exports: FakeChat };
    // no database here: the controller's per-turn tenant date context comes from the same fixed synthetic one
    const refPath = require.resolve("./src/services/analytics/referenceDate");
    require.cache[refPath] = { id: refPath, filename: refPath, loaded: true, exports: { ...require(refPath), getTenantDateContext: async () => SYNTH_DATES } };
    // the planner path reads freshness BEFORE its call: also synthetic here (no database)
    const freshPath = require.resolve("./src/services/analytics/freshness");
    require.cache[freshPath] = { id: freshPath, filename: freshPath, loaded: true, exports: { ...require(freshPath), getFreshness: fresh } };
    delete require.cache[require.resolve("./src/controllers/chatController")];
    const { sendChatMessage } = require("./src/controllers/chatController");
    const mkRes = () => { const r = { code: 0, body: null, on() { return r; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
    const send = async (message) => {
      const res = mkRes();
      await sendChatMessage({ body: { message }, params: {}, user: { id: "u1" }, companyContext: { tenantId: "TEST-TENANT", companyGuid: "guid-1" } }, res);
      return res;
    };
    // the real planner client has no API key here (and the network is poisoned): the planner is unreachable
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      let n = emitted.length;
      let res = await send("GST on sales last month");
      let e = JSON.parse(emitted[emitted.length - 1]);
      check("H. planner unreachable: 200 with an honest answer, exactly ONE event, path planner_failed, no network call", res.code === 200 && emitted.length === n + 1 && e.path === "planner_failed" && e.httpStatus === 200 && e.ok === true && e.totalLatencyMs >= 0 && netCalls === 0);
      check("   the answer is the fixed planner-unavailable message and the turn is saved", /planner is unavailable|couldn't turn this question/i.test(res.body.data.answer) && saved.length >= 1);

      // validation errors are not AI turns: no event
      n = emitted.length;
      res = await send("");
      check("empty message: 400 unchanged, no event (not an AI turn)", res.code === 400 && emitted.length === n);

      // I. the logger throws -> the turn still succeeds with the same answer
      const prevSink = telemetry.setTelemetrySink(() => { throw new Error("log transport down"); });
      const prevErr = console.error;
      let errLines = 0;
      console.error = () => { errLines += 1; throw new Error("stderr down too"); };
      try {
        res = await send("GST on sales last month");
        check("I. sink AND console.error throw: request still 200 with the normal answer", res.code === 200 && /planner is unavailable|couldn't turn this question/i.test(res.body.data.answer) && errLines === 1);
      } finally {
        console.error = prevErr;
        telemetry.setTelemetrySink(prevSink);
      }
      let threw = false;
      try { telemetry.emitChatTurn(null); telemetry.emitTurnEvent({ tenantId: {}, metrics: { get path() { throw new Error("x"); } } }); } catch (err) { threw = true; }
      check("I. emit helpers never throw, whatever they are given", !threw);
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
      delete require.cache[chatPath];
      delete require.cache[require.resolve("./src/services/analytics/freshness")];
    }
  }
  section("J. privacy: allow-listed fields, codes only - no question, names, plan, answer or prompt");
  {
    const lines = emitted.join("\n");
    const forbidden = [
      "Sales from Dhingra", "show sales", "GST on sales", "Dhingra", "General Store", "Maggi", "Acme", "Snacks", "Ghost Traders",
      "invoiceAmount", "lineAmount", "previous_month", "filters", "eq_ci", // plan contents
      "₹", "Invoice amount", "planner is unavailable", "try again", // answers
      "get_sales_summary", "tool_use", "submit_query_plan", "overloaded", "Mongo", "secret-host", "guid-1", "u1\"", // prompt/tools/errors/ids
    ];
    const leaks = forbidden.filter((w) => lines.includes(w));
    check(`no forbidden text in any of the ${emitted.length} emitted events`, emitted.length >= 20 && leaks.length === 0, leaks.join(", "));
    const keys = Object.keys(JSON.parse(emitted[0])).sort().join();
    check("every event has exactly the same allow-listed key set", emitted.every((l) => Object.keys(JSON.parse(l)).sort().join() === keys));
    const hostile = telemetry.buildTurnEvent({ tenantId: "TEST-TENANT", metrics: { path: "Sales from Dhingra General Store", plannerStatus: "DROP TABLE; ₹5", plannerCode: "planner_x\nsecret", question: "raw question", plan: { filters: ["Dhingra"] }, answer: "₹1", claudeCalls: "7", plannerLatencyMs: -3, answerCacheHit: "yes" } });
    const hs = JSON.stringify(hostile);
    check("free text in a code field is replaced by 'invalid_code'", hostile.path === "invalid_code" && hostile.plannerStatus === "invalid_code" && hostile.plannerCode === "invalid_code");
    check("unknown fields (question/plan/answer) are dropped; wrong types become null", !("question" in hostile) && !("plan" in hostile) && !("answer" in hostile) && hostile.claudeCalls === null && hostile.plannerLatencyMs === null && hostile.answerCacheHit === null && !/Dhingra|raw question|₹/.test(hs));
    check("a non-id tenantId is not echoed", telemetry.buildTurnEvent({ tenantId: "Dhingra General Store ₹", metrics: {} }).tenantId === null);
    // P0 cost-forensics (Phase 8): requestId correlates a turn event to the X-Request-Id response header,
    // so a specific network request can be matched to its exact Claude-cost decision.
    check("requestId is echoed when it is a real id", telemetry.buildTurnEvent({ tenantId: "TEST-TENANT", requestId: "abc123-def-456", metrics: {} }).requestId === "abc123-def-456");
    check("a hostile/free-text requestId is dropped to null, never echoed raw", telemetry.buildTurnEvent({ tenantId: "TEST-TENANT", requestId: "some raw user text ₹5\nsecret", metrics: {} }).requestId === null);
    check("requestId is part of every event's allow-listed key set", "requestId" in hostile);
    check("no question hash / identifier field exists", !/question|hash|message|prompt|history/i.test(keys));
    const src = require("fs").readFileSync(require.resolve("./src/services/query/turnTelemetry"), "utf8");
    check("telemetry module has no DB / network / Claude access", !/require\(["'](?:mongoose|http|https|@anthropic-ai\/sdk)["']\)|\.aggregate\(|\.find\(/.test(src));
    const ac = require("fs").readFileSync(require.resolve("./src/services/query/answerCache"), "utf8");
    check("production cached executor passes the engine timing hook (cache logic untouched)", /timeEngineDeps\(deps, timing\)/.test(ac));
  }

  section("K. no network was used");
  check("zero fetch/http calls (no Anthropic, no Tally)", netCalls === 0, String(netCalls));
  Object.assign(global, { fetch: savedNet.fetch });
  http.request = savedNet.h;
  https.request = savedNet.s;

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
