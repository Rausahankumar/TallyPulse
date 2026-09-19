const Sale = require("../../models/sales.model");
const Purchase = require("../../models/purchase.model");
const {
  getPendingVoucherAlterIds,
  getVouchersByAlterIds,
  MAX_ALTERIDS_PER_RECOVERY_QUERY,
} = require("../odbc/odbcService");
const { extractVoucherCollection, processSingleVoucher } = require("../import/tallySalesImport");
const { processSinglePurchaseVoucher } = require("../import/tallyPurchaseImport");
const {
  parseTallyId,
  parseTallyBoolean,
  unwrapJsonExValue,
} = require("../parser/tallyParser");
const { verifyOpenTallyCompany } = require("../auth/tallyCompanyGuard");
const { resolveVoucherTypeClassification } = require("../tally/voucherTypeClassifier");
const { resolveBatchSize, findMissingAlterIds } = require("./batchWindow");

// --------------------------------------------------
// Missing-data recovery.
//
// Use case: Tally still holds vouchers whose MongoDB documents were deleted
// or never written, while the normal incremental checkpoint has already
// advanced past them - so incremental sync will never fetch them again.
//
// This is deliberately NOT a checkpoint reset. It compares what Tally has
// with what MongoDB has (same GUID identity the reconciliation worker uses),
// re-imports only the vouchers that are actually missing, and never reads or
// writes SyncCheckpoint - the normal sync's position, lock and status are
// untouched.
//
//   1. verify the company open in Tally is this company (same guard the
//      sync worker uses) and resolve its Sales/Purchase voucher types
//      (voucherTypeClassifier)
//   2. light registry query: every voucher of that class with GUID, AlterID
//      and cancelled flag - no inventory/ledger walk
//   3. missing = active (not cancelled/deleted) registry vouchers whose
//      {tenantId, tallyGuid} has no MongoDB document
//   4. apply only: fetch the missing ones in bounded batches by explicit
//      AlterID, require every requested AlterID back before writing anything
//      (same completeness rule as the sync worker), persist through the
//      existing parser -> mapper -> validation -> upsert pipeline (identity
//      {tenantId, tallyGuid}, so it cannot duplicate), and stop at the first
//      failed batch
//
// dry run (apply=false, the default) does steps 1-3 only and writes nothing.
// --------------------------------------------------

const RECOVERY_TARGETS = {
  Sales: {
    classificationKey: "sales",
    Model: Sale,
    processVoucher: processSingleVoucher,
  },
  Purchase: {
    classificationKey: "purchase",
    Model: Purchase,
    processVoucher: processSinglePurchaseVoucher,
  },
};

const MAX_BATCHES_CAP = 50;
const DEFAULT_MAX_BATCHES = 5;

// Overlapping recoveries for the same {tenant, voucher type} in this process
// are refused. (Writes are idempotent upserts so an overlap could not
// duplicate anything, but two concurrent runs would only waste Tally load.)
const inFlight = new Set();

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) return fallback;
  return Math.min(n, max);
}

function emptyResult(voucherType, apply) {
  return {
    status: null,
    voucherType,
    dryRun: !apply,
    reasonCode: null,
    reason: null,
    tally: { total: 0, cancelledOrDeleted: 0 },
    alreadyPresent: 0,
    outOfScope: 0,
    found: 0,
    recovered: 0,
    skipped: 0,
    failed: 0,
    remainingMissing: 0,
    ignoredUnexpected: 0,
    batches: { attempted: 0, succeeded: 0, failed: 0 },
    errors: [],
  };
}

function aborted(result, reasonCode, reason) {
  return { ...result, status: "aborted", reasonCode, reason };
}

const asString = (value) => {
  const v = unwrapJsonExValue(value);
  return v === undefined || v === null ? "" : String(v).trim();
};

async function recoverMissingVouchers({
  company,
  voucherType,
  apply = false,
  batchSize,
  maxBatches,
  upToAlterId,
  maxMissing,
  deps = {},
}) {
  const target = RECOVERY_TARGETS[voucherType];

  if (!target) {
    throw new Error(`Unsupported voucher type "${voucherType}" (expected Sales or Purchase).`);
  }

  const result = emptyResult(voucherType, apply);
  const tenantId = company.tenantId;
  const companyGuid = company.companyGuid;
  const baseUrl = (company.tallyConnection && company.tallyConnection.baseUrl) || undefined;

  const fetchRegistry = deps.fetchRegistry || getPendingVoucherAlterIds;
  const fetchByAlterIds = deps.fetchByAlterIds || getVouchersByAlterIds;

  const lockKey = `${tenantId}:${voucherType}`;

  if (inFlight.has(lockKey)) {
    return aborted(result, "already_running", `A ${voucherType} recovery is already running for this company.`);
  }

  inFlight.add(lockKey);

  try {
    // Company guard: never recover into a tenant from whichever company
    // happens to be open in Tally.
    const guard = await verifyOpenTallyCompany(companyGuid, { baseUrl });

    if (!guard.ok) {
      return aborted(result, guard.reason === "unreachable" ? "tally_unreachable" : "company_mismatch", guard.message);
    }

    const classification = await resolveVoucherTypeClassification({ companyGuid, baseUrl });
    const classResult = classification[target.classificationKey];

    if (!classResult || classResult.status !== "ok") {
      const prefix =
        classResult && classResult.status === "needs_configuration"
          ? "NEEDS_CONFIGURATION"
          : "CLASSIFICATION_ERROR";

      return aborted(
        result,
        prefix.toLowerCase(),
        `${prefix}: ${(classResult && classResult.reason) || `Could not resolve ${voucherType} voucher types.`}`
      );
    }

    const voucherTypeNames = classResult.typeNames;

    // ---- registry (light) ----
    let registryRows;

    try {
      const response = await fetchRegistry({
        afterAlterId: 0,
        baseUrl,
        voucherTypeNames,
        withCancelledFlag: true,
      });
      const payload = typeof response === "string" ? JSON.parse(response) : response;
      registryRows = extractVoucherCollection(payload);
    } catch (error) {
      return aborted(result, "registry_fetch_failed", `Could not read the voucher list from Tally: ${error.message}`);
    }

    const registry = registryRows.map((row) => ({
      guid: asString(row && row.guid),
      alterId: parseTallyId(row && (row.alterid ?? row.alterId)),
      cancelledOrDeleted:
        parseTallyBoolean(row && (row.iscancelled ?? row.isCancelled)) ||
        parseTallyBoolean(row && (row.isdeleted ?? row.isDeleted)),
    }));

    if (registry.some((r) => !r.guid || r.alterId === null)) {
      return aborted(
        result,
        "registry_unreadable",
        "Tally returned vouchers without a readable GUID or AlterID; refusing to compare."
      );
    }

    result.tally.total = registry.length;
    result.tally.cancelledOrDeleted = registry.filter((r) => r.cancelledOrDeleted).length;

    // ---- what MongoDB already has (this tenant only, any status) ----
    const existingDocs = await target.Model.find({
      tenantId,
      tallyGuid: { $type: "string" },
    })
      .select("tallyGuid")
      .lean();
    const existingGuids = new Set(existingDocs.map((d) => d.tallyGuid));

    const active = registry.filter((r) => !r.cancelledOrDeleted);

    // Optional scope: only vouchers at or below `upToAlterId` (the incremental
    // sync's checkpoint) count. Anything above it is still ahead of the normal
    // sync, which will fetch it itself, so the automatic self-heal leaves it
    // alone. Manual recovery passes nothing and covers everything.
    const scoped =
      upToAlterId === undefined || upToAlterId === null
        ? active
        : active.filter((r) => r.alterId <= upToAlterId);
    const missing = scoped
      .filter((r) => !existingGuids.has(r.guid))
      .sort((a, b) => a.alterId - b.alterId);

    result.outOfScope = active.length - scoped.length;
    result.alreadyPresent = scoped.length - missing.length;
    result.found = missing.length;
    result.remainingMissing = missing.length;

    if (!apply) {
      result.status = "dry_run";
      return result;
    }

    // Guardrail for unattended callers: a gap larger than this is not
    // repaired automatically, it is reported for a person to look at.
    if (Number.isFinite(maxMissing) && missing.length > maxMissing) {
      return aborted(
        result,
        "too_many_missing",
        `${missing.length} vouchers are missing (limit for automatic recovery is ${maxMissing}). Run recovery manually.`
      );
    }

    if (missing.length === 0) {
      result.status = "completed";
      return result;
    }

    // ---- bounded recovery ----
    const size = Math.min(resolveBatchSize(batchSize), MAX_ALTERIDS_PER_RECOVERY_QUERY);
    const batchLimit = clampInt(maxBatches, DEFAULT_MAX_BATCHES, 1, MAX_BATCHES_CAP);
    const resolved = new Set(); // GUIDs settled this run (recovered / already there / skipped)
    let stopped = false;

    for (let b = 0; b < batchLimit && !stopped; b += 1) {
      const batch = missing.filter((r) => !resolved.has(r.guid)).slice(0, size);
      if (batch.length === 0) break;

      result.batches.attempted += 1;

      const expectedAlterIds = batch.map((r) => r.alterId);
      const expectedGuids = new Set(batch.map((r) => r.guid));
      let vouchers;

      try {
        const response = await fetchByAlterIds({ alterIds: expectedAlterIds, baseUrl, voucherTypeNames });
        const payload = typeof response === "string" ? JSON.parse(response) : response;
        vouchers = extractVoucherCollection(payload);
      } catch (error) {
        result.batches.failed += 1;
        result.errors.push(`Tally fetch failed: ${error.message}`);
        stopped = true;
        break;
      }

      // Fetch completeness, before anything is written.
      const returnedAlterIds = vouchers
        .map((v) => parseTallyId(v && (v.alterid ?? v.alterId)))
        .filter((id) => id !== null);
      const missingIds = findMissingAlterIds(expectedAlterIds, returnedAlterIds);

      if (missingIds.length > 0) {
        result.batches.failed += 1;
        result.errors.push(
          `Incomplete Tally fetch: ${missingIds.length} of ${expectedAlterIds.length} requested AlterID(s) were not returned (first missing: ${missingIds[0]}). Nothing from this batch was written.`
        );
        stopped = true;
        break;
      }

      let batchFailed = 0;

      for (const voucher of vouchers) {
        const guid = asString(voucher && voucher.guid);

        if (!expectedGuids.has(guid)) {
          result.ignoredUnexpected += 1;
          continue;
        }

        const outcome = await target.processVoucher(voucher, tenantId);

        if (outcome.status === "failed") {
          batchFailed += 1;
          result.failed += 1;
          if (result.errors.length < 5) result.errors.push(outcome.message);
          continue;
        }

        resolved.add(guid);

        if (outcome.status === "created") {
          result.recovered += 1;
        } else if (outcome.status === "skipped") {
          result.skipped += 1;
        } else {
          // updated / duplicate: a document appeared since the comparison
          // (e.g. the incremental sync wrote it) - counted as present, not
          // as recovered, and no second document exists.
          result.alreadyPresent += 1;
        }
      }

      if (batchFailed > 0) {
        result.batches.failed += 1;
        stopped = true;
      } else {
        result.batches.succeeded += 1;
      }
    }

    result.remainingMissing = missing.filter((r) => !resolved.has(r.guid)).length;

    if (result.failed === 0 && result.errors.length === 0 && result.remainingMissing === 0) {
      result.status = "completed";
    } else {
      result.status = result.recovered > 0 || result.skipped > 0 ? "partial" : "failed";

      if (result.errors.length > 0) {
        result.reasonCode = "batch_failed";
        result.reason = result.errors[0];
      } else if (result.remainingMissing > 0) {
        result.reasonCode = "batch_limit";
        result.reason = `Batch limit reached with ${result.remainingMissing} voucher(s) still missing; run recovery again to continue.`;
        result.status = "partial";
      }
    }

    return result;
  } finally {
    inFlight.delete(lockKey);
  }
}

module.exports = {
  recoverMissingVouchers,
  RECOVERY_TARGETS,
  DEFAULT_MAX_BATCHES,
  MAX_BATCHES_CAP,
};
