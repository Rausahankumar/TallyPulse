const Sale = require("../../models/sales.model");
const Purchase = require("../../models/purchase.model");
const SyncCheckpoint = require("../../models/syncCheckpoint.model");
const { buildVoucherMatchStage } = require("./analyticsScope");

// --------------------------------------------------
// The reporting reference date ("today") and the synced coverage window.
//
// FINAL PRODUCT DECISION (2026-09-28, Semantic Foundation decision 1): the
// AI reporting reference date is the ACTUAL CURRENT DATE. Relative periods
// ("today", "this month", "this quarter", "this FY") end today. Vouchers
// dated after today (post-dated or mistyped - the data model cannot tell
// which: the voucher header has no post-dated/optional flag) never move
// "today" and are never inside a relative period; they are disclosed, and
// an explicit date range that names those dates still returns them.
//
// ONE rule, ONE place: every AI layer (planner validation,
// coverage, query engine, formatter notes, telemetry) takes the
// reference date from getTenantDateContext(), computed once per chat turn.
//
// A tenant whose data lags the clock is no longer hidden by moving "today"
// back to its last voucher: the coverage window says honestly that the
// period is not synced (analytics/coverage.js) instead of showing a zero.
//
// getTenantReferenceDate() - the REST dashboard/report anchor - keeps its
// earlier rule (latest active voucher across Sales + Purchase, the wall
// clock only without vouchers). Moving the dashboard to "today" is outside
// this decision's scope and needs its own confirmation
// (docs/SEMANTIC_FOUNDATION.md).
// --------------------------------------------------

const DAY = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
const valid = (d) => d instanceof Date && !Number.isNaN(d.getTime());
// Voucher dates are stored as UTC midnight of the Tally date and every period boundary is local time, so the
// end of today's LOCAL day includes every voucher dated today and none dated tomorrow.
const endOfLocalDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

// The earliest and latest active voucher date of one collection (two indexed lookups).
async function voucherDateBounds(Model, tenantId) {
  // A voucher without a date sorts first ascending; it bounds nothing.
  const match = { ...buildVoucherMatchStage({ tenantId }), "header.voucherDate": { $type: "date" } };
  const pick = (dir) => Model.findOne(match).sort({ "header.voucherDate": dir }).select({ "header.voucherDate": 1, _id: 0 }).lean();
  const [first, last] = await Promise.all([pick(1), pick(-1)]);
  const earliest = first && first.header && first.header.voucherDate ? new Date(first.header.voucherDate) : null;
  const latest = last && last.header && last.header.voucherDate ? new Date(last.header.voucherDate) : null;
  return { earliest, latest };
}

// The last successful incremental sync of this tenant (any voucher type). The incremental sync fetches every
// voucher altered in Tally up to that moment, whatever its date, so data is complete up to it.
async function lastSuccessfulSync(tenantId) {
  const rows = await SyncCheckpoint.find({ tenantId, lastSyncedAt: { $type: "date" } }).select({ lastSyncedAt: 1, _id: 0 }).lean();
  const times = rows.map((r) => new Date(r.lastSyncedAt).getTime()).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)) : null;
}

/**
 * The rule (pure). referenceDate = the end of today's local calendar day. Coverage = the first active voucher of
 * either type .. the later of the last active voucher and the last successful sync.
 * @param {{sales:{earliest,latest}, purchase:{earliest,latest}, lastSyncedAt?:Date|null}} bounds
 * @param {Date} now wall clock
 */
function buildDateContext(bounds, now) {
  const wallClock = new Date(now);
  const pickBounds = (b) => ({ earliest: valid(b && b.earliest) ? b.earliest : null, latest: valid(b && b.latest) ? b.latest : null });
  const sales = pickBounds(bounds.sales);
  const purchase = pickBounds(bounds.purchase);
  const lastSync = valid(bounds.lastSyncedAt) ? new Date(bounds.lastSyncedAt) : null;
  const latests = [sales.latest, purchase.latest].filter(Boolean).map((d) => d.getTime());
  const earliests = [sales.earliest, purchase.earliest].filter(Boolean).map((d) => d.getTime());
  const hasVouchers = latests.length > 0;
  const latestVoucher = hasVouchers ? new Date(Math.max(...latests)) : null;
  const referenceDate = endOfLocalDay(wallClock);
  const syncedThrough = hasVouchers ? new Date(Math.max(latestVoucher.getTime(), lastSync ? lastSync.getTime() : 0)) : null;
  return Object.freeze({
    referenceDate,
    source: "today",
    wallClock,
    latestVoucher,
    // vouchers dated after today exist: disclosed, never inside a relative period
    futureVouchers: !!latestVoucher && DAY(latestVoucher) > DAY(wallClock),
    coverage: Object.freeze({
      earliest: earliests.length ? new Date(Math.min(...earliests)) : null,
      latest: syncedThrough,
      lastSyncedAt: lastSync,
      sales: Object.freeze(sales),
      purchase: Object.freeze(purchase),
    }),
  });
}

/** The per-turn tenant date context: reference date (today) + synced coverage window. */
async function getTenantDateContext(tenantId, { now = new Date() } = {}) {
  const [sales, purchase, lastSyncedAt] = await Promise.all([voucherDateBounds(Sale, tenantId), voucherDateBounds(Purchase, tenantId), lastSuccessfulSync(tenantId)]);
  return buildDateContext({ sales, purchase, lastSyncedAt }, now);
}

/** REST dashboard/report anchor (unchanged rule, see the header): latest active voucher, else the wall clock. */
async function getTenantReferenceDate(tenantId) {
  const [sales, purchase] = await Promise.all([voucherDateBounds(Sale, tenantId), voucherDateBounds(Purchase, tenantId)]);
  const latests = [sales.latest, purchase.latest].filter(Boolean).map((d) => d.getTime());
  return latests.length ? new Date(Math.max(...latests)) : new Date();
}

module.exports = { getTenantReferenceDate, getTenantDateContext, buildDateContext };
