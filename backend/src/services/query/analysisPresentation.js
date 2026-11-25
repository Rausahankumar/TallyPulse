"use strict";

// --------------------------------------------------
// Structured view of an analysis answer (presentation model v1, kind "analysis"): the same step results and evidence record
// that formatAnalysisAnswer turns into text, laid out for the chat as a headline, KPI cards, one featured visual, the
// labelled findings, suggested next actions and every step behind an expander. Presentation only: it never runs a query,
// never changes the answer text and computes nothing new - each query step's view is the single-query presentation of that
// step's own plan and result (buildPresentation), and every finding is the evidence record's own text with its step numbers.
// --------------------------------------------------

const { buildPresentation, primaryOf, shortLabel, compareLabel, col, PRESENTATION_VERSION } = require("./presentation");
const { formatQueryAnswer, fmtValue, fmtSigned, pctOf, plainMetricNames } = require("./answerFormatter");
const { unavailableText, FINDING_LABELS, LABEL_NOTE, INSIGHT_FIELDS, TOOL_TITLES, SUMMARIES, fmt, noActionText, ACTION_KIND_LABELS } = require("./analysisAnswer");
const { CATALOG } = require("./semanticCatalog");

/** One query step's single-query view, built from its own plan and result exactly as a one-query answer would be. */
function queryView(step) {
  const f = formatQueryAnswer({ plan: step.request, result: step.result });
  return buildPresentation({ plan: step.request, result: step.result, notes: f.notes, zero: f.zero });
}

/** An insight tool's rows as a table: the tool's own fields (INSIGHT_FIELDS), its own numbers, formatted like the text. */
function insightView(step) {
  const ev = step.result;
  const fields = INSIGHT_FIELDS[step.tool] || [];
  const rows = (ev.data && ev.data.rows) || [];
  const numeric = (k) => rows.some((r) => typeof r[k] === "number");
  const notes = [];
  if (rows.length && ev.coverage && ev.coverage.ordering) notes.push(`Ordered by ${ev.coverage.ordering}.`);
  if (ev.coverage && ev.coverage.mayHaveMore) notes.push("Only the top rows were requested; more may exist.");
  notes.push(...((ev.coverage && ev.coverage.notes) || []), ...(ev.disclosures || []), ...(ev.limitations || []));
  return {
    title: TOOL_TITLES[step.tool] || step.tool,
    period: ev.period ? `${ev.period.from} to ${ev.period.to}` : null,
    product: ev.productMatch ? ev.productMatch.resolved : null,
    summary: SUMMARIES[step.tool] && ev.data && ev.data.hasData ? SUMMARIES[step.tool](ev.data) : null,
    columns: fields.map(([k, label]) => col(k, label, numeric(k) ? "right" : "left")),
    rows: rows.map((r) => ({ cells: Object.fromEntries(fields.map(([k]) => [k, fmt(r[k])])) })),
    notes,
  };
}

/**
 * The KPI cards of the analysis: current, previous, change and % change of the primary metric of the FIRST step that ran
 * a comparison and returned its totals. Every value is the engine's own (totals.values / totals.comparison), formatted by
 * the same functions as the text; nothing when no step compared two periods.
 */
function kpisOf(entries) {
  for (const e of entries) {
    if (e.kind !== "query" || !e.view || e.view.kind === "empty") continue;
    const { request: plan, result } = e.step;
    const totals = result.totals;
    const primary = primaryOf(result.metrics || plan.metrics || []);
    const c = totals && totals.comparison && totals.comparison[primary];
    if (!c || !totals.values || typeof totals.values[primary] !== "number") continue;
    const metric = shortLabel(primary);
    const direction = c.delta > 0 ? "up" : c.delta < 0 ? "down" : "flat";
    return {
      step: e.n,
      metric,
      // the step view's own basis labels (invoice totals incl. tax vs pre-tax line values): the cards say what they add up
      basis: e.view.basis || [],
      cards: [
        { id: "current", label: `${metric} · ${e.view.period.label}`, display: fmtValue(primary, totals.values[primary]) },
        { id: "previous", label: `${metric} · ${compareLabel(plan, result)}`, display: fmtValue(primary, c.previous) },
        { id: "change", label: "Change", display: fmtSigned(primary, c.delta), direction },
        { id: "pct", label: "Change %", display: pctOf(c), direction },
      ],
    };
  }
  return null;
}

/**
 * The one visual shown open: the step behind the first contributor finding (the breakdown of the change), else the first
 * trend or ranking, else the KPI step's own comparison, else the first step with a view. Steps without a chart or table
 * (a single figure) are never featured over one that has them.
 */
function featuredOf(entries, evidence, kpis) {
  const visual = (e) => e && e.view && ["ranking", "trend", "comparison", "table"].includes(e.view.kind);
  const byN = (n) => entries.find((e) => e.n === n);
  const contributor = (evidence.findings || []).find((f) => f.label === "contributor");
  const fromContributor = contributor && contributor.steps.map(byN).find(visual);
  if (fromContributor) return fromContributor;
  const shaped = entries.find((e) => visual(e) && (e.view.kind === "trend" || e.view.kind === "ranking"));
  if (shaped) return shaped;
  if (kpis && visual(byN(kpis.step))) return byN(kpis.step);
  return entries.find((e) => visual(e) || e.insight) || null;
}

// ---- sales next to purchases, per product: two ranking steps over the same product grouping, measure, basis, period and filters
const PAIR_DIMS = new Set(["product", "productGroup"]);
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
function pairable(s, p) {
  const a = s.step, b = p.step;
  const g = a.request.groupBy || [];
  if (g.length !== 1 || !PAIR_DIMS.has(g[0].dim) || !same(g, b.request.groupBy)) return false;
  if (a.request.compare || b.request.compare || a.result.comparison || b.result.comparison) return false;
  const m = primaryOf(a.result.metrics || []);
  if (m !== primaryOf(b.result.metrics || []) || !same((a.result.amountBasis || {})[m], (b.result.amountBasis || {})[m])) return false;
  return same(a.result.period && [a.result.period.from, a.result.period.to], b.result.period && [b.result.period.from, b.result.period.to]) && same(a.request.filters || [], b.request.filters || []);
}

/**
 * One aligned table (and two-series chart) of a sales step and a purchase step of the same products: a row per product in
 * either list, by sales then purchases. A product absent from a COMPLETE list had no activity on that side ("none in this
 * period"); absent from a list cut at its limit, its value is unknown ("not in the top N returned"). Never a zero for either,
 * never a difference (sales and purchase line values are not a margin). Values are the steps' own, formatted once.
 */
function pairView(s, p) {
  const m = primaryOf(s.step.result.metrics);
  const dim = s.step.request.groupBy[0].dim;
  const side = (e) => {
    const map = new Map();
    for (const r of e.step.result.rows || []) map.set(String(r.key[dim]), r.values[m]);
    return { map, complete: !e.step.result.truncated, shown: (e.step.result.rows || []).length };
  };
  const sales = side(s), buys = side(p);
  const names = [...sales.map.keys(), ...[...buys.map.keys()].filter((k) => !sales.map.has(k))];
  const missing = (x, what) => (x.complete ? `No ${what} in this period` : `Not in the top ${x.shown} ${what} returned`);
  let both = 0;
  const rows = names.map((name) => {
    const sv = sales.map.has(name) ? sales.map.get(name) : null;
    const pv = buys.map.has(name) ? buys.map.get(name) : null;
    if (sv !== null && pv !== null) both += 1;
    const flags = [sv === null ? missing(sales, "sales") : null, pv === null ? missing(buys, "purchases") : null].filter(Boolean);
    return { name, sv, pv, cells: { name, sales: sv === null ? "—" : fmtValue(m, sv), purchases: pv === null ? "—" : fmtValue(m, pv) }, ...(flags.length ? { flag: flags.join("; ") } : {}) };
  });
  const label = CATALOG.dimensions[dim].label;
  const notes = [...new Set([...(s.view.notes || []), ...(p.view.notes || [])])];
  if (!sales.complete || !buys.complete) notes.unshift(`Each side lists only its top ${label.toLowerCase()}s: a dash means the value is not in that list, not zero.`);
  return {
    v: PRESENTATION_VERSION,
    kind: "paired",
    steps: [s.n, p.n],
    title: `Sales vs purchases by ${label.toLowerCase()}`,
    period: s.view.period,
    scope: s.view.scope, // no dimension: the title already names it
    summary: `${names.length} ${label.toLowerCase()}s: ${both} with both sales and purchases, ${names.length - both} on one side only.`,
    columns: [col("name", label, "left"), col("sales", `Sales · ${shortLabel(m)}`), col("purchases", `Purchases · ${shortLabel(m)}`)],
    rows: rows.map(({ cells, flag }) => ({ cells, ...(flag ? { flag } : {}) })),
    chart: rows.length >= 2
      ? {
          type: "bar-pair",
          metric: shortLabel(m),
          money: !!(CATALOG.metrics[m] && CATALOG.metrics[m].amountBasis),
          series: [{ key: "sales", label: "Sales" }, { key: "purchases", label: "Purchases" }],
          // a missing side is null (no bar), never 0
          points: rows.slice(0, 10).map((r) => ({ label: r.name, sales: r.sv, purchases: r.pv, salesDisplay: r.cells.sales, purchasesDisplay: r.cells.purchases })),
          shownOf: rows.length > 10 ? { shown: 10, total: rows.length } : null,
        }
      : null,
    basis: s.view.basis || [],
    notes,
  };
}

function pairsOf(entries) {
  const ranked = entries.filter((e) => e.kind === "query" && e.view && e.view.kind === "ranking");
  const used = new Set();
  const pairs = [];
  for (const s of ranked) {
    if (s.step.request.entity !== "sales" || used.has(s.n)) continue;
    const p = ranked.find((o) => !used.has(o.n) && o.step.request.entity === "purchase" && pairable(s, o));
    if (!p) continue;
    used.add(s.n);
    used.add(p.n);
    pairs.push(pairView(s, p));
  }
  return pairs;
}

// Customers have sales only: purchases are recorded by supplier, so a customer breakdown next to a purchase comparison has no counterpart.
const NO_CUSTOMER_PURCHASES = "Purchases are recorded by supplier, not by customer, so customers are shown with sales only.";

/**
 * @param {{execution: {steps: object[]}, formatted: {answered: number, evidence: object}, assumptions?: string[],
 *          unavailable?: string[], display?: "chart"|"table"|null}} input
 * @returns {object|null} the analysis presentation, or null (no step answered, or anything unexpected): the text stays the answer
 */
function buildAnalysisPresentation({ execution, formatted, assumptions = [], unavailable = [], display = null, actions = false }) {
  try {
    if (!formatted || !formatted.answered) return null;
    const evidence = formatted.evidence || { findings: [], gaps: [], recommendations: [] };
    const entries = ((execution && execution.steps) || []).map((s, i) => {
      const base = { n: i + 1, step: s, origin: s.origin ? s.origin.reason : null, status: s.status };
      if (s.status !== "ok") return { ...base, kind: "not_run", message: s.error ? s.error.message : s.message || "It could not run." };
      if (s.kind === "query") return { ...base, kind: "query", view: queryView(s), facts: s.facts || null };
      return { ...base, kind: "insight", insight: insightView(s) };
    });

    const kpis = kpisOf(entries);
    const pairs = pairsOf(entries);
    const paired = new Set(pairs.flatMap((x) => x.steps));
    // the featured visual is never one half of a pair: the pair itself is shown first
    const featured = featuredOf(entries.filter((e) => !paired.has(e.n)), evidence, kpis);
    const hasPurchases = entries.some((e) => e.kind === "query" && e.step.request.entity === "purchase");
    const customerOnlySales = entries.some((e) => e.kind === "query" && e.step.request.entity === "sales" && (e.step.request.groupBy || []).some((g) => g.dim === "customer"));
    const findings = evidence.findings || [];
    // the headline is the overall result (its direction, and any mismatch with what the steps looked for); without one, the
    // first measured finding, preferring the KPI step's own
    const overall = evidence.overall || null;
    const measured = findings.filter((f) => f.label === "measured" && !(overall && f.text === overall.sourceText));
    const fallback = (kpis && measured.find((f) => f.steps.includes(kpis.step))) || measured[0] || null;
    const item = (f) => ({ text: f.text, steps: f.steps || [] });
    const headline = overall ? { text: overall.text, steps: overall.steps || [], note: overall.note || null } : fallback ? item(fallback) : null;

    const bases = new Set();
    for (const e of entries) for (const b of (e.view && e.view.basis) || []) bases.add(b);

    return {
      v: PRESENTATION_VERSION,
      kind: "analysis",
      // the plain-language opening (formatAnalysisAnswer's, in the question's language): shown first; the rest is detail
      plain: formatted.plain && formatted.plain.lines.length ? formatted.plain : null,
      display,
      headline,
      kpis,
      pairs,
      featuredStep: pairs.length ? null : featured ? featured.n : null,
      pairNote: pairs.length && hasPurchases && customerOnlySales ? NO_CUSTOMER_PURCHASES : null,
      // labelled exactly as the text labels them
      assumptions: assumptions.map((a) => `Interpretation (AI-assisted): ${plainMetricNames(a)}`),
      unavailable: unavailableText(unavailable),
      findings: {
        measured: measured.filter((f) => f !== fallback || !!overall).map(item),
        contributors: findings.filter((f) => f.label === "contributor").map(item),
        possibleCauses: findings.filter((f) => f.label === "possible_cause").map(item),
      },
      findingLabels: { measured: FINDING_LABELS.measured, contributor: FINDING_LABELS.contributor, possibleCause: FINDING_LABELS.possible_cause },
      gaps: (evidence.gaps || []).map(item),
      // shown only when the question asked what to do (as in the text); asked with none derivable: said so, never invented
      recommendations: actions ? (evidence.recommendations || []).map((r) => ({ ...item(r), kind: r.kind || "verify", kindLabel: ACTION_KIND_LABELS[r.kind] || ACTION_KIND_LABELS.verify, because: r.because || null })) : [],
      noAction: actions && !(evidence.recommendations || []).length ? noActionText(evidence) : null,
      labelNote: findings.length ? LABEL_NOTE : null,
      basis: [...bases],
      steps: entries.map(({ step, view, ...e }) => ({
        ...e,
        ...(paired.has(e.n) ? { paired: true } : {}),
        title: e.kind === "query" ? `${CATALOG.entities[step.request.entity].label}${view && view.period ? ` · ${view.period.label}` : ""}${view && view.dimension ? ` · by ${view.dimension.toLowerCase()}` : ""}` : e.kind === "insight" ? e.insight.title : `Step ${e.n}`,
        ...(view ? { view } : {}),
      })),
    };
  } catch (error) {
    return null;
  }
}

module.exports = { buildAnalysisPresentation };
