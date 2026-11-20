"use strict";

/**
 * Library behind verify-nlu-eval.js: runs the corpus rows through the production planner (planQuestion, unchanged) behind the
 * planner's client seam, scores every answer with the shared semantic scorer, and aggregates the measurements. NLU only: nothing here touches a database, Tally or real business data - the corpus is synthetic.
 *
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

const rowKey = (row) => sha(`${row.id}\u0000${row.question}\u0000${JSON.stringify(row.previousPlan || null)}`).slice(0, 24);

// ---------------------------------------------------------------------------------------------------------------
// Bounded concurrency

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

module.exports = { selectRows, sampleEvenly, newTargetState, HALT_AFTER_REFUSALS, rowKey, evaluateRow, submittedPlan, aggregate, partitionProblem, breakdown, accountingLines, percentile };
