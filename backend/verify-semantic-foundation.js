"use strict";

/**
 * Semantic Foundation & Context (P-SF) - focused deterministic suite.
 *
 *   A. ONE tenant reference date per turn: the rule, future-dated vouchers (rule kept + disclosed), memoisation,
 *      and the SAME period boundaries through router/engine, legacy chat (prompt + tools) and the planner
 *   B. relative periods (>= 30 questions): router meaning + engine boundaries vs an INDEPENDENT calendar oracle at
 *      month-end, 29 Feb, FY-start and mid-month anchors, and legacy tools agree wherever they overlap
 *   C. data coverage (>= 30 questions): covered / partial / outside, deterministic refusals and caveats, never a zero
 *   D. "who" (>= 50 questions): entity, dimension, metric, direction, period, comparison asserted for every one
 *   E. growth / percentage (>= 50 questions): total %, grouped %, % ranking (refused), % thresholds, share, direction
 *   F. new / reactivated / lost (>= 20 questions)
 *   G. follow-up context (>= 40 follow-ups through the real chat entry point, context carried like the controller)
 *   H. month-end: complete period vs same days disclosed, never silently changed
 *   I. synthetic tenant (real MongoDB, real engine): no-data vs zero, coverage, "who", %, new/lost and a controller
 *      round trip, every figure checked against an INDEPENDENT oracle (plain arithmetic over the inserted vouchers)
 *   J. safety: plans carry no tenant/operator fields, stored context is untrusted, no network at all
 *
 * Writes ONLY a synthetic tenant ("verify-semantic-foundation-*": vouchers through the raw driver, one chat) and
 * deletes it afterwards. Real tenants are not read. No Anthropic, no Tally (all network is disabled).
 * Run: node verify-semantic-foundation.js
 */

require("dotenv").config();
const http = require("http");
const https = require("https");

let netCalls = 0;
const savedNet = { fetch: global.fetch, h: http.request, s: https.request };
global.fetch = async () => { netCalls += 1; throw new Error("network disabled in this suite"); };
http.request = () => { netCalls += 1; throw new Error("network disabled in this suite"); };
https.request = () => { netCalls += 1; throw new Error("network disabled in this suite"); };

// Legacy tools are exercised without a database: the trust envelope is replaced by a pass-through that keeps its
// contract (a {supported:false} result becomes state no_usable_data with the reason as message).
const envPath = require.resolve("./src/services/analytics/trustEnvelope");
require.cache[envPath] = {
  id: envPath, filename: envPath, loaded: true,
  exports: { wrapAnalyticsResult: async ({ run }) => { const data = await run(); return data && data.supported === false ? { state: "no_usable_data", data: null, freshness: null, message: data.reason } : { state: "valid_data", data, freshness: null, message: null }; } },
};
// Freshness is not what this suite tests: every entity is "fresh" (the freshness gate has its own suites).
const freshPath = require.resolve("./src/services/analytics/freshness");
require.cache[freshPath] = { id: freshPath, filename: freshPath, loaded: true, exports: { getFreshness: async () => ({ state: "fresh", dataAsOf: new Date("2025-06-30T10:00:00Z"), message: "Data is current." }) } };

const fs = require("fs");
const { routeQuestion } = require("./src/services/query/localRouter");
const { validateQueryPlan } = require("./src/services/query/validator");
const { parseQueryPlan } = require("./src/services/query/queryPlan.schema");
const { createEntityResolver } = require("./src/services/query/entityResolver");
const { planQuestion, PLANNER_TOOL_NAME, SKIP_ROUTER_CODES } = require("./src/services/query/planner");
const { tryAnswerWithQueryEngine, createTurnDates } = require("./src/services/query/queryChat");
const { readQueryState } = require("./src/services/query/followUp");
const { formatQueryAnswer, fmtMoney } = require("./src/services/query/answerFormatter");
const { buildDateContext } = require("./src/services/analytics/referenceDate");
const { classifyRange, assessCoverage } = require("./src/services/analytics/coverage");
const tools = require("./src/services/ai/tools");
const salesAnalytics = require("./src/services/analytics/salesAnalytics");
const { handleChatTurn, buildSystemPromptBlocks } = require("./src/services/ai/chatOrchestrator");

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 400)})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);
const ymd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const range = (r) => (r && r.from ? `${ymd(r.from)}..${ymd(r.to)}` : "none");
const U = (y, m, d) => new Date(Date.UTC(y, m - 1, d)); // voucher dates are stored as UTC midnight

// Semantic signature: entity:metric | dimension | direction | comparison | period [| limit][| filter]
function sig(p) {
  const h = p.having || [];
  const find = (m, op) => h.find((x) => x.metric.endsWith(m) && x.op === op);
  let dir = "-";
  if (h.some((x) => /\.previous$/.test(x.metric) && x.op === "eq") && h.some((x) => !/\./.test(x.metric) && x.op === "gt")) dir = "new";
  else if (h.some((x) => !/\./.test(x.metric) && x.op === "eq") && h.some((x) => /\.previous$/.test(x.metric) && x.op === "gt")) dir = "lost";
  else if (find(".deltaPct", "gt")) dir = `pct>${find(".deltaPct", "gt").value}`;
  else if (find(".deltaPct", "lt")) dir = `pct<${find(".deltaPct", "lt").value}`;
  else if (find(".delta", "gt")) dir = "up";
  else if (find(".delta", "lt")) dir = "down";
  const dim = p.groupBy && p.groupBy.length ? p.groupBy.map((g) => g.dim + (g.bucket ? ":" + g.bucket : "")).join("+") : "total";
  const period = p.period.kind === "custom" ? `${p.period.from}..${p.period.to}` : p.period.kind === "specific_fy" ? `fy${p.period.fy}` : p.period.kind;
  const cmp = p.compare ? (p.compare.mode === "custom" ? `vs ${p.compare.period.from}..${p.compare.period.to}` : p.compare.mode) : "none";
  let out = `${p.entity}:${p.metrics ? p.metrics[0] : "list"}|${dim}|${dir}|${cmp}|${period}`;
  if (p.limit !== undefined) out += `|L${p.limit}`;
  for (const f of p.filters || []) out += `|${f.dim}=${f.value}`;
  return out;
}

// synthetic names only
const NAMES = { customer: ["Aarav Traders", "Bluebell Mart"], supplier: ["Crescent Supplies"], product: ["Widget Alpha"], productGroup: ["Hardware"] };
const resolver = createEntityResolver({ tenantId: "SF-PURE", sources: Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [k, async () => v])) });
const REF = new Date(2026, 8, 18, 12); // routing only validates with it; plans stay symbolic
const route = (q, ref = REF) => routeQuestion(q, { resolveEntity: resolver, entityIndex: resolver.spanIndex, referenceDate: ref });
const classOf = (x) => (x.status === "supported" ? "SUPPORTED" : x.status === "unsupported" ? "UNSUPPORTED" : SKIP_ROUTER_CODES.has(x.code) ? "CLARIFY" : "PLANNER");

// date contexts (pure)
const WINDOW = buildDateContext({ sales: { earliest: U(2025, 4, 1), latest: U(2025, 12, 8) }, purchase: { earliest: U(2025, 4, 3), latest: U(2025, 12, 5) } }, new Date(2025, 11, 8, 12)); // today = 8 Dec 2025
const forbiddenPlanner = async () => { throw new Error("Claude must NOT be called"); };
function fakeEngine() {
  const calls = [];
  const fn = async (plan, ctx) => {
    calls.push({ plan, ctx });
    const v = validateQueryPlan(plan, { referenceDate: ctx.referenceDate });
    const n = v.normalized;
    const out = (r) => (r && r.from ? { from: r.from.toISOString(), to: r.to.toISOString(), label: r.label, isPartial: r.isPartial } : r ? { label: r.label } : null);
    return { result: { ok: true, entity: plan.entity, mode: plan.mode, period: out(n.period), comparison: n.comparison ? { ...out(n.comparison), mode: plan.compare.mode } : null, metrics: n.metrics, groupBy: n.groupBy, amountBasis: {}, rows: [], totals: { values: Object.fromEntries(n.metrics.map((m) => [m, 1])), comparison: n.comparison ? Object.fromEntries(n.metrics.map((m) => [m, { previous: 1, delta: 0, deltaPct: 0 }])) : null }, truncated: false, rowLimit: n.limit, warnings: v.warnings, assumptions: v.assumptions }, cache: { status: "miss" } };
  };
  fn.calls = calls;
  return fn;
}
const askPure = (q, { dates = WINDOW, history = [], previousQuery = null, execute = fakeEngine(), plannerClient = forbiddenPlanner } = {}) =>
  tryAnswerWithQueryEngine({ context: { tenantId: "SF-PURE" }, userMessage: q, conversationHistory: history, previousQuery, deps: { resolveEntity: resolver, entityIndex: resolver.spanIndex, getFreshness: async () => ({ state: "fresh", dataAsOf: null, message: "ok" }), plannerClient, execute, getDateContext: async () => dates } });

// ---------------------------------------------------------------- independent calendar oracle (no project code)
const D = (y, m, d) => new Date(y, m, d);
const dim = (y, m) => new Date(y, m + 1, 0).getDate();
const shiftM = (x, k) => { const t = x.getMonth() + k; const y = x.getFullYear() + Math.floor(t / 12); const m = ((t % 12) + 12) % 12; return D(y, m, Math.min(x.getDate(), dim(y, m))); };
const addD = (x, k) => D(x.getFullYear(), x.getMonth(), x.getDate() + k);
const fyStart = (x) => D(x.getMonth() >= 3 ? x.getFullYear() : x.getFullYear() - 1, 3, 1);
const qStart = (x) => D(x.getFullYear(), Math.floor(x.getMonth() / 3) * 3, 1);
const monday = (x) => addD(x, -((x.getDay() + 6) % 7));
const R = (a, b) => `${ymd(a)}..${ymd(b)}`;
function oracle(kind, mode, r) {
  const cur = {
    current_month: [D(r.getFullYear(), r.getMonth(), 1), r],
    previous_month: [shiftM(D(r.getFullYear(), r.getMonth(), 1), -1), D(r.getFullYear(), r.getMonth(), 0)],
    current_quarter: [qStart(r), r],
    previous_quarter: [shiftM(qStart(r), -3), addD(qStart(r), -1)],
    current_fy: [fyStart(r), r],
    previous_fy: [shiftM(fyStart(r), -12), addD(fyStart(r), -1)],
    current_week: [monday(r), r],
    previous_week: [addD(monday(r), -7), addD(monday(r), -1)],
    today: [r, r],
    yesterday: [addD(r, -1), addD(r, -1)],
    last_7_days: [addD(r, -6), r],
    last_30_days: [addD(r, -29), r],
    last_90_days: [addD(r, -89), r],
  }[kind];
  let prev = null;
  const unitShift = { current_month: 1, current_quarter: 3, current_fy: 12 }[kind];
  if (mode === "like_for_like") {
    if (unitShift) prev = [shiftM(cur[0], -unitShift), shiftM(cur[1], -unitShift)];
    else if (kind === "previous_month") prev = [shiftM(cur[0], -1), D(cur[0].getFullYear(), cur[0].getMonth(), 0)];
    else if (kind === "previous_quarter") prev = [shiftM(cur[0], -3), addD(cur[0], -1)];
    else if (kind === "current_week") prev = [addD(cur[0], -7), addD(cur[1], -7)];
    else if (/^last_(\d+)_days$/.test(kind)) { const n = Number(kind.split("_")[1]); prev = [addD(cur[0], -n), addD(cur[1], -n)]; }
  } else if (mode === "same_period_last_year") prev = [shiftM(cur[0], -12), shiftM(cur[1], -12)];
  else if (mode === "full_previous") prev = { current_month: [shiftM(cur[0], -1), addD(cur[0], -1)], current_quarter: [shiftM(cur[0], -3), addD(cur[0], -1)], current_fy: [shiftM(cur[0], -12), addD(cur[0], -1)] }[kind];
  return { cur: R(cur[0], cur[1]), prev: prev ? R(prev[0], prev[1]) : "none" };
}

(async () => {
  // =============================================================== A
  section("A. ONE tenant reference date per turn (rule, future dates, memoisation, cross-path consistency)");
  {
    // Decision 1 (final, 2026-09-28): the reporting reference date is TODAY; vouchers never move it
    const NOW = new Date(2026, 8, 28, 12); // 28-Sep-2026, noon
    const a = buildDateContext({ sales: { earliest: U(2025, 4, 1), latest: U(2025, 12, 8) }, purchase: { earliest: U(2025, 3, 15), latest: U(2025, 12, 10) } }, NOW);
    check("rule: reference date = end of TODAY (28 Sep 2026 23:59:59.999 local), whatever the vouchers say (source today)", a.referenceDate.getTime() === new Date(2026, 8, 28, 23, 59, 59, 999).getTime() && a.source === "today");
    check("coverage window: first voucher of EITHER type .. last voucher (no sync recorded); per-entity bounds kept", a.coverage.earliest.getTime() === U(2025, 3, 15).getTime() && a.coverage.latest.getTime() === U(2025, 12, 10).getTime() && a.coverage.sales.earliest.getTime() === U(2025, 4, 1).getTime());
    const synced = buildDateContext({ sales: { earliest: U(2025, 4, 1), latest: U(2026, 9, 20) }, purchase: {}, lastSyncedAt: new Date(2026, 8, 28, 9, 30) }, NOW);
    check("coverage window ends at the later of the last voucher and the last successful sync (a synced day with no vouchers is a real zero)", ymd(synced.coverage.latest) === "2026-09-28");
    const b = buildDateContext({ sales: { earliest: U(2025, 4, 1), latest: U(2025, 12, 8) }, purchase: { earliest: U(2025, 3, 15), latest: U(2025, 12, 10) } }, NOW);
    check("deterministic: same inputs -> identical context", JSON.stringify(a) === JSON.stringify(b));
    const none = buildDateContext({ sales: {}, purchase: {} }, NOW);
    check("no vouchers at all: still today, no coverage window, no future vouchers", ymd(none.referenceDate) === "2026-09-28" && none.coverage.earliest === null && none.coverage.latest === null && !none.futureVouchers);

    // test 1-3: today 28-Sep-2026 with a future voucher dated 1-Oct-2026
    const future = buildDateContext({ sales: { earliest: U(2026, 8, 1), latest: U(2026, 10, 1) }, purchase: { earliest: U(2026, 8, 3), latest: U(2026, 9, 20) } }, NOW);
    check("(1) future voucher 1-Oct-2026: the reference date stays 28-Sep-2026 (flagged futureVouchers)", ymd(future.referenceDate) === "2026-09-28" && future.futureVouchers === true && ymd(future.latestVoucher) === "2026-10-01");
    const sameDay = buildDateContext({ sales: { earliest: U(2026, 8, 1), latest: U(2026, 9, 28) }, purchase: {} }, new Date(2026, 8, 28, 23, 50));
    check("a voucher dated today is not a future voucher", sameDay.futureVouchers === false);
    const eng = fakeEngine();
    const r = await askPure("sales this month", { dates: future, execute: eng });
    const cm = validateQueryPlan(eng.calls[0].plan, { referenceDate: eng.calls[0].ctx.referenceDate }).normalized.period;
    check("(2) current month on 28-Sep-2026 = 1-Sep-2026 .. 28-Sep-2026 (the engine gets the SAME reference date)", range(cm) === "2026-09-01..2026-09-28" && eng.calls[0].ctx.referenceDate.getTime() === future.referenceDate.getTime(), range(cm));
    check("(3) a voucher dated 1-Oct-2026 is outside every relative period (the boundary is today), and the answer says future-dated vouchers exist and are excluded", U(2026, 10, 1).getTime() > cm.to.getTime() && /Relative periods end today \(28 Sept? 2026\)\. This company also has vouchers dated after today \(latest 1 Oct 2026\); they are not included/.test(r.structured.answer), r.structured.answer);
    const rAll = await askPure("top 5 customers by sales", { dates: future });
    check("...no such note on a question without a relative period (all history)", !/after today/.test(rAll.structured.answer));
    const lit = fakeEngine();
    await askPure("sales from 2026-10-01 to 2026-10-31", { dates: future, execute: lit });
    const ln = validateQueryPlan(lit.calls[0].plan, { referenceDate: lit.calls[0].ctx.referenceDate }).normalized.period;
    check("(4) an explicit future date range keeps its explicit meaning (1-Oct-2026 .. 31-Oct-2026 is queried as asked)", range(ln) === "2026-10-01..2026-10-31", range(ln));

    // memoised per turn
    let loads = 0;
    const get = createTurnDates("T", async () => ((loads += 1), WINDOW));
    await Promise.all([get(), get(), get()]);
    check("createTurnDates: read at most once per turn, value visible to telemetry via peek()", loads === 1 && get.peek() === WINDOW);
    let loads2 = 0;
    const lazy = createTurnDates("T", async () => ((loads2 += 1), WINDOW));
    void lazy;
    check("...and not read at all until something needs it", loads2 === 0);

    // no wall-clock "today" left on the AI paths
    let refusedTool = false;
    try { tools.resolvePeriod({ period: "previous_month" }); } catch (e) { refusedTool = true; }
    let refusedCmp = false;
    try { tools.resolveComparisonPeriods("vs_previous_month"); } catch (e) { refusedCmp = true; }
    let refusedPrompt = false;
    try { buildSystemPromptBlocks(); } catch (e) { refusedPrompt = true; }
    check("legacy tools and the legacy prompt refuse to run without the tenant date (no silent wall clock)", refusedTool && refusedCmp && refusedPrompt);
    const ctl = fs.readFileSync(require.resolve("./src/controllers/chatController.js"), "utf8");
    check("controller: ONE createTurnDates per turn, shared by the engine AND legacy chat (getDateContext: turnDates)", (ctl.match(/createTurnDates\(tenantId\)/g) || []).length === 1 && (ctl.match(/getDateContext: turnDates/g) || []).length === 2);
    const srcs = ["src/services/query/queryChat.js", "src/services/query/followUp.js", "src/services/query/localRouter.js", "src/services/ai/tools.js", "src/services/ai/chatOrchestrator.js", "src/services/analytics/coverage.js"].map((f) => [f, fs.readFileSync(f, "utf8")]);
    const wall = srcs.filter(([, t]) => /new Date\(\)/.test(t.replace(/\/\/.*$/gm, "")));
    check("no `new Date()` (wall clock) in the AI query/legacy-chat/coverage code", wall.length === 0, wall.map(([f]) => f).join(","));

    // the SAME question -> the SAME boundaries through router/engine, legacy chat (prompt + tools) and the planner
    const anchors = [U(2026, 4, 30), U(2026, 3, 31), U(2024, 2, 29), U(2026, 4, 1), U(2025, 12, 8)];
    const QS = [
      ["sales this month", { tool: "get_sales_summary", args: { period: "current_month" } }],
      ["sales last month", { tool: "get_sales_summary", args: { period: "previous_month" } }],
      ["sales this month vs last month", { tool: "get_sales_comparison", args: { comparisonType: "vs_previous_month" } }],
      ["sales this month vs same month last year", { tool: "get_sales_comparison", args: { comparisonType: "vs_same_month_last_year" } }],
    ];
    const captured = [];
    const origSummary = salesAnalytics.getSalesSummary;
    const origCmp = salesAnalytics.getSalesComparison;
    salesAnalytics.getSalesSummary = async (t, period) => (captured.push({ cur: period }), { hasData: true, totalSales: 1 });
    salesAnalytics.getSalesComparison = async (t, current, previous) => (captured.push({ cur: current, prev: previous }), { hasData: true });
    let same = 0;
    const diffs = [];
    let promptOk = 0;
    for (const ref of anchors) {
      const dates = buildDateContext({ sales: { earliest: U(2020, 1, 1), latest: ref }, purchase: {} }, ref); // "today" = the anchor
      // legacy chat: one turn whose (fake) Claude calls the four tools; the handler resolves the periods itself
      captured.length = 0;
      let systemSeen = null;
      let step = 0;
      const claude = async (messages, defs, system) => {
        systemSeen = system;
        step += 1;
        if (step === 1) return { content: QS.map(([, t], i) => ({ type: "tool_use", id: `t${i}`, name: t.tool, input: t.args })) };
        return { content: [{ type: "text", text: "done" }] };
      };
      await handleChatTurn({ context: { tenantId: "SF-PURE" }, userMessage: "x", conversationHistory: [], claudeClient: claude, getDateContext: async () => dates });
      if (systemSeen && systemSeen[1].text.includes(`Today's date is ${ymd(dates.referenceDate)}`)) promptOk += 1;
      for (let i = 0; i < QS.length; i += 1) {
        const [q] = QS[i];
        const x = await route(q, dates.referenceDate);
        const v = validateQueryPlan(x.plan, { referenceDate: dates.referenceDate }).normalized;
        const legacy = captured[i];
        // the planner path: Claude's (scripted) plan is the router's plan; validated + executed with the turn's date
        const eng = fakeEngine();
        const planner = async () => ({ content: [{ type: "tool_use", id: "p", name: PLANNER_TOOL_NAME, input: { plan: x.plan } }], usage: { input_tokens: 1, output_tokens: 1 } });
        await tryAnswerWithQueryEngine({ context: { tenantId: "SF-PURE" }, userMessage: q.replace("sales", "turnover"), conversationHistory: [], deps: { resolveEntity: resolver, getFreshness: async () => ({ state: "fresh", dataAsOf: null, message: "ok" }), plannerClient: planner, execute: eng, getDateContext: async () => dates } });
        const pv = eng.calls.length ? validateQueryPlan(eng.calls[0].plan, { referenceDate: eng.calls[0].ctx.referenceDate }).normalized : null;
        const e = `${range(v.period)} / ${range(v.comparison)}`;
        const l = `${range(legacy.cur)} / ${legacy.prev ? range(legacy.prev) : "none"}`;
        const p = pv ? `${range(pv.period)} / ${range(pv.comparison)}` : "no plan";
        if (e === l && e === p && eng.calls[0].ctx.referenceDate.getTime() === dates.referenceDate.getTime()) same += 1;
        else diffs.push(`${ymd(ref)} "${q}": engine ${e} | legacy ${l} | planner ${p}`);
      }
    }
    salesAnalytics.getSalesSummary = origSummary;
    salesAnalytics.getSalesComparison = origCmp;
    check(`legacy chat's prompt "today" = the tenant reference date on every anchor (${promptOk}/${anchors.length})`, promptOk === anchors.length);
    check(`same question -> same boundaries via router/engine, legacy chat tools and the planner: ${same}/${anchors.length * QS.length} (month-end, 31 Mar, 29 Feb, FY start, mid-month)`, same === anchors.length * QS.length, diffs.slice(0, 3).join(" | "));
  }

  // =============================================================== B
  section("B. relative periods: router meaning + boundaries vs an independent calendar oracle");
  {
    const RP = [
      ["sales this month", "sales", "current_month", "none"], ["sales last month", "sales", "previous_month", "none"],
      ["sales mtd", "sales", "current_month", "none"], ["sales month to date", "sales", "current_month", "none"],
      ["sales previous month", "sales", "previous_month", "none"], ["sales this month vs last month", "sales", "current_month", "full_previous"],
      ["sales this month compared with last month", "sales", "current_month", "full_previous"], ["sales this month vs same month last year", "sales", "current_month", "same_period_last_year"],
      ["sales this month yoy", "sales", "current_month", "same_period_last_year"], ["sales this quarter", "sales", "current_quarter", "none"],
      ["sales last quarter", "sales", "previous_quarter", "none"], ["sales qtd", "sales", "current_quarter", "none"],
      ["sales this quarter vs last quarter", "sales", "current_quarter", "like_for_like"], ["sales this fy", "sales", "current_fy", "none"],
      ["sales last fy", "sales", "previous_fy", "none"], ["sales this financial year vs last financial year", "sales", "current_fy", "like_for_like"],
      ["sales fytd", "sales", "current_fy", "none"], ["sales this week", "sales", "current_week", "none"],
      ["sales last week", "sales", "previous_week", "none"], ["sales today", "sales", "today", "none"],
      ["sales yesterday", "sales", "yesterday", "none"], ["purchases this month", "purchase", "current_month", "none"],
      ["purchases last month vs the month before", "purchase", "previous_month", "like_for_like"], ["purchases this quarter vs same quarter last year", "purchase", "current_quarter", "same_period_last_year"],
      ["revenue last month", "sales", "previous_month", "none"], ["revenue this month vs last month", "sales", "current_month", "full_previous"],
      ["sales invoice count last month", "sales", "previous_month", "none"], ["sales last 7 days", "sales", "last_7_days", "none"],
      ["sales last 30 days", "sales", "last_30_days", "none"], ["sales last 90 days", "sales", "last_90_days", "none"],
      ["sales this month vs full last month", "sales", "current_month", "full_previous"], ["how much did we sell last month", "sales", "previous_month", "none"],
      ["what were purchases in the previous quarter", "purchase", "previous_quarter", "none"], ["sales this week vs last week", "sales", "current_week", "like_for_like"],
      // decision 2: explicit same-days wording keeps like-for-like; the reversed order is the same comparison
      ["sales this month vs same period last month", "sales", "current_month", "like_for_like"], ["sales mtd vs lmtd", "sales", "current_month", "like_for_like"],
      ["compare sales previous month vs current month", "sales", "current_month", "full_previous"], ["sales this month vs last month like for like", "sales", "current_month", "like_for_like"],
    ];
    const anchors = [new Date(2026, 3, 30), new Date(2026, 2, 31), new Date(2024, 1, 29), new Date(2026, 3, 1), new Date(2026, 0, 1), new Date(2025, 11, 8)];
    let meaning = 0;
    let bounds = 0;
    const bad = [];
    for (const [q, entity, kind, mode] of RP) {
      const x = await route(q);
      if (x.status === "supported" && x.plan.entity === entity && x.plan.period.kind === kind && (x.plan.compare ? x.plan.compare.mode : "none") === mode) meaning += 1;
      else { bad.push(`${q}: ${x.status}/${x.code} ${x.plan ? sig(x.plan) : ""}`); continue; }
      for (const ref of anchors) {
        const n = validateQueryPlan(x.plan, { referenceDate: ref }).normalized;
        const o = oracle(kind, mode, ref);
        if (range(n.period) === o.cur && range(n.comparison) === o.prev) bounds += 1;
        else bad.push(`${ymd(ref)} ${q}: engine ${range(n.period)} / ${range(n.comparison)} vs oracle ${o.cur} / ${o.prev}`);
      }
    }
    check(`relative-period meaning (entity, period, comparison) for ${RP.length} questions`, meaning === RP.length, bad.slice(0, 3).join(" | "));
    check(`engine boundaries = independent oracle: ${bounds}/${RP.length * anchors.length} (30 Apr, 31 Mar, 29 Feb, 1 Apr, 1 Jan, 8 Dec)`, bounds === RP.length * anchors.length, bad.slice(0, 3).join(" | "));
  }

  // =============================================================== C
  section("C. data coverage: covered / partial / outside (window 1 Apr 2025 - 8 Dec 2025, anchor 8 Dec 2025)");
  {
    const cls = (from, to) => classifyRange({ from: new Date(from), to: new Date(to) }, WINDOW.coverage);
    check("classifier: inside / before / after / straddling start / straddling end / unbounded / no history", cls("2025-05-01T00:00", "2025-05-31T23:59") === "covered" && cls("2025-01-01T00:00", "2025-01-31T23:59") === "before_history" && cls("2026-01-01T00:00", "2026-01-31T23:59") === "after_latest_data" && cls("2025-03-15T00:00", "2025-04-15T23:59") === "partly_before_history" && cls("2025-12-01T00:00", "2025-12-31T23:59") === "partly_after_latest_data" && classifyRange({}, WINDOW.coverage) === "unbounded" && classifyRange({ from: new Date(), to: new Date() }, { earliest: null, latest: null }) === "no_history");
    // [question, expected: covered | partial | outside:<subject|comparison>]
    const CQ = [
      ["Sales in January 2025 vs January 2024", "outside:subject_before_history"], ["Sales in April 2025 vs April 2024", "outside:comparison_before_history"],
      ["sales this month vs same month last year", "outside:comparison_before_history"], ["sales FY 2024-25", "outside:subject_before_history"],
      ["sales this fy vs last fy", "outside:comparison_before_history"], ["sales in March 2025", "outside:subject_before_history"],
      ["sales in January 2026", "outside:subject_after_latest_data"], ["sales for Aarav Traders in January 2025", "outside:subject_before_history"],
      ["customers who stopped buying this month vs same month last year", "outside:comparison_before_history"], ["new products sold in May 2025 vs March 2025", "outside:comparison_before_history"],
      ["purchases in February 2025", "outside:subject_before_history"], ["revenue in December 2024", "outside:subject_before_history"],
      ["top 5 customers by sales in 2025-01-01 to 2025-03-31", "outside:subject_before_history"], ["sales yoy this quarter", "outside:comparison_before_history"],
      ["sales from 2025-03-15 to 2025-04-15", "partial"], ["sales in December 2025", "partial"],
      ["sales from 2025-05-01 to 2025-05-31 vs 2025-03-20 to 2025-04-20", "partial"], ["sales in April 2025", "covered"],
      ["sales this month vs last month", "covered"], ["sales this quarter vs last quarter", "covered"],
      ["sales last 90 days", "covered"], ["new products sold this month", "covered"],
      ["Who bought less this month than last month?", "covered"], ["sales growth percentage this month vs last month", "covered"],
      ["top 10 customers by sales", "covered"], ["sales for Aarav Traders this month", "covered"],
      ["purchases last month vs the month before", "covered"], ["sales in November 2025 vs October 2025", "covered"],
      ["sales this fy", "covered"], ["customers whose sales grew by more than 20% this month vs last month", "covered"],
      ["sales in May 2025 vs April 2025", "covered"], ["sales from 2025-12-01 to 2025-12-31 vs 2025-11-01 to 2025-11-30", "partial"],
    ];
    let ok = 0;
    const bad = [];
    let refusedWithoutEngine = 0;
    let deterministic = 0;
    for (const [q, want] of CQ) {
      const eng = fakeEngine();
      const r = await askPure(q, { execute: eng });
      const meta = r.structured.details.queryEngine;
      const text = r.structured.answer;
      let got;
      if (meta.status === "outside_coverage") got = `outside:${meta.code}`;
      else if (meta.status === "answered") got = /Coverage: /.test(text) ? "partial" : "covered";
      else got = `${meta.status}/${meta.code}`;
      if (got === want) ok += 1;
      else bad.push(`${q}: ${got} (want ${want})`);
      if (want.startsWith("outside")) {
        if (eng.calls.length === 0 && meta.claudeCalls === 0 && /missing data, not zero|false zero baseline/.test(text)) refusedWithoutEngine += 1;
        const again = await askPure(q);
        if (again.structured.answer === text) deterministic += 1;
      }
      if (want === "partial" && !(r.structured.warnings || []).some((w) => /^Coverage: /.test(w))) bad.push(`${q}: partial caveat missing from warnings`);
    }
    const outside = CQ.filter(([, w]) => w.startsWith("outside")).length;
    check(`coverage outcome for ${CQ.length} questions (${outside} outside, ${CQ.filter(([, w]) => w === "partial").length} partial, ${CQ.filter(([, w]) => w === "covered").length} covered)`, ok === CQ.length && bad.length === 0, bad.slice(0, 4).join(" | "));
    check(`outside coverage: refused BEFORE the engine runs, saying the data is missing (not zero): ${refusedWithoutEngine}/${outside}`, refusedWithoutEngine === outside);
    check(`coverage messages are deterministic (identical on a second ask): ${deterministic}/${outside}`, deterministic === outside);
    const r = await askPure("Sales in April 2025 vs April 2024");
    check("comparison outside: names the missing range, the synced window and offers the subject alone", /1 Apr 2024 – 30 Apr 2024/.test(r.structured.answer) && /1 Apr 2025 – 8 Dec 2025/.test(r.structured.answer) && /on its own/.test(r.structured.answer) && r.structured.details.toolCalls[0].state === "no_usable_data", r.structured.answer);
    const cust = await askPure("sales for Aarav Traders in January 2025");
    check("a named customer outside coverage: 'no data', never 'no sales for Aarav Traders' / 'couldn't find'", /TallyPulse has no data for 1 Jan 2025 – 31 Jan 2025/.test(cust.structured.answer) && !/couldn.t find|no matching/i.test(cust.structured.answer));
    const noHist = await askPure("sales this month", { dates: buildDateContext({ sales: {}, purchase: {} }, new Date(2026, 8, 28)) });
    check("a tenant with no vouchers at all: honest 'no data yet', not a zero", /no synced Sales or Purchase vouchers/.test(noHist.structured.answer) && noHist.structured.details.queryEngine.status === "outside_coverage");
    const pure = assessCoverage({ entity: "purchase", period: { from: new Date(2025, 0, 1), to: new Date(2025, 0, 31, 23, 59) }, comparison: null, coverage: WINDOW.coverage });
    check("purchase wording: 'not zero purchases'", /not zero purchases/.test(pure.message));
  }

  // =============================================================== D
  section("D. \"who\": the party comes from the surrounding words (customer / supplier / product / group / clarify)");
  {
    const CM = (dir, per = "current_month", cmp = per === "current_month" ? "full_previous" : "like_for_like") => `sales:invoiceAmount|customer|${dir}|${cmp}|${per}`;
    const SP = (dir, per = "current_month", cmp = per === "current_month" ? "full_previous" : "like_for_like") => `purchase:purchaseAmount|supplier|${dir}|${cmp}|${per}`;
    const W = [
      ["Who bought less this month?", CM("down")], ["Who bought less this month than last month?", CM("down")],
      ["Which customers bought less this month?", CM("down")], ["Who purchased less than last month?", CM("down")],
      ["Which buyers declined this month vs last month?", CM("down")], ["Which customers reduced purchases this month?", CM("down")],
      ["Who stopped buying this month?", CM("lost")], ["Who bought more this month?", CM("up")],
      ["Who increased purchases this month?", CM("up")], ["Which customers increased sales this month?", CM("up")],
      ["Who contributed to the sales increase this month?", CM("up")], ["Who drove the decline in sales this month?", CM("down")],
      ["Which clients bought more this quarter than last quarter?", CM("up", "current_quarter")], ["who all bought less this month", CM("down")],
      ["who's buying less this month", CM("down")], ["Who bought less than last month, pls?", CM("down")],
      ["Who stopped buying from us this month vs last month?", CM("lost")], ["Whose sales fell this month?", CM("down")],
      ["Whose purchases went down this month?", CM("down")], ["Which customers purchased more this month vs last month?", CM("up")],
      ["Who did we sell more to this month?", CM("up")], ["Who did we sell less to this month than last month?", CM("down")],
      ["Which parties bought less this month?", CM("down")], ["Which buyers bought more this month?", CM("up")],
      ["Who are the customers that bought less this month?", CM("down")], ["Customers who bought less this month", CM("down")],
      ["Who had lower revenue this month than last month?", "sales:lineAmount|customer|down|full_previous|current_month"], ["Who had the highest sales this month?", CM("-", "current_month", "none")],
      ["Who bought the most this month?", CM("-", "current_month", "none")], ["who are my top 5 customers this month", `${CM("-", "current_month", "none")}|L5`],
      ["Which customers drove the increase this month?", CM("up")], ["hi, who bought less this month vs last month? thanks", CM("down")],
      ["Who did we buy less from this month?", SP("down")], ["From whom did we purchase more this month than last month?", SP("up")],
      ["Who supplied us less this month?", SP("down")], ["Who sold us more this month vs last month?", SP("up")],
      ["Which suppliers did we buy less from this month?", SP("down")], ["Which vendors sold us less this month?", SP("down")],
      ["Who did we buy the most from this month?", SP("-", "current_month", "none")], ["who did we purchase less from last month compared to the month before", SP("down", "previous_month")],
      ["parties with lower purchases this month", SP("down")],
      ["Which products sold less this month?", "sales:lineAmount|product|down|full_previous|current_month"], ["Which product groups sold more this month vs last month?", "sales:lineAmount|productGroup|up|full_previous|current_month"],
      ["Which goods sold more this month?", "sales:lineAmount|product|up|full_previous|current_month"], ["Which categories sold less this quarter vs last quarter?", "sales:lineAmount|productGroup|down|like_for_like|current_quarter"],
      ["Which stock groups grew in sales this month?", "sales:lineAmount|productGroup|up|full_previous|current_month"], ["Which products sold the most this month?", "sales:lineAmount|product|-|none|current_month"],
      // still ambiguous or unanswerable: an honest clarification/refusal, never a guess and never a name lookup
      ["Who sold the most this month?", "needs_planner/who_ambiguous"], ["Who grew this month?", "needs_planner/who_ambiguous"],
      ["Who declined in purchases this month?", CM("down")], ["Who is growing?", "needs_planner/who_ambiguous"],
      ["Who drove the decline?", "needs_planner/who_ambiguous"], ["Who had the lowest purchases this month?", "needs_planner/who_ambiguous"], ["Who sold less this month?", "needs_planner/who_ambiguous"],
      ["Who stopped buying?", "needs_planner/period_missing"], ["Who bought more?", "needs_planner/period_missing"],
      ["Which buyers declined?", "needs_planner/period_missing"], ["Who bought for the first time this month?", "unsupported/unsupported_first_purchase"],
      ["Who came back this month?", "unsupported/unsupported_reactivation"], ["Who is doing better this month?", "needs_planner/vague_performance"],
    ];
    const bad = [];
    let lookups = 0;
    const spyResolver = async (a) => ((lookups += 1), resolver(a));
    for (const [q, want] of W) {
      const x = await routeQuestion(q, { resolveEntity: spyResolver, referenceDate: REF });
      const got = x.plan ? sig(x.plan) : `${x.status}/${x.code}`;
      if (got !== want) bad.push(`${q}: ${got} (want ${want})`);
    }
    check(`"who" semantics (entity, dimension, metric, direction, period, comparison) for ${W.length} questions`, bad.length === 0, bad.slice(0, 4).join(" | "));
    check("no \"who\" question looked a word up as a customer/product name (no false 'couldn't find that name')", lookups === 0, String(lookups));
    const x = await route("Who bought less this month than last month?");
    check("the audit's silent misread is gone: 'Who bought less ...' = customers (sales), with the reading stated", x.plan.entity === "sales" && x.plan.groupBy[0].dim === "customer" && x.assumptions.some((a) => a.code === "who_read_as_customers"));
    const y = await route("Which customers reduced purchases this month?");
    check("'customers ... purchases' is their buying (our sales), and the answer says so", y.plan.entity === "sales" && y.assumptions.some((a) => a.code === "customer_buying_is_sales"));
    const z = await route("Who sold us more this month vs last month?");
    check("'sold us' is our purchases from suppliers, and the answer says so", z.plan.entity === "purchase" && z.assumptions.some((a) => a.code === "supplier_selling_is_purchases"));
    const c = await route("Who contributed to the sales increase this month?");
    check("'who contributed/drove': ranked by change in amount, stated as arithmetic contribution, not a cause", c.assumptions.some((a) => a.code === "contribution_is_change") && c.plan.sort[0].by === "invoiceAmount.delta");
    const r = await route("What drove the sales increase this month?");
    check("'what drove ...' (no party) stays a request for a cause, not a breakdown", r.status !== "supported");
  }

  // =============================================================== E
  section("E. growth and percentages: total %, grouped %, ranking by % (refused), thresholds, share, direction");
  {
    const T = (per = "current_month", cmp = per === "current_month" ? "full_previous" : "like_for_like", e = "sales:invoiceAmount") => `${e}|total|-|${cmp}|${per}`;
    const G = [
      ["Sales growth percentage this month vs last month", T()], ["What is the % change in sales this month vs last month?", T()],
      ["sales growth % this month", T()], ["Purchases growth percentage this quarter vs last quarter", T("current_quarter", "like_for_like", "purchase:purchaseAmount")],
      ["Revenue growth % this quarter vs last quarter", T("current_quarter", "like_for_like", "sales:lineAmount")], ["percentage change in sales this fy vs last fy", T("current_fy")],
      ["sales growth rate this month vs last month", T()], ["how much did sales grow in percentage terms this month vs last month", T()],
      ["% growth in purchases this month vs same month last year", T("current_month", "same_period_last_year", "purchase:purchaseAmount")], ["sales yoy growth % this month", T("current_month", "same_period_last_year")],
      ["MoM sales growth % this month", T()], ["sales change % last month vs the month before", T("previous_month")],
      ["sales growth vs last year this month", T("current_month", "same_period_last_year")], ["how did sales change this month vs last month", T()],
      ["difference in purchases this month vs last month", T("current_month", "full_previous", "purchase:purchaseAmount")], ["sales variance this quarter vs last quarter", T("current_quarter")],
      ["sales growth this month vs last month", T()],
      ["sales growth % by customer this month vs last month", "sales:invoiceAmount|customer|-|full_previous|current_month"], ["percentage change in sales by product this month vs last month", "sales:lineAmount|product|-|full_previous|current_month"],
      ["purchase growth % by supplier this quarter vs last quarter", "purchase:purchaseAmount|supplier|-|like_for_like|current_quarter"], ["revenue growth % by product group this month vs last month", "sales:lineAmount|productGroup|-|full_previous|current_month"],
      ["customer growth this month", "sales:invoiceAmount|customer|up|full_previous|current_month"], ["which customers grew this month vs last month", "sales:invoiceAmount|customer|up|full_previous|current_month"],
      ["top 10 customers by growth this month vs last month", "sales:invoiceAmount|customer|up|full_previous|current_month|L10"],
      ["Which customers grew by more than 20% this month?", "sales:invoiceAmount|customer|pct>20|full_previous|current_month"], ["customers whose sales grew by more than 20% this month vs last month", "sales:invoiceAmount|customer|pct>20|full_previous|current_month"],
      ["customers with growth above 20% this month", "sales:invoiceAmount|customer|pct>20|full_previous|current_month"], ["products whose sales fell by more than 10% this month vs last month", "sales:lineAmount|product|pct<-10|full_previous|current_month"],
      ["suppliers whose purchases grew by more than 15% this quarter vs last quarter", "purchase:purchaseAmount|supplier|pct>15|like_for_like|current_quarter"], ["customers with sales up over 25 percent this month vs last month", "sales:invoiceAmount|customer|pct>25|full_previous|current_month"],
      ["which customers declined by at least 30% this month", "sales:invoiceAmount|customer|pct<-30|full_previous|current_month"], ["customers whose sales dropped more than 50% vs last month", "sales:invoiceAmount|customer|pct<-50|full_previous|current_month"],
      ["Which customers have the highest growth percentage this month?", "unsupported/unsupported_growth_rate"], ["Top 10 customers by growth % this month vs last month", "unsupported/unsupported_growth_rate"],
      ["fastest growing customers this quarter", "unsupported/unsupported_growth_rate"], ["Which products grew the fastest this month?", "unsupported/unsupported_growth_rate"],
      ["customers ranked by % growth this month vs last month", "unsupported/unsupported_growth_rate"], ["Which supplier has the biggest percentage increase this month vs last month?", "unsupported/unsupported_growth_rate"],
      ["Bottom 5 products by % change this month vs last month", "unsupported/unsupported_growth_rate"], ["Which customers grew the most in percentage terms this month vs last month?", "unsupported/unsupported_growth_rate"],
      ["highest growth rate customers this fy vs last fy", "unsupported/unsupported_growth_rate"], ["quickest growing product groups this month", "unsupported/unsupported_growth_rate"],
      ["customers whose sales changed by more than 20% this month", "needs_planner/threshold_direction_missing"], ["customers with a sales variance above 10% this month vs last month", "needs_planner/threshold_direction_missing"],
      ["customers who bought less than 20% last month", "needs_planner/unsupported_threshold"],
      ["What % of sales came from Aarav Traders this month?", "unsupported/unsupported_share_of_total"], ["share of sales by customer this month", "unsupported/unsupported_share_of_total"],
      ["What percentage of purchases were from Crescent Supplies last month?", "unsupported/unsupported_share_of_total"],
      ["monthly sales growth % this fy", "unsupported/unsupported_growth_pattern"], ["customers growing every month", "unsupported/unsupported_growth_pattern"],
    ];
    const bad = [];
    for (const [q, want] of G) {
      const x = await route(q);
      const got = x.plan ? sig(x.plan) : `${x.status}/${x.code}`;
      if (got !== want) bad.push(`${q}: ${got} (want ${want})`);
    }
    check(`growth/% semantics for ${G.length} questions`, bad.length === 0, bad.slice(0, 4).join(" | "));
    const g = await route("sales growth % by customer this month vs last month");
    check("grouped %: rows are NOT silently ranked by % - ordered by amount, and the answer says so", g.plan.sort[0].by === "invoiceAmount" && g.assumptions.some((a) => a.code === "pct_shown_not_ranked"));
    // formatter: zero baseline and null deltaPct are explained, never 0% or infinite
    const plan = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount"], filters: [], compare: { mode: "like_for_like" } };
    const res = (prev, pct) => ({ ok: true, metrics: ["invoiceAmount"], period: { label: "Month to date" }, comparison: { label: "Same date range, previous month" }, amountBasis: {}, rows: [], totals: { values: { invoiceAmount: 500 }, comparison: { invoiceAmount: { previous: prev, delta: 500 - prev, deltaPct: pct } } }, warnings: [], assumptions: [] });
    const zero = formatQueryAnswer({ plan, result: res(0, null) }).text;
    const normal = formatQueryAnswer({ plan, result: res(400, 25) }).text;
    check("total % against a zero baseline: 'n/a: the comparison value is zero' (never 0% or infinite)", /% change n\/a: the comparison value is zero/.test(zero) && !/Infinity|NaN/.test(zero), zero);
    check("total % normal case: +25.0%", /\+25\.0%/.test(normal));
    const gp = { ...plan, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] };
    const rowsRes = { ...res(0, null), groupBy: [{ dim: "customer" }], totals: null, rows: [{ key: { customer: "Cedar Stores" }, values: { invoiceAmount: 826 }, comparison: { invoiceAmount: { previous: 0, delta: 826, deltaPct: null } }, presence: "current_only" }, { key: { customer: "Aarav Traders" }, values: { invoiceAmount: 1298 }, comparison: { invoiceAmount: { previous: 1652, delta: -354, deltaPct: -21.43 } }, presence: "both" }] };
    const rt = formatQueryAnswer({ plan: gp, result: rowsRes }).text;
    check("grouped rows: null deltaPct explained + flagged 'no activity in the comparison period'; others show their %", /Cedar Stores .*% change n\/a: the comparison value is zero\).*no activity in the comparison period/.test(rt) && /Aarav Traders .*-21\.4%/.test(rt), rt);
  }

  // =============================================================== F
  section("F. new / reactivated / lost: only the definitions the data supports, each one stated");
  {
    const N = [
      // decision 3: a new customer/supplier = Tally ledger created in the period (LedgerMaster) -> new_in_period, no comparison
      ["new customers this month", "sales:invoiceAmount|customer|-|none|current_month|customer=period"], ["Who became a new customer this month?", "sales:invoiceAmount|customer|-|none|current_month|customer=period"],
      ["which customers are new this quarter vs last quarter", "sales:invoiceAmount|customer|-|none|current_quarter|customer=period"], ["new suppliers this month", "purchase:purchaseAmount|supplier|-|none|current_month|supplier=period"],
      ["new products sold this quarter vs last quarter", "sales:lineAmount|product|new|like_for_like|current_quarter"], ["new customers this month vs same month last year", "sales:invoiceAmount|customer|-|none|current_month|customer=period"], ["new products sold this month", "sales:lineAmount|product|new|full_previous|current_month"],
      ["customers we lost this month vs last month", "sales:invoiceAmount|customer|lost|full_previous|current_month"], ["Which customers went inactive this month?", "sales:invoiceAmount|customer|lost|full_previous|current_month"],
      ["lost customers this quarter vs last quarter", "sales:invoiceAmount|customer|lost|like_for_like|current_quarter"], ["customers who became inactive this month vs last month", "sales:invoiceAmount|customer|lost|full_previous|current_month"],
      ["dormant customers this month", "sales:invoiceAmount|customer|lost|full_previous|current_month"], ["customers who stopped buying this quarter", "sales:invoiceAmount|customer|lost|like_for_like|current_quarter"],
      ["suppliers we stopped buying from this month", "purchase:purchaseAmount|supplier|lost|full_previous|current_month"], ["Who stopped buying this month?", "sales:invoiceAmount|customer|lost|full_previous|current_month"],
      ["First time customers this month", "unsupported/unsupported_first_purchase"], ["brand new customers this month", "unsupported/unsupported_first_purchase"],
      ["customers who never bought before this month", "unsupported/unsupported_first_purchase"], ["customers making their first ever purchase this quarter", "unsupported/unsupported_first_purchase"],
      ["returning customers this quarter", "unsupported/unsupported_reactivation"], ["customers won back this month", "unsupported/unsupported_reactivation"],
      ["Reactivated customers this quarter", "unsupported/unsupported_reactivation"], ["Which customers came back this month after being inactive?", "unsupported/unsupported_reactivation"],
      ["new customers", "needs_planner/period_missing"], ["lost customers", "needs_planner/period_missing"],
    ];
    const bad = [];
    let notes = 0;
    let supported = 0;
    for (const [q, want] of N) {
      const x = await route(q);
      const got = x.plan ? sig(x.plan) : `${x.status}/${x.code}`;
      if (got !== want) bad.push(`${q}: ${got} (want ${want})`);
      if (x.plan) {
        supported += 1;
        const code = /=period$/.test(got) ? "new_party_by_ledger_created_date" : /\|new\|/.test(got) ? "new_means_absent_in_comparison" : "lost_means_absent_in_period";
        if (x.assumptions.some((a) => a.code === code)) notes += 1;
      }
    }
    check(`new/reactivated/lost semantics for ${N.length} questions`, bad.length === 0, bad.slice(0, 4).join(" | "));
    check(`every answered new/lost question states its definition (absent in the comparison / this period): ${notes}/${supported}`, notes === supported && supported > 0);
    // Decision 3 (tests 10-12, behaviour level): "new" = ledger created in the period; never labelled "new" by absence
    const np = await route("new customers this month");
    check("'new customers' reads the ledger master (new_in_period), not the comparison-period absence", np.status === "supported" && np.plan.filters.some((f) => f.op === "new_in_period") && !np.plan.compare, np.status + "/" + np.code);
    const fu = await askPure("new customers?", { history: [{ role: "user", content: "Show sales this month" }, { role: "assistant", content: "x" }], previousQuery: (await askPure("Show sales this month")).queryContext });
    check("...also as a follow-up ('new customers?') - never answered with the comparison-period reading", fu.handled && fu.structured.details.queryEngine.code === "unsupported_new_party" && /ledger was created in the period/.test(fu.structured.answer));
    const planNew = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount"], filters: [], groupBy: [{ dim: "customer" }], compare: { mode: "full_previous" }, having: [{ metric: "invoiceAmount.previous", op: "eq", value: 0 }, { metric: "invoiceAmount", op: "gt", value: 0 }], sort: [{ by: "invoiceAmount", dir: "desc" }] };
    const pn = await planQuestion("which customers are first-timers this month", { claudeClient: async () => ({ content: [{ type: "tool_use", id: "p", name: PLANNER_TOOL_NAME, input: { plan: planNew } }], usage: {} }), resolveEntity: resolver });
    check("...and a Claude plan with the 'absent in the comparison period' shape is refused server-side (Claude never decides 'new')", pn.status === "unsupported" && pn.code === "unsupported_new_party" && !pn.plan);
    // a tenant whose item is literally named "New" (seen on real data): the refusal still wins, no Claude call
    const withNew = createEntityResolver({ tenantId: "SF-NEW-ITEM", sources: { customer: async () => ["Aarav Traders"], supplier: async () => [], product: async () => ["New"], productGroup: async () => [] } });
    const nn = await routeQuestion("new customers this month", { resolveEntity: withNew, entityIndex: withNew.spanIndex, referenceDate: REF });
    check("a tenant item named 'New' does not turn 'new customers this month' into a planner call (ledger-master reading stays final)", nn.status === "supported" && nn.plan.filters.some((f) => f.op === "new_in_period"));
    const u = await route("returning customers this quarter");
    check("reactivated/first-ever: a final honest answer naming what CAN be asked (no planner, no guess)", u.status === "unsupported" && /full purchase history/.test(u.reason) && /customers who stopped buying this month vs last month/.test(u.reason));
  }

  // =============================================================== G
  section("G. follow-up context through the real chat entry point (context carried exactly like the controller)");
  {
    const conversations = [
      ["Show sales this month", [["by customer", "sales:invoiceAmount|customer|-|none|current_month"], ["top 5", "sales:invoiceAmount|customer|-|none|current_month|L5"], ["what about last month?", "sales:invoiceAmount|customer|-|none|previous_month|L5"], ["and products?", "sales:lineAmount|product|-|none|previous_month|L5"]]],
      ["Show sales this month vs last month", [["top 10", "needs_clarification/followup_needs_dimension"], ["what about products?", "sales:lineAmount|product|-|full_previous|current_month"], ["only the ones that declined", "sales:lineAmount|product|down|full_previous|current_month"], ["by customer", "sales:invoiceAmount|customer|down|full_previous|current_month"]]],
      ["Show customer growth this month", [["only above 20%", "sales:invoiceAmount|customer|pct>20|full_previous|current_month"], ["what about last quarter?", "sales:invoiceAmount|customer|pct>20|like_for_like|previous_quarter"], ["and suppliers?", "purchase:purchaseAmount|supplier|pct>20|like_for_like|previous_quarter"]]],
      ["Show sales this FY", [["compare with last FY", "sales:invoiceAmount|total|-|like_for_like|current_fy"], ["by product group", "sales:lineAmount|productGroup|-|like_for_like|current_fy"], ["only growth above 10%", "sales:lineAmount|productGroup|pct>10|like_for_like|current_fy"]]],
      ["Show revenue this month", [["by product group", "sales:lineAmount|productGroup|-|none|current_month"], ["vs last month", "sales:lineAmount|productGroup|-|full_previous|current_month"], ["and by customer?", "sales:lineAmount|customer|-|full_previous|current_month"]]],
      ["Show purchases last month", [["which suppliers?", "purchase:purchaseAmount|supplier|-|none|previous_month"], ["top 3", "purchase:purchaseAmount|supplier|-|none|previous_month|L3"], ["compared with the month before", "purchase:purchaseAmount|supplier|-|like_for_like|previous_month|L3"], ["which declined?", "purchase:purchaseAmount|supplier|down|like_for_like|previous_month|L3"]]],
      ["sales last month", [["and purchases?", "purchase:purchaseAmount|total|-|none|previous_month"], ["by supplier", "purchase:purchaseAmount|supplier|-|none|previous_month"], ["what about sales?", "sales:invoiceAmount|customer|-|none|previous_month"]]],
      ["top 5 customers by sales this month", [["same for last month", "sales:invoiceAmount|customer|-|none|previous_month|L5"], ["vs the same month last year", "sales:invoiceAmount|customer|-|same_period_last_year|previous_month|L5"], ["which of them grew?", "sales:invoiceAmount|customer|up|same_period_last_year|previous_month|L5"]]],
      ["sales for Aarav Traders this month", [["and last month?", "sales:invoiceAmount|total|-|none|previous_month|customer=Aarav Traders"], ["what about Bluebell Mart?", "sales:invoiceAmount|total|-|none|previous_month|customer=Bluebell Mart"], ["compare with the month before", "sales:invoiceAmount|total|-|like_for_like|previous_month|customer=Bluebell Mart"]]],
      ["Which customers grew this quarter vs last quarter?", [["and products?", "sales:lineAmount|product|up|like_for_like|current_quarter"], ["only more than 25%", "sales:lineAmount|product|pct>25|like_for_like|current_quarter"], ["what about this month", "sales:lineAmount|product|pct>25|full_previous|current_month"]]],
      ["Show sales this month vs last month", [["and by customer?", "sales:invoiceAmount|customer|-|full_previous|current_month"]]],
      ["revenue last quarter", [["and quantity?", "sales:quantity|total|-|none|previous_quarter"], ["by product", "sales:quantity|product|-|none|previous_quarter"]]],
      ["purchases this month", [["how many invoices?", "purchase:purchaseInvoiceCount|total|-|none|current_month"]]],
      ["Show sales this month vs last month", [["why?", "LEGACY"], ["GST?", "unsupported/unsupported_capability"]]],
      ["sales this month", [["new customers?", "needs_clarification/unsupported_new_party"], ["and lost customers?", "sales:invoiceAmount|customer|lost|full_previous|current_month"]]],
      ["sales last month", [["and customers who bought less", "sales:invoiceAmount|customer|down|like_for_like|previous_month"]]],
      ["Who bought less this month than last month?", [["what about suppliers?", "purchase:purchaseAmount|supplier|down|full_previous|current_month"]]],
    ];
    const bad = [];
    let followUps = 0;
    let exact = 0;
    let legacy = 0;
    let notesOk = 0;
    let merged = 0;
    const eng = fakeEngine();
    // history from 2023, so "compare with last FY" is covered (coverage refusals are section C's job)
    const WIDE = buildDateContext({ sales: { earliest: U(2023, 4, 1), latest: U(2025, 12, 8) }, purchase: {} }, new Date(2025, 11, 8, 12)); // today = 8 Dec 2025
    for (const [first, turns] of conversations) {
      const history = [];
      let prev = null;
      for (const [q, want] of [[first, null], ...turns]) {
        const before = eng.calls.length;
        const out = await askPure(q, { dates: WIDE, history: [...history], previousQuery: prev && prev.queryContext ? prev.queryContext : null, execute: eng });
        const planned = eng.calls.length > before ? eng.calls[eng.calls.length - 1].plan : null;
        const meta = out.handled ? out.structured.details.queryEngine : null;
        const got = !out.handled ? "LEGACY" : planned ? sig(planned) : `${meta.status}/${meta.code}`;
        if (want) {
          followUps += 1;
          if (got === want) exact += 1;
          else bad.push(`[${first}] "${q}": ${got} (want ${want})`);
          if (!out.handled) legacy += 1;
          if (meta && meta.route === "follow_up" && meta.status === "answered") {
            merged += 1;
            if (/Follow-up to your previous question: kept the [^;]+; changed: /.test(out.structured.answer)) notesOk += 1;
          }
        }
        prev = out;
        history.push({ role: "user", content: q }, { role: "assistant", content: out.handled ? out.structured.answer : "(legacy)" });
      }
    }
    check(`follow-ups: ${exact}/${followUps} keep the previous measure/period/comparison and change only what they name`, exact === followUps && followUps >= 40, bad.slice(0, 4).join(" | "));
    check(`every merged follow-up states what it kept and what it changed: ${notesOk}/${merged}`, notesOk === merged && merged > 0);
    check(`only the unanswerable follow-up ("why?") reaches history-aware legacy chat: ${legacy}`, legacy === 1);
    const plannerCalls = [];
    const planner = async (req) => (plannerCalls.push(req), { content: [{ type: "tool_use", id: "p", name: PLANNER_TOOL_NAME, input: { decline: { code: "needs_clarification", message: "x" } } }], usage: {} });
    const s1 = await askPure("Show sales this month vs last month", { plannerClient: planner });
    await askPure("and by customer?", { history: [{ role: "user", content: "Show sales this month vs last month" }, { role: "assistant", content: s1.structured.answer }], previousQuery: s1.queryContext, plannerClient: planner });
    check("follow-ups never call Claude, and the stored plan is never part of what Claude could see", plannerCalls.length === 0 && Object.keys(s1).join(",") === "handled,structured" && !JSON.stringify(s1.structured).includes("queryContext"));
    // continuation without a usable previous plan: never answered stand-alone
    const noCtx = await askPure("and by customer?", { history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] });
    check("a continuation ('and by customer?') with no stored plan is NOT answered as all-time sales by customer (goes to history-aware legacy chat)", noCtx.handled === false && noCtx.reason === "follow_up_uses_legacy_chat");
    const selfC = await askPure("purchases last quarter", { history: [{ role: "user", content: "Show sales this month" }, { role: "assistant", content: "x" }], previousQuery: s1.queryContext });
    check("a self-contained new question after an answer is answered on its own terms (not merged)", eng.calls.length > 0 && selfC.structured.details.queryEngine.route === "router");
  }

  // =============================================================== H
  section("H. month comparisons (decision 2): this month to date vs the COMPLETE previous month; same days only when asked");
  {
    // "today" = the given day; history from 2023 so every comparison is covered
    const at = (y, m, d) => buildDateContext({ sales: { earliest: U(2023, 4, 1), latest: U(y, m, d) }, purchase: {} }, new Date(y, m - 1, d, 12));
    const resolved = async (q, dates) => {
      const eng = fakeEngine();
      const r = await askPure(q, { dates, execute: eng });
      if (!eng.calls.length) return { r, cur: "none", prev: "none" };
      const n = validateQueryPlan(eng.calls[0].plan, { referenceDate: eng.calls[0].ctx.referenceDate }).normalized;
      return { r, cur: range(n.period), prev: range(n.comparison), mode: eng.calls[0].plan.compare && eng.calls[0].plan.compare.mode };
    };
    // test 5: the product decision's own example
    const ex = await resolved("Compare sales previous month vs current month", at(2026, 9, 28));
    check("(5) 28-Sep-2026 'Compare sales previous month vs current month': current 1-Sep..28-Sep, previous 1-Aug..31-Aug", ex.cur === "2026-09-01..2026-09-28" && ex.prev === "2026-08-01..2026-08-31", `${ex.cur} vs ${ex.prev}`);
    check("...and both ranges are visible in the answer", /1 Sept? 2026 – 28 Sept? 2026/.test(ex.r.structured.answer) && /1 Aug 2026 – 31 Aug 2026/.test(ex.r.structured.answer), ex.r.structured.answer);
    for (const q of ["this month vs last month", "sales growth over last month", "Sales this month vs last month"]) {
      const x = await resolved(q.startsWith("sales") || q.startsWith("Sales") ? q : "sales " + q, at(2026, 9, 28));
      check("(5) 28-Sep-2026 '" + q + "': 1-Sep..28-Sep vs the complete August, the default stated", x.cur === "2026-09-01..2026-09-28" && x.prev === "2026-08-01..2026-08-31" && /compared with the complete previous month/.test(x.r.structured.answer), `${x.cur} vs ${x.prev}`);
    }
    // test 6: month-ends (the current month is complete on its last day; the previous one is always complete)
    const ends = [[2026, 3, 31, "2026-03-01..2026-03-31", "2026-02-01..2026-02-28"], [2026, 4, 30, "2026-04-01..2026-04-30", "2026-03-01..2026-03-31"], [2026, 5, 31, "2026-05-01..2026-05-31", "2026-04-01..2026-04-30"], [2026, 6, 30, "2026-06-01..2026-06-30", "2026-05-01..2026-05-31"], [2026, 7, 31, "2026-07-01..2026-07-31", "2026-06-01..2026-06-30"], [2026, 8, 31, "2026-08-01..2026-08-31", "2026-07-01..2026-07-31"], [2026, 9, 30, "2026-09-01..2026-09-30", "2026-08-01..2026-08-31"], [2026, 10, 31, "2026-10-01..2026-10-31", "2026-09-01..2026-09-30"], [2026, 11, 30, "2026-11-01..2026-11-30", "2026-10-01..2026-10-31"], [2026, 12, 31, "2026-12-01..2026-12-31", "2026-11-01..2026-11-30"], [2027, 1, 31, "2027-01-01..2027-01-31", "2026-12-01..2026-12-31"], [2027, 2, 28, "2027-02-01..2027-02-28", "2027-01-01..2027-01-31"], [2024, 2, 29, "2024-02-01..2024-02-29", "2024-01-01..2024-01-31"], [2024, 3, 1, "2024-03-01..2024-03-01", "2024-02-01..2024-02-29"]];
    const endBad = [];
    let noteless = 0;
    for (const [y, m, d, cur, prev] of ends) {
      const x = await resolved("sales this month vs last month", at(y, m, d));
      if (x.cur !== cur || x.prev !== prev) endBad.push(`${y}-${m}-${d}: ${x.cur} vs ${x.prev}`);
      if (!/is complete .* but is compared with the same days/.test(x.r.structured.answer)) noteless += 1;
    }
    check(`(6) month-ends (31 Mar, 30 Apr, 31 May, 30 Jun, 31 Jul, 31 Aug, 30 Sep ... 29 Feb, 1 Mar): this month vs the complete previous month on all ${ends.length}`, endBad.length === 0 && noteless === ends.length, endBad.join(" | "));
    // test 7: explicit same-period / same-day-count / like-for-like / full wording keeps its meaning
    const explicit = [
      ["sales this month vs same period last month", at(2026, 9, 28), "like_for_like", "2026-08-01..2026-08-28"],
      ["sales this month vs the same days last month", at(2026, 9, 28), "like_for_like", "2026-08-01..2026-08-28"],
      ["sales this month vs last month like for like", at(2026, 9, 28), "like_for_like", "2026-08-01..2026-08-28"],
      ["sales mtd vs lmtd", at(2026, 9, 28), "like_for_like", "2026-08-01..2026-08-28"],
      ["sales this month vs same number of days last month", at(2026, 9, 28), "like_for_like", "2026-08-01..2026-08-28"],
      ["sales this month vs full last month", at(2026, 9, 28), "full_previous", "2026-08-01..2026-08-31"],
      ["sales this month vs same month last year", at(2026, 9, 28), "same_period_last_year", "2025-09-01..2025-09-28"],
      ["sales from 2026-08-01 to 2026-08-15 vs 2026-07-01 to 2026-07-15", at(2026, 9, 28), "custom", "2026-07-01..2026-07-15"],
    ];
    const exBad = [];
    for (const [q, dates, mode, prev] of explicit) {
      const x = await resolved(q, dates);
      if (x.mode !== mode || x.prev !== prev) exBad.push(`${q}: ${x.mode} ${x.prev}`);
    }
    check(`(7) explicit same-period / same-day-count / full / same-month-last-year / literal ranges keep their explicit meaning (${explicit.length})`, exBad.length === 0, exBad.join(" | "));
    // other units keep like-for-like (decision 2 is about months); a complete period vs a shorter baseline is disclosed
    const q = await resolved("sales this quarter vs last quarter", at(2026, 6, 30));
    check("quarters unchanged (like-for-like): 30 Jun quarter vs 1 Jan..30 Mar, with the complete-period disclosure", q.mode === "like_for_like" && q.prev === "2026-01-01..2026-03-30" && /is complete .* but is compared with the same days/.test(q.r.structured.answer));
    const same = await resolved("sales this month vs same period last month", at(2026, 4, 30));
    check("explicit same days at a month-end: 1-30 Apr vs 1-30 Mar, disclosed with how to get complete months", same.prev === "2026-03-01..2026-03-30" && /1 Mar 2026 – 31 Mar 2026/.test(same.r.structured.answer) && /vs full last month/.test(same.r.structured.answer));
  }

  // =============================================================== I
  section("I. synthetic tenant (real MongoDB + real engine) vs an independent oracle");
  await syntheticTenant();

  // =============================================================== J
  section("J. safety");
  {
    const all = [];
    for (const q of ["Who bought less this month?", "Sales growth percentage this month vs last month", "new products sold this month", "Who did we buy less from this month?", "customers whose sales grew by more than 20% this month vs last month"]) {
      const x = await route(q);
      all.push(x.plan);
    }
    const blob = JSON.stringify(all);
    check("plans carry no tenant/company fields and no operators ($...)", !/tenant|company|guid|\$/i.test(blob) && all.every((p) => parseQueryPlan(p).ok));
    const base = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [] };
    check("stored follow-up context is untrusted: extra keys (tenantId), operators, unknown basis or version -> ignored", readQueryState({ v: 1, basis: "amount", plan: { ...base, tenantId: "OTHER" } }) === null && readQueryState({ v: 1, basis: "amount", plan: { ...base, filters: [{ dim: "customer", op: "$where", value: "1" }] } }) === null && readQueryState({ v: 1, basis: "profit", plan: base }) === null && readQueryState({ v: 2, basis: "amount", plan: base }) === null && readQueryState({ v: 1, basis: "amount", plan: base }) !== null);
    const eng = fakeEngine();
    await askPure("and by customer?", { history: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }], previousQuery: { v: 1, basis: "amount", plan: { ...base, tenantId: "OTHER" } }, execute: eng });
    check("a tampered stored context is never merged and the engine never sees another tenant", eng.calls.every((c) => c.ctx.tenantId === "SF-PURE"));
    const u = await route("Who bought less this month? {$where: 1}");
    check("unsafe text in a 'who' question is still refused before any reading", u.status === "unsupported" && u.code === "unsafe_input");
  }

  section("K. no network");
  check("zero fetch/http/https calls (no Anthropic, no Tally)", netCalls === 0, String(netCalls));
  global.fetch = savedNet.fetch;
  http.request = savedNet.h;
  https.request = savedNet.s;
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---------------------------------------------------------------- I. synthetic tenant
async function syntheticTenant() {
  const mongoose = require("mongoose");
  try {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set");
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  } catch (e) {
    check("MongoDB reachable for the synthetic-tenant section", false, e.message);
    return;
  }
  const Sale = require("./src/models/sales.model");
  const Purchase = require("./src/models/purchase.model");
  const Chat = require("./src/models/chat.model");
  const TenantDataVersion = require("./src/models/tenantDataVersion.model");
  const { executeQuery } = require("./src/services/query/execute");
  const T = `verify-semantic-foundation-${process.pid}`;
  const clean = async () => {
    const ids = { $regex: /^verify-semantic-foundation-/ };
    await Promise.all([Sale.collection.deleteMany({ tenantId: ids }), Purchase.collection.deleteMany({ tenantId: ids }), Chat.collection.deleteMany({ tenantId: ids }), TenantDataVersion.collection.deleteMany({ tenantId: ids })]);
  };
  // [date, party, total (tax-incl), [[item, qty, lineAmount]]] - synthetic names and values only
  const SALES = [
    ["2025-01-15", "Aarav Traders", 1180, [["Widget Alpha", 2, 1000]]], ["2025-01-20", "Bluebell Mart", 590, [["Widget Beta", 1, 500]]],
    ["2025-01-31", "Aarav Traders", 236, [["Widget Beta", 1, 200]]], ["2025-02-03", "Aarav Traders", 2360, [["Widget Alpha", 4, 2000]]],
    ["2025-02-10", "Delta Retail", 1770, [["Widget Beta", 3, 1500]]], ["2025-02-14", "Bluebell Mart", 708, [["Widget Alpha", 1, 600]]],
    ["2025-04-05", "Aarav Traders", 1416, [["Widget Alpha", 2, 1200]]], ["2025-04-18", "Bluebell Mart", 944, [["Widget Beta", 2, 800]]],
    ["2025-05-02", "Aarav Traders", 1652, [["Widget Alpha", 3, 1400]]], ["2025-05-15", "Bluebell Mart", 472, [["Widget Beta", 1, 400]]],
    ["2025-05-31", "Emerald Co", 3540, [["Widget Alpha", 5, 3000]]], ["2025-06-03", "Aarav Traders", 1298, [["Widget Alpha", 2, 1100]]],
    ["2025-06-10", "Cedar Stores", 826, [["Widget Beta", 1, 700]]], ["2025-06-20", "Delta Retail", 1062, [["Widget Alpha", 1, 900]]],
    ["2025-06-30", "Emerald Co", 2950, [["Widget Beta", 5, 2500]]],
    // post-dated: after "today" (30 Jun 2025, fixed below) - never inside a relative period (decision 1)
    ["2025-07-02", "Aarav Traders", 5000, [["Widget Alpha", 5, 4237]]],
  ];
  const PURCHASES = [
    ["2025-01-16", "Crescent Supplies", 5900, [["Widget Alpha", 10, 5000]]], ["2025-03-10", "Crescent Supplies", 3540, [["Widget Beta", 6, 3000]]],
    ["2025-05-20", "Dune Wholesale", 2360, [["Widget Alpha", 4, 2000]]], ["2025-06-12", "Crescent Supplies", 4720, [["Widget Alpha", 8, 4000]]],
  ];
  const doc = (x, i, kind) => ({
    tenantId: T, tallyGuid: `${T}-${kind}-${i}`, tallyAlterId: i + 1, voucherStatus: "active",
    header: { voucherNo: `${kind}-${i + 1}`, voucherDate: new Date(`${x[0]}T00:00:00.000Z`), voucherType: "Invoice", voucherTotalAmount: x[2], narration: "", partyName: x[1] },
    inventory: x[3].map(([itemName, quantity, amount]) => ({ itemName, quantity, rate: amount / quantity, amount })), ledgers: [],
  });
  // ---- the oracle: plain filtering + sums over the rows above (no project code)
  const inR = (d, a, b) => d >= a && d <= b;
  const sumOf = (rows, a, b, party) => rows.filter((x) => inR(x[0], a, b) && (!party || x[1] === party)).reduce((s, x) => s + x[2], 0);
  const countOf = (rows, a, b) => rows.filter((x) => inR(x[0], a, b)).length;
  const byParty = (rows, a, b) => rows.filter((x) => inR(x[0], a, b)).reduce((m, x) => ((m[x[1]] = (m[x[1]] || 0) + x[2]), m), {});
  const near = (x, y) => (x === null || y === null ? x === y : Math.abs(x - y) < 0.01);
  const pctOf = (cur, prev) => (prev === 0 ? null : ((cur - prev) / prev) * 100);

  let captured = null;
  const execute = async (plan, ctx) => {
    const result = await executeQuery(plan, ctx);
    captured = { plan, ctx, result };
    return { result, cache: { status: "miss" } };
  };
  const forbidden = async () => { throw new Error("Claude must NOT be called"); };
  // "today" is fixed at 30 Jun 2025 through the REAL date-context function (real vouchers, real sync checkpoints)
  const NOW = new Date(2025, 5, 30, 12);
  const refMod = require("./src/services/analytics/referenceDate");
  const datesAtNow = (tenantId) => refMod.getTenantDateContext(tenantId, { now: NOW });
  const ask = async (q) => {
    captured = null;
    const r = await tryAnswerWithQueryEngine({ context: { tenantId: T }, userMessage: q, conversationHistory: [], deps: { plannerClient: forbidden, execute, getDateContext: datesAtNow } });
    return { r, meta: r.structured.details.queryEngine, text: r.structured.answer, ran: captured };
  };
  try {
    await clean();
    await Sale.collection.insertMany(SALES.map((x, i) => doc(x, i, "S")));
    await Purchase.collection.insertMany(PURCHASES.map((x, i) => doc(x, i, "P")));
    console.log(`    synthetic tenant: ${SALES.length} sales + ${PURCHASES.length} purchase vouchers, 15 Jan 2025 - 30 Jun 2025 + one post-dated 2 Jul 2025 (no sales in March, purchases in March), 5 customers: steady, lost, first-ever, reactivated, month-end buyer; today = 30 Jun 2025`);

    // 1. both periods covered: this month vs last month at the 30 Jun anchor
    let x = await ask("Sales this month vs last month");
    const jun = sumOf(SALES, "2025-06-01", "2025-06-30");
    const mayFull = sumOf(SALES, "2025-05-01", "2025-05-31");
    const mayLfl = sumOf(SALES, "2025-05-01", "2025-05-30");
    const t = x.ran && x.ran.result.totals;
    check(`this month vs last month: June 1-30 ₹${jun} (${countOf(SALES, "2025-06-01", "2025-06-30")} invoices) vs the COMPLETE May ₹${mayFull} = oracle; reference date = today (30 Jun 2025), not the 2 Jul voucher`, x.ran && ymd(x.ran.ctx.referenceDate) === "2025-06-30" && near(t.values.invoiceAmount, jun) && t.values.invoiceCount === countOf(SALES, "2025-06-01", "2025-06-30") && near(t.comparison.invoiceAmount.previous, mayFull) && near(t.comparison.invoiceAmount.deltaPct, pctOf(jun, mayFull)) && x.text.includes(fmtMoney(jun)), x.text);
    check("...the post-dated 2 Jul voucher is NOT in 'this month' (total excludes it) and the answer says post-dated vouchers exist; no coverage caveat", !x.text.includes(fmtMoney(jun + 5000)) && /vouchers dated after today \(latest 2 Jul 2025\); they are not included/.test(x.text) && !/Coverage:/.test(x.text) && x.meta.claudeCalls === 0, x.text);
    x = await ask("Sales from 2025-07-01 to 2025-07-31");
    check("an explicit range that names the post-dated day returns it (explicit intent kept): ₹5,000.00", x.ran && near(x.ran.result.totals.values.invoiceAmount, sumOf(SALES, "2025-07-01", "2025-07-31")) && x.ran.result.totals.values.invoiceAmount === 5000);
    x = await ask("Sales this month vs same period last month");
    check(`explicit same period: June vs 1-30 May ₹${mayLfl} = oracle, with the complete-period disclosure`, x.ran && near(x.ran.result.totals.comparison.invoiceAmount.previous, mayLfl) && /is complete .* but is compared with the same days/.test(x.text));
    x = await ask("Sales growth percentage this month vs last month");
    check(`total %: ${pctOf(jun, mayFull).toFixed(1)}% vs the complete May = oracle, shown in the answer`, x.ran && near(x.ran.result.totals.comparison.invoiceAmount.deltaPct, pctOf(jun, mayFull)) && x.text.includes(`${pctOf(jun, mayFull) > 0 ? "+" : ""}${pctOf(jun, mayFull).toFixed(1)}%`), x.text);

    // 2. "who" on real data
    x = await ask("Who bought less this month than last month?");
    const cur = byParty(SALES, "2025-06-01", "2025-06-30");
    const prev = byParty(SALES, "2025-05-01", "2025-05-31"); // decision 2: complete May
    const down = [...new Set([...Object.keys(cur), ...Object.keys(prev)])].map((k) => [k, (cur[k] || 0) - (prev[k] || 0)]).filter(([, d]) => d < 0).sort((a, b) => a[1] - b[1]).map(([k]) => k);
    const rows = x.ran ? x.ran.result.rows.map((r) => r.key.customer) : [];
    check(`"Who bought less ..." = customers whose sales fell, most first: ${down.join(", ")} (oracle)`, JSON.stringify(rows) === JSON.stringify(down) && /"Who" is read as your customers/.test(x.text), JSON.stringify(rows));

    // 3. new / lost with a genuinely new customer, a reactivated one and a month-end buyer
    x = await ask("new customers this month");
    check("decision 3: tenant without a synced ledger master -> final honest answer (ledger_master_missing), no legacy fallback, so Delta Retail (bought in Feb, back in June) is never labelled new", x.r.handled && x.meta.status === "unsupported" && x.meta.code === "ledger_master_missing" && /ledger master has not been synced/.test(x.text) && !/Delta Retail|Cedar Stores/.test(x.text));
    x = await ask("customers who stopped buying this month vs last month");
    const lost = Object.keys(prev).filter((k) => !cur[k]);
    check(`lost customers = bought in the complete May, nothing in June: ${lost.join(", ")} (oracle)`, x.ran && JSON.stringify(x.ran.result.rows.map((r) => r.key.customer)) === JSON.stringify(lost));
    x = await ask("sales for Cedar Stores this month vs last month");
    check("a genuinely new customer: previous ₹0 is a real zero (covered), % change explained, no coverage caveat", x.ran && x.ran.result.totals.comparison.invoiceAmount.previous === 0 && x.ran.result.totals.comparison.invoiceAmount.deltaPct === null && /% change n\/a: the comparison value is zero/.test(x.text) && !/Coverage:/.test(x.text), x.text);

    // 4. zero inside coverage vs no data outside it
    x = await ask("Sales in March 2025");
    check("a covered month with no sales (purchases were synced that month): 'no matching records' - a real zero, answered", x.meta.status === "answered" && x.r.structured.details.toolCalls[0].state === "zero_result" && x.ran && x.ran.result.totals.values.invoiceCount === 0 && !/Coverage:/.test(x.text));
    x = await ask("Sales from 2025-04-01 to 2025-04-30 vs 2025-03-01 to 2025-03-31");
    const apr = sumOf(SALES, "2025-04-01", "2025-04-30");
    check(`April vs a genuinely zero March: ₹${apr} vs ₹0, % change n/a (zero baseline), no coverage caveat`, x.ran && near(x.ran.result.totals.values.invoiceAmount, apr) && x.ran.result.totals.comparison.invoiceAmount.previous === 0 && /% change n\/a/.test(x.text) && !/Coverage:/.test(x.text));
    x = await ask("Sales from 2025-03-01 to 2025-03-31 vs 2025-02-01 to 2025-02-28");
    check("one period with zero transactions: March ₹0 vs February = oracle, -100.0%", x.ran && near(x.ran.result.totals.comparison.invoiceAmount.previous, sumOf(SALES, "2025-02-01", "2025-02-28")) && /-100\.0%/.test(x.text));
    x = await ask("Sales from 2025-01-01 to 2025-01-31");
    check(`current period partly covered (history starts 15 Jan): ₹${sumOf(SALES, "2025-01-01", "2025-01-31")} = oracle, with the caveat in text AND warnings`, x.ran && near(x.ran.result.totals.values.invoiceAmount, sumOf(SALES, "2025-01-01", "2025-01-31")) && /synced data starts on 15 Jan 2025/.test(x.text) && x.r.structured.warnings.some((w) => /15 Jan 2025/.test(w)));
    x = await ask("Sales from 2025-02-01 to 2025-02-28 vs 2025-01-01 to 2025-01-31");
    check("comparison period partly covered: figures = oracle, comparison caveat stated", x.ran && near(x.ran.result.totals.comparison.invoiceAmount.previous, sumOf(SALES, "2025-01-01", "2025-01-31")) && /comparison period 1 Jan 2025 – 31 Jan 2025 is only partly covered/.test(x.text));
    x = await ask("Sales in June 2025 vs June 2024");
    check("comparison completely outside: refused, the engine never ran, no false zero baseline", x.meta.status === "outside_coverage" && x.ran === null && /false zero baseline/.test(x.text) && /15 Jan 2025/.test(x.text));
    x = await ask("sales this month vs same month last year");
    check("YoY at the anchor (June 2024 has no data): refused, not 'everyone grew from ₹0'", x.meta.status === "outside_coverage" && x.ran === null);
    x = await ask("Sales in December 2024 vs December 2023");
    check("both periods outside: 'TallyPulse has no data for 1 Dec 2024 – 31 Dec 2024' (missing, not zero)", x.meta.status === "outside_coverage" && /no data for 1 Dec 2024 – 31 Dec 2024/.test(x.text) && /not zero sales/.test(x.text));
    x = await ask("sales for Aarav Traders in December 2024");
    check("a real customer outside coverage: no-data refusal, not 'Aarav Traders had no sales' and not 'couldn't find'", x.meta.status === "outside_coverage" && !/couldn.t find|no matching/i.test(x.text));
    x = await ask("purchases this month vs last month");
    check("purchases: June vs the complete May = oracle", x.ran && near(x.ran.result.totals.values.purchaseAmount, sumOf(PURCHASES, "2025-06-01", "2025-06-30")) && near(x.ran.result.totals.comparison.purchaseAmount.previous, sumOf(PURCHASES, "2025-05-01", "2025-05-31")));

    // 5. controller round trip: the plan is stored on the assistant message and drives the follow-up
    const orchPath = require.resolve("./src/services/ai/chatOrchestrator");
    const realOrch = require.cache[orchPath];
    let legacyCalls = 0;
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: { handleChatTurn: async () => { legacyCalls += 1; throw new Error("legacy must not run"); }, callClaude: async () => { throw new Error("no Claude"); } } };
    const refPath = require.resolve("./src/services/analytics/referenceDate");
    const realRef = require.cache[refPath];
    require.cache[refPath] = { id: refPath, filename: refPath, loaded: true, exports: { ...refMod, getTenantDateContext: (tid) => refMod.getTenantDateContext(tid, { now: NOW }) } };
    delete require.cache[require.resolve("./src/controllers/chatController")];
    const { sendChatMessage } = require("./src/controllers/chatController");
    const userId = new mongoose.Types.ObjectId();
    const send = async (message, chatId) => {
      const res = { code: 0, body: null, on() { return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
      await sendChatMessage({ body: { message }, params: chatId ? { chatId } : {}, user: { id: String(userId) }, companyContext: { tenantId: T, companyGuid: "synthetic" } }, res);
      return res;
    };
    const a = await send("Show sales this month vs last month");
    const b = await send("and by customer?", a.body.chatId);
    const saved = await Chat.findOne({ _id: a.body.chatId, tenantId: T, userId }).lean();
    const stored = saved && saved.messages[3] && saved.messages[3].queryContext;
    check("controller: the engine's plan is persisted on the assistant message (server-side), the follow-up keeps period + comparison and groups by customer, legacy never runs", a.code === 200 && b.code === 200 && legacyCalls === 0 && saved.messages[1].queryContext && saved.messages[1].queryContext.basis === "amount" && stored && stored.plan.groupBy[0].dim === "customer" && stored.plan.period.kind === "current_month" && stored.plan.compare.mode === "full_previous" && /by customer/.test(b.body.data.answer) && /Follow-up to your previous question/.test(b.body.data.answer), JSON.stringify(stored));
    check("controller: the stored context is not in the API response", !JSON.stringify(a.body).includes("queryContext"));
    require.cache[refPath] = realRef;
    if (realOrch) require.cache[orchPath] = realOrch;
    else delete require.cache[orchPath];
  } catch (e) {
    check("synthetic tenant section ran without an exception", false, e && e.stack);
  } finally {
    await clean();
    const left = (await Sale.collection.countDocuments({ tenantId: T })) + (await Purchase.collection.countDocuments({ tenantId: T })) + (await Chat.collection.countDocuments({ tenantId: T }));
    check("synthetic tenant removed (vouchers + chat)", left === 0, String(left));
    await mongoose.disconnect().catch(() => {});
  }
}
