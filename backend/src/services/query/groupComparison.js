"use strict";

// --------------------------------------------------
// "Compare the top 3 suppliers with the others": a ranking's top N against every other group, from ONE validated query.
//
// The ranking itself is an ordinary query plan (one customer / supplier / product / product-group grouping, sorted by an
// additive metric, highest first). The comparison runs that same plan with the largest row limit and the engine's own
// overall total (`totals`, a separate query over the same tenant, period and filters, never a sum of the rows):
//   top N total   = the first N ranked rows
//   others total  = overall total - top N total (every other group, including those beyond the row limit)
//   others count  = the remaining rows, only when every group was returned (otherwise not stated)
// When every group was returned, the remaining rows must add up to the others total, or no figure is shown.
// Shares are given only against a positive overall total. Nothing here calls a model or re-queries.
//
// Follow-ups: the turn's state is the ranking plan (limit N) plus `group` {top, members}; a later turn that only changes the
// period ("Aug 2025") keeps the comparison, re-ranked inside the new period by the same rule.
// --------------------------------------------------

const { CATALOG, LIMITS } = require("./semanticCatalog");
const { fmtValue, fmtSigned, formatQueryAnswer } = require("./answerFormatter");
const { buildPresentation, shortLabel, col, PRESENTATION_VERSION } = require("./presentation");

const MAX_TOP = 10; // a "top N" group is at most the default ranking size
const ELIGIBLE_DIMS = new Set(["supplier", "customer", "product", "productGroup"]);
const ADDITIVE_OPS = new Set(["sum", "count"]); // a share of a total needs a measure that adds up across groups
const PLURAL = { supplier: "suppliers", customer: "customers", product: "products", productGroup: "product groups" };

// ---- the question: "compare (the) top 3 (suppliers) with (the) others / rest / remaining"
const COMPARE_WORDS = /\b(?:compare[ds]?|comparison|vs|versus|against|tulna|mukabla|muqabla)\b/i;
const OTHERS_WORDS = /\b(?:others|other\s+(?:suppliers?|customers?|products?|parties|party|items?|groups?)|(?:the\s+)?rest|remaining|everyone\s+else|everybody\s+else|baaki|baki)\b/i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const TOP_N = /\btop\s*[-:]?\s*(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;
const DIM_WORDS = { supplier: /\bsuppliers?\b|\bvendors?\b/i, customer: /\bcustomers?\b|\bbuyers?\b/i, product: /\bproducts?\b|\bitems?\b/i };
// words a comparison request may contain without adding scope (anything else - a period, a filter - goes to the planner)
const FILLER = new Set(
  "compare compared compares comparison with to against vs versus and the a my our top all of them these those that this group groups others other rest remaining everyone everybody else baaki baki ke se ki ka saath sath karo kar do please now suppliers supplier vendors vendor customers customer buyers buyer products product items item parties party".split(" ")
);

/** The explicit "top N" of a question, or null. */
function topNOf(text) {
  const m = typeof text === "string" ? TOP_N.exec(text) : null;
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()];
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * A top-versus-others request, or null. `pure`: nothing but the request (no period, filter or measure), so the previous
 * ranking can be reused as it is, without a planner call. `dim`: the grouping the words name, if any.
 */
function intentOf(text) {
  if (typeof text !== "string" || !COMPARE_WORDS.test(text) || !OTHERS_WORDS.test(text)) return null;
  const dims = Object.keys(DIM_WORDS).filter((d) => DIM_WORDS[d].test(text));
  const rest = text.toLowerCase().replace(TOP_N, " ").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !FILLER.has(w) && !(w in NUMBER_WORDS));
  return { n: topNOf(text), dim: dims.length === 1 ? dims[0] : dims.length ? "mixed" : null, pure: rest.length === 0 };
}

/** The ranking rule of a plan ({dim, metric, n}), or null when the plan is not a ranking a top group can be cut from. */
function rankingOf(plan) {
  if (!plan || plan.mode !== "aggregate" || plan.compare || (plan.having || []).length) return null;
  const groupBy = plan.groupBy || [];
  if (groupBy.length !== 1 || !ELIGIBLE_DIMS.has(groupBy[0].dim)) return null;
  const sort = (plan.sort || [])[0];
  const metric = sort ? sort.by : (plan.metrics || [])[0];
  const def = CATALOG.metrics[metric];
  if (!def || !(plan.metrics || []).includes(metric) || !def.aggregation || !ADDITIVE_OPS.has(def.aggregation.op)) return null;
  if (sort && sort.dir !== "desc") return null; // "top" is highest first; a lowest-first list is not cut into a top group
  return { dim: groupBy[0].dim, metric, n: plan.limit !== undefined ? plan.limit : LIMITS.defaultLimit };
}
const sameRanking = (a, b) => !!a && !!b && a.dim === b.dim && a.metric === b.metric;

/** The ranking plan a follow-up carries: one metric, highest first, limited to the top N. */
function rankingPlan(plan, ranking, n) {
  const copy = JSON.parse(JSON.stringify(plan));
  return { ...copy, metrics: [ranking.metric], sort: [{ by: ranking.metric, dir: "desc" }], limit: n, totals: true, explain: "none" };
}
/** The plan that is executed: the same ranking with every group the engine may return, plus the overall total. */
const comparisonPlan = (plan, ranking) => rankingPlan(plan, ranking, LIMITS.maxLimit);

const nameOf = (row, dim) => {
  const v = row && row.key ? row.key[dim] : null;
  return v === null || v === undefined || v === "" ? "(no name)" : String(v);
};
const cents = (x) => Math.round(x * 100) / 100;

/**
 * The two groups from an executed comparison plan. {ok:false, reason} when the figures cannot be stated honestly.
 * @returns {{ok:true, top:{name:string,value:number}[], topTotal:number, othersTotal:number, overall:number, difference:number,
 *   topShare:number|null, othersShare:number|null, othersCount:number|null, othersAtLeast:number|null, tie:boolean}|{ok:false, reason:string}}
 */
function computeGroups(result, { metric, dim, n }) {
  const rows = (result && result.rows) || [];
  const overall = result && result.totals && result.totals.values ? result.totals.values[metric] : undefined;
  if (!rows.length) return { ok: false, reason: "no_rows" };
  if (typeof overall !== "number" || !Number.isFinite(overall)) return { ok: false, reason: "no_total" };
  const value = (r) => r.values[metric];
  if (rows.some((r) => typeof value(r) !== "number" || !Number.isFinite(value(r)))) return { ok: false, reason: "bad_row" };
  const top = rows.slice(0, n);
  const topTotal = top.reduce((t, r) => t + value(r), 0);
  const othersTotal = overall - topTotal;
  const tolerance = 0.01 * Math.max(1, rows.length);
  let othersCount = null;
  let othersAtLeast = null;
  if (result.truncated) {
    othersAtLeast = rows.length - top.length; // more groups exist beyond the row limit: their number is not known
    if (othersTotal < -tolerance) return { ok: false, reason: "not_reconciled" };
  } else {
    const listed = rows.slice(n).reduce((t, r) => t + value(r), 0);
    if (Math.abs(listed - othersTotal) > tolerance) return { ok: false, reason: "not_reconciled" };
    othersCount = rows.length - top.length;
  }
  const others = othersCount === 0 ? 0 : othersTotal;
  const shares = overall > 0 && topTotal >= 0 && others >= -tolerance;
  return {
    ok: true,
    top: top.map((r) => ({ name: nameOf(r, dim), value: value(r) })),
    topTotal: cents(topTotal),
    othersTotal: cents(others),
    overall: cents(overall),
    difference: cents(topTotal - others),
    topShare: shares ? (topTotal / overall) * 100 : null,
    othersShare: shares ? (Math.max(0, others) / overall) * 100 : null,
    othersCount,
    othersAtLeast,
    tie: rows.length > n && value(rows[n - 1]) === value(rows[n]),
  };
}

const pctText = (p) => (p === null ? null : `${p.toFixed(1)}%`);
const groupLabels = (n, dim) => ({ top: `Top ${n} ${n === 1 ? dim === "productGroup" ? "product group" : dim : PLURAL[dim]}`, others: `All other ${PLURAL[dim]}`, all: `All ${PLURAL[dim]}` });
const countText = (g) => (g.othersCount !== null ? String(g.othersCount) : g.othersAtLeast !== null ? `more than ${g.othersAtLeast}` : null);
const sameMembers = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const samePeriod = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

const REASON_TEXT = {
  no_rows: "No matching records were found for this period, so there is nothing to compare.",
  no_total: "The overall total for this period could not be read, so the other group's total is not stated (it is never estimated from the top group).",
  bad_row: "A ranked value could not be read, so no group totals are stated.",
  not_reconciled: "The ranked rows do not add up to the overall total for this period, so no group totals are stated.",
};

/**
 * Text + presentation of a top-versus-others answer, from the executed comparison plan's result.
 * @param {object} a
 * @param {object} a.plan the ranking plan (the turn's period and filters) @param {object} a.execPlan the executed comparison plan
 * @param {object} a.result the engine result of execPlan @param {{dim:string, metric:string}} a.ranking @param {number} a.n
 * @param {{top:number, members:string[]}|null} [a.previous] the previous turn's group @param {object} [a.previousPeriod]
 * @returns {{text:string, warnings:string[], zero:boolean, members:string[], visualization:object|null}}
 */
function formatGroupAnswer({ plan, execPlan, result, ranking, n, contextNotes = [], definitionNotes = [], plannerAssumptions = [], dataThrough = null, previous = null, previousPeriod = null, display = null }) {
  const { dim, metric } = ranking;
  const base = formatQueryAnswer({ plan: execPlan, result, definitionNotes, plannerAssumptions, contextNotes, dataThrough });
  const labels = groupLabels(n, dim);
  const header = base.text.split("\n")[0].replace(/ — by [^—]+$/, ` — ${labels.top.toLowerCase()} vs ${labels.others.toLowerCase()}`);
  const g = computeGroups(result, { metric, dim, n });
  const notes = [...base.notes];
  const rule = `${labels.top} = the ${n} with the highest ${shortLabel(metric).toLowerCase()} in this period; ${labels.others.toLowerCase()} = every other ${dim === "productGroup" ? "product group" : dim} in the same period, filters and basis (overall total minus the top ${n}).`;
  notes.unshift(rule);
  if (plan.entity === "purchase" && dim === "supplier" && CATALOG.metrics[metric].amountBasis) {
    notes.unshift("This ranks suppliers by how much was bought from them, not by price: a larger total does not mean a lower rate. To compare prices, ask for supplier rates of a product.");
  }
  if (!g.ok) {
    const text = [header, "", REASON_TEXT[g.reason], ...(notes.length ? ["", ...notes.map((x) => `• ${x}`)] : [])].join("\n");
    return { text, warnings: base.warnings, zero: g.reason === "no_rows", members: [], visualization: g.reason === "no_rows" ? buildPresentation({ plan: execPlan, result, notes: base.notes, zero: true }) : null };
  }
  const members = g.top.map((t) => t.name);
  if (g.tie) notes.push(`The ${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"} and the next ${dim === "productGroup" ? "product group" : dim} have the same ${shortLabel(metric).toLowerCase()}; the engine's order between them decided the top ${n}.`);
  if (previous && previous.members && previous.members.length && !samePeriod(previousPeriod, plan.period) && !sameMembers(previous.members, members)) {
    notes.push(`The top ${n} are ranked inside this period, so they differ from the previous answer's (${previous.members.join(", ")}).`);
  }
  if (g.othersCount === null) notes.push(`More ${PLURAL[dim]} exist than one query returns (${LIMITS.maxLimit}), so the number of other ${PLURAL[dim]} is not stated; their total comes from the overall total.`);

  const v = (x) => fmtValue(metric, x);
  const others = countText(g);
  const summary =
    g.othersCount === 0
      ? `Only ${g.top.length} ${PLURAL[dim]} have ${shortLabel(metric).toLowerCase()} in this period, so there is no other group: they account for all ${v(g.overall)}.`
      : `The ${labels.top.toLowerCase()} account for ${v(g.topTotal)}${g.topShare !== null ? ` (${pctText(g.topShare)} of ${v(g.overall)})` : ""}; ${labels.others.toLowerCase()}${others ? ` (${others})` : ""} account for ${v(g.othersTotal)}${g.othersShare !== null ? ` (${pctText(g.othersShare)})` : ""}. The top ${n} account for ${v(Math.abs(g.difference))} ${g.difference >= 0 ? "more" : "less"} than ${labels.others.toLowerCase()}.`;
  const lines = [header, "", summary, "", `${labels.top} (highest ${shortLabel(metric).toLowerCase()} first):`];
  g.top.forEach((t, i) => lines.push(`${i + 1}. ${t.name} — ${v(t.value)}`));
  if (g.topShare === null && g.othersCount !== 0) notes.push("Shares are not given: the overall total is not positive.");
  const uniq = [...new Set(notes)];
  lines.push("", ...uniq.map((x) => `• ${x}`));
  return { text: lines.join("\n"), warnings: base.warnings, zero: false, members, visualization: buildGroupPresentation({ execPlan, result, g, labels, metric, dim, notes: uniq, summary, display }) };
}

/**
 * The structured view (kind "groups"): a one-line caption (share and difference: the two things the table does not say at a
 * glance), the two-bar chart, the group table and the top N - all from `g`. The KPI cards hold the same figures for any view
 * that wants them; the full sentence stays in the text answer.
 */
function buildGroupPresentation({ execPlan, result, g, labels, metric, dim, notes, summary, display }) {
  try {
    const ranking = buildPresentation({ plan: execPlan, result, notes }); // title, period, scope, basis and notes (basis lines stated once): the single-query view's own
    if (!ranking) return null;
    const v = (x) => fmtValue(metric, x);
    const share = (p) => (p === null ? "—" : pctText(p));
    const hasOthers = g.othersCount !== 0;
    const kpis = [
      { id: "top", label: `${labels.top} total`, display: v(g.topTotal) },
      ...(hasOthers ? [{ id: "others", label: `${labels.others} total`, display: v(g.othersTotal) }, { id: "difference", label: "Difference", display: fmtSigned(metric, g.difference) }] : []),
      ...(g.topShare !== null ? [{ id: "share", label: `${labels.top} share`, display: share(g.topShare) }] : []),
    ];
    const chartable = hasOthers && g.topTotal >= 0 && g.othersTotal >= 0;
    return {
      v: PRESENTATION_VERSION,
      kind: "groups",
      title: ranking.title,
      period: ranking.period,
      scope: ranking.scope,
      dimension: ranking.dimension,
      summary,
      caption: hasOthers
        ? `${labels.top} ${g.topShare !== null ? `hold ${pctText(g.topShare)} of the total` : `total ${v(g.topTotal)}`}: ${v(Math.abs(g.difference))} ${g.difference >= 0 ? "more" : "less"} than ${labels.others.toLowerCase()}.`
        : summary,
      kpis,
      chart: chartable
        ? { type: "bar", metric: shortLabel(metric), money: !!CATALOG.metrics[metric].amountBasis, highlight: 0, points: [{ label: labels.top, value: g.topTotal, display: v(g.topTotal) }, { label: labels.others, value: g.othersTotal, display: v(g.othersTotal) }] }
        : null,
      columns: [col("group", "Group", "left"), col("total", shortLabel(metric)), col("share", "Share of total"), col("count", `Number of ${PLURAL[dim]}`)],
      rows: [
        { cells: { group: labels.top, total: v(g.topTotal), share: share(g.topShare), count: String(g.top.length) } },
        ...(hasOthers ? [{ cells: { group: labels.others, total: v(g.othersTotal), share: share(g.othersShare), count: countText(g) || "—" } }] : []),
      ],
      totals: { cells: { group: labels.all, total: v(g.overall), share: g.topShare !== null ? "100.0%" : "—", count: g.othersCount !== null ? String(g.top.length + g.othersCount) : "—" } },
      members: {
        label: `${labels.top} in this comparison`,
        columns: [col("rank", "#", "right", { narrow: true }), col("name", ranking.dimension, "left"), col("total", shortLabel(metric)), col("share", "Share of total")],
        rows: g.top.map((t, i) => ({ cells: { rank: String(i + 1), name: t.name, total: v(t.value), share: g.topShare !== null ? pctText((t.value / g.overall) * 100) : "—" } })),
      },
      basis: ranking.basis,
      notes: ranking.notes,
      ...(display ? { display } : {}),
    };
  } catch (error) {
    return null;
  }
}

/** The follow-up state of a comparison turn: the ranking plan (limit N) and the group, as a normal query state plus `group`. */
function groupState(queryState, members, n) {
  return { ...queryState, group: { top: n, members: members.slice(0, n) } };
}

module.exports = { intentOf, topNOf, rankingOf, sameRanking, rankingPlan, comparisonPlan, computeGroups, formatGroupAnswer, buildGroupPresentation, groupState, MAX_TOP };
