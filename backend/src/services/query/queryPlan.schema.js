"use strict";

// --------------------------------------------------
// Sales/Purchase Query DSL - LAYER 1: strict structural schema (Phase 1A).
//
// This is the only shape Claude may ever produce. It is deliberately small and closed:
//   - every object is STRICT: any unknown key is rejected, which is what
//     makes tenantId/companyId/companyGuid, raw Mongo operators ($match,
//     $where, ...), and "expression" fields structurally impossible;
//   - every id (metric, dimension, filter op, sort/having ref, period kind)
//     is an enum generated from semanticCatalog.js / periodEngine - Claude
//     cannot invent one;
//   - every free string is length-capped and control-character-free, and is
//     only ever used later as an ESCAPED LITERAL (never as a pattern).
//
// What this layer does NOT do (Phase 1B validator, per QUERY_RULES):
// entity/metric/dimension applicability, grain rules, comparison-vs-period
// support, sort/having reference resolution, date-range span, high-
// cardinality rules, series length. It only guarantees shape.
//
// Dates: the plan never carries a computed date. `period` is a kind that
// periodEngine resolves; the only literal dates are an explicit custom
// range (YYYY-MM-DD, real calendar dates, from <= to).
// --------------------------------------------------

const { z } = require("zod");
const catalog = require("./semanticCatalog");
const periodEngine = require("../analytics/periodEngine");

const { LIMITS } = catalog;

const ENTITY_IDS = Object.keys(catalog.CATALOG.entities);
const METRIC_IDS = Object.keys(catalog.CATALOG.metrics);
const DIMENSION_IDS = Object.keys(catalog.CATALOG.dimensions);
const FILTERABLE_DIMENSION_IDS = Object.values(catalog.CATALOG.dimensions)
  .filter((d) => d.filterOps.length > 0)
  .map((d) => d.id);
const BUCKETS = catalog.CATALOG.dimensions.date.buckets;
const FILTER_OPS = ["eq_ci", "in_ci", "contains_ci", "new_in_period"];
const HAVING_OPS = ["gt", "gte", "lt", "lte", "eq", "neq"];
// having: selected metrics or their compare-derived variants.
const METRIC_REFS = catalog.metricRefs();
// sort: metrics (+derived), groupBy dimensions, and the list-mode voucher number.
const SORT_REFS = [...METRIC_REFS, ...DIMENSION_IDS, "voucherNo"];

// ---------- primitives ----------

// Plain text only: no control characters (incl. NUL/newlines). Values are
// treated as literals downstream, but hygiene here keeps logs, cache keys
// and prompts clean.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const safeString = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.maxStringLength)
  .refine((s) => !CONTROL_CHARS.test(s), { message: "must not contain control characters" });

function isRealIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const isoDate = z.string().refine(isRealIsoDate, { message: "must be a real calendar date in YYYY-MM-DD format" });

function isConsistentFy(value) {
  if (!/^\d{4}-\d{2}$/.test(value)) return false;
  try {
    periodEngine.parseFinancialYearInput(value); // validates the 2-digit end year is start+1
    return true;
  } catch {
    return false;
  }
}

// ---------- period ----------

const STANDARD_PERIOD_KINDS = catalog.PERIOD_KINDS.filter((k) => k !== "custom" && k !== "specific_fy");

const customRange = z
  .strictObject({ kind: z.literal("custom"), from: isoDate, to: isoDate })
  .refine((p) => p.from <= p.to, { message: "from must not be after to", path: ["from"] });

const periodSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(STANDARD_PERIOD_KINDS) }),
  customRange,
  z.strictObject({
    kind: z.literal("specific_fy"),
    fy: z.string().refine(isConsistentFy, { message: 'must look like "2025-26" (end year = start year + 1)' }),
  }),
]);

// ---------- comparison ----------
// The mode is EXPLICIT so like-for-like (same elapsed duration) can never
// be confused with the complete previous period:
//   like_for_like          -> periodEngine.resolveComparisonPeriod
//   full_previous          -> the complete previous_X period
//   same_period_last_year  -> same resolved range shifted one year
//   custom                 -> caller-supplied explicit period

const compareSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.enum(["like_for_like", "full_previous", "same_period_last_year"]) }),
  z.strictObject({ mode: z.literal("custom"), period: customRange }),
]);

// ---------- groupBy / filters / having / sort ----------

const groupByItem = z.strictObject({
  dim: z.enum(DIMENSION_IDS),
  bucket: z.enum(BUCKETS).optional(),
});

const filterItem = z
  .strictObject({
    dim: z.enum(FILTERABLE_DIMENSION_IDS),
    op: z.enum(FILTER_OPS),
    value: z.union([safeString, z.array(safeString).min(1).max(LIMITS.maxInValues)]),
  })
  .superRefine((f, ctx) => {
    const dim = catalog.CATALOG.dimensions[f.dim];
    if (!dim.filterOps.includes(f.op)) {
      ctx.addIssue({ code: "custom", path: ["op"], message: `operator ${f.op} is not allowed on ${f.dim}` });
    }
    if (f.op === "new_in_period") {
      // the only value: the rule is "created inside the query's own period"
      if (f.value !== "period") ctx.addIssue({ code: "custom", path: ["value"], message: 'new_in_period takes the value "period"' });
    } else if (f.op === "in_ci") {
      if (!Array.isArray(f.value)) ctx.addIssue({ code: "custom", path: ["value"], message: "in_ci requires an array of values" });
    } else if (Array.isArray(f.value)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: `${f.op} requires a single string value` });
    } else if (f.op === "contains_ci" && f.value.length < LIMITS.minContainsLength) {
      ctx.addIssue({ code: "custom", path: ["value"], message: `contains_ci needs at least ${LIMITS.minContainsLength} characters` });
    }
  });

const havingItem = z.strictObject({
  metric: z.enum(METRIC_REFS),
  op: z.enum(HAVING_OPS),
  value: z.number().finite(),
});

const sortItem = z.strictObject({
  by: z.enum(SORT_REFS),
  dir: z.enum(["asc", "desc"]),
});

// ---------- the plan ----------

const queryPlanSchema = z
  .strictObject({
    v: z.literal(1),
    entity: z.enum(ENTITY_IDS),
    mode: z.enum(["aggregate", "list"]),
    period: periodSchema,
    compare: compareSchema.nullable().default(null),
    metrics: z.array(z.enum(METRIC_IDS)).max(LIMITS.maxMetrics).default([]),
    groupBy: z.array(groupByItem).max(LIMITS.maxGroupBy).default([]),
    filters: z.array(filterItem).max(LIMITS.maxFilters).default([]),
    having: z.array(havingItem).max(LIMITS.maxHaving).default([]),
    sort: z.array(sortItem).max(LIMITS.maxSort).default([]),
    // No default here: the default depends on the query shape (10 for
    // rankings, 100 for date series) and is applied by the Phase 1B
    // validator, never silently by the schema.
    limit: z.number().int().min(1).max(LIMITS.maxLimit).optional(),
    // Overall (ungrouped) totals alongside grouped rows, unaffected by limit.
    totals: z.boolean().default(true),
    // A REQUEST for explanation, not a guarantee: the backend decides.
    explain: z.enum(["none", "brief", "analysis"]).default("none"),
  })
  .superRefine((plan, ctx) => {
    // groupBy: unique dims; a bucket exists iff the dim is `date`.
    const seen = new Set();
    plan.groupBy.forEach((g, i) => {
      if (seen.has(g.dim)) ctx.addIssue({ code: "custom", path: ["groupBy", i, "dim"], message: `duplicate groupBy dimension ${g.dim}` });
      seen.add(g.dim);
      if (g.dim === "date" && !g.bucket) ctx.addIssue({ code: "custom", path: ["groupBy", i, "bucket"], message: "groupBy date requires a bucket (day|week|month|quarter|fy)" });
      if (g.dim !== "date" && g.bucket) ctx.addIssue({ code: "custom", path: ["groupBy", i, "bucket"], message: "bucket is only valid for the date dimension" });
    });

    // Unique metrics / filter dims / sort keys.
    if (new Set(plan.metrics).size !== plan.metrics.length) ctx.addIssue({ code: "custom", path: ["metrics"], message: "duplicate metrics" });
    const filterDims = plan.filters.map((f) => f.dim);
    if (new Set(filterDims).size !== filterDims.length) ctx.addIssue({ code: "custom", path: ["filters"], message: "at most one filter per dimension" });
    const sortKeys = plan.sort.map((s) => s.by);
    if (new Set(sortKeys).size !== sortKeys.length) ctx.addIssue({ code: "custom", path: ["sort"], message: "duplicate sort key" });

    // Shape of each mode.
    if (plan.mode === "aggregate" && plan.metrics.length === 0) {
      ctx.addIssue({ code: "custom", path: ["metrics"], message: "aggregate mode requires at least one metric" });
    }
    if (plan.mode === "list") {
      if (plan.metrics.length) ctx.addIssue({ code: "custom", path: ["metrics"], message: "list mode returns invoice rows and takes no metrics" });
      if (plan.groupBy.length) ctx.addIssue({ code: "custom", path: ["groupBy"], message: "list mode takes no groupBy" });
      if (plan.having.length) ctx.addIssue({ code: "custom", path: ["having"], message: "list mode takes no having" });
      if (plan.compare) ctx.addIssue({ code: "custom", path: ["compare"], message: "list mode takes no compare" });
    }
  });

// ---------- public API ----------

function flattenIssues(issues, out = []) {
  for (const issue of issues) {
    const path = (issue.path || []).join(".");
    if (issue.code === "invalid_union") {
      out.push({ path, code: "invalid_union", message: issue.message });
      // Surface the best-matching branch (fewest problems) for usable feedback.
      const branches = Array.isArray(issue.errors) ? issue.errors : [];
      if (branches.length) {
        const best = branches.reduce((a, b) => (b.length < a.length ? b : a));
        flattenIssues(best.map((i) => ({ ...i, path: [...(issue.path || []), ...(i.path || [])] })), out);
      }
      continue;
    }
    out.push({ path, code: issue.code, message: issue.message });
  }
  return out;
}

// JSON.parse can produce an OWN "__proto__" property, which zod's strict
// key check does not flag. None of these keys has any legitimate place in a
// plan, so reject them anywhere in the tree (depth-bounded).
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function findForbiddenKey(value, path = "", depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return null;
  for (const key of Object.getOwnPropertyNames(value)) {
    const here = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KEYS.has(key)) return here;
    const nested = findForbiddenKey(value[key], here, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function fail(errors) {
  return { ok: false, errors };
}

// new_in_period has exactly one legal value, "period" (the rule is "created inside the query's own period"). The planner model
// sometimes sends an EMPTY value with it (nothing to say), which made the whole plan invalid ("New customers in November 2025" failed
// on that alone). A blank value carries no meaning, so it is set to "period" here. Any other value (a name, a month, a number) is NOT
// guessed at: it is still refused. Works on a copy; every other check (dimension, operator, the rest of the plan) is unchanged.
function normalizeNewPartyFilters(raw) {
  const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
  const isNewParty = (f) => f !== null && typeof f === "object" && f.op === "new_in_period" && isBlank(f.value);
  if (!Array.isArray(raw.filters) || !raw.filters.some(isNewParty)) return raw;
  return { ...raw, filters: raw.filters.map((f) => (isNewParty(f) ? { ...f, value: "period" } : f)) };
}

/**
 * Structural validation of a candidate plan (an object - never a string).
 * Returns {ok:true, plan} with defaults applied, or
 * {ok:false, errors:[{path, code, message}]} - a stable shape safe to feed
 * back to a planner or log. Never throws.
 */
function parseQueryPlan(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail([{ path: "", code: "not_an_object", message: "A query plan must be a JSON object." }]);
  }

  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(raw), "utf8");
  } catch {
    return fail([{ path: "", code: "not_serializable", message: "The query plan is not valid JSON data." }]);
  }
  if (size > LIMITS.maxPlanBytes) {
    return fail([{ path: "", code: "plan_too_large", message: `The query plan exceeds ${LIMITS.maxPlanBytes} bytes.` }]);
  }

  const forbidden = findForbiddenKey(raw);
  if (forbidden) {
    return fail([{ path: forbidden, code: "forbidden_key", message: `Key "${forbidden.split(".").pop()}" is not allowed in a query plan.` }]);
  }

  const result = queryPlanSchema.safeParse(normalizeNewPartyFilters(raw));
  if (!result.success) return fail(flattenIssues(result.error.issues));

  const plan = result.data;
  // `totals` has no meaning for invoice rows.
  if (plan.mode === "list") plan.totals = false;
  return { ok: true, plan };
}

/** JSON Schema for the planner tool input (Phase 1F). Input-io so defaulted fields are optional. */
function queryPlanJsonSchema() {
  const { $schema, ...rest } = z.toJSONSchema(queryPlanSchema, { io: "input" });
  return rest;
}

module.exports = {
  queryPlanSchema,
  parseQueryPlan,
  queryPlanJsonSchema,
  ENTITY_IDS,
  METRIC_IDS,
  DIMENSION_IDS,
  FILTERABLE_DIMENSION_IDS,
  FILTER_OPS,
  HAVING_OPS,
  METRIC_REFS,
  SORT_REFS,
  BUCKETS,
};
