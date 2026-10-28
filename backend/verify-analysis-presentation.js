/**
 * Structured view of an analysis answer (services/query/analysisPresentation.js) and the display intent read from the
 * question (presentation.displayIntent). Checks that:
 *   - an answered analysis gets a presentation (kind "analysis") with a headline, KPI cards, one featured visual, labelled
 *     findings, gaps, suggested next actions and every step - not only the long text;
 *   - the headline, the KPI cards, the featured chart and the table carry the SAME values (the engine's, formatted once);
 *   - a contributor is never presented as a cause, and possible causes and next actions are kept apart from findings;
 *   - accounting bases, assumptions, not-run steps and step references stay visible;
 *   - too little data gives no chart and no KPI cards (never a made-up visual); no answered step gives no presentation;
 *   - "chart" / "table" in the question is passed through; ordinary questions get neither;
 *   - building the view changes neither the answer text nor the execution, and single-query presentations are unchanged.
 * Synthetic step results shaped like executeAnalysisPlan's: no database, no network, no model.
 *
 * Run: node verify-analysis-presentation.js
 */

process.env.AI_USAGE_PERSIST = "off";
const http = require("http");
const https = require("https");
let netCalls = 0;
http.request = () => { netCalls += 1; throw new Error("network blocked in test"); };
https.request = () => { netCalls += 1; throw new Error("network blocked in test"); };

const { buildAnalysisPresentation } = require("./src/services/query/analysisPresentation");
const { formatAnalysisAnswer } = require("./src/services/query/analysisAnswer");
const { buildPresentation, displayIntent } = require("./src/services/query/presentation");
const { fmtMoney } = require("./src/services/query/answerFormatter");

let pass = 0;
let fail = 0;
function check(description, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 600)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const section = (t) => console.log(`\n=== ${t} ===`);

// ---------------------------------------------------------------- fixtures (the engine's result shapes)
const REF = new Date(2025, 9, 15, 12); // reporting reference date: 15 Oct 2025 (August and July are complete)
const iso = (y, m, d, end = false) => (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
const AUG = { kind: "custom", from: iso(2025, 8, 1), to: iso(2025, 8, 31, true), label: "Custom range", isPartial: false };
const JUL = { mode: "custom", from: iso(2025, 7, 1), to: iso(2025, 7, 31, true), label: "Custom comparison range" };
const AUG_PLAN = { kind: "custom", from: "2025-08-01", to: "2025-08-31" };
const JUL_PLAN = { kind: "custom", from: "2025-07-01", to: "2025-07-31" };
const round2 = (n) => Math.round(n * 100) / 100;
const cmp = (cur, prev) => ({ previous: prev, delta: round2(cur - prev), deltaPct: prev ? round2(((cur - prev) / prev) * 100) : null });
let sid = 0;
const qstep = (request, result, extra = {}) => ({
  id: `s${++sid}`, kind: "query", status: "ok",
  request: { v: 1, entity: "sales", mode: "aggregate", filters: [], groupBy: [], ...request },
  result: { ok: true, entity: "sales", mode: "aggregate", grain: "voucher", rows: [], totals: null, truncated: false, comparison: null, warnings: [], assumptions: [], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, ...result },
  facts: "(step text)", notes: [], dataState: null, ...extra,
});
// step 1: total sales, August vs July (the measured change)
const totalStep = () => qstep(
  { metrics: ["invoiceAmount", "invoiceCount"], period: AUG_PLAN, compare: { mode: "custom", period: JUL_PLAN } },
  { metrics: ["invoiceAmount", "invoiceCount"], period: AUG, comparison: JUL, totals: { values: { invoiceAmount: 410000, invoiceCount: 90 }, comparison: { invoiceAmount: cmp(410000, 500000), invoiceCount: cmp(90, 100) } } },
);
// step 2: the same change by customer (contributors; the rows add up to the total change)
const CUSTOMERS = [["Alpha Stores", 120000, 170000], ["Beta Traders", 90000, 120000], ["Gamma Co", 200000, 210000]];
const byCustomerStep = () => qstep(
  { metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], period: AUG_PLAN, compare: { mode: "custom", period: JUL_PLAN }, sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 10 },
  {
    metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], period: AUG, comparison: JUL,
    rows: CUSTOMERS.map(([name, cur, prev]) => ({ key: { customer: name }, values: { invoiceAmount: cur }, comparison: { invoiceAmount: cmp(cur, prev) } })),
    totals: { values: { invoiceAmount: 410000 }, comparison: { invoiceAmount: cmp(410000, 500000) } },
  },
);
// step 3: pre-tax line value by product (another accounting basis, kept apart)
const lineStep = () => qstep(
  { metrics: ["lineAmount"], groupBy: [{ dim: "product" }], period: AUG_PLAN, limit: 10 },
  { metrics: ["lineAmount"], groupBy: [{ dim: "product" }], grain: "line", period: AUG, amountBasis: { lineAmount: "line_item_pre_tax" }, rows: [{ key: { product: "Pen" }, values: { lineAmount: 3000 } }, { key: { product: "Ink" }, values: { lineAmount: 1500 } }], totals: { values: { lineAmount: 4500 } } },
);
const notRunStep = () => ({ id: `s${++sid}`, kind: "query", status: "refused", error: { code: "outside_coverage", message: "No Purchase data exists for this period." } });
const build = (steps, opts = {}) => {
  const execution = { steps };
  const formatted = formatAnalysisAnswer(execution, { referenceDate: REF, assumptions: opts.assumptions || [] });
  const before = JSON.stringify(execution);
  const text = formatted.text;
  const p = buildAnalysisPresentation({ execution, formatted, assumptions: opts.assumptions || [], unavailable: opts.unavailable || [], display: opts.display || null });
  return { p, formatted, unchanged: JSON.stringify(execution) === before && formatAnalysisAnswer(execution, { referenceDate: REF, assumptions: opts.assumptions || [] }).text === text };
};

// ---------------------------------------------------------------- 1. a "why did sales fall" analysis
section("1. Why did sales fall in August 2025? (total change + contributors)");
{
  const { p, formatted, unchanged } = build([totalStep(), byCustomerStep(), lineStep(), notRunStep()], { assumptions: ["invoiceAmount compared with the month before"] });
  check("an answered analysis gets a structured presentation (kind analysis, v1), not only the text", p && p.v === 1 && p.kind === "analysis", JSON.stringify(p));
  check("headline = the measured total change of step 1 (from the evidence record, with its step)", p.headline && /Sales/.test(p.headline.text) && p.headline.text.includes(fmtMoney(500000)) && p.headline.text.includes(fmtMoney(410000)) && /-₹90,000\.00/.test(p.headline.text) && p.headline.steps.includes(1), JSON.stringify(p.headline));
  const cards = Object.fromEntries((p.kpis ? p.kpis.cards : []).map((c) => [c.id, c]));
  check("KPI cards: current, previous, change, % change of step 1", p.kpis && p.kpis.step === 1 && cards.current.display === fmtMoney(410000) && cards.previous.display === fmtMoney(500000) && cards.change.display === "-₹90,000.00" && cards.pct.display === "-18.0%", JSON.stringify(p.kpis));
  check("a fall keeps its sign and direction (never shown as a positive change)", cards.change.direction === "down" && cards.pct.direction === "down");
  check("KPI cards carry the step's accounting basis (invoice totals including tax)", p.kpis.basis.includes("Invoice amounts are invoice totals including tax."), JSON.stringify(p.kpis.basis));
  const s1 = p.steps[0].view;
  check("summary and table agree: the comparison table's cells are the KPI values", s1.kind === "comparison" && s1.rows[0].cells.invoiceAmount === cards.previous.display && s1.rows[1].cells.invoiceAmount === cards.current.display, JSON.stringify(s1.rows));
  check("summary and chart agree: the comparison chart's points are the KPI values", s1.chart.points[0].display === cards.previous.display && s1.chart.points[1].display === cards.current.display);
  check("featured visual = the contributor breakdown (step 2), a ranking with previous values (comparison is visible)", p.featuredStep === 2 && p.steps[1].view.kind === "ranking" && p.steps[1].view.chart.points.every((pt) => pt.previous !== undefined), JSON.stringify(p.steps[1].view && p.steps[1].view.chart));
  const s2 = p.steps[1].view;
  check("contributor table: exact current, previous and change per customer (the engine's values)", s2.rows.length === 3 && s2.rows[0].cells.name === "Alpha Stores" && s2.rows[0].cells.previous === fmtMoney(170000) && s2.rows[0].cells.change === "-₹50,000.00" && s2.rows[0].cells.pct === "-29.4%", JSON.stringify(s2.rows[0]));
  check("the contributor chart and table carry the same per-customer values", s2.chart.points.every((pt) => s2.rows.some((r) => r.cells.name === pt.label && r.cells.invoiceAmount === pt.display)));
  check("contributors are their own list, word-for-word the evidence record's", p.findings.contributors.length > 0 && p.findings.contributors.every((c) => formatted.evidence.findings.some((f) => f.label === "contributor" && f.text === c.text)), JSON.stringify(p.findings.contributors));
  check("no contributor is presented as a cause: possible causes are a separate, labelled list", p.findings.contributors.every((c) => !/\bcaused?\b|\bbecause\b/i.test(c.text)) && p.findingLabels.possibleCause === "Possible cause (not proven)");
  check("the headline is not repeated among the other measured findings", !p.findings.measured.some((f) => f.text === p.headline.text));
  check("each finding keeps its step references", [...p.findings.measured, ...p.findings.contributors].every((f) => Array.isArray(f.steps) && f.steps.length > 0));
  check("the label legend is kept (Measured / Contributor / Possible cause)", /Possible cause = consistent with the data, not proven/.test(p.labelNote || ""));
  check("assumptions keep the text's own AI-assisted label", p.assumptions.length === 1 && /^Interpretation \(AI-assisted\): /.test(p.assumptions[0]) && !/invoiceAmount/.test(p.assumptions[0]), JSON.stringify(p.assumptions));
  check("both accounting bases are listed, never merged", p.basis.includes("Invoice amounts are invoice totals including tax.") && p.basis.includes("Amounts are pre-tax line-item totals (revenue), not invoice totals."), JSON.stringify(p.basis));
  check("the pre-tax step keeps its own basis on its view", p.steps[2].view.basis.length === 1 && /pre-tax/.test(p.steps[2].view.basis[0]));
  check("a step that did not run is listed with its reason", p.steps[3].kind === "not_run" && p.steps[3].status === "refused" && /No Purchase data/.test(p.steps[3].message));
  check("every step is listed, numbered, with a title", p.steps.map((s) => s.n).join() === "1,2,3,4" && p.steps.every((s) => typeof s.title === "string" && s.title));
  check("ordinary analysis question: no display preference", p.display === null);
  check("building the view changes neither the answer text nor the execution", unchanged);
  check("the payload is plain JSON (storable in the chat document)", JSON.stringify(JSON.parse(JSON.stringify(p))) === JSON.stringify(p));
}

// ---------------------------------------------------------------- 2. next actions and gaps
section("2. Suggested next actions and gaps stay apart from findings");
{
  const execution = { steps: [totalStep(), byCustomerStep()] };
  const formatted = formatAnalysisAnswer(execution, { referenceDate: REF, limitations: ["The follow-up round could not run."], actions: true });
  formatted.evidence.recommendations = [{ text: "Check Alpha Stores' orders for August.", steps: [2] }];
  const p = buildAnalysisPresentation({ execution, formatted, actions: true }); // the question asked what to do
  check("suggested next actions are their own list with the steps they follow from", p.recommendations.length === 1 && p.recommendations[0].steps[0] === 2 && !p.findings.contributors.some((c) => c.text === p.recommendations[0].text));
  check("what the data cannot establish is its own list (incl. the investigation's limitations)", p.gaps.some((g) => g.text === "The follow-up round could not run."));
}

// ---------------------------------------------------------------- 3. too little data
section("3. Missing or insufficient data never makes a misleading visual");
{
  const single = qstep({ metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], period: AUG_PLAN }, { metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], period: AUG, rows: [{ key: { customer: "Alpha Stores" }, values: { invoiceAmount: 120000 } }], totals: { values: { invoiceAmount: 120000 } } });
  const { p } = build([single]);
  check("one row: the step has its table but no chart", p && p.steps[0].view.kind === "ranking" && p.steps[0].view.chart === null);
  check("no comparison in any step: no KPI cards", p.kpis === null);
  const zero = qstep({ metrics: ["invoiceAmount"], period: AUG_PLAN }, { metrics: ["invoiceAmount"], period: AUG, totals: { values: { invoiceAmount: 0 } } });
  const z = build([zero]);
  check("no records: the step is the empty state, no KPI cards, nothing featured as a chart", z.p && z.p.steps[0].view.kind === "empty" && z.p.kpis === null && !(z.p.steps[0].view.chart));
  const none = buildAnalysisPresentation({ execution: { steps: [notRunStep()] }, formatted: formatAnalysisAnswer({ steps: [notRunStep()] }) });
  check("no step answered: no presentation (the text answer stays the whole answer)", none === null);
  check("a malformed input never throws: null", buildAnalysisPresentation({ execution: { steps: [{ status: "ok", kind: "query" }] }, formatted: { answered: 1, evidence: {} } }) === null);
}

// ---------------------------------------------------------------- 4. display intent
section("4. What the user asked to see");
{
  check("'show sales as a chart' -> chart", displayIntent("Show August sales by customer as a chart") === "chart");
  check("'graph' / 'visualise' -> chart", displayIntent("sales ka graph dikhao") === "chart" && displayIntent("visualise purchases") === "chart");
  check("'in a table' -> table", displayIntent("Give me daily sales for August in a table") === "table");
  check("an ordinary question -> no preference", displayIntent("Why did sales fall in August 2025?") === null && displayIntent("What were sales last month?") === null);
  check("words that only contain them are not matched ('notable', 'graphite')", displayIntent("notable customers") === null && displayIntent("graphite pencils sales") === null);
  check("asking for both -> no preference (both shown)", displayIntent("chart and table of sales") === null);
  const { p } = build([totalStep(), byCustomerStep()], { display: "chart" });
  check("the analysis view carries the preference", p.display === "chart");
}

// ---------------------------------------------------------------- 5. single-query presentation unchanged
section("5. Single-query presentations are unchanged");
{
  const s = totalStep();
  const plain = buildPresentation({ plan: s.request, result: s.result });
  check("without a preference: no display key (identical to before)", plain && !("display" in plain) && plain.kind === "comparison");
  const asked = buildPresentation({ plan: s.request, result: s.result, display: "table" });
  check("with a preference: the same model plus display", asked.display === "table" && JSON.stringify({ ...asked, display: undefined }) === JSON.stringify({ ...plain, display: undefined }));
}

// ---------------------------------------------------------------- 6. through the real chat turn
// tryAnswerWithQueryEngine with a scripted fake planner and a fake executor (the same seams the chat suites use): no database.
async function chatTurns() {
  section("6. A real chat turn carries the view (fake planner, fake executor)");
  const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");
  const { PLANNER_TOOL_NAME } = require("./src/services/query/planner");
  const { ANALYSIS_TOOL_NAME } = require("./src/services/query/analysisPlanner");
  const reply = (name, input) => ({ content: [{ type: "tool_use", id: "tu_1", name, input }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  const model = (script) => async (req) => {
    const next = script[req.tool_choice.name].shift();
    if (!next) throw new Error(`no scripted reply for ${req.tool_choice.name}`);
    return reply(req.tool_choice.name, next);
  };
  const results = { total: totalStep().result, customer: byCustomerStep().result };
  const execute = async (plan) => ({ result: plan.groupBy && plan.groupBy.length ? results.customer : results.total });
  const DC = { referenceDate: REF, source: "today", futureVouchers: false, latestVoucher: new Date(2025, 9, 14), coverage: { earliest: new Date(2025, 0, 1), latest: new Date(2025, 9, 14), lastSyncedAt: null } };
  const deps = (plannerClient) => ({ plannerClient, execute, analysisEnabled: true, getFreshness: async () => ({ state: "fresh", message: "", dataAsOf: null }), getDateContext: async () => DC });
  const ask = (question, script) => tryAnswerWithQueryEngine({ context: { tenantId: "T-analysis-presentation", userId: "u1" }, userMessage: question, conversationHistory: [], deps: deps(model(script)) });
  const q = (o) => ({ v: 1, entity: "sales", mode: "aggregate", period: AUG_PLAN, metrics: ["invoiceAmount"], groupBy: [], filters: [], ...o });
  const VS_JUL = { mode: "custom", period: JUL_PLAN };
  const PLAN = { v: 1, steps: [
    { id: "total", kind: "query", plan: q({ compare: VS_JUL }) },
    { id: "customers", kind: "query", plan: q({ groupBy: [{ dim: "customer" }], compare: VS_JUL, sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 10 }) },
  ] };
  const NEEDS = { decline: { code: "needs_analysis", message: "This needs several analyses." } };

  let out = await ask("Why did sales fall in August 2025?", { [PLANNER_TOOL_NAME]: [NEEDS], [ANALYSIS_TOOL_NAME]: [{ analysis: PLAN }] });
  const v = out.structured.visualization;
  check("an analysis turn returns the structured view next to the unchanged text answer", out.structured.details.queryEngine.route === "analysis" && v && v.kind === "analysis" && /\n\nAnalysis: /.test(out.structured.answer), JSON.stringify(out.structured.details.queryEngine));
  check("its headline and KPI cards are the measured change of the turn's own results", v && /-₹90,000\.00/.test(v.headline.text) && v.kpis.cards.find((c) => c.id === "change").display === "-₹90,000.00" && out.structured.answer.includes(v.headline.text), v && JSON.stringify(v.headline));
  check("the view's findings are the ones the text states", v && [...v.findings.measured, ...v.findings.contributors, v.headline].every((f) => out.structured.answer.includes(f.text)));
  check("an ordinary 'why' question: no display preference", v && v.display === null);

  out = await ask("Show sales by customer for August 2025 as a chart", { [PLANNER_TOOL_NAME]: [NEEDS], [ANALYSIS_TOOL_NAME]: [{ analysis: PLAN }] });
  check("'as a chart' reaches the analysis view", out.structured.visualization && out.structured.visualization.display === "chart");

  out = await ask("Sales by customer in August 2025 in a table", { [PLANNER_TOOL_NAME]: [{ plan: q({ groupBy: [{ dim: "customer" }], compare: VS_JUL, sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 10 }) }] });
  check("single query asked 'in a table': the same ranking view, display table", out.structured.visualization && out.structured.visualization.kind === "ranking" && out.structured.visualization.display === "table", JSON.stringify(out.structured.details.queryEngine));
  out = await ask("Sales by customer in August 2025", { [PLANNER_TOOL_NAME]: [{ plan: q({ groupBy: [{ dim: "customer" }], compare: VS_JUL, sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 10 }) }] });
  check("single query without such words: no display key (as before)", out.structured.visualization && !("display" in out.structured.visualization));
}

chatTurns()
  .catch((e) => check("chat turns ran", false, e && e.stack))
  .finally(() => {
    check("no network call of any kind", netCalls === 0, netCalls);
    console.log(`\nverify-analysis-presentation: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
