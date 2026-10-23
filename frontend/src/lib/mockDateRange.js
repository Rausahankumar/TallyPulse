// --------------------------------------------------
// Makes the date-range filter actually do something against the mock
// data architecture (no analytics API exists yet — see MockDataBanner
// — so there's nothing real to query). The monthly mock series (Apr
// through Sep) are anchored to a fixed reference year so a selected
// {from, to} range can genuinely include/exclude points and the
// screen visibly changes — this is a real, working filter over
// sample data, not a decorative one.
// --------------------------------------------------
export const MOCK_SERIES_YEAR = 2026;
const MONTH_INDEX = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

export function monthLabelToDate(label) {
  return new Date(MOCK_SERIES_YEAR, MONTH_INDEX[label] ?? 0, 1);
}

export const DEFAULT_RANGE = {
  from: new Date(MOCK_SERIES_YEAR, 3, 1), // 01 Apr
  to: new Date(MOCK_SERIES_YEAR, 8, 17), // 17 Sep — matches "today" used elsewhere in the mock data
};

// Builds the yyyy-mm-dd string from LOCAL date parts. `toISOString()`
// converts to UTC first, which silently shifts the displayed date back
// a day for anyone east of UTC (e.g. IST) — found by QA: opening the
// picker on a 01 Apr range showed 31 Mar in the input.
export function toDateInputValue(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Parses a yyyy-mm-dd input value as a LOCAL date, matching
// toDateInputValue above. `new Date("yyyy-mm-dd")` parses as UTC
// midnight instead, which shifts the day for anyone west of UTC.
export function parseDateInputValue(value) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function formatRangeLabel({ from, to }) {
  const fmt = (d) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  return `${fmt(from)} – ${fmt(to)}`;
}

const SHORT_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Formats a Date as "1-May-2025" — the typed format the date-range
// fields display and accept (see parseTypedDate below).
export function formatTypedDate(date) {
  const day = date.getDate();
  const month = date.toLocaleDateString("en-GB", { month: "short" });
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

// Parses text like "1-May-2025", "1 may 2025" or "01/May/2025" as a
// LOCAL date. Returns null for anything that doesn't match or isn't a
// real calendar date (e.g. "31-Feb-2025"), so callers can fall back to
// the last known-good value instead of silently accepting garbage.
export function parseTypedDate(text) {
  if (!text) return null;
  const match = text.trim().match(/^(\d{1,2})\s*[-/\s]\s*([a-zA-Z]+)\s*[-/\s]\s*(\d{4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const monthIndex = SHORT_MONTHS.indexOf(match[2].slice(0, 3).toLowerCase());
  const year = Number(match[3]);
  if (monthIndex === -1) return null;

  const date = new Date(year, monthIndex, day);
  if (date.getMonth() !== monthIndex || date.getDate() !== day) return null; // rejects overflow, e.g. 31-Feb
  return date;
}

// Keeps only the monthly points whose month overlaps [from, to].
export function filterMonthlySeries(series, range, labelKey = "label") {
  if (!range) return series;
  const { from, to } = range;
  return series.filter((point) => {
    const monthStart = monthLabelToDate(point[labelKey]);
    const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
    return monthEnd >= from && monthStart <= to;
  });
}

// Recomputes a simple sum-based KPI total from a filtered series so
// the headline numbers move together with the chart instead of
// staying frozen while the chart below them changes.
export function sumBy(series, key) {
  return series.reduce((total, point) => total + (Number(point[key]) || 0), 0);
}
