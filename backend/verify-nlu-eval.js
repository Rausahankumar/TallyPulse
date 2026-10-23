"use strict";

/**
 * NLU evaluation harness: measures how well TallyPulse understands natural-language questions, against
 * eval/nlu-corpus.json (synthetic names, expected plans in the existing queryPlan v1 contract). The planner is the
 * only interpreter (there is no deterministic router), so the evaluation is of the planner.
 *
 *   node verify-nlu-eval.js                       FREE: corpus self-check + scoring self-tests with fake providers (period mutations, a one-field-at-a-time
 *                                                  mutation test of the comparator, the UTC pin, and the 380-row bucket accounting). No Claude, no
 *                                                  database, no network (network is blocked and any attempt fails the run).
 *   node verify-nlu-eval.js --live --limit=20     LIVE: one existing-planner (Claude) call per question, no repair.
 *                                                  --limit is REQUIRED; more than 60 also needs --confirm-spend.
 *
 * Options: --group=<name>  --ids=nl_0001,nl_0002  --include-gaps  --include-followups (live: also the follow-up rows; the previous plan is passed to the
 *          planner as previousPlan)  --out=<file.json>  --verbose
 *
 * Scoring compares plans SEMANTICALLY: both plans go through the real validator (relative periods resolve against the corpus
 * reference date, defaults are applied) and are compared field by field - never as JSON text.
 * Expected-plan oracle execution against data is NOT done here: the corpus uses synthetic names, so there is no data to
 * query. The independent MongoDB oracles live in verify-planner-live-eval.js (tenant-specific, 18 questions).
 */

require("./eval/evalTimezone"); // FIRST: the evaluation runs in UTC whatever the machine's zone (E3)
process.env.AI_USAGE_PERSIST = "off"; // an evaluation never writes usage records
const fs = require("fs");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const LIVE = flag("live");
if (LIVE) require("dotenv").config({ quiet: true }); // the live planner needs ANTHROPIC_API_KEY
const VERBOSE = flag("verbose");
const LIMIT = opt("limit") === null ? null : Number(opt("limit"));
const OUT = opt("out");

// The free mode must be provably free: any network attempt is counted and fails the run.
let networkAttempts = 0;
if (!LIVE) {
  const http = require("http");
  const https = require("https");
  const block = () => {
    networkAttempts += 1;
    throw new Error("network is disabled in the free self-check");
  };
  global.fetch = block;
  http.request = block;
  https.request = block;
}

const { planQuestion, createAnthropicPlannerClient, uncalculableTermRefusal } = require("./src/services/query/planner");
const { parseQueryPlan } = require("./src/services/query/queryPlan.schema");
// The corpus, the semantic comparator and the scoring are shared with eval-nlu-models.js (one implementation for every model).
const { corpus, REF_DATE, canonical, diffPlans, makeResolver, scoreRow: scoreLive, needsDiagnostic, diagnose } = require("./eval/nluScoring");

const STATUSES = new Set(["supported", "clarify", "decline"]);
const LANGUAGES = new Set(["english", "hinglish", "mixed"]);

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

const lower = (v) => String(v).toLowerCase();

// ------------------------------------------------------------------ corpus self-check

function selfCheck() {
  section("corpus self-check");
  const ids = new Set();
  const names = Object.fromEntries(Object.entries(corpus.fixtures).map(([k, v]) => [k, new Set(v.map(lower))]));
  let n = 0;
  for (const r of corpus.rows) {
    n += 1;
    check(`${r.id}: unique id`, !ids.has(r.id));
    ids.add(r.id);
    check(`${r.id}: language/status valid`, LANGUAGES.has(r.language) && STATUSES.has(r.expected.status), `${r.language}/${r.expected.status}`);
    check(`${r.id}: question is a non-empty string`, typeof r.question === "string" && r.question.trim().length > 0);
    const gap = !!r.needsEngineCapability;
    const plan = r.expected.plan;
    if (r.expected.status === "supported" && !gap) check(`${r.id}: supported row has a plan`, !!plan);
    if (r.expected.status !== "supported") check(`${r.id}: ${r.expected.status} row has no plan`, !plan);
    if (plan) {
      const c = canonical(plan);
      check(`${r.id}: expected plan validates (${r.question.slice(0, 40)})`, !c.invalid, c.errors && c.errors.join(","));
      for (const f of plan.filters || []) for (const v of Array.isArray(f.value) ? f.value : [f.value]) if (names[f.dim]) check(`${r.id}: filter name "${v}" is a synthetic fixture`, names[f.dim].has(lower(v)));
    }
    if (r.previousPlan) {
      check(`${r.id}: previousPlan validates`, !canonical(r.previousPlan).invalid);
      check(`${r.id}: previousPlan only on follow_up rows`, r.group === "follow_up");
    }
    if (r.group === "follow_up") check(`${r.id}: follow_up rows carry a previousPlan`, !!r.previousPlan);
    if (plan && !canonical(plan).invalid) check(`${r.id}: a plan matches itself semantically`, diffPlans(plan, plan).length === 0);
  }
  check("no real tenant data: fixture names are the synthetic set", corpus.fixtures.customer.includes("Acme Traders"));
  console.log(`  ${n} corpus rows checked`);
}

// ------------------------------------------------------------------ shared

const bump = (o, k, by = 1) => {
  o[k] = (o[k] || 0) + by;
};

// ------------------------------------------------------------------ live: the existing planner, one call per question

function selectRows(rows) {
  let out = rows;
  if (opt("group")) out = out.filter((r) => r.group === opt("group"));
  if (opt("ids")) {
    const want = new Set(opt("ids").split(","));
    out = out.filter((r) => want.has(r.id));
  }
  return out;
}

async function runLive(rows) {
  const withFollowUps = flag("include-followups");
  const eligible = rows.filter((r) => (withFollowUps || !r.previousPlan) && (flag("include-gaps") || !r.needsEngineCapability));
  const skippedFollowUps = withFollowUps ? 0 : rows.filter((r) => r.previousPlan).length;
  const selected = eligible.slice(0, LIMIT);
  section(`live provider evaluation: existing Claude planner, ${selected.length} questions, 1 call each (up to 2 HTTP requests each if the SDK retries)`);
  console.log(`  ${withFollowUps ? "follow-up rows included: their previousPlan is passed to the planner" : `skipped ${skippedFollowUps} follow-up rows (add --include-followups to evaluate them with their previous plan)`}`);
  const provider = opt("provider") || "anthropic";
  if (provider !== "anthropic") throw new Error(`provider "${provider}" is not implemented (Phase 0 evaluates the existing Claude planner only)`);
  const client = createAnthropicPlannerClient();
  const resolver = makeResolver();
  const tot = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const results = [];
  for (const row of selected) {
    const t0 = Date.now();
    let planned;
    try {
      // no repair call, no history: the planner is judged on the question alone
      planned = await planQuestion(row.question, { claudeClient: client, resolveEntity: resolver, referenceDate: REF_DATE, maxRepairs: 0, ...(row.previousPlan ? { previousPlan: row.previousPlan } : {}) });
    } catch (e) {
      results.push({ id: row.id, group: row.group, language: row.language, question: row.question, outcome: "harness_error", error: `${e.name}: ${e.message}`.slice(0, 200), ms: Date.now() - t0 });
      continue;
    }
    const ms = Date.now() - t0;
    const u = planned.usage || {};
    for (const k of Object.keys(tot)) tot[k] += u[k] || 0;
    const exp = row.expected;
    const { got, outcome, diffs, executable } = scoreLive(row, planned);
    results.push({ id: row.id, group: row.group, language: row.language, question: row.question, expectedStatus: exp.status, got, plannerStatus: `${planned.status}${planned.code ? "/" + planned.code : ""}`, outcome, executable, diffs, diagnostic: needsDiagnostic(outcome) ? diagnose({ row, planned, outcome, got }) : null, usage: { calls: u.calls || 0, input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0, cache_creation_input_tokens: u.cache_creation_input_tokens || 0 }, ms });
    const last = results[results.length - 1];
    console.log(`  ${outcome.padEnd(22)} ${row.id} ${String(ms).padStart(5)}ms in=${last.usage.input_tokens} out=${last.usage.output_tokens}  "${row.question}"${diffs.length ? "  " + diffs.map((d) => `${d.field}: want ${d.expected} got ${d.actual}`).join(" | ") : ""}`);
  }
  return { results, tot };
}

function summariseLive({ results, tot }) {
  const scored = results.filter((r) => r.outcome !== "harness_error");
  const tally = {};
  for (const r of scored) bump(tally, r.outcome);
  const supported = scored.filter((r) => r.expectedStatus === "supported");
  const fieldWrong = {};
  for (const r of supported) for (const d of r.diffs) bump(fieldWrong, d.field);
  const lat = scored.map((r) => r.ms).sort((a, b) => a - b);
  const p = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : null);
  section("LIVE RESULTS (existing Claude planner)");
  console.log(`questions ${scored.length} | outcomes ${JSON.stringify(tally)}`);
  console.log(`plan correct on supported rows: ${supported.filter((r) => r.outcome === "plan_correct").length}/${supported.length}`);
  console.log(`WRONG BUT EXECUTABLE (a believable wrong answer would be shown): ${(tally.wrong_but_executable || 0)}`);
  console.log(`wrong fields among supported rows: ${JSON.stringify(fieldWrong)}`);
  console.log(`calls ${tot.calls} | input ${tot.input_tokens} | output ${tot.output_tokens} | cache read ${tot.cache_read_input_tokens} | cache write ${tot.cache_creation_input_tokens}  (raw usage; money is not calculated: no pricing table exists)`);
  console.log(`latency ms: p50 ${p(0.5)} | p95 ${p(0.95)} | max ${lat[lat.length - 1] ?? null}`);
  return { questions: scored.length, outcomes: tally, planCorrect: supported.filter((r) => r.outcome === "plan_correct").length, supportedRows: supported.length, wrongButExecutable: tally.wrong_but_executable || 0, wrongFields: fieldWrong, usage: tot, latencyMs: { p50: p(0.5), p95: p(0.95), max: lat[lat.length - 1] ?? null } };
}

// ------------------------------------------------------------------ self-test of the live scoring (fake providers)

/** The same plan for the previous period (a believable wrong answer that stays inside the years the question names, so the planner's own year guard cannot catch it). */
function shiftPeriod(period) {
  const back = (d) => {
    const [y, m, day] = d.split("-").map(Number);
    const mm = m > 1 ? m - 1 : 12;
    const yy = m > 1 ? y : y - 1;
    return `${yy}-${String(mm).padStart(2, "0")}-${String(Math.min(day, new Date(Date.UTC(yy, mm, 0)).getUTCDate())).padStart(2, "0")}`;
  };
  if (period.kind === "custom") return { kind: "custom", from: back(period.from), to: back(period.to) };
  if (period.kind === "specific_fy") return { kind: "specific_fy", fy: `${Number(period.fy.slice(0, 4)) - 1}-${String(Number(period.fy.slice(0, 4))).slice(2)}` };
  return { kind: period.kind === "previous_month" ? "current_month" : "previous_month" };
}

/** A fake planner "provider": answers every question from the corpus row itself. "mutated" returns the right plan for the WRONG (previous) period. */
function fakeProvider(mode, currentRow) {
  return async () => {
    const row = currentRow();
    const exp = row.expected;
    let input;
    if (exp.status === "supported" && exp.plan) {
      const plan = JSON.parse(JSON.stringify(exp.plan));
      if (mode === "mutated") plan.period = shiftPeriod(plan.period);
      input = { plan };
    } else input = { decline: { code: exp.status === "clarify" ? "needs_clarification" : "unsupported_domain", message: "fake provider" } };
    return { content: [{ type: "tool_use", id: "fake", name: "submit_query_plan", input }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  };
}

async function liveSelfTest() {
  section("live-scoring self-test (fake providers: no network, no spend)");
  const resolver = makeResolver();
  const rows = corpus.rows.filter((r) => !r.previousPlan && !r.needsEngineCapability);
  for (const mode of ["golden", "mutated"]) {
    let current = null;
    const client = fakeProvider(mode, () => current);
    const tally = {};
    const problems = [];
    const yearGuarded = [];
    for (const row of rows) {
      current = row;
      const planned = await planQuestion(row.question, { claudeClient: client, resolveEntity: resolver, referenceDate: REF_DATE, maxRepairs: 0 });
      const sc = scoreLive(row, planned);
      bump(tally, sc.outcome);
      const wantPlan = row.expected.status === "supported" && row.expected.plan;
      if (mode === "golden" && !["plan_correct", "correct_refusal", "refusal_accepted"].includes(sc.outcome)) problems.push(`${row.id} ${sc.outcome} ${planned.status}/${planned.code || ""}`);
      // A shifted custom range can move into a year the question never states (calendar 2025 -> Dec 2024..Nov 2025); the planner's year
      // guard then refuses the invented year (year_missing). That is the guard working, so it is accepted - it is still never plan_correct.
      const yearGuardRefusal = sc.outcome === "false_refusal" && planned.status === "needs_clarification" && planned.code === "year_missing" && planned.source === "date_guard";
      if (mode === "mutated" && yearGuardRefusal) yearGuarded.push(row.id);
      if (mode === "mutated" && wantPlan && !yearGuardRefusal && !["wrong_but_executable", "provider_failure", "refusal_accepted"].includes(sc.outcome)) problems.push(`${row.id} ${sc.outcome}`);
    }
    if (mode === "golden") check(`a perfect provider scores every non-gap row correct (${JSON.stringify(tally)})`, problems.length === 0, problems.slice(0, 6).join(" | "));
    else {
      check(`a provider that answers every question for the PREVIOUS period is caught as wrong_but_executable (or refused by the year guard when the shift invents an unstated year), never plan_correct (${JSON.stringify(tally)})`, problems.length === 0 && !tally.plan_correct, problems.slice(0, 6).join(" | "));
      check(`year-guard refusals stay the exception, only on custom ranges (${yearGuarded.join(",") || "none"})`, yearGuarded.length <= 3 && yearGuarded.every((id) => { const r = rows.find((x) => x.id === id); return r.expected.plan.period.kind === "custom"; }), yearGuarded.join(","));
    }
    console.log(`  ${mode}: ${JSON.stringify(tally)}`);
  }
}

/** Follow-up rows: the previous plan must reach the planner request as structured JSON (and nothing like chat history). */
async function followUpSelfTest() {
  section("follow-up rows: previousPlan reaches the planner (fake provider: no network, no spend)");
  const resolver = makeResolver();
  const rows = corpus.rows.filter((r) => r.previousPlan && !r.needsEngineCapability);
  let current = null;
  const seen = [];
  const inner = fakeProvider("golden", () => current);
  const client = async (request, opts) => {
    seen.push(request);
    return inner(request, opts);
  };
  const problems = [];
  const tally = {};
  for (const row of rows) {
    current = row;
    seen.length = 0;
    const planned = await planQuestion(row.question, { claudeClient: client, resolveEntity: resolver, referenceDate: REF_DATE, maxRepairs: 0, previousPlan: row.previousPlan });
    const sc = scoreLive(row, planned);
    bump(tally, sc.outcome);
    const content = seen.length ? seen[0].messages[0].content : "";
    const json = String(content).split("\n").find((l) => l.startsWith("{"));
    let back = null;
    try {
      back = JSON.parse(json);
    } catch (e) {
      /* reported below */
    }
    if (!back || back.entity !== row.previousPlan.entity || seen[0].messages.length !== 1) problems.push(`${row.id}: previous plan did not reach the planner`);
    if (!["plan_correct", "correct_refusal", "refusal_accepted"].includes(sc.outcome)) problems.push(`${row.id}: ${sc.outcome}`);
  }
  check(`every follow-up row delivers its previous plan to the planner request as JSON, one message, and the golden answer scores correct (${JSON.stringify(tally)})`, problems.length === 0, problems.slice(0, 5).join(" | "));
}

// ------------------------------------------------------------------ the comparator itself (E1, E6): one change at a time

const clone = (o) => JSON.parse(JSON.stringify(o));
const fieldsOf = (diffs) => diffs.map((d) => d.field);

// Known valid expected plans (synthetic names). Every mutation below changes exactly ONE thing in one of them.
const BASES = {
  trend: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_fy" }, metrics: ["invoiceAmount"], groupBy: [{ dim: "date", bucket: "month" }] },
  ranking: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "previous_month" }, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 5 },
  filtered: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" }, metrics: ["lineAmount"], filters: [{ dim: "product", op: "eq_ci", value: "LED Bulb 9W" }] },
  growth: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, compare: { mode: "full_previous" }, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], having: [{ metric: "invoiceAmount.delta", op: "gt", value: 0 }], sort: [{ by: "invoiceAmount.delta", dir: "desc" }], limit: 10 },
  comparison: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, compare: { mode: "full_previous" }, metrics: ["invoiceAmount"] },
  completeComparison: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "previous_month" }, compare: { mode: "like_for_like" }, metrics: ["invoiceAmount"] },
  list: { v: 1, entity: "sales", mode: "list", period: { kind: "current_month" }, sort: [{ by: "date", dir: "desc" }], limit: 10 },
  twoDims: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "previous_month" }, metrics: ["lineAmount"], groupBy: [{ dim: "customer" }, { dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 10 },
  names: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "previous_month" }, metrics: ["invoiceAmount"], filters: [{ dim: "customer", op: "in_ci", value: ["Acme Traders", "Zenith Retail"] }] },
  specificFy: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "specific_fy", fy: "2025-26" }, metrics: ["invoiceAmount"] },
  previousFyTrend: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "previous_fy" }, metrics: ["invoiceAmount"], groupBy: [{ dim: "date", bucket: "month" }] },
  byVoucherType: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "previous_month" }, metrics: ["invoiceAmount"], groupBy: [{ dim: "voucherType" }], sort: [{ by: "invoiceAmount", dir: "desc" }] },
};

// [what changed, base, how, the field the scorer must flag]. All of them stay VALID plans: the scorer must see a different MEANING, not an invalid plan.
const MUTATIONS = [
  ["metric: the only metric swapped (invoiceAmount -> invoiceCount)", "trend", (p) => (p.metrics = ["invoiceCount"]), "metrics"],
  ["metric: an expected metric is missing", "ranking", (p) => (p.metrics = ["invoiceAmount"]), "metrics"],
  ["metric: the second metric swapped for a different one", "ranking", (p) => (p.metrics = ["invoiceAmount", "averageInvoiceValue"]), "metrics"],
  ["entity: sales -> purchase", "list", (p) => (p.entity = "purchase"), "entity"],
  ["period: current FY -> previous FY", "trend", (p) => (p.period = { kind: "previous_fy" }), "period"],
  ["period: previous month -> current month", "ranking", (p) => (p.period = { kind: "current_month" }), "period"],
  ["period: a custom range moved by a month", "filtered", (p) => (p.period = { kind: "custom", from: "2025-08-01", to: "2025-08-31" }), "period"],
  ["groupBy: the dimension changed (customer -> voucherType)", "ranking", (p) => (p.groupBy = [{ dim: "voucherType" }]), "groupBy"],
  ["groupBy: removed", "trend", (p) => (p.groupBy = []), "groupBy"],
  ["groupBy: the date bucket changed (month -> week)", "trend", (p) => (p.groupBy = [{ dim: "date", bucket: "week" }]), "groupBy"],
  ["groupBy: a second dimension added", "ranking", (p) => (p.groupBy = [{ dim: "customer" }, { dim: "voucherType" }]), "groupBy"],
  ["filter operator: eq_ci -> contains_ci (same text)", "filtered", (p) => (p.filters[0].op = "contains_ci"), "filters"],
  ["filter removed", "filtered", (p) => (p.filters = []), "filters"],
  ["filter added", "ranking", (p) => (p.filters = [{ dim: "customer", op: "eq_ci", value: "Acme Traders" }]), "filters"],
  ["filter value changed", "filtered", (p) => (p.filters[0].value = "Widget Alpha"), "filters"],
  ["filter dimension changed (product -> productGroup, same text)", "filtered", (p) => (p.filters[0].dim = "productGroup"), "filters"],
  ["sort: direction flipped", "ranking", (p) => (p.sort = [{ by: "invoiceAmount", dir: "asc" }]), "sort"],
  ["sort: key changed (invoiceAmount -> invoiceCount)", "ranking", (p) => (p.sort = [{ by: "invoiceCount", dir: "desc" }]), "sort"],
  ["sort: the growth key changed (delta -> deltaPct)", "growth", (p) => ((p.sort = [{ by: "invoiceAmount.deltaPct", dir: "desc" }])), "sort"],
  ["limit: halved (a smaller ranking is a different answer)", "ranking", (p) => (p.limit = 2), "limit"],
  ["having: operator flipped (gt -> lt)", "growth", (p) => (p.having[0].op = "lt"), "having"],
  ["having: threshold changed", "growth", (p) => (p.having[0].value = 1000), "having"],
  ["having: removed", "growth", (p) => (p.having = []), "having"],
  ["comparison: full_previous -> like_for_like (a different baseline for a month to date)", "comparison", (p) => (p.compare = { mode: "like_for_like" }), "comparison"],
  ["comparison: removed", "comparison", (p) => (p.compare = null), "comparison"],
  ["comparison: -> same period last year", "comparison", (p) => (p.compare = { mode: "same_period_last_year" }), "comparison"],
];

// Equivalences the scorer deliberately accepts. Each must score plan_correct.
const EQUIVALENT = [
  ["filter: a one-value in_ci is eq_ci (the product's own equivalence: same regex, same validator treatment)", "filtered", (p) => (p.filters = [{ dim: "product", op: "in_ci", value: ["LED Bulb 9W"] }])],
  ["filter: names are case-insensitive", "filtered", (p) => (p.filters[0].value = "led bulb 9w")],
  ["filter: in_ci value order and case do not matter", "names", (p) => (p.filters[0].value = ["zenith retail", "ACME TRADERS"])],
  ["groupBy: dimension order does not matter", "twoDims", (p) => (p.groupBy = [p.groupBy[1], p.groupBy[0]])],
  ["metrics: order does not matter", "ranking", (p) => (p.metrics = ["invoiceCount", "invoiceAmount"])],
  ["metrics: an extra metric of the same grain cannot change the answer", "trend", (p) => (p.metrics = ["invoiceAmount", "invoiceCount"])],
  ["sort: omitting the default sort is stating it (a low-cardinality grouping needs no explicit sort)", "byVoucherType", (p) => (p.sort = [])],
  ["limit: omitting the default limit is stating it", "growth", (p) => delete p.limit],
  ["period: previous month = its custom range", "ranking", (p) => (p.period = { kind: "custom", from: "2025-11-01", to: "2025-11-30" })],
  ["period: current month to date = the same custom days", "list", (p) => (p.period = { kind: "custom", from: "2025-12-01", to: "2025-12-08" })],
  ["period: previous FY = its custom dates", "previousFyTrend", (p) => (p.period = { kind: "custom", from: "2024-04-01", to: "2025-03-31" })],
  ["period: a specific FY = its custom dates", "specificFy", (p) => (p.period = { kind: "custom", from: "2025-04-01", to: "2026-03-31" })],
  ["comparison: like_for_like = full_previous when the period is already complete", "completeComparison", (p) => (p.compare = { mode: "full_previous" })],
];

async function comparatorSelfTest() {
  section("comparator self-test: every important field is detected when it changes (E6), and only the established equivalences are accepted (E1)");
  const asRow = (plan) => ({ expected: { status: "supported", plan } });
  const scored = (plan, base) => scoreLive(asRow(base), { status: "supported", plan });

  for (const [name, base] of Object.entries(BASES)) {
    check(`base "${name}" is a valid plan and equals itself`, !canonical(base).invalid && diffPlans(clone(base), base).length === 0, JSON.stringify(canonical(base).errors));
  }
  for (const [label, baseName, mutate, field] of MUTATIONS) {
    const base = BASES[baseName];
    const plan = clone(base);
    mutate(plan);
    const valid = !canonical(plan).invalid;
    const diffs = valid ? diffPlans(plan, base) : [];
    const sc = valid ? scored(plan, base) : null;
    check(`MUTATION ${label}: still a valid plan, flagged in "${field}", scored wrong_but_executable`, valid && diffs.some((d) => d.field === field && !d.minor) && sc.outcome === "wrong_but_executable", valid ? `${JSON.stringify(fieldsOf(diffs))} ${sc.outcome}` : `invalid: ${canonical(plan).errors}`);
  }
  for (const [label, baseName, mutate] of EQUIVALENT) {
    const base = BASES[baseName];
    const plan = clone(base);
    mutate(plan);
    const valid = !canonical(plan).invalid;
    const sc = valid ? scored(plan, base) : null;
    check(`EQUIVALENT ${label}: accepted as plan_correct`, valid && diffPlans(plan, base).length === 0 && sc.outcome === "plan_correct", valid ? `${JSON.stringify(diffPlans(plan, base))} ${sc.outcome}` : `invalid: ${canonical(plan).errors}`);
  }
  const larger = clone(BASES.ranking);
  larger.limit = 10;
  check("limit: a LARGER limit is imprecise (acceptable, never exact); a smaller one is wrong", scored(larger, BASES.ranking).outcome === "plan_imprecise" && diffPlans(larger, BASES.ranking).every((d) => d.minor) && scored({ ...clone(BASES.ranking), limit: 2 }, BASES.ranking).outcome === "wrong_but_executable");
  // A scalar aggregate (no groupBy) returns totals only and the engine never applies its limit, so any limit there is the same answer.
  for (const [name, lim] of [["specificFy", 100], ["specificFy", 1], ["comparison", 100]]) {
    const p = { ...clone(BASES[name]), limit: lim };
    check(`limit: scalar aggregate "${name}" with limit ${lim} is still exactly correct (no limit diff)`, diffPlans(p, BASES[name]).length === 0 && scored(p, BASES[name]).outcome === "plan_correct", JSON.stringify(diffPlans(p, BASES[name])));
  }
  check("limit: a grouped date series keeps its limit difference (the rule is scalar-only)", fieldsOf(diffPlans({ ...clone(BASES.trend), limit: 50 }, BASES.trend)).includes("limit"));
  check("limit: list mode keeps its limit difference (list returns rows)", fieldsOf(diffPlans({ ...clone(BASES.list), limit: 50 }, BASES.list)).includes("limit") && scored({ ...clone(BASES.list), limit: 50 }, BASES.list).outcome === "plan_imprecise");

  // ---- E1: the filter operator, case by case
  const withFilter = (op, value) => ({ ...clone(BASES.filtered), filters: [{ dim: "product", op, value }] });
  const eq = withFilter("eq_ci", "LED Bulb 9W");
  const { FILTER_OPS } = require("./src/services/query/queryPlan.schema");
  check("E1 eq_ci vs contains_ci (same text) -> different, and the difference is in the filter", fieldsOf(diffPlans(withFilter("contains_ci", "LED Bulb 9W"), eq)).includes("filters") && scored(withFilter("contains_ci", "LED Bulb 9W"), eq).outcome === "wrong_but_executable");
  check("E1 contains_ci vs eq_ci -> different (both directions)", fieldsOf(diffPlans(eq, withFilter("contains_ci", "LED Bulb 9W"))).includes("filters"));
  const startsWith = withFilter("starts_with_ci", "LED Bulb 9W");
  check("E1 eq_ci vs starts_with_ci -> different: starts_with_ci is NOT an operator of the plan DSL (eq_ci, in_ci, contains_ci, new_in_period only), so the plan is invalid, and no equivalence is invented", !FILTER_OPS.includes("starts_with_ci") && canonical(startsWith).invalid === true && diffPlans(startsWith, eq).some((d) => d.field === "valid") && scored(startsWith, eq).outcome !== "plan_correct", JSON.stringify(diffPlans(startsWith, eq)));
  check("E1 eq_ci vs one-value in_ci -> equal in both directions (the established equivalence)", diffPlans(withFilter("in_ci", ["LED Bulb 9W"]), eq).length === 0 && diffPlans(eq, withFilter("in_ci", ["led bulb 9w"])).length === 0);
  check("E1 in_ci with TWO values vs eq_ci -> different", fieldsOf(diffPlans(withFilter("in_ci", ["LED Bulb 9W", "Widget Alpha"]), eq)).includes("filters"));
  check("E1 contains_ci vs one-value in_ci -> different (the equivalence is eq_ci only)", fieldsOf(diffPlans(withFilter("contains_ci", "LED Bulb 9W"), withFilter("in_ci", ["LED Bulb 9W"]))).includes("filters"));
  check("E1 identical operators and text -> equal (eq, contains, in_ci pair)", diffPlans(withFilter("eq_ci", "LED Bulb 9W"), eq).length === 0 && diffPlans(withFilter("contains_ci", "LED Bulb 9W"), withFilter("contains_ci", "led bulb 9w")).length === 0 && diffPlans(withFilter("in_ci", ["A One", "B Two"]), withFilter("in_ci", ["b two", "a one"])).length === 0);
  const newParty = { ...clone(BASES.ranking), filters: [{ dim: "customer", op: "new_in_period", value: "period" }] };
  const nameEq = { ...clone(BASES.ranking), filters: [{ dim: "customer", op: "eq_ci", value: "period" }] };
  check("E1 new_in_period vs eq_ci on the same dimension and text -> different", !canonical(newParty).invalid && fieldsOf(diffPlans(newParty, nameEq)).includes("filters"));
}

// ------------------------------------------------------------------ the deterministic D1-D3 term guards against the whole corpus

function termGuardCorpusSelfTest() {
  section("D1-D3 term guards vs the corpus: no supported row is refused, every decided-term row is");
  const KIND = { decline: "unsupported", clarify: "needs_clarification" };
  const planOf = (p) => (p ? parseQueryPlan(p).plan : null);
  const generic = parseQueryPlan({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "previous_month" }, metrics: ["invoiceAmount"], filters: [] }).plan;

  // (1) a row whose expected outcome is an answer must never be refused by the guard, given the plan the corpus expects (and its previous plan)
  const supported = corpus.rows.filter((r) => r.expected.status === "supported" && r.expected.plan);
  const falseRefusals = supported.map((r) => ({ r, g: uncalculableTermRefusal(r.question, planOf(r.expected.plan), planOf(r.previousPlan)) })).filter((x) => x.g);
  check(`none of the ${supported.length} supported corpus rows is refused by a term guard (no false refusal, English / Hinglish / mixed, follow-ups included)`, falseRefusals.length === 0, falseRefusals.slice(0, 4).map((x) => `${x.r.id}:${x.g.code}`).join(" "));

  // (2) every row that expects a refusal and uses a decided term is refused by the guard for a generic plan, with a kind the row accepts
  const decided = corpus.rows.filter((r) => /^D[1-3]\b/.test(r.note || "") && r.expected.status !== "supported");
  const wrong = [];
  for (const r of decided) {
    const g = uncalculableTermRefusal(r.question, generic, planOf(r.previousPlan));
    const accepted = [r.expected.status, ...(r.expected.alsoAccept || [])].map((k) => KIND[k]);
    if (!g || !accepted.includes(g.status)) wrong.push(`${r.id}:${g ? g.status : "not refused"}`);
  }
  check(`all ${decided.length} decided-term rows that expect a refusal or clarification are refused by the guard in a kind the row accepts`, decided.length >= 15 && wrong.length === 0, wrong.join(" "));

  // (3) other rows that use a guarded term (turnover, orders) expect a refusal too: the guard and the corpus never disagree about WHETHER to answer.
  // (Whether it is a decline or a clarification is the model's call; the guard is the fallback if the model produced a plan, and it never returns a figure.)
  const others = corpus.rows.filter((r) => !/^D[1-3]/.test(r.note || "")).map((r) => ({ r, g: uncalculableTermRefusal(r.question, r.expected.plan ? planOf(r.expected.plan) : generic, planOf(r.previousPlan)) })).filter((x) => x.g);
  check(`every other row that uses a guarded term (${others.length} rows, e.g. turnover, orders) expects a refusal, never an answer`, others.length >= 1 && others.every((x) => x.r.expected.status !== "supported"), others.filter((x) => x.r.expected.status === "supported").map((x) => x.r.id).join(" "));

  // (4) coverage of the corpus itself: the decided terms are present in English and Hinglish and as follow-ups
  const langs = new Set(decided.map((r) => r.language));
  check("the decided-term rows cover English and Hinglish and include follow-ups with a previous plan", langs.has("english") && langs.has("hinglish") && decided.some((r) => r.previousPlan), [...langs].join());
}

// ------------------------------------------------------------------ the evaluation's time zone (E3)

async function timezoneSelfTest() {
  section("E3: the evaluation runs in UTC whatever the machine's time zone (child processes started in other zones)");
  const path = require("path");
  const { spawnSync } = require("child_process");
  check("this process: TZ is UTC and the runtime applied it (offset 0 in January and in July)", process.env.TZ === "UTC" && [0, 6].every((m) => new Date(2025, m, 15).getTimezoneOffset() === 0));
  const scorer = path.join(__dirname, "eval", "nluScoring.js");
  const script = (afterLoad) => `
process.env.AI_USAGE_PERSIST = "off";
const S = require(${JSON.stringify(scorer)});
${afterLoad}
const v = (period) => ({ v: 1, entity: "sales", mode: "aggregate", period, metrics: ["invoiceAmount"] });
const pairs = [
  [v({ kind: "previous_month" }), v({ kind: "custom", from: "2025-11-01", to: "2025-11-30" })],
  [v({ kind: "current_month" }), v({ kind: "custom", from: "2025-12-01", to: "2025-12-08" })],
  [v({ kind: "previous_quarter" }), v({ kind: "custom", from: "2025-07-01", to: "2025-09-30" })],
  [v({ kind: "previous_fy" }), v({ kind: "custom", from: "2024-04-01", to: "2025-03-31" })],
  [v({ kind: "specific_fy", fy: "2025-26" }), v({ kind: "custom", from: "2025-04-01", to: "2026-03-31" })],
  [v({ kind: "last_7_days" }), v({ kind: "custom", from: "2025-12-02", to: "2025-12-08" })],
];
console.log(JSON.stringify({ tz: process.env.TZ, offsets: [0, 6].map((m) => new Date(2025, m, 15).getTimezoneOffset()), equal: pairs.map(([a, b]) => S.diffPlans(a, b).length === 0) }));`;
  const run = (zone, afterLoad = "") => {
    const r = spawnSync(process.execPath, ["-e", script(afterLoad)], { env: { ...process.env, TZ: zone }, encoding: "utf8", timeout: 60000 });
    try {
      return JSON.parse(String(r.stdout).trim().split("\n").pop());
    } catch (e) {
      return { error: `${r.status} ${String(r.stderr).slice(0, 200)}` };
    }
  };
  for (const zone of ["UTC", "Asia/Kolkata", "America/New_York", "America/Los_Angeles", "Pacific/Auckland"]) {
    const out = run(zone);
    check(`machine zone ${zone}: the scorer pins UTC and a relative period equals the custom dates it means, for all 6 period kinds`, out.tz === "UTC" && !!out.offsets && out.offsets.every((o) => o === 0) && Array.isArray(out.equal) && out.equal.length === 6 && out.equal.every(Boolean), JSON.stringify(out));
  }
  const control = run("UTC", `process.env.TZ = "America/New_York"; // control: switch the zone AFTER the scorer loaded, i.e. what an unpinned evaluator would see`);
  check("control: with the zone forced to America/New_York after the scorer loaded, relative-vs-custom comparisons DO break (so the pin is what makes the scores machine-independent)", Array.isArray(control.equal) && control.equal.some((x) => !x), JSON.stringify(control));
}

// ------------------------------------------------------------------ every row accounted for (E4)

async function accountingSelfTest() {
  section("E4: every evaluated row of the corpus sits in exactly one reporting bucket (fake providers, no network, no spend)");
  const runner = require("./eval/nluModelRunner");
  const resolver = makeResolver();
  const answer = (input) => async () => ({ content: [{ type: "tool_use", id: "fake", name: "submit_query_plan", input }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  const providers = {
    "a perfect provider": (row) => fakeProvider("golden", () => row),
    "a provider that answers for the wrong period": (row) => fakeProvider("mutated", () => row),
    "a provider that declines everything": () => answer({ decline: { code: "unsupported_domain", message: "fake" } }),
    "a provider that clarifies everything": () => answer({ decline: { code: "needs_clarification", message: "fake" } }),
    "a provider whose plans the validator rejects": () => answer({ plan: { v: 1, entity: "sales", mode: "aggregate", metrics: ["notARealMetric"], period: { kind: "current_month" } } }),
  };
  const total = corpus.rows.length;
  for (const [name, make] of Object.entries(providers)) {
    const records = [];
    for (const row of corpus.rows) records.push(await runner.evaluateRow({ row, target: { provider: "claude", model: null, label: name, client: make(row) }, resolver, cache: null }));
    const s = runner.aggregate(records);
    const sum = Object.values(s.buckets).reduce((a, b) => a + b, 0);
    const countSum = Object.values(s.counts).reduce((a, b) => a + b, 0);
    check(`${name}: all ${total} rows evaluated, bucket totals = ${total}, outcome counts = ${total}, partition OK`, s.questions === total && sum === total && countSum === total && s.partition.ok === true && runner.partitionProblem(s) === null && s.harnessErrors === 0 && s.skipped === 0, JSON.stringify(s.partition));
    console.log(`  ${runner.accountingLines([{ label: name, summary: s }])[1].trim()}`);
    if (name === "a perfect provider") check("a perfect provider has no wrong, invalid or failed row (at most the capability-gap rows, which have no expected plan, are refused)", s.buckets.wrongPlan === 0 && s.buckets.invalid === 0 && s.buckets.failure === 0 && s.buckets.refusalKindDiffers === 0 && s.buckets.falseRefusal <= corpus.rows.filter((r) => r.needsEngineCapability).length, JSON.stringify(s.buckets));
    if (name === "a provider that declines everything") check("false refusals and wrong-kind refusals are reported, not dropped", s.buckets.falseRefusal > 0 && s.buckets.refusalKindDiffers > 0 && s.buckets.correctRefusal > 0, JSON.stringify(s.buckets));
    if (name === "a provider that clarifies everything") check("the same for a provider that clarifies everything (a decline row answered by a clarification is a kind difference)", s.buckets.falseRefusal > 0 && s.buckets.refusalKindDiffers > 0, JSON.stringify(s.buckets));
    if (name === "a provider whose plans the validator rejects") check("rejected plans are counted as invalid", s.buckets.invalid > 0 && s.buckets.wrongPlan === 0, JSON.stringify(s.buckets));
  }
}

// ------------------------------------------------------------------ main

(async () => {
  selfCheck();
  if (!fail) await liveSelfTest();
  if (!fail) await followUpSelfTest();
  if (!fail) await comparatorSelfTest();
  if (!fail) termGuardCorpusSelfTest();
  if (!fail) await timezoneSelfTest();
  if (!fail) await accountingSelfTest();
  if (!LIVE || fail) {
    if (!LIVE) {
      check("the free self-check made no network attempts", networkAttempts === 0, networkAttempts);
      const mongoose = require("mongoose");
      check("the free self-check never opened a database connection", mongoose.connection.readyState === 0, mongoose.connection.readyState);
    }
    console.log(`\nverify-nlu-eval self-check: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  const rows = selectRows(corpus.rows);
  if (!rows.length) throw new Error("no corpus rows selected");
  const report = { generatedAt: new Date().toISOString(), mode: "live", corpusVersion: corpus.version, referenceDate: corpus.referenceDate, model: null, selectedRows: rows.length };

  if (!Number.isInteger(LIMIT) || LIMIT < 1) {
    console.log("\nLive mode spends API money and requires an explicit --limit=N (for example --limit=20). Nothing was called.");
    process.exit(2);
  }
  if (LIMIT > 60 && !flag("confirm-spend")) {
    console.log(`\n--limit=${LIMIT} is more than 60 questions. Add --confirm-spend to run it. Nothing was called.`);
    process.exit(2);
  }
  report.model = process.env.ANTHROPIC_PLANNER_MODEL || process.env.ANTHROPIC_MODEL || "(planner default)";
  const live = await runLive(rows);
  report.live = summariseLive(live);
  report.cases = live.results;
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nverify-nlu-eval: live run complete; harness checks ${pass} passed, ${fail} failed${OUT ? `; report written to ${OUT}` : ""}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
