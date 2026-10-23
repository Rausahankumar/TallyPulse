"use strict";

/**
 * NLU evaluation harness: measures how well TallyPulse understands natural-language questions, against
 * eval/nlu-corpus.json (synthetic names, expected plans in the existing queryPlan v1 contract). The planner is the
 * only interpreter (there is no deterministic router), so the evaluation is of the planner.
 *
 *   node verify-nlu-eval.js                       FREE: corpus self-check + scoring self-tests with fake providers. No Claude, no
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

process.env.AI_USAGE_PERSIST = "off"; // an evaluation never writes usage records
const fs = require("fs");
const path = require("path");

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

const { validateQueryPlan } = require("./src/services/query/validator");
const { compileQuery } = require("./src/services/query/compile");
const { CATALOG } = require("./src/services/query/semanticCatalog");
const { createEntityResolver } = require("./src/services/query/entityResolver");
const { planQuestion, createAnthropicPlannerClient } = require("./src/services/query/planner");

const CORPUS_PATH = path.join(__dirname, "eval", "nlu-corpus.json");
const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));
const REF_DATE = (() => {
  const [y, m, d] = corpus.referenceDate.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999); // end of the local reference day, like the product's "today"
})();
const TENANT = "eval-tenant"; // a label only: nothing here queries a tenant

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

// ------------------------------------------------------------------ semantic plan comparison

const ms = (d) => (d instanceof Date ? d.getTime() : null);
const iso = (t) => (t === null ? null : new Date(t).toISOString().slice(0, 10));
const lower = (v) => String(v).toLowerCase();

/** The validator's own resolved form of a plan, reduced to the fields that carry meaning. Null when the plan is invalid. */
function canonical(plan) {
  const v = validateQueryPlan(plan, { referenceDate: REF_DATE });
  if (!v.ok) return { invalid: true, errors: v.errors.map((e) => e.code) };
  const n = v.normalized;
  return {
    entity: n.entity,
    mode: n.mode,
    period: `${iso(ms(n.period.from))}..${iso(ms(n.period.to))}`,
    comparison: n.comparison ? `${iso(ms(n.comparison.from))}..${iso(ms(n.comparison.to))}` : "none",
    metrics: [...n.metrics].sort(),
    groupBy: n.groupBy.map((g) => (g.dim === "date" ? `date:${g.bucket}` : g.dim)).sort(),
    filters: n.filters.map((f) => `${f.dim}=${(Array.isArray(f.value) ? f.value : [f.value]).map(lower).sort().join("|")}`).sort(),
    having: n.having.map((h) => `${h.metric} ${h.op} ${h.value}`).sort(),
    sort: n.sort.map((s) => `${s.by} ${s.dir}`),
    limit: n.limit,
  };
}

/**
 * Field-level differences between an actual and an expected plan ({field, expected, actual, minor?}); empty = semantically equal.
 * An extra metric of the same grain as an expected one (e.g. invoiceCount next to invoiceAmount) is NOT a difference: the ranking is
 * compared through "sort", so an extra column cannot change the answer. A larger row limit is a MINOR difference (it still contains
 * what was asked, plus more rows). Every other difference is MAJOR: it changes the financial meaning of the answer.
 */
function diffPlans(actual, expected) {
  const a = canonical(actual);
  const e = canonical(expected);
  if (a.invalid) return [{ field: "valid", expected: "valid plan", actual: `invalid: ${a.errors.join(",")}` }];
  if (e.invalid) return [{ field: "expected", expected: "valid expected plan", actual: `corpus bug: ${e.errors.join(",")}` }];
  const out = [];
  for (const k of ["entity", "mode", "period", "comparison"]) if (a[k] !== e[k]) out.push({ field: k, expected: e[k], actual: a[k] });
  if (a.limit !== e.limit) out.push({ field: "limit", expected: e.limit, actual: a.limit, minor: typeof a.limit === "number" && typeof e.limit === "number" && a.limit > e.limit });
  // metrics: every expected metric must be present; an extra metric is minor only if it shares the grain (invoice / line / return) of an expected one
  const grain = (m) => (CATALOG.metrics[m] ? CATALOG.metrics[m].grain : null);
  const missing = e.metrics.filter((m) => !a.metrics.includes(m));
  const extra = a.metrics.filter((m) => !e.metrics.includes(m));
  if (missing.length) out.push({ field: "metrics", expected: e.metrics.join(","), actual: a.metrics.join(",") });
  else if (extra.some((m) => !e.metrics.some((x) => grain(x) === grain(m)))) out.push({ field: "metrics", expected: e.metrics.join(","), actual: a.metrics.join(",") });
  for (const k of ["groupBy", "filters", "having"]) if (a[k].join(";") !== e[k].join(";")) out.push({ field: k, expected: e[k].join(";") || "-", actual: a[k].join(";") || "-" });
  if (a.sort.join(";") !== e.sort.join(";")) out.push({ field: "sort", expected: e.sort.join(";"), actual: a.sort.join(";") });
  return out;
}

/** Could the engine compile this validated plan into a pipeline? (no database is touched) */
function compiles(plan) {
  try {
    const v = validateQueryPlan(plan, { referenceDate: REF_DATE });
    if (!v.ok) return false;
    compileQuery(v.normalized, { tenantId: TENANT, groupItemNames: [], newPartyNames: [] });
    return true;
  } catch (e) {
    return false;
  }
}

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

function makeResolver() {
  const list = (dim) => async () => corpus.fixtures[dim];
  return createEntityResolver({ tenantId: TENANT, sources: { customer: list("customer"), supplier: list("supplier"), product: list("product"), productGroup: list("productGroup") } });
}

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

/** Score one planner answer against the row's expectation. A plan where a refusal was expected, or a plan with the wrong meaning, is "wrong_but_executable" when the engine could compile it. */
function scoreLive(row, planned) {
  const exp = row.expected;
  const also = exp.alsoAccept || [];
  const got = planned.status === "supported" ? "supported" : planned.status === "needs_clarification" ? "clarify" : planned.status === "unsupported" ? "decline" : "failure";
  let outcome;
  let diffs = [];
  let executable = null;
  if (got === "failure") outcome = "provider_failure";
  else if (got === "supported") {
    executable = compiles(planned.plan);
    if (exp.status === "supported" && exp.plan) {
      diffs = diffPlans(planned.plan, exp.plan);
      outcome = !diffs.length ? "plan_correct" : diffs.every((d) => d.minor) ? "plan_imprecise" : executable ? "wrong_but_executable" : "wrong_not_executable";
    } else outcome = also.includes("supported") ? "plan_correct" : executable ? "wrong_but_executable" : "wrong_not_executable";
  } else if (exp.status === "supported") outcome = also.includes(got) ? "refusal_accepted" : "false_refusal";
  else outcome = got === exp.status || also.includes(got) ? "correct_refusal" : "refusal_kind_differs";
  return { got, outcome, diffs, executable };
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
    results.push({ id: row.id, group: row.group, language: row.language, question: row.question, expectedStatus: exp.status, got, plannerStatus: `${planned.status}${planned.code ? "/" + planned.code : ""}`, outcome, executable, diffs, usage: { calls: u.calls || 0, input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0, cache_creation_input_tokens: u.cache_creation_input_tokens || 0 }, ms });
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
    for (const row of rows) {
      current = row;
      const planned = await planQuestion(row.question, { claudeClient: client, resolveEntity: resolver, referenceDate: REF_DATE, maxRepairs: 0 });
      const sc = scoreLive(row, planned);
      bump(tally, sc.outcome);
      const wantPlan = row.expected.status === "supported" && row.expected.plan;
      if (mode === "golden" && !["plan_correct", "correct_refusal", "refusal_accepted"].includes(sc.outcome)) problems.push(`${row.id} ${sc.outcome} ${planned.status}/${planned.code || ""}`);
      if (mode === "mutated" && wantPlan && !["wrong_but_executable", "provider_failure", "refusal_accepted"].includes(sc.outcome)) problems.push(`${row.id} ${sc.outcome}`);
    }
    if (mode === "golden") check(`a perfect provider scores every non-gap row correct (${JSON.stringify(tally)})`, problems.length === 0, problems.slice(0, 6).join(" | "));
    else check(`a provider that answers every question for the PREVIOUS period is caught as wrong_but_executable, never plan_correct (${JSON.stringify(tally)})`, problems.length === 0 && !tally.plan_correct, problems.slice(0, 6).join(" | "));
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

// ------------------------------------------------------------------ main

(async () => {
  selfCheck();
  if (!fail) await liveSelfTest();
  if (!fail) await followUpSelfTest();
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
