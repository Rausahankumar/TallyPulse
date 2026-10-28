/**
 * The overall result governs the answer (evidence.overallOf): the measured total's direction is stated first, in words, and
 * when the plan's own breakdowns look the other way (ranked by / filtered to falls while the total rose, or the reverse) the
 * answer says the comparison does not show the opposite. Customer/product declines and zero sales stay secondary findings.
 *
 * Grounded fixture: the reported June -> July 2025 comparison - sales invoice amount ₹40,85,714.10 -> ₹57,16,599.12
 * (+₹16,30,885.02, +39.9%). ONLY those two totals are from the report; every customer and product row below is a
 * SYNTHETIC placeholder (named "Synthetic ..."), not business data.
 *
 * Run: node verify-overall-direction.js   (no database, no network, no model; one chat turn with a scripted planner)
 */

process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const { buildEvidence } = require("./src/services/query/evidence");
const { formatAnalysisAnswer } = require("./src/services/query/analysisAnswer");
const { buildAnalysisPresentation } = require("./src/services/query/analysisPresentation");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 900)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const iso = (y, m, d, end) => (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
const r2 = (n) => Math.round(n * 100) / 100;
const cmp = (c, p) => ({ previous: p, delta: r2(c - p), deltaPct: p ? r2(((c - p) / p) * 100) : null });
const JUN = { from: iso(2025, 6, 1), to: iso(2025, 6, 30, true) }, JUL = { from: iso(2025, 7, 1), to: iso(2025, 7, 31, true) };
const REPORTED = { june: 4085714.1, july: 5716599.12 }; // the reported invoice totals

// one compared step: dim null = a total; rows [name, previous, current]; totals [previous, current] or null (not measured)
function step(dim, metric, rows, totals, { sort = null, having = [], truncated = false, filters = [] } = {}) {
  return {
    kind: "query", status: "ok", facts: "(step text)", notes: [],
    request: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-07-01", to: "2025-07-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-06-01", to: "2025-06-30" } }, metrics: [metric], groupBy: dim ? [{ dim }] : [], filters, ...(sort ? { sort } : {}), having, limit: 10 },
    result: { ok: true, entity: "sales", period: JUL, comparison: JUN, metrics: [metric], groupBy: dim ? [{ dim }] : [], amountBasis: { [metric]: metric === "lineAmount" ? "line_item_pre_tax" : "voucher_total_incl_tax" }, rows: rows.map(([k, p, c]) => ({ key: { [dim]: k }, values: { [metric]: c }, comparison: { [metric]: cmp(c, p) } })), totals: totals ? { values: { [metric]: totals[1] }, comparison: { [metric]: cmp(totals[1], totals[0]) } } : null, truncated },
  };
}
const fallsFirst = (m) => ({ sort: [{ by: `${m}.delta`, dir: "asc" }], having: [{ metric: `${m}.delta`, op: "lt", value: 0 }] });
const risesFirst = (m) => ({ sort: [{ by: `${m}.delta`, dir: "desc" }], having: [{ metric: `${m}.delta`, op: "gt", value: 0 }] });
const answer = (steps, o = {}) => { const f = formatAnalysisAnswer({ steps }, o); return { f, text: f.text, ev: f.evidence, vis: buildAnalysisPresentation({ execution: { steps }, formatted: f }) }; };

// ---- 1. the reported shape: "why did sales decline" planned as falls-only breakdowns, while the total ROSE
{
  const customers = step("customer", "invoiceAmount", [["Synthetic Customer A", 50000, 0], ["Synthetic Customer B", 30000, 12000]], [REPORTED.june, REPORTED.july], fallsFirst("invoiceAmount"));
  const products = step("product", "lineAmount", [["Synthetic Product X", 20000, 0]], [3800000, 5300000], fallsFirst("lineAmount"));
  const { text, ev, vis } = answer([customers, products]);
  check("rise-overall", "the overall result is the reported one, with its direction in words: rose from ₹40,85,714.10 (Jun 2025) to ₹57,16,599.12 (Jul 2025), +₹16,30,885.02 (+39.9%), invoice totals", ev.overall && ev.overall.direction === 1 && ev.overall.text === "Sales (invoice amount) rose from ₹40,85,714.10 in Jun 2025 to ₹57,16,599.12 in Jul 2025: +₹16,30,885.02 (+39.9%).", JSON.stringify(ev.overall));
  check("rise-mismatch", "the plan looked for falls while the total rose: the answer says the comparison does not show an overall decline, and that the customers and products that fell are individual changes", ev.overall.note === "This comparison does not show an overall decline: the total rose. The customers and products below that fell are individual changes within that overall increase.", ev.overall.note);
  const at = (s) => text.indexOf(s);
  check("rise-first", "the overall result and the mismatch come first - before every customer/product finding, including the zero-July-sales ones", at("**Overall:** Sales (invoice amount) rose") > 0 && at("does not show an overall decline") < at("**Findings**") && at("**Findings**") < at("none recorded in Jul 2025 for Synthetic Customer A"), text.slice(0, 900));
  check("rise-secondary-kept", "individual declines and zero sales stay available as secondary findings (not removed)", /none recorded in Jul 2025 for Synthetic Customer A/.test(text) && /none recorded in Jul 2025 for Synthetic Product X/.test(text) && /Contributor: This list of customers/.test(text));
  check("rise-no-decline-claim", "nothing states that overall sales fell or declined", !/Sales \(invoice amount\) fell|sales (declined|fell) overall|overall (decline|fall) (in|of) sales/i.test(text.replace("does not show an overall decline", "")));
  check("rise-not-repeated", "the total is stated once (the overall line), not repeated as a measured finding", (text.match(/₹57,16,599\.12/g) || []).length === 1, (text.match(/₹57,16,599\.12/g) || []).length);
  check("rise-view", "the view's headline is the overall result with the mismatch note; the KPI change shows the rise; the total is not repeated among the findings", vis.headline.text === ev.overall.text && vis.headline.note === ev.overall.note && vis.kpis.cards.find((c) => c.id === "change").direction === "up" && !vis.findings.measured.some((f) => f.text === ev.overall.sourceText), JSON.stringify(vis.headline));
}

// ---- 2. the reverse: total FELL while the plan looked at customers that rose
{
  const customers = step("customer", "invoiceAmount", [["Synthetic Customer C", 10000, 25000]], [500000, 420000], risesFirst("invoiceAmount"));
  const { ev, text } = answer([customers]);
  check("fall-overall", "overall fell (synthetic): -₹80,000.00 (-16.0%), stated first", ev.overall.direction === -1 && /\n\nAnalysis: [^\n]*\n\n\*\*Overall:\*\* Sales \(invoice amount\) fell from ₹5,00,000\.00 in Jun 2025 to ₹4,20,000\.00 in Jul 2025: -₹80,000\.00 \(-16\.0%\)\./.test(text), text.slice(0, 400));
  check("fall-mismatch", "the plan looked at rises while the total fell: 'does not show an overall increase', the customers that rose are individual changes within the decrease", ev.overall.note === "This comparison does not show an overall increase: the total fell. The customers below that rose are individual changes within that overall decrease.", ev.overall.note);
  const consistent = answer([step("customer", "invoiceAmount", [["Synthetic Customer D", 90000, 10000]], [500000, 420000], fallsFirst("invoiceAmount"))]);
  check("fall-consistent", "a decline question when the total did fall: the direction is stated, with no mismatch note", consistent.ev.overall.direction === -1 && consistent.ev.overall.note === null, JSON.stringify(consistent.ev.overall));
}

// ---- 3. total rose; some products have no July sales; the plan did not look for falls (a plain product comparison)
{
  const total = step(null, "invoiceAmount", [], [REPORTED.june, REPORTED.july]);
  const products = step("product", "lineAmount", [["Synthetic Product Y", 0, 60000], ["Synthetic Product Z", 15000, 0]], [3800000, 5300000], { sort: [{ by: "lineAmount", dir: "desc" }] });
  const { ev, text } = answer([total, products]);
  check("zero-products", "the company total governs (rose, the reported figures); the product with no July sales is a secondary finding after it; no mismatch note (the plan did not look for falls)", ev.overall.steps[0] === 1 && /rose from ₹40,85,714\.10/.test(ev.overall.text) && ev.overall.note === null && text.indexOf("**Overall:**") < text.indexOf("none recorded in Jul 2025 for Synthetic Product Z") && text.indexOf("none recorded in Jul 2025 for Synthetic Product Z") > 0, text.slice(0, 700));
  check("zero-basis", "the product breakdown keeps its own pre-tax basis; the overall line is the invoice-total basis of the company total", /\*\*Overall:\*\* Sales \(invoice amount\)/.test(text) && /line amount, pre-tax/.test(text));
}

// ---- 4. the overall comparison incomplete or unavailable
{
  const partial = answer([step("customer", "invoiceAmount", [["Synthetic Customer A", 50000, 0]], [REPORTED.june, REPORTED.july], fallsFirst("invoiceAmount"))], { dataThrough: "2025-07-15" });
  check("incomplete", "data only to 15 Jul: the overall line says so (not a full-period change), and the mismatch note says 'so far'", /rose from ₹40,85,714\.10 in Jun 2025 to ₹57,16,599\.12 in Jul 2025 \(incomplete: data only up to 2025-07-15\): \+₹16,30,885\.02/.test(partial.ev.overall.text) && /within that overall increase \(so far\)\./.test(partial.ev.overall.note) && /Jul 2025 has data only up to 2025-07-15, so its change is not a full-period change/.test(partial.text), JSON.stringify(partial.ev.overall));
  const none = answer([step("customer", "invoiceAmount", [["Synthetic Customer A", 50000, 0], ["Synthetic Customer B", 30000, 12000]], null, { ...fallsFirst("invoiceAmount"), truncated: true })]);
  check("unavailable", "no total measured: the overall direction is stated as NOT established (never inferred from the listed rows), no rise or fall claimed, no mismatch note", none.ev.overall && none.ev.overall.unavailable === true && /\*\*Overall:\*\* The overall change between the periods was not measured, so whether the total rose or fell is not established/.test(none.text) && !/ rose from | fell from /.test(none.text), none.text.slice(0, 500));
  check("unchanged", "a total that did not change is said so, without a mismatch note", (() => { const u = answer([step("customer", "invoiceAmount", [["Synthetic Customer A", 50000, 40000], ["Synthetic Customer B", 30000, 40000]], [80000, 80000], fallsFirst("invoiceAmount"))]); return /did not change from ₹80,000\.00/.test(u.ev.overall.text) && u.ev.overall.note === null; })());
  check("no-comparison", "no period comparison at all: no overall line", answer([{ ...step("customer", "invoiceAmount", [], [1, 2]), result: { ...step("customer", "invoiceAmount", [], [1, 2]).result, comparison: null } }]).ev.overall === null);
}

// ---- 5. through the chat turn: the reported question shape, planned as falls-only breakdowns
(async () => {
  const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");
  const DC = { referenceDate: new Date(2026, 9, 27, 12), source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 31), coverage: { earliest: new Date(2025, 0, 1), latest: new Date(2025, 11, 31), lastSyncedAt: null } };
  const plan = { v: 1, steps: [{ id: "customers", kind: "query", plan: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-07-01", to: "2025-07-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-06-01", to: "2025-06-30" } }, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], ...fallsFirst("invoiceAmount"), limit: 10 } }] };
  const replies = [{ decline: { code: "needs_analysis", message: "several analyses" } }, { analysis: plan }];
  const model = async (req) => ({ content: [{ type: "tool_use", name: req.tool_choice.name, input: replies.shift() || { decline: { code: "not_a_data_query" } } }], usage: { input_tokens: 1, output_tokens: 1 } });
  const tenants = [];
  const execute = async (p, ctx) => { tenants.push(ctx.tenantId); return { result: step("customer", "invoiceAmount", [["Synthetic Customer A", 50000, 0]], [REPORTED.june, REPORTED.july], fallsFirst("invoiceAmount")).result }; };
  const out = await tryAnswerWithQueryEngine({ context: { tenantId: "T-OVERALL", userId: "u" }, userMessage: "Why did sales decline in July 2025 compared with June 2025?", conversationHistory: [], deps: { plannerClient: model, analysisEnabled: true, getFreshness: async () => ({ state: "fresh", message: "", dataAsOf: null }), getDateContext: async () => DC, execute, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) } });
  const s = out.structured;
  check("chat-turn", "through the chat turn: the answer opens with the rise and the mismatch; the view's headline carries both; the query ran for this tenant only", /\*\*Overall:\*\* Sales \(invoice amount\) rose from ₹40,85,714\.10 in Jun 2025 to ₹57,16,599\.12 in Jul 2025: \+₹16,30,885\.02 \(\+39\.9%\)/.test(s.answer) && /does not show an overall decline/.test(s.answer) && s.visualization && /rose/.test(s.visualization.headline.text) && /does not show an overall decline/.test(s.visualization.headline.note) && tenants.every((t) => t === "T-OVERALL"), s.answer.slice(0, 600));
  console.log(`\nverify-overall-direction: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
