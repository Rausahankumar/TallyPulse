// --------------------------------------------------
// Period resolution for analytics comparisons.
//
// The correctness trap this exists to avoid: comparing a PARTIAL current
// month (month-to-date, since "today" is mid-month) against a FULL prior
// month produces a growth percentage that looks confidently wrong - e.g.
// "-40%" when the real story is just "the month isn't over yet." Every
// period this module returns is therefore always paired with an explicit
// `label` and `isPartial` flag, and every comparison compares like-for-
// like day-ranges (month-to-date vs the same day-range in the prior
// period), never a partial period against a complete one.
//
// All boundaries are inclusive-from / inclusive-to Date objects, meant
// to be passed straight into analyticsScope.buildVoucherMatchStage's
// {from, to}.
// --------------------------------------------------

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfMonth(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function endOfMonth(date) {
  const d = new Date(date);
  // day 0 of next month = last day of this month
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

// Shifts by whole months, CLAMPING the day-of-month to the target month's last day. A plain
// `new Date(y, m + delta, day)` rolls over instead (31 Mar - 1 month = "31 Feb" = 3 Mar), which made
// "previous month" resolve to the CURRENT month on 29-31 Mar, 31 May/Jul/Oct/Dec. Time of day is kept.
function shiftMonths(date, delta) {
  const d = new Date(date);
  const monthIndex = d.getMonth() + delta;
  const year = d.getFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(d.getDate(), lastDay), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

// Same clamp for years: 29 Feb 2024 - 1 year = 28 Feb 2023 (not 1 Mar 2023).
function shiftYears(date, delta) {
  return shiftMonths(date, delta * 12);
}

function shiftDays(date, delta) {
  const d = new Date(date);
  d.setDate(d.getDate() + delta);
  return d;
}

// Shift a whole {from, to} window back by N months/years, preserving the
// exact day-of-month range so a month-to-date window stays month-to-date
// in the shifted period, and a full-month window stays full-month.
// Clamps `to` to the shifted month's real last day (e.g. Jan 31 shifted
// back a month doesn't overflow into March).
function shiftPeriod({ from, to }, { months = 0, years = 0 } = {}) {
  const shift = (d) => {
    let out = new Date(d);
    if (years) out = shiftYears(out, years);
    if (months) out = shiftMonths(out, months);
    return out;
  };

  const shiftedFrom = shift(from);
  let shiftedTo = shift(to);

  // A `to` day that does not exist in the target month (31 Mar -> Feb) means "through the end of that
  // month": the whole last day, not the clamped day at `to`'s time of day.
  if (shiftedTo.getDate() !== new Date(to).getDate()) shiftedTo = endOfMonth(shiftedTo);

  // Clamp: never let `to` run past the month `from` shifted into.
  const monthEnd = endOfMonth(shiftedFrom);
  if (shiftedTo > monthEnd) {
    shiftedTo = monthEnd;
  }

  return { from: shiftedFrom, to: shiftedTo };
}

/**
 * Current month, month-to-date: [1st of this month, now]. Explicitly
 * partial unless `now` happens to be the last instant of the month.
 */
function currentMonthToDate(referenceDate = new Date()) {
  const from = startOfMonth(referenceDate);
  const to = referenceDate;
  const monthEnd = endOfMonth(referenceDate);

  // Partial unless `to` is on the same calendar day as the month's last
  // day (i.e. we're asking "this month" on the month's final day).
  const isPartial =
    to.getFullYear() !== monthEnd.getFullYear() ||
    to.getMonth() !== monthEnd.getMonth() ||
    to.getDate() !== monthEnd.getDate();

  return {
    from,
    to,
    label: "Month to date",
    isPartial,
  };
}

/**
 * The full previous calendar month: [1st, last day 23:59:59.999].
 * Always complete (a "previous" month, by definition, has already ended).
 */
function previousFullMonth(referenceDate = new Date()) {
  const prevMonthAnchor = shiftMonths(referenceDate, -1);
  return {
    from: startOfMonth(prevMonthAnchor),
    to: endOfMonth(prevMonthAnchor),
    label: "Previous month (complete)",
    isPartial: false,
  };
}

/**
 * The SAME day-range in the previous month as currentMonthToDate() -
 * i.e. if today is the 16th, this is [1st, 16th] of last month. This is
 * the correct comparison base for "how much did sales grow vs last
 * month" - comparing MTD to MTD, not MTD to a full month.
 */
function previousMonthSameRange(referenceDate = new Date()) {
  const current = currentMonthToDate(referenceDate);
  const shifted = shiftPeriod(current, { months: -1 });
  return {
    from: shifted.from,
    to: shifted.to,
    label: "Same date range, previous month",
    isPartial: false,
  };
}

/**
 * The same month-to-date window, one year earlier. E.g. if today is
 * 16 Sep 2026, this is [1 Sep 2025, 16 Sep 2025].
 */
function sameMonthLastYearToDate(referenceDate = new Date()) {
  const current = currentMonthToDate(referenceDate);
  const shifted = shiftPeriod(current, { years: -1 });
  return {
    from: shifted.from,
    to: shifted.to,
    label: "Same date range, same month last year",
    isPartial: false,
  };
}

/**
 * The full calendar month, same month, one year earlier. Used when the
 * comparison should be "the whole of that month" rather than MTD (e.g.
 * comparing two already-complete months).
 */
function sameFullMonthLastYear(referenceDate = new Date()) {
  const anchor = shiftYears(referenceDate, -1);
  return {
    from: startOfMonth(anchor),
    to: endOfMonth(anchor),
    label: "Same month last year (complete)",
    isPartial: false,
  };
}

/**
 * The last N complete calendar months ending in referenceDate's month
 * (inclusive) - e.g. n=6 with referenceDate in December returns
 * [1 Jul, 31 Dec]. Used as the default window for trend charts when the
 * caller hasn't picked an explicit range.
 */
function lastNMonthsEnding(referenceDate, n) {
  const to = endOfMonth(referenceDate);
  const from = startOfMonth(shiftMonths(referenceDate, -(n - 1)));
  return { from, to, label: `Last ${n} months`, isPartial: false };
}

/**
 * A caller-supplied custom range, validated and normalized to day
 * boundaries.
 */
function customRange(fromInput, toInput) {
  const from = startOfDay(new Date(fromInput));
  const to = endOfDay(new Date(toInput));

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("customRange: invalid from/to date.");
  }

  if (from > to) {
    throw new Error("customRange: from date must not be after to date.");
  }

  return { from, to, label: "Custom range", isPartial: false };
}

module.exports = {
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  shiftMonths,
  shiftYears,
  shiftDays,
  shiftPeriod,
  currentMonthToDate,
  previousFullMonth,
  previousMonthSameRange,
  sameMonthLastYearToDate,
  sameFullMonthLastYear,
  lastNMonthsEnding,
  customRange,
};
