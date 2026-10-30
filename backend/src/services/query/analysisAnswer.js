"use strict";

// --------------------------------------------------
// The answer text of an analysis plan (Milestone 2): the MEASURED results of each step, in order. Query steps reuse the query
// engine's own formatted text (answerFormatter); insight steps show the tool's own rows with a fixed field list per TOOL
// (never per question), its disclosures and its coverage notes. A step that did not run says why.
// Above the steps (Milestone 3): the evidence record's labelled findings (evidence.js) - deterministic arithmetic on those
// same results, each pointing at its steps - and what the data cannot establish. Without findings the text is as before.
// --------------------------------------------------

const { plainMetricNames } = require("./answerFormatter");
const { CATALOG } = require("./semanticCatalog");

/**
 * The parts of the question the data cannot answer (the analysis planner's validated `unavailable` catalog ids), stated
 * first with the catalog's own reasons, and the scope of everything below: the whole company, not that breakdown. Ids the
 * catalog does not list as `partial` are dropped (never rendered).
 */
function unavailableText(ids) {
  const entries = [...new Set(ids || [])].map((id) => CATALOG.unsupported.find((u) => u.id === id && u.partial)).filter(Boolean);
  if (!entries.length) return null;
  const labels = entries.map((u) => u.label).join(", or by ");
  return ["**Not available in the data**", ...entries.map((u) => `- ${u.reason}`), `The results below are for the whole company: they are not broken down by ${labels} and say nothing about any single one.`].join("\n");
}
const { buildEvidence } = require("./evidence");
const { plainSummary } = require("./plainAnswer");

const FINDING_LABELS = { measured: "Measured", contributor: "Contributor", possible_cause: "Possible cause (not proven)" };
const LABEL_NOTE = "Measured = returned or calculated directly from the steps below; Contributor = a measured part of the change; Possible cause = consistent with the data, not proven.";
const stepRef = (steps) => `(${steps.length > 1 ? "steps" : "step"} ${steps.join(", ")})`;

// Asked what to do, but no action follows from these results: the evidence record's specific reason, never an invented action.
const noActionText = (evidence) => `No action follows from these results yet: ${(evidence && evidence.noAction) || "nothing in them points to a step to take"}.`;
// How far each next step goes (evidence.js `kind`): the label is shown with it, so a check is never read as a decision.
const ACTION_KIND_LABELS = { action: "Action", verify: "Check", option: "Possible option (after the check)" };

/** The next steps as a prioritized list: kind, step, and the finding (figures) it follows from. */
function actionsText(evidence) {
  const recs = evidence.recommendations || [];
  if (!recs.length) return ["**Suggested next actions**", `- ${noActionText(evidence)}`];
  return [
    "**Suggested next actions** (largest amount first; each follows from the finding named, none from a confirmed cause):",
    ...recs.map((r, i) => `${i + 1}. ${ACTION_KIND_LABELS[r.kind] || "Check"}: ${r.text}${r.because ? ` Because: ${r.because}.` : ""} ${stepRef(r.steps)}`),
  ];
}

function findingsText(evidence, actions) {
  const lines = ["**Findings**"];
  // the overall change is stated once, above (overallLines), not repeated here
  const lead = evidence.overall && evidence.overall.sourceText;
  for (const f of evidence.findings) if (f.text !== lead) lines.push(`- ${FINDING_LABELS[f.label]}: ${f.text} ${stepRef(f.steps)}`);
  if (evidence.gaps.length) {
    lines.push("Not established by this data:");
    for (const g of evidence.gaps) lines.push(`- ${g.text}${g.steps && g.steps.length ? ` ${stepRef(g.steps)}` : ""}`);
  }
  // next actions only when the question asked what to do (the planner's `actions`). The evidence record derives them either
  // way; only their display depends on the ask.
  if (actions) lines.push(...actionsText(evidence));
  lines.push(LABEL_NOTE);
  return lines.join("\n");
}

const MAX_INSIGHT_ROWS = 10;
const fmt = (v) => (typeof v === "number" ? v.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : v === null || v === undefined ? "n/a" : String(v));
// Which fields of each tool's rows are shown (presentation per tool; the numbers are the tool's own).
const INSIGHT_FIELDS = {
  product_rates: [["product", "Product"], ["saleRate", "Sale rate"], ["purchaseRate", "Purchase rate"], ["rateGap", "Rate gap"], ["saleQty", "Sold qty"]],
  product_trend: [["month", "Month"], ["saleQty", "Sold qty"], ["purchaseQty", "Bought qty"], ["netQty", "Net qty"], ["cumulativeNetQty", "Running net"]],
  supplier_rates: [["product", "Product"], ["bestSupplier", "Best supplier"], ["bestRate", "Best rate"], ["avgRate", "Average rate"], ["supplierCount", "Suppliers"], ["savingIfAllAtBest", "Indicative saving"]],
  discount_summary: [["key", "Group"], ["discountAmount", "Discount"], ["discountPct", "Discount %"], ["grossAmount", "List value"], ["billedAmount", "Billed"]],
  product_margin: [["product", "Product"], ["saleAmount", "Sale value"], ["unitMargin", "Indicative unit margin"], ["marginPct", "Indicative margin %"], ["indicativeProfit", "Indicative profit"], ["costSource", "Cost from"], ["costLastBought", "Cost last bought"]],
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
  if (rows.length && ev.coverage && ev.coverage.ordering) lines.push(`Ordered by ${ev.coverage.ordering}.`);
  if (ev.coverage && ev.coverage.mayHaveMore) lines.push("Only the top rows were requested; more may exist.");
  for (const n of (ev.coverage && ev.coverage.notes) || []) lines.push(`• ${n}`);
  for (const d of ev.disclosures || []) lines.push(`• ${d}`);
  for (const l of ev.limitations || []) lines.push(`• ${l}`);
  return lines.join("\n");
}

/**
 * @param {{steps: object[]}} execution the result of executeAnalysisPlan
 * @param {{assumptions?: string[], referenceDate?: Date, dataThrough?: Date|null, limitations?: string[], unavailable?: string[], actions?: boolean}} [options] the
 *        analysis planner's stated assumptions (already cleaned and capped), the turn's reporting reference date and the latest
 *        voucher's day (a date bucket or period ending after either is incomplete), the investigation's own limitations
 *        (what its budget or remedies could not settle), listed with the findings' gaps, and whether the question asked what to
 *        do (the planner's `actions`): only then are suggested next actions shown
 * @returns {{text: string, warnings: string[], answered: number, evidence: object}}
 */
function formatAnalysisAnswer(execution, { assumptions = [], referenceDate = null, dataThrough = null, limitations = [], unavailable = [], actions = false, language = "en" } = {}) {
  const steps = (execution && execution.steps) || [];
  const evidence = buildEvidence(execution, { referenceDate, dataThrough });
  for (const text of limitations) evidence.gaps.push({ text, steps: [] });
  const hasEvidence = evidence.findings.length > 0;
  const parts = [hasEvidence ? "Analysis: findings calculated from the measured results, then each step's results." : "Analysis: measured results only (no interpretation)."];
  // the planner's own reading of the question, labelled exactly as the single-query answer labels its planner's
  if (assumptions.length) parts.push(assumptions.map((a) => `Interpretation (AI-assisted): ${plainMetricNames(a)}`).join("\n"));
  const notAvailable = unavailableText(unavailable);
  if (notAvailable) parts.push(notAvailable);
  // the overall result first: it governs how every customer/product finding below is read
  const overall = evidence.overall;
  if (overall) parts.push(`**Overall:** ${overall.text}${overall.steps.length && !overall.unavailable ? ` ${stepRef(overall.steps)}` : ""}${overall.note ? `\n${overall.note}` : ""}`);
  if (hasEvidence) parts.push(findingsText(evidence, actions));
  else if (actions) parts.push(actionsText(evidence).join("\n"));
  const warnings = [];
  let answered = 0;
  steps.forEach((s, i) => {
    // a step the investigation added says where it came from
    const head = `**Step ${i + 1}**${s.origin ? ` (follow-up: ${s.origin.reason})` : ""}`;
    if (s.status === "ok") {
      answered += 1;
      parts.push(`${head}\n${s.kind === "query" ? s.facts : insightText(s)}`);
      for (const n of s.notes || []) warnings.push(n);
    } else {
      const why = s.error ? s.error.message : s.message || "It could not run.";
      parts.push(`${head}\nNot run: ${why}`); // stated in the text: not repeated as a warning
    }
  });
  // the plain-language opening (the question's language) comes first; the detailed findings above stay as they are, below it
  const plain = plainSummary(evidence, { language, actions });
  if (plain.lines.length) parts.unshift(plain.lines.join("\n"));
  return { text: parts.join("\n\n"), warnings: [...new Set(warnings)], answered, evidence, plain };
}

// the labels, tool fields and headings are shared with the structured view (analysisPresentation.js), so both say the same
module.exports = { formatAnalysisAnswer, noActionText, ACTION_KIND_LABELS, MAX_INSIGHT_ROWS, unavailableText, FINDING_LABELS, LABEL_NOTE, INSIGHT_FIELDS, TOOL_TITLES, SUMMARIES, fmt };
