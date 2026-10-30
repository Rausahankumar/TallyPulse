/**
 * Top N versus the others (groupComparison.js) and its follow-ups, on synthetic data:
 *   "top 3 suppliers which give me best price" -> "Compare with others" -> "Compare top 3 suppliers with others" -> "Aug 2025".
 *
 * The REAL controller (sendChatMessage), chat turn, query planner checks, validator, follow-up state and presentation run; the
 * model replies are scripted, the engine is in memory (per-month purchases by supplier, honouring period, sort, limit and the
 * overall total) and the Chat model's database calls are captured. No database, no network, no model.
 * Checks: the group survives follow-ups; "compare with others" resolves without a planner call when a ranking is established and
 * asks when it is not; a period-only follow-up keeps the comparison; others excludes the top N and includes every other
 * supplier; totals, difference and shares reconcile; the ranking changes only on request; missing, truncated or unreconciled data
 * never yields a fabricated figure; KPI cards, chart, table and narrative carry the same figures; tenant scope, strict state
 * re-reading, validation and ordinary answers are unchanged.
 *
 * Run: node verify-group-comparison.js
 */

process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const gc = require("./src/services/query/groupComparison");
const followUp = require("./src/services/query/followUp");
const { validateQueryPlan } = require("./src/services/query/validator");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 900)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const TENANT = "T-GROUPS-0001";
const OTHER_TENANT = "T-GROUPS-0002";
const inr = (n) => `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// synthetic purchases (invoice totals incl. tax) by supplier and month; the other tenant's rows must never appear
const DATA = {
  [TENANT]: {
    "2025-07": { "Alpha Agro": 50000, "Beta Foods": 40000, "Gamma Traders": 30000, "Delta Supply": 20000, "Epsilon Co": 10000 },
    "2025-08": { "Delta Supply": 60000, "Alpha Agro": 45000, "Zeta Mart": 25000, "Beta Foods": 15000.5, "Gamma Traders": 5000, "Epsilon Co": 2500.25 },
  },
  [OTHER_TENANT]: { "2025-08": { "Other Tenant Supplier": 999999 } },
};
const july = { kind: "custom", from: "2025-07-01", to: "2025-07-31" };
const aug = { kind: "custom", from: "2025-08-01", to: "2025-08-31" };
const ranking = (o) => ({ v: 1, entity: "purchase", mode: "aggregate", period: july, metrics: ["purchaseAmount"], groupBy: [{ dim: "supplier" }], filters: [], sort: [{ by: "purchaseAmount", dir: "desc" }], limit: 3, ...o });

// ---------------------------------------------------------------- 1. pure functions
{
  const i1 = gc.intentOf("Compare with others"), i2 = gc.intentOf("Compare top 3 suppliers with others"), i3 = gc.intentOf("compare top 3 suppliers with the rest in Aug 2025");
  check("intent", "the comparison requests are recognised; extra scope (a period) is not 'pure'; ordinary questions are not requests", !!i1 && i1.pure && i1.n === null && !!i2 && i2.pure && i2.n === 3 && i2.dim === "supplier" && !!i3 && !i3.pure && gc.intentOf("compare sales with other months") === null && gc.intentOf("top 3 suppliers in Aug 2025") === null && gc.intentOf("Aug 2025") === null, JSON.stringify({ i1, i2, i3 }));
  check("ranking-rule", "a ranking is one supplier/customer/product grouping on an additive metric, highest first; lowest-first, averages, comparisons, having and date series are not", !!gc.rankingOf(ranking({})) && gc.rankingOf(ranking({ sort: [{ by: "purchaseAmount", dir: "asc" }] })) === null && gc.rankingOf(ranking({ metrics: ["averagePurchaseValue"], sort: [] })) === null && gc.rankingOf(ranking({ compare: { mode: "previous_period" } })) === null && gc.rankingOf(ranking({ having: [{ metric: "purchaseAmount", op: "gt", value: 1 }] })) === null && gc.rankingOf(ranking({ groupBy: [{ dim: "date", bucket: "month" }] })) === null);
  const exec = gc.comparisonPlan(ranking({}), gc.rankingOf(ranking({})));
  const v = validateQueryPlan(exec, { referenceDate: new Date(2026, 9, 27) });
  check("exec-plan-valid", "the executed comparison plan is the same ranking (period, filters, metric, order) with the largest row limit and the overall total, and passes the real validator", v.ok && exec.limit === 100 && exec.totals === true && JSON.stringify(exec.period) === JSON.stringify(july) && exec.groupBy[0].dim === "supplier", JSON.stringify(v.errors || v));

  const res = (rows, total, o = {}) => ({ ok: true, rows: rows.map(([k, x]) => ({ key: { supplier: k }, values: { purchaseAmount: x } })), totals: total === undefined ? null : { values: { purchaseAmount: total } }, truncated: false, ...o });
  const g = gc.computeGroups(res([["A", 60], ["B", 30], ["C", 5], ["D", 4], ["E", 1]], 100), { metric: "purchaseAmount", dim: "supplier", n: 3 });
  check("reconcile", "top 3 + others = overall; difference = top - others; shares add to 100; others = every other supplier (2)", g.ok && g.topTotal === 95 && g.othersTotal === 5 && g.overall === 100 && g.difference === 90 && Math.abs(g.topShare + g.othersShare - 100) < 1e-9 && g.othersCount === 2 && g.top.map((t) => t.name).join() === "A,B,C", JSON.stringify(g));
  const trunc = gc.computeGroups(res([["A", 60], ["B", 30], ["C", 5], ["D", 4]], 150, { truncated: true }), { metric: "purchaseAmount", dim: "supplier", n: 3 });
  check("truncated", "more suppliers than one query returns: others = overall - top (includes those beyond the limit), their number is NOT stated", trunc.ok && trunc.othersTotal === 55 && trunc.othersCount === null && trunc.othersAtLeast === 1);
  const noTotal = gc.computeGroups(res([["A", 60], ["B", 30], ["C", 5], ["D", 4]], undefined), { metric: "purchaseAmount", dim: "supplier", n: 3 });
  const off = gc.computeGroups(res([["A", 60], ["B", 30], ["C", 5], ["D", 4]], 120), { metric: "purchaseAmount", dim: "supplier", n: 3 });
  const empty = gc.computeGroups(res([], 0), { metric: "purchaseAmount", dim: "supplier", n: 3 });
  check("no-fabrication", "no overall total, rows that do not add up to it, or no rows: no group figures at all (never estimated from the top 3)", !noTotal.ok && noTotal.reason === "no_total" && !off.ok && off.reason === "not_reconciled" && !empty.ok && empty.reason === "no_rows", JSON.stringify({ noTotal, off, empty }));
  const zero = gc.computeGroups(res([["A", 0], ["B", 0], ["C", 0], ["D", 0]], 0), { metric: "purchaseAmount", dim: "supplier", n: 3 });
  check("shares-denominator", "shares only against a positive overall total", zero.ok && zero.topShare === null && zero.othersShare === null);
  const few = gc.computeGroups(res([["A", 60], ["B", 40]], 100), { metric: "purchaseAmount", dim: "supplier", n: 3 });
  check("fewer-than-n", "fewer suppliers than N: no other group (count 0, total 0), all of the total in the top group", few.ok && few.othersCount === 0 && few.othersTotal === 0 && few.topShare === 100);
  // the verified August 2025 regression figures (synthetic supplier names, the same totals)
  const reg = gc.computeGroups(res([["S1", 1200000], ["S2", 900000.98], ["S3", 617465], ["S4", 500000], ["S5", 499994], ["S6", 500000]].sort((a, b) => b[1] - a[1]), 4217459.98), { metric: "purchaseAmount", dim: "supplier", n: 3 });
  check("regression-aug-2025", "top 3 = ₹27,17,465.98 (64.4%), all others = ₹14,99,994.00 (35.6%), all suppliers = ₹42,17,459.98, reconciled", reg.ok && reg.topTotal === 2717465.98 && reg.othersTotal === 1499994 && reg.overall === 4217459.98 && reg.topShare.toFixed(1) === "64.4" && reg.othersShare.toFixed(1) === "35.6" && reg.othersCount === 3, JSON.stringify(reg));
  const tie = gc.computeGroups(res([["A", 60], ["B", 30], ["C", 5], ["D", 5]], 100), { metric: "purchaseAmount", dim: "supplier", n: 3 });
  check("tie", "a tie at the cut is flagged", tie.ok && tie.tie === true);

  // follow-up state: strict
  const st = gc.groupState(followUp.buildQueryState(ranking({})), ["Alpha Agro", "Beta Foods", "Gamma Traders"], 3);
  const back = followUp.readQueryState(JSON.parse(JSON.stringify(st)));
  check("state-roundtrip", "the comparison state re-reads strictly with its group (top 3, members) and holds no tenant or figure", !!back && back.group.top === 3 && back.group.members.length === 3 && !JSON.stringify(st).includes(TENANT) && !/50000|120000/.test(JSON.stringify(st)), JSON.stringify(back));
  const bad = (g) => followUp.readQueryState({ ...JSON.parse(JSON.stringify(st)), group: g });
  check("state-tampered", "a tampered group (top 0 or 50, members longer than top or not strings, or on an analysis state) -> the whole state is ignored", bad({ top: 0, members: [] }) === null && bad({ top: 50, members: [] }) === null && bad({ top: 1, members: ["a", "b"] }) === null && bad({ top: 3, members: [{ $ne: 1 }] }) === null && bad({ top: 3 }) === null && followUp.readQueryState({ ...JSON.parse(JSON.stringify(st)), source: "analysis", carried: ["entity"] }) === null);
  const single = followUp.buildQueryState(ranking({}));
  check("state-single-unchanged", "an ordinary query state reads exactly as before (no group)", JSON.stringify(followUp.readQueryState(single)) === JSON.stringify({ plan: single.plan, basis: single.basis }));
}

// ---------------------------------------------------------------- 2. the conversation, end to end through the real controller
(async () => {
  const day = (iso, end) => (end ? new Date(`${iso}T23:59:59.999`) : new Date(`${iso}T00:00:00`)).toISOString();
  const executed = [];
  let truncateAt = null; // force a truncated result (more suppliers than the query returns)
  const execute = async (plan, ctx) => {
    executed.push({ plan: JSON.parse(JSON.stringify(plan)), tenantId: ctx.tenantId });
    const month = plan.period.from.slice(0, 7);
    const groups = (DATA[ctx.tenantId] || {})[month] || {};
    const m = plan.metrics[0];
    const all = Object.entries(groups).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const total = Math.round(all.reduce((t, [, x]) => t + x, 0) * 100) / 100;
    const limit = truncateAt || plan.limit || 10;
    const rows = plan.groupBy.length ? all.slice(0, limit).map(([k, x]) => ({ key: { supplier: k }, values: { [m]: x } })) : [];
    return { result: { ok: true, entity: plan.entity, mode: "aggregate", period: { from: day(plan.period.from), to: day(plan.period.to, true), label: month }, comparison: null, metrics: plan.metrics, groupBy: plan.groupBy, amountBasis: { purchaseAmount: "voucher_total_incl_tax" }, rows, totals: { values: { [m]: total } }, truncated: plan.groupBy.length > 0 && all.length > limit, rowLimit: limit, warnings: [], assumptions: [] }, cache: { status: "miss" } };
  };
  const DC = { referenceDate: new Date(2026, 9, 27, 23, 59, 59, 999), source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 31), coverage: { earliest: new Date(2025, 0, 1), latest: new Date(2026, 9, 27), lastSyncedAt: null } };

  const requests = [];
  let script = [];
  const model = async (req) => {
    requests.push(req);
    const next = script.shift();
    if (!next) throw new Error("unexpected model call");
    return { content: [{ type: "tool_use", name: req.tool_choice.name, input: typeof next === "function" ? next(req) : next }], usage: { input_tokens: 1, output_tokens: 1 } };
  };
  let freshness = { state: "fresh", message: "" };
  let tenant = TENANT;
  const queryChat = require("./src/services/query/queryChat");
  const realTurn = queryChat.tryAnswerWithQueryEngine;
  queryChat.tryAnswerWithQueryEngine = (args) => realTurn({ ...args, getDateContext: async () => DC, deps: { plannerClient: model, analysisEnabled: false, execute, getFreshness: async () => freshness, getDateContext: async () => DC, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) } });
  const Chat = require("./src/models/chat.model");
  const saved = [];
  Chat.prototype.save = async function save() { saved.push(JSON.parse(JSON.stringify(this.toObject()))); return this; };
  let stored = null;
  Chat.findOne = async (filter) => (stored && filter.tenantId === tenant && String(filter._id) === String(stored._id) ? Chat.hydrate(JSON.parse(JSON.stringify(stored))) : null);
  const { sendChatMessage } = require("./src/controllers/chatController");
  const mkRes = () => ({ statusCode: 0, body: null, destroyed: false, closed: false, writableFinished: false, on() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.writableFinished = true; return this; } });
  const mkReq = (message, chatId) => ({ id: "req-groups", body: { message }, params: chatId ? { chatId } : {}, companyContext: { tenantId: tenant, companyGuid: "guid-groups" }, user: { id: "64b000000000000000000002" } });
  let n = 0;
  const ask = async (message, replies, { newChat = false } = {}) => {
    script = [...replies]; requests.length = 0; executed.length = 0;
    const res = mkRes();
    await sendChatMessage(mkReq(message, newChat || !stored ? undefined : stored._id), res);
    const doc = saved[saved.length - 1];
    stored = { ...doc, _id: `64b0000000000000000000${String(10 + (n += 1)).padStart(2, "0")}` };
    const msgs = doc.messages;
    return { res, data: res.body && res.body.data, state: msgs[msgs.length - 1].queryContext, calls: requests.length, executed: [...executed], left: script.length };
  };
  const vis = (t) => t.data && t.data.visualization;
  const kpi = (t, id) => (vis(t).kpis.find((k) => k.id === id) || {}).display;
  const cell = (t, i, k) => vis(t).rows[i] && vis(t).rows[i].cells[k];

  // turn 1: the ranking ("best price" planned as purchase value, highest first, with the planner's stated assumption)
  const t1 = await ask("Give me top 3 suppliers which gives me best price in July 2025", [{ plan: ranking({}), assumptions: ["best price read as the suppliers with the highest purchase value (purchaseAmount)"] }], { newChat: true });
  check("t1-ranking", "turn 1 is an ordinary ranking answer (kind ranking, 3 rows), its state is the ranking plan", t1.res.statusCode === 200 && vis(t1).kind === "ranking" && vis(t1).rows.length === 3 && !!followUp.readQueryState(t1.state) && !t1.state.group, JSON.stringify({ status: t1.res.statusCode, kind: vis(t1) && vis(t1).kind, state: t1.state }));

  // turn 2: "Compare with others" -> no planner call, the July ranking reused
  const t2 = await ask("Compare with others", []);
  const julyTop = 120000, julyAll = 150000;
  check("t2-resolved", "'Compare with others' reuses the established ranking: no model call, one query for this tenant, July, every supplier + overall total", t2.calls === 0 && t2.executed.length === 1 && t2.executed[0].tenantId === TENANT && t2.executed[0].plan.limit === 100 && t2.executed[0].plan.period.from === "2025-07-01" && t2.data.details.queryEngine.claudeCalls === 0 && t2.data.details.queryEngine.comparison === "top_vs_others", JSON.stringify({ calls: t2.calls, executed: t2.executed }));
  check("t2-figures", "top 3 = 1,20,000 (80.0%), others (2 suppliers) = 30,000, difference 90,000 - KPI cards, table and chart agree", vis(t2).kind === "groups" && kpi(t2, "top") === inr(julyTop) && kpi(t2, "others") === inr(30000) && kpi(t2, "difference") === `+${inr(90000)}` && kpi(t2, "share") === "80.0%" && cell(t2, 0, "total") === inr(julyTop) && cell(t2, 1, "total") === inr(30000) && cell(t2, 1, "count") === "2" && vis(t2).totals.cells.total === inr(julyAll) && vis(t2).chart.points[0].display === inr(julyTop) && vis(t2).chart.points[1].value === 30000, JSON.stringify(vis(t2)));
  check("t2-narrative", "the summary and the text state the same figures; the top 3 are listed for verification", vis(t2).summary.includes(inr(julyTop)) && vis(t2).summary.includes("80.0%") && vis(t2).summary.includes(inr(30000)) && /Alpha Agro/.test(t2.data.answer) && /Gamma Traders/.test(t2.data.answer) && vis(t2).members.rows.map((r) => r.cells.name).join() === "Alpha Agro,Beta Foods,Gamma Traders", t2.data.answer);
  check("t2-price", "spending is not presented as price: the answer says the ranking is by amount bought, not by rate, and never says 'cheapest'", /not by price/.test(t2.data.answer) && vis(t2).notes.some((x) => /not by price/.test(x)) && !/cheapest|lowest price/i.test(t2.data.answer));
  check("t2-no-duplicates", "the basis is stated once (not repeated in the notes); no raw plan or step objects in the text", vis(t2).basis.length === 1 && !vis(t2).notes.some((x) => vis(t2).basis.includes(x)) && !/[{}]|"entity"|groupBy|Step d/.test(t2.data.answer), JSON.stringify({ basis: vis(t2).basis, notes: vis(t2).notes }));
  check("t2-state", "the comparison state carries the ranking (top 3, July) and its members, and re-reads strictly", (() => { const s = followUp.readQueryState(t2.state); return !!s && s.group.top === 3 && s.plan.limit === 3 && s.group.members.join() === "Alpha Agro,Beta Foods,Gamma Traders"; })(), JSON.stringify(t2.state));

  // turn 3: same, with the group named
  const t3 = await ask("Compare top 3 suppliers with others", []);
  check("t3-same", "'Compare top 3 suppliers with others' gives the same comparison (no model call, same figures)", t3.calls === 0 && kpi(t3, "top") === inr(julyTop) && kpi(t3, "others") === inr(30000));

  // turn 4: "Aug 2025" -> planner with the previous ranking; the period changes, the comparison stays
  let sentPrev = null;
  const t4 = await ask("Aug 2025", [(req) => { sentPrev = req.messages[0].content; return { plan: ranking({ period: aug, limit: 10 }) }; }]);
  const augTop = 130000, augAll = 152500.75, augOthers = 22500.75;
  check("t4-prev-plan", "the planner gets the carried ranking (top 3, July) as the previous plan; no tenant id or figures are sent", /Previous query plan/.test(sentPrev || "") && /"limit":3/.test(sentPrev) && /2025-07-01/.test(sentPrev) && !sentPrev.includes(TENANT) && !/120000|Alpha Agro/.test(sentPrev), sentPrev && sentPrev.slice(0, 600));
  check("t4-period", "'Aug 2025' updates the period and keeps the comparison: August, top 3 (the planner's limit 10 does not change the ranking)", t4.calls === 1 && t4.executed[0].plan.period.from === "2025-08-01" && vis(t4).kind === "groups" && vis(t4).members.rows.length === 3, JSON.stringify({ calls: t4.calls, kind: vis(t4) && vis(t4).kind, plan: t4.executed[0] && t4.executed[0].plan }));
  check("t4-figures", "August: top 3 (Delta, Alpha, Zeta) = 1,30,000; others = every other August supplier (3) = 22,500.75; total 1,52,500.75; shares 85.2% / 14.8%", kpi(t4, "top") === inr(augTop) && kpi(t4, "others") === inr(augOthers) && cell(t4, 1, "count") === "3" && vis(t4).totals.cells.total === inr(augAll) && kpi(t4, "share") === "85.2%" && cell(t4, 1, "share") === "14.8%" && vis(t4).members.rows.map((r) => r.cells.name).join() === "Delta Supply,Alpha Agro,Zeta Mart", JSON.stringify(vis(t4)));
  check("t4-excludes", "the others group excludes every top-3 supplier and includes every other one: its total equals the sum of Beta, Gamma and Epsilon exactly", Math.round((15000.5 + 5000 + 2500.25) * 100) / 100 === augOthers && !vis(t4).members.rows.some((r) => ["Beta Foods", "Gamma Traders", "Epsilon Co"].includes(r.cells.name)));
  check("t4-members-change", "the answer says why the suppliers differ from July's top 3 (ranked inside August)", /differ from the previous answer's \(Alpha Agro, Beta Foods, Gamma Traders\)/.test(t4.data.answer), t4.data.answer);
  check("t4-tenant", "only this tenant's suppliers: the other tenant's supplier never appears", t4.executed.every((e) => e.tenantId === TENANT) && !/Other Tenant Supplier/.test(JSON.stringify(t4.data)));

  // explicit ranking changes only
  const t5 = await ask("top 5 in Aug 2025", [{ plan: ranking({ period: aug, limit: 5 }) }]);
  check("rank-explicit-n", "an explicit 'top 5' changes the group to 5 (others = Epsilon only: 2,500.25)", vis(t5).kind === "groups" && vis(t5).members.rows.length === 5 && kpi(t5, "others") === inr(2500.25), JSON.stringify(vis(t5) && vis(t5).kpis));
  const t6 = await ask("by number of invoices instead", [{ plan: ranking({ period: aug, metrics: ["purchaseInvoiceCount"], sort: [{ by: "purchaseInvoiceCount", dir: "desc" }], limit: 5 }) }]);
  check("rank-explicit-metric", "a different measure is a new ranking the user asked for: an ordinary ranking answer, not the old comparison", vis(t6).kind === "ranking" && !t6.state.group, JSON.stringify({ kind: vis(t6) && vis(t6).kind, state: t6.state }));

  // ordinary flow after a comparison: a total is a KPI
  await ask("Compare top 3 suppliers with others", [], { newChat: true }); // no state in a new chat -> clarification (checked below)
  const t7 = await ask("Give me top 3 suppliers by purchase value in Aug 2025", [{ plan: ranking({ period: aug }) }], { newChat: true });
  const t8 = await ask("Compare with others", []);
  const t9 = await ask("total purchases in Aug 2025", [{ plan: { v: 1, entity: "purchase", mode: "aggregate", period: aug, metrics: ["purchaseAmount"] } }]);
  check("ordinary-flow", "a plain total after a comparison is an ordinary KPI answer (1,52,500.75) and saves an ordinary state", vis(t7).kind === "ranking" && vis(t8).kind === "groups" && vis(t9).kind === "kpi" && vis(t9).headline.display === inr(augAll) && !t9.state.group, JSON.stringify(vis(t9)));

  // no established ranking -> ask, never guess; the reply completes the question
  stored = null;
  const c1 = await ask("Compare with others", [], { newChat: true });
  check("clarify-no-context", "'Compare with others' in a new chat asks which ranking and period (no model call, no query, no figure) and keeps the question pending", c1.calls === 0 && c1.executed.length === 0 && /Which ranking/.test(c1.data.answer) && !/₹/.test(c1.data.answer) && c1.state && c1.state.pending === "Compare with others", JSON.stringify({ answer: c1.data.answer, state: c1.state }));
  let joined = null;
  const c2 = await ask("top 3 suppliers by purchase value in Aug 2025", [(req) => { joined = req.messages[0].content; return { plan: ranking({ period: aug }) }; }]);
  check("clarify-reply", "the reply is planned together with the pending request and answered as the comparison (August top 3 vs others)", /Compare with others \(clarification: top 3 suppliers/.test(joined || "") && vis(c2).kind === "groups" && kpi(c2, "top") === inr(augTop), joined);
  const t1b = await ask("Average purchase invoice value per supplier in Aug 2025", [{ plan: { v: 1, entity: "purchase", mode: "aggregate", period: aug, metrics: ["averagePurchaseValue"], groupBy: [{ dim: "supplier" }], limit: 3 } }], { newChat: true });
  const c3 = await ask("Compare with others", []);
  check("clarify-not-ranking", "after an answer that is not an additive ranking (average per supplier), 'compare with others' asks instead of guessing", vis(t1b).kind === "ranking" && c3.executed.length === 0 && /Which ranking/.test(c3.data.answer));
  await ask("Give me top 3 suppliers by purchase value in July 2025", [{ plan: ranking({}) }], { newChat: true });
  const c4 = await ask("Compare top 3 customers with others", []);
  check("clarify-other-dim", "naming a different grouping (customers after a supplier ranking) asks instead of switching silently", c4.executed.length === 0 && c4.calls === 0 && /Which ranking/.test(c4.data.answer));

  // a tampered saved group is ignored (strict re-read): the request then has no context and asks
  const r = await ask("Give me top 3 suppliers by purchase value in July 2025", [{ plan: ranking({}) }], { newChat: true });
  await ask("Compare with others", []);
  const tampered = JSON.parse(JSON.stringify(stored));
  tampered.messages[tampered.messages.length - 1].queryContext.group = { top: 99, members: [] };
  stored = tampered;
  const c5 = await ask("Compare with others", []);
  check("tampered-ignored", "a tampered saved comparison state is ignored: nothing runs and the user is asked", vis(r).kind === "ranking" && c5.executed.length === 0 && /Which ranking/.test(c5.data.answer));

  // other tenant: the same chat id is not found for another tenant (tenant-scoped lookup), the turn never uses this tenant's state
  tenant = OTHER_TENANT;
  const o1 = await ask("Compare with others", []);
  tenant = TENANT;
  check("tenant-isolation", "another tenant cannot continue this tenant's chat (the chat lookup is tenant-scoped); nothing is executed for it", o1.res.statusCode !== 200 || (o1.executed.length === 0), JSON.stringify({ status: o1.res.statusCode, executed: o1.executed }));

  // truncated, stale and outside coverage
  await ask("Give me top 3 suppliers by purchase value in Aug 2025", [{ plan: ranking({ period: aug }) }], { newChat: true });
  truncateAt = 4;
  const tr = await ask("Compare with others", []);
  truncateAt = null;
  check("truncated-e2e", "more suppliers than the query returns: others total still from the overall total, their number shown as unknown, never counted from the rows (22,500.75)", kpi(tr, "others") === inr(augOthers) && /more than 1/.test(cell(tr, 1, "count")) && tr.data.answer.includes("number of other suppliers is not stated"), JSON.stringify(vis(tr)));
  freshness = { state: "stale", message: "Purchase data was last synced 3 days ago." };
  const stale = await ask("Compare with others", []);
  freshness = { state: "fresh", message: "" };
  check("stale", "stale data: the comparison is shown with the freshness warning and the stale state", stale.data.warnings.includes("Purchase data was last synced 3 days ago.") && stale.data.details.toolCalls[0].state === "stale_data");
  const out = await ask("Aug 2024", [{ plan: ranking({ period: { kind: "custom", from: "2024-08-01", to: "2024-08-31" } }) }]);
  check("outside-coverage", "a period before the synced history is missing data: no figures, no query, and the comparison is still carried for the next turn", out.executed.length === 0 && !/₹/.test(out.data.answer) && out.state && out.state.group && out.state.group.top === 3, JSON.stringify({ answer: out.data.answer, state: out.state }));
  const emptyMonth = await ask("Sep 2025", [{ plan: ranking({ period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" } }) }]);
  check("empty-period", "a month with no purchases: no group totals or shares, an empty-state view", vis(emptyMonth) && vis(emptyMonth).kind === "empty" && !/₹|%/.test(emptyMonth.data.answer.split("•")[0]), emptyMonth.data.answer);

  queryChat.tryAnswerWithQueryEngine = realTurn;
  console.log("\nSample (turn 4, 'Aug 2025'):\n" + JSON.stringify({ summary: vis(t4).summary, kpis: vis(t4).kpis, chart: vis(t4).chart, rows: vis(t4).rows, totals: vis(t4).totals, members: vis(t4).members.rows.map((x) => x.cells), basis: vis(t4).basis, notes: vis(t4).notes }, null, 1));
  console.log(`\nverify-group-comparison: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
