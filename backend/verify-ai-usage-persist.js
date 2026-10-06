"use strict";

/**
 * P0 persisted AI usage telemetry. Offline: the writer is replaced by an in-memory fake (and the Mongoose
 * model by a stub for the default-writer idempotency check) - no MongoDB, no Anthropic, no Tally, no network.
 * Run: node verify-ai-usage-persist.js
 */

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const telemetry = require("./src/services/query/turnTelemetry");
const usage = require("./src/services/query/usageStore");

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 300)})` : ""}`);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);
const tick = () => new Promise((r) => setImmediate(r));

const consoleLines = [];
telemetry.setTelemetrySink((l) => consoleLines.push(l));
const saved = [];
const realWriter = usage.setUsageWriter(async (rec) => { saved.push(rec); });

const base = { tenantId: "tenantA", requestId: "req-1", httpStatus: 200, totalMs: 120 };

(async () => {
  section("1-3. engine / planner / deterministic turns persist one record each");
  saved.length = 0;
  telemetry.emitChatTurn({ ...base, requestId: "r-engine", metrics: { path: "planner", engineRan: true, claudeCalls: 0 } });
  telemetry.emitChatTurn({ ...base, requestId: "r-planner", metrics: { path: "planner", engineRan: true, plannerAttempts: 1, plannerInputTokens: 2400, plannerOutputTokens: 210, plannerCacheReadTokens: 2000, plannerCacheCreationTokens: 0, plannerLatencyMs: 900 } });
  telemetry.emitChatTurn({ ...base, requestId: "r-deterministic", metrics: { path: "coverage_refused" } });
  await tick();
  const by = Object.fromEntries(saved.map((r) => [r.requestId, r]));
  check("3 turns -> 3 records", saved.length === 3, saved.length);
  check("engine turn: aiPath engine, zero Claude, no provider/model", by["r-engine"].aiPath === "engine" && by["r-engine"].claudeCalls === 0 && by["r-engine"].provider === null && by["r-engine"].plannerModel === null);
  check("planner turn: aiPath planner, 1 call", by["r-planner"].aiPath === "planner" && by["r-planner"].claudeCalls === 1 && by["r-planner"].plannerCalls === 1);
  check("no-engine/no-Claude turn: deterministic", by["r-deterministic"].aiPath === "deterministic");

  section("4-5. planner token fields recorded");
  saved.length = 0;
  telemetry.emitChatTurn({ ...base, requestId: "r-both", metrics: { path: "planner", plannerAttempts: 1, plannerInputTokens: 100, plannerOutputTokens: 10, plannerCacheReadTokens: 50, plannerCacheCreationTokens: 5, plannerLatencyMs: 800 } });
  await tick();
  const b = saved[0];
  check("aiPath planner, one planner call", b.aiPath === "planner" && b.claudeCalls === 1 && b.plannerCalls === 1);
  check("input/output/cache tokens equal the planner's", b.inputTokens === 100 && b.outputTokens === 10 && b.cacheReadTokens === 50 && b.cacheWriteTokens === 5);
  check("planner tokens kept per stage", b.plannerInputTokens === 100 && b.plannerCacheWriteTokens === 5);
  check("latencies recorded", b.plannerLatencyMs === 800 && b.totalLatencyMs === 120);

  section("6-8. request id, model/provider, retry, cost");
  check("request id and tenant recorded", b.requestId === "r-both" && b.tenantId === "tenantA");
  check("provider anthropic; planner model recorded", b.provider === "anthropic" && b.plannerModel === usage.plannerModel() && /^claude-/.test(b.plannerModel));
  check("retry count honestly null (SDK-internal retries are not observable)", b.retryCount === null);
  check("cost not invented: estimatedCostUsd null", b.estimatedCostUsd === null);
  {
    const src = (f) => fs.readFileSync(path.join(__dirname, "src/services", f), "utf8");
    const dm = (s) => (/const DEFAULT_(?:PLANNER_)?MODEL = "([^"]+)"/.exec(s) || [])[1];
    check("default model constant matches planner.js (no drift)", !!dm(src("query/planner.js")) && dm(src("query/planner.js")) === (/DEFAULT_MODEL = "([^"]+)"/.exec(src("query/usageStore.js")) || [])[1]);
    check("the planner call site still resolves its model with the mirrored env precedence", /ANTHROPIC_PLANNER_MODEL \|\| process\.env\.ANTHROPIC_MODEL \|\| DEFAULT_PLANNER_MODEL/.test(src("query/planner.js")));
  }

  section("6b. no legacy or router fields exist on the record");
  saved.length = 0;
  telemetry.emitChatTurn({ ...base, requestId: "r-route", metrics: { path: "planner", legacyReason: "exception", routeCode: "x" } });
  await tick();
  check("legacy and router fields are not part of the record, whatever the event carried", !("legacyReason" in saved[0]) && !("legacyCalls" in saved[0]) && !("legacyModel" in saved[0]) && !("routeCode" in saved[0]));

  section("9. failed turns record safely");
  saved.length = 0;
  telemetry.emitChatTurn({ ...base, requestId: "r-fail", httpStatus: 503, metrics: { path: "planner_failed", plannerAttempts: 2, plannerStatus: "planner_failed", plannerCode: "planner_timeout" } });
  telemetry.emitChatTurn({ ...base, requestId: "r-500", httpStatus: 500, metrics: {} });
  telemetry.emitChatTurn({ ...base, requestId: "r-abort", httpStatus: 499, clientAborted: true, metrics: { plannerAttempts: 1 } });
  await tick();
  check("failure: ok false, category = the machine code", saved[0].ok === false && saved[0].httpStatus === 503 && saved[0].failureCategory === "planner_timeout" && saved[0].claudeCalls === 2);
  check("bare 500 -> http_500", saved[1].failureCategory === "http_500");
  check("client abort -> client_aborted", saved[2].failureCategory === "client_aborted");

  section("10. persistence failure never breaks the turn");
  {
    const prevWriter = usage.setUsageWriter(async () => { throw new Error("mongo down: secret connection string"); });
    const errs = [];
    const prevErr = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    let threw = false;
    try { telemetry.emitChatTurn({ ...base, metrics: { path: "planner" } }); } catch (e) { threw = true; }
    usage.setUsageWriter(() => { throw new Error("sync throw"); });
    try { telemetry.emitChatTurn({ ...base, metrics: { path: "planner" } }); } catch (e) { threw = true; }
    await tick();
    console.error = prevErr;
    usage.setUsageWriter(prevWriter);
    check("emitChatTurn does not throw when the writer rejects or throws", !threw);
    check("the failure is logged safely (error name only, not the message)", errs.length === 2 && errs.every((l) => /AI USAGE PERSIST ERROR: Error$/.test(l)) && !errs.join("").includes("secret"), errs.join("|"));
    check("the console telemetry line still went out", consoleLines.length > 0);
    const t0 = process.hrtime.bigint();
    usage.setUsageWriter(() => new Promise(() => {})); // a write that never finishes
    telemetry.emitChatTurn({ ...base, metrics: { path: "planner" } });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    usage.setUsageWriter(prevWriter);
    check("a hanging write does not block the turn (emit returns immediately)", ms < 25, ms.toFixed(2) + "ms");
  }
  check("disconnected Mongo: the default writer drops silently (no buffering hang)", mongoose.connection.readyState !== 1 && (await realWriter({ requestId: "x" })) === undefined);

  section("11. sensitive fields are never persisted");
  {
    saved.length = 0;
    telemetry.emitChatTurn({
      ...base,
      requestId: "r-sens",
      metrics: { path: "planner", question: "sales of ACME PVT LTD ₹1,23,456", prompt: "SYSTEM", apiKey: "sk-ant-xxx", authorization: "Bearer abc", toolResults: [{ customer: "ACME", amount: 99 }], answer: "ACME owes 99", history: ["x"], plannerCode: "ACME Corp 5000" },
    });
    await tick();
    const r = saved[0];
    const json = JSON.stringify(r);
    const ALLOWED = Object.keys(require("./src/models/aiTurnUsage.model").schema.paths).filter((k) => k !== "_id");
    check("only schema (allow-listed) fields appear", Object.keys(r).every((k) => ALLOWED.includes(k)), Object.keys(r).filter((k) => !ALLOWED.includes(k)).join());
    check("no question/prompt/key/auth/tool results/answer/history/raw text", !/ACME|sk-ant|Bearer|SYSTEM|99|history|123/.test(json.replace(/"(inputTokens|outputTokens)":\d+/g, "")), json.slice(0, 200));
    check("a free-text value in a code field is replaced, never stored", r.failureCategory === "invalid_code" || r.failureCategory === null || !/ACME/.test(String(r.failureCategory)));
    check("no field is an object/array except ts", Object.entries(r).every(([k, v]) => k === "ts" || v === null || typeof v !== "object"));
  }

  section("12. one turn -> one record (idempotent on requestId)");
  {
    const store = new Map();
    const calls = { updateOne: 0, create: 0 };
    const modelPath = require.resolve("./src/models/aiTurnUsage.model");
    require.cache[modelPath] = { id: modelPath, filename: modelPath, loaded: true, exports: {
      updateOne: async (filter, update) => { calls.updateOne += 1; if (!store.has(filter.requestId)) store.set(filter.requestId, update.$setOnInsert); },
      create: async (rec) => { calls.create += 1; store.set(`anon${calls.create}`, rec); },
    } };
    const realState = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
    Object.defineProperty(mongoose.connection, "readyState", { get: () => 1, configurable: true });
    delete require.cache[require.resolve("./src/services/query/usageStore")];
    const fresh = require("./src/services/query/usageStore");
    fresh.persistTurnUsage(telemetry.buildTurnEvent({ tenantId: "tenantA", requestId: "dup-1", metrics: { path: "planner", plannerAttempts: 1 } }));
    fresh.persistTurnUsage(telemetry.buildTurnEvent({ tenantId: "tenantA", requestId: "dup-1", metrics: { path: "planner", plannerAttempts: 1 } }));
    fresh.persistTurnUsage(telemetry.buildTurnEvent({ tenantId: "tenantA", requestId: null, metrics: { path: "planner" } }));
    await tick(); await tick();
    check("same requestId written twice -> one stored record (upsert $setOnInsert)", [...store.keys()].filter((k) => k === "dup-1").length === 1 && calls.updateOne === 2);
    check("no request id -> plain insert", calls.create === 1);
    check("the model carries a partial-unique index on requestId", require("fs").readFileSync(path.join(__dirname, "src/models/aiTurnUsage.model.js"), "utf8").includes("partialFilterExpression"));
    if (realState) Object.defineProperty(mongoose.connection, "readyState", realState); else delete mongoose.connection.readyState;
  }

  section("kill switch");
  {
    saved.length = 0;
    process.env.AI_USAGE_PERSIST = "off";
    telemetry.emitChatTurn({ ...base, metrics: { path: "planner" } });
    await tick();
    delete process.env.AI_USAGE_PERSIST;
    check("AI_USAGE_PERSIST=off persists nothing", saved.length === 0);
  }

  console.log(`\nverify-ai-usage-persist: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
