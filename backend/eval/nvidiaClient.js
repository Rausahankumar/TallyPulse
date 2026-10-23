"use strict";

/**
 * NVIDIA API Catalog adapter for the planner's model seam - EVALUATION ONLY. Nothing under src/ requires this file: the
 * production Ask AI path never reaches NVIDIA.
 *
 * Same seam as eval/openRouterClient.js: claudeClient(request, { signal, meta }) -> an Anthropic-shaped response
 * ({ content: [{ type: "tool_use", name, input }], usage }). The request is sent to NVIDIA's hosted, OpenAI-compatible
 * endpoint (official API reference for nvidia/nemotron-3-super-120b-a12b: POST https://integrate.api.nvidia.com/v1/chat/completions,
 * "Authorization: Bearer $NVIDIA_API_KEY"). The response is normalised by openRouterClient's parseCompletion, unchanged, so
 * both providers are judged through the identical mapping.
 *
 *   - structuredMode "tool"        the planner's tool is sent as a function and forced with tool_choice (tools/tool_choice
 *                                  are used by NVIDIA's own request templates for this model).
 *   - structuredMode "json_schema" response_format json_schema with the planner's schema. NOT documented for this hosted
 *                                  endpoint: whether it is accepted or enforced is unverified, and every result says so.
 *
 * Billing: hosted calls draw on NVIDIA API trial credits. No price or cost is reported per request, so nothing here can prove
 * a request is free; the CLI only calls NVIDIA after an explicit --allow-nvidia-trial. There is no fallback to any other
 * provider or model. 401/402/403/404/422/429 and 202 ("pending, poll") are never retried; the runner halts a model refused
 * three times in a row.
 *
 * The key is read lazily from NVIDIA_API_KEY, goes only into the Authorization header and is redacted from every message.
 * The raw response body (before any parsing) is handed to options.rawSink, redacted, for the evaluation's own records.
 */

const { parseCompletion } = require("./openRouterClient");

const DEFAULTS = {
  baseUrl: "https://integrate.api.nvidia.com/v1",
  attemptTimeoutMs: 30000,
  deadlineMs: 60000,
  maxRetries: 1,
};
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]); // never 429: a rate limit is reported, not retried in a loop
const BACKOFF_MS = 1000;
const SCHEMA_NAME = "query_plan_submission";
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FORMAT_INSTRUCTION = "Output format: reply with ONE JSON object and nothing else - the input you would pass to submit_query_plan ({\"plan\": ...} or {\"decline\": ...}).";
const SAMPLE_CHARS = 200;
const RAW_CHARS = 20000;

// Whether NVIDIA enforces response_format/json_schema for this hosted model is NOT documented in its API reference (the
// request schema lists no response_format), so the evaluation never claims it: requested != verified.
const SCHEMA_ENFORCEMENT = { status: "unverified", reason: "response_format is not documented for this hosted endpoint; HTTP 200 and a parseable reply do not prove the schema was enforced" };

function evalError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}
const sample = (text) => String(text).replace(/\s+/g, " ").trim().slice(0, SAMPLE_CHARS);
// Secret shapes removed from everything this client persists or throws, on top of the exact key: NVIDIA/OpenRouter/Anthropic
// keys, bearer tokens, Authorization headers, credentials inside connection strings, password/secret/token key-value pairs.
const SECRET_PATTERNS = [
  [/nvapi-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/sk-(?:or-v1|ant)-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',}]{8,}/gi, "$1[redacted]"],
  [/bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [redacted]"],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s:@/"']+:[^\s@/"']+@/gi, "$1[redacted]@"],
  [/((?:password|passwd|pwd|secret|api[_-]?key|token)["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, "$1[redacted]"],
];
function makeRedactor(apiKey) {
  return (text) => {
    let out = String(text == null ? "" : text);
    if (apiKey) out = out.split(apiKey).join("[redacted]");
    for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
    return out;
  };
}

/**
 * The reasoning switch, reproducibly: CLI value (--nvidia-thinking) wins over NVIDIA_THINKING, which wins over the default
 * (send nothing: the provider's own default, reasoning ON for this model). Only "on"/"off" are accepted; anything else throws.
 */
function resolveNvidiaThinking({ cli = null, env = null } = {}) {
  const pick = cli !== null && cli !== undefined && cli !== "" ? { raw: cli, source: "cli" } : env !== null && env !== undefined && env !== "" ? { raw: env, source: "env" } : null;
  if (!pick) return { setting: "provider_default", source: "default", chatTemplateKwargs: null };
  const v = String(pick.raw).trim().toLowerCase();
  if (v !== "on" && v !== "off") throw evalError("NVIDIA_BAD_CONFIG", `NVIDIA thinking must be "on" or "off" (got an invalid value from ${pick.source === "cli" ? "--nvidia-thinking" : "NVIDIA_THINKING"}).`);
  return { setting: v, source: pick.source, chatTemplateKwargs: { enable_thinking: v === "on" } };
}

/**
 * Per-row evidence ladder for structured output, from the runner's records (no new judgement): each step only counts rows
 * that passed the step before it. Provider enforcement is never inferred from these counts.
 */
function structuredOutputSummary(records, settings = {}) {
  const rows = (records || []).filter((r) => r && r.outcome !== "skipped");
  const status = (r) => String(r.plannerStatus || "");
  const accepted = rows.filter((r) => r.httpStatus === 200);
  const parseable = accepted.filter((r) => !r.malformedReason);
  const protocol = parseable.filter((r) => !/planner_protocol_violation/.test(status(r)));
  // Only a plan the planner accepted (status "supported") went through schema + validator successfully. A refusal or a
  // clarification carries no validated plan, so it is counted separately and never as a schema/validator pass.
  const schema = protocol.filter((r) => /^supported(\/|$)/.test(status(r)));
  const refusedWithoutPlan = protocol.filter((r) => /^(unsupported|needs_clarification)(\/|$)/.test(status(r)));
  const count = (o) => rows.filter((r) => r.outcome === o).length;
  return {
    requestedOutputMode: settings.structuredMode || null,
    thinking: settings.thinking || null,
    schemaEnforcementByProvider: SCHEMA_ENFORCEMENT,
    rows: rows.length,
    providerAccepted: accepted.length,
    parseableJson: parseable.length,
    passedPlannerProtocol: protocol.length,
    passedSchemaAndValidator: schema.length,
    refusedWithoutPlan: refusedWithoutPlan.length,
    semantic: { exact: count("plan_correct"), imprecise: count("plan_imprecise"), correctRefusal: count("correct_refusal"), wrongButExecutable: count("wrong_but_executable"), falseRefusal: count("false_refusal"), refusalKindDiffers: count("refusal_kind_differs") },
  };
}
function systemText(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((b) => (b && typeof b.text === "string" ? b.text : "")).filter(Boolean).join("\n\n");
  return "";
}

function buildRequestBody(request, config) {
  if (!request || typeof request !== "object") throw evalError("NVIDIA_BAD_REQUEST", "A planner request is required.");
  const mode = config.structuredMode;
  const messages = [];
  let system = systemText(request.system);
  if (mode === "json_schema") system = [system, FORMAT_INSTRUCTION].filter(Boolean).join("\n\n");
  if (system) messages.push({ role: "system", content: system });
  for (const message of request.messages || []) {
    if (!message || typeof message.content !== "string") throw evalError("NVIDIA_BAD_REQUEST", "Only plain-text messages are supported (the evaluation uses no repair rounds).");
    messages.push({ role: message.role, content: message.content });
  }
  const tool = (request.tools || [])[0];
  if (!tool || !request.tool_choice || request.tool_choice.name !== tool.name) throw evalError("NVIDIA_BAD_REQUEST", "The planner request must carry exactly its forced tool.");
  const body = {
    model: config.model, // one explicit model id, no fallback list
    messages,
    temperature: 0, // as in the OpenRouter evaluation, for a like-for-like comparison
    max_tokens: config.maxTokens || request.max_tokens,
    stream: false, // the endpoint streams by default
  };
  // e.g. { enable_thinking: false } - the documented reasoning switch for this model (sent only when set; default = provider's)
  if (config.chatTemplateKwargs) body.chat_template_kwargs = config.chatTemplateKwargs;
  if (mode === "tool") {
    body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    body.tool_choice = { type: "function", function: { name: request.tool_choice.name } };
  } else if (mode === "json_schema") {
    body.response_format = { type: "json_schema", json_schema: { name: SCHEMA_NAME, strict: false, schema: tool.input_schema } };
  } else {
    throw evalError("NVIDIA_BAD_REQUEST", `Unknown structured mode "${mode}".`);
  }
  return body;
}

function httpError(status, text, redact) {
  let detail = "";
  try {
    const parsed = JSON.parse(text);
    const m = parsed && (parsed.detail || (parsed.error && parsed.error.message) || parsed.title || parsed.message);
    if (typeof m === "string") detail = m;
  } catch (e) {
    /* not JSON: no detail */
  }
  const code = status === 401 || status === 403 ? "NVIDIA_AUTH" : status === 402 ? "NVIDIA_CREDITS" : status === 404 ? "NVIDIA_NO_MODEL" : status === 422 ? "NVIDIA_REJECTED_REQUEST" : status === 429 ? "NVIDIA_RATE_LIMITED" : "NVIDIA_HTTP";
  // redact BEFORE the 200-char cut, so a secret straddling the cut cannot survive as a fragment
  return evalError(code, redact(`NVIDIA HTTP ${status}${detail ? `: ${sample(redact(detail))}` : ""}`), { status, kind: "http", retryable: RETRYABLE_STATUS.has(status) });
}

async function postOnce({ url, headers, body, limitMs, signal, fetchImpl, redact, onRaw }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limitMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const started = Date.now();
  try {
    let response;
    let text;
    try {
      response = await fetchImpl(url, { method: "POST", headers, body, signal: controller.signal });
      text = await response.text();
    } catch (e) {
      if (timedOut) throw evalError("PLANNER_DEADLINE_EXCEEDED", `NVIDIA request timed out after ${limitMs}ms.`, { kind: "timeout" });
      if (signal && signal.aborted) throw evalError("ABORTED", "The request was aborted.", { kind: "aborted" });
      throw evalError("NVIDIA_NETWORK", redact(`Network error${e && e.cause && e.cause.code ? ` (${e.cause.code})` : ""}.`), { kind: "network", retryable: true });
    }
    onRaw({ httpStatus: response.status, latencyMs: Date.now() - started, body: redact(text).slice(0, RAW_CHARS) });
    if (response.status === 202) throw evalError("NVIDIA_PENDING", "NVIDIA answered 202 (result pending, poll by request id): not polled in this evaluation.", { status: 202, kind: "http" });
    if (!response.ok) throw httpError(response.status, text, redact);
    try {
      return JSON.parse(text);
    } catch (e) {
      throw evalError("NVIDIA_BAD_RESPONSE", "NVIDIA returned a response that is not JSON.", { kind: "http", status: response.status });
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {true}   options.evalOnly                 required: never part of the production path
 * @param {string} options.model                    NVIDIA API Catalog model id, e.g. "nvidia/nemotron-3-super-120b-a12b"
 * @param {"tool"|"json_schema"} [options.structuredMode="tool"]
 * @param {number} [options.maxTokens]              overrides the planner's max_tokens (recorded in describe())
 * @param {number} [options.attemptTimeoutMs], [options.deadlineMs], [options.maxRetries]
 * @param {object} [options.chatTemplateKwargs]     sent as chat_template_kwargs, e.g. { enable_thinking: false }
 * @param {Function} [options.rawSink]              ({ question, attempt, httpStatus, latencyMs, body }) => void, body redacted
 * @param {string} [options.apiKey], [options.baseUrl], [options.fetchImpl], [options.sleep]  injectable for tests
 */
function createNvidiaPlannerClient(options = {}) {
  if (options.evalOnly !== true) throw evalError("NVIDIA_EVAL_ONLY", "The NVIDIA client is evaluation-only: pass evalOnly: true. It is not part of the production Ask AI path.");
  const model = typeof options.model === "string" ? options.model.trim() : "";
  if (!MODEL_ID.test(model)) throw evalError("NVIDIA_BAD_MODEL", "An NVIDIA model id like \"nvidia/model-name\" is required.");
  const structuredMode = options.structuredMode || "tool";
  if (!["tool", "json_schema"].includes(structuredMode)) throw evalError("NVIDIA_BAD_REQUEST", `Unknown structured mode "${structuredMode}".`);
  const config = {
    model,
    structuredMode,
    maxTokens: Number.isInteger(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : null,
    attemptTimeoutMs: options.attemptTimeoutMs || DEFAULTS.attemptTimeoutMs,
    deadlineMs: options.deadlineMs || DEFAULTS.deadlineMs,
    maxRetries: Number.isInteger(options.maxRetries) && options.maxRetries >= 0 ? options.maxRetries : DEFAULTS.maxRetries,
    chatTemplateKwargs: options.chatTemplateKwargs && typeof options.chatTemplateKwargs === "object" ? { ...options.chatTemplateKwargs } : null,
    thinking: "provider_default",
  };
  if (options.thinking) {
    // the resolved --nvidia-thinking / NVIDIA_THINKING setting (resolveNvidiaThinking); it decides chat_template_kwargs
    config.thinking = options.thinking.setting;
    config.chatTemplateKwargs = options.thinking.chatTemplateKwargs ? { ...options.thinking.chatTemplateKwargs } : null;
  } else if (config.chatTemplateKwargs && typeof config.chatTemplateKwargs.enable_thinking === "boolean") {
    config.thinking = config.chatTemplateKwargs.enable_thinking ? "on" : "off";
  }
  const baseUrl = String(options.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || defaultSleep;
  const rawSink = typeof options.rawSink === "function" ? options.rawSink : null;

  async function nvidiaPlannerClient(request, callOptions = {}) {
    const meta = callOptions.meta || {};
    const apiKey = options.apiKey || process.env.NVIDIA_API_KEY;
    if (!apiKey) throw evalError("NVIDIA_NOT_CONFIGURED", "NVIDIA is not configured: NVIDIA_API_KEY is missing.");
    const redact = makeRedactor(apiKey);
    const body = JSON.stringify(buildRequestBody(request, config));
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
    const question = sample(redact(((request.messages || []).slice(-1)[0] || {}).content || "")); // redact, then cut
    const started = Date.now();
    meta.attempts = 0;
    meta.retries = 0;
    let lastError = null;
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      const remaining = config.deadlineMs - (Date.now() - started);
      if (remaining <= 0) break;
      meta.attempts = attempt + 1;
      // Persisted fields only: the synthetic question sample, request settings, status, latency and the redacted response body.
      // Never the system prompt, the headers or the key.
      const onRaw = (raw) => { if (rawSink) rawSink({ question: redact(question), attempt: attempt + 1, model: config.model, structuredMode: config.structuredMode, thinking: config.thinking, schemaEnforcementByProvider: SCHEMA_ENFORCEMENT.status, httpStatus: raw.httpStatus, latencyMs: raw.latencyMs, body: redact(raw.body) }); };
      try {
        const json = await postOnce({ url: `${baseUrl}/chat/completions`, headers, body, limitMs: Math.min(config.attemptTimeoutMs, remaining), signal: callOptions.signal || null, fetchImpl, redact, onRaw });
        meta.httpStatus = 200;
        const mapped = parseCompletion(json, request, config, meta); // the same normalisation the OpenRouter evaluation used
        if (meta.servedModel && meta.servedModel !== config.model) meta.servedModelMismatch = true;
        return mapped;
      } catch (error) {
        lastError = error;
        if (error && error.status) meta.httpStatus = error.status;
        if (!error || !error.retryable || attempt === config.maxRetries) break;
        if (Date.now() - started + BACKOFF_MS >= config.deadlineMs) break;
        meta.retries += 1;
        (meta.retryReasons || (meta.retryReasons = [])).push(error.status || error.code || "error");
        await sleep(BACKOFF_MS);
      }
    }
    throw lastError || evalError("PLANNER_DEADLINE_EXCEEDED", `NVIDIA request exceeded the ${config.deadlineMs}ms deadline.`, { kind: "timeout" });
  }

  nvidiaPlannerClient.describe = () => ({ provider: "nvidia", model: config.model, structuredMode: config.structuredMode, schemaEnforcementByProvider: SCHEMA_ENFORCEMENT.status, thinking: config.thinking, chatTemplateKwargs: config.chatTemplateKwargs, maxTokens: config.maxTokens, attemptTimeoutMs: config.attemptTimeoutMs, deadlineMs: config.deadlineMs, maxRetries: config.maxRetries, temperature: 0, stream: false, baseUrl });
  return nvidiaPlannerClient;
}

/** The public model list of the API Catalog (no key is sent). Returns { reachable, listed } for the given ids. */
async function fetchNvidiaModels(ids, { fetchImpl = globalThis.fetch, baseUrl = DEFAULTS.baseUrl } = {}) {
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}/models`, { headers: { Accept: "application/json" } });
    if (!response.ok) return { reachable: false, listed: {} };
    const json = await response.json();
    const all = new Set((json.data || []).map((m) => m && m.id).filter(Boolean));
    return { reachable: true, listed: Object.fromEntries(ids.map((id) => [id, all.has(id)])) };
  } catch (e) {
    return { reachable: false, listed: {} };
  }
}

module.exports = { createNvidiaPlannerClient, buildRequestBody, fetchNvidiaModels, makeRedactor, resolveNvidiaThinking, structuredOutputSummary, SCHEMA_ENFORCEMENT, DEFAULTS };
