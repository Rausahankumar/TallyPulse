/**
 * Analysis planner (Milestone 2): a question the query planner declines with `needs_analysis` gets an analysis plan from a
 * second forced tool call, validated with the existing checks, then run by the analysis executor and answered with the
 * measured results only. MOCKED model provider only: no network, no Anthropic call, no Tally.
 *
 * Covers: the generated prompt and tool schema and their budgets; output parsing and protocol checks; valid plans of
 * different shapes (a decline explained by customers and products, product performance with an insight tool, customer
 * changes in both directions, sales next to purchases); invalid plans with ONE repair; unknown or not-offered tools; a tenant
 * inside a plan; invalid dependencies; invented years and decided terms (final, never repaired); timeouts and aborts; and the
 * chat turn: flag on, flag off (exactly the previous decline), ordinary questions unchanged, telemetry and tenant isolation.
 *
 * Synthetic data on a loopback MongoDB for the chat section (refused otherwise). Data removed at the end.
 *
 * Run: node verify-analysis-planner.js
 */

require("dotenv").config();
{
  const uri = process.env.MONGODB_URI || "";
  const host = (/^mongodb:\/\/(?:[^@/]*@)?\[?([^\]/:,]+)\]?(?::\d+)?[/?]/.exec(uri) || [])[1];
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || /mongodb\+srv|mongodb\.net|atlas/i.test(uri)) {
    console.error("REFUSED: verify-analysis-planner.js only runs against a loopback MongoDB. Nothing was touched.");
    process.exit(2);
  }
  require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };
}
process.env.AI_USAGE_PERSIST = "off";
delete process.env.ASK_AI_ANALYSIS; // the default (off) is part of what is tested

const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const TenantDataVersion = require("./src/models/tenantDataVersion.model");
const ap = require("./src/services/query/analysisPlanner");
const { PLANNER_TOOL_NAME } = require("./src/services/query/planner");
const { CATALOG } = require("./src/services/query/semanticCatalog");
const { SCOPE_HINT } = require("./src/services/query/answerFormatter");
const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");

let pass = 0;
let fail = 0;
function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}

const TA = "TEST-TENANT-A-analysis-planner";
const TB = "TEST-TENANT-B-analysis-planner";
const TC = "TEST-TENANT-C-analysis-planner";
const REF = new Date(2025, 10, 5, 23, 59, 59, 999);
const OCT = { kind: "custom", from: "2025-10-01", to: "2025-10-31" };
const VS_SEP = { mode: "custom", period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" } };
const q = (o) => ({ v: 1, entity: "sales", mode: "aggregate", period: OCT, metrics: ["invoiceAmount"], groupBy: [], filters: [], ...o });

// ---- the mocked model: answers by the tool it is forced to call, in order, and records every request
const toolReply = (name, input) => ({ content: [{ type: "tool_use", id: `tu_${Math.random().toString(36).slice(2, 8)}`, name, input }], usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
function fakeModel(script) {
  const queue = { [PLANNER_TOOL_NAME]: [...(script.query || [])], [ap.ANALYSIS_TOOL_NAME]: [...(script.analysis || [])] };
  const fn = async (req) => {
    fn.requests.push(req);
    const name = req.tool_choice.name;
    const next = queue[name].shift();
    if (next === undefined) throw new Error(`no scripted reply for ${name}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(req) : toolReply(name, next);
  };
  fn.requests = [];
  return fn;
}
const plan = (question, script, extra = {}) => ap.planAnalysis(question, { claudeClient: fakeModel(script), referenceDate: REF, ...extra });

// Analysis plans of different shapes. They are the MODEL's output in these tests: nothing in the code knows them.
const PLANS = {
  decline: { v: 1, steps: [
    { id: "total", kind: "query", plan: q({ compare: VS_SEP }) },
    { id: "customers", kind: "query", plan: q({ groupBy: [{ dim: "customer" }], compare: VS_SEP, having: [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 2 }) },
    { id: "products", kind: "query", plan: q({ metrics: ["lineAmount"], groupBy: [{ dim: "product" }], compare: VS_SEP, sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 }), inputs: [{ fromStep: "customers", dim: "customer", take: 2 }] },
  ] },
  productPerformance: { v: 1, steps: [
    { id: "value", kind: "query", plan: q({ metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "product" }], compare: VS_SEP, sort: [{ by: "lineAmount.delta", dir: "asc" }] }) },
    { id: "rates", kind: "insight", tool: "product_rates", args: { period: OCT, limit: 10 } },
  ] },
  customerChanges: { v: 1, steps: [
    { id: "up", kind: "query", plan: q({ groupBy: [{ dim: "customer" }], compare: VS_SEP, having: [{ metric: "invoiceAmount.deltaPct", op: "gt", value: 50 }], sort: [{ by: "invoiceAmount.deltaPct", dir: "desc" }] }) },
    { id: "down", kind: "query", plan: q({ groupBy: [{ dim: "customer" }], compare: VS_SEP, having: [{ metric: "invoiceAmount.deltaPct", op: "lt", value: -50 }], sort: [{ by: "invoiceAmount.deltaPct", dir: "asc" }] }) },
  ] },
  salesAndPurchases: { v: 1, steps: [
    { id: "sales", kind: "query", plan: q({ compare: VS_SEP }) },
    { id: "purchases", kind: "query", plan: q({ entity: "purchase", metrics: ["purchaseAmount"], compare: VS_SEP }) },
  ] },
};

// ---- synthetic vouchers: [model, tenant, date, party, [[item, qty, rate, amount]]]
const VOUCHERS = [
  ["sale", TA, "2025-09-05", "Alpha Traders", [["Item P1", 6, 100, 600], ["Item P2", 4, 100, 400]]],
  ["sale", TA, "2025-09-08", "Beta Stores", [["Item P1", 8, 100, 800]]],
  ["sale", TA, "2025-09-12", "Gamma Mart", [["Item P2", 5, 100, 500]]],
  ["sale", TA, "2025-09-20", "Delta Corp", [["Item P3", 2, 100, 200]]],
  ["sale", TA, "2025-10-03", "Alpha Traders", [["Item P1", 1, 100, 100], ["Item P2", 3, 100, 300]]],
  ["sale", TA, "2025-10-09", "Beta Stores", [["Item P1", 10, 80, 700]]],
  ["sale", TA, "2025-10-15", "Gamma Mart", [["Item P2", 6, 100, 600]]],
  ["purchase", TA, "2025-09-02", "Sup One", [["Item P1", 10, 55, -550]]],
  ["purchase", TA, "2025-10-02", "Sup One", [["Item P1", 20, 60, -1200]]],
  ["sale", TB, "2025-10-04", "Alpha Traders", [["Item P9", 1, 99999, 99999]]],
  ["sale", TB, "2025-09-04", "Alpha Traders", [["Item P9", 1, 1, 1]]],
  // Tenant C: discount and margin data with one case for each conditional note (see section 7)
  ["sale", TC, "2025-10-06", "Cust X", [["Item M1", 10, 100, 900], ["Item NoRate", 2, 0, 50], ["Item Odd", 100, 100, 100], ["Item M2", 5, 40, 200]]],
  ["sale", TC, "2025-10-20", "Cust Y", [["Item M1", 1, 100, 10]]],
  ["purchase", TC, "2025-10-02", "Sup Z", [["Item M1", 20, 50, -1000]]],
  ["purchase", TC, "2025-03-10", "Sup Z", [["Item M2", 10, 30, -300]]], // within the 12 months before October: M2's earlier cost
];
const cleanup = async () => {
  const ids = { $in: [TA, TB, TC] };
  await Promise.all([Sale.deleteMany({ tenantId: ids }), Purchase.deleteMany({ tenantId: ids }), TenantDataVersion.deleteMany({ tenantId: ids })]);
};
const DATE_CONTEXT = Object.freeze({ referenceDate: REF, source: "today", futureVouchers: false, latestVoucher: new Date(2025, 9, 15), coverage: Object.freeze({ earliest: new Date(2025, 8, 1), latest: new Date(2025, 9, 31), lastSyncedAt: null }) });
const fresh = async () => ({ state: "fresh", message: "", dataAsOf: null });
const ask = (tenantId, question, model, extraDeps = {}) =>
  tryAnswerWithQueryEngine({ context: { tenantId, userId: "u-analysis" }, userMessage: question, conversationHistory: [], deps: { plannerClient: model, getFreshness: fresh, getDateContext: async () => DATE_CONTEXT, ...extraDeps } });

async function main() {
  console.log("=== 1. Generated prompt, tool schema and budgets ===");
  const prompt = ap.getAnalysisPrompt();
  const text = prompt.system[0].text;
  const wire = JSON.stringify({ system: prompt.system, tools: [prompt.tool], messages: [{ role: "user", content: "x".repeat(600) }], max_tokens: ap.ANALYSIS_MAX_TOKENS });
  check("budget-system", "the analysis system prompt stays under 6,500 chars", text.length < 6500, true);
  check("budget-request", "the whole analysis request (longest allowed question) stays under 19,000 chars (raised from 18,000 when discount_summary and product_margin were offered)", wire.length < 19000, true);
  console.log(`  (info) analysis system ${text.length} chars, whole request ${wire.length} chars`);
  check("prompt-generated", "every supported catalog metric and every offered tool appears (generated, not hand-written)", Object.values(CATALOG.metrics).filter((m) => m.status === "supported").every((m) => text.includes(m.id)) && ap.ANALYSIS_TOOL_IDS.every((t) => text.includes(t)), true);
  check("prompt-own-task", "the prompt is the analysis task, not the query planner's (no submit_query_plan, no needs_analysis)", [text.includes("submit_query_plan"), text.includes("needs_analysis"), text.startsWith("You turn ONE business question into an analysis plan")], [false, false, true]);
  check("prompt-lifts", "the analysis prompt drops only 'cross entity comparison' from the catalog's unsupported list (separate steps measure each entity)", [text.includes("cross entity comparison"), CATALOG.unsupported.filter((u) => u.id !== "cross_entity_comparison").every((u) => text.includes(require("./src/services/query/semanticCatalog").unsupportedLabel(u)))], [false, true]);
  check("prompt-profit", "accounting profit stays in the decline list; discount analysis is no longer there; the margin tool says 'Not accounting profit'", [/accounting profit/.test(text), /discount analysis/.test(text), /product_margin \(Indicative margin per product[^)]*Not accounting profit\.\)/.test(text)], [true, false, true]);
  const stepKinds = prompt.tool.input_schema.properties.analysis.properties.steps.items.anyOf;
  check("schema-tools", "the tool schema offers exactly the five allowlisted insight tools", stepKinds.slice(1).map((s) => s.properties.tool.const), ["discount_summary", "product_rates", "product_margin", "product_trend", "supplier_rates"]);
  check("schema-no-tenant", "no tenant field anywhere in the request", /tenant/i.test(wire), false);

  console.log("\n=== 2. Valid plans of different shapes (one call each) ===");
  for (const [name, analysis] of Object.entries(PLANS)) {
    const model = fakeModel({ analysis: [{ analysis }] });
    const r = await ap.planAnalysis(`question about ${name} in October 2025 vs September 2025`, { claudeClient: model, referenceDate: REF });
    check(`valid-${name}`, `${name}: supported in one forced call`, [r.status, r.usage.calls, model.requests[0].tool_choice], ["supported", 1, { type: "tool", name: ap.ANALYSIS_TOOL_NAME }]);
  }

  console.log("\n=== 3. Output parsing and protocol ===");
  const proto = async (respond) => (await plan("q October 2025", { analysis: [respond] })).code;
  check("proto-text", "text instead of a tool call -> protocol violation", await proto(() => ({ content: [{ type: "text", text: "Sales fell because..." }], usage: {} })), "planner_protocol_violation");
  check("proto-two", "two tool calls -> protocol violation", await proto(() => ({ content: [toolReply(ap.ANALYSIS_TOOL_NAME, { analysis: PLANS.decline }).content[0], toolReply(ap.ANALYSIS_TOOL_NAME, { analysis: PLANS.decline }).content[0]], usage: {} })), "planner_protocol_violation");
  check("proto-name", "the wrong tool name -> protocol violation", await proto(() => toolReply(PLANNER_TOOL_NAME, { plan: q({}) })), "planner_protocol_violation");
  check("proto-both", "a plan AND a decline -> protocol violation", await proto({ analysis: PLANS.decline, decline: { code: "unsupported_domain" } }), "planner_protocol_violation");
  check("proto-extra", "an extra top-level key -> protocol violation", await proto({ analysis: PLANS.decline, sql: "db.sales.find()" }), "planner_protocol_violation");
  const dec = await plan("forecast sales", { analysis: [{ decline: { code: "unsupported_domain", message: "Forecasts are not available." } }] });
  check("decline", "a decline passes through with its message (no plan, no repair)", [dec.status, dec.code, dec.reason, dec.usage.calls], ["unsupported", "analysis_unsupported_domain", "Forecasts are not available.", 1]);
  const clar = await plan("sales this year", { analysis: [{ decline: { code: "needs_clarification", message: "Financial or calendar year?" } }] });
  check("clarify", "a clarification passes through", [clar.status, clar.code], ["needs_clarification", "analysis_needs_clarification"]);

  console.log("\n=== 4. Invalid plans: at most ONE repair, only our codes go back ===");
  const notOffered = { v: 1, steps: [{ id: "m", kind: "insight", tool: "product_margin", args: { period: OCT, sortBy: "galaxy" } }] };
  let model = fakeModel({ analysis: [{ analysis: notOffered }, { analysis: PLANS.salesAndPurchases }] });
  let r = await ap.planAnalysis("margins in October 2025", { claudeClient: model, referenceDate: REF });
  const repairMsg = JSON.stringify(model.requests[1].messages[2]);
  check("repair-ok", "invalid insight arguments (an unknown margin sort) are rejected, repaired once, then supported (2 calls)", [r.status, r.usage.calls], ["supported", 2]);
  check("repair-content", "the repair message carries only validator codes (no data, no tenant)", [/invalid_insight_args@steps\.0\.args\.sortBy/.test(repairMsg), /TEST-TENANT/.test(repairMsg)], [true, false]);
  const badDep = { v: 1, steps: [{ id: "a", kind: "query", plan: q({}), inputs: [{ fromStep: "b", dim: "customer", take: 2 }] }, { id: "b", kind: "query", plan: q({ groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }) }] };
  model = fakeModel({ analysis: [{ analysis: badDep }, { analysis: badDep }] });
  r = await ap.planAnalysis("q October 2025", { claudeClient: model, referenceDate: REF });
  check("repair-exhausted", "an invalid dependency twice -> analysis_invalid_plan after exactly 2 calls (never a third)", [r.status, r.code, r.usage.calls, r.errors.map((e) => e.code)], ["planner_failed", "analysis_invalid_plan", 2, ["input_from_unknown_or_later_step"]]);
  const withTenant = { v: 1, steps: [{ id: "a", kind: "query", plan: q({}), tenantId: TB }] };
  r = await plan("q October 2025", { analysis: [{ analysis: withTenant }, { analysis: withTenant }] });
  check("tenant-in-plan", "a tenant inside the plan is rejected by the strict schema, never used", [r.code, r.errors[0].code], ["analysis_invalid_plan", "invalid_shape"]);
  const unknownTool = { v: 1, steps: [{ id: "a", kind: "insight", tool: "export_all_data", args: {} }] };
  check("unknown-tool", "an unknown tool is rejected", (await plan("q October 2025", { analysis: [{ analysis: unknownTool }, { analysis: unknownTool }] })).errors[0].code, "invalid_shape");
  const wrongEntity = { v: 1, steps: [{ id: "a", kind: "query", plan: q({ metrics: ["purchaseAmount"] }) }] };
  r = await plan("q October 2025", { analysis: [{ analysis: wrongEntity }, { analysis: PLANS.salesAndPurchases }] });
  check("repair-validator", "a query step the validator rejects (metric_not_applicable_to_entity) is repaired with that code", [r.status, r.usage.calls], ["supported", 2]);
  const unbounded = JSON.parse(JSON.stringify(PLANS.decline));
  unbounded.steps[1].plan.having = [];
  model = fakeModel({ analysis: [{ analysis: unbounded }, { analysis: PLANS.decline }] });
  r = await ap.planAnalysis("Why did sales fall in October 2025 compared with September 2025?", { claudeClient: model, referenceDate: REF });
  check("repair-change-sign", "customers ranked by fall without having delta lt 0 feeding a later step are repaired with input_change_sign_unbounded", [r.status, r.usage.calls, /input_change_sign_unbounded@steps\.2\.inputs\.0/.test(JSON.stringify(model.requests[1].messages[2]))], ["supported", 2, true]);
  check("prompt-change-sign", "the prompt states the rule (a change-ranked source keeps only its direction)", ap.getAnalysisPrompt().system[0].text.includes("must also keep only that direction with having"), true);
  const badArgs = { v: 1, steps: [{ id: "a", kind: "insight", tool: "product_trend", args: { period: OCT } }] };
  r = await plan("trend October 2025", { analysis: [{ analysis: badArgs }, { analysis: badArgs }] });
  check("insight-args", "an insight step with invalid arguments (no product) is rejected with invalid_insight_args", [r.code, r.errors[0].code], ["analysis_invalid_plan", "invalid_insight_args"]);
  const tooMany = { v: 1, steps: ["a", "b", "c", "d", "e"].map((id) => ({ id, kind: "query", plan: q({}) })) };
  check("max-steps", "more than 4 steps is rejected", (await plan("q October 2025", { analysis: [{ analysis: tooMany }, { analysis: tooMany }] })).errors[0].code, "invalid_shape");

  console.log("\n=== 5. Decided rules are final (never repaired) ===");
  const invented = { v: 1, steps: [{ id: "a", kind: "query", plan: q({ period: { kind: "custom", from: "2023-10-01", to: "2023-10-31" } }) }] };
  model = fakeModel({ analysis: [{ analysis: invented }] });
  r = await ap.planAnalysis("why did sales fall last month", { claudeClient: model, referenceDate: REF });
  check("year-guard", "a year the user never wrote -> year_missing clarification, one call, no repair", [r.status, r.code, model.requests.length], ["needs_clarification", "year_missing", 1]);
  const inventedTool = { v: 1, steps: [{ id: "a", kind: "insight", tool: "product_rates", args: { period: { kind: "custom", from: "2023-01-01", to: "2023-01-31" } } }] };
  check("year-guard-insight", "the year guard applies to insight-step periods too", (await plan("rates last month", { analysis: [{ analysis: inventedTool }] })).code, "year_missing");
  r = await plan("why did net sales fall in October 2025", { analysis: [{ analysis: PLANS.decline }] });
  check("term-guard", "a decided term (net sales) refuses the whole analysis with the catalog reason", [r.status, r.code], ["unsupported", "net_sales_unsupported"]);
  r = await plan("why did revenue fall in October 2025", { analysis: [{ analysis: PLANS.decline }] });
  check("revenue-guard", "revenue with an invoice-level step is refused (revenue means pre-tax item value)", [r.status, r.code], ["unsupported", "revenue_basis_unsupported"]);
  const marginPlan = { v: 1, steps: [{ id: "m", kind: "insight", tool: "product_margin", args: { period: OCT, sortBy: "marginPct", order: "asc" } }] };
  for (const qq of ["What was our gross margin in October 2025?", "profit by product in October 2025", "net margin for October 2025", "COGS for October 2025"]) {
    model = fakeModel({ analysis: [{ analysis: marginPlan }] });
    r = await ap.planAnalysis(qq, { claudeClient: model, referenceDate: REF });
    check(`accounting-profit: ${qq}`, "an accounting-profit question is refused with the catalog reason even when the plan asks for the indicative margin (one call, no repair)", [r.status, r.code, r.reason.startsWith("No cost/COGS data is available"), model.requests.length], ["unsupported", "profit_margin_unsupported", true, 1]);
  }
  check("plain-margin", "a plain margin question may use the indicative margin tool", (await plan("Which products have low margins in October 2025?", { analysis: [{ analysis: marginPlan }] })).status, "supported");
  const discountPlan = { v: 1, steps: [{ id: "d", kind: "insight", tool: "discount_summary", args: { period: OCT, by: "customer", limit: 5 } }] };
  check("plain-discount", "a discount question may use the discount tool", (await plan("How much discount did customers get in October 2025?", { analysis: [{ analysis: discountPlan }] })).status, "supported");
  const badBreakdown = { v: 1, steps: [{ id: "d", kind: "insight", tool: "discount_summary", args: { period: OCT, by: "supplier" } }] };
  check("discount-args", "the discount tool's own argument rules still apply (no supplier breakdown for sales)", (await plan("discounts October 2025", { analysis: [{ analysis: badBreakdown }, { analysis: badBreakdown }] })).errors[0].code, "invalid_insight_args");

  console.log("\n=== 6. Timeouts and aborts ===");
  r = await plan("q October 2025", { analysis: [Object.assign(new Error("Request timed out"), { name: "APIConnectionTimeoutError" })] });
  check("timeout", "a model timeout is planner_timeout (retryable), nothing runs", [r.code, r.retryable], ["planner_timeout", true]);
  const ac = new AbortController();
  ac.abort();
  model = fakeModel({ analysis: [{ analysis: PLANS.decline }] });
  r = await ap.planAnalysis("q October 2025", { claudeClient: model, referenceDate: REF, signal: ac.signal });
  check("abort", "an aborted request makes no model call", [r.code, model.requests.length], ["planner_call_failed", 0]);

  console.log("\n=== 7. The chat turn (synthetic data) ===");
  await connectDB();
  await cleanup();
  try {
    let n = 0;
    for (const [kind, tenantId, date, party, lines] of VOUCHERS) {
      n += 1;
      await (kind === "sale" ? Sale : Purchase).create({
        tenantId,
        header: { voucherNo: `APL-${n}`, voucherDate: new Date(`${date}T00:00:00Z`), voucherType: kind === "sale" ? "Invoice" : "Purchase", partyName: party, voucherTotalAmount: Math.abs(lines.reduce((s, l) => s + l[3], 0)), narration: "" },
        inventory: lines.map(([itemName, quantity, rate, amount]) => ({ itemName, quantity, rate, amount })),
        ledgers: [],
        tallyGuid: `apl-${tenantId}-${n}`,
        tallyAlterId: n,
        voucherStatus: "active",
      });
    }
    const NEEDS = { decline: { code: "needs_analysis", message: "This needs several analyses." } };
    const Q = "Why did sales fall in October 2025 compared with September 2025?";

    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: PLANS.decline }] });
    let out = await ask(TA, Q, model, { analysisEnabled: true });
    let meta = out.structured.details.queryEngine;
    check("chat-analysis", "flag on: the declined question is answered by an analysis plan (2 model calls, deterministic results)", [out.handled, meta.route, meta.status, meta.claudeCalls, meta.steps], [true, "analysis", "answered", 2, ["ok", "ok", "ok"]]);
    check("chat-text", "the answer shows the three steps' measured results and says it has no interpretation", [/measured results only \(no interpretation\)/.test(out.structured.answer), (out.structured.answer.match(/\*\*Step \d\*\*/g) || []).length, /1,700/.test(out.structured.answer), /Alpha Traders/.test(out.structured.answer), /Item P1/.test(out.structured.answer)], [true, 3, true, true, true]);
    check("chat-tenant", "another tenant's same-named customer (99,999) never appears", /99,999|99999/.test(out.structured.answer), false);
    check("chat-telemetry", "telemetry records the analysis route and both model calls", [out.telemetry.route, out.telemetry.claudeCalls], ["analysis", 2]);
    const usageRecordOf = (r) => require("./src/services/query/usageStore").buildUsageRecord(require("./src/services/query/turnTelemetry").buildTurnEvent({ tenantId: TA, requestId: "r-eval", metrics: r.telemetry, totalMs: 1, httpStatus: 200 }));
    check("chat-usage-path", "the persisted usage record tells an analysis turn apart (path analysis, 2 Claude calls)", [out.telemetry.path, usageRecordOf(out).path, usageRecordOf(out).claudeCalls], ["analysis", "analysis", 2]);

    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: PLANS.decline }] });
    out = await ask(TA, Q, model); // flag not set: the default
    meta = out.structured.details.queryEngine;
    check("chat-flag-off", "flag off (default): a refusal with ONE fixed message (never the model's varying wording), one call, no analysis call", [meta.route, meta.status, meta.code, meta.claudeCalls, model.requests.length, out.structured.answer.startsWith("This question needs several separate analyses"), out.structured.answer.includes("Multi-step analysis is not switched on"), out.structured.answer.includes("This needs several analyses."), out.structured.answer.endsWith(SCOPE_HINT)], ["planner", "unsupported", "planner_needs_analysis", 1, 1, true, true, false, true]);

    model = fakeModel({ query: [{ plan: q({}) }] });
    out = await ask(TA, "total sales in October 2025", model, { analysisEnabled: true });
    meta = out.structured.details.queryEngine;
    check("chat-ordinary", "an ordinary question with the flag on stays on the single-query path (1 call, planner route)", [meta.route, meta.status, meta.claudeCalls], ["planner", "answered", 1]);

    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: PLANS.productPerformance }] });
    out = await ask(TA, "How are products doing in October 2025 against September 2025?", model, { analysisEnabled: true });
    check("chat-insight-step", "a query step and an insight step in one analysis both answer", [out.structured.details.queryEngine.steps, /Sale and purchase rates per product/.test(out.structured.answer)], [["ok", "ok"], true]);

    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: PLANS.customerChanges }] });
    out = await ask(TA, "Which customers changed a lot in October 2025 versus September 2025?", model, { analysisEnabled: true });
    check("chat-both-directions", "two steps measure rises and falls separately (no rise above 50% here; Alpha and Delta fell)", [out.structured.details.queryEngine.steps, /Delta Corp/.test(out.structured.answer)], [["ok", "ok"], true]);

    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: PLANS.salesAndPurchases }] });
    out = await ask(TA, "Compare sales and purchases in October 2025 with September 2025", model, { analysisEnabled: true });
    check("chat-sales-purchases", "sales and purchases are measured in separate steps, each as measured (no combined figure)", [out.structured.details.queryEngine.steps, /1,200/.test(out.structured.answer), /550/.test(out.structured.answer)], [["ok", "ok"], true, true]);

    model = fakeModel({ query: [NEEDS], analysis: [{ decline: { code: "unsupported_domain", message: "Forecasts are not available." } }] });
    let engineRan = false;
    out = await ask(TA, "What will sales be next quarter and why?", model, { analysisEnabled: true, execute: async () => { engineRan = true; return { result: { ok: false } }; } });
    check("chat-unsupported", "the analysis planner's decline is the answer; nothing is executed", [out.structured.details.queryEngine.status, out.structured.answer.startsWith("Forecasts are not available."), engineRan], ["unsupported", true, false]);
    check("chat-unsupported-path", "an analysis decline is recorded as path analysis_declined", out.telemetry.path, "analysis_declined");

    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: badDep }, { analysis: badDep }] });
    out = await ask(TA, Q, model, { analysisEnabled: true });
    check("chat-invalid", "an analysis plan still invalid after the repair -> the fixed planner message, 3 calls in all", [out.structured.details.queryEngine.status, out.structured.details.queryEngine.code, out.structured.details.queryEngine.claudeCalls], ["planner_failed", "analysis_invalid_plan", 3]);
    check("chat-invalid-path", "an analysis plan that cannot run is recorded as path analysis_failed", out.telemetry.path, "analysis_failed");

    const oldAndNew = { v: 1, steps: [{ id: "old", kind: "query", plan: q({ period: { kind: "custom", from: "2025-03-01", to: "2025-03-31" } }) }, { id: "oct", kind: "query", plan: q({}) }] };
    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: oldAndNew }] });
    out = await ask(TA, "Sales in March 2025 and October 2025, what changed?", model, { analysisEnabled: true });
    check("chat-coverage", "a step outside the synced history is shown as not run (missing data), the other step answers", [out.structured.details.queryEngine.steps, /Not run: .*missing data, not zero/.test(out.structured.answer)], [["refused", "ok"], true]);

    // ---- discount and indicative margin (tenant C): fixed headings, the existing notes, and notes that match the data
    const insights = require("./src/services/analytics/insights");
    const DM = { v: 1, steps: [{ id: "d", kind: "insight", tool: "discount_summary", args: { period: OCT } }, { id: "m", kind: "insight", tool: "product_margin", args: { period: OCT } }] };
    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: DM }] });
    out = await ask(TC, "How much discount did we give and what are the indicative product margins in October 2025?", model, { analysisEnabled: true });
    const A = out.structured.answer;
    check("dm-ran", "both insight steps answer", out.structured.details.queryEngine.steps, ["ok", "ok"]);
    check("dm-discount-heading", "the discount heading states the basis: list value minus billed amount, before tax", A.includes("Discount = list value − billed amount (before tax), 2025-10-01 to 2025-10-31:"), true);
    check("dm-discount-total", "the discount total is the tool's own figure: 100 + 90 = 190 on a list value of 1,300 (14.62%), billed 1,110", A.includes("Total: discount 190 on a list value of 1,300 (14.62%), billed 1,110."), true);
    check("dm-discount-note", "the existing DISCOUNT_NOTE is shown verbatim", A.includes(insights.DISCOUNT_NOTE), true);
    check("dm-discount-norate", "1 line without a rate -> its note (and only because the data has one)", A.includes("1 item line has no rate or quantity and is not in the discount figures."), true);
    check("dm-discount-excluded", "1 line billed below 5% of list value -> its note", A.includes("1 item line was billed below 5% of list value (and not free) and left out: more likely a different unit than a discount."), true);
    check("dm-margin-heading", "the margin heading says indicative and not accounting profit", A.includes("Indicative margin per product (not accounting profit), 2025-10-01 to 2025-10-31:"), true);
    check("dm-margin-note", "the existing MARGIN_NOTE is shown verbatim", A.includes(insights.MARGIN_NOTE), true);
    check("dm-margin-labels", "row labels say indicative", [A.includes("Indicative unit margin: 32.73"), A.includes("Indicative margin %")], [true, true]);
    check("dm-margin-nocost", "2 of 4 products have no purchase cost (Item NoRate, Item Odd) -> its note", A.includes("2 of 4 products have no purchase cost in the period or the 12 months before: they have no margin and are listed last."), true);
    check("dm-margin-earlier", "Item M2's cost comes from March 2025 -> the 12-months-before note", A.includes("For 1 product shown, the cost is the average purchase rate of the 12 months before the period (nothing was bought in it)."), true);
    check("dm-margin-unit", "Item M1 was sold at 90 and at 10 per unit (more than 5x) -> the unit-of-measure note", A.includes("1 product shown has line rates that differ by more than 5×: the unit of measure may differ between vouchers."), true);
    check("dm-not-a-cause", "both steps state that the figures alone do not explain a change in sales", (A.match(/on their own they do not explain a change in sales/g) || []).length >= 2, true);
    check("dm-profit-wording", "every 'profit' in the answer is 'indicative profit' or 'accounting profit'", (A.match(/\w*\s*profit/gi) || []).every((m) => /^(indicative|accounting)\s+profit$/i.test(m.trim())), true);
    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: { v: 1, steps: [{ id: "d", kind: "insight", tool: "discount_summary", args: { period: OCT } }] } }] });
    out = await ask(TA, "discounts in October 2025?", model, { analysisEnabled: true });
    check("dm-no-false-notes", "clean data (tenant A) gets no conditional discount notes", [/no rate or quantity|below 5% of list value \(and not free\)/.test(out.structured.answer), out.structured.answer.includes("Total: discount 100")], [false, true]);

    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: marginPlan }] });
    out = await ask(TC, "What was our gross margin in October 2025?", model, { analysisEnabled: true });
    check("dm-accounting-profit-chat", "in chat, an accounting-profit question answered with the margin tool is refused with the catalog reason", [out.structured.details.queryEngine.status, out.structured.details.queryEngine.code, out.structured.answer.startsWith("No cost/COGS data is available")], ["unsupported", "profit_margin_unsupported", true]);

    console.log("\n=== 8. The same rules and notes as the single-query answer ===");
    const planner = require("./src/services/query/planner");
    // The query planner (planQuestion) and an analysis step (checkAnalysis) given the SAME model plan for the same question
    // must end with the same plan and the same definition notes: one implementation of the decided rules (applyPlanRules).
    const bothWays = async (question, qplan) => {
      const single = await planner.planQuestion(question, { claudeClient: fakeModel({ query: [{ plan: qplan }] }), referenceDate: REF });
      const checked = ap.checkAnalysis(question, { v: 1, steps: [{ id: "a", kind: "query", plan: qplan }] }, REF);
      return [single.status, JSON.stringify(checked.plan.steps[0].plan) === JSON.stringify(single.plan), (checked.notes.a || []).map((n) => n.code), single.definitionNotes.map((n) => n.code)];
    };
    check("rules-month", "this month vs last month: the step compares with the COMPLETE previous month, like the single query", await bothWays("Why are sales down this month compared with last month?", q({ period: { kind: "current_month" }, compare: { mode: "like_for_like" } })), ["supported", true, ["month_vs_complete_previous_month"], ["month_vs_complete_previous_month"]]);
    check("rules-month-same-days", "asked for the same days: the step keeps like-for-like, like the single query", await bothWays("Why are sales down this month compared with the same days last month?", q({ period: { kind: "current_month" }, compare: { mode: "like_for_like" } })), ["supported", true, [], []]);
    check("rules-product-value", "products measured by quantity without unit words: the step switches to sales value, like the single query", await bothWays("Which products drove sales in October 2025?", q({ metrics: ["quantity"], groupBy: [{ dim: "product" }], sort: [{ by: "quantity", dir: "desc" }], limit: 5 })), ["supported", true, ["product_value_default_applied"], ["product_value_default_applied"]]);
    check("rules-last-year", "'last year' read as the previous financial year carries the same note", await bothWays("Why did sales fall last year?", q({ period: { kind: "previous_fy" } })), ["supported", true, ["last_year_previous_fy"], ["last_year_previous_fy"]]);

    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: { v: 1, steps: [{ id: "r", kind: "query", plan: q({ metrics: ["lineAmount"], compare: VS_SEP }) }] } }] });
    out = await ask(TA, "Why did revenue fall in October 2025 compared with September 2025?", model, { analysisEnabled: true });
    check("rules-revenue-chat", "a revenue analysis states the revenue definition (pre-tax item value), as the single-query answer does", [out.structured.details.queryEngine.status, out.structured.answer.includes(planner.REVENUE_ASSUMPTION.message)], ["answered", true]);

    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: { v: 1, steps: [{ id: "z", kind: "query", plan: q({ filters: [{ dim: "product", op: "eq_ci", value: "Item P3" }] }) }] } }] });
    out = await ask(TA, "Why did Item P3 not sell in October 2025?", model, { analysisEnabled: true });
    check("notes-data-through", "an empty step says how far the company's data goes (latest voucher 15 Oct 2025), as the single-query answer does", /No matching records[^\n]*latest voucher in this company is dated 15 Oct 2025/.test(out.structured.answer), true);

    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: { v: 1, steps: [{ id: "m", kind: "query", plan: q({ period: { kind: "previous_month" } }) }] } }] });
    out = await ask(TA, "Why did sales change last month?", model, { analysisEnabled: true, getDateContext: async () => ({ ...DATE_CONTEXT, futureVouchers: true, wallClock: REF }) });
    check("notes-future-vouchers", "a relative period with vouchers dated after today carries the future-vouchers note", /vouchers dated after today/.test(out.structured.answer), true);

    const staleBuy = (state) => async (t, vt) => (vt === "Purchase" ? { state, message: `Purchase sync note (${state}).`, dataAsOf: null } : { state: "fresh", message: "", dataAsOf: null });
    for (const [state, toolState] of [["stale", "stale_data"], ["sync_failed", "sync_failed"]]) {
      model = fakeModel({ query: [NEEDS], analysis: [{ analysis: PLANS.salesAndPurchases }] });
      out = await ask(TA, "Compare sales and purchases in October 2025 with September 2025", model, { analysisEnabled: true, getFreshness: staleBuy(state) });
      check(`fresh-${state}`, `purchases ${state}: the answer is marked ${toolState} and warns, never shown as current data`, [out.structured.details.queryEngine.steps, out.structured.details.toolCalls[0].state, out.structured.warnings.includes(`Purchase sync note (${state}).`)], [["ok", "ok"], toolState, true]);
    }
    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: PLANS.salesAndPurchases }] });
    out = await ask(TA, "Compare sales and purchases in October 2025 with September 2025", model, { analysisEnabled: true });
    check("fresh-current", "current data: valid_data and no sync warning", [out.structured.details.toolCalls[0].state, out.structured.warnings.some((w) => /sync/i.test(w))], ["valid_data", false]);

    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: PLANS.salesAndPurchases, assumptions: ["October 2025 is compared with September 2025", "invoiceAmount.delta is the change"] }] });
    out = await ask(TA, "Compare sales and purchases in October 2025 with September 2025", model, { analysisEnabled: true });
    check("assumptions-shown", "the analysis planner's assumptions are shown with the single-query label, metric ids in plain words", [out.structured.answer.includes("Interpretation (AI-assisted): October 2025 is compared with September 2025"), /Interpretation \(AI-assisted\): [^\n]*invoiceAmount/.test(out.structured.answer)], [true, false]);

    console.log("\n=== 9. Routing: what one query cannot express reaches the analysis path (flag on) ===");
    const discountPlan = { v: 1, steps: [{ id: "d", kind: "insight", tool: "discount_summary", args: { period: OCT, by: "customer" } }] };
    const badQuery = { plan: q({ metrics: ["discountAmount"] }) }; // the model invents a metric: the plan schema rejects it
    model = fakeModel({ query: [badQuery], analysis: [{ analysis: discountPlan }] });
    out = await ask(TA, "How much discount did we give customers in October 2025?", model, { analysisEnabled: true });
    check("route-invalid-plan", "a plan one query cannot express (invalid) goes to the analysis planner: the discount tool answers (hand-derived: list 100+300+800+600 = 1,800; discount 100 on Beta Stores' 800)", [out.structured.details.queryEngine.route, out.structured.details.queryEngine.claudeCalls, /Discount = list value − billed amount \(before tax\)/.test(out.structured.answer), /Total: discount 100 on a list value of 1,800 \(5\.56%\), billed 1,700/.test(out.structured.answer), /Beta Stores/.test(out.structured.answer)], ["analysis", 2, true, true, true]);
    model = fakeModel({ query: [badQuery], analysis: [{ analysis: discountPlan }] });
    out = await ask(TA, "How much discount did we give customers in October 2025?", model);
    check("route-invalid-plan-off", "flag off: the same failure keeps its honest fixed message, one call, no analysis call", [out.structured.details.queryEngine.status, out.structured.details.queryEngine.code, model.requests.length, /couldn't turn this question into a query/.test(out.structured.answer)], ["planner_failed", "planner_invalid_plan", 1, true]);
    model = fakeModel({ query: [{ plan: q({ metrics: ["grossProfit"] }) }], analysis: [{ analysis: marginPlan }] });
    out = await ask(TC, "What was our gross profit in October 2025?", model, { analysisEnabled: true });
    check("route-gross-profit", "gross profit stays refused with the catalog reason (no cost data), never routed to the indicative margin", [out.structured.details.queryEngine.code, model.requests.length, /No cost\/COGS data is available/.test(out.structured.answer), /Indicative margin/.test(out.structured.answer)], ["profit_margin_unsupported", 1, true, false]);
    model = fakeModel({ query: [{ decline: { code: "unsupported_domain", message: "Forecasts are not available." } }], analysis: [{ analysis: PLANS.decline }] });
    out = await ask(TA, "What will sales be next quarter?", model, { analysisEnabled: true });
    check("route-forecast", "a forecast stays the planner's refusal, one call (never routed, never computed)", [out.structured.details.queryEngine.route, out.structured.details.queryEngine.status, model.requests.length], ["planner", "unsupported", 1]);
    // relative periods: last month vs the month before, with the reference date 5 Nov 2025 -> October vs September 2025
    const relative = { v: 1, steps: [
      { id: "tot", kind: "query", plan: q({ period: { kind: "previous_month" }, compare: { mode: "like_for_like" } }) },
      { id: "cust", kind: "query", plan: q({ period: { kind: "previous_month" }, compare: { mode: "like_for_like" }, groupBy: [{ dim: "customer" }], having: [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 5 }) },
      { id: "prod", kind: "query", plan: q({ period: { kind: "previous_month" }, compare: { mode: "like_for_like" }, metrics: ["lineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 }), inputs: [{ fromStep: "cust", dim: "customer", take: 5 }] },
    ] };
    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: relative }] });
    out = await ask(TA, "Why did sales fall last month compared with the month before?", model, { analysisEnabled: true });
    // hand-derived: Sep 2,500 (Alpha 1,000, Beta 800, Gamma 500, Delta 200); Oct 1,700 (Alpha 400, Beta 700, Gamma 600)
    check("relative-compare", "last month vs the month before needs no year: October 1,700 vs September 2,500; fallers Alpha, Delta, Beta (Gamma grew)", [out.structured.details.queryEngine.steps, /1,700/.test(out.structured.answer) && /2,500/.test(out.structured.answer), /Gamma Mart/.test(out.structured.answer.split("**Step 3**")[0].split("**Step 2**")[1] || "x")], [["ok", "ok", "ok"], true, false]);
    const invented = { v: 1, steps: [{ id: "tot", kind: "query", plan: q({ period: { kind: "previous_month" }, compare: VS_SEP }) }] };
    model = fakeModel({ query: [NEEDS], analysis: [{ analysis: invented }] });
    out = await ask(TA, "Why did sales fall last month compared with the month before?", model, { analysisEnabled: true });
    check("relative-invented-year", "the same question planned with invented dates is still caught by the year guard (asked, never guessed)", [out.structured.details.queryEngine.status, out.structured.details.queryEngine.code], ["needs_clarification", "year_missing"]);

    const stop = new AbortController();
    model = fakeModel({ query: [NEEDS], analysis: [(req) => { stop.abort(); return toolReply(ap.ANALYSIS_TOOL_NAME, { analysis: PLANS.decline }); }] });
    let engineRuns = 0;
    out = await tryAnswerWithQueryEngine({ context: { tenantId: TA, userId: "u-analysis" }, userMessage: Q, conversationHistory: [], signal: stop.signal, deps: { plannerClient: model, getFreshness: fresh, getDateContext: async () => DATE_CONTEXT, analysisEnabled: true, execute: async () => { engineRuns += 1; return { result: { ok: false } }; } } });
    check("abort-chat", "the user stopped while the analysis was planned: no step runs and nothing is answered", [out.handled, out.reason, engineRuns], [false, "client_aborted", 0]);
  } finally {
    await cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("verify-analysis-planner crashed:", err && err.message, err && err.stack && err.stack.split("\n")[1]);
  try { await cleanup(); await mongoose.disconnect(); } catch { /* best-effort */ }
  process.exit(1);
});
