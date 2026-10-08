"use strict";

/**
 * The planner prompt's catalog digest (planner.js buildCatalogDigest): it must be GENERATED from semanticCatalog.js, carry the meaning
 * the model needs to choose the right metric (each summed metric's own catalog description: the tax-inclusive voucher total vs the pre-tax item
 * value, with its grain), state the validator rules the schema cannot express (including that voucher-grain metrics cannot be grouped by
 * product), list what cannot be answered, and stay small.
 *
 * Offline and free: no model is called. What this proves is that the prompt carries the information and that it agrees with the corpus
 * expectations and the validator. Whether a model USES it is measured only by a live evaluation (eval-nlu-models.js).
 *
 * Run: node verify-planner-digest.js
 */

process.env.AI_USAGE_PERSIST = "off";
const fs = require("fs");
const path = require("path");
const { planQuestion, getPlannerPrompt, buildCatalogDigest, PLANNER_TOOL_NAME, PLANNER_MAX_TOKENS } = require("./src/services/query/planner");
const { CATALOG } = require("./src/services/query/semanticCatalog");
const scoring = require("./eval/nluScoring");

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
const clone = () => JSON.parse(JSON.stringify(CATALOG));

const prompt = getPlannerPrompt();
const text = prompt.system[0].text;
const lines = text.split("\n");

// What a reader of the prompt can learn, parsed from the prompt text itself.
const metricInfo = {};
for (const l of lines) {
  const m = l.match(/^(\w+) \[([\w/]+); (voucher|line)\](?:: (.*))?$/);
  if (m) metricInfo[m[1]] = { entities: m[2].split("/"), grain: m[3], meaning: m[4] || null };
}
// The voucher-grain metric whose catalog description says tax-inclusive: what a reader of the prompt takes as an entity's overall amount.
const overallByEntity = {};
for (const [id, info] of Object.entries(metricInfo)) {
  if (info.grain === "voucher" && info.meaning && /tax-inclusive/.test(info.meaning)) for (const e of info.entities) (overallByEntity[e] = overallByEntity[e] || []).push(id);
}
const overall = (entity) => (overallByEntity[entity] || [])[0];

(async () => {
  // ------------------------------------------------------------------------------------------ A. generated from the catalog
  section("A. the digest is generated from the catalog (single source of truth)");
  check("getPlannerPrompt() is the catalog digest, built once", text === buildCatalogDigest() && getPlannerPrompt() === prompt);
  const supported = Object.values(CATALOG.metrics).filter((m) => m.status === "supported");
  check("every supported metric is listed with its scope and grain, exactly as the catalog says", supported.every((m) => metricInfo[m.id] && metricInfo[m.id].grain === m.grain && metricInfo[m.id].entities.join("/") === m.entities.join("/")) && Object.keys(metricInfo).length === supported.length, Object.keys(metricInfo).join(","));
  const sums = supported.filter((m) => m.aggregation && m.aggregation.op === "sum");
  check("every summed amount/quantity carries the catalog's OWN description, word for word", sums.length >= 7 && sums.every((m) => metricInfo[m.id].meaning === m.description), sums.map((m) => m.id).join(","));
  check("counts and ratios are listed by id and scope only (self-explanatory, saves tokens)", supported.filter((m) => !sums.includes(m)).every((m) => metricInfo[m.id].meaning === null));
  check("each summed metric's description states its basis (tax-inclusive voucher total vs pre-tax item value), so the digest can rely on it", sums.filter((m) => m.amountBasis === CATALOG.amountBasis.VOUCHER_TOTAL_INCL_TAX).every((m) => /tax-inclusive/.test(m.description)) && sums.filter((m) => m.amountBasis === CATALOG.amountBasis.LINE_ITEM_PRE_TAX).every((m) => /pre-tax/i.test(m.description)));
  check("entities are described with the catalog's labels (so 'credit note' / 'debit note' vocabulary reaches the model)", lines.some((l) => l.startsWith("Entities:") && /sales_return \(Sales returns \(Credit Notes\)/.test(l) && /purchase_return \(Purchase returns \(Debit Notes\)/.test(l)));
  check("for each entity the prompt describes exactly ONE voucher-grain metric as tax-inclusive, and it is the overall amount: sales=invoiceAmount, purchase=purchaseAmount, returns=returnAmount", Object.keys(CATALOG.entities).every((e) => (overallByEntity[e] || []).length === 1) && overall("sales") === "invoiceAmount" && overall("purchase") === "purchaseAmount" && overall("sales_return") === "returnAmount" && overall("purchase_return") === "returnAmount", JSON.stringify(overallByEntity));
  check("no headline-amount sentence: the digest states meanings and rules, it does not pick a metric for the model", !/Headline/i.test(text));
  const src = buildCatalogDigest.toString();
  check("no metric id is written into the digest code except in the planner's own revenue sentence", (src.match(/invoiceAmount/g) || []).length === 1 && !/purchaseAmount|returnAmount/.test(src));

  // a catalog edit changes the prompt: nothing is hard-coded
  const c1 = clone();
  c1.metrics.invoiceAmount.description = "CHANGED DESCRIPTION (tax-inclusive)";
  check("editing a metric description in the catalog changes the prompt", buildCatalogDigest(c1).includes("CHANGED DESCRIPTION (tax-inclusive)") && !buildCatalogDigest(c1).includes("Total invoice value (party-ledger total"));
  const c3 = clone();
  c3.unsupported = c3.unsupported.filter((u) => u.id !== "net_of_returns");
  check("the unsupported list follows the catalog: removing an entry removes it from the prompt", buildCatalogDigest(c3).includes("net of returns") === false && buildCatalogDigest().includes("net of returns"));
  const c4 = clone();
  c4.metrics.quantity.status = "pending";
  check("a metric that is not 'supported' is not offered", !/^quantity \[/m.test(buildCatalogDigest(c4)) && /^quantity \[/m.test(text));

  // ------------------------------------------------------------------------------------------ B. what must NOT reach the model
  section("B. nothing internal reaches the model");
  const INTERNAL = /header\.|inventory\.|voucherTotalAmount|partyName|collection|forcedMatch|AdjustmentNote|StockItemMaster|oracle|parity|getSales|getTop|stockGroupAnalytics|docs\/|PROJECT_CONTEXT|existing analytics|tenant|company|guid|mongo|\$match|\$lookup|db\./i;
  check("no storage path, model name, parity oracle, analytics function, document reference or tenant vocabulary in the prompt", !INTERNAL.test(text), (text.match(INTERNAL) || [])[0]);
  const wire = JSON.stringify({ system: prompt.system, tools: [prompt.tool], messages: [{ role: "user", content: "show sales last month" }], max_tokens: PLANNER_MAX_TOKENS });
  check("no storage path in the whole request either (system + tool schema)", !INTERNAL.test(wire), (wire.match(INTERNAL) || [])[0]);
  check("catalog texts that reach the model carry no developer wording", sums.every((m) => !/see docs|existing analytics|matching/i.test(m.description)));
  check("the date rule is intact: no reference date, YYYY-MM-DD documented, ytd hidden, every other period kind and compare mode listed", !/20\d\d-\d\d-\d\d|reference date|today is/i.test(text) && /YYYY-MM-DD/.test(text) && !/\bytd\b/.test(text) && CATALOG.periods.kinds.filter((k) => k !== "ytd").every((k) => text.includes(k)) && CATALOG.compare.modes.every((m) => text.includes(m)));
  check("the revenue rule is unchanged", /"Revenue" has one fixed meaning: the pre-tax value of the items sold = entity sales with metric lineAmount \(never invoiceAmount, invoiceCount or averageInvoiceValue\)\. If a revenue question needs purchases or an invoice-level metric, decline\./.test(text));

  // ------------------------------------------------------------------------------------------ C. rules and declines
  section("C. validator rules and the decline list");
  const rule = (code) => CATALOG.queryRules.find((r) => r.code === code).description;
  check("the validator rules the schema cannot express are stated, as the catalog words them: sort for high-cardinality groupings, list-mode shape, and voucher-grain metrics cannot be grouped by product/productGroup", text.includes(rule("high_cardinality_requires_sort")) && text.includes(rule("list_mode_shape")) && text.includes(rule("dimension_not_applicable_to_voucher_metric")) && /Mode "list" returns individual invoices/.test(text));
  check("every unsupported capability in the catalog is in the decline sentence, in plain words", CATALOG.unsupported.every((u) => text.includes(u.id.replace(/_/g, " "))));
  const other = CATALOG.unsupported.find((u) => u.id === "other_accounting_domains");
  check("the catch-all entry's examples (orders, stock valuation, ...) reach the model, and its catalog reason text is unchanged", other.examples.every((e) => text.includes(e)) && other.reason === "Orders, delivery notes, stock valuation, payroll, expenses and other accounting areas are outside Sales/Purchase in this phase.");
  check("forecasts and explanations remain declines (planner-level, not a data capability)", /or a forecast or an explanation/.test(text));
  check("CONTRADICTION FIXED: the prompt no longer tells the model to decline returns / credit notes", !/returns\/credit notes/.test(text) && !fs.readFileSync(path.join(__dirname, "src", "services", "query", "planner.js"), "utf8").includes("returns/credit notes"));
  check("...and agrees with the catalog: return entities and metrics are offered, and the catalog says returns can be asked directly", ["sales_return", "purchase_return"].every((e) => lines.find((l) => l.startsWith("Entities:")).includes(e)) && ["returnAmount", "returnCount", "returnQuantity", "returnLineAmount"].every((m) => metricInfo[m]) && /can be asked directly/.test(CATALOG.unsupported.find((u) => u.id === "net_of_returns").reason));

  // ------------------------------------------------------------------------------------------ D. the corpus expectations agree with the digest
  section("D. what the prompt tells the model matches what the corpus (and the engine) expect, per question type");
  const rows = (g, pred = () => true) => scoring.corpus.rows.filter((r) => r.group === g && r.expected.status === "supported" && r.expected.plan && !r.previousPlan && !r.needsEngineCapability && pred(r));
  const grainOf = (metric) => (metricInfo[metric] ? metricInfo[metric].grain : null);
  const isSum = (metric) => sums.some((m) => m.id === metric);
  const voucherCategory = (label, group) => {
    const rs = rows(group);
    const ok = rs.every((r) => r.expected.plan.metrics.every((m) => grainOf(m) === "voucher" && (!isSum(m) || m === overall(r.expected.plan.entity))));
    check(`${label}: all ${rs.length} corpus plans use voucher-grain metrics, and the amount is the tax-inclusive voucher metric the prompt describes`, rs.length > 0 && ok, rs.filter((r) => !r.expected.plan.metrics.every((m) => grainOf(m) === "voucher" && (!isSum(m) || m === overall(r.expected.plan.entity)))).map((r) => r.id).join(","));
  };
  voucherCategory("generic sales total", "sales_total");
  voucherCategory("generic purchase total", "purchase_total");
  voucherCategory("customer-wise sales", "sales_by_customer");
  voucherCategory("supplier-wise purchase", "purchase_by_supplier");
  voucherCategory("top customers", "top_customers");
  const cmp = rows("period_comparison");
  check(`comparison questions: all ${cmp.length} corpus plans compare the tax-inclusive voucher amount of their entity`, cmp.length > 0 && cmp.every((r) => r.expected.plan.compare && r.expected.plan.metrics.every((m) => m === overall(r.expected.plan.entity))));
  const lineCategory = (label, group, pred) => {
    const rs = rows(group, pred);
    check(`${label}: all ${rs.length} corpus plans use line-grain metrics (a voucher-grain total cannot be broken down by product)`, rs.length > 0 && rs.every((r) => r.expected.plan.metrics.every((m) => grainOf(m) === "line")), rs.map((r) => r.id).join(","));
  };
  lineCategory("product-wise sales", "sales_by_product");
  lineCategory("product-wise purchase", "purchase_by_product");
  lineCategory("top products", "top_products");
  const qty = scoring.corpus.rows.filter((r) => r.expected.plan && r.expected.plan.metrics.includes("quantity") && !r.previousPlan);
  check(`quantity questions: all ${qty.length} corpus plans use the quantity metric, which the prompt lists at line grain with the catalog's description`, qty.length >= 5 && grainOf("quantity") === "line" && metricInfo.quantity.meaning === CATALOG.metrics.quantity.description);
  const rets = rows("returns");
  check(`return questions: all ${rets.length} corpus plans use a return entity and a return metric the prompt offers (returns are supported, not declined)`, rets.length === 7 && rets.every((r) => /_return$/.test(r.expected.plan.entity) && r.expected.plan.metrics.every((m) => metricInfo[m] && metricInfo[m].entities.includes(r.expected.plan.entity))) && rets.filter((r) => r.expected.plan.metrics.includes("returnAmount")).every((r) => r.expected.plan.metrics.every((m) => m === overall(r.expected.plan.entity))));

  // ------------------------------------------------------------------------------------------ E. semantic correctness through the real pipeline
  section("E. the real planner pipeline with scripted model answers: right plans are exact, plausible wrong plans are caught");
  const resolver = scoring.makeResolver();
  const scripted = (input) => async () => ({ content: [{ type: "tool_use", id: "t", name: PLANNER_TOOL_NAME, input }], usage: { input_tokens: 1, output_tokens: 1 } });
  const run = async (row, plan) => {
    const planned = await planQuestion(row.question, { claudeClient: scripted({ plan }), resolveEntity: resolver, referenceDate: scoring.REF_DATE, maxRepairs: 0 });
    return { planned, scored: scoring.classifyPlanned(row, planned) };
  };
  const pick = (g, pred) => rows(g, pred)[0];
  const swap = (plan, from, to) => ({ ...JSON.parse(JSON.stringify(plan)), metrics: plan.metrics.map((m) => (m === from ? to : m)), sort: (plan.sort || []).map((s) => ({ ...s, by: s.by.replace(from, to) })) });
  const cats = [
    ["generic sales total", pick("sales_total", (r) => r.expected.plan.metrics[0] === "invoiceAmount"), "invoiceAmount", "lineAmount"],
    ["generic purchase total", pick("purchase_total", (r) => r.expected.plan.metrics[0] === "purchaseAmount"), "purchaseAmount", "lineAmount"],
    ["customer-wise sales", pick("sales_by_customer", (r) => r.expected.plan.groupBy.length), "invoiceAmount", "lineAmount"],
    ["supplier-wise purchase", pick("purchase_by_supplier", (r) => r.expected.plan.groupBy.length), "purchaseAmount", "lineAmount"],
    ["sales comparison", pick("period_comparison", (r) => r.expected.plan.entity === "sales"), "invoiceAmount", "lineAmount"],
  ];
  for (const [label, row, right, wrong] of cats) {
    const ok = await run(row, row.expected.plan);
    check(`${label} ("${row.question}"): the correct plan is accepted and scored exact`, ok.scored.outcome === "plan_correct", ok.scored.outcome);
    const bad = await run(row, swap(row.expected.plan, right, wrong));
    check(`${label}: ${wrong} instead of ${right} passes schema AND validator (nothing downstream can see the question) but is scored WRONG`, bad.planned.status === "supported" && bad.scored.executable === true && bad.scored.outcome === "wrong_but_executable" && bad.scored.diffs.some((d) => d.field === "metrics"), `${bad.planned.status} ${bad.scored.outcome}`);
  }
  for (const [label, row] of [["product-wise sales", pick("sales_by_product", (r) => r.expected.plan.groupBy.some((g) => g.dim === "product") && r.expected.plan.metrics[0] === "lineAmount")], ["product-wise purchase", pick("purchase_by_product", (r) => r.expected.plan.groupBy.some((g) => g.dim === "product") && r.expected.plan.metrics[0] === "lineAmount")]]) {
    const ok = await run(row, row.expected.plan);
    check(`${label} ("${row.question}"): the correct line-grain plan is accepted and scored exact`, ok.scored.outcome === "plan_correct", ok.scored.outcome);
    const overallMetric = overall(row.expected.plan.entity);
    const bad = await run(row, swap(row.expected.plan, "lineAmount", overallMetric));
    check(`${label}: the voucher-grain amount grouped by product is rejected by the validator (the engine can never attribute an invoice total to a product)`, bad.scored.outcome === "validator_rejected", bad.scored.outcome);
  }
  const qrow = pick("sales_by_product", (r) => r.expected.plan.metrics.includes("quantity") && !r.expected.plan.groupBy.length) || scoring.corpus.rows.find((r) => r.expected.plan && r.expected.plan.metrics.includes("quantity") && !r.previousPlan && !r.needsEngineCapability);
  const qok = await run(qrow, qrow.expected.plan);
  check(`quantity ("${qrow.question}"): the correct plan is accepted and scored exact`, qok.scored.outcome === "plan_correct", qok.scored.outcome);
  const retRow = rows("returns").find((r) => r.expected.plan.metrics[0] === "returnAmount" && !r.expected.plan.groupBy.length);
  const retOk = await run(retRow, retRow.expected.plan);
  check(`return ("${retRow.question}"): a return plan is accepted by the planner and scored exact (no decline)`, retOk.planned.status === "supported" && retOk.scored.outcome === "plan_correct", `${retOk.planned.status} ${retOk.scored.outcome}`);
  const retWrong = await run(retRow, swap(retRow.expected.plan, "returnAmount", "returnQuantity"));
  check("return: returnQuantity instead of returnAmount is accepted by the validator but scored WRONG", retWrong.scored.outcome === "wrong_but_executable", retWrong.scored.outcome);

  // ------------------------------------------------------------------------------------------ F. size
  section("F. the prompt stays bounded");
  const OLD_SYSTEM_CHARS = 2906; // the id-only digest this replaces (measured before the change)
  check(`system prompt ${text.length} chars (was ${OLD_SYSTEM_CHARS}; +${text.length - OLD_SYSTEM_CHARS}), under 5,000`, text.length < 5000);
  check(`whole request ${wire.length} chars (about ${Math.ceil(wire.length / 4)} tokens at 4 chars/token), under 12,000 chars`, wire.length < 12000);
  console.log(`  (info) catalog digest: ${text.length} chars, about ${Math.round(text.length / 3)} tokens at 3.0 chars/token (was ${OLD_SYSTEM_CHARS} chars, about ${Math.round(OLD_SYSTEM_CHARS / 3)}); whole request about ${Math.ceil(wire.length / 4)} tokens at 4 chars/token`);

  console.log(`\nverify-planner-digest: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
