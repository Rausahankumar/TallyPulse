/**
 * The revenue basis inside an ANALYSIS (analysisPlanner.revenueGuard). "Revenue" means sales + lineAmount (pre-tax item value). An
 * analysis is judged as a whole: it needs one revenue step, may carry supporting steps (quantity, counts, breakdowns, sales-side
 * insight tools) under their own labels, and must never show a tax-inclusive voucher total or a non-sales entity beside "revenue".
 * Offline: no database, no network, no model; every name and figure is SYNTHETIC.
 * Run: node verify-revenue-analysis-guard.js
 */
process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const ap = require("./src/services/query/analysisPlanner");
const planner = require("./src/services/query/planner");
const { buildTurnEvent, newTurnMetrics } = require("./src/services/query/turnTelemetry");

let pass = 0, fail = 0;
function check(id, description, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      got ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const REF = new Date(2025, 10, 5, 23, 59, 59, 999);
const OCT = { kind: "custom", from: "2025-10-01", to: "2025-10-31" };
const SEP = { mode: "custom", period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" } };
const q = (o) => ({ v: 1, entity: "sales", mode: "aggregate", period: OCT, metrics: ["lineAmount"], groupBy: [], filters: [], ...o });
const step = (id, o) => ({ id, kind: "query", plan: q(o) });
const Q = "Why did revenue fall in October 2025 compared with September 2025?";
const HEAD = step("revenue", { compare: SEP });
const run = (steps, question = Q, opts) => ap.checkAnalysis(question, { v: 1, steps }, REF, null, opts);
const verdict = (r) => (r.refusal ? [r.refusal.code, r.refusal.guardStep, r.refusal.guardRule] : r.errors ? ["errors", r.errors.map((e) => e.code)] : "allowed");

console.log("=== allowed: a revenue headline with supporting steps ===");
check("headline-only", "the revenue step on its own", verdict(run([HEAD])), "allowed");
check("qty", "headline + quantity by product", verdict(run([HEAD, step("qty", { metrics: ["quantity"], groupBy: [{ dim: "product" }], compare: SEP, sort: [{ by: "quantity", dir: "desc" }], limit: 5 })])), "allowed");
check("line+qty", "a step with lineAmount and quantity is a revenue step too", verdict(run([step("both", { metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "product" }], compare: SEP, sort: [{ by: "lineAmount", dir: "desc" }], limit: 5 })])), "allowed");
check("discount", "headline + a sales discount summary", verdict(run([HEAD, { id: "disc", kind: "insight", tool: "discount_summary", args: { period: OCT, entity: "sales" } }])), "allowed");
check("customers", "headline + revenue by customer", verdict(run([HEAD, step("cust", { groupBy: [{ dim: "customer" }], compare: SEP, sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 })])), "allowed");
check("products", "headline + revenue by product", verdict(run([HEAD, step("prod", { groupBy: [{ dim: "product" }], compare: SEP, sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 })])), "allowed");
check("invoice-count", "headline + invoice count (a count, not an amount)", verdict(run([HEAD, step("count", { metrics: ["invoiceCount"], compare: SEP })])), "allowed");
check("product-insight", "headline + a product-rates insight (own label)", verdict(run([HEAD, { id: "rates", kind: "insight", tool: "product_rates", args: { period: OCT, limit: 5 } }])), "allowed");

console.log("\n=== refused, with the exact step and rule ===");
check("invoice-amount", "invoiceAmount beside revenue (step 1)", verdict(run([HEAD, step("inv", { metrics: ["invoiceAmount"], compare: SEP })])), ["revenue_basis_unsupported", 1, "invoice_total_not_revenue"]);
check("invoice-only", "invoiceAmount as the only step (the old behaviour is kept)", verdict(run([step("inv", { metrics: ["invoiceAmount"], compare: SEP })])), ["revenue_basis_unsupported", 0, "invoice_total_not_revenue"]);
check("avg-invoice", "average invoice value is a tax-inclusive total as well", verdict(run([HEAD, step("avg", { metrics: ["averageInvoiceValue"], compare: SEP })])), ["revenue_basis_unsupported", 1, "invoice_total_not_revenue"]);
check("mixed-metrics", "lineAmount together with invoiceAmount never reaches the guard: the validator refuses mixed grains (a second line of defence)", verdict(run([step("mix", { metrics: ["lineAmount", "invoiceAmount"], compare: SEP })])), ["errors", ["mixed_metric_grains"]]);
check("purchase", "a purchase amount beside revenue (step 1)", verdict(run([HEAD, step("buy", { entity: "purchase", metrics: ["purchaseAmount"], compare: SEP })])), ["revenue_basis_unsupported", 1, "entity_not_sales"]);
check("purchase-lineamount", "purchase lineAmount is not revenue either", verdict(run([HEAD, step("buy", { entity: "purchase", metrics: ["lineAmount"], compare: SEP })])), ["revenue_basis_unsupported", 1, "entity_not_sales"]);
check("purchase-insight", "a purchase-side insight tool (supplier_rates)", verdict(run([HEAD, { id: "sup", kind: "insight", tool: "supplier_rates", args: { period: OCT, product: "Item P1" } }])), ["revenue_basis_unsupported", 1, "entity_not_sales"]);
check("purchase-discount", "a purchase discount summary", verdict(run([HEAD, { id: "disc", kind: "insight", tool: "discount_summary", args: { period: OCT, entity: "purchase" } }])), ["revenue_basis_unsupported", 1, "entity_not_sales"]);
check("no-headline-qty", "supporting steps only, no sales + lineAmount step", verdict(run([step("qty", { metrics: ["quantity"], groupBy: [{ dim: "product" }], compare: SEP, sort: [{ by: "quantity", dir: "desc" }], limit: 5 })])), ["revenue_basis_unsupported", null, "no_revenue_step"]);
check("no-headline-count", "an invoice count only", verdict(run([step("count", { metrics: ["invoiceCount"], compare: SEP })])), ["revenue_basis_unsupported", null, "no_revenue_step"]);
check("no-headline-insight", "an insight tool only", verdict(run([{ id: "disc", kind: "insight", tool: "discount_summary", args: { period: OCT, entity: "sales" } }])), ["revenue_basis_unsupported", null, "no_revenue_step"]);
check("reason-text", "the user-facing reason is the existing revenue refusal", run([HEAD, step("inv", { metrics: ["invoiceAmount"] })]).refusal.reason, planner.REVENUE_BASIS_REFUSAL);

console.log("\n=== scope: only revenue questions, only analysis planning ===");
check("non-revenue-invoice", "a question that does not say revenue is untouched (invoiceAmount steps are fine)", verdict(run([step("inv", { metrics: ["invoiceAmount"], compare: SEP })], "Why did sales fall in October 2025 compared with September 2025?")), "allowed");
check("non-revenue-purchase", "...and so are purchases", verdict(run([HEAD, step("buy", { entity: "purchase", metrics: ["purchaseAmount"], compare: SEP })], "Why did sales fall in October 2025 compared with September 2025?")), "allowed");
check("investigation-round", "an investigation round (requirePrimary false) may hold supporting steps only", verdict(run([step("qty", { metrics: ["quantity"], groupBy: [{ dim: "product" }], compare: SEP, sort: [{ by: "quantity", dir: "desc" }], limit: 5 })], Q, { requirePrimary: false })), "allowed");
check("investigation-round-invoice", "...but still never an invoice total", verdict(run([step("inv", { metrics: ["invoiceAmount"] })], Q, { requirePrimary: false })), ["revenue_basis_unsupported", 0, "invoice_total_not_revenue"]);
const single = (plan) => planner.checkPlannedQuery(Q, plan);
check("single-query-unchanged", "the single-query revenue guard is untouched: a quantity plan is still refused", single(q({ metrics: ["quantity"] })).code, "revenue_basis_unsupported");
check("single-query-ok", "...and a revenue plan still passes", single(q({})), null);
check("option-off", "the analysis seam (revenue: false) skips only the revenue check", planner.checkPlannedQuery(Q, q({ metrics: ["quantity"] }), null, { revenue: false }), null);

console.log("\n=== labels: the revenue definition goes on the revenue step only ===");
{
  const r = run([HEAD, step("qty", { metrics: ["quantity"], groupBy: [{ dim: "customer" }], compare: SEP, sort: [{ by: "quantity", dir: "desc" }], limit: 5 }), step("count", { metrics: ["invoiceCount"], compare: SEP })]);
  const has = (id) => (r.notes[id] || []).some((n) => n.code === planner.REVENUE_ASSUMPTION.code);
  check("note-on-revenue", "the revenue step carries the definition note", has("revenue"), true);
  check("note-not-on-supporting", "quantity (by customer) and invoice-count steps do not; quantity keeps its metric", [has("qty"), has("count"), r.plan.steps[1].plan.metrics], [false, false, ["quantity"]]);
  // EXISTING rule (planner.withProductValueDefault, unchanged): a quantity-only PRODUCT step becomes sales value unless the question
  // asks for units. It is then a real revenue-by-product step, says so in its own note, and carries the revenue definition.
  const p = run([HEAD, step("qty", { metrics: ["quantity"], groupBy: [{ dim: "product" }], compare: SEP, sort: [{ by: "quantity", dir: "desc" }], limit: 5 })]);
  check("product-default-kept", "quantity by product (no unit words) is rewritten to value by the existing rule, labelled by its own note", [p.plan.steps[1].plan.metrics, p.notes.qty.map((n) => n.code).sort()], [["lineAmount"], ["product_value_default_applied", "revenue_is_pre_tax_item_value"]]);
  const u = ap.checkAnalysis("Why did revenue fall in October 2025? Show units sold by product", { v: 1, steps: [HEAD, step("qty", { metrics: ["quantity"], groupBy: [{ dim: "product" }], compare: SEP, sort: [{ by: "quantity", dir: "desc" }], limit: 5 })] }, REF, null);
  check("units-asked-kept", "when units are asked, quantity by product stays quantity and carries no revenue definition", [u.plan.steps[1].plan.metrics, (u.notes.qty || []).some((n) => n.code === planner.REVENUE_ASSUMPTION.code)], [["quantity"], false]);
  const r2 = run([step("both", { metrics: ["lineAmount", "quantity"], compare: SEP })]);
  check("note-on-line-grain", "a step of line-grain metrics incl. lineAmount keeps it", (r2.notes.both || []).some((n) => n.code === planner.REVENUE_ASSUMPTION.code), true);
}

console.log("\n=== through the analysis planner and telemetry ===");
(async () => {
  const reply = (steps) => async () => ({ content: [{ type: "tool_use", id: "t1", name: ap.ANALYSIS_TOOL_NAME, input: { analysis: { v: 1, steps } } }], usage: { input_tokens: 10, output_tokens: 5 } });
  const ok = await ap.planAnalysis(Q, { claudeClient: reply([HEAD, step("qty", { metrics: ["quantity"], groupBy: [{ dim: "product" }], compare: SEP, sort: [{ by: "quantity", dir: "desc" }], limit: 5 })]), referenceDate: REF });
  check("planner-allowed", "the planner returns a supported plan for headline + quantity (the reported question's shape)", [ok.status, ok.usage.calls], ["supported", 1]);
  const bad = await ap.planAnalysis(Q, { claudeClient: reply([HEAD, step("inv", { metrics: ["invoiceAmount"], compare: SEP })]), referenceDate: REF });
  check("planner-refused", "an invoice-total step: refused, one call (a decided rule is never repaired), step and rule returned", [bad.status, bad.code, bad.guardStep, bad.guardRule, bad.usage.calls], ["unsupported", "revenue_basis_unsupported", 1, "invoice_total_not_revenue", 1]);
  const evidence = await ap.planAnalysis(Q, { claudeClient: reply([step("qty", { metrics: ["quantity"], groupBy: [{ dim: "product" }], compare: SEP, sort: [{ by: "quantity", dir: "desc" }], limit: 5 })]), referenceDate: REF, evidence: "Step total: ...", maxRepairs: 0 });
  check("planner-evidence-round", "with evidence (an investigation round) supporting steps alone are accepted", evidence.status, "supported");
  const none = await ap.planAnalysis(Q, { claudeClient: reply([step("qty", { metrics: ["quantity"], compare: SEP })]), referenceDate: REF });
  check("planner-no-headline", "no revenue step at all: refused, no step index", [none.status, none.guardStep, none.guardRule], ["unsupported", null, "no_revenue_step"]);

  const tm = newTurnMetrics();
  tm.guardRule = "invoice_total_not_revenue"; tm.guardStep = 1;
  const event = buildTurnEvent({ tenantId: "T", requestId: "r", metrics: tm });
  check("telemetry-fields", "the turn event names the rejected step and rule (codes and an integer only)", [event.guardStep, event.guardRule], [1, "invoice_total_not_revenue"]);
  const clean = buildTurnEvent({ tenantId: "T", requestId: "r", metrics: newTurnMetrics() });
  check("telemetry-absent", "a turn with no such refusal carries no value for them", [clean.guardStep ?? null, clean.guardRule ?? null], [null, null]);

  console.log(`\nverify-revenue-analysis-guard: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
