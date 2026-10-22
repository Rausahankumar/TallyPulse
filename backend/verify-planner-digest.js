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
const { parseQueryPlan } = require("./src/services/query/queryPlan.schema");
const { validateQueryPlan } = require("./src/services/query/validator");
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

// Digest sections, recognised by how their line starts; metric lines belong to "metrics". Budgets are chars incl. the line break.
const SECTION_PREFIXES = [
  ["intro", "You translate "], ["entities", "Entities: "], ["metrics", "Metrics ["], ["dimensions", "Dimensions "], ["rules", "Rules: "],
  ["periods", "Period kinds: "], ["refs", "having/sort "], ["growth", "Growth/decline "], ["revenue", '"Revenue" '], ["returns", "Returns: "],
  ["names", "Copy "], ["decline", "If the question "],
];
// rules +100 (the product order clause) and periods -200 (the kind/mode lists moved to the schema enums) in the Slice 2 rebalance;
// metrics +110 for the customerCount line (Slice 3).
// Analysis plans (Milestone 2): intro -50 (shortened to 136) and decline +50 (the needs_analysis code), total unchanged.
const SECTION_BUDGETS = { intro: 150, entities: 300, metrics: 1560, dimensions: 400, rules: 600, periods: 300, refs: 150, growth: 450, revenue: 250, returns: 400, names: 200, decline: 600 };

// Every enum/const string in the tool schema's period and compare branches, as "period:<v>" / "compare:<v>".
function enumValues(node, out = new Set()) {
  if (Array.isArray(node)) node.forEach((x) => enumValues(x, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "enum" && Array.isArray(v)) v.forEach((x) => typeof x === "string" && out.add(x));
      else if (k === "const" && typeof v === "string") out.add(v);
      else enumValues(v, out);
    }
  }
  return out;
}
const kindValues = (planSchema) => enumValues(planSchema.properties.period.anyOf || planSchema.properties.period.oneOf || planSchema.properties.period);
// The compare branch also carries a custom period; only its "mode" values count.
const modeValues = (planSchema) => {
  const out = new Set();
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (n.properties && n.properties.mode) enumValues(n.properties.mode, out);
    for (const [k, v] of Object.entries(n)) if (k !== "properties") walk(v);
  };
  walk(planSchema.properties.compare);
  return out;
};
const wantedEnumValues = () => [...CATALOG.periods.kinds.map((k) => `period:${k}`), ...CATALOG.compare.modes.map((m) => `compare:${m}`)];
const actualEnumValues = (planSchema) => [...[...kindValues(planSchema)].map((k) => `period:${k}`), ...[...modeValues(planSchema)].map((m) => `compare:${m}`)];
const missingEnumValues = (planSchema) => wantedEnumValues().filter((v) => !actualEnumValues(planSchema).includes(v));
const extraEnumValues = (planSchema) => actualEnumValues(planSchema).filter((v) => !wantedEnumValues().includes(v));
function dropEnumValue(node, value) {
  if (Array.isArray(node)) return node.forEach((x) => dropEnumValue(x, value));
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.enum)) node.enum = node.enum.filter((x) => x !== value);
  if (node.const === value) delete node.const;
  for (const v of Object.values(node)) dropEnumValue(v, value);
}
function sectionSizes(digest) {
  const out = {};
  for (const l of digest.split("\n")) {
    const hit = SECTION_PREFIXES.find(([, p]) => l.startsWith(p));
    const id = hit ? hit[0] : /^\w+ \[[\w/]+; (voucher|line)\]/.test(l) ? "metrics" : "unbudgeted";
    out[id] = (out[id] || 0) + l.length + 1;
  }
  return out;
}

(async () => {
  // ------------------------------------------------------------------------------------------ A. generated from the catalog
  section("A. the digest is generated from the catalog (single source of truth)");
  check("getPlannerPrompt() is the catalog digest, built once", text === buildCatalogDigest() && getPlannerPrompt() === prompt);
  const supported = Object.values(CATALOG.metrics).filter((m) => m.status === "supported");
  check("every supported metric is listed with its scope and grain, exactly as the catalog says", supported.every((m) => metricInfo[m.id] && metricInfo[m.id].grain === m.grain && metricInfo[m.id].entities.join("/") === m.entities.join("/")) && Object.keys(metricInfo).length === supported.length, Object.keys(metricInfo).join(","));
  const sums = supported.filter((m) => m.aggregation && m.aggregation.op === "sum");
  check("every summed amount/quantity carries the catalog's OWN description, word for word", sums.length >= 7 && sums.every((m) => metricInfo[m.id].meaning === m.description), sums.map((m) => m.id).join(","));
  const distincts = supported.filter((m) => m.aggregation && m.aggregation.op === "distinct");
  check("plain counts and ratios are listed by id and scope only (self-explanatory, saves tokens)", supported.filter((m) => !sums.includes(m) && !distincts.includes(m)).every((m) => metricInfo[m.id].meaning === null));
  check("a distinct count (customerCount) carries the catalog's OWN description: debtor ledgers, never grouped by customer/product", distincts.length === 1 && distincts[0].id === "customerCount" && metricInfo.customerCount.meaning === distincts[0].description && /debtor ledgers/.test(distincts[0].description) && /never by customer\/product/.test(distincts[0].description));
  check("each summed metric's description states its basis (tax-inclusive voucher total vs pre-tax item value), so the digest can rely on it", sums.filter((m) => m.amountBasis === CATALOG.amountBasis.VOUCHER_TOTAL_INCL_TAX).every((m) => /tax-inclusive/.test(m.description)) && sums.filter((m) => m.amountBasis === CATALOG.amountBasis.LINE_ITEM_PRE_TAX).every((m) => /pre-tax/i.test(m.description)));
  check("entities are described with the catalog's labels (so 'credit note' / 'debit note' vocabulary reaches the model)", lines.some((l) => l.startsWith("Entities:") && /sales_return \(Sales returns \(Credit Notes\)/.test(l) && /purchase_return \(Purchase returns \(Debit Notes\)/.test(l)));
  check("for each entity the prompt describes exactly ONE voucher-grain metric as tax-inclusive, and it is the overall amount: sales=invoiceAmount, purchase=purchaseAmount, returns=returnAmount", Object.keys(CATALOG.entities).every((e) => (overallByEntity[e] || []).length === 1) && overall("sales") === "invoiceAmount" && overall("purchase") === "purchaseAmount" && overall("sales_return") === "returnAmount" && overall("purchase_return") === "returnAmount", JSON.stringify(overallByEntity));
  check("the sales overall metric is the one the prompt calls 'Total sales' (from the catalog description), and no other metric is", /^Total sales:/.test((metricInfo[overall("sales")] || {}).meaning || "") && Object.entries(metricInfo).filter(([, i]) => /total sales/i.test(i.meaning || "")).map(([id]) => id).join(",") === overall("sales"), JSON.stringify(Object.entries(metricInfo).filter(([, i]) => /total sales/i.test(i.meaning || "")).map(([id]) => id)));
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
  // Period kinds and compare modes reach the model as enums of the tool schema; the digest only points there (no second list) and keeps ytd unused.
  check("the date rule is intact: no reference date, YYYY-MM-DD documented, the schema values are named as the source, ytd ruled out", !/20\d\d-\d\d-\d\d|reference date|today is/i.test(text) && /YYYY-MM-DD/.test(text) && /use the schema values, never ytd\./.test(text));
  const planSchema = prompt.tool.input_schema.properties.plan;
  check("the tool schema carries EVERY catalog period kind and compare mode as an enum/const value (nothing missing, nothing extra)", missingEnumValues(planSchema).length === 0 && extraEnumValues(planSchema).length === 0, JSON.stringify({ missing: missingEnumValues(planSchema), extra: extraEnumValues(planSchema) }));
  check("the digest no longer repeats the period-kind or compare-mode lists", !["last_7_days", "same_month_last_year", "previous_quarter", "full_previous", "same_period_last_year"].some((v) => text.includes(v)));
  for (const [where, value] of [["period", "previous_fy"], ["period", "custom"], ["compare", "like_for_like"], ["compare", "custom"]]) {
    const broken = JSON.parse(JSON.stringify(planSchema));
    dropEnumValue(broken.properties[where], value);
    check(`negative: a schema without the ${where} value "${value}" is reported missing`, missingEnumValues(broken).includes(`${where}:${value}`), JSON.stringify(missingEnumValues(broken)));
  }
  check('the "last year" rule is stated: alone it means the previous financial year', /Financial year is April-March; "last year" alone = previous_fy\./.test(text));
  check('the product order rule is stated: "which products did we sell" sorts by value, by name only if asked', /"Which products did we sell": sort by the value metric, desc; by name only if asked\./.test(text));
  check("the revenue rule is unchanged", /"Revenue" has one fixed meaning: the pre-tax value of the items sold = entity sales with metric lineAmount \(never invoiceAmount, invoiceCount or averageInvoiceValue\)\. If a revenue question needs purchases or an invoice-level metric, decline\./.test(text));

  // ------------------------------------------------------------------------------------------ C. rules and declines
  section("C. validator rules and the decline list");
  const rule = (code) => CATALOG.queryRules.find((r) => r.code === code).description;
  check("the validator rules the schema cannot express are stated, as the catalog words them: sort for high-cardinality groupings, list-mode shape, and voucher-grain metrics cannot be grouped by product/productGroup", text.includes(rule("high_cardinality_requires_sort")) && text.includes(rule("list_mode_shape")) && text.includes(rule("dimension_not_applicable_to_voucher_metric")) && /Mode "list" returns individual invoices/.test(text));
  check("every unsupported capability in the catalog is in the decline sentence, in plain words (its label, else its id)", CATALOG.unsupported.every((u) => text.includes(require("./src/services/query/semanticCatalog").unsupportedLabel(u))));
  const profitEntry = CATALOG.unsupported.find((u) => u.id === "profit_margin");
  check("accounting profit stays unsupported: shown as 'accounting profit', and its reason keeps 'No cost/COGS data is available' and names gross and net margin", !!profitEntry && /accounting profit/.test(text) && profitEntry.reason.startsWith("No cost/COGS data is available") && /gross margin and net margin/.test(profitEntry.reason) && /labelled as indicative/.test(profitEntry.reason));
  check("the outdated discount refusal is gone: discounts are no longer listed as unsupported", !CATALOG.unsupported.some((u) => u.id === "discount_analysis") && !/discount analysis/.test(text));
  const other = CATALOG.unsupported.find((u) => u.id === "other_accounting_domains");
  check("the catch-all entry's examples (orders, stock valuation, ...) reach the model, and its catalog reason text is unchanged", other.examples.every((e) => text.includes(e)) && other.reason === "Orders, delivery notes, stock valuation, payroll, expenses and other accounting areas are outside Sales/Purchase in this phase.");
  check("forecasts and explanations remain declines (planner-level, not a data capability): a forecast is in the decline sentence, an explanation in the needs_analysis sentence", /, or a forecast, or is truly ambiguous/.test(text) && /Several analyses \([^)]*\), an explanation,/.test(text));

  // ---- compact text that relies on the catalog or the schema: it must not drift from them
  const allEntities = Object.keys(CATALOG.entities);
  const driftOf = (dimLine) => Object.values(CATALOG.dimensions).filter((d) => {
    const m = new RegExp(`(?:: |; )${d.id} \\(([^)]*)\\)`).exec(dimLine);
    if (!m) return true;
    const parts = m[1].split("; ");
    const ents = parts[0] === "all" ? allEntities : parts[0].split("/");
    const lineOnly = parts.includes("line only");
    const buckets = (parts.find((p) => p.startsWith("buckets ")) || "").replace("buckets ", "");
    return ents.slice().sort().join() !== d.entities.slice().sort().join() || lineOnly !== !(d.grains || []).includes("voucher") || (d.id === "date" ? buckets !== d.buckets.join("|") : !!buckets);
  });
  const dimDrift = driftOf(lines.find((l) => l.startsWith("Dimensions ")));
  check("the compact dimensions line agrees with the catalog for every dimension (entities or 'all', 'line only', date buckets)", dimDrift.length === 0, dimDrift.map((d) => d.id).join(","));
  const changed = clone();
  changed.dimensions.product.grains = ["voucher", "line"];
  changed.dimensions.customer.entities = ["sales"];
  const changedLine = buildCatalogDigest(changed).split("\n").find((l) => l.startsWith("Dimensions "));
  check("negative: a digest built from a different catalog (product voucher grain, customer sales-only) is reported as drifted", driftOf(changedLine).map((d) => d.id).sort(), ["customer", "product"]);
  const schemaJson = prompt.tool.input_schema.properties.plan;
  const customCompare = JSON.stringify(schemaJson.properties.compare).includes('"required":["mode","period"]');
  check("facts the prompt no longer repeats are enforced by the tool schema: limit maximum = LIMITS.maxLimit, and a custom compare requires its period", [schemaJson.properties.limit.maximum === CATALOG.limits.maxLimit, customCompare, /limit <= /.test(text), /custom compare needs a period/.test(text)], [true, true, false, false]);
  check("rules the JSON schema cannot show stay in the prompt (a date groupBy needs a bucket and no compare; derived refs need compare; ALL items use limit = maxLimit)", [/A date groupBy needs a bucket and cannot be combined with compare\./.test(text), /with compare, metric\.previous \/ metric\.delta \/ metric\.deltaPct/.test(text), new RegExp(`having with limit ${CATALOG.limits.maxLimit}\\.`).test(text)], [true, true, true]);
  check("a question needing several analyses, an explanation, discounts or product margins is a decline with code needs_analysis, and the tool schema allows that code", /Several analyses \([^)]*\), an explanation, discounts or product margins: code needs_analysis\./.test(text) && prompt.tool.input_schema.properties.decline.properties.code.enum.includes("needs_analysis"));
  {
    // generated from the catalog's multiStep flag: named in the needs_analysis rule, never in the "cannot answer" list
    const catalog = require("./src/services/query/semanticCatalog");
    const multi = CATALOG.unsupported.filter((u) => u.multiStep).map((u) => catalog.unsupportedLabel(u));
    const declineLine = text.split("\n").find((l) => l.startsWith("If the question needs something"));
    const cannot = declineLine.slice(0, declineLine.indexOf("do NOT guess"));
    const several = (declineLine.match(/Several analyses \(([^)]*)\)/) || [])[1] || "";
    check("multi-step catalog entries (sales next to purchases) go to needs_analysis, not to the cannot-answer list", multi.length > 0 && multi.every((l) => several.includes(l) && !cannot.includes(l)), JSON.stringify({ multi, several }));
    check("single-entity limits stay in the cannot-answer list (accounting profit among them)", CATALOG.unsupported.filter((u) => !u.multiStep).every((u) => cannot.includes(catalog.unsupportedLabel(u))) && cannot.includes("accounting profit"));
  }
  check("relative periods compare with like_for_like; custom dates only when the user gave them (the year guard refuses invented years)", /compare = the EARLIER period \(like_for_like when it is the one just before a relative period; custom only with dates the user gave\)/.test(text));
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
  // Product questions default to VALUE (lineAmount, PROJECT_CONTEXT "product sales = pre-tax item value"); quantity only when the user
  // asks for PRODUCT units: units, pieces, quantity, or a count of a product's items (how many <product>, kitne <pieces>). The rule reaches the
  // model through the catalog description and is scoped to products, so other "how many" questions (invoices, customers, orders) are unaffected.
  // These checks prove the prompt text and the corpus expectations agree - NOT what a live model does.
  check("the prompt states that lineAmount is the default for product sales AND purchase value (incl. 'most sold' / Hinglish 'bikne') and quantity only for product units/pieces", /^Default for product sales\/purchase value, incl\. most sold\/bikne; quantity only for product units\/pieces\./.test((metricInfo.lineAmount || {}).meaning || ""), (metricInfo.lineAmount || {}).meaning);
  check("product purchases have a line-value metric: lineAmount covers purchase (sign-flipped) while purchaseAmount is invoice-level and cannot be grouped by product", CATALOG.metrics.lineAmount.entities.includes("purchase") && CATALOG.metrics.lineAmount.aggregation.entitySign.purchase === -1 && CATALOG.metrics.purchaseAmount.grain === "voucher");
  const PRODUCT_UNIT_WORDS = /\b(units?|pieces?|quantity|qty|how many|kitne)\b/i; // applied to product questions only
  const isProductQuestion = (p) => !!p && ["sales", "purchase"].includes(p.entity) && [...(p.groupBy || []), ...(p.filters || [])].some((x) => x.dim === "product" || x.dim === "productGroup");
  // "How many CUSTOMERS bought <product>" counts customers (customerCount + a product filter): its "how many" is about customers, not
  // product units, so it is checked separately below instead of by the units rule.
  const CUSTOMER_COUNT_WORDS = /\b(?:how many|kitne)\s+(?:unique\s+|distinct\s+)?customers?\b/i;
  const countsCustomers = (r) => r.expected.plan.metrics.includes("customerCount") && CUSTOMER_COUNT_WORDS.test(r.question);
  const productRows = scoring.corpus.rows.filter((r) => !r.previousPlan && isProductQuestion(r.expected.plan) && !countsCustomers(r));
  const unitMismatch = productRows.filter((r) => PRODUCT_UNIT_WORDS.test(r.question) !== r.expected.plan.metrics.includes("quantity"));
  check(`product questions: all ${productRows.length} corpus plans use quantity exactly when the question asks for product units, otherwise the value metric`, productRows.length >= 40 && unitMismatch.length === 0, unitMismatch.map((r) => `${r.id} ${JSON.stringify(r.expected.plan.metrics)}`).join(", "));
  const customerProductRows = scoring.corpus.rows.filter((r) => !r.previousPlan && isProductQuestion(r.expected.plan) && countsCustomers(r));
  check(`'how many customers bought <product>': all ${customerProductRows.length} corpus plans count customers (customerCount with a product filter), never quantity`, customerProductRows.length >= 1 && customerProductRows.every((r) => JSON.stringify(r.expected.plan.metrics) === JSON.stringify(["customerCount"]) && r.expected.plan.filters.some((f) => f.dim === "product")), customerProductRows.map((r) => r.id).join(","));
  check("negative: the customer-count exclusion never applies to a units question", !CUSTOMER_COUNT_WORDS.test("how many units of Steel Bolt 10mm did we sell last month") && !CUSTOMER_COUNT_WORDS.test("LED Bulb 9W kitne pieces bike August 2025 mein?") && CUSTOMER_COUNT_WORDS.test("How many customers purchased LED Bulb 9W in September 2025?"));
  const triggerCases = [["LED Bulb 9W kitne pieces bike August 2025 mein?", true], ["how many units of Steel Bolt 10mm did we sell last month", true], ["top 10 products by quantity sold in August 2025", true], ["best selling products last month", false], ["sabse zyada bikne wale 5 items last month", false], ["Steel Bolt 10mm kitna bika September 2025 mein?", false], ["Least purchased product in August 2025", false], ["sabse kam bikne wala product", false], ["kitne pieces kharide Steel Bolt 10mm ke", true]];
  check("product-unit trigger words: Hinglish 'kitne pieces', 'units' and 'quantity' ask for units; 'best selling', 'sabse zyada bikne wale' and 'kitna bika' ask for value", triggerCases.every(([q, units]) => PRODUCT_UNIT_WORDS.test(q) === units), triggerCases.filter(([q, units]) => PRODUCT_UNIT_WORDS.test(q) !== units).map(([q]) => q).join(" | "));
  // The planner's value-default repair uses its own copy of these words: it must classify every trigger case and every corpus product
  // question exactly as this rule does, so the repair and the corpus expectations can never drift apart.
  const plannerUnits = require("./src/services/query/planner").PRODUCT_UNIT_WORDS;
  const unitText = (q) => q.toLowerCase().replace(/\s+/g, " ");
  const drift = [...triggerCases.map(([q]) => q), ...productRows.map((r) => r.question)].filter((q) => plannerUnits.test(unitText(q)) !== PRODUCT_UNIT_WORDS.test(q));
  check(`the planner's units words (value-default repair) agree with this rule on all ${triggerCases.length} trigger cases and ${productRows.length} corpus product questions`, plannerUnits instanceof RegExp && drift.length === 0, drift.join(" | "));
  const pinned = (id) => scoring.corpus.rows.find((r) => r.id === id).expected.plan;
  const rankedBy = (id, metric, dir) => { const p = pinned(id); return p.metrics.includes(metric) && p.sort && p.sort[0] && p.sort[0].by === metric && p.sort[0].dir === dir && (p.groupBy || []).some((g) => g.dim === "product"); };
  check("best-selling products (nl_0100) and the Hinglish most-sold items (nl_0107) are expected to rank by lineAmount, highest first, grouped by product", rankedBy("nl_0100", "lineAmount", "desc") && rankedBy("nl_0107", "lineAmount", "desc"));
  check("least-selling product (nl_0111) is expected to rank by lineAmount, lowest first", rankedBy("nl_0111", "lineAmount", "asc"));
  check("explicit units: top products by quantity sold (nl_0105) and highest quantity sold (nl_0106) are expected to rank by quantity, highest first", rankedBy("nl_0105", "quantity", "desc") && rankedBy("nl_0106", "quantity", "desc"));
  check("explicit unit count for one product (nl_0053 'How many LED Bulb 9W') is expected to use quantity and keep its product filter", pinned("nl_0053").metrics.includes("quantity") && (pinned("nl_0053").filters || []).some((f) => f.dim === "product" && f.op === "eq_ci"));
  const expectOf = (id) => scoring.corpus.rows.find((r) => r.id === id).expected;
  check("least purchased product (nl_0080) is expected as entity purchase, lineAmount, lowest first, grouped by product (never the invoice-level purchaseAmount)", rankedBy("nl_0080", "lineAmount", "asc") && pinned("nl_0080").entity === "purchase" && !pinned("nl_0080").metrics.includes("purchaseAmount"));
  const nonProductCounts = [["nl_0017", "invoiceCount"], ["nl_0019", "invoiceCount"], ["nl_0031", "purchaseInvoiceCount"]];
  check("non-product counting: 'how many invoices' (nl_0017), 'kitne invoice' (nl_0019) and purchase invoices (nl_0031) keep their invoice-count metrics, never quantity", nonProductCounts.every(([id, m]) => { const e = expectOf(id); return e.status === "supported" && e.plan.metrics.length === 1 && e.plan.metrics[0] === m && !isProductQuestion(e.plan); }));
  const refusedCounts = [["nl_0348", "decline"], ["nl_0385", "clarify"], ["nl_0388", "clarify"], ["nl_0397", "clarify"]];
  check("non-product counting: distinct products are declined and order counts ask for clarification (nl_0348, nl_0385, nl_0388, nl_0397); none expects quantity", refusedCounts.every(([id, status]) => { const e = expectOf(id); return e.status === status && !e.plan; }));
  const customers = expectOf("nl_0343");
  check("'how many customers' (nl_0343) expects the debtor-ledger customerCount, never quantity or an invoice count", customers.status === "supported" && JSON.stringify(customers.plan.metrics) === JSON.stringify(["customerCount"]) && customers.plan.entity === "sales" && !customers.plan.groupBy.length);
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
    const voucherPlan = swap(row.expected.plan, "lineAmount", overallMetric);
    const parsedVoucher = parseQueryPlan(voucherPlan);
    const direct = parsedVoucher.ok ? validateQueryPlan(parsedVoucher.plan, { referenceDate: scoring.REF_DATE }) : { ok: false, errors: [] };
    check(`${label}: the voucher-grain amount grouped by product is rejected by the validator (the engine can never attribute an invoice total to a product)`, parsedVoucher.ok && !direct.ok && direct.errors.length > 0 && direct.errors.every((e) => e.code === "dimension_not_applicable_to_voucher_metric"), JSON.stringify(direct.errors));
    const bad = await run(row, voucherPlan);
    check(`${label}: the planner switches that plan to the product's line value and says so (product_value_metric_applied), so it is answered as the exact expected plan`, bad.planned.status === "supported" && bad.planned.plan.metrics[0] === "lineAmount" && (bad.planned.definitionNotes || []).some((n) => n.code === "product_value_metric_applied") && bad.scored.outcome === "plan_correct", `${bad.planned.status} ${bad.scored.outcome}`);
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

  // Per-section budgets (chars incl. the line break), so growth is a visible, deliberate decision per section and a new section
  // cannot be added without a budget. The 5,000 total above is this test's own budget, not a provider limit; it still applies.
  const sizes = sectionSizes(text);
  const over = Object.entries(sizes).filter(([id, n]) => !(id in SECTION_BUDGETS) || n > SECTION_BUDGETS[id]);
  check("every digest section has an explicit budget and stays within it", over.length === 0, over.map(([id, n]) => `${id} ${n}/${SECTION_BUDGETS[id] ?? "no budget"}`).join(", "));
  check("every budgeted section is present in the digest (no stale budgets)", Object.keys(SECTION_BUDGETS).every((id) => sizes[id] > 0), Object.keys(SECTION_BUDGETS).filter((id) => !sizes[id]).join(","));
  const bigCat = clone();
  bigCat.metrics.lineAmount.description += " x".repeat(150);
  const bigSizes = sectionSizes(buildCatalogDigest(bigCat));
  check("negative: a 300-char longer metric description puts the metrics section over its budget", bigSizes.metrics > SECTION_BUDGETS.metrics, `${bigSizes.metrics}/${SECTION_BUDGETS.metrics}`);
  const extra = sectionSizes(`${text}\nPlanning rules: a new section.`);
  check("negative: a new unbudgeted section is reported as unbudgeted", extra.unbudgeted > 0 && !("unbudgeted" in SECTION_BUDGETS), JSON.stringify(extra.unbudgeted));
  console.log(`  (info) section sizes: ${Object.entries(sizes).map(([id, n]) => `${id} ${n}/${SECTION_BUDGETS[id] ?? "-"}`).join(", ")}`);

  console.log(`\nverify-planner-digest: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
