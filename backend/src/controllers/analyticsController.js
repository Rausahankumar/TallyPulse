const salesAnalytics = require("../services/analytics/salesAnalytics");
const purchaseAnalytics = require("../services/analytics/purchaseAnalytics");
const dateRanges = require("../services/analytics/dateRanges");
const periodEngine = require("../services/analytics/periodEngine");
const stockGroupAnalytics = require("../services/analytics/stockGroupAnalytics");
const { getTenantReferenceDate } = require("../services/analytics/referenceDate");
const { wrapAnalyticsResult } = require("../services/analytics/trustEnvelope");

// --------------------------------------------------
// Read-only REST surface over the deterministic Analytics Engine
// (src/services/analytics/*) - the same calculations and the same
// analyticsScope tenant/active-voucher gating the query engine is checked
// against (verify-query-parity.js). Nothing here recomputes a business
// number - every handler below parses HTTP query params into a period or
// comparison (dateRanges.resolveRequestPeriod / resolveRequestComparison, or
// periodEngine) and calls the analytics function.
//
// Company/tenant context is never read from the query string or body -
// it comes from req.companyContext, set by the activeCompanyContext
// middleware (src/services/auth/companyContext.js), which re-derives
// the tenant from the authenticated user's own authorized company.
//
// Every response is the trust envelope wrapAnalyticsResult already
// produces ({state, data, freshness, message}) - the same contract the
// frontend's FreshnessBadge is already built to
// read - spread directly into the HTTP body, never reshaped.
// --------------------------------------------------

const PERIOD_KINDS = ["current_month", "previous_month", "custom"];
const COMPARISON_KINDS = ["vs_previous_month", "vs_same_month_last_year"];

// `referenceDate` anchors what "current_month"/"previous_month" actually
// mean - see services/analytics/referenceDate.js for why this is the
// tenant's own latest voucher date, not necessarily the wall clock.
// Every caller below computes it once per request and threads it
// through; period="custom" ignores it entirely (an explicit from/to
// needs no anchor).
function parsePeriodFromQuery(query, referenceDate) {
  const period = query.period || "current_month";

  if (!PERIOD_KINDS.includes(period)) {
    const err = new Error(`Invalid period "${period}". Expected one of: ${PERIOD_KINDS.join(", ")}.`);
    err.status = 400;
    throw err;
  }

  if (period === "custom" && (!query.from || !query.to)) {
    const err = new Error('period "custom" requires both "from" and "to" query params.');
    err.status = 400;
    throw err;
  }

  try {
    return dateRanges.resolveRequestPeriod({ period, from: query.from, to: query.to }, referenceDate);
  } catch (error) {
    error.status = error.status || 400;
    throw error;
  }
}

// Default window for a trend chart when the caller hasn't picked an
// explicit range: the last 6 complete months ending at the tenant's own
// reference date (see above) - not a hardcoded set of months.
function parseTrendPeriodFromQuery(query, referenceDate) {
  if (query.from && query.to) {
    try {
      return dateRanges.customRange(query.from, query.to);
    } catch (error) {
      error.status = 400;
      throw error;
    }
  }
  return dateRanges.lastNMonthsEnding(referenceDate, 6);
}

function parseComparisonTypeFromQuery(query) {
  const comparisonType = query.comparisonType || "vs_previous_month";

  if (!COMPARISON_KINDS.includes(comparisonType)) {
    const err = new Error(
      `Invalid comparisonType "${comparisonType}". Expected one of: ${COMPARISON_KINDS.join(", ")}.`
    );
    err.status = 400;
    throw err;
  }

  return comparisonType;
}

function parseLimitFromQuery(query) {
  if (query.limit === undefined) return 10;

  const limit = Number.parseInt(query.limit, 10);

  if (!Number.isFinite(limit) || limit < 1 || limit > 50) {
    const err = new Error('Invalid "limit". Expected an integer between 1 and 50.');
    err.status = 400;
    throw err;
  }

  return limit;
}

// Stock Group performance uses the NEW, richer period engine
// (periodEngine.js) - its own period-kind set (17 kinds, see that
// file), completely separate from PERIOD_KINDS/parsePeriodFromQuery
// above, which stays exactly as it was for every existing endpoint.
// Adding this parser changes no existing endpoint's accepted query
// params or behavior.
function parseStockGroupPeriodFromQuery(query, referenceDate) {
  const kind = query.period || "current_month";

  if (!periodEngine.PERIOD_KINDS.includes(kind)) {
    const err = new Error(`Invalid period "${kind}". Expected one of: ${periodEngine.PERIOD_KINDS.join(", ")}.`);
    err.status = 400;
    throw err;
  }

  const options = {};
  if (kind === "custom") {
    if (!query.from || !query.to) {
      const err = new Error('period "custom" requires both "from" and "to" query params.');
      err.status = 400;
      throw err;
    }
    options.from = query.from;
    options.to = query.to;
  }
  if (kind === "specific_fy") {
    if (!query.fy) {
      const err = new Error('period "specific_fy" requires an "fy" query param (e.g. "2025-26").');
      err.status = 400;
      throw err;
    }
    options.fy = query.fy;
  }

  try {
    const current = periodEngine.resolvePeriod(kind, referenceDate, options);
    // resolveComparisonPeriod legitimately returns null for "custom" and
    // "same_month_last_year" (no single natural MoM-style comparison) -
    // passed through as null, never guessed into something.
    const previous = periodEngine.resolveComparisonPeriod(kind, referenceDate, options);
    const sameLastYear = periodEngine.resolveSamePeriodLastYear(kind, referenceDate, options);
    return { current, previous, sameLastYear };
  } catch (error) {
    error.status = error.status || 400;
    throw error;
  }
}

// Wraps a handler so any thrown error (bad query params, or anything
// unexpected) becomes a clean HTTP error response instead of a 500 with
// no message - matches the pattern already used across
// authController/importController.
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      // Validation errors carry a 4xx status and a message we wrote; anything
      // else is logged and answered generically (audit F-12).
      const status = error.status >= 400 && error.status < 500 ? error.status : 500;

      if (status === 500) console.error("ANALYTICS ERROR:", error);

      return res.status(status).json({
        success: false,
        message: status === 500 ? "Something went wrong on the server. Please try again." : error.message,
      });
    }
  };
}

const getSalesSummary = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parsePeriodFromQuery(req.query, referenceDate);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => salesAnalytics.getSalesSummary(tenantId, period),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getSalesComparison = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const comparisonType = parseComparisonTypeFromQuery(req.query);
  const referenceDate = await getTenantReferenceDate(tenantId);
  const { current, previous } = dateRanges.resolveRequestComparison(comparisonType, referenceDate);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => salesAnalytics.getSalesComparison(tenantId, current, previous),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getTopProducts = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parsePeriodFromQuery(req.query, referenceDate);
  const limit = parseLimitFromQuery(req.query);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => salesAnalytics.getTopProducts(tenantId, period, { limit }),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getGrowingProducts = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const comparisonType = parseComparisonTypeFromQuery(req.query);
  const limit = parseLimitFromQuery(req.query);
  const referenceDate = await getTenantReferenceDate(tenantId);
  const { current, previous } = dateRanges.resolveRequestComparison(comparisonType, referenceDate);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => salesAnalytics.getTopGrowingProducts(tenantId, current, previous, { limit }),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getDecliningProducts = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const comparisonType = parseComparisonTypeFromQuery(req.query);
  const limit = parseLimitFromQuery(req.query);
  const referenceDate = await getTenantReferenceDate(tenantId);
  const { current, previous } = dateRanges.resolveRequestComparison(comparisonType, referenceDate);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => salesAnalytics.getDecliningProducts(tenantId, current, previous, { limit }),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getTopCustomers = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parsePeriodFromQuery(req.query, referenceDate);
  const limit = parseLimitFromQuery(req.query);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => salesAnalytics.getTopCustomers(tenantId, period, { limit }),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getSalesTrend = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parseTrendPeriodFromQuery(req.query, referenceDate);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => salesAnalytics.getSalesTrend(tenantId, period),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getCustomerCounts = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parsePeriodFromQuery(req.query, referenceDate);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => salesAnalytics.getCustomerCounts(tenantId, period),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getPurchaseSummary = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parsePeriodFromQuery(req.query, referenceDate);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Purchase",
    run: () => purchaseAnalytics.getPurchaseSummary(tenantId, period),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getPurchaseComparison = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const comparisonType = parseComparisonTypeFromQuery(req.query);
  const referenceDate = await getTenantReferenceDate(tenantId);
  const { current, previous } = dateRanges.resolveRequestComparison(comparisonType, referenceDate);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Purchase",
    run: () => purchaseAnalytics.getPurchaseComparison(tenantId, current, previous),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getTopSuppliers = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parsePeriodFromQuery(req.query, referenceDate);
  const limit = parseLimitFromQuery(req.query);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Purchase",
    run: () => purchaseAnalytics.getTopSuppliers(tenantId, period, { limit }),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getPurchaseTrend = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const period = parseTrendPeriodFromQuery(req.query, referenceDate);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Purchase",
    run: () => purchaseAnalytics.getPurchaseTrend(tenantId, period),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getStockGroupPerformance = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const referenceDate = await getTenantReferenceDate(tenantId);
  const { current, previous, sameLastYear } = parseStockGroupPeriodFromQuery(req.query, referenceDate);
  const limit = parseLimitFromQuery(req.query);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => stockGroupAnalytics.getTopStockGroups(tenantId, current, previous, sameLastYear, { limit }),
  });

  return res.status(200).json({ success: true, ...envelope });
});

module.exports = {
  getSalesSummary,
  getSalesComparison,
  getTopProducts,
  getGrowingProducts,
  getDecliningProducts,
  getTopCustomers,
  getSalesTrend,
  getCustomerCounts,
  getStockGroupPerformance,
  getPurchaseSummary,
  getPurchaseComparison,
  getTopSuppliers,
  getPurchaseTrend,
};
