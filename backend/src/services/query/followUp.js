"use strict";

// --------------------------------------------------
// Follow-up STATE: the structured context a follow-up needs ("and by customer?", "same for purchases").
//
// The chat only persists display text, so the smallest structured state that keeps a follow-up's context is the
// previous turn's executed query plan - it already holds entity, metrics, period, comparison, filters, groupBy, having,
// sort and limit - plus the measure the user asked for ("basis": revenue / amount / count / avg / qty). It is stored on
// the assistant message (server-side, tenant+user scoped chat document) and handed to the planner as the previous plan
// of the next turn; the chat history itself is never sent to Claude.
//
// A stored state is untrusted input: it is re-parsed with the strict plan schema before it is used.
// --------------------------------------------------

const { parseQueryPlan } = require("./queryPlan.schema");

const STATE_VERSION = 1;
const MAX_GROUP_TOP = 10; // groupComparison.MAX_TOP
const MAX_MEMBER_CHARS = 200;
const BASES = new Set(["revenue", "amount", "count", "avg", "qty"]);

/** What the measure of a plan was, in the user's terms. `revenue` comes from a stated definition. */
function basisOf(plan, { revenue = false } = {}) {
  if (revenue && plan.entity === "sales") return "revenue";
  const m = plan.metrics || [];
  if (m[0] === "quantity") return "qty";
  if (m.some((x) => /^average/.test(x))) return "avg";
  if (m.length && m.every((x) => /Count$/.test(x))) return "count";
  return "amount";
}

/** The structured state persisted on the assistant message. Plain JSON; no tenant, no figures. */
function buildQueryState(plan, { revenue = false } = {}) {
  return { v: STATE_VERSION, plan: JSON.parse(JSON.stringify(plan)), basis: basisOf(plan, { revenue }) };
}

// ---- analysis turns: the scope EVERY executed query step shares, and nothing else.
// An analysis runs several steps (a monthly trend, a period comparison, a filtered breakdown...). Only what all of them agree
// on can describe "this" in a follow-up; a part they disagree on is not carried (never picked, never merged). The state
// still holds one strict plan (so the schema re-parse protects it), plus `carried`: the only parts a reader may use.
const CARRY_KEYS = ["entity", "period", "compare", "filters", "metrics"];
const SCOPE_DIMS = new Set(["customer", "supplier", "product", "productGroup"]);
const NOT_CARRIED_PERIOD = { kind: "all_time" }; // schema filler only: `period` is absent from `carried`, so it is never read
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * The follow-up state of an analysis turn (executed steps), or null when its steps share nothing. Steps over sales AND purchases
 * share no entity (and so no metric: a metric's meaning depends on its entity), but still share their period: "Compare sales vs
 * purchase ... Aug 2025" carries August 2025 (the entity is then a schema filler, outside `carried`).
 */
function buildAnalysisState(steps, { revenue = false } = {}) {
  const plans = (steps || []).filter((s) => s && s.kind === "query" && s.status === "ok" && s.request).map((s) => s.request);
  if (!plans.length) return null;
  const [first] = plans;
  const agree = (key) => plans.every((p) => canonical(p[key]) === canonical(first[key]));
  const sameEntity = agree("entity");
  const carried = sameEntity ? ["entity"] : [];
  // schema fillers for parts not carried (the strict re-parse needs a period and a metric): never read, `carried` excludes them
  const plan = { v: 1, entity: first.entity, mode: "aggregate", period: NOT_CARRIED_PERIOD, metrics: (first.metrics || []).slice(0, 1), groupBy: [], filters: [] };
  if (agree("period")) { plan.period = first.period; carried.push("period"); }
  if (carried.includes("period") && agree("compare") && first.compare) { plan.compare = first.compare; carried.push("compare"); }
  // product / party filters present, identically, in every step (a value bound from an earlier step's rows is step-specific)
  const shared = (first.filters || []).filter((f) => SCOPE_DIMS.has(f.dim) && plans.every((p) => (p.filters || []).some((g) => canonical(g) === canonical(f))));
  if (shared.length) { plan.filters = shared; carried.push("filters"); }
  if (sameEntity && agree("metrics") && (first.metrics || []).length) { plan.metrics = first.metrics; carried.push("metrics"); }
  if (!carried.length) return null;
  return { v: STATE_VERSION, plan, basis: carried.includes("metrics") ? basisOf(plan, { revenue }) : "amount", source: "analysis", carried };
}

/** The carried scope of a state as a compact plain object (entity, then only the parts a follow-up may use). */
function scopeOf(state) {
  if (!state || !state.plan) return null;
  const keys = state.source === "analysis" ? state.carried : CARRY_KEYS;
  const out = {};
  for (const k of keys) {
    const v = state.plan[k];
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

// A question the assistant answered with a clarification ("financial or calendar year?") is kept as `pending` on that turn, so
// the user's reply ("2024-25") is planned TOGETHER with it - the chat sends no text history to Claude, so without it the reply
// would be planned alone and its metric and subject lost. Only the user's own earlier words; capped like any question.
const MAX_PENDING_CHARS = 600; // the planner's own question limit (planner.PLANNER_MAX_QUESTION_CHARS)
const cleanPending = (text) => (typeof text === "string" ? text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "");

/** The state stored on a clarification turn: the earlier plan (if any) plus the question that is still open. */
function withPendingQuestion(state, question) {
  const pending = cleanPending(question);
  // an analysis scope keeps its marks, so a clarification never turns a partial scope into a full plan
  const kept = state && state.plan ? { plan: state.plan, basis: state.basis, ...(state.source === "analysis" ? { source: "analysis", carried: state.carried } : {}) } : null;
  if (!pending || pending.length > MAX_PENDING_CHARS) return kept ? { v: STATE_VERSION, ...kept } : null;
  return { v: STATE_VERSION, ...(kept || {}), pending };
}

/** The reply to a clarification, joined to the question it clarifies (unchanged when nothing is pending or it would be too long). */
function clarifiedQuestion(reply, state) {
  if (!state || !state.pending) return reply;
  const joined = `${state.pending} (clarification: ${String(reply).trim()})`;
  return joined.length <= MAX_PENDING_CHARS ? joined : reply;
}

/** A stored state is untrusted input: strict schema re-parse, known basis, else ignored. */
function readQueryState(stored) {
  if (!stored || typeof stored !== "object" || stored.v !== STATE_VERSION) return null;
  const pending = cleanPending(stored.pending);
  const hasPending = !!pending && pending.length <= MAX_PENDING_CHARS;
  if (stored.plan === undefined && hasPending) return { pending };
  if (!BASES.has(stored.basis)) return null;
  const parsed = parseQueryPlan(stored.plan);
  if (!parsed.ok) return null;
  if (stored.basis === "revenue" && stored.plan.entity !== "sales") return null;
  // an analysis scope: anything else in `carried` and the state is ignored
  let analysis = {};
  if (stored.source !== undefined) {
    const c = stored.carried;
    // `carried` must be a known, duplicate-free, non-empty list; a metric only with its entity (its meaning depends on it)
    if (stored.source !== "analysis" || !Array.isArray(c) || !c.length || new Set(c).size !== c.length || !c.every((k) => CARRY_KEYS.includes(k))) return null;
    if (c.includes("metrics") && !c.includes("entity")) return null;
    if (c.includes("compare") && !c.includes("period")) return null;
    analysis = { source: "analysis", carried: [...c] };
  }
  // a top-versus-others comparison (groupComparison.js): its top N and the names it found, on a single-query state only
  let group = {};
  if (stored.group !== undefined) {
    const g = stored.group;
    const okTop = !!g && Number.isInteger(g.top) && g.top >= 1 && g.top <= MAX_GROUP_TOP;
    if (stored.source !== undefined || !okTop || !Array.isArray(g.members) || g.members.length > g.top || !g.members.every((m) => typeof m === "string" && m.length <= MAX_MEMBER_CHARS)) return null;
    group = { group: { top: g.top, members: [...g.members] } };
  }
  return { plan: stored.plan, basis: stored.basis, ...analysis, ...group, ...(hasPending ? { pending } : {}) };
}

// ---- the scope as given to a planner (query or analysis planner): the carried parts only, framed before the question. Never
// rows, tenant or chat text. One turn deep: each answered turn replaces it, and the planner is told to ignore it for a new topic.
const SCOPE_KEYS = CARRY_KEYS;
const SCOPE_MAX_CHARS = 1200;
const SCOPE_LEAD = "Previous turn's analysis scope (structured JSON; only what that turn's steps all shared - anything not listed was not shared and must come from the question):";
const SCOPE_RULE = 'The question below may refer to that scope ("this", "those", "same period"): keep the listed scope for what the question does not change. If the question is not a follow-up, ignore it.';
/** A scope as a planner may receive it: a small plain object of known keys (at least one); anything else is no scope. */
function readScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const keys = Object.keys(scope);
  if (!keys.length || !keys.every((k) => SCOPE_KEYS.includes(k)) || ("entity" in scope && typeof scope.entity !== "string")) return null;
  const json = JSON.stringify(scope);
  return json.length <= SCOPE_MAX_CHARS ? JSON.parse(json) : null;
}
const scopeMessage = (scope, text) => `${SCOPE_LEAD}
${JSON.stringify(scope)}
${SCOPE_RULE}
Question: ${text}`;

module.exports = { readScope, scopeMessage, buildQueryState, buildAnalysisState, scopeOf, readQueryState, withPendingQuestion, clarifiedQuestion, basisOf, STATE_VERSION, MAX_PENDING_CHARS, CARRY_KEYS };
