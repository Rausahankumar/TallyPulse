"use strict";

// --------------------------------------------------
// Sales/Purchase Query DSL - LAYER 3: deterministic compiler.
//
//   validated plan  ->  MongoDB aggregation pipeline(s)
//
// Guarantees (each asserted by tests AND re-checked at runtime by
// assertPipelineSafe on every compiled pipeline):
//   1. The FIRST stage of every pipeline is exactly the existing scope
//      stage, buildVoucherMatchStage({tenantId, from, to}): tenant +
//      active-vouchers-only + date range. tenantId comes ONLY from the
//      caller's authorized context - the plan has no such field.
//   2. Only allow-listed stages are ever emitted ($match, $unwind,
//      $addFields, $group, $sort, $limit, $project). There is NO $lookup:
//      product groups are resolved by the executor with one explicit,
//      tenant-filtered read of the Stock Item master AFTER aggregating per
//      item (cost scales with distinct items, not with lines), never by a
//      per-line join.
//   3. Nothing from the plan is ever interpolated as an operator, field
//      path, collection or JavaScript. Every field path/operator below is
//      chosen from the catalog by an enum id; user text appears only as an
//      ESCAPED regex literal or as an $in list of item names that the
//      executor read from the tenant's own master.
//   4. Sorting is on values rounded to 6 decimals, so groups that tie to
//      the paisa order by their key (deterministically) instead of by
//      floating-point summation noise.
//
// Compilation is pure: same input, same output, no I/O, no clock.
// --------------------------------------------------

const { buildVoucherMatchStage } = require("../analytics/analyticsScope");
const catalog = require("./semanticCatalog");
const { isValidatedPlan, parseRef } = require("./validator");

const { CATALOG, LIMITS } = catalog;

const ALLOWED_STAGES = new Set(["$match", "$unwind", "$addFields", "$group", "$sort", "$limit", "$project"]);
const FORBIDDEN_OPERATORS = new Set(["$where", "$function", "$accumulator", "$out", "$merge", "$unionWith", "$graphLookup", "$lookup", "$facet", "$replaceRoot", "$replaceWith"]);

// ---------- literals ----------

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// User text becomes an inert, escaped, case-insensitive literal - never a pattern.
function regexCondition(filter) {
  if (filter.op === "eq_ci") return { $regex: `^${escapeRegex(filter.value)}$`, $options: "i" };
  if (filter.op === "in_ci") return { $regex: `^(?:${filter.value.map(escapeRegex).join("|")})$`, $options: "i" };
  return { $regex: escapeRegex(filter.value), $options: "i" }; // contains_ci
}

// ---------- field mapping (catalog-driven, enum ids only) ----------

const PARTY_DIMS = new Set(["customer", "supplier"]);

function bucketExpression(bucket) {
  const date = "$header.voucherDate";
  if (bucket === "fy") {
    // FY starts 1 April: shift back 3 months and take the year => FY start year.
    return { $year: { date: { $dateSubtract: { startDate: date, unit: "month", amount: 3, timezone: "UTC" } }, timezone: "UTC" } };
  }
  const spec = { date, unit: bucket, timezone: "UTC" };
  if (bucket === "week") spec.startOfWeek = "monday";
  return { $dateTrunc: spec };
}

function groupKeyExpression(g) {
  if (g.dim === "date") return bucketExpression(g.bucket);
  if (PARTY_DIMS.has(g.dim)) return "$header.partyName";
  if (g.dim === "product") return "$inventory.itemName";
  // productGroup: aggregate PER ITEM here; the executor rolls items up into
  // their Stock Groups (see execute.js rollupProductGroups).
  if (g.dim === "productGroup") return "$inventory.itemName";
  return "$header.voucherType"; // voucherType
}

function groupId(groupBy) {
  if (!groupBy.length) return null;
  const id = {};
  for (const g of groupBy) id[g.dim] = groupKeyExpression(g);
  return id;
}

// ---------- metrics ----------

const isDerived = (id) => !!CATALOG.metrics[id].derived;
const valueRef = (id) => (isDerived(id) ? `d_${id}` : `m_${id}`);

function baseMetricsNeeded(metrics) {
  const out = [];
  const add = (id) => {
    if (!out.includes(id)) out.push(id);
  };
  for (const id of metrics) {
    const m = CATALOG.metrics[id];
    if (m.derived) {
      add(m.derived.numerator);
      add(m.derived.denominator);
    } else add(id);
  }
  return out;
}

function accumulators(metrics) {
  const acc = {};
  for (const id of baseMetricsNeeded(metrics)) {
    const a = CATALOG.metrics[id].aggregation;
    acc[`m_${id}`] = a.op === "count" ? { $sum: 1 } : { $sum: a.abs ? { $abs: `$${a.path}` } : `$${a.path}` };
  }
  return acc;
}

function derivedFields(metrics) {
  const fields = {};
  for (const id of metrics) {
    const d = CATALOG.metrics[id].derived;
    if (!d) continue;
    fields[`d_${id}`] = {
      $cond: [{ $gt: [`$m_${d.denominator}`, 0] }, { $divide: [`$m_${d.numerator}`, `$m_${d.denominator}`] }, d.zeroDenominator],
    };
  }
  return fields;
}

function projectValues(metrics, { withKey, rolled = false }) {
  const p = { _id: 0 };
  if (withKey) p.key = "$_id";
  for (const id of metrics) p[id] = `$${valueRef(id)}`;
  if (rolled) {
    // Hidden per-item counters the executor needs for the mapping diagnostic.
    p.__lines = "$x_lines";
    p.__amount = "$x_amount";
  }
  return { $project: p };
}

const HAVING_OPS = { gt: "$gt", gte: "$gte", lt: "$lt", lte: "$lte", eq: "$eq", neq: "$ne" };

// ---------- shared prefix: scope -> filters -> unwind ----------

function scopeStage(tenantId, range, entity) {
  const match = buildVoucherMatchStage({ tenantId, from: range.from || undefined, to: range.to || undefined });
  // sales_return / purchase_return: a HARD, never-user-controlled match on
  // AdjustmentNote.classification - the user's filters/groupBy can never
  // widen this to include value_adjustment notes. See semanticCatalog.js's
  // entity definitions.
  const forced = CATALOG.entities[entity] && CATALOG.entities[entity].storage.forcedMatch;
  return { $match: forced ? { ...match, ...forced } : match };
}

function buildPrefix(n, tenantId, range, { groupItemNames, newPartyNames } = {}) {
  const stages = [scopeStage(tenantId, range, n.entity)];

  const voucherMatch = {};
  const and = [];
  for (const f of n.filters) {
    if (PARTY_DIMS.has(f.dim)) voucherMatch["header.partyName"] = f.op === "new_in_period" ? { $in: newPartyNames } : regexCondition(f);
    else if (f.dim === "voucherType") voucherMatch["header.voucherType"] = regexCondition(f);
    else if (n.grain === "voucher") {
      // Invoice-level query filtered by a line attribute: keep invoices that CONTAIN it.
      if (f.dim === "product") and.push({ inventory: { $elemMatch: { itemName: regexCondition(f) } } });
      else and.push({ inventory: { $elemMatch: { itemName: { $in: groupItemNames } } } });
    }
  }
  if (and.length) voucherMatch.$and = and;
  if (Object.keys(voucherMatch).length) stages.push({ $match: voucherMatch });

  if (n.grain === "line") {
    stages.push({ $unwind: "$inventory" });
    for (const f of n.filters) {
      if (f.dim === "product") stages.push({ $match: { "inventory.itemName": regexCondition(f) } });
      else if (f.dim === "productGroup") stages.push({ $match: { "inventory.itemName": { $in: groupItemNames } } });
    }
  }
  return stages;
}

// ---------- query builders ----------

function sortStages(n) {
  const add = {};
  const spec = {};
  for (const s of n.sort) {
    const { base } = parseRef(s.by);
    if (CATALOG.metrics[base]) {
      const src = valueRef(base);
      add[`sk_${src}`] = { $round: [`$${src}`, 6] }; // paisa-level ties break by key, not float noise
      spec[`sk_${src}`] = s.dir === "asc" ? 1 : -1;
    } else {
      spec[`_id.${s.by}`] = s.dir === "asc" ? 1 : -1;
    }
  }
  // Deterministic tie-break on every group key.
  for (const g of n.groupBy) {
    const f = `_id.${g.dim}`;
    if (!(f in spec)) spec[f] = 1;
  }
  return [...(Object.keys(add).length ? [{ $addFields: add }] : []), { $sort: spec }];
}

function havingMatch(n) {
  if (!n.having.length) return null;
  const clauses = n.having.map((h) => ({ [valueRef(parseRef(h.metric).base)]: { [HAVING_OPS[h.op]]: h.value } }));
  return { $match: clauses.length === 1 ? clauses[0] : { $and: clauses } };
}

// finalize=true  : non-comparison, non-rolled -> having/sort/limit run in MongoDB.
//                  limit+1 detects truncation without a second count query.
// finalize=false : the executor needs the FULL group set (comparison, or a
//                  product-group roll-up) and does having/sort/limit itself.
function rowsPipeline(n, tenantId, range, ctx, { finalize, rolled }) {
  const stages = buildPrefix(n, tenantId, range, ctx);
  const rolledAcc = rolled ? { x_lines: { $sum: 1 }, x_amount: { $sum: "$inventory.amount" } } : {};
  stages.push({ $group: { _id: groupId(n.groupBy), ...accumulators(n.metrics), ...rolledAcc } });
  const derived = derivedFields(n.metrics);
  if (Object.keys(derived).length) stages.push({ $addFields: derived });

  if (finalize) {
    const having = havingMatch(n);
    if (having) stages.push(having);
    if (n.groupBy.length) {
      stages.push(...sortStages(n));
      stages.push({ $limit: n.limit + 1 });
    }
  } else {
    stages.push({ $limit: (rolled ? LIMITS.maxRollupRows : LIMITS.maxCompareGroups) + 1 });
  }
  stages.push(projectValues(n.metrics, { withKey: n.groupBy.length > 0, rolled }));
  return stages;
}

function totalsPipeline(n, tenantId, range, ctx) {
  const stages = buildPrefix(n, tenantId, range, ctx);
  stages.push({ $group: { _id: null, ...accumulators(n.metrics) } });
  const derived = derivedFields(n.metrics);
  if (Object.keys(derived).length) stages.push({ $addFields: derived });
  stages.push(projectValues(n.metrics, { withKey: false }));
  return stages;
}

const LIST_SORT_FIELDS = { voucherNo: "header.voucherNo", date: "header.voucherDate", customer: "header.partyName", supplier: "header.partyName", invoiceAmount: "header.voucherTotalAmount", purchaseAmount: "header.voucherTotalAmount" };

function listPipeline(n, tenantId, ctx) {
  const stages = buildPrefix(n, tenantId, n.period, ctx);
  const spec = {};
  for (const s of n.sort) spec[LIST_SORT_FIELDS[s.by]] = s.dir === "asc" ? 1 : -1;
  spec._id = 1; // deterministic tie-break
  stages.push({ $sort: spec });
  stages.push({ $limit: n.limit + 1 });
  const partyColumn = CATALOG.entities[n.entity].partyDimension;
  const amountColumn = n.entity === "sales" ? "invoiceAmount" : "purchaseAmount";
  stages.push({
    $project: {
      _id: 0,
      voucherNo: "$header.voucherNo",
      date: "$header.voucherDate",
      [partyColumn]: "$header.partyName",
      voucherType: "$header.voucherType",
      [amountColumn]: "$header.voucherTotalAmount",
    },
  });
  return stages;
}

// ---------- runtime safety net ----------

function walk(value, visit) {
  if (Array.isArray(value)) return value.forEach((v) => walk(v, visit));
  if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof RegExp)) {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v);
      walk(v, visit);
    }
  }
}

/**
 * Throws unless the pipeline is provably scoped and uses only allow-listed
 * constructs. Exported so tests can prove it rejects tampered pipelines.
 */
function assertPipelineSafe(pipeline, tenantId) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) throw new Error("compile: empty pipeline");

  const first = pipeline[0];
  const keys = first && typeof first === "object" ? Object.keys(first) : [];
  if (keys.length !== 1 || keys[0] !== "$match") throw new Error("compile: first stage must be the tenant scope $match");
  const scope = first.$match;
  if (scope.tenantId !== tenantId) throw new Error("compile: first stage does not carry the authorized tenantId");
  if (!scope.voucherStatus || !Array.isArray(scope.voucherStatus.$in) || scope.voucherStatus.$in.length !== 1 || scope.voucherStatus.$in[0] !== "active") {
    throw new Error("compile: first stage does not restrict to active vouchers");
  }

  for (const stage of pipeline) {
    const names = Object.keys(stage);
    if (names.length !== 1 || !ALLOWED_STAGES.has(names[0])) throw new Error(`compile: stage ${names.join(",")} is not allowed`);
  }
  walk(pipeline, (k) => {
    if (FORBIDDEN_OPERATORS.has(k)) throw new Error(`compile: operator ${k} is forbidden`);
  });
}

// ---------- public API ----------

/**
 * @param {object} n         normalized plan from validateQueryPlan (brand-checked)
 * @param {object} context
 * @param {string} context.tenantId       from the authorized company context ONLY
 * @param {string[]} [context.groupItemNames] required when the plan filters by productGroup:
 *        the item names the executor read from THIS tenant's Stock Item master
 * @param {string[]} [context.newPartyNames] required when the plan has a new_in_period filter: exact
 *        party names the executor read from THIS tenant's Ledger master
 * @returns {{model:string, entity:string, rollup:boolean, queries:Array<{key,model,pipeline,options}>}}
 */
function compileQuery(n, { tenantId, groupItemNames, newPartyNames } = {}) {
  if (!isValidatedPlan(n)) throw new Error("compileQuery only accepts plans produced by validateQueryPlan.");
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("compileQuery requires the authorized tenantId.");

  const needsGroupNames = n.filters.some((f) => f.dim === "productGroup");
  if (needsGroupNames && (!Array.isArray(groupItemNames) || groupItemNames.length > LIMITS.maxGroupItemNames)) {
    throw new Error("compileQuery: a productGroup filter needs resolved item names.");
  }
  const needsNewParties = n.filters.some((f) => f.op === "new_in_period");
  if (needsNewParties && (!Array.isArray(newPartyNames) || newPartyNames.length > LIMITS.maxGroupItemNames)) {
    throw new Error("compileQuery: a new_in_period filter needs resolved party names.");
  }
  const ctx = { groupItemNames, newPartyNames };
  const model = CATALOG.entities[n.entity].storage.model;
  const options = { maxTimeMS: LIMITS.queryTimeoutMs, allowDiskUse: false };
  const queries = [];
  const add = (key, pipeline) => queries.push({ key, model, pipeline, options: { ...options } });

  const rolled = n.mode === "aggregate" && n.groupBy.some((g) => g.dim === "productGroup");

  if (n.mode === "list") {
    add("list", listPipeline(n, tenantId, ctx));
  } else if (n.comparison) {
    add("rows_current", rowsPipeline(n, tenantId, n.period, ctx, { finalize: false, rolled }));
    add("rows_previous", rowsPipeline(n, tenantId, n.comparison, ctx, { finalize: false, rolled }));
    // A roll-up already holds every group, so its totals are the sum of its rows.
    if (n.totals && n.groupBy.length && !rolled) {
      add("totals_current", totalsPipeline(n, tenantId, n.period, ctx));
      add("totals_previous", totalsPipeline(n, tenantId, n.comparison, ctx));
    }
  } else if (rolled) {
    add("rows", rowsPipeline(n, tenantId, n.period, ctx, { finalize: false, rolled }));
  } else {
    add("rows", rowsPipeline(n, tenantId, n.period, ctx, { finalize: true, rolled }));
    if (n.totals && n.groupBy.length) add("totals", totalsPipeline(n, tenantId, n.period, ctx));
  }

  for (const q of queries) assertPipelineSafe(q.pipeline, tenantId);
  return { model, entity: n.entity, rollup: rolled, queries };
}

module.exports = { compileQuery, assertPipelineSafe, escapeRegex, regexCondition, ALLOWED_STAGES };
