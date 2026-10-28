/**
 * The calculation record of a single-query answer (calculation.buildCalculation, attached to visualization.calculation by
 * queryChat): what executed, with the engine's own values only. Checks the reported July/August example, both accounting
 * bases, the % change rule of computeGrowth (zero previous), filters proven by the previous turn's scope, zero / missing
 * totals, cut lists, incomplete periods, and that no number appears that the engine did not return.
 *
 * Every name is SYNTHETIC; the July/August totals are the example figures from the review brief, used as plain numbers.
 * Run: node verify-calculation.js   (no database, no network, no model; chat turns with a scripted planner)
 */

process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const { buildCalculation } = require("./src/services/query/calculation");
const { computeGrowth } = require("./src/services/analytics/salesAnalytics");
const { formatQueryAnswer } = require("./src/services/query/answerFormatter");
const { PLANNER_TOOL_NAME } = require("./src/services/query/planner");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 1200)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const iso = (y, m, d, e) => (e ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
// exactly what execute.growthFor stores: computeGrowth's amount and percentage
const growth = (current, previous) => { const g = computeGrowth(current, previous); return { previous, delta: g.growthAmount, deltaPct: g.growthPercentage }; };
const AUG = { from: iso(2025, 8, 1), to: iso(2025, 8, 31, true), label: "August 2025" }, JUL = { from: iso(2025, 7, 1), to: iso(2025, 7, 31, true), label: "July 2025" };
const augVsJul = { period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-07-01", to: "2025-07-31" } } };
const CUST = { dim: "customer", op: "eq_ci", value: "Synthetic Traders" };
const plan = (p) => ({ v: 1, entity: "sales", mode: "aggregate", groupBy: [], filters: [], ...p });
const res = (r) => ({ ok: true, groupBy: [], rows: [], truncated: false, warnings: [], assumptions: [], ...r });
const build = (p, r, extra = {}) => buildCalculation({ plan: p, result: r, zero: formatQueryAnswer({ plan: p, result: r }).zero, ...extra });

/** Every number anywhere in the record (keys excluded). */
function numbersIn(x, out = []) {
  if (typeof x === "number") out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => numbersIn(v, out));
  else if (x && typeof x === "object") Object.values(x).forEach((v) => numbersIn(v, out));
  return out;
}
/** Every number the engine returned (totals, comparisons, rows, list amounts, the row limit). */
function engineNumbers(r) {
  return [r.rowLimit, ...numbersIn(r.totals), ...numbersIn((r.rows || []).map((row) => ({ values: row.values, comparison: row.comparison, invoiceAmount: row.invoiceAmount, purchaseAmount: row.purchaseAmount })))].filter((n) => typeof n === "number");
}
function noNewNumbers(id, rec, r) {
  // allowed beside the engine's numbers: the record version, the rows-shown count, and the catalog's zero-denominator rule
  const allowed = new Set([...engineNumbers(r), 1, (r.rows || []).length, 0]);
  const extra = numbersIn(rec).filter((n) => !allowed.has(n));
  check(id, "no number appears that the engine did not return", extra.length === 0, extra.join(", "));
}

// ---- the example: July ₹57,16,599.12 -> August ₹43,44,775.50
const exPlan = plan({ ...augVsJul, metrics: ["invoiceAmount"] });
const exRes = res({ period: AUG, comparison: JUL, metrics: ["invoiceAmount"], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, totals: { values: { invoiceAmount: 4344775.5 }, comparison: { invoiceAmount: growth(4344775.5, 5716599.12) } } });
{
  const c = build(exPlan, exRes);
  const v = c.values[0];
  check("example-values", "current, previous and change are the engine's own values", v.metric === "invoiceAmount" && v.current === 4344775.5 && v.previous === 5716599.12 && v.change.value === exRes.totals.comparison.invoiceAmount.delta && v.change.formula === "current − previous" && v.change.inputs.current === 4344775.5 && v.change.inputs.previous === 5716599.12, JSON.stringify(v));
  check("example-change", "the change is −13,71,823.62 (to the paisa) and the % about −24.0", Math.abs(v.change.value - -1371823.62) < 0.005 && v.changePct.value.toFixed(1) === "-24.0", `${v.change.value} ${v.changePct.value}`);
  check("example-pct-rule", "the % is computeGrowth's (change ÷ |previous| × 100), passed through, not recomputed", v.changePct.value === computeGrowth(4344775.5, 5716599.12).growthPercentage && v.changePct.formula === "change ÷ |previous| × 100" && v.changePct.inputs.change === v.change.value);
  check("example-periods", "both periods by their calendar days and labels", c.period.from === "2025-08-01" && c.period.to === "2025-08-31" && c.compare.from === "2025-07-01" && c.compare.to === "2025-07-31" && c.compare.label === "July 2025");
  check("tax-inclusive", "invoice amount: invoice totals including tax, summed per invoice, with the catalog's disclosures", c.metrics[0].basis.id === "voucher_total_incl_tax" && /including tax/.test(c.metrics[0].basis.text) && c.metrics[0].rule.op === "sum" && c.metrics[0].rule.per === "invoice" && c.metrics[0].disclosures.some((d) => /Gross of returns/.test(d)));
  check("records", "what was counted: active Sales vouchers only", /^Active Sales vouchers/.test(c.records) && c.kind === "total");
  noNewNumbers("example-no-new-number", c, exRes);
}

// ---- % change against a zero (and a negative) previous value: computeGrowth's rule
{
  const r = res({ period: AUG, comparison: JUL, metrics: ["invoiceAmount"], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, totals: { values: { invoiceAmount: 50000 }, comparison: { invoiceAmount: growth(50000, 0) } } });
  const v = build(exPlan, r).values[0];
  check("pct-zero-previous", "previous 0: no %, marked unavailable (previous_is_zero), never 0% or infinite", v.changePct.available === false && v.changePct.reason === "previous_is_zero" && !("value" in v.changePct) && computeGrowth(50000, 0).growthPercentage === null && v.change.value === 50000, JSON.stringify(v));
  const neg = res({ period: AUG, comparison: JUL, metrics: ["lineAmount"], amountBasis: { lineAmount: "line_item_pre_tax" }, totals: { values: { lineAmount: 100 }, comparison: { lineAmount: growth(100, -200) } } });
  const nv = build(plan({ ...augVsJul, metrics: ["lineAmount"] }), neg).values[0];
  check("pct-negative-previous", "a negative previous value: the engine's % (divided by |previous|) is kept as returned", nv.changePct.value === 150 && nv.changePct.value === computeGrowth(100, -200).growthPercentage, nv.changePct.value);
}

// ---- pre-tax product breakdown, cut at its limit
const rows = [["Synthetic Tint 36ML", 145463.04, 0], ["Synthetic Product B", 150000, 60000], ["Synthetic Product C", 108000, 54000]];
const prodPlan = plan({ ...augVsJul, metrics: ["lineAmount"], filters: [CUST], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 2 });
const prodRes = res({ period: AUG, comparison: JUL, metrics: ["lineAmount"], groupBy: [{ dim: "product" }], amountBasis: { lineAmount: "line_item_pre_tax" }, rowLimit: 2, truncated: true, rows: rows.slice(0, 2).map(([k, p, c]) => ({ key: { product: k }, values: { lineAmount: c }, comparison: { lineAmount: growth(c, p) }, presence: c ? "both" : "previous_only" })), totals: { values: { lineAmount: 114000 }, comparison: { lineAmount: growth(114000, 403463.04) } } });
{
  const c = build(prodPlan, prodRes);
  check("pre-tax", "product line amount: before tax, per item line, never an invoice total", c.metrics[0].basis.id === "line_item_pre_tax" && /before tax/.test(c.metrics[0].basis.text) && /do not add up to invoice totals/.test(c.metrics[0].basis.text) && c.metrics[0].rule.per === "item line");
  check("bases-distinct", "the two bases are never the same text", build(exPlan, exRes).metrics[0].basis.text !== c.metrics[0].basis.text);
  check("truncated", "a cut list: rows shown, the limit, the order, the note that listed rows do not add up to the total", c.kind === "breakdown" && c.rows.truncated === true && c.rows.shown === 2 && c.rows.rowLimit === 2 && c.rows.sort[0].by === "lineAmount.delta" && /do not add up to the total/.test(c.rows.note));
  check("total-covers-all", "the overall total is the engine's (all records, unaffected by the limit), not a sum of the listed rows", c.values[0].current === 114000 && c.values[0].current !== c.rows.items.reduce((t, r) => t + r.values.lineAmount.current, 0) && /beyond the row limit/.test(c.totalCovers));
  const stopped = c.rows.items[0];
  check("rows-exact", "rows in the engine's order with exact values, comparison and presence", stopped.key.product === "Synthetic Tint 36ML" && stopped.values.lineAmount.current === 0 && stopped.values.lineAmount.previous === 145463.04 && stopped.values.lineAmount.change.value === -145463.04 && stopped.presence === "previous_only");
  noNewNumbers("breakdown-no-new-number", c, prodRes);
}

// ---- filters proven (or not) by the previous turn's stored scope
{
  const prevSingle = { entity: "sales", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, filters: [{ value: "Synthetic Traders", op: "eq_ci", dim: "customer" }], metrics: ["invoiceAmount"] };
  const two = plan({ ...augVsJul, metrics: ["lineAmount"], filters: [CUST, { dim: "product", op: "eq_ci", value: "Synthetic Product B" }] });
  const r = res({ ...prodRes, rows: [], truncated: false, groupBy: [] });
  const c = build(two, r, { previousScope: prevSingle });
  check("inherited-proven", "a filter identical to the previous turn's (any key order): same_as_previous; a new one: this_question", c.filters[0].origin === "same_as_previous" && c.filters[1].origin === "this_question" && c.previousScope === "available", JSON.stringify(c.filters));
  const changed = build(two, r, { previousScope: { ...prevSingle, filters: [{ dim: "customer", op: "eq_ci", value: "Synthetic Other" }] } });
  check("inherited-different-value", "the same dimension with another value is not inherited", changed.filters[0].origin === "this_question");
  const otherOp = build(two, r, { previousScope: { ...prevSingle, filters: [{ dim: "customer", op: "contains_ci", value: "Synthetic Traders" }] } });
  check("inherited-different-op", "the same value with another match rule is not inherited", otherOp.filters[0].origin === "this_question");
  const none = build(two, r, { previousScope: null });
  check("no-previous", "no previous scope: every filter is from this question, and the record says there was none", none.filters.every((f) => f.origin === "this_question") && none.previousScope === "none");
  const analysis = build(two, r, { previousScope: { period: prevSingle.period, filters: [CUST] } });
  check("inherited-from-analysis", "an analysis turn's carried scope proves its shared filter the same way", analysis.filters[0].origin === "same_as_previous" && analysis.filters[1].origin === "this_question");
  const noFilters = build(two, r, { previousScope: { period: prevSingle.period } });
  check("previous-without-filters", "a previous scope without filters proves nothing", noFilters.filters.every((f) => f.origin === "this_question"));
}

// ---- zero, missing totals, lists, averages, incomplete periods
{
  const zp = plan({ period: augVsJul.period, metrics: ["invoiceAmount"], filters: [CUST] });
  const z = build(zp, res({ period: AUG, metrics: ["invoiceAmount"], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, totals: { values: { invoiceAmount: 0 } } }));
  check("zero", "no matching records: values unavailable (no_matching_records), no formula, no figure", z.zero === true && z.values.available === false && z.values.reason === "no_matching_records" && !JSON.stringify(z).includes("formula") && numbersIn(z).every((n) => n === 1), JSON.stringify(z.values));
  const zeroNow = build(exPlan, res({ ...exRes, totals: { values: { invoiceAmount: 0 }, comparison: { invoiceAmount: growth(0, 50000) } } }));
  check("zero-against-nonzero", "zero now against a non-zero earlier period is a measured fall, not 'no records'", zeroNow.zero === false && zeroNow.values[0].current === 0 && zeroNow.values[0].change.value === -50000 && zeroNow.values[0].changePct.value === -100);
  const rankPlan = plan({ period: augVsJul.period, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 5 });
  const noTotal = res({ period: AUG, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, rowLimit: 5, rows: [{ key: { customer: "Synthetic Alpha" }, values: { invoiceAmount: 900 } }], totals: null });
  const nt = build(rankPlan, noTotal);
  check("missing-total", "no total returned: unavailable (total_not_returned), never 0 and never a sum of the rows", nt.values.available === false && nt.values.reason === "total_not_returned" && nt.rows.items[0].values.invoiceAmount.current === 900 && !("totalCovers" in nt));
  noNewNumbers("missing-total-no-new-number", nt, noTotal);
  const listPlan = plan({ mode: "list", period: augVsJul.period, metrics: ["invoiceAmount"], limit: 2 });
  const listRes = res({ period: AUG, metrics: ["invoiceAmount"], rowLimit: 2, truncated: true, rows: [{ voucherNo: "S1", date: "2025-08-02", customer: "Synthetic Alpha", invoiceAmount: 100 }, { voucherNo: "S2", date: "2025-08-03", customer: "Synthetic Beta", invoiceAmount: 200 }], totals: null });
  const l = build(listPlan, listRes);
  check("list", "an invoice list: no total (invoice_list_has_no_total), each invoice as returned, cut flagged", l.kind === "list" && l.values.reason === "invoice_list_has_no_total" && l.rows.items[1].voucherNo === "S2" && l.rows.items[1].amount === 200 && l.rows.truncated === true);
  noNewNumbers("list-no-new-number", l, listRes);
  const avgBoth = res({ period: AUG, metrics: ["invoiceAmount", "invoiceCount", "averageInvoiceValue"], amountBasis: { invoiceAmount: "voucher_total_incl_tax", averageInvoiceValue: "voucher_total_incl_tax" }, totals: { values: { invoiceAmount: 3000, invoiceCount: 4, averageInvoiceValue: 750 } } });
  const ab = build(plan({ period: augVsJul.period, metrics: ["invoiceAmount", "invoiceCount", "averageInvoiceValue"] }), avgBoth);
  const avg = ab.values.find((x) => x.metric === "averageInvoiceValue");
  check("average-inputs", "an average: the catalog's ratio rule, its two measured inputs and the engine's own result", avg.current === 750 && avg.ratioInputs.numerator === 3000 && avg.ratioInputs.denominator === 4 && ab.metrics[2].rule.op === "ratio" && ab.metrics[2].rule.numerator.id === "invoiceAmount" && ab.metrics[2].rule.whenDenominatorZero === 0 && !ab.unavailable.includes("record_count"));
  const avgOnly = build(plan({ period: augVsJul.period, metrics: ["averageInvoiceValue"] }), res({ period: AUG, metrics: ["averageInvoiceValue"], amountBasis: { averageInvoiceValue: "voucher_total_incl_tax" }, totals: { values: { averageInvoiceValue: 750 } } }));
  check("average-inputs-unmeasured", "an average whose inputs were not measured: inputs unavailable, never back-computed; the invoice count is unavailable", avgOnly.values[0].ratioInputs.available === false && avgOnly.values[0].ratioInputs.reason === "inputs_not_measured" && avgOnly.unavailable.includes("record_count"));
  const inc = build(exPlan, exRes, { dataThrough: "2025-08-20", contextNotes: [{ code: "coverage_partial", message: "Part of this period is outside the synced data." }] });
  check("incomplete", "a period past the latest voucher and partial coverage: both reasons, the note kept as a limitation", JSON.stringify(inc.incomplete.reasons) === JSON.stringify(["partly_outside_synced_data", "period_ends_after_latest_voucher"]) && inc.limitations.some((x) => x.code === "coverage_partial") && inc.data.latestVoucher === "2025-08-20", JSON.stringify(inc.incomplete));
  check("complete", "a period fully before the latest voucher is not called incomplete", !("incomplete" in build(exPlan, exRes, { dataThrough: "2025-12-31" })));
  check("all-time", "all history is never called incomplete", !("incomplete" in build(plan({ period: { kind: "all_time" }, metrics: ["invoiceAmount"] }), res({ ...exRes, comparison: null, period: { kind: "all_time", from: null, to: AUG.to } }), { dataThrough: "2025-08-20" })));
  const ret = build(plan({ entity: "sales_return", period: augVsJul.period, metrics: ["returnAmount"] }), res({ period: AUG, metrics: ["returnAmount"], amountBasis: { returnAmount: "voucher_total_incl_tax" }, totals: { values: { returnAmount: 25000 } } }));
  check("returns-records", "returns: only Credit Notes classified as returns", /^Active Credit Notes classified as sales returns/.test(ret.records));
  const notes = build(exPlan, { ...exRes, warnings: [{ code: "w1", message: "Synthetic warning." }], assumptions: [{ code: "a1", message: "Synthetic assumption." }] }, { definitionNotes: [{ code: "revenue_definition", message: "Revenue = pre-tax item value." }], plannerAssumptions: ["Read 'last month' as August 2025."] });
  check("rules-and-interpretation", "rules applied, AI-assisted interpretation and limitations are the texts the answer carries, labelled", notes.rulesApplied[0].code === "revenue_definition" && notes.interpretation[0].source === "ai_assisted" && notes.limitations.map((x) => x.code).join() === "a1,w1");
  check("unavailable", "what the engine does not record is listed as unavailable, never filled", ["source_records", "request_id", "data_version", "record_count"].every((k) => build(exPlan, exRes).unavailable.includes(k)));
}

// ---- through the chat turn: attached to visualization.calculation; the answer text and the model calls are unchanged
(async () => {
  const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");
  const DC = { referenceDate: new Date(2026, 9, 27, 12), source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 31), coverage: { earliest: new Date(2025, 0, 1), latest: new Date(2025, 11, 31), lastSyncedAt: null } };
  const turn = async (question, planOut, result, previousQuery = null) => {
    let calls = 0;
    const model = async () => { calls += 1; return { content: [{ type: "tool_use", id: "p", name: PLANNER_TOOL_NAME, input: { plan: planOut } }], usage: { input_tokens: 1, output_tokens: 1 } }; };
    const out = await tryAnswerWithQueryEngine({ context: { tenantId: "T-CALC", userId: "u" }, userMessage: question, conversationHistory: previousQuery ? [{ role: "user", content: "(earlier)" }, { role: "assistant", content: "(answer)" }] : [], previousQuery, deps: { plannerClient: model, getFreshness: async () => ({ state: "fresh", message: "", dataAsOf: new Date("2026-10-26T04:35:00Z") }), getDateContext: async () => DC, execute: async () => ({ result, cache: { status: "miss" } }), resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) } });
    return { s: out.structured, queryContext: out.queryContext, calls };
  };
  const exQ = { ...exPlan };
  const first = await turn("Sales August 2025 vs July 2025", exQ, exRes);
  const calc = first.s.visualization.calculation;
  check("chat-attached", "the answer's view carries the record; one planner call; fresh data time recorded", calc && calc.v === 1 && calc.values[0].current === 4344775.5 && first.calls === 1 && calc.data.freshness.dataAsOf === "2026-10-26T04:35:00.000Z" && calc.data.latestVoucher === "2025-12-31", JSON.stringify(calc && calc.data));
  check("chat-text-unchanged", "the answer text still ends with the formatter's output, unchanged", first.s.answer.endsWith(`\n\n${formatQueryAnswer({ plan: exQ, result: exRes, dataThrough: DC.latestVoucher }).text}`), first.s.answer.slice(-300));
  check("chat-no-tenant", "the record holds no tenant id, prompt or plan internals", !!calc && !/T-CALC|tenant|submit_query_plan|system/i.test(JSON.stringify(calc)));
  const fq = { ...exQ, filters: [CUST] };
  const follow = await turn("only Synthetic Traders", fq, exRes, first.queryContext);
  check("chat-follow-up-new-filter", "a follow-up adding a customer: that filter is from this question", follow.s.visualization.calculation.filters[0].origin === "this_question" && follow.s.visualization.calculation.previousScope === "available");
  const again = await turn("and in purchases terms the same customer, same months", fq, exRes, follow.queryContext);
  check("chat-follow-up-kept-filter", "the next follow-up keeping that customer: same_as_previous, proven by the stored plan", again.s.visualization.calculation.filters[0].origin === "same_as_previous", JSON.stringify(again.s.visualization.calculation.filters));
  console.log(`\nverify-calculation: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
