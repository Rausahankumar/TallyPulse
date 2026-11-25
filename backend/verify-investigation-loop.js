/**
 * Bounded investigation loop (services/query/investigation.js), first slice.
 *
 * The REAL loop and the REAL executeAnalysisPlan (plan parser, query validator, name re-resolution, freshness and coverage
 * gates) run against an in-memory engine stub that answers like the query engine (rows ordered and cut by the plan's sort
 * and limit, totals over every row). Checks: a breakdown ordered against its change triggers ONE validated follow-up that
 * re-orders it toward the change; the answer then names the largest contributors from the follow-up, with provenance, and
 * reconciles; a sufficient plan runs once; the step, round, follow-up and time budgets stop the loop and say so; a
 * repeated plan and a having-filtered step are not followed up; a failed follow-up keeps round 1; the tenant comes from
 * the context only; and through the chat turn the follow-up costs no model call.
 *
 * No database, no network, no model. Run: node verify-investigation-loop.js
 */

process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const { investigate, proposeFollowUps, fingerprint, MAX_ROUNDS, MAX_TOTAL_STEPS } = require("./src/services/query/investigation");
const { executeAnalysisPlan: executeAnalysisPlanFor } = require("./src/services/query/analysisPlan");
const { formatAnalysisAnswer } = require("./src/services/query/analysisAnswer");
const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 700)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const r2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- in-memory engine (Oct 2025 vs Sep 2025, invoice amount)
const REF = new Date(2026, 9, 26, 12);
const DC = Object.freeze({ referenceDate: REF, source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 31), coverage: Object.freeze({ earliest: new Date(2025, 0, 1), latest: new Date(2025, 11, 31), lastSyncedAt: null }) });
// customer -> [Oct, Sep]: two rise a little, three fall a lot; net change is a fall
const DATA = { "Rise One": [900, 100], "Rise Two": [600, 200], "Fall One": [0, 5000], "Fall Two": [1000, 4000], "Fall Three": [500, 2000] };
const day = (y, m, d, end) => (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
function engine(log, { fail: failIf = () => false } = {}) {
  return async (plan, ctx) => {
    log.push({ plan: JSON.parse(JSON.stringify(plan)), tenantId: ctx.tenantId });
    if (failIf(plan)) return { result: { ok: false, errors: [{ code: "query_failed" }] } };
    const m = plan.metrics[0];
    const rows = Object.entries(DATA)
      .filter(([name]) => !(plan.filters || []).some((f) => f.dim === "customer" && !(Array.isArray(f.value) ? f.value : [f.value]).includes(name)))
      .map(([name, [cur, prev]]) => ({ key: { customer: name }, values: { [m]: cur }, comparison: { [m]: { previous: prev, delta: r2(cur - prev), deltaPct: prev ? r2(((cur - prev) / prev) * 100) : null } } }))
      .filter((r) => (plan.having || []).every((h) => (h.op === "gt" ? r.comparison[m].delta > h.value : h.op === "lt" ? r.comparison[m].delta < h.value : true)));
    const s = plan.sort && plan.sort[0];
    if (s && /\.delta$/.test(s.by)) rows.sort((a, b) => (s.dir === "asc" ? 1 : -1) * (a.comparison[m].delta - b.comparison[m].delta));
    const all = Object.values(DATA);
    const cur = all.reduce((t, x) => t + x[0], 0), prev = all.reduce((t, x) => t + x[1], 0);
    const limit = plan.limit || 10;
    return { result: { ok: true, entity: plan.entity, mode: "aggregate", period: { from: day(2025, 10, 1), to: day(2025, 10, 31, true), label: "October 2025" }, comparison: { from: day(2025, 9, 1), to: day(2025, 9, 30, true), label: "September 2025" }, metrics: plan.metrics, groupBy: plan.groupBy, rows: rows.slice(0, limit), totals: { values: { [m]: cur }, comparison: { [m]: { previous: prev, delta: r2(cur - prev), deltaPct: null } } }, truncated: rows.length > limit, rowLimit: limit, warnings: [], assumptions: [] } };
  };
}
const context = (log, opts) => ({ tenantId: "T-LOOP", dateContext: DC, execute: engine(log, opts), getFreshness: async () => ({ state: "fresh", message: "" }), resolveEntity: async ({ hintDim, text }) => ({ matches: Object.keys(DATA).includes(text) ? [{ dim: hintDim, value: text }] : [] }) });
const customers = (dir, limit, extra = {}) => ({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-10-01", to: "2025-10-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" } }, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], filters: [], sort: [{ by: "invoiceAmount.delta", dir }], limit, ...extra });
const opts = { referenceDate: REF, dataThrough: DC.latestVoucher };
const TOTAL = r2(Object.values(DATA).reduce((t, [c, p]) => t + c - p, 0)); // -8,700

(async () => {
  console.log("=== 1. Evidence-driven follow-up ===");
  {
    const log = [];
    const out = await investigate({ v: 1, steps: [{ id: "custs", kind: "query", plan: customers("desc", 2) }] }, context(log), opts);
    const st = out.execution.steps;
    check("loop-follow-up", "a list cut at 2 and ordered by largest INCREASE for a FALL triggers exactly one follow-up round, run through the validated executor", out.ok && out.investigation.rounds === 2 && out.investigation.followUps === 1 && st.length === 2 && log.length === 2, JSON.stringify(out.investigation));
    check("loop-remedy-shape", "the follow-up is the same query (entity, metric, periods, filters, limit) re-ordered by largest fall first - nothing else changed", log[1].plan.sort[0].dir === "asc" && log[1].plan.sort[0].by === "invoiceAmount.delta" && log[1].plan.limit === 2 && JSON.stringify({ ...log[1].plan, sort: null }) === JSON.stringify({ ...log[0].plan, sort: null }), JSON.stringify(log.map((l) => l.plan.sort)));
    check("loop-provenance", "the follow-up step carries its provenance (round 2, from step 1, why)", st[1].origin && st[1].origin.round === 2 && st[1].origin.from === 1 && /re-ordered by largest fall first/.test(st[1].origin.reason), JSON.stringify(st[1].origin));
    const text = formatAnalysisAnswer(out.execution, { ...opts, limitations: out.investigation.notes }).text;
    const k = out.execution && require("./src/services/query/evidence").buildEvidence(out.execution, opts).findings.filter((f) => f.label === "contributor");
    check("loop-answer", "the answer now names the largest contributors from the follow-up step (Fall One -5,000, Fall Two -3,000) and no longer leads with 'cannot show what drove it'", k.length === 1 && k[0].steps.join() === "2" && /^Largest contributors/.test(k[0].text) && /Fall One -₹5,000\.00/.test(k[0].text) && /Fall Two -₹3,000\.00/.test(k[0].text) && !/cannot show what drove it/.test(text), text.slice(0, 900));
    check("loop-reconciles", "the follow-up breakdown reconciles to the measured change exactly", k.length === 1 && k[0].values.total === TOTAL && r2(k[0].values.named + k[0].values.otherListed + k[0].values.notListed) === TOTAL, JSON.stringify(k[0] && k[0].values));
    check("loop-heading", "the answer shows the follow-up step with its provenance heading", /\*\*Step 2\*\* \(follow-up: step 1 re-ordered by largest fall first, the direction of its change\)/.test(text), text);
    check("loop-tenant", "every query of both rounds ran for the context's tenant only; no plan carries a tenant", log.every((l) => l.tenantId === "T-LOOP" && !JSON.stringify(l.plan).includes("tenant")));
  }

  console.log("\n=== 2. Sufficient evidence: no extra round ===");
  {
    const log = [];
    const out = await investigate({ v: 1, steps: [{ id: "custs", kind: "query", plan: customers("asc", 2) }] }, context(log), opts);
    check("loop-sufficient", "a list already ordered toward its change runs once (one round, one query)", out.investigation.rounds === 1 && out.investigation.stopReason === "sufficient" && log.length === 1 && out.investigation.notes.length === 0, JSON.stringify(out.investigation));
  }

  console.log("\n=== 3. Budgets, repeats and unresolvable needs ===");
  {
    // step budget: five against-change lists of different scopes leave room for one follow-up (6 steps in all)
    const log = [];
    const scoped = (i) => ({ id: `s${i}`, kind: "query", plan: customers("desc", 1, { filters: [{ dim: "customer", op: "in_ci", value: Object.keys(DATA).slice(i, i + 2) }] }) });
    const many = await investigate({ v: 1, steps: [0, 1, 2].map(scoped) }, context(log), opts);
    check("loop-follow-up-cap", "three open needs, two follow-ups per round: two are run, the third is stated as not followed up", many.investigation.followUps === 2 && many.execution.steps.length === 5 && many.investigation.notes.some((n) => /follow-up budget was used up/.test(n)), JSON.stringify(many.investigation));
    const four = { v: 1, steps: [0, 1, 2, 3].map(scoped) };
    const full = await investigate(four, context([]), opts);
    check("loop-step-cap", `never more than ${MAX_TOTAL_STEPS} steps in all, and never more than ${MAX_ROUNDS} rounds`, full.execution.steps.length <= MAX_TOTAL_STEPS && full.investigation.rounds <= MAX_ROUNDS, JSON.stringify(full.investigation));
    // time budget: a clock already past the deadline after round 1
    let t = 0;
    const late = await investigate({ v: 1, steps: [{ id: "custs", kind: "query", plan: customers("desc", 2) }] }, { ...context([]), now: () => t }, { ...opts, now: () => (t += 40000) });
    check("loop-time-budget", "no follow-up is started without time left; the answer says the breakdown could not be followed up", late.investigation.rounds === 1 && late.investigation.stopReason === "time_budget" && late.investigation.notes.some((n) => /time budget/.test(n)), JSON.stringify(late.investigation));
    // repeat: the remedy has already run
    const executedOnce = await investigate({ v: 1, steps: [{ id: "custs", kind: "query", plan: customers("desc", 2) }] }, context([]), opts);
    const fp = new Set(executedOnce.execution.steps.map((s) => fingerprint(s.request)));
    const again = proposeFollowUps(executedOnce.execution.steps.slice(0, 1), [{ kind: "rank_toward_change", step: 1, metric: "invoiceAmount", dir: -1 }], { executed: fp });
    check("loop-no-repeat", "a follow-up whose plan has already run is not run again (plan fingerprint)", again.steps.length === 0 && /already run/.test(again.unresolved[0].reason), JSON.stringify(again));
    // having: re-ordering cannot help
    const log2 = [];
    const filtered = await investigate({ v: 1, steps: [{ id: "custs", kind: "query", plan: customers("desc", 1, { having: [{ metric: "invoiceAmount.delta", op: "gt", value: -100000 }] }) }] }, context(log2), opts);
    check("loop-having", "a step whose rows are filtered by a having is not re-ordered (it could not change what comes back); the reason is stated", log2.length === 1 && filtered.investigation.stopReason === "no_remedy" && filtered.investigation.notes.some((n) => /having/.test(n)), JSON.stringify(filtered.investigation));
    // a failed follow-up keeps round 1 and says so
    const broken = await investigate({ v: 1, steps: [{ id: "custs", kind: "query", plan: customers("desc", 2) }] }, context([], { fail: (p) => p.sort[0].dir === "asc" }), opts);
    const bt = formatAnalysisAnswer(broken.execution, { ...opts, limitations: broken.investigation.notes }).text;
    check("loop-follow-up-fails", "a follow-up that fails leaves round 1's evidence (still 'cannot show what drove it') and the step says why it did not run", broken.ok && broken.execution.steps[1].status === "failed" && /cannot show what drove it/.test(bt) && /\*\*Step 2\*\* \(follow-up:[^\n]*\nNot run:/.test(bt), bt.slice(-700));
  }

  console.log("\n=== 4. Through the chat turn: no extra model call ===");
  {
    const replies = [{ decline: { code: "needs_analysis", message: "several analyses" } }, { analysis: { v: 1, steps: [{ id: "custs", kind: "query", plan: customers("desc", 2) }] } }];
    let calls = 0;
    const model = async (req) => { calls += 1; const r = replies.shift(); return { content: [{ type: "tool_use", name: req.tool_choice.name, input: r }], usage: { input_tokens: 10, output_tokens: 5 } }; };
    const log = [];
    const out = await tryAnswerWithQueryEngine({ context: { tenantId: "T-LOOP", userId: "u" }, userMessage: "Why did sales fall in October 2025 compared with September 2025?", conversationHistory: [], deps: { plannerClient: model, analysisEnabled: true, getFreshness: async () => ({ state: "fresh", message: "", dataAsOf: null }), getDateContext: async () => DC, execute: engine(log), resolveEntity: context([]).resolveEntity } });
    const meta = out.structured.details.queryEngine;
    check("chat-loop", "the chat turn answers through the investigation: 2 model calls (planner + analysis planner) only, 2 rounds, the follow-up step in the answer", out.handled && meta.status === "answered" && meta.claudeCalls === 2 && calls === 2 && meta.investigation && meta.investigation.rounds === 2 && meta.investigation.followUps === 1 && /\*\*Step 2\*\* \(follow-up:/.test(out.structured.answer) && /Largest contributors/.test(out.structured.answer), JSON.stringify({ meta, calls }));
  }

  console.log("\n=== 5. Model-chosen follow-up (stubbed model) ===");
  {
    const { parseAnalysisPlan } = require("./src/services/query/analysisPlan");
    const { SUMMARY_MAX_CHARS } = require("./src/services/query/investigation");
    // a list ordered against a fall AND filtered by a having: re-ordering cannot help, so only another query can
    const HAVING = { having: [{ metric: "invoiceAmount.delta", op: "gt", value: -100000 }] };
    const stuck = () => ({ v: 1, steps: [{ id: "custs", kind: "query", plan: customers("desc", 1, HAVING) }] });
    const model = (reply) => { const calls = []; const fn = async (summary) => { calls.push(summary); return typeof reply === "function" ? reply(summary) : reply; }; fn.calls = calls; return fn; };
    const proposal = (...plans) => ({ status: "supported", analysis: { v: 1, steps: plans.map((p, i) => ({ id: "custs", kind: "query", plan: p, ...(i ? { id: `more${i}` } : {}) })) }, definitionNotes: {}, usage: { calls: 1, input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });

    const log = [];
    const m1 = model(proposal(customers("asc", 2)));
    const ok1 = await investigate(stuck(), context(log), { ...opts, proposeWithModel: m1 });
    const st = ok1.execution.steps;
    const t1 = formatAnalysisAnswer(ok1.execution, { ...opts, limitations: ok1.investigation.notes }).text;
    check("model-follow-up", "no deterministic remedy (having): the model is asked ONCE, its 1-step plan runs through the executor, and the answer names the largest contributors from it", m1.calls.length === 1 && ok1.investigation.modelCalls === 1 && ok1.investigation.rounds === 2 && log.length === 2 && log[1].plan.sort[0].dir === "asc" && /Largest contributors[^\n]*Fall One -₹5,000\.00[^\n]*\(step 2\)/.test(t1), JSON.stringify(ok1.investigation));
    check("model-provenance", "the model's step carries provenance, a fresh id (no clash with 'custs') and its own heading", st[1].origin && st[1].origin.round === 2 && /proposed by the analysis planner for the open point of step 1/.test(st[1].origin.reason) && st[1].id !== "custs" && /\*\*Step 2\*\* \(follow-up: proposed by the analysis planner/.test(t1), JSON.stringify({ id: st[1].id, origin: st[1].origin }));
    check("model-usage", "the call's usage is returned for the turn's telemetry", ok1.investigation.usage.calls === 1 && ok1.investigation.usage.input_tokens === 50);
    check("model-tenant", "the model's follow-up ran for the context's tenant", log.every((l) => l.tenantId === "T-LOOP"));

    // what the model is told
    const summary = m1.calls[0];
    check("model-prompt-safe", `the evidence summary has the open point, the steps run and the findings; no tenant id, no result rows; at most ${SUMMARY_MAX_CHARS} chars`, /^Open points:\n- step 1: rank_toward_change on invoiceAmount \(change is a fall\); step 1 filters its rows \(having\)/.test(summary) && /Steps already run:\n1\. sales invoiceAmount by customer, 2025-10-01\.\.2025-10-31 vs 2025-09-01\.\.2025-09-30, sort invoiceAmount\.delta desc, limit 1/.test(summary) && /Findings so far:/.test(summary) && !/T-LOOP|tenant/i.test(summary) && !/"(values|comparison|key|rows)"/.test(summary) && summary.length <= SUMMARY_MAX_CHARS, summary);
    const { evidenceSummary } = require("./src/services/query/investigation");
    const long = evidenceSummary([], { findings: Array.from({ length: 40 }, (_, i) => ({ label: "measured", text: `finding ${i} `.repeat(30), steps: [1] })) }, [{ need: { step: 1, kind: "rank_toward_change", metric: "invoiceAmount", dir: -1 }, reason: "open" }]);
    check("model-prompt-cap", "a long evidence record is capped, and the open points (first) always survive", long.length <= SUMMARY_MAX_CHARS && long.startsWith("Open points:\n- step 1:"), long.length);

    // failures: every one leaves round 1 and an honest limitation, never a finding
    const safe = async (name, reply, re) => {
      const lg = [];
      const out = await investigate(stuck(), context(lg), { ...opts, proposeWithModel: model(reply) });
      const text = formatAnalysisAnswer(out.execution, { ...opts, limitations: out.investigation.notes }).text;
      check(`model-safe-${name}`, `${name}: nothing extra runs (1 engine query), the answer keeps 'cannot show what drove it' and states the limitation`, lg.length === 1 && out.investigation.modelCalls === 1 && out.investigation.stopReason === "no_remedy" && /cannot show what drove it/.test(text) && re.test(text) && !/Largest contributors/.test(text), `${JSON.stringify(out.investigation)}\n${text.slice(-500)}`);
    };
    await safe("invalid-plan", { status: "planner_failed", code: "planner_invalid_plan", usage: { calls: 1 } }, /proposed no usable follow-up \(planner_invalid_plan\)/);
    await safe("protocol-violation", { status: "planner_failed", code: "planner_protocol_violation", usage: { calls: 1 } }, /proposed no usable follow-up \(planner_protocol_violation\)/);
    await safe("decline", { status: "unsupported", code: "analysis_unsupported_domain", usage: { calls: 1 } }, /proposed no usable follow-up \(analysis_unsupported_domain\)/);
    await safe("call-throws", () => { throw new Error("planner down"); }, /could not be asked for a follow-up/);
    await safe("too-many-steps", proposal(customers("asc", 2), customers("asc", 3), customers("asc", 4)), /did not fit the investigation's budget/);
    const ran = parseAnalysisPlan(stuck()).plan.steps[0].plan;
    await safe("duplicate", proposal(ran), /repeats a step already run/);

    // no model call when the deterministic proposer settles the need
    const lgd = [];
    const unused = model(proposal(customers("asc", 2)));
    const det = await investigate({ v: 1, steps: [{ id: "custs", kind: "query", plan: customers("desc", 2) }] }, context(lgd), { ...opts, proposeWithModel: unused });
    check("model-not-needed", "a need the deterministic proposer settles never calls the model (0 calls, the re-ordered step runs)", unused.calls.length === 0 && det.investigation.modelCalls === 0 && det.investigation.followUps === 1 && lgd[1].plan.sort[0].dir === "asc", JSON.stringify(det.investigation));
    // one-call budget: the model's plan leaves the need open - no second call, the round budget says so
    const again = model(proposal(customers("desc", 2, HAVING))); // a different query that still cannot show the fall
    const once = await investigate(stuck(), context([]), { ...opts, proposeWithModel: again });
    check("model-one-call", "the model is never asked twice in one investigation; a need still open after its follow-up is stated at the round budget", again.calls.length === 1 && once.investigation.modelCalls === 1 && once.investigation.stopReason === "round_budget" && once.investigation.notes.some((n) => /stopped after 2 rounds/.test(n)), JSON.stringify(once.investigation));
    // the step budget: a plan at its 4-step maximum plus a 2-step model follow-up stays within the 6-step total
    const four = { v: 1, steps: [0, 1, 2].map((i) => ({ id: `s${i}`, kind: "query", plan: customers("asc", 1, { filters: [{ dim: "customer", op: "in_ci", value: Object.keys(DATA).slice(i, i + 2) }] }) })).concat([{ id: "stuck", kind: "query", plan: customers("desc", 1, HAVING) }]) };
    const two = model(proposal(customers("asc", 2), customers("asc", 3)));
    const capped = await investigate(four, context([]), { ...opts, proposeWithModel: two });
    check("model-step-budget", "4 steps run + a 2-step model follow-up = 6 steps, the total budget; never more", two.calls.length === 1 && capped.investigation.followUps === 2 && capped.execution.steps.length === MAX_TOTAL_STEPS, JSON.stringify(capped.investigation));
  }

  console.log("\n=== 6. Model follow-up through the chat turn (scripted model, real planner checks) ===");
  {
    const HAVING = { having: [{ metric: "invoiceAmount.delta", op: "gt", value: -100000 }] };
    const replies = [{ decline: { code: "needs_analysis", message: "several analyses" } }, { analysis: { v: 1, steps: [{ id: "custs", kind: "query", plan: customers("desc", 1, HAVING) }] } }, { analysis: { v: 1, steps: [{ id: "falls", kind: "query", plan: customers("asc", 2) }] } }];
    const requests = [];
    const model = async (req) => { requests.push(req); return { content: [{ type: "tool_use", name: req.tool_choice.name, input: replies.shift() }], usage: { input_tokens: 100, output_tokens: 10 } }; };
    const SYNC = "The last Sales sync attempt failed. Any data shown reflects the last successful sync, which may now be outdated.";
    const LATE = { ...DC, latestVoucher: new Date(2025, 9, 15) }; // October 2025 has data only to the 15th
    const log = [];
    const out = await tryAnswerWithQueryEngine({ context: { tenantId: "T-LOOP", userId: "u" }, userMessage: "Why did sales fall in October 2025 compared with September 2025?", conversationHistory: [], deps: { plannerClient: model, analysisEnabled: true, getFreshness: async () => ({ state: "sync_failed", message: SYNC, dataAsOf: null }), getDateContext: async () => LATE, execute: engine(log), resolveEntity: context([]).resolveEntity } });
    const meta = out.structured.details.queryEngine, ans = out.structured.answer;
    const third = requests[2] && requests[2].messages[0].content;
    check("chat-model-calls", "3 model calls in all (planner, analysis planner, ONE follow-up), counted in claudeCalls, usage and meta.investigation.modelCalls", requests.length === 3 && meta.claudeCalls === 3 && meta.usage.calls === 3 && meta.usage.input_tokens === 300 && meta.investigation.modelCalls === 1 && meta.investigation.rounds === 2 && out.telemetry.claudeCalls === 3, JSON.stringify({ meta, tel: out.telemetry && out.telemetry.claudeCalls }));
    check("chat-model-prompt", "the follow-up call sends the question plus the evidence summary, through the same tool, with no tenant", typeof third === "string" && third.startsWith("Why did sales fall in October 2025 compared with September 2025?\n\nEvidence already gathered") && /Open points:/.test(third) && !/T-LOOP/.test(third) && requests[2].tool_choice.name === requests[1].tool_choice.name, third);
    check("chat-model-answer", "the answer names the largest contributors from the model's follow-up, with its provenance heading", /Largest contributors[^\n]*\(step 2\)/.test(ans) && /\*\*Step 2\*\* \(follow-up: proposed by the analysis planner/.test(ans), ans.slice(0, 1500));
    check("chat-model-warnings", "incomplete-period and sync-failure warnings are kept", /\(incomplete: data only up to 2025-10-15\)/.test(ans) && /not a full-period change/.test(ans) && out.structured.warnings.includes(SYNC), JSON.stringify(out.structured.warnings));
  }

  console.log("\n=== 7. First hypothesis family: purchases behind a product's sales fall (synthetic data) ===");
  {
    const { buildEvidence } = require("./src/services/query/evidence");
    const PRODUCT = "Apple Shimla 1kg";
    // Sep 2026 vs Aug 2026, sales by customer (one product unless `products` is false); purchases by month from `buys`
    const engine7 = (log, { buys = {}, failPurchase = false } = {}) => async (plan, ctx) => {
      log.push({ plan: JSON.parse(JSON.stringify(plan)), tenantId: ctx.tenantId });
      const range = (p) => ({ from: new Date(`${p.from}T00:00:00`).toISOString(), to: new Date(`${p.to}T23:59:59.999`).toISOString() });
      if (plan.entity === "purchase") {
        if (failPurchase) return { result: { ok: false, errors: [{ code: "query_failed" }] } };
        const rows = Object.entries(buys).filter(([mo]) => `${mo}-01` >= plan.period.from && `${mo}-01` <= plan.period.to).map(([mo, [v, q]]) => ({ key: { date: { bucket: "month", start: `${mo}-01`, label: mo } }, values: { lineAmount: v, quantity: q } }));
        return { result: { ok: true, entity: "purchase", mode: "aggregate", period: range(plan.period), comparison: null, metrics: plan.metrics, groupBy: plan.groupBy, rows, totals: { values: { lineAmount: rows.reduce((t, r) => t + r.values.lineAmount, 0), quantity: rows.reduce((t, r) => t + r.values.quantity, 0) } }, truncated: false, rowLimit: 24, warnings: [], assumptions: [] } };
      }
      const data = { "Sharma Fruits": [0, 4000], "Gupta Mart": [0, 3000], "Rao Traders": [1600, 1500] };
      const rows = Object.entries(data).map(([k, [c, p]]) => ({ key: { customer: k }, values: { lineAmount: c }, comparison: { lineAmount: { previous: p, delta: r2(c - p), deltaPct: null } } })).sort((a, b) => a.comparison.lineAmount.delta - b.comparison.lineAmount.delta);
      return { result: { ok: true, entity: "sales", mode: "aggregate", period: range(plan.period), comparison: range(plan.compare.period), metrics: plan.metrics, groupBy: plan.groupBy, rows, totals: { values: { lineAmount: 1600 }, comparison: { lineAmount: { previous: 8500, delta: -6900, deltaPct: null } } }, truncated: false, rowLimit: 5, warnings: [], assumptions: [] } };
    };
    const DC7 = { ...DC, latestVoucher: new Date(2026, 8, 30), coverage: { earliest: new Date(2026, 0, 1), latest: new Date(2026, 9, 26), lastSyncedAt: null } };
    const opts7 = { referenceDate: REF, dataThrough: DC7.latestVoucher };
    const ctx7 = (log, o = {}, fresh = async () => ({ state: "fresh", message: "" })) => ({ tenantId: "T-SUPPLY", dateContext: DC7, execute: engine7(log, o), getFreshness: fresh, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) });
    const salesStep = (filters = [{ dim: "product", op: "eq_ci", value: PRODUCT }], to = "2026-09-30", cmpTo = "2026-08-31") => ({ v: 1, steps: [{ id: "who", kind: "query", plan: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2026-09-01", to }, compare: { mode: "custom", period: { kind: "custom", from: "2026-08-01", to: cmpTo } }, metrics: ["lineAmount"], groupBy: [{ dim: "customer" }], filters, sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 } }] });
    const FELL = { "2026-07": [6000, 100], "2026-08": [1800, 30], "2026-09": [1800, 30] };
    const FLAT = { "2026-07": [6000, 100], "2026-08": [6000, 100], "2026-09": [6200, 103] };
    const run7 = async (plan, o, fresh, dataThrough = DC7.latestVoucher) => {
      const log = [];
      const out = await investigate(plan, ctx7(log, o, fresh), { referenceDate: REF, dataThrough });
      const ev = buildEvidence(out.execution, { referenceDate: REF, dataThrough });
      return { log, out, ev, text: formatAnalysisAnswer(out.execution, { referenceDate: REF, dataThrough, limitations: out.investigation.notes, actions: true }).text }; // asked what to do: actions shown
    };

    // 1-2. the need and its window
    const first = await executeAnalysisPlanFor(salesStep(), ctx7([]));
    const need = buildEvidence(first, opts7).needs.find((n) => n.kind === "purchases_for_fall");
    check("supply-need", "a single-product sales fall (complete) with no purchase evidence creates a purchases_for_fall need for that product", !!need && need.product === PRODUCT && need.step === 1, JSON.stringify(buildEvidence(first, opts7).needs));
    check("supply-window", "the need's window is the decline comparison window from the executed step (from the month before the comparison period to the end of the fall), not a new year or a guessed period", !!need && need.from === "2026-07-01" && need.to === "2026-09-30", JSON.stringify(need));
    const multi = await executeAnalysisPlanFor(salesStep([]), ctx7([]));
    check("supply-multi-product", "a multi-product (unfiltered) fall never raises the single-product supply need", !buildEvidence(multi, opts7).needs.some((n) => n.kind === "purchases_for_fall"));

    // 3-4. a purchase fall: one validated follow-up, a qualified possible cause, a grounded action
    const fell = await run7(salesStep(), { buys: FELL });
    const fu = fell.log[1];
    check("supply-follow-up", "the follow-up runs through the executor: purchases of the SAME product by month over that window (line value and quantity), same tenant, provenance kept", fell.out.investigation.followUps === 1 && fu && fu.plan.entity === "purchase" && JSON.stringify(fu.plan.filters) === JSON.stringify([{ dim: "product", op: "eq_ci", value: PRODUCT }]) && fu.plan.period.from === "2026-07-01" && fu.plan.period.to === "2026-09-30" && JSON.stringify(fu.plan.metrics) === '["lineAmount","quantity"]' && fu.tenantId === "T-SUPPLY" && fell.out.execution.steps[1].origin && /did they fall with its sales \(step 1\)/.test(fell.out.execution.steps[1].origin.reason), JSON.stringify(fell.log.map((l) => l.plan)));
    const cause = fell.ev.findings.find((f) => f.label === "possible_cause");
    check("supply-cause-qualified", "a measured purchase fall (6,000 -> 1,800, Jul -> Aug) is a possible cause only: hedged, not stock on hand, not confirmed - never a proven shortage", !!cause && /fell from ₹6,000\.00 in Jul 2026 to ₹1,800\.00 in Aug 2026, before the sales fall in Sep 2026/.test(cause.text) && /may have limited/.test(cause.text) && /not stock on hand/.test(cause.text) && /not confirmed/.test(cause.text) && !/\bcaused\b|(was|is) (a )?shortage|shortage (caused|was)|was out of stock|ran out/i.test(fell.text), cause && cause.text);
    check("supply-action", "the action is to check supplier orders and availability, tied to the finding's steps, with no claim that stock was unavailable", fell.ev.recommendations.some((r) => /^Check supplier orders and the availability of Apple Shimla 1kg/.test(r.text) && /not stock levels/.test(r.text) && JSON.stringify(r.steps) === "[1,2]") && /\*\*Suggested next actions\*\*/.test(fell.text), JSON.stringify(fell.ev.recommendations));

    // 5. unchanged or increased purchases: no supply-side explanation
    const flat = await run7(salesStep(), { buys: FLAT });
    check("supply-no-fall", "purchases that did not fall: no possible cause and no supply claim, a measured 'no fall' and an evidence-gathering next action instead", !flat.ev.findings.some((f) => f.label === "possible_cause") && flat.ev.findings.some((f) => /show no fall of 10% or more from Jul 2026 to Sep 2026/.test(f.text)) && flat.ev.recommendations.some((r) => /did not fall, so review its customer orders and selling rates next/.test(r.text)) && !/supply|stock on hand|availability/i.test(flat.ev.recommendations.map((r) => r.text).join(" ")), JSON.stringify({ f: flat.ev.findings.map((f) => f.text), r: flat.ev.recommendations }));

    // 6. missing, failed, stale or incomplete purchase evidence: an explicit limitation
    const empty = await run7(salesStep(), { buys: {} });
    check("supply-empty", "no purchase records in the window: 'could not be established' and a next evidence action; no cause", empty.ev.gaps.some((g) => /Whether purchases of Apple Shimla 1kg fell with its sales could not be established: the purchase query returned no complete months/.test(g.text)) && !empty.ev.findings.some((f) => f.label === "possible_cause") && empty.ev.recommendations.some((r) => /Check the purchase records of Apple Shimla 1kg for Jul 2026 to Sep 2026/.test(r.text)), JSON.stringify(empty.ev.gaps));
    const failed = await run7(salesStep(), { buys: FELL, failPurchase: true });
    check("supply-failed", "a purchase query that failed: stated as not run, no cause", failed.ev.gaps.some((g) => /could not be established: the purchase query did not run/.test(g.text)) && !failed.ev.findings.some((f) => f.label === "possible_cause"), JSON.stringify(failed.ev.gaps));
    const stale = await run7(salesStep(), { buys: FELL }, async (t, vt) => (vt === "Purchase" ? { state: "sync_failed", message: "The last Purchase sync attempt failed." } : { state: "fresh", message: "" }));
    check("supply-stale", "stale purchase data (its sync failed): no possible cause, the limitation and a re-check after sync are stated", !stale.ev.findings.some((f) => f.label === "possible_cause") && stale.ev.gaps.some((g) => /may be out of date \(its last sync did not succeed\)/.test(g.text)) && stale.ev.recommendations.some((r) => /once the purchase sync succeeds/.test(r.text)), JSON.stringify(stale.ev.gaps));
    const lateBuys = { "2026-07": [6000, 100], "2026-08": [6000, 100], "2026-09": [600, 10] }; // the fall only in a month not yet complete
    const partial = await run7(salesStep(), { buys: lateBuys }, undefined, new Date(2026, 8, 30));
    const partialIncomplete = buildEvidence(partial.out.execution, { referenceDate: REF, dataThrough: "2026-09-15" });
    check("supply-incomplete-sales", "a sales fall in an incomplete period raises no supply need and no cause", !partialIncomplete.findings.some((f) => f.label === "possible_cause") && !partialIncomplete.needs.some((n) => n.kind === "purchases_for_fall"), JSON.stringify(partialIncomplete.findings.map((f) => f.label)));
    // a COMPLETE sales fall over 1-15 Sep (data through 15 Sep) whose purchase window reaches into September: that purchase month
    // is incomplete (it runs to the 30th) and its partial figure must not be read as a purchase fall
    const midMonth = await run7(salesStep(undefined, "2026-09-15", "2026-08-15"), { buys: lateBuys }, undefined, new Date(2026, 8, 15));
    check("supply-incomplete-purchases", "a complete sales fall: the follow-up runs, but the incomplete September purchase month is not read as a fall - no possible cause from it", midMonth.out.investigation.followUps === 1 && midMonth.log[1].plan.period.to === "2026-09-15" && !midMonth.ev.findings.some((f) => f.label === "possible_cause"), JSON.stringify({ inv: midMonth.out.investigation, f: midMonth.ev.findings.map((f) => `${f.label}: ${f.text.slice(0, 120)}`) }));

    // 7. recommendations only from findings
    check("supply-recs-grounded", "a step is derived only from evidence that points at something specific: here the one supply check (purchases of Apple fell before its sales), with those purchase figures, from steps that ran - no step for a customer merely because it fell (Sharma Fruits 58.0%) or has no current sales", fell.ev.recommendations.length === 1 && fell.ev.recommendations.every((r) => r.steps.length && r.steps.every((n) => fell.out.execution.steps[n - 1] && fell.out.execution.steps[n - 1].status === "ok")) && /^Check supplier orders and the availability of Apple Shimla 1kg/.test(fell.ev.recommendations[0].text) && /^purchases ₹6,000\.00 in Jul 2026 -> ₹1,800\.00 in Aug 2026/.test(fell.ev.recommendations[0].because) && fell.ev.recommendations[0].kind === "verify" && !fell.ev.recommendations.some((r) => /Sharma|Gupta/.test(r.text)), JSON.stringify(fell.ev.recommendations));

    // 9. budgets, de-duplication, provenance, warnings; the turn's scope is its plan's, not the follow-up's
    check("supply-budget-dedupe", "one follow-up round, one purchase query, never repeated (2 rounds, 2 steps, distinct plans)", fell.out.investigation.rounds === 2 && fell.out.execution.steps.length === 2 && new Set(fell.log.map((l) => JSON.stringify(l.plan))).size === fell.log.length);
    const replies = [{ decline: { code: "needs_analysis", message: "several analyses" } }, { analysis: salesStep() }];
    const model = async (req) => ({ content: [{ type: "tool_use", name: req.tool_choice.name, input: replies.shift() }], usage: { input_tokens: 1, output_tokens: 1 } });
    const SYNC = "The last Sales sync attempt failed. Any data shown reflects the last successful sync, which may now be outdated.";
    const chat = await tryAnswerWithQueryEngine({ context: { tenantId: "T-SUPPLY", userId: "u" }, userMessage: "Why are apple sales declining in September 2026 compared with August 2026?", conversationHistory: [], deps: { plannerClient: model, analysisEnabled: true, execute: engine7([], { buys: FELL }), getFreshness: async (t, vt) => (vt === "Sales" ? { state: "sync_failed", message: SYNC } : { state: "fresh", message: "" }), getDateContext: async () => DC7, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) } });
    const meta = chat.structured.details.queryEngine, qc = chat.queryContext;
    check("supply-chat", "through the chat turn: no extra model call (2), the follow-up step and its heading, the sync warning kept, and the saved follow-up scope is the PLAN's (sales of the product), not merged with the purchase follow-up", meta.claudeCalls === 2 && meta.investigation.followUps === 1 && /\*\*Step 2\*\* \(follow-up: purchases of Apple Shimla 1kg by month/.test(chat.structured.answer) && chat.structured.warnings.includes(SYNC) && !!qc && qc.plan.entity === "sales" && qc.carried.includes("filters"), JSON.stringify({ meta, qc }));
  }

  console.log(`\nverify-investigation-loop: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
