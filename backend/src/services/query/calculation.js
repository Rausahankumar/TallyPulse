"use strict";

// --------------------------------------------------
// The calculation record of a single-query answer ("View calculation", phase 1: data only, no UI).
//
// A pure, deterministic description of what EXECUTED: the validated plan, the engine result and the notes the answer already
// carries. Every number in it is a value the engine returned (totals, previous values, changes, percentages, rows); nothing is
// added, summed, divided or rounded here. Formulas are the fixed rules of the code that produced those values
// (salesAnalytics.computeGrowth for a change, the catalog's derived ratio for an average), stated with the engine's own inputs.
// What the result cannot show truthfully is marked unavailable, never filled in. No model call, no database.
// --------------------------------------------------

const { CATALOG } = require("./semanticCatalog");
const { dayOf } = require("./evidence");

const CALCULATION_VERSION = 1;

const BASIS = {
  voucher_total_incl_tax: { id: "voucher_total_incl_tax", text: "Invoice totals including tax" },
  line_item_pre_tax: { id: "line_item_pre_tax", text: "Item line values before tax (do not add up to invoice totals)" },
};
const GRAIN = { voucher: "invoice", line: "item line" };
// what was counted (analyticsScope: active vouchers only; returns: compile.js's forced classification match)
const RECORDS = {
  sales: "Active Sales vouchers (cancelled and deleted vouchers are not counted)",
  purchase: "Active Purchase vouchers (cancelled and deleted vouchers are not counted)",
  sales_return: "Active Credit Notes classified as sales returns (value adjustments are not counted)",
  purchase_return: "Active Debit Notes classified as purchase returns (value adjustments are not counted)",
};

// canonical JSON (key order free), so a filter is "the same" only when every part of it is
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const metricLabel = (id) => (CATALOG.metrics[id] ? CATALOG.metrics[id].label : id);

/** How a metric is computed, from the catalog's structured fields only (its planner-facing description is not used). */
function definitionOf(id) {
  const m = CATALOG.metrics[id];
  if (!m) return { id, label: id, available: false };
  const out = { id, label: m.label, grain: GRAIN[m.grain] || m.grain, basis: m.amountBasis ? BASIS[m.amountBasis] || { id: m.amountBasis } : null, disclosures: [...(m.disclosures || [])] };
  if (m.derived && m.derived.op === "ratio") out.rule = { op: "ratio", numerator: { id: m.derived.numerator, label: metricLabel(m.derived.numerator) }, denominator: { id: m.derived.denominator, label: metricLabel(m.derived.denominator) }, whenDenominatorZero: m.derived.zeroDenominator };
  else if (m.aggregation) out.rule = { op: m.aggregation.op, per: GRAIN[m.grain] || m.grain };
  return out;
}

/**
 * Where each filter came from, only where the stored previous scope proves it: "same_as_previous" when the previous turn's
 * plan (or an analysis turn's carried scope) holds exactly the same filter; "this_question" when there was no previous scope
 * (the planner had nothing else to take it from) or the previous one did not hold it. Never "inherited" by guess.
 */
function filtersOf(plan, previousScope) {
  const prev = previousScope && Array.isArray(previousScope.filters) ? new Set(previousScope.filters.map(canonical)) : null;
  return (plan.filters || []).map((f) => ({
    dim: f.dim,
    label: CATALOG.dimensions[f.dim] ? CATALOG.dimensions[f.dim].label : f.dim,
    op: f.op,
    value: f.value,
    origin: prev && prev.has(canonical(f)) ? "same_as_previous" : "this_question",
  }));
}

const periodOf = (r) => (r ? { label: r.label || null, from: dayOf(r.from), to: dayOf(r.to) } : null);

/**
 * The change formula, exactly as computeGrowth computed the engine's values: change = current − previous; % change =
 * change ÷ |previous| × 100, not defined when previous is 0 (the engine returns null; never shown as 0% or infinite).
 */
function changeOf(current, c) {
  const previous = num(c.previous), delta = num(c.delta), pct = num(c.deltaPct);
  return {
    previous,
    change: { formula: "current − previous", inputs: { current, previous }, value: delta },
    changePct: previous === 0
      ? { formula: "change ÷ |previous| × 100", available: false, reason: "previous_is_zero" }
      : { formula: "change ÷ |previous| × 100", inputs: { change: delta, previous }, value: pct },
  };
}

/** A derived ratio's inputs, only when the same plan measured both of them (else stated unavailable, never recomputed). */
function ratioInputs(id, values) {
  const d = CATALOG.metrics[id] && CATALOG.metrics[id].derived;
  if (!d || d.op !== "ratio") return undefined;
  const a = num(values[d.numerator]), b = num(values[d.denominator]);
  return a !== null && b !== null ? { numerator: a, denominator: b } : { available: false, reason: "inputs_not_measured" };
}

function keyOf(key) {
  return Object.fromEntries(Object.entries(key || {}).map(([dim, v]) => [dim, v && typeof v === "object" ? { label: v.label, start: v.start || null } : v]));
}

/**
 * @param {object} input
 * @param {object} input.plan the validated, executed plan
 * @param {object} input.result the engine result (execute.js)
 * @param {boolean} [input.zero] formatQueryAnswer's "no matching records"
 * @param {object|null} [input.previousScope] the stored scope of the previous turn (followUp.scopeOf), or null
 * @param {Array} [input.definitionNotes] fixed server-side rules applied to the plan ({code, message})
 * @param {string[]} [input.plannerAssumptions] the planner's own interpretation lines (AI-assisted)
 * @param {Array} [input.contextNotes] coverage / complete-period / future-voucher notes ({code, message})
 * @param {object|null} [input.freshness] the turn's freshness object
 * @param {Date|string|null} [input.dataThrough] the latest voucher's day
 * @returns {object} the calculation record (JSON-safe)
 */
function buildCalculation({ plan, result, zero = false, previousScope = null, definitionNotes = [], plannerAssumptions = [], contextNotes = [], freshness = null, dataThrough = null }) {
  const metrics = result.metrics || plan.metrics || [];
  const groups = plan.groupBy || [];
  const totals = result.totals && result.totals.values ? result.totals : null;
  const record = {
    v: CALCULATION_VERSION,
    kind: plan.mode === "list" ? "list" : groups.length ? "breakdown" : "total",
    entity: { id: plan.entity, label: CATALOG.entities[plan.entity] ? CATALOG.entities[plan.entity].label : plan.entity },
    records: RECORDS[plan.entity] || null,
    period: periodOf(result.period),
    compare: periodOf(result.comparison),
    filters: filtersOf(plan, previousScope),
    previousScope: previousScope ? "available" : "none",
    metrics: metrics.map(definitionOf),
    zero: !!zero,
  };

  // the measured values: the overall total (unaffected by the row limit), its comparison, and a derived ratio's inputs
  if (plan.mode === "list") record.values = { available: false, reason: "invoice_list_has_no_total" };
  else if (zero) record.values = { available: false, reason: "no_matching_records" };
  else if (!totals) record.values = { available: false, reason: "total_not_returned" };
  else {
    record.values = metrics.map((id) => {
      const current = num(totals.values[id]);
      const out = { metric: id, current };
      const c = totals.comparison && totals.comparison[id];
      if (c && record.compare) Object.assign(out, changeOf(current, c));
      const inputs = ratioInputs(id, totals.values);
      if (inputs) out.ratioInputs = inputs;
      return out;
    });
    if (groups.length) record.totalCovers = "all matching records, including groups beyond the row limit";
  }

  // the rows the engine returned, in its order (exact values; nothing summed here)
  if (groups.length || plan.mode === "list") {
    const rows = result.rows || [];
    record.rows = {
      dimensions: groups.map((g) => (g.dim === "date" ? { dim: "date", bucket: g.bucket } : { dim: g.dim, label: CATALOG.dimensions[g.dim] ? CATALOG.dimensions[g.dim].label : g.dim })),
      shown: rows.length,
      truncated: !!result.truncated,
      rowLimit: num(result.rowLimit),
      sort: (plan.sort || []).map((s) => ({ by: s.by, dir: s.dir })),
      items: plan.mode === "list"
        ? rows.map((r) => ({ voucherNo: r.voucherNo, date: r.date, party: r.customer || r.supplier || null, amount: num(r.invoiceAmount !== undefined ? r.invoiceAmount : r.purchaseAmount) }))
        : rows.map((r) => {
          const item = { key: keyOf(r.key), values: {} };
          for (const id of metrics) {
            const v = { current: num(r.values && r.values[id]) };
            const c = r.comparison && r.comparison[id];
            if (c && record.compare) Object.assign(v, changeOf(v.current, c));
            item.values[id] = v;
          }
          if (r.presence) item.presence = r.presence;
          return item;
        }),
    };
    if (result.truncated) record.rows.note = "Only the first rows are listed; the listed rows do not add up to the total.";
  }

  // how it was interpreted and what limits it (texts the answer already carries; nothing new)
  record.rulesApplied = (definitionNotes || []).map((n) => ({ code: n.code || null, text: n.message }));
  record.interpretation = (plannerAssumptions || []).map((a) => ({ source: "ai_assisted", text: a }));
  record.limitations = [
    ...(contextNotes || []).map((n) => ({ code: n.code || null, text: n.message })),
    ...(result.assumptions || []).map((a) => ({ code: a.code || null, text: a.message })),
    ...(result.warnings || []).map((w) => ({ code: w.code || null, text: w.message })),
  ].filter((l, i, all) => l.text && all.findIndex((x) => x.text === l.text) === i);
  const latestVoucher = dataThrough instanceof Date ? dayOf(dataThrough) : typeof dataThrough === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dataThrough) ? dataThrough : null;
  // incomplete: only what the turn established (partial coverage, a to-date period) or a plain date comparison (the period
  // ends after the latest voucher); all history is never called incomplete
  const incomplete = [];
  if ((contextNotes || []).some((n) => n.code === "coverage_partial")) incomplete.push("partly_outside_synced_data");
  if (result.period && result.period.isPartial) incomplete.push("period_to_date");
  if (plan.period && plan.period.kind !== "all_time" && latestVoucher && record.period && record.period.to && record.period.to > latestVoucher) incomplete.push("period_ends_after_latest_voucher");
  if (incomplete.length) record.incomplete = { reasons: incomplete };
  record.data = {
    freshness: freshness ? { state: freshness.state || null, dataAsOf: freshness.dataAsOf ? new Date(freshness.dataAsOf).toISOString() : null } : { available: false },
    latestVoucher,
  };
  // not recorded by the engine for this answer: said so, never inferred
  record.unavailable = ["source_records", "request_id", "data_version", ...(metrics.some((m) => /Count$/.test(m)) ? [] : ["record_count"])];
  return record;
}

module.exports = { buildCalculation, CALCULATION_VERSION };
