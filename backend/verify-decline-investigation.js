/**
 * "Why did sales decline in August 2025?" - the bounded investigation connects the measured fall to its customer and product
 * contributors and, when ONE product carries a material share of a fall its step ranked by that fall, to that product's
 * purchase evidence (evidence.js rule 5, reached through the investigation's existing purchases_for_fall follow-up).
 *
 * The REAL investigation loop (investigate), executor, evidence and answer formatter run, and the chat turn once end to end;
 * the engine is in memory (synthetic lines by month, customer and product), the model scripted. No database, network or model.
 * Proves: what the code does with these result shapes. Not proven: how a real planner plans such questions, or real data.
 *
 * Run: node verify-decline-investigation.js
 */

process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const { investigate, MAX_TOTAL_STEPS } = require("./src/services/query/investigation");
const { formatAnalysisAnswer } = require("./src/services/query/analysisAnswer");
const { buildAnalysisPresentation } = require("./src/services/query/analysisPresentation");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 900)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const r2 = (x) => Math.round(x * 100) / 100;
const TENANT = "T-DECLINE-0001";
const AUG = { kind: "custom", from: "2025-08-01", to: "2025-08-31" };
const JUL = { kind: "custom", from: "2025-07-01", to: "2025-07-31" };
const DC = Object.freeze({ referenceDate: new Date(2026, 9, 27, 12), source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 31), coverage: Object.freeze({ earliest: new Date(2025, 0, 1), latest: new Date(2025, 11, 31), lastSyncedAt: null }) });

// [entity, YYYY-MM, party, product, pre-tax line value, quantity]; an invoice total = line value x 1.05 (tax)
const SALES = [
  ["2025-07", "Kiran Stores", "Apple Shimla", 60000, 600], ["2025-07", "Kiran Stores", "Banana Robusta", 40000, 800],
  ["2025-07", "Lata Mart", "Banana Robusta", 80000, 1600], ["2025-07", "Mehta & Sons", "Cherry Kashmir", 50000, 250], ["2025-07", "Nair Retail", "Apple Shimla", 30000, 300],
  ["2025-08", "Kiran Stores", "Apple Shimla", 10000, 100], ["2025-08", "Kiran Stores", "Banana Robusta", 30000, 600],
  ["2025-08", "Lata Mart", "Banana Robusta", 70000, 1400], ["2025-08", "Mehta & Sons", "Cherry Kashmir", 65000, 325],
].map((l) => ["sales", ...l]);
// purchases of Apple by month: three supply variants
const PURCHASES = {
  fell: [["2025-06", "Himachal Orchards", "Apple Shimla", 70000, 700], ["2025-07", "Himachal Orchards", "Apple Shimla", 70000, 700], ["2025-08", "Himachal Orchards", "Apple Shimla", 20000, 200]],
  flat: [["2025-06", "Himachal Orchards", "Apple Shimla", 70000, 700], ["2025-07", "Himachal Orchards", "Apple Shimla", 70000, 700], ["2025-08", "Himachal Orchards", "Apple Shimla", 68000, 680]],
  none: [],
};
const lastDay = (m) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
const iso = (d, end) => (end ? new Date(`${d}T23:59:59.999`) : new Date(`${d}T00:00:00`)).toISOString();
const months = (from, to) => { const out = []; let m = from.slice(0, 7); while (m <= to.slice(0, 7)) { out.push(m); const [y, mo] = m.split("-").map(Number); m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; } return out; };

function engine(log, supply = "fell") {
  const LINES = [...SALES, ...PURCHASES[supply].map((l) => ["purchase", ...l])];
  return async (plan, ctx) => {
    log.push({ plan: JSON.parse(JSON.stringify(plan)), tenantId: ctx.tenantId });
    const keep = (l) => l[0] === plan.entity && (plan.filters || []).every((f) => { const vals = (Array.isArray(f.value) ? f.value : [f.value]).map((v) => v.toLowerCase()); return vals.includes((f.dim === "product" ? l[3] : l[2]).toLowerCase()); });
    const val = (l, m) => (m === "quantity" ? l[5] : m === "lineAmount" ? l[4] : r2(l[4] * 1.05));
    const ms = plan.metrics;
    const g = (plan.groupBy[0] || {}).dim;
    const sum = (inMonth, keyOf) => { const out = new Map(); for (const l of LINES.filter((x) => keep(x) && inMonth(x[1]))) { const k = keyOf(l); const v = out.get(k) || Object.fromEntries(ms.map((m) => [m, 0])); for (const m of ms) v[m] = r2(v[m] + val(l, m)); out.set(k, v); } return out; };
    const range = months(plan.period.from, plan.period.to);
    const period = { from: iso(plan.period.from), to: iso(plan.period.to, true), label: plan.period.from.slice(0, 7) };
    const totalOf = (map) => Object.fromEntries(ms.map((m) => [m, r2([...map.values()].reduce((t, v) => t + v[m], 0))]));
    if (g === "date") {
      const by = sum((mo) => range.includes(mo), (l) => l[1]);
      const rows = range.filter((mo) => by.has(mo)).map((mo) => ({ key: { date: { bucket: "month", start: `${mo}-01`, label: mo } }, values: by.get(mo) }));
      return { result: { ok: true, entity: plan.entity, mode: "aggregate", period, comparison: null, metrics: ms, groupBy: plan.groupBy, amountBasis: Object.fromEntries(ms.map((m) => [m, m === "lineAmount" ? "line_item_pre_tax" : m === "quantity" ? null : "voucher_total_incl_tax"])), rows, totals: { values: totalOf(by) }, truncated: false, rowLimit: plan.limit || 100, warnings: [], assumptions: [] } };
    }
    const prevRange = plan.compare && plan.compare.period ? months(plan.compare.period.from, plan.compare.period.to) : [];
    const keyOf = (l) => (g === "product" ? l[3] : g === "customer" ? l[2] : "");
    const cur = sum((mo) => range.includes(mo), keyOf), prev = sum((mo) => prevRange.includes(mo), keyOf);
    const m = ms[0];
    let rows = [...new Set([...cur.keys(), ...prev.keys()])].map((k) => {
      const c = cur.get(k) ? cur.get(k)[m] : 0, p = prev.get(k) ? prev.get(k)[m] : 0;
      return { key: { [g]: k }, values: { [m]: c }, comparison: { [m]: { previous: p, delta: r2(c - p), deltaPct: p ? r2(((c - p) / p) * 100) : null } } };
    });
    const s = (plan.sort || [])[0];
    rows.sort(s && /\.delta$/.test(s.by) ? (a, b) => (s.dir === "asc" ? 1 : -1) * (a.comparison[m].delta - b.comparison[m].delta) : (a, b) => b.values[m] - a.values[m]);
    for (const h of plan.having || []) rows = rows.filter((r) => (h.op === "lt" ? r.comparison[m].delta < h.value : r.comparison[m].delta > h.value));
    const tc = totalOf(cur)[m], tp = totalOf(prev)[m];
    const limit = plan.limit || 10;
    return { result: { ok: true, entity: plan.entity, mode: "aggregate", period, comparison: { from: iso(plan.compare.period.from), to: iso(plan.compare.period.to, true), label: plan.compare.period.from.slice(0, 7) }, metrics: ms, groupBy: plan.groupBy, amountBasis: { [m]: m === "lineAmount" ? "line_item_pre_tax" : "voucher_total_incl_tax" }, rows: g ? rows.slice(0, limit) : [], totals: { values: { [m]: tc }, comparison: { [m]: { previous: tp, delta: r2(tc - tp), deltaPct: tp ? r2(((tc - tp) / tp) * 100) : null } } }, truncated: !!g && rows.length > limit, rowLimit: limit, warnings: [], assumptions: [] } };
  };
}
const context = (log, supply) => ({ tenantId: TENANT, dateContext: DC, execute: engine(log, supply), getFreshness: async () => ({ state: "fresh", message: "" }), resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) });
const opts = { referenceDate: DC.referenceDate, dataThrough: DC.latestVoucher };

// the plan a planner sends for "why did sales decline in August 2025": the total, then customers and products ranked by the fall
const q = (o) => ({ v: 1, entity: "sales", mode: "aggregate", period: AUG, compare: { mode: "custom", period: JUL }, filters: [], ...o });
const WHY = { v: 1, steps: [
  { id: "total", kind: "query", plan: q({ metrics: ["invoiceAmount"] }) },
  { id: "customers", kind: "query", plan: q({ metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 10 }) },
  { id: "products", kind: "query", plan: q({ metrics: ["lineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 10 }) },
] };
const run = async (plan, supply = "fell") => {
  const log = [];
  const out = await investigate(plan, context(log, supply), opts);
  const formatted = formatAnalysisAnswer(out.execution, { referenceDate: DC.referenceDate, dataThrough: DC.latestVoucher, limitations: out.investigation.notes });
  return { out, log, text: formatted.text, formatted, findings: formatted.evidence.findings, vis: buildAnalysisPresentation({ execution: out.execution, formatted }) };
};
const purchaseQueries = (log) => log.filter((e) => e.plan.entity === "purchase");

(async () => {
  // ---- A. measured fall, contributors, and the supply evidence for the dominant product (purchases fell)
  const a = await run(WHY, "fell");
  check("a-measured", "the answer leads with the overall fall against July 2025: invoice totals ₹2,73,000 -> ₹1,83,750, -₹89,250 (-32.7%); the plan looked for falls, so no mismatch note", /\n\nAnalysis: [^\n]*\n\n\*\*Overall:\*\* Sales \(invoice amount\) fell from ₹2,73,000\.00 in Jul 2025 to ₹1,83,750\.00 in Aug 2025: -₹89,250\.00 \(-32\.7%\)\. \(step \d\)\n\n\*\*Findings\*\*/.test(a.text) && !/does not show an overall/.test(a.text), a.text.slice(0, 600));
  check("a-customers", "customer contributors reconcile to the fall: Kiran -63,000 (70.6%), Nair -31,500 (35.3%), Lata -10,500 (11.8%), Mehta +15,750 the other way; they add up to -89,250", /Kiran Stores -₹63,000\.00 \(70\.6%\); Nair Retail -₹31,500\.00 \(35\.3%\); Lata Mart -₹10,500\.00 \(11\.8%\)/.test(a.text) && /These add up to -₹89,250\.00/.test(a.text));
  check("a-products", "product contributors on the pre-tax line basis reconcile to their own total: Apple -80,000 (94.1%), Banana -20,000 (23.5%), Cherry +15,000; add up to -85,000", /Apple Shimla -₹80,000\.00 \(94\.1%\); Banana Robusta -₹20,000\.00 \(23\.5%\)/.test(a.text) && /These add up to -₹85,000\.00/.test(a.text));
  check("a-inactive", "a customer with no August sales is stated as an absence, not a reason (Nair Retail)", /none recorded in Aug 2025 for Nair Retail/.test(a.text) && /The data shows the absence, not its reason/.test(a.text));
  const pq = purchaseQueries(a.log);
  check("a-purchase-followup", "the investigation adds ONE purchase query for the dominant product only (Apple, by month, Jun-Aug 2025, line value and quantity), labelled as a follow-up", pq.length === 1 && pq[0].plan.filters[0].value === "Apple Shimla" && pq[0].plan.period.from === "2025-06-01" && pq[0].plan.period.to === "2025-08-31" && pq[0].plan.groupBy[0].bucket === "month" && a.out.execution.steps.some((s) => s.origin && /purchases of Apple Shimla by month/.test(s.origin.reason)), JSON.stringify(pq.map((e) => e.plan)));
  const cause = a.findings.find((f) => f.label === "possible_cause");
  check("a-hypothesis", "the purchase fall is a POSSIBLE cause, hedged (not confirmed, purchases are not stock), citing both the product breakdown and the purchase step", !!cause && /Purchases of Apple Shimla fell from ₹70,000\.00 in Jul 2025 to ₹20,000\.00 in Aug 2025/.test(cause.text) && /not confirmed/.test(cause.text) && cause.steps.includes(3) && cause.steps.includes(4), JSON.stringify(cause));
  check("a-labels", "facts, contributors and hypotheses stay apart; nothing is called a cause or proven", a.findings.some((f) => f.label === "measured") && a.findings.some((f) => f.label === "contributor") && !/\b(caused by|root cause|is the cause|proves?)\b/i.test(a.text.split("**Step 1**")[0]));
  check("a-no-supplier-claim", "the supplier is named only as where Apple's purchases came from; no claim about its price or blame", !/Himachal Orchards (caused|is responsible|is cheaper|best price)/i.test(a.text));
  check("a-bounded", "bounded: 4 queries in all (3 planned + 1 follow-up), within the step budget; nothing queried twice", a.log.length === 4 && a.out.execution.steps.length <= MAX_TOTAL_STEPS && new Set(a.log.map((e) => JSON.stringify(e.plan))).size === a.log.length && a.out.investigation.modelCalls === 0);
  check("a-tenant", "every query ran for this tenant", a.log.every((e) => e.tenantId === TENANT));
  check("a-view", "the structured view carries the hypothesis in its own cautioned list, apart from the measured findings", !!a.vis && a.vis.findings.possibleCauses.length === 1 && !a.vis.findings.measured.some((f) => /Purchases of Apple Shimla fell/.test(f.text)));

  // ---- B. purchases did not fall: measured "no purchase fall", no supply hypothesis
  const b = await run(WHY, "flat");
  check("b-no-fall", "purchases of Apple held up: a measured 'no fall of 10% or more', and no possible cause is invented", !b.findings.some((f) => f.label === "possible_cause") && /Purchases of Apple Shimla show no fall of 10% or more/.test(b.text), b.text.slice(0, 300));

  // ---- C. no purchase records for the product: unknown, never zero
  const c = await run(WHY, "none");
  check("c-missing", "no purchase records of Apple in the window: stated as 'could not be established', never as zero purchases or a fall", /Whether purchases of Apple Shimla fell with its sales could not be established/.test(c.text) && !c.findings.some((f) => f.label === "possible_cause") && !/Purchases of Apple Shimla fell/.test(c.text), c.text.split("**Step 1**")[0]);

  // ---- D. a comparison is not turned into an investigation
  const compare = { v: 1, steps: [{ id: "products", kind: "query", plan: q({ metrics: ["lineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 10 }) }] };
  const d = await run(compare);
  check("d-comparison", "product sales Aug vs Jul ordered by VALUE (a comparison, not ranked by the fall): no purchase query, no hypothesis", purchaseQueries(d.log).length === 0 && !d.findings.some((f) => f.label === "possible_cause"), JSON.stringify(d.log.map((e) => e.plan.entity)));
  // ---- E. no dominant product: the fall spread thinly -> no purchase query
  const spread = { v: 1, steps: [{ id: "products", kind: "query", plan: q({ metrics: ["lineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 10, filters: [{ dim: "customer", op: "in_ci", value: ["Lata Mart", "Mehta & Sons"] }] }) }] };
  const e = await run(spread);
  check("e-no-dominant", "a breakdown whose net change is not a fall (Lata -10,500, Mehta +15,750) adds no purchase query", purchaseQueries(e.log).length === 0);
  // ---- F. the planner already asked for purchases of Apple: not repeated
  const withPurchase = { v: 1, steps: [...WHY.steps, { id: "buys", kind: "query", plan: { v: 1, entity: "purchase", mode: "aggregate", period: { kind: "custom", from: "2025-06-01", to: "2025-08-31" }, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "date", bucket: "month" }], filters: [{ dim: "product", op: "eq_ci", value: "Apple Shimla" }], sort: [{ by: "date", dir: "asc" }], limit: 24 } }] };
  const f = await run(withPurchase);
  check("f-no-duplicate", "purchase evidence already planned: used as is, no second purchase query", purchaseQueries(f.log).length === 1 && f.findings.some((x) => x.label === "possible_cause"));
  // ---- G. Step B: products of the declining customers (inputs bound from the customer step), then supply
  const forCustomers = { v: 1, steps: [
    { id: "customers", kind: "query", plan: q({ metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], having: [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }], limit: 5 }) },
    { id: "products", kind: "query", plan: q({ metrics: ["lineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 10 }), inputs: [{ fromStep: "customers", dim: "customer", take: 3 }] },
  ] };
  const g = await run(forCustomers);
  const prod = g.log.find((x) => x.plan.groupBy[0] && x.plan.groupBy[0].dim === "product");
  check("g-connect", "products are measured for the three declining customers only (Mehta excluded): Apple -80,000 (80.0%) of their -100,000; then Apple's purchases are checked", !!prod && JSON.stringify(prod.plan.filters).includes("Kiran Stores") && !JSON.stringify(prod.plan.filters).includes("Mehta") && /Apple Shimla -₹80,000\.00 \(80\.0%\)/.test(g.text) && purchaseQueries(g.log).length === 1, g.text.split("**Step 1**")[0]);

  // ---- H. through the chat turn: the analysis route answers with the follow-up step and the hypothesis
  const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");
  const log = [];
  let script = [{ decline: { code: "needs_analysis", message: "several analyses" } }, { analysis: WHY }];
  const model = async (req) => ({ content: [{ type: "tool_use", name: req.tool_choice.name, input: script.shift() }], usage: { input_tokens: 1, output_tokens: 1 } });
  const chat = await tryAnswerWithQueryEngine({ context: { tenantId: TENANT, userId: "u" }, userMessage: "Why did sales decline in August 2025?", conversationHistory: [], deps: { plannerClient: model, analysisEnabled: true, getFreshness: async () => ({ state: "fresh", message: "", dataAsOf: null }), getDateContext: async () => DC, execute: engine(log, "fell"), resolveEntity: context([]).resolveEntity } });
  const meta = chat.structured.details.queryEngine;
  check("h-chat", "the chat turn runs it: 2 planner calls, 1 follow-up step, the hypothesis in the answer, a follow-up state saved (period carried)", meta.route === "analysis" && meta.claudeCalls === 2 && meta.investigation.followUps === 1 && /Possible cause \(not proven\): Purchases of Apple Shimla fell/.test(chat.structured.answer) && !!chat.queryContext && chat.queryContext.carried.includes("period"), JSON.stringify({ meta, carried: chat.queryContext && chat.queryContext.carried }));

  // ---- I. suggested next actions only when the question asks what to do (the analysis planner's structured `actions`)
  {
    const ACTIONS_RE = /\*\*Suggested next actions\*\*/;
    const turn = async (question, replies, previous = null, { dc = DC } = {}) => {
      const lg = [];
      const sent = [];
      let s = [...replies];
      const mdl = async (req) => { sent.push(req.messages[0].content); const next = s.shift(); return { content: [{ type: "tool_use", name: req.tool_choice.name, input: typeof next === "function" ? next(req) : next }], usage: { input_tokens: 1, output_tokens: 1 } }; };
      const out = await tryAnswerWithQueryEngine({ context: { tenantId: TENANT, userId: "u" }, userMessage: question, conversationHistory: previous ? [{ role: "user", text: "x" }] : [], previousQuery: previous, deps: { plannerClient: mdl, analysisEnabled: true, getFreshness: async () => ({ state: "fresh", message: "", dataAsOf: null }), getDateContext: async () => dc, execute: engine(lg, "fell"), resolveEntity: context([]).resolveEntity } });
      return { out, answer: out.structured.answer, vis: out.structured.visualization, meta: out.structured.details.queryEngine, sent, log: lg };
    };
    const DECLINE = { decline: { code: "needs_analysis", message: "several analyses" } };
    // comparison: product sales by value next to purchases by supplier (a concentration insight), no actions asked
    const COMPARE = { v: 1, steps: [
      { id: "products", kind: "query", plan: q({ metrics: ["lineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 10 }) },
      { id: "suppliers", kind: "query", plan: { v: 1, entity: "purchase", mode: "aggregate", period: { kind: "custom", from: "2025-06-01", to: "2025-08-31" }, metrics: ["lineAmount"], groupBy: [{ dim: "date", bucket: "month" }], filters: [{ dim: "product", op: "eq_ci", value: "Apple Shimla" }], sort: [{ by: "date", dir: "asc" }], limit: 24 } },
    ] };
    const cmp = await turn("Compare product sales and Apple purchases for August 2025", [DECLINE, { analysis: COMPARE }]);
    check("i-comparison", "a comparison: its findings (product contributors, purchases by month) are shown and no 'Suggested next actions' section is added", !ACTIONS_RE.test(cmp.answer) && /Contributor: /.test(cmp.answer) && cmp.vis.recommendations.length === 0 && cmp.vis.noAction === null && cmp.meta.actions === false, cmp.answer.split("**Step 1**")[0]);
    const why = await turn("Why did sales decline in August 2025?", [DECLINE, { analysis: WHY }]);
    check("i-why", "an investigation: measured fall, contributors and the hedged possible cause - and no unsolicited action plan", !ACTIONS_RE.test(why.answer) && /Possible cause \(not proven\): Purchases of Apple Shimla fell/.test(why.answer) && why.vis.recommendations.length === 0 && why.meta.actions === false, why.answer.split("**Step 1**")[0]);
    const evidenceStill = formatAnalysisAnswer((await run(WHY)).out.execution, { referenceDate: DC.referenceDate, dataThrough: DC.latestVoucher }).evidence.recommendations;
    check("i-independent", "the evidence record derives its steps either way (only their display depends on the ask): here the one supply check that specific evidence supports", evidenceStill.length === 1 && /^Check supplier orders and the availability of Apple Shimla/.test(evidenceStill[0].text));
    // the decision open point: the model's reply to it (third model call of the turn) - declined here
    const DECIDE_NO = { decline: { code: "not_a_data_query", message: "the findings are enough" } };
    const act = await turn("What should I do about the sales decline in August 2025?", [DECLINE, { analysis: WHY, actions: true }, DECIDE_NO]);
    check("i-actions", "asked what to do: only steps specific evidence supports - the supply check for Apple, kind 'Check', with the purchase figures it follows from; no generic step for a customer or product merely because it fell", ACTIONS_RE.test(act.answer) && /\n1\. Check: Check supplier orders and the availability of Apple Shimla.*Because: purchases ₹70,000\.00 in Jul 2025 -> ₹20,000\.00 in Aug 2025/.test(act.answer) && !/\n2\. /.test(act.answer.slice(act.answer.indexOf("**Suggested"), act.answer.indexOf("\nMeasured = "))) && !/Follow up with customer|Review product|still orders|Break the/.test(act.answer) && act.vis.recommendations.length === 1 && act.meta.actions === true, act.answer.slice(act.answer.indexOf("**Suggested"), act.answer.indexOf("**Suggested") + 500));
    // follow-up: "What should I do?" after the "why" turn - the August scope reaches both planners and the decision call
    const fromScope = (req) => { const m = /Previous turn's analysis scope[^\n]*\n(\{[^\n]*\})\n/.exec(req.messages[0].content); const scope = m ? JSON.parse(m[1]) : {}; const keep = (st) => ({ ...st, plan: { ...st.plan, period: scope.period || st.plan.period, compare: scope.compare || st.plan.compare } }); return { analysis: { v: 1, steps: WHY.steps.map(keep) }, actions: true }; };
    const fu = await turn("What should I do?", [DECLINE, fromScope, DECIDE_NO], why.out.queryContext);
    check("i-followup", "'What should I do?' after the investigation: all three planner requests carry the August scope (no period in the question); the answer gives the supply check for that same fall", fu.sent.length === 3 && fu.sent.every((t) => /Previous turn's analysis scope/.test(t) && t.includes("2025-08-01")) && ACTIONS_RE.test(fu.answer) && /Check supplier orders and the availability of Apple Shimla/.test(fu.answer) && fu.log.every((e) => e.tenantId === TENANT) && fu.log.filter((e) => e.plan.entity === "sales").every((e) => e.plan.period.from === "2025-08-01"), JSON.stringify({ sent: fu.sent.map((t) => t.slice(0, 160)), answer: fu.answer.slice(0, 300) }));
    // the reported follow-up wording, with a decision step that adds evidence: what did Kiran Stores (the largest fall) buy less of?
    const KIRAN_BY_PRODUCT = { analysis: { v: 1, steps: [{ id: "kiran_products", kind: "query", plan: q({ metrics: ["lineAmount"], groupBy: [{ dim: "product" }], filters: [{ dim: "customer", op: "eq_ci", value: "Kiran Stores" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 10 }) }] } };
    const hi = await turn("Ab hame kya karna chahiye?", [DECLINE, fromScope, KIRAN_BY_PRODUCT], why.out.queryContext);
    const hiFindings = hi.answer.slice(0, hi.answer.indexOf("**Step 1**"));
    check("i-followup-hinglish", "'Ab hame kya karna chahiye?': the decision call measures what the largest customer fall consisted of - Kiran Stores' fall is mostly Apple Shimla (-50,000 of -60,000, 83.3%), the product whose purchases also fell; the only step shown is still the evidence-backed supply check", hi.sent.every((t) => t.includes("2025-08-01")) && /decide: the user asks what to do/.test(hi.sent[2]) && /Sales for customer Kiran Stores \(line amount, pre-tax\), Jul 2025 to Aug 2025, by product .*Apple Shimla -₹50,000\.00 \(83\.3%\)/.test(hiFindings) && /Check supplier orders and the availability of Apple Shimla/.test(hi.answer) && !/Follow up with customer|still orders/.test(hi.answer) && hi.meta.investigation.decision === "measured", hiFindings.slice(-1500));
    // asked what to do, but nothing to act on: said so, never an invented action
    const RISE = { v: 1, steps: [{ id: "mehta", kind: "query", plan: q({ metrics: ["invoiceAmount"], filters: [{ dim: "customer", op: "in_ci", value: ["Mehta & Sons"] }] }) }] };
    const none = await turn("What should I do about Mehta & Sons in August 2025?", [DECLINE, { analysis: RISE, actions: true }, DECIDE_NO]);
    check("i-no-fabrication", "asked what to do with nothing to act on (Mehta's sales rose): says specifically why ('the measured change is not a fall'), no invented action", /No action follows from these results yet: the measured change is not a fall\./.test(none.answer) && none.vis.recommendations.length === 0 && /not a fall/.test(none.vis.noAction || "") && !/Review|Check supplier|Follow up/.test(none.answer), none.answer.slice(0, 500));
    // the flag is structured and validated: not a boolean, or beside a decline -> protocol violation
    const bad1 = await turn("Why did sales decline in August 2025?", [DECLINE, { analysis: WHY, actions: "yes" }]);
    const bad2 = await turn("Why did sales decline in August 2025?", [DECLINE, { decline: { code: "not_a_data_query" }, actions: true }]);
    check("i-validated", "a non-boolean actions flag, or one beside a decline, is a protocol violation (nothing runs)", bad1.meta.code === "planner_protocol_violation" && bad1.log.length === 0 && bad2.meta.code === "planner_protocol_violation", JSON.stringify([bad1.meta.code, bad2.meta.code]));

    // ---- J. the decision open point: does one more measurement change what to do? (asked once, inside the existing budget)
    const askWhat = (decideReply, o) => turn("Ab hame kya karna chahiye?", [DECLINE, fromScope, decideReply], why.out.queryContext, o);
    const sectionOf = (ans) => ans.slice(ans.indexOf("**Suggested"), ans.indexOf("\nMeasured = "));
    const decided = (x) => x.out.structured.details.queryEngine.investigation;
    // J1 useful: the decision step adds evidence the findings did not hold, and is labelled as evidence, never a recommendation
    const kiranStep = hi.log.find((e) => e.plan.filters.some((f) => f.dim === "customer" && f.value === "Kiran Stores"));
    check("j-useful-evidence", "a decision step that adds new evidence: Kiran Stores' products (not its total again), run through the executor for this tenant; the turn makes 3 model calls in all (1 inside the investigation), and the step is headed as evidence, not a recommendation", !!kiranStep && kiranStep.tenantId === TENANT && kiranStep.plan.groupBy[0].dim === "product" && hi.meta.claudeCalls === 3 && decided(hi).modelCalls === 1 && /follow-up: measured to inform what to do \(proposed by the analysis planner; evidence, not a recommendation\)/.test(hi.answer), JSON.stringify({ plan: kiranStep && kiranStep.plan, inv: decided(hi) }));
    check("j-useful-no-template", "the new evidence is shown as a finding; it is not turned into a new action (no 'follow up with Kiran', no 'review Apple') - the only step stays the supply check the purchase evidence supports", !/Kiran|Review/.test(sectionOf(hi.answer)) && /Check supplier orders and the availability of Apple Shimla/.test(sectionOf(hi.answer)));
    // J2 declines: the findings are enough - not a failure and not a limitation
    check("j-declined", "the model declines: decision 'declined', nothing extra runs, and the answer states no limitation about it (a decline is not 'could not be checked')", decided(act).decision === "declined" && act.log.length === 4 && !/could not be checked|stays open|stopped at its/.test(act.answer) && decided(act).stopReason !== "follow_up_failed", JSON.stringify(decided(act)));
    // J3 redundant and duplicate: re-measuring what is shown is not run
    const kiranTotal = await askWhat({ analysis: { v: 1, steps: [{ id: "kiran_total", kind: "query", plan: q({ metrics: ["invoiceAmount"], filters: [{ dim: "customer", op: "eq_ci", value: "Kiran Stores" }] }) }] } });
    check("j-remeasure", "a decision step that only re-measures a row already shown (Kiran Stores' Jul-Aug total) is not run, and says so; decision 'not_run'", !kiranTotal.log.some((e) => !(e.plan.groupBy || []).length && e.plan.filters.some((f) => f.value === "Kiran Stores")) && /only re-measures values already shown/.test(kiranTotal.answer) && decided(kiranTotal).decision === "not_run", JSON.stringify(decided(kiranTotal)));
    const again = await askWhat({ analysis: { v: 1, steps: [WHY.steps[1]] } });
    check("j-duplicate", "a decision step identical to a step already run is not run (plan fingerprint)", /repeats a step already run/.test(again.answer) && again.log.filter((e) => e.plan.groupBy[0] && e.plan.groupBy[0].dim === "customer").length === 1, JSON.stringify(decided(again)));
    const fullAgain = await askWhat({ analysis: { v: 1, steps: [{ id: "customers_value", kind: "query", plan: q({ metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 20 }) }] } });
    check("j-same-breakdown", "the same complete customer breakdown, only re-ordered or with another limit, is a re-measure and is not run", /only re-measures values already shown/.test(fullAgain.answer) && fullAgain.log.filter((e) => e.plan.groupBy[0] && e.plan.groupBy[0].dim === "customer").length === 1);
    // J4 incomplete period: no step from an incomplete fall, whatever is measured
    const DC_AUG20 = Object.freeze({ ...DC, latestVoucher: new Date(2025, 7, 20) });
    const partial = await askWhat(KIRAN_BY_PRODUCT, { dc: DC_AUG20 });
    check("j-incomplete", "data only up to 20 Aug: the decision step may run, but nothing is recommended - the answer says the fall is not complete yet", /No action follows from these results yet: the fall is not complete yet: Aug 2025 has data only up to 2025-08-20/.test(partial.answer) && partial.vis.recommendations.length === 0, sectionOf(partial.answer));
    // J5 limits and accounting: budget, per-step validation and rewrites still apply to decision steps
    const twoSteps = await askWhat({ analysis: { v: 1, steps: [KIRAN_BY_PRODUCT.analysis.steps[0], { id: "lata_products", kind: "query", plan: q({ metrics: ["lineAmount"], groupBy: [{ dim: "product" }], filters: [{ dim: "customer", op: "eq_ci", value: "Lata Mart" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 10 }) }] } });
    check("j-budget", "the round's deterministic purchase step leaves room for ONE decision step: a 2-step proposal is not run (the per-round budget is unchanged)", /did not fit the investigation's budget \(at most 1 query steps\)/.test(twoSteps.answer) && twoSteps.log.length === 4 && decided(twoSteps).decision === "not_run", JSON.stringify(decided(twoSteps)));
    const invoiceByProduct = await askWhat({ analysis: { v: 1, steps: [{ id: "kiran_inv", kind: "query", plan: q({ metrics: ["invoiceAmount"], groupBy: [{ dim: "product" }], filters: [{ dim: "customer", op: "eq_ci", value: "Kiran Stores" }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 10 }) }] } });
    const invStep = invoiceByProduct.log.find((e) => e.plan.filters.some((f) => f.value === "Kiran Stores"));
    check("j-accounting", "a decision step asking invoice totals by product (an invoice total cannot be split by product without inventing a tax allocation) is refused by the same validator and never runs; recorded as not checked, not as declined; every query that did run was for this tenant", !invStep && /could not be checked \(the analysis planner's reply was not usable: analysis_invalid_plan\)/.test(invoiceByProduct.answer) && decided(invoiceByProduct).decision === "not_run" && invoiceByProduct.log.every((e) => e.tenantId === TENANT), JSON.stringify({ inv: decided(invoiceByProduct), ran: invoiceByProduct.log.map((e) => e.plan.metrics) }));
    // J6 inconclusive: new evidence that points at nothing specific stays a finding
    const LATA_BY_PRODUCT = { analysis: { v: 1, steps: [{ id: "lata_products", kind: "query", plan: q({ metrics: ["lineAmount"], groupBy: [{ dim: "product" }], filters: [{ dim: "customer", op: "eq_ci", value: "Lata Mart" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 10 }) }] } };
    const lata = await askWhat(LATA_BY_PRODUCT);
    check("j-inconclusive", "a decision step whose result points at nothing specific (Lata Mart bought -10,000 less Banana; Banana's purchases are not in question) adds a finding but no action", /Sales for customer Lata Mart \(line amount, pre-tax\)/.test(lata.answer) && !/Lata|Banana/.test(sectionOf(lata.answer)) && lata.vis.recommendations.length === 1 && decided(lata).decision === "measured", sectionOf(lata.answer));
    // J7 a failed reply is not a decline
    const broken = await askWhat({ analysis: { v: 1, steps: "x" } });
    check("j-failed-not-declined", "a malformed reply to the decision point is stated as 'could not be checked' and recorded 'not_run' - never presented as the findings being enough", /Whether another measurement would change what to do could not be checked/.test(broken.answer) && decided(broken).decision === "not_run", JSON.stringify(decided(broken)));
  }

  console.log("\nSample answer (A, purchases fell):\n" + a.text.split("**Step 1**")[0]);
  console.log(`\nverify-decline-investigation: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
