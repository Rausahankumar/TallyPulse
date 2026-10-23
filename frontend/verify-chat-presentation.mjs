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
  check("line chart container + a Month | Sales | Orders table", html.includes('role="img"') && /trend over 5 periods/.test(html) && html.includes(">Month<") && html.includes(">Orders<"));
  check("every month's exact value is listed, then the engine's total", vals.every((v) => html.includes(fmtMoney(v))) && html.includes("Total") && html.includes(fmtMoney(24441477.91)));
  check("month labels read 'Apr 2025' ... 'Aug 2025'", ["Apr 2025", "May 2025", "Jun 2025", "Jul 2025", "Aug 2025"].every((l) => html.includes(l)));
}

section("Comparison");
{
  const r = base({ comparison: { mode: "custom", label: "Custom comparison range" }, totals: { values: { invoiceAmount: 301438, invoiceCount: 9 }, comparison: { invoiceAmount: { previous: 322427, delta: -20989, deltaPct: -6.5096905656164035 }, invoiceCount: { previous: 11, delta: -2, deltaPct: -18.181818181818183 } } } });
  const p = plan({ period: custom("2025-09-01", "2025-09-30"), compare: { mode: "custom", period: custom("2025-08-01", "2025-08-31") }, filters: [{ dim: "customer", op: "eq_ci", value: "DHINGRA GENERAL STORE" }] });
  const html = render(message(p, r));
  check("table: Period | Sales | Orders | Avg order with August then September", html.includes(">Period<") && html.includes("Avg order") && (() => { const body = html.slice(html.indexOf("<tbody")); return body.indexOf("August 2025") > -1 && body.indexOf("August 2025") < body.indexOf("September 2025"); })());
  check("both periods' exact values are shown", html.includes(fmtMoney(322427)) && html.includes(fmtMoney(301438)));
  check("the change is explicit: amount, wording, percent", html.includes(`${fmtMoney(20989)} less`) && html.includes("-6.5%"));
  check("the derived column is footnoted", html.includes("Amount ÷ orders") && html.includes("Avg order *"));
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

check("no network call of any kind while rendering", netCalls === 0, netCalls);
await vite.close();
console.log(`\nverify-chat-presentation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
