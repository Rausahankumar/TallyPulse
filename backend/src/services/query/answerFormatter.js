"use strict";

// --------------------------------------------------
// Deterministic answer text for Query Engine results (Phase 1G wiring).
//
// No Claude, no invented numbers: every figure printed here is a value the
// engine returned, formatted (Indian digit grouping, currency symbol) and
// labelled from the semantic catalog. The header states how the question was
// interpreted, so a plan that came from the planner is always visible to the
// user, and assumptions/caveats are listed rather than hidden.
// --------------------------------------------------

const { CATALOG } = require("./semanticCatalog");

const MAX_DISPLAY_ROWS = 25;
const MAX_NOTES = 6;

const isMoney = (metricId) => {
  const m = CATALOG.metrics[metricId];
  return !!(m && m.amountBasis);
};

function fmtMoney(n) {
  return `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtNumber(n) {
  return Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
function fmtValue(metricId, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  return isMoney(metricId) ? fmtMoney(v) : fmtNumber(v);
}
function fmtSigned(metricId, v) {
  const s = fmtValue(metricId, Math.abs(v));
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : s;
}
function fmtPct(p) {
  return p === null || p === undefined ? "n/a" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;
}
const label = (id) => (CATALOG.metrics[id] ? CATALOG.metrics[id].label : id);

function periodText(plan, result) {
  const p = plan.period;
  if (p.kind === "custom") return p.from === p.to ? p.from : `${p.from} to ${p.to}`;
  if (p.kind === "specific_fy") return `FY ${p.fy}${result.period && result.period.isPartial ? " (to date)" : ""}`;
  return (result.period && result.period.label) || p.kind.replace(/_/g, " ");
}

function keyText(key) {
  return Object.values(key)
    .map((v) => (v && typeof v === "object" && v.label ? v.label : String(v)))
    .join(" / ");
}

function compareText(plan, result) {
  const c = result.comparison;
  if (!c) return null;
  if (plan.compare && plan.compare.mode === "custom" && plan.compare.period) {
    const p = plan.compare.period;
    return p.from === p.to ? p.from : `${p.from} to ${p.to}`;
  }
  return c.label || (plan.compare && plan.compare.mode.replace(/_/g, " "));
}

function isZero(plan, result) {
  if (plan.mode === "list") return (result.rows || []).length === 0;
  if ((plan.groupBy || []).length) return (result.rows || []).length === 0;
  const v = result.totals && result.totals.values;
  if (!v) return true;
  const counts = Object.entries(v).filter(([id]) => /Count$/.test(id));
  if (counts.length) return counts.every(([, n]) => n === 0);
  return Object.values(v).every((n) => n === 0);
}

/**
 * @returns {{text:string, warnings:string[], zero:boolean}}
 */
function formatQueryAnswer({ plan, result, routerAssumptions = [], plannerAssumptions = [], source = "router" }) {
  const lines = [];
  const entity = CATALOG.entities[plan.entity].label;
  const parts = [entity, periodText(plan, result)];
  for (const f of plan.filters || []) parts.push(`${CATALOG.dimensions[f.dim].label.toLowerCase()}: ${Array.isArray(f.value) ? f.value.join(", ") : f.value}`);
  if ((plan.groupBy || []).length) parts.push(`by ${plan.groupBy.map((g) => (g.dim === "date" ? g.bucket : CATALOG.dimensions[g.dim].label.toLowerCase())).join(" and ")}`);
  lines.push(parts.join(" — "));

  const zero = isZero(plan, result);
  const cmpLabel = compareText(plan, result);

  if (zero) {
    lines.push("", "No matching records were found for this question.");
  } else if (plan.mode === "list") {
    lines.push("");
    (result.rows || []).slice(0, MAX_DISPLAY_ROWS).forEach((r, i) => {
      const money = r.invoiceAmount !== undefined ? fmtMoney(r.invoiceAmount) : fmtMoney(r.purchaseAmount);
      lines.push(`${i + 1}. ${r.voucherNo} · ${r.date} · ${r.customer || r.supplier} · ${money}`);
    });
  } else if ((plan.groupBy || []).length) {
    lines.push("");
    const metrics = result.metrics;
    const primary = metrics[0];
    (result.rows || []).slice(0, MAX_DISPLAY_ROWS).forEach((r, i) => {
      const vals = metrics.map((m) => (metrics.length > 1 ? `${label(m)} ${fmtValue(m, r.values[m])}` : fmtValue(m, r.values[m]))).join(" · ");
      let extra = "";
      const c = r.comparison && r.comparison[primary];
      if (c) extra = ` (previous ${fmtValue(primary, c.previous)}, change ${fmtSigned(primary, c.delta)}, ${fmtPct(c.deltaPct)})`;
      if (r.presence === "previous_only") extra += " [no activity in the current period]";
      if (r.presence === "current_only") extra += " [no activity in the comparison period]";
      lines.push(`${i + 1}. ${keyText(r.key)} — ${vals}${extra}`);
    });
    if ((result.rows || []).length > MAX_DISPLAY_ROWS) lines.push(`… and ${(result.rows || []).length - MAX_DISPLAY_ROWS} more rows not shown.`);
    if (result.truncated) lines.push(`Showing the first ${result.rows.length} results; more exist (limit ${result.rowLimit}).`);
    if (result.totals && result.totals.values && !result.truncated) {
      lines.push(`Total: ${metrics.map((m) => `${label(m)} ${fmtValue(m, result.totals.values[m])}`).join(" · ")}`);
    }
  } else {
    lines.push("");
    const v = result.totals.values;
    for (const m of result.metrics) lines.push(`${label(m)}: ${fmtValue(m, v[m])}`);
    const c = result.totals.comparison;
    if (c) {
      for (const m of result.metrics) {
        if (!c[m]) continue;
        lines.push(`Compared with ${cmpLabel || "the comparison period"}: previous ${fmtValue(m, c[m].previous)}, change ${fmtSigned(m, c[m].delta)} (${fmtPct(c[m].deltaPct)}) — ${label(m)}`);
      }
    }
  }

  // ---- notes: how it was interpreted + engine assumptions + basis
  const notes = [];
  if (source === "planner") for (const a of plannerAssumptions) notes.push(`Interpretation (AI-assisted): ${a}`);
  for (const a of routerAssumptions) notes.push(a.message);
  for (const a of result.assumptions || []) notes.push(a.message);
  const bases = new Set(Object.values(result.amountBasis || {}));
  if (bases.has("voucher_total_incl_tax")) notes.push("Invoice amounts are invoice totals including tax.");
  if (bases.has("line_item_pre_tax")) notes.push("Line amounts are item values before tax.");
  const uniq = [...new Set(notes)].slice(0, MAX_NOTES);
  if (uniq.length) lines.push("", ...uniq.map((n) => `• ${n}`));

  const warnings = [...new Set((result.warnings || []).map((w) => w.message))];
  return { text: lines.join("\n"), warnings, zero };
}

// ---- honest, Claude-free messages for non-answers --------------------------------------

const CLARIFY = {
  ambiguous_period: 'Which period do you mean? "This year" could be the financial year (April–March) or the calendar year. Try "this financial year" or "FY 2025-26".',
  year_missing: "Which year do you mean? For example: \"April 2025\".",
  period_missing: 'Which period should I use? For example: "last month", "this financial year" or "FY 2025-26".',
  invalid_fy: 'That financial year isn’t valid. Write it like "FY 2025-26" (consecutive years).',
  unsupported_window: "Only the last 7, 30 or 90 days are available as rolling windows. Or give explicit dates.",
  question_too_long: "Please shorten the question.",
  entity_not_resolved: "I couldn’t find that customer, supplier, product or group in your data. Please check the spelling.",
  planner_needs_clarification: null, // uses the planner's own message
};
const SCOPE_HINT = "I can answer questions about Sales and Purchase amounts, invoice counts, quantities, and breakdowns by customer, supplier, product, product group, voucher type or time.";

function formatNonAnswer(result) {
  if (result.status === "unsupported") {
    if (result.code === "unsafe_input" || result.code === "invalid_input" || result.code === "empty_question") return "I couldn’t process that question. Please rephrase it in plain words.";
    if (result.code === "limit_too_large" || result.code === "unsupported_combination" || result.code === "reasoning_not_supported") return `${result.reason}`;
    return `${result.reason} ${SCOPE_HINT}`;
  }
  const canned = CLARIFY[result.code];
  return canned || result.reason || "Could you clarify the question?";
}

module.exports = { formatQueryAnswer, formatNonAnswer, fmtMoney, fmtNumber, SCOPE_HINT, MAX_DISPLAY_ROWS };
