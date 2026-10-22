"use strict";

// --------------------------------------------------
// The answer text of an analysis plan (Milestone 2): the MEASURED results of each step, in order, and nothing else. No
// interpretation, cause or recommendation is written here (synthesis is a later milestone). Query steps reuse the query
// engine's own formatted text (answerFormatter); insight steps show the tool's own rows with a fixed field list per TOOL
// (never per question), its disclosures and its coverage notes. A step that did not run says why.
// --------------------------------------------------

const { plainMetricNames } = require("./answerFormatter");

const MAX_INSIGHT_ROWS = 10;
const fmt = (v) => (typeof v === "number" ? v.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : v === null || v === undefined ? "n/a" : String(v));
// Which fields of each tool's rows are shown (presentation per tool; the numbers are the tool's own).
const INSIGHT_FIELDS = {
  product_rates: [["product", "Product"], ["saleRate", "Sale rate"], ["purchaseRate", "Purchase rate"], ["rateGap", "Rate gap"], ["saleQty", "Sold qty"]],
  product_trend: [["month", "Month"], ["saleQty", "Sold qty"], ["purchaseQty", "Bought qty"], ["netQty", "Net qty"], ["cumulativeNetQty", "Running net"]],
  supplier_rates: [["product", "Product"], ["bestSupplier", "Best supplier"], ["bestRate", "Best rate"], ["avgRate", "Average rate"], ["supplierCount", "Suppliers"], ["savingIfAllAtBest", "Indicative saving"]],
  discount_summary: [["key", "Group"], ["discountAmount", "Discount"], ["discountPct", "Discount %"], ["grossAmount", "List value"], ["billedAmount", "Billed"]],
  product_margin: [["product", "Product"], ["saleAmount", "Sale value"], ["unitMargin", "Indicative unit margin"], ["marginPct", "Indicative margin %"], ["costSource", "Cost from"]],
};
// Fixed headings: the discount basis and the indicative nature of the margin are stated in the heading itself.
const TOOL_TITLES = {
  product_rates: "Sale and purchase rates per product",
  product_trend: "Quantity bought and sold per month",
  supplier_rates: "Supplier rates for the product",
  discount_summary: "Discount = list value − billed amount (before tax)",
  product_margin: "Indicative margin per product (not accounting profit)",
};
// One summary line from the tool's own totals (the rows are only the top ones).
const SUMMARIES = {
  discount_summary: (d) => (d.totals ? `Total: discount ${fmt(d.totals.discountAmount)} on a list value of ${fmt(d.totals.grossAmount)} (${fmt(d.totals.discountPct)}%), billed ${fmt(d.totals.billedAmount)}.` : null),
  product_margin: (d) => (d.summary ? `All ${d.summary.products} products sold: indicative profit ${fmt(d.summary.indicativeProfit)} at an indicative margin of ${fmt(d.summary.marginPct)}% on the ${d.summary.costedProducts} products with a cost.` : null),
};

function insightText(step) {
  const ev = step.result;
  const fields = INSIGHT_FIELDS[step.tool] || [];
  const rows = (ev.data && ev.data.rows) || [];
  const lines = [`${TOOL_TITLES[step.tool] || step.tool}, ${ev.period.from} to ${ev.period.to}${ev.productMatch ? ` (${ev.productMatch.resolved})` : ""}:`];
  const summary = SUMMARIES[step.tool] && ev.data && ev.data.hasData ? SUMMARIES[step.tool](ev.data) : null;
  if (summary) lines.push(summary);
  if (!rows.length && !summary) lines.push("No matching records in this period.");
  for (const r of rows.slice(0, MAX_INSIGHT_ROWS)) lines.push(`- ${fields.map(([k, label]) => `${label}: ${fmt(r[k])}`).join(" · ")}`);
  if (rows.length > MAX_INSIGHT_ROWS) lines.push(`(${rows.length - MAX_INSIGHT_ROWS} more rows not shown)`);
  if (ev.coverage && ev.coverage.mayHaveMore) lines.push("Only the top rows were requested; more may exist.");
  for (const n of (ev.coverage && ev.coverage.notes) || []) lines.push(`• ${n}`);
  for (const d of ev.disclosures || []) lines.push(`• ${d}`);
  for (const l of ev.limitations || []) lines.push(`• ${l}`);
  return lines.join("\n");
}

/**
 * @param {{steps: object[]}} execution the result of executeAnalysisPlan
 * @param {{assumptions?: string[]}} [options] the analysis planner's stated assumptions (already cleaned and capped)
 * @returns {{text: string, warnings: string[], answered: number}}
 */
function formatAnalysisAnswer(execution, { assumptions = [] } = {}) {
  const steps = (execution && execution.steps) || [];
  const parts = ["Analysis: measured results only (no interpretation)."];
  // the planner's own reading of the question, labelled exactly as the single-query answer labels its planner's
  if (assumptions.length) parts.push(assumptions.map((a) => `Interpretation (AI-assisted): ${plainMetricNames(a)}`).join("\n"));
  const warnings = [];
  let answered = 0;
  steps.forEach((s, i) => {
    const head = `**Step ${i + 1}**`;
    if (s.status === "ok") {
      answered += 1;
      parts.push(`${head}\n${s.kind === "query" ? s.facts : insightText(s)}`);
      for (const n of s.notes || []) warnings.push(n);
    } else {
      const why = s.error ? s.error.message : s.message || "It could not run.";
      parts.push(`${head}\nNot run: ${why}`); // stated in the text: not repeated as a warning
    }
  });
  return { text: parts.join("\n\n"), warnings: [...new Set(warnings)], answered };
}

module.exports = { formatAnalysisAnswer, MAX_INSIGHT_ROWS };
