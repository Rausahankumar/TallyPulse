const Sale = require("../../models/sales.model");
const Purchase = require("../../models/purchase.model");
const { getVouchersByAlterIds, MAX_ALTERIDS_PER_RECOVERY_QUERY } = require("../odbc/odbcService");
const { extractVoucherCollection } = require("../import/tallySalesImport");
const { parseTallyVoucher, parseTallyId, unwrapJsonExValue } = require("../parser/tallyParser");
const { verifyOpenTallyCompany } = require("../auth/tallyCompanyGuard");
const { resolveVoucherTypeClassification } = require("../tally/voucherTypeClassifier");
const { validateBatchOwnership, logMismatch } = require("../tally/companyOwnership");
const { resolveBatchSize, findMissingAlterIds } = require("./batchWindow");
const { storedDayStart, storedDayEnd, parseCalendarDay } = require("../analytics/dateRanges");

// --------------------------------------------------
// Back-fill of line details for vouchers that are ALREADY stored.
//
// Why: the voucher parser used to drop two things Tally sends on every item line - the discount percentage and (when asked
// for) the computed GST amounts - so every voucher synced before that fix has discount 0/0 and no `gst.amounts`. The
// incremental sync will not re-read them (their AlterID has not changed), so this reads them once more, by explicit AlterID.
//
// What it may write: ONLY three things per item line - discountPercentage, discountAmount and the `gst` snapshot
// (a whitelist, enforced below and tested). It also COUNTS, without writing, lines whose billed quantity differs from the actual one. It never touches amount, quantity, rate, item name, the header, the ledgers,
// the voucher status or the AlterID, so invoice totals and every revenue figure are exactly what they were.
//
// Safety (same discipline as voucher recovery, which it mirrors):
//   - the company open in Tally must be this tenant's company; Sales/Purchase types come from the VoucherType master
//   - every fetched voucher must belong to this company's GUID, or nothing is written
//   - a stored voucher is only enriched when it is still the SAME version: Tally's AlterID equals the stored one, and every
//     line matches (item, quantity, amount). A voucher edited since is left to the normal sync; a mismatch is reported.
//   - the write is conditional on {tenantId, tallyGuid, tallyAlterId}, so a voucher the sync updated meanwhile is not touched
//   - bounded: at most `maxBatches` requests of `batchSize` AlterIDs per run, one request at a time, resumable by cursor
//   - dry run (the default) reads Tally and MongoDB and writes nothing
// --------------------------------------------------

const TARGETS = {
  Sales: { classificationKey: "sales", Model: Sale },
  Purchase: { classificationKey: "purchase", Model: Purchase },
};

const DEFAULT_MAX_BATCHES = 5;
const MAX_BATCHES_CAP = 50;
const ALLOWED_SET_PATH = /^inventory\.\d+\.(discountPercentage|discountAmount|gst)$/;

const clampInt = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min ? Math.min(n, max) : fallback;
};
const asString = (value) => {
  const v = unwrapJsonExValue(value);
  return v === undefined || v === null ? "" : String(v).trim();
};
const near = (a, b, eps) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;

function emptyResult(voucherType, apply) {
  return {
    status: null,
    voucherType,
    dryRun: !apply,
    reasonCode: null,
    reason: null,
    candidates: 0,
    fetched: 0,
    vouchersToUpdate: 0,
    vouchersUpdated: 0,
    linesToUpdate: 0,
    lines: { withDiscount: 0, discountAmountDerived: 0, discountAmountNotDerivable: 0, withTaxAmounts: 0, withoutComputedFields: 0, withBilledQuantity: 0, billedDiffersFromActual: 0, billedQuantityMissingInTally: 0 },
    skipped: { notReturnedByTally: 0, changedInTally: 0, lineMismatch: 0, unexpectedVoucher: 0, changedDuringRun: 0 },
    batches: { attempted: 0, succeeded: 0, failed: 0 },
    nextAfterAlterId: null,
    remainingCandidates: null,
    errors: [],
  };
}

const aborted = (result, reasonCode, reason) => ({ ...result, status: "aborted", reasonCode, reason });

// The stored voucher and the freshly parsed one must describe the same lines before anything is written.
function sameLines(storedLines, parsedLines) {
  if (!Array.isArray(storedLines) || storedLines.length !== parsedLines.length) return false;
  return storedLines.every((s, i) => {
    const p = parsedLines[i];
    return s.itemName === p.itemName && near(s.quantity, p.quantity, 0.0005) && near(s.amount, p.amount, 0.005);
  });
}

// Build the $set for one voucher: only what differs, only the whitelisted paths.
function buildSet(storedLines, parsedLines, counters) {
  const set = {};
  parsedLines.forEach((p, i) => {
    const s = storedLines[i];
    if (p.discountPercentage > 0) counters.withDiscount += 1;
    if (p.discountPercentage > 0 && p.discountAmount > 0) counters.discountAmountDerived += 1;
    if (p.discountPercentage > 0 && !(p.discountAmount > 0)) counters.discountAmountNotDerivable += 1;
    if (p.gst && p.gst.amounts) counters.withTaxAmounts += 1;
    else counters.withoutComputedFields += 1;

    if (!near(s.discountPercentage || 0, p.discountPercentage, 1e-9)) set[`inventory.${i}.discountPercentage`] = p.discountPercentage;
    if (!near(s.discountAmount || 0, p.discountAmount, 1e-9)) set[`inventory.${i}.discountAmount`] = p.discountAmount;
    // The snapshot is written when the line has none yet, or when Tally now supplies the computed amounts the stored one lacks.
    if (p.gst && (!s.gst || (p.gst.amounts && !s.gst.amounts))) set[`inventory.${i}.gst`] = p.gst;
    // Diagnostic only (nothing is written for it): how often Tally's billed quantity differs from the actual quantity that is
    // stored, i.e. free goods. A full FY 2025-26 dry run found no such line, so the billed quantity is not stored.
    if (p.billedQuantity !== undefined) {
      counters.withBilledQuantity += 1;
      if (!near(p.billedQuantity, p.quantity, 0.0005)) counters.billedDiffersFromActual += 1;
    } else counters.billedQuantityMissingInTally += 1;
  });
  for (const path of Object.keys(set)) {
    if (!ALLOWED_SET_PATH.test(path)) throw new Error(`Back-fill refused to write ${path}: only discount and gst fields may change.`);
  }
  return set;
}

/**
 * @param {Object} params
 * @param {Object} params.company        the tenant's Company record ({tenantId, companyGuid, tallyConnection})
 * @param {"Sales"|"Purchase"} params.voucherType
 * @param {boolean} [params.apply=false] false = dry run (nothing is written)
 * @param {number} [params.afterAlterId=0] cursor: only stored vouchers with a larger AlterID (the result gives the next one)
 * @param {number} [params.batchSize]    AlterIDs per Tally request (<= 200, default the sync batch size)
 * @param {number} [params.maxBatches]   requests per run (default 5, max 50)
 * @param {string} [params.from]         optional YYYY-MM-DD, voucher date from (inclusive)
 * @param {string} [params.to]           optional YYYY-MM-DD, voucher date to (inclusive)
 * @param {Object} [params.deps]         test seams: verifyCompany, classify, fetchByAlterIds
 */
async function backfillVoucherLineDetails({ company, voucherType, apply = false, afterAlterId = 0, batchSize, maxBatches, from, to, deps = {} }) {
  const target = TARGETS[voucherType];
  if (!target) throw new Error(`Unsupported voucher type "${voucherType}" (expected Sales or Purchase).`);

  const result = emptyResult(voucherType, apply);
  const tenantId = company.tenantId;
  const companyGuid = company.companyGuid;
  const baseUrl = (company.tallyConnection && company.tallyConnection.baseUrl) || undefined;
  const verifyCompany = deps.verifyCompany || verifyOpenTallyCompany;
  const classify = deps.classify || resolveVoucherTypeClassification;
  const fetchByAlterIds = deps.fetchByAlterIds || getVouchersByAlterIds;

  if (typeof tenantId !== "string" || !tenantId.trim() || typeof companyGuid !== "string" || !companyGuid.trim()) {
    return aborted(result, "company_incomplete", "The company record has no tenantId / companyGuid.");
  }

  const guard = await verifyCompany(companyGuid, { baseUrl });
  if (!guard.ok) return aborted(result, guard.reason === "unreachable" ? "tally_unreachable" : "company_mismatch", guard.message);

  const classification = await classify({ companyGuid, baseUrl });
  const classResult = classification[target.classificationKey];
  if (!classResult || classResult.status !== "ok") {
    return aborted(result, "classification_error", (classResult && classResult.reason) || `Could not resolve ${voucherType} voucher types.`);
  }
  const voucherTypeNames = classResult.typeNames;

  const size = Math.min(resolveBatchSize(batchSize), MAX_ALTERIDS_PER_RECOVERY_QUERY);
  const batchLimit = clampInt(maxBatches, DEFAULT_MAX_BATCHES, 1, MAX_BATCHES_CAP);

  // ---- which stored vouchers still lack the details (this tenant only, active, same AlterID cursor order) ----
  const filter = {
    tenantId,
    voucherStatus: "active",
    tallyGuid: { $type: "string" },
    tallyAlterId: { $type: "number", $gt: Number(afterAlterId) || 0 },
    inventory: { $elemMatch: { "gst.amounts": { $exists: false } } },
  };
  if (from || to) {
    filter["header.voucherDate"] = {};
    if (from) filter["header.voucherDate"].$gte = storedDayStart(parseCalendarDay(from));
    if (to) filter["header.voucherDate"].$lte = storedDayEnd(parseCalendarDay(to));
  }
  const wanted = size * batchLimit;
  const candidates = await target.Model.find(filter)
    .select({ tallyGuid: 1, tallyAlterId: 1, "header.voucherNo": 1, "inventory.itemName": 1, "inventory.quantity": 1, "inventory.amount": 1, "inventory.discountPercentage": 1, "inventory.discountAmount": 1, "inventory.gst": 1 })
    .sort({ tallyAlterId: 1 })
    .limit(wanted)
    .lean();
  result.candidates = candidates.length;
  result.remainingCandidates = Math.max(0, (await target.Model.countDocuments(filter)) - candidates.length);

  // ---- bounded batches, one request at a time ----
  for (let b = 0; b < batchLimit; b += 1) {
    const batch = candidates.slice(b * size, (b + 1) * size);
    if (batch.length === 0) break;
    result.batches.attempted += 1;

    const byGuid = new Map(batch.map((d) => [d.tallyGuid, d]));
    const expectedAlterIds = batch.map((d) => d.tallyAlterId);
    let vouchers;
    try {
      const response = await fetchByAlterIds({ alterIds: expectedAlterIds, baseUrl, voucherTypeNames });
      const payload = typeof response === "string" ? JSON.parse(response) : response;
      vouchers = extractVoucherCollection(payload);
    } catch (error) {
      result.batches.failed += 1;
      result.errors.push(`Tally fetch failed: ${error.message}`);
      return { ...result, status: result.vouchersUpdated > 0 ? "partial" : "failed", reasonCode: "batch_failed", reason: result.errors[0] };
    }

    // Whole-batch company ownership BEFORE anything is read from it: one foreign voucher rejects the batch and ends the run.
    const ownership = validateBatchOwnership(vouchers, companyGuid);
    if (!ownership.ok) {
      logMismatch(ownership, { tenantId, companyGuid, source: `line-backfill:${voucherType}` });
      result.batches.failed += 1;
      return aborted(result, "company_mismatch", ownership.reason);
    }

    result.fetched += vouchers.length;
    const returned = new Set(vouchers.map((v) => parseTallyId(v && (v.alterid ?? v.alterId))).filter((id) => id !== null));
    // A stored voucher edited in Tally since the sync no longer answers to its old AlterID: it is the normal sync's job.
    result.skipped.notReturnedByTally += findMissingAlterIds(expectedAlterIds, [...returned]).length;

    const ops = [];
    for (const voucher of vouchers) {
      const guid = asString(voucher && voucher.guid);
      const stored = byGuid.get(guid);
      if (!stored) { result.skipped.unexpectedVoucher += 1; continue; }

      const parsed = parseTallyVoucher(voucher);
      if (parsed.sync.alterId !== stored.tallyAlterId) { result.skipped.changedInTally += 1; continue; }
      if (!sameLines(stored.inventory, parsed.inventory)) { result.skipped.lineMismatch += 1; continue; }

      const set = buildSet(stored.inventory, parsed.inventory, result.lines);
      if (Object.keys(set).length === 0) continue;
      result.vouchersToUpdate += 1;
      result.linesToUpdate += new Set(Object.keys(set).map((k) => k.split(".")[1])).size;
      ops.push({
        updateOne: {
          // Conditional on the version we compared: a voucher the sync updated meanwhile simply does not match.
          filter: { tenantId, tallyGuid: guid, tallyAlterId: stored.tallyAlterId },
          update: { $set: set },
        },
      });
    }

    if (apply && ops.length > 0) {
      try {
        const written = await target.Model.bulkWrite(ops, { ordered: false });
        const modified = written.modifiedCount || 0;
        result.vouchersUpdated += modified;
        result.skipped.changedDuringRun += ops.length - (written.matchedCount || 0);
      } catch (error) {
        result.batches.failed += 1;
        result.errors.push(`Write failed: ${error.message}`);
        return { ...result, status: result.vouchersUpdated > 0 ? "partial" : "failed", reasonCode: "write_failed", reason: result.errors[0] };
      }
    }
    result.batches.succeeded += 1;
  }

  const processed = candidates.slice(0, batchLimit * size);
  result.nextAfterAlterId = processed.length ? processed[processed.length - 1].tallyAlterId : null;
  result.status = apply ? "completed" : "dry_run";
  return result;
}

// --------------------------------------------------
// Which database is a script about to write to? A script that loads backend/.env connects to whatever MONGODB_URI says,
// which on a developer machine is the live cluster. This turns "write to a non-local database" into something that has to
// be typed on purpose: --apply against a non-loopback host needs --confirm-host <that exact host>. Dry runs are allowed
// anywhere because they write nothing. Only the host name is ever shown (never credentials, port or options).
// Used by backfill-voucher-line-details.js before it connects.
// --------------------------------------------------

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function hostOfMongoUri(uri) {
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?\[?([^\]/:,?]+)/i.exec(String(uri || "").trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * @returns {{ok: boolean, host: string|null, loopback: boolean, mode: "dry-run"|"apply", reason: string|null}}
 */
function checkWriteTarget({ uri, apply = false, confirmHost = null }) {
  const host = hostOfMongoUri(uri);
  const loopback = host !== null && LOOPBACK.has(host);
  const mode = apply ? "apply" : "dry-run";
  if (host === null) return { ok: false, host, loopback, mode, reason: "MONGODB_URI is missing or not a MongoDB connection string." };
  if (!apply || loopback) return { ok: true, host, loopback, mode, reason: null };
  if (typeof confirmHost === "string" && confirmHost.trim().toLowerCase() === host) return { ok: true, host, loopback, mode, reason: null };
  return {
    ok: false,
    host,
    loopback,
    mode,
    reason: `--apply would WRITE to ${host}, which is not a local database. Re-run with --confirm-host ${host} if that is intended.`,
  };
}

module.exports = { backfillVoucherLineDetails, ALLOWED_SET_PATH, hostOfMongoUri, checkWriteTarget };
