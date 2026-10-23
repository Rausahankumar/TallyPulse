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
  ("a an the my our me i we us you your show give tell what whats which who whom whose how many when where is are was were be been am do does did done can could would will shall please list get display report see view find of for in on at to from by with without and or vs versus per each every all any some this that these those has have had it its there their them then also just only about into over under between during within total summary numbers number data figures figure so far till now current currently me they hi hello hey thanks thank thankyou pls plz kindly want wanted know need needed perform performed performing ki ka ke ko kya kitni kitna kitne hui hua hue thi tha hai hain ho mein bhi dikhao dikhaiye batao bataiye mujhe").split(" ")
);
// Demo fix (Hinglish): the words above in the last line are pure fillers/question words (like "what/how many"), so
// they are dropped. These carry MEANING the grammar cannot map (less / goods / bought / sold / which / most / from),
// so a run containing one is language for the planner - never a customer/product name to look up (which ended in
// a false "check the spelling").
const HINGLISH_CONTENT = new Set(
  ("kam kum zyada jyada sabse maal kharida kharidi kharide kharid bika bike bikri becha bechi gaya gayi gaye kaunse kaunsa kaunsi kaun se ne par aur ya wala wali wale kab kyun kyu kaise liye pichle pichhle agle mahina mahine hafte saal").split(" ")
);
/** Unambiguous Hinglish period phrases -> the English the grammar already knows. */
function normalizeHinglish(t) {
  return t
    .replace(/\bpich+l[ea]\s+mahin[eao]\b/g, "last month")
    .replace(/\b(?:is|iss|isi)\s+mahin[eao]\b/g, "this month")
    .replace(/\baaj\b/g, "today");
}

const RANGE_SEP = "(to|and|till|until|through|se)";
const CHANGE_WORDS_RE = /\b(?:chang\w*|grow\w*|grew|increas\w*|decreas\w*|declin\w*|drop\w*|fell|fall\w*|rise|rose|risen|vs|versus|compar\w*|differenc\w*|varianc\w*|delta|improv\w*|higher|lower|badhi|badhe|ghati|ghate|zyada|kam)\b/;
const monthEnd = (y, m) => `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
/**
 * A month range is ONE custom period: "Apr 2025 to Aug 2025" / "April 2025 se August 2025 tak" ->
 * "2025-04-01 to 2025-08-31" (the ISO range the grammar already reads). "Apr-2025" is "Apr 2025". Inside an
 * explicit FY, bare months take their year from it ("FY 2025-26 ... April se August tak" -> 2025-04-01..2025-08-31;
 * Apr-Dec = start year, Jan-Mar = end year) and the FY label is consumed. "X and Y" is a range only after "between";
 * a reversed range, a range outside the stated FY, or one following "compare" is left untouched.
 */
function normalizeMonthRanges(t) {
  t = t.replace(new RegExp(`\\b${MONTH_RE}-(20\\d{2})\\b`, "g"), "$1 $2");
  // "how did sales change from August 2025 to September 2025" names two periods to COMPARE, not one range.
  if (CHANGE_WORDS_RE.test(t)) return t;
  const fyRe = /(?:\b(?:in|for|during|of)\s+)?\b(?:fy|f y|financial year|fiscal year)\s*(\d{2,4})\s*-\s*(\d{2,4})\b/;
  const fyM = fyRe.exec(t);
  const fy = fyM ? fyFrom(fyM[1], fyM[2]) : null;
  const fyStart = fy ? Number(fy.slice(0, 4)) : null;
  let usedFy = false;
  const guard = (m, sep, offset) => (sep === "and" && !/^between\b/.test(m)) || /compar\w*\s*$/.test(t.slice(0, offset));
  // explicit years on both ends
  t = t.replace(new RegExp(`(?:\\b(?:from|between)\\s+)?\\b${MONTH_RE}\\s+(20\\d{2})\\s+${RANGE_SEP}\\s+${MONTH_RE}\\s+(20\\d{2})\\b(?:\\s+tak\\b)?`, "g"), (m, m1, y1, sep, m2, y2, offset) => {
    if (guard(m, sep, offset)) return m;
    const a = `${y1}-${pad2(monthNum(m1))}-01`;
    const b = monthEnd(Number(y2), monthNum(m2));
    if (a > b) return m;
    if (fyStart !== null && a >= `${fyStart}-04-01` && b <= `${fyStart + 1}-03-31`) usedFy = true;
    return ` ${a} to ${b} `;
  });
  // bare months inside an explicit FY
  if (fy) {
    t = t.replace(new RegExp(`(?:\\b(?:from|between)\\s+)?\\b${MONTH_RE}\\s+${RANGE_SEP}\\s+${MONTH_RE}\\b(?!\\s*-?\\s*20\\d{2})(?:\\s+tak\\b)?`, "g"), (m, m1, sep, m2, offset) => {
      if (guard(m, sep, offset)) return m;
      const n1 = monthNum(m1), n2 = monthNum(m2);
      if ((n1 + 8) % 12 > (n2 + 8) % 12) return m;
      usedFy = true;
      return ` ${fyStart + (n1 >= 4 ? 0 : 1)}-${pad2(n1)}-01 to ${monthEnd(fyStart + (n2 >= 4 ? 0 : 1), n2)} `;
    });
  }
  return usedFy ? t.replace(fyRe, " ") : t;
}

const UNSUPPORTED_RULES = [
  ["tax_breakdown", /\b(?:gst|cgst|sgst|igst|utgst|vat|itc|tds|tcs|hsn|tax|taxes|taxable|taxed|pre-tax|pretax|post-tax|ex-tax)\b/],
  ["net_of_returns", /\b(?:credit notes?|debit notes?|creditnotes?|debitnotes?|returns?|returned|refunds?|net sales|net purchases)\b/],
  ["profit_margin", /\b(?:profit|profits|profitable|profitability|margins?|cogs|cost of goods|pnl|p and l|loss|losses|markup|mark-up|balance sheet|income statement)\b/],
  ["discount_analysis", /\b(?:discounts?|discounted|rebates?|schemes?)\b/],
  ["cancelled_invoices", /\b(?:cancell?ed|cancell?ations?|deleted|voided|void)\b/],
  ["sales_by_region_or_salesperson", /\b(?:regions?|states?|cit(?:y|ies)|areas?|territor(?:y|ies)|salespersons?|salesmen|salesman|sales reps?|sales executives?|executives?|zones?|branch(?:es)?|customer groups?|customer categor(?:y|ies)|gstin|pincode|district|locations?)\b/],
  ["outstanding_or_payments", /\b(?:outstanding|receivables?|payables?|receipts?|payments?|paid|unpaid|overdue|dues?|collections?|collected|ageing|aging|balances?|ledgers?|bank|cash|journals?|contra|debtors?|creditors?)\b/],
  ["other_accounting_domains", /\b(?:orders?|deliver(?:y|ies)|dispatch(?:es)?|stock valuation|closing stock|opening stock|inventory valuation|stock on hand|stock in hand|payroll|salary|salaries|wages|e ?way|fixed assets?|depreciation|budgets?|targets?|quotas?|expenses?|expenditure|income|assets?|liabilit(?:y|ies)|equity|capital)\b/],
];

const COMPLEX_RE = /\b(?:why|explain|explanation|reasons?|because|insights?|analy[sz]e|analysis|analytics?|recommend\w*|suggest\w*|should|contribut\w*|impact|drivers?|caus(?:e|es|ed)|correlat\w*|seasonal\w*|predict\w*|forecast\w*|projection\w*|projected|run rate|pace|anomal\w*|unusual|overview|health|opportunit\w*|risks?|risky|trends? analysis)\b/;
// "performance" alone does not inherently mean reasoning ("sales performance this month" is just "sales this
// month") - handled separately, context-aware, right below: try the question with the word removed first, and
// only fall back to the reasoning gate when the rest of the sentence does not reduce to a clean deterministic
// answer (a plan, or one of the router's own deterministic clarifications/refusals).
const PERFORMANCE_RE = /\bperformance\b/;
// Mirrors planner.js's SKIP_ROUTER_CODES (a router->planner import would be circular - planner.js already
// requires this file). Keep in sync: these are the needs_planner codes that are themselves a final,
// deterministic clarification and must never reach Claude.
const DETERMINISTIC_CLARIFICATION_CODES = new Set([
  "entity_not_resolved", "question_too_long", "year_missing", "ambiguous_period", "invalid_fy",
  "unsupported_window", "period_missing", "period_label_unsupported", "relative_offset_unsupported",
  "open_ended_range", "who_ambiguous", "threshold_direction_missing", "vague_performance", "entity_ambiguous", "too_many_periods", "two_periods_without_comparison",
]);
const AMBIGUOUS_METRIC_RE = /\b(?:turnover|spend|spending|spent|cost|costs|business|earnings?|volume|worth)\b/;

// Period / comparison / growth vocabulary the Query DSL cannot express. Each is consumed as grammar and answered
// honestly (a clarification, or a final "not yet"), so it is never looked up as a customer/product name and never
// silently turned into a different period. Matched on the normalized text (lower-case, single spaces).
const CONNECTOR_SRC = "(?:as |when )?(?:vs|versus|compared (?:with|to|against)|compare (?:(?:it|them|that|this|these|those) )?(?:with|to|against)|against|than|relative to|in comparison (?:to|with))";
const NUMW = "\\d+|a few|few|a couple of|couple of|several|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|eighteen|twenty four|twenty|thirty six";
const SPAN_UNIT = "(?:months?|mths?|mos|weeks?|wks?|quarters?|qtrs?|years?|yrs?)";
// "3 months ago", "a year back": the DSL has no offset periods
const RELATIVE_OFFSET_RE = new RegExp(`\\b(?:${NUMW}|a|an) (?:days?|${SPAN_UNIT}) (?:ago|back|earlier|before now)\\b`, "g");
// "the month before last" / "the day before yesterday" as the SUBJECT (after "vs" they are the comparison target)
const BEFORE_LAST_RE = /(?<!\b(?:vs|versus|than|against|to|with)\s(?:the\s)?)\b(?:the )?(?:(?:week|month|quarter|year) before last|day before yesterday)\b/g;
// "last 6 months", "past two quarters", "12-month", "TTM": only 7/30/90-day rolling windows exist
const ROLLING_WINDOW_RE = new RegExp(`\\b(?:(?:in|over|during|for|within|of) )?(?:the )?(?:(?:last|past|previous|prior|preceding|trailing|rolling|recent|next|coming) (?:${NUMW}) (?:calendar )?${SPAN_UNIT}|(?:${NUMW})[ -]${SPAN_UNIT}(?: (?:rolling|trailing|window|period))?|ttm|ltm|l\\d{1,2}m|(?:trailing|rolling|last|past) twelve months)\\b`, "g");
// "Q1 2025", "H1", "first half of the year": FY vs calendar numbering differs, so never guessed
const PERIOD_LABEL_RE = /\b(?:q[1-4]|quarter (?:[1-4]|one|two|three|four)|(?:first|second|third|fourth|1st|2nd|3rd|4th) quarter|h[12]|(?:first|second|1st|2nd) half(?: of(?: the| this| last)?(?: (?:financial |fiscal |calendar )?year)?)?|half[- ]year(?:ly)?|semi[- ]annual(?:ly)?)(?: (?:of )?(?:(?:fy|financial year|fiscal year|calendar year) ?)?(?:20)?\d{2}(?: ?- ?\d{2,4})?)?\b/g;
// "since April 2025", "from April onwards": one end of the range is missing
const OPEN_RANGE_RE = /\b(?:since|onwards?)\b/g;
// "recently", "lately", "in recent months": no period named
const VAGUE_PERIOD_RE = /\b(?:recently|lately|of late|these days|nowadays|(?:in )?(?:the )?recent (?:days|weeks|months|times|years|past))\b/g;
// "over the year", "in the year 2025": which year (financial or calendar)?
const OVER_THE_YEAR_RE = /\b(?:(?:over|during|throughout|across|in|for|through) the (?:(?:whole|entire|full|past) )?year(?! ?\d)|(?:in|for|during|of) (?:the )?(?:calendar )?year 20\d{2}(?!-))\b/g;
// growth measured over EVERY sub-period of a range (the DSL holds one comparison, and no comparison per bucket)
const GROWTH_PATTERN_RE = new RegExp(`\\b(?:consistently|continuously|continually|steadily|progressively|in a row|back to back|back-to-back|consecutive(?:ly)?|successive(?:ly)?|streaks?|(?:month|week|quarter|year) after (?:month|week|quarter|year)|(?:consistent|continuous|steady|sustained|constant) (?:growth|increases?|declines?|rise|fall|drops?)|(?:keeps?|kept|keeping) (?:on )?(?:grow|increas|ris|declin|fall|dropp|decreas)\\w*|(?:${NUMW}) straight ${SPAN_UNIT})\\b`, "g");
// growth measured as a SPEED ("fastest growing"): a ranking by rate the router refuses (runs after the "by more
// than 20%" threshold rules)
const GROWTH_SPEED_RE = /\b(?:fastest|quickest|most rapidly|rapidly)(?:-(?=[a-z]))?/g;
// "what % of sales came from X", "share of sales": a share of a total, not a change
const SHARE_OF_TOTAL_RE = /(?:%|\bpercentages?|\bpercent|\bpct|\bshare|\bproportion|\bportion) of\b(?! (?:growth|change|increase|decrease|decline|drop|rise|fall)\b)/g;
// the change measured in % ("growth %", "% change", "in percentage terms"): the comparison's own deltaPct. Ranking
// BY it is refused in step 11 (see GROWTH_RATE_REASON); a total or a breakdown showing it is answered.
const PCT_MEASURE_RE = /(?:\b(?:growth|change|increase|decrease|decline|drop|rise|fall) (?:rates?|percentages?|percent|%|pct)(?!\w)|(?:\bpercentages?|\bpercent|\bpct|%) (?:growth|change|increases?|decreases?|declines?|drops?|rises?|falls?)\b|\bin percentage terms\b|\b(?:percentages?|percent)\b|%)/g;
const GROWTH_RATE_REASON = 'I can\'t rank by growth rate (%) yet - a very small previous value can put anyone at the top. I can show the % change of a total ("sales growth % this month vs last month"), rank by the size of the change ("top 10 customers by growth this month vs last month"), or list those that changed by more than a percentage ("customers whose sales grew by more than 20% this month vs last month").';
const SHARE_REASON = 'I can\'t compute a share of a total (for example "what % of sales came from X") yet. I can show the amounts and the total - for example "sales by customer this month".';
const GROWTH_PATTERN_REASON = 'I can\'t check growth across every month or quarter of a range yet (for example "consistently", "every month" or "in a row"). I can compare one period with another - for example "customers whose sales grew this quarter vs last quarter".';
const FIRST_TIME_REASON = 'I can\'t tell first-ever purchases yet - that needs your party/ledger master, which TallyPulse does not sync yet. I can list who bought in a period (for example "top customers this month") or who stopped buying (for example "customers who stopped buying this month vs last month").';
const REACTIVATED_REASON = 'I can\'t tell returning or reactivated customers yet - that needs each customer\'s full purchase history. I can list who bought in a period ("top customers this month") or who stopped buying ("customers who stopped buying this month vs last month").';

// "who" asks for a party breakdown (P-SF). Which party comes from the words around it, never from "who" alone:
//   we bought FROM them          -> supplier
//   THEY bought / we sold TO them -> customer (their buying is our sales)
//   "who sold ..." (not to us)    -> ambiguous (a salesperson is not recorded; a supplier sells to us)
// Matched on the normalized text.
const WHO_RE = /\b(?:who|whom|whose)\b/;
const WHO_SUPPLIER_RE = /\bwho(?:m)? (?:did|do|does|have|has|had|should|could|can|would) (?:we|i) (?:\w+ ){0,2}?(?:buy|bought|buying|purchase|purchased|purchasing|procure|procured|source|sourced)\b|\bfrom whom\b|\bwho (?:\w+ )?(?:supplied|supplies|supply|supplying)\b|\bwho (?:\w+ )?(?:sold|sells|sell|selling) (?:\w+ )?(?:to )?(?:us|me)\b/;
const WHO_BUYER_RE = /\bwho(?:m)? (?:did|do|does|have|has|had) (?:we|i) (?:\w+ ){0,2}?(?:sell|sold|selling|invoice|invoiced|bill|billed)\b|\bwhose (?:sales?|revenues?|purchases?|buying|business)\b|\bwho (?:\w+ ){0,2}?(?:bought|buys|buy|buying|purchased|purchases|purchase|purchasing)\b/;
const WHO_SELLER_RE = /\bwho (?:\w+ )?(?:sold|sells|sell|selling)\b/;
// "who drove / contributed to the increase": read as each party's share of the change (arithmetic, not a cause)
const WHO_CONTRIBUTION_RE = /\b(?:drove|drives|drive|driving|contributed|contributes|contributing|(?:was|were|is|are) (?:most )?responsible for)\b/g;
const PARTY_ASK_RE = /\b(?:which|what) (?:of (?:my|our|the) )?(?:customers?|clients?|buyers?|suppliers?|vendors?|products?|items?|goods|skus?|parties|party|categor(?:y|ies)|groups?|product groups?|stock groups?)\b/;
const WHO_REASON ='Who do you mean - customers or suppliers? For example "which customers bought less this month than last month" or "which suppliers did we buy less from this month".';
const WHO_CUSTOMER_NOTE = { code: "who_read_as_customers", message: '"Who" is read as your customers (the parties on your sales invoices).' };
const BUYER_WORDS_NOTE = { code: "customer_buying_is_sales", message: '"Bought/purchases" here means customers buying from you, i.e. your sales.' };
const SUPPLIER_SELLING_NOTE = { code: "supplier_selling_is_purchases", message: '"Sold to us" here means suppliers selling to you, i.e. your purchases.' };
const WHO_SUPPLIER_NOTE = { code: "who_read_as_suppliers", message: '"Who" is read as your suppliers (the parties on your purchase invoices).' };
const CONTRIBUTION_NOTE = { code: "contribution_is_change", message: "Ranked by each one's change in amount - the arithmetic contribution to the total change, not an explanation of its cause." };
// Decision 3 (final, 2026-09-28): a NEW customer/supplier is a party that is NOT already in the tenant's party/ledger
// master. TallyPulse has no such master (vouchers carry only the party NAME; the Tally ledger master is not synced),
// so "absent in the comparison period" must not be labelled "new" - e.g. a 2024 customer returning this month.
// Refused honestly until the master exists (docs/SEMANTIC_FOUNDATION.md). New PRODUCTS keep the comparison reading.
const NEW_PARTY_REASON = 'A "new customer" (or supplier) is one whose Tally ledger was created in the period and who traded in it. That cannot be read off a comparison of two periods (a returning customer is not new), so ask it directly with one period, for example "new customers this month".';
const NEW_NOTE = { code: "new_means_absent_in_comparison", message: '"New" means bought in this period but not in the comparison period - not necessarily a first-ever purchase (full purchase history is not checked).' };
const LOST_NOTE = { code: "lost_means_absent_in_period", message: '"Stopped/lost" means bought in the comparison period but not in this period - they may still buy later.' };
// Decision 2 (final, 2026-09-28): "this month vs last month" = month to date vs the COMPLETE previous calendar
// month. The same days are compared only when asked for explicitly. Other units keep the like-for-like default.
const SAME_DAYS_RE = /\b(?:(?:the )?same (?:period|days|dates|date range|number of days|day count|elapsed days) (?:of |in )?(?:last|previous|prior) month|like[- ]for[- ]like|same[- ]day[- ]count|same number of days)\b/g;
const LFL_NOTE = { code: "comparison_like_for_like_default", message: "Compared with the same elapsed portion of the previous period (the product's standard comparison)." };
const SAME_DAYS_NOTE = { code: "comparison_same_days_requested", message: "Compared with the same days of the previous period, as asked." };
const MONTH_FULL_NOTE = { code: "month_vs_complete_previous_month", message: 'This month so far is compared with the complete previous month (the product\'s standard month comparison). Ask for "same period last month" to compare the same days.' };

// --------------------------------------------------------------------------
// AdjustmentNote query support (LedgerMaster phase follow-on). A SEPARATE,
// deliberately narrow, deterministic branch - checked before the general
// "returns/credit notes/debit notes are unsupported" refusal below - rather
// than threading a third/fourth entity through the sales/purchase grammar
// above. Only the phrasings this covers become a plan; everything else
// (named parties, product breakdowns, rankings, trends, other periods) is
// refused or falls through to the existing catch-all, never guessed. See
// docs/PROJECT_CONTEXT.md.
// --------------------------------------------------------------------------
// Passive "X were/was returned" reads as something coming back TO the business (a Credit Note); active "we
// (did) return(ed) X" reads as the business sending something back (a Debit Note) - a real, non-arbitrary
// English distinction, not a guessed default. Excludes "we returned" so the two never both fire.
const RETURN_PASSIVE_RE = /\b(?:were|was)\s+returned\b/;
const RETURN_ACTIVE_WE_RE = /\b(?:we|did\s+we)\s+return(?:ed)?\b/;
const SALES_RETURN_RE = /\b(?:sales returns?|customer returns?|returns? (?:from|by) customers?|goods returned by customers?|customers?\s+return(?:ed)?\b)\b/;
// "top 10 customers by returned amount" - no "sales"/"customer return" phrase, but "returned amount" next to
// "customers" (never "suppliers") is unambiguous enough. Narrow on purpose - does NOT match "customers who
// returned" alone (a possible reactivation phrasing), only the specific "returned amount" wording.
const RETURN_AMOUNT_BY_CUSTOMER_RE = /\bcustomers?\b[\s\S]{0,20}\breturned\s+amount\b|\breturned\s+amount\b[\s\S]{0,20}\bcustomers?\b/;
const RETURN_AMOUNT_BY_SUPPLIER_RE = /\bsuppliers?\b[\s\S]{0,20}\breturned\s+amount\b|\breturned\s+amount\b[\s\S]{0,20}\bsuppliers?\b/;
const PURCHASE_RETURN_RE = /\b(?:purchase returns?|supplier returns?|returns? (?:to|from) suppliers?|goods returned to suppliers?|return(?:ed)?\s+(?:the\s+)?(?:most\s+)?purchases?\s+(?:to|from)\b|return(?:ed)?\s+(?:the\s+)?most\s+purchases?\b)\b/;
// Anything needing data the pipeline does not capture reliably (return
// reasons, return rate, partial/full status, GST-head impact) - refused
// explicitly rather than silently answered with the total.
const RETURN_UNSUPPORTED_MODIFIER_RE = /\breturn reasons?\b|\breturn rate\b|\b(?:partial|full)\s+returns?\b|\bnet sales\b|\bnet purchases\b|\b(?:gst|cgst|sgst|igst|hsn)\b/;
const RETURN_BY_PRODUCT_RE = /\bby products?\b|\bproducts?[- ]wise\b|\bper products?\b|\bmost returned\b|\bwhich products?\b|\bwhat products?\b|\breturned products?\b|\bproducts?\s+returned\b|\bproducts?\s+we\s+returned\b|\b(?:top|highest|largest|biggest|most)\s+(?:\d+\s+|[a-z]+\s+)?products?\b/;
const RETURN_BY_CUSTOMER_RE = /\bby customers?\b|\bcustomers?[- ]wise\b|\bper customers?\b|\bwhich customers?\b|\bwhat customers?\b|\b(?:top|highest|largest|biggest|most)\s+(?:\d+\s+|[a-z]+\s+)?customers?\b/;
const RETURN_BY_SUPPLIER_RE = /\bby suppliers?\b|\bsuppliers?[- ]wise\b|\bper suppliers?\b|\bwhich suppliers?\b|\bwhat suppliers?\b|\b(?:top|highest|largest|biggest|most)\s+(?:\d+\s+|[a-z]+\s+)?suppliers?\b/;
// "who" implies a party breakdown, same convention as the main grammar's own WHO_RE - direction (customer vs
// supplier) is already known by the time this is checked, from isSales/isPurchase.
const RETURN_WHO_RE = /\bwho\b/;
const RETURN_COUNT_RE = /\bhow many\b|\bnumber of\b|\bcount\b/;
// "how many UNITS" is quantity, not a voucher/line count - checked before RETURN_COUNT_RE's generic
// "how many" match. Product return count itself (how many TIMES an item was returned) is deliberately not
// implemented (voucher count vs line count would differ ambiguously) - see RETURN_PRODUCT_COUNT_RE below.
const RETURN_QUANTITY_WORD_RE = /\bunits?\b|\bquantit(?:y|ies)\b|\bqty\b/;
// A specific named product ("units of X were returned", "value of X was returned", "... did we return X to
// suppliers", "return value for X"). The captured group may be an opaque xqx{n}xqx placeholder (span-first
// pass) or raw text (grammar-only pass) - resolved the same way the main grammar resolves any name.
const RETURN_PRODUCT_NAME_RE = /\b(?:units?|value)\s+of\s+(.+?)\s+(?:were|was|did\s+we)\s+return(?:ed)?(?:\s+to\s+suppliers?)?\b/;
const RETURN_PRODUCT_NAME_FOR_RE = /\breturn\s+value\s+for\s+(.+?)(?:\s+(?:this|last|in)\b|\s*$)/;
// "top 5", "highest 10", ... - reuses the main grammar's own number-word map (NUM_WORDS). Bare "top"/"highest"/
// "most" (no number) is ranking intent with no cap - matches the main grammar's own "top customers" (no N)
// behaviour: sort, don't truncate, since no default N is established anywhere else in the product.
const RETURN_TOPN_RE = new RegExp(`\\b(?:top|highest|largest|biggest|most)\\s+(\\d+|${Object.keys(NUM_WORDS).join("|")})\\b`);
// Month-only trend/series ("show ... month by month", "... trend"); day/week are
// not offered (the main grammar's own rule: they need an explicit period, and
// this branch's period grammar is deliberately small - see below).
const RETURN_TREND_RE = /\bmonth by month\b|\bmonthly\b|\btrend\b/;
// Comparison intent words, not just an explicit "vs"/"compared" connector -
// "did returns increase this month?" is a comparison question too.
const RETURN_COMPARE_INTENT_RE = /\bvs\b|\bversus\b|\bcompared?\b|\bagainst\b|\bincreas\w*|\bdecreas\w*|\bchang(?:e|ed|ing)\b|\bgrew\b|\bgrow\w*|\bdropp?ed\b|\bfell\b|\bhigher\b|\blower\b/;
// A small, self-contained period grammar (mirrors a subset of step 7 above,
// specifically for this branch - see the file header on why this is a
// parallel implementation rather than a shared one).
const RETURN_PERIOD_PATTERNS = [
  [/\b(\d{4}-\d{2}-\d{2})\s+(?:to|and|through|until|till)\s+(\d{4}-\d{2}-\d{2})\b/, (m) => ({ kind: "custom", from: m[1], to: m[2] })],
  [/\btodays?\b/, () => ({ kind: "today" })],
  [/\byesterdays?\b/, () => ({ kind: "yesterday" })],
  [/\b(?:this|current) months?\b|\bmtd\b/, () => ({ kind: "current_month" })],
  [/\b(?:last|previous) months?\b/, () => ({ kind: "previous_month" })],
  [/\b(?:this|current) quarters?\b/, () => ({ kind: "current_quarter" })],
  [/\b(?:last|previous) quarters?\b/, () => ({ kind: "previous_quarter" })],
  [/\b(?:this|current) (?:financial|fiscal) year\b|\b(?:this|current) fy\b|\bfy to date\b|\bfytd\b|\bfinancial year to date\b/, () => ({ kind: "current_fy" })],
  [/\b(?:last|previous) (?:financial|fiscal) year\b|\b(?:last|previous) fy\b/, () => ({ kind: "previous_fy" })],
  [new RegExp(`\\b${MONTH_RE}\\s+(20\\d{2})\\b`), (m) => monthRange(Number(m[2]), monthNum(m[1]))],
];
// Decision 2's default comparison target, reused as-is (never a new rule):
// current_month -> the complete previous month; current_quarter -> like-for-like
// (quarters stay like-for-like per decision 2). No default exists for any other
// period kind, so a compare-intent word elsewhere is answered as a total only.
const RETURN_DEFAULT_COMPARE = { current_month: { mode: "full_previous" }, current_quarter: { mode: "like_for_like" } };

async function routeReturnQuestion(text, normalized, context, quoted) {
  const activeWe = RETURN_ACTIVE_WE_RE.test(text);
  const isSales = SALES_RETURN_RE.test(text) || RETURN_AMOUNT_BY_CUSTOMER_RE.test(text) || (RETURN_PASSIVE_RE.test(text) && !activeWe);
  const isPurchase = PURCHASE_RETURN_RE.test(text) || RETURN_AMOUNT_BY_SUPPLIER_RE.test(text) || activeWe;
  if (!isSales && !isPurchase) return null; // not a return question this branch handles - fall through unchanged

  if (isSales && isPurchase) {
    return unsupported("return_direction_ambiguous", null, 'That mentions both sales and purchase returns; ask about one side, for example "sales returns this month" or "purchase returns this month".', { normalized });
  }
  if (RETURN_UNSUPPORTED_MODIFIER_RE.test(text)) {
    return unsupported(
      "unsupported_return_detail",
      null,
      "Return reasons, return rate, partial/full return status, GST-head return impact and net sales/purchases after returns are not available yet - only the total return amount/count, optionally by customer or supplier.",
      { normalized }
    );
  }

  const entity = isSales ? "sales_return" : "purchase_return";
  const groupDim = isSales ? "customer" : "supplier";

  const isTrend = RETURN_TREND_RE.test(text);
  const byDim = (isSales ? RETURN_BY_CUSTOMER_RE : RETURN_BY_SUPPLIER_RE).test(text) || RETURN_WHO_RE.test(text);
  const byProduct = RETURN_BY_PRODUCT_RE.test(text);

  // A specific named product ("units of X were returned", "return value for X") - resolved the SAME way the
  // main grammar resolves any customer/supplier/product name (context.resolveEntity, hintDim:"product"), so
  // it fails closed identically: 0 matches -> entity_not_resolved, >1 -> entity_ambiguous, lookup error ->
  // temporarily_unavailable. Never inferred from description/fuzzy matching.
  let productFilter = null;
  const productNameMatch = text.match(RETURN_PRODUCT_NAME_RE) || text.match(RETURN_PRODUCT_NAME_FOR_RE);
  if (productNameMatch) {
    const raw = productNameMatch[1].trim();
    const q = /^xqx(\d+)xqx$/.exec(raw);
    const candidate = q ? quoted[Number(q[1])] : raw;
    if (!candidate) return needsPlanner("unrecognized_words", "A quoted name is mixed with other words.", { normalized });
    if (typeof context.resolveEntity !== "function") return needsPlanner("entity_not_resolved", `"${candidate}" could not be looked up.`, { normalized });
    let resolved;
    try {
      resolved = await context.resolveEntity({ entity, hintDim: "product", text: candidate });
    } catch (error) {
      return temporarilyUnavailable("entity_lookup_unavailable", "The product lookup is temporarily unavailable.", { normalized });
    }
    const matches = (resolved && resolved.matches) || [];
    if (matches.length === 0) return needsPlanner("entity_not_resolved", `"${candidate}" did not match a known product.`, { normalized });
    if (matches.length > 1) return needsPlanner("entity_ambiguous", `"${candidate}" matches more than one product.`, { normalized });
    productFilter = { dim: "product", op: "eq_ci", value: matches[0].value };
  }
  const productDim = byProduct || !!productFilter;

  if (productDim && byDim) {
    return unsupported("unsupported_combination", null, "A product breakdown together with a customer/supplier breakdown is not available yet; ask for one or the other.", { normalized });
  }
  if (productDim && isTrend) {
    return unsupported("unsupported_combination", null, "A product breakdown compared over a month-by-month trend is not available yet.", { normalized });
  }
  if (productDim && RETURN_COMPARE_INTENT_RE.test(text)) {
    return unsupported("unsupported_combination", null, "A product breakdown compared against another period is not available yet (this would silently become a growth-ranking question); ask for the breakdown OR the comparison, not both.", { normalized });
  }

  let period = null;
  for (const [re, build] of RETURN_PERIOD_PATTERNS) {
    const m = text.match(re);
    if (m) {
      period = build(m);
      break;
    }
  }
  const assumptions = [];
  if (!period) {
    // Same rule as the main grammar's own missing-period default (localRouter.js step
    // "defaults for a missing period"): a ranking/breakdown/named-filter defaults to all
    // history; a plain total still needs an explicit period.
    if (!isTrend && !byDim && !productDim) return needsPlanner("period_missing", "That return question needs a period, for example \"this month\" or \"last month\".", { normalized });
    period = { kind: "all_time" };
    assumptions.push({ code: "period_defaulted_to_all_time", message: "No period was stated, so all available history is used." });
  }

  if (isTrend && byDim) {
    return unsupported("unsupported_combination", null, "A month-by-month trend cannot also be broken down by customer/supplier in one question; ask for one or the other.", { normalized });
  }
  if (byDim && RETURN_COMPARE_INTENT_RE.test(text)) {
    return unsupported("unsupported_combination", null, "A customer/supplier breakdown compared against another period is not available yet; ask for the breakdown OR the comparison, not both.", { normalized });
  }

  // Metric: quantity is chosen only by an explicit unit/quantity word - "how many" alone (no
  // unit/quantity word) on a product question is a voucher-vs-line COUNT ambiguity and is refused,
  // never silently read as quantity.
  let metricId;
  if (productDim) {
    if (RETURN_QUANTITY_WORD_RE.test(text)) metricId = "returnQuantity";
    else if (RETURN_COUNT_RE.test(text)) {
      return unsupported(
        "unsupported_return_detail",
        null,
        "A product's return COUNT is ambiguous (a voucher can return several products, and a product can appear on several lines) and is not available; ask for the returned quantity or value instead.",
        { normalized }
      );
    } else metricId = "returnLineAmount";
  } else {
    metricId = RETURN_COUNT_RE.test(text) ? "returnCount" : "returnAmount";
  }
  const metrics = [metricId];
  const plan = { v: 1, entity, mode: "aggregate", period, metrics };
  if (productFilter) plan.filters = [productFilter];

  if (isTrend) {
    plan.groupBy = [{ dim: "date", bucket: "month" }];
  } else if (byProduct) {
    plan.groupBy = [{ dim: "product" }];
    plan.sort = [{ by: metrics[0], dir: "desc" }];
    const topNMatch = text.match(RETURN_TOPN_RE);
    if (topNMatch) {
      const topN = /^\d+$/.test(topNMatch[1]) ? Number(topNMatch[1]) : NUM_WORDS[topNMatch[1]];
      if (topN > LIMITS.maxLimit) return unsupported("limit_too_large", null, `At most ${LIMITS.maxLimit} rows can be returned.`, { normalized });
      plan.limit = topN;
    }
  } else if (byDim) {
    plan.groupBy = [{ dim: groupDim }];
    // Always descending (return-amount ranking, never ascending in this phase); ties
    // break deterministically on the party name (compile.js sortStages, reused as-is).
    plan.sort = [{ by: metrics[0], dir: "desc" }];
    const topNMatch = text.match(RETURN_TOPN_RE);
    if (topNMatch) {
      const topN = /^\d+$/.test(topNMatch[1]) ? Number(topNMatch[1]) : NUM_WORDS[topNMatch[1]];
      if (topN > LIMITS.maxLimit) return unsupported("limit_too_large", null, `At most ${LIMITS.maxLimit} rows can be returned.`, { normalized });
      plan.limit = topN;
    }
    // No number stated ("which customers had the highest...", "who returned the most"): plan.limit is
    // left unset, so validator.js applies the product's own existing default (LIMITS.defaultLimit,
    // truncated: true) - the same rule every other grouped query already gets, nothing new here.
  } else if (RETURN_COMPARE_INTENT_RE.test(text) && RETURN_DEFAULT_COMPARE[period.kind]) {
    // Decision 2's existing default target for the period kind - reused as-is,
    // never a new comparison rule. No default exists for other period kinds
    // (today/yesterday/explicit range/FY/month+year), so the intent word is
    // simply not actionable there and the total alone is answered.
    plan.compare = RETURN_DEFAULT_COMPARE[period.kind];
  }

  return finish(plan, { normalized, assumptions, context, extra: { intent: "return" } });
}
const PCT_ORDER_NOTE = { code: "pct_shown_not_ranked", message: "Rows are ordered by amount (or by the change in amount), not by % change; the % change is shown for each. A % change is not defined when the comparison value is zero." };
// "doing better/worse" has no single measurable meaning (amount? invoices? margin?)
const VAGUE_PERFORMANCE_RE = /\b(?:doing|did|does|do|performing|performed|going|faring) (?:better|worse|well|badly|poorly|good|bad)\b|\b(?:better|worse) (?:performing|performers?)\b/;

// G7: requests for business INTERPRETATION or DIAGNOSIS, not a measurable figure. No plan can answer them
// truthfully, so they get a fixed honest answer - no planner, no legacy chat, no name lookup. Deliberately
// narrow: each pattern is a whole phrase (question word + subject + intent), never a single keyword, so
// "how much", "how did sales change", "which customers declined" etc. are untouched. Matched on the
// normalized text (lower-case, punctuation and apostrophes removed: "how's" -> "hows").
const REASONING_INTENTS = [
  // "how is my business doing", "how's the business performing", "how is our company going"
  /\bhow(?: is|s| are)? (?:my|our|the) (?:business|company|firm)(?: is)? (?:doing|performing|going|faring)\b/,
  // "how is business", "how's business going" (whole question, so a customer "Business Solutions" is untouched)
  /^how(?: is|s) business(?: (?:doing|going|performing))?$/,
  // "how are we doing", "how am I doing"
  /\bhow (?:are we|am i) (?:doing|performing|faring)\b/,
  // "what does this tell us", "what do these numbers mean"
  /\bwhat (?:does|do) (?:this|that|these|those|it)(?: (?:numbers?|figures?|data|results?))? (?:tell|say|mean|suggest|indicate)\b/,
  // "what should I focus on", "where should we focus", "what should we prioritise" (no object: "which customers
  // should I focus on" names something to rank and keeps its existing route)
  /\b(?:what|where) should (?:i|we) (?:focus|prioriti[sz]e|concentrate)\b/,
  // "what are the main problems (with my business)", "what are our biggest issues"
  /\bwhat (?:are|is|s) (?:the|our|my) (?:main |biggest |key |major )?(?:problems?|issues?|weakness(?:es)?|challenges?)\b/,
  // "why are my sales declining", "why did revenue decline", "why are purchases falling": WHY + a sales/revenue/
  // purchase subject + a movement word, in that order
  /\bwhy\b.*\b(?:sales?|revenues?|purchases?|business)\b.*\b(?:declin\w*|decreas\w*|fall\w*|fell|drop\w*|down|lower|reduc\w*|slow\w*|increas\w*|grow\w*|grew|rise|rises|rising|rose|up|higher|improv\w*|stagnat\w*|flat)\b/,
];
const REASONING_REASON =
  'That question asks for a broader interpretation of the business, which I can\'t give reliably from the figures alone. I can answer specific, measurable questions - for example "sales this month vs last month", "customers whose sales declined vs last month" or "top 5 products by revenue this quarter".';

// "Revenue" has ONE fixed meaning in TallyPulse: the pre-tax value of the items on active sales invoices
// (lineAmount). Stated on every answer so the basis is never hidden.
const REVENUE_ASSUMPTION = {
  code: "revenue_is_pre_tax_item_value",
  message: "Revenue = pre-tax value of the items sold (excludes GST, freight and other non-item charges, and invoices without item lines); gross of returns.",
};
// Same word test on every AI path (router, planner guard, chat fallbacks), so "revenue" can never reach a
// path that reads it as the tax-inclusive Sales total.
const REVENUE_RE = /\brevenues?\b/i;
const mentionsRevenue = (text) => typeof text === "string" && REVENUE_RE.test(text);

const DIM_WORD = {
  customer: "customer", customers: "customer", client: "customer", clients: "customer", buyer: "customer", buyers: "customer",
  supplier: "supplier", suppliers: "supplier", vendor: "supplier", vendors: "supplier",
  product: "product", products: "product", item: "product", items: "product", sku: "product", skus: "product", goods: "product",
  productgroup: "productGroup", vouchertype: "voucherType",
  // a trading party: the customer on sales, the supplier on purchases (resolved once the entity is known)
  party: "party", parties: "party",
};
const TRIGGER_HINT = { to: "customer", from: "supplier", customer: "customer", customers: "customer", client: "customer", clients: "customer", buyer: "customer", buyers: "customer", supplier: "supplier", suppliers: "supplier", vendor: "supplier", vendors: "supplier", product: "product", products: "product", item: "product", items: "product", productgroup: "productGroup" };
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
// Infrastructure failure (not a property of the question): final, retryable, never handed to Claude.
function temporarilyUnavailable(code, reason, extra = {}) {
  return { status: "temporarily_unavailable", route: "honest_response", code, reason, retryable: true, ...extra };
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

// Steps 4-10 of the router: every grammar recognizer, in its fixed order, consumes the words it understands
// and leaves markers. Pure (no I/O). Also used to ask whether a single word is grammar at all (P1-2).
function consumeGrammar(text) {
  // ---- 4. collapse multi-word dimension nouns
  text = text
    .replace(/\b(?:product|stock|item) groups?\b|\bcategor(?:y|ies)\b|\bgroups?\b/g, " productgroup ")
    .replace(/\bvoucher types?\b/g, " vouchertype ")
    .replace(/\s+/g, " ")
    .trim();

  const st = makeState(text);

  // ---- 5a. period and growth vocabulary the DSL cannot express. Recognised here (before every period/series
  // rule, which would otherwise split them) so the question gets an honest answer - these words are never
  // looked up as a customer/product name and never silently re-interpreted.
  const invalidPeriod = (reason) => () => ({ type: "period", period: { type: "invalid", reason } });
  take(st, GROWTH_PATTERN_RE, () => ({ type: "growthPattern" }));
  take(st, /\b(?:first[- ]time|first[- ]ever|brand[- ]new|never (?:bought|purchased|ordered)(?: from us)? before|(?:first|1st) (?:ever )?(?:purchases?|orders?|invoices?))\b/g, () => ({ type: "firstTime" }));
  take(st, /\b(?:re-?activated|re-?activation|reactivat\w*|came back|come back|comes back|coming back|returning|won back|win back|regained|revived)\b/g, () => ({ type: "reactivated" }));
  take(st, PERIOD_LABEL_RE, invalidPeriod("period_label_unsupported"));
  take(st, RELATIVE_OFFSET_RE, invalidPeriod("relative_offset_unsupported"));
  take(st, BEFORE_LAST_RE, invalidPeriod("relative_offset_unsupported"));
  take(st, ROLLING_WINDOW_RE, invalidPeriod("unsupported_window"));
  take(st, OPEN_RANGE_RE, invalidPeriod("open_ended_range"));
  take(st, VAGUE_PERIOD_RE, invalidPeriod("period_missing"));
  take(st, OVER_THE_YEAR_RE, () => ({ type: "period", period: { type: "ambiguous" } }));
  // "LMTD" (last month to date) is exactly the like-for-like baseline of the current month
  take(st, /\b(?:lmtd|(?:last|previous|prior) month to date)\b/g, () => ({ type: "prevPeriod", sameDays: true }));
  // an explicit SAME-DAYS comparison (decision 2 keeps it like-for-like): "same period last month", "like for like"
  take(st, SAME_DAYS_RE, () => ({ type: "prevPeriod", sameDays: true }));
  // "growth over last month" = compared with last month ("over THE last month" is a span of time: not matched)
  take(st, /\bover(?= (?:last|previous|prior) (?:month|week|quarter|fy|financial year|fiscal year|period)\b)/g, () => ({ type: "connector" }));

  // ---- 5. comparison connectors that contain period words (must precede periods)
  take(st, new RegExp(`\\b(?:(?:${CONNECTOR_SRC})\\s+(?:the\\s+)?|over\\s+(?!the\\b))?(?:(?:same|corresponding|equivalent) (?:period|time|month|quarter|week) )?(?:last|previous|prior) year\\b`, "g"), (g, m) =>
    /\b(?:vs|versus|compared?|against|than|relative|comparison|over|same|corresponding|equivalent)\b/.test(m) ? { type: "sply" } : { type: "period", period: { type: "ambiguous" } }
  );
  take(st, /\b(?:yoy|y-o-y|y o y|year[\s-](?:over|on)[\s-]year)\b/g, () => ({ type: "sply" }));
  // period-over-period comparison words and "the month before": grammar, never entity names
  take(st, /\b(?:mom|m-o-m|month[\s-](?:over|on)[\s-]month)\b/g, () => ({ type: "pop", unit: "month" }));
  take(st, /\b(?:qoq|q-o-q|quarter[\s-](?:over|on)[\s-]quarter)\b/g, () => ({ type: "pop", unit: "quarter" }));
  take(st, /\bweek[\s-](?:over|on)[\s-]week\b/g, () => ({ type: "pop", unit: "week" }));
  take(st, /\b(?:the\s+)?(month|quarter|week|day) before(?:\s+(?:that|it|last|yesterday))?\b/g, (g) => ({ type: "priorOf", unit: g[0] }));
  take(st, new RegExp(`\\b(?:(?:${CONNECTOR_SRC})\\s+)?(?:the\\s+)?(?:previous|prior|preceding) period\\b`, "g"), () => ({ type: "prevPeriod" }));

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
  take(st, /\b(?:fy|f y|financial year|fiscal year|year)\s*(\d{2,4})\s*-\s*(\d{2,4})\b/g, (g) => {
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
  // a bare "till date" / "to date" (after the month/quarter/FY/week-to-date rules above) names no period
  take(st, /\b(?:till|until|up ?to|upto|to) date\b/g, () => P({ type: "invalid", reason: "period_missing" }));
  take(st, /\b(?:in|for|during|of|from|to)\s+may\b/g, () => P({ type: "invalid", reason: "year_missing" }));
  take(st, /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g, () => P({ type: "invalid", reason: "year_missing" }));

  // ---- 8. comparison connectors, growth and change intents
  const pct = [];
  take(st, /\b(?:full|complete|entire|whole)\b/g, () => ({ type: "full" }));
  take(st, /\b(?:by\s+)?(?:more than|over|above|greater than|at least)\s+(\d+(?:\.\d+)?)\s*%/g, (g) => (pct.push(Number(g[0])), { type: "pct" }));
  take(st, /\b(?:by\s+)?(?:less than|under|below|up to|upto)\s+\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*%/g, () => ({ type: "invalid", reason: "unsupported_threshold" }));
  take(st, new RegExp(`\\b(?:${CONNECTOR_SRC}|compared|compare|comparison)\\b`, "g"), () => ({ type: "connector" }));
  // a share of a total ("% of sales") is not a change; growth SPEED ("fastest") is a ranking by rate; a % change
  // ("growth %") is the comparison's deltaPct - see step 11
  take(st, SHARE_OF_TOTAL_RE, () => ({ type: "shareOfTotal" }));
  take(st, GROWTH_SPEED_RE, () => ({ type: "growthRate" }));
  take(st, PCT_MEASURE_RE, (g, m) => ({ type: "pctMeasure", intent: /decreas|declin|drop|fall/.test(m) ? "down" : /increas|rise/.test(m) ? "up" : /growth/.test(m) ? "growth" : "change" }));
  // "go up", "went down", "trending up": the movement is the intent; the verb is grammar
  take(st, /\b(?:go|goes|going|gone|went|come|came|coming|move[ds]?|moving|trend(?:ed|ing)?|head(?:ed|ing)?)\s+(up|down|higher|lower)\b/g, (g) => ({ type: "intent", intent: /up|higher/.test(g[0]) ? "up" : "down" }));
  // neutral change words ask for the comparison itself, like "growth"
  take(st, /\b(?:changes?|changed|changing|difference|variance|delta|trending)\b/g, () => ({ type: "intent", intent: "change" }));
  take(st, /\b(?:are|were|is|was|became|become|becomes)(?:\s+an?)?\s+new\b/g, () => ({ type: "intent", intent: "new" }));
  take(st, /\b(?:became|become|becomes|turned|went|gone)\b(?=\s+(?:inactive|dormant|lost)\b)/g, () => ({ type: "filler" }));
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
  // "ranked by", "sorted by": a ranking word (never a name)
  take(st, /\b(?:ranked|ranking|rank|sorted|sort|arranged)(?: (?:by|on|in))?\b/g, () => ((rankDir = rankDir || "desc"), { type: "rank" }));
  take(st, /\b(?:bottom|smallest|lowest|worst|least|minimum|min|fewest)\b/g, () => ((rankDir = rankDir || "asc"), { type: "rank" }));

  // ---- 10. metrics and entity words
  take(st, /\bwhat (?:did|do|have) (?:i|we) (?:sell|sold|buy|bought|purchase|purchased)\b/g, (g, m) => ({ type: "whatDid", entity: /sell|sold/.test(m) ? "sales" : "purchase" }));
  take(st, /\b(?:average|avg)\s+(?:(sales?|purchases?)\s+)?(?:(?:invoices?|bills?|orders?|vouchers?)(?:\s+(?:value|amount|size))?|(?:value|amount|size))\b/g, (g) => ({ type: "metric", metric: "avg", entity: g[0] ? (/^purchase/.test(g[0]) ? "purchase" : "sales") : null }));
  take(st, /\b(?:how many|number of|count of|total number of)\s+(?:invoices?|bills?|sales|purchases?|vouchers?)\b|\b(?:invoice|bill|voucher|sales?|purchases?) count\b/g, (g, m) => ({ type: "metric", metric: "count", entity: /purchase/.test(m) ? "purchase" : /sales/.test(m) ? "sales" : null }));
  // "customer count"/"supplier count": a distinct-party count is genuinely not represented by any metric
  // (invoiceCount/purchaseInvoiceCount are VOUCHER counts, not distinct-party counts) - refused explicitly
  // rather than silently answered with the wrong number or sent to the planner to guess.
  take(st, /\b(?:customer|supplier)s?\s+count\b|\bcount\s+of\s+(?:customer|supplier)s?\b/g, () => ({ type: "unsupportedPartyCount" }));
  take(st, /\bline (?:item )?amounts?\b/g, () => ({ type: "metric", metric: "line" }));
  take(st, /\b(?:quantity|quantities|qty|units|pieces|pcs)\b/g, () => ({ type: "metric", metric: "qty" }));
  take(st, /\b(?:invoices?|bills?|vouchers?)\b/g, () => ({ type: "invoiceNoun" }));
  take(st, /\brevenues?\b/g, () => ({ type: "revenue" }));
  take(st, /\b(?:sales?|sold|sell|sells|selling)\b/g, (g, m) => ({ type: "entity", entity: "sales", noun: /^sales?$/.test(m) }));
  take(st, /\b(?:purchases?|procurement)\b/g, () => ({ type: "entity", entity: "purchase", noun: true }));
  // a supplier supplying us: our purchases (a verb, like "bought")
  take(st, /\b(?:supplied|supplies|supplying)\b/g, () => ({ type: "entity", entity: "purchase", noun: false }));
  take(st, /\b(?:purchased|purchasing|bought|buy|buys|buying)\b/g, () => ({ type: "entity", entity: "purchase", noun: false }));
  take(st, /\b(?:how much|amount|value)\b/g, () => ({ type: "metric", metric: "amount" }));
  return { text, st, pct, topN, rankDir, recency };
}

// ---------------------------------------------------------------- resolver-first span matching (P1-2)
//
// A question containing a known tenant name is read twice: grammar-only (the existing router) and span-first
// (the known name is opaque, the grammar reads only the rest). Both use the same tenant-scoped resolver.

const FINAL_SEMANTIC_REFUSALS = new Set(["unsupported_new_party", "unsupported_first_purchase", "unsupported_reactivation", "unsupported_growth_rate", "unsupported_growth_pattern", "unsupported_share_of_total"]);

// Picks between the two readings. Never guesses between two different valid plans.
function chooseReading(grammarOnly, spanFirst) {
  if (spanFirst.status === "supported") {
    if (grammarOnly.status !== "supported") return spanFirst;
    if (samePlan(grammarOnly.plan, spanFirst.plan)) return grammarOnly;
    return needsPlanner("entity_ambiguous", "The question reads differently with and without a known customer/supplier/product/group name.", { normalized: spanFirst.normalized });
  }
  if (grammarOnly.status === "supported") return grammarOnly;
  // Unsafe text OUTSIDE a known name is refused exactly as before and never handed to any other path.
  if (grammarOnly.code === "unsafe_input") return grammarOnly;
  // A deliberate semantic refusal ("new customers" without the party master, first-ever, reactivated, % ranking,
  // share, growth pattern) is final unless the known-name reading yields a real plan: a tenant item that happens to
  // be named "New" must not turn it into a Claude call.
  if (grammarOnly.status === "unsupported" && FINAL_SEMANTIC_REFUSALS.has(grammarOnly.code)) return grammarOnly;
  return spanFirst;
}

const canonJson = (v) => (Array.isArray(v) ? v.map(canonJson) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonJson(v[k])])) : v);
const samePlan = (a, b) => JSON.stringify(canonJson(a)) === JSON.stringify(canonJson(b));

const QUOTE_RE = /["“”]([^"“”]{1,200})["“”]/g;
const PLACEHOLDER_RE = /^xqx\d+xqx$/;

// A word the grammar itself uses: stop word, trigger, dimension noun, number, gate word, or anything a
// recognizer consumes. A known-name span made ONLY of such words is never marked opaque, so a tenant name
// like "A", "Top" or "Monthly" cannot take over an ordinary question.
function isGrammarToken(tok) {
  if (STOP.has(tok) || TRIGGERS.has(tok) || DIM_WORD[tok] || /^\d+$/.test(tok) || PLACEHOLDER_RE.test(tok)) return true;
  if (UNSUPPORTED_RULES.some(([, re]) => re.test(tok)) || COMPLEX_RE.test(tok) || AMBIGUOUS_METRIC_RE.test(tok) || REVENUE_RE.test(tok)) return true;
  const { st } = consumeGrammar(tok);
  return !st.s.split(/\s+/).includes(tok);
}
// Stored names the input gate would reject are matched literally in the raw question. One stable predicate, so
// the resolver can reuse its candidate list.
const nameNeedsLiteral = (name) => UNSAFE_INPUT.some((re) => re.test(name));
const acceptSpan = (slice) => !slice.some((t) => PLACEHOLDER_RE.test(t)) && slice.some((t) => !isGrammarToken(t));

// Before the input gate: quoted text that is one of THIS tenant's names, and exact raw occurrences of tenant
// names whose own characters the gate rejects, become opaque placeholders. Their text is literal data - it only
// ever becomes a resolved filter value - and the gate then judges the remaining text.
async function exciseKnownLiterals(question, context, { idx, probe }, quoted) {
  let out = "";
  let last = 0;
  if (typeof context.resolveEntity === "function") {
    for (const m of question.matchAll(QUOTE_RE)) {
      const inner = m[1].replace(/\s+/g, " ").trim();
      const resolved = await context.resolveEntity({ entity: null, hintDim: null, text: inner });
      if (!resolved || !Array.isArray(resolved.matches) || !resolved.matches.length) continue;
      quoted.push(inner);
      out += `${question.slice(last, m.index)} xqx${quoted.length - 1}xqx `;
      last = m.index + m[0].length;
      probe.opaque += 1;
    }
  }
  let text = out + question.slice(last);
  const literals = await idx.findLiterals(text, nameNeedsLiteral);
  if (literals.length) {
    let rebuilt = "";
    let at = 0;
    for (const lit of literals) {
      quoted.push(text.slice(lit.start, lit.end));
      rebuilt += `${text.slice(at, lit.start)} xqx${quoted.length - 1}xqx `;
      at = lit.end;
      probe.opaque += 1;
    }
    text = rebuilt + text.slice(at);
  }
  return text;
}

// After normalization: the leftmost-longest known-name spans become opaque placeholders.
async function markKnownNameSpans(text, { idx, probe }, quoted) {
  const tokens = text.split(" ").filter(Boolean);
  const spans = await idx.findSpans(tokens, acceptSpan);
  if (!spans.length) return text;
  probe.opaque += spans.length;
  const out = [];
  let i = 0;
  for (const sp of spans) {
    out.push(...tokens.slice(i, sp.start));
    quoted.push(sp.text);
    out.push(`xqx${quoted.length - 1}xqx`);
    i = sp.end;
  }
  out.push(...tokens.slice(i));
  return out.join(" ");
}

// ---------------------------------------------------------------- the router

/**
 * @param {string} question
 * @param {object} [context]
 * @param {Function} [context.resolveEntity] async ({entity, hintDim, text}) => {matches:[{dim,value}]}
 *        tenant-scoped, supplied by the server; the router never sees a tenant.
 * @param {{findSpans:Function, findLiterals:Function}} [context.entityIndex] the SAME resolver's name index
 *        (resolveEntity.spanIndex); enables resolver-first span matching. Omitted = grammar-only.
 * @param {Date} [context.referenceDate] only used to run the semantic validator
 */
async function routeQuestion(question, context = {}) {
  const grammarOnly = await routeCore(question, context, null);
  // P1-2 resolver-first span matching: only with this tenant's name index (server-supplied, tenant-bound).
  const idx = context.entityIndex;
  if (!idx || typeof idx.findSpans !== "function" || typeof idx.findLiterals !== "function" || typeof question !== "string") return grammarOnly;
  if (["invalid_input", "question_too_long", "empty_question"].includes(grammarOnly.code)) return grammarOnly;
  // Name lookup is down (P0-1): answer exactly as before - no second load attempt inside the same question.
  if (grammarOnly.status === "temporarily_unavailable") return grammarOnly;
  // G7: a whole interpretation phrase was asked - final, and no tenant name lookup is needed to say so.
  if (grammarOnly.code === "reasoning_not_supported") return grammarOnly;
  const probe = { opaque: 0 };
  let spanFirst;
  try {
    spanFirst = await routeCore(question, context, { idx, probe });
  } catch (error) {
    // The name index could not be read: keep the grammar-only reading, whose own name lookup (if any)
    // already reports an outage as temporarily_unavailable (P0-1).
    return grammarOnly;
  }
  if (!probe.opaque) return grammarOnly; // no known name in the question: exactly the existing behaviour
  return chooseReading(grammarOnly, spanFirst);
}

async function routeCore(question, context, spanMode) {
  // ---- 0. input gate
  if (typeof question !== "string") return unsupported("invalid_input", null, "The question must be text.");
  if (question.length > MAX_QUESTION_CHARS) return needsPlanner("question_too_long", `Questions over ${MAX_QUESTION_CHARS} characters are not handled by the local router.`);
  // P1-2: in the span-first reading, known tenant names are cut out as literal data first (exciseKnownLiterals);
  // the gate then judges only the remaining text. The grammar-only reading gates the raw question exactly as before.
  const quoted = [];
  const gateText = spanMode ? await exciseKnownLiterals(question, context, spanMode, quoted) : question;
  for (const re of UNSAFE_INPUT) {
    if (re.test(gateText)) return unsupported("unsafe_input", null, "The question contains characters or terms that cannot be processed.");
  }
  if (!question.trim()) return unsupported("empty_question", null, "The question is empty.");

  // ---- 1. quoted names out first (their content is opaque, never parsed)
  const withoutQuotes = gateText.replace(QUOTE_RE, (m, inner) => {
    quoted.push(inner.replace(/\s+/g, " ").trim());
    return ` xqx${quoted.length - 1}xqx `;
  });

  let text = normalizeText(withoutQuotes);
  if (spanMode) {
    text = await markKnownNameSpans(text, spanMode, quoted);
    if (!spanMode.probe.opaque) return { status: "no_known_name" }; // nothing opaque: the grammar-only reading stands
  }
  text = text.replace(/\b(?:average|avg) order (?:value|amount|size)\b/g, "average invoice value");
  text = text.replace(/\b(\d+(?:\.\d+)?) ?(?:percent|per cent|pct)\b/g, "$1%"); // "20 percent" = "20%"
  text = text.replace(/\bwhos\b/g, "who is"); // "who's" loses its apostrophe in normalizeText
  text = normalizeDates(normalizeMonthRanges(normalizeHinglish(text))).replace(/\s+/g, " ").trim();
  const normalized = text;
  if (!text) return unsupported("empty_question", null, "The question is empty.");

  // ---- 1b. G7: interpretation/diagnosis requests get a fixed honest answer (see REASONING_INTENTS). Known names
  // are already opaque placeholders in the span-first reading, so a name can never supply the phrase there.
  if (REASONING_INTENTS.some((re) => re.test(text))) return unsupported("reasoning_not_supported", null, REASONING_REASON, { normalized });

  // ---- 1c. sales/purchase returns (AdjustmentNote) - a narrow, self-contained
  // branch checked before the general "returns are unsupported" refusal below.
  const returnResult = await routeReturnQuestion(text, normalized, context, quoted);
  if (returnResult) return returnResult;

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

  // ---- 2b. "who": the party it asks about comes from the surrounding words (WHO_*), resolved in step 14b
  let whoFrame = null;
  let contribution = false;
  if (WHO_RE.test(text)) whoFrame = WHO_SUPPLIER_RE.test(text) ? "supplier" : WHO_BUYER_RE.test(text) ? "buyer" : WHO_SELLER_RE.test(text) ? "seller" : "open";
  // "who / which customers drove the increase": a party breakdown of the change. Without a party ("what drove the
  // increase?") it stays a request for a cause (reasoning).
  if (whoFrame || PARTY_ASK_RE.test(text)) {
    const stripped = text.replace(WHO_CONTRIBUTION_RE, " ").replace(/\s+/g, " ").trim();
    if (stripped !== text) {
      contribution = true;
      text = stripped;
    }
  }
  if (VAGUE_PERFORMANCE_RE.test(text)) return needsPlanner("vague_performance", "Doing better or worse has no single measurable meaning.", { normalized });

  // ---- 3. reasoning / ambiguity gates
  if (COMPLEX_RE.test(text)) return needsPlanner("requires_reasoning", "The question asks for analysis or explanation rather than a direct figure.", { normalized });
  if (PERFORMANCE_RE.test(text)) {
    // Try the question with "performance" removed: if the rest cleanly resolves to a plan, or to one of the
    // router's own deterministic clarifications/refusals, that reading wins - "performance" was just emphasis.
    // Otherwise (still needs_planner for an open-ended reason, or genuinely unsupported) this was a real
    // reasoning question, and the original behavior (send to the planner) stands.
    const withoutPerformance = question.replace(/\bperformance\b/gi, " ").replace(/\s+/g, " ").trim();
    let probe;
    try {
      probe = await routeCore(withoutPerformance, context, spanMode);
    } catch (error) {
      probe = null;
    }
    // "empty_question" from the probe would be misleading here (the ORIGINAL question wasn't empty - only the
    // performance-stripped copy is, e.g. a bare "performance"): that case falls back to requires_reasoning below.
    const clean =
      probe &&
      probe.code !== "empty_question" &&
      (probe.status === "supported" || probe.status === "unsupported" || (probe.status === "needs_planner" && DETERMINISTIC_CLARIFICATION_CODES.has(probe.code)));
    if (clean) return { ...probe, normalized };
    return needsPlanner("requires_reasoning", "The question asks for analysis or explanation rather than a direct figure.", { normalized });
  }
  if (AMBIGUOUS_METRIC_RE.test(text)) return needsPlanner("ambiguous_metric", "The measure is ambiguous (e.g. turnover/spend/cost could mean different amounts).", { normalized });

  const grammar = consumeGrammar(text);
  text = grammar.text;
  const { st, pct, topN, rankDir, recency } = grammar;

  // ---- 11. read the markers
  const items = markersInOrder(st);
  if (ofType(items, "unsupportedPartyCount").length) {
    return unsupported(
      "unsupported_party_count",
      null,
      "A count of distinct customers/suppliers is not available - invoice/voucher counts and new-customer/supplier breakdowns are (for example \"top customers by sales\" or \"new customers this month\").",
      { normalized }
    );
  }
  // ---- 11-growth. growth the DSL cannot express - a rate ranking, growth across every sub-period (pattern words,
  // or a change word on a date series), a first-ever purchase: a final honest answer, whatever the period says.
  // A % change is the comparison's own deltaPct: a total or a breakdown shows it; RANKING by it is refused.
  if (ofType(items, "shareOfTotal").length) return unsupported("unsupported_share_of_total", null, SHARE_REASON, { normalized });
  const pctMeasure = ofType(items, "pctMeasure");
  if (ofType(items, "growthRate").length || (pctMeasure.length && (rankDir !== null || topN !== null))) return unsupported("unsupported_growth_rate", null, GROWTH_RATE_REASON, { normalized });
  if (ofType(items, "growthPattern").length || (ofType(items, "bucket").length && (ofType(items, "intent").length || pctMeasure.length))) {
    return unsupported("unsupported_growth_pattern", null, GROWTH_PATTERN_REASON, { normalized });
  }
  if (ofType(items, "firstTime").length) return unsupported("unsupported_first_purchase", null, FIRST_TIME_REASON, { normalized });
  if (ofType(items, "reactivated").length) return unsupported("unsupported_reactivation", null, REACTIVATED_REASON, { normalized });

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

  // ---- 11-rev. revenue is an item-level amount: it cannot be mixed with invoice counts/averages (checked
  // before any leftover word such as "average" could be mistaken for a name).
  if (ofType(items, "revenue").length && (ofType(items, "metric").some((x) => x.metric === "count" || x.metric === "avg") || /\b(?:average|avg|mean)\b/.test(text))) {
    return unsupported("unsupported_combination", null, "Revenue is the pre-tax item value, which cannot be combined with invoice counts or averages in one question. Please ask for them separately.", { normalized });
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
  let nameHintIsPreposition = false;
  let unrecognised = false;

  for (const run of runs) {
    let a = 0;
    let b = run.length;
    while (a < b && STOP.has(run[a]) && !TRIGGERS.has(run[a])) a += 1;
    while (b > a && STOP.has(run[b - 1]) && !TRIGGERS.has(run[b - 1])) b -= 1;
    let core = run.slice(a, b);
    if (!core.length) continue;
    if (core.some((w) => HINGLISH_CONTENT.has(w))) {
      unrecognised = true;
      continue;
    }

    // leading trigger words give the name a dimension hint
    let hint = null;
    let hintIsPreposition = false;
    while (core.length && (TRIGGERS.has(core[0]) || STOP.has(core[0]))) {
      if (TRIGGER_HINT[core[0]] && !hint) {
        hint = TRIGGER_HINT[core[0]];
        hintIsPreposition = core[0] === "to" || core[0] === "from";
      }
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
    if (lead.length) hint = DIM_WORD[lead[lead.length - 1]] === "party" ? null : DIM_WORD[lead[lead.length - 1]];
    nameRun = core;
    nameHint = hint;
    nameHintIsPreposition = hintIsPreposition && !lead.length;
    void words;
  }
  if (unrecognised) return needsPlanner("unrecognized_words", "The question contains words the router cannot map safely.", { normalized });

  // ---- 13. resolve the (single) name
  let filter = null;
  let nameEntityHint = null;
  let partialNameNote = null;
  if (nameRun) {
    const surface = nameRun.join(" ");
    const q = /^xqx(\d+)xqx$/.exec(nameRun.length === 1 ? nameRun[0] : "");
    const rawText = q ? quoted[Number(q[1])] : null;
    if (!rawText && nameRun.some((w) => /xqx\d+xqx/.test(w))) return needsPlanner("unrecognized_words", "A quoted name is mixed with other words.", { normalized });

    const entityWords = ofType(items, "entity").map((x) => x.entity);
    const impliedEntity = entityWords.length ? entityWords[0] : ofType(items, "revenue").length ? "sales" : null;
    // "to"/"from" only say which side of the trade the name is on: for sales that side is a customer
    // ("revenue from X"), for purchases a supplier. Explicit nouns ("supplier X") are never remapped.
    if (nameHintIsPreposition && impliedEntity === "sales" && nameHint === "supplier") nameHint = "customer";
    if (nameHintIsPreposition && impliedEntity === "purchase" && nameHint === "customer") nameHint = "supplier";
    if (typeof context.resolveEntity === "function") {
      let resolved;
      try {
        resolved = await context.resolveEntity({ entity: impliedEntity, hintDim: nameHint, text: rawText || surface });
      } catch (error) {
        // The lookup itself failed (database/load error): that is NOT "no such name", and no other path may guess it.
        return temporarilyUnavailable("entity_lookup_unavailable", "The customer/supplier/product lookup is temporarily unavailable.", { normalized });
      }
      const matches = (resolved && resolved.matches) || [];
      if (matches.length === 0) return needsPlanner("entity_not_resolved", `"${rawText || surface}" did not match a known customer, supplier, product or group.`, { normalized });
      if (matches.length > 1) return needsPlanner("entity_ambiguous", `"${rawText || surface}" matches more than one kind of entity.`, { normalized });
      filter = { dim: matches[0].dim, value: matches[0].value };
      if (matches[0].partial) partialNameNote = { code: "name_matched_by_prefix", message: `"${rawText || surface}" was read as "${matches[0].value}" - the only ${matches[0].dim === "productGroup" ? "product group" : matches[0].dim} whose name starts with it.` };
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
  const assumptions = [];
  if (partialNameNote) assumptions.push(partialNameNote);
  let entityItems = ofType(items, "entity");
  // A customer's buying is our sale, a supplier's selling our purchase: when the party side is fixed (a customer/
  // supplier dimension or name, or a "who" frame) and the trade words only describe that party's side, they are
  // read from our side - never as the other entity - and the reading is stated.
  const partyDims = dims.filter((d) => d === "customer" || d === "supplier").concat(filter && (filter.dim === "customer" || filter.dim === "supplier") ? [filter.dim] : []);
  // "which parties bought less": a party that BUYS (verb, never the noun "purchases") is a customer
  const partyBuyer = dims.includes("party") && !partyDims.length && entityItems.some((x) => x.entity === "purchase" && !x.noun) && entityItems.every((x) => x.entity === "purchase" && !x.noun);
  const buyerSide = (whoFrame === "buyer" && !partyDims.length) || (partyDims.length && partyDims.every((d) => d === "customer")) || partyBuyer;
  const supplierSide = (whoFrame === "supplier" && !partyDims.length) || (partyDims.length && partyDims.every((d) => d === "supplier"));
  if (buyerSide && entityItems.some((x) => x.entity === "purchase") && !entityItems.some((x) => x.entity === "sales")) {
    if (entityItems.some((x) => x.entity === "purchase" && x.noun)) assumptions.push(BUYER_WORDS_NOTE);
    entityItems = entityItems.map((x) => (x.entity === "purchase" ? { ...x, entity: "sales", noun: true } : x));
  } else if (supplierSide && entityItems.some((x) => x.entity === "sales") && entityItems.every((x) => x.entity === "purchase" || (x.entity === "sales" && !x.noun))) {
    assumptions.push(SUPPLIER_SELLING_NOTE);
    entityItems = entityItems.map((x) => (x.entity === "sales" ? { ...x, entity: "purchase", noun: true } : x));
  }
  const nounEntities = new Set(entityItems.filter((x) => x.noun || x.entity === "sales").map((x) => x.entity));
  const whatDid = ofType(items, "whatDid")[0];
  const countEntity = ofType(items, "metric").map((x) => x.entity).filter(Boolean);
  const revenue = ofType(items, "revenue").length > 0;
  const signals = new Set([...nounEntities, ...dimEntity, ...(whatDid ? [whatDid.entity] : []), ...countEntity, ...(revenue ? ["sales"] : [])]);
  // purchase VERBS ("purchased", "bought") are neutral when a customer/supplier is named
  const verbOnly = entityItems.filter((x) => !x.noun && x.entity === "purchase");
  if (signals.size === 0 && verbOnly.length && dimEntity.size === 0) signals.add("purchase");
  if (nameEntityHint) signals.add(nameEntityHint);
  if (whoFrame === "buyer" && buyerSide) signals.add("sales");
  if (whoFrame === "supplier" && supplierSide) signals.add("purchase");
  if (signals.size > 1) return needsPlanner("entity_conflict", "The question mixes sales and purchase concepts.", { normalized });
  if (signals.size === 0) {
    if (whoFrame) return needsPlanner("who_ambiguous", WHO_REASON, { normalized });
    return needsPlanner("entity_ambiguous", "The question does not say whether it is about sales or purchases.", { normalized });
  }
  const entity = [...signals][0];
  void salesWord;
  void purchaseVerb;

  // ---- 14b. a trading party ("parties") is the customer on sales, the supplier on purchases; "who" with no
  // dimension named asks for that party - unless the words leave it open (then a clarification, never a guess).
  for (let i = 0; i < dims.length; i += 1) if (dims[i] === "party") dims[i] = entity === "sales" ? "customer" : "supplier";
  if (whoFrame && !dims.length && !(filter && (filter.dim === "customer" || filter.dim === "supplier")) && !ofType(items, "bucket").length) {
    const whoDim = whoFrame === "seller" ? null : whoFrame === "supplier" ? "supplier" : whoFrame === "buyer" ? "customer" : entity === "sales" ? "customer" : null;
    if (!whoDim || (whoDim === "customer") !== (entity === "sales")) return needsPlanner("who_ambiguous", WHO_REASON, { normalized });
    dims.push(whoDim);
    assumptions.push(whoDim === "customer" ? WHO_CUSTOMER_NOTE : WHO_SUPPLIER_NOTE);
  }

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
  if (revenue) want.line = true;
  const invoiceNoun = ofType(items, "invoiceNoun").length > 0;
  const sortHint = ofType(items, "sortHint")[0];
  const M = METRIC_DEFAULTS[entity];

  // ---- 17. list mode (individual invoices)
  const listMode = invoiceNoun && !want.avg && !want.count && !want.qty && !want.line;
  if (revenue) assumptions.unshift(REVENUE_ASSUMPTION);
  const plan = { v: 1, entity, mode: listMode ? "list" : "aggregate", period: null };

  // ---- 18. period + comparison
  const connectors = ofType(items, "connector").length > 0;
  const sply = ofType(items, "sply").length > 0;
  const prevPeriod = ofType(items, "prevPeriod").length > 0;
  // a % change word ("growth %") asks for the comparison like any change word; its direction words count too
  const intents = ofType(items, "intent").map((x) => x.intent).concat(pctMeasure.map((x) => x.intent));
  const growthWords = intents.length > 0;
  const wantsCompare = connectors || sply || prevPeriod || growthWords;
  const fullWords = ofType(items, "full").length > 0;
  const sameDays = items.some((x) => x.type === "prevPeriod" && x.sameDays);
  // the comparison with the period just before the subject (decision 2 for months; like-for-like otherwise)
  const previousCompare = (p, noteLfl) => {
    if (fullWords) return { mode: "full_previous" };
    if (p.kind === "current_month" && !sameDays) {
      assumptions.push(MONTH_FULL_NOTE);
      return { mode: "full_previous" };
    }
    if (sameDays) assumptions.push(SAME_DAYS_NOTE);
    else if (noteLfl) assumptions.push(LFL_NOTE);
    return { mode: "like_for_like" };
  };

  let period = null;
  let compare = null;
  if (periods.length > 2) return needsPlanner("too_many_periods", "More than two periods were mentioned.", { normalized });

  if (periods.length === 2) {
    if (!connectors) return needsPlanner("two_periods_without_comparison", "Two periods were mentioned without saying how to compare them.", { normalized });
    // "previous month vs current month" names the same comparison in the other order: subject = the current period
    const reversed = RELATIVE_UNIT[periods[0].kind] && RELATIVE_UNIT[periods[1].kind] && RELATIVE_UNIT[periods[0].kind][0] === RELATIVE_UNIT[periods[1].kind][0] && RELATIVE_UNIT[periods[0].kind][1] === "previous" && RELATIVE_UNIT[periods[1].kind][1] === "current";
    const [p0, p1] = reversed ? [periods[1], periods[0]] : periods;
    const u0 = RELATIVE_UNIT[p0.kind];
    const u1 = RELATIVE_UNIT[p1.kind];
    if (u0 && u1 && u0[0] === u1[0] && u0[1] === "current" && u1[1] === "previous") {
      period = p0;
      compare = previousCompare(p0, true);
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
    compare = previousCompare(period, RELATIVE_UNIT[period.kind][1] === "current");
  } else if (periods.length === 1) {
    period = periods[0];
    if (wantsCompare) {
      if (sply) compare = { mode: "same_period_last_year" };
      else if (connectors && !prevPeriod && !growthWords) return needsPlanner("comparison_target_missing", "A comparison was requested without saying what to compare against.", { normalized });
      else compare = previousCompare(period, true);
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

  // "growth above 20%" is a rise of more than 20%; "changed by more than 20%" has no direction (clarified below)
  const wantsUp = intents.includes("up") || (pct.length > 0 && intents.includes("growth") && !intents.includes("down"));
  const wantsDown = intents.includes("down");
  const stopped = intents.includes("stopped");
  const isNew = intents.includes("new");
  if ([wantsUp, wantsDown, stopped, isNew].filter(Boolean).length > 1) return needsPlanner("conflicting_intents", "The question asks for more than one kind of change.", { normalized });
  const changeIntent = wantsUp || wantsDown || stopped || isNew;
  // "changed by more than 20%": up or down? One having list cannot say "either way", and guessing a side would
  // silently drop half the answer.
  if (pct.length && !wantsUp && !wantsDown) return needsPlanner("threshold_direction_missing", "A percentage threshold needs a direction (grew or fell).", { normalized });

  if (changeIntent && !groupDim) {
    if (stopped || isNew) return needsPlanner("intent_needs_dimension", "That change question needs customers, suppliers or products to compare.", { normalized });
    if (pct.length) return needsPlanner("intent_needs_dimension", "A percentage threshold needs customers, suppliers or products to compare.", { normalized });
    // a bare "did sales go up/down" is just the comparison itself
  }
  // decision 3: a new party = its Tally ledger was created in the period (LedgerMaster), never the comparison reading
  const newParty = isNew && (groupDim === "customer" || groupDim === "supplier");
  if (newParty) {
    if (pct.length) return needsPlanner("conflicting_intents", "A percentage threshold does not apply to new customers/suppliers.", { normalized });
    if (plan.filters.some((f) => f.dim === groupDim)) return needsPlanner("conflicting_intents", "A named party cannot also be filtered to new parties.", { normalized });
    if (assumptions.some((a) => a.code === "period_defaulted_to_all_time")) return needsPlanner("period_missing", "New customers/suppliers need a period.", { normalized });
    delete plan.compare; // "new this month vs last month" = new in this month
    plan.filters = [...plan.filters, { dim: groupDim, op: "new_in_period", value: "period" }];
    assumptions.push(require("./validator").NEW_PARTY_NOTE);
  }
  if (changeIntent && groupDim && !newParty) {
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
    if (isNew) assumptions.push(NEW_NOTE);
    if (stopped) assumptions.push(LOST_NOTE);
    if (contribution && !stopped && !isNew) assumptions.push(CONTRIBUTION_NOTE);
    if (pctMeasure.length && !pct.length) assumptions.push(PCT_ORDER_NOTE);
  } else if (groupDim) {
    plan.sort = [{ by: primaryRef, dir: rankDir === "asc" ? "asc" : "desc" }];
    if (pctMeasure.length && plan.compare) assumptions.push(PCT_ORDER_NOTE);
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

// ---------------------------------------------------------------- follow-up slots (P-SF)
//
// A short follow-up ("and by customer?", "only above 20%", "compare with last FY") is read with the SAME grammar
// and reported as slots - nothing is guessed here. followUp.js merges the slots into the previous plan.

// conversational glue that carries no meaning of its own in a follow-up
const FOLLOW_UP_GLUE_RE = /\b(?:how about|what about|and what about|same (?:for|but|thing)|same (?:month|period)(?! (?:of |in )?(?:last|previous|prior)\b)|instead|now|ok|okay|then|also|plus|but|so|again|rather|just|only|please|break (?:it|that|this|them) down|split (?:it|that|this|them)|broken down|breakdown|show|me|them|those|these|that|it|ones)\b/g;
const CONTINUATION_CUE_RE = /^(?:and|also|plus|now|then|so|ok(?:ay)?|but|what about|how about|same|only|just|instead|break (?:it|that|this) down|split (?:it|that|this))\b|\b(?:instead|same period|same thing|the same|those|them|that one|these ones|the two|both of them)\b/;

/** True when the wording itself says "this continues the previous question". Normalized text only. */
function hasContinuationCue(question) {
  return typeof question === "string" && CONTINUATION_CUE_RE.test(normalizeText(question));
}

/**
 * Slots of a follow-up message, or null when the message must go through the full router (unsafe text, a refusal
 * word, a reasoning request, an ambiguous measure - those keep their existing honest answers).
 */
function readFollowUpSlots(question) {
  if (typeof question !== "string" || !question.trim() || question.length > MAX_QUESTION_CHARS) return null;
  if (UNSAFE_INPUT.some((re) => re.test(question))) return null;
  const quoted = [];
  let text = normalizeText(question.replace(QUOTE_RE, (m, inner) => (quoted.push(inner.replace(/\s+/g, " ").trim()), ` xqx${quoted.length - 1}xqx `)));
  text = text.replace(/\b(\d+(?:\.\d+)?) ?(?:percent|per cent|pct)\b/g, "$1%").replace(/\bwhos\b/g, "who is");
  text = normalizeDates(normalizeMonthRanges(normalizeHinglish(text))).replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (REASONING_INTENTS.some((re) => re.test(text)) || UNSUPPORTED_RULES.some(([, re]) => re.test(text))) return null;
  let whoFrame = null;
  if (WHO_RE.test(text)) whoFrame = WHO_SUPPLIER_RE.test(text) ? "supplier" : WHO_BUYER_RE.test(text) ? "buyer" : WHO_SELLER_RE.test(text) ? "seller" : "open";
  const contribution = (whoFrame !== null || PARTY_ASK_RE.test(text)) && WHO_CONTRIBUTION_RE.test(text);
  if (contribution) text = text.replace(WHO_CONTRIBUTION_RE, " ");
  if (COMPLEX_RE.test(text) || AMBIGUOUS_METRIC_RE.test(text) || VAGUE_PERFORMANCE_RE.test(text)) return null;
  text = text.replace(FOLLOW_UP_GLUE_RE, " ").replace(/\s+/g, " ").trim();
  const g = consumeGrammar(text);
  const items = markersInOrder(g.st);
  const leftover = g.st.s.split(/\s+/).filter((t) => t && !/^¦m\d+¦$/.test(t));
  const dims = [];
  const nameWords = [];
  for (const w of leftover) {
    if (DIM_WORD[w]) dims.push(DIM_WORD[w]);
    else if (!STOP.has(w)) nameWords.push(w);
  }
  const pick = (type) => ofType(items, type);
  return {
    text,
    periods: pick("period").map((x) => x.period),
    dims,
    buckets: pick("bucket").map((x) => x.bucket),
    intents: pick("intent").map((x) => x.intent).concat(pick("pctMeasure").map((x) => x.intent)),
    pctMeasure: pick("pctMeasure").length > 0,
    pct: g.pct,
    topN: g.topN,
    rankDir: g.rankDir,
    connector: pick("connector").length > 0,
    sply: pick("sply").length > 0,
    prevPeriod: pick("prevPeriod").length > 0,
    sameDays: pick("prevPeriod").some((x) => x.sameDays),
    pop: pick("pop").map((x) => x.unit),
    full: pick("full").length > 0,
    entities: pick("entity").map((x) => x.entity),
    revenue: pick("revenue").length > 0,
    metrics: pick("metric").map((x) => x.metric),
    invoiceNoun: pick("invoiceNoun").length > 0,
    blocked: ["growthRate", "growthPattern", "firstTime", "reactivated", "shareOfTotal", "invalid", "whatDid", "recency", "sortHint"].some((t) => pick(t).length > 0),
    prior: pick("priorOf").map((x) => x.unit),
    whoFrame,
    contribution,
    nameWords,
    quoted,
  };
}

/** The same safety gate the router applies first; the planner reuses it so it can never see unsafe text. */
function isUnsafeQuestion(question) {
  return typeof question !== "string" || UNSAFE_INPUT.some((re) => re.test(question));
}

module.exports = { routeQuestion, routeAndExecute, normalizeText, isUnsafeQuestion, mentionsRevenue, REVENUE_ASSUMPTION, MAX_QUESTION_CHARS, readFollowUpSlots, hasContinuationCue, NEW_PARTY_REASON, NOTES: { MONTH_FULL_NOTE, SAME_DAYS_NOTE, WHO_CUSTOMER_NOTE, WHO_SUPPLIER_NOTE, NEW_NOTE, LOST_NOTE, CONTRIBUTION_NOTE, PCT_ORDER_NOTE } };
