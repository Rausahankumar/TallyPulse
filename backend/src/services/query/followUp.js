"use strict";

// --------------------------------------------------
// Follow-up context (P-SF): "Show sales this month vs last month" -> "and by customer?" keeps the measure, the
// period and the comparison and changes ONLY the grouping.
//
// Where context used to be lost: the chat only persisted display text, so a follow-up either went to legacy chat
// (history as free text) or was routed on its own and silently answered a different question ("and by customer?"
// -> all-time sales by customer). The smallest structured state that fixes it is the previous turn's executed
// query plan - it already holds entity, metrics, period, comparison, filters, groupBy, having, sort and limit - plus
// the measure the user asked for ("basis": revenue / amount / count / avg / qty). It is stored on the assistant
// message (server-side, tenant+user scoped chat document) and never sent to Claude.
//
// Deterministic: the follow-up is read with the router's own grammar (readFollowUpSlots) and merged by the fixed
// rules below. Anything the rules cannot apply returns "clarify" (a fixed message) or "none" (the normal route runs).
// The merged plan is re-parsed and re-validated like any other plan before it can run.
// --------------------------------------------------

const { readFollowUpSlots, REVENUE_ASSUMPTION, NOTES, NEW_PARTY_REASON } = require("./localRouter");
const { parseQueryPlan } = require("./queryPlan.schema");
const { CATALOG } = require("./semanticCatalog");

const STATE_VERSION = 1;
const BASES = new Set(["revenue", "amount", "count", "avg", "qty"]);
const METRIC = {
  sales: { amount: "invoiceAmount", count: "invoiceCount", avg: "averageInvoiceValue" },
  purchase: { amount: "purchaseAmount", count: "purchaseInvoiceCount", avg: "averagePurchaseValue" },
};
const RELATIVE_UNIT = {
  current_month: ["month", "current"], previous_month: ["month", "previous"],
  current_quarter: ["quarter", "current"], previous_quarter: ["quarter", "previous"],
  current_week: ["week", "current"], previous_week: ["week", "previous"],
  current_fy: ["fy", "current"], previous_fy: ["fy", "previous"],
};
const LFL_NOTE = { code: "comparison_like_for_like_default", message: "Compared with the same elapsed portion of the previous period (the product's standard comparison)." };

const NONE = Object.freeze({ status: "none" });
const clarify = (code, message) => ({ status: "clarify", code, message });

const MESSAGES = {
  followup_needs_dimension: 'Top or bottom of what? Your previous question was a total. Try for example "top 10 customers" or "top 10 products".',
  followup_needs_breakdown: 'That needs a breakdown to filter - for example "by customer" first, or ask in full: "customers whose sales grew by more than 20% this month vs last month".',
  followup_entity_mismatch: "That doesn't fit your previous question (customers only exist on sales, suppliers only on purchases). Please ask it in full, for example \"purchases by supplier last month\".",
  followup_not_applicable: 'I couldn\'t apply that to your previous question without guessing. Please ask it in full, for example "sales by customer this month vs last month".',
  followup_conflicting: "That follow-up asks for more than one kind of change at once. Please pick one - for example \"only the ones that grew\".",
};

// ---------------------------------------------------------------- state

/** What the measure of a plan was, in the user's terms. `revenue` comes from the route (a stated definition). */
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

/** A stored state is untrusted input: strict schema re-parse, known basis, else ignored. */
function readQueryState(stored) {
  if (!stored || typeof stored !== "object" || stored.v !== STATE_VERSION || !BASES.has(stored.basis)) return null;
  const parsed = parseQueryPlan(stored.plan);
  if (!parsed.ok) return null;
  if (stored.basis === "revenue" && stored.plan.entity !== "sales") return null;
  return { plan: stored.plan, basis: stored.basis };
}

// ---------------------------------------------------------------- plan pieces (same rules as the router)

function metricsFor(entity, basis, groupDim, filters) {
  const lineDim = groupDim === "product" || groupDim === "productGroup";
  const lineFilter = filters.some((f) => f.dim === "product" || f.dim === "productGroup");
  if (basis === "revenue") return entity === "sales" ? (groupDim === "product" ? ["lineAmount", "quantity"] : ["lineAmount"]) : null;
  if (basis === "qty") return ["quantity", "lineAmount"];
  if (lineDim || (lineFilter && basis === "amount")) {
    if (basis === "count" || basis === "avg") return null; // invoice counts/averages cannot be split by product
    return groupDim === "product" ? ["lineAmount", "quantity"] : ["lineAmount"];
  }
  const M = METRIC[entity];
  if (basis === "avg") return [M.avg];
  if (basis === "count") return [M.count];
  return [M.amount, M.count];
}

function primaryOf(metrics, basis) {
  if (basis === "qty") return "quantity";
  return metrics.find((m) => /Amount$/.test(m)) || metrics[0];
}

// The change the previous plan asked for, independent of which metric it used.
function intentOf(plan) {
  const h = plan.having || [];
  if (h.some((x) => x.op === "eq" && !x.metric.includes("."))) return { kind: "lost" };
  if (h.some((x) => x.metric.endsWith(".previous") && x.op === "eq")) return { kind: "new" };
  const p = h.find((x) => x.metric.endsWith(".deltaPct"));
  if (p) return { kind: p.op === "gt" ? "pct_up" : "pct_down", value: Math.abs(p.value) };
  const d = h.find((x) => x.metric.endsWith(".delta"));
  if (d) return { kind: d.op === "gt" ? "up" : "down" };
  return { kind: "none" };
}

function havingFor(intent, primary) {
  switch (intent.kind) {
    case "lost": return { having: [{ metric: primary, op: "eq", value: 0 }, { metric: `${primary}.previous`, op: "gt", value: 0 }], sort: [{ by: `${primary}.previous`, dir: "desc" }] };
    case "new": return { having: [{ metric: `${primary}.previous`, op: "eq", value: 0 }, { metric: primary, op: "gt", value: 0 }], sort: [{ by: primary, dir: "desc" }] };
    case "pct_up": return { having: [{ metric: `${primary}.deltaPct`, op: "gt", value: intent.value }], sort: [{ by: `${primary}.deltaPct`, dir: "desc" }] };
    case "pct_down": return { having: [{ metric: `${primary}.deltaPct`, op: "lt", value: -intent.value }], sort: [{ by: `${primary}.deltaPct`, dir: "asc" }] };
    case "up": return { having: [{ metric: `${primary}.delta`, op: "gt", value: 0 }], sort: [{ by: `${primary}.delta`, dir: "desc" }] };
    case "down": return { having: [{ metric: `${primary}.delta`, op: "lt", value: 0 }], sort: [{ by: `${primary}.delta`, dir: "asc" }] };
    default: return null;
  }
}

const fyRange = (fy) => ({ kind: "custom", from: `${fy.slice(0, 4)}-04-01`, to: `${Number(fy.slice(0, 4)) + 1}-03-31` });

// Decision 2 (same rule as the router): a current month is compared with the COMPLETE previous month unless the
// same days are asked for; other units compare like-for-like.
const defaultMode = (subject, s) => (s.full || (subject.kind === "current_month" && !s.sameDays) ? "full_previous" : "like_for_like");
const modeNote = (subject, s, mode) => (mode === "full_previous" ? (s.full ? null : NOTES.MONTH_FULL_NOTE) : s.sameDays ? NOTES.SAME_DAYS_NOTE : LFL_NOTE);

// "compare with <target>" against the kept subject period.
function compareWith(subject, target, s) {
  const u0 = RELATIVE_UNIT[subject.kind];
  const u1 = RELATIVE_UNIT[target.kind];
  if (u0 && u1 && u0[0] === u1[0] && u0[1] === "current" && u1[1] === "previous") return { mode: defaultMode(subject, s) };
  const fixed = (p) => p.kind === "custom" || p.kind === "specific_fy";
  if (fixed(subject) && fixed(target)) return { mode: "custom", period: target.kind === "specific_fy" ? fyRange(target.fy) : { kind: "custom", from: target.from, to: target.to } };
  return null;
}

const DIM_LABEL = (d) => (CATALOG.dimensions[d] ? CATALOG.dimensions[d].label.toLowerCase() : d);

// ---------------------------------------------------------------- the merge

/**
 * @param {{plan:object, basis:string}} state  from readQueryState (the previous engine answer)
 * @param {string} message                      the follow-up
 * @param {{resolveEntity?:Function}} [deps]     the tenant-scoped resolver (same one the router uses)
 * @returns {Promise<{status:"none"}|{status:"clarify",code:string,message:string}|{status:"unavailable"}|{status:"merged",plan:object,basis:string,kept:string[],changed:string[],notes:object[]}>}
 */
async function mergeFollowUp(state, message, { resolveEntity } = {}) {
  const s = readFollowUpSlots(message);
  if (!s || s.blocked) return NONE;
  const prev = state.plan;
  let entity = prev.entity;
  let basis = state.basis;
  let period = prev.period;
  let compare = prev.compare ? { ...prev.compare } : null;
  let groupBy = (prev.groupBy || []).map((g) => ({ ...g }));
  let filters = (prev.filters || []).map((f) => ({ ...f }));
  let intent = intentOf(prev);
  let limit = prev.limit;
  let rankAsc = !!(prev.sort && prev.sort[0] && prev.sort[0].dir === "asc" && intent.kind === "none");
  const changed = new Set();
  const notes = [];

  // ---- entity (sales / purchases) and measure
  const ents = new Set(s.entities);
  if (s.revenue) ents.add("sales");
  const buyerSide = s.whoFrame === "buyer" || (s.dims.includes("customer") && !s.dims.includes("supplier"));
  const supplierSide = s.whoFrame === "supplier" || (s.dims.includes("supplier") && !s.dims.includes("customer"));
  if (buyerSide && ents.has("purchase") && !ents.has("sales")) ents.delete("purchase"), ents.add("sales");
  if (supplierSide && ents.has("sales") && !ents.has("purchase") && !s.revenue) ents.delete("sales"), ents.add("purchase");
  // a party noun alone says which side of the trade ("what about suppliers?" after a customer breakdown = purchases)
  if (!ents.size && !s.whoFrame) {
    const party = s.dims.filter((d) => d === "customer" || d === "supplier");
    if (party.length === 1) ents.add(party[0] === "customer" ? "sales" : "purchase");
  }
  if (ents.size > 1) return NONE; // "sales vs purchases": the full router answers it honestly
  if (ents.size === 1) {
    const e = [...ents][0];
    if (e !== entity) {
      if (filters.some((f) => f.dim === "customer" || f.dim === "supplier")) return clarify("followup_entity_mismatch", MESSAGES.followup_entity_mismatch);
      entity = e;
      groupBy = groupBy.map((g) => (g.dim === "customer" ? { dim: "supplier" } : g.dim === "supplier" ? { dim: "customer" } : g));
      if (basis === "revenue") basis = "amount";
      changed.add(entity === "sales" ? "sales" : "purchases");
    }
  }
  const nextBasis = s.revenue ? "revenue" : s.metrics.includes("qty") ? "qty" : s.metrics.includes("avg") ? "avg" : s.metrics.includes("count") ? "count" : s.metrics.includes("line") ? "revenue" : s.metrics.includes("amount") && (basis === "count" || basis === "avg") ? "amount" : basis;
  if (nextBasis !== basis) {
    if (nextBasis === "revenue" && entity !== "sales") return clarify("followup_entity_mismatch", MESSAGES.followup_entity_mismatch);
    basis = nextBasis;
    changed.add(basis === "revenue" ? "revenue" : basis === "qty" ? "quantity" : basis === "count" ? "invoice count" : basis === "avg" ? "average invoice value" : "amount");
  }

  // ---- grouping
  let dims = [...new Set(s.dims.map((d) => (d === "party" ? (entity === "sales" ? "customer" : "supplier") : d)))];
  if (!dims.length && s.whoFrame && !s.buckets.length) {
    const whoDim = s.whoFrame === "seller" ? null : s.whoFrame === "supplier" ? "supplier" : s.whoFrame === "buyer" ? "customer" : entity === "sales" ? "customer" : null;
    if (!whoDim || (whoDim === "customer") !== (entity === "sales")) return clarify("who_ambiguous", null);
    dims = [whoDim];
    notes.push(whoDim === "customer" ? NOTES.WHO_CUSTOMER_NOTE : NOTES.WHO_SUPPLIER_NOTE);
  }
  if (dims.length + s.buckets.length > 1) return NONE;
  if (dims.length) {
    const dim = dims[0];
    if (!CATALOG.dimensions[dim] || !CATALOG.dimensions[dim].entities.includes(entity)) return clarify("followup_entity_mismatch", MESSAGES.followup_entity_mismatch);
    if (!(groupBy.length && groupBy[0].dim === dim)) changed.add(`grouping by ${DIM_LABEL(dim)}`);
    groupBy = [{ dim }];
  } else if (s.buckets.length) {
    groupBy = [{ dim: "date", bucket: s.buckets[0] }];
    changed.add(`${s.buckets[0]}ly series`);
  }

  // ---- a name ("what about Maggi?"): the tenant-scoped resolver decides what it is, or the full router runs
  if (s.nameWords.length || s.quoted.length) {
    if (typeof resolveEntity !== "function" || (s.nameWords.length && s.quoted.length) || s.quoted.length > 1) return NONE;
    const text = s.quoted.length ? s.quoted[0] : s.nameWords.join(" ");
    let resolved;
    try {
      resolved = await resolveEntity({ entity, hintDim: null, text });
    } catch (error) {
      return { status: "unavailable" };
    }
    const matches = (resolved && resolved.matches) || [];
    if (matches.length !== 1) return NONE;
    const f = matches[0];
    if (!CATALOG.dimensions[f.dim] || !CATALOG.dimensions[f.dim].entities.includes(entity)) return clarify("followup_entity_mismatch", MESSAGES.followup_entity_mismatch);
    filters = [{ dim: f.dim, op: "eq_ci", value: f.value }];
    if (groupBy.length && groupBy[0].dim === f.dim) groupBy = [];
    changed.add(`${DIM_LABEL(f.dim)} ${f.value}`);
  }

  // ---- period and comparison
  const periods = s.periods;
  const bad = periods.find((p) => p.type);
  if (bad) return clarify(bad.type === "ambiguous" ? "ambiguous_period" : bad.reason, null);
  if (periods.length > 2) return NONE;
  if (periods.length === 2) {
    if (!s.connector) return NONE;
    const c = compareWith(periods[0], periods[1], s);
    if (!c) return NONE;
    period = periods[0];
    compare = c;
    changed.add("period").add("comparison");
    if (c.mode !== "custom" && modeNote(period, s, c.mode)) notes.push(modeNote(period, s, c.mode));
  } else if (periods.length === 1) {
    if (s.connector && !s.sply) {
      // "compare with last FY": the period is the comparison target for the kept subject
      const c = compareWith(period, periods[0], s);
      if (!c) return clarify("followup_not_applicable", MESSAGES.followup_not_applicable);
      compare = c;
      changed.add("comparison");
      if (c.mode !== "custom" && modeNote(period, s, c.mode)) notes.push(modeNote(period, s, c.mode));
    } else {
      const before = period;
      period = periods[0];
      changed.add("period");
      if (s.sply) (compare = { mode: "same_period_last_year" }), changed.add("comparison");
      else if (s.prevPeriod || s.pop.length) (compare = { mode: defaultMode(period, s) }), changed.add("comparison");
      else if (compare && (compare.mode === "like_for_like" || compare.mode === "full_previous")) {
        // the kept comparison follows the new period's standard mode, unless it was an explicit choice
        const explicitFull = compare.mode === "full_previous" && before.kind !== "current_month";
        const explicitSame = compare.mode === "like_for_like" && before.kind === "current_month";
        if (!explicitFull && !explicitSame && compare.mode !== defaultMode(period, s)) {
          compare = { mode: defaultMode(period, s) };
          if (modeNote(period, s, compare.mode)) notes.push(modeNote(period, s, compare.mode));
        }
      }
    }
  } else if (s.sply) {
    compare = { mode: "same_period_last_year" };
    changed.add("comparison");
  } else if (s.prior.length) {
    // "compared with the month before": the period just before the kept subject, same unit only (as the router)
    const u = RELATIVE_UNIT[period.kind];
    if (!u || u[0] !== s.prior[0] || new Set(s.prior).size > 1) return clarify("comparison_periods_not_aligned", null);
    compare = { mode: defaultMode(period, s) };
    changed.add("comparison");
  } else if (s.prevPeriod || s.pop.length) {
    compare = { mode: defaultMode(period, s) };
    if (modeNote(period, s, compare.mode)) notes.push(modeNote(period, s, compare.mode));
    changed.add("comparison");
  } else if (s.connector) {
    return clarify("comparison_target_missing", null);
  }

  // ---- change intents and thresholds
  const I = new Set(s.intents);
  const dirs = ["up", "down", "stopped", "new"].filter((k) => I.has(k));
  if (dirs.length > 1) return clarify("followup_conflicting", MESSAGES.followup_conflicting);
  const partyOrItem = groupBy.length && groupBy[0].dim !== "date";
  const needCompare = () => {
    if (!compare) {
      compare = { mode: defaultMode(period, s) };
      if (modeNote(period, s, compare.mode)) notes.push(modeNote(period, s, compare.mode));
      changed.add("comparison");
    }
  };
  if (s.pct.length) {
    if (!partyOrItem) return clarify("followup_needs_breakdown", MESSAGES.followup_needs_breakdown);
    // "only above 20%": the direction is the stated one, else the previous question's (a fall stays a fall)
    const down = I.has("down") || (!I.has("up") && !I.has("growth") && (intent.kind === "down" || intent.kind === "pct_down"));
    if (I.has("change") && !I.has("up") && !I.has("down") && !I.has("growth")) return clarify("threshold_direction_missing", null);
    intent = { kind: down ? "pct_down" : "pct_up", value: s.pct[0] };
    needCompare();
    changed.add(`change ${down ? "below -" : "above "}${s.pct[0]}%`);
  } else if (dirs.length) {
    const k = dirs[0] === "stopped" ? "lost" : dirs[0];
    if ((k === "lost" || k === "new") && !partyOrItem) return clarify("intent_needs_dimension", null);
    // decision 3: "new customer/supplier" needs the party master (not synced) - never the comparison reading
    if (k === "new" && (groupBy[0].dim === "customer" || groupBy[0].dim === "supplier")) return clarify("unsupported_new_party", NEW_PARTY_REASON);
    if (partyOrItem) intent = { kind: k };
    needCompare();
    changed.add(k === "lost" ? "stopped buying" : k === "new" ? "new" : k === "up" ? "increases only" : "decreases only");
  } else if (I.has("growth") || I.has("change") || s.pctMeasure) {
    needCompare();
  }
  if (intent.kind === "new") notes.push(NOTES.NEW_NOTE);
  if (intent.kind === "lost") notes.push(NOTES.LOST_NOTE);
  if (s.contribution && (intent.kind === "up" || intent.kind === "down")) notes.push(NOTES.CONTRIBUTION_NOTE);

  // ---- ranking
  if (s.topN !== null || s.rankDir !== null) {
    if (!partyOrItem && prev.mode !== "list") return clarify("followup_needs_dimension", MESSAGES.followup_needs_dimension);
    if (s.topN !== null) limit = s.topN;
    rankAsc = s.rankDir === "asc";
    changed.add(s.topN !== null ? `${rankAsc ? "bottom" : "top"} ${s.topN}` : rankAsc ? "lowest first" : "highest first");
  }

  if (!changed.size) return NONE;

  // ---- rebuild
  let plan;
  if (prev.mode === "list") {
    if (groupBy.length || compare || intent.kind !== "none" || entity !== prev.entity) return clarify("followup_not_applicable", MESSAGES.followup_not_applicable);
    plan = { ...JSON.parse(JSON.stringify(prev)), period, filters };
    if (limit !== undefined) plan.limit = limit;
  } else {
    const groupDim = partyOrItem ? groupBy[0].dim : null;
    const metrics = metricsFor(entity, basis, groupDim, filters);
    if (!metrics) return clarify("followup_not_applicable", MESSAGES.followup_not_applicable);
    const primary = primaryOf(metrics, basis);
    plan = { v: 1, entity, mode: "aggregate", period, metrics, filters };
    if (groupBy.length) plan.groupBy = groupBy;
    if (compare) plan.compare = compare;
    const hs = partyOrItem ? havingFor(intent, primary) : null;
    if (hs) {
      plan.having = hs.having;
      plan.sort = hs.sort;
      if (rankAsc && intent.kind === "down") plan.sort[0].dir = "asc";
    } else if (partyOrItem) {
      plan.sort = [{ by: primary, dir: rankAsc ? "asc" : "desc" }];
    }
    if (limit !== undefined && groupBy.length) plan.limit = limit;
    if (s.pctMeasure && partyOrItem && !s.pct.length) notes.push(NOTES.PCT_ORDER_NOTE);
  }
  if (basis === "revenue") notes.unshift(REVENUE_ASSUMPTION);

  const all = ["measure", "period", "comparison", "filter", "grouping"];
  const changedText = [...changed];
  const kept = all.filter((k) => {
    if (k === "period") return !changed.has("period");
    if (k === "comparison") return !!plan.compare && !changed.has("comparison");
    if (k === "filter") return (plan.filters || []).length > 0 && !changedText.some((c) => /^(?:customer|supplier|product|product group) /.test(c));
    if (k === "grouping") return !!(plan.groupBy && plan.groupBy.length) && !changedText.some((c) => /^grouping|series$/.test(c));
    return !changedText.some((c) => ["sales", "purchases", "revenue", "quantity", "invoice count", "average invoice value", "amount"].includes(c));
  });
  return { status: "merged", plan, basis, kept, changed: changedText, notes };
}

module.exports = { mergeFollowUp, buildQueryState, readQueryState, basisOf, MESSAGES, STATE_VERSION };
