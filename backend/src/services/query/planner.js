"use strict";

// --------------------------------------------------
// Claude PLANNER for the Sales/Purchase Query Engine (Phase 1F).
//
// Role: turn a question into a Query DSL plan - and nothing else. It is the ONLY natural-language
// interpreter: there is no deterministic router in front of it.
//
//   question (+ the previous turn's structured plan, for follow-ups) -> ONE structured call
//   Claude's answer is only ever DATA:
//     tool input -> strict schema (layer 1) -> semantic validator (layer 2)
//     -> tenant-scoped entity resolution -> plan handed to the same
//     compiler/executor/cache as every other plan.
//
// What Claude can never do here (structurally, not by instruction):
//   * reach MongoDB: it has no tool except submit_query_plan, and that tool's
//     input is a closed schema (unknown keys rejected, ids are enums);
//   * choose tenant/company: neither concept exists in the prompt, the tool
//     schema, or any function signature in this file - tenant scope is applied
//     later by the server-side executor;
//   * write raw MongoDB: operators/expressions are not representable;
//   * invent entities: every customer/supplier/product/group name in a filter
//     is re-resolved against the tenant's own data (injected resolver) and
//     replaced with the stored spelling, or the plan is refused.
//
// Token discipline: one call, forced tool choice, no chat history (only the previous structured plan), no tenant data,
// static system prompt + tool schema marked cacheable, max_tokens capped.
// --------------------------------------------------

const catalog = require("./semanticCatalog");
const { parseQueryPlan, queryPlanJsonSchema } = require("./queryPlan.schema");
const { validateQueryPlan } = require("./validator");

// ---------------------------------------------------------------- safety gate + product definitions (shared policy)

// Input containing operator characters, tenant/company/database terms or prompt-injection phrasing is refused outright:
// Claude never sees it.
const UNSAFE_INPUT = [
  // Mongo operators, JSON, JS/shell/HTML/pipeline characters. Square brackets are deliberately NOT here: Tally stock item names
  // routinely contain them ("FEVICOL MR [20 GM]"), and the text only ever reaches Claude and, after name verification, an escaped
  // literal regex (compile.js regexCondition), never a pattern or an operator.
  /[${}`\\<>;|]/,
  /[\u0000-\u001f\u007f]/,
  /\b(?:tenant\s*id|tenantid|tenant|company\s*guid|companyguid|company\s*id|companyid|guid|objectid|mongo\w*|mongoose|db\s*\.\s*\w+)\b/i,
  /__proto__|\bconstructor\b|\bprototype\b/i,
  /\b(?:ignore|disregard|forget)\b.{0,30}\b(?:previous|prior|above|earlier|all)\b.{0,30}\b(?:instructions?|rules?|prompts?)\b/i,
  /\b(?:system\s+prompt|jailbreak|you\s+are\s+now|act\s+as|developer\s+mode)\b/i,
  /\b(?:drop|delete|truncate|update|insert)\s+(?:table|collection|database|from)\b/i,
];

/** The safety gate applied before any Claude call. */
function isUnsafeQuestion(question) {
  return typeof question !== "string" || UNSAFE_INPUT.some((re) => re.test(question));
}

// What the user is told when the gate refuses: operator characters get a specific, fixable message; the injection / internal-term patterns
// get the plain statement of what TallyPulse answers. The text never repeats the question.
const UNSAFE_CHARS_REASON = "The question contains a character that cannot be processed (one of $ { } ` \\ < > ; |). Please ask it again in plain words.";
const UNSAFE_SCOPE_REASON = "I can only answer questions about your Sales and Purchase data, so I can't act on that request. Please ask about sales, purchases, customers, suppliers or products.";
function unsafeReason(question) {
  return typeof question === "string" && UNSAFE_INPUT[0].test(question) ? UNSAFE_CHARS_REASON : UNSAFE_SCOPE_REASON;
}

// "Revenue" has ONE fixed meaning in TallyPulse: the pre-tax value of the items on active sales invoices
// (lineAmount). Stated on every answer so the basis is never hidden.
const REVENUE_ASSUMPTION = {
  code: "revenue_is_pre_tax_item_value",
  message: "Revenue = pre-tax value of the items sold (excludes GST, freight and other non-item charges, and invoices without item lines); gross of returns.",
};
// Same word test on every AI path (planner guard, chat fallbacks), so "revenue" can never reach a
// path that reads it as the tax-inclusive Sales total.
const REVENUE_RE = /\brevenues?\b/i;
const mentionsRevenue = (text) => typeof text === "string" && REVENUE_RE.test(text);

// Product decisions D1-D3 (final). Net sales / turnover = invoice sales AFTER returns and BEFORE tax; invoice sales = BEFORE tax and BEFORE returns.
// The engine has no invoice-level total before tax and cannot combine sales with returns in one figure, so these terms are REFUSED with the
// catalog's own reason - never answered with a nearby number (the sales total includes tax; revenue is the item lines only). An "order" is not
// an invoice (D1): an order question is never answered from invoice data. Enforced here, on whatever plan the model produced.
//
// The guards read the question after a light normalisation (case, Unicode width, zero-width characters, hyphens/underscores) and do not depend on
// the plan's shape, except where the question names no noun of its own: a follow-up such as "now exclude tax" is judged against the plan the model
// produced AND the previous turn's plan, so it cannot turn a tax-inclusive total into a "before tax" figure (or swap in the item-line revenue).
const normalizeTerms = (value) =>
  String(value)
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .toLowerCase()
    .replace(/[-_\u2010-\u2015]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ---- D3: net sales / turnover / "after returns"
const RETURNS_WORD = "(?:sales\\s+)?(?:returns?|credit\\s+notes?)";
const NET_SALES_TERMS = [
  /\bnett?\s?sales?\b/,
  /\bturn\s?over\b/,
  // a sales-like noun, then "after / net of / minus ... returns"
  new RegExp("\\b(?:sales?|invoices?)\\b[^.?!]{0,30}\\b(?:after|net\\s+of|less|minus|excluding|without|deducting|adjusted\\s+for)\\s+(?:the\\s+)?" + RETURNS_WORD + "\\b"),
  // no noun (a follow-up: "now deduct returns"): only verbs that cannot mean "customers with less/no returns"
  new RegExp("\\b(?:deduct(?:ing)?|subtract(?:ing)?|net(?:ting)?\\s+of|minus|after|adjust(?:ed|ing)?\\s+for)\\s+(?:the\\s+|all\\s+|any\\s+)?" + RETURNS_WORD + "\\b"),
  // Hinglish: "returns ke baad", "returns hata ke", "credit note minus karke"
  new RegExp("\\b(?:returns?|credit\\s+notes?)\\s+(?:ko\\s+|ke\\s+)?(?:baad|hata|nikal|ghata|minus|kam\\s?kar|alag)\\w*"),
];

// ---- D2: invoice sales / "excluding tax" (before tax)
const TAX = "(?:[cis]?gst|tax(?:es)?|vat)";
const TAX_NOUN = "(?:sales?|invoices?|purchases?|billing|bills?)";
const TAX_OFF = "(?:" + [
  "(?:excluding|excludes?|excluded|exclusive\\s+of|excl\\.?|before|without|w/o|net\\s+of|less|minus|deduct(?:ing)?|removing)\\s+(?:the\\s+|any\\s+|all\\s+)?" + TAX,
  "(?:pre|ex)\\s?" + TAX,
  "(?:bina|baghair|bagair)\\s+" + TAX,
  TAX + "\\s+(?:ke\\s+)?(?:bina|baghair|bagair)",
  TAX + "\\s+(?:ko\\s+)?(?:hata|nikal|alag|ghata|minus)\\w*",
].join("|") + ")\\b";
const TAX_OFF_RE = new RegExp("\\b" + TAX_OFF);
const INVOICE_SALES_TERMS = [
  /\binvoice\s?sales?\b/,
  new RegExp("\\b" + TAX_NOUN + "\\b[^.?!]{0,30}\\b" + TAX_OFF),
  new RegExp("\\b" + TAX_OFF + "[^.?!]{0,30}\\b" + TAX_NOUN + "\\b"),
  /\btaxable\s+(?:sales?|purchases?|value|amount)\b/,
];
// The amounts that are invoice TOTALS including tax (catalog amountBasis): a list shows them as its amount column.
const carriesVoucherTotal = (plan) =>
  !!plan && (plan.mode === "list" || (plan.metrics || []).some((id) => CATALOG_METRICS[id] && CATALOG_METRICS[id].amountBasis === "voucher_total_incl_tax"));

// ---- D1: orders. Plural "orders" always; singular "order" only in its commerce senses (never "in descending order", "order by", "in order to").
const ORDER_SORT_SENSE = /\b(?:ascending|descending|alphabetical|alphabetic|chronological|increasing|decreasing|reverse|numerical|sorted|sort)\s+order\b|\bin\s+(?:the\s+)?order\b|\border\s+by\b/g;
const ORDER_TERMS = [
  /\borders\b/,
  /\b(?:an?|the|my|our|each|every|per|many|few|any|some|more|all|no|pending|recent|average|avg|mean|total|number\s+of|count\s+of|no\s+of|purchase|sales?|customer|supplier|repeat|first|last|new|biggest|largest|smallest|single|ek)\s+order\b/,
  /\border\s+(?:value|size|count|total|amount|number|volume|quantity|frequency|history|book|booking|kitn\w*|kya|ka|ki|ke|aaye|aaya|hue|hua|list|dikha\w*|batao|detail\w*)\b/,
];
const mentionsOrders = (t) => {
  const commerce = t.replace(ORDER_SORT_SENSE, " ");
  return ORDER_TERMS.some((re) => re.test(commerce));
};
const INVOICE_WORD_RE = /\binvoic\w*/; // invoice, invoices, invoiced: the user's own bridge from "orders" to what TallyPulse holds
const ORDERS_REASON = "TallyPulse has no order data: its counts and averages are of sales or purchase invoices, not orders. If you mean invoices, ask for the number of invoices or the average invoice value.";

// ---- Distinct counts the catalog has no metric for: suppliers and different products. Only customers can be counted (customerCount).
// The model otherwise answers them with a nearby number (a purchase-invoice count per supplier, or units sold). Only a counting lead word
// followed DIRECTLY by the noun (with at most two plain modifiers), so a party or item name in between never triggers it; an invoice question
// ("how many invoices from suppliers") and an explicit units question ("how many units / pieces") are never refused. A plain "how many items"
// stays an item count (units), per the product decision.
const COUNT_LEAD = String.raw`(?:how\s+many|kitne|kitni|number\s+of|no\.?\s+of|count\s+of|total\s+number\s+of)`;
const COUNT_MODIFIERS = String.raw`(?:(?:purchase|different|unique|distinct|active|total|our|alag)\s+){0,2}`;
const SUPPLIER_COUNT_RE = new RegExp(String.raw`\b${COUNT_LEAD}\s+${COUNT_MODIFIERS}(?:suppliers?|vendors?|creditors?)\b|\b(?:suppliers?|vendors?)\s+(?:count|ki\s+ginti|ki\s+sankhya)\b`);
const PRODUCT_COUNT_RE = new RegExp(String.raw`\b${COUNT_LEAD}\s+${COUNT_MODIFIERS}(?:products?|skus?|product\s+types?|types?\s+of\s+(?:products?|items?))\b|\b(?:different|unique|distinct)\s+(?:products?|items?)\b|\bproduct\s+count\b`);
const EXPLICIT_UNITS_RE = /\b(?:units?|pieces?|quantity|qty|pcs)\b/;
const SUPPLIER_COUNT_REASON = "TallyPulse cannot count suppliers yet: it counts customers only (sales parties on debtor ledgers). To see each supplier's purchases, ask for purchases by supplier.";
const PRODUCT_COUNT_REASON = 'TallyPulse cannot count different products yet. For units sold, ask "how many units did we sell"; for each product\'s sales, ask for sales by product.';
const catalogReason = (id) => ((catalog.CATALOG.unsupported || []).find((u) => u.id === id) || {}).reason || "This cannot be calculated.";
const CATALOG_METRICS = catalog.CATALOG.metrics;

/**
 * A refusal when the question uses a term the engine cannot calculate (D1-D3, or a supplier / different-product count) and the model
 * nevertheless produced a plan; else null.
 * @param {string} question the user's question
 * @param {object} plan the plan the model produced (schema-parsed)
 * @param {object|null} [previousPlan] the previous turn's plan, for a follow-up that names no noun of its own
 */
function uncalculableTermRefusal(question, plan, previousPlan = null) {
  const t = normalizeTerms(question);
  if (NET_SALES_TERMS.some((re) => re.test(t))) return { status: "unsupported", route: "honest_response", source: "term_guard", code: "net_sales_unsupported", reason: catalogReason("net_of_returns") };
  // "revenue excluding tax" is its own, defined figure (pre-tax item lines, with its note): the revenue guard governs it, not this one.
  const definedRevenue = mentionsRevenue(question) && isRevenuePlan(plan);
  const taxOffOnTotal = !definedRevenue && TAX_OFF_RE.test(t) && (carriesVoucherTotal(plan) || carriesVoucherTotal(previousPlan));
  if (INVOICE_SALES_TERMS.some((re) => re.test(t)) || taxOffOnTotal) return { status: "unsupported", route: "honest_response", source: "term_guard", code: "invoice_sales_unsupported", reason: catalogReason("tax_breakdown") };
  if (mentionsOrders(t) && !INVOICE_WORD_RE.test(t)) return { status: "needs_clarification", route: "honest_response", source: "term_guard", code: "orders_not_invoices", reason: ORDERS_REASON };
  if (!INVOICE_WORD_RE.test(t) && SUPPLIER_COUNT_RE.test(t)) return { status: "unsupported", route: "honest_response", source: "term_guard", code: "supplier_count_unsupported", reason: SUPPLIER_COUNT_REASON };
  if (!INVOICE_WORD_RE.test(t) && !EXPLICIT_UNITS_RE.test(t) && PRODUCT_COUNT_RE.test(t)) return { status: "unsupported", route: "honest_response", source: "term_guard", code: "distinct_product_count_unsupported", reason: PRODUCT_COUNT_REASON };
  return null;
}

// Profit questions: TallyPulse holds no cost data (catalog "profit_margin"). Only words that cannot be part of a party or item name.
const PROFIT_TERMS = /\b(?:profits?|profitab\w+|cogs|cost\s+of\s+goods|gross\s+margin|net\s+margin)\b/;

// "New customer/supplier" needs the ledger master; it cannot be read off a comparison of two periods.
const NEW_PARTY_REASON = 'A "new customer" (or supplier) is one whose Tally ledger was created in the period and who traded in it. That cannot be read off a comparison of two periods (a returning customer is not new), so ask it directly with one period, for example "new customers this month".';
// Decision 2 (final, 2026-09-28): "this month vs last month" = month to date vs the COMPLETE previous calendar month.
// A grouping by customer / supplier / product must be sorted (validator rule high_cardinality_requires_sort) or the rows it returns are
// arbitrary. The model sometimes forgets it ("how many new customers did we get in November?" failed on that alone), and the only sensible
// order is the first metric asked for, highest first: so when that is the ONLY thing wrong with an otherwise valid plan it is added, and the
// answer says so. Any other validator error is left alone and still fails the plan.
const DEFAULT_SORT_NOTE_CODE = "default_sort_applied";
function withDefaultSort(plan) {
  if (!plan || plan.mode !== "aggregate" || !Array.isArray(plan.metrics) || !plan.metrics.length) return null;
  const label = ((CATALOG.metrics || {})[plan.metrics[0]] || {}).label || plan.metrics[0];
  return { plan: { ...plan, sort: [{ by: plan.metrics[0], dir: "desc" }] }, note: { code: DEFAULT_SORT_NOTE_CODE, message: `No order was asked for, so the rows are ordered by ${label}, highest first.` } };
}

// An invoice-level amount cannot be split by product (validator rule dimension_not_applicable_to_voucher_metric). A product question
// on sales or purchases means the product's pre-tax item value (PROJECT_CONTEXT, decided meanings), and the model sometimes picks the
// invoice total instead ("least purchased product" -> purchaseAmount by product). When that is the ONLY thing wrong - every validator
// error is this rule and every metric is the entity's invoice-level amount - the metric (and its sort/having references) is switched to
// the entity's line value, and the answer says so. Counts, averages, mixed metrics, returns and any other error still fail the plan.
const PRODUCT_VALUE_ERROR = "dimension_not_applicable_to_voucher_metric";
const PRODUCT_VALUE_NOTE_CODE = "product_value_metric_applied";
function catalogAmountMetric(entity, grain, amountBasis) {
  return Object.values(CATALOG.metrics || {}).find((m) => m.status === "supported" && m.grain === grain && m.amountBasis === amountBasis && m.aggregation && m.aggregation.op === "sum" && m.entities.includes(entity)) || null;
}
function withProductValueMetric(plan) {
  if (!plan || plan.mode !== "aggregate" || !["sales", "purchase"].includes(plan.entity) || !Array.isArray(plan.metrics) || !plan.metrics.length) return null;
  const from = catalogAmountMetric(plan.entity, "voucher", CATALOG.amountBasis.VOUCHER_TOTAL_INCL_TAX);
  const to = catalogAmountMetric(plan.entity, "line", CATALOG.amountBasis.LINE_ITEM_PRE_TAX);
  if (!from || !to || !plan.metrics.every((m) => m === from.id)) return null;
  const rename = (ref) => (ref === from.id ? to.id : typeof ref === "string" && ref.startsWith(`${from.id}.`) ? `${to.id}${ref.slice(from.id.length)}` : ref);
  const fixed = {
    ...plan,
    metrics: [to.id],
    sort: (plan.sort || []).map((s) => ({ ...s, by: rename(s.by) })),
    having: (plan.having || []).map((h) => ({ ...h, metric: rename(h.metric) })),
  };
  return { plan: fixed, note: { code: PRODUCT_VALUE_NOTE_CODE, message: `${from.label} is an invoice total and cannot be split by product, so product values use ${to.label}: the pre-tax value of the items, which does not add up to invoice totals.` } };
}

const MONTH_FULL_NOTE = { code: "month_vs_complete_previous_month", message: 'This month so far is compared with the complete previous month (the product\'s standard month comparison). Ask for "same period last month" to compare the same days.' };

// "Last year" with no basis named is the previous FINANCIAL year (product decision). The plan's period is the model's; this only makes
// the assumption a fixed line of the answer whenever the plan is previous_fy and the user wrote "last year" without naming a basis.
const LAST_YEAR_WORDING = /\b(?:last|previous|prior|pichh?l[ae])\s+(?:year|yr|saal|sal)\b/i;
const YEAR_BASIS_WORDING = /\b(?:financial|fiscal|fy|calendar)\b/i;
const LAST_YEAR_FY_NOTE = { code: "last_year_previous_fy", message: '"Last year" is read as the previous financial year (April to March). For a calendar year, ask for it by its dates, for example "sales January to December 2024".' };
const needsLastYearNote = (plan, text) => plan.period && plan.period.kind === "previous_fy" && LAST_YEAR_WORDING.test(text) && !YEAR_BASIS_WORDING.test(text);

// "Which products did we sell?" ranks products by value (product decision), not by name. When a sales/purchase product breakdown is
// sorted ONLY by the product name and the user did not ask for name order, the sort becomes the plan's value metric (lineAmount when
// selected, else its first metric), highest first, and the answer says so. Explicit name order, comparisons and metric sorts are untouched.
// Product questions default to the sales value (product decision, PROJECT_CONTEXT "decided meanings"): quantity only when the user asks
// for units, pieces or an item count ("how many <product>", "kitne pieces"). The model sometimes picks quantity for "most sold" wording
// (Hinglish "sabse zyada bikne wale": live runs 2026-10-19 and 2026-10-21). When a sales/purchase product plan's ONLY metric is quantity
// and the question has none of those words, the metric (and its sort/having references) becomes lineAmount, and the answer says so.
// A follow-up whose previous plan already counted units keeps quantity ("only top 5" after a units ranking). A plan with a NON-ZERO
// threshold on quantity (having quantity gt 50, quantity.delta lt -10) keeps quantity too: the number is a count of units, and renaming
// the metric would silently turn it into a rupee threshold. A zero threshold (quantity.delta lt 0 = "fell") means the same in units or
// value (sold / grew / fell at all), so it does not block the switch.
const PRODUCT_UNIT_WORDS = /\b(?:units?|pieces?|quantity|qty|pcs|how\s+many|kitne)\b/;
const PRODUCT_VALUE_DEFAULT_NOTE_CODE = "product_value_default_applied";
const isProductPlan = (plan) => ["sales", "purchase"].includes(plan.entity) && [...(plan.groupBy || []), ...(plan.filters || [])].some((x) => x.dim === "product" || x.dim === "productGroup");
function withProductValueDefault(plan, text, previousPlan) {
  if (!plan || plan.mode !== "aggregate" || !isProductPlan(plan) || PRODUCT_UNIT_WORDS.test(normalizeTerms(text))) return null;
  if (!Array.isArray(plan.metrics) || plan.metrics.length !== 1 || plan.metrics[0] !== "quantity") return null;
  if (previousPlan && (previousPlan.metrics || []).includes("quantity")) return null;
  const quantityRef = (ref) => ref === "quantity" || (typeof ref === "string" && ref.startsWith("quantity."));
  if ((plan.having || []).some((h) => quantityRef(h.metric) && h.value !== 0)) return null;
  const rename = (ref) => (ref === "quantity" ? "lineAmount" : typeof ref === "string" && ref.startsWith("quantity.") ? `lineAmount${ref.slice("quantity".length)}` : ref);
  const label = ((CATALOG.metrics || {}).lineAmount || {}).label || "lineAmount";
  return {
    plan: { ...plan, metrics: ["lineAmount"], sort: (plan.sort || []).map((s) => ({ ...s, by: rename(s.by) })), having: (plan.having || []).map((h) => ({ ...h, metric: rename(h.metric) })) },
    note: { code: PRODUCT_VALUE_DEFAULT_NOTE_CODE, message: `Products are measured by sales value (${label}). Ask for units or pieces to see quantities instead.` },
  };
}

const NAME_ORDER_WORDING =/\b(?:alphabetic(?:al(?:ly)?)?|a\s*(?:-|to)\s*z|z\s*(?:-|to)\s*a|by\s+(?:product\s+)?names?|name[- ]?wise|naam\s+se)\b/i;
const PRODUCT_SORT_NOTE_CODE = "product_value_sort_applied";
function withProductValueSort(plan, text) {
  if (!plan || plan.mode !== "aggregate" || !["sales", "purchase"].includes(plan.entity) || plan.compare || NAME_ORDER_WORDING.test(text)) return null;
  if (!Array.isArray(plan.groupBy) || plan.groupBy.length !== 1 || plan.groupBy[0].dim !== "product") return null;
  if (!Array.isArray(plan.sort) || !plan.sort.length || !plan.sort.every((s) => s.by === "product") || !plan.metrics.length) return null;
  const by = plan.metrics.includes("lineAmount") ? "lineAmount" : plan.metrics[0];
  const label = ((CATALOG.metrics || {})[by] || {}).label || by;
  return { plan: { ...plan, sort: [{ by, dir: "desc" }] }, note: { code: PRODUCT_SORT_NOTE_CODE, message: `Products are ranked by ${label}, highest first. Ask for them "alphabetically" to list them by name.` } };
}

const { CATALOG } = catalog;

const PLANNER_TOOL_NAME = "submit_query_plan";
const PLANNER_MAX_TOKENS = 700;
const PLANNER_MAX_QUESTION_CHARS = 600;
// Bounded planner call (the chat frontend gives up after 60s; the rest of the turn - freshness,
// engine with its 8s maxTimeMS, persistence - must still fit). One SDK retry at most, each attempt capped,
// and an overall deadline that aborts the request whatever the SDK is doing.
const PLANNER_ATTEMPT_TIMEOUT_MS = 15000;
const PLANNER_MAX_RETRIES = 1;
const PLANNER_DEADLINE_MS = 30000;
const DEFAULT_PLANNER_MODEL = "claude-sonnet-4-5-20250929";
const MAX_REPAIRS_CAP = 1;
const VALIDATION_FALLBACK_REF = new Date(2025, 0, 15, 12, 0, 0);

// needs_analysis: the question needs several analyses (or an explanation). It is still a decline of THIS planner (status
// "unsupported"), so every existing consumer treats it as before; queryChat may hand it to the analysis planner instead.
const DECLINE_CODES = ["unsupported_domain", "needs_clarification", "not_a_data_query", "needs_analysis"];
const NAME_DIMENSIONS = new Set(["customer", "supplier", "product", "productGroup"]);


// ---------------------------------------------------------------- prompt + tool (built once from the catalog)

let memo = null;

// What the model is told about the data comes from the catalog (semanticCatalog.js), the single source of truth: each
// metric's scope, grain and - where its meaning is not obvious from its name - the catalog's own description; the validator
// rules the schema cannot express; and the list of what cannot be answered. Storage
// paths, aggregation formulas, parity oracles and developer notes are never sent. Only the planner's own wording (output
// format, "revenue", name copying, period vocabulary, forecasts/explanations) is written here.

// Validator rules (catalog QUERY_RULES) the model cannot infer from the plan schema; their catalog text is sent as written.
const NLU_RULE_CODES = ["high_cardinality_requires_sort", "list_mode_shape", "dimension_not_applicable_to_voucher_metric"];

// A metric carries its catalog description when it is a summed amount or quantity (the basis - tax-inclusive invoice total vs pre-tax
// item value - matters) or a distinct count (what is counted and how it cannot be grouped). Plain counts and ratios are self-explanatory.
const needsMeaning = (m) => !!(m.aggregation && (m.aggregation.op === "sum" || m.aggregation.op === "distinct"));

function buildCatalogDigest(cat = CATALOG) {
  const limits = cat.limits;
  const dims = Object.values(cat.dimensions);
  const metricLines = Object.values(cat.metrics)
    .filter((m) => m.status === "supported")
    .map((m) => `${m.id} [${m.entities.join("/")}; ${m.grain}]${needsMeaning(m) ? `: ${m.description}` : ""}`);
  // Compact, still generated from the catalog: "all" when a dimension exists for every entity, and the grain only when it
  // is line-only (every dimension supports line grain; voucher-grain metrics need a voucher-grain dimension).
  const entityIds = Object.keys(cat.entities);
  const dimLines = dims.map((d) => {
    const ents = entityIds.every((e) => d.entities.includes(e)) ? "all" : d.entities.join("/");
    const lineOnly = (d.grains || []).includes("voucher") ? "" : "; line only";
    const buckets = d.id === "date" ? `; buckets ${d.buckets.join("|")}` : "";
    return `${d.id} (${ents}${lineOnly}${buckets})`;
  });
  const rules = NLU_RULE_CODES.map((code) => {
    const rule = cat.queryRules.find((r) => r.code === code);
    if (!rule) throw new Error(`The catalog has no query rule ${code}.`);
    return rule.description;
  });
  // multi-step entries are not "cannot answer": separate analysis steps answer them, so they are named in the needs_analysis rule
  const unsupported = cat.unsupported.filter((u) => !u.multiStep).map((u) => `${catalog.unsupportedLabel(u)}${u.examples ? ` (${u.examples.join(", ")})` : ""}`).join("; ");
  const multiStep = cat.unsupported.filter((u) => u.multiStep).map((u) => catalog.unsupportedLabel(u)).join(", ");
  return [
    "You translate ONE Sales/Purchase question into ONE query plan by calling submit_query_plan. Never answer in prose. Never state figures.",
    `Entities: ${Object.values(cat.entities).map((e) => `${e.id} (${e.label}; party dimension: ${e.partyDimension})`).join(", ")}. One entity per plan.`,
    `Metrics [entities; grain: voucher = one value per invoice, line = one per item line]:\n${metricLines.join("\n")}`,
    `Dimensions (groupBy, max ${limits.maxGroupBy}): ${dimLines.join("; ")}.`,
    `Rules: never mix invoice-grain and line-grain metrics in one plan. A date groupBy needs a bucket and cannot be combined with compare. Mode "list" returns individual invoices. ${rules.join(" ")} "Which products did we sell": sort by the value metric, desc; by name only if asked.`,
    // The period kinds and compare modes are enums of the tool schema itself, so they are not listed again here; ytd stays unused.
    // The schema also requires a custom compare's period and caps limit (maximum), so neither is repeated here.
    'Period kinds: use the schema values, never ytd. custom needs from/to as YYYY-MM-DD; specific_fy needs fy like 2024-25. all_time cannot be compared. Financial year is April-March; "last year" alone = previous_fy.',
    "having/sort may use a selected metric or, with compare, metric.previous / metric.delta / metric.deltaPct.",
    "Growth/decline between two periods (grew, increased, dropped, fell, vs): period = the LATER period, compare = the EARLIER period (like_for_like when it is the one just before a relative period; custom only with dates the user gave); group only by the dimension asked, never a date groupBy; sort by metric.delta (desc = most growth, asc = biggest decline). ALL items meeting a condition (customers above an amount): having with limit " + limits.maxLimit + ".",
    '"Revenue" has one fixed meaning: the pre-tax value of the items sold = entity sales with metric lineAmount (never invoiceAmount, invoiceCount or averageInvoiceValue). If a revenue question needs purchases or an invoice-level metric, decline.',
    'Returns: "returns" and "credit notes" mean sales_return; purchase_return only when purchases, suppliers or debit notes are named. "Orders" are not invoices and there is no order data: never answer an order question with an invoice count or average (ask which invoices are meant). Net sales, turnover and invoice sales (before tax) cannot be calculated: decline.',
    "Copy customer/supplier/product/group names exactly as the user wrote them; never invent names. Never add a period the user did not state unless the question clearly implies one.",
    `If the question needs something this data cannot answer (${unsupported}), or a forecast, or is truly ambiguous ("this year": financial or calendar?), do NOT guess: send decline {code, message}. Several analyses (${multiStep}; a change, then its customers/products), an explanation, discounts or product margins: code needs_analysis. Otherwise send plan, plus up to 3 short assumptions.`,
  ].join("\n");
}

function getPlannerPrompt() {
  if (!memo) {
    memo = {
      system: [{ type: "text", text: buildCatalogDigest(), cache_control: { type: "ephemeral" } }],
      tool: {
        name: PLANNER_TOOL_NAME,
        description: "Submit the query plan for the question, or decline it. Call exactly once.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            plan: queryPlanJsonSchema(),
            decline: {
              type: "object",
              additionalProperties: false,
              properties: {
                code: { type: "string", enum: DECLINE_CODES },
                message: { type: "string", maxLength: 200 },
              },
              required: ["code"],
            },
            assumptions: { type: "array", maxItems: 3, items: { type: "string", maxLength: 160 } },
          },
        },
        cache_control: { type: "ephemeral" },
      },
    };
  }
  return memo;
}

// ---------------------------------------------------------------- helpers

const CONTROL = /[\u0000-\u001f\u007f]/g;
// Anything Claude wrote is untrusted display text: no control chars, bounded, never fed to the engine.
function cleanText(value, max) {
  return typeof value === "string" ? value.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== "object") return;
  for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    if (Number.isFinite(usage[k])) total[k] += usage[k];
  }
}

function newUsage() {
  return { calls: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

const REVENUE_BASIS_REFUSAL = 'Revenue in TallyPulse means the pre-tax value of the items sold, and this question can\'t be answered on that basis. Ask for revenue on its own (for example "revenue last month" or "top 5 customers by revenue this month"), or ask for sales if you want tax-inclusive invoice totals.';

function isRevenuePlan(plan) {
  const metrics = plan.metrics || [];
  return plan.entity === "sales" && metrics.includes("lineAmount") && metrics.every((m) => CATALOG.metrics[m] && CATALOG.metrics[m].grain === "line");
}

// Years the user actually wrote: 2025, '25, 2025-26, 24-25 (both years of an FY label).
function statedYears(text) {
  const years = new Set();
  for (const m of text.matchAll(/\b(20\d{2})\b/g)) years.add(Number(m[1]));
  for (const m of text.matchAll(/\b(?:20)?(\d{2})\s*-\s*(\d{2})\b/g)) {
    years.add(2000 + Number(m[1]));
    years.add(2000 + Number(m[2]));
  }
  for (const m of text.matchAll(/'(\d{2})\b/g)) years.add(2000 + Number(m[1]));
  return years;
}

// The previous STRUCTURED plan of the conversation (follow-ups). It is untrusted input: it must pass the same strict
// schema as any plan, otherwise it is ignored (the question is then planned exactly as without one). Only the plan -
// never chat text, answers, tool results or figures - and it is shown to Claude without its default fields.
function readPreviousPlan(previousPlan) {
  if (previousPlan === undefined || previousPlan === null) return null;
  const parsed = parseQueryPlan(previousPlan);
  if (!parsed.ok) return null;
  const compact = {};
  for (const [k, v] of Object.entries(parsed.plan)) {
    if (v === null || (Array.isArray(v) && v.length === 0)) continue;
    if ((k === "totals" && v === true) || (k === "explain" && v === "none")) continue;
    compact[k] = v;
  }
  return { plan: parsed.plan, json: JSON.stringify(compact) };
}

function previousPlanMessage(json, text) {
  return [
    "Previous query plan (structured JSON). The question below may refine or modify it:",
    json,
    "Interpret the question in that context and return one complete new plan that follows the same rules. Keep whatever the question does not change. If the question is not a follow-up, ignore the previous plan.",
    `Question: ${text}`,
  ].join("\n");
}

// Years in the previous plan's own dates were stated by the user in an earlier turn (and validated then), so a follow-up
// that keeps that period is not "inventing" a year.
function plannedYears(plan) {
  const years = new Set();
  const add = (p) => {
    if (!p) return;
    if (p.kind === "custom") {
      years.add(Number(p.from.slice(0, 4)));
      years.add(Number(p.to.slice(0, 4)));
    } else if (p.kind === "specific_fy") {
      years.add(Number(p.fy.slice(0, 4)));
      years.add(Number(p.fy.slice(0, 4)) + 1);
    }
  };
  add(plan.period);
  if (plan.compare && plan.compare.mode === "custom") add(plan.compare.period);
  return years;
}

function datesStated(plan, text, previous = null) {
  const years = statedYears(String(text));
  if (previous) for (const y of plannedYears(previous)) years.add(y);
  const ok = (p) => {
    if (!p) return true;
    if (p.kind === "custom") return years.has(Number(p.from.slice(0, 4))) && years.has(Number(p.to.slice(0, 4)));
    if (p.kind === "specific_fy") return years.has(Number(p.fy.slice(0, 4))) || years.has(Number(p.fy.slice(0, 4)) + 1);
    return true; // relative kinds stay symbolic: the server resolves them with the tenant reference date
  };
  return ok(plan.period) && (!plan.compare || plan.compare.mode !== "custom" || ok(plan.compare.period));
}

// Product rules the planner's plan must follow, enforced here (never left to Claude):
//  decision 2 - "this month vs last month" compares with the COMPLETE previous month unless the user asked for the
//               same days; decision 3 - "new customer/supplier" (absent in the comparison period) is not answerable
//               without the party master.
const SAME_DAYS_WORDING = /\b(?:same (?:period|days|dates|date range|number of days|day count|elapsed days)|like[- ]for[- ]like|month[- ]to[- ]date|lmtd|same[- ]day[- ]count)\b/i;
const isNewPartyPlan = (plan) =>
  (plan.groupBy || []).some((g) => g.dim === "customer" || g.dim === "supplier") &&
  (plan.having || []).some((h) => /\.previous$/.test(h.metric) && h.op === "eq" && h.value === 0);

const failed = (code, reason, usage, extra = {}) => ({ status: "planner_failed", route: "honest_response", source: "claude_planner", code, reason, usage, ...extra });

/**
 * The question-level checks a model-written query plan must pass, as planQuestion applies them after the model answers: the
 * decided terms (D1-D3, counts), the revenue basis, years the user never wrote, and new-party comparisons. Exported so the
 * analysis planner applies the SAME checks to each query step; it composes the existing functions and changes none of them.
 * @returns {null | {status, code, reason, source}} null when the plan may run
 */
function checkPlannedQuery(question, plan) {
  const text = String(question || "").replace(/\s+/g, " ").trim();
  const term = uncalculableTermRefusal(text, plan, null);
  if (term) return term;
  if (mentionsRevenue(text) && !isRevenuePlan(plan)) return { status: "unsupported", source: "revenue_guard", code: "revenue_basis_unsupported", reason: REVENUE_BASIS_REFUSAL };
  if (!datesStated(plan, text, null)) return { status: "needs_clarification", source: "date_guard", code: "year_missing", reason: "Which year do you mean?" };
  if (isNewPartyPlan(plan)) return { status: "unsupported", source: "new_party_guard", code: "unsupported_new_party", reason: NEW_PARTY_REASON };
  return null;
}

/**
 * The decided rules that rewrite or annotate a valid, name-verified query plan, as planQuestion applies them: the complete
 * previous month (decision 2), the product value default and value sort, and the "last year" note. Exported so the analysis
 * planner applies the SAME rules to each query step (one implementation; the same numbers and notes for the same plan).
 * @returns {{plan, validation, notes: object[]} | {error: string}} the plan is a new object; the input is not changed
 */
function applyPlanRules(question, inputPlan, { referenceDate, previousPlan = null, validation = null } = {}) {
  const text = String(question || "").replace(/\s+/g, " ").trim();
  const ref = referenceDate || VALIDATION_FALLBACK_REF;
  let plan = JSON.parse(JSON.stringify(inputPlan));
  let checked = validation || validateQueryPlan(plan, { referenceDate: ref });
  if (!checked.ok) return { error: "The plan is not valid." };
  const notes = [];
  if (plan.period.kind === "current_month" && plan.compare && plan.compare.mode === "like_for_like" && !SAME_DAYS_WORDING.test(text)) {
    plan.compare = { mode: "full_previous" };
    checked = validateQueryPlan(plan, { referenceDate: ref });
    if (!checked.ok) return { error: "The plan was not valid after applying the month comparison rule." };
    notes.push(MONTH_FULL_NOTE);
  }
  const valueDefault = withProductValueDefault(plan, text, previousPlan);
  if (valueDefault) {
    const v = validateQueryPlan(valueDefault.plan, { referenceDate: ref });
    const reparsed = v.ok ? parseQueryPlan(valueDefault.plan) : null;
    if (reparsed && reparsed.ok) {
      plan = JSON.parse(JSON.stringify(reparsed.plan));
      checked = v;
      notes.push(valueDefault.note);
    }
  }
  const valueSort = withProductValueSort(plan, text);
  if (valueSort) {
    const v = validateQueryPlan(valueSort.plan, { referenceDate: ref });
    const reparsed = v.ok ? parseQueryPlan(valueSort.plan) : null;
    if (reparsed && reparsed.ok) {
      plan = JSON.parse(JSON.stringify(reparsed.plan));
      checked = v;
      notes.push(valueSort.note);
    }
  }
  if (needsLastYearNote(plan, text)) notes.push(LAST_YEAR_FY_NOTE);
  return { plan, validation: checked, notes };
}

// ---------------------------------------------------------------- the planner

/**
 * @param {string} question
 * @param {object} options
 * @param {Function} options.claudeClient async ({system, messages, tools, tool_choice, max_tokens}) => Anthropic-shaped response
 * @param {Function} [options.resolveEntity] tenant-scoped resolver (server-supplied); re-verifies every name Claude used
 * @param {Date} [options.referenceDate] only for running the semantic validator
 * @param {number} [options.maxRepairs=0] 0 or 1: one extra call that returns only validator error codes
 * @param {object} [options.previousPlan] the previous query plan of the conversation (structured plan only, optional). When it passes
 *        the plan schema it is added to the user message as JSON for follow-ups; when invalid it is ignored.
 */
async function planQuestion(question, options = {}) {
  const out = await planQuestionCore(question, options);
  // A profit / margin question the model could not turn into anything usable gets the fixed catalog answer (no cost data) instead of
  // a generic "could not make a query". Only on those two failure codes and only the unambiguous words, so a name never triggers it.
  if (out && out.status === "planner_failed" && (out.code === "planner_protocol_violation" || out.code === "planner_invalid_plan") && PROFIT_TERMS.test(normalizeTerms(question))) {
    return { status: "unsupported", route: "honest_response", source: "profit_guard", code: "profit_margin_unsupported", reason: catalogReason("profit_margin"), usage: out.usage };
  }
  return out;
}

async function planQuestionCore(question, options = {}) {
  const { claudeClient, resolveEntity, referenceDate } = options;
  const previous = readPreviousPlan(options.previousPlan);
  if (typeof claudeClient !== "function") throw new Error("planQuestion requires a claudeClient function.");
  const maxRepairs = Math.min(MAX_REPAIRS_CAP, Math.max(0, Number.isInteger(options.maxRepairs) ? options.maxRepairs : 0));
  const usage = newUsage();

  // ---- gate: Claude never sees unsafe, empty or oversized text
  if (typeof question !== "string" || !question.trim()) return { status: "unsupported", route: "honest_response", source: "planner_gate", code: "empty_question", reason: "The question is empty.", usage };
  if (isUnsafeQuestion(question)) return { status: "unsupported", route: "honest_response", source: "planner_gate", code: "unsafe_input", reason: unsafeReason(question), usage };
  const text = question.replace(/\s+/g, " ").trim();
  if (text.length > PLANNER_MAX_QUESTION_CHARS) return { status: "needs_clarification", route: "honest_response", source: "planner_gate", code: "question_too_long", reason: "Please shorten the question.", usage };

  const prompt = getPlannerPrompt();
  let messages = [{ role: "user", content: previous ? previousPlanMessage(previous.json, text) : text }];
  let lastFailure = null;

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    // Client disconnected (Stop): no first call and no repair call.
    if (options.signal && options.signal.aborted) return failed("planner_call_failed", "The request was cancelled.", usage, { retryable: true });
    let response;
    usage.calls += 1;
    try {
      response = await claudeClient(
        {
          system: prompt.system,
          messages,
          tools: [prompt.tool],
          tool_choice: { type: "tool", name: PLANNER_TOOL_NAME },
          max_tokens: PLANNER_MAX_TOKENS,
        },
        { signal: options.signal || null }
      );
    } catch (error) {
      const timedOut = !!error && (error.code === "PLANNER_DEADLINE_EXCEEDED" || /timeout|timed out|abort/i.test(`${error.name} ${error.message}`));
      return timedOut
        ? failed("planner_timeout", "The planning service did not respond in time.", usage, { retryable: true })
        : failed("planner_call_failed", "The planning service is unavailable right now.", usage, { retryable: true });
    }
    addUsage(usage, response && response.usage);

    // ---- protocol: exactly one submit_query_plan tool_use, nothing else that matters
    const blocks = response && Array.isArray(response.content) ? response.content : [];
    const toolUses = blocks.filter((b) => b && b.type === "tool_use");
    if (toolUses.length !== 1 || toolUses[0].name !== PLANNER_TOOL_NAME || !isPlainObject(toolUses[0].input)) {
      return failed("planner_protocol_violation", "The planner did not return exactly one structured plan.", usage);
    }
    const input = toolUses[0].input;
    const extraKeys = Object.keys(input).filter((k) => !["plan", "decline", "assumptions"].includes(k));
    const hasPlan = Object.prototype.hasOwnProperty.call(input, "plan");
    const hasDecline = Object.prototype.hasOwnProperty.call(input, "decline");
    if (extraKeys.length || hasPlan === hasDecline) {
      return failed("planner_protocol_violation", "The planner output had an unexpected shape.", usage);
    }

    // ---- decline
    if (hasDecline) {
      const d = input.decline;
      if (!isPlainObject(d) || !DECLINE_CODES.includes(d.code)) return failed("planner_protocol_violation", "The planner decline was malformed.", usage);
      const message = cleanText(d.message, 200) || "This question cannot be answered with the available Sales/Purchase queries.";
      return d.code === "needs_clarification"
        ? { status: "needs_clarification", route: "honest_response", source: "claude_planner", code: "planner_needs_clarification", reason: message, usage }
        : { status: "unsupported", route: "honest_response", source: "claude_planner", code: `planner_${d.code}`, reason: message, usage };
    }

    // ---- plan: schema -> validator (same layers the engine enforces again at execution)
    let parsed = parseQueryPlan(input.plan);
    let errors = null;
    let validation = null;
    let defaultSortNote = null;
    let productValueNote = null;
    if (!parsed.ok) errors = (parsed.errors || []).map((e) => ({ code: e.code, path: e.path }));
    else {
      validation = validateQueryPlan(parsed.plan, { referenceDate: referenceDate || VALIDATION_FALLBACK_REF });
      if (!validation.ok) errors = validation.errors.map((e) => ({ code: e.code, path: e.path }));
    }
    if (errors && parsed.ok && errors.length === 1 && errors[0].code === "high_cardinality_requires_sort") {
      const fixed = withDefaultSort(parsed.plan);
      const reparsed = fixed ? parseQueryPlan(fixed.plan) : null;
      const revalidated = reparsed && reparsed.ok ? validateQueryPlan(reparsed.plan, { referenceDate: referenceDate || VALIDATION_FALLBACK_REF }) : null;
      if (revalidated && revalidated.ok) {
        parsed = reparsed;
        validation = revalidated;
        errors = null;
        defaultSortNote = fixed.note;
      }
    }
    if (errors && parsed.ok && errors.every((e) => e.code === PRODUCT_VALUE_ERROR)) {
      const fixed = withProductValueMetric(parsed.plan);
      const reparsed = fixed ? parseQueryPlan(fixed.plan) : null;
      const revalidated = reparsed && reparsed.ok ? validateQueryPlan(reparsed.plan, { referenceDate: referenceDate || VALIDATION_FALLBACK_REF }) : null;
      if (revalidated && revalidated.ok) {
        parsed = reparsed;
        validation = revalidated;
        errors = null;
        productValueNote = fixed.note;
      }
    }
    if (errors) {
      lastFailure = errors;
      if (attempt < maxRepairs) {
        // One repair round: only OUR validator's codes go back (no user data, no tenant data).
        messages = [
          messages[0],
          { role: "assistant", content: [toolUses[0]] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: toolUses[0].id, is_error: true, content: `Rejected by validator: ${errors.slice(0, 5).map((e) => `${e.code}@${e.path || "/"}`).join(", ")}. Resubmit a corrected plan or decline.` }] },
        ];
        continue;
      }
      return failed("planner_invalid_plan", "The planner produced a plan the query engine cannot run.", usage, { errors: errors.slice(0, 5) });
    }

    // ---- D1-D3: net sales / turnover / invoice sales (before tax) / orders are refused, never answered with a nearby figure
    const termRefusal = uncalculableTermRefusal(text, parsed.plan, previous && previous.plan);
    if (termRefusal) return { ...termRefusal, usage };

    // ---- revenue basis: enforced here, not trusted to the prompt. A revenue question may only become the
    // pre-tax item-value plan (sales + lineAmount, no invoice-level metric); anything else is refused -
    // never answered as the tax-inclusive Sales total.
    const revenue = mentionsRevenue(text);
    if (revenue && !isRevenuePlan(parsed.plan)) {
      return { status: "unsupported", route: "honest_response", source: "revenue_guard", code: "revenue_basis_unsupported", reason: REVENUE_BASIS_REFUSAL, usage };
    }

    // ---- dates (P-SF): the planner is never given a date, so a literal year in its plan that the user did not
    // write would be invented. Custom ranges and specific FYs must use years stated in the question.
    if (!datesStated(parsed.plan, text, previous && previous.plan)) {
      return { status: "needs_clarification", route: "honest_response", source: "date_guard", code: "year_missing", reason: "Which year do you mean?", usage };
    }

    // ---- entity names: re-resolved against the tenant's own data
    let plan = JSON.parse(JSON.stringify(parsed.plan));
    if (typeof resolveEntity === "function" && Array.isArray(plan.filters)) {
      for (const f of plan.filters) {
        if (!NAME_DIMENSIONS.has(f.dim) || (f.op !== "eq_ci" && f.op !== "in_ci")) continue;
        const values = Array.isArray(f.value) ? f.value : [f.value];
        const canonical = [];
        for (const v of values) {
          let matches = [];
          try {
            matches = ((await resolveEntity({ entity: plan.entity, hintDim: f.dim, text: v })) || {}).matches || [];
          } catch (e) {
            return failed("planner_entity_check_failed", "Names in the plan could not be verified.", usage);
          }
          if (matches.length !== 1) {
            // nothing matched: offer the closest stored names, so a typo or a different spelling is one tap away
            let suggestions = [];
            if (!matches.length && typeof resolveEntity.suggest === "function") {
              try {
                suggestions = ((await resolveEntity.suggest({ entity: plan.entity, hintDim: f.dim, text: v })) || []).map((x) => cleanText(x.value, 80)).filter(Boolean);
              } catch (e) {
                suggestions = [];
              }
            }
            return failed("planner_entity_not_resolved", `"${cleanText(v, 60)}" did not match a known ${f.dim}.`, usage, suggestions.length ? { suggestions } : {});
          }
          canonical.push(matches[0].value);
        }
        f.value = Array.isArray(f.value) ? canonical : canonical[0];
      }
      const again = validateQueryPlan(plan, { referenceDate: referenceDate || VALIDATION_FALLBACK_REF });
      const reparsed = parseQueryPlan(plan);
      if (!again.ok || !reparsed.ok) return failed("planner_invalid_plan", "The plan was not valid after name verification.", usage);
      validation = again;
      plan = JSON.parse(JSON.stringify(reparsed.plan));
    }

    if (isNewPartyPlan(plan)) {
      return { status: "unsupported", route: "honest_response", source: "new_party_guard", code: "unsupported_new_party", reason: NEW_PARTY_REASON, usage };
    }
    const definitionNotes = revenue ? [REVENUE_ASSUMPTION] : [];
    if (defaultSortNote) definitionNotes.push(defaultSortNote);
    if (productValueNote) definitionNotes.push(productValueNote);
    const ruled = applyPlanRules(text, plan, { referenceDate, previousPlan: previous && previous.plan, validation });
    if (ruled.error) return failed("planner_invalid_plan", ruled.error, usage);
    plan = ruled.plan;
    validation = ruled.validation;
    definitionNotes.push(...ruled.notes);

    const plannerAssumptions = (Array.isArray(input.assumptions) ? input.assumptions : []).slice(0, 3).map((a) => cleanText(a, 160)).filter(Boolean);
    return {
      status: "supported",
      route: "query_engine",
      source: "claude_planner",
      plan,
      plannerAssumptions,
      definitionNotes,
      assumptions: validation.assumptions,
      warnings: validation.warnings,
      usage,
    };
  }
  return failed("planner_invalid_plan", "The planner produced a plan the query engine cannot run.", usage, { errors: (lastFailure || []).slice(0, 5) });
}

// ---------------------------------------------------------------- real Anthropic client (not used by tests)

/**
 * Production planner client: same request shape the fake client receives. Lazily reads the key.
 * Bounded: explicit maxRetries (never the SDK default), a per-attempt timeout, and an overall deadline
 * that aborts the in-flight request and rejects with code PLANNER_DEADLINE_EXCEEDED.
 * `sdkOptions` exists only so tests can point a real SDK client at a local stub (never api.anthropic.com).
 */
function createAnthropicPlannerClient({ attemptTimeoutMs = PLANNER_ATTEMPT_TIMEOUT_MS, maxRetries = PLANNER_MAX_RETRIES, deadlineMs = PLANNER_DEADLINE_MS, sdkOptions = {} } = {}) {
  let client = null;
  return async function anthropicPlannerClient(request, { signal } = {}) {
    if (!client) {
      const Anthropic = require("@anthropic-ai/sdk");
      const apiKey = sdkOptions.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        const err = new Error("AI planner is not configured: ANTHROPIC_API_KEY is missing on the backend.");
        err.code = "AI_NOT_CONFIGURED";
        throw err;
      }
      client = new Anthropic({ ...sdkOptions, apiKey, maxRetries, timeout: attemptTimeoutMs });
    }
    const controller = new AbortController();
    // The caller's signal (client disconnected) aborts the same in-flight request as the deadline does.
    const onClientAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) onClientAbort();
      else signal.addEventListener("abort", onClientAbort, { once: true });
    }
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Planner deadline of ${deadlineMs}ms exceeded.`);
        err.code = "PLANNER_DEADLINE_EXCEEDED";
        controller.abort(err);
        reject(err);
      }, deadlineMs);
    });
    try {
      return await Promise.race([
        client.messages.create(
          { model: process.env.ANTHROPIC_PLANNER_MODEL || process.env.ANTHROPIC_MODEL || DEFAULT_PLANNER_MODEL, temperature: 0, ...request },
          { timeout: attemptTimeoutMs, maxRetries, signal: controller.signal }
        ),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onClientAbort);
    }
  };
}

module.exports = {
  planQuestion,
  uncalculableTermRefusal,
  createAnthropicPlannerClient,
  getPlannerPrompt,
  buildCatalogDigest,
  PLANNER_TOOL_NAME,
  PLANNER_MAX_TOKENS,
  PLANNER_MAX_QUESTION_CHARS,
  PLANNER_ATTEMPT_TIMEOUT_MS,
  PLANNER_MAX_RETRIES,
  PLANNER_DEADLINE_MS,
  DECLINE_CODES,
  REVENUE_ASSUMPTION,
  PRODUCT_UNIT_WORDS,
  checkPlannedQuery,
  applyPlanRules,
  mentionsRevenue,
  // The same accounting-profit words the profit refusal uses (profit, COGS, gross/net margin), on the normalised question.
  mentionsAccountingProfit: (question) => PROFIT_TERMS.test(normalizeTerms(question)),
};
