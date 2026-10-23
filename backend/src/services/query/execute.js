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
const { buildVoucherMatchStage } = require("../analytics/analyticsScope");
const { storedDayStart, storedDayEnd } = require("../analytics/dateRanges");

// ---------- MongoDB access (injectable for tests) ----------

function getModel(name) {
  if (name === "Sale") return require("../../models/sales.model");
  if (name === "Purchase") return require("../../models/purchase.model");
  if (name === "AdjustmentNote") return require("../../models/adjustmentNote.model");
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

// New party (decision 3): ledgers of THIS tenant created inside the period, from its own Ledger master.
// Names shared by two live ledgers are ambiguous and never counted as new.
const BULK_LEDGER_DAY_THRESHOLD = 50; // ledgers created on one day at or above this look like a bulk import

async function defaultFindNewParties(tenantId, period, timeoutMs) {
  const LedgerMaster = require("../../models/ledgerMaster.model");
  const live = { tenantId, removedAt: null };
  const [latest, docs, undated] = await Promise.all([
    LedgerMaster.findOne(live, { syncedAt: 1, _id: 0 }).sort({ syncedAt: -1 }).maxTimeMS(timeoutMs).lean(),
    LedgerMaster.find({ ...live, createdDate: { $gte: storedDayStart(period.from), $lte: storedDayEnd(period.to) } }, { name: 1, createdDate: 1, _id: 0 })
      .limit(LIMITS.maxGroupItemNames + 1)
      .maxTimeMS(timeoutMs)
      .lean(),
    LedgerMaster.countDocuments({ ...live, createdDate: null }).maxTimeMS(timeoutMs),
  ]);
  if (!latest) return { masterMissing: true };
  const names = [...new Set(docs.map((d) => d.name))];
  const dupes = names.length
    ? await LedgerMaster.aggregate([{ $match: { ...live, name: { $in: names } } }, { $group: { _id: "$name", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
        .option({ maxTimeMS: timeoutMs })
        .exec()
    : [];
  const perDay = new Map();
  for (const d of docs) {
    const day = d.createdDate.toISOString().slice(0, 10);
    if (!perDay.has(day)) perDay.set(day, []);
    perDay.get(day).push(d.name);
  }
  const bulk = [...perDay].filter(([, list]) => list.length >= BULK_LEDGER_DAY_THRESHOLD);
  return {
    masterMissing: false,
    names,
    ambiguous: dupes.map((d) => d._id),
    bulkDays: bulk.map(([day, list]) => ({ day, names: list })),
    undated,
    syncedAt: latest.syncedAt,
  };
}

// One bounded read: for the candidate names, first/last voucher up to the period end. Tells who
// actually traded in the period and who already traded BEFORE their ledger's creation period.
async function newPartyActivity(runAggregate, model, tenantId, period, names) {
  if (!names.length) return [];
  const pipeline = [
    { $match: { ...buildVoucherMatchStage({ tenantId, to: period.to }), "header.partyName": { $in: names } } },
    { $group: { _id: "$header.partyName", first: { $min: "$header.voucherDate" }, last: { $max: "$header.voucherDate" } } },
  ];
  return runAggregate(model, pipeline, { maxTimeMS: LIMITS.queryTimeoutMs, allowDiskUse: false });
}

const nameList = (list) => list.slice(0, 5).join(", ") + (list.length > 5 ? `, and ${list.length - 5} more` : "");

function newPartyWarnings(info, activity, period) {
  const out = [];
  const periodStart = storedDayStart(period.from); // voucher dates are stored as UTC midnight of their calendar day
  const traded = activity.filter((a) => a.last && a.last >= periodStart);
  const tradedSet = new Set(traded.map((a) => a._id));
  const prior = traded.filter((a) => a.first && a.first < periodStart).map((a) => a._id);
  if (prior.length) {
    out.push({ code: "new_party_traded_before_ledger", message: `${prior.length} of these parties already had vouchers before this period even though their ledger was created in it (for example a re-created ledger): ${nameList(prior)}.` });
  }
  const bulkTraded = info.bulkDays.flatMap((b) => b.names.filter((nm) => tradedSet.has(nm)).map((nm) => ({ nm, day: b.day })));
  if (bulkTraded.length) {
    const days = [...new Set(bulkTraded.map((b) => b.day))].join(", ");
    out.push({ code: "new_party_bulk_created_ledgers", message: `${bulkTraded.length} of these parties' ledgers were created in a bulk batch (${days}, likely an import), so their creation date may not be when they became customers/suppliers.` });
  }
  if (info.ambiguous.length) {
    out.push({ code: "new_party_ambiguous_names", message: `${info.ambiguous.length} ledger name(s) created in this period are shared by more than one ledger and were not counted as new: ${nameList(info.ambiguous)}.` });
  }
  if (info.undated > 0) {
    out.push({ code: "new_party_undated_ledgers", message: `${info.undated} ledger(s) have no creation date in Tally and are never counted as new.` });
  }
  if (info.syncedAt && info.syncedAt < period.to) {
    out.push({ code: "ledger_master_as_of", message: `The ledger master was last refreshed on ${info.syncedAt.toISOString().slice(0, 10)}; parties whose ledger was created after that are not counted as new.` });
  }
  return out;
}

// ---------- customerCount: distinct party names resolved against the Ledger master ----------
// Name policy: a sales party name is matched to this tenant's live ledgers by EXACT, case-sensitive equality (both sides are stored
// trimmed; Tally ledger names are unique within a company). No fuzzy matching, no aliases. A name counts as a customer only when it
// matches exactly ONE live ledger and that ledger's partyRole is "debtor". Everything else is excluded and disclosed with counts.

const CUSTOMER_COUNT_BASIS = {
  code: "customer_count_basis",
  message: "Customers are counted from the synced Tally Ledger master: a sales party counts only when its name matches exactly one debtor ledger (Sundry Debtors). Cash, bank and other parties are not counted.",
};

async function defaultFindPartyLedgers(tenantId, names, timeoutMs) {
  const LedgerMaster = require("../../models/ledgerMaster.model");
  const live = { tenantId, removedAt: null };
  const [latest, ledgers] = await Promise.all([
    LedgerMaster.findOne(live, { syncedAt: 1, _id: 0 }).sort({ syncedAt: -1 }).maxTimeMS(timeoutMs).lean(),
    names.length
      ? LedgerMaster.find({ ...live, name: { $in: names } }, { name: 1, partyRole: 1, _id: 0 })
          .limit(2 * LIMITS.maxPartyNames + 1)
          .maxTimeMS(timeoutMs)
          .lean()
      : [],
  ]);
  if (!latest) return { masterMissing: true };
  return { masterMissing: false, ledgers, syncedAt: latest.syncedAt };
}

const distinctMetricIds = (n) => n.metrics.filter((id) => CATALOG.metrics[id].aggregation && CATALOG.metrics[id].aggregation.op === "distinct");

function partyNamesIn(results, ids) {
  const names = new Set();
  for (const rows of Object.values(results)) for (const r of rows) for (const id of ids) for (const nm of Array.isArray(r[id]) ? r[id] : []) if (typeof nm === "string") names.add(nm);
  return names;
}

// name -> "debtor" | "non_debtor" | "unmatched" | "ambiguous"
function classifyParties(names, ledgers) {
  const byName = new Map();
  for (const l of ledgers) {
    if (!byName.has(l.name)) byName.set(l.name, []);
    byName.get(l.name).push(l.partyRole);
  }
  const out = new Map();
  for (const nm of names) {
    const roles = byName.get(nm) || [];
    out.set(nm, roles.length === 0 ? "unmatched" : roles.length > 1 ? "ambiguous" : roles[0] === "debtor" ? "debtor" : "non_debtor");
  }
  return out;
}

// Replaces every distinct metric's name set with the number of its debtor names, in place, before any assembly (so totals, deltas,
// having, sort and limit all see the resolved count).
function applyPartyCounts(results, ids, status) {
  for (const rows of Object.values(results)) for (const r of rows) for (const id of ids) r[id] = (Array.isArray(r[id]) ? r[id] : []).filter((nm) => status.get(nm) === "debtor").length;
}

function customerCountWarnings(status, syncedAt, period) {
  const out = [];
  const of = (kind) => [...status].filter(([, s]) => s === kind).map(([nm]) => nm).sort();
  const parts = [
    [of("non_debtor"), "on a cash, bank or other non-debtor ledger"],
    [of("unmatched"), "with no matching ledger in the synced Ledger master"],
    [of("ambiguous"), "shared by more than one ledger (ambiguous)"],
  ].filter(([list]) => list.length);
  if (parts.length) {
    const total = parts.reduce((t, [list]) => t + list.length, 0);
    out.push({ code: "customer_count_excluded_parties", message: `${total} party name${total === 1 ? "" : "s"} in these sales ${total === 1 ? "is" : "are"} not counted as customers: ${parts.map(([list, why]) => `${list.length} ${why} (${nameList(list)})`).join("; ")}.` });
  }
  if (syncedAt && syncedAt < period.to) {
    out.push({ code: "ledger_master_as_of", message: `The ledger master was last refreshed on ${syncedAt.toISOString().slice(0, 10)}; customers whose ledger was created or changed after that may not be counted.` });
  }
  return out;
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

// Lines of items with no Stock Group in the synced master (or whose name differs from the master's) are left out of a productGroup breakdown
// and of its total. The count and amount were always in `mapping`; this puts them in front of the user as a warning.
function unmappedWarning(mapping) {
  const amount = Number(mapping.unmappedLineAmount).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const lines = mapping.unmappedLines;
  return {
    code: "warn_unmapped_product_group_lines",
    message: `${lines} item line${lines === 1 ? "" : "s"} (₹${amount} before tax) belong to items with no Stock Group in the synced Stock Item master, or whose name differs from the master's, and are left out of these groups and of their total.`,
  };
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
 * @param {Function} [context.findPartyLedgers] injectable (tenantId, names) => Promise<{masterMissing, ledgers:[{name, partyRole}], syncedAt}>
 * @param {Function} [context.findNewParties] injectable (tenantId, period) => Promise<{masterMissing, names, ambiguous, bulkDays, undated, syncedAt}>
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
    // the AI reporting rule (today); chat passes the turn's date, this is only the stand-alone fallback
    referenceDate = (await require("../analytics/referenceDate").getTenantDateContext(tenantId)).referenceDate;
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

    // A new_in_period party filter is resolved to exact names from this tenant's Ledger master.
    let newPartyNames;
    let newPartyInfo = null;
    if (n.filters.some((f) => f.op === "new_in_period")) {
      newPartyInfo = await (context.findNewParties || ((tid, p) => defaultFindNewParties(tid, p, timeoutMs)))(tenantId, n.period);
      if (newPartyInfo.masterMissing) {
        return fail("execution", [{ code: "ledger_master_missing", path: "filters", message: "The Tally ledger master has not been synced for this company yet, so new customers/suppliers cannot be identified." }], { warnings: validation.warnings });
      }
      if (newPartyInfo.names.length > LIMITS.maxGroupItemNames) {
        return fail("execution", [{ code: "result_too_large", path: "filters", message: "Too many ledgers were created in that period to filter by; choose a shorter period." }], { warnings: validation.warnings });
      }
      const ambiguous = new Set(newPartyInfo.ambiguous);
      newPartyNames = newPartyInfo.names.filter((nm) => !ambiguous.has(nm));
    }

    const compiled = compileQuery(n, { tenantId, groupItemNames, newPartyNames });
    const settled = await Promise.all(compiled.queries.map((q) => runAggregate(q.model, q.pipeline, q.options)));
    const results = Object.fromEntries(compiled.queries.map((q, i) => [q.key, settled[i]]));

    // customerCount: resolve every distinct party name once (one bounded Ledger master read), then replace the name sets by counts.
    let partyInfo = null;
    const distinctIds = distinctMetricIds(n);
    if (distinctIds.length) {
      const names = partyNamesIn(results, distinctIds);
      if (names.size > LIMITS.maxPartyNames) {
        return fail("execution", [{ code: "result_too_large", path: "metrics", message: `More than ${LIMITS.maxPartyNames} different parties are involved; choose a shorter period or add a filter.` }], { warnings: validation.warnings });
      }
      const found = await (context.findPartyLedgers || ((tid, list) => defaultFindPartyLedgers(tid, list, timeoutMs)))(tenantId, [...names]);
      if (found.masterMissing) {
        return fail("execution", [{ code: "ledger_master_missing", path: "metrics", message: "The Tally ledger master has not been synced for this company yet, so customers cannot be counted." }], { warnings: validation.warnings });
      }
      if (found.ledgers.length > 2 * LIMITS.maxPartyNames) {
        return fail("execution", [{ code: "result_too_large", path: "metrics", message: "Too many ledgers match these parties to count them reliably; choose a shorter period or add a filter." }], { warnings: validation.warnings });
      }
      const status = classifyParties(names, found.ledgers);
      applyPartyCounts(results, distinctIds, status);
      partyInfo = { status, syncedAt: found.syncedAt };
    }

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
    } else if (compiled.inMemory && n.groupBy.length) {
      // Grouped distinct count without a comparison: having/sort/limit on the RESOLVED counts; the total is its own query, never a sum.
      if (results.rows.length > LIMITS.maxCompareGroups) {
        return fail("execution", [{ code: "result_too_large", path: "", message: `The breakdown spans more than ${LIMITS.maxCompareGroups} groups; add a filter or use a shorter period.` }], { warnings: validation.warnings });
      }
      const totals = n.totals ? { values: metricValues(n, results.totals && results.totals[0]) } : null;
      assembled = finalizeInMemory(n, toRows(n, results.rows), null, totals);
    } else {
      assembled = assemblePlain(n, results);
    }

    let warnings = validation.warnings;
    if (mapping && mapping.unmappedLines > 0) warnings = [...warnings, unmappedWarning(mapping)];
    if (newPartyInfo) {
      const activity = await newPartyActivity(runAggregate, compiled.queries[0].model, tenantId, n.period, newPartyNames);
      warnings = [...warnings, ...newPartyWarnings(newPartyInfo, activity, n.period)];
    }
    if (partyInfo) warnings = [...warnings, ...customerCountWarnings(partyInfo.status, partyInfo.syncedAt, n.period)];
    const assumptions = partyInfo ? [...validation.assumptions, CUSTOMER_COUNT_BASIS] : validation.assumptions;

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
      warnings,
      assumptions,
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
