/**
 * An analysis whose steps all CANNOT run because the period is outside the synced data (for example "this month" when the
 * company's data ends in December of last year). Before: nothing was remembered, so the user's reply ("last complete month",
 * or just a period) was planned as a brand-new question and answered with an unrelated total. Now the turn remembers the
 * question and tells the user where the data ends, so the reply is planned TOGETHER with the original question.
 *
 * Offline: scripted planner replies, no database, no network, no Tally; every date and name is SYNTHETIC.
 * Run: node verify-analysis-not-run-followup.js
 */
process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const queryChat = require("./src/services/query/queryChat");
const followUp = require("./src/services/query/followUp");
const { createChecker } = require("./test/check");

const t = createChecker();
const check = t.check;

const TENANT = "T-NOT-RUN-0001";
const QUESTION = "Why might my revenue be declining?";
// data ends in the middle of December 2025; "today" is far later
const DC = { referenceDate: new Date(2026, 9, 28, 23, 59, 59, 999), source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 8), coverage: { earliest: new Date(2025, 3, 1), latest: new Date(2025, 11, 8), lastSyncedAt: null } };

const DECLINE = { decline: { code: "needs_analysis", message: "several analyses" } };
const q = (period, extra = {}) => ({ v: 1, entity: "sales", mode: "aggregate", period, metrics: ["lineAmount"], groupBy: [], filters: [], ...extra });
// relative periods, as "why is revenue declining?" gets them: they resolve against today (Oct 2026), far past the data
const CURRENT = { kind: "current_month" };
const PREVIOUS = { mode: "full_previous" };
const OCT_PLAN = { v: 1, steps: [{ id: "revenue", kind: "query", plan: q(CURRENT, { compare: PREVIOUS }) }] };

const requests = [];
let script = [];
const model = async (req) => {
  requests.push(req);
  const next = script.shift();
  const input = typeof next === "function" ? next(req) : next;
  return { content: [{ type: "tool_use", id: "tu", name: req.tool_choice.name, input }], usage: { input_tokens: 1, output_tokens: 1 } };
};
const noExecute = async () => { throw new Error("the engine must not run: every period is outside the data"); };
const turn = (args) => queryChat.tryAnswerWithQueryEngine({
  context: { tenantId: TENANT, companyGuid: "g-1" },
  getDateContext: async () => DC,
  deps: { plannerClient: model, analysisEnabled: true, execute: noExecute, getFreshness: async () => ({ state: "fresh", message: "" }), getDateContext: async () => DC, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) },
  ...args,
});

(async () => {
  // ---- turn 1: the question, every step outside the synced data
  script = [DECLINE, { analysis: OCT_PLAN }];
  const out1 = await turn({ userMessage: QUESTION, conversationHistory: [], previousQuery: null });
  const answer1 = out1.structured.answer;
  const meta1 = out1.structured.details.queryEngine;
  check("turn1-not-run", "every step is reported as not run (data ends 8 Dec 2025), and nothing is computed", [out1.handled, meta1.status, /Not run/.test(answer1)], [true, "execution_failed", true]);
  check("turn1-states-where-data-ends", "the answer says where the data ends and which month is the last complete one", [/8 Dec 2025/.test(answer1), /November 2025/.test(answer1)], [true, true]);
  check("turn1-asks-for-a-period", "the answer asks which period to use", /last complete month/i.test(answer1), true);

  const saved = out1.queryContext;
  check("turn1-remembers-the-question", "the turn saves a state that holds the original question as pending", !!saved && typeof saved.pending === "string" && saved.pending.includes(QUESTION), true);
  check("turn1-saves-the-data-window", "the saved question carries the server-derived data end and last complete month", !!saved && /2025-12-08/.test(saved.pending) && /2025-11-01/.test(saved.pending) && /2025-11-30/.test(saved.pending), true);
  check("turn1-state-reads-back", "the saved state passes the strict reader (a tampered or malformed one would be ignored)", !!followUp.readQueryState(JSON.parse(JSON.stringify(saved))), true);

  // ---- turn 2: the user's reply is planned together with the original question
  requests.length = 0;
  script = [DECLINE, { decline: { code: "needs_clarification", message: "stop here: this test only inspects what the planner was sent" } }];
  const out2 = await turn({ userMessage: "last complete month", conversationHistory: [{}], previousQuery: JSON.parse(JSON.stringify(saved)) });
  check("turn2-reply-reaches-the-planner", "the reply is not refused by the question safety gate (the planner was called)", requests.length > 0, true);
  const first = requests[0] && requests[0].messages[0].content;
  const sent = typeof first === "string" ? first : JSON.stringify(first);
  check("turn2-planner-gets-the-original-question", "the planner is sent the original question, not just the reply", [/revenue be declining/.test(sent), /last complete month/.test(sent)], [true, true]);
  check("turn2-planner-gets-the-window", "...and the server-derived data window, so 'last complete month' can be resolved", /2025-11-01/.test(sent) && /2025-11-30/.test(sent), true);
  check("turn2-year-guard-allows-the-window-year", "a plan for that month passes the year guard (its year came from the window, not from the model)", out2.structured.details.queryEngine.code !== "year_missing", true);

  // ---- a second reply that is again outside the data does not pile notes up
  script = [DECLINE, { analysis: OCT_PLAN }];
  const out2b = await turn({ userMessage: "this month", conversationHistory: [{}], previousQuery: JSON.parse(JSON.stringify(saved)) });
  const again = out2b.queryContext;
  check("repeated-not-run-keeps-one-note", "asked again and still outside the data: the question is remembered with ONE data-window note, not two", !!again && (again.pending.match(/\[the data ends on/g) || []).length === 1 && again.pending.includes(QUESTION), true);

  // ---- the reported case: the sync is HEALTHY (so the period is inside the synced window), the steps RUN, and find no records
  //      because the company's latest voucher is long before the period. That is "no data for this period", not an empty result.
  const DC2 = { referenceDate: new Date(2026, 10, 20, 23, 59, 59, 999), source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 8), coverage: { earliest: new Date(2025, 3, 1), latest: new Date(2026, 10, 20), lastSyncedAt: new Date(2026, 10, 20) } };
  const zeroResult = (plan) => ({ result: { ok: true, entity: plan.entity, mode: "aggregate", period: { from: new Date(2026, 10, 1).toISOString(), to: new Date(2026, 10, 20, 23, 59, 59).toISOString(), label: "Month to date" }, comparison: { from: new Date(2026, 9, 1).toISOString(), to: new Date(2026, 9, 20, 23, 59, 59).toISOString(), label: "October 2026" }, metrics: ["lineAmount"], groupBy: [], rows: [], truncated: false, warnings: [], assumptions: [], totals: { values: { lineAmount: 0 }, comparison: { lineAmount: { previous: 0, delta: 0, deltaPct: null } } } }, cache: { status: "miss" } });
  const turnDC2 = (args, execute) => queryChat.tryAnswerWithQueryEngine({ context: { tenantId: TENANT, companyGuid: "g-1" }, getDateContext: async () => DC2, deps: { plannerClient: model, analysisEnabled: true, execute, getFreshness: async () => ({ state: "fresh", message: "" }), getDateContext: async () => DC2, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) }, ...args });
  const threeSteps = { v: 1, steps: [
    { id: "total", kind: "query", plan: q(CURRENT, { compare: PREVIOUS }) },
    { id: "customers", kind: "query", plan: q(CURRENT, { compare: PREVIOUS, groupBy: [{ dim: "customer" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 }) },
  ] };
  script = [DECLINE, { analysis: threeSteps }];
  const outE = await turnDC2({ userMessage: QUESTION, conversationHistory: [], previousQuery: null }, async (plan) => zeroResult(plan));
  const textE = outE.structured.answer;
  check("empty-says-no-data-for-the-period", "all steps empty and the period is after the latest voucher: the answer says there is no data for it (not 'No matching records found' per step)", [/No matching records/.test(textE), /8 Dec 2025/.test(textE), /no data/i.test(textE)], [false, true, true]);
  check("empty-names-the-last-complete-month", "...and names the last complete month and asks for a period", [/November 2025/.test(textE), /last complete month/i.test(textE)], [true, true]);
  check("empty-no-fake-overall", "...and does not claim the total change 'was not measured' or show empty steps", [/was not measured/.test(textE), /Step 1/.test(textE)], [false, false]);
  const savedE = outE.queryContext;
  check("empty-remembers-the-question", "the question is remembered (with the data window), so a reply like 'aug 2025' continues it", !!savedE && !!savedE.pending && savedE.pending.includes(QUESTION) && /2025-11-30/.test(savedE.pending), true);
  check("empty-is-not-an-answer", "it is reported as not answered (no usable data), not as a successful analysis", [outE.structured.details.queryEngine.status, outE.structured.details.toolCalls[0].state], ["execution_failed", "no_usable_data"]);

  requests.length = 0;
  script = [DECLINE, { decline: { code: "needs_clarification", message: "stop: this test only inspects what the planner was sent" } }];
  await turnDC2({ userMessage: "aug 2025", conversationHistory: [{}], previousQuery: JSON.parse(JSON.stringify(savedE)) }, async (plan) => zeroResult(plan));
  const sentE = requests[0] ? JSON.stringify(requests[0].messages) : "";
  check("aug-2025-continues-the-revenue-question", "the reply 'aug 2025' reaches the planner TOGETHER with 'why might my revenue be declining' (not as a lone question)", [/revenue be declining/.test(sentE), /aug 2025/.test(sentE)], [true, true]);

  // an empty result INSIDE the data is a real "no records" and keeps its normal answer
  script = [DECLINE, { analysis: { v: 1, steps: [{ id: "x", kind: "query", plan: q({ kind: "custom", from: "2025-10-01", to: "2025-10-31" }, { compare: { mode: "custom", period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" } }, filters: [{ dim: "customer", op: "eq_ci", value: "Nobody Ltd" }] }) }] } }];
  const zeroInside = async (plan) => { const r = zeroResult(plan); r.result.period = { from: new Date(2025, 9, 1).toISOString(), to: new Date(2025, 9, 31, 23, 59, 59).toISOString(), label: "October 2025" }; return r; };
  const outI = await turnDC2({ userMessage: "Why did revenue fall for Nobody Ltd in October 2025 compared with September 2025?", conversationHistory: [], previousQuery: null }, zeroInside);
  check("empty-inside-the-data-is-unchanged", "no records for a period INSIDE the data keeps the normal answer (no 'data ends' text, nothing remembered)", [/data ends|last complete month/i.test(outI.structured.answer), outI.queryContext && outI.queryContext.pending], [false, undefined]);

  // ---- steps that fail for ANOTHER reason (the engine errored; the period itself is inside the data) are not "outside the data"
  script = [DECLINE, { analysis: { v: 1, steps: [{ id: "x", kind: "query", plan: q({ kind: "custom", from: "2025-10-01", to: "2025-10-31" }, { compare: { mode: "custom", period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" } } }) }] } }];
  const execFails = async () => ({ result: { ok: false, errors: [{ code: "query_timeout", message: "took too long" }] }, cache: { status: "miss" } });
  const out4 = await queryChat.tryAnswerWithQueryEngine({ context: { tenantId: TENANT, companyGuid: "g-1" }, userMessage: "Why did revenue fall in October 2025 compared with September 2025?", conversationHistory: [], previousQuery: null, getDateContext: async () => DC, deps: { plannerClient: model, analysisEnabled: true, execute: execFails, getFreshness: async () => ({ state: "fresh", message: "" }), getDateContext: async () => DC, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) } });
  check("failed-for-another-reason-not-remembered", "steps that failed for another reason (not outside the data) save no pending question and add no data-window text", [out4.queryContext === undefined, /last complete month/i.test(out4.structured.answer)], [true, false]);

  // ---- not every empty analysis is remembered
  script = [DECLINE, { analysis: { v: 1, steps: [{ id: "x", kind: "query", plan: q({ kind: "custom", from: "2025-10-01", to: "2025-10-31" }, { compare: { mode: "custom", period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" } } }) }] } }];
  const execOk = async (plan) => ({ result: { ok: true, entity: plan.entity, mode: "aggregate", period: { from: new Date(2025, 9, 1).toISOString(), to: new Date(2025, 9, 31, 23, 59, 59).toISOString(), label: "October 2025" }, comparison: { from: new Date(2025, 8, 1).toISOString(), to: new Date(2025, 8, 30, 23, 59, 59).toISOString(), label: "September 2025" }, metrics: ["lineAmount"], groupBy: [], rows: [], truncated: false, warnings: [], assumptions: [], totals: { values: { lineAmount: 1000 }, comparison: { lineAmount: { previous: 1500, delta: -500, deltaPct: -33.3 } } } }, cache: { status: "miss" } });
  const out3 = await queryChat.tryAnswerWithQueryEngine({ context: { tenantId: TENANT, companyGuid: "g-1" }, userMessage: "Why did revenue fall in October 2025 compared with September 2025?", conversationHistory: [], previousQuery: null, getDateContext: async () => DC, deps: { plannerClient: model, analysisEnabled: true, execute: execOk, getFreshness: async () => ({ state: "fresh", message: "" }), getDateContext: async () => DC, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) } });
  const state3 = out3.queryContext;
  check("answered-analysis-unchanged", "an analysis that DID run keeps its normal saved scope (no pending question, no data-window text)", !!state3 && state3.pending === undefined && !/Not run/.test(out3.structured.answer) && !/last complete month/i.test(out3.structured.answer), true);

  console.log(t.summary());
  process.exit(t.fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
