/**
 * Ask AI follow-up fixes (offline: no database, no network, no real model; every name and figure is SYNTHETIC):
 *  - an empty answer's follow-up ("take the last synced data") is told where the data ends, and the year guard accepts that month
 *  - a long ranking says how many moved (100+ products fell), not just "biggest drops"
 *  - an analysis follow-up carries the previous ranking, so "these products" needs no question
 *  - one bounded retry when the analysis planner asks for what the scope already holds
 * Run: node verify-ask-ai-ux-fixes.js
 */
process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const followUp = require("./src/services/query/followUp");
const planner = require("./src/services/query/planner");
const { planAnalysis } = require("./src/services/query/analysisPlanner");
const { plainQuerySummary } = require("./src/services/query/plainAnswer");
const { buildPresentation } = require("./src/services/query/presentation");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 800)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const REF = new Date(2026, 9, 28); // 28 Oct 2026

// ---- the data window (local midnight of the latest voucher day)
{
  const mid = followUp.dataWindow(new Date(2025, 11, 5));
  check("window-mid-month", "latest voucher 5 Dec 2025: data through that day, last complete month = November 2025", same(mid, { through: "2025-12-05", lastCompleteMonth: { from: "2025-11-01", to: "2025-11-30" } }), JSON.stringify(mid));
  const end = followUp.dataWindow(new Date(2025, 11, 31));
  check("window-month-end", "latest voucher on the last day of December: December is complete", same(end.lastCompleteMonth, { from: "2025-12-01", to: "2025-12-31" }), JSON.stringify(end));
  const jan = followUp.dataWindow(new Date(2026, 0, 10));
  check("window-january", "latest voucher in January: the last complete month is the December before", same(jan.lastCompleteMonth, { from: "2025-12-01", to: "2025-12-31" }), JSON.stringify(jan));
  const leap = followUp.dataWindow(new Date(2024, 2, 3));
  check("window-leap", "latest voucher early March 2024: February 2024 ends on the 29th", leap.lastCompleteMonth.to === "2024-02-29", JSON.stringify(leap));
  check("window-invalid", "no usable date, no window", followUp.dataWindow("not a date") === null);
}

// ---- the saved state: `empty` survives only as the literal true on a single-query state
{
  const plan = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount"], groupBy: [], filters: [] };
  const s = followUp.buildQueryState(plan, { empty: true });
  check("state-empty-roundtrip", "an empty turn's state reads back as empty", followUp.readQueryState(JSON.parse(JSON.stringify(s))).empty === true);
  check("state-not-empty", "a state that was not empty has no flag", followUp.readQueryState(followUp.buildQueryState(plan)).empty === undefined);
  check("state-empty-tampered", "a tampered flag (anything but true) is ignored", followUp.readQueryState({ ...s, empty: "yes" }).empty === undefined);
}

// ---- the planner is told the window, and the year guard accepts its year
(async () => {
  const OCT = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2026-10-01", to: "2026-10-31" }, metrics: ["invoiceAmount"], groupBy: [], filters: [] };
  const NOV = { ...OCT, period: { kind: "custom", from: "2025-11-01", to: "2025-11-30" } };
  const seen = [];
  const client = async (req) => {
    seen.push(req.messages[0].content);
    return { content: [{ type: "tool_use", id: "t1", name: planner.PLANNER_TOOL_NAME, input: { plan: NOV } }], usage: {} };
  };
  const window = followUp.dataWindow(new Date(2025, 11, 5));
  const withWindow = await planner.planQuestion("pick data from last synced data", { claudeClient: client, resolveEntity: async () => ({ ok: true }), previousPlan: OCT, dataWindow: window, referenceDate: REF });
  check("planner-window-line", "the request carries the data end and the last complete month", /ends on 2025-12-05/.test(seen[0]) && /2025-11-01 to 2025-11-30/.test(seen[0]), seen[0]);
  check("planner-window-year-ok", "the plan for that month passes the year guard (its year came from the server's window, not the model)", withWindow.status === "supported", JSON.stringify(withWindow).slice(0, 300));
  seen.length = 0;
  const without = await planner.planQuestion("pick data from last synced data", { claudeClient: client, resolveEntity: async () => ({ ok: true }), previousPlan: OCT, referenceDate: REF });
  check("planner-no-window", "without a window the request has no such line and the invented year is still asked about", !/ends on/.test(seen[0]) && without.status === "needs_clarification" && without.code === "year_missing", `${without.status} ${without.code}`);
  const bad = await planner.planQuestion("x", { claudeClient: client, resolveEntity: async () => ({ ok: true }), previousPlan: OCT, dataWindow: { through: "yesterday", lastCompleteMonth: { from: "a", to: "b" } }, referenceDate: REF });
  check("planner-bad-window", "a malformed window is ignored", /ends on/.test(seen[seen.length - 1]) === false && bad.status !== undefined);

  // ---- the empty card says where the data ends
  const emptyPlan = { ...OCT };
  const emptyRes = { ok: true, period: { from: new Date(2026, 9, 1).toISOString(), to: new Date(2026, 9, 31, 23, 59, 59).toISOString(), label: "October 2026" }, metrics: ["invoiceAmount"], groupBy: [], rows: [], truncated: false, warnings: [], assumptions: [], totals: { values: { invoiceAmount: 0 } } };
  const card = buildPresentation({ plan: emptyPlan, result: emptyRes, zero: true, dataThrough: new Date(2025, 11, 5) });
  check("card-latest-date", "the empty card carries the latest data day", card && card.kind === "empty" && card.dataThrough === "2025-12-05", JSON.stringify(card).slice(0, 200));
  const card2 = buildPresentation({ plan: emptyPlan, result: emptyRes, zero: true });
  check("card-no-date", "without a date the card has none (nothing invented)", card2 && card2.kind === "empty" && card2.dataThrough === undefined);

  // ---- a long ranking says how many moved
  const AUG = { from: new Date(2025, 7, 1).toISOString(), to: new Date(2025, 7, 31, 23, 59, 59).toISOString() }, JUL = { from: new Date(2025, 6, 1).toISOString(), to: new Date(2025, 6, 31, 23, 59, 59).toISOString() };
  const rank = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-07-01", to: "2025-07-31" } }, metrics: ["lineAmount"], groupBy: [{ dim: "product" }], filters: [], sort: [{ by: "lineAmount.delta", dir: "asc" }], having: [{ metric: "lineAmount.delta", op: "lt", value: 0 }], limit: 100 };
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ key: { product: `Synthetic Product ${i + 1}` }, values: { lineAmount: 100 }, comparison: { lineAmount: { previous: 200 + i, delta: -100 - i, deltaPct: -50 } }, presence: "both" }));
  const result = (n, truncated) => ({ ok: true, period: AUG, comparison: JUL, metrics: ["lineAmount"], groupBy: [{ dim: "product" }], amountBasis: { lineAmount: "line_item_pre_tax" }, rows: rows(n), truncated, warnings: [], assumptions: [] });
  const lead = (n, truncated, language) => plainQuerySummary({ plan: rank, result: result(n, truncated), language }).lines.find((l) => /fell|gire|गिरावट आई|Biggest drops|Sabse zyada girawat/.test(l));
  check("rank-cut-en", "100 rows at the engine's limit: '100+ products fell' and that more exist", /^100\+ products fell \(the list is cut at the row limit; more exist\)\. Biggest drops:$/.test(lead(100, true, "en")), lead(100, true, "en"));
  check("rank-short-en", "5 rows, nothing cut: the exact count, no plus", lead(5, false, "en") === "5 products fell. Biggest drops:", lead(5, false, "en"));
  check("rank-two-keeps-plain", "two or fewer rows keep the plain lead", lead(2, false, "en") === "Biggest drops:", lead(2, false, "en"));
  check("rank-hinglish", "Hinglish says the count too", /^100\+ products gire/.test(lead(100, true, "hinglish")), lead(100, true, "hinglish"));
  check("rank-hindi", "Hindi says the count too", /^उत्पादों में से 100\+ में गिरावट आई/.test(lead(100, true, "hi")), lead(100, true, "hi"));

  // ---- the analysis follow-up carries the previous ranking
  const state = followUp.buildQueryState(rank);
  const scope = followUp.analysisScopeOf(state);
  check("scope-has-ranking", "a single-query state with a breakdown hands the analysis planner groupBy, sort, having and limit", same(scope.groupBy, rank.groupBy) && same(scope.sort, rank.sort) && same(scope.having, rank.having) && scope.limit === 100, JSON.stringify(scope));
  check("scope-carried-intact", "the old carried keys are still there, and the plain scope used elsewhere is unchanged", scope.period && scope.compare && same(followUp.scopeOf(state).groupBy, undefined));
  const noGroup = followUp.analysisScopeOf(followUp.buildQueryState({ ...rank, groupBy: [], sort: [], having: [] }));
  check("scope-no-ranking-without-breakdown", "a state with no breakdown adds no ranking", noGroup.groupBy === undefined && noGroup.limit === undefined, JSON.stringify(noGroup));
  check("scope-readable", "the planner accepts the widened scope", followUp.readScope(scope) !== null);
  check("scope-rejects-unknown", "an unknown key is still no scope", followUp.readScope({ ...scope, tenantId: "T" }) === null);
  const msg = followUp.scopeMessage(followUp.readScope(scope), "in products ka girne ka karan kya hai");
  check("scope-message", "the message tells the planner that 'these products' are that ranking", /groupBy/.test(msg) && /these products/.test(msg) && /Question: in products/.test(msg));

  // ---- one retry when the analysis planner asks for what the scope already holds
  const clarify = { content: [{ type: "tool_use", id: "c1", name: "submit_analysis_plan", input: { decline: { code: "needs_clarification", message: "Please specify which products and time period." } } }], usage: { input_tokens: 10, output_tokens: 5 } };
  const calls = [];
  const asker = (replies) => async (req) => { calls.push(req); return replies[Math.min(calls.length - 1, replies.length - 1)]; };
  const r1 = await planAnalysis("in products ka girne ka karan kya hai", { claudeClient: asker([clarify, clarify]), referenceDate: REF, previousScope: scope });
  check("retry-once", "with the period in the scope a clarification is asked back once, then returned (2 calls, counted)", calls.length === 2 && r1.status === "needs_clarification" && r1.usage.calls === 2, `${calls.length} ${r1.status} ${r1.usage && r1.usage.calls}`);
  const second = JSON.stringify(calls[1].messages);
  check("retry-says-why", "the second request answers the question from the scope (no data, no tenant)", /already gives the period/.test(second) && !/tenant/i.test(second));
  calls.length = 0;
  const r2 = await planAnalysis("what changed", { claudeClient: asker([clarify]), referenceDate: REF, previousScope: null });
  check("no-retry-without-scope", "without a scope the clarification is returned at once (1 call)", calls.length === 1 && r2.status === "needs_clarification", String(calls.length));
  calls.length = 0;
  const r3 = await planAnalysis("what changed", { claudeClient: asker([clarify]), referenceDate: REF, previousScope: { entity: "sales", metrics: ["invoiceAmount"] } });
  check("no-retry-without-period", "a scope without a period has nothing to answer with: no retry", calls.length === 1 && r3.status === "needs_clarification", String(calls.length));

  console.log(`\nverify-ask-ai-ux-fixes: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
