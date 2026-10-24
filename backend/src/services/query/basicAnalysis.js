"use strict";

// --------------------------------------------------
// ASK_AI_ANALYSIS modes: "on" (the default when unset) runs every analysis plan; "basic" runs only the bounded part of analysis
// plans that basic business questions need; "off" runs none (the fixed "several separate analyses" answer). An unrecognised
// value fails closed to "off". In basic mode an analysis plan is run only when it has one of these shapes:
//   - ONE insight step: discount_summary (discount %) or product_margin (indicative margin, never accounting profit);
//   - TWO plain query steps: one sales total and one purchase total, same period, same amount basis (tax-inclusive invoice
//     totals, or pre-tax item values on both sides), no grouping, filters, comparison or bindings.
// Anything else keeps the fixed "several separate analyses" answer. The numbers are the engine's and the insight tools' own;
// this module only adds, in every mode, the difference of a comparable sales/purchase pair (labelled as such, never as
// profit), or, for a pair that is not comparable (different periods or amount bases), why no difference is shown.
// --------------------------------------------------

const { CATALOG } = require("./semanticCatalog");
const { fmtMoney } = require("./answerFormatter");

const MODES = new Set(["on", "basic", "off"]);
const BASIC_INSIGHT_TOOLS = new Set(["discount_summary", "product_margin"]);
// the amount bases that can be put side by side: [sales metric, purchase metric, label]
const PAIRS = [
  ["invoiceAmount", "purchaseAmount", "invoice totals including tax"],
  ["lineAmount", "lineAmount", "item values before tax"],
];

const DEFAULT_MODE = "on";
const FAIL_CLOSED_MODE = "off";

/** The analysis mode of this turn: a test's deps.analysisMode / deps.analysisEnabled, else ASK_AI_ANALYSIS (unset: on). */
function analysisMode(deps, env = process.env) {
  if (deps && typeof deps.analysisMode === "string" && MODES.has(deps.analysisMode)) return deps.analysisMode;
  if (deps && typeof deps.analysisEnabled === "boolean") return deps.analysisEnabled ? "on" : "off";
  const raw = env.ASK_AI_ANALYSIS;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_MODE;
  const v = String(raw).trim().toLowerCase();
  return MODES.has(v) ? v : FAIL_CLOSED_MODE; // a typo never switches analysis on
}

/** True when ASK_AI_ANALYSIS holds a value that is not on/basic/off (the server warns at start). */
function analysisModeUnrecognised(env = process.env) {
  const raw = env.ASK_AI_ANALYSIS;
  return raw !== undefined && String(raw).trim() !== "" && !MODES.has(String(raw).trim().toLowerCase());
}

const empty = (v) => v === undefined || v === null || (Array.isArray(v) && v.length === 0);
const plainTotal = (plan) =>
  plan && (plan.mode === undefined || plan.mode === "aggregate") && empty(plan.groupBy) && empty(plan.filters) && empty(plan.having) && empty(plan.compare) && Array.isArray(plan.metrics) && plan.metrics.length === 1;

/**
 * Which basic shape an analysis plan has, or null when it is outside basic analysis.
 * @returns {null | {kind: "insight", tool: string} | {kind: "sales_vs_purchase", salesStep: string, purchaseStep: string, salesMetric: string, purchaseMetric: string, basis: string}}
 */
function basicShape(analysis) {
  const steps = (analysis && analysis.steps) || [];
  if (steps.length === 1 && steps[0].kind === "insight" && BASIC_INSIGHT_TOOLS.has(steps[0].tool)) return { kind: "insight", tool: steps[0].tool };
  if (steps.length !== 2 || steps.some((s) => s.kind !== "query" || !empty(s.inputs) || !plainTotal(s.plan))) return null;
  const sales = steps.find((s) => s.plan.entity === "sales");
  const purchase = steps.find((s) => s.plan.entity === "purchase");
  if (!sales || !purchase || JSON.stringify(sales.plan.period) !== JSON.stringify(purchase.plan.period)) return null;
  const pair = PAIRS.find(([s, p]) => sales.plan.metrics[0] === s && purchase.plan.metrics[0] === p);
  if (!pair) return null;
  return { kind: "sales_vs_purchase", salesStep: sales.id, purchaseStep: purchase.id, salesMetric: pair[0], purchaseMetric: pair[1], basis: pair[2] };
}

const AMOUNT_BASIS_LABEL = (metric) => {
  const m = CATALOG.metrics[metric];
  return m && m.amountBasis === "voucher_total_incl_tax" ? "invoice totals including tax" : m && m.amountBasis === "line_item_pre_tax" ? "item values before tax" : "not an amount";
};

/**
 * A plan of exactly one plain sales total and one plain purchase total that is NOT a comparable pair: why (different
 * periods, different amount bases). Null for a comparable pair and for any other plan.
 */
function salesVsPurchaseMismatch(analysis) {
  const steps = (analysis && analysis.steps) || [];
  if (steps.length !== 2 || steps.some((s) => s.kind !== "query" || !empty(s.inputs) || !plainTotal(s.plan))) return null;
  const sales = steps.find((s) => s.plan.entity === "sales");
  const purchase = steps.find((s) => s.plan.entity === "purchase");
  if (!sales || !purchase || basicShape(analysis)) return null;
  const reasons = [];
  if (JSON.stringify(sales.plan.period) !== JSON.stringify(purchase.plan.period)) reasons.push("the two totals cover different periods");
  if (!PAIRS.some(([s, p]) => sales.plan.metrics[0] === s && purchase.plan.metrics[0] === p)) {
    reasons.push(`they use different amount bases (sales: ${AMOUNT_BASIS_LABEL(sales.plan.metrics[0])}; purchases: ${AMOUNT_BASIS_LABEL(purchase.plan.metrics[0])})`);
  }
  return reasons.length ? { reasons } : null;
}

/** The note for a non-comparable sales/purchase pair: no difference, and never profit. */
function salesVsPurchaseMismatchText(mismatch, { asksProfit = false } = {}) {
  const lines = [`**Sales vs purchases: not compared** - ${mismatch.reasons.join(", and ")}, so no difference is shown. Ask for both over the same period on the same basis to compare them.`];
  lines.push("Neither total, nor any difference between them, is profit.");
  if (asksProfit) lines.push(`Profit is not calculated. ${profitReason()}`);
  return lines.join("\n");
}

const totalOf = (step, metric) => {
  const v = step && step.status === "ok" && step.result && step.result.totals && step.result.totals.values ? step.result.totals.values[metric] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const profitReason = () => ((CATALOG.unsupported || []).find((u) => u.id === "profit_margin") || {}).reason;

/**
 * The side-by-side block for a sales_vs_purchase shape: both totals, their difference, and why the difference is not profit.
 * Null when either step did not produce a total (each step already says why).
 */
function salesVsPurchaseText(execution, shape, { asksProfit = false } = {}) {
  const steps = (execution && execution.steps) || [];
  const sales = totalOf(steps.find((s) => s.id === shape.salesStep), shape.salesMetric);
  const purchases = totalOf(steps.find((s) => s.id === shape.purchaseStep), shape.purchaseMetric);
  if (sales === null || purchases === null) return null;
  const diff = Math.round((sales - purchases) * 100) / 100;
  const lines = [
    `**Sales vs purchases** (same period, ${shape.basis}):`,
    `- Sales: ${fmtMoney(sales)}`,
    `- Purchases: ${fmtMoney(purchases)}`,
    `- Difference (sales − purchases): ${diff < 0 ? "−" : ""}${fmtMoney(Math.abs(diff))}${diff > 0 ? " (sales higher)" : diff < 0 ? " (purchases higher)" : ""}`,
    "This difference is not profit: purchases in a period are not the cost of the goods sold in it (stock bought earlier or still unsold), and returns are not deducted.",
  ];
  if (asksProfit) lines.push(`Profit is not calculated. ${profitReason()}`);
  return lines.join("\n");
}

module.exports = { analysisMode, analysisModeUnrecognised, basicShape, salesVsPurchaseText, salesVsPurchaseMismatch, salesVsPurchaseMismatchText, BASIC_INSIGHT_TOOLS, DEFAULT_MODE };
