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

// A question the assistant answered with a clarification ("financial or calendar year?") is kept as `pending` on that turn, so
// the user's reply ("2024-25") is planned TOGETHER with it - the chat sends no text history to Claude, so without it the reply
// would be planned alone and its metric and subject lost. Only the user's own earlier words; capped like any question.
const MAX_PENDING_CHARS = 600; // the planner's own question limit (planner.PLANNER_MAX_QUESTION_CHARS)
const cleanPending = (text) => (typeof text === "string" ? text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "");

/** The state stored on a clarification turn: the earlier plan (if any) plus the question that is still open. */
function withPendingQuestion(state, question) {
  const pending = cleanPending(question);
  if (!pending || pending.length > MAX_PENDING_CHARS) return state ? { v: STATE_VERSION, plan: state.plan, basis: state.basis } : null;
  return { v: STATE_VERSION, ...(state && state.plan ? { plan: state.plan, basis: state.basis } : {}), pending };
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
  return { plan: stored.plan, basis: stored.basis, ...(hasPending ? { pending } : {}) };
}

module.exports = { buildQueryState, readQueryState, withPendingQuestion, clarifiedQuestion, basisOf, STATE_VERSION, MAX_PENDING_CHARS };
