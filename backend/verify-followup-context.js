/**
 * Follow-up context across an analysis turn that measured BOTH sales and purchases, then into a single-query follow-up and a
 * deeper analysis. The regression: "Compare sales vs purchase product wise and customer wise of Aug 2025" followed by
 * "customers jiske wajah se sale giri" was planned with no context (month to date vs last month, no records), because
 *   1. followUp.buildAnalysisState saved NO state when the steps differed in entity (sales and purchase), and
 *   2. the query planner was never given an analysis turn's scope (queryChat passed previous plans of single-query turns only).
 *
 * The REAL controller (sendChatMessage), chat turn, both planners' checks (year guard, plan rules), validator, follow-up state,
 * analysis executor and evidence run; the model is scripted and plans FROM WHAT IT IS SENT (a planner that uses the context it
 * receives, or plans without it - "month to date" - when none is sent); the engine is in memory. No database, network or model.
 * What this proves: the context reaches the planners and the guards accept it; NOT how well a real model uses it.
 *
 * Run: node verify-followup-context.js
 */

process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const followUp = require("./src/services/query/followUp");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 900)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const TENANT = "T-CONTEXT-0001";
const AUG = { kind: "custom", from: "2025-08-01", to: "2025-08-31" };
const JUL = { kind: "custom", from: "2025-07-01", to: "2025-07-31" };

// synthetic lines: [entity, month, party, product, pre-tax amount]; invoice totals = amount x 1.05 (tax), per invoice line here
const LINES = [
  ["sales", "2025-07", "Kiran Stores", "Apple Shimla", 60000], ["sales", "2025-07", "Kiran Stores", "Banana Robusta", 40000],
  ["sales", "2025-08", "Kiran Stores", "Apple Shimla", 10000], ["sales", "2025-08", "Kiran Stores", "Banana Robusta", 30000],
  ["sales", "2025-07", "Lata Mart", "Banana Robusta", 80000], ["sales", "2025-08", "Lata Mart", "Banana Robusta", 70000],
  ["sales", "2025-07", "Mehta & Sons", "Cherry Kashmir", 50000], ["sales", "2025-08", "Mehta & Sons", "Cherry Kashmir", 65000],
  ["sales", "2025-07", "Nair Retail", "Apple Shimla", 30000],
  ["purchase", "2025-07", "Himachal Orchards", "Apple Shimla", 70000], ["purchase", "2025-08", "Himachal Orchards", "Apple Shimla", 20000],
  ["purchase", "2025-08", "Fresh Farms", "Banana Robusta", 90000],
];
const PARTY = { sales: "customer", purchase: "supplier" };

(async () => {
  const day = (iso, end) => (end ? new Date(`${iso}T23:59:59.999`) : new Date(`${iso}T00:00:00`)).toISOString();
  const monthOf = (p) => (p.kind === "custom" ? p.from.slice(0, 7) : p.kind === "specific_fy" ? `${p.fy.slice(0, 4)}-04` : "2026-10"); // no data outside Jul/Aug 2025
  const prevMonth = (m) => { const [y, mo] = m.split("-").map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`; };
  const lastDay = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo, 0).getDate(); };
  const executed = [];
  const execute = async (plan, ctx) => {
    executed.push({ plan: JSON.parse(JSON.stringify(plan)), tenantId: ctx.tenantId });
    const month = monthOf(plan.period);
    const prev = plan.compare ? (plan.compare.mode === "custom" ? plan.compare.period.from.slice(0, 7) : prevMonth(month)) : null;
    const m = plan.metrics[0];
    const dim = (plan.groupBy[0] || {}).dim;
    const val = (l) => (m === "invoiceAmount" || m === "purchaseAmount" ? l[4] * 1.05 : l[4]);
    const keep = (l) => l[0] === plan.entity && (plan.filters || []).every((f) => {
      const vals = Array.isArray(f.value) ? f.value : [f.value];
      const field = f.dim === "product" ? l[3] : l[2];
      return vals.some((v) => v.toLowerCase() === field.toLowerCase());
    });
    const sum = (mon) => {
      const g = new Map();
      for (const l of LINES.filter((x) => keep(x) && x[1] === mon)) { const k = dim ? (dim === "product" ? l[3] : l[2]) : ""; g.set(k, Math.round(((g.get(k) || 0) + val(l)) * 100) / 100); }
      return g;
    };
    const cur = sum(month), before = prev ? sum(prev) : null;
    const keys = [...new Set([...cur.keys(), ...(before ? before.keys() : [])])];
    let rows = keys.map((k) => {
      const c = cur.get(k) || 0, p = before ? before.get(k) || 0 : null;
      return { key: { [dim]: k }, values: { [m]: c }, ...(before ? { comparison: { [m]: { previous: p, delta: Math.round((c - p) * 100) / 100, deltaPct: p ? Math.round(((c - p) / p) * 10000) / 100 : null } }, presence: !cur.has(k) ? "previous_only" : !before.has(k) ? "current_only" : "both" } : {}) };
    });
    const s = (plan.sort || [])[0];
    if (s && /\.delta$/.test(s.by)) rows.sort((a, b) => (a.comparison[m].delta - b.comparison[m].delta) * (s.dir === "asc" ? 1 : -1));
    else rows.sort((a, b) => b.values[m] - a.values[m]);
    for (const h of plan.having || []) if (/\.delta$/.test(h.metric)) rows = rows.filter((r) => (h.op === "lt" ? r.comparison[m].delta < h.value : r.comparison[m].delta > h.value));
    const total = [...cur.values()].reduce((t, x) => t + x, 0), prevTotal = before ? [...before.values()].reduce((t, x) => t + x, 0) : null;
    if (!dim) rows = [];
    const limit = plan.limit || 10;
    const r2 = (x) => Math.round(x * 100) / 100;
    return { result: { ok: true, entity: plan.entity, mode: "aggregate", period: { from: day(`${month}-01`), to: day(`${month}-${lastDay(month)}`, true), label: month }, comparison: before ? { from: day(`${prev}-01`), to: day(`${prev}-${lastDay(prev)}`, true), label: prev } : null, metrics: plan.metrics, groupBy: plan.groupBy, amountBasis: { [m]: m === "lineAmount" ? "line_item_pre_tax" : "voucher_total_incl_tax" }, rows: rows.slice(0, limit), totals: { values: { [m]: r2(total) }, ...(before ? { comparison: { [m]: { previous: r2(prevTotal), delta: r2(total - prevTotal), deltaPct: prevTotal ? r2(((total - prevTotal) / prevTotal) * 100) : null } } } : {}) }, truncated: rows.length > limit, rowLimit: limit, warnings: [], assumptions: [] } };
  };
  const DC = { referenceDate: new Date(2026, 9, 27, 23, 59, 59, 999), source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 31), coverage: { earliest: new Date(2025, 0, 1), latest: new Date(2026, 9, 27), lastSyncedAt: null } };

  // ---- the model. The query planner and the analysis planner read the context they are SENT and plan from it.
  const SCOPE_RE = /Previous turn's analysis scope[^\n]*\n(\{[^\n]*\})\n/;
  const PLAN_RE = /Previous query plan[^\n]*\n(\{[^\n]*\})\n/;
  const contextIn = (req) => {
    const text = req.messages[0].content;
    const s = SCOPE_RE.exec(text), p = PLAN_RE.exec(text);
    return s ? { scope: JSON.parse(s[1]) } : p ? { plan: JSON.parse(p[1]) } : {};
  };
  const requests = [];
  const DECLINE = { decline: { code: "needs_analysis", message: "several analyses" } };
  // "customers behind the fall": sales by customer over the context's period against the month before it (a custom month needs an
  // explicit custom comparison range - the validator refuses full_previous there); without context, month to date vs last month
  const monthBefore = (p) => { const [y, m] = p.from.split("-").map(Number); const d = new Date(y, m - 2, 1); const e = new Date(y, m - 1, 0); const f2 = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; return { kind: "custom", from: f2(d), to: f2(e) }; };
  const customerDecline = (req) => {
    const c = contextIn(req);
    const period = (c.scope && c.scope.period) || (c.plan && c.plan.period) || { kind: "current_month" };
    const compare = period.kind === "custom" ? { mode: "custom", period: monthBefore(period) } : { mode: "full_previous" };
    return { plan: { v: 1, entity: "sales", mode: "aggregate", period, compare, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], having: [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }], limit: 10 } };
  };
  let script = [];
  const model = async (req) => {
    requests.push(req);
    const next = script.shift();
    if (!next) throw new Error("unexpected model call");
    return { content: [{ type: "tool_use", name: req.tool_choice.name, input: typeof next === "function" ? next(req) : next }], usage: { input_tokens: 1, output_tokens: 1 } };
  };
  const queryChat = require("./src/services/query/queryChat");
  const realTurn = queryChat.tryAnswerWithQueryEngine;
  queryChat.tryAnswerWithQueryEngine = (args) => realTurn({ ...args, getDateContext: async () => DC, deps: { plannerClient: model, analysisEnabled: true, execute, getFreshness: async () => ({ state: "fresh", message: "" }), getDateContext: async () => DC, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) } });
  const Chat = require("./src/models/chat.model");
  const saved = [];
  Chat.prototype.save = async function save() { saved.push(JSON.parse(JSON.stringify(this.toObject()))); return this; };
  let stored = null;
  Chat.findOne = async (filter) => (stored && filter.tenantId === TENANT && String(filter._id) === String(stored._id) ? Chat.hydrate(JSON.parse(JSON.stringify(stored))) : null);
  const { sendChatMessage } = require("./src/controllers/chatController");
  const mkRes = () => ({ statusCode: 0, body: null, destroyed: false, closed: false, writableFinished: false, on() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.writableFinished = true; return this; } });
  const mkReq = (message, chatId) => ({ id: "req-context", body: { message }, params: chatId ? { chatId } : {}, companyContext: { tenantId: TENANT, companyGuid: "guid-context" }, user: { id: "64b000000000000000000003" } });
  let n = 0;
  const ask = async (message, replies, { newChat = false } = {}) => {
    script = [...replies]; requests.length = 0; executed.length = 0;
    const res = mkRes();
    await sendChatMessage(mkReq(message, newChat || !stored ? undefined : stored._id), res);
    const doc = saved[saved.length - 1];
    stored = { ...doc, _id: `64b0000000000000000001${String(10 + (n += 1)).padStart(2, "0")}` };
    return { res, data: res.body && res.body.data, state: doc.messages[doc.messages.length - 1].queryContext, sent: requests.map((r) => r.messages[0].content), executed: [...executed], left: script.length };
  };
  const step = (id, entity, dim, metric) => ({ id, kind: "query", plan: { v: 1, entity, mode: "aggregate", period: AUG, metrics: [metric], groupBy: [{ dim }], sort: [{ by: metric, dir: "desc" }], limit: 10 } });
  const comparison = { analysis: { v: 1, steps: [step("sp", "sales", "product", "lineAmount"), step("pp", "purchase", "product", "lineAmount"), step("sc", "sales", "customer", "invoiceAmount"), step("ps", "purchase", "supplier", "purchaseAmount")] } };
  const isAug = (p) => p && p.period && p.period.kind === "custom" && p.period.from === "2025-08-01" && p.period.to === "2025-08-31";

  // ---- turn 1: the comparison (sales and purchases, product-wise and customer-wise, Aug 2025)
  const t1 = await ask("Compare sales vs purchase product wise and customer wise of Aug 2025", [DECLINE, comparison], { newChat: true });
  const s1 = followUp.readQueryState(t1.state);
  check("t1-state", "the sales+purchase comparison saves its shared scope: Aug 2025 (entity and metric differ between steps, so they are NOT carried)", !!s1 && s1.source === "analysis" && s1.carried.includes("period") && !s1.carried.includes("entity") && !s1.carried.includes("metrics") && isAug(s1.plan), JSON.stringify(t1.state));
  const v1 = t1.data.visualization;
  check("t1-comparison-intact", "the comparison itself is unchanged: one aligned sales/purchase product view, the customer and supplier views beside it, a sold-only product shown as '—' (not ₹0)", !!v1 && v1.pairs.length === 1 && v1.pairs[0].rows.some((r) => r.cells.name === "Cherry Kashmir" && r.cells.purchases === "—" && r.flag === "No purchases in this period") && v1.steps.filter((s) => !s.paired).length === 2, JSON.stringify(v1 && v1.pairs));
  check("t1-no-drift", "the comparison answer states no possible cause and suggests no action", !/Possible cause \(not proven\):|Suggested next actions/.test(t1.data.answer));

  // ---- turn 2: the regression - "customers jiske wajah se sale giri" (no period)
  const t2 = await ask("customers jiske wajah se sale giri", [customerDecline]);
  const p2 = t2.executed[0] && t2.executed[0].plan;
  check("t2-scope-sent", "the query planner receives the comparison's scope (Aug 2025) as a follow-up context, with the ignore-if-unrelated rule; no tenant or figures", t2.sent.length === 1 && SCOPE_RE.test(t2.sent[0]) && t2.sent[0].includes("2025-08-01") && /If the question is not a follow-up, ignore it/.test(t2.sent[0]) && !t2.sent[0].includes(TENANT) && !/Kiran|60000|Apple/.test(t2.sent[0]), t2.sent[0] && t2.sent[0].slice(0, 500));
  check("t2-august", "August 2025 survives: the query runs on Aug 2025, compared with July 2025 - never month to date", isAug(p2) && p2.compare && p2.compare.mode === "custom" && p2.compare.period.from === "2025-07-01" && p2.compare.period.to === "2025-07-31" && /Aug(ust)? 2025|2025-08/.test(t2.data.answer) && !/Month to date/i.test(t2.data.answer), JSON.stringify({ plan: p2, answer: t2.data.answer && t2.data.answer.slice(0, 300) }));
  const rows2 = t2.data.visualization && t2.data.visualization.rows;
  check("t2-ranking", "customers with a negative change, largest fall first: Kiran Stores (-63,000), Nair Retail (-31,500), Lata Mart (-10,500); Mehta & Sons (up) excluded", !!rows2 && rows2.map((r) => r.cells.name).join() === "Kiran Stores,Nair Retail,Lata Mart" && /-₹63,000\.00/.test(rows2[0].cells.change), JSON.stringify(rows2 && rows2.map((r) => r.cells)));
  check("t2-baseline", "the answer names the baseline every 'previous' refers to: July 2025", /Compared with July 2025:/.test(t2.data.answer), t2.data.answer);

  // the same follow-up WITHOUT the fix's context (a new chat): what the user saw - month to date, no records
  const before = await ask("customers jiske wajah se sale giri", [customerDecline], { newChat: true });
  check("before-fix-replay", "replay of the failure without context: planned as month to date (no records) - the context is what changes it", before.executed[0] && before.executed[0].plan.period.kind === "current_month", JSON.stringify(before.executed[0] && before.executed[0].plan.period));

  // ---- variations: each is planned against the same scope (the model reads it; the guards accept it)
  for (const q of ["Which customers caused the decline?", "Customer-wise breakdown.", "Who contributed most to the fall?", "In August, which customers dropped?"]) {
    stored = { ...saved.find((d) => d.messages.length === 2 && d.messages[0].text.startsWith("Compare sales vs purchase")), _id: "64b000000000000000000199" };
    const t = await ask(q, [customerDecline]);
    check(`variation-${q.slice(0, 18).replace(/\W+/g, "-")}`, `"${q}" is planned on Aug 2025 vs July (scope sent, year guard satisfied by the carried period)`, SCOPE_RE.test(t.sent[0] || "") && isAug(t.executed[0] && t.executed[0].plan), JSON.stringify({ answer: t.data.answer && t.data.answer.slice(0, 200), plan: t.executed[0] && t.executed[0].plan }));
  }

  // ---- turn 3: deeper, from the customer-decline turn - "Which products caused the decline for those customers?"
  stored = { ...saved.find((d) => d.messages.length === 4 && d.messages[2].text === "customers jiske wajah se sale giri"), _id: "64b000000000000000000200" };
  const deeper = (req) => {
    const scope = contextIn(req).scope || {};
    const base = { v: 1, entity: "sales", mode: "aggregate", period: scope.period || { kind: "current_month" }, compare: scope.compare || { mode: "full_previous" } }; // the carried July comparison
    return { analysis: { v: 1, steps: [
      { id: "who", kind: "query", plan: { ...base, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], having: [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }], limit: 5 } },
      { id: "what", kind: "query", plan: { ...base, metrics: ["lineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 10 }, inputs: [{ fromStep: "who", dim: "customer", take: 3 }] },
    ] } };
  };
  const t3 = await ask("Which products caused the decline for those customers?", [DECLINE, deeper]);
  const aSent = t3.sent[1] || "";
  check("t3-scope", "the deeper follow-up's analysis planner receives the previous turn's scope (sales, Aug 2025 vs July 2025)", SCOPE_RE.test(aSent) && aSent.includes("2025-08-01") && aSent.includes("2025-07-01"), aSent.slice(0, 400));
  const prodStep = t3.executed.find((e) => e.plan.groupBy[0] && e.plan.groupBy[0].dim === "product");
  check("t3-bound", "products are measured for the declining customers only (bound from step 1: Kiran Stores, Nair Retail, Lata Mart), Aug vs July", !!prodStep && isAug(prodStep.plan) && JSON.stringify(prodStep.plan.filters).includes("Kiran Stores") && JSON.stringify(prodStep.plan.filters).includes("Nair Retail") && !JSON.stringify(prodStep.plan.filters).includes("Mehta"), JSON.stringify(prodStep && prodStep.plan.filters));
  check("t3-evidence", "the answer names Apple Shimla as the largest product contributor for those customers (-50,000 Kiran + -30,000 Nair) as a CONTRIBUTOR, never a cause; no supplier is named", /Contributor: .*Apple Shimla -₹80,000\.00/.test(t3.data.answer) && !/Possible cause \(not proven\):.*Apple/.test(t3.data.answer) && !/Himachal|Fresh Farms|caused by/i.test(t3.data.answer), t3.data.answer.slice(0, 1200));

  // ---- an unrelated new question after the comparison: the scope is sent with "ignore it" and the question's own period wins
  stored = { ...saved.find((d) => d.messages.length === 2 && d.messages[0].text.startsWith("Compare sales vs purchase")), _id: "64b000000000000000000201" };
  const unrelated = await ask("Total purchases in FY 2024-25", [{ plan: { v: 1, entity: "purchase", mode: "aggregate", period: { kind: "specific_fy", fy: "2024-25" }, metrics: ["purchaseAmount"] } }]);
  check("stale-unrelated", "a new topic with its own period runs on that period (FY 2024-25), not on the carried August", unrelated.executed[0] && unrelated.executed[0].plan.period.kind === "specific_fy" && !isAug(unrelated.executed[0].plan), JSON.stringify(unrelated.executed[0] && unrelated.executed[0].plan));
  const after = await ask("customers jiske wajah se sale giri", [customerDecline]);
  check("stale-bounded", "context is one turn deep: after that unrelated turn, its own plan (FY 2024-25) is the context, never the older August", !SCOPE_RE.test(after.sent[0] || "") && PLAN_RE.test(after.sent[0] || "") && !(after.sent[0] || "").includes("2025-08-01"), (after.sent[0] || "").slice(0, 300));
  const fresh = await ask("customers jiske wajah se sale giri", [customerDecline], { newChat: true });
  check("stale-new-chat", "a new chat carries nothing", !SCOPE_RE.test(fresh.sent[0] || "") && !PLAN_RE.test(fresh.sent[0] || ""));

  // ---- strict state
  const tampered = JSON.parse(JSON.stringify(t1.state || {}));
  check("state-strict", "an analysis state must carry something known and unique; metrics only with the entity; comparison only with the period", followUp.readQueryState({ ...tampered, carried: [] }) === null && followUp.readQueryState({ ...tampered, carried: ["metrics"] }) === null && followUp.readQueryState({ ...tampered, carried: ["period", "period"] }) === null && followUp.readQueryState({ ...tampered, carried: ["compare"] }) === null && followUp.readQueryState({ ...tampered, carried: ["period", "tenantId"] }) === null && !!followUp.readQueryState(tampered));
  check("tenant", "every query ran for this tenant", saved.length > 0 && executed.every((e) => e.tenantId === TENANT));

  queryChat.tryAnswerWithQueryEngine = realTurn;
  console.log("\nReplay (turn 2, 'customers jiske wajah se sale giri'):\n" + t2.data.answer);
  console.log("\nDeeper follow-up (turn 3) findings:\n" + (t3.data.answer.split("**Step 1**")[0]));
  console.log(`\nverify-followup-context: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
