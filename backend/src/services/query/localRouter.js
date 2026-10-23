"use strict";

// --------------------------------------------------
// Sales/Purchase LOCAL QUERY ROUTER (Phase 1D) - deterministic, no LLM.
//
//   question -> normalize -> route
//        supported     -> a Query DSL plan (never MongoDB, never tenant fields)
//        unsupported   -> structured refusal mapped to a catalog capability
//        needs_planner -> structured reason (ambiguous / too complex)
//
// How it decides: it is a small consume-and-check grammar, NOT a set of
// per-question patterns. Each recognizer (period, comparison, ranking,
// metric, date series, entity words, dimensions) REMOVES the words it
// understands and records a slot. When every word has been either
// understood or is a fixed stop word, the slots become a plan. If anything is
// left over, or two readings are possible, the router REFUSES TO GUESS and
// returns needs_planner. The single free-text element - a customer /
// supplier / product / group name - is only accepted when quoted or when an
// injected, tenant-scoped resolver confirms it exists.
//
// Every plan it produces is also passed through the same strict schema +
// semantic validator the Query Engine uses, so the router can never emit
// something the engine would refuse for structural reasons.
//
// Security: no tenant/company/database concept exists in this file. Input
// containing operator characters, tenant/company/database terms or
// prompt-injection phrasing is refused outright (never forwarded).
// --------------------------------------------------

const catalog = require("./semanticCatalog");
const { parseQueryPlan } = require("./queryPlan.schema");
const { validateQueryPlan } = require("./validator");

const { CATALOG, LIMITS } = catalog;

const MAX_QUESTION_CHARS = 300;
// Only used to run the semantic validator when the caller gave no reference
// date; it never affects the produced plan (relative periods stay symbolic).
const VALIDATION_FALLBACK_REF = new Date(2025, 0, 15, 12, 0, 0);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthNum = (name) => MONTHS[name.slice(0, 3)];
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, fifty: 50, hundred: 100 };
const pad2 = (n) => String(n).padStart(2, "0");

// ---------------------------------------------------------------- normalization

/** Lower-case, punctuation-free, single-spaced form. Also used to compare entity names. */
function normalizeText(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9%\-\s]/g, " ")
    .replace(/(^|\s)-+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDates(t) {
  t = t.replace(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\s+(\\d{4})\\b`, "g"), (m, d, mon, y) => ` ${y}-${pad2(monthNum(mon))}-${pad2(d)} `);
  t = t.replace(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(\\d{4})\\b`, "g"), (m, mon, d, y) => ` ${y}-${pad2(monthNum(mon))}-${pad2(d)} `);
  return t;
}

// ---------------------------------------------------------------- safety gate

const UNSAFE_INPUT = [
  /[${}`\\<>;|[\]]/, // Mongo operators, JSON, JS/shell/HTML/pipeline characters
  /[\u0000-\u001f\u007f]/,
  /\b(?:tenant\s*id|tenantid|tenant|company\s*guid|companyguid|company\s*id|companyid|guid|objectid|mongo\w*|mongoose|db\s*\.\s*\w+)\b/i,
  /__proto__|\bconstructor\b|\bprototype\b/i,
  /\b(?:ignore|disregard|forget)\b.{0,30}\b(?:previous|prior|above|earlier|all)\b.{0,30}\b(?:instructions?|rules?|prompts?)\b/i,
  /\b(?:system\s+prompt|jailbreak|you\s+are\s+now|act\s+as|developer\s+mode)\b/i,
  /\b(?:drop|delete|truncate|update|insert)\s+(?:table|collection|database|from)\b/i,
];

// ---------------------------------------------------------------- vocabulary

const STOP = new Set(
  ("a an the my our me i we us you your show give tell what whats which who whom whose how when where is are was were be been am do does did done can could would will shall please list get display report see view find of for in on at to from by with without and or vs versus per each every all any some this that these those has have had it its there their them then also just only about into over under between during within total summary numbers number data figures figure so far till now current currently me").split(" ")
);

const UNSUPPORTED_RULES = [
  ["tax_breakdown", /\b(?:gst|cgst|sgst|igst|utgst|vat|itc|tds|tcs|hsn|tax|taxes|taxable|taxed|pre-tax|pretax|post-tax|ex-tax)\b/],
  ["net_of_returns", /\b(?:credit notes?|debit notes?|creditnotes?|debitnotes?|returns?|returned|refunds?|net sales|net purchases)\b/],
  ["profit_margin", /\b(?:profit|profits|profitable|profitability|margins?|cogs|cost of goods|pnl|p and l|loss|losses|markup|mark-up|balance sheet|income statement)\b/],
  ["discount_analysis", /\b(?:discounts?|discounted|rebates?|schemes?)\b/],
  ["cancelled_invoices", /\b(?:cancell?ed|cancell?ations?|deleted|voided|void)\b/],
  ["sales_by_region_or_salesperson", /\b(?:regions?|states?|cit(?:y|ies)|areas?|territor(?:y|ies)|salespersons?|salesmen|salesman|sales reps?|sales executives?|executives?|zones?|branch(?:es)?|customer groups?|customer categor(?:y|ies)|gstin|pincode|district|locations?)\b/],
  ["outstanding_or_payments", /\b(?:outstanding|receivables?|payables?|receipts?|payments?|paid|unpaid|overdue|dues?|collections?|collected|ageing|aging|balances?|ledgers?|bank|cash|journals?|contra|debtors?|creditors?)\b/],
  ["other_accounting_domains", /\b(?:orders?|deliver(?:y|ies)|dispatch(?:es)?|stock valuation|closing stock|opening stock|inventory valuation|stock on hand|stock in hand|payroll|salary|salaries|wages|e ?way|fixed assets?|depreciation|budgets?|expenses?|expenditure|income|assets?|liabilit(?:y|ies)|equity|capital)\b/],
];

const COMPLEX_RE = /\b(?:why|explain|explanation|reasons?|because|insights?|analy[sz]e|analysis|analytics?|recommend\w*|suggest\w*|should|contribut\w*|impact|drivers?|caus(?:e|es|ed)|correlat\w*|seasonal\w*|predict\w*|forecast\w*|anomal\w*|unusual|overview|performance|health|opportunit\w*|risks?|risky|trends? analysis)\b/;
const AMBIGUOUS_METRIC_RE = /\b(?:revenue|turnover|spend|spending|spent|cost|costs|business|earnings?|volume|worth)\b/;

const DIM_WORD = {
  customer: "customer", customers: "customer",
  supplier: "supplier", suppliers: "supplier", vendor: "supplier", vendors: "supplier",
  product: "product", products: "product", item: "product", items: "product", sku: "product", skus: "product",
  productgroup: "productGroup", vouchertype: "voucherType",
};
const TRIGGER_HINT = { to: "customer", from: "supplier", customer: "customer", customers: "customer", supplier: "supplier", suppliers: "supplier", vendor: "supplier", vendors: "supplier", product: "product", products: "product", item: "product", items: "product", productgroup: "productGroup" };
const TRIGGERS = new Set(["to", "from", "for", "of", "named", "called", ...Object.keys(DIM_WORD)]);

const METRIC_DEFAULTS = {
  sales: { amount: "invoiceAmount", count: "invoiceCount", avg: "averageInvoiceValue" },
  purchase: { amount: "purchaseAmount", count: "purchaseInvoiceCount", avg: "averagePurchaseValue" },
};

// ---------------------------------------------------------------- consume machinery

function makeState(text) {
  return { s: ` ${text} `, items: [] };
}

// Replace every match with a marker carrying a payload; markers keep their
// position, so appearance order is recoverable from the final string.
function take(st, re, payload) {
  let hits = 0;
  st.s = st.s.replace(re, (...args) => {
    const groups = args.slice(1, -2);
    const id = st.items.length;
    st.items.push(payload(groups, args[0]));
    hits += 1;
    return ` ¦m${id}¦ `;
  });
  return hits;
}

function markersInOrder(st) {
  const out = [];
  for (const m of st.s.matchAll(/¦m(\d+)¦/g)) out.push(st.items[Number(m[1])]);
  return out;
}
const ofType = (items, type) => items.filter((x) => x.type === type);

// ---------------------------------------------------------------- results

function unsupported(code, capabilityId, reason, extra = {}) {
  return { status: "unsupported", route: "honest_response", code, capability: capabilityId || null, reason, ...extra };
}
function needsPlanner(code, detail, extra = {}) {
  return { status: "needs_planner", route: "claude_planner", code, reason: detail, ...extra };
}

// ---------------------------------------------------------------- period helpers

const monthRange = (year, month) => ({ kind: "custom", from: `${year}-${pad2(month)}-01`, to: `${year}-${pad2(month)}-${pad2(new Date(Date.UTC(year, month, 0)).getUTCDate())}` });

function fyFrom(a, b) {
  const start = a.length === 2 ? 2000 + Number(a) : Number(a);
  const endYY = String(Number(b.length === 4 ? b.slice(2) : b)).padStart(2, "0");
  if (String((start + 1) % 100).padStart(2, "0") !== endYY) return null;
  return `${start}-${endYY}`;
}

const fyRange = (fy) => {
  const start = Number(fy.slice(0, 4));
  return { kind: "custom", from: `${start}-04-01`, to: `${start + 1}-03-31` };
};

const RELATIVE_UNIT = {
  current_month: ["month", "current"], previous_month: ["month", "previous"],
  current_quarter: ["quarter", "current"], previous_quarter: ["quarter", "previous"],
  current_week: ["week", "current"], previous_week: ["week", "previous"],
  current_fy: ["fy", "current"], previous_fy: ["fy", "previous"],
};

// ---------------------------------------------------------------- the router

/**
 * @param {string} question
 * @param {object} [context]
 * @param {Function} [context.resolveEntity] async ({entity, hintDim, text}) => {matches:[{dim,value}]}
 *        tenant-scoped, supplied by the server; the router never sees a tenant.
 * @param {Date} [context.referenceDate] only used to run the semantic validator
 */
async function routeQuestion(question, context = {}) {
  // ---- 0. input gate
  if (typeof question !== "string") return unsupported("invalid_input", null, "The question must be text.");
  if (question.length > MAX_QUESTION_CHARS) return needsPlanner("question_too_long", `Questions over ${MAX_QUESTION_CHARS} characters are not handled by the local router.`);
  for (const re of UNSAFE_INPUT) {
    if (re.test(question)) return unsupported("unsafe_input", null, "The question contains characters or terms that cannot be processed.");
  }
  if (!question.trim()) return unsupported("empty_question", null, "The question is empty.");

  // ---- 1. quoted names out first (their content is opaque, never parsed)
  const quoted = [];
  const withoutQuotes = question.replace(/["“”]([^"“”]{1,200})["“”]/g, (m, inner) => {
    quoted.push(inner.replace(/\s+/g, " ").trim());
    return ` xqx${quoted.length - 1}xqx `;
  });

  let text = normalizeText(withoutQuotes);
  text = text.replace(/\b(?:average|avg) order (?:value|amount|size)\b/g, "average invoice value");
  text = normalizeDates(text).replace(/\s+/g, " ").trim();
  const normalized = text;
  if (!text) return unsupported("empty_question", null, "The question is empty.");

  // ---- 2. honest refusals BEFORE any interpretation
  for (const [id, re] of UNSUPPORTED_RULES) {
    if (re.test(text)) {
      const cap = CATALOG.unsupported.find((u) => u.id === id);
      return unsupported("unsupported_capability", id, cap ? cap.reason : "Not supported in this phase.", { normalized });
    }
  }
  const salesWord = /\b(?:sales?|sold|sell|sells|selling)\b/.test(text);
  const purchaseNoun = /\b(?:purchases?|procurement)\b/.test(text);
  const purchaseVerb = /\b(?:purchased|purchasing|bought|buy|buys|buying)\b/.test(text);
  if (salesWord && purchaseNoun) {
    const cap = CATALOG.unsupported.find((u) => u.id === "cross_entity_comparison");
    return unsupported("unsupported_capability", "cross_entity_comparison", cap.reason, { normalized });
  }

  // ---- 3. reasoning / ambiguity gates
  if (COMPLEX_RE.test(text)) return needsPlanner("requires_reasoning", "The question asks for analysis or explanation rather than a direct figure.", { normalized });
  if (AMBIGUOUS_METRIC_RE.test(text)) return needsPlanner("ambiguous_metric", "The measure is ambiguous (e.g. revenue/turnover/spend/cost could mean different amounts).", { normalized });

  // ---- 4. collapse multi-word dimension nouns
  text = text
    .replace(/\b(?:product|stock|item) groups?\b|\bcategor(?:y|ies)\b|\bgroups?\b/g, " productgroup ")
    .replace(/\bvoucher types?\b/g, " vouchertype ")
    .replace(/\s+/g, " ")
    .trim();

  const st = makeState(text);

  // ---- 5. comparison connectors that contain period words (must precede periods)
  take(st, /\b(?:(?:vs|versus|compared (?:with|to)|against|than)\s+(?:the\s+)?)?(?:same (?:period|time|month|quarter|week) )?(?:last|previous|prior) year\b/g, (g, m) =>
    /\b(?:vs|versus|compared|against|than|same)\b/.test(m) ? { type: "sply" } : { type: "period", period: { type: "ambiguous" } }
  );
  take(st, /\b(?:yoy|y-o-y|y o y|year[\s-](?:over|on)[\s-]year)\b/g, () => ({ type: "sply" }));
  // period-over-period comparison words and "the month before": grammar, never entity names
  take(st, /\b(?:mom|m-o-m|month[\s-](?:over|on)[\s-]month)\b/g, () => ({ type: "pop", unit: "month" }));
  take(st, /\b(?:qoq|q-o-q|quarter[\s-](?:over|on)[\s-]quarter)\b/g, () => ({ type: "pop", unit: "quarter" }));
  take(st, /\bweek[\s-](?:over|on)[\s-]week\b/g, () => ({ type: "pop", unit: "week" }));
  take(st, /\b(?:the\s+)?(month|quarter|week) before(?:\s+(?:that|it|last))?\b/g, (g) => ({ type: "priorOf", unit: g[0] }));
  take(st, /\b(?:(?:vs|versus|compared (?:with|to)|against|than)\s+)?(?:the\s+)?(?:previous|prior|preceding) period\b/g, () => ({ type: "prevPeriod" }));

  // ---- 6. date series words (before periods)
  take(st, /\b(?:monthly|month wise|month by month|by month|per month|each month|every month|trend|over time)\b/g, () => ({ type: "bucket", bucket: "month" }));
  take(st, /\b(?:weekly|week wise|by week|per week|each week|every week)\b/g, () => ({ type: "bucket", bucket: "week" }));
  take(st, /\b(?:daily|day wise|by day|per day|each day|every day)\b/g, () => ({ type: "bucket", bucket: "day" }));
  take(st, /\b(?:quarterly|quarter wise|by quarter|per quarter|each quarter|every quarter)\b/g, () => ({ type: "bucket", bucket: "quarter" }));
  take(st, /\b(?:fy wise|financial year wise|fiscal year wise|by fy|by financial year|per financial year|per fy)\b/g, () => ({ type: "bucket", bucket: "fy" }));

  // ---- 7. periods
  const P = (period) => ({ type: "period", period });
  const D = "(\\d{4}-\\d{2}-\\d{2})";
  take(st, new RegExp(`(?:\\b(?:between|from)\\s+)?\\b${D}\\s+(?:and|to|until|till|through)\\s+${D}\\b`, "g"), (g) => P({ kind: "custom", from: g[0], to: g[1] }));
  take(st, new RegExp(`(?:\\b(?:on|for|dated|of)\\s+)?\\b${D}\\b`, "g"), (g) => P({ kind: "custom", from: g[0], to: g[0] }));
  take(st, /\b(?:fy|f y|financial year|fiscal year)\s*(\d{2,4})\s*-\s*(\d{2,4})\b/g, (g) => {
    const fy = fyFrom(g[0], g[1]);
    return fy ? P({ kind: "specific_fy", fy }) : P({ type: "invalid", reason: "invalid_fy" });
  });
  take(st, /\b(20\d{2})-(\d{2}|\d{4})\b(?!-)/g, (g) => {
    const fy = fyFrom(g[0], g[1]);
    return fy ? P({ kind: "specific_fy", fy }) : P({ type: "invalid", reason: "invalid_fy" });
  });
  take(st, new RegExp(`\\b(?:month of\\s+)?${MONTH_RE}\\s+(?:of\\s+)?(20\\d{2})\\b`, "g"), (g) => P(monthRange(Number(g[1]), monthNum(g[0]))));
  take(st, /\b(?:this|current) (?:financial|fiscal) year\b|\b(?:this|current) fy\b|\bfy to date\b|\bfytd\b|\bfinancial year to date\b/g, () => P({ kind: "current_fy" }));
  take(st, /\b(?:last|previous|prior) (?:financial|fiscal) year\b|\b(?:last|previous|prior) fy\b/g, () => P({ kind: "previous_fy" }));
  take(st, /\b(?:this|current) quarters?\b|\bquarter to date\b|\bqtd\b/g, () => P({ kind: "current_quarter" }));
  take(st, /\b(?:last|previous|prior) quarters?\b/g, () => P({ kind: "previous_quarter" }));
  take(st, /\b(?:this|current) months?\b|\bmonth to date\b|\bmtd\b/g, () => P({ kind: "current_month" }));
  take(st, /\b(?:last|previous|prior) months?\b/g, () => P({ kind: "previous_month" }));
  take(st, /\b(?:this|current) weeks?\b|\bweek to date\b|\bwtd\b/g, () => P({ kind: "current_week" }));
  take(st, /\b(?:last|previous|prior) weeks?\b/g, () => P({ kind: "previous_week" }));
  take(st, /\btodays?\b/g, () => P({ kind: "today" }));
  take(st, /\byesterdays?\b/g, () => P({ kind: "yesterday" }));
  take(st, /\b(?:last|past|previous)\s+(\d+)\s+days?\b/g, (g) => ([7, 30, 90].includes(Number(g[0])) ? P({ kind: `last_${g[0]}_days` }) : P({ type: "invalid", reason: "unsupported_window" })));
  take(st, /\b(?:year to date|ytd|(?:this|current|last|previous|prior|past) (?:calendar )?year|calendar year|annual|annually|yearly|by year|per year|year wise|year by year|(?:in|for|during|of) 20\d{2})\b/g, () => P({ type: "ambiguous" }));
  take(st, /\b(?:in|for|during|of|from|to)\s+may\b/g, () => P({ type: "invalid", reason: "year_missing" }));
  take(st, /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g, () => P({ type: "invalid", reason: "year_missing" }));

  // ---- 8. comparison connectors, growth and change intents
  const pct = [];
  take(st, /\b(?:full|complete|entire|whole)\b/g, () => ({ type: "full" }));
  take(st, /\b(?:by\s+)?(?:more than|over|above|greater than|at least)\s+(\d+(?:\.\d+)?)\s*%/g, (g) => (pct.push(Number(g[0])), { type: "pct" }));
  take(st, /\b(?:by\s+)?(?:less than|under|below|up to|upto)\s+\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*%/g, () => ({ type: "invalid", reason: "unsupported_threshold" }));
  take(st, /\b(?:vs|versus|compared (?:with|to)|compared|compare|comparison|against|than)\b/g, () => ({ type: "connector" }));
  take(st, /\b(?:stopped|stop|no longer|not (?:bought|buying|purchased|purchasing)|did not (?:buy|purchase)|didnt (?:buy|purchase)|havent (?:bought|purchased)|have not (?:bought|purchased)|lost|churned|inactive|dormant)\b/g, () => ({ type: "intent", intent: "stopped" }));
  take(st, /\bnew(?=\s+(?:customers?|suppliers?|vendors?|products?|items?)\b)/g, () => ({ type: "intent", intent: "new" }));
  take(st, /\b(?:declin\w*|decreas\w*|drop\w*|fell|fall\w*|down|lower|less|reduc\w*|shrunk|shrank)\b/g, () => ({ type: "intent", intent: "down" }));
  take(st, /\b(?:grew|grow\w*|increas\w*|gain\w*|rose|rise\w*|improv\w*|up|more|higher|bigger|expand\w*|jump\w*)\b/g, () => ({ type: "intent", intent: "up" }));
  take(st, /\bgrowth\b/g, () => ({ type: "intent", intent: "growth" }));

  // ---- 9. ranking, limits, sort hints
  take(st, /\bby\s+(quantity|qty|units|amount|value|count|number of invoices)\b/g, (g) => ({ type: "sortHint", hint: g[0] }));
  let topN = null;
  let rankDir = null;
  take(st, /\b(top|bottom|largest|biggest|highest|smallest|lowest)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|fifty|hundred)\b/g, (g) => {
    topN = /^\d+$/.test(g[1]) ? Number(g[1]) : NUM_WORDS[g[1]];
    rankDir = ["top", "largest", "biggest", "highest"].includes(g[0]) ? "desc" : "asc";
    return { type: "rank" };
  });
  const recency = { dir: null };
  take(st, /\b(?:(?:latest|recent|newest|most recent|last)\s+(\d+)|(\d+)\s+(?:latest|recent|newest|most recent|largest|biggest|smallest))(?=\s+(?:sales |purchase )?(?:invoices?|bills?|vouchers?)\b)/g, (g, m) => {
    topN = Number(g[0] || g[1]);
    if (/largest|biggest/.test(m)) rankDir = "desc";
    else if (/smallest/.test(m)) rankDir = "asc";
    else recency.dir = "desc";
    return { type: "recency" };
  });
  take(st, /\b(?:latest|recent|newest|most recent)\b/g, () => ((recency.dir = "desc"), { type: "recency" }));
  take(st, /\b(?:oldest|earliest)\b/g, () => ((recency.dir = "asc"), { type: "recency" }));
  take(st, /\b(?:top|biggest|largest|highest|best|leading|greatest|most|maximum|max)\b/g, () => ((rankDir = rankDir || "desc"), { type: "rank" }));
  take(st, /\b(?:bottom|smallest|lowest|worst|least|minimum|min|fewest)\b/g, () => ((rankDir = rankDir || "asc"), { type: "rank" }));

  // ---- 10. metrics and entity words
  take(st, /\bwhat (?:did|do|have) (?:i|we) (?:sell|sold|buy|bought|purchase|purchased)\b/g, (g, m) => ({ type: "whatDid", entity: /sell|sold/.test(m) ? "sales" : "purchase" }));
  take(st, /\b(?:average|avg)\s+(?:(sales?|purchases?)\s+)?(?:(?:invoices?|bills?|orders?|vouchers?)(?:\s+(?:value|amount|size))?|(?:value|amount|size))\b/g, (g) => ({ type: "metric", metric: "avg", entity: g[0] ? (/^purchase/.test(g[0]) ? "purchase" : "sales") : null }));
  take(st, /\b(?:how many|number of|count of|total number of)\s+(?:invoices?|bills?|sales|purchases?|vouchers?)\b|\b(?:invoice|bill|voucher) count\b/g, (g, m) => ({ type: "metric", metric: "count", entity: /purchase/.test(m) ? "purchase" : /sales/.test(m) ? "sales" : null }));
  take(st, /\bline (?:item )?amounts?\b/g, () => ({ type: "metric", metric: "line" }));
  take(st, /\b(?:quantity|quantities|qty|units|pieces|pcs)\b/g, () => ({ type: "metric", metric: "qty" }));
  take(st, /\b(?:invoices?|bills?|vouchers?)\b/g, () => ({ type: "invoiceNoun" }));
  take(st, /\b(?:sales?|sold|sell|sells|selling)\b/g, (g, m) => ({ type: "entity", entity: "sales", noun: /^sales?$/.test(m) }));
  take(st, /\b(?:purchases?|procurement)\b/g, () => ({ type: "entity", entity: "purchase", noun: true }));
  take(st, /\b(?:purchased|purchasing|bought|buy|buys|buying)\b/g, () => ({ type: "entity", entity: "purchase", noun: false }));
  take(st, /\b(?:how much|amount|value)\b/g, () => ({ type: "metric", metric: "amount" }));

  // ---- 11. read the markers
  const items = markersInOrder(st);
  let periods = ofType(items, "period").map((x) => x.period);
  const bad = periods.find((p) => p.type === "invalid");
  if (bad) return needsPlanner(bad.reason, `Period could not be resolved safely (${bad.reason}).`, { normalized });
  if (periods.some((p) => p.type === "ambiguous")) {
    return needsPlanner("ambiguous_period", "The period is ambiguous (e.g. 'this year' / 'YTD' could be the calendar year or the financial year).", { normalized });
  }
  if (items.some((x) => x.type === "invalid")) {
    const inv = items.find((x) => x.type === "invalid");
    return needsPlanner(inv.reason, "A numeric condition in the question cannot be mapped safely.", { normalized });
  }

  // ---- 11a. a lone previous period right after a comparison word ("declined vs last month",
  // "less than last month") is the comparison TARGET: the subject is the current period of that unit.
  if (periods.length === 1 && RELATIVE_UNIT[periods[0].kind] && RELATIVE_UNIT[periods[0].kind][1] === "previous") {
    const at = items.findIndex((x) => x.type === "period");
    if (at > 0 && items[at - 1].type === "connector") periods = [{ kind: periods[0].kind.replace("previous_", "current_") }, periods[0]];
  }

  // ---- 11b. the DSL holds ONE comparison. A question asking for more than one is never answered with just one.
  const pop = ofType(items, "pop");
  const prior = ofType(items, "priorOf");
  {
    const popUnits = new Set(pop.map((x) => x.unit));
    const priorUnits = new Set(prior.map((x) => x.unit));
    const pair = periods.length === 2 ? periods.map((p) => RELATIVE_UNIT[p.kind]) : null;
    const alignedPair = !!(pair && pair[0] && pair[1] && pair[0][0] === pair[1][0] && pair[0][1] === "current" && pair[1][1] === "previous");
    let targets = 0;
    if (ofType(items, "sply").length) targets += 1;
    if (periods.length === 2) targets += 1;
    if (prior.length) targets += 1;
    const prevLike = ofType(items, "prevPeriod").length > 0 || pop.length > 0;
    if (prevLike && !(alignedPair && (!pop.length || [...popUnits][0] === pair[0][0]))) targets += 1;
    if (popUnits.size > 1 || priorUnits.size > 1 || targets > 1) {
      return unsupported(
        "unsupported_combination",
        null,
        "This question asks for more than one comparison, but I can compare one period at a time. Please ask for one comparison, for example against the previous period or against the same period last year.",
        { normalized, clarification: "multiple_comparisons" }
      );
    }
  }

  // ---- 12. leftover words: dimensions, names, or unrecognised text
  const tokens = st.s.split(/\s+/).filter(Boolean);
  const runs = [];
  let cur = [];
  for (const tk of tokens) {
    if (/^¦m\d+¦$/.test(tk)) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push(tk);
  }
  if (cur.length) runs.push(cur);

  const dims = [];
  let nameRun = null;
  let nameHint = null;
  let unrecognised = false;

  for (const run of runs) {
    let a = 0;
    let b = run.length;
    while (a < b && STOP.has(run[a]) && !TRIGGERS.has(run[a])) a += 1;
    while (b > a && STOP.has(run[b - 1]) && !TRIGGERS.has(run[b - 1])) b -= 1;
    let core = run.slice(a, b);
    if (!core.length) continue;

    // leading trigger words give the name a dimension hint
    let hint = null;
    while (core.length && (TRIGGERS.has(core[0]) || STOP.has(core[0]))) {
      if (TRIGGER_HINT[core[0]] && !hint) hint = TRIGGER_HINT[core[0]];
      core = core.slice(1);
    }
    if (!core.length) {
      // a run of only trigger/stop words: dimension mentions such as "customers"
      for (const w of run) if (DIM_WORD[w]) dims.push(DIM_WORD[w]);
      continue;
    }
    // trailing dimension noun(s) e.g. "top customers who" -> handled as words in the run
    const words = core.filter((w) => !DIM_WORD[w] || /^xqx\d+xqx$/.test(w));
    const dimOnly = core.every((w) => DIM_WORD[w] || STOP.has(w));
    if (dimOnly) {
      for (const w of core) if (DIM_WORD[w]) dims.push(DIM_WORD[w]);
      continue;
    }
    if (nameRun) {
      unrecognised = true;
      continue;
    }
    // dimension nouns embedded before the name give the hint: "customer dhingra general store"
    const lead = [];
    while (core.length && DIM_WORD[core[0]]) lead.push(core.shift());
    if (lead.length) hint = DIM_WORD[lead[lead.length - 1]];
    nameRun = core;
    nameHint = hint;
    void words;
  }
  if (unrecognised) return needsPlanner("unrecognized_words", "The question contains words the router cannot map safely.", { normalized });

  // ---- 13. resolve the (single) name
  let filter = null;
  let nameEntityHint = null;
  if (nameRun) {
    const surface = nameRun.join(" ");
    const q = /^xqx(\d+)xqx$/.exec(nameRun.length === 1 ? nameRun[0] : "");
    const rawText = q ? quoted[Number(q[1])] : null;
    if (!rawText && nameRun.some((w) => /xqx\d+xqx/.test(w))) return needsPlanner("unrecognized_words", "A quoted name is mixed with other words.", { normalized });

    const entityWords = ofType(items, "entity").map((x) => x.entity);
    const impliedEntity = entityWords.length ? entityWords[0] : null;
    if (typeof context.resolveEntity === "function") {
      const resolved = await context.resolveEntity({ entity: impliedEntity, hintDim: nameHint, text: rawText || surface });
      const matches = (resolved && resolved.matches) || [];
      if (matches.length === 0) return needsPlanner("entity_not_resolved", `"${rawText || surface}" did not match a known customer, supplier, product or group.`, { normalized });
      if (matches.length > 1) return needsPlanner("entity_ambiguous", `"${rawText || surface}" matches more than one kind of entity.`, { normalized });
      filter = { dim: matches[0].dim, value: matches[0].value };
    } else if (rawText && nameHint) {
      filter = { dim: nameHint, value: rawText };
    } else {
      return needsPlanner(rawText ? "entity_kind_unknown" : "entity_requires_resolution", "A name was given but its kind (customer/supplier/product/group) could not be confirmed without the entity resolver.", { normalized });
    }
    nameEntityHint = filter.dim === "customer" ? "sales" : filter.dim === "supplier" ? "purchase" : null;
  }

  // ---- 14. entity (sales vs purchase)
  const dimEntity = new Set();
  for (const d of dims.concat(filter ? [filter.dim] : [])) {
    if (d === "customer") dimEntity.add("sales");
    if (d === "supplier") dimEntity.add("purchase");
  }
  const entityItems = ofType(items, "entity");
  const nounEntities = new Set(entityItems.filter((x) => x.noun || x.entity === "sales").map((x) => x.entity));
  const whatDid = ofType(items, "whatDid")[0];
  const countEntity = ofType(items, "metric").map((x) => x.entity).filter(Boolean);
  const signals = new Set([...nounEntities, ...dimEntity, ...(whatDid ? [whatDid.entity] : []), ...countEntity]);
  // purchase VERBS ("purchased", "bought") are neutral when a customer/supplier is named
  const verbOnly = entityItems.filter((x) => !x.noun && x.entity === "purchase");
  if (signals.size === 0 && verbOnly.length && dimEntity.size === 0) signals.add("purchase");
  if (nameEntityHint) signals.add(nameEntityHint);
  if (signals.size > 1) return needsPlanner("entity_conflict", "The question mixes sales and purchase concepts.", { normalized });
  if (signals.size === 0) return needsPlanner("entity_ambiguous", "The question does not say whether it is about sales or purchases.", { normalized });
  const entity = [...signals][0];
  void salesWord;
  void purchaseVerb;

  // ---- 15. dimension (at most one groupBy)
  const bucketItems = ofType(items, "bucket");
  const distinctDims = [...new Set(dims)];
  if (bucketItems.length > 1 || distinctDims.length > 1 || (bucketItems.length && distinctDims.length)) {
    return needsPlanner("multi_dimension", "The question groups by more than one dimension.", { normalized });
  }
  const catalogDim = distinctDims[0] || null;
  const bucket = bucketItems[0] ? bucketItems[0].bucket : null;
  if (catalogDim && !CATALOG.dimensions[catalogDim].entities.includes(entity)) {
    return needsPlanner("entity_conflict", `${catalogDim} does not exist for ${entity}.`, { normalized });
  }

  // ---- 16. metrics
  const metricWords = ofType(items, "metric");
  const want = { avg: false, count: false, qty: false, line: false, amount: false };
  for (const m of metricWords) want[m.metric] = true;
  const invoiceNoun = ofType(items, "invoiceNoun").length > 0;
  const sortHint = ofType(items, "sortHint")[0];
  const M = METRIC_DEFAULTS[entity];

  // ---- 17. list mode (individual invoices)
  const listMode = invoiceNoun && !want.avg && !want.count && !want.qty && !want.line;
  const assumptions = [];
  const plan = { v: 1, entity, mode: listMode ? "list" : "aggregate", period: null };

  // ---- 18. period + comparison
  const connectors = ofType(items, "connector").length > 0;
  const sply = ofType(items, "sply").length > 0;
  const prevPeriod = ofType(items, "prevPeriod").length > 0;
  const intents = ofType(items, "intent").map((x) => x.intent);
  const growthWords = intents.length > 0;
  const wantsCompare = connectors || sply || prevPeriod || growthWords;

  let period = null;
  let compare = null;
  if (periods.length > 2) return needsPlanner("too_many_periods", "More than two periods were mentioned.", { normalized });

  if (periods.length === 2) {
    if (!connectors) return needsPlanner("two_periods_without_comparison", "Two periods were mentioned without saying how to compare them.", { normalized });
    const [p0, p1] = periods;
    const u0 = RELATIVE_UNIT[p0.kind];
    const u1 = RELATIVE_UNIT[p1.kind];
    if (u0 && u1 && u0[0] === u1[0] && u0[1] === "current" && u1[1] === "previous") {
      period = p0;
      const fullWords = ofType(items, "full").length > 0;
      compare = { mode: fullWords ? "full_previous" : "like_for_like" };
      if (!fullWords) assumptions.push({ code: "comparison_like_for_like_default", message: "Compared with the same elapsed portion of the previous period (the product's standard comparison)." });
    } else if ((p0.kind === "custom" || p0.kind === "specific_fy") && (p1.kind === "custom" || p1.kind === "specific_fy")) {
      period = p0.kind === "specific_fy" ? p0 : p0;
      compare = { mode: "custom", period: p1.kind === "specific_fy" ? fyRange(p1.fy) : p1 };
    } else {
      return needsPlanner("comparison_periods_not_aligned", "The two periods cannot be compared with a supported comparison mode.", { normalized });
    }
  } else if (periods.length === 1 && (pop.length || prior.length)) {
    // "this month MoM", "last month vs the month before": compare with the period just before the subject
    period = periods[0];
    const unit = (pop[0] || prior[0]).unit;
    if (!RELATIVE_UNIT[period.kind] || RELATIVE_UNIT[period.kind][0] !== unit) {
      return needsPlanner("comparison_periods_not_aligned", "The comparison does not match the period asked about.", { normalized });
    }
    const fullWords = ofType(items, "full").length > 0;
    compare = { mode: fullWords ? "full_previous" : "like_for_like" };
    if (!fullWords && RELATIVE_UNIT[period.kind][1] === "current") assumptions.push({ code: "comparison_like_for_like_default", message: "Compared with the same elapsed portion of the previous period (the product's standard comparison)." });
  } else if (periods.length === 1) {
    period = periods[0];
    if (wantsCompare) {
      if (sply) compare = { mode: "same_period_last_year" };
      else if (connectors && !prevPeriod && !growthWords) return needsPlanner("comparison_target_missing", "A comparison was requested without saying what to compare against.", { normalized });
      else {
        compare = { mode: "like_for_like" };
        assumptions.push({ code: "comparison_like_for_like_default", message: "Compared with the same elapsed portion of the previous period (the product's standard comparison)." });
      }
    }
  } else if (prior.length) {
    return needsPlanner("comparison_periods_not_aligned", "The period asked about could not be expressed.", { normalized });
  } else if (sply || prevPeriod || growthWords || connectors || pop.length) {
    return needsPlanner("period_missing", "A comparison was requested without a period.", { normalized });
  }

  if (ofType(items, "full").length && !(compare && compare.mode === "full_previous")) {
    return needsPlanner("unrecognized_words", "'full/complete/entire' only applies to a comparison with a previous period.", { normalized });
  }

  // defaults for a missing period
  if (!period) {
    const rankingLike = rankDir !== null || topN !== null || catalogDim !== null || filter !== null || listMode || whatDid;
    const coarseSeries = bucket && ["month", "quarter", "fy"].includes(bucket);
    if (rankingLike || coarseSeries) {
      period = { kind: "all_time" };
      assumptions.push({ code: "period_defaulted_to_all_time", message: "No period was stated, so all available history is used." });
    } else return needsPlanner("period_missing", "A period is required for this kind of question.", { normalized });
  }
  plan.period = period;

  // ---- 19. grouping / filters
  let groupDim = catalogDim;
  if (whatDid && filter && !groupDim && !bucket) groupDim = "product";
  else if (whatDid && !filter) return needsPlanner("ambiguous_metric", "'What did I sell/buy' without a customer or supplier is ambiguous.", { normalized });

  const lineDim = groupDim === "product" || groupDim === "productGroup";
  const lineFilter = filter && (filter.dim === "product" || filter.dim === "productGroup");
  const lineGrain = lineDim || want.qty || want.line || (lineFilter && !want.count && !want.avg);

  if (listMode) {
    if (groupDim || bucket || intents.length || compare) return needsPlanner("list_conflict", "Listing invoices cannot be combined with grouping or comparison here.", { normalized });
    if (filter && filter.dim === "productGroup") { /* allowed: validator adds the whole-invoice caveat */ }
    plan.filters = filter ? [{ dim: filter.dim, op: "eq_ci", value: filter.value }] : [];
    const asc = rankDir === "asc";
    if (recency.dir) plan.sort = [{ by: "date", dir: recency.dir }];
    else if (rankDir) plan.sort = [{ by: M.amount, dir: asc ? "asc" : "desc" }];
    else plan.sort = [{ by: "date", dir: "desc" }];
    if (topN) plan.limit = topN;
    return finish(plan, { normalized, assumptions, context, extra: { intent: "list" } });
  }

  // metrics
  let metrics;
  if (lineGrain) {
    metrics = [];
    if (want.qty) metrics.push("quantity");
    if (want.line || want.amount || !want.qty || metrics.length) metrics.push("lineAmount");
    if (lineDim && groupDim === "product" && !want.qty && !metrics.includes("quantity")) metrics.push("quantity");
    metrics = [...new Set(metrics)];
    if (want.count || want.avg) return unsupported("unsupported_combination", null, "Invoice counts and averages cannot be broken down by product or group.", { normalized });
  } else {
    metrics = [];
    if (want.avg) metrics.push(M.avg);
    if (want.count) metrics.push(M.count);
    if (!metrics.length) metrics = [M.amount, M.count];
    else if (want.amount && !want.avg && !want.count) metrics = [M.amount, M.count];
  }
  plan.metrics = metrics;

  if (groupDim) plan.groupBy = [{ dim: groupDim }];
  else if (bucket) plan.groupBy = [{ dim: "date", bucket }];
  plan.filters = filter ? [{ dim: filter.dim, op: "eq_ci", value: filter.value }] : [];
  if (compare) plan.compare = compare;

  // sorting / limits / change intents
  const primary = (() => {
    if (sortHint) {
      const h = sortHint.hint;
      if (/quantity|qty|units/.test(h) && metrics.includes("quantity")) return "quantity";
      if (/count|number/.test(h)) return metrics.find((m) => /Count$/.test(m) && m !== "lineCount") || metrics[0];
      return metrics.find((m) => /Amount$/.test(m)) || metrics[0];
    }
    if (want.qty && !want.line && !want.amount && metrics.includes("quantity")) return "quantity";
    return metrics.find((m) => /Amount$/.test(m)) || metrics[0];
  })();
  if (sortHint && /quantity|qty|units/.test(sortHint.hint) && !metrics.includes("quantity") && lineGrain) plan.metrics = ["quantity", ...metrics];
  const primaryRef = plan.metrics.includes(primary) ? primary : plan.metrics[0];

  const wantsUp = intents.includes("up");
  const wantsDown = intents.includes("down");
  const stopped = intents.includes("stopped");
  const isNew = intents.includes("new");
  if ([wantsUp, wantsDown, stopped, isNew].filter(Boolean).length > 1) return needsPlanner("conflicting_intents", "The question asks for more than one kind of change.", { normalized });
  const changeIntent = wantsUp || wantsDown || stopped || isNew;

  if (changeIntent && !groupDim) {
    if (stopped || isNew) return needsPlanner("intent_needs_dimension", "That change question needs customers, suppliers or products to compare.", { normalized });
    if (pct.length) return needsPlanner("intent_needs_dimension", "A percentage threshold needs customers, suppliers or products to compare.", { normalized });
    // a bare "did sales go up/down" is just the comparison itself
  }
  if (changeIntent && groupDim) {
    if (!plan.compare) return needsPlanner("period_missing", "A change question needs a period to compare.", { normalized });
    plan.having = [];
    if (stopped) {
      plan.having = [{ metric: primaryRef, op: "eq", value: 0 }, { metric: `${primaryRef}.previous`, op: "gt", value: 0 }];
      plan.sort = [{ by: `${primaryRef}.previous`, dir: "desc" }];
    } else if (isNew) {
      plan.having = [{ metric: `${primaryRef}.previous`, op: "eq", value: 0 }, { metric: primaryRef, op: "gt", value: 0 }];
      plan.sort = [{ by: primaryRef, dir: "desc" }];
    } else if (pct.length) {
      plan.having = [{ metric: `${primaryRef}.deltaPct`, op: wantsDown ? "lt" : "gt", value: wantsDown ? -pct[0] : pct[0] }];
      plan.sort = [{ by: `${primaryRef}.deltaPct`, dir: wantsDown ? "asc" : "desc" }];
    } else {
      plan.having = [{ metric: `${primaryRef}.delta`, op: wantsDown ? "lt" : "gt", value: 0 }];
      plan.sort = [{ by: `${primaryRef}.delta`, dir: wantsDown ? "asc" : "desc" }];
    }
    if (rankDir === "asc" && wantsDown) plan.sort[0].dir = "asc";
  } else if (groupDim) {
    plan.sort = [{ by: primaryRef, dir: rankDir === "asc" ? "asc" : "desc" }];
  } else if (bucket) {
    if (rankDir !== null || topN !== null) return needsPlanner("ranking_over_time", "Ranking periods within a series needs the planner.", { normalized });
    if ((bucket === "day" || bucket === "week") && assumptions.some((a) => a.code === "period_defaulted_to_all_time")) {
      return needsPlanner("period_missing", "Daily/weekly series need an explicit period.", { normalized });
    }
  } else if (rankDir !== null || topN !== null) {
    return needsPlanner("ranking_without_dimension", "A ranking needs something to rank (customers, products, ...).", { normalized });
  }
  if (topN !== null) {
    if (topN > LIMITS.maxLimit) return unsupported("limit_too_large", null, `At most ${LIMITS.maxLimit} rows can be returned.`, { normalized });
    if (topN < 1) return needsPlanner("invalid_limit", "The row count is not valid.", { normalized });
    plan.limit = topN;
  }

  return finish(plan, { normalized, assumptions, context, extra: { intent: changeIntent ? "change" : "aggregate" } });
}

// ---------------------------------------------------------------- finish: validate, summarize

const MATRIX_CODES = new Set(["dimension_not_applicable_to_voucher_metric", "mixed_metric_grains", "compare_not_supported_with_date_groupby", "all_time_cannot_compare", "metric_not_applicable_to_entity", "dimension_not_applicable_to_entity"]);

function describePlan(plan) {
  const ent = CATALOG.entities[plan.entity].label;
  const what = plan.mode === "list" ? "invoices" : plan.metrics.map((m) => CATALOG.metrics[m].label.toLowerCase()).join(", ");
  const by = plan.groupBy && plan.groupBy.length ? ` by ${plan.groupBy[0].dim === "date" ? `${plan.groupBy[0].bucket}` : plan.groupBy[0].dim}` : "";
  const flt = plan.filters && plan.filters.length ? ` for ${plan.filters.map((f) => `${f.dim} "${f.value}"`).join(", ")}` : "";
  const per = plan.period.kind === "custom" ? `${plan.period.from} to ${plan.period.to}` : plan.period.kind === "specific_fy" ? `FY ${plan.period.fy}` : plan.period.kind.replace(/_/g, " ");
  const cmp = plan.compare ? `, compared using ${plan.compare.mode.replace(/_/g, " ")}` : "";
  return `${ent}: ${what}${by}${flt}, ${per}${cmp}`;
}

function finish(plan, { normalized, assumptions, context, extra }) {
  const parsed = parseQueryPlan(plan);
  if (!parsed.ok) return needsPlanner("router_plan_invalid", "The interpreted question did not form a valid plan.", { normalized, detail: parsed.errors.map((e) => e.code) });

  const validation = validateQueryPlan(plan, { referenceDate: context.referenceDate || VALIDATION_FALLBACK_REF });
  if (!validation.ok) {
    const codes = validation.errors.map((e) => e.code);
    if (codes.some((c) => MATRIX_CODES.has(c))) {
      return unsupported("unsupported_combination", null, validation.errors.map((e) => e.message).join(" "), { normalized, validatorCodes: codes });
    }
    return needsPlanner("router_plan_invalid", "The interpreted question could not be expressed as a supported query.", { normalized, detail: codes });
  }

  return {
    status: "supported",
    route: "query_engine",
    plan: parsed.plan ? stripDefaults(plan) : plan,
    interpretation: { summary: describePlan(plan), ...extra },
    assumptions,
    warnings: validation.warnings,
    normalized,
  };
}

// The plan handed on is exactly what the router built (no schema defaults injected), so tests and
// later stages see the router's own intent.
function stripDefaults(plan) {
  return JSON.parse(JSON.stringify(plan));
}

/**
 * Isolated adapter: route, and only if `supported` hand the plan to the executor. Not wired into chat.
 */
async function routeAndExecute(question, { tenantId, referenceDate, resolveEntity, execute } = {}) {
  const route = await routeQuestion(question, { resolveEntity, referenceDate });
  if (route.status !== "supported") return { route, result: null, executed: false };
  const run = execute || require("./execute").executeQuery;
  const result = await run(route.plan, { tenantId, referenceDate });
  return { route, result, executed: true };
}

/** The same safety gate the router applies first; the planner reuses it so it can never see unsafe text. */
function isUnsafeQuestion(question) {
  return typeof question !== "string" || UNSAFE_INPUT.some((re) => re.test(question));
}

module.exports = { routeQuestion, routeAndExecute, normalizeText, isUnsafeQuestion, MAX_QUESTION_CHARS };
