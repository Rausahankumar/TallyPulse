"use strict";

/**
 * OpenRouter adapter for the planner's client seam - EVALUATION ONLY.
 *
 * The planner (src/services/query/planner.js) talks to its model through ONE seam:
 *     claudeClient(request, { signal }) -> an Anthropic-shaped response
 * where `request` is { system, messages, tools, tool_choice, max_tokens } and the response carries
 * `content: [{type:"tool_use", name, input}]` and `usage`. This adapter implements the same seam on top of OpenRouter's
 * OpenAI-compatible chat-completions API, so planQuestion() runs unchanged - same prompt, same Query Plan contract, same
 * validator, same guards - with a different model behind it. There is no second planner and no second plan format.
 *
 * This file lives in eval/ on purpose: nothing under src/ or server.js imports it, so the production Ask AI path cannot
 * reach OpenRouter. The factory also refuses to build a client unless the caller passes `evalOnly: true`.
 *
 * FREE-ONLY by default (`freeOnly: false` must be passed deliberately; the CLI never does): the model id must be an exact
 * ":free" id (no openrouter/* routers or stealth ids), every request names that one model, forbids provider fallbacks and caps
 * the price at 0, and a response that reports a cost is an error. assessFreeModel() is the pre-flight gate against the live
 * catalogue (every price field must be exactly 0; anything missing, priced or unverifiable is not called).
 *
 * Output handling (never lenient about prose):
 *   - structuredMode "tool"        the planner's tool is sent as a function and forced with tool_choice; the call's
 *                                  arguments must be one JSON object.
 *   - structuredMode "json_schema" no tools; response_format json_schema with the same schema; the message content must be
 *                                  exactly one JSON object (a single ```json fence around it is tolerated and recorded).
 *   Anything else (prose, broken JSON, no tool call, several tool calls) is returned as a text block, which planQuestion
 *   reports as a protocol violation - i.e. "malformed output". It is never turned into a plan.
 *
 * The API key is read lazily from OPENROUTER_API_KEY, goes only into the Authorization header, and is redacted from every
 * error message. Requests and responses are never logged by this module.
 */

const DEFAULTS = {
  baseUrl: "https://openrouter.ai/api/v1",
  attemptTimeoutMs: 30000,
  deadlineMs: 60000,
  maxRetries: 2,
};
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 8000;
const MAX_RETRY_AFTER_MS = 10000;
const SCHEMA_NAME = "query_plan_submission";
// Free-only routing: OpenRouter may only use an endpoint priced at $0 for prompt and completion, and may not fall back to any other
// provider (which could be a paid one). Enforced by OpenRouter itself, on top of this client's own checks.
const FREE_ONLY_PROVIDER = { allow_fallbacks: false, max_price: { prompt: 0, completion: 0 } };
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._~:@+-]*\/[A-Za-z0-9][A-Za-z0-9._~:@+/-]*$/;
const FORMAT_INSTRUCTION = "Output format: reply with ONE JSON object and nothing else - the input you would pass to submit_query_plan ({\"plan\": ...} or {\"decline\": ...}).";

function evalError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  return Object.assign(error, extra);
}

/** Replace the API key (and anything shaped like an OpenRouter key or bearer token) in a piece of text. */
function makeRedactor(apiKey) {
  return (text) => {
    let out = String(text);
    if (apiKey) out = out.split(apiKey).join("[redacted]");
    return out.replace(/sk-or-[A-Za-z0-9_-]{6,}/g, "[redacted]").replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  };
}

// ---------------------------------------------------------------------------------------------- request construction

function systemText(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((block) => (block && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The OpenRouter request body for a planner request. Pure (no key, no network): the same logical input every model gets -
 * the planner's system prompt, the user message, the tool schema - translated to the OpenAI-compatible shape.
 */
function buildRequestBody(request, config) {
  if (!request || typeof request !== "object") throw evalError("OPENROUTER_BAD_REQUEST", "A planner request is required.");
  const mode = config.structuredMode || "tool";
  const messages = [];
  let system = systemText(request.system);
  if (mode === "json_schema") system = [system, FORMAT_INSTRUCTION].filter(Boolean).join("\n\n");
  if (system) messages.push({ role: "system", content: system });
  for (const message of request.messages || []) {
    if (!message || typeof message.content !== "string") throw evalError("OPENROUTER_BAD_REQUEST", "Only plain-text messages are supported (the evaluation uses no repair rounds).");
    messages.push({ role: message.role, content: message.content });
  }
  const tool = (request.tools || [])[0];
  if (!tool || !request.tool_choice || request.tool_choice.name !== tool.name) throw evalError("OPENROUTER_BAD_REQUEST", "The planner request must carry exactly its forced tool.");

  const body = {
    model: config.model, // always one explicit model id: never "openrouter/auto", never a `models` fallback list
    messages,
    temperature: 0,
    max_tokens: config.maxTokens || request.max_tokens,
    provider: { require_parameters: true, ...(config.freeOnly ? FREE_ONLY_PROVIDER : {}), ...(config.provider || {}) },
    usage: { include: true },
  };
  if (config.freeOnly) body.provider = { ...body.provider, ...FREE_ONLY_PROVIDER }; // not overridable by `provider` preferences
  if (mode === "tool") {
    body.tools = (request.tools || []).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    body.tool_choice = { type: "function", function: { name: request.tool_choice.name } };
  } else if (mode === "json_schema") {
    body.response_format = { type: "json_schema", json_schema: { name: SCHEMA_NAME, strict: false, schema: tool.input_schema } };
  } else {
    throw evalError("OPENROUTER_BAD_REQUEST", `Unknown structured mode "${mode}".`);
  }
  return body;
}

// ---------------------------------------------------------------------------------------------- response mapping

const SAMPLE_CHARS = 200;
const sample = (text) => String(text).replace(/\s+/g, " ").trim().slice(0, SAMPLE_CHARS);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function mapUsage(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  const prompt = Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : 0;
  const cached = u.prompt_tokens_details && Number.isFinite(u.prompt_tokens_details.cached_tokens) ? u.prompt_tokens_details.cached_tokens : 0;
  return {
    // Anthropic semantics: input_tokens EXCLUDES cache reads, so every provider sums as input + cache_read + cache_creation.
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: Number.isFinite(u.completion_tokens) ? u.completion_tokens : 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/** Strict reading of a model's JSON answer: a JSON object, optionally inside ONE ```json fence. Anything else is null. */
function strictJsonObject(text) {
  if (typeof text !== "string") return { value: null };
  let body = text.trim();
  let fenceStripped = false;
  const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
  if (fence) {
    body = fence[1].trim();
    fenceStripped = true;
  }
  if (!body.startsWith("{")) return { value: null };
  try {
    const value = JSON.parse(body);
    return isPlainObject(value) ? { value, fenceStripped } : { value: null };
  } catch (e) {
    return { value: null };
  }
}

/**
 * Map an OpenRouter completion to the Anthropic-shaped response the planner reads. Pure. `meta` (optional) receives
 * non-secret diagnostics: finishReason, servedModel, providerName, cost, and why an answer was malformed.
 */
function parseCompletion(json, request, config, meta = {}) {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  const message = (choice && choice.message) || {};
  const usage = mapUsage(json && json.usage);
  if (json && json.usage && Number.isFinite(json.usage.cost)) meta.cost = json.usage.cost;
  meta.finishReason = choice && choice.finish_reason ? String(choice.finish_reason) : null;
  if (json && typeof json.model === "string") meta.servedModel = json.model;
  if (json && typeof json.provider === "string") meta.providerName = json.provider;
  meta.structuredMode = config.structuredMode || "tool";

  const content = [];
  const forcedName = request.tool_choice.name;
  if (meta.structuredMode === "tool") {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    calls.forEach((call, i) => {
      const fn = (call && call.function) || {};
      let input = null;
      try {
        input = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : isPlainObject(fn.arguments) ? fn.arguments : null;
      } catch (e) {
        input = null;
      }
      if (isPlainObject(input) && typeof fn.name === "string") content.push({ type: "tool_use", id: (call && call.id) || `call_${i}`, name: fn.name, input });
      else meta.malformedReason = "tool_arguments_not_a_json_object";
    });
    if (!calls.length) meta.malformedReason = message.refusal ? "model_refusal_field" : "no_tool_call";
  } else {
    const parsed = strictJsonObject(message.content);
    if (parsed.value) {
      content.push({ type: "tool_use", id: "json_0", name: forcedName, input: parsed.value });
      if (parsed.fenceStripped) meta.fenceStripped = true;
    } else meta.malformedReason = message.refusal ? "model_refusal_field" : "content_not_a_json_object";
  }
  if (!content.length) content.push({ type: "text", text: sample(typeof message.content === "string" && message.content ? message.content : message.refusal || "") });
  return { id: json && json.id, model: meta.servedModel, content, usage, stop_reason: meta.finishReason };
}

// ---------------------------------------------------------------------------------------------- transport

function retryAfterMs(headers) {
  const raw = headers && typeof headers.get === "function" ? headers.get("retry-after") : null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(MAX_RETRY_AFTER_MS, seconds * 1000) : 0;
}

function httpError(status, text, headers, redact) {
  let detail = "";
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.error && typeof parsed.error.message === "string") detail = parsed.error.message;
  } catch (e) {
    /* body is not JSON: no detail is used */
  }
  const code = status === 401 || status === 403 ? "OPENROUTER_AUTH" : status === 402 ? "OPENROUTER_CREDITS" : status === 404 ? "OPENROUTER_NO_ENDPOINT" : status === 429 ? "OPENROUTER_RATE_LIMITED" : "OPENROUTER_HTTP_ERROR";
  return evalError(code, redact(`OpenRouter HTTP ${status}${detail ? `: ${sample(detail)}` : ""}`), { status, kind: "http", retryable: RETRYABLE_STATUS.has(status), retryAfterMs: retryAfterMs(headers) });
}

async function postOnce({ url, headers, body, limitMs, signal, fetchImpl, redact }) {
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
  const timeout = () => evalError("PLANNER_DEADLINE_EXCEEDED", `OpenRouter request timed out after ${limitMs}ms.`, { kind: "timeout" });
  try {
    let response;
    let text;
    try {
      response = await fetchImpl(url, { method: "POST", headers, body, signal: controller.signal });
      text = await response.text();
    } catch (e) {
      if (timedOut) throw timeout();
      if (signal && signal.aborted) throw evalError("ABORTED", "The request was aborted.", { kind: "aborted" });
      throw evalError("OPENROUTER_NETWORK", redact(`Network error${e && e.cause && e.cause.code ? ` (${e.cause.code})` : ""}.`), { kind: "network", retryable: true });
    }
    if (!response.ok) throw httpError(response.status, text, response.headers, redact);
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw evalError("OPENROUTER_BAD_RESPONSE", "OpenRouter returned a response that is not JSON.", { kind: "http", status: response.status });
    }
    if (json && json.error) {
      const status = Number.isInteger(json.error.code) ? json.error.code : 502;
      throw evalError("OPENROUTER_PROVIDER_ERROR", redact(`OpenRouter provider error ${status}${typeof json.error.message === "string" ? `: ${sample(json.error.message)}` : ""}`), { status, kind: "http", retryable: RETRYABLE_STATUS.has(status) });
    }
    return json;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {true}   options.evalOnly            required: this client is never part of the production path
 * @param {string} options.model               OpenRouter model id, e.g. "vendor/model-name"
 * @param {string} [options.apiKey]            default: process.env.OPENROUTER_API_KEY (read at call time)
 * @param {string} [options.baseUrl]           default: process.env.OPENROUTER_BASE_URL or https://openrouter.ai/api/v1
 * @param {"tool"|"json_schema"} [options.structuredMode="tool"]
 * @param {number} [options.maxTokens]         overrides the planner's max_tokens (recorded in describe())
 * @param {number} [options.attemptTimeoutMs], [options.deadlineMs], [options.maxRetries]
 * @param {object} [options.provider]          extra OpenRouter provider preferences, e.g. { data_collection: "deny" }
 * @param {Function} [options.fetchImpl], [options.sleep]  injectable for tests
 * @returns {Function} async (request, { signal, meta }) => Anthropic-shaped response, with .describe()
 */
function createOpenRouterPlannerClient(options = {}) {
  if (options.evalOnly !== true) {
    throw evalError("OPENROUTER_EVAL_ONLY", "The OpenRouter client is evaluation-only: pass evalOnly: true. It is not part of the production Ask AI path.");
  }
  const model = typeof options.model === "string" ? options.model.trim() : "";
  if (!MODEL_ID.test(model)) throw evalError("OPENROUTER_BAD_MODEL", "An OpenRouter model id like \"vendor/model-name\" is required.");
  const freeOnly = options.freeOnly !== false; // free-only unless a caller deliberately passes freeOnly: false (the CLI never does)
  if (freeOnly) {
    const refusal = freeIdRefusal(model);
    if (refusal) throw evalError("OPENROUTER_NOT_FREE", `Free-only mode: ${refusal}`);
  }
  const config = {
    model,
    freeOnly,
    structuredMode: options.structuredMode || "tool",
    maxTokens: Number.isInteger(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : null,
    attemptTimeoutMs: options.attemptTimeoutMs || DEFAULTS.attemptTimeoutMs,
    deadlineMs: options.deadlineMs || DEFAULTS.deadlineMs,
    maxRetries: Number.isInteger(options.maxRetries) && options.maxRetries >= 0 ? options.maxRetries : DEFAULTS.maxRetries,
    provider: options.provider && typeof options.provider === "object" ? options.provider : {},
  };
  const baseUrl = String(options.baseUrl || process.env.OPENROUTER_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || defaultSleep;

  async function openRouterPlannerClient(request, callOptions = {}) {
    const meta = callOptions.meta || {};
    const apiKey = options.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw evalError("OPENROUTER_NOT_CONFIGURED", "OpenRouter is not configured: OPENROUTER_API_KEY is missing.");
    const redact = makeRedactor(apiKey);
    const body = JSON.stringify(buildRequestBody(request, config));
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "TallyPulse NLU evaluation" };
    const started = Date.now();
    meta.attempts = 0;
    meta.retries = 0;
    let lastError = null;
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      const remaining = config.deadlineMs - (Date.now() - started);
      if (remaining <= 0) break;
      meta.attempts = attempt + 1;
      try {
        const json = await postOnce({ url: `${baseUrl}/chat/completions`, headers, body, limitMs: Math.min(config.attemptTimeoutMs, remaining), signal: callOptions.signal || null, fetchImpl, redact });
        meta.httpStatus = 200;
        const mapped = parseCompletion(json, request, config, meta);
        if (config.freeOnly) {
          // A free request never reports a cost. If one does, a paid endpoint served it: stop (never retry) and let the runner halt this model.
          if (Number.isFinite(meta.cost) && meta.cost > 0) {
            meta.freeViolation = "non_zero_cost_reported";
            throw evalError("OPENROUTER_FREE_VIOLATION", "A response reported a non-zero cost for a model that must be free.", { kind: "free_violation", status: 200 });
          }
          if (meta.servedModel && !sameModel(meta.servedModel, config.model)) meta.servedModelMismatch = true; // recorded and reported, not hidden
        }
        return mapped;
      } catch (error) {
        lastError = error;
        if (error && error.status) meta.httpStatus = error.status;
        if (!error || !error.retryable || attempt === config.maxRetries) break;
        // a rate-limited (429) free endpoint needs real breathing room: start at 2 s; other transient errors at 0.5 s
        const wait = Math.max(Math.min(MAX_BACKOFF_MS, (error.status === 429 ? 2000 : 500) * 2 ** attempt) + Math.floor(Math.random() * 250), error.retryAfterMs || 0);
        if (Date.now() - started + wait >= config.deadlineMs) break;
        meta.retries += 1;
        (meta.retryReasons || (meta.retryReasons = [])).push(error.status || error.code || "error");
        await sleep(wait);
      }
    }
    throw lastError || evalError("PLANNER_DEADLINE_EXCEEDED", `OpenRouter deadline of ${config.deadlineMs}ms exceeded.`, { kind: "timeout" });
  }

  /** Non-secret description of this client's settings, recorded with every result. */
  openRouterPlannerClient.describe = () => ({
    provider: "openrouter",
    model: config.model,
    structuredMode: config.structuredMode,
    maxTokens: config.maxTokens,
    temperature: 0,
    attemptTimeoutMs: config.attemptTimeoutMs,
    deadlineMs: config.deadlineMs,
    maxRetries: config.maxRetries,
    requireParameters: true,
    freeOnly: config.freeOnly,
    providerPreferences: config.freeOnly ? { ...config.provider, ...FREE_ONLY_PROVIDER } : config.provider,
    baseUrl,
  });
  return openRouterPlannerClient;
}

// ---------------------------------------------------------------------------------------------- capability lookup

/**
 * What OpenRouter says each model supports (public catalogue, no key needed). Failure is not an error: capabilities stay
 * unknown and the model is still measured.
 */
async function fetchModelCapabilities(modelIds, { baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const url = `${String(baseUrl || process.env.OPENROUTER_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, "")}/models`;
  const byId = {};
  for (const id of modelIds) byId[id] = { found: false, supportedParameters: [], contextLength: null, pricing: null };
  let reachable = false;
  try {
    const response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { reachable, byId };
    const json = await response.json();
    if (!Array.isArray(json && json.data)) return { reachable, byId };
    reachable = true;
    for (const entry of json.data) {
      if (!entry || !byId[entry.id]) continue;
      byId[entry.id] = {
        found: true,
        supportedParameters: Array.isArray(entry.supported_parameters) ? entry.supported_parameters.map(String) : [],
        contextLength: Number.isFinite(entry.context_length) ? entry.context_length : null,
        pricing: entry.pricing && typeof entry.pricing === "object" ? { ...entry.pricing } : null, // every price field, so ANY non-zero one is seen
      };
    }
  } catch (e) {
    /* capabilities stay unknown */
  }
  return { reachable, byId };
}

// ---------------------------------------------------------------------------------------------- free-only safety

/** Why a model id may not be used in free-only mode (null = acceptable). Routers and stealth ids are refused outright. */
function freeIdRefusal(model) {
  if (/^openrouter\//i.test(model)) return `"${model}" is an OpenRouter router / stealth id, which can route to any model. Name an exact model.`;
  if (!/:free$/.test(model)) return `"${model}" is not a ":free" variant.`;
  return null;
}

const stripVariant = (id) => String(id).toLowerCase().replace(/:free$/, "").replace(/-\d{8}$/, "");
/** Is the model that served a request the one that was asked for? (tolerates the ":free" suffix and a trailing date stamp) */
function sameModel(served, requested) {
  const a = stripVariant(served);
  const b = stripVariant(requested);
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * The pre-flight gate for ONE requested model, from the live catalogue. The model may be called only when status is
 * "free_verified": exact id found, ":free" variant, and EVERY price field is exactly zero. Anything else - not found, a paid
 * price, an unreachable catalogue (price cannot be verified) - means "do not call it", recorded with the reason.
 */
function assessFreeModel(id, capability, catalogueReachable) {
  const refusal = freeIdRefusal(id);
  if (refusal) return { status: "refused_not_free_id", callable: false, reason: refusal, pricing: null };
  if (!catalogueReachable) return { status: "unavailable_pricing_unverified", callable: false, reason: "The OpenRouter catalogue could not be read, so the price cannot be verified: not called.", pricing: null };
  if (!capability || !capability.found) return { status: "unavailable_not_in_catalogue", callable: false, reason: "This exact model id is not in the OpenRouter catalogue right now (no paid or similar model is substituted).", pricing: null };
  const pricing = capability.pricing;
  if (!pricing) return { status: "unavailable_pricing_unverified", callable: false, reason: "The catalogue lists no pricing for this model: not called.", pricing: null };
  const fields = Object.entries(pricing);
  const priced = fields.filter(([, v]) => !(typeof v === "string" || typeof v === "number") || !Number.isFinite(Number(v)) || Number(v) !== 0);
  if (!("prompt" in pricing) || !("completion" in pricing)) return { status: "unavailable_pricing_unverified", callable: false, reason: "The catalogue pricing lacks prompt/completion prices: not called.", pricing };
  if (priced.length) return { status: "refused_not_free_pricing", callable: false, reason: `Not free: ${priced.map(([k, v]) => `${k}=${v}`).join(", ")}.`, pricing };
  return { status: "free_verified", callable: true, reason: null, pricing };
}

/** Choose how a model is asked for structured output, and record any limitation. `override` is "tool", "json_schema" or "auto". */
function pickStructuredMode(capability, override = "auto") {
  if (override === "tool" || override === "json_schema") return { mode: override, limitations: [] };
  if (!capability || !capability.found) return { mode: "tool", limitations: ["model not found in the OpenRouter catalogue: capabilities unknown, trying tool calling"] };
  const supported = capability.supportedParameters;
  if (supported.includes("tools")) return { mode: "tool", limitations: [] };
  if (supported.includes("structured_outputs") || supported.includes("response_format")) return { mode: "json_schema", limitations: ["no tool calling advertised: using JSON-schema output with strict JSON parsing"] };
  return { mode: "json_schema", limitations: ["no tool calling or structured output advertised: strict JSON parsing only, prose is scored as malformed output"] };
}

module.exports = { createOpenRouterPlannerClient, buildRequestBody, parseCompletion, strictJsonObject, fetchModelCapabilities, pickStructuredMode, assessFreeModel, freeIdRefusal, sameModel, makeRedactor, mapUsage, DEFAULTS, FORMAT_INSTRUCTION, FREE_ONLY_PROVIDER };
