const { unwrapJsonExValue } = require("../parser/tallyParser");

// --------------------------------------------------
// Company ownership guard: the one place that decides whether data Tally just
// returned belongs to the tenant's own company.
//
// Why it exists: TallyPrime can have several companies open at once, and its
// voucher and master queries answer for whichever company is *selected*, not
// for the company a tenant is configured with. Confirming that a tenant's GUID
// is somewhere in the open-company list (tallyCompanyGuard) therefore does not
// prove the data in a response is that tenant's. Every Tally voucher GUID is
// "<companyGuid>-<masterId>", so the response itself says whose it is.
//
// The invariant: Tally data may only reach a tenant's MongoDB state after the
// WHOLE batch has been checked against the tenant's configured company GUID
// (from the application's Company record - never from the response being
// checked). One foreign or unverifiable item rejects the whole batch, before
// anything is written or any checkpoint is considered.
//
// Pure and synchronous: no I/O, O(n) over the batch, no copies of the batch.
// Nothing here logs a voucher body; diagnostics carry counts and truncated
// GUID prefixes only.
// --------------------------------------------------

const MASTER_ID_PATTERN = /^[0-9A-Za-z]+$/;
const SAMPLE_LIMIT = 3;

function guidText(value) {
  const unwrapped = unwrapJsonExValue(value);
  return typeof unwrapped === "string" ? unwrapped.trim() : "";
}

// "<companyGuid>-<masterId>": exact company GUID, then a hyphen, then a
// non-empty alphanumeric master id. Anything else is not this company's.
function classifyGuid(guid, expectedCompanyGuid) {
  if (!guid) return "missing";

  const prefix = `${expectedCompanyGuid}-`;

  if (!guid.startsWith(prefix)) {
    // Looks like a real Tally GUID of some other company, or garbage.
    return guid.length > prefix.length && guid.includes("-") ? "foreign" : "malformed";
  }

  const masterId = guid.slice(prefix.length);
  return MASTER_ID_PATTERN.test(masterId) ? "ok" : "malformed";
}

// Short, non-sensitive label for logs: the first 8 characters of a GUID.
const shortGuid = (guid) => (guid ? `${guid.slice(0, 8)}...` : "(none)");

/**
 * Validate a batch of Tally items (vouchers, registry rows, ...) against the
 * tenant's company GUID.
 *
 * @param {Array} items - rows as returned by Tally; each carries a `guid`
 *   (raw JSONEx value or a plain string).
 * @param {string} expectedCompanyGuid - trusted, from the Company record.
 * @param {Object} [options]
 * @param {boolean} [options.rejectDuplicates=false] - also reject a batch that
 *   lists the same GUID twice (a registry/GUID list must not).
 * @returns {{ok: boolean, total: number, foreign: number, missing: number,
 *   malformed: number, duplicates: number, reason: string|null,
 *   sample: string[]}}
 */
function validateBatchOwnership(items, expectedCompanyGuid, { rejectDuplicates = false } = {}) {
  const result = {
    ok: false,
    total: Array.isArray(items) ? items.length : 0,
    foreign: 0,
    missing: 0,
    malformed: 0,
    duplicates: 0,
    reason: null,
    sample: [],
  };

  // The trusted GUID is a precondition, not something to be defaulted: without
  // it nothing can be proven, so nothing is accepted.
  if (typeof expectedCompanyGuid !== "string" || !expectedCompanyGuid.trim()) {
    result.reason = "No trusted company GUID is configured for this tenant; refusing to accept Tally data.";
    return result;
  }

  if (!Array.isArray(items)) {
    result.reason = "Tally returned no readable list to verify.";
    return result;
  }

  const seen = rejectDuplicates ? new Set() : null;

  for (const item of items) {
    const guid = guidText(item && item.guid);
    const kind = classifyGuid(guid, expectedCompanyGuid);

    if (kind !== "ok") {
      result[kind] += 1;
      if (result.sample.length < SAMPLE_LIMIT) result.sample.push(shortGuid(guid));
      continue;
    }

    if (seen) {
      if (seen.has(guid)) result.duplicates += 1;
      else seen.add(guid);
    }
  }

  const bad = result.foreign + result.missing + result.malformed + result.duplicates;

  if (bad > 0) {
    result.reason =
      `Company mismatch: ${bad} of ${result.total} item(s) in this Tally response do not belong to the configured company ` +
      `(foreign=${result.foreign}, missing=${result.missing}, malformed=${result.malformed}, duplicates=${result.duplicates}). ` +
      "The whole batch was rejected; nothing was written.";
    return result;
  }

  result.ok = true;
  return result;
}

/**
 * Like validateBatchOwnership, but throws a CompanyMismatchError (with the
 * diagnostics attached) when the batch is not entirely the company's own.
 */
class CompanyMismatchError extends Error {
  constructor(validation, context) {
    super(validation.reason);
    this.name = "CompanyMismatchError";
    this.code = "COMPANY_MISMATCH";
    this.validation = validation;
    this.context = context || {};
  }
}

function assertBatchOwnership(items, expectedCompanyGuid, context, options) {
  const validation = validateBatchOwnership(items, expectedCompanyGuid, options);

  if (!validation.ok) {
    logMismatch(validation, context);
    throw new CompanyMismatchError(validation, context);
  }

  return validation;
}

// One line, counts and truncated prefixes only - enough to diagnose, nothing
// about the vouchers themselves.
function logMismatch(validation, context = {}) {
  console.warn(
    `[companyOwnership] REJECTED batch tenant=${context.tenantId || "?"} company=${shortGuid(context.companyGuid)} ` +
      `source=${context.source || "?"} total=${validation.total} foreign=${validation.foreign} ` +
      `missing=${validation.missing} malformed=${validation.malformed} duplicates=${validation.duplicates} ` +
      `sample=[${validation.sample.join(",")}]`
  );
}

/**
 * Voucher-type MASTERS (and other master data) also follow Tally's selected
 * company. Requested with the Guid method, each master carries
 * "<companyGuid>-<masterId>" too (confirmed live: 39 of 39). A response is
 * accepted only if NO record carries another company's GUID and at least one
 * record positively carries this company's. Records with no GUID at all are
 * tolerated individually (some built-in masters may lack one) but a response
 * with no verifiable record at all is refused.
 */
function validateMasterOwnership(items, expectedCompanyGuid) {
  const result = {
    ok: false,
    total: Array.isArray(items) ? items.length : 0,
    foreign: 0,
    verified: 0,
    unverifiable: 0,
    reason: null,
    sample: [],
  };

  if (typeof expectedCompanyGuid !== "string" || !expectedCompanyGuid.trim()) {
    result.reason = "No trusted company GUID is configured for this tenant; refusing to accept Tally master data.";
    return result;
  }

  for (const item of Array.isArray(items) ? items : []) {
    const guid = guidText(item && item.guid);

    if (!guid) {
      result.unverifiable += 1;
      continue;
    }

    if (classifyGuid(guid, expectedCompanyGuid) === "ok") {
      result.verified += 1;
    } else {
      result.foreign += 1;
      if (result.sample.length < SAMPLE_LIMIT) result.sample.push(shortGuid(guid));
    }
  }

  if (result.foreign > 0) {
    result.reason =
      `Company mismatch: ${result.foreign} of ${result.total} master record(s) belong to a different company than the one configured. Not used.`;
    return result;
  }

  if (result.verified === 0) {
    result.reason = "Tally master data could not be tied to the configured company; not used.";
    return result;
  }

  result.ok = true;
  return result;
}

module.exports = {
  validateBatchOwnership,
  assertBatchOwnership,
  validateMasterOwnership,
  classifyGuid,
  logMismatch,
  CompanyMismatchError,
};
