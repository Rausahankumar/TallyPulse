"use strict";

// --------------------------------------------------
// Sales/Purchase Query DSL - LAYER 4: executor.
//
//   raw plan -> validate -> compile -> MongoDB (maxTimeMS) -> structured result
//
// No LLM anywhere. The tenant comes ONLY from `context.tenantId`, which the
// caller must have derived via resolveAuthorizedCompany - the plan cannot
// carry one. Returns structured data only (no prose): the deterministic
// formatter / result shaper are later phases.
//
// Three result paths:
//   plain      - having/sort/limit run inside MongoDB (bounded by limit+1).
//   comparison - the pipeline runs once per period; the two FULL group sets
//                are merged here (full outer join on the group key, missing
//                side = 0) using the EXISTING computeGrowth(), so growth
//                semantics cannot diverge from the current analytics.
//   roll-up    - productGroup queries aggregate PER ITEM in MongoDB, then map
//                item -> Stock Group with ONE tenant-filtered read of the
//                Stock Item master and sum up here. Same semantics as the
//                old per-line join (exact item-name match, current Tally
//                classification, unmapped items excluded and reported) at a
//                cost that scales with distinct items, not voucher lines.
// --------------------------------------------------

const { parseQueryPlan } = require("./queryPlan.schema");
const { validateQueryPlan, parseRef } = require("./validator");
const { compileQuery, regexCondition } = require("./compile");
const catalog = require("./semanticCatalog");
const { computeGrowth } = require("../analytics/salesAnalytics");

const { CATALOG, LIMITS } = catalog;

// ---------- MongoDB access (injectable for tests) ----------

function getModel(name) {
  if (name === "Sale") return require("../../models/sales.model");
  if (name === "Purchase") return require("../../models/purchase.model");
  throw new Error(`execute: unknown model ${name}`);
}

// Builds (does not run) the aggregate, so tests can assert maxTimeMS is set.
function buildAggregate(modelName, pipeline, options) {
  return getModel(modelName)
    .aggregate(pipeline)
    .option({ maxTimeMS: options.maxTimeMS })
    .allowDiskUse(options.allowDiskUse === true);
}

function defaultRunAggregate(modelName, pipeline, options) {
  return buildAggregate(modelName, pipeline, options).exec();
}

// The ONLY reads outside the compiled pipelines, both explicitly filtered by
// tenantId: the tenant's own Stock Item master (item -> group).
async function defaultLoadStockGroupMap(tenantId, timeoutMs) {
  const StockItemMaster = require("../../models/stockItemMaster.model");
  const docs = await StockItemMaster.find({ tenantId }, { itemName: 1, stockGroupName: 1, _id: 0 }).maxTimeMS(timeoutMs).lean();
  return new Map(docs.map((d) => [d.itemName, d.stockGroupName]));
}

async function defaultFindGroupItemNames(tenantId, filter, timeoutMs) {
  const StockItemMaster = require("../../models/stockItemMaster.model");
  const docs = await StockItemMaster.find({ tenantId, stockGroupName: regexCondition(filter) }, { itemName: 1, _id: 0 })
    .limit(LIMITS.maxGroupItemNames + 1)
    .maxTimeMS(timeoutMs)
    .lean();
  return docs.map((d) => d.itemName);
}

function isTimeout(error) {
  return !!error && (error.code === 50 || /exceeded time limit|MaxTimeMSExpired/i.test(String(error.message || "")));
}

// ---------- result helpers ----------

const iso = (d) => (d instanceof Date ? d.toISOString() : null);
const rd6 = (v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v);

function periodOut(p) {
  return { kind: p.kind, from: iso(p.from), to: iso(p.to), label: p.label, isPartial: p.isPartial };
}

function comparisonOut(c) {
  return c ? { mode: c.mode, canonicalMode: c.canonicalMode, from: iso(c.from), to: iso(c.to), label: c.label } : null;
}

function fyLabel(startYear) {
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// Bucket keys come back from MongoDB as Dates (day/week/month/quarter) or
// an integer FY start year; turn them into stable, readable keys.
function formatDateKey(bucket, value) {
  if (bucket === "fy") return { bucket, start: `${value}-04-01`, label: fyLabel(value) };
  const start = new Date(value).toISOString().slice(0, 10);
  if (bucket === "day") return { bucket, start, label: start };
  if (bucket === "week") return { bucket, start, label: `week of ${start}` };
  if (bucket === "month") return { bucket, start, label: start.slice(0, 7) };
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  const fy = m >= 4 ? y : y - 1;
  const q = Math.floor(((m - 4 + 12) % 12) / 3) + 1;
  return { bucket, start, label: `${fyLabel(fy)} Q${q}` };
}

function outKey(n, rawKey) {
  const key = {};
  for (const g of n.groupBy) {
    const v = rawKey ? rawKey[g.dim] : null;
    key[g.dim] = g.dim === "date" ? formatDateKey(g.bucket, v) : v;
  }
  return key;
}

const metricValues = (n, row) => Object.fromEntries(n.metrics.map((id) => [id, row && typeof row[id] === "number" ? row[id] : 0]));
const toRows = (n, raw) => raw.map((r) => ({ key: outKey(n, r.key), values: metricValues(n, r) }));

function sumValues(n, rows) {
  const out = metricValues(n, null);
  for (const r of rows) for (const id of n.metrics) out[id] += r.values[id];
  return out;
}

function amountBasisOut(n) {
  const out = {};
  for (const id of n.metrics) if (CATALOG.metrics[id].amountBasis) out[id] = CATALOG.metrics[id].amountBasis;
  return out;
}

function growthFor(n, current, previous) {
  const out = {};
  for (const id of n.metrics) {
    const g = computeGrowth(current[id], previous[id]);
    out[id] = { previous: previous[id], delta: g.growthAmount, deltaPct: g.growthPercentage };
  }
  return out;
}

function refValue(ref, current, cmp) {
  const { base, suffix } = parseRef(ref);
  if (!suffix) return current[base];
  return cmp[base][suffix];
}

const OPS = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
};

// ---------- product-group roll-up ----------

// Raw rows are per ITEM (key.productGroup holds the item name). Sum them into
// their Stock Groups; items with no master record are excluded and counted.
function rollupProductGroups(n, raw, groupMap) {
  for (const id of n.metrics) if (CATALOG.metrics[id].derived) throw new Error("roll-up: derived metrics are not additive");

  const out = new Map();
  const mapping = { mappedLines: 0, unmappedLines: 0, mappedLineAmount: 0, unmappedLineAmount: 0, classificationBasis: "current_stock_item_master" };
  for (const r of raw) {
    const lines = r.__lines || 0;
    const amount = r.__amount || 0;
    const group = groupMap.get(r.key.productGroup);
    if (group === undefined || group === null) {
      mapping.unmappedLines += lines;
      mapping.unmappedLineAmount += amount;
      continue;
    }
    mapping.mappedLines += lines;
    mapping.mappedLineAmount += amount;
    const key = { ...r.key, productGroup: group };
    const id = JSON.stringify(key);
    if (!out.has(id)) out.set(id, { key, ...metricValues(n, null) });
    const acc = out.get(id);
    for (const m of n.metrics) acc[m] += typeof r[m] === "number" ? r[m] : 0;
  }
  return { rows: [...out.values()], mapping };
}

// ---------- in-memory finalization (comparison + roll-up) ----------

function finalizeInMemory(n, cur, prev, totals) {
  const zeros = metricValues(n, null);
  const map = new Map();
  const put = (rows, side) => {
    for (const r of rows) {
      const id = JSON.stringify(r.key);
      if (!map.has(id)) map.set(id, { _id: id, key: r.key, cur: null, prev: null });
      map.get(id)[side] = r.values;
    }
  };
  put(cur, "cur");
  if (prev) put(prev, "prev");

  let rows = [...map.values()].map((e) => {
    const values = e.cur || zeros;
    if (!prev) return { _id: e._id, key: e.key, values };
    const previous = e.prev || zeros;
    return {
      _id: e._id,
      key: e.key,
      presence: e.cur && e.prev ? "both" : e.cur ? "current_only" : "previous_only",
      values,
      comparison: growthFor(n, values, previous),
    };
  });

  // having: a null value (e.g. deltaPct with no previous) never satisfies any comparison.
  rows = rows.filter((r) =>
    n.having.every((h) => {
      const v = refValue(h.metric, r.values, r.comparison);
      return v !== null && v !== undefined && OPS[h.op](v, h.value);
    })
  );

  const sortValue = (r, s) => {
    const { base } = parseRef(s.by);
    return CATALOG.metrics[base] ? rd6(refValue(s.by, r.values, r.comparison)) : JSON.stringify(r.key[s.by]);
  };
  rows.sort((a, b) => {
    for (const s of n.sort) {
      const va = sortValue(a, s);
      const vb = sortValue(b, s);
      if (va === vb) continue;
      if (va === null || va === undefined) return 1; // nulls last, either direction
      if (vb === null || vb === undefined) return -1;
      const c = va < vb ? -1 : 1;
      return s.dir === "asc" ? c : -c;
    }
    return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
  });

  const truncated = rows.length > n.limit;
  rows = rows.slice(0, n.limit).map(({ _id, ...rest }) => rest);

  let totalsOut = null;
  if (n.totals && totals) {
    totalsOut = { values: totals.values };
    if (prev) totalsOut.comparison = growthFor(n, totals.values, totals.previousValues);
  }
  return { rows, truncated, totals: totalsOut };
}

// ---------- assembly ----------

function assembleScalarComparison(n, results) {
  const c = metricValues(n, results.rows_current[0]);
  const p = metricValues(n, results.rows_previous[0]);
  return { rows: [], truncated: false, totals: { values: c, comparison: growthFor(n, c, p) } };
}

function assemblePlain(n, results) {
  const raw = results.rows;
  if (n.groupBy.length === 0) return { rows: [], truncated: false, totals: { values: metricValues(n, raw[0]) } };
  const truncated = raw.length > n.limit;
  const rows = raw.slice(0, n.limit).map((r) => ({ key: outKey(n, r.key), values: metricValues(n, r) }));
  const totals = n.totals ? { values: metricValues(n, results.totals && results.totals[0]) } : null;
  return { rows, truncated, totals };
}

function assembleList(n, results) {
  const raw = results.list;
  const truncated = raw.length > n.limit;
  const rows = raw.slice(0, n.limit).map((r) => ({ ...r, date: iso(r.date) ? iso(r.date).slice(0, 10) : null }));
  return { rows, truncated, totals: null };
}

// ---------- public API ----------

function fail(stage, errors, extra = {}) {
  return { ok: false, stage, errors, warnings: [], ...extra };
}

/**
 * @param {object} rawPlan candidate plan
 * @param {object} context
 * @param {string} context.tenantId  from the authorized company context ONLY
 * @param {Date}   [context.referenceDate] tenant reference date; resolved from the data when omitted
 * @param {Function} [context.runAggregate] injectable (model, pipeline, options) => Promise<rows>
 * @param {Function} [context.findGroupItemNames] injectable (tenantId, filter) => Promise<string[]>
 * @param {Function} [context.loadStockGroupMap] injectable (tenantId) => Promise<Map(item -> group)>
 */
async function executeQuery(rawPlan, context = {}) {
  const { tenantId } = context;
  if (typeof tenantId !== "string" || !tenantId.trim()) {
    return fail("context", [{ code: "tenant_context_required", path: "", message: "No authorized company context - refusing to run any query." }]);
  }
  const runAggregate = context.runAggregate || defaultRunAggregate;

  // Resolve the tenant reference date only when the plan actually needs it.
  let referenceDate = context.referenceDate;
  const pre = parseQueryPlan(rawPlan);
  if (pre.ok && !referenceDate && pre.plan.period.kind !== "all_time" && pre.plan.period.kind !== "custom") {
    const { getTenantReferenceDate } = require("../analytics/referenceDate");
    referenceDate = await getTenantReferenceDate(tenantId);
  }

  const validation = validateQueryPlan(rawPlan, { referenceDate });
  if (!validation.ok) return { ok: false, stage: validation.stage, errors: validation.errors, warnings: validation.warnings };

  const n = validation.normalized;
  const timeoutMs = LIMITS.queryTimeoutMs;

  try {
    // A productGroup FILTER is resolved to this tenant's own item names first.
    let groupItemNames;
    const groupFilter = n.filters.find((f) => f.dim === "productGroup");
    if (groupFilter) {
      groupItemNames = await (context.findGroupItemNames || ((tid, f) => defaultFindGroupItemNames(tid, f, timeoutMs)))(tenantId, groupFilter);
      if (groupItemNames.length > LIMITS.maxGroupItemNames) {
        return fail("execution", [{ code: "result_too_large", path: "filters", message: "That product group matches too many items to filter by; choose a narrower group." }], { warnings: validation.warnings });
      }
    }

    const compiled = compileQuery(n, { tenantId, groupItemNames });
    const settled = await Promise.all(compiled.queries.map((q) => runAggregate(q.model, q.pipeline, q.options)));
    const results = Object.fromEntries(compiled.queries.map((q, i) => [q.key, settled[i]]));

    let assembled;
    let mapping = null;

    if (n.mode === "list") {
      assembled = assembleList(n, results);
    } else if (compiled.rollup) {
      const curRaw = results.rows_current || results.rows;
      const prevRaw = results.rows_previous || null;
      if (curRaw.length > LIMITS.maxRollupRows || (prevRaw && prevRaw.length > LIMITS.maxRollupRows)) {
        return fail("execution", [{ code: "result_too_large", path: "", message: `The per-item breakdown exceeds ${LIMITS.maxRollupRows} rows; add a filter or use a shorter period.` }], { warnings: validation.warnings });
      }
      const groupMap = await (context.loadStockGroupMap || ((tid) => defaultLoadStockGroupMap(tid, timeoutMs)))(tenantId);
      const rc = rollupProductGroups(n, curRaw, groupMap);
      const rp = prevRaw ? rollupProductGroups(n, prevRaw, groupMap) : null;
      const cur = toRows(n, rc.rows);
      const prev = rp ? toRows(n, rp.rows) : null;
      const totals = n.totals ? { values: sumValues(n, cur), previousValues: prev ? sumValues(n, prev) : null } : null;
      assembled = finalizeInMemory(n, cur, prev, totals);
      mapping = rc.mapping;
    } else if (n.comparison) {
      if (n.groupBy.length === 0) {
        assembled = assembleScalarComparison(n, results);
      } else {
        if (results.rows_current.length > LIMITS.maxCompareGroups || results.rows_previous.length > LIMITS.maxCompareGroups) {
          return fail("execution", [{ code: "result_too_large", path: "", message: `The comparison spans more than ${LIMITS.maxCompareGroups} groups; add a filter or use a shorter period.` }], { warnings: validation.warnings });
        }
        const totals = n.totals ? { values: metricValues(n, results.totals_current[0]), previousValues: metricValues(n, results.totals_previous[0]) } : null;
        assembled = finalizeInMemory(n, toRows(n, results.rows_current), toRows(n, results.rows_previous), totals);
      }
    } else {
      assembled = assemblePlain(n, results);
    }

    return {
      ok: true,
      entity: n.entity,
      mode: n.mode,
      grain: n.grain,
      period: periodOut(n.period),
      comparison: comparisonOut(n.comparison),
      metrics: n.metrics,
      groupBy: n.groupBy,
      amountBasis: amountBasisOut(n),
      rows: assembled.rows,
      totals: assembled.totals,
      truncated: assembled.truncated,
      rowLimit: n.limit,
      mapping,
      warnings: validation.warnings,
      assumptions: validation.assumptions,
      diagnostics: { catalogVersion: catalog.CATALOG_VERSION, complexity: n.complexity, queryCount: compiled.queries.length, timeoutMs },
    };
  } catch (error) {
    if (isTimeout(error)) {
      return fail("execution", [{ code: "query_timeout", path: "", message: `The query exceeded the ${timeoutMs}ms limit; narrow the period or add a filter.` }], { warnings: validation.warnings });
    }
    // Never leak driver/internal detail to a caller (or, later, to Claude).
    console.error("QUERY ENGINE ERROR:", error && error.name, error && error.message);
    return fail("execution", [{ code: "query_failed", path: "", message: "The query could not be completed." }], { warnings: validation.warnings });
  }
}

module.exports = { executeQuery, buildAggregate, formatDateKey };
