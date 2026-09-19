const salesAnalytics = require("../services/analytics/salesAnalytics");
const purchaseAnalytics = require("../services/analytics/purchaseAnalytics");
const { wrapAnalyticsResult } = require("../services/analytics/trustEnvelope");
const {
  resolvePeriod,
  resolveComparisonPeriods,
} = require("../services/ai/tools");

// --------------------------------------------------
// Read-only REST surface over the existing, deterministic Analytics
// Engine (src/services/analytics/*) - the same calculations, the same
// analyticsScope tenant/active-voucher gating, and the same
// resolvePeriod/resolveComparisonPeriods period resolution already used
// by the Claude tool layer (src/services/ai/tools.js). Nothing here
// recomputes a business number - every handler below just parses HTTP
// query params into the same period/comparison objects the tool layer
// already builds, then calls the exact same analytics function.
//
// Company/tenant context is never read from the query string or body -
// it comes from req.companyContext, set by the activeCompanyContext
// middleware (src/services/auth/companyContext.js), which re-derives
// the tenant from the authenticated user's own authorized company.
//
// Every response is the trust envelope wrapAnalyticsResult already
// produces ({state, data, freshness, message}) - the same contract the
// frontend's FreshnessBadge and future chat layer are already built to
// read - spread directly into the HTTP body, never reshaped.
// --------------------------------------------------

const PERIOD_KINDS = ["current_month", "previous_month", "custom"];
const COMPARISON_KINDS = ["vs_previous_month", "vs_same_month_last_year"];

function parsePeriodFromQuery(query) {
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
    return resolvePeriod({ period, from: query.from, to: query.to });
  } catch (error) {
    error.status = error.status || 400;
    throw error;
  }
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

// Wraps a handler so any thrown error (bad query params, or anything
// unexpected) becomes a clean HTTP error response instead of a 500 with
// no message - matches the pattern already used across
// authController/importController.
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      const status = error.status || 500;
      return res.status(status).json({
        success: false,
        message: error.message || "Unexpected analytics error.",
      });
    }
  };
}

const getSalesSummary = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const period = parsePeriodFromQuery(req.query);

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
  const { current, previous } = resolveComparisonPeriods(comparisonType);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => salesAnalytics.getSalesComparison(tenantId, current, previous),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getTopProducts = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const period = parsePeriodFromQuery(req.query);
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
  const { current, previous } = resolveComparisonPeriods(comparisonType);

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
  const { current, previous } = resolveComparisonPeriods(comparisonType);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => salesAnalytics.getDecliningProducts(tenantId, current, previous, { limit }),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getTopCustomers = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const period = parsePeriodFromQuery(req.query);
  const limit = parseLimitFromQuery(req.query);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Sales",
    run: () => salesAnalytics.getTopCustomers(tenantId, period, { limit }),
  });

  return res.status(200).json({ success: true, ...envelope });
});

const getPurchaseSummary = handle(async (req, res) => {
  const { tenantId } = req.companyContext;
  const period = parsePeriodFromQuery(req.query);

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
  const { current, previous } = resolveComparisonPeriods(comparisonType);

  const envelope = await wrapAnalyticsResult({
    tenantId,
    voucherType: "Purchase",
    run: () => purchaseAnalytics.getPurchaseComparison(tenantId, current, previous),
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
  getPurchaseSummary,
  getPurchaseComparison,
};
