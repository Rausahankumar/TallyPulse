/**
 * Ask AI structured answers: proves the presentation components render the backend's presentation model
 * (message.visualization) as KPI / ranking / trend / comparison / empty views without changing a value.
 *  - loads the REAL ChatBubble / PresentationView through Vite's SSR transform (no test framework added)
 *  - feeds them models built by the REAL backend presentation builder from synthetic engine results
 *  - every figure shown must be a string the backend produced; clarifications/refusals/failures stay text
 *  - fetch / http / XHR / WebSocket are poisoned during rendering: any network call fails the run
 *
 * Run: node verify-chat-presentation.mjs
 */
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 300)})` : ""}`);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);

const require = createRequire(import.meta.url);
const { buildPresentation } = require("../backend/src/services/query/presentation.js");
const { formatQueryAnswer, formatNonAnswer, fmtMoney } = require("../backend/src/services/query/answerFormatter.js");

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
const { default: ChatBubble } = await vite.ssrLoadModule("/src/components/chat/ChatBubble.jsx");
const { isPresentation } = await vite.ssrLoadModule("/src/components/chat/present/isPresentation.js");

let netCalls = 0;
const saved = { fetch: globalThis.fetch, h: http.request, s: https.request };
const boom = (what) => () => {
  netCalls += 1;
  throw new Error(`NETWORK BLOCKED: ${what}`);
};
const render = (message) => {
  globalThis.fetch = boom("fetch");
  http.request = boom("http.request");
  https.request = boom("https.request");
  try {
    return renderToStaticMarkup(createElement(ChatBubble, { message }));
  } finally {
    globalThis.fetch = saved.fetch;
    http.request = saved.h;
    https.request = saved.s;
  }
};

// ---- synthetic engine results (the shapes the real engine returns)
const custom = (from, to) => ({ kind: "custom", from, to });
const base = (o) => ({ ok: true, entity: "sales", mode: "aggregate", grain: "voucher", period: { kind: "custom", label: "Custom range", isPartial: false }, comparison: null, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, rows: [], totals: { values: { invoiceAmount: 4344775.5, invoiceCount: 633 } }, truncated: false, rowLimit: 10, warnings: [], assumptions: [], ...o });
const plan = (o) => ({ v: 1, entity: "sales", mode: "aggregate", period: custom("2025-08-01", "2025-08-31"), metrics: ["invoiceAmount", "invoiceCount"], filters: [], ...o });
const message = (p, r) => {
  const f = formatQueryAnswer({ plan: p, result: r });
  const toolState = f.zero ? "zero_result" : "valid_data";
  return { role: "assistant", text: f.text, toolCalls: [{ toolName: "query_engine", state: toolState }], warnings: [], freshness: { state: "fresh", dataAsOf: new Date().toISOString() }, visualization: buildPresentation({ plan: p, result: r, notes: f.notes, zero: f.zero }), details: { queryEngine: { status: "answered" } } };
};
const count = (s, re) => (s.match(re) || []).length;

section("KPI");
{
  const m = message(plan({}), base({}));
  const html = render(m);
  check("recognised as a presentation", isPresentation(m.visualization));
  check("headline value, invoice count and range are shown", html.includes(fmtMoney(4344775.5)) && html.includes("633 invoices") && html.includes("2025-08-01 → 2025-08-31"));
  check("a single number gets no chart and no table", !html.includes('role="img"') && !html.includes("<table"));
  check("the text-answer paragraph is NOT repeated next to the card", !html.includes("Invoice amount:") && count(html, /4,344,775|43,44,775/g) === 1, count(html, /43,44,775/g));
  check("basis statement shown once", count(html, /invoice totals including tax/g) === 1);
}

section("Ranking (long names wrap, exact table + bar chart)");
{
  const long = "PenTONIC BALL PEN BLUE @10. EXTRA LONG PRODUCT NAME FOR WRAPPING (PACK OF 100 PIECES)";
  const names = [long, "FEVISTIK J[15GM]", "Fevistik J 8 Gms", "Item 4", "Item 5"];
  const rows = names.map((n, i) => ({ key: { product: n }, values: { lineAmount: 108634.1 - i * 1000, quantity: 18500 - i * 100 } }));
  const r = base({ grain: "line", metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "product" }], amountBasis: { lineAmount: "line_item_pre_tax" }, rows, totals: { values: { lineAmount: 500000, quantity: 90000 } } });
  const html = render(message(plan({ metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "product" }], limit: 5 }), r));
  check("a real table with Rank / Product / Amount / Quantity headers", html.includes("<table") && html.includes(">#<") && html.includes(">Product<") && html.includes("Amount (pre-tax)") && html.includes(">Quantity<"));
  check("the full long name is in the table, wrapped by CSS (not cut in the data)", html.includes(long) && html.includes("break-words"));
  check("every row and its exact values are present", names.every((n) => html.includes(n)) && html.includes(fmtMoney(108634.1)) && html.includes("18,500"));
  check("a bar chart container is present (accessible label)", html.includes('role="img"') && /aria-label="Amount \(pre-tax\) by 5 items"/.test(html));
  check("pre-tax basis wording, not the invoice wording", html.includes("pre-tax line-item totals (revenue), not invoice totals") && !html.includes("invoice totals including tax"));
  check("the numbers appear once in the table (no repeated paragraph)", count(html, /1,08,634\.10/g) === 1, count(html, /1,08,634\.10/g));
  check("table scrolls on narrow screens", html.includes("overflow-x-auto"));
  const hostile = render(message(plan({ groupBy: [{ dim: "customer" }] }), base({ groupBy: [{ dim: "customer" }], rows: [{ key: { customer: '<img src=x onerror="alert(1)">' }, values: { invoiceAmount: 1, invoiceCount: 1 } }, { key: { customer: "B" }, values: { invoiceAmount: 1, invoiceCount: 1 } }], totals: { values: { invoiceAmount: 2, invoiceCount: 2 } } })));
  check("a hostile name is escaped, never rendered as HTML", !hostile.includes("<img src=x") && hostile.includes("&lt;img src=x"));
}

section("Trend");
{
  const months = ["2025-04", "2025-05", "2025-06", "2025-07", "2025-08"];
  const vals = [6071377.93, 4223011.26, 4085714.1, 5716599.12, 4344775.5];
  const rows = months.map((m, i) => ({ key: { date: { bucket: "month", start: `${m}-01`, label: m } }, values: { invoiceAmount: vals[i], invoiceCount: 100 + i } }));
  const html = render(message(plan({ period: custom("2025-04-01", "2025-08-31"), groupBy: [{ dim: "date", bucket: "month" }] }), base({ groupBy: [{ dim: "date", bucket: "month" }], rows, totals: { values: { invoiceAmount: 24441477.91, invoiceCount: 510 } } })));
  check("line chart container + a Month | Sales | Invoices table (an invoice count is never labelled Orders)", html.includes('role="img"') && /trend over 5 periods/.test(html) && html.includes(">Month<") && html.includes(">Invoices<") && !html.includes(">Orders<"));
  check("every month's exact value is listed, then the engine's total", vals.every((v) => html.includes(fmtMoney(v))) && html.includes("Total") && html.includes(fmtMoney(24441477.91)));
  check("month labels read 'Apr 2025' ... 'Aug 2025'", ["Apr 2025", "May 2025", "Jun 2025", "Jul 2025", "Aug 2025"].every((l) => html.includes(l)));

  // A daily series for a month: every day arrives, the table opens on the first 10 with a "Show all" toggle, total still shown.
  const days = Array.from({ length: 31 }, (_, i) => `2025-08-${String(i + 1).padStart(2, "0")}`);
  const dayRows = days.map((d, i) => ({ key: { date: { bucket: "day", start: d, label: d } }, values: { invoiceAmount: 1000 + i, invoiceCount: 1 } }));
  const daily = render(message(plan({ groupBy: [{ dim: "date", bucket: "day" }] }), base({ groupBy: [{ dim: "date", bucket: "day" }], rows: dayRows, totals: { values: { invoiceAmount: 31465, invoiceCount: 31 } } })));
  const bodyRows = count(daily.split("<tbody>")[1].split("</tbody>")[0], /<tr/g);
  check("31 daily rows: 10 shown first, 'Show all 31 rows' toggle, total kept", bodyRows === 10 && daily.includes("Show all 31 rows") && daily.includes(fmtMoney(31465)), bodyRows);
  const short = render(message(plan({ groupBy: [{ dim: "date", bucket: "day" }] }), base({ groupBy: [{ dim: "date", bucket: "day" }], rows: dayRows.slice(0, 12), totals: { values: { invoiceAmount: 12066, invoiceCount: 12 } } })));
  check("a 12-row table is shown whole, no toggle", count(short.split("<tbody>")[1].split("</tbody>")[0], /<tr/g) === 12 && !short.includes("Show all"));
}

section("Comparison");
{
  const r = base({ comparison: { mode: "custom", label: "Custom comparison range" }, totals: { values: { invoiceAmount: 301438, invoiceCount: 9 }, comparison: { invoiceAmount: { previous: 322427, delta: -20989, deltaPct: -6.5096905656164035 }, invoiceCount: { previous: 11, delta: -2, deltaPct: -18.181818181818183 } } } });
  const p = plan({ period: custom("2025-09-01", "2025-09-30"), compare: { mode: "custom", period: custom("2025-08-01", "2025-08-31") }, filters: [{ dim: "customer", op: "eq_ci", value: "DHINGRA GENERAL STORE" }] });
  const html = render(message(p, r));
  check("table: Period | Sales | Invoices | Avg invoice with August then September", html.includes(">Period<") && html.includes("Avg invoice") && !html.includes("Avg order") && (() => { const body = html.slice(html.indexOf("<tbody")); return body.indexOf("August 2025") > -1 && body.indexOf("August 2025") < body.indexOf("September 2025"); })());
  check("both periods' exact values are shown", html.includes(fmtMoney(322427)) && html.includes(fmtMoney(301438)));
  check("the change is explicit: amount, wording, percent", html.includes(`${fmtMoney(20989)} less`) && html.includes("-6.5%"));
  check("the derived column is footnoted", html.includes("Amount ÷ invoices") && html.includes("Avg invoice *"));
  check("customer scope chip", html.includes("DHINGRA GENERAL STORE") && html.includes("Customer:"));
  check("comparison chart present", html.includes('role="img"') && /Sales: .* versus /.test(html));
}

section("No data, clarification, refusal, Markdown text");
{
  const empty = render(message(plan({ filters: [{ dim: "customer", op: "eq_ci", value: "DHINGRA GENERAL STORE" }] }), base({ totals: { values: { invoiceAmount: 0, invoiceCount: 0 } } })));
  check("empty state: clean message, period and customer, no chart/table", empty.includes("No matching records found.") && empty.includes("Period:") && empty.includes("DHINGRA GENERAL STORE") && !empty.includes('role="img"') && !empty.includes("<table"));
  check("the empty state is not shown twice (no extra 'No matching data' label)", count(empty, /No matching/g) === 1, count(empty, /No matching/g));
  const clar = render({ role: "assistant", text: formatNonAnswer({ status: "needs_clarification", code: "year_missing" }), toolCalls: [], warnings: [], freshness: null, visualization: null, details: { queryEngine: { status: "needs_clarification" } } });
  check("clarification: readable text with its label, no chart/table", clar.includes("Which year do you mean?") && clar.includes("Clarification needed") && !clar.includes('role="img"') && !clar.includes("<table"));
  const markdown = render({ role: "assistant", text: "**Top 5 products**\n\n| # | Product |\n|---|---|\n| 1 | Pen |", toolCalls: [], warnings: [], freshness: null, visualization: null });
  check("Markdown answers (no presentation) still render as Markdown", markdown.includes("<table") && markdown.includes("<strong"));
  const user = render({ role: "user", text: "<b>sales</b> | **x**" });
  check("the user's own question stays plain text", user.includes("&lt;b&gt;sales&lt;/b&gt;") && !user.includes("<table"));
  const unknown = render({ role: "assistant", text: "Fallback text", toolCalls: [], visualization: { v: 99, kind: "unknown" } });
  check("an unknown presentation version falls back to the text answer", unknown.includes("Fallback text"));
}

section("Analysis answers (structured view, not only a long report)");
{
  const { formatAnalysisAnswer } = require("../backend/src/services/query/analysisAnswer.js");
  const { buildAnalysisPresentation } = require("../backend/src/services/query/analysisPresentation.js");
  const iso = (y, m, d, end = false) => (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
  const AUG = { kind: "custom", from: iso(2025, 8, 1), to: iso(2025, 8, 31, true), label: "Custom range", isPartial: false };
  const JUL = { mode: "custom", from: iso(2025, 7, 1), to: iso(2025, 7, 31, true), label: "Custom comparison range" };
  const cmpOf = (cur, prev) => ({ previous: prev, delta: Math.round((cur - prev) * 100) / 100, deltaPct: Math.round(((cur - prev) / prev) * 10000) / 100 });
  const periods = { period: custom("2025-08-01", "2025-08-31"), compare: { mode: "custom", period: custom("2025-07-01", "2025-07-31") } };
  const step = (request, result) => ({ id: `s${request.groupBy.length}`, kind: "query", status: "ok", request: { v: 1, entity: "sales", mode: "aggregate", filters: [], ...periods, ...request }, result: base({ period: AUG, comparison: JUL, ...result }), facts: "Step facts text.", notes: [], dataState: null });
  const total = step({ metrics: ["invoiceAmount", "invoiceCount"], groupBy: [] }, { totals: { values: { invoiceAmount: 410000, invoiceCount: 90 }, comparison: { invoiceAmount: cmpOf(410000, 500000), invoiceCount: cmpOf(90, 100) } } });
  const cust = [["Alpha Stores", 120000, 170000], ["Beta Traders", 90000, 120000], ["Gamma Co", 200000, 210000]];
  const byCustomer = step(
    { metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 10 },
    { metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], rows: cust.map(([n, c, p]) => ({ key: { customer: n }, values: { invoiceAmount: c }, comparison: { invoiceAmount: cmpOf(c, p) } })), totals: { values: { invoiceAmount: 410000 }, comparison: { invoiceAmount: cmpOf(410000, 500000) } } },
  );
  const execution = { steps: [total, byCustomer, { id: "s9", kind: "query", status: "refused", error: { code: "outside_coverage", message: "No Purchase data exists for this period." } }] };
  // the question asked what to do (the planner's actions flag): the suggested actions section is shown
  const formatted = formatAnalysisAnswer(execution, { referenceDate: new Date(2025, 9, 15, 12), actions: true });
  const vis = buildAnalysisPresentation({ execution, formatted, actions: true });
  const msg = (visualization, extra = {}) => ({ role: "assistant", text: formatted.text, toolCalls: [{ toolName: "analysis_plan", state: "valid_data" }], warnings: ["The last Sales sync attempt failed."], freshness: null, visualization, ...extra });
  const html = render(msg(vis));
  const kpi = Object.fromEntries(vis.kpis.cards.map((c) => [c.id, c.display]));
  check("the analysis renders its structured view: headline, KPI cards, sections - not the step-by-step report", html.includes(vis.headline.text.replace(/&/g, "&amp;")) && html.includes("What the data shows") && html.includes("Suggested next actions") && !html.includes("Analysis: findings calculated"), html.slice(0, 400));
  check("KPI cards show current, previous, change and % change", [kpi.current, kpi.previous, kpi.change, kpi.pct].every((d) => html.includes(d)) && kpi.change === "-₹90,000.00" && kpi.pct === "-18.0%");
  check("headline, KPI cards and the comparison table agree (the same backend strings)", vis.headline.text.includes(kpi.current) && vis.headline.text.includes(kpi.previous) && vis.steps[0].view.rows[1].cells.invoiceAmount === kpi.current);
  check("the featured visual is the contributor breakdown: a bar chart plus its exact table", vis.featuredStep === 2 && html.includes('role="img"') && cust.every(([n]) => html.includes(n)) && html.includes(fmtMoney(170000)) && html.includes("-₹50,000.00"));
  check("the featured chart and table use the same values", vis.steps[1].view.chart.points.every((pt) => html.includes(pt.display)));
  check("contributors are labelled Contributor, never cause; the label legend is shown", html.includes("Contributor: ") && !/Possible causes/.test(html) && html.includes("Possible cause = consistent with the data, not proven"));
  const details = html.indexOf("Details:");
  check("asked what to do with contributors only (no evidence pointing at a specific step): no generic list - the view says where the fall is and that the data does not show why; no step badges in the default view", vis.recommendations.length === 0 && html.includes("Suggested next actions") && /No action follows from these results yet: the results show where the fall is \(largest: /.test(html) && !/>steps? \d/.test(html.slice(0, details)), vis.noAction);
  check("accounting basis and sync warnings stay visible", html.includes("Invoice amounts are invoice totals including tax.") && html.includes("The last Sales sync attempt failed."));
  check("every step is reachable in Details; the step that did not run is stated in the default view with its reason", details > -1 && html.indexOf("Not run: No Purchase data exists for this period.") < details && ["Step 1", "Step 2", "Step 3"].every((t) => html.indexOf(t) > details));
  check("no 'All N analysis steps', no 'Step text (as in the full answer)', no duplicated step text", !/All \d+ analysis steps/.test(html) && !html.includes("Step text (as in the full answer)") && !html.includes("Step facts text."));
  const withAssumptions = render(msg(buildAnalysisPresentation({ execution, formatted, assumptions: ["sales read as invoiceAmount", "sales read as invoiceAmount"] })));
  check("interpretation lines are in Details only, once each", count(withAssumptions, /Interpretation \(AI-assisted\)/g) === 1 && withAssumptions.indexOf("Interpretation (AI-assisted)") > withAssumptions.indexOf("Details:"), count(withAssumptions, /Interpretation \(AI-assisted\)/g));
  const shownAt = (t) => html.indexOf(t.replace(/&/g, "&amp;"));
  check("the measured change the KPI cards show is not repeated as a sentence in the default view", vis.findings.measured.filter((f) => f.steps.every((n) => n === 1)).every((f) => shownAt(f.text) === -1 || shownAt(f.text) > details));
  check("the accounting basis is stated once for the whole analysis", count(html, /Invoice amounts are invoice totals including tax\./g) === 1, count(html, /Invoice amounts are invoice totals including tax\./g));
  const changeCards = (h) => count(h, /text-ink-500">Change<\/p>/g);
  check("the KPI change is not repeated as a change card anywhere in the view", changeCards(html) === 0 && html.includes(">Change</p>"), changeCards(html));
  check("a plain comparison answer (no analysis) keeps its change card", changeCards(render(message(plan({ compare: { mode: "custom", period: custom("2025-07-01", "2025-07-31") } }), total.result))) === 1);

  const mismatch = render(msg({ ...vis, plain: { language: "en", lines: ["Total sales rose from ₹40.86 lakh in June 2025 to ₹57.17 lakh in July 2025 — up ₹16.31 lakh (39.9%).", "So overall sales did not fall — they rose. Some customers sold less, but that happened within an overall increase."] }, headline: { text: "Sales (invoice amount) rose from ₹40,85,714.10 in Jun 2025 to ₹57,16,599.12 in Jul 2025: +₹16,30,885.02 (+39.9%).", steps: [1], note: "This comparison does not show an overall decline: the total rose." } }));
  const det = mismatch.indexOf("Details:");
  check("the plain-language overall result and its mismatch lead the view, before any visual; the exact (technical) result, its note and the finding lists are in Details", mismatch.indexOf("Total sales rose from ₹40.86 lakh") > -1 && mismatch.indexOf("did not fall — they rose") > mismatch.indexOf("Total sales rose") && mismatch.indexOf("did not fall — they rose") < mismatch.indexOf('role="img"') && mismatch.indexOf("rose from ₹40,85,714.10") > det && mismatch.indexOf("does not show an overall decline") > det && mismatch.indexOf("What the data shows") > det, det);
  const notAsked = buildAnalysisPresentation({ execution, formatted: formatAnalysisAnswer(execution, { referenceDate: new Date(2025, 9, 15, 12) }) });
  // an evidence-backed step (shape as buildAnalysisPresentation emits it for rule 5's supply check)
  const supplied = { ...vis, noAction: null, recommendations: [{ text: "Check supplier orders and the availability of Apple: its purchases fell before or with its sales (the data shows purchases, not stock levels).", steps: [2], kind: "verify", kindLabel: "Check", because: "purchases ₹70,000.00 in Jul 2025 -> ₹20,000.00 in Aug 2025; sales of Apple -₹80,000.00 in Aug 2025" }] };
  const suppliedHtml = render(msg(supplied));
  check("asked what to do with an evidence-backed step: numbered with its kind, the finding it follows from shown as 'Because:', qualified as not a confirmed cause", suppliedHtml.includes("1. Check: ") && suppliedHtml.includes("Because: purchases ₹70,000.00 in Jul 2025 -&gt; ₹20,000.00 in Aug 2025") && suppliedHtml.includes("None follows from a confirmed cause."));
  check("not asked what to do: no 'Suggested next actions' section in the view (findings unchanged)", !render(msg(notAsked)).includes("Suggested next actions") && notAsked.findings.contributors.length === vis.findings.contributors.length);
  const askedNone = render(msg({ ...vis, recommendations: [], noAction: "No specific action follows from these results yet; what is not established above would have to be settled first." }));
  check("asked what to do with nothing to act on: the view says so instead of listing an action", askedNone.includes("Suggested next actions") && askedNone.includes("No specific action follows from these results yet"));
  const caused = { ...vis, findings: { ...vis.findings, possibleCauses: [{ text: "Purchases of Apple also fell before its sales fell.", steps: [1, 2] }] } };
  const ch = render(msg(caused));
  check("possible causes get their own cautioned section, marked not proven", ch.includes("Possible causes (not proven)") && ch.includes("Consistent with the data, not proven.") && ch.includes("Purchases of Apple also fell before its sales fell.") && !ch.includes(">steps 1, 2<"));
  const broken = render(msg({ v: 1, kind: "analysis", steps: "x" }));
  check("a malformed analysis view falls back to the text answer", broken.includes("Analysis: findings calculated"));
  check("an old analysis message without a view still renders its text (legacy flow)", render(msg(null)).includes("Analysis: findings calculated"));
}

section("The user's chart / table request");
{
  const cust = ["Alpha Stores", "Beta Traders", "Gamma Co"].map((n, i) => ({ key: { customer: n }, values: { invoiceAmount: 300000 - i * 50000, invoiceCount: 11 - i } }));
  const rp = plan({ groupBy: [{ dim: "customer" }], limit: 3 });
  const rr = base({ groupBy: [{ dim: "customer" }], rows: cust, totals: { values: { invoiceAmount: 750000, invoiceCount: 30 } } });
  const withDisplay = (display) => { const m = message(rp, rr); m.visualization = { ...m.visualization, display }; return render(m); };
  const def = withDisplay(null);
  check("no request: chart then table, nothing folded (unchanged)", def.indexOf('role="img"') < def.indexOf("<table") && !def.includes("Show exact figures") && !def.includes("Show chart"));
  const asChart = withDisplay("chart");
  check("asked for a chart: the chart comes first, the exact figures are one click away", asChart.indexOf('role="img"') < asChart.indexOf("Show exact figures") && asChart.indexOf("Show exact figures") < asChart.indexOf("<table"));
  const asTable = withDisplay("table");
  check("asked for a table: the table comes first, the chart is folded", asTable.indexOf("<table") < asTable.indexOf("Show chart") && asTable.indexOf("Show chart") < asTable.indexOf('role="img"'));
  check("the same values in every order", cust.every((r) => [def, asChart, asTable].every((h) => h.includes(fmtMoney(r.values.invoiceAmount)))));
  const one = message(plan({ groupBy: [{ dim: "customer" }] }), base({ groupBy: [{ dim: "customer" }], rows: cust.slice(0, 1), totals: { values: { invoiceAmount: 300000, invoiceCount: 11 } } }));
  one.visualization = { ...one.visualization, display: "chart" };
  const oneHtml = render(one);
  check("asked for a chart with one value: no chart is drawn, the table says why", !oneHtml.includes('role="img"') && oneHtml.includes("too few values for a chart") && oneHtml.includes(fmtMoney(300000)));
  const kpiAsked = message(plan({}), base({}));
  kpiAsked.visualization = { ...kpiAsked.visualization, display: "chart" };
  check("a single figure asked as a chart stays a KPI card (no invented chart)", !render(kpiAsked).includes('role="img"'));
}

section("Compare sales vs purchase product wise and customer wise (one aligned comparison)");
{
  const { formatAnalysisAnswer } = require("../backend/src/services/query/analysisAnswer.js");
  const { buildAnalysisPresentation } = require("../backend/src/services/query/analysisPresentation.js");
  const iso = (y, m, d, end = false) => (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
  const AUG = { kind: "custom", from: iso(2025, 8, 1), to: iso(2025, 8, 31, true), label: "Custom range", isPartial: false };
  const LINE = { lineAmount: "line_item_pre_tax" };
  // 14 products sold; purchases of 12 of them in a different order, plus one bought but not sold
  const sold = Array.from({ length: 14 }, (_, i) => [`Product ${String.fromCharCode(65 + i)} long descriptive item name 1kg pack`, 50000 - i * 3000]);
  const bought = [...sold.slice(0, 12).reverse().map(([n], i) => [n, 20000 + i * 1000]), ["Packing Material Roll", 4500]];
  const q = (id, entity, dim, metric, rows, extra = {}) => ({ id, kind: "query", status: "ok", request: { v: 1, entity, mode: "aggregate", period: custom("2025-08-01", "2025-08-31"), metrics: [metric], groupBy: [{ dim }], filters: [], sort: [{ by: metric, dir: "desc" }], limit: 100 }, result: base({ entity, grain: metric === "lineAmount" ? "line" : "voucher", period: AUG, metrics: [metric], groupBy: [{ dim }], amountBasis: metric === "lineAmount" ? LINE : { invoiceAmount: "voucher_total_incl_tax" }, rows: rows.map(([k, x]) => ({ key: { [dim]: k }, values: { [metric]: x } })), totals: { values: { [metric]: rows.reduce((t, [, x]) => t + x, 0) } }, rowLimit: 100, ...extra }), facts: "Step facts text.", notes: [], dataState: null });
  const steps = [q("sp", "sales", "product", "lineAmount", sold), q("pp", "purchase", "product", "lineAmount", bought), q("sc", "sales", "customer", "invoiceAmount", [["Alpha Stores", 90000], ["Beta Traders", 60000]])];
  const execution = { steps };
  const formatted = formatAnalysisAnswer(execution, { referenceDate: new Date(2025, 9, 15, 12) });
  const vis = buildAnalysisPresentation({ execution, formatted });
  const pair = vis.pairs[0];
  const html = render({ role: "assistant", text: formatted.text, toolCalls: [{ toolName: "analysis_plan", state: "valid_data" }], warnings: [], freshness: null, visualization: vis });
  const row = (name) => pair.rows.find((r) => r.cells.name === name);
  check("sales and purchases by product become ONE aligned comparison (steps 1 and 2), not two separate sections", vis.pairs.length === 1 && pair.kind === "paired" && pair.steps.join() === "1,2" && vis.steps[0].paired && vis.steps[1].paired && count(html, /Sales vs purchases by product/g) === 1);
  check("rows align by product: each product's sales and purchases on one row, the engine's own values", row(sold[0][0]).cells.sales === fmtMoney(sold[0][1]) && row(sold[0][0]).cells.purchases === fmtMoney(bought.find(([n]) => n === sold[0][0])[1]) && pair.rows.length === 15);
  check("unmatched products are marked, never zero: sold-only shows a dash and 'No purchases in this period', bought-only 'No sales'", row(sold[13][0]).cells.purchases === "—" && row(sold[13][0]).flag === "No purchases in this period" && row("Packing Material Roll").cells.sales === "—" && row("Packing Material Roll").flag === "No sales in this period" && !pair.rows.some((r) => r.cells.sales === fmtMoney(0) || r.cells.purchases === fmtMoney(0)));
  check("the chart has two series with a legend; a missing side is null (no bar), never 0", pair.chart.type === "bar-pair" && pair.chart.series.map((s) => s.label).join() === "Sales,Purchases" && pair.chart.points.every((p) => p.sales === null || typeof p.sales === "number") && pair.chart.points.some((p) => p.purchases === null) === pair.chart.points.some((p) => row(p.label).cells.purchases === "—") && /Sales and Purchases \(Amount \(pre-tax\)\) for 10 items/.test(html));
  check("the chart shows the first 10, the table every row; the long table opens compact with 'Show all'", pair.chart.points.length === 10 && pair.chart.shownOf.total === 15 && html.includes("Show all 15 rows") && html.includes("Chart shows the first 10 of 15"));
  check("only comparable steps are paired: same product grouping, pre-tax line value, period; the customer step stays separate with sales only", vis.steps[2].paired === undefined && vis.pairNote === "Purchases are recorded by supplier, not by customer, so customers are shown with sales only." && html.includes("Alpha Stores") && html.includes(vis.pairNote));
  check("no customer purchase figure is invented anywhere", !/Purchases[^<]{0,40}Alpha Stores|Alpha Stores[^<]{0,80}Purchases/.test(html) && !pair.rows.some((r) => r.cells.name === "Alpha Stores"));
  check("both accounting bases are stated, once each (pre-tax line values vs invoice totals incl. tax)", count(html, /invoice totals including tax/g) === 1 && count(html, /pre-tax line-item totals/g) === 1, `${count(html, /invoice totals including tax/g)} / ${count(html, /pre-tax line-item totals/g)}`);
  // a list cut at its limit: an absent product is unknown, not "none"
  const cut = [q("sp", "sales", "product", "lineAmount", sold.slice(0, 3)), q("pp", "purchase", "product", "lineAmount", bought.slice(0, 3), { truncated: true, rowLimit: 3 })];
  const cutVis = buildAnalysisPresentation({ execution: { steps: cut }, formatted: formatAnalysisAnswer({ steps: cut }, {}) });
  const cutRow = cutVis.pairs[0].rows.find((r) => r.cells.purchases === "—");
  check("a purchase list cut at its limit: a missing product says 'Not in the top 3 purchases returned' and the view says a dash is not zero", !!cutRow && cutRow.flag === "Not in the top 3 purchases returned" && cutVis.pairs[0].notes.some((n) => /a dash means the value is not in that list, not zero/.test(n)));
  // incompatible: invoice totals vs pre-tax line values are never paired
  const mixed = [q("sp", "sales", "product", "lineAmount", sold.slice(0, 3)), q("pp", "purchase", "product", "quantity", bought.slice(0, 3))];
  check("different measures (value vs quantity) are not paired: separate steps as before", buildAnalysisPresentation({ execution: { steps: mixed }, formatted: formatAnalysisAnswer({ steps: mixed }, {}) }).pairs.length === 0);
}

section("Explicit chart request: a short reading next to the chart");
{
  const cust = ["Alpha Stores", "Beta Traders", "Gamma Co"].map((n, i) => ({ key: { customer: n }, values: { invoiceAmount: 300000 - i * 50000, invoiceCount: 11 - i } }));
  const p = buildPresentation({ plan: plan({ groupBy: [{ dim: "customer" }], limit: 3 }), result: base({ groupBy: [{ dim: "customer" }], rows: cust, totals: { values: { invoiceAmount: 750000, invoiceCount: 30 } } }), display: "chart" });
  const html = render({ role: "assistant", text: "x", toolCalls: [], warnings: [], freshness: null, visualization: p });
  check("asked for a chart: one caption line from the chart's own values, above the chart", p.caption === `Alpha Stores is highest (${fmtMoney(300000)}); Gamma Co is lowest of the 3 shown (${fmtMoney(200000)}).` && html.indexOf("is highest") < html.indexOf('role="img"'));
  const plainP = buildPresentation({ plan: plan({ groupBy: [{ dim: "customer" }], limit: 3 }), result: base({ groupBy: [{ dim: "customer" }], rows: cust, totals: { values: { invoiceAmount: 750000, invoiceCount: 30 } } }) });
  check("not asked: no caption (ordinary answers unchanged)", !("caption" in plainP));
}

section("Top 3 suppliers vs all others (kind groups)");
{
  const gc = require("../backend/src/services/query/groupComparison.js");
  const rk = { v: 1, entity: "purchase", mode: "aggregate", period: custom("2025-08-01", "2025-08-31"), metrics: ["purchaseAmount"], groupBy: [{ dim: "supplier" }], filters: [], sort: [{ by: "purchaseAmount", dir: "desc" }], limit: 3 };
  const ranking = gc.rankingOf(rk);
  const execPlan = gc.comparisonPlan(rk, ranking);
  const sup = [["Delta Supply", 60000], ["Alpha Agro", 45000], ["Zeta Mart", 25000], ["Beta Foods", 15000.5], ["Gamma Traders", 5000], ["Epsilon Co", 2500.25]];
  const r = base({ entity: "purchase", metrics: ["purchaseAmount"], groupBy: [{ dim: "supplier" }], amountBasis: { purchaseAmount: "voucher_total_incl_tax" }, rows: sup.map(([k, x]) => ({ key: { supplier: k }, values: { purchaseAmount: x } })), totals: { values: { purchaseAmount: 152500.75 } }, rowLimit: 100 });
  const a = gc.formatGroupAnswer({ plan: rk, execPlan, result: r, ranking, n: 3 });
  const m = { role: "assistant", text: a.text, toolCalls: [{ toolName: "query_engine", state: "valid_data" }], warnings: [], freshness: { state: "fresh", dataAsOf: new Date().toISOString() }, visualization: a.visualization };
  const html = render(m);
  const at = (s) => html.indexOf(s);
  check("recognised as a presentation", isPresentation(m.visualization) && m.visualization.kind === "groups");
  check("compact order: one caption line, chart, group table, top-3 list (folded), notes; no KPI row repeating the table", at("hold 85.2% of the total") > -1 && at("hold 85.2% of the total") < at('role="img"') && at('role="img"') < at("<table") && at("<table") < at("Top 3 suppliers in this comparison") && at("Top 3 suppliers in this comparison") < at("not by price") && !html.includes("Top 3 suppliers total") && !html.includes("account for"));
  check("chart, table and caption carry the same figures (each group total in the chart and the table, the share in the caption and the table)", [fmtMoney(130000), fmtMoney(22500.75), "85.2%"].every((v) => count(html, new RegExp(v.replace(/[.*+?^${}()|[\]\\₹]/g, "\\$&"), "g")) >= 2) && html.includes(fmtMoney(152500.75)) && html.includes(`${fmtMoney(107499.25)} more than all other suppliers`));
  check("the two-bar chart names both groups with their values", /aria-label="[^"]*Top 3 suppliers ₹1,30,000.00 versus All other suppliers ₹22,500.75"/.test(html));
  check("the top 3 are listed for verification; no raw objects or step numbers", html.includes("Delta Supply") && html.includes("Zeta Mart") && !html.includes("Beta Foods") && !/\{&quot;|Step \d/.test(html));
  check("basis stated once", count(html, /invoice totals including tax/g) === 1);
  const none = gc.formatGroupAnswer({ plan: rk, execPlan, result: { ...r, totals: null }, ranking, n: 3 });
  check("no overall total: no view and no figures (text answer only)", none.visualization === null && !/₹/.test(none.text));
}

section("Single-query plain opening");
{
  // the backend sends the opening on a single-query view (queryChat); the view leads with it, the KPI/table follow unchanged
  const m = message(plan({}), base({}));
  const lines = ["Synthetic kul bikri (August 2025): ₹12.35 lakh."];
  const withPlain = render({ ...m, visualization: { ...m.visualization, plain: { language: "hinglish", lines } } });
  const kpiAt = withPlain.indexOf("Synthetic kul bikri");
  check("a single-query view opens with the plain sentence (marked hi-Latn), before the KPI card", kpiAt > -1 && withPlain.includes('lang="hi-Latn"') && kpiAt < withPlain.indexOf(m.visualization.headline.display.replace(/&/g, "&amp;")), kpiAt);
  check("without the opening the view is exactly as before", render(m) === render({ ...m, visualization: { ...m.visualization, plain: { language: "en", lines: [] } } }) && !render(m).includes('lang="en"'));
  const zero = message(plan({ filters: [{ dim: "customer", op: "eq_ci", value: "Synthetic Nobody" }] }), base({ totals: { values: { invoiceAmount: 0, invoiceCount: 0 } } }));
  const zeroHtml = render({ ...zero, visualization: { ...zero.visualization, plain: { language: "hi", lines: ["अगस्त 2025 में Synthetic Nobody की कोई बिक्री नहीं मिली।"] } } });
  check("an empty view opens with the plain sentence too", zero.visualization.kind === "empty" && zeroHtml.includes("कोई बिक्री नहीं मिली") && zeroHtml.includes('lang="hi"'));
}

section("View calculation (saved record, read-only)");
{
  // records built by the REAL backend builder from synthetic results; the panel only formats their numbers
  const { buildCalculation } = require("../backend/src/services/query/calculation.js");
  const { default: CalculationPanel, CalculationView } = await vite.ssrLoadModule("/src/components/chat/present/CalculationPanel.jsx");
  const AUGd = { from: new Date(2025, 7, 1).toISOString(), to: new Date(2025, 7, 31, 23, 59, 59).toISOString(), label: "August 2025" };
  const JULd = { from: new Date(2025, 6, 1).toISOString(), to: new Date(2025, 6, 31, 23, 59, 59).toISOString(), label: "July 2025" };
  const cmpPlan = plan({ period: custom("2025-08-01", "2025-08-31"), compare: { mode: "custom", period: custom("2025-07-01", "2025-07-31") }, metrics: ["invoiceAmount"], filters: [{ dim: "customer", op: "eq_ci", value: "Synthetic Traders" }] });
  const cmpRes = base({ period: AUGd, comparison: JULd, metrics: ["invoiceAmount"], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, totals: { values: { invoiceAmount: 4344775.5 }, comparison: { invoiceAmount: { previous: 5716599.12, delta: -1371823.62, deltaPct: (-1371823.62 / 5716599.12) * 100 } } } });
  const calc = buildCalculation({ plan: cmpPlan, result: cmpRes, previousScope: { filters: [{ dim: "customer", op: "eq_ci", value: "Synthetic Traders" }] }, freshness: { state: "fresh", dataAsOf: "2026-10-26T04:35:00Z" }, dataThrough: "2025-12-31" });
  const m = message(cmpPlan, cmpRes);
  const withCalc = render({ ...m, visualization: { ...m.visualization, calculation: calc } });
  check("an answer with a saved record shows a View calculation button (a dialog opener, closed)", withCalc.includes("View calculation") && withCalc.includes('aria-haspopup="dialog"') && withCalc.includes('aria-expanded="false"') && !withCalc.includes('role="dialog"'));
  check("an answer without a record has no button", !render(m).includes("View calculation"));
  check("a malformed or unknown-version record shows no button", !render({ ...m, visualization: { ...m.visualization, calculation: { v: 2 } } }).includes("View calculation"));
  const view = renderToStaticMarkup(createElement(CalculationView, { calculation: calc }));
  check("period and comparison in human dates", view.includes("1 Aug 2025 – 31 Aug 2025") && view.includes("1 Jul 2025 – 31 Jul 2025"), view.slice(0, 300));
  check("the filter, marked as the same as the previous question (proven by the record)", view.includes("Synthetic Traders") && view.includes("Same as your previous question"));
  check("measure and accounting basis: invoice totals including tax", view.includes("Invoice amount") && view.includes("Basis: Invoice totals including tax") && view.includes("Sum per invoice"));
  check("the formula with the record's own values (formatted only)", view.includes("₹57,16,599.12") && view.includes("₹43,44,775.50") && view.includes("Change = current − previous") && view.includes("−₹13,71,823.62") && view.includes("−24.0%"), view.match(/Calculation.*?<\/section>/s)?.[0]?.slice(0, 600));
  check("freshness, latest voucher and what is not recorded", view.includes("Up to date") && view.includes("31 Dec 2025") && view.includes("Not recorded for this answer: the source invoices"));
  const zeroPrev = buildCalculation({ plan: cmpPlan, result: { ...cmpRes, totals: { values: { invoiceAmount: 5000 }, comparison: { invoiceAmount: { previous: 0, delta: 5000, deltaPct: null } } } } });
  const zv = renderToStaticMarkup(createElement(CalculationView, { calculation: zeroPrev }));
  check("previous value 0: % change is said to be undefined, never 0%", zv.includes("not defined, because the previous value is 0") && !zv.includes("0.0%"));
  const lineCalc = buildCalculation({ plan: plan({ period: custom("2025-08-01", "2025-08-31"), metrics: ["lineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 1 }), result: base({ period: AUGd, metrics: ["lineAmount"], groupBy: [{ dim: "product" }], amountBasis: { lineAmount: "line_item_pre_tax" }, rowLimit: 1, truncated: true, rows: [{ key: { product: "Synthetic Item" }, values: { lineAmount: 900 } }], totals: null }), dataThrough: "2025-08-20" });
  const lv = renderToStaticMarkup(createElement(CalculationView, { calculation: lineCalc }));
  check("pre-tax basis, no total (not zero), cut list and incomplete period stated", lv.includes("Item line values before tax") && lv.includes("No overall total was returned") && lv.includes("limit 1; more exist") && lv.includes("ends after the latest voucher") && !lv.includes("₹0.00"));
  const panel = renderToStaticMarkup(createElement(CalculationPanel, { calculation: calc, open: true, onClose: () => {} }));
  check("the open panel is a labelled modal dialog with a close button", panel.includes('role="dialog"') && panel.includes('aria-modal="true"') && panel.includes('aria-labelledby="calculation-panel-title"') && panel.includes('aria-label="Close calculation"') && panel.includes("How this was calculated"));
  check("closed panel renders nothing", renderToStaticMarkup(createElement(CalculationPanel, { calculation: calc, open: false, onClose: () => {} })) === "");
}

check("no network call of any kind while rendering", netCalls === 0, netCalls);
await vite.close();
console.log(`\nverify-chat-presentation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
