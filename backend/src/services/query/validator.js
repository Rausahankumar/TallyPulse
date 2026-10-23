"use strict";

// --------------------------------------------------
// Sales/Purchase Query DSL - LAYER 2: semantic validator (Phase 1B).
//
// Input: a candidate plan (from Claude or a test). Output: a
// VALIDATED, NORMALIZED plan with periods already resolved to concrete
// dates - or a structured refusal. Nothing reaches the compiler/MongoDB
// without passing through here: the compiler refuses any object that was
// not produced by this function (see isValidatedPlan).
//
// Pure and deterministic: no database, no clock. The tenant reference
// date (what "this month" is anchored to) is an EXPLICIT input supplied by
// the backend (getTenantReferenceDate) - never guessed here, never taken
// from the plan.
//
// Rules enforced are exactly the ones declared in the catalog
// (semanticCatalog.QUERY_RULES) plus the metric x dimension compatibility
// matrix; a test asserts every emitted code is declared there.
// --------------------------------------------------

const catalog = require("./semanticCatalog");
const periodEngine = require("../analytics/periodEngine");
const dateRanges = require("../analytics/dateRanges");
const { parseQueryPlan } = require("./queryPlan.schema");

const { CATALOG, LIMITS } = catalog;
const W = catalog.COMPLEXITY_WEIGHTS;

// Module-private brand: only plans returned by validateQueryPlan are
// members, so the compiler cannot be handed a hand-built or mutated object.
const VALIDATED = new WeakSet();
function isValidatedPlan(value) {
  return value !== null && typeof value === "object" && VALIDATED.has(value);
}


const NEW_PARTY_NOTE = {
  code: "new_party_by_ledger_created_date",
  message: '"New" means the party\'s Tally ledger was created in this period and they traded in it (from the synced ledger master).',
};

function parseRef(ref) {
  const dot = ref.indexOf(".");
  if (dot === -1) return { base: ref, suffix: null };
  return { base: ref.slice(0, dot), suffix: ref.slice(dot + 1) };
}

const isMetricId = (id) => Object.prototype.hasOwnProperty.call(CATALOG.metrics, id);
const isDimensionId = (id) => Object.prototype.hasOwnProperty.call(CATALOG.dimensions, id);

const NEEDS_REFERENCE_DATE = (kind) => kind !== "all_time" && kind !== "custom";

// ---------- period resolution ----------

function toResolved(kind, range) {
  return {
    kind,
    from: range.from || null,
    to: range.to || null,
    label: range.label || null,
    isPartial: !!range.isPartial,
  };
}

function resolvePlanPeriod(period, referenceDate) {
  if (period.kind === "all_time") {
    return toResolved("all_time", { from: null, to: null, label: "All time", isPartial: false });
  }
  if (period.kind === "custom") {
    return toResolved("custom", dateRanges.customRange(period.from, period.to));
  }
  const options = period.kind === "specific_fy" ? { fy: period.fy } : {};
  return toResolved(period.kind, periodEngine.resolvePeriod(period.kind, referenceDate, options));
}

const sameRange = (a, b) => !!a && !!b && a.from.getTime() === b.from.getTime() && a.to.getTime() === b.to.getTime();

function resolveComparison(plan, referenceDate) {
  const { period, compare } = plan;
  const options = period.kind === "specific_fy" ? { fy: period.fy } : period.kind === "custom" ? { from: period.from, to: period.to } : {};
  const support = CATALOG.periods.comparisonSupport[period.kind];

  const lfl = () => periodEngine.resolveComparisonPeriod(period.kind, referenceDate, options);
  const full = () => {
    if (support.fullPrevious && typeof support.fullPrevious === "object") {
      return periodEngine.resolvePeriod(support.fullPrevious.kind, referenceDate, options);
    }
    return lfl();
  };

  if (compare.mode === "custom") {
    const r = dateRanges.customRange(compare.period.from, compare.period.to);
    return { mode: "custom", canonicalMode: "custom", from: r.from, to: r.to, label: "Custom comparison range" };
  }

  if (compare.mode === "same_period_last_year") {
    const r = periodEngine.resolveSamePeriodLastYear(period.kind, referenceDate, options);
    return { mode: compare.mode, canonicalMode: compare.mode, from: r.from, to: r.to, label: "Same period last year" };
  }

  const r = compare.mode === "like_for_like" ? lfl() : full();
  let canonicalMode = compare.mode;
  // Where both modes resolve to the identical range (complete periods),
  // the canonical form is like_for_like, so equivalent plans share one
  // cache key later.
  if (support.likeForLike && support.fullPrevious) {
    const other = compare.mode === "like_for_like" ? full() : lfl();
    if (sameRange(r, other)) canonicalMode = "like_for_like";
  }
  const label = compare.mode === "like_for_like" ? "Same-duration comparison period" : "Complete previous period";
  return { mode: compare.mode, canonicalMode, from: r.from, to: r.to, label };
}

// ---------- helpers ----------

function spanDays(from, to) {
  return Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
}

function estimateBuckets(bucket, from, to) {
  const days = spanDays(from, to);
  const months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) + 1;
  switch (bucket) {
    case "day":
      return days;
    case "week":
      return Math.ceil(days / 7) + 1;
    case "month":
      return months;
    case "quarter":
      return Math.ceil(months / 3) + 1;
    default:
      return Math.ceil(months / 12) + 1; // fy
  }
}

function defaultSort(plan) {
  if (plan.mode === "list") return [{ by: "date", dir: "desc" }];
  const dateGroup = plan.groupBy.find((g) => g.dim === "date");
  if (dateGroup) return [{ by: "date", dir: "asc" }];
  return [{ by: plan.metrics[0], dir: "desc" }];
}

// ---------- the validator ----------

function refuse(stage, errors, warnings = []) {
  return { ok: false, stage, errors, warnings };
}

/**
 * @param {object} raw           candidate plan (object)
 * @param {object} [context]
 * @param {Date}   [context.referenceDate] tenant reference date (required for relative periods)
 * @returns {{ok:true, plan, normalized, warnings, assumptions} | {ok:false, stage, errors, warnings}}
 */
function validateQueryPlan(raw, { referenceDate } = {}) {
  const parsed = parseQueryPlan(raw);
  if (!parsed.ok) return refuse("schema", parsed.errors);

  const plan = parsed.plan;
  const errors = [];
  const warnings = [];
  const assumptions = [];
  const err = (code, message, path = "") => errors.push({ code, path, message });

  const entityMetricIds = new Set(catalog.metricsForEntity(plan.entity).map((m) => m.id));
  const entityDimIds = new Set(catalog.dimensionsForEntity(plan.entity).map((d) => d.id));
  const groupDims = plan.groupBy.map((g) => g.dim);

  // 1. Entity applicability + metric status --------------------------------
  plan.metrics.forEach((id, i) => {
    if (!entityMetricIds.has(id)) {
      const alt = catalog.metricsForEntity(plan.entity).filter((m) => m.grain === CATALOG.metrics[id].grain).map((m) => m.id);
      err("metric_not_applicable_to_entity", `${id} does not apply to ${plan.entity}${alt.length ? ` (available for ${plan.entity}: ${alt.join(", ")})` : ""}.`, `metrics.${i}`);
    } else if (CATALOG.metrics[id].status !== "supported") {
      err("metric_unsupported", `${id} is not supported: ${CATALOG.metrics[id].status}.`, `metrics.${i}`);
    }
  });
  plan.groupBy.forEach((g, i) => {
    if (!entityDimIds.has(g.dim)) err("dimension_not_applicable_to_entity", `${g.dim} does not exist for ${plan.entity}.`, `groupBy.${i}.dim`);
  });
  plan.filters.forEach((f, i) => {
    if (!entityDimIds.has(f.dim)) err("dimension_not_applicable_to_entity", `${f.dim} does not exist for ${plan.entity}.`, `filters.${i}.dim`);
  });

  // New party = Tally ledger created inside the period (LedgerMaster), so the
  // period must be bounded and there is no second period to compare against.
  if (plan.filters.some((f) => f.op === "new_in_period")) {
    if (plan.period.kind === "all_time") err("new_party_needs_period", "New customers/suppliers need a period (for example this month).", "period");
    if (plan.compare) err("new_party_comparison_unsupported", "New customers/suppliers are defined by ledger creation date inside one period; remove the comparison.", "compare");
    assumptions.push(NEW_PARTY_NOTE);
  }

  // 2. Grain + compatibility matrix ---------------------------------------
  const usableMetrics = plan.metrics.filter((id) => entityMetricIds.has(id));
  const metricGrains = new Set(usableMetrics.map((id) => CATALOG.metrics[id].grain));
  if (metricGrains.size > 1) {
    err("mixed_metric_grains", "Invoice-level metrics and line-level metrics cannot be combined in one query (an invoice total would be counted once per line). Ask them as separate queries.", "metrics");
  }
  const usesProduct = groupDims.includes("product") || groupDims.includes("productGroup");
  const grain = metricGrains.has("line") || usesProduct ? "line" : "voucher";

  if (metricGrains.size <= 1) {
    const matrix = catalog.buildCompatibilityMatrix(plan.entity);
    for (const id of usableMetrics) {
      plan.groupBy.forEach((g, i) => {
        const cell = matrix[id] && matrix[id][g.dim];
        if (cell && cell.status === "invalid") err(cell.code, cell.reason, `groupBy.${i}.dim`);
      });
    }
  }

  // A quantity (quantity, returnQuantity) is unit-safe only when tied to a single product: every metric that declares the mixed_units
  // caveat in the catalog gets it (no unit of measure is stored).
  const singleProductFilter = plan.filters.some((f) => f.dim === "product" && (f.op === "eq_ci" || (f.op === "in_ci" && f.value.length === 1)));
  const mixedUnitsRule = usableMetrics.map((id) => (CATALOG.metrics[id].caveatRules || []).find((r) => r.code === "mixed_units")).find(Boolean);
  if (mixedUnitsRule && !groupDims.includes("product") && !singleProductFilter) {
    warnings.push({ code: "warn_mixed_units", message: mixedUnitsRule.message });
  }

  // 3. Mode-specific ---------------------------------------------------------
  const listSortable = new Set(CATALOG.listMode.sortable[plan.entity]);
  if (plan.mode === "list") {
    plan.sort.forEach((s, i) => {
      if (!listSortable.has(s.by)) err("list_mode_shape", `list mode can sort by ${[...listSortable].join(", ")} - not ${s.by}.`, `sort.${i}.by`);
    });
  }

  // 4. Reference resolution: having/sort -----------------------------------
  const hasCompare = plan.compare !== null;
  const checkMetricRef = (ref, path) => {
    const { base, suffix } = parseRef(ref);
    if (!isMetricId(base)) return false;
    if (suffix && !hasCompare) {
      err("derived_ref_requires_compare", `${ref} needs a comparison period (add "compare").`, path);
      return false;
    }
    if (!plan.metrics.includes(base)) {
      err("ref_not_selected", `${ref} refers to ${base}, which is not one of the selected metrics.`, path);
      return false;
    }
    return true;
  };
  if (plan.having.length && plan.groupBy.length === 0) {
    err("having_requires_groupby", "having filters grouped rows; add a groupBy (an ungrouped total has no rows to filter).", "having");
  }
  plan.having.forEach((h, i) => checkMetricRef(h.metric, `having.${i}.metric`));
  if (plan.mode === "aggregate") {
    plan.sort.forEach((s, i) => {
      const { base } = parseRef(s.by);
      if (isMetricId(base)) checkMetricRef(s.by, `sort.${i}.by`);
      else if (isDimensionId(s.by)) {
        if (!groupDims.includes(s.by)) err("ref_not_selected", `cannot sort by ${s.by}: it is not one of the groupBy dimensions.`, `sort.${i}.by`);
      } else err("ref_not_selected", `cannot sort by ${s.by} in an aggregate query.`, `sort.${i}.by`);
    });
  }

  // 5. Periods --------------------------------------------------------------
  let resolvedPeriod = null;
  let resolvedComparison = null;

  if (NEEDS_REFERENCE_DATE(plan.period.kind) && !(referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime()))) {
    err("reference_date_required", `period ${plan.period.kind} is relative and needs the tenant reference date from the backend.`, "period");
  } else {
    try {
      resolvedPeriod = resolvePlanPeriod(plan.period, referenceDate);
    } catch (e) {
      err("period_invalid", e.message, "period");
    }
  }

  if (plan.period.kind === "custom" && spanDays(dateRanges.customRange(plan.period.from, plan.period.to).from, dateRanges.customRange(plan.period.from, plan.period.to).to) > CATALOG.periods.rules.maxCustomRangeDays) {
    err("range_too_long", `custom range exceeds ${CATALOG.periods.rules.maxCustomRangeDays} days.`, "period");
  }

  if (hasCompare) {
    if (plan.period.kind === "all_time") {
      err("all_time_cannot_compare", "all_time has no comparison period.", "compare");
    } else {
      const support = CATALOG.periods.comparisonSupport[plan.period.kind];
      const mode = plan.compare.mode;
      if (mode === "like_for_like" && !support.likeForLike) {
        err("compare_mode_unsupported_for_period", `like_for_like is not defined for ${plan.period.kind}; use same_period_last_year or a custom comparison period.`, "compare.mode");
      }
      if (mode === "full_previous" && !support.fullPrevious) {
        err("compare_mode_unsupported_for_period", `full_previous is not defined for ${plan.period.kind}; use same_period_last_year or a custom comparison period.`, "compare.mode");
      }
      if (mode === "custom") {
        const c = plan.compare.period;
        const r = dateRanges.customRange(c.from, c.to);
        if (spanDays(r.from, r.to) > CATALOG.periods.rules.maxCustomRangeDays) err("range_too_long", `comparison range exceeds ${CATALOG.periods.rules.maxCustomRangeDays} days.`, "compare.period");
      }
    }
    if (groupDims.includes("date")) {
      err("compare_not_supported_with_date_groupby", "A comparison cannot be combined with a date series: two different periods share no date buckets.", "compare");
    }
  }

  // Comparison resolution only when the rules above allow it.
  const compareBlocked = errors.some((e) => ["all_time_cannot_compare", "compare_mode_unsupported_for_period", "reference_date_required", "period_invalid", "range_too_long"].includes(e.code));
  if (hasCompare && resolvedPeriod && !compareBlocked) {
    try {
      resolvedComparison = resolveComparison(plan, referenceDate);
    } catch (e) {
      err("period_invalid", e.message, "compare");
    }
  }

  if (hasCompare && plan.period.kind === "specific_fy" && resolvedPeriod && resolvedPeriod.isPartial && resolvedComparison) {
    warnings.push({
      code: "warn_specific_fy_partial_comparison",
      message: "The selected financial year is still in progress but is compared against the COMPLETE prior financial year, so growth is not like-for-like. Use current_fy for a like-for-like comparison.",
    });
  }

  // 6. Cardinality, series, limit ------------------------------------------
  const highCardinality = plan.groupBy.some((g) => CATALOG.dimensions[g.dim].cardinality === "high");
  if (highCardinality && plan.sort.length === 0 && plan.mode === "aggregate") {
    err("high_cardinality_requires_sort", "Grouping by customer/supplier/product needs an explicit sort so the returned top rows are meaningful.", "sort");
  }

  const dateGroup = plan.groupBy.find((g) => g.dim === "date");
  if (dateGroup && resolvedPeriod) {
    if (plan.period.kind === "all_time") {
      if (dateGroup.bucket === "day" || dateGroup.bucket === "week") {
        err("series_too_long", `An all_time ${dateGroup.bucket} series is unbounded; use month, quarter or fy buckets.`, "groupBy");
      }
    } else {
      const buckets = estimateBuckets(dateGroup.bucket, resolvedPeriod.from, resolvedPeriod.to);
      if (buckets > LIMITS.maxLimit) err("series_too_long", `This range holds about ${buckets} ${dateGroup.bucket} buckets (max ${LIMITS.maxLimit}); use a coarser bucket or a shorter period.`, "groupBy");
    }
  }

  const limit = plan.limit !== undefined ? plan.limit : dateGroup ? LIMITS.defaultSeriesLimit : LIMITS.defaultLimit;

  // 7. Caveats ------------------------------------------------------------
  const productishFilter = plan.filters.some((f) => f.dim === "product" || f.dim === "productGroup");
  // A distinct count (customerCount) has no amount to misread as the product's share, so the invoice-amount caveat is not attached
  // when distinct counts are the only metrics; any invoice-level amount next to them still gets it.
  const onlyDistinctMetrics = plan.mode === "aggregate" && usableMetrics.length > 0 && usableMetrics.every((id) => CATALOG.metrics[id].aggregation && CATALOG.metrics[id].aggregation.op === "distinct");
  if (productishFilter && grain === "voucher" && !onlyDistinctMetrics) {
    warnings.push({
      code: "warn_invoice_total_not_product_share",
      message: CATALOG.listMode.filterCaveats.productOrGroupFilter.message,
    });
  }

  // 8. Complexity -----------------------------------------------------------
  const usesProductGroup = groupDims.includes("productGroup") || plan.filters.some((f) => f.dim === "productGroup");
  const complexity =
    W.base +
    groupDims.length * W.perGroupBy +
    (usesProductGroup ? W.productGroupJoin : 0) +
    (hasCompare ? W.compare : 0) +
    plan.filters.length * W.perFilter +
    (grain === "line" ? W.lineGrain : 0) +
    (plan.totals && plan.mode === "aggregate" ? W.totals : 0) +
    plan.having.length * W.perHaving;
  if (complexity > LIMITS.maxComplexity) {
    err("complexity_too_high", `Query complexity ${complexity} exceeds the limit of ${LIMITS.maxComplexity}; simplify (fewer filters/groupings/comparison).`, "");
  }

  if (errors.length) return refuse("semantic", errors, warnings);

  // 9. Assumptions (facts a later formatter must be able to state) ---------
  if (NEEDS_REFERENCE_DATE(plan.period.kind)) {
    assumptions.push({
      code: "period_anchored_to_latest_data",
      message: `Relative periods are measured up to the reporting reference date (${referenceDate.getFullYear()}-${String(referenceDate.getMonth() + 1).padStart(2, "0")}-${String(referenceDate.getDate()).padStart(2, "0")}).`,
    });
  }
  if (resolvedPeriod.isPartial) {
    assumptions.push({ code: "period_is_partial", message: "The period is still in progress (to date)." });
  }

  const normalized = {
    entity: plan.entity,
    mode: plan.mode,
    grain: plan.mode === "list" ? "voucher" : grain,
    period: resolvedPeriod,
    comparison: resolvedComparison,
    metrics: [...plan.metrics],
    groupBy: plan.groupBy.map((g) => ({ ...g })),
    filters: plan.filters.map((f) => ({ ...f, value: Array.isArray(f.value) ? [...f.value] : f.value })),
    having: plan.having.map((h) => ({ ...h })),
    sort: plan.sort.length ? plan.sort.map((s) => ({ ...s })) : defaultSort(plan),
    limit,
    totals: plan.mode === "aggregate" ? plan.totals : false,
    usesProductGroup,
    complexity,
  };

  deepFreeze(normalized);
  VALIDATED.add(normalized);
  return { ok: true, plan, normalized, warnings, assumptions };
}

// A validated plan is immutable: the brand above proves the compiler is
// handed exactly what the validator approved, not something edited since.
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

module.exports = { validateQueryPlan, isValidatedPlan, parseRef, estimateBuckets, NEW_PARTY_NOTE };
