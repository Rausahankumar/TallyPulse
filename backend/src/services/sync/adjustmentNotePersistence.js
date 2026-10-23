const { parseAdjustmentNoteVoucher } = require("../parser/adjustmentNoteParser");
const { mapAdjustmentNote } = require("../mapper/adjustmentNoteMapper");
const { classifyAdjustmentNote, resolveAccountRoles } = require("../tally/adjustmentNoteClassifier");
const AdjustmentNote = require("../../models/adjustmentNote.model");

// --------------------------------------------------
// Credit Note / Debit Note persistence. Mirrors voucherPersistence.js's
// createVoucherPersistence (identity by {tenantId, tallyGuid}, AlterID
// idempotency, cancel/delete tombstone handling, ambiguous-voucherNo guard)
// as a SEPARATE, self-contained implementation rather than a shared
// abstraction - see PROJECT_CONTEXT.md's "smallest safe change" convention.
// The one real difference: classification needs an async LedgerMaster
// lookup (adjustmentNoteClassifier.resolveAccountRoles) before mapping,
// which voucherPersistence's synchronous mapVoucher(parsed, {tenantId})
// contract doesn't support - reusing it would mean changing code proven by
// the live Sales/Purchase pipeline.
//
// @param {"credit"|"debit"} noteType - fixed per persistence instance
//   (one for Credit Note vouchers, one for Debit Note vouchers), matching
//   tallySyncWorker's one-module-per-voucher-class convention.
// --------------------------------------------------
function createAdjustmentNotePersistence({ noteType }) {
  if (noteType !== "credit" && noteType !== "debit") {
    throw new Error("createAdjustmentNotePersistence requires noteType 'credit' or 'debit'.");
  }
  const label = noteType === "credit" ? "Credit Note" : "Debit Note";

  async function handleUnmappable({ tenantId, voucherNo, parsedVoucher, mapError }) {
    const sync = (parsedVoucher && parsedVoucher.sync) || {};
    if (!sync.isCancelled && !sync.isDeleted) throw mapError;

    const lookup = sync.guid ? { tenantId, tallyGuid: sync.guid } : voucherNo ? { tenantId, "header.voucherNo": voucherNo } : null;
    if (!lookup) {
      return { created: false, duplicate: false, updated: false, message: `Cancelled/deleted ${label} has no identifiable voucher number or GUID; nothing to update.`, tenantId, voucherNo, status: "skipped" };
    }

    if (!sync.guid) {
      const candidates = await AdjustmentNote.find(lookup).select("_id").limit(2).lean();
      if (candidates.length > 1) {
        return { created: false, duplicate: false, updated: false, message: `Cannot safely mark voucherNo ${voucherNo} cancelled/deleted: no GUID and more than one existing ${label} shares that number for tenantId ${tenantId}.`, tenantId, voucherNo, status: "skipped" };
      }
    }

    const voucherStatus = sync.isDeleted ? "deleted" : "cancelled";
    const updated = await AdjustmentNote.findOneAndUpdate(lookup, { $set: { voucherStatus, ...(sync.alterId != null ? { tallyAlterId: sync.alterId } : {}) } }, { returnDocument: "after" }).lean();
    if (!updated) {
      return { created: false, duplicate: false, updated: false, message: `No existing ${label} found to mark ${voucherStatus} for tenantId ${tenantId} (nothing was ever synced for this voucher).`, tenantId, voucherNo, status: "skipped" };
    }
    return { created: false, duplicate: false, updated: true, message: `${label} marked ${voucherStatus} from Tally`, tenantId, voucherNo: updated.header && updated.header.voucherNo, tallyAlterId: sync.alterId ?? null, status: "updated" };
  }

  async function processSingleAdjustmentNoteVoucher(voucher, tenantId, companyGuid) {
    const voucherNo = voucher && voucher.vouchernumber ? voucher.vouchernumber : null;

    try {
      if (!voucher || typeof voucher !== "object") throw new Error(`${label} entry is not an object.`);
      if (!companyGuid) throw new Error(`processSingleAdjustmentNoteVoucher requires a trusted companyGuid for ${label}.`);

      const parsedVoucher = parseAdjustmentNoteVoucher(voucher);

      let mappedDoc;
      try {
        const ledgerNames = (parsedVoucher.inventory || []).map((l) => l.accountingAllocationLedger).filter(Boolean);
        const roleMap = await resolveAccountRoles(tenantId, ledgerNames);
        const classification = classifyAdjustmentNote(parsedVoucher, noteType, roleMap);
        mappedDoc = mapAdjustmentNote(parsedVoucher, { tenantId, companyGuid, noteType, classification });
      } catch (mapError) {
        return await handleUnmappable({ tenantId, voucherNo, parsedVoucher, mapError });
      }

      const doc = new AdjustmentNote(mappedDoc);
      await doc.validate();

      const resolvedVoucherNo = (mappedDoc.header && mappedDoc.header.voucherNo) || voucherNo;
      const hasGuid = !!mappedDoc.tallyGuid;
      const filter = hasGuid ? { tenantId, tallyGuid: mappedDoc.tallyGuid } : { tenantId, "header.voucherNo": resolvedVoucherNo };

      if (!hasGuid) {
        const candidates = await AdjustmentNote.find(filter).select("_id").limit(2).lean();
        if (candidates.length > 1) {
          return { created: false, duplicate: false, updated: false, message: `Cannot safely upsert voucherNo ${resolvedVoucherNo}: no tallyGuid and more than one existing ${label} shares that voucher number for tenantId ${tenantId}. Refusing to guess.`, tenantId, voucherNo: resolvedVoucherNo, status: "failed", error: "Ambiguous voucherNo identity with no tallyGuid to disambiguate." };
        }
      }

      const existingDoc = await AdjustmentNote.findOne(filter).select("_id tallyAlterId").lean();

      if (existingDoc && existingDoc.tallyAlterId != null && mappedDoc.tallyAlterId != null && mappedDoc.tallyAlterId <= existingDoc.tallyAlterId) {
        return { created: false, duplicate: true, updated: false, message: `${label} already up to date for tenantId ${tenantId} and voucherNo ${resolvedVoucherNo}`, tenantId, voucherNo: resolvedVoucherNo, tallyAlterId: mappedDoc.tallyAlterId, status: "duplicate" };
      }

      const savedDoc = await AdjustmentNote.findOneAndUpdate(filter, { $set: mappedDoc }, { upsert: true, returnDocument: "after", runValidators: true, setDefaultsOnInsert: true });
      const wasCreated = !existingDoc;

      return {
        created: wasCreated,
        duplicate: false,
        updated: !wasCreated,
        message: wasCreated ? `${label} imported successfully` : `${label} updated from Tally`,
        adjustmentNoteId: String(savedDoc._id),
        tenantId,
        voucherNo: resolvedVoucherNo,
        tallyAlterId: mappedDoc.tallyAlterId,
        classification: mappedDoc.classification,
        status: wasCreated ? "created" : "updated",
      };
    } catch (error) {
      const message = (error && error.message) || `Unknown ${label.toLowerCase()} import error`;
      return { created: false, duplicate: false, updated: false, message, tenantId, voucherNo, status: "failed", error: message };
    }
  }

  return { processSingleAdjustmentNoteVoucher };
}

module.exports = { createAdjustmentNotePersistence };
