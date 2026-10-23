"use strict";

/**
 * Presentation model (services/query/presentation.js): a deterministic description of how an ENGINE RESULT is
 * shown (KPI / ranking / trend / comparison / table / empty). Proves that:
 *  - every figure in the model is a value the engine returned, formatted exactly like the text answer
 *  - nothing is computed except the marked, derived "Avg order" (amount / orders of two returned values)
 *  - the text answer is byte-for-byte what formatQueryAnswer produces (presentation never changes it)
 *  - clarifications / refusals carry no presentation; a failure inside the builder returns null
 * Synthetic fixtures only: no database, no Claude, no network.
 *
 * Run: node verify-presentation.js
 */

const http = require("http");
const https = require("https");
let netCalls = 0;
global.fetch = () => { netCalls += 1; throw new Error("network blocked in test"); };
http.request = () => { netCalls += 1; throw new Error("network blocked in test"); };
https.request = () => { netCalls += 1; throw new Error("network blocked in test"); };

const { buildPresentation, PRESENTATION_VERSION } = require("./src/services/query/presentation");
const { formatQueryAnswer, fmtMoney, fmtNumber } = require("./src/services/query/answerFormatter");
const { tryAnswerWithQueryEngine: realTryAnswer } = require("./src/services/query/queryChat");
const { PLANNER_TOOL_NAME } = require("./src/services/query/planner");
const { createEntityResolver } = require("./src/services/query/entityResolver");
const { buildDateContext } = require("./src/services/analytics/referenceDate");

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 300)})` : ""}`);
    return;
  }
  console.log(`  PASS - ${label}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);

const custom = (from, to) => ({ kind: "custom", from, to });
const PERIOD = (label = "Custom range") => ({ kind: "custom", from: "2025-07-31T18:30:00.000Z", to: "2025-08-31T18:29:59.999Z", label, isPartial: false });
const base = (o) => ({ ok: true, entity: "sales", mode: "aggregate", grain: "voucher", period: PERIOD(), comparison: null, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, rows: [], totals: { values: { invoiceAmount: 4344775.5, invoiceCount: 633 } }, truncated: false, rowLimit: 10, warnings: [], assumptions: [], ...o });
const plan = (o) => ({ v: 1, entity: "sales", mode: "aggregate", period: custom("2025-08-01", "2025-08-31"), metrics: ["invoiceAmount", "invoiceCount"], filters: [], ...o });
const P = (p, r, extra = {}) => {
  const f = formatQueryAnswer({ plan: p, result: r });
  return { f, pres: buildPresentation({ plan: p, result: r, notes: f.notes, zero: f.zero, ...extra }) };
};

(async () => {
  section("KPI (single value)");
  {
    const { pres } = P(plan({}), base({}));
    check("kind kpi, versioned", pres.kind === "kpi" && pres.v === PRESENTATION_VERSION);
    check("headline is the engine's amount, formatted exactly like the text answer", pres.headline.display === fmtMoney(4344775.5) && pres.headline.label === "Sales");
    check("the invoice count rides along as a secondary value (no chart, no table)", pres.secondary.length === 1 && pres.secondary[0].display === "633" && pres.secondary[0].unit === "invoices" && !pres.chart && !pres.rows);
    check("period label and explicit range", pres.period.label === "August 2025" && pres.period.range === "2025-08-01 → 2025-08-31");
    check("the basis is stated once, as its own field", pres.basis.length === 1 && /invoice totals including tax/.test(pres.basis[0]));
    const fy = P(plan({ period: { kind: "specific_fy", fy: "2025-26" } }), base({ period: { kind: "specific_fy", label: "FY 2025-26", isPartial: false }, totals: { values: { invoiceAmount: 41448889.4, invoiceCount: 5339 } } }));
    check("FY period: label and range (FY semantics untouched)", fy.pres.period.label === "FY 2025-26" && fy.pres.period.range === "2025-04-01 → 2026-03-31");
  }

  section("Comparison (total vs total, and one customer)");
  {
    const r = base({
      period: PERIOD("Custom range"),
      comparison: { mode: "custom", from: "2025-07-31T18:30:00.000Z", to: "2025-08-31T18:29:59.999Z", label: "Custom comparison range" },
      totals: { values: { invoiceAmount: 301438, invoiceCount: 9 }, comparison: { invoiceAmount: { previous: 322427, delta: -20989, deltaPct: -6.5096905656164035 }, invoiceCount: { previous: 11, delta: -2, deltaPct: -18.181818181818183 } } },
    });
    const p = plan({ period: custom("2025-09-01", "2025-09-30"), compare: { mode: "custom", period: custom("2025-08-01", "2025-08-31") }, filters: [{ dim: "customer", op: "eq_ci", value: "DHINGRA GENERAL STORE" }] });
    const { pres, f } = P(p, r);
    check("kind comparison with the two periods named, previous first", pres.kind === "comparison" && pres.rows[0].cells.period === "August 2025" && pres.rows[1].cells.period === "September 2025" && pres.rows[1].current === true);
    check("both rows carry the engine's values", pres.rows[0].cells.invoiceAmount === fmtMoney(322427) && pres.rows[1].cells.invoiceAmount === fmtMoney(301438) && pres.rows[0].cells.invoiceCount === "11" && pres.rows[1].cells.invoiceCount === "9");
    const avgCol = pres.columns.find((c) => c.key === "avg");
    check("Avg order is the one derived column: marked derived, amount / orders of the same row", avgCol && avgCol.derived === true && pres.rows[0].cells.avg === fmtMoney(322427 / 11) && pres.rows[1].cells.avg === fmtMoney(301438 / 9));
    const c = pres.changes.find((x) => x.metric === "invoiceAmount");
    check("change: engine delta and engine % (never recomputed), wording and direction", c.display === `${fmtMoney(20989)} less` && c.pct === "-6.5%" && c.direction === "down" && c.signed === `-${fmtMoney(20989)}`);
    check("the order-count change is also the engine's", pres.changes.find((x) => x.metric === "invoiceCount").pct === "-18.2%");
    check("comparison bar chart plots previous vs current", pres.chart.type === "bar" && pres.chart.points[0].value === 322427 && pres.chart.points[1].value === 301438);
    check("scope chip names the customer", pres.scope[0].label === "Customer" && pres.scope[0].value === "DHINGRA GENERAL STORE");
    check("the text answer still states the same figures", f.text.includes(fmtMoney(301438)) && f.text.includes("-6.5%"));
    const zeroPrev = base({ comparison: { mode: "custom", label: "x" }, totals: { values: { invoiceAmount: 5, invoiceCount: 1 }, comparison: { invoiceAmount: { previous: 0, delta: 5, deltaPct: null }, invoiceCount: { previous: 0, delta: 1, deltaPct: null } } } });
    const zp = P(p, zeroPrev).pres;
    check("a % against a zero comparison is the engine's own 'n/a' wording, never 0% or infinity", /n\/a/.test(zp.changes[0].pct) && zp.rows[0].cells.avg === "—");
  }

  section("Ranking (products: line amounts; customers: invoice amounts)");
  {
    const long = "PenTONIC BALL PEN BLUE @10. EXTRA LONG PRODUCT NAME FOR WRAPPING (PACK OF 100 PIECES)";
    const rows = [long, "FEVISTIK J[15GM]", "Fevistik J 8 Gms", "Item 4", "Item 5"].map((n, i) => ({ key: { product: n }, values: { lineAmount: 108634.1 - i * 1000, quantity: 18500 - i * 100 } }));
    const r = base({ grain: "line", metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "product" }], amountBasis: { lineAmount: "line_item_pre_tax" }, rows, totals: { values: { lineAmount: 500000, quantity: 90000 } } });
    const { pres } = P(plan({ metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "product" }], limit: 5 }), r);
    check("kind ranking with a horizontal bar chart of the actual values", pres.kind === "ranking" && pres.chart.type === "bar-h" && pres.chart.points.length === 5 && pres.chart.points[0].value === 108634.1);
    check("table keeps rank, FULL name (not truncated), amount and quantity", pres.rows[0].cells.rank === "1" && pres.rows[0].cells.name === long && pres.rows[0].cells.lineAmount === fmtMoney(108634.1) && pres.rows[0].cells.quantity === fmtNumber(18500));
    check("column labels: pre-tax amount and quantity", pres.columns.map((c) => c.label).join("|") === "#|Product|Amount (pre-tax)|Quantity");
    check("line-amount basis wording is the pre-tax revenue statement, never the invoice one", pres.basis.length === 1 && /pre-tax line-item totals \(revenue\), not invoice totals/.test(pres.basis[0]));
    check("totals row is the engine's total", pres.totals.cells.lineAmount === fmtMoney(500000));

    const cust = ["Alpha Stores", "Beta Traders", "Gamma Co"].map((n, i) => ({ key: { customer: n }, values: { invoiceAmount: 300000 - i * 50000, invoiceCount: 11 - i } }));
    const cp = P(plan({ groupBy: [{ dim: "customer" }], limit: 3 }), base({ groupBy: [{ dim: "customer" }], rows: cust, totals: { values: { invoiceAmount: 750000, invoiceCount: 30 } } })).pres;
    check("customer ranking: Rank | Customer | Sales | Orders", cp.columns.map((c) => c.label).join("|") === "#|Customer|Sales|Orders" && cp.rows[2].cells.name === "Gamma Co");
    const one = P(plan({ groupBy: [{ dim: "customer" }] }), base({ groupBy: [{ dim: "customer" }], rows: cust.slice(0, 1), totals: { values: { invoiceAmount: 300000, invoiceCount: 11 } } })).pres;
    check("a single row gets the table but no chart", one.kind === "ranking" && one.chart === null && one.rows.length === 1);
    const many = Array.from({ length: 30 }, (_, i) => ({ key: { customer: `C${i + 1}` }, values: { invoiceAmount: 1000 - i, invoiceCount: 1 } }));
    const mp = P(plan({ groupBy: [{ dim: "customer" }], limit: 30 }), base({ groupBy: [{ dim: "customer" }], rows: many, totals: { values: { invoiceAmount: 1, invoiceCount: 1 } } })).pres;
    check("table is bounded like the text answer; chart shows only the top 10 and says so", mp.rows.length === 25 && mp.chart.points.length === 10 && mp.chart.shownOf.total === 30 && mp.moreRows.total === 30);

    const cmpRows = [{ key: { customer: "WE R TOYS" }, presence: "both", values: { invoiceAmount: 32201, invoiceCount: 3 }, comparison: { invoiceAmount: { previous: 85464, delta: -53263, deltaPct: -62.32214733689039 }, invoiceCount: { previous: 6, delta: -3, deltaPct: -50 } } }, { key: { customer: "Gone Co" }, presence: "previous_only", values: { invoiceAmount: 0, invoiceCount: 0 }, comparison: { invoiceAmount: { previous: 1000, delta: -1000, deltaPct: -100 }, invoiceCount: { previous: 1, delta: -1, deltaPct: -100 } } }];
    const rc = P(plan({ period: custom("2025-09-01", "2025-09-30"), compare: { mode: "custom", period: custom("2025-08-01", "2025-08-31") }, groupBy: [{ dim: "customer" }] }), base({ groupBy: [{ dim: "customer" }], comparison: { mode: "custom", label: "c" }, rows: cmpRows, totals: { values: { invoiceAmount: 32201, invoiceCount: 3 } } })).pres;
    check("ranking with a comparison: previous / change / % come from the engine row", rc.rows[0].cells.previous === fmtMoney(85464) && rc.rows[0].cells.change === `-${fmtMoney(53263)}` && rc.rows[0].cells.pct === "-62.3%" && rc.chart.points[0].previous === 85464);
    check("a party with no current activity is flagged, not hidden", rc.rows[1].flag === "No activity in the current period");
  }

  section("Trend");
  {
    const months = ["2025-04", "2025-05", "2025-06", "2025-07", "2025-08"];
    const vals = [6071377.93, 4223011.26, 4085714.1, 5716599.12, 4344775.5];
    const rows = months.map((m, i) => ({ key: { date: { bucket: "month", start: `${m}-01`, label: m } }, values: { invoiceAmount: vals[i], invoiceCount: 100 + i } }));
    const { pres } = P(plan({ period: custom("2025-04-01", "2025-08-31"), groupBy: [{ dim: "date", bucket: "month" }] }), base({ groupBy: [{ dim: "date", bucket: "month" }], rows, totals: { values: { invoiceAmount: 24441477.91, invoiceCount: 510 } } }));
    check("kind trend with a line chart of the actual monthly values", pres.kind === "trend" && pres.chart.type === "line" && pres.chart.points.map((p) => p.value).join() === vals.join());
    check("x labels are 'Apr 2025' ... 'Aug 2025'", pres.chart.points.map((p) => p.label).join() === "Apr 2025,May 2025,Jun 2025,Jul 2025,Aug 2025");
    check("monthly table (Month | Sales | Orders) with the engine's total", pres.columns.map((c) => c.label).join("|") === "Month|Sales|Orders" && pres.rows.length === 5 && pres.totals.cells.invoiceAmount === fmtMoney(24441477.91));
    check("a monthly trend is never collapsed into one total", pres.kind !== "kpi" && pres.rows.length === 5);
    const single = P(plan({ groupBy: [{ dim: "date", bucket: "month" }] }), base({ groupBy: [{ dim: "date", bucket: "month" }], rows: rows.slice(0, 1), totals: { values: { invoiceAmount: vals[0], invoiceCount: 100 } } })).pres;
    check("one data point: table only, no line chart", single.chart === null);
  }

  section("List, empty state, purchases");
  {
    const lr = base({ mode: "list", metrics: [], amountBasis: {}, totals: null, rows: [{ voucherNo: "WF/25-26/3432", date: "2025-08-30", customer: "Products Zone", voucherType: "Invoice", invoiceAmount: 9550 }] });
    const lp = P(plan({ mode: "list", metrics: undefined }), lr).pres;
    check("voucher list is a plain table", lp.kind === "table" && lp.rows[0].cells.voucher === "WF/25-26/3432" && lp.rows[0].cells.amount === fmtMoney(9550) && lp.chart === undefined);
    const ep = P(plan({ filters: [{ dim: "customer", op: "eq_ci", value: "DHINGRA GENERAL STORE" }], period: { kind: "previous_month" } }), base({ period: { kind: "previous_month", label: "Previous month (complete)", from: "2026-08-31T18:30:00.000Z", to: "2026-09-30T18:29:59.999Z" }, totals: { values: { invoiceAmount: 0, invoiceCount: 0 } } })).pres;
    check("no data: empty state with period and customer, no chart, no table, no figures", ep.kind === "empty" && ep.scope[0].value === "DHINGRA GENERAL STORE" && !ep.chart && !ep.rows && !ep.headline);
    const pu = P(plan({ entity: "purchase", metrics: ["purchaseAmount", "purchaseInvoiceCount"] }), base({ entity: "purchase", metrics: ["purchaseAmount", "purchaseInvoiceCount"], amountBasis: { purchaseAmount: "voucher_total_incl_tax" }, totals: { values: { purchaseAmount: 4217459.98, purchaseInvoiceCount: 570 } } })).pres;
    check("purchase KPI uses the purchase figures", pu.kind === "kpi" && pu.title === "Purchases" && pu.headline.display === fmtMoney(4217459.98) && pu.headline.label === "Purchases");
  }

  section("Presentation never changes the answer, and never invents");
  {
    const fresh = async () => ({ state: "fresh", dataAsOf: new Date("2025-12-08T10:00:00Z"), message: "Data is current." });
    const dates = buildDateContext({ sales: { earliest: new Date(2024, 3, 1), latest: new Date(2025, 11, 8) }, purchase: { earliest: new Date(2024, 3, 1), latest: new Date(2025, 11, 8) } }, new Date(2025, 11, 8, 18));
    const resolver = createEntityResolver({ tenantId: "T", sources: { customer: async () => ["Alpha Stores"], supplier: async () => [], product: async () => [], productGroup: async () => [] } });
    // the planner is scripted (no network): it answers with the given tool input, i.e. a plan or a decline
    const scripted = (input) => async () => ({ content: [{ type: "tool_use", id: "p", name: PLANNER_TOOL_NAME, input }], usage: { input_tokens: 1, output_tokens: 1 } });
    const result = base({ period: { kind: "previous_month", label: "Previous month (complete)", isPartial: false }, totals: { values: { invoiceAmount: 1234567.5, invoiceCount: 42 } } });
    const lastMonth = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "previous_month" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [] };
    const ask = (q, execute, input = { plan: lastMonth }) => realTryAnswer({ context: { tenantId: "T" }, userMessage: q, conversationHistory: [], deps: { resolveEntity: resolver, getFreshness: fresh, getDateContext: async () => dates, plannerClient: scripted(input), execute } });
    const r = await ask("total sales last month", async () => ({ result, cache: { status: "miss" } }));
    const expectText = formatQueryAnswer({ plan: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "previous_month" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [] }, result }).text;
    check("the chat response carries the presentation in the existing visualization slot", r.handled && r.structured.visualization && r.structured.visualization.kind === "kpi" && r.structured.visualization.headline.display === fmtMoney(1234567.5));
    check("the text answer is exactly the formatter's output (unchanged)", r.structured.answer === expectText);
    const z = await ask("total sales last month", async () => ({ result: base({ totals: { values: { invoiceAmount: 0, invoiceCount: 0 } } }), cache: { status: "miss" } }));
    check("zero result -> empty state presentation (no chart)", z.structured.visualization.kind === "empty" && !z.structured.visualization.chart);
    // a year the user never wrote: the planner's deterministic year guard asks, the engine never runs
    const c = await ask("sales in April", async () => { throw new Error("must not run"); }, { plan: { ...lastMonth, period: { kind: "custom", from: "2025-04-01", to: "2025-04-30" } } });
    check("a clarification has no presentation (text only)", c.handled && c.structured.visualization === null);
    const u = await ask("GST on sales last month", async () => { throw new Error("must not run"); }, { decline: { code: "unsupported_domain", message: "GST is not available here." } });
    check("a refusal has no presentation (text only)", u.handled && u.structured.visualization === null);
    check("the builder never throws: garbage in -> null", buildPresentation({ plan: null, result: null }) === null && buildPresentation({}) === null);
    check("the model is plain JSON (it is persisted on the chat message)", JSON.stringify(buildPresentation({ plan: plan({}), result: base({}), notes: [], zero: false })) === JSON.stringify(JSON.parse(JSON.stringify(buildPresentation({ plan: plan({}), result: base({}), notes: [], zero: false })))));
  }

  check("no network call of any kind", netCalls === 0, netCalls);
  console.log(`\nverify-presentation: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
