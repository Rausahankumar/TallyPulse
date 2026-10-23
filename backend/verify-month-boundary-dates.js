"use strict";

/**
 * Month-boundary date regression: "previous month" and every other month/year shift must land in the right calendar
 * month on EVERY anchor day - including 29-31 Mar, 31 May/Jul/Oct/Dec, 31 Jan, 29-30 Apr, 31 Aug and 29 Feb, where a
 * plain `new Date(y, m - 1, day)` rolls over into the wrong month. Checked on every surface that resolves periods:
 *   dateRanges (shared helpers)  ->  periodEngine  ->  Query DSL validator (router/planner/engine)
 *   legacy chat tools + REST analytics API (tools.resolvePeriod / resolveComparisonPeriods)
 *   dashboard default trend window (dateRanges.lastNMonthsEnding)
 * against an independent oracle built from plain year/month arithmetic. Pure: no DB, no network, no Claude, no Tally.
 * Run: node verify-month-boundary-dates.js
 */

const dateRanges = require("./src/services/analytics/dateRanges");
const periodEngine = require("./src/services/analytics/periodEngine");
const { validateQueryPlan } = require("./src/services/query/validator");
const tools = require("./src/services/ai/tools");

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail ? ` (${detail})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const stamp = (d) => `${ymd(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
const range = (r) => `${stamp(r.from)}..${stamp(r.to)}`;

// ---- independent oracle (plain calendar arithmetic, shares nothing with the code under test)
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
const addMonths = (y, m, delta) => { const t = y * 12 + m + delta; return [Math.floor(t / 12), ((t % 12) + 12) % 12]; };
const wholeMonth = (y, m) => ({ from: new Date(y, m, 1, 0, 0, 0, 0), to: new Date(y, m, daysIn(y, m), 23, 59, 59, 999) });

// every anchor day of 2000-2040 (incl. 10 leap days) at three times of day
function* anchors() {
  for (let y = 2000; y <= 2040; y += 1) for (let m = 0; m < 12; m += 1) for (let d = 1; d <= daysIn(y, m); d += 1) {
    for (const [h, mi, s, ms] of [[0, 0, 0, 0], [12, 30, 15, 0], [23, 59, 59, 999]]) yield new Date(y, m, d, h, mi, s, ms);
  }
}
function sweep(label, fn) {
  let n = 0;
  const bad = [];
  for (const ref of anchors()) {
    n += 1;
    let r;
    try { r = fn(ref); } catch (e) { r = `threw ${e.message}`; }
    if (r !== true) bad.push(`${stamp(ref)}: ${r}`);
  }
  check(`${label} - all ${n} anchors`, bad.length === 0, `${bad.length} wrong, e.g. ${bad.slice(0, 3).join(" | ")}`);
}
const same = (got, want) => (got === want ? true : `got ${got}, want ${want}`);
const res = (kind, mode, ref) => {
  const v = validateQueryPlan({ v: 1, entity: "sales", mode: "aggregate", period: { kind }, metrics: ["invoiceAmount"], filters: [], ...(mode ? { compare: { mode } } : {}) }, { referenceDate: ref });
  if (!v.ok) throw new Error(v.errors.map((e) => e.code).join(","));
  return v.normalized;
};

section("A. the named month-end anchors that used to resolve to the WRONG month");
{
  const cases = [
    // [anchor, previous month, the month before that]
    ["2026-03-29", "2026-02-01..2026-02-28", "2026-01-01..2026-01-31"],
    ["2026-03-30", "2026-02-01..2026-02-28", "2026-01-01..2026-01-31"],
    ["2026-03-31", "2026-02-01..2026-02-28", "2026-01-01..2026-01-31"],
    ["2024-03-31", "2024-02-01..2024-02-29", "2024-01-01..2024-01-31"], // leap year
    ["2025-05-31", "2025-04-01..2025-04-30", "2025-03-01..2025-03-31"],
    ["2025-07-31", "2025-06-01..2025-06-30", "2025-05-01..2025-05-31"],
    ["2025-10-31", "2025-09-01..2025-09-30", "2025-08-01..2025-08-31"],
    ["2025-12-31", "2025-11-01..2025-11-30", "2025-10-01..2025-10-31"],
    ["2026-01-31", "2025-12-01..2025-12-31", "2025-11-01..2025-11-30"], // year boundary; month-before was wrong here
    ["2026-04-30", "2026-03-01..2026-03-31", "2026-02-01..2026-02-28"], // month-before was wrong here
    ["2025-08-31", "2025-07-01..2025-07-31", "2025-06-01..2025-06-30"], // month-before was wrong here
  ];
  for (const [a, prev, before] of cases) {
    const [y, m, d] = a.split("-").map(Number);
    const ref = new Date(y, m - 1, d, 12, 0, 0, 0);
    const n = res("previous_month", "like_for_like", ref);
    const got = `${ymd(n.period.from)}..${ymd(n.period.to)}`;
    const gotBefore = `${ymd(n.comparison.from)}..${ymd(n.comparison.to)}`;
    check(`anchor ${a}: "last month" = ${prev}, "the month before" = ${before}`, got === prev && gotBefore === before, `${got} / ${gotBefore}`);
    const full = res("current_month", "full_previous", ref);
    check(`anchor ${a}: "this month vs the FULL last month" baseline = ${prev}`, `${ymd(full.comparison.from)}..${ymd(full.comparison.to)}` === prev);
  }
  const leap = dateRanges.sameFullMonthLastYear(new Date(2024, 1, 29, 12));
  check("29 Feb 2024: the same full month last year = February 2023 (not March)", `${ymd(leap.from)}..${ymd(leap.to)}` === "2023-02-01..2023-02-28");
  const trend = dateRanges.lastNMonthsEnding(new Date(2025, 6, 31, 12), 6);
  check("dashboard trend on 31 Jul 2025: 6 whole months = Feb-Jul 2025 (not Mar-Jul)", `${ymd(trend.from)}..${ymd(trend.to)}` === "2025-02-01..2025-07-31");
}

section("B. shared helpers (dateRanges) vs the oracle, every anchor 2000-2040");
{
  sweep("shiftMonths clamps the day and keeps the time (deltas -25..+13)", (ref) => {
    for (const delta of [-25, -13, -12, -2, -1, 1, 2, 12, 13]) {
      const [y, m] = addMonths(ref.getFullYear(), ref.getMonth(), delta);
      const want = new Date(y, m, Math.min(ref.getDate(), daysIn(y, m)), ref.getHours(), ref.getMinutes(), ref.getSeconds(), ref.getMilliseconds());
      const r = same(stamp(dateRanges.shiftMonths(ref, delta)), stamp(want));
      if (r !== true) return `delta ${delta}: ${r}`;
    }
    return true;
  });
  sweep("shiftYears clamps 29 Feb to 28 Feb", (ref) => {
    const y = ref.getFullYear() - 1;
    return same(stamp(dateRanges.shiftYears(ref, -1)), stamp(new Date(y, ref.getMonth(), Math.min(ref.getDate(), daysIn(y, ref.getMonth())), ref.getHours(), ref.getMinutes(), ref.getSeconds(), ref.getMilliseconds())));
  });
  sweep("shiftMonths agrees with periodEngine.safeShiftMonths", (ref) => same(stamp(dateRanges.shiftMonths(ref, -1)), stamp(periodEngine.safeShiftMonths(ref, -1))));
  sweep("previousFullMonth = the whole previous calendar month", (ref) => { const [y, m] = addMonths(ref.getFullYear(), ref.getMonth(), -1); return same(range(dateRanges.previousFullMonth(ref)), range(wholeMonth(y, m))); });
  sweep("sameFullMonthLastYear = the whole same month a year earlier", (ref) => same(range(dateRanges.sameFullMonthLastYear(ref)), range(wholeMonth(ref.getFullYear() - 1, ref.getMonth()))));
  sweep("lastNMonthsEnding(n) = n whole months ending with the anchor month (n = 1, 3, 6, 12)", (ref) => {
    for (const n of [1, 3, 6, 12]) {
      const [fy, fm] = addMonths(ref.getFullYear(), ref.getMonth(), -(n - 1));
      const r = same(range(dateRanges.lastNMonthsEnding(ref, n)), range({ from: wholeMonth(fy, fm).from, to: wholeMonth(ref.getFullYear(), ref.getMonth()).to }));
      if (r !== true) return `n=${n}: ${r}`;
    }
    return true;
  });
  // month-to-date baselines (these were already right; their exact behaviour is pinned here)
  sweep("previousMonthSameRange = 1st..same day (whole last day when the day does not exist) of the previous month", (ref) => {
    const [y, m] = addMonths(ref.getFullYear(), ref.getMonth(), -1);
    const overflow = ref.getDate() > daysIn(y, m);
    const to = overflow ? wholeMonth(y, m).to : new Date(y, m, ref.getDate(), ref.getHours(), ref.getMinutes(), ref.getSeconds(), ref.getMilliseconds());
    return same(range(dateRanges.previousMonthSameRange(ref)), range({ from: new Date(y, m, 1), to }));
  });
  sweep("sameMonthLastYearToDate = 1st..same day of the same month a year earlier (29 Feb -> whole 28 Feb)", (ref) => {
    const y = ref.getFullYear() - 1;
    const m = ref.getMonth();
    const overflow = ref.getDate() > daysIn(y, m);
    const to = overflow ? wholeMonth(y, m).to : new Date(y, m, ref.getDate(), ref.getHours(), ref.getMinutes(), ref.getSeconds(), ref.getMilliseconds());
    return same(range(dateRanges.sameMonthLastYearToDate(ref)), range({ from: new Date(y, m, 1), to }));
  });
}

section("C. period engine + Query DSL (router / planner / engine all resolve through the validator)");
{
  sweep("periodEngine previous_month = whole previous month; its comparison = whole month before", (ref) => {
    const [y1, m1] = addMonths(ref.getFullYear(), ref.getMonth(), -1);
    const [y2, m2] = addMonths(ref.getFullYear(), ref.getMonth(), -2);
    const a = same(range(periodEngine.resolvePeriod("previous_month", ref)), range(wholeMonth(y1, m1)));
    return a !== true ? a : same(range(periodEngine.resolveComparisonPeriod("previous_month", ref)), range(wholeMonth(y2, m2)));
  });
  sweep("DSL previous_month (+ like_for_like) and current_month full_previous land in the right months", (ref) => {
    const [y1, m1] = addMonths(ref.getFullYear(), ref.getMonth(), -1);
    const [y2, m2] = addMonths(ref.getFullYear(), ref.getMonth(), -2);
    const a = res("previous_month", "like_for_like", ref);
    const b = res("current_month", "full_previous", ref);
    const got = `${range(a.period)} | ${range(a.comparison)} | ${range(b.comparison)}`;
    return same(got, `${range(wholeMonth(y1, m1))} | ${range(wholeMonth(y2, m2))} | ${range(wholeMonth(y1, m1))}`);
  });
  sweep("DSL same_month_last_year and current_month same_period_last_year stay in the anchor's month, a year earlier", (ref) => {
    const a = res("same_month_last_year", null, ref);
    const b = res("current_month", "same_period_last_year", ref);
    const want = `${ref.getFullYear() - 1}-${ref.getMonth()}`;
    const key = (d) => `${d.getFullYear()}-${d.getMonth()}`;
    return same(`${key(a.period.from)} ${key(a.period.to)} ${key(b.comparison.from)} ${key(b.comparison.to)}`, `${want} ${want} ${want} ${want}`);
  });
}

section("D. legacy chat tools + REST analytics API (tools.resolvePeriod / resolveComparisonPeriods)");
{
  sweep("period previous_month = whole previous month (legacy chat tool AND the dashboard API)", (ref) => {
    const [y, m] = addMonths(ref.getFullYear(), ref.getMonth(), -1);
    return same(range(tools.resolvePeriod({ period: "previous_month" }, ref)), range(wholeMonth(y, m)));
  });
  sweep("comparisonType vs_previous_month / vs_same_month_last_year compare month-to-date with the right months", (ref) => {
    const [y, m] = addMonths(ref.getFullYear(), ref.getMonth(), -1);
    const a = tools.resolveComparisonPeriods("vs_previous_month", ref);
    const b = tools.resolveComparisonPeriods("vs_same_month_last_year", ref);
    const k = (d) => `${d.getFullYear()}-${d.getMonth()}`;
    return same(`${k(a.previous.from)} ${k(a.previous.to)} ${k(b.previous.from)} ${k(b.previous.to)}`, `${y}-${m} ${y}-${m} ${ref.getFullYear() - 1}-${ref.getMonth()} ${ref.getFullYear() - 1}-${ref.getMonth()}`);
  });
  const src = require("fs").readFileSync(require.resolve("./src/controllers/analyticsController.js"), "utf8");
  check("the dashboard API resolves periods through the same tested functions (tools.resolvePeriod, dateRanges.lastNMonthsEnding)", /resolvePeriod\(\{ period, from: query\.from, to: query\.to \}, referenceDate\)/.test(src) && /dateRanges\.lastNMonthsEnding\(referenceDate, 6\)/.test(src));
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
