const { extractVoucherCollection } = require("../import/tallySalesImport");
const { unwrapJsonExValue } = require("../parser/tallyParser");
const { validateBatchOwnership, logMismatch } = require("../tally/companyOwnership");

// --------------------------------------------------
// Reconciliation safety-net: catches deletions the AlterID incremental
// sync structurally cannot see.
//
// CONFIRMED against a live TallyPrime instance: a deleted voucher does
// not appear in ANY collection query (any AlterID threshold, including
// 0/"everything") and never carries $IsDeleted=true - it simply vanishes
// from Tally's own results. The incremental sync (tallySyncWorker.js,
// voucherPersistence.js) is therefore untouched by this file and cannot
// detect deletion on its own - this module is a separate mechanism:
//
//   fetch ALL current Tally voucher GUIDs (lightest possible query)
//     -> compare against all MongoDB-active voucher GUIDs for the same
//        tenant + voucherType
//     -> anything active in MongoDB but absent from Tally's complete
//        current set gets marked voucherStatus="deleted"
//        (never physically deleted - same convention as cancellation)
//
// FAIL-CLOSED, deliberately conservative: this function would rather do
// nothing than risk mass-marking real data deleted from a bad Tally
// response. See guards below.
// --------------------------------------------------

// If Tally's guid fetch returns fewer than this fraction of MongoDB's
// current active count, treat the response as suspicious (a bad/partial
// fetch, not a real mass deletion) and abort rather than apply. E.g. the
// default 0.5 means: reconciliation will happily mark 1, 2, or a few
// vouchers deleted, but will refuse to act on a response that would wipe
// out more than half of what MongoDB currently has active, since that
// shape is far more likely to be a truncated/broken Tally response than
// a real mass-deletion event in the business.
const DEFAULT_MAX_DELETE_RATIO =
  Number(process.env.RECONCILIATION_MAX_DELETE_RATIO) || 0.5;

function extractGuidSet(parsedPayload) {
  return guidSetFromRows(extractVoucherCollection(parsedPayload));
}

function guidSetFromRows(vouchers) {
  const guids = new Set();
  for (const voucher of vouchers) {
    const guid = unwrapJsonExValue(voucher && voucher.guid);
    if (typeof guid === "string" && guid.trim()) {
      guids.add(guid.trim());
    }
  }

  return guids;
}

/**
 * Run one reconciliation pass for a single {tenantId, voucherType,
 * Model}. Never throws - all outcomes are returned as a result object so
 * callers can log/record without special-casing errors.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.companyGuid - the tenant's configured Tally company;
 *   the GUID list is only trusted if every entry belongs to it
 * @param {import('mongoose').Model} params.Model - Sale or Purchase
 * @param {Function} params.fetchAllGuids - async ({baseUrl}) => Tally response
 * @param {string} [params.baseUrl]
 * @param {number} [params.maxDeleteRatio]
 */
async function reconcileVoucherType({
  tenantId,
  companyGuid,
  Model,
  fetchAllGuids,
  baseUrl,
  maxDeleteRatio = DEFAULT_MAX_DELETE_RATIO,
}) {
  // Step 1: fetch the complete current Tally guid set. Any error here
  // (network, timeout, malformed body) aborts immediately - nothing in
  // MongoDB is touched.
  let tallyResponse;
  try {
    tallyResponse = await fetchAllGuids({ baseUrl });
  } catch (error) {
    return {
      status: "failed",
      reason: `Tally fetch failed: ${error && error.message ? error.message : "unknown error"}`,
      tallyGuidCount: null,
      mongoActiveCount: null,
      markedDeletedCount: 0,
    };
  }

  let parsedPayload;
  try {
    parsedPayload =
      typeof tallyResponse === "string" ? JSON.parse(tallyResponse) : tallyResponse;
  } catch (error) {
    return {
      status: "failed",
      reason: `Tally response was not valid JSON: ${error.message}`,
      tallyGuidCount: null,
      mongoActiveCount: null,
      markedDeletedCount: 0,
    };
  }

  let tallyGuids;
  try {
    const rows = extractVoucherCollection(parsedPayload);

    // Company ownership first: a GUID list that is not entirely this
    // company's must never be read as "these vouchers were deleted". Nothing
    // is compared, marked or recorded beyond the aborted result.
    const ownership = validateBatchOwnership(rows, companyGuid);

    if (!ownership.ok) {
      logMismatch(ownership, { tenantId, companyGuid, source: "reconciliation" });
      return {
        status: "aborted_unsafe",
        reason: ownership.reason,
        tallyGuidCount: null,
        mongoActiveCount: null,
        markedDeletedCount: 0,
        companyMismatch: true,
      };
    }

    tallyGuids = guidSetFromRows(rows);
  } catch (error) {
    return {
      status: "failed",
      reason: `Could not extract voucher GUIDs from the Tally response: ${error.message}`,
      tallyGuidCount: null,
      mongoActiveCount: null,
      markedDeletedCount: 0,
    };
  }

  // Step 2: fetch the current MongoDB-active guid set. Only documents
  // that both are currently "active" AND carry a real tallyGuid are
  // candidates - guid-less legacy documents (see voucherPersistence.js)
  // have no comparable identity here and are deliberately left alone by
  // this mechanism, same as everywhere else in this codebase.
  //
  // Wrapped like the Tally-fetch steps above: a Mongo error here (e.g. a
  // connection blip) must return a "failed" result, not throw - otherwise
  // the caller's lock-release never runs and the next scheduled run stays
  // blocked until the stale-lock timeout instead of retrying immediately.
  let mongoActiveDocs;
  try {
    mongoActiveDocs = await Model.find({
      tenantId,
      voucherStatus: "active",
      tallyGuid: { $type: "string" },
    })
      .select("tallyGuid")
      .lean();
  } catch (error) {
    return {
      status: "failed",
      reason: `Reading active vouchers from MongoDB failed: ${error && error.message ? error.message : "unknown error"}`,
      tallyGuidCount: tallyGuids.size,
      mongoActiveCount: null,
      markedDeletedCount: 0,
    };
  }

  const mongoActiveGuids = mongoActiveDocs.map((d) => d.tallyGuid);

  // Step 3: fail-closed safety guards, BEFORE any comparison result is
  // trusted enough to act on.
  //
  // Guard A: an empty Tally result while MongoDB has active vouchers is
  // exactly the "unexpected empty result must never cause mass deletion"
  // case called out explicitly - refuse outright rather than treat an
  // empty set as "everything was deleted."
  if (tallyGuids.size === 0 && mongoActiveGuids.length > 0) {
    return {
      status: "aborted_unsafe",
      reason: `Tally returned zero vouchers, but MongoDB has ${mongoActiveGuids.length} active - this looks like a bad/empty response, not a real mass deletion. Refusing to reconcile.`,
      tallyGuidCount: 0,
      mongoActiveCount: mongoActiveGuids.length,
      markedDeletedCount: 0,
    };
  }

  const missingGuids = mongoActiveGuids.filter((g) => !tallyGuids.has(g));

  // Guard B: even a non-empty response could be partial/truncated. If
  // the fraction of currently-active vouchers this run would mark
  // deleted exceeds the safety ratio, treat it as suspicious rather than
  // apply it automatically.
  if (
    mongoActiveGuids.length > 0 &&
    missingGuids.length / mongoActiveGuids.length > maxDeleteRatio
  ) {
    return {
      status: "aborted_unsafe",
      reason: `This run would mark ${missingGuids.length} of ${mongoActiveGuids.length} active vouchers deleted (> ${Math.round(maxDeleteRatio * 100)}% threshold) - this looks like a partial/bad Tally response rather than a real mass deletion. Refusing to reconcile automatically; needs manual review.`,
      tallyGuidCount: tallyGuids.size,
      mongoActiveCount: mongoActiveGuids.length,
      markedDeletedCount: 0,
    };
  }

  // Step 4: safe to apply. A single bulk update, not N individual
  // writes - avoids N+1 entirely regardless of how many vouchers are
  // involved.
  //
  // Same reasoning as Step 2's try/catch: if the write itself fails
  // (e.g. MongoDB connection drops between the read and the write), this
  // must come back as a "failed" result rather than throw. Nothing has
  // been applied at this point - either updateMany never executes, or a
  // driver-level error means Mongo did not confirm the write - so there
  // is no partial-state risk to reconcile; the next run simply retries
  // the same diff from scratch.
  let markedDeletedCount = 0;
  if (missingGuids.length > 0) {
    try {
      const updateResult = await Model.updateMany(
        { tenantId, tallyGuid: { $in: missingGuids }, voucherStatus: "active" },
        { $set: { voucherStatus: "deleted" } }
      );
      markedDeletedCount = updateResult.modifiedCount || 0;
    } catch (error) {
      return {
        status: "failed",
        reason: `Marking deleted vouchers in MongoDB failed: ${error && error.message ? error.message : "unknown error"}`,
        tallyGuidCount: tallyGuids.size,
        mongoActiveCount: mongoActiveGuids.length,
        markedDeletedCount: 0,
      };
    }
  }

  return {
    status: "success",
    reason: null,
    tallyGuidCount: tallyGuids.size,
    mongoActiveCount: mongoActiveGuids.length,
    markedDeletedCount,
    markedDeletedGuids: missingGuids,
    // The exact set Tally reported (cancelled vouchers included). The
    // self-heal step diffs it against MongoDB by GUID; it is never persisted.
    tallyGuids,
  };
}

module.exports = {
  reconcileVoucherType,
  extractGuidSet,
  DEFAULT_MAX_DELETE_RATIO,
};
