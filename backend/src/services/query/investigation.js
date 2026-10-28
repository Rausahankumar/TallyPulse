"use strict";

// --------------------------------------------------
// Bounded investigation loop (Milestone 4): run an analysis plan, read the evidence it produced, and when the evidence
// says a step cannot answer its own change, run ONE more validated round that can - then stop.
//
//   round 1   executeAnalysisPlan(plan)                         (the analysis planner's plan, unchanged)
//   evidence  buildEvidence(...).needs                           (deterministic: which step lacks what)
//   propose   1. deterministic, no model: a schema-valid query step per need, derived from the executed step itself:
//                rank_toward_change - the step's list is cut and ordered AGAINST its change, so the same query (same
//                entity, metric, periods, filters, limit) re-ordered in the change's direction can name what drove it
//             2. only when (1) yields no step and a need is still open for a reason a different query could settle (a
//                having filter, an already-run remedy, no defined remedy): ONE call to the analysis planner (injected as
//                proposeWithModel; same tool schema and checkAnalysis) with the question and a compact evidence summary
//                (steps run, findings, open points; capped, no rows, no tenant). Its plan must have 1-2 query steps,
//                fit the step budget and repeat no plan already run, else nothing runs and the limitation is stated
//   round 2   executeAnalysisPlan(follow-up plan)                (same parser, validator, name re-resolution, freshness and
//                                                                 coverage gates; tenant from the context only)
//   merge     every step keeps its provenance (origin: round, from step, reason); evidence is rebuilt over all steps
//   stop      no open need, no remedy, a repeated plan, or the budget: at most MAX_ROUNDS rounds, MAX_TOTAL_STEPS steps,
//             MAX_FOLLOW_UPS per round, MAX_MODEL_CALLS model call and OVERALL_DEADLINE_MS; whatever stays open is stated
// Asked what to do (the planner's `actions`): one more open point, `decide` - would a measurement the findings do not yet hold
// change which step is worth taking? No rule settles it: it goes to the same single model call (alongside any deterministic
// follow-up of the round, within the same per-round budget), which may propose up to the remaining room in query steps or
// decline (the findings are enough). Its steps are evidence, labelled as measured to inform the decision - never a
// recommendation; a step that only re-measures values already shown (a total or row of an executed step) is not run.
// Nothing reads the database except through the executor; the only model call is the injected one.
// --------------------------------------------------

const { executeAnalysisPlan, DEFAULT_DEADLINE_MS } = require("./analysisPlan");
const { buildEvidence } = require("./evidence");

const MAX_ROUNDS = 2; // the planner's plan + one follow-up round
const MAX_TOTAL_STEPS = 6; // across all rounds
const MAX_FOLLOW_UPS = 2; // per follow-up round (deterministic or model-proposed)
const MAX_MODEL_CALLS = 1; // per investigation
const SUMMARY_MAX_CHARS = 1500; // the evidence summary sent with a model call
const OVERALL_DEADLINE_MS = 30000; // both rounds together (inside the chat's 60 s request, with planning and answering)
const MIN_ROUND_MS = 2000; // a follow-up round is not started with less time than this left
// open needs a DIFFERENT query might settle (a model may be asked); "budget" is never one of them
const MODEL_ELIGIBLE = new Set(["having", "repeat", "no_remedy"]);
const USAGE_KEYS = ["calls", "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];

// Stable serialization (sorted keys): two plans with the same content have the same fingerprint.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const fingerprint = (plan) => canonical(plan);

/** A step id that is valid for the analysis-plan schema ([a-z][a-z0-9_]{0,23}) and not already used. */
function freshId(base, used) {
  const stem = `${String(base).toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "") || "step"}`.slice(0, 18);
  for (let i = 1; ; i += 1) {
    const id = `${stem}_f${i}`.slice(0, 24);
    if (!used.has(id)) return id;
  }
}

/**
 * The deterministic follow-up steps for the open needs: schema-valid query steps derived from the executed steps only.
 * @returns {{steps: object[], origins: object[], unresolved: {need: object, code: string, reason: string}[]}}
 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The deterministic remedy of one need, built from the executed steps and the need itself (never from the question):
 * {plan, idBase, reason} to run, or {code, reason} when none applies.
 *   rank_toward_change  the same query re-ordered toward its change (not for a having-filtered step)
 *   purchases_for_fall  purchases of the same product by month over the fall's window (dates from the executed steps):
 *                       pre-tax line value and quantity - the product-level basis of product sales (invoice totals cannot
 *                       be split by product)
 */
function remedyFor(need, steps) {
  if (need.kind === "rank_toward_change") {
    const src = steps[need.step - 1];
    if (!src || src.kind !== "query" || src.status !== "ok" || !src.request) return { code: "no_remedy", reason: "no follow-up is defined for it" };
    // a having filter can keep only the other direction: re-ordering would not change what comes back
    if ((src.request.having || []).length) return { code: "having", reason: `step ${need.step} filters its rows (having), so re-ordering it cannot show what drove the change` };
    const plan = JSON.parse(JSON.stringify(src.request));
    plan.sort = [{ by: `${need.metric}.delta`, dir: need.dir < 0 ? "asc" : "desc" }];
    return { plan, idBase: src.id, reason: `step ${need.step} re-ordered by ${need.dir < 0 ? "largest fall" : "largest increase"} first, the direction of its change`, repeat: `the re-ordered query of step ${need.step} has already run` };
  }
  if (need.kind === "purchases_for_fall") {
    if (typeof need.product !== "string" || !need.product || !ISO_DAY.test(need.from) || !ISO_DAY.test(need.to) || need.from > need.to) return { code: "no_remedy", reason: "its product or window is not known" };
    const plan = { v: 1, entity: "purchase", mode: "aggregate", period: { kind: "custom", from: need.from, to: need.to }, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "date", bucket: "month" }], filters: [{ dim: "product", op: "eq_ci", value: need.product }], sort: [{ by: "date", dir: "asc" }], limit: 24 };
    return { plan, idBase: "purchases", reason: `purchases of ${need.product} by month, ${need.from} to ${need.to}: did they fall with its sales (step ${need.step})?`, repeat: `the purchase query of ${need.product} for that window has already run` };
  }
  if (need.kind === "decide") return { code: "no_remedy", reason: "only a measurement chosen for this decision can settle it" };
  return { code: "no_remedy", reason: "no follow-up is defined for it" };
}

// What would change the decision is the model's to choose; the bounds are not: a step that only re-measures values an executed
// step already shows - the same entity, periods and measure, narrowed to rows that step returned, or the same breakdown again -
// adds nothing to the decision and is not run. Sort, limit and having are ignored (they reorder or cut the same values).
function remeasures(plan, steps) {
  const same = (a, b) => canonical(a === undefined ? null : a) === canonical(b === undefined ? null : b);
  return steps.some((s) => {
    if (s.kind !== "query" || s.status !== "ok" || !s.request || !s.result) return false;
    const r = s.request;
    if (r.entity !== plan.entity || !same(r.period, plan.period) || !same(r.compare, plan.compare)) return false;
    if (!(plan.metrics || []).every((m) => (r.metrics || []).includes(m))) return false;
    const dims = (r.groupBy || []).map((g) => g.dim);
    const known = new Set((s.result.rows || []).map((row) => (dims.length === 1 && row.key ? String(row.key[dims[0]]).toLowerCase() : null)));
    const filters = plan.filters || [];
    const others = (fs, d) => fs.filter((f) => f.dim !== d);
    // the same breakdown again - a repeat only when the executed one was complete (not cut at its limit, not filtered by a
    // having): re-ordering a cut or filtered list can return rows nobody has seen yet
    const complete = !s.result.truncated && !(r.having || []).length;
    if (same(plan.groupBy || [], r.groupBy || []) && same(filters, r.filters || [])) return complete;
    if ((plan.groupBy || []).length || dims.length !== 1) return false;
    // a total narrowed to rows of that breakdown: every value is already a row
    const narrowed = filters.filter((f) => f.dim === dims[0]);
    return narrowed.length === 1 && same(others(filters, dims[0]), r.filters || []) && [].concat(narrowed[0].value).every((v) => known.has(String(v).toLowerCase()));
  });
}

function proposeFollowUps(steps, needs, { executed = new Set(), max = MAX_FOLLOW_UPS } = {}) {
  const used = new Set(steps.map((s) => s.id));
  const out = { steps: [], origins: [], unresolved: [] };
  for (const need of needs) {
    const remedy = remedyFor(need, steps);
    if (!remedy.plan) {
      out.unresolved.push({ need, code: remedy.code, reason: remedy.reason });
      continue;
    }
    const fp = fingerprint(remedy.plan);
    if (executed.has(fp)) {
      out.unresolved.push({ need, code: "repeat", reason: remedy.repeat });
      continue;
    }
    if (out.steps.length >= max) {
      out.unresolved.push({ need, code: "budget", reason: "the follow-up budget was used up" });
      continue;
    }
    executed.add(fp);
    const id = freshId(remedy.idBase, used);
    used.add(id);
    out.steps.push({ id, kind: "query", plan: remedy.plan });
    out.origins.push({ from: need.step, reason: remedy.reason });
  }
  return out;
}

/** An open need in plain words (for the model's summary and the stated limitations). */
function needText(need) {
  if (need.kind === "purchases_for_fall") return `purchases_for_fall: did purchases of ${need.product} fall between ${need.from} and ${need.to}, the window of its sales fall`;
  if (need.kind === "decide") return "decide: the user asks what to do. Propose query steps only if their result would change which next step is worth taking - something the findings do not show yet (for example what a large contributor bought less of, or who bought less of a falling product); never re-measure a total or a row already shown. If the findings are enough, or no query could change the decision, decline (not_a_data_query)";
  return `${need.kind} on ${need.metric} (change is a ${need.dir < 0 ? "fall" : "rise"})`;
}

/** One executed step as the model sees it: its scope only (entity, metrics, grouping, periods, filters, order) - never rows. */
function stepScope(s, n) {
  if (s.kind !== "query" || !s.request) return `${n}. ${s.kind} ${s.tool || ""} (${s.status})`.replace(/\s+\(/, " (");
  const p = s.request;
  const range = (x) => (x && x.kind === "custom" ? `${x.from}..${x.to}` : x ? x.kind : "?");
  const by = (p.groupBy || []).map((g) => (g.dim === "date" ? `date:${g.bucket}` : g.dim)).join("+") || "total";
  const filters = (p.filters || []).map((f) => `${f.dim} ${f.op} ${Array.isArray(f.value) ? `[${f.value.length} names]` : String(f.value).slice(0, 40)}`).join("; ");
  const cmp = p.compare ? ` vs ${p.compare.mode === "custom" ? range(p.compare.period) : p.compare.mode}` : "";
  const sort = (p.sort || []).map((x) => `${x.by} ${x.dir}`).join(",");
  return `${n}. ${p.entity} ${(p.metrics || []).join(",")} by ${by}, ${range(p.period)}${cmp}${filters ? `, filters ${filters}` : ""}${sort ? `, sort ${sort}` : ""}${p.limit ? `, limit ${p.limit}` : ""}${s.status !== "ok" ? ` (${s.status})` : ""}`;
}

/**
 * What the model is told: the open points first, then the steps already run, then the findings - capped, so the open
 * points always survive. Built from step scopes and finding texts only (no rows, no tenant).
 */
function evidenceSummary(steps, evidence, open) {
  const lines = [
    "Open points:",
    ...open.map((u) => `- step ${u.need.step}: ${needText(u.need)}; ${u.reason}`),
    "Steps already run:",
    ...steps.map((s, i) => stepScope(s, i + 1)),
    "Findings so far:",
    ...evidence.findings.map((f) => `- ${f.label}: ${f.text.slice(0, 220)} (step ${f.steps.join(",")})`),
  ];
  const text = lines.join("\n");
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…` : text;
}

/** Renames a model plan's step ids so they never collide with steps already run (inputs follow the rename). */
function renameSteps(plan, used) {
  const map = new Map();
  for (const s of plan.steps) {
    const id = freshId(s.id, used);
    used.add(id);
    map.set(s.id, id);
  }
  return {
    steps: plan.steps.map((s) => ({ ...s, id: map.get(s.id), ...(s.inputs ? { inputs: s.inputs.map((x) => ({ ...x, fromStep: map.get(x.fromStep) || x.fromStep })) } : {}) })),
    map,
  };
}

/**
 * Asks the injected model proposer once; returns the steps to run, or the reason none run (always stated).
 * @returns {Promise<{steps: object[], origins: object[], definitionNotes: object, note: string|null, usage: object|null}>}
 */
async function proposeWithModelOnce(proposeWithModel, { steps, evidence, open, executed, room }) {
  const none = (note, usage = null, declined = false) => ({ steps: [], origins: [], definitionNotes: {}, note, usage, declined });
  const which = open.map((u) => u.need.step).join(", ");
  // only the decision is open: a decline means the findings are enough - not a limitation of the answer
  const decisionOnly = open.every((u) => u.need.kind === "decide");
  let res;
  try {
    res = await proposeWithModel(evidenceSummary(steps, evidence, open));
  } catch (e) {
    return none(decisionOnly ? "Whether another measurement would change what to do could not be checked (the analysis planner could not be asked)." : `The analysis planner could not be asked for a follow-up, so the open point of step ${which} stays open.`);
  }
  const usage = (res && res.usage) || null;
  if (!res || res.status !== "supported" || !res.analysis || !Array.isArray(res.analysis.steps)) {
    // a decline (the findings are enough) is not a failure; a failed or malformed reply is - and is stated as such
    if (decisionOnly && res && res.status === "unsupported") return none(null, usage, true);
    if (decisionOnly) return none(`Whether another measurement would change what to do could not be checked (the analysis planner's reply was not usable: ${(res && (res.code || res.status)) || "no answer"}).`, usage);
    return none(`The analysis planner proposed no usable follow-up (${(res && (res.code || res.status)) || "no answer"}), so the open point of step ${which} stays open.`, usage);
  }
  const plan = res.analysis;
  if (!plan.steps.length || plan.steps.length > Math.min(MAX_FOLLOW_UPS, room) || plan.steps.some((s) => s.kind !== "query")) {
    return none(`The analysis planner's follow-up did not fit the investigation's budget (at most ${Math.min(MAX_FOLLOW_UPS, room)} query steps), so it was not run.`, usage);
  }
  if (plan.steps.some((s) => executed.has(fingerprint(s.plan)))) {
    return none("The analysis planner's follow-up repeats a step already run, so it was not run.", usage);
  }
  if (plan.steps.some((s) => remeasures(s.plan, steps))) {
    return none("The analysis planner's follow-up only re-measures values already shown, so it was not run.", usage);
  }
  const { steps: renamed, map } = renameSteps(plan, new Set(steps.map((s) => s.id)));
  for (const s of renamed) executed.add(fingerprint(s.plan));
  const notes = {};
  for (const [from, to] of map) if (res.definitionNotes && res.definitionNotes[from]) notes[to] = res.definitionNotes[from];
  const reason = decisionOnly ? "measured to inform what to do (proposed by the analysis planner; evidence, not a recommendation)" : `proposed by the analysis planner for the open point of step ${which}`;
  return { steps: renamed, origins: renamed.map(() => ({ from: open[0].need.step, reason })), definitionNotes: notes, note: null, usage };
}

function addUsage(total, usage) {
  if (!usage) return;
  for (const k of USAGE_KEYS) total[k] = (Number(total[k]) || 0) + (Number(usage[k]) || 0);
}

/**
 * Runs an analysis plan as a bounded investigation.
 * @param {object} plan the analysis plan (from the analysis planner)
 * @param {object} context executeAnalysisPlan's context (tenantId from the authenticated company context only)
 * @param {{referenceDate?: Date, dataThrough?: Date|null, now?: Function, proposeWithModel?: Function}} [options]
 *        proposeWithModel(summary) -> the analysis planner's result for the question plus that evidence summary
 *        (planAnalysis with options.evidence); omitted -> deterministic follow-ups only
 * @returns {Promise<{ok: boolean, execution: object, error?: object, investigation: {rounds: number, stopReason: string,
 *          followUps: number, modelCalls: number, usage: object, notes: string[]}}>}
 */
async function investigate(plan, context, { referenceDate = null, dataThrough = null, now = Date.now, proposeWithModel = null, actions = false } = {}) {
  const started = now();
  const first = await executeAnalysisPlan(plan, { ...context, deadlineMs: Math.min(context.deadlineMs || DEFAULT_DEADLINE_MS, OVERALL_DEADLINE_MS) });
  // decision: null (not asked), "measured" / "declined" / "not_run" (the model's answer to the decide point) or "no_room"
  const info = { rounds: 1, stopReason: "sufficient", followUps: 0, modelCalls: 0, decision: null, usage: Object.fromEntries(USAGE_KEYS.map((k) => [k, 0])), notes: [] };
  if (!first.ok) return { ok: false, execution: first, error: first.error, investigation: { ...info, stopReason: "plan_failed" } };

  let steps = first.steps;
  const executed = new Set(steps.filter((s) => s.kind === "query" && s.request).map((s) => fingerprint(s.request)));
  while (info.rounds < MAX_ROUNDS) {
    const evidence = buildEvidence({ steps }, { referenceDate, dataThrough });
    // asked what to do: the decision is one more open point, offered once to the single model call (never settled by a rule)
    const decide = actions && info.decision === null && typeof proposeWithModel === "function" && info.modelCalls < MAX_MODEL_CALLS && evidence.findings.length ? [{ kind: "decide", step: evidence.findings[0].steps[0] }] : [];
    const needs = [...evidence.needs, ...decide];
    if (!needs.length) break;
    const room = Math.min(MAX_FOLLOW_UPS, MAX_TOTAL_STEPS - steps.length);
    const left = OVERALL_DEADLINE_MS - (now() - started);
    if (room <= 0 || left < MIN_ROUND_MS) {
      info.stopReason = room <= 0 ? "step_budget" : "time_budget";
      if (evidence.needs.length) info.notes.push(`The investigation stopped at its ${room <= 0 ? "step" : "time"} budget, so ${evidence.needs.length === 1 ? "one breakdown" : `${evidence.needs.length} breakdowns`} could not be followed up.`);
      if (decide.length) { info.decision = "no_room"; info.notes.push(`No measurement beyond these steps could be made (the investigation's ${room <= 0 ? "step" : "time"} budget was used up), so what to do rests on them alone.`); }
      break;
    }
    const proposal = proposeFollowUps(steps, needs, { executed, max: room });
    let round = { steps: proposal.steps, origins: proposal.origins, definitionNotes: {} };
    // the model is asked when no deterministic remedy exists for this round, or - for the decision - beside the round's
    // deterministic steps with the room they leave; at most MAX_MODEL_CALLS times
    const open = proposal.unresolved.filter((u) => MODEL_ELIGIBLE.has(u.code) && (!round.steps.length || u.need.kind === "decide"));
    const modelRoom = room - round.steps.length;
    if (open.length && modelRoom > 0 && typeof proposeWithModel === "function" && info.modelCalls < MAX_MODEL_CALLS) {
      info.modelCalls += 1;
      const asked = await proposeWithModelOnce(proposeWithModel, { steps, evidence, open, executed, room: modelRoom });
      addUsage(info.usage, asked.usage);
      if (asked.note) info.notes.push(asked.note);
      if (decide.length) info.decision = asked.declined ? "declined" : asked.steps.length ? "measured" : "not_run";
      round = { steps: [...round.steps, ...asked.steps], origins: [...round.origins, ...asked.origins], definitionNotes: asked.definitionNotes || {} };
      if (round.steps.length && OVERALL_DEADLINE_MS - (now() - started) < MIN_ROUND_MS) {
        info.stopReason = "time_budget";
        info.notes.push("The analysis planner's follow-up was not run: the investigation's time budget was used up.");
        break;
      }
    } else {
      for (const u of proposal.unresolved.filter((x) => x.need.kind !== "decide")) info.notes.push(`Step ${u.need.step} could not be followed up: ${u.reason}.`);
      if (decide.length) info.decision = "no_room";
    }
    if (!round.steps.length) {
      info.stopReason = "no_remedy";
      break;
    }
    const remaining = OVERALL_DEADLINE_MS - (now() - started);
    const next = await executeAnalysisPlan({ v: 1, steps: round.steps }, { ...context, definitionNotes: { ...(context.definitionNotes || {}), ...round.definitionNotes }, deadlineMs: Math.max(MIN_ROUND_MS, Math.min(remaining, DEFAULT_DEADLINE_MS)) });
    info.rounds += 1;
    if (!next.ok) {
      info.stopReason = "follow_up_failed";
      info.notes.push("The follow-up query could not be run, so the answer uses the first round only.");
      break;
    }
    steps = [...steps, ...next.steps.map((s, i) => ({ ...s, origin: { round: info.rounds, ...round.origins[i] } }))];
    info.followUps += next.steps.length;
  }
  if (info.rounds >= MAX_ROUNDS && info.stopReason === "sufficient") {
    const { needs } = buildEvidence({ steps }, { referenceDate, dataThrough });
    if (needs.length) {
      info.stopReason = "round_budget";
      const ranks = needs.filter((x) => x.kind === "rank_toward_change").length;
      if (ranks) info.notes.push(`The investigation stopped after ${MAX_ROUNDS} rounds with ${ranks === 1 ? "one breakdown" : `${ranks} breakdowns`} still unable to show what drove ${ranks === 1 ? "its" : "their"} change.`);
      for (const x of needs.filter((n) => n.kind === "purchases_for_fall")) info.notes.push(`The investigation stopped after ${MAX_ROUNDS} rounds before checking whether purchases of ${x.product} fell between ${x.from} and ${x.to}.`);
    }
  }
  return { ok: true, execution: { ...first, steps, budget: { ...first.budget, steps: steps.length } }, investigation: info };
}

module.exports = { investigate, proposeFollowUps, evidenceSummary, fingerprint, MAX_ROUNDS, MAX_TOTAL_STEPS, MAX_FOLLOW_UPS, MAX_MODEL_CALLS, SUMMARY_MAX_CHARS, OVERALL_DEADLINE_MS };
