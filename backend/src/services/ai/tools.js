const { z } = require("zod");

const salesAnalytics = require("../analytics/salesAnalytics");
const purchaseAnalytics = require("../analytics/purchaseAnalytics");
const dateRanges = require("../analytics/dateRanges");
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
      "Get the top-selling products by revenue for a period. Returns item name, total amount, total quantity, and order count per product.",
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
      "Get the top customers by total sales amount for a period. Returns customer name, total amount, and order count. Only call this when the user is actually asking about customers - it returns customer names, which should not be included in answers to questions that don't need them.",
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
    name: "get_category_performance",
    description:
      "Get sales performance broken down by product category. NOTE: not currently supported by the underlying data - calling this will return an explicit unsupported-capability result, not fabricated category data.",
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
};
