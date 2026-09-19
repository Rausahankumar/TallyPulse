const { parseTallyVoucher } = require("../parser/tallyParser");

// --------------------------------------------------
// The one genuinely shared piece of the sync pipeline: parse -> map ->
// validate -> tenant-safe upsert -> cancel/delete tombstone fallback.
// Extracted out of the original Sales-only implementation so Sales and
// Purchase (and any future voucher type) share this logic instead of
// each carrying their own copy — this is where real correctness bugs
// (duplicate writes, broken idempotency, a lost audit trail) would bite,
// so it's worth not duplicating.
//
// Parameterized by:
//   Model      - the Mongoose model to persist into (Sale, Purchase, ...)
//   mapVoucher - the voucher-type-specific mapper (mapTallySale,
//                mapTallyPurchase, ...), called as mapVoucher(parsedVoucher, { tenantId })
//   entityLabel - "Sale" | "Purchase" | ... used only for message text
//
// Returns the same result shape regardless of Model/mapper used:
//   "created"   - no prior document existed; inserted.
//   "updated"   - a prior document existed and this write changed it.
//   "duplicate" - a prior document existed and its $AlterID is already >=
//                 the incoming one; no write performed.
//   "skipped"   - couldn't be fully mapped, but carries a cancel/delete
//                 signal and no matching document exists to update.
//   "failed"    - a genuine error.
// --------------------------------------------------
function createVoucherPersistence({ Model, mapVoucher, entityLabel }) {
  if (!Model || typeof Model.findOne !== "function") {
    throw new Error("createVoucherPersistence requires a Mongoose Model.");
  }

  if (typeof mapVoucher !== "function") {
    throw new Error("createVoucherPersistence requires a mapVoucher function.");
  }

  const label = entityLabel || Model.modelName || "Voucher";

  async function handleUnmappableVoucher({ tenantId, voucherNo, parsedVoucher, mapError }) {
    const sync = (parsedVoucher && parsedVoucher.sync) || {};

    if (!sync.isCancelled && !sync.isDeleted) {
      throw mapError;
    }

    const lookup = sync.guid
      ? { tenantId, tallyGuid: sync.guid }
      : voucherNo
        ? { tenantId, "header.voucherNo": voucherNo }
        : null;

    if (!lookup) {
      return {
        created: false,
        duplicate: false,
        updated: false,
        message:
          `Cancelled/deleted ${label.toLowerCase()} has no identifiable voucher number or GUID to match against; nothing to update.`,
        sale: null,
        saleId: null,
        tenantId,
        voucherNo,
        status: "skipped",
      };
    }

    // voucherNo is not a unique identity (see the top of this file) - if
    // this tombstone has no GUID to match on and its voucherNo fallback
    // is ambiguous (matches more than one document, e.g. two distinct
    // voucher masters that happen to share a number), refuse to guess
    // which one to mark cancelled/deleted. A wrong guess here would
    // silently corrupt the wrong voucher's status - worse than doing
    // nothing.
    if (!sync.guid) {
      const candidates = await Model.find(lookup).select("_id").limit(2).lean();
      if (candidates.length > 1) {
        return {
          created: false,
          duplicate: false,
          updated: false,
          message:
            `Cannot safely mark voucherNo ${voucherNo} cancelled/deleted: no GUID on this record and more than one existing ${label.toLowerCase()} shares that voucher number for tenantId ${tenantId}. Refusing to guess which one.`,
          sale: null,
          saleId: null,
          tenantId,
          voucherNo,
          status: "skipped",
        };
      }
    }

    const voucherStatus = sync.isDeleted ? "deleted" : "cancelled";

    const updatedDoc = await Model.findOneAndUpdate(
      lookup,
      {
        $set: {
          voucherStatus,
          ...(sync.alterId != null ? { tallyAlterId: sync.alterId } : {}),
        },
      },
      { returnDocument: "after" }
    ).lean();

    if (!updatedDoc) {
      return {
        created: false,
        duplicate: false,
        updated: false,
        message:
          `No existing ${label} found to mark ${voucherStatus} for tenantId ${tenantId} (nothing was ever synced for this voucher).`,
        sale: null,
        saleId: null,
        tenantId,
        voucherNo,
        status: "skipped",
      };
    }

    return {
      created: false,
      duplicate: false,
      updated: true,
      message: `${label} marked ${voucherStatus} from Tally`,
      sale: updatedDoc,
      saleId: String(updatedDoc._id),
      tenantId,
      voucherNo: updatedDoc.header && updatedDoc.header.voucherNo,
      tallyAlterId: sync.alterId ?? null,
      status: "updated",
    };
  }

  async function processSingleVoucher(voucher, tenantId) {
    const voucherNo =
      voucher && voucher.vouchernumber ? voucher.vouchernumber : null;

    try {
      if (!voucher || typeof voucher !== "object") {
        throw new Error("Voucher entry is not an object.");
      }

      // parseTallyVoucher never throws for sparse/incomplete records — it
      // always returns usable sync flags even when header fields are
      // missing. Only mapVoucher (below) requires the header to be
      // complete.
      const parsedVoucher = parseTallyVoucher(voucher);

      let mappedDoc;

      try {
        mappedDoc = mapVoucher(parsedVoucher, { tenantId });
      } catch (mapError) {
        return await handleUnmappableVoucher({
          tenantId,
          voucherNo,
          parsedVoucher,
          mapError,
        });
      }

      const doc = new Model(mappedDoc);
      await doc.validate();

      const resolvedVoucherNo =
        mappedDoc.header && mappedDoc.header.voucherNo
          ? mappedDoc.header.voucherNo
          : voucherNo;

      // Identity: {tenantId, tallyGuid} - Tally's own stable
      // per-voucher-master id, not voucherNo (which is a business/
      // display field and is NOT guaranteed unique - two distinct
      // voucher masters can legitimately share a voucherNo; confirmed
      // against a live TallyPrime instance). voucherNo is only used as
      // a fallback identity when a record genuinely has no GUID (e.g. a
      // manual file upload whose source JSON carried no AlterID/GUID) -
      // a known, narrower-trust legacy path.
      const hasGuid = !!mappedDoc.tallyGuid;

      const filter = hasGuid
        ? { tenantId, tallyGuid: mappedDoc.tallyGuid }
        : { tenantId, "header.voucherNo": resolvedVoucherNo };

      if (!hasGuid) {
        // Same ambiguity guard as the tombstone path: without a GUID,
        // voucherNo isn't a safe identity if more than one existing
        // document already shares it. Don't guess which one this write
        // is "for".
        const candidates = await Model.find(filter).select("_id").limit(2).lean();
        if (candidates.length > 1) {
          return {
            created: false,
            duplicate: false,
            updated: false,
            message:
              `Cannot safely upsert voucherNo ${resolvedVoucherNo}: no tallyGuid on this record and more than one existing ${label.toLowerCase()} shares that voucher number for tenantId ${tenantId}. Refusing to guess which one to update.`,
            sale: null,
            saleId: null,
            tenantId,
            voucherNo: resolvedVoucherNo,
            status: "failed",
            error: "Ambiguous voucherNo identity with no tallyGuid to disambiguate.",
          };
        }
      }

      const existingDoc = await Model.findOne(filter)
        .select("_id tallyAlterId")
        .lean();

      // Idempotency guard: only meaningful when both sides carry a
      // comparable $AlterID. If the incoming AlterID is not newer than
      // what's stored, this is a re-poll of a delta already applied —
      // skip the write so retries are safe.
      if (
        existingDoc &&
        existingDoc.tallyAlterId != null &&
        mappedDoc.tallyAlterId != null &&
        mappedDoc.tallyAlterId <= existingDoc.tallyAlterId
      ) {
        return {
          created: false,
          duplicate: true,
          updated: false,
          message:
            `${label} already up to date for tenantId ${tenantId} and voucherNo ${resolvedVoucherNo}`,
          sale: existingDoc,
          saleId: String(existingDoc._id),
          tenantId,
          voucherNo: resolvedVoucherNo,
          tallyAlterId: mappedDoc.tallyAlterId,
          status: "duplicate",
        };
      }

      const savedDoc = await Model.findOneAndUpdate(
        filter,
        { $set: mappedDoc },
        {
          upsert: true,
          returnDocument: "after",
          runValidators: true,
          setDefaultsOnInsert: true,
        }
      );

      const wasCreated = !existingDoc;

      return {
        created: wasCreated,
        duplicate: false,
        updated: !wasCreated,
        message: wasCreated
          ? `${label} imported successfully`
          : `${label} updated from Tally`,
        sale: savedDoc.toObject(),
        saleId: String(savedDoc._id),
        tenantId,
        voucherNo: resolvedVoucherNo,
        tallyAlterId: mappedDoc.tallyAlterId,
        status: wasCreated ? "created" : "updated",
      };
    } catch (error) {
      const message =
        error && error.message ? error.message : `Unknown ${label.toLowerCase()} import error`;

      return {
        created: false,
        duplicate: false,
        updated: false,
        message,
        sale: null,
        saleId: null,
        tenantId,
        voucherNo,
        status: "failed",
        error: message,
      };
    }
  }

  return { processSingleVoucher };
}

module.exports = {
  createVoucherPersistence,
};
