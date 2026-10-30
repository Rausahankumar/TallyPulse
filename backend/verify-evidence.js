/**
 * Evidence record of an analysis plan (services/query/evidence.js) and its findings in the answer text (analysisAnswer.js).
 *
 * Pure: the evidence is built from step results only, so every case here hands formatAnalysisAnswer / buildEvidence an
 * execution object shaped exactly like executeAnalysisPlan's (query steps carry the engine's rows, totals, period and
 * comparison). Checks:
 *   - arithmetic: changes, shares, and the quantity/rate split add up EXACTLY (2 decimals), including a seeded property run;
 *   - labels: measured / contributor / possible_cause only; inactivity and contributors are never called causes; a possible
 *     cause is always hedged; sales minus purchases is never called profit;
 *   - honesty: no split for mixed products or a period without quantity, no shares when rows are cut and no total exists,
 *     an incomplete latest bucket is not compared, a gap in a series is not bridged, different bases are not subtracted;
 *   - unchanged behaviour: no findings -> the answer text is exactly as before;
 *   - the investigation eval's own explanation criteria pass on the findings and fail on the steps alone.
 *
 * No database, no network, no model. Run: node verify-evidence.js
 */

process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const fs = require("fs");
const path = require("path");
const { buildEvidence, round2 } = require("./src/services/query/evidence");
const { formatAnalysisAnswer } = require("./src/services/query/analysisAnswer");
const S = require("./eval/investigation/scenarios");
const { grade } = require("./eval/investigation/grader");

let pass = 0;
let fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 600)}`}`);
  if (ok) pass += 1; else fail += 1;
}

// ---------------------------------------------------------------- fixtures shaped like the engine's results
const REF = new Date(2026, 9, 26, 12); // reporting reference date: 26 Oct 2026
const iso = (y, m, d, end = false) => (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
const month = (y, m) => ({ bucket: "month", start: `${y}-${String(m).padStart(2, "0")}-01`, label: `${y}-${String(m).padStart(2, "0")}` });
const SEP = { from: iso(2026, 9, 1), to: iso(2026, 9, 30, true), label: "Previous month (complete)" };
const AUG = { from: iso(2026, 8, 1), to: iso(2026, 8, 31, true), label: "August 2026" };
const ALL = { kind: "all_time", from: null, to: null, label: "All time" };
const product = (name) => [{ dim: "product", op: "eq_ci", value: name }];
let sid = 0;
const qstep = (request, result, status = "ok") => ({ id: `s${++sid}`, kind: "query", status, request: { v: 1, mode: "aggregate", filters: [], groupBy: [], ...request }, result: { rows: [], totals: null, truncated: false, comparison: null, ...result }, facts: `facts of s${sid}`, notes: [] });
/** a monthly series step: points = [[y, m, {metric: value}]] */
const series = (entity, metrics, points, { filters = [], other = null } = {}) =>
  qstep({ entity, metrics, filters, groupBy: [...(other ? [{ dim: other.dim }] : []), { dim: "date", bucket: "month" }], period: { kind: "all_time" } }, { period: ALL, rows: points.map(([y, m, values, g]) => ({ key: { ...(other ? { [other.dim]: g || other.value } : {}), date: month(y, m) }, values })) });
/** a comparison by one dimension: rows = [[name, current, previous]] */
function compared(entity, dim, metric, rows, { filters = [], total = "sum", truncated = false, dir = "asc" } = {}) {
  const out = rows.map(([name, cur, prev]) => ({ key: { [dim]: name }, values: { [metric]: cur }, comparison: { [metric]: { previous: prev, delta: round2(cur - prev), deltaPct: prev ? round2(((cur - prev) / prev) * 100) : null } } }));
  const sum = (i) => round2(rows.reduce((s, r) => s + r[i], 0));
  const totals = total === "none" ? null : (() => { const [c, p] = total === "sum" ? [sum(1), sum(2)] : total; return { values: { [metric]: c }, comparison: { [metric]: { previous: p, delta: round2(c - p), deltaPct: null } } }; })();
  return qstep({ entity, metrics: [metric], filters, groupBy: [{ dim }], period: { kind: "previous_month" }, compare: { mode: "full_previous" }, sort: [{ by: `${metric}.delta`, dir }], limit: 5 }, { period: SEP, comparison: AUG, rows: out, totals, truncated });
}
const total = (entity, metric, value, period = SEP) => qstep({ entity, metrics: [metric], period: { kind: "previous_month" } }, { period, totals: { values: { [metric]: value } } });
const ev = (...steps) => buildEvidence({ steps }, { referenceDate: REF });
const texts = (e) => e.findings.map((f) => f.text).join("\n");
const ofLabel = (e, label) => e.findings.filter((f) => f.label === label);
const numberAt = (text, re) => { const m = re.exec(text); return m ? Number(m[1].replace(/[₹,]/g, "")) * (m[0].includes("-₹") ? -1 : 1) : NaN; };

// ---------------------------------------------------------------- 1. series change and the quantity / rate split
{
  const apple = series("sales", ["lineAmount", "quantity"], [[2026, 7, { lineAmount: 10000, quantity: 100 }], [2026, 8, { lineAmount: 10000, quantity: 100 }], [2026, 9, { lineAmount: 3100, quantity: 31 }]], { filters: product("Apple") });
  const e = ev(apple);
  check("series-change", "every complete month vs the one before (Jul -> Aug 0, Aug -> Sep -6,900 (-69.0%)), labelled measured", /each month vs the previous month: Aug 2026 ₹10,000\.00 vs Jul 2026 ₹10,000\.00: ₹0\.00 \(0\.0%\); Sep 2026 ₹3,100\.00 vs Aug 2026 ₹10,000\.00: -₹6,900\.00 \(-69\.0%\)\./.test(texts(e)) && ofLabel(e, "measured").length === 2, texts(e));
  const two = ev(series("sales", ["lineAmount"], [[2026, 8, { lineAmount: 10000 }], [2026, 9, { lineAmount: 3100 }]]));
  check("series-single-pair", "with exactly one complete pair the change reads as one sentence", /fell from ₹10,000\.00 in Aug 2026 to ₹3,100\.00 in Sep 2026: -₹6,900\.00 \(-69\.0%\)/.test(texts(two)), texts(two));
  const split = ofLabel(e, "contributor")[0];
  check("split-volume", "a pure quantity fall: quantity effect -6,900, rate effect 0, together exactly the change", split && split.values.volume === -6900 && split.values.rate === 0 && split.values.delta === -6900, JSON.stringify(split));
  check("split-wording", "quantity fell 100 -> 31, average rate unchanged at 100, with the free-quantity and unit caveat", /Quantity sold fell from 100 to 31/.test(texts(e)) && /Average rate unchanged at ₹100\.00/.test(texts(e)) && /The rate is Line amount \(pre-tax\) ÷ stored quantity: free quantity is included and no unit of measure is stored/.test(texts(e)));

  const orange = series("sales", ["lineAmount", "quantity"], [[2026, 8, { lineAmount: 12000, quantity: 100 }], [2026, 9, { lineAmount: 9000, quantity: 100 }]], { filters: product("Orange") });
  const o = ofLabel(ev(orange), "contributor")[0];
  check("split-rate", "a pure price cut: quantity effect 0, rate effect -3,000; rate 120 -> 90", o && o.values.volume === 0 && o.values.rate === -3000 && /Average rate fell from ₹120\.00 to ₹90\.00/.test(texts(ev(orange))), JSON.stringify(o));

  // seeded property run: awkward values never leave a rounding gap
  let seed = 7, bad = null;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 500 && !bad; i += 1) {
    const q0 = 1 + Math.floor(rnd() * 999), q1 = 1 + Math.floor(rnd() * 999);
    const v0 = round2(rnd() * 1e6), v1 = round2(rnd() * 1e6);
    const st = series("purchase", ["lineAmount", "quantity"], [[2026, 8, { lineAmount: v0, quantity: q0 }], [2026, 9, { lineAmount: v1, quantity: q1 }]], { filters: product("P") });
    const c = ofLabel(ev(st), "contributor")[0];
    if (!c || round2(c.values.volume + c.values.rate) !== round2(v1 - v0) || c.values.delta !== round2(v1 - v0)) bad = { v0, v1, q0, q1, c: c && c.values };
  }
  check("split-exact-property", "500 seeded cases: quantity effect + rate effect = the change to the paisa", bad === null, JSON.stringify(bad));
}

// ---------------------------------------------------------------- 2. no split where it would not be valid
{
  const mixed = series("sales", ["lineAmount", "quantity"], [[2026, 8, { lineAmount: 500, quantity: 10 }], [2026, 9, { lineAmount: 400, quantity: 9 }]]);
  const e = ev(mixed);
  check("no-split-mixed", "no product filter: the change is measured but quantity/rate are NOT split, and the reason is a gap", ofLabel(e, "contributor").length === 0 && !/Average rate/.test(texts(e)) && e.gaps.some((g) => /several products/.test(g.text)), JSON.stringify(e));
  const zero = series("sales", ["lineAmount", "quantity"], [[2026, 8, { lineAmount: 0, quantity: 0 }], [2026, 9, { lineAmount: 400, quantity: 9 }]], { filters: product("P") });
  const z = ev(zero);
  check("no-split-zero-qty", "no quantity in the earlier month: no rate, no split, stated as a gap", ofLabel(z, "contributor").length === 0 && z.gaps.some((g) => /no quantity in Aug 2026/.test(g.text)), JSON.stringify(z));
  const invoice = series("sales", ["invoiceAmount"], [[2026, 8, { invoiceAmount: 100 }], [2026, 9, { invoiceAmount: 80 }]], { filters: product("P") });
  check("no-split-voucher-metric", "an invoice-total series has no line quantity on the same basis: change only", ev(invoice).findings.length === 1 && ofLabel(ev(invoice), "contributor").length === 0);
}

// ---------------------------------------------------------------- 3. incomplete and missing buckets
{
  const withOct = series("sales", ["lineAmount"], [[2026, 8, { lineAmount: 100 }], [2026, 9, { lineAmount: 90 }], [2026, 10, { lineAmount: 5 }]]);
  const e = ev(withOct);
  check("partial-latest", "Oct 2026 ends after the reference date (26 Oct): it is not compared; Aug -> Sep is, and the gap says why", /from ₹100\.00 in Aug 2026 to ₹90\.00 in Sep 2026/.test(texts(e)) && !/Oct 2026/.test(texts(e)) && e.gaps.some((g) => /Oct 2026 may be incomplete \(data up to 2026-10-26\)/.test(g.text)), JSON.stringify(e));
  const holes = series("sales", ["lineAmount"], [[2026, 6, { lineAmount: 100 }], [2026, 9, { lineAmount: 90 }]]);
  const h = ev(holes);
  check("no-bridge", "Jun then Sep (no rows in between): no change is calculated across the hole; the gap says so", h.findings.length === 0 && h.gaps.some((g) => /no row for the month before Sep 2026/.test(g.text)), JSON.stringify(h));
  const noRef = buildEvidence({ steps: [series("sales", ["lineAmount"], [[2026, 8, { lineAmount: 1 }], [2026, 9, { lineAmount: 2 }]])] });
  check("no-reference-date", "all-time series without a reference date: the latest bucket is never assumed complete", noRef.findings.length === 0 && noRef.gaps.length === 1, JSON.stringify(noRef));
}

// ---------------------------------------------------------------- 4. contributors, offsets, rows not listed, inactive parties
{
  const c = compared("sales", "customer", "lineAmount", [["Sharma", 0, 4000], ["Gupta", 0, 3000], ["Khan", 1500, 1500], ["Rao", 1600, 1500]], { filters: product("Apple") });
  const e = ev(c);
  const k = ofLabel(e, "contributor")[0];
  check("contrib-shares", "shares of the net -6,900: Sharma 58.0%, Gupta 43.5%; Rao's +100 shown as moving the other way", /Sharma -₹4,000\.00 \(58\.0%\); Gupta -₹3,000\.00 \(43\.5%\)/.test(k.text) && /Rao \+₹100\.00 in the other direction/.test(k.text), k.text);
  check("contrib-reconciles", "named + other listed + not listed = the measured change exactly", round2(k.values.named + k.values.otherListed + k.values.notListed) === k.values.total && k.values.total === -6900, JSON.stringify(k.values));
  const inactive = e.findings.find((f) => /Sales of Apple: none recorded in Sep 2026 for/.test(f.text));
  check("inactive-measured", "customers with nothing in Sep after buying in Aug: a MEASURED absence that says it is not a reason", !!inactive && inactive.label === "measured" && /Sharma \(₹4,000\.00 in Aug 2026\), Gupta \(₹3,000\.00 in Aug 2026\)/.test(inactive.text) && /not its reason/.test(inactive.text), JSON.stringify(inactive));

  const cut = compared("sales", "customer", "lineAmount", [["A", 100, 500], ["B", 50, 300]], { total: [1000, 2500], truncated: true });
  const kc = ofLabel(ev(cut), "contributor")[0];
  check("contrib-not-listed", "rows cut at the limit, total known: the remainder is named 'customers not listed' and everything adds up", /customers not listed -₹850\.00/.test(kc.text) && round2(kc.values.named + kc.values.otherListed + kc.values.notListed) === -1500, kc && kc.text);
  const unknown = ev(compared("sales", "customer", "lineAmount", [["A", 100, 500]], { total: "none", truncated: true }));
  check("contrib-no-total", "rows cut and no total: no shares are invented; a gap says the others are unknown", ofLabel(unknown, "contributor").length === 0 && unknown.gaps.some((g) => /Only the 1 customers shown are known/.test(g.text)), JSON.stringify(unknown));
  const flat = ev(compared("sales", "customer", "lineAmount", [["A", 100, 100]]));
  check("contrib-no-change", "a net change of zero: stated ONCE (the measured ₹0.00 change, no extra 'no net change'), no shares (no division by zero)", flat.findings.length === 1 && /a change of ₹0\.00 \(0\.0%\)/.test(texts(flat)) && !/no net change/.test(texts(flat)) && ofLabel(flat, "contributor").length === 0, texts(flat));
  const flatNoTotal = ev(compared("sales", "customer", "lineAmount", [["A", 100, 100]], { total: "none" }));
  check("contrib-no-change-no-total", "without a total line, a complete list netting to zero still says 'no net change' once", flatNoTotal.findings.length === 1 && /no net change/.test(texts(flatNoTotal)), texts(flatNoTotal));
  const filtered = compared("sales", "customer", "lineAmount", [["A", 100, 500]], { total: "none" });
  filtered.request.having = [{ metric: "lineAmount.delta", op: "lt", value: 0 }];
  const fh = ev(filtered);
  check("contrib-having-no-total", "rows filtered by a having and no total: the listed falls are NOT taken as the whole change", ofLabel(fh, "contributor").length === 0 && fh.gaps.some((g) => /Only the 1 customers shown are known/.test(g.text)), JSON.stringify(fh));
  const bound = compared("sales", "product", "lineAmount", [["P1", 0, 500]], { filters: [{ dim: "customer", op: "in_ci", value: ["Alpha Traders", "Delta Corp"] }] });
  check("scope-filters", "a step filtered to bound customers says so in every finding (never reads as all sales)", ev(bound).findings.every((f) => /for customers Alpha Traders, Delta Corp/.test(f.text)) && ev(bound).findings.length === 3, texts(ev(bound)));
  const scalar = qstep({ entity: "sales", metrics: ["invoiceAmount"], period: { kind: "previous_month" }, compare: { mode: "full_previous" } }, { period: SEP, comparison: AUG, totals: { values: { invoiceAmount: 1700 }, comparison: { invoiceAmount: { previous: 2000, delta: -300, deltaPct: -15 } } } });
  const sc = ev(scalar);
  check("compared-total", "a compared total with no grouping: one measured change (2,000 -> 1,700, -300, -15.0%), no contributors", sc.findings.length === 1 && sc.findings[0].label === "measured" && /₹2,000\.00 in Aug 2026, ₹1,700\.00 in Sep 2026, a change of -₹300\.00 \(-15\.0%\)/.test(sc.findings[0].text), texts(sc));
}

// ---------------------------------------------------------------- 5. possible causes: hedged, same product, material, in time
{
  const salesFall = compared("sales", "customer", "lineAmount", [["Sharma", 0, 4000], ["Rao", 1600, 1500]], { filters: product("Apple") });
  const buy = (name, points) => series("purchase", ["lineAmount"], points.map(([m, v]) => [2026, m, { lineAmount: v }]), { filters: product(name), other: { dim: "supplier", value: "Himachal" } });
  const e = ev(salesFall, buy("Apple", [[6, 6000], [7, 6000], [8, 1800], [9, 1800]]));
  const pc = ofLabel(e, "possible_cause");
  check("cause-found", "purchases of the SAME product fell 70% the month before the sales fall: one possible cause, both steps cited", pc.length === 1 && /Himachal fell from ₹6,000\.00 in Jul 2026 to ₹1,800\.00 in Aug 2026, before the sales fall in Sep 2026/.test(pc[0].text) && JSON.stringify(pc[0].steps) === JSON.stringify([1, 2]), JSON.stringify(pc));
  check("cause-hedged", "the possible cause is hedged (the eval's hedge words) and says it is not confirmed", pc.length === 1 && S.HEDGE.test(pc[0].text) && /not confirmed/.test(pc[0].text));
  check("cause-other-product", "a purchase fall of a DIFFERENT product is not offered as a cause", ofLabel(ev(salesFall, buy("Banana", [[7, 6000], [8, 1800]])), "possible_cause").length === 0);
  check("cause-not-material", "a purchase dip under the materiality threshold is not offered", ofLabel(ev(salesFall, buy("Apple", [[7, 6000], [8, 5800]])), "possible_cause").length === 0);
  check("cause-too-early", "a purchase fall long before the sales fall (outside the window) is not offered", ofLabel(ev(salesFall, buy("Apple", [[2, 6000], [3, 1000]])), "possible_cause").length === 0);
  check("cause-needs-fall", "no sales fall (sales rose): no cause is looked for", ofLabel(ev(compared("sales", "customer", "lineAmount", [["A", 900, 100]], { filters: product("Apple") }), buy("Apple", [[7, 6000], [8, 1800]])), "possible_cause").length === 0);
  check("labels-closed-set", "every finding carries one of the three labels and cites at least one step that ran", [e, ev(salesFall)].every((x) => x.findings.every((f) => ["measured", "contributor", "possible_cause"].includes(f.label) && f.steps.length > 0 && f.steps.every((n) => n === 1 || n === 2))));
}

// ---------------------------------------------------------------- 6. sales minus purchases is never profit
{
  const e = ev(total("sales", "invoiceAmount", 16905), total("purchase", "purchaseAmount", 11865));
  check("difference", "same period, both invoice totals incl. tax: 16,905 - 11,865 = 5,040, measured", /₹16,905\.00 − ₹11,865\.00 = ₹5,040\.00/.test(texts(e)) && e.findings[0].label === "measured" && e.findings[0].values.diff === 5040, texts(e));
  check("difference-not-profit", "the difference is disclosed as NOT profit and no text claims a profit figure", e.gaps.some((g) => /not profit/.test(g.text)) && !/\b(?:profit|margin)\s*(?:is|was|of|=|:)\s*(?:₹|rs\.?\s*)?[\d,]+/i.test(formatAnalysisAnswer({ steps: [total("sales", "invoiceAmount", 16905), total("purchase", "purchaseAmount", 11865)] }).text));
  const mixedBasis = ev(total("sales", "invoiceAmount", 100), total("purchase", "lineAmount", 60));
  check("difference-basis", "an invoice total and a pre-tax line value are NOT subtracted; the gap says why", mixedBasis.findings.length === 0 && mixedBasis.gaps.some((g) => /same period and amount basis/.test(g.text)));
  const mixedPeriod = ev(total("sales", "invoiceAmount", 100), total("purchase", "purchaseAmount", 60, AUG));
  check("difference-period", "different periods are NOT subtracted", mixedPeriod.findings.length === 0);
}

// ---------------------------------------------------------------- 7. the answer text: unchanged without findings, findings first otherwise
{
  const none = { steps: [{ id: "x", kind: "query", status: "ok", request: { v: 1, entity: "sales", mode: "aggregate", metrics: ["invoiceCount"], groupBy: [], filters: [] }, result: { rows: [], totals: { values: { invoiceCount: 4 } }, comparison: null, period: SEP }, facts: "Sales — 4 invoices", notes: [] }, { id: "y", kind: "query", status: "skipped", message: "Step x returned nothing." }] };
  const text = formatAnalysisAnswer(none).text;
  check("unchanged-without-findings", "no finding can be computed: the text is exactly the previous format", text === "Analysis: measured results only (no interpretation).\n\n**Step 1**\nSales — 4 invoices\n\n**Step 2**\nNot run: Step x returned nothing.", text);
  const skipped = buildEvidence({ steps: [{ ...compared("sales", "customer", "lineAmount", [["A", 0, 10]]), status: "failed" }] });
  check("ignores-failed-steps", "a step that did not run contributes nothing", skipped.findings.length === 0 && skipped.gaps.length === 0);
  const withF = formatAnalysisAnswer({ steps: [compared("sales", "customer", "lineAmount", [["A", 0, 10], ["B", 5, 5]])] }, { referenceDate: REF }).text;
  check("findings-first", "the overall result, then the findings come before the steps, each with its step reference, then the label legend, then the step text unchanged", /\n\nAnalysis: findings calculated from the measured results, then each step's results\.\n\n\*\*Overall:\*\* Sales \(line amount, pre-tax\) fell from ₹15\.00 in Aug 2026 to ₹5\.00 in Sep 2026: -₹10\.00 \(-66\.7%\)\. \(step 1\)\n\n\*\*Findings\*\*\n- [A-Z][a-z]+: .*\(step 1\)/.test(withF) && withF.indexOf("Possible cause = consistent with the data, not proven.") < withF.indexOf("**Step 1**") && /\*\*Step 1\*\*\nfacts of s\d+/.test(withF), withF);
}

// ---------------------------------------------------------------- 8. the investigation eval's criteria on the findings
{
  const months = S.monthsBefore(new Date(2026, 9, 26));
  const truth = S.groundTruth(months);
  const criteria = Object.fromEntries(S.scenarios(truth).flatMap((sc) => sc.turns.flatMap((t) => t.criteria)).map((c) => [c.id, c]));
  const at = (i) => [months[i].y, months[i].m];
  const appleSteps = [series("sales", ["lineAmount", "quantity"], truth.apple.valueByMonth.map((v, i) => [...at(i), { lineAmount: v, quantity: truth.apple.unitsByMonth[i] }]), { filters: product(S.APPLE) })];
  const orangeSteps = [series("sales", ["lineAmount", "quantity"], truth.orange.valueByMonth.map((v, i) => [...at(i), { lineAmount: v, quantity: truth.orange.unitsByMonth[i] }]), { filters: product(S.ORANGE) })];
  const run = (steps, ids) => {
    const text = formatAnalysisAnswer({ steps }, { referenceDate: REF }).text;
    const stepsOnly = text.slice(text.indexOf("**Step 1**"));
    return { withFindings: grade(ids.map((id) => criteria[id]), { text }), stepsOnly: grade(ids.map((id) => criteria[id]), { text: stepsOnly }) };
  };
  const a = run(appleSteps, ["driver-volume", "price-unchanged", "units-after"]);
  const o = run(orangeSteps, ["driver-price", "quantity-flat", "rate-before", "rate-after"]);
  const passed = (g) => g.results.filter((r) => r.pass).length;
  check("eval-apple-explanation", "apple (volume decline): the eval's explanation criteria pass on the findings, fail on the steps alone", passed(a.withFindings) === 3 && passed(a.stepsOnly) < 3, JSON.stringify(a.withFindings.results.filter((r) => !r.pass)));
  check("eval-orange-explanation", "orange (price cut): driver-price, quantity-flat and both rates pass on the findings, fail on the steps alone", passed(o.withFindings) === 4 && passed(o.stepsOnly) === 0, JSON.stringify(o.withFindings.results.filter((r) => !r.pass)));
}

// ---------------------------------------------------------------- 10. live WE FOUR transcript regressions (data through 8 Dec 2025)
{
  const custom = (y1, m1, d1, y2, m2, d2) => ({ kind: "custom", from: iso(y1, m1, d1), to: iso(y2, m2, d2, true), label: "custom" });
  const MAY_DEC = custom(2025, 5, 1, 2025, 12, 31);
  const SALES = [[5, 4223011.26], [6, 4085714.1], [7, 5716599.12], [8, 4344775.5], [9, 5096416.8], [10, 4765585.55], [11, 5623866.46], [12, 1521542.68]];
  const monthly = (points = SALES, period = MAY_DEC) => { const st = series("sales", ["invoiceAmount"], points.map(([m, v]) => [2025, m, { invoiceAmount: v }])); st.result.period = period; st.request.period = { kind: "custom" }; return st; };
  const evd = (opts, ...steps) => buildEvidence({ steps }, { referenceDate: REF, ...opts });
  const DEC8 = new Date(2025, 11, 8); // dc.latestVoucher: local midnight of the latest voucher's calendar day

  // 1. incomplete periods
  const mid = evd({ dataThrough: DEC8 }, monthly());
  check("live-incomplete-month", "latest voucher 8 Dec: Dec 2025 is incomplete - never compared, and the gap names the data date", !/Dec 2025/.test(texts(mid)) && mid.gaps.some((g) => /Dec 2025 may be incomplete \(data up to 2025-12-08\)/.test(g.text)), JSON.stringify(mid));
  const full = evd({ dataThrough: new Date(2025, 11, 31) }, monthly());
  check("live-complete-month", "latest voucher 31 Dec: Dec 2025 is complete and its change vs Nov is measured", /Dec 2025 ₹15,21,542\.68 vs Nov 2025 ₹56,23,866\.46: -₹41,02,323\.78 \(-72\.9%\)/.test(texts(full)) && !full.gaps.length, JSON.stringify(full));
  check("live-datathrough-string", "a YYYY-MM-DD dataThrough is read as that calendar day", !/Dec 2025/.test(texts(evd({ dataThrough: "2025-12-08" }, monthly()))));
  check("live-datathrough-invalid", "an unusable dataThrough is ignored (the period end decides, as before)", /Dec 2025 ₹15,21,542\.68/.test(texts(evd({ dataThrough: "not a date" }, monthly()))) && /Dec 2025 ₹15,21,542\.68/.test(texts(evd({ dataThrough: null }, monthly()))));
  const cmp = qstep({ entity: "sales", metrics: ["invoiceAmount"], period: { kind: "custom" }, compare: { mode: "custom" } }, { period: custom(2025, 11, 1, 2025, 12, 31), comparison: custom(2025, 5, 1, 2025, 6, 30), totals: { values: { invoiceAmount: 7145409.14 }, comparison: { invoiceAmount: { previous: 8308725.36, delta: -1163316.22, deltaPct: -14 } } } });
  const ci = evd({ dataThrough: DEC8 }, cmp);
  check("live-incomplete-comparison", "Nov-Dec vs May-Jun with data to 8 Dec: the change is measured but flagged incomplete, and a gap says it is not a full-period change", ci.findings.length === 1 && /incomplete: data only up to 2025-12-08/.test(ci.findings[0].text) && ci.gaps.some((g) => /not a full-period change/.test(g.text)), JSON.stringify(ci));
  const appleCmp = compared("sales", "customer", "lineAmount", [["Sharma", 0, 4000]], { filters: product("Apple") });
  const buyApple = series("purchase", ["lineAmount"], [[2026, 8, { lineAmount: 6000 }], [2026, 9, { lineAmount: 1000 }]], { filters: product("Apple") });
  check("live-incomplete-no-cause", "a sales fall in an incomplete period is not used for a possible cause", ofLabel(evd({ dataThrough: new Date(2026, 8, 20) }, appleCmp, buyApple), "possible_cause").length === 0 && ofLabel(evd({}, appleCmp, buyApple), "possible_cause").length === 1);

  // 2. contributor accuracy
  const desc = compared("sales", "customer", "invoiceAmount", [["A&T", 74785, 3589], ["Madhav", 47047, 5045], ["Benir", 0, 5767]], { total: [1521542.68, 5623866.46], truncated: true, dir: "desc" });
  const dk = texts(ev(desc));
  const dc = ofLabel(ev(desc), "contributor").map((f) => f.text).join("\n");
  check("live-opposite-sort", "a list ordered by largest INCREASE, cut at the limit, for a fall: never 'Largest contributors', says it runs the opposite way, and names no listed customer (not even the small faller Benir) as a contributor", !/Largest contributors|Among the listed/.test(dc) && /ordered largest increase first, the opposite direction/.test(dc) && !/Benir|A&T|Madhav/.test(dc), dc);
  check("live-remainder-dominates", "the unlisted remainder and its share of the change are stated (here almost all of it)", /customers not listed -₹42,09,754\.78 \(102\.6% of the change\)/.test(dk), dk);
  const asc = compared("sales", "customer", "invoiceAmount", [["Dhingra", 365529, 693580], ["OZI", 20690, 251075]], { total: [1000000, 2000000], truncated: true, dir: "asc" });
  const ak = ofLabel(ev(asc), "contributor")[0];
  check("live-truncated-ranked", "ordered by largest fall and cut: 'Largest contributors' is allowed, listed and not-listed parts are separate and add up", /^Largest contributors/.test(ak.text) && /customers not listed -₹4,41,564\.00/.test(ak.text) && round2(ak.values.named + ak.values.otherListed + ak.values.notListed) === -1000000, ak && ak.text);
  const none = compared("sales", "customer", "invoiceAmount", [["A", 200, 100]], { total: [1000, 5000], truncated: true });
  none.request.sort = [{ by: "invoiceAmount", dir: "desc" }]; // a list ranked by value, not by this change
  check("live-no-listed-contributor", "a list not ranked by the change, none of its rows moving with it: says so and names the unlisted remainder (no invented contributor)", /None of the 1 listed customers \(first 1 shown, more exist, ordered by invoiceAmount desc\) moved with the -₹4,000\.00 change/.test(texts(ev(none))) && /customers not listed -₹4,100\.00/.test(texts(ev(none))), texts(ev(none)));

  // 3. empty results vs measured zeros
  const emptyGroup = compared("sales", "product", "lineAmount", [], { total: [0, 0] });
  const emptyScalar = qstep({ entity: "sales", metrics: ["invoiceAmount"], period: { kind: "previous_month" }, compare: { mode: "full_previous" } }, { period: SEP, comparison: AUG, totals: { values: { invoiceAmount: 0 }, comparison: { invoiceAmount: { previous: 0, delta: 0, deltaPct: null } } } });
  const e0 = ev(emptyGroup, emptyScalar);
  check("live-empty-step", "steps with no records give no finding at all (no ₹0 change, no 'no net change')", e0.findings.length === 0, JSON.stringify(e0));
  const emptyDiff = ev(total("sales", "invoiceAmount", 0), total("purchase", "purchaseAmount", 0));
  check("live-empty-difference", "sales minus purchases is not computed from empty steps (no ₹0 − ₹0 = ₹0)", emptyDiff.findings.length === 0, JSON.stringify(emptyDiff));
  const zeroNow = qstep({ entity: "sales", metrics: ["invoiceAmount"], period: { kind: "previous_month" }, compare: { mode: "full_previous" } }, { period: SEP, comparison: AUG, totals: { values: { invoiceAmount: 0 }, comparison: { invoiceAmount: { previous: 5000, delta: -5000, deltaPct: -100 } } } });
  check("live-valid-zero", "a measured zero against a non-zero previous period IS a finding (-₹5,000.00, -100.0%)", /₹5,000\.00 in Aug 2026, ₹0\.00 in Sep 2026, a change of -₹5,000\.00 \(-100\.0%\)/.test(texts(ev(zeroNow))));
  const flatScalar = qstep({ entity: "sales", metrics: ["invoiceAmount"], period: { kind: "previous_month" }, compare: { mode: "full_previous" } }, { period: SEP, comparison: AUG, totals: { values: { invoiceAmount: 100 }, comparison: { invoiceAmount: { previous: 100, delta: 0, deltaPct: 0 } } } });
  check("live-no-duplicate-flat", "an unchanged non-empty total gives ONE finding, not a change line plus 'no net change'", ev(flatScalar).findings.length === 1, texts(ev(flatScalar)));

  // 4. every adjacent month
  const all = evd({ dataThrough: new Date(2025, 11, 31) }, monthly());
  const pairs = (texts(all).match(/\b\w{3} 2025 ₹[\d,.]+ vs \w{3} 2025 ₹[\d,.]+: [-+]₹[\d,.]+ \([-+]?[\d.]+%\)/g) || []);
  check("live-all-pairs", "May-Dec complete: all 7 adjacent pairs (Jun vs May ... Dec vs Nov) are listed, oldest first", pairs.length === 7 && /^Jun 2025 ₹40,85,714\.10 vs May 2025 ₹42,23,011\.26: -₹1,37,297\.16 \(-3\.3%\)/.test(pairs[0]) && /^Dec 2025/.test(pairs[6]), JSON.stringify(pairs));
  const holes = evd({ dataThrough: new Date(2025, 11, 31) }, monthly([[5, 100], [6, 90], [8, 80], [9, 70]]));
  const hp = texts(holes).match(/\w{3} 2025 ₹[\d,.]+ vs \w{3} 2025/g) || [];
  check("live-pairs-no-bridge", "a missing month is never bridged: Jun vs May and Sep vs Aug only, and the hole is a gap", JSON.stringify(hp) === JSON.stringify(["Jun 2025 ₹90.00 vs May 2025", "Sep 2025 ₹70.00 vs Aug 2025"]) && holes.gaps.some((g) => /no row for the month before Aug 2025/.test(g.text)), texts(holes) + JSON.stringify(holes.gaps));
}

// ---------------------------------------------------------------- 11. live WE FOUR Q4 / Q5 / Q6: several breakdowns, sort directions, limits
{
  const TOTAL = [1521542.68, 5623866.46]; // Dec vs Nov invoice totals: -41,02,323.78
  const up = () => compared("sales", "customer", "invoiceAmount", [["A&T", 74785, 3589], ["Madhav", 47047, 5045]], { total: TOTAL, truncated: true, dir: "desc" });
  const down = () => compared("sales", "customer", "invoiceAmount", [["Dhingra", 365529, 693580], ["OZI", 20690, 251075], ["Malik", 0, 173105]], { total: TOTAL, truncated: true, dir: "asc" });
  const contribs = (e) => ofLabel(e, "contributor");

  // Q6: the same change listed twice, once by largest increase and once by largest fall
  const q6 = ev(up(), down());
  const q6t = texts(q6);
  check("q6-one-breakdown", "two lists of the same change: only the fall-ordered list gives the contributor breakdown (step 2); the increase-ordered one is not repeated as a second, contradictory breakdown", contribs(q6).length === 1 && JSON.stringify(contribs(q6)[0].steps) === "[2]" && !/None of the/.test(q6t), q6t);
  check("q6-no-increase-as-fall", "no increase-ordered customer is presented as a contributor to the fall", !/A&T|Madhav/.test(contribs(q6).map((f) => f.text).join("\n")), q6t);
  check("q6-limit-stated", "the ranked breakdown states its limit and order (first 3 shown, more exist, largest fall first) and the unlisted remainder", /^Largest contributors to the -₹41,02,323\.78 change in Sales \(invoice amount\), Nov|^Largest contributors to the -₹41,02,323\.78 change in Sales \(invoice amount\)/.test(contribs(q6)[0].text) && /first 3 shown, more exist, ordered largest fall first/.test(contribs(q6)[0].text) && /customers not listed -₹33,70,782\.78 \(82\.2% of the change\)/.test(contribs(q6)[0].text), contribs(q6)[0].text);
  const k6 = contribs(q6)[0].values;
  check("q6-reconciles", "named + other listed + not listed = the measured change, exactly", round2(k6.named + k6.otherListed + k6.notListed) === k6.total && k6.total === -4102323.78, JSON.stringify(k6));
  check("q6-total-once", "the shared total change is stated once, not once per step", ofLabel(q6, "measured").filter((f) => /a change of -₹41,02,323\.78/.test(f.text)).length === 1, q6t);

  // the increase-ordered list alone: says what it is, names no contributor, still reconciles
  const alone = ev(up());
  const at = contribs(alone)[0];
  check("opposite-alone", "an increase-ordered, cut list on its own: says it is ordered opposite to the change and cannot show what drove it; listed total and unlisted remainder add up", !!at && /ordered largest increase first, the opposite direction/.test(at.text) && /cannot show what drove it/.test(at.text) && /listed customers together \+₹1,13,198\.00; customers not listed -₹42,15,521\.78 \(102\.8% of the change\)/.test(at.text) && round2(at.values.otherListed + at.values.notListed) === at.values.total && at.values.named === 0, at && at.text);

  // Q4: one list, ordered by largest fall, first N of more
  const q4 = contribs(ev(down()))[0];
  check("q4-ranked-truncated", "fall-ordered and cut at the limit: 'Largest contributors' is justified, with the limit and the remainder stated", /^Largest contributors/.test(q4.text) && /first 3 shown, more exist/.test(q4.text) && /customers not listed/.test(q4.text), q4.text);

  // Q5: a customer breakdown (invoice amount) and a product breakdown (pre-tax line amount) of the same months
  const cust = compared("sales", "customer", "invoiceAmount", [["Dhingra", 365529, 693580]], { total: TOTAL, truncated: true });
  const prod = compared("sales", "product", "lineAmount", [["Pidilite", 50000, 120000]], { total: [1320858.29, 4890617.59], truncated: true });
  const q5 = ev(cust, prod);
  const [c5, p5] = contribs(q5);
  check("q5-separate", "two breakdowns, one per step, each naming its own metric basis; never combined", contribs(q5).length === 2 && JSON.stringify(c5.steps) === "[1]" && JSON.stringify(p5.steps) === "[2]" && /\(invoice amount\)/.test(c5.text) && /\(line amount, pre-tax\)/.test(p5.text) && /by customer/.test(c5.text) && /by product/.test(p5.text), texts(q5));
  check("q5-each-reconciles", "each breakdown reconciles to ITS step's total (-41,02,323.78 invoice; -35,69,759.30 pre-tax)", c5.values.total === -4102323.78 && p5.values.total === -3569759.3 && round2(c5.values.named + c5.values.otherListed + c5.values.notListed) === c5.values.total && round2(p5.values.named + p5.values.otherListed + p5.values.notListed) === p5.values.total, JSON.stringify([c5.values, p5.values]));
  check("q5-periods-stated", "each breakdown states the periods it compares", /Aug 2026 to Sep 2026/.test(c5.text) && /Aug 2026 to Sep 2026/.test(p5.text), c5.text);

  const upA = compared("sales", "customer", "invoiceAmount", [["A&T", 74785, 3589]], { total: TOTAL, truncated: true, dir: "desc", filters: product("Pencil") });
  const downB = compared("sales", "customer", "invoiceAmount", [["Dhingra", 365529, 693580]], { total: TOTAL, truncated: true, dir: "asc", filters: product("Glue") });
  check("different-scope-kept", "an opposite-ordered list of ANOTHER scope (product Pencil vs Glue) is not suppressed: different changes", contribs(ev(upA, downB)).length === 2, texts(ev(upA, downB)));
  const twoMonths = compared("sales", "customer", "invoiceAmount", [["D", 1, 5]], { total: [10, 50] });
  twoMonths.result.period = { from: iso(2025, 11, 1), to: iso(2025, 12, 31, true) };
  twoMonths.result.comparison = { from: iso(2025, 9, 1), to: iso(2025, 10, 31, true) };
  const yearEnd = compared("sales", "customer", "invoiceAmount", [["D", 1, 5]], { total: [10, 50] });
  yearEnd.result.period = { from: iso(2025, 12, 1), to: iso(2026, 1, 31, true) };
  check("period-names", "whole-month ranges read as months (Sep–Oct 2025 to Nov–Dec 2025; Dec 2025–Jan 2026)", /Sep–Oct 2025 to Nov–Dec 2025/.test(texts(ev(twoMonths))) && /Dec 2025–Jan 2026/.test(texts(ev(yearEnd))), texts(ev(twoMonths)) + texts(ev(yearEnd)));

  // the same inactive customer in two lists is named once
  const both = ev(compared("sales", "customer", "invoiceAmount", [["Malik", 0, 173105], ["Rao", 5, 1]], { total: TOTAL, truncated: true }), compared("sales", "customer", "invoiceAmount", [["X", 9, 1], ["Malik", 0, 173105]], { total: TOTAL, truncated: true, dir: "desc" }));
  check("inactive-once", "an inactive customer listed by two steps of the same change is named once", (texts(both).match(/Malik \(₹1,73,105\.00/g) || []).length === 1, texts(both));
}

// ---------------------------------------------------------------- 9. the module stays pure (no database, no model, no tenant)
{
  const src = fs.readFileSync(path.join(__dirname, "src/services/query/evidence.js"), "utf8");
  const requires = [...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]).sort();
  check("pure-module", "evidence.js requires only the catalog and the answer formatter (no model, database or tenant access)", JSON.stringify(requires) === JSON.stringify(["./answerFormatter", "./semanticCatalog"]), JSON.stringify(requires));
}

// ---------------------------------------------------------------- concentration of a ranked breakdown (a comparison stays a comparison)
{
  const AUGP = { from: iso(2025, 8, 1), to: iso(2025, 8, 31, true) };
  const ranked = (entity, dim, m, rows, o = {}) => ({
    kind: "query", status: "ok",
    request: { v: 1, entity, mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, metrics: [m], groupBy: [{ dim }], filters: [], sort: [{ by: m, dir: "desc" }], limit: 10, ...(o.request || {}) },
    result: { ok: true, entity, mode: "aggregate", period: AUGP, comparison: null, metrics: [m], groupBy: [{ dim }], rows: rows.map(([k, x]) => ({ key: { [dim]: k }, values: { [m]: x } })), totals: "total" in o ? o.total : { values: { [m]: rows.reduce((t, [, x]) => t + x, 0) } }, truncated: !!o.truncated, amountBasis: { [m]: m === "lineAmount" ? "line_item_pre_tax" : "voucher_total_incl_tax" } },
  });
  const SUP = [["Alpha Agro", 500000], ["Beta Foods", 300000], ["Gamma Traders", 150000], ["Delta Supply", 30000], ["Epsilon Co", 20000]];
  const CUS = [["Kiran Stores", 210000], ["Lata Mart", 200000], ["Mehta & Sons", 190000], ["Nair Retail", 180000], ["Oak Traders", 170000], ["Pal Bros", 50000]];
  const plan = { steps: [ranked("sales", "customer", "invoiceAmount", CUS), ranked("purchase", "supplier", "purchaseAmount", SUP)] };
  const ev = buildEvidence(plan, {});
  const conc = ev.findings.filter((f) => /are concentrated/.test(f.text));
  check("conc-found", "a supplier ranking with 95% in its top 3 gets one measured concentration finding with its own figures and basis", conc.length === 1 && conc[0].label === "measured" && conc[0].steps.join() === "2" && conc[0].text === "Purchases in Aug 2025 are concentrated: the top 3 of 5 suppliers account for 95.0% (₹9,50,000.00 of ₹10,00,000.00, invoice totals including tax); the largest, Alpha Agro, 50.0%.", JSON.stringify(ev.findings));
  check("conc-judgment", "not every answer gets an insight: 3 of 6 customers holding 60% (near an even 50%) and an even 7-way split get none", ev.findings.every((f) => !/customers/.test(f.text)) && buildEvidence({ steps: [ranked("sales", "customer", "invoiceAmount", [["A", 100], ["B", 100], ["C", 100], ["D", 100], ["E", 100], ["F", 100], ["G", 100]])] }, {}).findings.length === 0);
  check("conc-many-groups", "3 of 20 customers holding 60% is a concentration (even split 15%)", /top 3 of 20 customers account for 60.0%/.test((buildEvidence({ steps: [ranked("sales", "customer", "invoiceAmount", [["A", 300], ["B", 200], ["C", 100], ...Array.from({ length: 17 }, (_, i) => [`X${i + 10}`, 400 / 17])])] }, {}).findings[0] || {}).text || ""));
  check("conc-no-drift", "a comparison answer gains context only: no possible cause, no recommendation, no investigation need (nothing for the investigation loop to add)", ev.findings.every((f) => f.label === "measured") && ev.recommendations.length === 0 && ev.needs.length === 0);
  const trunc = buildEvidence({ steps: [ranked("purchase", "supplier", "purchaseAmount", SUP.slice(0, 4), { truncated: true, total: { values: { purchaseAmount: 1000000 } } })] }, {}).findings[0];
  check("conc-truncated", "a list cut at its limit uses the engine's own total; the number of suppliers is 'more than 4', never counted from the rows", !!trunc && /top 3 of more than 4 suppliers account for 95\.0%/.test(trunc.text), trunc && trunc.text);
  const none = (label, steps) => check(`conc-none-${label}`, `no concentration finding when ${label.replace(/-/g, " ")} (never a share without a valid denominator)`, buildEvidence({ steps }, {}).findings.filter((f) => /concentrated/.test(f.text)).length === 0);
  none("no-total", [ranked("purchase", "supplier", "purchaseAmount", SUP, { total: null })]);
  none("zero-total", [ranked("purchase", "supplier", "purchaseAmount", [["A", 0], ["B", 0], ["C", 0], ["D", 0]])]);
  none("rows-do-not-reconcile", [ranked("purchase", "supplier", "purchaseAmount", SUP, { total: { values: { purchaseAmount: 2000000 } } })]);
  none("a-having-filter", [ranked("purchase", "supplier", "purchaseAmount", SUP, { request: { having: [{ metric: "purchaseAmount", op: "gt", value: 1 }] } })]);
  none("not-ranked-highest-first", [ranked("purchase", "supplier", "purchaseAmount", [...SUP].reverse(), { request: { sort: [{ by: "purchaseAmount", dir: "asc" }] } })]);
  none("three-or-fewer-groups", [ranked("purchase", "supplier", "purchaseAmount", SUP.slice(0, 3))]);
  none("quantities-across-products", [ranked("sales", "product", "quantity", [["P1", 90], ["P2", 5], ["P3", 3], ["P4", 2]])]);
  none("a-negative-row", [ranked("purchase", "supplier", "purchaseAmount", [["A", 500], ["B", 400], ["C", 300], ["D", -50]])]);
  const line = buildEvidence({ steps: [ranked("sales", "product", "lineAmount", [["Apple", 700], ["Banana", 200], ["Cherry", 50], ["Date", 30], ["Elder", 20]])] }, {}).findings[0];
  check("conc-line-basis", "a product ranking on pre-tax line values says so (never presented as invoice totals)", !!line && /pre-tax item values/.test(line.text) && !/including tax/.test(line.text), line && line.text);
  // before / after through the answer text
  const text = formatAnalysisAnswer({ steps: plan.steps.map((s) => ({ ...s, facts: "(step text)", notes: [] })) }, {}).text;
  check("conc-answer", "the comparison answer now leads with this finding (was: 'measured results only, no interpretation') and states no cause or next action", /^Analysis: findings calculated/.test(text) && text.includes("Measured: Purchases in Aug 2025 are concentrated") && !/Possible cause \(not proven\):|Suggested next actions/.test(text), text.slice(0, 400));
}

// ---------------------------------------------------------------- next steps derived from the findings (shown when asked what to do)
{
  // the reported scenario: an August 2025 fall of ₹13,71,823.62 (24.0%), Ashok Traders 29.5% of it, BUNTY TRADERS 11.8%, one customer
  // with no August sales. Contributor size alone is a fact, not a reason to act: no template step is derived from it.
  const JULP = { from: iso(2025, 7, 1), to: iso(2025, 7, 31, true) }, AUGP2 = { from: iso(2025, 8, 1), to: iso(2025, 8, 31, true) };
  // [customer, July, August]: Jul total 57,15,931.75 -> fall 13,71,823.62 (24.0%); the rest of the fall is spread over seven
  // customers under 10% each, and one customer (Jai Traders) rose
  const named = [["Ashok Traders", 1004456, 600000], ["BUNTY TRADERS", 361452, 200000], ["Ganesh Stores", 120000, 0], ["Hari Mart", 95000, 30000], ["Jai Traders", 400000, 450000]];
  const restPrev = round2(5715931.75 - named.reduce((t, r) => t + r[1], 0)), restFall = round2(-1371823.62 - named.reduce((t, r) => t + r[2] - r[1], 0));
  const small = Array.from({ length: 7 }, (_, i) => { const p = i < 6 ? round2(restPrev / 7) : round2(restPrev - 6 * round2(restPrev / 7)); const d = i < 6 ? round2(restFall / 7) : round2(restFall - 6 * round2(restFall / 7)); return [`Small Store ${i + 1}`, p, round2(p + d)]; });
  const C = [...named, ...small];
  const prevT = C.reduce((t, r) => t + r[1], 0), curT = C.reduce((t, r) => t + r[2], 0);
  const cmpOf = (c, p) => ({ previous: p, delta: round2(c - p), deltaPct: p ? round2(((c - p) / p) * 100) : null });
  const custStep = (o = {}) => ({ kind: "query", status: "ok",
    request: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-07-01", to: "2025-07-31" } }, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], filters: [], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 10, ...(o.request || {}) },
    result: { ok: true, entity: "sales", mode: "aggregate", period: AUGP2, comparison: JULP, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, rows: C.map(([k, p, c]) => ({ key: { customer: k }, values: { invoiceAmount: c }, comparison: { invoiceAmount: cmpOf(c, p) } })).sort((a, b) => a.comparison.invoiceAmount.delta - b.comparison.invoiceAmount.delta), totals: { values: { invoiceAmount: round2(curT) }, comparison: { invoiceAmount: cmpOf(round2(curT), round2(prevT)) } }, truncated: false, ...(o.result || {}) } });
  const ev = buildEvidence({ steps: [custStep()] }, {});
  const recs = ev.recommendations;
  check("act-fall", "fixture: the fall is -₹13,71,823.62 (-24.0%), Ashok Traders -₹4,04,456.00 (29.5%), BUNTY TRADERS -₹1,61,452.00 (11.8%)", ev.findings.some((f) => /a change of -₹13,71,823\.62 \(-24\.0%\)/.test(f.text)) && ev.findings.some((f) => /Ashok Traders -₹4,04,456\.00 \(29\.5%\); BUNTY TRADERS -₹1,61,452\.00 \(11\.8%\)/.test(f.text)), JSON.stringify(ev.findings.map((f) => f.text)).slice(0, 600));
  check("act-no-template", "contributor size alone derives no step: no 'follow up with' Ashok/BUNTY, no 'still orders' check for Ganesh Stores, nothing for small or rising customers", recs.length === 0, JSON.stringify(recs));
  check("act-no-action-reason", "asked what to do with only these findings: says where the fall is (its largest contributor, the engine's figure) and that the data does not show why", ev.noAction === "the results show where the fall is (largest: Ashok Traders, -₹4,04,456.00) but not why, and nothing in them points to a specific step yet", ev.noAction);
  check("act-no-churn-claim", "the absence of August sales stays a measured finding, never called churn or loss of the customer", ev.findings.some((f) => /none recorded in Aug 2025 for Ganesh Stores/.test(f.text)) && !/churn|lost the customer|stopped buying/i.test(JSON.stringify(ev)));
  const text = formatAnalysisAnswer({ steps: [{ ...custStep(), facts: "(step)", notes: [] }] }, { actions: true }).text;
  check("act-text", "asked what to do: one specific line, no numbered list of generic checks", /\*\*Suggested next actions\*\*\n- No action follows from these results yet: the results show where the fall is \(largest: Ashok Traders, -₹4,04,456\.00\) but not why/.test(text) && !/\n1\. /.test(text.slice(text.indexOf("**Suggested"))), text.slice(text.indexOf("**Suggested")));
  check("act-not-asked", "not asked (comparison or 'why'): the same evidence, no action section", !/Suggested next actions/.test(formatAnalysisAnswer({ steps: [{ ...custStep(), facts: "(step)", notes: [] }] }, {}).text));
  // a fall measured only as a total: no "break it down" template; the reason names what is missing
  const totalOnly = buildEvidence({ steps: [custStep({ request: { groupBy: [], sort: [] }, result: { groupBy: [], rows: [] } })] }, {});
  check("act-total-only", "a fall known only as a total: no template step; 'where the fall is but not why' without inventing a contributor", totalOnly.recommendations.length === 0 && totalOnly.noAction === "the results show where the fall is but not why, and nothing in them points to a specific step yet", totalOnly.noAction);
  // nothing to act on: the specific reason
  const rise = buildEvidence({ steps: [custStep({ result: { rows: [], totals: { values: { invoiceAmount: 500 }, comparison: { invoiceAmount: cmpOf(500, 400) } }, groupBy: [] }, request: { groupBy: [], sort: [] } })] }, {});
  const flat = buildEvidence({ steps: [{ kind: "query", status: "ok", request: { v: 1, entity: "sales", mode: "aggregate", metrics: ["invoiceAmount"], groupBy: [], filters: [] }, result: { ok: true, rows: [], totals: { values: { invoiceAmount: 4 } }, comparison: null, period: AUGP2, metrics: ["invoiceAmount"] } }] }, {});
  const incomplete = buildEvidence({ steps: [custStep()] }, { dataThrough: "2025-08-20" });
  check("act-none-specific", "no step derivable: the reason is specific - not a fall / no comparison measured / the incomplete period", rise.recommendations.length === 0 && rise.noAction === "the measured change is not a fall" && flat.noAction.startsWith("no change between two periods was measured") && incomplete.recommendations.length === 0 && /^the fall is not complete yet: Aug 2025 has data only up to 2025-08-20, so its change is not a full-period change$/.test(incomplete.noAction), JSON.stringify([rise.noAction, flat.noAction, incomplete.noAction]));
  const noneText = formatAnalysisAnswer({ steps: [{ kind: "query", status: "ok", request: { v: 1, entity: "sales", mode: "aggregate", metrics: ["invoiceAmount"], groupBy: [], filters: [] }, result: { ok: true, rows: [], totals: { values: { invoiceAmount: 4 } }, comparison: null, period: AUGP2, metrics: ["invoiceAmount"] }, facts: "Sales — 4", notes: [] }] }, { actions: true }).text;
  check("act-none-text", "asked, nothing to act on: one specific line, never the old generic sentence or an empty list", /No action follows from these results yet: no change between two periods was measured/.test(noneText) && !/what is not established above would have to be settled first/.test(noneText), noneText);
}

console.log(`\nverify-evidence: ${pass} passed, ${fail} failed, ${pass + fail} total`);
process.exit(fail ? 1 : 0);
