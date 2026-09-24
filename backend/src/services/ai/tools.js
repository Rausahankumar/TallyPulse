const { z } = require("zod");

const salesAnalytics = require("../analytics/salesAnalytics");
const purchaseAnalytics = require("../analytics/purchaseAnalytics");
const stockGroupAnalytics = require("../analytics/stockGroupAnalytics");
const dateRanges = require("../analytics/dateRanges");
const periodEngine = require("../analytics/periodEngine");
const { getTenantReferenceDate } = require("../analytics/referenceDate");
const { wrapAnalyticsResult } = require("../analytics/trustEnvelope");

// --------------------------------------------------
// The controlled, read-only tool layer Claude is allowed to call.
//
// SECURITY MODEL (see Part 12/13 of the architecture report for the
// full reasoning):
//  - Every tool's argument schema uses zod .strict(), so an unexpected
//    key (e.g. Claude - or a prompt-injected user message - trying to
//    smuggle a tenantId/companyId/companyGuId into the arguments) is
//    REJECTED outright, not silently stripped. Tool schemas below never
//    even declare a tenant/company field in the first place.
//  - Tenant/company context is a function PARAMETER (`context`),
//    supplied by the caller (the chat controller) from the
//    server-verified companyContext (see
//    src/services/auth/companyContext.js) - never from `args`, never
//    from anything Claude returns. A tool handler physically cannot see
//    a tenantId that didn't come from resolveAuthorizedCompany().
//  - Every tool is read-only: it calls into analyticsEngine functions
//    that only ever run MongoDB aggregation reads. No tool exists that
//    writes, deletes, or executes arbitrary code/queries. There is no
//    "raw query" or "run aggregation pipeline" tool - only fixed,
//    named, pre-built analytics functions with validated arguments.
//  - Every result is wrapped via wrapAnalyticsResult, so a tool never
//    returns a bare number without its freshness/validity state
//    attached.
// --------------------------------------------------

const PERIOD_KINDS = [
  "current_month",
  "previous_month",
  "custom",
];

const periodSchema = z
  .object({
    period: z.enum(PERIOD_KINDS).default("current_month"),
    from: z.string().optional(), // ISO date, required when period === "custom"
    to: z.string().optional(),
  })
  .strict();

function resolvePeriod({ period, from, to }, referenceDate = new Date()) {
  if (period === "custom") {
    if (!from || !to) {
      throw new Error('period "custom" requires both from and to.');
    }
    return dateRanges.customRange(from, to);
  }

  if (period === "previous_month") {
    return dateRanges.previousFullMonth(referenceDate);
  }

  return dateRanges.currentMonthToDate(referenceDate);
}

const comparisonSchema = z
  .object({
    comparisonType: z
      .enum(["vs_previous_month", "vs_same_month_last_year"])
      .default("vs_previous_month"),
  })
  .strict();

const limitSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

const limitWithComparisonSchema = z
  .object({
    comparisonType: z
      .enum(["vs_previous_month", "vs_same_month_last_year"])
      .default("vs_previous_month"),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

// Scoped to get_customer_sales ONLY - deliberately not merged into
// PERIOD_KINDS/periodSchema above, so adding "all_time" support here
// cannot change the behavior of any other existing tool (get_sales_summary,
// get_top_customers, etc. all keep their original 3-value period enum,
// byte-for-byte unchanged).
const CUSTOMER_PERIOD_KINDS = ["all_time", "current_month", "previous_month", "custom"];

const customerSalesSchema = z
  .object({
    customerName: z.string().min(1),
    period: z.enum(CUSTOMER_PERIOD_KINDS).default("all_time"),
    from: z.string().optional(), // ISO date, required when period === "custom"
    to: z.string().optional(),
  })
  .strict();

function resolveCustomerPeriod({ period, from, to }, referenceDate = new Date()) {
  if (period === "all_time") {
    // No from/to at all - buildVoucherMatchStage() already treats a
    // missing from/to as "no date filter", so this is genuinely
    // unbounded, not a synthetic wide range.
    return { from: undefined, to: undefined, label: "All time", isPartial: false };
  }
  // Reuse the exact same date math as every other tool for the 3 shared
  // kinds - never a second implementation of "what does previous_month mean".
  return resolvePeriod({ period, from, to }, referenceDate);
}

// --------------------------------------------------
// get_stock_group_performance ONLY. Deliberately reuses periodEngine.js
// (the full 17-kind period engine already built, tested - 61/61 - and
// approved for the Stock Group analytics REST endpoint) rather than
// tools.js's own narrower PERIOD_KINDS/resolvePeriod above (3 kinds,
// wall-clock referenceDate). Two reasons this is a genuine exception,
// not an inconsistency to "fix" elsewhere:
//   1. The task requires current_quarter/previous_quarter/current_fy/
//      previous_fy/same_month_last_year, none of which the older
//      resolvePeriod supports - extending IT would change behavior for
//      every existing tool that already uses it.
//   2. Stock Group performance is anchored to this tenant's own latest
//      synced voucher date (getTenantReferenceDate), not the wall clock
//      - the same anchoring already used by the REST endpoint
//      (analyticsController.js) and by Dashboard/Analytics generally.
//      A tenant whose sync has fallen behind the wall clock would
//      otherwise get a permanently-empty "current quarter" here, same
//      failure mode already fixed everywhere else in the app.
// Every other existing tool's date resolution is completely unchanged.
const stockGroupPeriodSchema = z
  .object({
    period: z.enum(periodEngine.PERIOD_KINDS).default("current_month"),
    from: z.string().optional(), // ISO date, required when period === "custom"
    to: z.string().optional(),
    fy: z.string().optional(), // e.g. "2025-26", required when period === "specific_fy"
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

function resolveComparisonPeriods(comparisonType, referenceDate = new Date()) {
  if (comparisonType === "vs_same_month_last_year") {
    return {
      current: dateRanges.currentMonthToDate(referenceDate),
      previous: dateRanges.sameMonthLastYearToDate(referenceDate),
    };
  }
  return {
    current: dateRanges.currentMonthToDate(referenceDate),
    previous: dateRanges.previousMonthSameRange(referenceDate),
  };
}

// --------------------------------------------------
// Tool definitions: Anthropic tool-use JSON schema + a validated handler.
// Handler signature: async (rawArgs, context) => trust envelope
// context = { tenantId, companyGuid } - always server-derived.
// --------------------------------------------------

const TOOLS = [
  {
    name: "get_sales_summary",
    description:
      "Get total sales amount, order count, and average order value for a period (current month to date, previous full month, or a custom date range). Only includes active (non-cancelled, non-deleted) vouchers.",
    input_schema: zodToJsonSchema(periodSchema),
    handler: async (rawArgs, context) => {
      const args = periodSchema.parse(rawArgs || {});
      const period = resolvePeriod(args);
      return wrapAnalyticsResult({
        tenantId: context.tenantId,
        voucherType: "Sales",
        run: () => salesAnalytics.getSalesSummary(context.tenantId, period),
      });
    },
  },

  {
    name: "get_sales_comparison",
    description:
      "Compare current sales (month to date) against a prior comparable period: either the same date range last month, or the same date range in the same month last year. Returns both totals and the growth amount/percentage.",
    input_schema: zodToJsonSchema(comparisonSchema),
    handler: async (rawArgs, context) => {
      const args = comparisonSchema.parse(rawArgs || {});
      const { current, previous } = resolveComparisonPeriods(args.comparisonType);
      return wrapAnalyticsResult({
        tenantId: context.tenantId,
        voucherType: "Sales",
        run: () => salesAnalytics.getSalesComparison(context.tenantId, current, previous),
      });
    },
  },

  {
    name: "get_sales_growth",
    description:
      "Get the sales growth percentage and amount compared to a prior period (same phrasing as get_sales_comparison - use whichever name best matches the user's question).",
    input_schema: zodToJsonSchema(comparisonSchema),
    handler: async (rawArgs, context) => {
      const args = comparisonSchema.parse(rawArgs || {});
      const { current, previous } = resolveComparisonPeriods(args.comparisonType);
      return wrapAnalyticsResult({
        tenantId: context.tenantId,
        voucherType: "Sales",
        run: () => salesAnalytics.getSalesComparison(context.tenantId, current, previous),
      });
    },
  },

  {
    name: "get_top_products",
    description:
      "Get the top-selling INDIVIDUAL products by revenue for a period. Returns item name, total amount, total quantity, and order count per product. Use get_stock_group_performance instead if the user asks about product GROUPS or categories (e.g. 'top product groups', 'sales by category') rather than individual products.",
    input_schema: zodToJsonSchema(periodSchema.merge(limitSchema)),
    handler: async (rawArgs, context) => {
      const args = periodSchema.merge(limitSchema).strict().parse(rawArgs || {});
      const period = resolvePeriod(args);
      return wrapAnalyticsResult({
        tenantId: context.tenantId,
        voucherType: "Sales",
        run: () =>
          salesAnalytics.getTopProducts(context.tenantId, period, { limit: args.limit }),
      });
    },
  },

  {
    name: "get_product_growth",
    description:
      "Get the fastest-growing products by comparing per-product sales between the current period and a prior comparable period. New products (no sales in the prior period) are flagged as new rather than given a fabricated growth percentage.",
    input_schema: zodToJsonSchema(limitWithComparisonSchema),
    handler: async (rawArgs, context) => {
      const args = limitWithComparisonSchema.parse(rawArgs || {});
      const { current, previous } = resolveComparisonPeriods(args.comparisonType);
      return wrapAnalyticsResult({
        tenantId: context.tenantId,
        voucherType: "Sales",
        run: () =>
          salesAnalytics.getTopGrowingProducts(context.tenantId, current, previous, {
            limit: args.limit,
          }),
      });
    },
  },

  {
    name: "get_declining_products",
    description:
      "Get products with declining sales, comparing the current period to a prior comparable period.",
    input_schema: zodToJsonSchema(limitWithComparisonSchema),
    handler: async (rawArgs, context) => {
      const args = limitWithComparisonSchema.parse(rawArgs || {});
      const { current, previous } = resolveComparisonPeriods(args.comparisonType);
      return wrapAnalyticsResult({
        tenantId: context.tenantId,
        voucherType: "Sales",
        run: () =>
          salesAnalytics.getDecliningProducts(context.tenantId, current, previous, {
            limit: args.limit,
          }),
      });
    },
  },

  {
    name: "get_top_customers",
    description:
      "Get the RANKED LIST of top customers by total sales amount for a period. Returns customer name, total amount, and order count. Use this for ranking/listing questions ('who are my top customers', 'biggest customers') - NOT for a question about one specific named customer (use get_customer_sales for that instead; this tool cannot look up a single customer by name). Only call this when the user is actually asking about customers - it returns customer names, which should not be included in answers to questions that don't need them.",
    input_schema: zodToJsonSchema(periodSchema.merge(limitSchema)),
    handler: async (rawArgs, context) => {
      const args = periodSchema.merge(limitSchema).strict().parse(rawArgs || {});
      const period = resolvePeriod(args);
      return wrapAnalyticsResult({
        tenantId: context.tenantId,
        voucherType: "Sales",
        run: () =>
          salesAnalytics.getTopCustomers(context.tenantId, period, { limit: args.limit }),
      });
    },
  },

  {
    name: "get_customer_sales",
    description:
      'Get total sales, order count, and average order value for ONE specific NAMED customer (e.g. "sales for DHINGRA GENERAL STORE", "how much has X bought from us", "X\'s sales last month"). Defaults to period "all_time" (the customer\'s full historical total) when the user does not name a period - never default to current_month/previous_month for a named-customer question, since that would silently hide real historical data. Use current_month/previous_month/custom only when the user actually names that period. Do NOT use get_top_customers for this - that tool only ranks customers within a period and cannot look up one customer by name. The result must be phrased according to its fields: customerFound=false -> tell the user no matching customer was found (do not imply anything about their sales history); customerFound=true with orderCount=0 -> tell the user no sales were found for this customer in the requested period specifically (never say they have never purchased from you - they may simply have no sales in this particular period); customerFound=true with orderCount>0 -> report totalSales/orderCount/averageOrderValue.',
    input_schema: zodToJsonSchema(customerSalesSchema),
    handler: async (rawArgs, context) => {
      const args = customerSalesSchema.parse(rawArgs || {});
      const period = resolveCustomerPeriod(args);
      return wrapAnalyticsResult({
        tenantId: context.tenantId,
        voucherType: "Sales",
        run: () =>
          salesAnalytics.getCustomerSales(context.tenantId, args.customerName, period),
      });
    },
  },

  {
    name: "get_category_performance",
    description:
      "NOTE: for a generic 'category' word with no further context, prefer get_stock_group_performance instead - Tally's own Stock Group master data DOES support real group-level performance (unlike a category label, which this tool cannot compute). Calling this tool returns an explicit unsupported-capability result, not fabricated category data.",
    input_schema: zodToJsonSchema(periodSchema),
    handler: async (rawArgs, context) => {
      return wrapAnalyticsResult({
        tenantId: context.tenantId,
        voucherType: "Sales",
        run: () => salesAnalytics.getCategoryPerformance(),
      });
    },
  },

  {
    name: "get_stock_group_performance",
    description:
      "Get sales performance by STOCK GROUP / PRODUCT GROUP (not individual products) - total sales amount and quantity per group, ranked highest first, for a period. Use this for questions like 'top product groups', 'best-selling categories', 'sales by product group'. Stock Group names come directly from Tally's own Stock Group master data (via Sale.inventory.itemName -> StockItemMaster.stockGroupName) - use them EXACTLY as returned in your answer, never rename, translate, or generalize them into your own category labels (e.g. if the result says the group is named \"Oddy\", say \"Oddy\" - never turn it into something like \"Stationery\" or \"Adhesives\"). Supports the same period kinds as the rest of the analytics: current_month, previous_month, current_quarter, previous_quarter, current_fy, previous_fy, same_month_last_year, specific_fy (pass fy, e.g. \"2025-26\"), custom (pass from/to), plus today/yesterday/current_week/previous_week/last_7_days/last_30_days/last_90_days/ytd - the backend resolves the exact date range for you, you never compute dates yourself. Quarters are financial-year-aligned (Q1 Apr-Jun ... Q4 Jan-Mar), not calendar quarters. Each result item includes momGrowthPercentage and yoyGrowthPercentage, which are null (not 0%) whenever no comparable prior-period data exists - if either is null, tell the user that comparison is unavailable, never state or imply a 0% change or invent a number. IMPORTANT - what previousPeriod/momGrowth actually is: when called with a \"current_X\" period kind (current_month/current_week/current_quarter/current_fy), the result's previousPeriod and momGrowth compare against a SAME-DURATION, like-for-like prior period, not the full previous calendar/FY period - e.g. if current_quarter is Oct 1 - Dec 8 (in progress), previousPeriod is Jul 1 - Sep 8 (the same 69 elapsed days last quarter), NOT the complete Jul 1 - Sep 30. This is deliberate: comparing an in-progress period's growth against a full prior period would produce a misleading percentage. previousPeriod/momGrowth from a current_X call is the right baseline for \"how are we trending vs last period\" questions - use it directly, no second call needed. But if the user explicitly asks for the FULL/complete previous quarter, month, week, or FY (its own figures, not a growth baseline), that is a genuinely different date range this result does not contain - call this tool again with the explicit period kind instead (period: \"previous_quarter\", \"previous_month\", \"previous_week\", or \"previous_fy\"), which always returns the complete prior period. The result's amountBasis field (always \"line_item_pre_tax\") means every sales figure is the pre-tax line-item amount, not the tax/freight/rounding-corrected invoice total - mention this if the user asks about exact invoice totals or margins. The mapping field reports mappedLines/unmappedLines/mappedAmount/unmappedAmount - if unmappedAmount is a material share of the period's real sales, say so, so the ranking isn't presented as more complete than it actually is.",
    input_schema: zodToJsonSchema(stockGroupPeriodSchema),
    handler: async (rawArgs, context) => {
      const args = stockGroupPeriodSchema.parse(rawArgs || {});
      const referenceDate = await getTenantReferenceDate(context.tenantId);
      const options = {};
      if (args.period === "custom") {
        options.from = args.from;
        options.to = args.to;
      }
      if (args.period === "specific_fy") {
        options.fy = args.fy;
      }

      const current = periodEngine.resolvePeriod(args.period, referenceDate, options);
      const previous = periodEngine.resolveComparisonPeriod(args.period, referenceDate, options);
      const sameLastYear = periodEngine.resolveSamePeriodLastYear(args.period, referenceDate, options);

      return wrapAnalyticsResult({
        tenantId: context.tenantId,
        voucherType: "Sales",
        run: () =>
          stockGroupAnalytics.getTopStockGroups(context.tenantId, current, previous, sameLastYear, {
            limit: args.limit,
          }),
      });
    },
  },

  {
    name: "get_purchase_summary",
    description:
      "Get total purchase amount, order count, and average order value for a period.",
    input_schema: zodToJsonSchema(periodSchema),
    handler: async (rawArgs, context) => {
      const args = periodSchema.parse(rawArgs || {});
      const period = resolvePeriod(args);
      return wrapAnalyticsResult({
        tenantId: context.tenantId,
        voucherType: "Purchase",
        run: () => purchaseAnalytics.getPurchaseSummary(context.tenantId, period),
      });
    },
  },

  {
    name: "get_purchase_growth",
    description:
      "Compare current purchases (month to date) against the same date range last month, returning the growth amount/percentage.",
    input_schema: zodToJsonSchema(z.object({}).strict()),
    handler: async (_rawArgs, context) => {
      return wrapAnalyticsResult({
        tenantId: context.tenantId,
        voucherType: "Purchase",
        run: () => purchaseAnalytics.getPurchaseGrowthVsPreviousMonth(context.tenantId),
      });
    },
  },
];

// zod v4 ships native JSON Schema conversion (z.toJSONSchema) - used
// directly rather than hand-rolling a converter or pulling in a
// separate zod-to-json-schema package.
function zodToJsonSchema(schema) {
  const jsonSchema = z.toJSONSchema(schema);
  // Anthropic's tool input_schema doesn't use/want the draft $schema
  // marker zod includes by default.
  const { $schema, ...rest } = jsonSchema;
  return rest;
}

const TOOL_HANDLERS = Object.fromEntries(TOOLS.map((t) => [t.name, t.handler]));
const TOOL_DEFINITIONS = TOOLS.map(({ name, description, input_schema }) => ({
  name,
  description,
  input_schema,
}));

module.exports = {
  TOOLS,
  TOOL_HANDLERS,
  TOOL_DEFINITIONS,
  // Exported additionally so the REST analytics API (analyticsController.js)
  // can reuse the exact same period/comparison resolution the Claude tool
  // layer already uses, instead of re-implementing it - one definition of
  // "what does period=custom or comparisonType=vs_previous_month mean."
  resolvePeriod,
  resolveComparisonPeriods,
  periodSchema,
  comparisonSchema,
  limitSchema,
  stockGroupPeriodSchema,
};
