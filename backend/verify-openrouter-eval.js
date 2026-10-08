"use strict";

/**
 * The multi-model NLU evaluation (eval-nlu-models.js, eval/openRouterClient.js, eval/nluModelRunner.js, eval/nluScoring.js).
 * Offline and free: OpenRouter is a local stub HTTP server, the key is a fake, no Claude call is made, and nothing touches a
 * database or Tally. It proves: the OpenRouter request is built correctly and identically for every model, the key never leaks,
 * malformed / rejected / failed / timed-out answers are told apart, concurrency is bounded, scoring marks a plan that executes
 * but means the wrong thing as WRONG, the Claude baseline path is preserved, and production cannot reach OpenRouter.
 *
 * Run: node verify-openrouter-eval.js
 */

process.env.AI_USAGE_PERSIST = "off";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const { planQuestion, getPlannerPrompt, PLANNER_MAX_TOKENS, PLANNER_TOOL_NAME } = require("./src/services/query/planner");
const scoring = require("./eval/nluScoring");
const runner = require("./eval/nluModelRunner");
const or = require("./eval/openRouterClient");

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// built at runtime so no key-shaped literal exists in the source (secret scanners would flag one)
const FAKE_KEY = ["sk", "or", "v1", "FAKEKEYFORTESTSONLY0123456789abcdef"].join("-");
const rowById = (id) => scoring.corpus.rows.find((r) => r.id === id);
const resolver = scoring.makeResolver();

// ---------------------------------------------------------------------------------------------- local OpenRouter stub

function startStub(handler, { catalogue } = {}) {
  const stats = { chat: 0, models: 0, inFlight: 0, maxInFlight: 0, headers: [], bodies: [] };
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", async () => {
      if (req.method === "GET" && req.url.endsWith("/models")) {
        stats.models += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: catalogue || [] }));
        return;
      }
      stats.chat += 1;
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      stats.headers.push(req.headers);
      let body = {};
      try {
        body = JSON.parse(data || "{}");
      } catch (e) {
        /* leave empty */
      }
      stats.bodies.push(body);
      try {
        await handler(body, req, res, stats);
      } finally {
        stats.inFlight -= 1;
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ stats, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) })));
}

const reply = (res, status, obj, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
};
const completion = (message, extra = {}) => ({ id: "gen-1", model: "vendor/test-model", provider: "StubProvider", choices: [{ finish_reason: "stop", message: { role: "assistant", content: null, ...message } }], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 }, cost: 0 }, ...extra });
const toolReply = (input, name = PLANNER_TOOL_NAME) => completion({ tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(input) } }] }, { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(input) } }] } }] });
const goldenInput = (row) => (row.expected.status === "supported" && row.expected.plan ? { plan: row.expected.plan } : { decline: { code: row.expected.status === "clarify" ? "needs_clarification" : "unsupported_domain", message: "stub" } });

const makeClient = (baseUrl, extra = {}) => or.createOpenRouterPlannerClient({ evalOnly: true, model: "vendor/test-model", freeOnly: false, apiKey: FAKE_KEY, baseUrl, sleep: async () => {}, ...extra });

/** Run the production planner for a corpus row over a client; returns the planner result, the meta and the scored outcome. */
async function plan(row, client) {
  const meta = {};
  const planned = await planQuestion(row.question, { claudeClient: (request, options) => client(request, { ...options, meta }), resolveEntity: resolver, referenceDate: scoring.REF_DATE, maxRepairs: 0, ...(row.previousPlan ? { previousPlan: row.previousPlan } : {}) });
  return { planned, meta, scored: scoring.classifyPlanned(row, planned) };
}

async function capturedRequest(row) {
  let captured = null;
  await planQuestion(row.question, {
    claudeClient: async (request) => {
      captured = request;
      return { content: [{ type: "tool_use", name: PLANNER_TOOL_NAME, input: { decline: { code: "unsupported_domain" } } }], usage: {} };
    },
    resolveEntity: resolver,
    referenceDate: scoring.REF_DATE,
    maxRepairs: 0,
    ...(row.previousPlan ? { previousPlan: row.previousPlan } : {}),
  });
  return captured;
}

(async () => {
  // ------------------------------------------------------------------------------------------ A. request construction
  section("A. OpenRouter request construction (pure)");
  const fresh = rowById("nl_0001");
  const followUp = scoring.corpus.rows.find((r) => r.group === "follow_up");
  const reqFresh = await capturedRequest(fresh);
  const reqFollow = await capturedRequest(followUp);
  const cfg = { model: "vendor/model-a", structuredMode: "tool" };
  const bodyA = or.buildRequestBody(reqFresh, cfg);
  check("model, temperature 0, the planner's own max_tokens", bodyA.model === "vendor/model-a" && bodyA.temperature === 0 && bodyA.max_tokens === PLANNER_MAX_TOKENS);
  check("system prompt is the planner's catalogue prompt; the user message is exactly the question", bodyA.messages.length === 2 && bodyA.messages[0].role === "system" && bodyA.messages[0].content.includes("submit_query_plan") && bodyA.messages[1].role === "user" && bodyA.messages[1].content === fresh.question);
  check("the planner's tool schema is sent unchanged as a function and forced with tool_choice", eq(bodyA.tools[0].function.parameters, reqFresh.tools[0].input_schema) && bodyA.tools[0].function.name === PLANNER_TOOL_NAME && eq(bodyA.tool_choice, { type: "function", function: { name: PLANNER_TOOL_NAME } }));
  check("require_parameters keeps OpenRouter from silently dropping tools; usage accounting requested", bodyA.provider.require_parameters === true && bodyA.usage.include === true);
  check("no secret and no tenant/company/database field is in the body", !JSON.stringify(bodyA).includes(FAKE_KEY) && !/tenant|companyGuid|mongo/i.test(JSON.stringify(bodyA.messages[1])));
  const bodyB = or.buildRequestBody(reqFresh, { model: "other/model-b", structuredMode: "tool" });
  const strip = (b) => ({ ...b, model: undefined });
  check("every model gets exactly the same logical input (only the model id differs)", eq(strip(bodyA), strip(bodyB)));
  const bodyFollow = or.buildRequestBody(reqFollow, cfg);
  check("a follow-up row carries its previous structured plan in the user message, same as the planner builds it", bodyFollow.messages[1].content === reqFollow.messages[0].content && bodyFollow.messages[1].content.includes("Previous query plan") && bodyFollow.messages[1].content.includes(`Question: ${followUp.question}`));
  const bodyJson = or.buildRequestBody(reqFresh, { model: "vendor/model-a", structuredMode: "json_schema" });
  check("json_schema mode: no tools, the same schema as response_format, plus one output-format sentence", !bodyJson.tools && !bodyJson.tool_choice && eq(bodyJson.response_format.json_schema.schema, reqFresh.tools[0].input_schema) && bodyJson.messages[0].content === `${bodyA.messages[0].content}\n\n${or.FORMAT_INSTRUCTION}`);
  check("max_tokens can be overridden for reasoning models (and is recorded by describe())", or.buildRequestBody(reqFresh, { ...cfg, maxTokens: 2500 }).max_tokens === 2500 && makeClient("http://x/v1", { maxTokens: 2500 }).describe().maxTokens === 2500);
  let threw = null;
  try {
    or.buildRequestBody({ ...reqFresh, messages: [{ role: "user", content: [{ type: "tool_result" }] }] }, cfg);
  } catch (e) {
    threw = e.code;
  }
  check("repair-round (non-text) messages are refused: the evaluation uses none", threw === "OPENROUTER_BAD_REQUEST", threw);
  let guard = null;
  try {
    or.createOpenRouterPlannerClient({ model: "vendor/test-model:free" });
  } catch (e) {
    guard = e.code;
  }
  check("the client cannot be built without evalOnly: true", guard === "OPENROUTER_EVAL_ONLY", guard);
  let badModel = null;
  try {
    or.createOpenRouterPlannerClient({ evalOnly: true, model: "no-vendor-prefix:free" });
  } catch (e) {
    badModel = e.code;
  }
  check("a model id must look like vendor/model", badModel === "OPENROUTER_BAD_MODEL", badModel);

  // ------------------------------------------------------------------------------------------ B. response mapping
  section("B. response mapping and strict structured-output handling (pure)");
  const toolCfg = { structuredMode: "tool" };
  const jsonCfg = { structuredMode: "json_schema" };
  const m1 = {};
  const reply1 = toolReply({ plan: fresh.expected.plan });
  reply1.usage.cost = 0.0001;
  const r1 = or.parseCompletion(reply1, reqFresh, toolCfg, m1);
  check("a tool call becomes one tool_use block with the parsed input", r1.content.length === 1 && r1.content[0].type === "tool_use" && r1.content[0].name === PLANNER_TOOL_NAME && eq(r1.content[0].input, { plan: fresh.expected.plan }));
  check("usage: cached prompt tokens are separated (input excludes cache reads), output and reported cost are kept", eq(r1.usage, { input_tokens: 600, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 }) && m1.cost === 0.0001 && m1.servedModel === "vendor/test-model" && m1.providerName === "StubProvider");
  const mBad = {};
  const rBad = or.parseCompletion(completion({ tool_calls: [{ id: "c", type: "function", function: { name: PLANNER_TOOL_NAME, arguments: "{not json" } }] }), reqFresh, toolCfg, mBad);
  check("tool arguments that are not JSON -> no tool_use, reason recorded (malformed, never repaired)", !rBad.content.some((b) => b.type === "tool_use") && mBad.malformedReason === "tool_arguments_not_a_json_object");
  const rProse = or.parseCompletion(completion({ content: "Sure! Total sales for August are about 5 lakh." }), reqFresh, toolCfg, {});
  check("prose instead of a tool call is never turned into a plan", rProse.content.length === 1 && rProse.content[0].type === "text");
  const rRefusal = or.parseCompletion(completion({ refusal: "I cannot help with that." }), reqFresh, toolCfg, mBad);
  check("a provider-level refusal field is malformed output with its reason", rRefusal.content[0].type === "text" && mBad.malformedReason === "model_refusal_field");
  const rTwo = or.parseCompletion(completion({ tool_calls: [0, 1].map((i) => ({ id: `c${i}`, type: "function", function: { name: PLANNER_TOOL_NAME, arguments: "{}" } })) }), reqFresh, toolCfg, {});
  check("two tool calls are passed through as two tool_use blocks (the planner rejects them)", rTwo.content.filter((b) => b.type === "tool_use").length === 2);
  const mj = {};
  const rj = or.parseCompletion(completion({ content: JSON.stringify({ plan: fresh.expected.plan }) }), reqFresh, jsonCfg, mj);
  check("json_schema mode: a pure JSON object becomes the tool_use input", rj.content[0].type === "tool_use" && rj.content[0].name === PLANNER_TOOL_NAME && !mj.fenceStripped);
  const mf = {};
  const rf = or.parseCompletion(completion({ content: "```json\n" + JSON.stringify({ plan: fresh.expected.plan }) + "\n```" }), reqFresh, jsonCfg, mf);
  check("json_schema mode: one ```json fence around the object is accepted and recorded", rf.content[0].type === "tool_use" && mf.fenceStripped === true);
  const rembed = or.parseCompletion(completion({ content: "Here is the plan: " + JSON.stringify({ plan: fresh.expected.plan }) }), reqFresh, jsonCfg, {});
  check("json_schema mode: JSON embedded in prose is NOT accepted", rembed.content[0].type === "text");
  const rarr = or.parseCompletion(completion({ content: "[1,2]" }), reqFresh, jsonCfg, {});
  check("json_schema mode: a non-object is not accepted", rarr.content[0].type === "text");
  check("capability lookup picks the mode and records limitations", or.pickStructuredMode({ found: true, supportedParameters: ["tools", "temperature"] }).mode === "tool" && or.pickStructuredMode({ found: true, supportedParameters: ["structured_outputs"] }).mode === "json_schema" && or.pickStructuredMode({ found: true, supportedParameters: ["temperature"] }).limitations.length === 1 && or.pickStructuredMode({ found: false, supportedParameters: [] }).limitations.length === 1 && or.pickStructuredMode({ found: true, supportedParameters: [] }, "tool").mode === "tool");
  const caps = await or.fetchModelCapabilities(["a/x", "b/y"], { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "a/x", supported_parameters: ["tools"], context_length: 8000, pricing: { prompt: "0", completion: "0" } }] }) }) });
  check("fetchModelCapabilities reads supported parameters and every price field; a model missing from the catalogue is not found", caps.reachable && caps.byId["a/x"].found && caps.byId["a/x"].supportedParameters[0] === "tools" && caps.byId["a/x"].pricing.prompt === "0" && !caps.byId["b/y"].found);
  const capsDown = await or.fetchModelCapabilities(["a/x"], { fetchImpl: async () => { throw new Error("offline"); } });
  check("an unreachable catalogue is not an error, but is reported as unreachable", capsDown.reachable === false && capsDown.byId["a/x"].found === false);

  // ------------------------------------------------------------------------------------------ C. HTTP behaviour against the stub
  section("C. HTTP behaviour (local stub server, fake key)");
  let stub = await startStub((body, req, res) => reply(res, 200, toolReply(goldenInput(fresh))));
  let client = makeClient(stub.baseUrl);
  let out = await plan(fresh, client);
  check("happy path: the planner result is a supported plan that scores plan_correct", out.planned.status === "supported" && out.scored.outcome === "plan_correct", out.planned.status + "/" + out.planned.code);
  check("exactly one HTTP request; Authorization carries the key; the key is NOT in the body", stub.stats.chat === 1 && stub.stats.headers[0].authorization === `Bearer ${FAKE_KEY}` && !JSON.stringify(stub.stats.bodies[0]).includes(FAKE_KEY));
  check("meta: status 200, one attempt, no retries, tool mode, served model recorded", out.meta.httpStatus === 200 && out.meta.attempts === 1 && out.meta.retries === 0 && out.meta.structuredMode === "tool" && out.meta.servedModel === "vendor/test-model");
  check("usage reaches the planner result (input + cache read)", out.planned.usage.input_tokens === 600 && out.planned.usage.cache_read_input_tokens === 400 && out.planned.usage.output_tokens === 50, JSON.stringify(out.planned.usage));
  await stub.close();

  const declineRow = rowById("nl_0109");
  stub = await startStub((body, req, res) => reply(res, 200, toolReply(goldenInput(declineRow))));
  out = await plan(declineRow, makeClient(stub.baseUrl));
  check("a clarification the model chose is a correct_refusal when the corpus expects one", out.planned.status === "needs_clarification" && out.scored.outcome === "correct_refusal", out.scored.outcome);
  await stub.close();

  const declinedSupported = fresh;
  stub = await startStub((body, req, res) => reply(res, 200, toolReply({ decline: { code: "unsupported_domain", message: "no" } })));
  out = await plan(declinedSupported, makeClient(stub.baseUrl));
  check("declining a supported question is a false_refusal (not acceptable)", out.scored.outcome === "false_refusal", out.scored.outcome);
  await stub.close();

  // a plan that validates and compiles but means the wrong thing is WRONG
  const wrongMeaning = JSON.parse(JSON.stringify(fresh.expected.plan));
  wrongMeaning.metrics = ["lineAmount"]; // "sales" answered as pre-tax item value instead of the invoice total
  stub = await startStub((body, req, res) => reply(res, 200, toolReply({ plan: wrongMeaning })));
  out = await plan(fresh, makeClient(stub.baseUrl));
  check("sales answered with lineAmount instead of invoiceAmount validates and executes - and is scored WRONG", out.planned.status === "supported" && out.scored.executable === true && out.scored.outcome === "wrong_but_executable" && out.scored.diffs.some((d) => d.field === "metrics"), out.scored.outcome);
  await stub.close();

  stub = await startStub((body, req, res) => reply(res, 200, toolReply({ plan: { v: 1, entity: "sales", mode: "aggregate", metrics: ["notARealMetric"], period: { kind: "current_month" } } })));
  out = await plan(fresh, makeClient(stub.baseUrl));
  check("a plan the schema/validator rejects is validator_rejected", out.scored.outcome === "validator_rejected" && out.planned.code === "planner_invalid_plan", out.scored.outcome);
  await stub.close();

  for (const [name, handler] of [
    ["arguments that are not JSON", (b, r, res) => reply(res, 200, completion({ tool_calls: [{ id: "c", type: "function", function: { name: PLANNER_TOOL_NAME, arguments: "{oops" } }] }))],
    ["prose only", (b, r, res) => reply(res, 200, completion({ content: "The total is 5 lakh rupees." }))],
    ["the wrong tool name", (b, r, res) => reply(res, 200, toolReply(goldenInput(fresh), "some_other_tool"))],
    ["two tool calls", (b, r, res) => reply(res, 200, completion({ tool_calls: [0, 1].map((i) => ({ id: `c${i}`, type: "function", function: { name: PLANNER_TOOL_NAME, arguments: JSON.stringify(goldenInput(fresh)) } })) }))],
    ["a plan together with a decline", (b, r, res) => reply(res, 200, toolReply({ plan: fresh.expected.plan, decline: { code: "unsupported_domain" } }))],
  ]) {
    const s = await startStub(handler);
    const o = await plan(fresh, makeClient(s.baseUrl));
    check(`malformed output (${name}) -> malformed_output, never a plan`, o.scored.outcome === "malformed_output" && o.planned.status === "planner_failed", o.scored.outcome);
    await s.close();
  }

  stub = await startStub((body, req, res) => reply(res, 200, completion({ content: JSON.stringify(goldenInput(fresh)) })));
  out = await plan(fresh, makeClient(stub.baseUrl, { structuredMode: "json_schema" }));
  check("json_schema mode end to end: scores plan_correct and sends response_format, no tools", out.scored.outcome === "plan_correct" && stub.stats.bodies[0].response_format.type === "json_schema" && !stub.stats.bodies[0].tools, out.scored.outcome);
  await stub.close();

  // provider failures and retries
  const sleeps = [];
  let calls = 0;
  stub = await startStub((body, req, res) => {
    calls += 1;
    reply(res, 500, { error: { message: "upstream exploded", code: 500 } });
  });
  out = await plan(fresh, makeClient(stub.baseUrl, { maxRetries: 2, sleep: async (ms) => sleeps.push(ms) }));
  check("HTTP 500 is retried twice (3 attempts), then reported as provider_failure; retries are recorded", calls === 3 && out.meta.attempts === 3 && out.meta.retries === 2 && eq(out.meta.retryReasons, [500, 500]) && out.scored.outcome === "provider_failure" && sleeps.length === 2, `${calls} calls, ${out.scored.outcome}`);
  await stub.close();

  const sleeps429 = [];
  calls = 0;
  stub = await startStub((body, req, res) => {
    calls += 1;
    if (calls === 1) reply(res, 429, { error: { message: "slow down" } }, { "retry-after": "3" });
    else reply(res, 200, toolReply(goldenInput(fresh)));
  });
  out = await plan(fresh, makeClient(stub.baseUrl, { sleep: async (ms) => sleeps429.push(ms) }));
  check("HTTP 429 honours Retry-After, then succeeds; the retry is counted", out.scored.outcome === "plan_correct" && out.meta.retries === 1 && sleeps429[0] >= 3000, `${out.scored.outcome} ${sleeps429}`);
  await stub.close();

  for (const status of [401, 402, 400]) {
    calls = 0;
    const s = await startStub((body, req, res) => {
      calls += 1;
      reply(res, status, { error: { message: `status ${status}` } });
    });
    const o = await plan(fresh, makeClient(s.baseUrl));
    check(`HTTP ${status} is not retried and is a provider_failure`, calls === 1 && o.scored.outcome === "provider_failure" && o.meta.httpStatus === status, `${calls} calls`);
    await s.close();
  }

  stub = await startStub((body, req, res) => reply(res, 200, { error: { code: 503, message: "provider down" } }));
  out = await plan(fresh, makeClient(stub.baseUrl, { maxRetries: 1 }));
  check("an error object inside a 200 response is a provider failure (and retried when it looks transient)", out.scored.outcome === "provider_failure" && out.meta.retries === 1, out.scored.outcome);
  await stub.close();

  stub = await startStub(() => {
    /* never answers */
  });
  const t0 = Date.now();
  out = await plan(fresh, makeClient(stub.baseUrl, { attemptTimeoutMs: 150, deadlineMs: 400 }));
  check("a model that does not answer in time -> timeout (not retried), within the deadline", out.scored.outcome === "timeout" && out.planned.code === "planner_timeout" && out.meta.attempts === 1 && Date.now() - t0 < 2000, `${out.scored.outcome} ${Date.now() - t0}ms`);
  stub.stats.maxInFlight = 0;
  await stub.close();

  const closed = await startStub((b, r, res) => reply(res, 200, {}));
  const deadUrl = closed.baseUrl;
  await closed.close();
  out = await plan(fresh, makeClient(deadUrl, { maxRetries: 1 }));
  check("a refused connection is retried once, then provider_failure", out.scored.outcome === "provider_failure" && out.meta.retries === 1, `${out.scored.outcome} retries=${out.meta.retries}`);

  // key handling
  const savedKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const noKey = or.createOpenRouterPlannerClient({ evalOnly: true, freeOnly: false, model: "vendor/test-model", baseUrl: "http://127.0.0.1:1/v1" });
  out = await plan(fresh, noKey);
  check("a missing key is a clear provider failure that makes no request", out.scored.outcome === "provider_failure", out.scored.outcome);
  let noKeyError = null;
  try {
    await noKey(await capturedRequest(fresh), {});
  } catch (e) {
    noKeyError = e;
  }
  check("the missing-key error names the variable and nothing else", noKeyError && noKeyError.code === "OPENROUTER_NOT_CONFIGURED" && /OPENROUTER_API_KEY/.test(noKeyError.message));
  process.env.OPENROUTER_API_KEY = FAKE_KEY;
  stub = await startStub((body, req, res) => {
    calls += 1;
    reply(res, 401, { error: { message: `bad credentials: ${req.headers.authorization}` } });
  });
  const envClient = or.createOpenRouterPlannerClient({ evalOnly: true, freeOnly: false, model: "vendor/test-model", baseUrl: stub.baseUrl, sleep: async () => {} });
  let leak = null;
  try {
    await envClient(await capturedRequest(fresh), {});
  } catch (e) {
    leak = e;
  }
  check("the key is read from OPENROUTER_API_KEY at call time and is redacted when a server echoes it back", leak && leak.code === "OPENROUTER_AUTH" && !leak.message.includes(FAKE_KEY) && !JSON.stringify(leak, Object.getOwnPropertyNames(leak)).includes(FAKE_KEY), leak && leak.message);
  check("describe() never contains the key", !JSON.stringify(envClient.describe()).includes(FAKE_KEY));
  await stub.close();
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;

  // ------------------------------------------------------------------------------------------ C2. free-only enforcement
  section("C2. free-only enforcement (nothing paid, no routers, no fallbacks)");
  const notFreeIds = ["openrouter/auto", "openrouter/free", "openrouter/hunter-alpha", "vendor/paid-model", "qwen/qwen3.8-27b"];
  const refusedCodes = notFreeIds.map((id) => {
    try {
      or.createOpenRouterPlannerClient({ evalOnly: true, model: id });
      return "built";
    } catch (e) {
      return e.code;
    }
  });
  check("free-only is the default: routers, stealth ids and non-:free ids cannot even be built into a client", refusedCodes.every((c) => c === "OPENROUTER_NOT_FREE"), refusedCodes.join(","));
  check("an exact :free id builds without passing freeOnly (it is the default)", typeof or.createOpenRouterPlannerClient({ evalOnly: true, model: "vendor/ok-model:free" }) === "function" && or.createOpenRouterPlannerClient({ evalOnly: true, model: "vendor/ok-model:free" }).describe().freeOnly === true);
  const freeBody = or.buildRequestBody(reqFresh, { model: "vendor/ok-model:free", structuredMode: "tool", freeOnly: true, provider: { allow_fallbacks: true, max_price: { prompt: 5 }, data_collection: "allow" } });
  check("every request names exactly one model, forbids fallbacks, caps the price at 0 - and provider preferences cannot override that", freeBody.model === "vendor/ok-model:free" && freeBody.provider.allow_fallbacks === false && eq(freeBody.provider.max_price, { prompt: 0, completion: 0 }) && freeBody.provider.data_collection === "allow" && !("models" in freeBody) && !("route" in freeBody) && !("transforms" in freeBody));
  const gate = (id, cap, reachable = true) => or.assessFreeModel(id, cap, reachable);
  const okCap = { found: true, pricing: { prompt: "0", completion: "0", request: "0", image: "0" } };
  check("gate: exact :free id with every price field 0 -> free_verified and callable", gate("vendor/m:free", okCap).status === "free_verified" && gate("vendor/m:free", okCap).callable === true);
  check("gate: not in the catalogue -> unavailable (never substituted)", gate("vendor/gone:free", { found: false }).status === "unavailable_not_in_catalogue" && !gate("vendor/gone:free", { found: false }).callable);
  check("gate: a non-zero prompt, completion or ANY other price field -> refused", ["prompt", "completion", "request", "image", "web_search"].every((k) => {
    const g = gate("vendor/m:free", { found: true, pricing: { prompt: "0", completion: "0", [k]: "0.000001" } });
    return g.status === "refused_not_free_pricing" && !g.callable;
  }));
  check("gate: unparsable prices are not free; missing prices cannot be verified", gate("vendor/m:free", { found: true, pricing: { prompt: "free", completion: "0" } }).status === "refused_not_free_pricing" && gate("vendor/m:free", { found: true, pricing: { completion: "0" } }).status === "unavailable_pricing_unverified" && gate("vendor/m:free", { found: true, pricing: null }).status === "unavailable_pricing_unverified");
  check("gate: an unreachable catalogue means the price cannot be verified -> not called", gate("vendor/m:free", okCap, false).status === "unavailable_pricing_unverified" && !gate("vendor/m:free", okCap, false).callable);
  check("gate: the paid sibling of a missing :free model, and routers, are refused", gate("qwen/qwen3.8-27b", { found: true, pricing: { prompt: "0.0000004", completion: "0.000002" } }).status === "refused_not_free_id" && gate("openrouter/auto", okCap).status === "refused_not_free_id" && gate("openrouter/hunter-alpha:free", okCap).status === "refused_not_free_id");
  check("sameModel tolerates the :free suffix and a date stamp, but not a different model", or.sameModel("vendor/m", "vendor/m:free") && or.sameModel("vendor/m-20260101", "vendor/m:free") && !or.sameModel("vendor/other", "vendor/m:free"));

  // a response that reports a cost halts the model: never retried, never called again
  let paidCalls = 0;
  const paidStub = await startStub((body, req, res) => {
    paidCalls += 1;
    const j = toolReply(goldenInput(fresh));
    j.usage.cost = 0.002;
    reply(res, 200, j);
  });
  const paidTarget = { provider: "openrouter", model: "vendor/m:free", label: "vendor/m:free", pricingStatus: "free_verified", client: makeClient(paidStub.baseUrl, { model: "vendor/m:free", freeOnly: true }) };
  const paid1 = await runner.evaluateRow({ row: fresh, target: paidTarget, resolver, cache: null });
  const paid2 = await runner.evaluateRow({ row: rowById("nl_0002"), target: paidTarget, resolver, cache: null });
  check("a response reporting a non-zero cost is a provider failure with a free violation, not retried", paid1.outcome === "provider_failure" && paid1.freeViolation === "non_zero_cost_reported" && paid1.errorCode === "OPENROUTER_FREE_VIOLATION" && paid1.retries === 0 && paidCalls === 1, `${paid1.outcome} ${paidCalls}`);
  check("...and the model is halted: the next row is skipped and makes NO request", paidTarget.state.halted && paidTarget.state.freeViolations === 1 && paid2.outcome === "skipped" && paidCalls === 1);
  check("every per-request record names the model and its pricing status", paid1.modelId === "vendor/m:free" && paid1.pricingStatus === "free_verified" && "httpStatus" in paid1 && "latencyMs" in paid1 && "usage" in paid1);
  await paidStub.close();

  const mismatchStub = await startStub((body, req, res) => {
    const j = toolReply(goldenInput(fresh));
    j.model = "other/unrelated-model:free";
    reply(res, 200, j);
  });
  const mismatchTarget = { provider: "openrouter", model: "vendor/m:free", label: "vendor/m:free", pricingStatus: "free_verified", client: makeClient(mismatchStub.baseUrl, { model: "vendor/m:free", freeOnly: true }) };
  const mm = await runner.evaluateRow({ row: fresh, target: mismatchTarget, resolver, cache: null });
  check("a different model answering is recorded (and counted) but is not silently hidden", mm.servedModelMismatch === true && mm.servedModel === "other/unrelated-model:free" && mismatchTarget.state.servedModelMismatches === 1);
  await mismatchStub.close();

  let refusals = 0;
  const refusing = { provider: "openrouter", model: "vendor/m:free", label: "vendor/m:free", pricingStatus: "free_verified", client: async () => { refusals += 1; throw Object.assign(new Error("OpenRouter HTTP 429: limit"), { code: "OPENROUTER_RATE_LIMITED", status: 429 }); } };
  const refusalRows = scoring.corpus.rows.slice(0, 12);
  const refusalRecords = [];
  for (const r of refusalRows) refusalRecords.push(await runner.evaluateRow({ row: r, target: refusing, resolver, cache: null }));
  check(`a model refused ${runner.HALT_AFTER_REFUSALS} times in a row is halted; the rest are skipped without any request`, refusals === runner.HALT_AFTER_REFUSALS && refusalRecords.filter((r) => r.outcome === "provider_failure").length === runner.HALT_AFTER_REFUSALS && refusalRecords.filter((r) => r.outcome === "skipped").length === refusalRows.length - runner.HALT_AFTER_REFUSALS && /quota|credit|availability/.test(refusing.state.halted), `${refusals} requests`);
  const aggSkipped = runner.aggregate(refusalRecords);
  check("skipped rows are counted separately and are not scored as failures", aggSkipped.skipped === refusalRows.length - runner.HALT_AFTER_REFUSALS && aggSkipped.questions === runner.HALT_AFTER_REFUSALS && aggSkipped.providerFailure === runner.HALT_AFTER_REFUSALS);

  // pacing and sampling
  let clock = 0;
  const waits = [];
  const spacer = runner.createSpacer(30, { now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  await spacer();
  await spacer();
  await spacer();
  check("the request pacer spaces provider requests 60000/rpm ms apart (30 rpm -> 2000 ms)", eq(waits, [2000, 2000]), JSON.stringify(waits));
  const sampled = runner.sampleEvenly(scoring.corpus.rows, 10);
  check("--sample picks evenly spaced rows in corpus order (deterministic, starts at the first row, spans the corpus)", sampled.length === 10 && sampled[0].id === scoring.corpus.rows[0].id && eq(sampled.map((r) => r.id), runner.sampleEvenly(scoring.corpus.rows, 10).map((r) => r.id)) && new Set(sampled.map((r) => r.group)).size >= 8 && runner.sampleEvenly(scoring.corpus.rows, 9999).length === scoring.corpus.rows.length);

  // ------------------------------------------------------------------------------------------ D. runner: pool, cache, selection
  section("D. runner: bounded concurrency, cache, selection");
  for (const limit of [1, 3, 5]) {
    let active = 0;
    let peak = 0;
    const { results, maxInFlight } = await runner.runPool(Array.from({ length: 24 }, (_, i) => i), limit, async (i) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return i * 2;
    });
    check(`concurrency ${limit}: never more than ${limit} in flight (observed ${peak}), all items done, order kept`, peak <= limit && maxInFlight === peak && peak === Math.min(limit, 24) && results.length === 24 && results.every((v, i) => v === i * 2));
  }
  check("parseModelSpecs: claude, bare and prefixed OpenRouter ids; duplicates dropped; garbage refused", eq(runner.parseModelSpecs("claude, vendor/a ,openrouter:vendor/b,vendor/a").map((s) => s.label), ["claude", "vendor/a", "vendor/b"]));
  let badSpec = null;
  try {
    runner.parseModelSpecs("just-a-word");
  } catch (e) {
    badSpec = e.message;
  }
  check("an unrecognised model is an error, not a guess", !!badSpec && /Unrecognised model/.test(badSpec));
  const all = scoring.corpus.rows;
  check("selectRows: follow-ups and gaps are included by default, can be excluded, limit and ids work", runner.selectRows(all).length === all.length && runner.selectRows(all, { includeFollowUps: false }).every((r) => !r.previousPlan) && runner.selectRows(all, { includeGaps: false }).every((r) => !r.needsEngineCapability) && runner.selectRows(all, { limit: 7 }).length === 7 && runner.selectRows(all, { ids: ["nl_0001", "nl_0002"] }).length === 2);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nlu-eval-test-"));
  let upstream = 0;
  const fakeTarget = { provider: "openrouter", model: "vendor/fake", label: "vendor/fake", client: async () => { upstream += 1; return { content: [{ type: "tool_use", id: "x", name: PLANNER_TOOL_NAME, input: goldenInput(fresh) }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }; } };
  const cacheFile = path.join(tmp, runner.cacheFileName(fakeTarget, runner.configFingerprint({ a: 1 })));
  let cache = new runner.ResponseCache(cacheFile);
  const first = await runner.evaluateRow({ row: fresh, target: fakeTarget, resolver, cache });
  cache.flush();
  cache = new runner.ResponseCache(cacheFile);
  const second = await runner.evaluateRow({ row: fresh, target: fakeTarget, resolver, cache });
  check("a rerun is served from the cache: no second upstream call, same outcome, flagged cached", upstream === 1 && first.cached === false && second.cached === true && first.outcome === "plan_correct" && second.outcome === first.outcome);
  check("the configuration fingerprint changes with client settings, so results from different settings are never mixed", runner.configFingerprint({ a: 1 }) !== runner.configFingerprint({ a: 2 }) && runner.cacheFileName(fakeTarget, runner.configFingerprint({ a: 1 })) !== runner.cacheFileName(fakeTarget, runner.configFingerprint({ a: 2 })));
  let failingCalls = 0;
  const failing = { ...fakeTarget, client: async () => { failingCalls += 1; throw Object.assign(new Error("HTTP 500"), { code: "OPENROUTER_HTTP_ERROR", status: 500 }); } };
  const failCache = new runner.ResponseCache(path.join(tmp, "fail.json"));
  const f1 = await runner.evaluateRow({ row: fresh, target: failing, resolver, cache: failCache });
  const f2 = await runner.evaluateRow({ row: fresh, target: failing, resolver, cache: failCache });
  check("failures are never cached (a transient error must not become a permanent result), and carry their error code", failingCalls === 2 && f1.outcome === "provider_failure" && f1.errorCode === "OPENROUTER_HTTP_ERROR" && f1.httpStatus === 500 && f1.errorMessage === "HTTP 500" && f2.cached === false);
  const gated = await runner.evaluateRow({ row: rowById("nl_0329"), target: fakeTarget, resolver, cache: null });
  check("a question the planner's safety gate refuses never reaches any model (no call, no latency)", gated.calledModel === false && gated.latencyMs === null, JSON.stringify([gated.calledModel, gated.latencyMs, gated.plannerStatus]));
  const fu = scoring.corpus.rows.find((r) => r.group === "follow_up" && !r.needsEngineCapability);
  let seenMessage = null;
  await runner.evaluateRow({ row: fu, target: { ...fakeTarget, client: async (request) => { seenMessage = request.messages[0].content; return { content: [{ type: "tool_use", id: "x", name: PLANNER_TOOL_NAME, input: goldenInput(fu) }], usage: {} }; } }, resolver, cache: null });
  check("a follow-up row gives every model its previous plan, exactly as the planner builds it", typeof seenMessage === "string" && seenMessage.includes("Previous query plan") && seenMessage.includes(fu.question));

  // ------------------------------------------------------------------------------------------ E. scoring and aggregation
  section("E. scoring and aggregation");
  const rec = (outcome, extra = {}) => ({ outcome, categories: extra.categories || ["english"], expectedStatus: extra.expectedStatus || "supported", diffs: extra.diffs || [], usage: { calls: 1, input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, latencyMs: extra.latencyMs ?? 100, retries: 0, cached: false, providerReportedCost: null });
  const sample = [rec("plan_correct", { latencyMs: 100 }), rec("plan_correct", { latencyMs: 200 }), rec("plan_imprecise", { latencyMs: 300 }), rec("correct_refusal", { latencyMs: 400, expectedStatus: "decline" }), rec("wrong_but_executable", { latencyMs: 500 }), rec("false_refusal", { latencyMs: 600 }), rec("validator_rejected", { latencyMs: 700 }), rec("malformed_output", { latencyMs: 800 }), rec("timeout", { latencyMs: 900 }), rec("provider_failure", { latencyMs: 1000 })];
  const agg = runner.aggregate(sample);
  check("exact 20%, acceptable 40%, wrong 10%, invalid 20%, failure 20%, false refusal 10% of 10 rows", agg.exactPct === 20 && agg.acceptablePct === 40 && agg.wrongPlanPct === 10 && agg.invalidPlanPct === 20 && agg.failurePct === 20 && agg.falseRefusalPct === 10, JSON.stringify([agg.exactPct, agg.acceptablePct, agg.wrongPlanPct, agg.invalidPlanPct, agg.failurePct]));
  check("every outcome class is counted separately and the counts add up to the questions", Object.values(agg.counts).reduce((a, b) => a + b, 0) === 10 && agg.counts.timeout === 1 && agg.counts.provider_failure === 1 && agg.counts.malformed_output === 1 && agg.counts.validator_rejected === 1 && agg.counts.wrong_but_executable === 1);
  check("latency: average, p50, p95 (nearest rank) and token totals", agg.latencyMs.average === 550 && agg.latencyMs.p50 === 500 && agg.latencyMs.p95 === 1000 && agg.tokens.input === 1000 && agg.tokens.output === 100 && agg.tokens.calls === 10, JSON.stringify(agg.latencyMs));
  check("percentile helper", runner.percentile([1, 2, 3, 4], 0.5) === 2 && runner.percentile([1, 2, 3, 4], 0.95) === 4 && runner.percentile([], 0.5) === null);
  const cats = runner.breakdown([rec("plan_correct", { categories: ["hinglish", "ranking"] }), rec("wrong_but_executable", { categories: ["hinglish"] }), rec("plan_correct", { categories: ["follow_up"] })]);
  check("category breakdown: a row counts in each of its categories", cats.hinglish.questions === 2 && cats.hinglish.exactPct === 50 && cats.ranking.exactPct === 100 && cats.follow_up.questions === 1);
  const classify = (code) => scoring.classifyPlanned(fresh, { status: "planner_failed", code, usage: {} }).outcome;
  check("planner failures map to their own outcome classes: invalid plan, malformed, timeout, provider - and a name that does not exist is a WRONG plan, not a provider failure", classify("planner_invalid_plan") === "validator_rejected" && classify("planner_protocol_violation") === "malformed_output" && classify("planner_timeout") === "timeout" && classify("planner_call_failed") === "provider_failure" && classify("planner_entity_check_failed") === "provider_failure" && classify("planner_entity_not_resolved") === "wrong_not_executable");
  const names = scoring.categoriesOf(rowById("nl_0010"));
  check("the corpus categories cover language, follow-up, gap and refusal rows", names.includes("hinglish") && scoring.categoriesOf(followUp).includes("follow_up") && scoring.categoriesOf(rowById("nl_0109")).includes("clarification_decline") && scoring.corpus.rows.some((r) => scoring.categoriesOf(r).includes("capability_gap")) && scoring.corpus.rows.some((r) => scoring.categoriesOf(r).includes("entity_handling")) && scoring.corpus.rows.some((r) => scoring.categoriesOf(r).includes("comparison")) && scoring.corpus.rows.some((r) => scoring.categoriesOf(r).includes("ranking")) && scoring.corpus.rows.some((r) => scoring.categoriesOf(r).includes("grouping")) && scoring.corpus.rows.some((r) => scoring.categoriesOf(r).includes("period_handling")));
  const mkT = (label, provider, s, b) => ({ label, provider, summary: { ...runner.aggregate(s), }, breakdown: b });
  const tClaude = mkT("claude", "claude", [rec("plan_correct", { latencyMs: 900 }), rec("plan_correct", { latencyMs: 900 })], { follow_up: { questions: 2, exactPct: 100 } });
  const tA = mkT("vendor/a", "openrouter", [rec("plan_correct", { latencyMs: 300 }), rec("wrong_but_executable", { latencyMs: 300 })], { follow_up: { questions: 2, exactPct: 50 } });
  const tB = mkT("vendor/b", "openrouter", [rec("plan_correct", { latencyMs: 300 }), rec("plan_correct", { latencyMs: 300 })], { follow_up: { questions: 2, exactPct: 100 } });
  const lead = runner.leaders([tClaude, tA, tB]);
  check("leaders are facts with ties listed - no winner is chosen", eq(lead.bestExactAccuracy.models, ["claude", "vendor/b"]) && eq(lead.bestMedianLatency.models, ["vendor/a", "vendor/b"]) && eq(lead.lowestWrongPlanRate.models, ["claude", "vendor/b"]) && !("winner" in lead));
  check("every other model is reported as a delta against the Claude baseline", lead.againstClaudeBaseline.length === 2 && lead.againstClaudeBaseline[0].model === "vendor/a" && lead.againstClaudeBaseline[0].exactPctDelta === -50 && lead.againstClaudeBaseline[1].exactPctDelta === 0);
  const tFail = mkT("vendor/failed", "openrouter", [rec("provider_failure"), rec("timeout"), rec("provider_failure")], {});
  const lead2 = runner.leaders([tClaude, tA, tB, tFail]);
  check("a model that mostly failed at the provider is listed as ineligible, never as a leader (e.g. lowest wrong-plan rate)", lead2.ineligible.length === 1 && lead2.ineligible[0].model === "vendor/failed" && /failed at the provider/.test(lead2.ineligible[0].reason) && !lead2.lowestWrongPlanRate.models.includes("vendor/failed") && !lead2.bestMedianLatency.models.includes("vendor/failed"), JSON.stringify(lead2.ineligible));
  const table = runner.comparisonTable([tClaude, tA, tB]);
  check("the comparison table lists every model with Exact / Accept / Wrong / FalseRef / KindDiff / Invalid / Fail / NotEval / P50 / P95, and its accounting lines", /Model\s+Exact\s+Accept\s+Wrong\s+FalseRef\s+KindDiff\s+Invalid\s+Fail\s+NotEval\s+P50 ms\s+P95 ms/.test(table) && /claude/.test(table) && /vendor\/a/.test(table) && /vendor\/b/.test(table) && /partition OK/.test(table));

  // ------------------------------------------------------------------------------------------ E4. reporting buckets
  section("E4. reporting buckets partition every evaluated row");
  const throwsWith = (fn, re) => {
    try {
      fn();
      return false;
    } catch (e) {
      return re.test(e.message);
    }
  };
  const bucketLists = Object.values(scoring.OUTCOME_BUCKETS);
  check("every outcome class belongs to exactly one reporting bucket, and the buckets hold no other outcome", scoring.OUTCOMES.every((o) => bucketLists.filter((l) => l.includes(o)).length === 1) && eq([...bucketLists.flat()].sort(), [...scoring.OUTCOMES].sort()));
  check("ACCEPTABLE is exactly exact + imprecise + correct refusals, so Accept + Wrong + FalseRef + KindDiff + Invalid + Fail is 100% of the evaluated rows", eq([...scoring.ACCEPTABLE].sort(), [...scoring.OUTCOME_BUCKETS.exact, ...scoring.OUTCOME_BUCKETS.imprecise, ...scoring.OUTCOME_BUCKETS.correctRefusal].sort()));
  const twelve = scoring.OUTCOMES.map((o) => rec(o));
  const aggAll = runner.aggregate([...twelve, { outcome: "harness_error", categories: [] }, { outcome: "skipped", categories: [] }]);
  check("all 12 outcome classes: 12 evaluated; the harness error and the skipped row are documented as not evaluated and sit outside the percentages; buckets total 12", aggAll.questions === 12 && aggAll.partition.rows === 14 && aggAll.partition.evaluated === 12 && aggAll.partition.notEvaluated.harnessErrors === 1 && aggAll.partition.notEvaluated.skipped === 1 && aggAll.partition.bucketTotal === 12 && aggAll.partition.ok === true && runner.partitionProblem(aggAll) === null && runner.assertPartition(aggAll) === aggAll, JSON.stringify(aggAll.partition));
  check("false_refusal and refusal_kind_differs have their own buckets and percentages (they are not dropped)", aggAll.buckets.falseRefusal === 1 && aggAll.buckets.refusalKindDiffers === 1 && aggAll.refusalKindDiffers === 1 && aggAll.refusalKindDiffersPct === 8.3 && aggAll.falseRefusalPct === 8.3 && aggAll.bucketPct.wrongPlan === 16.7, JSON.stringify(aggAll.buckets));
  check("Accept + Wrong + FalseRef + KindDiff + Invalid + Fail account for all 12 evaluated rows", aggAll.acceptable + aggAll.buckets.wrongPlan + aggAll.buckets.falseRefusal + aggAll.buckets.refusalKindDiffers + aggAll.buckets.invalid + aggAll.buckets.failure === 12);
  const auditCounts = { plan_correct: 222, plan_imprecise: 38, correct_refusal: 40, wrong_but_executable: 51, wrong_not_executable: 3, false_refusal: 5, refusal_kind_differs: 3, validator_rejected: 17, malformed_output: 1 };
  const auditRecords = Object.entries(auditCounts).flatMap(([o, n]) => Array.from({ length: n }, () => rec(o)));
  const aud = runner.aggregate(auditRecords);
  check("the audited 380-row run: the old headline numbers covered 372 rows (acceptable + wrong + invalid + failure); the partition covers all 380, including 5 false refusals and 3 kind differences", auditRecords.length === 380 && aud.acceptable + aud.buckets.wrongPlan + aud.buckets.invalid + aud.buckets.failure === 372 && aud.partition.bucketTotal === 380 && aud.partition.ok === true && aud.buckets.falseRefusal === 5 && aud.buckets.refusalKindDiffers === 3, JSON.stringify(aud.buckets));
  const unknownOutcome = runner.aggregate([rec("plan_correct"), rec("some_new_outcome")]);
  check("an outcome that is in no bucket is detected: the partition is not OK, the outcome is named and the assertion throws", unknownOutcome.partition.ok === false && eq(unknownOutcome.partition.unclassifiedOutcomes, ["some_new_outcome"]) && /some_new_outcome/.test(runner.partitionProblem(unknownOutcome)) && throwsWith(() => runner.assertPartition(unknownOutcome), /accounting error/));
  const tampered = { ...aggAll, partition: { ...aggAll.partition, bucketTotal: 11, ok: false } };
  check("bucket totals that do not equal the evaluated rows are detected and asserted", /buckets hold 11 rows but 12 were evaluated/.test(runner.partitionProblem(tampered)) && throwsWith(() => runner.assertPartition(tampered), /accounting error/) && runner.partitionProblem({}) !== null);
  const tbl = runner.comparisonTable([{ label: "x", provider: "claude", summary: aggAll, breakdown: {} }]);
  check("the table prints the false-refusal and kind-differs columns, the not-evaluated count and one accounting line per model", /FalseRef\s+KindDiff/.test(tbl) && /NotEval/.test(tbl) && /x: 12 evaluated = 1 exact \+ 1 imprecise \+ 2 correct refusal \+ 2 wrong \+ 1 false refusal \+ 1 kind differs \+ 2 invalid \+ 2 failure \(partition OK\); not evaluated: 1 harness errors, 1 skipped/.test(tbl), tbl.split("\n").slice(-2).join(" | "));
  check("the category breakdown carries the false-refusal and kind-differs rates too", runner.breakdown([rec("false_refusal"), rec("plan_correct")]).english.falseRefusalPct === 50 && runner.breakdown([rec("refusal_kind_differs"), rec("plan_correct")]).english.refusalKindDiffersPct === 50);

  const refuser = mkT("vendor/refuser", "openrouter", [...Array.from({ length: 6 }, () => rec("false_refusal")), ...Array.from({ length: 4 }, () => rec("plan_correct"))], {});
  const leadR = runner.leaders([tClaude, refuser]);
  check("a model that declines most supported questions is ineligible (it would otherwise lead 'lowest wrong-plan rate' with 0%)", leadR.ineligible.length === 1 && leadR.ineligible[0].model === "vendor/refuser" && /declined or clarified/.test(leadR.ineligible[0].reason) && !leadR.lowestWrongPlanRate.models.includes("vendor/refuser") && !leadR.lowestFalseRefusalRate.models.includes("vendor/refuser"), JSON.stringify(leadR.ineligible));
  const shy = mkT("vendor/shy", "openrouter", [...Array.from({ length: 3 }, () => rec("false_refusal")), ...Array.from({ length: 7 }, () => rec("plan_correct"))], {});
  const bold = mkT("vendor/bold", "openrouter", [rec("wrong_but_executable"), ...Array.from({ length: 9 }, () => rec("plan_correct"))], {});
  const leadS = runner.leaders([tClaude, shy, bold]);
  check("a refusal is not a wrong plan: the wrong-plan leader refuses 30% of the questions, while the wrong-or-false-refusal leader and the false-refusal leader are the model that answers", leadS.ineligible.length === 0 && eq(leadS.lowestWrongPlanRate.models, ["claude", "vendor/shy"]) && eq(leadS.lowestWrongOrFalseRefusalRate.models, ["claude"]) && eq(leadS.lowestFalseRefusalRate.models, ["claude", "vendor/bold"]) && leadS.lowestWrongOrFalseRefusalRate.value === 0, JSON.stringify([leadS.lowestWrongPlanRate, leadS.lowestWrongOrFalseRefusalRate]));
  check("the Claude-baseline deltas include the false-refusal rate", leadS.againstClaudeBaseline.find((d) => d.model === "vendor/shy").falseRefusalPctDelta === 30 && leadS.againstClaudeBaseline.find((d) => d.model === "vendor/bold").falseRefusalPctDelta === 0);

  // ------------------------------------------------------------------------------------------ E5. diagnostics
  section("E5. diagnostics on rows that did not score cleanly (ids, codes and counts only)");
  const jsonHas = (obj, text) => JSON.stringify(obj).toLowerCase().includes(String(text).toLowerCase());
  const GRAIN_SWAP = { invoiceAmount: "invoiceCount", purchaseAmount: "purchaseInvoiceCount", lineAmount: "quantity", quantity: "lineAmount" };
  const filteredRow = scoring.corpus.rows.find((r) => r.expected.status === "supported" && r.expected.plan && (r.expected.plan.filters || []).length && !(r.expected.plan.groupBy || []).length && GRAIN_SWAP[r.expected.plan.metrics[0]] && !r.previousPlan && !r.needsEngineCapability);
  const filterValues = filteredRow.expected.plan.filters.flatMap((f) => (Array.isArray(f.value) ? f.value : [f.value]));
  const stubTarget = (input) => ({ provider: "claude", model: null, label: "stub", client: async () => ({ content: [{ type: "tool_use", id: "x", name: PLANNER_TOOL_NAME, input }], usage: { input_tokens: 5, output_tokens: 5 } }) });
  const evalWith = (row, input, cache = null) => runner.evaluateRow({ row, target: stubTarget(input), resolver, cache });
  const cleanRec = await evalWith(filteredRow, goldenInput(filteredRow));
  check("a clean row carries no diagnostic", cleanRec.outcome === "plan_correct" && cleanRec.diagnostic === null, cleanRec.outcome);

  const wrongInput = goldenInput(filteredRow);
  wrongInput.plan = { ...wrongInput.plan, metrics: [GRAIN_SWAP[filteredRow.expected.plan.metrics[0]]], sort: [], having: [] };
  const wrongRec = await evalWith(filteredRow, wrongInput);
  const dw = wrongRec.diagnostic;
  check("a wrong plan: expected and actual structure side by side, with the planner's status, code and source", wrongRec.outcome === "wrong_but_executable" && dw.expected.status === "supported" && dw.expected.shape.metrics[0] === filteredRow.expected.plan.metrics[0] && dw.actual.shape.metrics[0] === GRAIN_SWAP[filteredRow.expected.plan.metrics[0]] && dw.actual.outcome === "wrong_but_executable" && dw.actual.got === "supported" && dw.actual.plannerStatus === "supported" && dw.actual.plannerCode === null && dw.actual.plannerSource === "claude_planner" && dw.actual.shapeFrom === "planner_plan" && dw.validatorErrors.length === 0 && wrongRec.diffs.length > 0, JSON.stringify(dw));
  check("...and no filter value, question or free text anywhere in it (a filter is its dimension, operator and number of values)", filterValues.every((v) => !jsonHas(dw, v)) && !jsonHas(dw, filteredRow.question) && dw.actual.shape.filters.every((f) => /^[A-Za-z]+:[a-z_?]+#\d+$/.test(f)), JSON.stringify(dw.actual.shape.filters));

  const rejectedInput = { plan: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["notARealMetric"], filters: [{ dim: "customer", op: "eq_ci", value: "Zenith Retail" }], secretNote: "TOKEN-123" } };
  const rejectedRec = await evalWith(filteredRow, rejectedInput);
  const dr = rejectedRec.diagnostic;
  check("a rejected plan: planner code and source, the validator's error codes with their field paths, and the plan shown by structure as the model submitted it", rejectedRec.outcome === "validator_rejected" && dr.actual.plannerStatus === "planner_failed" && dr.actual.plannerCode === "planner_invalid_plan" && dr.actual.plannerSource === "claude_planner" && dr.validatorErrors.length > 0 && dr.validatorErrors.every((e) => /^[a-z][a-z0-9_]*$/.test(e.code) && /^[A-Za-z0-9_.]*$/.test(e.path)) && dr.actual.shapeFrom === "model_plan_as_submitted" && dr.actual.shape.metrics[0] === "?" && dr.actual.shape.filters[0] === "customer:eq_ci#1" && dr.expected.status === "supported" && !!dr.expected.shape, JSON.stringify(dr));
  check("...an unknown metric id is shown as '?'; the filter value, the unknown key and its text never appear", !jsonHas(dr, "notARealMetric") && !jsonHas(dr, "Zenith") && !jsonHas(dr, "TOKEN-123") && !jsonHas(dr, "secretNote"));

  const declineInput = { decline: { code: "unsupported_domain", message: "FREE-TEXT-FROM-THE-MODEL" } };
  const falseRec = await evalWith(filteredRow, declineInput);
  check("a false refusal: the planner's status, code and source are kept, there is no plan shape, and the model's decline text is not copied", falseRec.outcome === "false_refusal" && falseRec.diagnostic.actual.plannerStatus === "unsupported" && falseRec.diagnostic.actual.plannerCode === "planner_unsupported_domain" && falseRec.diagnostic.actual.plannerSource === "claude_planner" && falseRec.diagnostic.actual.shape === null && falseRec.diagnostic.actual.shapeFrom === null && !!falseRec.diagnostic.expected.shape && !jsonHas(falseRec.diagnostic, "FREE-TEXT"), JSON.stringify(falseRec.diagnostic));
  const kindRow = rowById("nl_0286"); // a decline row with no alsoAccept that the safety gate does not intercept
  const kindRec = await evalWith(kindRow, { decline: { code: "needs_clarification", message: "x" } });
  check("a refusal of the wrong kind: expected decline, got clarify, with the planner code", kindRec.outcome === "refusal_kind_differs" && kindRec.diagnostic.expected.status === "decline" && kindRec.diagnostic.actual.got === "clarify" && kindRec.diagnostic.actual.plannerCode === "planner_needs_clarification" && kindRec.diagnostic.expected.shape === null, JSON.stringify(kindRec.diagnostic));
  const proseRec = await runner.evaluateRow({ row: filteredRow, target: { provider: "claude", model: null, label: "stub", client: async () => ({ content: [{ type: "text", text: "Sales were 12,34,567 rupees" }], usage: {} }) }, resolver, cache: null });
  check("malformed output (prose instead of a plan): planner code kept, no plan shape, the prose is not copied", proseRec.outcome === "malformed_output" && proseRec.diagnostic.actual.plannerCode === "planner_protocol_violation" && proseRec.diagnostic.actual.shape === null && !jsonHas(proseRec.diagnostic, "12,34,567"));
  const downRec = await runner.evaluateRow({ row: filteredRow, target: { provider: "claude", model: null, label: "stub", client: async () => { throw new Error("HTTP 500 upstream detail"); } }, resolver, cache: null });
  check("a provider failure also carries a diagnostic (code only; the error text stays in the existing errorMessage field)", downRec.outcome === "provider_failure" && downRec.diagnostic.actual.plannerCode === "planner_call_failed" && !jsonHas(downRec.diagnostic, "upstream detail") && downRec.errorMessage === "HTTP 500 upstream detail");
  const diagCacheFile = path.join(tmp, "diag-cache.json");
  let diagCache = new runner.ResponseCache(diagCacheFile);
  const live1 = await evalWith(filteredRow, rejectedInput, diagCache);
  diagCache.flush();
  diagCache = new runner.ResponseCache(diagCacheFile);
  const replay1 = await evalWith(filteredRow, { plan: {} }, diagCache);
  check("a rejected plan replayed from the cache gets the same diagnostic (the plan comes from the cached answer, no provider call)", live1.cached === false && replay1.cached === true && eq(replay1.diagnostic, live1.diagnostic) && replay1.diagnostic.actual.shape.metrics[0] === "?");
  const shape = scoring.planShape({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-09-01", to: "bad" }, compare: { mode: "full_previous" }, metrics: ["invoiceAmount", "DROP TABLE"], groupBy: [{ dim: "date", bucket: "month" }, { dim: "customer" }], filters: [{ dim: "customer", op: "in_ci", value: ["Secret A", "Secret B"] }], having: [{ metric: "invoiceAmount.delta", op: "gt", value: 987654 }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 5, note: "free text" });
  check("planShape keeps ids, operators and counts; an unknown id, a malformed date, filter values, thresholds and extra keys never appear", shape.period === "custom:?" && eq(shape.metrics, ["invoiceAmount", "?"]) && eq(shape.groupBy, ["date:month", "customer"]) && eq(shape.filters, ["customer:in_ci#2"]) && eq(shape.having, ["invoiceAmount.delta gt"]) && eq(shape.sort, ["invoiceAmount desc"]) && shape.compare === "full_previous" && shape.limit === 5 && !jsonHas(shape, "Secret") && !jsonHas(shape, "987654") && !jsonHas(shape, "DROP") && !jsonHas(shape, "free text") && scoring.planShape(null) === null && scoring.planShape([]) === null && scoring.planShape("x") === null);
  check("needsDiagnostic: clean outcomes (exact, correct refusal, accepted refusal) need none; every other outcome does", ["plan_correct", "correct_refusal", "refusal_accepted"].every((o) => !scoring.needsDiagnostic(o)) && scoring.OUTCOMES.filter((o) => !["plan_correct", "correct_refusal", "refusal_accepted"].includes(o)).every((o) => scoring.needsDiagnostic(o)));

  // ------------------------------------------------------------------------------------------ F. Claude baseline preserved
  section("F. the Claude baseline path is preserved");
  const child = (script, argv, env = {}) => spawnSync(process.execPath, [path.join(__dirname, script), ...argv], { cwd: __dirname, encoding: "utf8", timeout: 120000, env: { ...process.env, ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "", OPENROUTER_EVAL_MODELS: "", OPENROUTER_BASE_URL: "http://127.0.0.1:1/v1", ...env } });
  const childAsync = (script, argv, env = {}) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(__dirname, script), ...argv], { cwd: __dirname, env: { ...process.env, ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "", OPENROUTER_EVAL_MODELS: "", OPENROUTER_BASE_URL: "http://127.0.0.1:1/v1", ...env } });
      let stdout = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.stderr.on("data", (d) => (stdout += d));
      c.on("close", (status) => resolve({ status, stdout }));
    });
  const free = child("verify-nlu-eval.js", []);
  check("verify-nlu-eval.js (the existing free self-check and live-scoring tests) still passes with the shared scorer", free.status === 0 && /0 failed/.test(free.stdout), (free.stdout || "").split("\n").slice(-3).join(" | "));
  const freeNY = child("verify-nlu-eval.js", [], { TZ: "America/New_York" });
  check("verify-nlu-eval.js started in America/New_York (a zone where an unpinned evaluator scored relative-vs-custom periods wrong) still passes: the evaluator pins UTC itself", freeNY.status === 0 && /0 failed/.test(freeNY.stdout), (freeNY.stdout || "").split("\n").slice(-3).join(" | "));
  const dryClaude = child("eval-nlu-models.js", ["--models=claude", "--limit=3", "--dry-run"]);
  check("--models=claude --dry-run lists the baseline and calls nothing", dryClaude.status === 0 && /claude {2}\(baseline: the existing planner\)/.test(dryClaude.stdout) && /nothing was called/.test(dryClaude.stdout), dryClaude.stdout);
  const noLimit = child("eval-nlu-models.js", ["--models=claude"]);
  check("no --limit / --all: refuses before any call", noLimit.status === 2 && /--limit=N/.test(noLimit.stdout), noLimit.stdout);
  const bigSpend = child("eval-nlu-models.js", ["--models=claude", "--all"]);
  check("the Claude baseline over more than 60 rows needs --confirm-spend", bigSpend.status === 2 && /--confirm-spend/.test(bigSpend.stdout), bigSpend.stdout);
  const keyStub = await startStub(() => {}, { catalogue: [{ id: "vendor/some-model:free", supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0" } }] });
  const noKeyRun = await childAsync("eval-nlu-models.js", ["--models=vendor/some-model:free", "--limit=3", "--no-claude"], { OPENROUTER_BASE_URL: keyStub.baseUrl });
  await keyStub.close();
  check("a verified-free model without OPENROUTER_API_KEY: a clear message, exit 2, no call", noKeyRun.status === 2 && /OPENROUTER_API_KEY is missing/.test(noKeyRun.stdout) && keyStub.stats.chat === 0, noKeyRun.stdout);
  const addsBaseline = child("eval-nlu-models.js", ["--models=vendor/some-model", "--limit=3", "--dry-run"]);
  check("the Claude baseline is added automatically next to OpenRouter models (unless --no-claude)", /claude {2}\(baseline/.test(addsBaseline.stdout) && /2 model\(s\) x 3 question/.test(addsBaseline.stdout), addsBaseline.stdout);
  check("OPENROUTER_EVAL_MODELS selects the models when --models is absent", /vendor\/env-a/.test(child("eval-nlu-models.js", ["--limit=2", "--dry-run", "--no-claude"], { OPENROUTER_EVAL_MODELS: "vendor/env-a,vendor/env-b" }).stdout));

  // ------------------------------------------------------------------------------------------ G. end to end through the CLI
  section("G. end to end: eval-nlu-models.js against the stub (bounded concurrency, cache, report, no secrets)");
  const catalogue = [{ id: "vendor/stub-model:free", supported_parameters: ["tools", "temperature"], context_length: 32000, pricing: { prompt: "0", completion: "0", request: "0" } }];
  const cliRows = scoring.corpus.rows.slice(0, 8);
  const wrongRow = cliRows[1].id;
  const stubCli = await startStub(async (body, req, res) => {
    await new Promise((r) => setTimeout(r, 40)); // keep requests overlapping so the concurrency bound is observable
    const content = body.messages[1].content;
    const question = content.includes("Question: ") ? content.split("Question: ").pop() : content;
    const row = scoring.corpus.rows.find((r) => r.question === question);
    const input = goldenInput(row);
    if (row.id === wrongRow) input.plan = { ...input.plan, metrics: ["invoiceCount"] };
    reply(res, 200, toolReply(input));
  }, { catalogue });
  const outDir = path.join(tmp, "results");
  const cacheDir = path.join(tmp, "cache");
  const runCli = (extra = []) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(__dirname, "eval-nlu-models.js"), "--models=vendor/stub-model:free", "--no-claude", "--limit=8", "--concurrency=2", "--no-pace", `--out-dir=${outDir}`, `--cache-dir=${cacheDir}`, ...extra], { cwd: __dirname, env: { ...process.env, TZ: "America/New_York", OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stubCli.baseUrl, ANTHROPIC_API_KEY: "", OPENROUTER_EVAL_MODELS: "" } });
      let text = "";
      c.stdout.on("data", (d) => (text += d));
      c.stderr.on("data", (d) => (text += d));
      c.on("close", (code) => resolve({ code, text }));
    });
  const run1 = await runCli();
  check("the CLI run succeeds", run1.code === 0, run1.text.slice(-300));
  check("one chat request per question, and never more than 2 in flight (stub-observed)", stubCli.stats.chat === 8 && stubCli.stats.maxInFlight <= 2 && stubCli.stats.maxInFlight >= 1, `${stubCli.stats.chat} requests, peak ${stubCli.stats.maxInFlight}`);
  check("the public model catalogue was read once and the model used tool mode", stubCli.stats.models === 1 && stubCli.stats.bodies.every((b) => !!b.tools && b.model === "vendor/stub-model:free"));
  const files = fs.readdirSync(outDir);
  const jsonFile = files.find((f) => f.endsWith(".json"));
  const txtFile = files.find((f) => f.endsWith(".txt"));
  check("a machine-readable JSON report and a human-readable text report were written", !!jsonFile && !!txtFile, files.join(","));
  const report = JSON.parse(fs.readFileSync(path.join(outDir, jsonFile), "utf8"));
  const t = report.targets[0];
  check("report metadata: provider, model, prompt/schema fingerprint, corpus version, counts, settings", t.provider === "openrouter" && t.model === "vendor/stub-model:free" && /^[0-9a-f]{16}$/.test(t.promptSchemaFingerprint) && report.corpus.version === scoring.corpus.version && report.corpus.evaluatedRows === 8 && t.summary.questions === 8 && t.settings.structuredMode === "tool" && report.run.maxInFlight <= 2 && report.run.databaseConnections === 0);
  check("the wrong-meaning plan is counted as wrong_but_executable; the rest are exact", t.summary.counts.wrong_but_executable === 1 && t.summary.exactCorrect === 7 && t.results.find((r) => r.id === wrongRow).outcome === "wrong_but_executable", JSON.stringify(t.summary.counts));
  check("per-question results carry outcome, latency, tokens, retries and error fields; metrics include percentages and tokens", t.results.every((r) => r.outcome && Number.isFinite(r.latencyMs) && r.usage && "retries" in r && "errorCode" in r) && t.summary.exactPct === 87.5 && t.summary.tokens.input > 0 && t.breakdown.english.questions === 8);
  const allOutput = run1.text + fs.readFileSync(path.join(outDir, jsonFile), "utf8") + fs.readFileSync(path.join(outDir, txtFile), "utf8") + JSON.stringify(fs.readdirSync(cacheDir).map((f) => fs.readFileSync(path.join(cacheDir, f), "utf8")));
  check("the API key appears nowhere: not in the console output, the reports or the cache", !allOutput.includes(FAKE_KEY) && !/sk-or-/i.test(allOutput) && !/authorization/i.test(allOutput));
  check("no real data: only corpus questions were sent, and no database was opened", report.run.databaseConnections === 0 && stubCli.stats.bodies.every((b) => scoring.corpus.rows.some((r) => b.messages[1].content.includes(r.question))));
  const reportText = fs.readFileSync(path.join(outDir, txtFile), "utf8");
  const diagRecord = t.results.find((r) => r.id === wrongRow);
  check("E3 through the CLI: started in America/New_York, the run still evaluates in UTC and says so in the report", report.run.timezone === "UTC" && /evaluation time zone UTC/.test(reportText));
  check("E4 through the CLI: the report carries the bucket accounting (8 evaluated = 7 exact + 1 wrong), the partition is OK, and the text report prints it", t.summary.partition.ok === true && t.summary.partition.evaluated === 8 && t.summary.partition.bucketTotal === 8 && t.summary.buckets.exact === 7 && t.summary.buckets.wrongPlan === 1 && /8 evaluated = 7 exact \+ 0 imprecise \+ 0 correct refusal \+ 1 wrong \+ 0 false refusal \+ 0 kind differs \+ 0 invalid \+ 0 failure \(partition OK\)/.test(reportText) && /FalseRef\s+KindDiff/.test(reportText), reportText.split("\n").slice(-6).join(" | "));
  check("E5 through the CLI: the wrong row carries a diagnostic (expected and actual structure, planner status and source); clean rows carry none", !!diagRecord.diagnostic && diagRecord.diagnostic.actual.outcome === "wrong_but_executable" && eq(diagRecord.diagnostic.actual.shape.metrics, ["invoiceCount"]) && diagRecord.diagnostic.actual.plannerStatus === "supported" && diagRecord.diagnostic.actual.plannerSource === "claude_planner" && diagRecord.diagnostic.expected.status === "supported" && t.results.filter((r) => r.id !== wrongRow).every((r) => r.diagnostic === null));
  const before = stubCli.stats.chat;
  const run2 = await runCli();
  const report2 = JSON.parse(fs.readFileSync(path.join(outDir, fs.readdirSync(outDir).filter((f) => f.endsWith(".json")).sort().pop()), "utf8"));
  check("rerunning the same evaluation spends no requests (served from the cache) and gives the same measurements", run2.code === 0 && stubCli.stats.chat === before && report2.targets[0].summary.cachedRows === 8 && report2.targets[0].summary.exactCorrect === t.summary.exactCorrect);
  const run3 = await runCli(["--no-cache"]);
  check("--no-cache calls the provider again", run3.code === 0 && stubCli.stats.chat === before + 8);
  const run4 = await runCli(["--max-tokens=1500"]);
  check("a different client setting is a different cache entry (no stale reuse)", run4.code === 0 && stubCli.stats.chat === before + 16 && stubCli.stats.bodies[stubCli.stats.bodies.length - 1].max_tokens === 1500);
  await stubCli.close();
  // ------------------------------------------------------------------------------------------ G2. the free gate through the CLI
  section("G2. the CLI refuses to call anything that is not verified free");
  const gateCatalogue = [
    { id: "vendor/stub-model:free", supported_parameters: ["tools", "temperature"], pricing: { prompt: "0", completion: "0", request: "0" } },
    { id: "vendor/priced-model:free", supported_parameters: ["tools"], pricing: { prompt: "0.000002", completion: "0" } },
    { id: "vendor/paid-model", supported_parameters: ["tools"], pricing: { prompt: "0.000002", completion: "0.000004" } },
  ];
  const gateStub = await startStub(async (body, req, res) => {
    const content = body.messages[1].content;
    const row = scoring.corpus.rows.find((r) => r.question === content);
    reply(res, 200, toolReply(goldenInput(row)));
  }, { catalogue: gateCatalogue });
  const gateOut = path.join(tmp, "gate-results");
  const gateRun = await childAsync("eval-nlu-models.js", ["--models=vendor/stub-model:free,vendor/priced-model:free,vendor/missing-model:free,vendor/paid-model,openrouter/auto", "--no-claude", "--limit=4", "--no-cache", "--no-pace", `--out-dir=${gateOut}`], { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: gateStub.baseUrl });
  check("the CLI run succeeds with one verified-free model among five requested", gateRun.status === 0, gateRun.stdout.slice(-300));
  check("only the verified-free model received requests (4 questions -> 4 requests); the priced, missing, non-:free and router ids received none", gateStub.stats.chat === 4 && gateStub.stats.bodies.every((b) => b.model === "vendor/stub-model:free"), `${gateStub.stats.chat} requests`);
  check("each request carried the zero-price cap, no fallbacks and no model list", gateStub.stats.bodies.every((b) => b.provider.allow_fallbacks === false && eq(b.provider.max_price, { prompt: 0, completion: 0 }) && !("models" in b) && !("route" in b)));
  const gateReport = JSON.parse(fs.readFileSync(path.join(gateOut, fs.readdirSync(gateOut).find((f) => f.endsWith(".json"))), "utf8"));
  const statuses = Object.fromEntries(gateReport.freeOnly.requestedModels.map((m) => [m.id, m.pricingStatus]));
  check("the report lists every requested model with its pricing status and why it was or was not tested", statuses["vendor/stub-model:free"] === "free_verified" && statuses["vendor/priced-model:free"] === "refused_not_free_pricing" && statuses["vendor/missing-model:free"] === "unavailable_not_in_catalogue" && statuses["vendor/paid-model"] === "refused_not_free_id" && statuses["openrouter/auto"] === "refused_not_free_id" && gateReport.freeOnly.requestedModels.filter((m) => m.tested).length === 1);
  check("the report confirms zero paid requests and carries the pricing seen and when it was checked", gateReport.freeOnly.paidModelRequestsIntentionallyMade === 0 && gateReport.freeOnly.providerRequestsToNonFreeVerifiedModels === 0 && gateReport.freeOnly.responsesReportingNonZeroCost === 0 && gateReport.freeOnly.requestedModels[0].pricing.prompt === "0" && !!gateReport.freeOnly.requestedModels[0].pricingCheckedAt);
  check("the screen output names the skipped models and the exact model tested", /SKIPPED vendor\/priced-model:free/.test(gateRun.stdout) && /SKIPPED vendor\/missing-model:free/.test(gateRun.stdout) && /TESTED {1,2}vendor\/stub-model:free/.test(gateRun.stdout) && /paid OpenRouter requests intentionally made: 0/.test(gateRun.stdout), gateRun.stdout.slice(-600));
  check("every per-question record carries the model id and pricing status", gateReport.targets[0].results.every((r) => r.modelId === "vendor/stub-model:free" && r.pricingStatus === "free_verified" && "httpStatus" in r));
  await gateStub.close();

  const downStub = await startStub((b, r, res) => reply(res, 200, {}));
  const downUrl = downStub.baseUrl;
  await downStub.close();
  const downRun = spawnSync(process.execPath, [path.join(__dirname, "eval-nlu-models.js"), "--models=vendor/stub-model:free", "--no-claude", "--limit=2"], { cwd: __dirname, encoding: "utf8", timeout: 120000, env: { ...process.env, OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: downUrl, ANTHROPIC_API_KEY: "", OPENROUTER_EVAL_MODELS: "" } });
  check("an unreachable catalogue means prices cannot be verified: no OpenRouter request is made and the run stops", downRun.status === 2 && /UNREACHABLE/.test(downRun.stdout) && /Nothing can be run/.test(downRun.stdout), downRun.stdout.slice(-300));

  fs.rmSync(tmp, { recursive: true, force: true });

  // ------------------------------------------------------------------------------------------ G3. prompt ablations (evaluation only)
  section("G3. prompt ablations: one change each, never silent, never in production");
  {
    // The registry is empty: the ablations of the 77-call experiment are now part of the prompt. The mechanism is tested with a
    // test-only entry that is registered here and removed again.
    const ab = require("./eval/promptAblations");
    const TARGET = "Never answer in prose. ";
    ab.ABLATIONS["test-only-remove-prose-sentence"] = { description: "test only", apply: (text) => text.replace(TARGET, "") };
    try {
      const original = getPlannerPrompt().system[0].text;
      const request = { system: getPlannerPrompt().system, messages: [{ role: "user", content: "x" }], tools: [getPlannerPrompt().tool], tool_choice: { type: "tool", name: PLANNER_TOOL_NAME }, max_tokens: PLANNER_MAX_TOKENS };
      const NAME = "test-only-remove-prose-sentence";
      const changed = ab.ablateRequest(NAME, request);
      check("an ablation changes the system text exactly as defined and nothing else in it", changed.system[0].text === original.replace(TARGET, "") && original.includes(TARGET));
      check("only the system text changes: tools, messages, tool_choice, max_tokens and cache_control are untouched, and the input request is not mutated", eq(changed.tools, request.tools) && eq(changed.messages, request.messages) && eq(changed.tool_choice, request.tool_choice) && changed.max_tokens === request.max_tokens && changed.system[0].cache_control.type === "ephemeral" && request.system[0].text === original);
      let twice = null;
      try {
        ab.ablateRequest(NAME, changed);
      } catch (e) {
        twice = e.message;
      }
      check("an ablation that changes nothing (its target is not in the prompt) throws instead of silently measuring the unmodified prompt", /did not change the prompt/.test(twice || ""), twice);
      let unknown = null;
      try {
        ab.ablateRequest("nope", request);
      } catch (e) {
        unknown = e.message;
      }
      check("an unknown ablation name throws and lists the known names", /unknown ablation "nope"/.test(unknown || "") && unknown.includes(NAME));
      let seen = null;
      await ab.withAblation(async (req, opts) => { seen = { req, opts }; return { ok: true }; }, NAME)(request, { signal: "s" });
      check("withAblation hands the ablated request and the original options to the real client", seen && !seen.req.system[0].text.includes(TARGET) && seen.opts.signal === "s");
      const f = (extra) => runner.configFingerprint({ provider: "claude", model: "m", ...extra });
      check("each ablation has its own configuration fingerprint (cache entries are never shared with another prompt)", new Set([f({}), f({ ablation: NAME }), f({ ablation: "another-ablation" })]).size === 3);
    } finally {
      delete ab.ABLATIONS["test-only-remove-prose-sentence"];
    }
    check("no ablation is registered in the product: the experiments' prompt changes are part of the prompt now", Object.keys(ab.ABLATIONS).length === 0);

    const cli = (...argv) => spawnSync(process.execPath, [path.join(__dirname, "eval-nlu-models.js"), ...argv], { cwd: __dirname, encoding: "utf8", timeout: 60000, env: { ...process.env, ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "", OPENROUTER_EVAL_MODELS: "", OPENROUTER_BASE_URL: "http://127.0.0.1:1/v1" } });
    const bad = cli("--models=claude", "--ablate=nope", "--all", "--dry-run");
    check("the CLI refuses an unknown --ablate name before any call", bad.status === 2 && /Unknown --ablate "nope"/.test(bad.stdout), bad.stdout);
    const mixed = cli("--models=vendor/x:free", "--ablate=anything", "--all", "--dry-run");
    check("--ablate is Claude-only: refused with an OpenRouter model, before any call", mixed.status === 2 && /applies to the Claude planner alone/.test(mixed.stdout), mixed.stdout);
    const dry = cli("--models=claude", "--all", "--ids=nl_0001,nl_0002", "--dry-run");
    check("--models=claude --all --ids=... selects exactly those rows and (dry run) calls nothing", dry.status === 0 && /1 model\(s\) x 2 question/.test(dry.stdout) && /nothing was called/.test(dry.stdout), dry.stdout);
  }

  // ------------------------------------------------------------------------------------------ H. production safety
  section("H. production is unchanged and cannot reach OpenRouter");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const prodFiles = [...walk(path.join(__dirname, "src")), path.join(__dirname, "server.js")].filter((f) => f.endsWith(".js"));
  const offenders = prodFiles.filter((f) => /openrouter|eval\/openRouterClient|nluModelRunner|promptAblations/i.test(fs.readFileSync(f, "utf8")));
  check(`no production file (${prodFiles.length} under src/ and server.js) mentions OpenRouter or imports the evaluation client`, offenders.length === 0, offenders.join(","));
  const qc = fs.readFileSync(path.join(__dirname, "src", "services", "query", "queryChat.js"), "utf8");
  check("Ask AI still builds its planner client with createAnthropicPlannerClient and nothing else", /createAnthropicPlannerClient/.test(qc) && !/createOpenRouter|process\.env\.[A-Z_]*PROVIDER/.test(qc));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  check("no new runtime dependency was added (OpenRouter is plain fetch)", !Object.keys(pkg.dependencies).some((d) => /openrouter|openai/i.test(d)) && !Object.keys(pkg.devDependencies || {}).some((d) => /openrouter|openai/i.test(d)));
  check("the planner's production defaults are unchanged: forced tool, 700 tokens, 15s attempt / 30s deadline", PLANNER_MAX_TOKENS === 700 && require("./src/services/query/planner").PLANNER_ATTEMPT_TIMEOUT_MS === 15000 && require("./src/services/query/planner").PLANNER_DEADLINE_MS === 30000 && getPlannerPrompt().tool.name === PLANNER_TOOL_NAME);
  const evalSources = ["eval/openRouterClient.js", "eval/nluModelRunner.js", "eval/nluScoring.js", "eval-nlu-models.js"].map((f) => [f, fs.readFileSync(path.join(__dirname, f), "utf8")]);
  check("the evaluation code never logs headers, keys, requests or raw provider bodies", evalSources.every(([f, src]) => !/console\.(log|error|warn|info)\([^)]*(apiKey|Authorization|headers|body|request\b)/.test(src.replace(/\/\/.*$/gm, ""))), evalSources.map(([f]) => f).join(","));
  check("no key-shaped literal in any evaluation source", evalSources.every(([f, src]) => !/sk-or-v1-[A-Za-z0-9]{8,}/.test(src)));
  const gitignore = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
  check(".gitignore covers .env files, evaluation results and the response cache", /^\.env$/m.test(gitignore) && /backend\/eval\/results\//.test(gitignore) && /backend\/eval\/\.cache\//.test(gitignore));
  const envExample = fs.readFileSync(path.join(__dirname, ".env.example"), "utf8");
  check(".env.example documents the OpenRouter variables with placeholders only", /OPENROUTER_API_KEY=<[^>]+>/.test(envExample) && /OPENROUTER_EVAL_MODELS/.test(envExample) && /NLU_EVAL_CONCURRENCY/.test(envExample) && !/sk-or-/.test(envExample));
  const ci = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  check("CI runs this suite (the OpenRouter evaluation itself is manual and never runs in CI)", /verify-openrouter-eval\.js/.test(ci) && !/eval-nlu-models\.js/.test(ci));

  console.log(`\nverify-openrouter-eval: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
