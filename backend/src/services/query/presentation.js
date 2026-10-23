"use strict";

// --------------------------------------------------
// Presentation model for Query Engine answers (response/visualisation layer ONLY).
//
// A deterministic, JSON-serialisable description of how an ENGINE RESULT should be shown (KPI, ranking,
// trend, comparison, table or empty state). It is built from the plan and the result the engine already
// returned - no Claude call, no re-query, no recalculation of any financial figure. Every number carried
// here is a value the engine produced, formatted with the same helpers as the text answer. The one derived
// column - "Avg order" in a comparison - is amount / orders of two returned values, and is marked `derived`.
//
// Carried in the existing response/persisted slot `visualization` (chat.model.js), so reloaded chats render
// the same way. The text `answer` is unchanged and remains the fallback for anything not described here
// (clarifications, refusals, failures). Any failure returns null: presentation can never affect
// the answer.
// --------------------------------------------------

const { CATALOG } = require("./semanticCatalog");
const { rangeText } = require("../analytics/coverage");
const { fmtValue, fmtSigned, pctOf, periodText } = require("./answerFormatter");

const PRESENTATION_VERSION = 1;
const MAX_TABLE_ROWS = 25;
const MAX_CHART_POINTS = 10;

const SHORT = {
  invoiceAmount: "Sales", invoiceCount: "Orders", averageInvoiceValue: "Avg order",
  purchaseAmount: "Purchases", purchaseInvoiceCount: "Orders", averagePurchaseValue: "Avg order",
  lineAmount: "Amount (pre-tax)", quantity: "Quantity", lineCount: "Lines",
  returnAmount: "Returns", returnCount: "Return notes", returnQuantity: "Returned qty", returnLineAmount: "Returned value (pre-tax)",
};
const COUNT_UNIT = { invoiceCount: "invoices", purchaseInvoiceCount: "invoices", lineCount: "lines", returnCount: "return notes" };
const shortLabel = (id) => SHORT[id] || (CATALOG.metrics[id] && CATALOG.metrics[id].label) || id;
const isMoney = (id) => !!(CATALOG.metrics[id] && CATALOG.metrics[id].amountBasis);
const primaryOf = (metrics) => metrics.find((m) => /Amount$/.test(m)) || metrics[0];

const BASIS_TEXT = {
  voucher_total_incl_tax: "Invoice amounts are invoice totals including tax.",
  line_item_pre_tax: "Amounts are pre-tax line-item totals (revenue), not invoice totals.",
};
// The basis lines the text answer already prints; the presentation states the basis once, in its own field.
const BASIS_NOTES = new Set(["Invoice amounts are invoice totals including tax.", "Line amounts are item values before tax."]);

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ymd = /^\d{4}-\d{2}-\d{2}$/;

/** "2025-08-01".."2025-08-31" -> "August 2025"; other ranges stay explicit. */
function customLabel(p) {
  if (!p || !ymd.test(p.from) || !ymd.test(p.to)) return null;
  if (p.from === p.to) return p.from;
  const [y, m] = p.from.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (p.from === `${p.from.slice(0, 8)}01` && p.to === `${p.from.slice(0, 7)}-${String(last).padStart(2, "0")}`) return `${MONTH_NAMES[m - 1]} ${y}`;
  return `${p.from} → ${p.to}`;
}

function currentLabel(plan, result) {
  const p = plan.period;
  if (p.kind === "custom") return customLabel(p) || periodText(plan, result);
  if (p.kind === "specific_fy") return `FY ${p.fy}${result.period && result.period.isPartial ? " (to date)" : ""}`;
  if (p.kind === "all_time") return "All time";
  return (result.period && result.period.label) || p.kind.replace(/_/g, " ");
}
function currentRange(plan, result) {
  const p = plan.period;
  if (p.kind === "custom") return p.from === p.to ? p.from : `${p.from} → ${p.to}`;
  if (p.kind === "specific_fy") return `${p.fy.slice(0, 4)}-04-01 → ${Number(p.fy.slice(0, 4)) + 1}-03-31`;
  if (p.kind === "all_time") return null;
  return result.period && result.period.from && result.period.to ? rangeText(result.period) : null;
}
function compareLabel(plan, result) {
  const c = result.comparison;
  if (!c) return null;
  if (plan.compare && plan.compare.mode === "custom" && plan.compare.period) {
    const p = plan.compare.period;
    return customLabel(p) || (p.from === p.to ? p.from : `${p.from} → ${p.to}`);
  }
  return c.label || (plan.compare && plan.compare.mode.replace(/_/g, " ")) || "Comparison period";
}
function compareRange(plan, result) {
  const c = result.comparison;
  if (!c) return null;
  if (plan.compare && plan.compare.mode === "custom" && plan.compare.period) {
    const p = plan.compare.period;
    return p.from === p.to ? p.from : `${p.from} → ${p.to}`;
  }
  return c.from && c.to ? rangeText(c) : null;
}

function scopeOf(plan) {
  return (plan.filters || []).map((f) => ({ label: CATALOG.dimensions[f.dim].label, value: Array.isArray(f.value) ? f.value.join(", ") : String(f.value) }));
}

function keyName(key) {
  return Object.values(key)
    .map((v) => (v && typeof v === "object" && v.label ? v.label : String(v)))
    .join(" / ");
}

function bucketLabel(k) {
  const d = k && k.date;
  if (!d) return keyName(k);
  if (d.bucket === "month" && ymd.test(d.start)) {
    const [y, m] = d.start.split("-").map(Number);
    return `${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`;
  }
  if (d.bucket === "week" && ymd.test(d.start)) return `Week of ${d.start}`;
  return String(d.label || d.start);
}

const money = (id) => (isMoney(id) ? "money" : "number");
const col = (key, label, align = "right", extra = {}) => ({ key, label, align, ...extra });
const change = (id, c) => {
  const delta = c.delta;
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return {
    metric: id,
    label: shortLabel(id),
    display: direction === "flat" ? "No change" : `${fmtValue(id, Math.abs(delta))} ${direction === "up" ? "more" : "less"}`,
    signed: fmtSigned(id, delta),
    pct: pctOf(c),
    direction,
    previous: fmtValue(id, c.previous),
  };
};

function build({ plan, result, notes = [], zero = false }) {
  const entityLabel = CATALOG.entities[plan.entity].label;
  const base = {
    v: PRESENTATION_VERSION,
    title: entityLabel,
    period: { label: currentLabel(plan, result), range: currentRange(plan, result) },
    scope: scopeOf(plan),
  };
  const bases = [...new Set(Object.values(result.amountBasis || {}))].filter((b) => BASIS_TEXT[b]);
  const withCommon = (p) => ({ ...p, basis: bases.map((b) => BASIS_TEXT[b]), notes: notes.filter((n) => !BASIS_NOTES.has(n)) });

  if (zero) return withCommon({ ...base, kind: "empty" });

  if (plan.mode === "list") {
    const rows = (result.rows || []).slice(0, MAX_TABLE_ROWS).map((r) => ({
      cells: { voucher: r.voucherNo, date: r.date, party: r.customer || r.supplier || "", amount: fmtValue(r.invoiceAmount !== undefined ? "invoiceAmount" : "purchaseAmount", r.invoiceAmount !== undefined ? r.invoiceAmount : r.purchaseAmount) },
    }));
    return withCommon({
      ...base,
      kind: "table",
      columns: [col("voucher", "Voucher", "left"), col("date", "Date", "left"), col("party", entity(plan), "left"), col("amount", "Amount")],
      rows,
      moreRows: (result.rows || []).length > rows.length || result.truncated ? { shown: rows.length, total: (result.rows || []).length, truncated: !!result.truncated } : null,
    });
  }

  const metrics = result.metrics || [];
  const primary = primaryOf(metrics);
  const groupBy = plan.groupBy || [];

  // ---- no grouping: one KPI, or one comparison
  if (!groupBy.length) {
    const v = (result.totals && result.totals.values) || {};
    const cmp = result.totals && result.totals.comparison;
    if (!cmp) {
      return withCommon({
        ...base,
        kind: "kpi",
        headline: { id: primary, label: shortLabel(primary), display: fmtValue(primary, v[primary]) },
        secondary: metrics.filter((m) => m !== primary).map((m) => ({ id: m, label: shortLabel(m), display: fmtValue(m, v[m]), unit: COUNT_UNIT[m] || null })),
      });
    }
    const prevLabel = compareLabel(plan, result);
    const curLabel = base.period.label;
    const amountId = metrics.find((m) => /Amount$/.test(m));
    const countId = metrics.find((m) => /(InvoiceCount|Count)$/.test(m));
    const columns = [col("period", "Period", "left")].concat(metrics.map((m) => col(m, shortLabel(m))));
    const withAvg = !!(amountId && countId && cmp[amountId] && cmp[countId]);
    if (withAvg) columns.push(col("avg", "Avg order", "right", { derived: true, hint: "Amount ÷ orders, from the two figures in this row" }));
    const avg = (a, n) => (n > 0 ? fmtValue(amountId, a / n) : "—");
    const prevRow = { cells: { period: prevLabel }, range: compareRange(plan, result) };
    const curRow = { cells: { period: curLabel }, range: base.period.range, current: true };
    for (const m of metrics) {
      prevRow.cells[m] = cmp[m] ? fmtValue(m, cmp[m].previous) : "—";
      curRow.cells[m] = fmtValue(m, v[m]);
    }
    if (withAvg) {
      prevRow.cells.avg = avg(cmp[amountId].previous, cmp[countId].previous);
      curRow.cells.avg = avg(v[amountId], v[countId]);
    }
    const pc = cmp[primary];
    return withCommon({
      ...base,
      kind: "comparison",
      columns,
      rows: [prevRow, curRow],
      changes: metrics.filter((m) => cmp[m]).map((m) => change(m, cmp[m])),
      primary,
      chart: pc
        ? { type: "bar", metric: shortLabel(primary), money: money(primary) === "money", points: [{ label: prevLabel, value: pc.previous, display: fmtValue(primary, pc.previous) }, { label: curLabel, value: v[primary], display: fmtValue(primary, v[primary]) }] }
        : null,
    });
  }

  const rows = result.rows || [];
  const hasCompare = rows.some((r) => r.comparison && r.comparison[primary]);

  // ---- date grouping: a trend
  if (groupBy[0].dim === "date") {
    const tableRows = rows.map((r) => ({ cells: Object.assign({ label: bucketLabel(r.key) }, ...metrics.map((m) => ({ [m]: fmtValue(m, r.values[m]) }))) }));
    const totals = !result.truncated && result.totals && result.totals.values ? { cells: Object.assign({ label: "Total" }, ...metrics.map((m) => ({ [m]: fmtValue(m, result.totals.values[m]) }))) } : null;
    return withCommon({
      ...base,
      kind: "trend",
      bucket: groupBy[0].bucket,
      columns: [col("label", { month: "Month", day: "Day", week: "Week", quarter: "Quarter", fy: "Financial year" }[groupBy[0].bucket] || "Period", "left")].concat(metrics.map((m) => col(m, shortLabel(m)))),
      rows: tableRows,
      totals,
      chart: rows.length >= 2 ? { type: "line", metric: shortLabel(primary), money: money(primary) === "money", points: rows.map((r) => ({ label: bucketLabel(r.key), value: r.values[primary], display: fmtValue(primary, r.values[primary]) })) } : null,
      truncated: !!result.truncated,
    });
  }

  // ---- party / product / voucher-type grouping: a ranking
  const dimLabel = groupBy.map((g) => CATALOG.dimensions[g.dim].label).join(" / ");
  const shown = rows.slice(0, MAX_TABLE_ROWS);
  const columns = [col("rank", "#", "right", { narrow: true }), col("name", dimLabel, "left")].concat(metrics.map((m) => col(m, shortLabel(m))));
  if (hasCompare) columns.push(col("previous", `Previous ${shortLabel(primary)}`), col("change", "Change"), col("pct", "%"));
  const tableRows = shown.map((r, i) => {
    const cells = { rank: String(i + 1), name: keyName(r.key) };
    for (const m of metrics) cells[m] = fmtValue(m, r.values[m]);
    const c = r.comparison && r.comparison[primary];
    if (hasCompare) {
      cells.previous = c ? fmtValue(primary, c.previous) : "—";
      cells.change = c ? fmtSigned(primary, c.delta) : "—";
      cells.pct = c ? pctOf(c) : "—";
    }
    const row = { cells };
    if (r.presence === "previous_only") row.flag = "No activity in the current period";
    if (r.presence === "current_only") row.flag = "No activity in the comparison period";
    return row;
  });
  const totals = !result.truncated && result.totals && result.totals.values ? { cells: Object.assign({ rank: "", name: "Total" }, ...metrics.map((m) => ({ [m]: fmtValue(m, result.totals.values[m]) }))) } : null;
  const chartRows = shown.slice(0, MAX_CHART_POINTS);
  return withCommon({
    ...base,
    kind: "ranking",
    dimension: dimLabel,
    columns,
    rows: tableRows,
    totals,
    chart: chartRows.length >= 2
      ? {
          type: "bar-h",
          metric: shortLabel(primary),
          money: money(primary) === "money",
          points: chartRows.map((r) => {
            const c = r.comparison && r.comparison[primary];
            return { label: keyName(r.key), value: r.values[primary], display: fmtValue(primary, r.values[primary]), ...(c ? { previous: c.previous, previousDisplay: fmtValue(primary, c.previous) } : {}) };
          }),
          shownOf: rows.length > chartRows.length ? { shown: chartRows.length, total: rows.length } : null,
        }
      : null,
    moreRows: rows.length > shown.length || result.truncated ? { shown: shown.length, total: rows.length, truncated: !!result.truncated } : null,
  });
}

function entity(plan) {
  return plan.entity === "purchase" || plan.entity === "purchase_return" ? "Supplier" : "Customer";
}

/** @returns {object|null} never throws */
function buildPresentation(input) {
  try {
    return build(input);
  } catch (error) {
    return null;
  }
}

module.exports = { buildPresentation, PRESENTATION_VERSION };
