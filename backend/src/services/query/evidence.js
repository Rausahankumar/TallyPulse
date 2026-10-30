"use strict";

// --------------------------------------------------
// Evidence record of an analysis plan (Milestone 3): deterministic findings computed ONLY from the results of steps that ran,
// each with a label that says how far it goes. No model is called and nothing here reads the database.
//   measured       - a value the steps returned, or arithmetic on returned values (a change, a difference, an average rate)
//   contributor    - a measured part of a measured change, with its share; the parts add up to the change exactly
//   possible_cause - a pattern in the measured data that is CONSISTENT with an explanation (for example purchases of the same
//                    product fell just before its sales fell); always worded as unproven
// Rules are generic over result shapes (a series by date, a comparison by one dimension, two totals of sales and purchases);
// none knows a question. Where a calculation is not valid (mixed units, no quantity in a period, an incomplete latest bucket,
// rows not listed and no total) the limitation is stated as a gap instead of a finding.
// --------------------------------------------------

const { CATALOG } = require("./semanticCatalog");
const { fmtValue, fmtMoney, fmtNumber, isZero } = require("./answerFormatter");

const MAX_SERIES = 3; // series groups reported per step (largest change first)
const MAX_CONTRIBUTORS = 5; // contributors named per comparison step
const MAX_INACTIVE = 5; // inactive parties named per comparison step
const MAX_PAIRS = 12; // adjacent bucket pairs listed per series (the most recent)
const MATERIAL_FALL_PCT = 10; // a purchase fall smaller than this is not offered as a possible cause
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Line value -> its quantity on the same line grain (a rate is only valid for one product, see productScope).
const QUANTITY_OF = { lineAmount: "quantity", returnLineAmount: "returnQuantity" };
const ENTITY_NOUN = { sales: "Sales", purchase: "Purchases", sales_return: "Sales returns", purchase_return: "Purchase returns" };
const QTY_VERB = { sales: "sold", purchase: "bought", sales_return: "returned", purchase_return: "returned" };
const BASIS_TEXT = { voucher_total_incl_tax: "invoice totals including tax", line_item_pre_tax: "pre-tax item values" };

// Currency precision: half away from zero, so -0.005 and 0.005 round alike.
const round2 = (n) => (Math.sign(n) * Math.round(Math.abs(n) * 100)) / 100 || 0;
const pad = (n) => String(n).padStart(2, "0");
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = (value) => (value ? localDay(new Date(value)) : null);
/** The latest voucher's calendar day: a Date (dc.latestVoucher, local midnight of that day) or a "YYYY-MM-DD" string; else null. */
function dataDayOf(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return value instanceof Date && !Number.isNaN(value.getTime()) ? localDay(value) : null;
}
const isMoney = (id) => !!(CATALOG.metrics[id] && CATALOG.metrics[id].amountBasis);
// "Line amount (pre-tax)" -> "line amount, pre-tax" (it is shown inside the finding's own brackets)
const metricLabel = (id) => (CATALOG.metrics[id] ? CATALOG.metrics[id].label.replace(/ \((.*)\)$/, ", $1").replace(/^./, (c) => c.toLowerCase()) : id);
const signed = (id, v) => (v > 0 ? `+${fmtValue(id, v)}` : v < 0 ? `-${fmtValue(id, -v)}` : fmtValue(id, 0));
const pct = (part, whole) => `${((part / whole) * 100).toFixed(1)}%`;

// ---- calendar buckets (the engine cuts date buckets in UTC; their keys are YYYY-MM-DD starts)
function addMonths(start, n) {
  const [y, m] = start.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}
const addDays = (start, n) => new Date(Date.parse(`${start}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const STEP_OF = { day: (s) => addDays(s, 1), week: (s) => addDays(s, 7), month: (s) => addMonths(s, 1), quarter: (s) => addMonths(s, 3), fy: (s) => addMonths(s, 12) };
const bucketEnd = (bucket, start) => addDays(STEP_OF[bucket](start), -1);
function bucketName(key) {
  if (key.bucket === "month") return `${MONTHS[Number(key.start.slice(5, 7)) - 1]} ${key.start.slice(0, 4)}`;
  return key.label;
}
function periodName(from, to) {
  if (!from || !to) return "the period";
  if (from.slice(8) === "01" && bucketEnd("month", `${from.slice(0, 8)}01`) === to) return bucketName({ bucket: "month", start: from });
  // whole months: "Sep–Oct 2025", "Dec 2025–Jan 2026"
  if (from.slice(8) === "01" && bucketEnd("month", `${to.slice(0, 8)}01`) === to && from < to) {
    const a = bucketName({ bucket: "month", start: from }), b = bucketName({ bucket: "month", start: `${to.slice(0, 8)}01` });
    return from.slice(0, 4) === to.slice(0, 4) ? `${a.slice(0, 3)}–${b}` : `${a}–${b}`;
  }
  return `${from} to ${to}`;
}

/** The one product a step is restricted to (a single-value product filter), else null. */
function productScope(plan) {
  const f = ((plan && plan.filters) || []).filter((x) => x.dim === "product");
  if (f.length !== 1) return null;
  const v = f[0].op === "eq_ci" ? f[0].value : f[0].op === "in_ci" && Array.isArray(f[0].value) && f[0].value.length === 1 ? f[0].value[0] : null;
  return typeof v === "string" && v ? v : null;
}
const sameName = (a, b) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
const listNames = (values) => (values.length <= 3 ? values.join(", ") : `${values.slice(0, 3).join(", ")} and ${values.length - 3} more`);
/** Every filter of a step except its single product (named separately), so a finding never reads wider than its step. */
function filtersText(plan) {
  const product = productScope(plan);
  const parts = ((plan && plan.filters) || []).filter((f) => !(product && f.dim === "product")).map((f) => {
    const values = Array.isArray(f.value) ? f.value : [f.value];
    if (f.op === "new_in_period") return `new ${dimPlural(f.dim)} only`;
    if (f.op === "contains_ci") return `${dimPlural(f.dim)} containing "${f.value}"`;
    return `${values.length > 1 ? dimPlural(f.dim) : dimPlural(f.dim).replace(/s$/, "")} ${listNames(values)}`;
  });
  return parts.length ? ` for ${parts.join("; ")}` : "";
}
/** "Sales of Apple for customers A, B" - the entity, its product and every other filter of the step. */
const scopeText = (plan, noun, product) => `${noun}${product ? ` of ${product}` : ""}${filtersText(plan)}`;
const valueMetric = (plan) => (plan.metrics || []).find(isMoney) || null;
const DIM_PLURAL = { customer: "customers", supplier: "suppliers", product: "products", productGroup: "product groups", voucherType: "voucher types" };
const dimPlural = (dim) => DIM_PLURAL[dim] || dim;

// ---------------------------------------------------------------- rule 1: change between the last two complete buckets of a series

function seriesGroups(step) {
  const plan = step.request;
  const dateDim = (plan.groupBy || []).find((g) => g.dim === "date");
  if (!dateDim || !STEP_OF[dateDim.bucket] || plan.groupBy.length > 2 || step.result.comparison) return [];
  const other = plan.groupBy.find((g) => g.dim !== "date");
  const groups = new Map();
  for (const r of step.result.rows || []) {
    if (!r.key || !r.key.date || !r.key.date.start) continue;
    const gk = other ? r.key[other.dim] : "";
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(r);
  }
  return [...groups.entries()].map(([group, rows]) => ({ group, dim: other ? other.dim : null, bucket: dateDim.bucket, rows: rows.sort((a, b) => (a.key.date.start < b.key.date.start ? -1 : 1)) }));
}

/**
 * Every adjacent pair of complete buckets of one series, oldest first, and why any bucket was left out. Only the latest
 * bucket can be incomplete (no data exists after `completeThrough`); a missing bucket is never bridged.
 */
function completePairs(series, completeThrough) {
  let rows = series.rows;
  const gaps = [];
  const last = rows[rows.length - 1];
  if (last && (!completeThrough || bucketEnd(series.bucket, last.key.date.start) > completeThrough)) {
    gaps.push(`${bucketName(last.key.date)} may be incomplete${completeThrough ? ` (data up to ${completeThrough})` : ""}, so it is not compared.`);
    rows = rows.slice(0, -1);
  }
  const pairs = [];
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1], b = rows[i];
    if (STEP_OF[series.bucket](a.key.date.start) === b.key.date.start) pairs.push({ a, b });
    else gaps.push(`The results have no row for the ${series.bucket} before ${bucketName(b.key.date)}, so its change is not calculated.`);
  }
  return { pairs, gaps };
}

function seriesFindings(step, n, ctx, out) {
  const plan = step.request;
  const m = valueMetric(plan) || (plan.metrics || [])[0];
  if (!m) return;
  const scope = productScope(plan);
  const noun = ENTITY_NOUN[plan.entity] || plan.entity;
  const changes = [];
  for (const s of seriesGroups(step)) {
    const ch = completePairs(s, ctx.completeThrough(step));
    for (const g of ch.gaps) out.gaps.push({ text: g, steps: [n] });
    if (!ch.pairs.length) continue;
    const { a, b } = ch.pairs[ch.pairs.length - 1];
    changes.push({ s, pairs: ch.pairs, a, b, delta: round2(b.values[m] - a.values[m]) });
  }
  changes.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  for (const { s, pairs, a, b, delta } of changes.slice(0, MAX_SERIES)) {
    const product = scope || (s.dim === "product" ? s.group : null);
    const who = s.dim && s.dim !== "product" ? ` ${s.dim === "supplier" ? "from" : s.dim === "customer" ? "to" : "—"} ${s.group}` : "";
    const subject = `${scopeText(plan, noun, product)}${who} (${metricLabel(m)})`;
    const v0 = a.values[m], v1 = b.values[m];
    let text;
    if (pairs.length === 1) {
      const move = delta === 0 ? `did not change: ${fmtValue(m, v1)} in both ${bucketName(a.key.date)} and ${bucketName(b.key.date)}` : `${delta < 0 ? "fell" : "rose"} from ${fmtValue(m, v0)} in ${bucketName(a.key.date)} to ${fmtValue(m, v1)} in ${bucketName(b.key.date)}: ${signed(m, delta)}${v0 ? ` (${delta > 0 ? "+" : ""}${pct(delta, v0)})` : ""}`;
      text = `${subject} ${move}.`;
    } else {
      // each bucket against the one before it, oldest first (the most recent MAX_PAIRS)
      const shown = pairs.slice(-MAX_PAIRS).map(({ a: p, b: c }) => {
        const d = round2(c.values[m] - p.values[m]);
        return `${bucketName(c.key.date)} ${fmtValue(m, c.values[m])} vs ${bucketName(p.key.date)} ${fmtValue(m, p.values[m])}: ${signed(m, d)}${p.values[m] ? ` (${d > 0 ? "+" : ""}${pct(d, p.values[m])})` : ""}`;
      });
      const earlier = pairs.length - shown.length;
      text = `${subject}, each ${s.bucket} vs the previous ${s.bucket}: ${shown.join("; ")}${earlier ? ` (${earlier} earlier pairs not listed)` : ""}.`;
    }
    out.findings.push({ label: "measured", text, steps: [n] });
    out.changes.push({ entity: plan.entity, scope: product, metric: m, delta, prevStart: a.key.date.start, start: b.key.date.start, end: bucketEnd(s.bucket, b.key.date.start), label: bucketName(b.key.date), steps: [n] });
    decompose(plan, m, a, b, product, n, out);
  }
}

// ---------------------------------------------------------------- rule 2: quantity effect vs rate effect (one product only)

function decompose(plan, m, a, b, product, n, out) {
  const q = QUANTITY_OF[m];
  if (!q || !(plan.metrics || []).includes(q)) return;
  if (!product) {
    out.gaps.push({ text: `Quantity and rate effects are not separated: the quantity adds several products (no unit of measure is stored).`, steps: [n] });
    return;
  }
  const q0 = a.values[q], q1 = b.values[q], v0 = a.values[m], v1 = b.values[m];
  if (!(q0 > 0) || !(q1 > 0)) {
    out.gaps.push({ text: `The rate change of ${product} cannot be separated: no quantity in ${bucketName((q0 > 0 ? b : a).key.date)}.`, steps: [n] });
    return;
  }
  const r0 = round2(v0 / q0), r1 = round2(v1 / q1), dq = q1 - q0;
  const verb = QTY_VERB[plan.entity] || "";
  const qtyText = dq === 0 ? `Quantity ${verb} unchanged at ${fmtNumber(q1)}` : `Quantity ${verb} ${dq < 0 ? "fell" : "rose"} from ${fmtNumber(q0)} to ${fmtNumber(q1)} (${dq > 0 ? "+" : ""}${fmtNumber(dq)})`;
  const rateText = r1 === r0 ? `Average rate unchanged at ${fmtMoney(r1)}` : `Average rate ${r1 < r0 ? "fell" : "rose"} from ${fmtMoney(r0)} to ${fmtMoney(r1)}`;
  out.findings.push({ label: "measured", text: `${qtyText}. ${rateText}. The rate is ${CATALOG.metrics[m].label} ÷ stored quantity: free quantity is included and no unit of measure is stored.`, steps: [n] });
  // Exact split: quantity effect at the earlier rate, rate effect on the later quantity; the second takes the rounding remainder.
  const delta = round2(v1 - v0);
  const volume = round2(dq * (v0 / q0));
  const rate = round2(delta - volume);
  out.findings.push({ label: "contributor", text: `Of the ${signed(m, delta)} change of ${product}, the quantity change accounts for ${signed(m, volume)} and the rate change for ${signed(m, rate)} (quantity change × earlier rate; rate change × later quantity; together exactly the change).`, steps: [n], values: { delta, volume, rate } });
}

// ---------------------------------------------------------------- rule 3: contributors to a compared change, and inactive parties

const ORDER_TEXT = { "-1": "largest fall first", 1: "largest increase first" };
const MATERIAL_SHARE = 0.3; // one product carrying this share of a ranked sales fall is examined for purchase evidence (rule 5)
// Next steps (shown only when the question asks what to do) come only from evidence that points at something specific (rule 5:
// purchase evidence for a product's fall) - never from a contributor's size alone. Each says which finding it follows from: its
// `because` holds that finding's own figures, `weight` the amount it concerns (ordering only; never a projected impact), and
// `kind` how far the evidence goes - "action" (an established, specific problem to fix), "verify" (evidence to gather before
// deciding anything). When asking what to do, the investigation may first measure what would change the decision (its
// `decide` open point); without such evidence, `noAction` says what remains unknown.
const rec = (kind, text, because, steps, weight, fact = null) => ({ kind, text, because, steps, weight: Math.abs(weight) || 0, ...(fact ? { fact } : {}) });

function comparisonFindings(step, n, ctx, out) {
  const plan = step.request, res = step.result;
  const groups = plan.groupBy || [];
  if (!res.comparison || groups.length > 1 || (groups[0] && groups[0].dim === "date")) return;
  const dim = groups.length ? groups[0].dim : null; // no dimension: a compared total, measured only
  const sortBase = plan.sort && plan.sort[0] && /\.(delta|deltaPct)$/.test(plan.sort[0].by) ? plan.sort[0].by.split(".")[0] : null;
  const m = sortBase && plan.metrics.includes(sortBase) ? sortBase : valueMetric(plan) || plan.metrics[0];
  const rows = (res.rows || []).filter((r) => r.comparison && r.comparison[m] && typeof r.comparison[m].delta === "number");
  const tc = res.totals && res.totals.comparison && res.totals.comparison[m];
  const listedSum = round2(rows.reduce((s, r) => s + r.comparison[m].delta, 0));
  // without a total, the listed rows are the whole change only if none were cut (limit) or filtered out (having)
  const total = tc && typeof tc.delta === "number" ? round2(tc.delta) : res.truncated || (plan.having || []).length ? null : listedSum;
  const scope = productScope(plan);
  const noun = ENTITY_NOUN[plan.entity] || plan.entity;
  const now = periodName(dayOf(res.period && res.period.from), dayOf(res.period && res.period.to));
  const before = periodName(dayOf(res.comparison.from), dayOf(res.comparison.to));
  const nowDays = [dayOf(res.period && res.period.from), dayOf(res.period && res.period.to)], beforeDays = [dayOf(res.comparison.from), dayOf(res.comparison.to)];
  const subject = `${scopeText(plan, noun, scope)} (${metricLabel(m)})`;
  // the period runs past the latest data: its figures are partial, never a full-period change
  const end = dayOf(res.period && res.period.to);
  const incomplete = !!(ctx.dataDay && end && end > ctx.dataDay);
  if (incomplete) out.gaps.push({ text: `${now} has data only up to ${ctx.dataDay}, so its change is not a full-period change.`, steps: [n] });

  let stated = false; // the change itself is already in the findings
  if (tc && typeof tc.previous === "number" && res.totals.values && typeof res.totals.values[m] === "number") {
    const v1 = res.totals.values[m];
    const start = dayOf(res.period.from);
    stated = out.changes.some((c) => !c.contributor && c.entity === plan.entity && sameName(c.scope || "", scope || "") && c.metric === m && c.start === start && c.delta === total);
    if (!stated) {
      const text = `${subject}: ${fmtValue(m, tc.previous)} in ${before}, ${fmtValue(m, v1)} in ${now}${incomplete ? ` (incomplete: data only up to ${ctx.dataDay})` : ""}, a change of ${signed(m, total)}${tc.previous ? ` (${total > 0 ? "+" : ""}${pct(total, tc.previous)})` : ""}.`;
      out.findings.push({ label: "measured", text, steps: [n] });
      stated = true;
      // a candidate for the overall result (see overallOf): the engine's own total of this step's scope and value metric
      if (isMoney(m)) out.totals.push({ n, entity: plan.entity, subject, filtered: (plan.filters || []).length > 0, grouped: !!dim, metric: m, previous: tc.previous, current: v1, delta: total, before, now, incomplete, dataDay: ctx.dataDay, text, filters: plan.filters || [], nowDays, beforeDays });
    }
    out.changes.push({ entity: plan.entity, scope, metric: m, delta: total, prevStart: dayOf(res.comparison.from), start, end, label: now, steps: [n], incomplete });
  }
  if (!dim) return;
  // which way this breakdown looks: ordered by its change (largest fall / rise first), or filtered to one direction by a
  // having on that change - the plan's own reading of the question, compared with the measured total in overallOf
  const s0 = plan.sort && plan.sort[0];
  const deltaHaving = (plan.having || []).find((h) => h.metric === `${m}.delta` && (h.op === "lt" || h.op === "lte" || h.op === "gt" || h.op === "gte") && h.value === 0);
  const looks = s0 && s0.by === `${m}.delta` ? (s0.dir === "asc" ? -1 : 1) : deltaHaving ? (/^lt/.test(deltaHaving.op) ? -1 : 1) : 0;
  if (looks) out.looks.push({ n, entity: plan.entity, dim, before, now, looks });
  if (total === null) {
    out.gaps.push({ text: `Only the ${rows.length} ${dimPlural(dim)} shown are known; the change of the others is not, so no shares are given.`, steps: [n] });
  } else if (total === 0) {
    if (!stated) out.findings.push({ label: "measured", text: `${subject}: no net change between ${before} and ${now}.`, steps: [n] });
  } else {
    const dir = Math.sign(total);
    const toward = rows.filter((r) => Math.sign(r.comparison[m].delta) === dir).sort((a, b) => Math.abs(b.comparison[m].delta) - Math.abs(a.comparison[m].delta));
    const against = rows.filter((r) => Math.sign(r.comparison[m].delta) === -dir);
    const named = toward.slice(0, MAX_CONTRIBUTORS);
    const parts = named.map((r) => `${r.key[dim]} ${signed(m, r.comparison[m].delta)} (${pct(r.comparison[m].delta, total)})`);
    const namedSum = round2(named.reduce((s, r) => s + r.comparison[m].delta, 0));
    const otherListed = round2(listedSum - namedSum);
    const notListed = round2(total - listedSum);
    const tail = [
      otherListed !== 0 ? `other listed ${dimPlural(dim)} ${signed(m, otherListed)}${against.length ? ` (including ${against.slice(0, 3).map((r) => `${r.key[dim]} ${signed(m, r.comparison[m].delta)}`).join(", ")} in the other direction)` : ""}` : null,
      notListed !== 0 ? `${dimPlural(dim)} not listed ${signed(m, notListed)} (${pct(notListed, total)} of the change)` : null,
    ].filter(Boolean);
    // "Largest" only when the rows can show it: the whole list, or a list ordered by this change in its own direction
    const order = s0 && s0.by === `${m}.delta` ? (s0.dir === "asc" ? -1 : 1) : 0;
    const complete = !res.truncated && !(plan.having || []).length;
    const ranked = complete || order === dir;
    const opposite = !complete && order === -dir;
    // every breakdown names its own change: metric basis, periods, list size and order (several steps can break down changes)
    const shown = res.truncated ? `first ${rows.length} shown, more exist` : `${rows.length} shown${(plan.having || []).length ? " after the step's filter" : ""}`;
    const orderText = order ? `ordered ${ORDER_TEXT[order]}` : s0 ? `ordered by ${s0.by} ${s0.dir}` : "not ranked";
    const change = `the ${signed(m, total)} change in ${scopeText(plan, noun, scope)} (${metricLabel(m)}), ${before} to ${now}`;
    const per = dimPlural(dim).replace(/s$/, "");
    const values = { total, named: namedSum, otherListed, notListed };
    // need: what would let this step answer its change (read by the investigation loop; never shown)
    const meta = { key: comparisonKey(plan, res, dim, m), ranked: ranked && parts.length > 0, opposite, need: opposite ? { kind: "rank_toward_change", step: n, metric: m, dir } : null };
    if (opposite) {
      // ordered against the change: its top rows are the largest moves the OTHER way, so it names no contributor
      out.findings.push({ label: "contributor", text: `This list of ${dimPlural(dim)} (${shown}) is ${orderText}, the opposite direction to ${change}: this list cannot show what drove it; listed ${dimPlural(dim)} together ${signed(m, listedSum)}; ${dimPlural(dim)} not listed ${signed(m, notListed)} (${pct(notListed, total)} of the change). These add up to ${signed(m, total)}.`, steps: [n], values: { total, named: 0, otherListed: listedSum, notListed }, meta });
    } else if (parts.length && ranked) {
      out.facts.push({ type: "contributors", step: n, entity: plan.entity, dim, metric: m, filters: plan.filters || [], dir, total, nowDays, beforeDays, rows: named.slice(0, 3).map((r) => ({ name: r.key[dim], previous: r.comparison[m].previous, current: r.values[m], delta: r.comparison[m].delta })) });
      out.findings.push({ label: "contributor", text: `Largest contributors to ${change}, by ${per} (${shown}, ${orderText}; share of the net change): ${parts.join("; ")}${tail.length ? `; ${tail.join("; ")}` : ""}. These add up to ${signed(m, total)}.`, steps: [n], values, meta });
      // a fall concentrated in one contributor: a targeted review of it (what the data shows, not why)
      const top = named[0], share = top.comparison[m].delta / total;
      // the largest contributor of the first complete fall: named when no step can be supported ("where the fall is, not why")
      if (total < 0 && !incomplete && !out.fallLeader) out.fallLeader = { name: top.key[dim], delta: top.comparison[m].delta, metric: m, dim, entity: plan.entity };
      // A complete sales fall the step itself ranked by that fall (largest fall first), carried for MATERIAL_SHARE or more by one
      // product: that product's own fall is examined for purchase evidence (rule 5) exactly like a step filtered to it - one
      // product per step, so a broad question ("why did sales fall?") reaches supply evidence without a query per product.
      if (dim === "product" && plan.entity === "sales" && total < 0 && order === dir && share >= MATERIAL_SHARE && !incomplete) {
        out.changes.push({ entity: "sales", scope: String(top.key[dim]), metric: m, delta: round2(top.comparison[m].delta), prevStart: dayOf(res.comparison.from), start: dayOf(res.period.from), end, label: now, steps: [n], incomplete: false, contributor: true });
      }
    } else if (parts.length) {
      out.findings.push({ label: "contributor", text: `Among the listed ${dimPlural(dim)} (${shown}, ${orderText}), these moved with ${change} (share of the net change): ${parts.join("; ")}${tail.length ? `; ${tail.join("; ")}` : ""}. These add up to ${signed(m, total)}. Larger contributors may be among the ${dimPlural(dim)} not listed.`, steps: [n], values, meta });
    } else {
      out.findings.push({ label: "contributor", text: `None of the ${rows.length} listed ${dimPlural(dim)} (${shown}, ${orderText}) moved with ${change}; ${tail.join("; ")}. These add up to ${signed(m, total)}.`, steps: [n], values, meta });
    }
  }
  // inactive: present before, nothing in the period (measured absence; it does not say why); a name already stated for the
  // same change by an earlier step is not repeated
  const key = comparisonKey(plan, res, dim, m);
  const seen = out.inactive.get(key) || new Set();
  out.inactive.set(key, seen);
  const inactive = rows.filter((r) => r.values[m] === 0 && r.comparison[m].previous > 0 && !seen.has(r.key[dim]));
  inactive.forEach((r) => seen.add(r.key[dim]));
  if (inactive.length) {
    const names = inactive.slice(0, MAX_INACTIVE).map((r) => `${r.key[dim]} (${fmtValue(m, r.comparison[m].previous)} in ${before})`);
    const more = inactive.length > MAX_INACTIVE ? ` and ${inactive.length - MAX_INACTIVE} more` : "";
    out.findings.push({ label: "measured", text: `${scopeText(plan, noun, scope)}: none recorded in ${now} for ${names.join(", ")}${more}. The data shows the absence, not its reason.`, steps: [n] });
    out.facts.push({ type: "absent", step: n, entity: plan.entity, dim, metric: m, nowDays, beforeDays, rows: inactive.slice(0, 3).map((r) => ({ name: r.key[dim], previous: r.comparison[m].previous })), more: Math.max(0, inactive.length - 3) });
  }
}

/** Two comparison steps measure the SAME change when entity, dimension, metric, both periods and every filter agree. */
function comparisonKey(plan, res, dim, m) {
  return JSON.stringify([plan.entity, dim, m, dayOf(res.period && res.period.from), dayOf(res.period && res.period.to), dayOf(res.comparison.from), dayOf(res.comparison.to), JSON.stringify(plan.filters || [])]);
}

/** A list ordered against a change adds nothing next to another step that ranks the same change in its own direction. */
function dropRedundantBreakdowns(findings) {
  const rankedKeys = new Set(findings.filter((f) => f.meta && f.meta.ranked).map((f) => f.meta.key));
  const kept = findings.filter((f) => !(f.meta && f.meta.opposite && rankedKeys.has(f.meta.key)));
  // a breakdown that still cannot answer its change (no other step ranks it) is an open need
  const needs = kept.filter((f) => f.meta && f.meta.need).map((f) => f.meta.need);
  return { findings: kept.map(({ meta, ...f }) => f), needs };
}

// ---------------------------------------------------------------- rule 4: sales minus purchases (two totals, same period and basis)

function salesMinusPurchases(steps, out) {
  const totalOf = (entity) => steps.find(({ s }) => s.kind === "query" && s.request.entity === entity && !(s.request.groupBy || []).length && !s.result.comparison && valueMetric(s.request));
  const sale = totalOf("sales"), buy = totalOf("purchase");
  if (!sale || !buy) return;
  if (isZero(sale.s.request, sale.s.result) || isZero(buy.s.request, buy.s.result)) {
    out.gaps.push({ text: "Sales or purchases have no records for the period, so no difference is calculated.", steps: [sale.n, buy.n] });
    return;
  }
  const ms = valueMetric(sale.s.request), mp = valueMetric(buy.s.request);
  const basis = CATALOG.metrics[ms].amountBasis;
  const p1 = sale.s.result.period || {}, p2 = buy.s.result.period || {};
  if (basis !== CATALOG.metrics[mp].amountBasis || dayOf(p1.from) !== dayOf(p2.from) || dayOf(p1.to) !== dayOf(p2.to)) {
    out.gaps.push({ text: "Sales and purchases are not on the same period and amount basis, so they are not subtracted.", steps: [sale.n, buy.n] });
    return;
  }
  const vs = sale.s.result.totals.values[ms], vp = buy.s.result.totals.values[mp];
  const diff = round2(vs - vp);
  out.findings.push({ label: "measured", text: `Sales minus purchases, ${periodName(dayOf(p1.from), dayOf(p1.to))} (both ${BASIS_TEXT[basis] || basis}): ${fmtMoney(vs)} − ${fmtMoney(vp)} = ${diff < 0 ? "-" : ""}${fmtMoney(Math.abs(diff))}.`, steps: [sale.n, buy.n], values: { diff } });
  out.gaps.push({ text: "This difference is not profit: profit needs the cost of the goods sold and stock valuation, which are not available.", steps: [sale.n, buy.n] });
}

// ---------------------------------------------------------------- rule 5: a purchase fall of the same product just before a sales fall

// The first hypothesis family of an investigation: did purchases of a product fall with its sales? For every COMPLETE sales
// fall of ONE product (a step filtered to it, or the dominant product of a product breakdown ranked by its fall - see
// comparisonFindings; a multi-product fall never qualifies), over the window from the month before its comparison period
// to its end:
//   fresh purchase evidence that fell >= MATERIAL_FALL_PCT  -> a hedged possible cause (purchases are not stock on hand)
//   fresh purchase evidence without such a fall             -> a measured "no purchase fall"; no supply claim
//   stale purchase data, or a purchase query that ran but gave no usable months -> "could not be established" (a gap)
//   no purchase query yet                                    -> a `purchases_for_fall` need (the investigation fetches it)
// Only complete buckets count (an incomplete latest month is never read as a fall).
function purchaseSeries(steps, ctx) {
  const out = [];
  for (const { s, n } of steps) {
    if (s.kind === "query" && s.request.entity === "purchase") {
      const m = valueMetric(s.request) || s.request.metrics[0];
      const scope = productScope(s.request);
      const through = ctx.completeThrough(s);
      for (const g of seriesGroups(s)) out.push({ n, metric: m, dataState: s.dataState || null, product: scope || (g.dim === "product" ? g.group : null), who: g.dim === "supplier" ? g.group : null, bucket: g.bucket, points: g.rows.filter((r) => through && bucketEnd(g.bucket, r.key.date.start) <= through).map((r) => ({ start: r.key.date.start, key: r.key.date, v: r.values[m] })) });
    } else if (s.kind === "insight" && s.tool === "product_trend" && s.result.data) {
      const rows = (s.result.data.rows || []).filter((r) => typeof r.month === "string");
      const dataDay = ctx.dataDay;
      out.push({ n, metric: "quantity", dataState: s.dataState || null, product: s.result.productMatch && s.result.productMatch.resolved, who: null, bucket: "month", points: rows.filter((r) => !dataDay || bucketEnd("month", `${r.month}-01`) <= dataDay).map((r) => ({ start: `${r.month}-01`, key: { bucket: "month", start: `${r.month}-01` }, v: r.purchaseQty })) });
    }
  }
  return out;
}

/** Adjacent month pairs of a purchase series whose later month lies in [from, to]. */
const pairsIn = (p, from, to) => p.points.slice(1).map((b, i) => ({ a: p.points[i], b })).filter(({ a, b }) => STEP_OF[p.bucket](a.start) === b.start && b.start >= from && b.start <= to);
const STALE = new Set(["stale", "sync_failed"]);

function possibleCauses(steps, allSteps, ctx, out) {
  const seenProduct = new Set();
  const falls = out.changes.filter((c) => c.entity === "sales" && c.scope && c.delta < 0 && !c.incomplete && !seenProduct.has(c.scope.toLowerCase()) && seenProduct.add(c.scope.toLowerCase()));
  if (!falls.length) return;
  const series = purchaseSeries(steps, ctx);
  for (const fall of falls) {
    const from = addMonths(`${fall.prevStart.slice(0, 7)}-01`, -1), to = fall.end;
    const window = `${bucketName({ bucket: "month", start: from })} to ${periodName(`${to.slice(0, 8)}01`, to)}`;
    const mine = series.filter((p) => sameName(fall.scope, p.product));
    const usable = mine.filter((p) => pairsIn(p, from, to).length);
    const fresh = usable.filter((p) => !STALE.has(p.dataState));
    if (usable.length && !fresh.length) {
      out.gaps.push({ text: `Purchase data for ${fall.scope} may be out of date (its last sync did not succeed), so whether purchases fell with its sales could not be established.`, steps: [...new Set(usable.map((p) => p.n))] });
      out.facts.push({ type: "supply_stale", product: fall.scope });
      out.recs.push(rec("action", `Re-check purchases of ${fall.scope} for ${window} once the purchase sync succeeds.`, `the purchase data may be out of date (its last sync did not succeed), while sales of ${fall.scope} fell ${signed(fall.metric, fall.delta)} in ${fall.label}`, [...new Set(usable.map((p) => p.n))], fall.delta, { type: "resync", product: fall.scope }));
      continue;
    }
    if (fresh.length) {
      let found = false;
      for (const p of fresh) {
        const hits = pairsIn(p, from, to).filter(({ a, b }) => a.v > 0 && ((a.v - b.v) / a.v) * 100 >= MATERIAL_FALL_PCT);
        if (!hits.length) continue;
        const { a, b } = hits[hits.length - 1];
        const fmt = (v) => fmtValue(p.metric, v);
        const who = p.who ? ` from ${p.who}` : "";
        const steps = [...new Set([...fall.steps, p.n])];
        out.findings.push({
          label: "possible_cause",
          text: `Purchases of ${fall.scope}${who} fell from ${fmt(a.v)} in ${bucketName(a.key)} to ${fmt(b.v)} in ${bucketName(b.key)}, ${b.start <= fall.prevStart ? "before" : "around the time"} the sales fall in ${fall.label}. This may have limited what could be sold; purchases are not stock on hand (stock is not recorded), so this is not confirmed.`,
          steps,
        });
        const because = `purchases ${fmt(a.v)} in ${bucketName(a.key)} -> ${fmt(b.v)} in ${bucketName(b.key)}; sales of ${fall.scope} ${signed(fall.metric, fall.delta)} in ${fall.label}`;
        out.facts.push({ type: "supply_fell", product: fall.scope, who: p.who || null, metric: p.metric, from: { start: a.start, value: a.v }, to: { start: b.start, value: b.v }, fallDays: [fall.start, fall.end] });
        out.recs.push(rec("verify", `Check supplier orders and the availability of ${fall.scope}${who}: its purchases fell before or with its sales (the data shows purchases, not stock levels).`, because, steps, fall.delta, { type: "supply_check", product: fall.scope, who: p.who || null, days: [fall.start, fall.end] }));
        found = true;
      }
      if (!found) {
        const steps = [...new Set([...fall.steps, ...fresh.map((p) => p.n)])];
        out.findings.push({ label: "measured", text: `Purchases of ${fall.scope} show no fall of ${MATERIAL_FALL_PCT}% or more from ${window}, the window of its sales fall in ${fall.label}.`, steps });
        out.facts.push({ type: "supply_steady", product: fall.scope });
        out.recs.push(rec("verify", `Purchases of ${fall.scope} did not fall, so review its customer orders and selling rates next.`, `no purchase fall of ${MATERIAL_FALL_PCT}% or more from ${window}; sales of ${fall.scope} ${signed(fall.metric, fall.delta)} in ${fall.label}`, steps, fall.delta, { type: "review_orders", product: fall.scope }));
      }
      continue;
    }
    // no usable purchase months: a purchase query of this product already ran (empty, failed, refused, incomplete) -> a stated
    // limitation; none ran yet -> a need, which the investigation can settle with one validated query
    const tried = allSteps.find((s) => s.kind === "query" && s.request && s.request.entity === "purchase" && sameName(productScope(s.request), fall.scope));
    if (tried) {
      const why = tried.status !== "ok" ? `the purchase query did not run (${(tried.error && tried.error.message) || tried.message || tried.status})` : "the purchase query returned no complete months of purchases in that window";
      out.gaps.push({ text: `Whether purchases of ${fall.scope} fell with its sales could not be established: ${why}.`, steps: [...fall.steps] });
      out.facts.push({ type: "supply_unknown", product: fall.scope });
      out.recs.push(rec("verify", `Check the purchase records of ${fall.scope} for ${window} to see whether supply changed.`, `${why}; sales of ${fall.scope} ${signed(fall.metric, fall.delta)} in ${fall.label}`, [...fall.steps], fall.delta, { type: "purchase_records", product: fall.scope }));
    } else {
      out.needs.push({ kind: "purchases_for_fall", step: fall.steps[0], product: fall.scope, from, to, metric: fall.metric });
    }
  }
}

/**
 * @param {{steps: object[]}} execution the result of executeAnalysisPlan
 * @param {{referenceDate?: Date, dataThrough?: Date|string|null}} [options] the turn's reporting reference date, and the
 *        calendar day of the latest voucher (dc.latestVoucher; a "YYYY-MM-DD" string is accepted): a date bucket or period
 *        ending after either is incomplete. Either may be absent; an unusable value is ignored.
 * @returns {{findings: {label: string, text: string, steps: number[]}[], gaps: {text: string, steps: number[]}[],
 *            needs: object[], recommendations: {text: string, steps: number[]}[]}} needs: what further evidence would settle
 *            an open question - rank_toward_change {step, metric, dir}: the step's list is cut and ordered against its change;
 *            purchases_for_fall {step, product, from, to, metric}: a single product's complete sales fall has no purchase
 *            evidence for its window yet. recommendations: next actions, each tied to the findings/steps it follows from
 */
// ---------------------------------------------------------------- rule: concentration of a ranked breakdown (no comparison)
// A ranking by one party/product dimension, highest first, with the engine's own overall total of the same value metric: when
// the top CONCENTRATION_TOP groups hold at least CONCENTRATION_SHARE of that total AND clearly more than an even split would give
// them (CONCENTRATION_LIFT above it: 3 of 6 holding 60% is near even, 3 of 20 holding 60% is not), say so (a measured share,
// never a reason). With rows cut at the limit the even split is taken at its largest (one more group than listed).
// Not stated when the share cannot be trusted: no positive total, rows not ordered by the metric, a negative row, a having
// filter (rows and total would differ in scope), or a complete list whose rows do not add up to the total.
const CONCENTRATION_TOP = 3;
const CONCENTRATION_SHARE = 0.5;
const CONCENTRATION_LIFT = 0.25;
const CONCENTRATION_DIMS = new Set(["customer", "supplier", "product", "productGroup"]);
function concentrationFindings(s, n, out) {
  const plan = s.request, result = s.result;
  const g = plan.groupBy || [];
  if (plan.mode !== "aggregate" || g.length !== 1 || !CONCENTRATION_DIMS.has(g[0].dim) || plan.compare || result.comparison || (plan.having || []).length) return;
  const m = valueMetric(plan);
  const def = m && CATALOG.metrics[m];
  if (!def || !def.aggregation || def.aggregation.op !== "sum") return;
  const total = result.totals && result.totals.values ? result.totals.values[m] : undefined;
  const rows = result.rows || [];
  const values = rows.map((r) => (r.values ? r.values[m] : undefined));
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return;
  if (rows.length <= CONCENTRATION_TOP && !result.truncated) return; // nothing outside the top group
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) return;
  if (values.some((v, i) => i > 0 && v > values[i - 1])) return; // not ranked by this metric
  const listed = values.reduce((t, v) => t + v, 0);
  if (!result.truncated && Math.abs(listed - total) > 0.01 * Math.max(1, rows.length)) return;
  const top = round2(values.slice(0, CONCENTRATION_TOP).reduce((t, v) => t + v, 0));
  const even = CONCENTRATION_TOP / (rows.length + (result.truncated ? 1 : 0));
  if (top / total < CONCENTRATION_SHARE || top / total - even < CONCENTRATION_LIFT) return;
  const dim = g[0].dim;
  const count = result.truncated ? `more than ${rows.length}` : String(rows.length);
  const period = periodName(dayOf(result.period && result.period.from), dayOf(result.period && result.period.to));
  const basis = BASIS_TEXT[(result.amountBasis || {})[m]];
  const largest = rows[0].key[dim];
  out.findings.push({
    label: "measured",
    text: `${scopeText(plan, ENTITY_NOUN[plan.entity] || plan.entity, productScope(plan))} in ${period} are concentrated: the top ${CONCENTRATION_TOP} of ${count} ${dimPlural(dim)} account for ${pct(top, total)} (${fmtValue(m, top)} of ${fmtValue(m, total)}${basis ? `, ${basis}` : ""}); the largest, ${largest}, ${pct(values[0], total)}.`,
    steps: [n],
    values: { top, total, topShare: round2((top / total) * 100), largestShare: round2((values[0] / total) * 100) },
    meta: { kind: "concentration", dim, metric: m },
  });
}

// ---------------------------------------------------------------- the overall result, which governs how the rest is read
// The measured total of the comparison - a company-wide total first (no filter, no grouping), else an unfiltered breakdown's
// own total, else a scoped one - stated with its direction in words. When the plan's own breakdowns of that comparison look the other way
// (ranked by, or filtered to, falls while the total rose - or rises while it fell), the answer says so: those rows are
// individual moves within an overall result in the other direction, and the comparison does not show the opposite.
// Steps compare periods but none measured a total: the overall direction is stated as not established.
const DIRECTION_WORD = { 1: "rose", "-1": "fell", 0: "did not change" };
function overallOf(out, comparedSteps, comparedEntity = null) {
  // the widest total measured: company-wide, else an unfiltered breakdown's, else the scoped total (its subject names the scope)
  const pick = out.totals.find((t) => !t.filtered && !t.grouped) || out.totals.find((t) => !t.filtered) || out.totals[0] || null;
  if (!pick) {
    return comparedSteps.length ? { unavailable: true, entity: comparedEntity, text: "The overall change between the periods was not measured, so whether the total rose or fell is not established; the rows below are individual changes only.", steps: comparedSteps } : null;
  }
  const dir = Math.sign(pick.delta);
  const pctText = pick.previous ? ` (${pick.delta > 0 ? "+" : ""}${pct(pick.delta, pick.previous)})` : "";
  const text = `${pick.subject} ${DIRECTION_WORD[dir]} from ${fmtValue(pick.metric, pick.previous)} in ${pick.before} to ${fmtValue(pick.metric, pick.current)} in ${pick.now}${pick.incomplete ? ` (incomplete: data only up to ${pick.dataDay})` : ""}: ${signed(pick.metric, pick.delta)}${pctText}.`;
  // the plan's breakdowns of the same entity and periods that look in the other direction
  const against = dir ? out.looks.filter((l) => l.entity === pick.entity && l.before === pick.before && l.now === pick.now && l.looks === -dir) : [];
  const dims = [...new Set(against.map((l) => dimPlural(l.dim)))].join(" and ");
  const note = against.length
    ? `This comparison does not show an overall ${dir > 0 ? "decline" : "increase"}: the total ${DIRECTION_WORD[dir]}. The ${dims} below that ${dir > 0 ? "fell" : "rose"} are individual changes within that overall ${dir > 0 ? "increase" : "decrease"}${pick.incomplete ? " (so far)" : ""}.`
    : null;
  const data = { entity: pick.entity, filters: pick.filters, metric: pick.metric, previous: pick.previous, current: pick.current, delta: pick.delta, nowDays: pick.nowDays, beforeDays: pick.beforeDays, incomplete: pick.incomplete, dataDay: pick.dataDay };
  return { direction: dir, text, note, steps: [pick.n], sourceText: pick.text, incomplete: pick.incomplete, data, mismatchDims: against.length ? [...new Set(against.map((l) => l.dim))] : [] };
}

function buildEvidence(execution, { referenceDate = null, dataThrough = null } = {}) {
  // a step that returned no records gives no finding (a measured zero against a non-zero period still does: isZero)
  const steps = ((execution && execution.steps) || []).map((s, i) => ({ s, n: i + 1 })).filter(({ s }) => s.status === "ok" && s.result);
  const derivable = steps.filter(({ s }) => s.kind !== "query" || (s.request && !isZero(s.request, s.result)));
  const refDay = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime()) ? localDay(referenceDate) : null;
  const ctx = {
    dataDay: dataDayOf(dataThrough),
    // a bucket is complete when it ends on or before the step's period end (or, for all time, the reference date) and the latest data
    completeThrough(step) {
      const bound = dayOf(step.result.period && step.result.period.to) || refDay;
      return bound && this.dataDay ? (this.dataDay < bound ? this.dataDay : bound) : bound || this.dataDay;
    },
  };
  const out = { findings: [], gaps: [], changes: [], inactive: new Map(), needs: [], recs: [], totals: [], looks: [], facts: [] };
  for (const { s, n } of derivable) {
    if (s.kind !== "query" || !s.request || !s.result) continue;
    seriesFindings(s, n, ctx, out);
    comparisonFindings(s, n, ctx, out);
    concentrationFindings(s, n, out);
  }
  salesMinusPurchases(steps, out);
  possibleCauses(derivable, (execution && execution.steps) || [], ctx, out);
  const seen = new Set();
  const gaps = out.gaps.filter((g) => (seen.has(g.text) ? false : seen.add(g.text)));
  const { findings, needs } = dropRedundantBreakdowns(out.findings);
  const falls = out.changes.filter((c) => c.delta < 0 && !c.contributor && !c.incomplete);
  const seenRec = new Set();
  const KIND_ORDER = { action: 0, verify: 1 };
  // largest amount concerned first
  const recommendations = out.recs.filter((r) => (seenRec.has(r.text) ? false : seenRec.add(r.text)))
    .sort((a, b) => (b.weight || 0) - (a.weight || 0) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  // asked what to do with nothing specific to act on: what is known and what is not (never a generic line or a filler step)
  const leader = out.fallLeader;
  const noAction = recommendations.length ? null
    : !out.changes.length ? "no change between two periods was measured, so there is nothing yet to act on; ask for this period against an earlier one"
    : !falls.length ? (out.changes.some((c) => c.delta < 0 && c.incomplete) && gaps.length ? `the fall is not complete yet: ${gaps[0].text.replace(/\.$/, "")}` : "the measured change is not a fall")
    : gaps.length ? `first settle what is not established: ${gaps[0].text.replace(/\.$/, "")}`
    : `the results show where the fall is${leader ? ` (largest: ${leader.name}, ${signed(leader.metric, leader.delta)})` : ""} but not why, and nothing in them points to a specific step yet`;
  // the same reason as a code (for the plain-language summary), in the same order as the text above
  const noActionCode = recommendations.length ? null
    : !out.changes.length ? "no_comparison"
    : !falls.length ? (out.changes.some((c) => c.delta < 0 && c.incomplete) && gaps.length ? "incomplete" : "not_fall")
    : gaps.length ? "gap"
    : "unknown_why";
  const compared = steps.filter(({ s }) => s.kind === "query" && s.result && s.result.comparison);
  const entities = [...new Set(compared.map(({ s }) => s.request.entity))];
  // the entity every compared step measured (sales or purchases), or null when they differ - for the plain-language wording
  const overall = overallOf(out, compared.map(({ n }) => n), entities.length === 1 ? entities[0] : null);
  return { findings, gaps, needs: [...needs, ...out.needs], recommendations, noAction, noActionCode, fallLeader: leader || null, overall, facts: out.facts };
}

module.exports = { buildEvidence, dayOf, dataDayOf, round2, MAX_SERIES, MAX_CONTRIBUTORS, MATERIAL_FALL_PCT, CONCENTRATION_TOP, CONCENTRATION_SHARE };
