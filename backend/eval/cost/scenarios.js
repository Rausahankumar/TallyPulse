"use strict";

// The cost-path scenarios (Tests A-I of the AI cost audit), run through the real controller by harness.js.
// A scenario returns plain observations: what the HTTP endpoint ACTUALLY received (stub.calls = every request the SDK sent,
// including SDK-internal retries) next to what telemetry REPORTED for the same turn. Nothing is asserted here.

const { createStub, createHarness } = require("./harness");

const PLAN_TOTAL = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount"] };
const AUG = { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, JUL = { kind: "custom", from: "2025-07-01", to: "2025-07-31" };
const cmpPlan = (extra = {}) => ({ v: 1, entity: "sales", mode: "aggregate", period: AUG, compare: { mode: "custom", period: JUL }, metrics: ["invoiceAmount"], filters: [], ...extra });
const WHY = { v: 1, steps: [{ id: "total", kind: "query", plan: cmpPlan() }, { id: "customers", kind: "query", plan: cmpPlan({ groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 10 }) }] };

const EQUIVALENT = ["What are my sales this month?", "How much have I sold in the current month?", "Show total sales for this month."];
const Q = (text) => (/Question: (.*)$/m.exec(text) || [null, text])[1].trim();

/** The scripted "model": a stable planner that answers the same way for the same meaning (what a deterministic model would do). */
function scriptedReply(state) {
  return (body, n, rec) => {
    if (state.failOnce && state.failOnce.size) { const hit = [...state.failOnce].find((s) => rec.userText.includes(s)); if (hit) { state.failOnce.delete(hit); return { status: 529, json: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }; } }
    if (state.failNext > 0) { state.failNext -= 1; return { status: 529, json: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }; }
    const q = Q(rec.userText).toLowerCase();
    const analysis = rec.tool === "submit_analysis_plan";
    if (/sales.*(this month|current month)|sold in the current month|total sales for this month/.test(q)) return analysis ? { decline: { code: "not_a_data_query" } } : { plan: PLAN_TOTAL };
    if (/why did sales decline|what should i do/.test(q)) return analysis ? { analysis: WHY, actions: /what should i do/.test(q), language: "en" } : { decline: { code: "needs_analysis", message: "several analyses" } };
    if (/which customers contributed/.test(q)) return analysis ? { decline: { code: "not_a_data_query" } } : { plan: cmpPlan({ groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 10 }) };
    return { decline: { code: "not_a_data_query", message: "n/a" } };
  };
}

const summarize = (calls) => calls.map((c) => ({ n: c.n, tool: c.tool, prefix: c.prefixHash, bytes: c.bodyBytes, prefixBytes: c.prefixBytes, messageChars: c.userText.length }));
const turnView = (r) => ({ status: r.status, sent: r.record ? r.record.providerRequests : undefined, calls: r.record ? r.record.claudeCalls : null, hits: r.record ? r.record.plannerCacheHits : null, misses: r.record ? r.record.plannerCacheMisses : null, inTok: r.record ? r.record.inputTokens : null, outTok: r.record ? r.record.outputTokens : null, cost: r.record ? r.record.estimatedCostUsd : undefined, retry: r.record ? r.record.retryCount : undefined, model: r.record ? r.record.plannerModel : null, ms: r.ms });

async function run({ log = () => {} } = {}) {
  const state = { failNext: 0, failOnce: new Set() };
  const stub = await createStub(scriptedReply(state));
  const h = createHarness({ baseUrl: stub.url, apiKey: "stub-key-not-a-secret" });
  const out = {};
  const since = (from) => stub.calls.slice(from);
  let mark = 0;
  const step = async (name, fn) => { mark = stub.calls.length; const o = await fn(); out[name] = { ...o, requests: since(mark).length, wire: summarize(since(mark)) }; log(name, out[name]); };

  // A. the same question twice, each in a NEW conversation (nothing else differs)
  await step("A_identical_new_chats", async () => {
    const t1 = await h.ask("T-COST-A", EQUIVALENT[0]); const c1 = stub.calls.length;
    const t2 = await h.ask("T-COST-A", EQUIVALENT[0]);
    return { first: turnView(t1), second: turnView(t2), requestsAfterFirst: c1 - mark };
  });
  // B. the same question asked repeatedly INSIDE one conversation
  await step("B_same_chat_repeat", async () => {
    const t1 = await h.ask("T-COST-B", EQUIVALENT[0]); const a = stub.calls.length;
    const t2 = await h.ask("T-COST-B", EQUIVALENT[0], t1.chatId); const b = stub.calls.length;
    const t3 = await h.ask("T-COST-B", EQUIVALENT[0], t1.chatId); const c = stub.calls.length;
    const t4 = await h.ask("T-COST-B", EQUIVALENT[0], t1.chatId);
    return { turns: [t1, t2, t3, t4].map(turnView), requestsPerTurn: [a - mark, b - a, c - b, stub.calls.length - c] };
  });
  // C. equivalent wordings (new conversation each)
  await step("C_equivalent_wordings", async () => {
    const ts = []; for (const q of EQUIVALENT) ts.push(await h.ask("T-COST-C", q));
    return { turns: ts.map(turnView), engineExecutions: h.engine.executions.filter((e) => e.tenantId === "T-COST-C").length };
  });
  // D. a contextual follow-up in the same conversation
  await step("D_followup", async () => {
    const t1 = await h.ask("T-COST-D", "Why did sales decline in August 2025?");
    const a = stub.calls.length;
    const t2 = await h.ask("T-COST-D", "Which customers contributed most to that decline?", t1.chatId);
    return { first: turnView(t1), followUp: turnView(t2), firstRequests: a - mark, followUpRequestChars: since(a).map((c) => c.userText.length) };
  });
  // E. data changes between two identical questions: no stale NUMBER may be served (the planner reply carries no data)
  await step("E_data_change", async () => {
    const t1 = await h.ask("T-COST-E", EQUIVALENT[0]);
    h.engine.bump("T-COST-E");
    const t2 = await h.ask("T-COST-E", EQUIVALENT[0]);
    const n = (a) => (/₹[\d,]+(\.\d+)?/.exec(a || "") || [null])[0];
    return { first: turnView(t1), second: turnView(t2), figures: [n(t1.answer), n(t2.answer)], engineExecutions: h.engine.executions.filter((e) => e.tenantId === "T-COST-E").length };
  });
  // F. another tenant asks the identical question
  await step("F_tenant_isolation", async () => {
    await h.ask("T-COST-F1", EQUIVALENT[0]);
    const a = stub.calls.length;
    const t2 = await h.ask("T-COST-F2", EQUIVALENT[0]);
    const t3 = await h.ask("T-COST-F1", EQUIVALENT[0]);
    return { otherTenant: turnView(t2), sameTenantAgain: turnView(t3), requestsForOtherTenant: stub.calls.slice(a).length - 0 };
  });
  // G. a multi-step investigation, then the same with "what should I do" (the decision call)
  await step("G_investigation", async () => {
    const t1 = await h.ask("T-COST-G", "Why did sales decline in August 2025?"); const a = stub.calls.length;
    const t2 = await h.ask("T-COST-G", "What should I do about the sales decline in August 2025?");
    return { why: turnView(t1), whyRequests: a - mark, act: turnView(t2), actRequests: stub.calls.length - a };
  });
  // G2. the same investigation asked again in a NEW conversation: every model call of it (query planner, analysis planner, decision) is remembered
  await step("G2_repeat_investigation", async () => {
    const t1 = await h.ask("T-COST-G", "Why did sales decline in August 2025?"); const a = stub.calls.length;
    const t2 = await h.ask("T-COST-G", "What should I do about the sales decline in August 2025?");
    return { why: turnView(t1), whyRequests: a - mark, act: turnView(t2), actRequests: stub.calls.length - a };
  });
  // I. two identical questions arriving at the same moment (two tabs / a double click)
  await step("I_concurrent_duplicates", async () => {
    const [t1, t2] = await Promise.all([h.ask("T-COST-I", EQUIVALENT[0]), h.ask("T-COST-I", EQUIVALENT[0])]);
    return { turns: [t1, t2].map(turnView) };
  });
  // R. the provider returns an overloaded error once; the SDK retries by itself
  await step("R_sdk_retry", async () => {
    state.failNext = 1;
    const t1 = await h.ask("T-COST-R", "How much have I sold in the current month?");
    return { turn: turnView(t1) };
  });

  // R2. two turns in flight together; the provider overloads exactly ONE request: the retry belongs to that turn only
  await step("R2_retry_attribution", async () => {
    state.failOnce.add("current month");
    const [t1, t2] = await Promise.all([h.ask("T-COST-R2", "How much have I sold in the current month?"), h.ask("T-COST-R2B", "Show total sales for this month.")]);
    return { failedTurn: turnView(t1), otherTurn: turnView(t2) };
  });

  out.stats = { cache: { ...h.cache().stats, size: h.cache().size() }, totalStubRequests: stub.calls.length };
  out.prefixes = [...new Set(stub.calls.map((c) => `${c.tool}:${c.prefixHash}:${c.prefixBytes}B`))];
  out.cacheControl = [...new Map(stub.calls.map((c) => [c.tool, JSON.stringify(c.cacheControl)])).entries()];
  out.models = [...new Set(stub.calls.map((c) => `${c.model}@${c.temperature}`))];
  await stub.close();
  return { out, calls: stub.calls, events: h.events, records: h.records };
}

module.exports = { run, scriptedReply, EQUIVALENT, WHY, PLAN_TOTAL };
