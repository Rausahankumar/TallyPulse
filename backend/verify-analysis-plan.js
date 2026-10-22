/**
 * Analysis plans (services/query/analysisPlan.js), Milestone 1: a general multi-step plan over the existing query engine and
 * insight tools, run by a deterministic executor. No model, no chat wiring.
 *
 * The end-to-end case is a 3-step analysis plus one insight step on synthetic data with hand-computed values:
 *   s1 total sales, October vs September -> s2 customers by change (largest fall first, top 2) ->
 *   s3 product change for exactly s2's customers (an input binding) ; s4 discount by product in October (insight tool).
 * Also: plan validation (budgets, ids, dependencies, strictness), tenant isolation, name re-resolution, the freshness and
 * coverage gates, an empty or failed input never running unfiltered, engine failures with plain messages, the deadline.
 *
 * Synthetic data only, on a loopback MongoDB (refused otherwise). No network, no Tally, no model. Data removed at the end.
 *
 * Run: node verify-analysis-plan.js
 */

require("dotenv").config();
{
  const uri = process.env.MONGODB_URI || "";
  const host = (/^mongodb:\/\/(?:[^@/]*@)?\[?([^\]/:,]+)\]?(?::\d+)?[/?]/.exec(uri) || [])[1];
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || /mongodb\+srv|mongodb\.net|atlas/i.test(uri)) {
    console.error("REFUSED: verify-analysis-plan.js only runs against a loopback MongoDB. Nothing was touched.");
    process.exit(2);
  }
  require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };
}
process.env.AI_USAGE_PERSIST = "off";

const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Sale = require("./src/models/sales.model");
const TenantDataVersion = require("./src/models/tenantDataVersion.model");
const analysis = require("./src/services/query/analysisPlan");
const insightTools = require("./src/services/analytics/insightTools");

let pass = 0;
let fail = 0;
function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}

const TA = "TEST-TENANT-A-analysis-plan";
const TB = "TEST-TENANT-B-analysis-plan";
let n = 0;
// [tenant, date, customer, [[item, qty, rate, amount], ...]] - the invoice total is the sum of its lines here
const VOUCHERS = [
  [TA, "2025-09-05", "Alpha Traders", [["Item P1", 6, 100, 600], ["Item P2", 4, 100, 400]]],
  [TA, "2025-09-08", "Beta Stores", [["Item P1", 8, 100, 800]]],
  [TA, "2025-09-12", "Gamma Mart", [["Item P2", 5, 100, 500]]],
  [TA, "2025-09-20", "Delta Corp", [["Item P3", 2, 100, 200]]],
  [TA, "2025-10-03", "Alpha Traders", [["Item P1", 1, 100, 100], ["Item P2", 3, 100, 300]]],
  [TA, "2025-10-09", "Beta Stores", [["Item P1", 10, 80, 700]]], // list 800, billed 700: a 100 discount
  [TA, "2025-10-15", "Gamma Mart", [["Item P2", 6, 100, 600]]],
  // Delta Corp buys nothing in October
  [TB, "2025-10-04", "Alpha Traders", [["Item P9", 1, 99999, 99999]]], // another tenant, same customer name
  [TB, "2025-09-04", "Alpha Traders", [["Item P9", 1, 1, 1]]],
];
const cleanup = async () => {
  const ids = { $in: [TA, TB] };
  await Promise.all([Sale.deleteMany({ tenantId: ids }), TenantDataVersion.deleteMany({ tenantId: ids })]);
};

const OCT = { kind: "custom", from: "2025-10-01", to: "2025-10-31" };
const VS_SEP = { mode: "custom", period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" } };
const q = (o) => ({ v: 1, entity: "sales", mode: "aggregate", period: OCT, metrics: ["invoiceAmount"], groupBy: [], filters: [], ...o });
const DATE_CONTEXT = Object.freeze({
  referenceDate: new Date(2025, 10, 5, 23, 59, 59, 999),
  coverage: Object.freeze({ earliest: new Date(2025, 8, 1), latest: new Date(2025, 9, 31), lastSyncedAt: null }),
});
const FRESH = async () => ({ state: "fresh", message: "" });
const ctx = (tenantId, extra = {}) => ({ tenantId, dateContext: DATE_CONTEXT, getFreshness: FRESH, ...extra });

const THREE_STEPS = {
  v: 1,
  steps: [
    { id: "s1", kind: "query", plan: q({ compare: VS_SEP }) },
    { id: "s2", kind: "query", plan: q({ groupBy: [{ dim: "customer" }], compare: VS_SEP, having: [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 2 }) },
    { id: "s3", kind: "query", plan: q({ metrics: ["lineAmount"], groupBy: [{ dim: "product" }], compare: VS_SEP, sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 }), inputs: [{ fromStep: "s2", dim: "customer", take: 2 }] },
    { id: "s4", kind: "insight", tool: "discount_summary", args: { period: OCT, by: "product", limit: 5 } },
  ],
};

async function main() {
  await connectDB();
  await cleanup();
  try {
    for (const [tenantId, date, party, lines] of VOUCHERS) {
      n += 1;
      await Sale.create({
        tenantId,
        header: { voucherNo: `AP-${n}`, voucherDate: new Date(`${date}T00:00:00Z`), voucherType: "Invoice", partyName: party, voucherTotalAmount: lines.reduce((s, l) => s + l[3], 0), narration: "" },
        inventory: lines.map(([itemName, quantity, rate, amount]) => ({ itemName, quantity, rate, amount })),
        ledgers: [],
        tallyGuid: `ap-${tenantId}-${n}`,
        tallyAlterId: n,
        voucherStatus: "active",
      });
    }

    console.log("=== 1. End to end: a 3-step analysis plus an insight step ===");
    const toolCalls = [];
    const spyTool = async (tool, args, c) => { toolCalls.push(c.tenantId); return insightTools.runInsightTool(tool, args, c); };
    const r = await analysis.executeAnalysisPlan(THREE_STEPS, ctx(TA, { runInsightTool: spyTool }));
    const [s1, s2, s3, s4] = r.steps;
    check("e2e-ok", "every step ran", [r.ok, r.steps.map((s) => s.status)], [true, ["ok", "ok", "ok", "ok"]]);
    check("s1-total", "s1: October 1,700 vs September 2,500, change -800", [s1.result.totals.values.invoiceAmount, s1.result.totals.comparison.invoiceAmount.previous, s1.result.totals.comparison.invoiceAmount.delta], [1700, 2500, -800]);
    check("s2-customers", "s2: the two largest falls, largest first: Alpha -600, Delta -200 (Delta bought nothing in October)", s2.result.rows.map((x) => [x.key.customer, x.comparison.invoiceAmount.delta]), [["Alpha Traders", -600], ["Delta Corp", -200]]);
    check("s3-binding", "s3 is filtered by EXACTLY s2's two customers (the input binding)", s3.bindings, [{ fromStep: "s2", dim: "customer", values: ["Alpha Traders", "Delta Corp"] }]);
    check("s3-request", "the binding is an ordinary in_ci filter in s3's query plan", s3.request.filters, [{ dim: "customer", op: "in_ci", value: ["Alpha Traders", "Delta Corp"] }]);
    check("s3-products", "s3: product change for those customers, largest fall first: P1 -500, P3 -200, P2 -100", s3.result.rows.map((x) => [x.key.product, x.comparison.lineAmount.delta]), [["Item P1", -500], ["Item P3", -200], ["Item P2", -100]]);
    check("s4-insight", "s4: the insight tool's evidence: October discount by product, P1 first with 100", [s4.source, s4.result.tool, s4.result.data.rows[0].key, s4.result.data.rows[0].discountAmount], ["insight_tool", "discount_summary", "Item P1", 100]);
    check("facts", "query steps carry the deterministic formatter's text (facts, not model text)", [typeof s1.facts, /1,700|1700/.test(s1.facts)], ["string", true]);
    check("no-diagnostics", "engine diagnostics are not passed on as evidence", "diagnostics" in s1.result, false);
    check("budget", "the result reports the budget used", [r.budget.maxSteps, r.budget.steps, r.budget.ran], [analysis.MAX_STEPS, 4, 4]);
    check("tenant-tool", "the insight tool got the tenant from the context", toolCalls, [TA]);
    check("tenant-isolation", "tenant B's 99,999 sale to a same-named customer never appears in tenant A's analysis", JSON.stringify(r).includes("99999"), false);
    const rb = await analysis.executeAnalysisPlan({ v: 1, steps: [THREE_STEPS.steps[0]] }, ctx(TB));
    check("tenant-b", "the same plan for tenant B reads only B's data (99,999 vs 1)", [rb.steps[0].result.totals.values.invoiceAmount, rb.steps[0].result.totals.comparison.invoiceAmount.previous], [99999, 1]);

    console.log("\n=== 2. Plan validation (no database) ===");
    const issues = (plan) => { const p = analysis.parseAnalysisPlan(plan); return p.ok ? "ok" : p.errors.map((e) => e.code); };
    const S = (id, extra = {}) => ({ id, kind: "query", plan: q({}), ...extra });
    check("val-ok", "the end-to-end plan is valid", issues(THREE_STEPS), "ok");
    check("val-max-steps", `more than ${analysis.MAX_STEPS} steps is rejected`, issues({ v: 1, steps: ["a", "b", "c", "d", "e"].map((x) => S(x)) }), ["invalid_shape"]);
    check("val-empty", "an empty plan is rejected", issues({ v: 1, steps: [] }), ["invalid_shape"]);
    check("val-dup", "a duplicate step id is rejected", issues({ v: 1, steps: [S("a"), S("a")] }), ["duplicate_step_id"]);
    check("val-later", "an input from a LATER step is rejected (no cycles possible)", issues({ v: 1, steps: [S("a", { inputs: [{ fromStep: "b", dim: "customer", take: 2 }] }), S("b", { plan: q({ groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }) })] }), ["input_from_unknown_or_later_step"]);
    check("val-not-grouped", "an input from a step not grouped by that dimension is rejected", issues({ v: 1, steps: [S("a"), S("b", { inputs: [{ fromStep: "a", dim: "customer", take: 2 }] })] }), ["input_source_not_grouped_by_dim"]);
    check("val-from-insight", "an input from an insight step is rejected (only query results bind)", issues({ v: 1, steps: [{ id: "a", kind: "insight", tool: "product_margin", args: { period: OCT } }, S("b", { inputs: [{ fromStep: "a", dim: "product", take: 2 }] })] }), ["input_source_not_grouped_by_dim"]);
    check("val-conflict", "binding a dimension the step already filters is rejected", issues({ v: 1, steps: [S("a", { plan: q({ groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }) }), S("b", { plan: q({ filters: [{ dim: "customer", op: "eq_ci", value: "Alpha Traders" }] }), inputs: [{ fromStep: "a", dim: "customer", take: 2 }] })] }), ["input_dimension_already_filtered"]);
    check("val-take", `taking more than ${analysis.MAX_INPUT_VALUES} values is rejected`, issues({ v: 1, steps: [S("a", { plan: q({ groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }) }), S("b", { inputs: [{ fromStep: "a", dim: "customer", take: 21 }] })] }), ["invalid_shape"]);
    check("val-tenant", "a tenantId anywhere in the plan is rejected (strict shapes)", [issues({ v: 1, tenantId: TB, steps: [S("a")] }), issues({ v: 1, steps: [S("a", { tenantId: TB })] }), issues({ v: 1, steps: [S("a", { plan: { ...q({}), tenantId: TB } })] })], [["invalid_shape"], ["invalid_shape"], ["invalid_query_plan"]]);
    check("val-unknown-kind", "an unknown step kind or insight tool is rejected", [issues({ v: 1, steps: [{ id: "a", kind: "mongo", pipeline: [] }] }), issues({ v: 1, steps: [{ id: "a", kind: "insight", tool: "drop_db", args: {} }] })], [["invalid_shape"], ["invalid_shape"]]);
    check("val-bad-query", "a step whose query plan breaks the Query Plan schema is rejected", issues({ v: 1, steps: [S("a", { plan: q({ metrics: ["madeUpMetric"] }) })] }), ["invalid_query_plan"]);
    check("no-tenant", "no tenant in the context -> refused before anything runs", (await analysis.executeAnalysisPlan(THREE_STEPS, { dateContext: DATE_CONTEXT })).error.code, "tenant_required");

    console.log("\n=== 3. Dependencies never run unfiltered ===");
    let engineCalls = 0;
    const realExec = require("./src/services/query/answerCache").createDefaultCachedExecutor();
    const countingExec = (plan, c) => { engineCalls += 1; return realExec.execute(plan, c); };
    const emptySource = { v: 1, steps: [S("a", { plan: q({ groupBy: [{ dim: "customer" }], compare: VS_SEP, having: [{ metric: "invoiceAmount.delta", op: "lt", value: -100000 }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }] }) }), S("b", { plan: q({ metrics: ["lineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }] }), inputs: [{ fromStep: "a", dim: "customer", take: 5 }] })] };
    const e = await analysis.executeAnalysisPlan(emptySource, ctx(TA, { execute: countingExec }));
    check("empty-input", "a source with no rows -> the dependent step is skipped, not run without its filter", [e.steps[0].status, e.steps[0].result.rows.length, e.steps[1].status, e.steps[1].reason, engineCalls], ["ok", 0, "skipped", "no_input_values", 1]);
    const failedSource = { v: 1, steps: [S("a", { plan: q({ metrics: ["purchaseAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "purchaseAmount", dir: "desc" }] }) }), S("b", { inputs: [{ fromStep: "a", dim: "customer", take: 2 }] }), S("c")] };
    const f = await analysis.executeAnalysisPlan(failedSource, ctx(TA));
    check("failed-input", "an invalid source is refused, its dependent is skipped, an independent step still runs", [f.steps[0].status, f.steps[0].error.code, f.steps[0].error.codes, f.steps[1].status, f.steps[1].reason, f.steps[2].status], ["refused", "invalid_query", ["metric_not_applicable_to_entity"], "skipped", "dependency_not_available", "ok"]);

    // Oct vs Sep by customer: Alpha -600, Delta -200, Beta -100 fell; Gamma +100 grew. A source ranked by change must keep
    // only that direction, so a grower is never bound as a decliner (sorting alone would put Gamma 4th).
    const ranked = (dir, having, limit = 5) => S("src", { plan: q({ groupBy: [{ dim: "customer" }], compare: VS_SEP, having, sort: [{ by: "invoiceAmount.delta", dir }], limit }) });
    const dependent = (take) => S("dep", { plan: q({ metrics: ["lineAmount"], groupBy: [{ dim: "product" }], compare: VS_SEP, sort: [{ by: "lineAmount", dir: "desc" }] }), inputs: [{ fromStep: "src", dim: "customer", take }] });
    const FELL = [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }];
    check("sign-unbounded", "a dependent of a change-ranked source with no sign having is rejected", issues({ v: 1, steps: [ranked("asc", []), dependent(4)] }), ["input_change_sign_unbounded"]);
    check("sign-zero", "a having that lets a zero change through (lte 0 / gte 0) is rejected", [issues({ v: 1, steps: [ranked("asc", [{ metric: "invoiceAmount.delta", op: "lte", value: 0 }]), dependent(4)] }), issues({ v: 1, steps: [ranked("desc", [{ metric: "invoiceAmount.delta", op: "gte", value: 0 }]), dependent(4)] })], [["input_change_sign_unbounded"], ["input_change_sign_unbounded"]]);
    check("sign-direction", "a having for the other direction, or on another metric, is rejected", [issues({ v: 1, steps: [ranked("desc", FELL), dependent(4)] }), issues({ v: 1, steps: [S("src", { plan: q({ metrics: ["invoiceAmount", "lineAmount"], groupBy: [{ dim: "customer" }], compare: VS_SEP, having: [{ metric: "lineAmount.delta", op: "lt", value: 0 }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }] }) }), dependent(4)] })], [["input_change_sign_unbounded"], ["input_change_sign_unbounded"]]);
    check("sign-accepted", "lt 0 on delta or deltaPct, a stricter threshold, and a change ranking nothing depends on are valid", [issues({ v: 1, steps: [ranked("asc", FELL), dependent(4)] }), issues({ v: 1, steps: [ranked("asc", [{ metric: "invoiceAmount.deltaPct", op: "lt", value: 0 }]), dependent(4)] }), issues({ v: 1, steps: [ranked("asc", [{ metric: "invoiceAmount.delta", op: "lte", value: -150 }]), dependent(4)] }), issues({ v: 1, steps: [ranked("asc", [])] })], ["ok", "ok", "ok", "ok"]);
    const fewer = await analysis.executeAnalysisPlan({ v: 1, steps: [ranked("asc", FELL), dependent(5)] }, ctx(TA));
    check("sign-fewer-falls", "5 requested, 3 fell: exactly Alpha, Delta, Beta are bound; Gamma (+100) never is", [fewer.steps.map((s) => s.status), fewer.steps[1].bindings[0].values], [["ok", "ok"], ["Alpha Traders", "Delta Corp", "Beta Stores"]]);
    check("sign-fewer-result", "the dependent step measures only those customers' products (Gamma's P2 600 in October is not in it; Delta's P3 is September-only)", fewer.steps[1].result.rows.map((r) => [r.key.product, r.values.lineAmount]), [["Item P1", 800], ["Item P2", 300], ["Item P3", 0]]);
    const rises = await analysis.executeAnalysisPlan({ v: 1, steps: [ranked("desc", [{ metric: "invoiceAmount.delta", op: "gt", value: 0 }]), dependent(5)] }, ctx(TA));
    check("sign-rises", "the same rule for rises: only Gamma is bound", rises.steps[1].bindings[0].values, ["Gamma Mart"]);
    let depCalls = 0;
    const dropHaving = (plan, c) => { if (plan.groupBy.some((g) => g.dim === "customer")) plan = { ...plan, having: [] }; else depCalls += 1; return realExec.execute(plan, c); };
    const mismatch = await analysis.executeAnalysisPlan({ v: 1, steps: [ranked("asc", FELL), dependent(4)] }, ctx(TA, { execute: dropHaving }));
    check("sign-mismatch", "a source row whose computed change is not a fall (Gamma +100) skips the dependent step; it never runs", [mismatch.steps[0].result.rows.map((r) => r.key.customer), mismatch.steps[1].status, mismatch.steps[1].reason, depCalls], [["Alpha Traders", "Delta Corp", "Beta Stores", "Gamma Mart"], "skipped", "input_change_sign_mismatch", 0]);

    console.log("\n=== 4. Names, freshness, coverage, engine failures, deadline ===");
    const named = await analysis.executeAnalysisPlan({ v: 1, steps: [S("a", { plan: q({ filters: [{ dim: "customer", op: "eq_ci", value: "alpha traders" }] }) })] }, ctx(TA));
    check("name-resolved", "a typed name is re-resolved to the tenant's stored spelling", [named.steps[0].status, named.steps[0].request.filters[0].value, named.steps[0].result.totals.values.invoiceAmount], ["ok", "Alpha Traders", 400]);
    const unknown = await analysis.executeAnalysisPlan({ v: 1, steps: [S("a", { plan: q({ filters: [{ dim: "customer", op: "eq_ci", value: "Omega Holdings" }] }) })] }, ctx(TA));
    check("name-unknown", "a name that matches nothing is refused (never guessed)", [unknown.steps[0].status, unknown.steps[0].error.code], ["refused", "entity_not_resolved"]);
    const never = await analysis.executeAnalysisPlan(THREE_STEPS, ctx(TA, { getFreshness: async () => ({ state: "never_synced", message: "Sales have never been synced." }) }));
    check("freshness", "never-synced data is refused in every step, never shown as zero", never.steps.map((s) => [s.status, s.status === "skipped" ? s.reason : s.error.code]), [["refused", "no_usable_data"], ["refused", "no_usable_data"], ["skipped", "dependency_not_available"], ["refused", "no_usable_data"]]);
    const old = await analysis.executeAnalysisPlan({ v: 1, steps: [S("a", { plan: q({ period: { kind: "custom", from: "2024-03-01", to: "2024-03-31" } }) }), { id: "b", kind: "insight", tool: "product_margin", args: { period: { kind: "custom", from: "2024-03-01", to: "2024-03-31" } } }] }, ctx(TA));
    check("coverage", "a period before the synced history is refused as missing data (query and insight steps)", [old.steps[0].status, old.steps[0].error.code, /missing data, not zero/.test(old.steps[0].error.message), old.steps[1].status, old.steps[1].error.code], ["refused", "outside_coverage", true, "refused", "outside_coverage"]);
    let toolRuns = 0;
    const countingTool = (tool, args, c) => { toolRuns += 1; return insightTools.runInsightTool(tool, args, c); };
    const oldInsight = await analysis.executeAnalysisPlan({ v: 1, steps: [{ id: "b", kind: "insight", tool: "product_margin", args: { period: { kind: "custom", from: "2024-03-01", to: "2024-03-31" } } }, { id: "c", kind: "insight", tool: "product_margin", args: { period: OCT } }] }, ctx(TA, { runInsightTool: countingTool }));
    check("coverage-before-tool", "an insight period outside the synced history is refused before the tool runs (no aggregation paid for); a covered one runs", [oldInsight.steps.map((s) => s.status), oldInsight.steps[0].error.code, toolRuns], [["refused", "ok"], "outside_coverage", 1]);
    const timeoutExec = async () => ({ result: { ok: false, errors: [{ code: "query_timeout", message: "operation exceeded time limit (driver detail)" }] } });
    const t = await analysis.executeAnalysisPlan({ v: 1, steps: [S("a")] }, ctx(TA, { execute: timeoutExec }));
    check("engine-timeout", "an engine timeout is a failed step with a plain message (no driver text)", [t.steps[0].status, t.steps[0].error.code, /driver|exceeded/.test(t.steps[0].error.message)], ["failed", "query_timeout", false]);
    const boom = await analysis.executeAnalysisPlan({ v: 1, steps: [S("a"), S("b")] }, ctx(TA, { execute: async () => { throw new Error("E11000 collection sales internal"); } }));
    check("engine-throw", "an unexpected error fails the step with a fixed message and does not stop the plan", [boom.steps.map((s) => s.status), /E11000|collection/.test(JSON.stringify(boom))], [["failed", "failed"], false]);
    let clock = 0;
    const slow = await analysis.executeAnalysisPlan({ v: 1, steps: [S("a"), S("b"), S("c")] }, ctx(TA, { deadlineMs: 15000, now: () => (clock += 10000) }));
    check("deadline", "steps that would start after the deadline are skipped, never half-run", slow.steps.map((s) => (s.status === "skipped" ? s.reason : s.status)), ["ok", "deadline_exceeded", "deadline_exceeded"]);
    const stop = new AbortController();
    let stopCalls = 0;
    const stopAfterFirst = (plan, c) => { stopCalls += 1; stop.abort(); return realExec.execute(plan, c); };
    const cancelled = await analysis.executeAnalysisPlan({ v: 1, steps: [S("a"), S("b"), S("c")] }, ctx(TA, { execute: stopAfterFirst, signal: stop.signal }));
    check("cancel", "the user stops during the analysis: the running step finishes, no later step starts", [cancelled.steps.map((s) => (s.status === "skipped" ? s.reason : s.status)), stopCalls], [["ok", "cancelled", "cancelled"], 1]);
    const lookups = [];
    const turnResolver = require("./src/services/query/entityResolver").createEntityResolver({ tenantId: TA });
    const spyResolver = async (args) => { lookups.push(args.hintDim); return turnResolver(args); };
    const trend = await analysis.executeAnalysisPlan({ v: 1, steps: [{ id: "t", kind: "insight", tool: "product_trend", args: { period: OCT, product: "item p1" } }] }, ctx(TA, { resolveEntity: spyResolver }));
    check("insight-resolver", "an insight step looks names up with the turn's resolver (no second name index per step)", [trend.steps[0].status, trend.steps[0].result.productMatch.resolved, lookups], ["ok", "Item P1", ["product"]]);
    const neverFor = (vt) => async (t, v) => (v === vt ? { state: "never_synced", message: `${v} never synced.` } : { state: "fresh", message: "" });
    const buyDiscount = { v: 1, steps: [{ id: "d", kind: "insight", tool: "discount_summary", args: { period: OCT, entity: "purchase" } }] };
    check("insight-voucher-types", "the freshness gate reads the vouchers the tool reads (purchase discounts: Purchase only)", [(await analysis.executeAnalysisPlan(buyDiscount, ctx(TA, { getFreshness: neverFor("Sales") }))).steps[0].status, (await analysis.executeAnalysisPlan(buyDiscount, ctx(TA, { getFreshness: neverFor("Purchase") }))).steps[0].error.code], ["ok", "no_usable_data"]);
    const staleSales = await analysis.executeAnalysisPlan({ v: 1, steps: [S("a")] }, ctx(TA, { getFreshness: async () => ({ state: "stale", message: "Sales data is 2 days old." }) }));
    check("stale-step", "stale data still answers, and the step carries the stale note and state", [staleSales.steps[0].status, staleSales.steps[0].notes, staleSales.steps[0].dataState], ["ok", ["Sales data is 2 days old."], "stale"]);
    check("deadline-cap", "a caller cannot raise the deadline above the default", (await analysis.executeAnalysisPlan({ v: 1, steps: [S("a")] }, ctx(TA, { deadlineMs: 10 * 60 * 1000 }))).budget.deadlineMs, analysis.DEFAULT_DEADLINE_MS);
  } finally {
    await cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("verify-analysis-plan crashed:", err && err.message);
  try { await cleanup(); await mongoose.disconnect(); } catch { /* best-effort */ }
  process.exit(1);
});
