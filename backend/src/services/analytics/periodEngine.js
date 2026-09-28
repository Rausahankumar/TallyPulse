const dateRanges = require("./dateRanges");

// --------------------------------------------------
// Deterministic, LLM-independent period resolution.
//
// This module resolves a period KIND STRING (e.g. "current_quarter",
// "fy:2025-26") to an exact {from, to} date range, plus - for every kind
// where a "vs what" comparison is natural - an exact {comparisonFrom,
// comparisonTo} range. All arithmetic; no Claude/LLM call anywhere in
// this file. The AI tool layer is NOT wired to this yet (deliberately -
// this phase is the foundation only, see the accompanying report).
//
// Conventions this module fixes, none of which the app configures
// anywhere else today (checked: the old Sales/Purchase Analytics "FY"
// dropdown was a cosmetic frontend label whose value never reached any
// date-math function) - each is a real judgment call, documented so a
// future reviewer can change it in exactly one place if the business
// means something different:
//   - Financial year: 1 April -> 31 March (India/Tally convention).
//   - Week: Monday -> Sunday (ISO 8601), not Sunday-start.
//   - Quarter: FINANCIAL-YEAR quarters (Apr-Jun/Jul-Sep/Oct-Dec/Jan-Mar),
//     not calendar quarters (Jan-Mar/Apr-Jun/Jul-Sep/Oct-Dec). Reviewed
//     and confirmed deliberately: GST return filing (GSTR-1 quarterly
//     scheme, QRMP) and TallyPrime's own default quarterly reporting for
//     Indian companies both align to FY quarters, not calendar quarters
//     - the less-surprising default for THIS product's actual users, even
//     though calendar quarters are the more common default in generic
//     software. So Q1 = Apr-Jun, Q2 = Jul-Sep, Q3 = Oct-Dec, Q4 = Jan-Mar
//     (Q4 belongs to the SAME financial year as the preceding Apr-Dec).
//   - YTD: CALENDAR year-to-date (1 Jan -> reference date), not
//     financial-year-to-date - chosen because "current financial year"
//     is already a separate, distinct period kind in the same list;
//     if YTD meant the same thing as current_fy there would be no
//     reason to list both.
//   - "last N days": a rolling window ENDING AT the reference date
//     (inclusive of "today so far"), not excluding today. E.g.
//     last_7_days on 16 Sep = [10 Sep, 16 Sep].
//
// Every period a caller can ask for follows the same "current_X is
// to-date/partial, previous_X is always complete" philosophy already
// established in dateRanges.js (see that file's own header comment) -
// applied here uniformly to week/quarter/FY, matching the FY behavior
// the spec itself gave as worked examples (current FY -> Apr 1 through
// reference date; previous FY -> Apr 1 through Mar 31 of previous FY).
// --------------------------------------------------

const FY_START_MONTH = 3; // 0-based: April

const PERIOD_KINDS = [
  "today",
  "yesterday",
  "current_week",
  "previous_week",
  "current_month",
  "previous_month",
  "same_month_last_year",
  "current_quarter",
  "previous_quarter",
  "current_fy",
  "previous_fy",
  "specific_fy",
  "custom",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "ytd",
];

// ---------- week ----------

function startOfWeek(date) {
  const d = dateRanges.startOfDay(date);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return d;
}

function endOfWeek(date) {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return dateRanges.endOfDay(end);
}

// ---------- quarter (financial-year aligned: Apr-Jun/Jul-Sep/Oct-Dec/Jan-Mar) ----------
//
// Note for whoever next touches this: switching from calendar quarters
// to FY quarters does NOT change any {from, to} boundary this module
// computes - it only changes which chunk is CALLED "Q1" and which
// financial year a Jan-Mar chunk is attributed to. That's because
// gcd(3, 12) = 3 and April (the FY start month) is itself a multiple of
// 3, so "every 3rd month starting from January" and "every 3rd month
// starting from April" land on the exact same four boundary dates
// (1 Jan, 1 Apr, 1 Jul, 1 Oct) either way. This module doesn't currently
// expose a quarter NUMBER/label anywhere (labels are generic, e.g.
// "Current quarter to date") - the FY-aligned numbering here exists so
// that if/when a quarter number or "Q2 FY2026-27"-style label IS added,
// it comes out FY-correct rather than calendar-numbered.

// Months since 1 April of this date's OWN financial year (see
// financialYearStartYear below) - 0 = April, 11 = March. Quarter index
// is then simply this offset divided by 3, unlike a calendar quarter
// which divides the raw calendar month by 3.
function fyMonthOffset(date) {
  const month = new Date(date).getMonth(); // 0=Jan..11=Dec
  return (month - FY_START_MONTH + 12) % 12;
}

function startOfQuarter(date) {
  const d = new Date(date);
  const startYear = financialYearStartYear(d);
  const qIdx = Math.floor(fyMonthOffset(d) / 3); // 0-3, 0=Apr-Jun
  const rawMonth = FY_START_MONTH + qIdx * 3; // 3,6,9,12 (12 = Jan of the next calendar year)
  const year = startYear + Math.floor(rawMonth / 12);
  const month = rawMonth % 12;
  return new Date(year, month, 1, 0, 0, 0, 0);
}

function endOfQuarter(date) {
  const start = startOfQuarter(date);
  // day 0 of (start's month + 3) = the real last day of a 3-month span,
  // regardless of which months those are (28/29/30/31 days) - same
  // "day 0 of next period" trick already used by endOfMonth/endOfQuarter
  // elsewhere in this codebase.
  return new Date(start.getFullYear(), start.getMonth() + 3, 0, 23, 59, 59, 999);
}

// Day fixed at 1 deliberately: the only thing ever read off this
// anchor downstream is its year/month (via startOfQuarter/endOfQuarter),
// never its day-of-month. Carrying the original day through (as a naive
// "new Date(y, m+delta, day)" would) risks a silent month rollover when
// the target month has fewer days than `day` (e.g. day 31 shifted into
// a 30-day month) - which would corrupt which quarter this resolves to.
function shiftQuarters(date, delta) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth() + delta * 3, 1);
}

// Shifts a date by whole months/years, clamping the day-of-month to the
// target month's real last day instead of letting it silently roll into
// the next month (JS's plain `new Date(y, m, day)` does this rollover,
// e.g. 29 Feb 2024 shifted +1 year becomes 1 Mar 2025, not 28 Feb 2025 -
// confirmed live in this investigation). dateRanges.shiftMonths/shiftYears
// now clamp the same way (they used to roll over, which broke
// previous_month on 29-31 Mar and 31 May/Jul/Oct/Dec); these two are
// kept as the period engine's own exported names.
function safeShiftMonths(date, deltaMonths) {
  const d = new Date(date);
  const day = d.getDate();
  const rawMonthIndex = d.getMonth() + deltaMonths;
  const targetYear = d.getFullYear() + Math.floor(rawMonthIndex / 12);
  const targetMonth = ((rawMonthIndex % 12) + 12) % 12;
  const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const safeDay = Math.min(day, daysInTargetMonth);
  return new Date(targetYear, targetMonth, safeDay, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

function safeShiftYears(date, deltaYears) {
  return safeShiftMonths(date, deltaYears * 12);
}

// ---------- financial year (Apr 1 -> Mar 31) ----------

// The FY "start year" a date falls in - e.g. any date from 1 Apr 2025
// through 31 Mar 2026 has FY start year 2025 ("FY 2025-26").
function financialYearStartYear(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  return d.getMonth() >= FY_START_MONTH ? y : y - 1;
}

function financialYearRange(startYear) {
  const from = new Date(startYear, FY_START_MONTH, 1, 0, 0, 0, 0);
  const to = new Date(startYear + 1, FY_START_MONTH, 0, 23, 59, 59, 999); // day 0 of the month after FY_START_MONTH next year = Mar 31
  return { from, to };
}

function financialYearLabel(startYear) {
  const endYY = String((startYear + 1) % 100).padStart(2, "0");
  return `FY ${startYear}-${endYY}`;
}

// Accepts a start year (number, e.g. 2025) or a label string
// ("FY 2025-26", "2025-26", "fy2025-26") and returns the FY start year
// as a number, validating the label's own two-digit end year is
// consistent (so "FY 2025-27" is rejected, not silently misparsed).
function parseFinancialYearInput(input) {
  if (typeof input === "number" && Number.isInteger(input)) return input;

  const text = String(input || "").trim();
  const match = text.match(/^(?:FY\s*)?(\d{4})[-\/](\d{2,4})$/i);
  if (!match) {
    throw new Error(`Invalid financial year "${input}". Expected a start year (e.g. 2025) or a label like "FY 2025-26".`);
  }

  const startYear = Number(match[1]);
  const endPart = match[2];
  const expectedEndYY = String((startYear + 1) % 100).padStart(2, "0");
  const givenEndYY = endPart.length === 4 ? String(Number(endPart) % 100).padStart(2, "0") : endPart.padStart(2, "0");

  if (givenEndYY !== expectedEndYY) {
    throw new Error(`Invalid financial year "${input}": "${match[1]}-${endPart}" is not a consistent one-year span (expected ${startYear}-${expectedEndYY}).`);
  }

  return startYear;
}

// ---------- rolling windows ----------

function lastNDays(referenceDate, n) {
  const to = referenceDate;
  const from = dateRanges.startOfDay(dateRanges.shiftDays(referenceDate, -(n - 1)));
  return { from, to };
}

// ---------- isPartial helper ----------

// True unless `to` already reached the full period's own natural end
// (same day) - matches currentMonthToDate's existing isPartial logic,
// generalized to any {to, naturalEnd} pair.
function isBeforeNaturalEnd(to, naturalEnd) {
  return (
    to.getFullYear() !== naturalEnd.getFullYear() ||
    to.getMonth() !== naturalEnd.getMonth() ||
    to.getDate() !== naturalEnd.getDate()
  );
}

// ============================================================
// resolvePeriod: kind -> {from, to, label, isPartial}
// ============================================================

function resolvePeriod(kind, referenceDate = new Date(), options = {}) {
  switch (kind) {
    case "today": {
      // isBeforeNaturalEnd (calendar-date-only comparison) can't be used
      // here: "today"'s own natural end is always the SAME calendar date
      // as `to`, by construction, so that check would always evaluate
      // false. Compare the actual instant instead - partial unless
      // referenceDate literally IS the last millisecond of the day.
      const dayEnd = dateRanges.endOfDay(referenceDate);
      return { from: dateRanges.startOfDay(referenceDate), to: referenceDate, label: "Today", isPartial: referenceDate.getTime() !== dayEnd.getTime() };
    }

    case "yesterday": {
      const y = dateRanges.shiftDays(referenceDate, -1);
      return { from: dateRanges.startOfDay(y), to: dateRanges.endOfDay(y), label: "Yesterday", isPartial: false };
    }

    case "current_week": {
      const from = startOfWeek(referenceDate);
      const naturalEnd = endOfWeek(referenceDate);
      return { from, to: referenceDate, label: "Current week to date", isPartial: isBeforeNaturalEnd(referenceDate, naturalEnd) };
    }

    case "previous_week": {
      const anchor = dateRanges.shiftDays(referenceDate, -7);
      return { from: startOfWeek(anchor), to: endOfWeek(anchor), label: "Previous week (complete)", isPartial: false };
    }

    case "current_month":
      return dateRanges.currentMonthToDate(referenceDate);

    case "previous_month":
      return dateRanges.previousFullMonth(referenceDate);

    case "same_month_last_year":
      return dateRanges.sameMonthLastYearToDate(referenceDate);

    case "current_quarter": {
      const from = startOfQuarter(referenceDate);
      const naturalEnd = endOfQuarter(referenceDate);
      return { from, to: referenceDate, label: "Current quarter to date", isPartial: isBeforeNaturalEnd(referenceDate, naturalEnd) };
    }

    case "previous_quarter": {
      const anchor = shiftQuarters(referenceDate, -1);
      return { from: startOfQuarter(anchor), to: endOfQuarter(anchor), label: "Previous quarter (complete)", isPartial: false };
    }

    case "current_fy": {
      const startYear = financialYearStartYear(referenceDate);
      const { from, to: naturalEnd } = financialYearRange(startYear);
      return { from, to: referenceDate, label: `${financialYearLabel(startYear)} (to date)`, isPartial: isBeforeNaturalEnd(referenceDate, naturalEnd) };
    }

    case "previous_fy": {
      const startYear = financialYearStartYear(referenceDate) - 1;
      const { from, to } = financialYearRange(startYear);
      return { from, to, label: `${financialYearLabel(startYear)} (complete)`, isPartial: false };
    }

    case "specific_fy": {
      const startYear = parseFinancialYearInput(options.fy);
      const { from, to } = financialYearRange(startYear);
      const isPartial = to > referenceDate;
      return { from, to, label: `${financialYearLabel(startYear)}${isPartial ? " (to date)" : " (complete)"}`, isPartial };
    }

    case "custom":
      if (!options.from || !options.to) {
        throw new Error('resolvePeriod: kind "custom" requires options.from and options.to.');
      }
      return dateRanges.customRange(options.from, options.to);

    case "last_7_days": {
      const { from, to } = lastNDays(referenceDate, 7);
      return { from, to, label: "Last 7 days", isPartial: true };
    }

    case "last_30_days": {
      const { from, to } = lastNDays(referenceDate, 30);
      return { from, to, label: "Last 30 days", isPartial: true };
    }

    case "last_90_days": {
      const { from, to } = lastNDays(referenceDate, 90);
      return { from, to, label: "Last 90 days", isPartial: true };
    }

    case "ytd": {
      const from = new Date(referenceDate.getFullYear(), 0, 1, 0, 0, 0, 0);
      const naturalEnd = new Date(referenceDate.getFullYear(), 11, 31, 23, 59, 59, 999);
      return { from, to: referenceDate, label: "Year to date (calendar)", isPartial: isBeforeNaturalEnd(referenceDate, naturalEnd) };
    }

    default:
      throw new Error(`resolvePeriod: unknown period kind "${kind}". Expected one of: ${PERIOD_KINDS.join(", ")}.`);
  }
}

// ============================================================
// resolveComparisonPeriod: kind -> {from, to} of the natural "vs what"
// period, or null when no single natural comparison exists.
// ============================================================

function resolveComparisonPeriod(kind, referenceDate = new Date(), options = {}) {
  switch (kind) {
    case "today": {
      const y = dateRanges.shiftDays(referenceDate, -1);
      return { from: dateRanges.startOfDay(y), to: dateRanges.endOfDay(y) };
    }

    case "yesterday": {
      const dby = dateRanges.shiftDays(referenceDate, -2);
      return { from: dateRanges.startOfDay(dby), to: dateRanges.endOfDay(dby) };
    }

    case "current_week": {
      const current = resolvePeriod("current_week", referenceDate);
      return { from: dateRanges.shiftDays(current.from, -7), to: dateRanges.shiftDays(current.to, -7) };
    }

    case "previous_week": {
      const current = resolvePeriod("previous_week", referenceDate);
      return { from: dateRanges.shiftDays(current.from, -7), to: dateRanges.shiftDays(current.to, -7) };
    }

    case "current_month":
      return dateRanges.previousMonthSameRange(referenceDate);

    case "previous_month": {
      const anchor = dateRanges.shiftMonths(referenceDate, -2);
      return { from: dateRanges.startOfMonth(anchor), to: dateRanges.endOfMonth(anchor) };
    }

    case "same_month_last_year":
      return null; // already itself a "vs last year" comparison target

    case "current_quarter": {
      const current = resolvePeriod("current_quarter", referenceDate);
      // NOT dateRanges.shiftPeriod: that helper's same-month clamp
      // assumes from/to fall in one calendar month (true for month-to-
      // date periods, false here - a quarter-to-date's from and to are
      // usually in different months). safeShiftMonths shifts each
      // boundary independently instead.
      return { from: safeShiftMonths(current.from, -3), to: safeShiftMonths(current.to, -3) };
    }

    case "previous_quarter": {
      const anchor = shiftQuarters(referenceDate, -2);
      return { from: startOfQuarter(anchor), to: endOfQuarter(anchor) };
    }

    case "current_fy": {
      const current = resolvePeriod("current_fy", referenceDate);
      // safeShiftYears, not shiftPeriod: same multi-month-span reason as
      // current_quarter above, plus the leap-day case (29 Feb shifted a
      // year into a non-leap year must clamp to 28 Feb, not roll to 1 Mar).
      return { from: safeShiftYears(current.from, -1), to: safeShiftYears(current.to, -1) };
    }

    case "previous_fy": {
      const startYear = financialYearStartYear(referenceDate) - 2;
      return financialYearRange(startYear);
    }

    case "specific_fy": {
      const startYear = parseFinancialYearInput(options.fy) - 1;
      return financialYearRange(startYear);
    }

    case "custom":
      return null; // no natural comparison for an arbitrary caller-supplied range

    case "last_7_days": {
      const from = dateRanges.startOfDay(dateRanges.shiftDays(referenceDate, -13));
      const to = dateRanges.endOfDay(dateRanges.shiftDays(referenceDate, -7));
      return { from, to };
    }

    case "last_30_days": {
      const from = dateRanges.startOfDay(dateRanges.shiftDays(referenceDate, -59));
      const to = dateRanges.endOfDay(dateRanges.shiftDays(referenceDate, -30));
      return { from, to };
    }

    case "last_90_days": {
      const from = dateRanges.startOfDay(dateRanges.shiftDays(referenceDate, -179));
      const to = dateRanges.endOfDay(dateRanges.shiftDays(referenceDate, -90));
      return { from, to };
    }

    case "ytd": {
      const current = resolvePeriod("ytd", referenceDate);
      return { from: safeShiftYears(current.from, -1), to: safeShiftYears(current.to, -1) };
    }

    default:
      throw new Error(`resolveComparisonPeriod: unknown period kind "${kind}". Expected one of: ${PERIOD_KINDS.join(", ")}.`);
  }
}

// ============================================================
// resolveSamePeriodLastYear: kind -> {from, to} of the SAME period
// exactly one year earlier - distinct from resolveComparisonPeriod,
// which for month/quarter/FY/week returns the natural MoM-style
// PRECEDING period, not YoY. Works uniformly for every kind (including
// "custom", where "same calendar dates last year" is the reasonable
// default) by shifting the period's own {from, to} back one year with
// safeShiftYears - no per-kind special-casing needed, and no new
// leap-year/month-length risk (safeShiftYears already guards that, see
// its own comment above).
// ============================================================

function resolveSamePeriodLastYear(kind, referenceDate = new Date(), options = {}) {
  const current = resolvePeriod(kind, referenceDate, options);
  return { from: safeShiftYears(current.from, -1), to: safeShiftYears(current.to, -1) };
}

// ============================================================
// resolvePeriodWithComparison: the one function most callers should
// use - {from, to, comparisonFrom, comparisonTo, label, isPartial}.
// comparisonFrom/comparisonTo are undefined (not present) when
// resolveComparisonPeriod returns null (custom range, same_month_last_year).
// ============================================================

function resolvePeriodWithComparison(kind, referenceDate = new Date(), options = {}) {
  const period = resolvePeriod(kind, referenceDate, options);
  const comparison = resolveComparisonPeriod(kind, referenceDate, options);

  return {
    from: period.from,
    to: period.to,
    label: period.label,
    isPartial: period.isPartial,
    ...(comparison ? { comparisonFrom: comparison.from, comparisonTo: comparison.to } : {}),
  };
}

module.exports = {
  PERIOD_KINDS,
  FY_START_MONTH,
  resolvePeriod,
  resolveComparisonPeriod,
  resolveSamePeriodLastYear,
  resolvePeriodWithComparison,
  financialYearStartYear,
  financialYearRange,
  financialYearLabel,
  parseFinancialYearInput,
  startOfWeek,
  endOfWeek,
  startOfQuarter,
  endOfQuarter,
  shiftQuarters,
  safeShiftMonths,
  safeShiftYears,
};
