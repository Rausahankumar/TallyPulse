"use strict";

// --------------------------------------------------
// Sales/Purchase SEMANTIC CATALOG (Phase 1A) - backend-owned, LLM-free.
//
// Single source of truth for what "sales amount", "quantity", "customer",
// "product group" MEAN. Claude never defines any of this; it only ever
// refers to the ids below. The planner prompt (planner.js buildCatalogDigest)
// is generated from this catalog, so what is written here is what the model is told.
//
// Scope, deliberately narrow: Sales and Purchase data plus the Credit/Debit
// Notes classified as returns (the sales_return / purchase_return entities).
// No GST/tax, receipts/payments, ledgers, profit/COGS. Anything
// Sales/Purchase-related that cannot be answered honestly today is listed
// under UNSUPPORTED_CAPABILITIES with the reason, so the planner declines it
// and nothing is guessed.
//
// Every measure below was derived from the EXISTING analytics
// implementations (salesAnalytics / purchaseAnalytics /
// stockGroupAnalytics) - see PARITY_ORACLES for which existing function
// is the ground truth for each capability.
//
// Layering (so nobody puts a rule in the wrong place):
//   L1 queryPlan.schema.js  - shape, enums, caps, period/compare/filter
//                             internal consistency (zod, strict).
//   L2 validator (Phase 1B)  - everything in QUERY_RULES + the
//                             compatibility matrix below.
//   L3 tenant guard/compiler - Phase 1B; tenant scope is NEVER in the plan.
// --------------------------------------------------

const crypto = require("crypto");
const periodEngine = require("../analytics/periodEngine");

const CATALOG_VERSION = "sp-1.3.0";

const AMOUNT_BASIS = {
  // header.voucherTotalAmount: the corrected PARTY-LEDGER total (includes
  // tax/freight/rounding). The authoritative invoice value. Unchanged.
  VOUCHER_TOTAL_INCL_TAX: "voucher_total_incl_tax",
  // inventory[].amount: pre-tax line-item subtotal. Does NOT reconcile to
  // the voucher total and must never be presented as if it does.
  LINE_ITEM_PRE_TAX: "line_item_pre_tax",
};

// ---------- entities ----------

const ENTITIES = {
  sales: {
    id: "sales",
    label: "Sales",
    storage: { model: "Sale", collection: "sales" },
    partyDimension: "customer",
  },
  purchase: {
    id: "purchase",
    label: "Purchases",
    storage: { model: "Purchase", collection: "purchases" },
    partyDimension: "supplier",
  },
  // AdjustmentNote-backed. forcedMatch is baked into every compiled pipeline's
  // scope stage (compile.js scopeStage) - never a user-controlled filter, so
  // a value_adjustment note can never be counted as a return no matter what
  // the plan asks for. See docs/PROJECT_CONTEXT.md and the CN/DN diagnostic.
  sales_return: {
    id: "sales_return",
    label: "Sales returns (Credit Notes)",
    storage: { model: "AdjustmentNote", collection: "adjustmentnotes", forcedMatch: { classification: "sales_return" } },
    partyDimension: "customer",
  },
  purchase_return: {
    id: "purchase_return",
    label: "Purchase returns (Debit Notes)",
    storage: { model: "AdjustmentNote", collection: "adjustmentnotes", forcedMatch: { classification: "purchase_return" } },
    partyDimension: "supplier",
  },
};

// ---------- dimensions ----------
// grains: which record level the dimension exists at. "voucher" = one row
// per invoice; "line" = one row per inventory line (after $unwind).

const DIMENSIONS = {
  date: {
    id: "date",
    label: "Date",
    entities: ["sales", "purchase", "sales_return", "purchase_return"],
    grains: ["voucher", "line"],
    source: { path: "header.voucherDate" },
    buckets: ["day", "week", "month", "quarter", "fy"],
    cardinality: "series",
    filterOps: [], // dates are constrained ONLY through `period`
    notes:
      "Financial-year conventions come from periodEngine (FY Apr-Mar, FY-aligned quarters, Monday-start weeks). Only buckets that contain data are returned; empty buckets are never zero-filled (matches getSalesTrend). Buckets are cut in UTC, the zone the voucher dates are stored in; periods are the server's local calendar days. There is no calendar-year bucket (use fy, or a custom range).",
  },
  customer: {
    id: "customer",
    label: "Customer",
    entities: ["sales", "sales_return"],
    grains: ["voucher", "line"],
    source: { path: "header.partyName" },
    cardinality: "high",
    filterOps: ["eq_ci", "in_ci", "contains_ci", "new_in_period"],
    notes:
      "Grouping uses the raw stored party name (same as getTopCustomers); filtering is case-insensitive and anchored (same as getCustomerSales). new_in_period (value \"period\") keeps only parties whose Tally ledger was CREATED inside the query period (LedgerMaster.createdDate, exact name match); it cannot be combined with compare. Spelling variants (case, punctuation, spacing) of one party are separate groups; a name filter matches case-insensitively.",
  },
  supplier: {
    id: "supplier",
    label: "Supplier",
    entities: ["purchase", "purchase_return"],
    grains: ["voucher", "line"],
    source: { path: "header.partyName" },
    cardinality: "high",
    filterOps: ["eq_ci", "in_ci", "contains_ci", "new_in_period"],
    notes: "Same party-name semantics as customer, on the Purchase collection (same as getTopSuppliers), including new_in_period.",
  },
  product: {
    id: "product",
    label: "Product",
    entities: ["sales", "purchase", "sales_return", "purchase_return"],
    grains: ["line"],
    source: { path: "inventory.itemName" },
    cardinality: "high",
    filterOps: ["eq_ci", "in_ci", "contains_ci"],
    notes: "Stock item name as stored on the voucher line - the same raw-name identity already used for sales/purchase (no StockItemMaster merge; a differently-cased or misspelled name is a different product, exactly as elsewhere). A name filter is verified against the synced Stock Item master first, so a product that exists only on vouchers can be grouped but not filtered by name.",
  },
  productGroup: {
    id: "productGroup",
    label: "Product group (Tally Stock Group)",
    entities: ["sales", "purchase"],
    grains: ["line"],
    source: {
      // Same source and semantics as stockGroupAnalytics' join (Tally's own
      // Stock Item master, matched on tenant + exact item name; never
      // inferred), but resolved by the executor: aggregate PER ITEM, then map
      // item -> group with ONE tenant-filtered read of the master. Identical
      // results without paying a join per voucher line.
      join: { model: "StockItemMaster", collection: "stockitemmasters", on: { tenantId: "tenantId", itemName: "inventory.itemName" }, field: "stockGroupName" },
      unmapped: "exclude_and_report",
    },
    cardinality: "medium",
    filterOps: ["eq_ci", "in_ci", "contains_ci"],
    notes:
      "Classification is CURRENT Tally state (not a historical snapshot). Lines whose item has no master record (or whose name differs from the master's exactly) are excluded from group results and totals, and reported in a mapping diagnostic and a warning. The group is the item's immediate Stock Group; it is not rolled up to a top-level group.",
  },
  voucherType: {
    id: "voucherType",
    label: "Voucher type",
    entities: ["sales", "purchase"],
    grains: ["voucher", "line"],
    source: { path: "header.voucherType" },
    cardinality: "low",
    filterOps: ["eq_ci", "in_ci"],
    notes:
      "The RAW Tally voucher-type NAME (e.g. \"Invoice\"), which customized companies rename freely. It is not a Sales/Purchase class - that classification happens at sync time. A name filter is not verified against known types; a voucher whose type name is absent is stored as \"Sales\".",
  },
};

// ---------- metrics ----------
// grain "voucher": one value per invoice (cannot be attributed to a product).
// grain "line":    one value per inventory line.
// caveatRules: machine-checkable disclosures the validator must attach.

const METRICS = {
  invoiceAmount: {
    id: "invoiceAmount",
    label: "Invoice amount",
    entities: ["sales"],
    grain: "voucher",
    aggregation: { op: "sum", path: "header.voucherTotalAmount" },
    sign: "positive",
    amountBasis: AMOUNT_BASIS.VOUCHER_TOTAL_INCL_TAX,
    status: "supported",
    description: "Total sales: total invoice value (party-ledger total, tax-inclusive) summed over active Sales vouchers.",
    disclosures: [
      "Gross of returns: Credit/Debit Notes are stored separately and are never netted against this total.",
      "Tax-inclusive only when the party-ledger line of the voucher is found (exact, case-sensitive name match); otherwise the pre-tax item sum is stored.",
      "The sign is not kept: the stored total is an absolute value.",
    ],
  },
  invoiceCount: {
    id: "invoiceCount",
    label: "Invoice count",
    entities: ["sales"],
    grain: "voucher",
    aggregation: { op: "count" },
    sign: "n/a",
    amountBasis: null,
    status: "supported",
    description: "Number of active Sales vouchers.",
    disclosures: [],
  },
  averageInvoiceValue: {
    id: "averageInvoiceValue",
    label: "Average invoice value",
    entities: ["sales"],
    grain: "voucher",
    derived: { op: "ratio", numerator: "invoiceAmount", denominator: "invoiceCount", zeroDenominator: 0 },
    sign: "positive",
    amountBasis: AMOUNT_BASIS.VOUCHER_TOTAL_INCL_TAX,
    status: "supported",
    description: "invoiceAmount / invoiceCount (0 when there are no invoices).",
    disclosures: [],
  },
  purchaseAmount: {
    id: "purchaseAmount",
    label: "Purchase amount",
    entities: ["purchase"],
    grain: "voucher",
    aggregation: { op: "sum", path: "header.voucherTotalAmount" },
    sign: "positive",
    amountBasis: AMOUNT_BASIS.VOUCHER_TOTAL_INCL_TAX,
    status: "supported",
    description: "Total purchase invoice value (party-ledger total, tax-inclusive) summed over active Purchase vouchers.",
    disclosures: [
      "Gross of returns: Credit/Debit Notes are stored separately and are never netted against this total.",
      "Tax-inclusive only when the party-ledger line of the voucher is found (exact, case-sensitive name match); otherwise the pre-tax item sum is stored.",
      "The sign is not kept: the stored total is an absolute value.",
    ],
  },
  purchaseInvoiceCount: {
    id: "purchaseInvoiceCount",
    label: "Purchase invoice count",
    entities: ["purchase"],
    grain: "voucher",
    aggregation: { op: "count" },
    sign: "n/a",
    amountBasis: null,
    status: "supported",
    description: "Number of active Purchase vouchers.",
    disclosures: [],
  },
  averagePurchaseValue: {
    id: "averagePurchaseValue",
    label: "Average purchase value",
    entities: ["purchase"],
    grain: "voucher",
    derived: { op: "ratio", numerator: "purchaseAmount", denominator: "purchaseInvoiceCount", zeroDenominator: 0 },
    sign: "positive",
    amountBasis: AMOUNT_BASIS.VOUCHER_TOTAL_INCL_TAX,
    status: "supported",
    description: "purchaseAmount / purchaseInvoiceCount (0 when there are no invoices).",
    disclosures: [],
  },
  returnAmount: {
    id: "returnAmount",
    label: "Return amount",
    entities: ["sales_return", "purchase_return"],
    grain: "voucher",
    aggregation: { op: "sum", path: "header.voucherTotalAmount" },
    sign: "positive",
    amountBasis: AMOUNT_BASIS.VOUCHER_TOTAL_INCL_TAX,
    status: "supported",
    description: "Total value (party-ledger total, tax-inclusive) of active Credit/Debit Notes deterministically classified as a return, for the given entity.",
    disclosures: [
      "Only notes classified as a return by their item accounting-allocation pattern are counted; value-adjustment notes are excluded, never netted against sales/purchase totals.",
      "Tax-inclusive only when the party-ledger line of the note is found (exact name match); otherwise the absolute pre-tax item sum is stored.",
    ],
  },
  returnCount: {
    id: "returnCount",
    label: "Return count",
    entities: ["sales_return", "purchase_return"],
    grain: "voucher",
    aggregation: { op: "count" },
    sign: "n/a",
    amountBasis: null,
    status: "supported",
    description: "Number of active Credit/Debit Notes classified as a return.",
    disclosures: [],
  },
  // Product-level return metrics. Confirmed against real WE FOUR data (1,277 sampled active return lines):
  // quantity is always positive on both sides; inventory.amount is Tally's own signed entry (negative on
  // every sales_return line, positive on every purchase_return line - the item's inward/outward accounting
  // sign, not a data error), so returnLineAmount sums the ABSOLUTE value (`abs: true`, compile.js) to read as
  // a positive "value returned" regardless of side. This is the pre-tax LINE-item value (does not reconcile
  // to returnAmount, which is the tax-inclusive voucher total and cannot be safely split across lines without
  // a GST allocation the source data doesn't carry - same basis distinction as lineAmount vs invoiceAmount).
  returnQuantity: {
    id: "returnQuantity",
    label: "Return quantity",
    entities: ["sales_return", "purchase_return"],
    grain: "line",
    aggregation: { op: "sum", path: "inventory.quantity" },
    sign: "positive",
    amountBasis: null,
    status: "supported",
    description: "Sum of returned quantities on active Credit/Debit Note lines classified as a return.",
    disclosures: [],
    caveatRules: [
      {
        code: "mixed_units",
        appliesUnless: { groupByIncludes: ["product"], orFilterOn: ["product"] },
        message: "No unit of measure is stored, so this quantity may add unlike units (e.g. pieces and boxes).",
      },
    ],
  },
  returnLineAmount: {
    id: "returnLineAmount",
    label: "Return value (pre-tax, per item)",
    entities: ["sales_return", "purchase_return"],
    grain: "line",
    aggregation: { op: "sum", path: "inventory.amount", abs: true },
    sign: "positive",
    amountBasis: AMOUNT_BASIS.LINE_ITEM_PRE_TAX,
    status: "supported",
    description: "Sum of the absolute pre-tax item value on active Credit/Debit Note lines classified as a return. Does not reconcile to returnAmount (the tax-inclusive voucher total).",
    disclosures: ["Pre-tax line-item basis; does not reconcile to returnAmount (tax-inclusive voucher total)."],
  },
  lineAmount: {
    id: "lineAmount",
    label: "Line amount (pre-tax)",
    entities: ["sales", "purchase"],
    grain: "line",
    // Tally books PURCHASE stock entries with the opposite (negative) sign (parser fixtures, real purchase documents). entitySign negates them so a
    // purchase figure reads as a positive value. It is a plain sign flip, not abs: opposite-signed lines still net against the rest.
    aggregation: { op: "sum", path: "inventory.amount", entitySign: { purchase: -1 } },
    sign: "positive",
    amountBasis: AMOUNT_BASIS.LINE_ITEM_PRE_TAX,
    status: "supported",
    description: "Pre-tax inventory line amount. Never reconciles to invoiceAmount/purchaseAmount - different basis.",
    disclosures: [
      "Pre-tax line-item basis; does not reconcile to invoice totals.",
      "Item lines only: tax, freight/other charges and vouchers without item lines are not included, so it is not an invoice total before tax.",
      "Purchase item amounts are negated (Tally stores them negative) so purchase values are positive.",
    ],
  },
  quantity: {
    id: "quantity",
    label: "Quantity",
    entities: ["sales", "purchase"],
    grain: "line",
    aggregation: { op: "sum", path: "inventory.quantity" },
    sign: "n/a",
    amountBasis: null,
    status: "supported",
    description: "Sum of line quantities.",
    disclosures: [],
    // No unit of measure is stored in Phase 1, so quantities of different
    // items (pcs, boxes, dozens) are not comparable. Meaningful when
    // grouped by (or filtered to) a single product; otherwise allowed but
    // MUST carry the disclosure.
    caveatRules: [
      {
        code: "mixed_units",
        appliesUnless: { groupByIncludes: ["product"], orFilterOn: ["product"] },
        message: "No unit of measure is stored, so this quantity may add unlike units (e.g. pieces and boxes).",
      },
    ],
  },
  lineCount: {
    id: "lineCount",
    label: "Line count",
    entities: ["sales", "purchase"],
    grain: "line",
    aggregation: { op: "count" },
    sign: "n/a",
    amountBasis: null,
    status: "supported",
    description:
      "Number of inventory lines. NOTE: existing product rankings call this 'orderCount' but it counts LINES, not vouchers - exposed under its true name so parity is honest. (The only non-requested measure; a count, not a financial metric.)",
    disclosures: [],
  },
};

// ---------- comparison ----------
// Compare-derived values, available in having/sort as "<metric>.<suffix>".
// Semantics mirror computeGrowth() exactly; groups present in only one
// period are kept (full outer join on group keys) with the missing side 0.

const COMPARE = {
  modes: ["like_for_like", "full_previous", "same_period_last_year", "custom"],
  derivedSuffixes: {
    previous: { label: "Previous-period value", formula: "value of the same metric in the comparison period (0 if the group is absent)" },
    delta: { label: "Change", formula: "current - previous", parity: "computeGrowth().growthAmount" },
    deltaPct: {
      label: "Change %",
      formula: "(current - previous) / abs(previous) * 100",
      nullWhen: "previous == 0 (never Infinity/NaN, never 0%)",
      parity: "computeGrowth().growthPercentage",
    },
  },
  joinPolicy: "full_outer_on_group_keys",
  // A comparison of groupBy:date buckets has no key overlap between two
  // different periods, so it is meaningless and rejected (see QUERY_RULES).
  notSupportedWith: ["groupBy:date"],
};

// ---------- periods ----------
// The DSL never carries computed dates. Kinds come from periodEngine
// (single source) plus one DSL-level kind:
//   all_time: no date filter at all - the default for "what did I sell to
//   X?". Cannot be compared.
//
// comparisonSupport describes, per kind, what each compare mode resolves to.
//   likeForLike: true  -> periodEngine.resolveComparisonPeriod is non-null
//   fullPrevious:
//     {kind}                       -> explicit previous_X kind (COMPLETE prior period)
//     "equivalent_to_like_for_like"-> the like-for-like window IS already a complete period
//     null                         -> mode not supported for this kind
// The current_X kinds are the ones where the two modes DIFFER while the
// current period is partial - the distinction the DSL exists to make explicit.

const PERIOD_KINDS = [...periodEngine.PERIOD_KINDS, "all_time"];

const COMPARISON_SUPPORT = {
  today: { likeForLike: true, fullPrevious: "equivalent_to_like_for_like" },
  yesterday: { likeForLike: true, fullPrevious: "equivalent_to_like_for_like" },
  current_week: { likeForLike: true, fullPrevious: { kind: "previous_week" }, differsWhenPartial: true },
  previous_week: { likeForLike: true, fullPrevious: "equivalent_to_like_for_like" },
  current_month: { likeForLike: true, fullPrevious: { kind: "previous_month" }, differsWhenPartial: true },
  previous_month: { likeForLike: true, fullPrevious: "equivalent_to_like_for_like" },
  same_month_last_year: { likeForLike: false, fullPrevious: null },
  current_quarter: { likeForLike: true, fullPrevious: { kind: "previous_quarter" }, differsWhenPartial: true },
  previous_quarter: { likeForLike: true, fullPrevious: "equivalent_to_like_for_like" },
  current_fy: { likeForLike: true, fullPrevious: { kind: "previous_fy" }, differsWhenPartial: true },
  previous_fy: { likeForLike: true, fullPrevious: "equivalent_to_like_for_like" },
  specific_fy: {
    likeForLike: true,
    fullPrevious: "equivalent_to_like_for_like",
    // Verified against periodEngine: for the IN-PROGRESS FY, specific_fy
    // returns the WHOLE FY range and compares it to the COMPLETE prior FY -
    // unlike current_fy, which truncates like-for-like. Pre-existing
    // engine behavior, preserved. Validator must warn.
    caveat: "comparison_is_complete_prior_fy_even_when_selected_fy_is_in_progress",
  },
  custom: { likeForLike: false, fullPrevious: null },
  last_7_days: { likeForLike: true, fullPrevious: "equivalent_to_like_for_like" },
  last_30_days: { likeForLike: true, fullPrevious: "equivalent_to_like_for_like" },
  last_90_days: { likeForLike: true, fullPrevious: "equivalent_to_like_for_like" },
  ytd: { likeForLike: true, fullPrevious: null }, // calendar YTD has no "full previous" kind
  all_time: { likeForLike: false, fullPrevious: null, samePeriodLastYear: false },
};

const PERIOD_RULES = {
  customDateFormat: "YYYY-MM-DD",
  maxCustomRangeDays: 1830, // ~5 years; enforced by the Phase 1B validator
  anchor: "reporting_reference_date", // 'current_X' resolves against today (the end of the server's local day), never the latest voucher date
  dayBoundaries: "server_local_calendar_days", // "today" and every period are calendar days of the server's calendar; voucher dates are stored as UTC midnight of the Tally date and are matched by CALENDAR DAY (analytics/dateRanges.js), so the server's time zone never moves a voucher across a period edge
  samePeriodLastYear: "supported for every kind except all_time (uniform year shift of the resolved range)",
};

// ---------- limits (single source for schema + validator) ----------

const LIMITS = {
  defaultLimit: 10,
  defaultSeriesLimit: 100, // groupBy includes date: a lone date series is validated to fit (series_too_long); date + another dimension can still exceed it and is then truncated and flagged
  maxLimit: 100,
  maxGroupBy: 2,
  maxMetrics: 4,
  maxFilters: 5,
  maxHaving: 3,
  maxSort: 2,
  maxInValues: 20,
  maxStringLength: 200,
  minContainsLength: 3,
  maxPlanBytes: 8192,
  queryTimeoutMs: 8000, // maxTimeMS for every aggregation
  maxComplexity: 12, // see COMPLEXITY_WEIGHTS
  maxCompareGroups: 20000, // a comparison must hold both periods' groups in memory; beyond this it is refused, never silently truncated
  maxGroupItemNames: 5000, // item names a productGroup filter may resolve to
  maxRollupRows: 50000, // per-item rows a product-group roll-up may hold in memory; beyond this it is refused, never silently truncated
};

// Query complexity score = base + the sum of what the plan uses. A plan whose
// score exceeds LIMITS.maxComplexity is refused (validator).
const COMPLEXITY_WEIGHTS = {
  base: 1,
  perGroupBy: 1,
  productGroupJoin: 2,
  compare: 2,
  perFilter: 1,
  lineGrain: 1,
  totals: 1,
  perHaving: 1,
};

// ---------- list mode (invoice rows) ----------
// Returns individual invoices. Columns are FIXED (no client column choice)
// and deliberately exclude narration (free text, prompt-injection surface).

const LIST_MODE = {
  columns: {
    sales: ["voucherNo", "date", "customer", "voucherType", "invoiceAmount"],
    purchase: ["voucherNo", "date", "supplier", "voucherType", "purchaseAmount"],
  },
  sortable: {
    sales: ["voucherNo", "date", "customer", "invoiceAmount"],
    purchase: ["voucherNo", "date", "supplier", "purchaseAmount"],
  },
  filterCaveats: {
    productOrGroupFilter: {
      code: "warn_invoice_total_not_product_share",
      message: "Rows are whole invoices that CONTAIN the filtered product/group; the amount shown is the full invoice total, not the product's share.",
    },
  },
};

// ---------- validator rules (Phase 1B implements; declared now) ----------

const QUERY_RULES = [
  { code: "metric_not_applicable_to_entity", description: "Every metric/dimension must apply to the plan's entity (see METRICS/DIMENSIONS.entities)." },
  { code: "mixed_metric_grains", description: "Voucher-grain and line-grain metrics cannot share one plan (would double-count invoice totals across lines)." },
  { code: "dimension_not_applicable_to_voucher_metric", description: "Voucher-grain metrics cannot be grouped by product/productGroup: an invoice total cannot be attributed to a product without inventing an allocation." },
  { code: "compare_not_supported_with_date_groupby", description: "compare + groupBy:date is rejected: two different periods share no date buckets." },
  { code: "compare_mode_unsupported_for_period", description: "compare.mode must be supported for the period kind (COMPARISON_SUPPORT)." },
  { code: "derived_ref_requires_compare", description: "having/sort refs ending in .previous/.delta/.deltaPct require `compare`." },
  { code: "ref_not_selected", description: "having/sort may only reference selected metrics (or their derived suffixes) or groupBy dimensions." },
  { code: "high_cardinality_requires_sort", description: "Grouping by a high-cardinality dimension (customer/supplier/product) requires an explicit sort." },
  { code: "series_too_long", description: "A date series must not exceed maxLimit buckets for the resolved range; use a coarser bucket." },
  { code: "range_too_long", description: "Custom range must not exceed maxCustomRangeDays." },
  { code: "all_time_cannot_compare", description: "period.kind=all_time has no comparison." },
  { code: "list_mode_shape", description: "list mode: no metrics/groupBy/having/compare; sort must be a sortable column." },
  { code: "warn_specific_fy_partial_comparison", description: "Warning (not error): specific_fy of an in-progress FY compares against the complete prior FY." },
  { code: "dimension_not_applicable_to_entity", description: "A groupBy/filter dimension must exist on the plan's entity (customer is sales-only, supplier purchase-only)." },
  { code: "having_requires_groupby", description: "having filters grouped rows, so it requires a groupBy." },
  { code: "metric_unsupported", description: "The metric's catalog status is not 'supported'." },
  { code: "complexity_too_high", description: "Plan complexity score exceeds LIMITS.maxComplexity." },
  { code: "reference_date_required", description: "Relative periods (current_X, last_N_days, ...) need the tenant reference date supplied by the backend." },
  { code: "period_invalid", description: "The period could not be resolved by periodEngine." },
  { code: "warn_invoice_total_not_product_share", description: "Warning: invoice-level amounts filtered by a product/group are whole-invoice values, not the product's share." },
  { code: "warn_mixed_units", description: "Warning attached when quantity or returnQuantity is not unit-safe (see their caveatRules)." },
  { code: "warn_unmapped_product_group_lines", description: "Warning (executor): item lines whose item has no Stock Group in the synced master are excluded from a productGroup breakdown and its total." },
];

// ---------- honest refusals ----------
// Sales/Purchase-adjacent capabilities that Phase 1 data cannot answer
// correctly. `unlocks` names the data that would be needed - documentation
// for later phases, NOT work to do now.

// Named once: the planner prompt shows them as examples and the reason text below is built from the same list.
const OTHER_DOMAIN_EXAMPLES = ["orders", "delivery notes", "stock valuation", "payroll", "expenses"];

const UNSUPPORTED_CAPABILITIES = [
  {
    id: "tax_breakdown",
    reason:
      "GST/tax amounts are not modelled, and there is no invoice-level total before tax: sales are shown as invoice totals including tax, or as revenue (the pre-tax value of the item lines only, which is not an invoice total before tax).",
    unlocks: "identifying the tax ledger lines of each voucher (later phase)",
  },
  {
    id: "net_of_returns",
    reason:
      'Sales and purchase totals are shown gross of returns: Credit/Debit Notes are never netted against them, and one query cannot combine sales with returns. Net sales (turnover: invoice sales after returns and before tax) therefore cannot be calculated. Sales/purchase returns themselves can be asked directly, for example "sales returns this month" or "purchase returns this month"; return reasons, return rate, partial/full status, GST-head impact and product-group returns are not available yet.',
    unlocks: "a combined sales-and-returns calculation on a before-tax basis, return rate, product-group returns",
  },
  { id: "profit_margin", reason: "No cost/COGS data is available.", unlocks: "cost data (later phase)" },
  { id: "discount_analysis", reason: "Discounts cannot be queried yet: they are stored per item line only for recently synced vouchers (older vouchers read zero until back-filled), and no discount metric exists.", unlocks: "a discount metric after the back-fill (later phase)" },
  { id: "cancelled_invoices", reason: "Cancelled vouchers are not reliably stored, so their counts would be wrong.", unlocks: "sync change (later phase)" },
  { id: "sales_by_region_or_salesperson", reason: "State, region, customer group and salesperson are not stored in this phase.", unlocks: "party master (later phase)" },
  { id: "cross_entity_comparison", reason: "A single query covers sales OR purchases; ask them as two questions.", unlocks: "multi-entity plans (not planned)" },
  { id: "outstanding_or_payments", reason: "Receipts, payments and balances are outside Sales/Purchase in this phase.", unlocks: "receipt/payment sync (later phase)" },
  {
    id: "other_accounting_domains",
    examples: OTHER_DOMAIN_EXAMPLES,
    reason: `${OTHER_DOMAIN_EXAMPLES.join(", ").replace(/^./, (c) => c.toUpperCase())} and other accounting areas are outside Sales/Purchase in this phase.`,
    unlocks: "new Tally data (later phases)",
  },
];

// ---------- parity oracles (Phase 1C ground truth) ----------
// The EXISTING analytics are the oracle. `independent` = no existing
// function covers the shape, so the harness must use an independently
// written aggregation (as was done for Stock Groups) and the capability
// stays `pending` until that parity passes.

const PARITY_ORACLES = [
  { id: "sales_summary", entity: "sales", shape: "totals (invoiceAmount, invoiceCount, averageInvoiceValue)", oracle: { module: "salesAnalytics", fn: "getSalesSummary" } },
  { id: "sales_by_customer", entity: "sales", shape: "groupBy customer, invoiceAmount/invoiceCount, sort+limit", oracle: { module: "salesAnalytics", fn: "getTopCustomers" } },
  { id: "sales_customer_lookup", entity: "sales", shape: "filter customer eq_ci, period all_time/any", oracle: { module: "salesAnalytics", fn: "getCustomerSales" } },
  { id: "sales_by_product", entity: "sales", shape: "groupBy product, lineAmount/quantity/lineCount", oracle: { module: "salesAnalytics", fn: "getTopProducts" }, note: "existing 'orderCount' == lineCount" },
  { id: "sales_by_product_group", entity: "sales", shape: "groupBy productGroup, lineAmount/quantity + compare", oracle: { module: "stockGroupAnalytics", fn: "getTopStockGroups" } },
  { id: "sales_trend", entity: "sales", shape: "groupBy date:month, invoiceAmount/invoiceCount", oracle: { module: "salesAnalytics", fn: "getSalesTrend" } },
  { id: "sales_period_comparison", entity: "sales", shape: "compare, totals + delta/deltaPct", oracle: { module: "salesAnalytics", fn: "getSalesComparison" } },
  { id: "sales_product_growth_decline", entity: "sales", shape: "groupBy product + compare, sort lineAmount.delta", oracle: { module: "salesAnalytics", fn: "getDecliningProducts" } },
  { id: "purchase_summary", entity: "purchase", shape: "totals", oracle: { module: "purchaseAnalytics", fn: "getPurchaseSummary" } },
  { id: "purchase_by_supplier", entity: "purchase", shape: "groupBy supplier", oracle: { module: "purchaseAnalytics", fn: "getTopSuppliers" } },
  { id: "purchase_by_product", entity: "purchase", shape: "groupBy product", oracle: { module: "purchaseAnalytics", fn: "getTopPurchasedProducts" }, note: "existing 'orderCount' == lineCount" },
  { id: "purchase_trend", entity: "purchase", shape: "groupBy date:month", oracle: { module: "purchaseAnalytics", fn: "getPurchaseTrend" } },
  { id: "purchase_period_comparison", entity: "purchase", shape: "compare, totals", oracle: { module: "purchaseAnalytics", fn: "getPurchaseComparison" } },
  { id: "purchase_by_product_group", entity: "purchase", shape: "groupBy productGroup", oracle: null, independent: true, note: "no existing purchase stock-group analytics; independent aggregation required, capability pending until parity passes" },
  { id: "invoice_list", entity: "sales", shape: "list mode (largest invoices, invoices for a customer/product)", oracle: null, independent: true, note: "no existing function lists invoices; independent aggregation required (also applies to purchase list mode)" },
];

// ---------- catalog assembly ----------

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const CATALOG = deepFreeze({
  version: CATALOG_VERSION,
  amountBasis: AMOUNT_BASIS,
  entities: ENTITIES,
  dimensions: DIMENSIONS,
  metrics: METRICS,
  compare: COMPARE,
  periods: { kinds: PERIOD_KINDS, comparisonSupport: COMPARISON_SUPPORT, rules: PERIOD_RULES },
  limits: LIMITS,
  complexityWeights: COMPLEXITY_WEIGHTS,
  listMode: LIST_MODE,
  queryRules: QUERY_RULES,
  unsupported: UNSUPPORTED_CAPABILITIES,
  parityOracles: PARITY_ORACLES,
});

// Stable serialization (sorted keys) so the fingerprint is deterministic.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Content hash: the answer cache (Phase 1E) keys on this, so a catalog edit
// invalidates cached answers automatically even if CATALOG_VERSION is
// forgotten.
function computeFingerprint(catalog = CATALOG) {
  return crypto.createHash("sha256").update(stableStringify(catalog)).digest("hex").slice(0, 16);
}

// ---------- accessors ----------

function metricsForEntity(entityId) {
  return Object.values(METRICS).filter((m) => m.entities.includes(entityId));
}
function dimensionsForEntity(entityId) {
  return Object.values(DIMENSIONS).filter((d) => d.entities.includes(entityId));
}
function metricRefs() {
  const suffixes = Object.keys(COMPARE.derivedSuffixes);
  const ids = Object.keys(METRICS);
  return [...ids, ...ids.flatMap((id) => suffixes.map((s) => `${id}.${s}`))];
}

// ---------- compatibility matrix ----------
// Cell for (metric x groupBy dimension) within one entity:
//   ok | ok_with_caveat{code} | invalid{code,reason}
// Derived from the metric/dimension definitions above, so it cannot drift
// from them; the Phase 1B validator reads THIS, not hand-written rules.

function compatibilityCell(metric, dim) {
  if (!dim.grains.includes(metric.grain)) {
    return {
      status: "invalid",
      code: "dimension_not_applicable_to_voucher_metric",
      reason: `${metric.label} is an invoice-level value and cannot be attributed to ${dim.label.toLowerCase()} without inventing a tax/freight allocation. Use a line-level metric (${metric.entities.some((e) => e.endsWith("_return")) ? "returnLineAmount" : "lineAmount"}) for ${dim.label.toLowerCase()} breakdowns.`,
    };
  }
  if (metric.caveatRules) {
    for (const rule of metric.caveatRules) {
      if (!rule.appliesUnless.groupByIncludes.includes(dim.id)) {
        return { status: "ok_with_caveat", code: rule.code };
      }
    }
  }
  return { status: "ok" };
}

function buildCompatibilityMatrix(entityId) {
  const metrics = metricsForEntity(entityId);
  const dims = dimensionsForEntity(entityId);
  const matrix = {};
  for (const m of metrics) {
    matrix[m.id] = {};
    for (const d of dims) matrix[m.id][d.id] = compatibilityCell(m, d);
  }
  return matrix;
}

module.exports = {
  CATALOG,
  CATALOG_VERSION,
  AMOUNT_BASIS,
  PERIOD_KINDS,
  COMPARISON_SUPPORT,
  LIMITS,
  COMPLEXITY_WEIGHTS,
  LIST_MODE,
  COMPARE,
  UNSUPPORTED_CAPABILITIES,
  PARITY_ORACLES,
  QUERY_RULES,
  computeFingerprint,
  metricsForEntity,
  dimensionsForEntity,
  metricRefs,
  buildCompatibilityMatrix,
};
