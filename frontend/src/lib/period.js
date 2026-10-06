// Period hand-off between screens (Dashboard KPI -> Reports). Pure helpers, no network, no tenant data.

// The analytics API returns a period as UTC instants. Two boundary shapes occur (backend dateRanges):
//  - a SERVER-LOCAL day edge: `from` is local 00:00:00.000 of the first day; `to` of a custom/full period is local
//    23:59:59.999 of the last day. Reading these with the BROWSER's timezone would shift the day for any browser outside
//    the server's zone, so the server's UTC offset is recovered from the instant itself (its known local time of day)
//    and the calendar day is read at that offset.
//  - the tenant REFERENCE DATE, used as `to` of a month-to-date period: a voucher date (stored as UTC midnight, e.g.
//    2025-12-08T00:00:00.000Z) that is not an end-of-day instant; its calendar day is its UTC date (the voucher's day).
// The result is the exact "YYYY-MM-DD" day the backend meant, in every browser timezone.
const DAY_MS = 86400000;
const END_OF_DAY_MS = DAY_MS - 1;
const QUARTER_HOUR_MS = 900000;

const utcTimeOfDay = (t) => ((t % DAY_MS) + DAY_MS) % DAY_MS;
const offsetMs = (t, localTimeOfDayMs) => {
  let offset = (((localTimeOfDayMs - utcTimeOfDay(t)) % DAY_MS) + DAY_MS) % DAY_MS; // ms east of UTC, 0..DAY_MS
  if (offset > 14 * 3600000) offset -= DAY_MS; // UTC-12 .. UTC+14
  return offset;
};
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

function startDay(instant) {
  const t = new Date(instant).getTime();
  return Number.isNaN(t) ? null : isoDay(t + offsetMs(t, 0));
}
function endDay(instant) {
  const t = new Date(instant).getTime();
  if (Number.isNaN(t)) return null;
  // an end-of-day instant is x:14:59.999 / x:29:59.999 / x:44:59.999 / x:59:59.999 UTC (offsets are quarter hours)
  const endOfDay = (utcTimeOfDay(t) + 1) % QUARTER_HOUR_MS === 0;
  return endOfDay ? isoDay(t + offsetMs(t, END_OF_DAY_MS)) : isoDay(t);
}

/** {from, to} instants of an analytics period -> {from, to} "YYYY-MM-DD" (or null when it has no usable range). */
export function calendarDatesOf(period) {
  if (!period || !period.from || !period.to) return null;
  const from = startDay(period.from);
  const to = endDay(period.to);
  return from && to && from <= to ? { from, to } : null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDay(value) {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** "2025-08-01" -> "01 Aug 2025", read as a calendar day (never shifted by the browser's timezone). */
export function formatIsoDay(value) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}
export const formatIsoRange = (from, to) => `${formatIsoDay(from)} – ${formatIsoDay(to)}`;

export const REPORT_TABS = ["sales", "purchase"];

/** The Reports URL for a KPI's period. Only tab / from / to / source travel in the URL - never a tenant or company. */
export function buildReportsLink(tab, { from, to }) {
  return `/reports?${new URLSearchParams({ tab, from, to, source: "dashboard" }).toString()}`;
}

/** Reads and strictly validates the Reports deep link; anything unexpected -> null (normal Reports behaviour). */
export function readReportsDeepLink(searchParams) {
  const tab = searchParams.get("tab");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (!REPORT_TABS.includes(tab) || !isIsoDay(from) || !isIsoDay(to) || from > to) return null;
  return { tab, from, to, source: searchParams.get("source") === "dashboard" ? "dashboard" : null };
}
