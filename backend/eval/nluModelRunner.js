"use strict";

/**
 * Library behind eval-nlu-models.js: runs the SAME corpus rows through the production planner (planQuestion, unchanged) with
 * different models behind the planner's client seam, scores every answer with the shared semantic scorer, and aggregates the
 * measurements. NLU only: nothing here touches a database, Tally or real business data - the corpus is synthetic.
 *
 * Pure logic and file caching live here so they can be tested offline; the CLI only wires arguments, keys and output.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { planQuestion, getPlannerPrompt, PLANNER_MAX_TOKENS } = require("../src/services/query/planner");
const scoring = require("./nluScoring");

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

// ---------------------------------------------------------------------------------------------------------------
// Targets (what is being evaluated)

const MODEL_SPEC = /^(?:openrouter:)?([A-Za-z0-9][A-Za-z0-9._~:@+-]*\/[A-Za-z0-9][A-Za-z0-9._~:@+/-]*)$/;

/**
 * "claude" -> the existing Claude planner (the baseline); "openrouter:vendor/model" or a bare "vendor/model" -> an OpenRouter
 * model. Duplicates are dropped; anything else is an error (nothing is guessed).
 */
function parseModelSpecs(list) {
  const out = [];
  const seen = new Set();
  for (const raw of String(list || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const spec = raw.toLowerCase() === "claude" ? { provider: "claude", model: null, label: "claude" } : null;
    let parsed = spec;
    if (!parsed) {
      const m = raw.match(MODEL_SPEC);
      if (!m) throw new Error(`Unrecognised model "${raw}": use "claude" or an OpenRouter id like "vendor/model-name".`);
      parsed = { provider: "openrouter", model: m[1], label: m[1] };
    }
    if (seen.has(parsed.label)) continue;
    seen.add(parsed.label);
    out.push(parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Row selection and cache keys

/** n rows evenly spaced through the list, in corpus order: the corpus is grouped, so this keeps the mix of groups, languages and follow-ups. */
function sampleEvenly(rows, n) {
  if (!Number.isInteger(n) || n < 1 || n >= rows.length) return rows;
  return Array.from({ length: n }, (_, i) => rows[Math.floor((i * rows.length) / n)]);
}

function selectRows(rows, { group, ids, includeFollowUps = true, includeGaps = true, limit = null, sample = null } = {}) {
  let out = rows;
  if (group) out = out.filter((r) => r.group === group);
  if (ids && ids.length) {
    const want = new Set(ids);
    out = out.filter((r) => want.has(r.id));
  }
  if (!includeFollowUps) out = out.filter((r) => !r.previousPlan);
  if (!includeGaps) out = out.filter((r) => !r.needsEngineCapability);
  if (Number.isInteger(sample) && sample > 0) out = sampleEvenly(out, sample);
  return Number.isInteger(limit) && limit > 0 ? out.slice(0, limit) : out;
}

/** Everything that changes what a model is asked: planner prompt + tool schema + token cap + corpus version + client settings. */
function configFingerprint(clientSettings = {}) {
  const prompt = getPlannerPrompt();
  return sha(JSON.stringify({ system: prompt.system.map((b) => b.text), tool: prompt.tool, maxTokens: PLANNER_MAX_TOKENS, corpusVersion: scoring.corpus.version, referenceDate: scoring.corpus.referenceDate, client: clientSettings })).slice(0, 16);
}

const rowKey = (row) => sha(`${row.id}\u0000${row.question}\u0000${JSON.stringify(row.previousPlan || null)}`).slice(0, 24);

/**
 * File-backed cache of raw model answers for ONE (provider, model, configuration). The configuration fingerprint is part of the
 * file name, so answers produced under a different prompt, schema, corpus or client setting are never reused. Failures
 * (timeouts, HTTP errors) are never cached - only answers the model actually gave.
 */
class ResponseCache {
  constructor(file) {
    this.file = file;
    this.entries = {};
    this.dirty = false;
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") this.entries = parsed.entries;
      } catch (e) {
        this.entries = {}; // an unreadable cache is just a cold cache
      }
    }
  }

  get(key) {
    return this.entries[key] || null;
  }

  set(key, entry) {
    this.entries[key] = entry;
    this.dirty = true;
  }

  flush() {
    if (!this.file || !this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
}

const cacheFileName = (target, fingerprint) => `${target.provider}-${String(target.model || "default").replace(/[^A-Za-z0-9._-]+/g, "_")}-${fingerprint}.json`;

// ---------------------------------------------------------------------------------------------------------------
// Bounded concurrency

/** Run `worker(item, index)` for every item with at most `concurrency` in flight; results keep the input order. */
async function runPool(items, concurrency, worker) {
  const limit = Math.max(1, Math.floor(Number(concurrency)) || 1);
  const results = new Array(items.length);
  let next = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  async function lane() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        results[i] = await worker(items[i], i);
      } finally {
        inFlight -= 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return { results, maxInFlight };
}

// ---------------------------------------------------------------------------------------------------------------
// One row, one target

const META_KEYS = ["attempts", "retries", "retryReasons", "httpStatus", "finishReason", "servedModel", "providerName", "cost", "structuredMode", "malformedReason", "fenceStripped", "latencyMs"];
const pickMeta = (meta) => Object.fromEntries(META_KEYS.filter((k) => meta[k] !== undefined).map((k) => [k, meta[k]]));
/** A JSON-safe copy of a provider response (only what the planner reads). */
const portable = (response) => ({ model: response && response.model, content: JSON.parse(JSON.stringify((response && response.content) || [])), usage: response && response.usage ? { ...response.usage } : {}, stop_reason: response && response.stop_reason });

// A target that is refused this many times in a row (HTTP 401/402/403/404/429: credits, quota, availability, access) is halted: the
// remaining rows are recorded as skipped instead of hammering a provider that has said no.
const HALT_AFTER_REFUSALS = 3;
const REFUSAL_STATUS = new Set([401, 402, 403, 404, 429]);

const newTargetState = () => ({ consecutiveRefusals: 0, halted: null, requests: 0, freeViolations: 0, servedModelMismatches: 0 });

/** The plan a model submitted, exactly as it came back (null when it sent none): lets a REJECTED plan be diagnosed. */
function submittedPlan(response) {
  const blocks = response && Array.isArray(response.content) ? response.content : [];
  const use = blocks.find((b) => b && b.type === "tool_use" && b.input && typeof b.input === "object" && b.input.plan && typeof b.input.plan === "object" && !Array.isArray(b.input.plan));
  return use ? use.input.plan : null;
}

async function evaluateRow({ row, target, resolver, cache }) {
  const key = rowKey(row);
  const meta = {};
  const state = target.state || (target.state = newTargetState());
  const base = {
    id: row.id,
    group: row.group,
    language: row.language,
    categories: scoring.categoriesOf(row),
    question: row.question,
    expectedStatus: row.expected.status,
    modelId: target.model || null,
    pricingStatus: target.pricingStatus || null,
  };
  if (state.halted) return { ...base, outcome: "skipped", skipReason: state.halted };
  let called = false;
  let lastResponse = null; // the one provider response of this row (no repair call), for the diagnostic
  const client = async (request, options = {}) => {
    const hit = cache ? cache.get(key) : null;
    if (hit) {
      Object.assign(meta, hit.meta, { cached: true });
      called = true;
      lastResponse = hit.response;
      return hit.response;
    }
    if (state.halted) throw Object.assign(new Error("This model was halted; no request was made."), { code: "TARGET_HALTED" });
    if (target.throttle) await target.throttle(); // request-rate cap shared by every model on the same provider
    called = true;
    state.requests += 1;
    const started = Date.now();
    try {
      const response = await target.client(request, { ...options, meta });
      lastResponse = response;
      meta.latencyMs = Date.now() - started;
      if (response && response.model && !meta.servedModel) meta.servedModel = response.model;
      if (cache) cache.set(key, { response: portable(response), meta: pickMeta(meta) });
      return response;
    } catch (error) {
      meta.latencyMs = Date.now() - started;
      meta.errorCode = error && error.code ? String(error.code) : (error && error.name) || "Error";
      meta.errorMessage = String((error && error.message) || "").replace(/\s+/g, " ").slice(0, 200); // already redacted by the client
      if (error && error.status) meta.httpStatus = error.status;
      throw error;
    }
  };
  let planned;
  try {
    // The production planner, unchanged: same prompt, contract, guards. No repair call, no history: judged on the question alone.
    planned = await planQuestion(row.question, { claudeClient: client, resolveEntity: resolver, referenceDate: scoring.REF_DATE, maxRepairs: 0, ...(row.previousPlan ? { previousPlan: row.previousPlan } : {}) });
  } catch (error) {
    return { ...base, outcome: "harness_error", error: `${error.name}: ${String(error.message).slice(0, 160)}` };
  }
  const { got, outcome, diffs, executable } = scoring.classifyPlanned(row, planned);
  const usage = planned.usage || {};
  // Why a row did not score cleanly (ids, codes and counts only - see scoring.diagnose); null for a clean row.
  const diagnostic = scoring.needsDiagnostic(outcome) ? scoring.diagnose({ row, planned, outcome, got, rawPlan: submittedPlan(lastResponse) }) : null;

  // ---- keep the provider honest: halt on a paid signal or on repeated refusals
  if (meta.servedModelMismatch) state.servedModelMismatches += 1;
  if (meta.freeViolation) {
    state.freeViolations += 1;
    state.halted = "a response reported a non-zero cost for a model that must be free: this model was not called again";
  } else if (outcome === "provider_failure" && REFUSAL_STATUS.has(meta.httpStatus)) {
    state.consecutiveRefusals += 1;
    if (state.consecutiveRefusals >= HALT_AFTER_REFUSALS) state.halted = `the provider refused ${state.consecutiveRefusals} requests in a row (last HTTP ${meta.httpStatus}): most likely a quota, credit or availability limit, so this model was not called again`;
  } else if (called && !meta.cached && outcome !== "provider_failure" && outcome !== "timeout") state.consecutiveRefusals = 0;

  return {
    ...base,
    got,
    plannerStatus: `${planned.status}${planned.code ? `/${planned.code}` : ""}`,
    outcome,
    executable,
    diffs,
    calledModel: called,
    cached: !!meta.cached,
    latencyMs: called && Number.isFinite(meta.latencyMs) ? meta.latencyMs : null,
    usage: { calls: usage.calls || 0, input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, cache_read_input_tokens: usage.cache_read_input_tokens || 0, cache_creation_input_tokens: usage.cache_creation_input_tokens || 0 },
    attempts: meta.attempts ?? null,
    retries: meta.retries ?? 0,
    retryReasons: meta.retryReasons || [],
    errorMessage: meta.errorMessage || null,
    httpStatus: meta.httpStatus ?? null,
    errorCode: meta.errorCode || null,
    finishReason: meta.finishReason || null,
    structuredMode: meta.structuredMode || null,
    malformedReason: meta.malformedReason || null,
    providerReportedCost: Number.isFinite(meta.cost) ? meta.cost : null,
    servedModel: meta.servedModel || null,
    servedModelMismatch: !!meta.servedModelMismatch,
    providerName: meta.providerName || null,
    freeViolation: meta.freeViolation || null,
    diagnostic,
  };
}

/** A request-rate cap: successive provider requests start at least 60000/rpm ms apart. Shared by every model on one provider. */
function createSpacer(requestsPerMinute, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const gap = Math.ceil(60000 / Math.max(1, requestsPerMinute));
  let nextAt = 0;
  return async function throttle() {
    const startAt = Math.max(now(), nextAt);
    nextAt = startAt + gap;
    const wait = startAt - now();
    if (wait > 0) await sleep(wait);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Aggregation

function percentile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** The measurements for a set of per-row records. Percentages are of all scored rows (harness errors are excluded and counted). */
function aggregate(records) {
  const scored = records.filter((r) => r.outcome !== "harness_error" && r.outcome !== "skipped");
  const n = scored.length;
  const counts = Object.fromEntries(scoring.OUTCOMES.map((o) => [o, 0]));
  for (const r of scored) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  const sum = (set) => scored.filter((r) => set.has(r.outcome)).length;
  const exact = sum(scoring.EXACT);
  const acceptable = sum(scoring.ACCEPTABLE);
  const wrong = sum(scoring.WRONG_PLAN);
  const invalid = sum(scoring.INVALID);
  const failure = sum(scoring.FAILURE);
  const latencies = scored.filter((r) => Number.isFinite(r.latencyMs)).map((r) => r.latencyMs).sort((a, b) => a - b);
  const tokens = scored.reduce(
    (t, r) => ({
      input: t.input + r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens,
      cachedInput: t.cachedInput + r.usage.cache_read_input_tokens,
      output: t.output + r.usage.output_tokens,
      calls: t.calls + r.usage.calls,
    }),
    { input: 0, cachedInput: 0, output: 0, calls: 0 }
  );
  const supported = scored.filter((r) => r.expectedStatus === "supported");
  const wrongFields = {};
  for (const r of supported) for (const d of r.diffs || []) wrongFields[d.field] = (wrongFields[d.field] || 0) + 1;
  // Accounting: rows that were not evaluated are exactly the harness errors and the skipped rows (a halted model); everything else is
  // evaluated and sits in exactly ONE bucket (scoring.OUTCOME_BUCKETS).
  const harnessErrors = records.filter((r) => r.outcome === "harness_error").length;
  const skipped = records.filter((r) => r.outcome === "skipped").length;
  const buckets = Object.fromEntries(Object.entries(scoring.OUTCOME_BUCKETS).map(([name, outcomes]) => [name, scored.filter((r) => outcomes.includes(r.outcome)).length]));
  const unclassifiedOutcomes = [...new Set(scored.filter((r) => !scoring.bucketOf(r.outcome)).map((r) => String(r.outcome)))];
  const bucketTotal = Object.values(buckets).reduce((a, b) => a + b, 0);
  const partition = { rows: records.length, evaluated: n, notEvaluated: { harnessErrors, skipped }, bucketTotal, unclassifiedOutcomes, ok: bucketTotal === n && unclassifiedOutcomes.length === 0 && n + harnessErrors + skipped === records.length };
  return {
    questions: n,
    harnessErrors,
    skipped,
    counts,
    buckets,
    bucketPct: Object.fromEntries(Object.entries(buckets).map(([name, count]) => [name, pct(count, n)])),
    partition,
    refusalKindDiffers: counts.refusal_kind_differs,
    refusalKindDiffersPct: pct(counts.refusal_kind_differs, n),
    exactCorrect: exact,
    acceptable,
    correctRefusal: counts.correct_refusal + counts.refusal_accepted,
    wrongButExecutable: counts.wrong_but_executable,
    validatorRejected: counts.validator_rejected,
    malformedOutput: counts.malformed_output,
    providerFailure: counts.provider_failure,
    timeout: counts.timeout,
    exactPct: pct(exact, n),
    acceptablePct: pct(acceptable, n),
    wrongPlanPct: pct(wrong, n),
    invalidPlanPct: pct(invalid, n),
    failurePct: pct(failure, n),
    falseRefusalPct: pct(counts.false_refusal, n),
    latencyMs: latencies.length ? { average: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length), p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies[latencies.length - 1], samples: latencies.length } : null,
    tokens,
    retries: scored.reduce((t, r) => t + (r.retries || 0), 0),
    cachedRows: scored.filter((r) => r.cached).length,
    providerReportedCost: scored.some((r) => r.providerReportedCost !== null) ? Math.round(scored.reduce((t, r) => t + (r.providerReportedCost || 0), 0) * 1e6) / 1e6 : null,
    wrongFieldsOnSupportedRows: wrongFields,
  };
}

/** Null when every evaluated row sits in exactly one reporting bucket; otherwise what is wrong with the accounting. */
function partitionProblem(summary) {
  const p = summary && summary.partition;
  if (!p) return "the summary carries no partition accounting";
  if (p.ok) return null;
  const parts = [];
  if (p.bucketTotal !== p.evaluated) parts.push(`the buckets hold ${p.bucketTotal} rows but ${p.evaluated} were evaluated`);
  if (p.unclassifiedOutcomes.length) parts.push(`outcome(s) in no bucket: ${p.unclassifiedOutcomes.join(", ")}`);
  if (p.evaluated + p.notEvaluated.harnessErrors + p.notEvaluated.skipped !== p.rows) parts.push(`evaluated + not evaluated is not the ${p.rows} rows`);
  return parts.join("; ") || "the partition accounting is inconsistent";
}

/** The assertion: the bucket totals equal the evaluated rows (only harness errors and skipped rows are outside), or it throws. */
function assertPartition(summary) {
  const problem = partitionProblem(summary);
  if (problem) throw new Error(`Evaluation accounting error: ${problem}.`);
  return summary;
}

/** Per-category summary (a row can count in several categories). */
function breakdown(records) {
  const out = {};
  for (const name of Object.keys(scoring.CATEGORIES)) {
    const rows = records.filter((r) => (r.categories || []).includes(name));
    if (!rows.length) continue;
    const a = aggregate(rows);
    out[name] = { questions: a.questions, exactPct: a.exactPct, acceptablePct: a.acceptablePct, wrongPlanPct: a.wrongPlanPct, invalidPlanPct: a.invalidPlanPct, failurePct: a.failurePct, falseRefusalPct: a.falseRefusalPct, refusalKindDiffersPct: a.refusalKindDiffersPct, exactCorrect: a.exactCorrect, acceptable: a.acceptable };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Reporting

const col = (v, w) => String(v === null || v === undefined ? "-" : v).padEnd(w);
const rcol = (v, w) => String(v === null || v === undefined ? "-" : v).padStart(w);
const fmtPct = (v) => (v === null || v === undefined ? "-" : `${v.toFixed(1)}%`);

function comparisonTable(targets) {
  const nameWidth = Math.max(22, ...targets.map((t) => t.label.length + 1));
  const head = `${col("Model", nameWidth)}${rcol("Exact", 8)}${rcol("Accept", 9)}${rcol("Wrong", 8)}${rcol("FalseRef", 10)}${rcol("KindDiff", 10)}${rcol("Invalid", 9)}${rcol("Fail", 8)}${rcol("NotEval", 9)}${rcol("P50 ms", 9)}${rcol("P95 ms", 9)}${rcol("In tok", 10)}${rcol("Out tok", 10)}`;
  const lines = [head, "-".repeat(head.length)];
  for (const t of targets) {
    const s = t.summary;
    lines.push(`${col(t.label, nameWidth)}${rcol(fmtPct(s.exactPct), 8)}${rcol(fmtPct(s.acceptablePct), 9)}${rcol(fmtPct(s.wrongPlanPct), 8)}${rcol(fmtPct(s.falseRefusalPct), 10)}${rcol(fmtPct(s.refusalKindDiffersPct), 10)}${rcol(fmtPct(s.invalidPlanPct), 9)}${rcol(fmtPct(s.failurePct), 8)}${rcol((s.harnessErrors || 0) + (s.skipped || 0), 9)}${rcol(s.latencyMs ? s.latencyMs.p50 : null, 9)}${rcol(s.latencyMs ? s.latencyMs.p95 : null, 9)}${rcol(s.tokens.input, 10)}${rcol(s.tokens.output, 10)}`);
  }
  return [...lines, "", ...accountingLines(targets)].join("\n");
}

/** One line per model: how every evaluated row is accounted for (the table's percentages are of the evaluated rows). */
function accountingLines(targets) {
  const lines = ["Accept = exact + imprecise + correct refusals. Accept + Wrong + FalseRef + KindDiff + Invalid + Fail = 100% of the evaluated rows. NotEval = harness errors + skipped (not in any percentage)."];
  for (const t of targets) {
    const s = t.summary;
    const b = s.buckets;
    if (!b) continue;
    const problem = partitionProblem(s);
    lines.push(`  ${t.label}: ${s.questions} evaluated = ${b.exact} exact + ${b.imprecise} imprecise + ${b.correctRefusal} correct refusal + ${b.wrongPlan} wrong + ${b.falseRefusal} false refusal + ${b.refusalKindDiffers} kind differs + ${b.invalid} invalid + ${b.failure} failure (${problem ? `PARTITION ERROR: ${problem}` : "partition OK"}); not evaluated: ${s.harnessErrors} harness errors, ${s.skipped} skipped`);
  }
  return lines;
}

function breakdownTable(targets) {
  const names = Object.keys(scoring.CATEGORIES).filter((c) => targets.some((t) => t.breakdown[c]));
  const nameWidth = Math.max(22, ...targets.map((t) => t.label.length + 1));
  const head = `${col("Exact % by category", nameWidth)}${names.map((n) => rcol(n, Math.max(10, n.length + 2))).join("")}`;
  const lines = [head, "-".repeat(head.length)];
  for (const t of targets) lines.push(`${col(t.label, nameWidth)}${names.map((n) => rcol(t.breakdown[n] ? fmtPct(t.breakdown[n].exactPct) : "-", Math.max(10, n.length + 2))).join("")}`);
  lines.push(`${col("(questions)", nameWidth)}${names.map((n) => rcol((targets.find((t) => t.breakdown[n]) || { breakdown: {} }).breakdown[n]?.questions, Math.max(10, n.length + 2))).join("")}`);
  return lines.join("\n");
}

/**
 * Which model leads each measure. Facts only: ties are all listed and NO winner is chosen here. Claude (the baseline) is
 * reported as the deltas of every other model against it.
 */
function leaders(allTargets) {
  // A model that mostly gave no usable answer has no meaningful 'lowest wrong-plan rate': provider errors / timeouts on more than half its
  // questions, or - since a refusal is not a wrong plan - provider failures plus false refusals (supported questions it declined or
  // clarified) on more than half; or none scored. It is listed as ineligible with the reason instead of leading a ranking.
  const noAnswerPct = (t) => (t.summary.failurePct || 0) + (t.summary.falseRefusalPct || 0);
  const eligibleTarget = (t) => t.summary.questions > 0 && (t.summary.failurePct === null || t.summary.failurePct <= 50) && noAnswerPct(t) <= 50;
  const targets = allTargets.filter(eligibleTarget);
  const ineligibleReason = (t) => {
    if (!t.summary.questions) return "no question was scored";
    if (t.summary.failurePct > 50) return `${t.summary.failurePct}% of its questions failed at the provider (errors or timeouts)`;
    return `${Math.round(noAnswerPct(t) * 10) / 10}% of its questions got no usable answer (${t.summary.failurePct || 0}% failed at the provider, ${t.summary.falseRefusalPct || 0}% were declined or clarified although the corpus expects an answer)`;
  };
  const ineligible = allTargets.filter((t) => !eligibleTarget(t)).map((t) => ({ model: t.label, reason: ineligibleReason(t) }));
  const best = (value, direction) => {
    const scored = targets.map((t) => ({ label: t.label, v: value(t) })).filter((x) => x.v !== null && x.v !== undefined);
    if (!scored.length) return null;
    const top = direction === "max" ? Math.max(...scored.map((x) => x.v)) : Math.min(...scored.map((x) => x.v));
    return { value: top, models: scored.filter((x) => x.v === top).map((x) => x.label) };
  };
  const cat = (names, field) => (t) => {
    const rows = names.map((n) => t.breakdown[n]).filter(Boolean);
    const total = rows.reduce((s, r) => s + r.questions, 0);
    return total ? Math.round((rows.reduce((s, r) => s + (r[field] / 100) * r.questions, 0) / total) * 1000) / 10 : null;
  };
  const baseline = allTargets.find((t) => t.provider === "claude");
  return {
    ineligible,
    bestExactAccuracy: best((t) => t.summary.exactPct, "max"),
    bestAcceptableOutcome: best((t) => t.summary.acceptablePct, "max"),
    lowestWrongPlanRate: best((t) => t.summary.wrongPlanPct, "min"),
    lowestFalseRefusalRate: best((t) => t.summary.falseRefusalPct, "min"),
    // a refusal is not a wrong plan, so the wrong-plan rate alone rewards a model that declines supported questions
    lowestWrongOrFalseRefusalRate: best((t) => (t.summary.questions ? Math.round(((t.summary.counts.wrong_but_executable + t.summary.counts.wrong_not_executable + t.summary.counts.false_refusal) / t.summary.questions) * 1000) / 10 : null), "min"),
    lowestInvalidOutputRate: best((t) => t.summary.invalidPlanPct, "min"),
    lowestFailureRate: best((t) => t.summary.failurePct, "min"),
    bestMedianLatency: best((t) => (t.summary.latencyMs ? t.summary.latencyMs.p50 : null), "min"),
    bestHinglishAndMixedExact: best(cat(["hinglish", "mixed"], "exactPct"), "max"),
    bestFollowUpExact: best((t) => (t.breakdown.follow_up ? t.breakdown.follow_up.exactPct : null), "max"),
    againstClaudeBaseline: baseline
      ? allTargets
          .filter((t) => t !== baseline && eligibleTarget(t))
          .map((t) => ({
            model: t.label,
            exactPctDelta: t.summary.exactPct === null || baseline.summary.exactPct === null ? null : Math.round((t.summary.exactPct - baseline.summary.exactPct) * 10) / 10,
            acceptablePctDelta: t.summary.acceptablePct === null || baseline.summary.acceptablePct === null ? null : Math.round((t.summary.acceptablePct - baseline.summary.acceptablePct) * 10) / 10,
            wrongPlanPctDelta: t.summary.wrongPlanPct === null || baseline.summary.wrongPlanPct === null ? null : Math.round((t.summary.wrongPlanPct - baseline.summary.wrongPlanPct) * 10) / 10,
            falseRefusalPctDelta: t.summary.falseRefusalPct === null || baseline.summary.falseRefusalPct === null ? null : Math.round((t.summary.falseRefusalPct - baseline.summary.falseRefusalPct) * 10) / 10,
          }))
      : null,
  };
}

module.exports = { parseModelSpecs, selectRows, sampleEvenly, createSpacer, newTargetState, HALT_AFTER_REFUSALS, configFingerprint, rowKey, ResponseCache, cacheFileName, runPool, evaluateRow, submittedPlan, aggregate, partitionProblem, assertPartition, breakdown, comparisonTable, accountingLines, breakdownTable, leaders, percentile };
