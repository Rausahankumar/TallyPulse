"use strict";

/**
 * The NLU scoring used by every evaluation of the planner (verify-nlu-eval.js and eval-nlu-models.js): the corpus, the
 * semantic plan comparator and the outcome scoring. One implementation, so Claude and every other model are judged by
 * exactly the same rules.
 *
 * Plans are compared SEMANTICALLY: both go through the real validator (relative periods resolve against the corpus reference
 * date, defaults are applied) and are compared field by field - never as JSON text. A plan that validates and compiles but
 * means something else is WRONG ("wrong_but_executable").
 *
 * Nothing here touches a database, Tally or the network: the corpus uses synthetic names only.
 */

require("./evalTimezone"); // FIRST: pins the evaluation to UTC before any date below is created (see eval/evalTimezone.js)
const fs = require("fs");
const path = require("path");
const schema = require("../src/services/query/queryPlan.schema");
const { validateQueryPlan } = require("../src/services/query/validator");
const { compileQuery } = require("../src/services/query/compile");
const { CATALOG } = require("../src/services/query/semanticCatalog");
const { createEntityResolver } = require("../src/services/query/entityResolver");

const CORPUS_PATH = path.join(__dirname, "nlu-corpus.json");
const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));
const REF_DATE = (() => {
  const [y, m, d] = corpus.referenceDate.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999); // end of the local reference day, like the product's "today"
})();
const TENANT = "eval-tenant"; // a label only: nothing here queries a tenant

const ms = (d) => (d instanceof Date ? d.getTime() : null);
const iso = (t) => (t === null ? null : new Date(t).toISOString().slice(0, 10));
const lower = (v) => String(v).toLowerCase();

/** The validator's own resolved form of a plan, reduced to the fields that carry meaning. Null when the plan is invalid. */
function canonical(plan) {
  const v = validateQueryPlan(plan, { referenceDate: REF_DATE });
  if (!v.ok) return { invalid: true, errors: v.errors.map((e) => e.code) };
  const n = v.normalized;
  return {
    entity: n.entity,
    mode: n.mode,
    period: `${iso(ms(n.period.from))}..${iso(ms(n.period.to))}`,
    comparison: n.comparison ? `${iso(ms(n.comparison.from))}..${iso(ms(n.comparison.to))}` : "none",
    metrics: [...n.metrics].sort(),
    groupBy: n.groupBy.map((g) => (g.dim === "date" ? `date:${g.bucket}` : g.dim)).sort(),
    filters: n.filters
      .map((f) => {
        const values = Array.isArray(f.value) ? f.value : [f.value];
        // The ONE operator equivalence the product itself establishes: in_ci with a single value is eq_ci (compile.regexCondition builds
        // `^v$` and `^(?:v)$`, the same match; validator.js treats a one-value in_ci as a single-product eq_ci). Every other operator
        // pair is a different question: eq_ci is the whole name, contains_ci any name containing the text, new_in_period a ledger rule.
        const op = f.op === "in_ci" && values.length === 1 ? "eq_ci" : f.op;
        return `${f.dim}:${op}=${values.map(lower).sort().join("|")}`;
      })
      .sort(),
    having: n.having.map((h) => `${h.metric} ${h.op} ${h.value}`).sort(),
    sort: n.sort.map((s) => `${s.by} ${s.dir}`),
    limit: n.limit,
  };
}

/**
 * Field-level differences between an actual and an expected plan ({field, expected, actual, minor?}); empty = semantically equal.
 * An extra metric of the same grain as an expected one (e.g. invoiceCount next to invoiceAmount) is NOT a difference: the ranking is
 * compared through "sort", so an extra column cannot change the answer. A larger row limit is a MINOR difference (it still contains
 * what was asked, plus more rows). Every other difference is MAJOR: it changes the financial meaning of the answer.
 * A filter is compared by dimension, OPERATOR and values (an exact name and a "contains" match are different questions); the only
 * operator equivalence is a one-value in_ci = eq_ci (see canonical).
 */
function diffPlans(actual, expected) {
  const a = canonical(actual);
  const e = canonical(expected);
  if (a.invalid) return [{ field: "valid", expected: "valid plan", actual: `invalid: ${a.errors.join(",")}` }];
  if (e.invalid) return [{ field: "expected", expected: "valid expected plan", actual: `corpus bug: ${e.errors.join(",")}` }];
  const out = [];
  for (const k of ["entity", "mode", "period", "comparison"]) if (a[k] !== e[k]) out.push({ field: k, expected: e[k], actual: a[k] });
  if (a.limit !== e.limit) out.push({ field: "limit", expected: e.limit, actual: a.limit, minor: typeof a.limit === "number" && typeof e.limit === "number" && a.limit > e.limit });
  // metrics: every expected metric must be present; an extra metric is minor only if it shares the grain (invoice / line / return) of an expected one
  const grain = (m) => (CATALOG.metrics[m] ? CATALOG.metrics[m].grain : null);
  const missing = e.metrics.filter((m) => !a.metrics.includes(m));
  const extra = a.metrics.filter((m) => !e.metrics.includes(m));
  if (missing.length) out.push({ field: "metrics", expected: e.metrics.join(","), actual: a.metrics.join(",") });
  else if (extra.some((m) => !e.metrics.some((x) => grain(x) === grain(m)))) out.push({ field: "metrics", expected: e.metrics.join(","), actual: a.metrics.join(",") });
  for (const k of ["groupBy", "filters", "having"]) if (a[k].join(";") !== e[k].join(";")) out.push({ field: k, expected: e[k].join(";") || "-", actual: a[k].join(";") || "-" });
  if (a.sort.join(";") !== e.sort.join(";")) out.push({ field: "sort", expected: e.sort.join(";"), actual: a.sort.join(";") });
  return out;
}

/** Could the engine compile this validated plan into a pipeline? (no database is touched) */
function compiles(plan) {
  try {
    const v = validateQueryPlan(plan, { referenceDate: REF_DATE });
    if (!v.ok) return false;
    compileQuery(v.normalized, { tenantId: TENANT, groupItemNames: [], newPartyNames: [] });
    return true;
  } catch (e) {
    return false;
  }
}

/** A tenant-free entity resolver over the corpus's synthetic fixture names. */
function makeResolver() {
  const list = (dim) => async () => corpus.fixtures[dim];
  return createEntityResolver({ tenantId: TENANT, sources: { customer: list("customer"), supplier: list("supplier"), product: list("product"), productGroup: list("productGroup") } });
}

/** Score one planner answer against the row's expectation. A plan where a refusal was expected, or a plan with the wrong meaning, is "wrong_but_executable" when the engine could compile it. */
function scoreRow(row, planned) {
  const exp = row.expected;
  const also = exp.alsoAccept || [];
  const got = planned.status === "supported" ? "supported" : planned.status === "needs_clarification" ? "clarify" : planned.status === "unsupported" ? "decline" : "failure";
  let outcome;
  let diffs = [];
  let executable = null;
  if (got === "failure") outcome = "provider_failure";
  else if (got === "supported") {
    executable = compiles(planned.plan);
    if (exp.status === "supported" && exp.plan) {
      diffs = diffPlans(planned.plan, exp.plan);
      outcome = !diffs.length ? "plan_correct" : diffs.every((d) => d.minor) ? "plan_imprecise" : executable ? "wrong_but_executable" : "wrong_not_executable";
    } else outcome = also.includes("supported") ? "plan_correct" : executable ? "wrong_but_executable" : "wrong_not_executable";
  } else if (exp.status === "supported") outcome = also.includes(got) ? "refusal_accepted" : "false_refusal";
  else outcome = got === exp.status || also.includes(got) ? "correct_refusal" : "refusal_kind_differs";
  return { got, outcome, diffs, executable };
}

// ---------------------------------------------------------------------------------------------------------------
// Outcome classes used by the model comparison (a superset of scoreRow's, adding the failure kinds the planner reports)

/**
 * Every row ends in exactly one of these:
 *   plan_correct        the plan means exactly what the corpus expects
 *   plan_imprecise      the same meaning with a larger row limit (acceptable, not exact)
 *   correct_refusal     the corpus expected a clarification/decline (or accepts one) and the model gave a correct one
 *   refusal_accepted    a refusal on a supported row that the corpus lists as acceptable
 *   wrong_but_executable / wrong_not_executable   a plan with the wrong meaning
 *   false_refusal       a supported question was declined / clarified
 *   refusal_kind_differs  a refusal where a different refusal kind was expected
 *   validator_rejected  the model's plan failed the schema or the validator
 *   malformed_output    no usable structured answer (prose, broken JSON, wrong tool, several calls)
 *   timeout             no answer in time
 *   provider_failure    the provider/API failed (HTTP error, network, not configured)
 */
const OUTCOMES = [
  "plan_correct",
  "plan_imprecise",
  "correct_refusal",
  "refusal_accepted",
  "wrong_but_executable",
  "wrong_not_executable",
  "false_refusal",
  "refusal_kind_differs",
  "validator_rejected",
  "malformed_output",
  "timeout",
  "provider_failure",
];

const EXACT = new Set(["plan_correct"]);
const ACCEPTABLE = new Set(["plan_correct", "plan_imprecise", "correct_refusal", "refusal_accepted"]);
const WRONG_PLAN = new Set(["wrong_but_executable", "wrong_not_executable"]);
const INVALID = new Set(["validator_rejected", "malformed_output"]);
const FAILURE = new Set(["timeout", "provider_failure"]);

/**
 * The REPORTING buckets: every outcome belongs to exactly ONE of them, so a table built from them accounts for every evaluated row.
 * The sets above keep their meaning (they are the same outcomes grouped for other questions) but none of them holds false_refusal or
 * refusal_kind_differs, which is how 8 of 380 rows once dropped out of the headline numbers. ACCEPTABLE = exact + imprecise + correctRefusal.
 */
const OUTCOME_BUCKETS = {
  exact: ["plan_correct"],
  imprecise: ["plan_imprecise"],
  correctRefusal: ["correct_refusal", "refusal_accepted"],
  wrongPlan: ["wrong_but_executable", "wrong_not_executable"],
  falseRefusal: ["false_refusal"],
  refusalKindDiffers: ["refusal_kind_differs"],
  invalid: ["validator_rejected", "malformed_output"],
  failure: ["timeout", "provider_failure"],
};
const bucketOf = (outcome) => Object.keys(OUTCOME_BUCKETS).find((b) => OUTCOME_BUCKETS[b].includes(outcome)) || null;

/** Score a planQuestion() result, mapping the planner's own failure codes to the evaluation's outcome classes. */
function classifyPlanned(row, planned) {
  // The model named a customer/supplier/product that does not exist (or is ambiguous) in the tenant's data: the plan it produced cannot
  // run and the user would be told "not found". That is a wrong plan by the model, not a provider failure.
  if (planned.status === "planner_failed" && planned.code === "planner_entity_not_resolved") return { got: "supported", outcome: "wrong_not_executable", diffs: [], executable: false };
  if (planned.status === "planner_failed") {
    const outcome =
      planned.code === "planner_timeout" ? "timeout" : planned.code === "planner_invalid_plan" ? "validator_rejected" : planned.code === "planner_protocol_violation" ? "malformed_output" : "provider_failure";
    return { got: "failure", outcome, diffs: [], executable: null };
  }
  return scoreRow(row, planned);
}

// ---------------------------------------------------------------------------------------------------------------
// Categories (a row can belong to several)

const COMPARISON_GROUPS = new Set(["period_comparison", "growth_decline", "customer_comparison", "product_comparison"]);
const RANKING_GROUPS = new Set(["top_customers", "top_products", "rankings"]);
const PERIOD_GROUPS = new Set(["relative_periods", "explicit_ranges", "fy_yearly"]);
const NAME_DIMS = new Set(["customer", "supplier", "product", "productGroup"]);

const CATEGORIES = {
  english: (r) => r.language === "english",
  hinglish: (r) => r.language === "hinglish",
  mixed: (r) => r.language === "mixed",
  follow_up: (r) => r.group === "follow_up",
  comparison: (r) => COMPARISON_GROUPS.has(r.group) || !!(r.expected.plan && r.expected.plan.compare),
  ranking: (r) => RANKING_GROUPS.has(r.group) || !!(r.expected.plan && r.expected.plan.sort && r.expected.plan.limit),
  period_handling: (r) => PERIOD_GROUPS.has(r.group),
  grouping: (r) => !!(r.expected.plan && (r.expected.plan.groupBy || []).length),
  entity_handling: (r) => !!(r.expected.plan && (r.expected.plan.filters || []).some((f) => NAME_DIMS.has(f.dim))),
  capability_gap: (r) => !!r.needsEngineCapability,
  clarification_decline: (r) => r.expected.status !== "supported",
};

const categoriesOf = (row) => Object.keys(CATEGORIES).filter((k) => CATEGORIES[k](row));

// ---------------------------------------------------------------------------------------------------------------
// Diagnostics (E5): enough structure to see WHY a row did not score cleanly, without re-deriving it
//
// Built by construction from ids, codes and counts only: every identifier must be a member of the catalog/schema's own id sets
// (anything else is shown as "?"), a filter is reduced to dimension, operator and the NUMBER of values, a having to metric and
// operator, a custom date to its YYYY-MM-DD form. No filter value, threshold, name, free text, prompt, result or pipeline can pass.

const SHAPE_IDS = {
  entity: new Set(schema.ENTITY_IDS),
  metric: new Set(schema.METRIC_IDS),
  metricRef: new Set(schema.METRIC_REFS),
  dim: new Set(schema.DIMENSION_IDS),
  bucket: new Set(schema.BUCKETS),
  op: new Set(schema.FILTER_OPS),
  havingOp: new Set(schema.HAVING_OPS),
  sortBy: new Set(schema.SORT_REFS),
  periodKind: new Set(CATALOG.periods.kinds),
  compareMode: new Set(CATALOG.compare.modes),
};
const pick = (set, v) => (typeof v === "string" && set.has(v) ? v : "?");
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const FY_LABEL = /^\d{4}-\d{2}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const PATH = /^[A-Za-z0-9_.]{0,80}$/;
const asCode = (v) => (typeof v === "string" && CODE.test(v) ? v : v === undefined || v === null ? null : "invalid_code");

/** The structure of a plan (validated or exactly as a model submitted it): ids, operators and counts - never a value. Null for a non-object. */
function planShape(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const list = (v) => (Array.isArray(v) ? v.slice(0, 12) : []);
  const p = obj(raw.period);
  let period = pick(SHAPE_IDS.periodKind, p.kind);
  if (p.kind === "custom") period = `custom:${typeof p.from === "string" && ISO_DAY.test(p.from) && typeof p.to === "string" && ISO_DAY.test(p.to) ? `${p.from}..${p.to}` : "?"}`;
  else if (p.kind === "specific_fy") period = `specific_fy:${typeof p.fy === "string" && FY_LABEL.test(p.fy) ? p.fy : "?"}`;
  return {
    entity: pick(SHAPE_IDS.entity, raw.entity),
    mode: raw.mode === "aggregate" || raw.mode === "list" ? raw.mode : "?",
    period,
    compare: raw.compare === null || raw.compare === undefined ? "none" : pick(SHAPE_IDS.compareMode, obj(raw.compare).mode),
    metrics: list(raw.metrics).map((m) => pick(SHAPE_IDS.metric, m)),
    groupBy: list(raw.groupBy).map((g) => {
      const x = obj(g);
      return x.bucket === undefined ? pick(SHAPE_IDS.dim, x.dim) : `${pick(SHAPE_IDS.dim, x.dim)}:${pick(SHAPE_IDS.bucket, x.bucket)}`;
    }),
    filters: list(raw.filters).map((f) => {
      const x = obj(f);
      const n = Array.isArray(x.value) ? x.value.length : typeof x.value === "string" ? 1 : 0;
      return `${pick(SHAPE_IDS.dim, x.dim)}:${pick(SHAPE_IDS.op, x.op)}#${n}`;
    }),
    having: list(raw.having).map((h) => `${pick(SHAPE_IDS.metricRef, obj(h).metric)} ${pick(SHAPE_IDS.havingOp, obj(h).op)}`),
    sort: list(raw.sort).map((x) => `${pick(SHAPE_IDS.sortBy, obj(x).by)} ${obj(x).dir === "asc" || obj(x).dir === "desc" ? obj(x).dir : "?"}`),
    limit: Number.isInteger(raw.limit) ? raw.limit : null,
  };
}

// Rows that scored cleanly need no explanation; every other outcome carries a diagnostic.
const CLEAN_OUTCOMES = new Set(["plan_correct", "correct_refusal", "refusal_accepted"]);
const needsDiagnostic = (outcome) => !CLEAN_OUTCOMES.has(outcome);

/**
 * Why this row scored as it did: what the corpus expected, what the planner reported (status, code, source, the validator's error codes),
 * and the structure of the plan - the planner's final plan when it produced one, otherwise the plan the model submitted (so a rejected
 * plan can be seen). The field-level differences stay on the record itself ("diffs").
 * @param {{row:object, planned:object, outcome:string, got?:string, rawPlan?:object|null}} p
 */
function diagnose({ row, planned, outcome, got = null, rawPlan = null }) {
  const exp = row.expected;
  const finalPlan = planned && planned.plan ? planned.plan : null;
  return {
    expected: { status: exp.status, alsoAccept: [...(exp.alsoAccept || [])], shape: planShape(exp.plan || null) },
    actual: {
      outcome,
      got,
      plannerStatus: asCode(planned && planned.status),
      plannerCode: asCode(planned && planned.code),
      plannerSource: asCode(planned && planned.source),
      shape: planShape(finalPlan || rawPlan),
      shapeFrom: finalPlan ? "planner_plan" : rawPlan ? "model_plan_as_submitted" : null,
    },
    validatorErrors: (planned && Array.isArray(planned.errors) ? planned.errors : []).slice(0, 5).map((e) => ({ code: asCode(e && e.code) || "unknown", path: e && typeof e.path === "string" && PATH.test(e.path) ? e.path : "?" })),
  };
}

module.exports = {
  corpus,
  CORPUS_PATH,
  REF_DATE,
  TENANT,
  canonical,
  diffPlans,
  compiles,
  makeResolver,
  scoreRow,
  classifyPlanned,
  OUTCOMES,
  EXACT,
  ACCEPTABLE,
  WRONG_PLAN,
  INVALID,
  FAILURE,
  OUTCOME_BUCKETS,
  bucketOf,
  CATEGORIES,
  categoriesOf,
  planShape,
  needsDiagnostic,
  diagnose,
};
