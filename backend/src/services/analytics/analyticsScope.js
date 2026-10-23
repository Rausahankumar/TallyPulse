// --------------------------------------------------
// The one mandatory gate every analytics query must pass through:
//
//   Tenant Scope -> Valid/Active Voucher Scope -> Date Scope -> Aggregation
//
// This exists so correctness (tenant isolation, excluding cancelled/
// deleted vouchers) does NOT depend on every analytics function
// remembering to add `voucherStatus: "active"` and `tenantId` to every
// query by hand. Every function in analyticsEngine.js builds its $match
// stage by calling buildVoucherMatchStage() - never by hand-assembling
// {tenantId, ...} itself.
//
// Fails closed: a missing/invalid tenantId throws rather than silently
// building a query that would match every tenant's data. This is a
// deliberate security invariant, not an oversight - a coding mistake
// that forgets to pass tenantId must be impossible to turn into a
// cross-tenant data leak.
// --------------------------------------------------

const dateRanges = require("./dateRanges");

const VALID_STATUSES = ["active", "cancelled", "deleted"];

// Default analytics scope: only vouchers Tally currently considers real
// and in force. Cancelled/deleted vouchers are excluded unless a caller
// explicitly opts in (e.g. a future "audit trail" view) - never by
// default, and never by omission.
const DEFAULT_STATUSES = ["active"];

function assertTenantId(tenantId) {
  if (typeof tenantId !== "string" || !tenantId.trim()) {
    throw new Error(
      "analyticsScope: tenantId is required and must be a non-empty string. Refusing to build a tenant-less analytics query."
    );
  }
}

function assertValidStatuses(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    throw new Error(
      "analyticsScope: statuses must be a non-empty array when provided."
    );
  }

  const invalid = statuses.filter((s) => !VALID_STATUSES.includes(s));
  if (invalid.length > 0) {
    throw new Error(
      `analyticsScope: invalid voucherStatus value(s): ${invalid.join(", ")}. Valid values: ${VALID_STATUSES.join(", ")}.`
    );
  }
}

// A bound is a PERIOD BOUNDARY: a local calendar day (what periodEngine/dateRanges produce, or a YYYY-MM-DD string). Voucher dates are
// stored as UTC midnight of their Tally date, so the bound is converted to the stored form of its calendar day (see dateRanges) - a
// raw instant comparison would move vouchers across a period edge by the server's UTC offset.
function normalizeDateBound(value, label, edge) {
  if (value === undefined || value === null) return null;

  const parsed = value instanceof Date ? value : dateRanges.parseCalendarDay(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`analyticsScope: invalid ${label} date: "${value}".`);
  }

  return edge === "end" ? dateRanges.storedDayEnd(parsed) : dateRanges.storedDayStart(parsed);
}

/**
 * Build the mandatory MongoDB $match stage for any company-owned
 * analytics query (Sale or Purchase).
 *
 * @param {Object} options
 * @param {string} options.tenantId - REQUIRED. Never optional, never
 *   inferred - callers must derive this server-side from the
 *   authenticated/authorized company context, never from user or AI
 *   input.
 * @param {Date|string} [options.from] - inclusive lower bound on
 *   header.voucherDate: the first calendar day of the period.
 * @param {Date|string} [options.to] - inclusive upper bound on
 *   header.voucherDate: the last calendar day of the period.
 * @param {string[]} [options.statuses] - which voucherStatus values to
 *   include. Defaults to ["active"] only. Pass explicitly (e.g.
 *   ["active", "cancelled"]) only for views that genuinely need to see
 *   non-active vouchers (e.g. an audit/reconciliation report) - never
 *   for a headline financial total.
 * @returns {Object} a MongoDB match filter, safe to use as the first
 *   $match stage of an aggregation pipeline (or as a plain find()
 *   filter).
 */
function buildVoucherMatchStage({ tenantId, from, to, statuses } = {}) {
  assertTenantId(tenantId);

  const effectiveStatuses = statuses || DEFAULT_STATUSES;
  assertValidStatuses(effectiveStatuses);

  const match = {
    tenantId,
    voucherStatus: { $in: effectiveStatuses },
  };

  const fromDate = normalizeDateBound(from, "from", "start");
  const toDate = normalizeDateBound(to, "to", "end");

  if (fromDate || toDate) {
    match["header.voucherDate"] = {};
    if (fromDate) match["header.voucherDate"].$gte = fromDate;
    if (toDate) match["header.voucherDate"].$lte = toDate;
  }

  return match;
}

module.exports = {
  buildVoucherMatchStage,
  DEFAULT_STATUSES,
  VALID_STATUSES,
};
