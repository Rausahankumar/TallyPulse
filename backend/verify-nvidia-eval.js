/**
 * Offline tests of the evaluation-only NVIDIA client (eval/nvidiaClient.js) and its CLI wiring.
 *
 * No network: every request goes to a local stub server on 127.0.0.1; any other fetch throws. No API key is read from
 * backend/.env (a synthetic marker key is used). Covers: the reproducible reasoning switch (--nvidia-thinking / NVIDIA_THINKING),
 * requested vs verified structured output, redaction of everything persisted or thrown, and isolation from OpenRouter.
 *
 * Run: node verify-nvidia-eval.js
 */
"use strict";

const http = require("http");
const path = require("path");
const { spawnSync } = require("child_process");
const nv = require("./eval/nvidiaClient");
const or = require("./eval/openRouterClient");
const runner = require("./eval/nluModelRunner");
const { getPlannerPrompt } = require("./src/services/query/planner");

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${detail})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);

// Synthetic markers only - none of these is a real credential or real business data.
const FAKE_KEY = "nvapi-SYNTHETICTESTKEY0000000000000000";
const FAKE_OR_KEY = "sk-or-v1-SYNTHETICOPENROUTERKEY000000";
const FAKE_PASSWORD = "SyntheticPassw0rd!";
const FAKE_URI = "mongodb+srv://synthuser:SyntheticSecret99@cluster0.example.net/db";
const prompt = getPlannerPrompt();
const request = (q = "Total sales in August 2025") => ({ system: prompt.system, messages: [{ role: "user", content: q }], tools: [prompt.tool], tool_choice: { type: "tool", name: prompt.tool.name }, max_tokens: 700 });
const allSecrets = [FAKE_KEY, FAKE_OR_KEY, FAKE_PASSWORD, "SyntheticSecret99"];
const leaks = (text) => allSecrets.filter((s) => String(text).includes(s));

// Only loopback is reachable during this suite.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  if (!/^http:\/\/127\.0\.0\.1:/.test(String(url))) throw new Error(`network disabled in verify-nvidia-eval (${String(url).slice(0, 40)})`);
  return realFetch(url, opts);
};

let mode = "plan";
let hits = 0;
let lastBody = null;
const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    hits += 1;
    lastBody = data ? JSON.parse(data) : null;
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (mode === "401-pad") return send(401, { detail: `${"y".repeat(195)} ${FAKE_KEY}` });
    if (mode === "401-echo") return send(401, { detail: `Authorization: Bearer ${FAKE_KEY} rejected; password=${FAKE_PASSWORD}` });
    if (mode === "429") return send(429, { detail: "Too many requests" });
    if (mode === "secrets-in-body") return send(200, { model: "nvidia/m", choices: [{ finish_reason: "stop", message: { role: "assistant", content: `{"plan": {"v": 1}} key ${FAKE_KEY} uri ${FAKE_URI} token=${FAKE_OR_KEY}` } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    // the known smoke case: correct shape, wrong content (fiscal year instead of August, no metric)
    return send(200, { model: "nvidia/nemotron-3-super-120b-a12b", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ plan: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "specific_fy", fy: "2025-26" }, metrics: [], groupBy: [], sort: [], limit: 100, totals: true, explain: "none" } }) } }], usage: { prompt_tokens: 1173, completion_tokens: 82, total_tokens: 1255 } });
  });
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const raws = [];
  const client = (extra = {}) => nv.createNvidiaPlannerClient({ evalOnly: true, model: "nvidia/nemotron-3-super-120b-a12b", apiKey: FAKE_KEY, baseUrl, structuredMode: "json_schema", maxRetries: 0, sleep: async () => {}, rawSink: (e) => raws.push(e), ...extra });

  try {
    section("A. Reasoning switch: --nvidia-thinking > NVIDIA_THINKING > provider default");
    {
      const off = nv.resolveNvidiaThinking({ env: "off" });
      check("NVIDIA_THINKING=off -> enable_thinking false", off.setting === "off" && off.source === "env" && off.chatTemplateKwargs.enable_thinking === false);
      const on = nv.resolveNvidiaThinking({ cli: "ON" });
      check("--nvidia-thinking=ON (case-insensitive) -> enable_thinking true", on.setting === "on" && on.source === "cli" && on.chatTemplateKwargs.enable_thinking === true);
      const prec = nv.resolveNvidiaThinking({ cli: "on", env: "off" });
      check("the CLI value wins over the environment", prec.setting === "on" && prec.source === "cli");
      const dflt = nv.resolveNvidiaThinking({});
      check("unset -> provider default, nothing to send", dflt.setting === "provider_default" && dflt.source === "default" && dflt.chatTemplateKwargs === null);
      for (const bad of ["false", "0", "disabled", "of f"]) {
        let code = null;
        try { nv.resolveNvidiaThinking({ env: bad }); } catch (e) { code = e.code; }
        check(`invalid NVIDIA_THINKING "${bad}" is refused`, code === "NVIDIA_BAD_CONFIG");
      }
      const offBody = nv.buildRequestBody(request(), { model: "nvidia/m", structuredMode: "json_schema", chatTemplateKwargs: off.chatTemplateKwargs });
      check("off -> request carries chat_template_kwargs {enable_thinking:false}", JSON.stringify(offBody.chat_template_kwargs) === '{"enable_thinking":false}');
      const defBody = nv.buildRequestBody(request(), { model: "nvidia/m", structuredMode: "json_schema" });
      check("default -> no chat_template_kwargs in the request", !("chat_template_kwargs" in defBody));
      const c = client({ thinking: off });
      check("describe() records the effective thinking setting", c.describe().thinking === "off" && c.describe().chatTemplateKwargs.enable_thinking === false);
      check("describe() of a default client says provider_default", client().describe().thinking === "provider_default");
      await c(request(), { meta: {} });
      check("the stub received enable_thinking:false", lastBody && lastBody.chat_template_kwargs && lastBody.chat_template_kwargs.enable_thinking === false);
    }

    section("B. Isolation from OpenRouter");
    {
      process.env.NVIDIA_THINKING = "off";
      const orBody = or.buildRequestBody(request(), { model: "vendor/model:free", structuredMode: "json_schema", freeOnly: true });
      check("OpenRouter request never carries chat_template_kwargs, even with NVIDIA_THINKING set", !("chat_template_kwargs" in orBody) && !("stream" in orBody));
      check("OpenRouter request keeps its free-only provider block", orBody.provider && orBody.provider.allow_fallbacks === false && orBody.provider.max_price && orBody.provider.max_price.prompt === 0);
      delete process.env.NVIDIA_THINKING;
      const specs = runner.parseModelSpecs("vendor/model-a:free,openrouter:vendor/model-b:free,nvidia:nvidia/nemotron-3-super-120b-a12b,claude");
      check("bare id -> OpenRouter (unchanged)", specs[0].provider === "openrouter" && specs[0].model === "vendor/model-a:free");
      check("openrouter: prefix -> OpenRouter (unchanged)", specs[1].provider === "openrouter" && specs[1].model === "vendor/model-b:free");
      check("nvidia: prefix -> NVIDIA only", specs[2].provider === "nvidia" && specs[2].model === "nvidia/nemotron-3-super-120b-a12b");
      check("claude unchanged", specs[3].provider === "claude");
      const nvBody = nv.buildRequestBody(request(), { model: "nvidia/m", structuredMode: "tool" });
      check("NVIDIA request has no OpenRouter-only fields (provider, usage)", !("provider" in nvBody) && !("usage" in nvBody));
    }

    section("C. Requested structured output vs verified enforcement (the known smoke case)");
    {
      const c = client({ thinking: nv.resolveNvidiaThinking({ env: "off" }) });
      check("enforcement is 'unverified' in describe()", c.describe().schemaEnforcementByProvider === "unverified");
      // run the smoke case through the UNCHANGED production planner and the eval scorer
      const scoring = require("./eval/nluScoring");
      const row = (scoring.corpus.rows || scoring.corpus).find((r) => r.question === "Total sales in August 2025");
      mode = "plan";
      const rec = await runner.evaluateRow({ row, target: { model: "nvidia/nemotron-3-super-120b-a12b", client: c }, resolver: scoring.makeResolver(), cache: null });
      check("provider accepted (HTTP 200)", rec.httpStatus === 200);
      check("reply was parseable JSON (no malformedReason)", !rec.malformedReason);
      check("the existing schema check rejected it (aggregate needs a metric)", /planner_invalid_plan/.test(String(rec.plannerStatus)) && rec.outcome === "validator_rejected", `${rec.plannerStatus} ${rec.outcome}`);
      const s = nv.structuredOutputSummary([rec], c.describe());
      check("ladder: accepted 1, parseable 1, protocol 1, schema+validator 0", s.providerAccepted === 1 && s.parseableJson === 1 && s.passedPlannerProtocol === 1 && s.passedSchemaAndValidator === 0, JSON.stringify(s));
      check("ladder never claims enforcement", s.schemaEnforcementByProvider.status === "unverified" && s.requestedOutputMode === "json_schema" && s.thinking === "off");
      check("semantic counts stay separate (0 exact)", s.semantic.exact === 0);
      const synthetic = [
        { outcome: "plan_correct", httpStatus: 200, plannerStatus: "supported" },
        { outcome: "malformed_output", httpStatus: 200, malformedReason: "content_not_a_json_object", plannerStatus: "planner_failed/planner_protocol_violation" },
        { outcome: "malformed_output", httpStatus: 200, plannerStatus: "planner_failed/planner_protocol_violation" },
        { outcome: "timeout", httpStatus: undefined, plannerStatus: "planner_failed/planner_timeout" },
        { outcome: "correct_refusal", httpStatus: 200, plannerStatus: "unsupported/planner_out_of_scope" },
        { outcome: "refusal_kind_differs", httpStatus: 200, plannerStatus: "needs_clarification/planner_needs_clarification" },
        { outcome: "skipped" },
      ];
      const s2 = nv.structuredOutputSummary(synthetic, { structuredMode: "json_schema" });
      check("ladder on synthetic rows: rows 6, accepted 5, parseable 4, protocol 3, schema 1", s2.rows === 6 && s2.providerAccepted === 5 && s2.parseableJson === 4 && s2.passedPlannerProtocol === 3 && s2.passedSchemaAndValidator === 1, JSON.stringify(s2));
      check("refusals/clarifications are never schema+validator passes; counted separately", s2.refusedWithoutPlan === 2 && s2.passedSchemaAndValidator === 1, JSON.stringify(s2));
    }

    section("D. Redaction: nothing persisted or thrown carries a secret");
    {
      const red = nv.makeRedactor(FAKE_KEY);
      const text = `Authorization: Bearer ${FAKE_KEY} ${FAKE_OR_KEY} ${FAKE_URI} password=${FAKE_PASSWORD} "api_key": "${FAKE_PASSWORD}"`;
      check("redactor removes keys, bearer, URI credentials and password pairs", leaks(red(text)).length === 0, leaks(red(text)).join(","));
      check("redactor keeps token-count fields readable", red('"total_tokens": 1255, "prompt_tokens": 1173').includes("1255") && red('"total_tokens": 1255').includes("total_tokens"));
      raws.length = 0;
      mode = "secrets-in-body";
      await client()(request(`sales question with ${FAKE_KEY} pasted in`), { meta: {} });
      const persisted = JSON.stringify(raws);
      check("raw entry: no secret in body or question", leaks(persisted).length === 0, leaks(persisted).join(","));
      check("raw entry: no system prompt or headers persisted", !persisted.includes(prompt.system[0].text.slice(0, 60)) && !/authorization/i.test(Object.keys(raws[0]).join(",")));
      check("raw entry: records thinking and 'unverified' enforcement", raws[0].thinking === "provider_default" && raws[0].schemaEnforcementByProvider === "unverified");
      // a secret straddling the 200-char cut must not survive as a fragment (redaction runs before truncation)
      raws.length = 0;
      mode = "plan";
      const pad = "x".repeat(195);
      await client()(request(`${pad} ${FAKE_KEY}`), { meta: {} });
      check("question: key across the 200-char cut leaves no fragment", !raws[0].question.includes(FAKE_KEY.slice(0, 10)) && raws[0].question.length <= 200, raws[0].question.slice(-30));
      mode = "401-pad";
      let ePad = null;
      try { await client()(request(), { meta: {} }); } catch (e) { ePad = e; }
      check("error detail: key across the 200-char cut leaves no fragment", ePad && ePad.code === "NVIDIA_AUTH" && !ePad.message.includes(FAKE_KEY.slice(0, 10)), ePad && ePad.message.slice(-40));
      mode = "401-echo";
      raws.length = 0;
      let err = null;
      try { await client()(request(), { meta: {} }); } catch (e) { err = e; }
      check("401 echoing the key -> NVIDIA_AUTH, message redacted", err && err.code === "NVIDIA_AUTH" && leaks(err.message).length === 0, err && err.message);
      check("401 raw body redacted", raws.length === 1 && leaks(raws[0].body).length === 0);
      check("thrown error carries no headers or key properties", err && !("headers" in err) && leaks(JSON.stringify(Object.assign({}, err))).length === 0);
      mode = "429";
      hits = 0;
      let e429 = null;
      try { await client({ maxRetries: 1 })(request(), { meta: {} }); } catch (e) { e429 = e; }
      check("429 is reported once, never retried", e429 && e429.code === "NVIDIA_RATE_LIMITED" && hits === 1, `hits=${hits}`);
    }

    section("E. CLI: an invalid NVIDIA_THINKING stops before any request");
    {
      const r = spawnSync(process.execPath, [path.join(__dirname, "eval-nlu-models.js"), "--models=nvidia:nvidia/nemotron-3-super-120b-a12b", "--no-claude", "--limit=1", "--dry-run"], { env: { ...process.env, NVIDIA_THINKING: "maybe", NVIDIA_API_KEY: "", OPENROUTER_API_KEY: "" }, encoding: "utf8", timeout: 60000 });
      const out = `${r.stdout || ""}${r.stderr || ""}`;
      check("CLI refuses NVIDIA_THINKING=maybe and calls nothing", /NVIDIA thinking must be "on" or "off"/.test(out) && /Nothing was called/.test(out) && !/Catalog check/.test(out), out.slice(-200));
    }
  } catch (error) {
    fail += 1;
    console.log("  FAIL - unexpected error:", error && error.stack);
  } finally {
    server.close();
  }
  console.log(`\nverify-nvidia-eval: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
