"use strict";

// --------------------------------------------------
// AI cost-path harness: drives the REAL chat controller (sendChatMessage) -> queryChat -> the shared planner response cache ->
// the REAL planner client and Anthropic SDK -> an HTTP endpoint. The endpoint is either a local stand-in (createStub: free,
// deterministic, records the exact wire payload - application behaviour only, NEVER provider evidence) or the real provider
// (live runs, see eval-ai-cost-live.js). Only the DATA side is injected (engine execution, freshness, date context, name
// resolution) and the Chat model's database calls are captured, so nothing here needs MongoDB. The planner client and cache are
// deliberately NOT injected: that is exactly what the unit tests of the cache do, and why they cannot show whether a normal
// chat turn benefits.
// --------------------------------------------------

const http = require("http");
const crypto = require("crypto");

const sha = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex").slice(0, 12);
const r2 = (n) => Math.round(n * 100) / 100;

/** Local stand-in for POST /v1/messages. `reply(body, n)` -> {status, json} | tool input object. Records every request. */
function createStub(reply, { usage = null } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { /* recorded as empty */ }
      const rec = {
        n: calls.length + 1,
        tool: body.tool_choice && body.tool_choice.name,
        model: body.model,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        prefixHash: sha({ tools: body.tools, system: body.system }), // what provider prompt caching would key on (tools, then system)
        systemHash: sha(body.system),
        toolsHash: sha(body.tools),
        bodyHash: sha(body),
        bodyBytes: Buffer.byteLength(JSON.stringify(body)),
        prefixBytes: Buffer.byteLength(JSON.stringify({ tools: body.tools, system: body.system })),
        cacheControl: {
          system: Array.isArray(body.system) ? body.system.map((b) => !!b.cache_control) : null,
          tools: Array.isArray(body.tools) ? body.tools.map((t) => !!t.cache_control) : null,
        },
        userText: body.messages && body.messages[0] && typeof body.messages[0].content === "string" ? body.messages[0].content : "",
        messageCount: (body.messages || []).length,
        headerKeys: Object.keys(req.headers).filter((h) => !/authorization|x-api-key/i.test(h)),
      };
      calls.push(rec);
      let out = reply(body, rec.n, rec);
      if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ input_tokens: Math.ceil(JSON.stringify([body.tools, body.system, body.messages]).length / 3.5) })); }
      if (!out || (out.status === undefined && out.json === undefined)) { out = { status: 200, json: toResponse(body, out) }; if (usage) out.json.usage = usage(body, rec); }
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

/** A tool_use reply in the provider's shape. Usage is a rough SIMULATION (stub only): ~3.5 chars per token. */
function toResponse(body, input) {
  const tok = (v) => Math.ceil(JSON.stringify(v).length / 3.5);
  return {
    id: `msg_stub_${Math.random().toString(36).slice(2, 10)}`, type: "message", role: "assistant", model: body.model, stop_reason: "tool_use", stop_sequence: null,
    content: [{ type: "tool_use", id: "toolu_stub", name: body.tool_choice && body.tool_choice.name, input: input || {} }],
    usage: { input_tokens: tok([body.tools, body.system, body.messages]), output_tokens: tok(input || {}), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

const DC = Object.freeze({ referenceDate: new Date(2026, 9, 27, 23, 59, 59, 999), source: "today", futureVouchers: false, latestVoucher: new Date(2026, 9, 27), coverage: Object.freeze({ earliest: new Date(2025, 0, 1), latest: new Date(2026, 9, 27), lastSyncedAt: null }) });

/** Synthetic engine: numbers depend on the tenant and a per-tenant data version, so staleness is observable. */
function createEngine() {
  const versions = new Map();
  const executions = [];
  const CUSTOMERS = [["Synthetic Alpha", 1.0], ["Synthetic Beta", 0.6], ["Synthetic Gamma", 0.3]];
  const base = (tenantId) => 100000 * (1 + (versions.get(tenantId) || 0));
  async function execute(plan, ctx) {
    executions.push({ tenantId: ctx.tenantId, entity: plan.entity, metrics: plan.metrics, groupBy: (plan.groupBy || []).map((g) => g.dim) });
    const m = plan.metrics[0];
    const cur = base(ctx.tenantId), prev = cur * 1.25; // the current period is lower: a decline
    const iso = (d, e) => (e ? new Date(`${d}T23:59:59.999`) : new Date(`${d}T00:00:00`)).toISOString();
    const per = plan.period.kind === "custom" ? plan.period : { from: "2026-10-01", to: "2026-10-31" };
    const cmpP = plan.compare && plan.compare.period ? plan.compare.period : { from: "2026-09-01", to: "2026-09-30" };
    const dim = plan.groupBy && plan.groupBy[0] && plan.groupBy[0].dim;
    const rows = dim ? CUSTOMERS.map(([k, w]) => ({ key: { [dim]: k }, values: { [m]: r2(cur * w * 0.5) }, ...(plan.compare ? { comparison: { [m]: { previous: r2(prev * w * 0.5), delta: r2((cur - prev) * w * 0.5), deltaPct: -20 } } } : {}) })) : [];
    return { result: { ok: true, entity: plan.entity, mode: "aggregate", period: { from: iso(per.from), to: iso(per.to, true), label: "period" }, comparison: plan.compare ? { from: iso(cmpP.from), to: iso(cmpP.to, true), label: "previous" } : null, metrics: plan.metrics, groupBy: plan.groupBy || [], amountBasis: { [m]: m === "lineAmount" ? "line_item_pre_tax" : "voucher_total_incl_tax" }, rows, totals: { values: { [m]: r2(cur) }, ...(plan.compare ? { comparison: { [m]: { previous: r2(prev), delta: r2(cur - prev), deltaPct: -20 } } } : {}) }, truncated: false, rowLimit: plan.limit || 10, warnings: [], assumptions: [] }, cache: { status: "miss" } };
  }
  return { execute, executions, bump: (tenantId) => versions.set(tenantId, (versions.get(tenantId) || 0) + 1), version: (tenantId) => versions.get(tenantId) || 0 };
}

/**
 * @param {{baseUrl?: string, apiKey?: string, analysis?: boolean}} opts baseUrl: the endpoint (stub or omit for the real provider)
 * Environment is set BEFORE the app modules load (the production client is created lazily on the first call).
 */
function createHarness({ baseUrl = null, apiKey = null, analysis = true, planCache = true } = {}) {
  if (baseUrl) process.env.ANTHROPIC_BASE_URL = baseUrl;
  if (apiKey) process.env.ANTHROPIC_API_KEY = apiKey;
  process.env.AI_USAGE_PERSIST = "on";
  if (!planCache) process.env.PLANNER_RESPONSE_CACHE = "off";
  const engine = createEngine();
  const events = [];
  const records = [];
  require("../../src/services/query/turnTelemetry").setTelemetrySink((line) => events.push(JSON.parse(line)));
  require("../../src/services/query/usageStore").setUsageWriter(async (rec) => { records.push(rec); });

  const queryChat = require("../../src/services/query/queryChat");
  const realTurn = queryChat.tryAnswerWithQueryEngine;
  queryChat.tryAnswerWithQueryEngine = (args) => realTurn({ ...args, getDateContext: async () => DC, deps: { analysisEnabled: analysis, execute: engine.execute, getFreshness: async () => ({ state: "fresh", message: "" }), getDateContext: async () => DC, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) } });
  const Chat = require("../../src/models/chat.model");
  const store = new Map(); // chatId -> serialized chat
  let seq = 0;
  Chat.prototype.save = async function save() { const o = JSON.parse(JSON.stringify(this.toObject())); if (!o._id) o._id = `64b0000000000000000${String(1000 + (seq += 1))}`; store.set(String(this._id), o); return this; };
  Chat.findOne = async (filter) => { const s = store.get(String(filter._id)); return s && s.tenantId === filter.tenantId && String(s.userId) === String(filter.userId) ? Chat.hydrate(JSON.parse(JSON.stringify(s))) : null; };
  const { sendChatMessage } = require("../../src/controllers/chatController");
  const mkRes = () => ({ statusCode: 0, body: null, destroyed: false, closed: false, writableFinished: false, on() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.writableFinished = true; return this; } });

  /** One normal chat turn. chatId null = a new conversation. Returns the answer and what telemetry recorded for the turn. */
  async function ask(tenantId, text, chatId = null, userId = "64b000000000000000000001") {
    const res = mkRes();
    const req = { id: `req-${Math.random().toString(36).slice(2, 10)}`, body: { message: text }, params: chatId ? { chatId } : {}, companyContext: { tenantId, companyGuid: `guid-${tenantId}` }, user: { id: userId } };
    const t0 = Date.now();
    await sendChatMessage(req, res);
    await new Promise((r) => setImmediate(r)); // the usage writer is fire-and-forget
    return { status: res.statusCode, chatId: res.body && res.body.chatId, answer: res.body && res.body.data && res.body.data.answer, meta: res.body && res.body.data && res.body.data.details && res.body.data.details.queryEngine, event: events.find((e) => e.requestId === req.id) || null, record: records.find((r) => r.requestId === req.id) || null, // matched by request id: correct for concurrent turns too
     ms: Date.now() - t0 };
  }
  const cache = () => require("../../src/services/query/plannerResponseCache").getSharedPlannerResponseCache();
  return { ask, engine, events, records, cache, DC, sha };
}

module.exports = { createStub, toResponse, createHarness, createEngine, DC, sha };
