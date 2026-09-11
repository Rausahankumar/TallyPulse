const fs = require("fs");
const path = require("path");

const Company = require("../../models/company");
const Sale = require("../../models/sales.model");

const { parseTallyVoucher } = require("../parser/tallyParser");
const { mapTallySale } = require("../mapper/salesMapper");
const { getSalesVouchers } = require("../odbc/odbcService");


function sanitizeJsonText(rawText) {
  if (typeof rawText !== "string") {
    return rawText;
  }

  let cleaned = rawText.replace(/^\uFEFF/, "");
  cleaned = cleaned.replace(/^[\u0000-\u001F\u007F]+/, "");

  return cleaned.trim();
}


function detectJsonEncoding(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return {
      encoding: "utf8",
      bom: false,
      reason: "Empty file detected; defaulting to UTF-8.",
    };
  }

  const byte0 = buffer[0];
  const byte1 = buffer[1];
  const byte2 = buffer[2];

  // UTF-8 BOM
  if (
    byte0 === 0xef &&
    byte1 === 0xbb &&
    byte2 === 0xbf
  ) {
    return {
      encoding: "utf8",
      bom: true,
      reason: "UTF-8 BOM detected.",
    };
  }

  // UTF-16 LE BOM
  if (
    byte0 === 0xff &&
    byte1 === 0xfe
  ) {
    return {
      encoding: "utf16le",
      bom: true,
      reason: "UTF-16LE BOM detected.",
    };
  }

  // UTF-16 BE BOM
  if (
    byte0 === 0xfe &&
    byte1 === 0xff
  ) {
    return {
      encoding: "utf16be",
      bom: true,
      reason: "UTF-16BE BOM detected.",
    };
  }

  const sample = buffer.subarray(
    0,
    Math.min(buffer.length, 64)
  );

  let evenNulls = 0;
  let oddNulls = 0;

  for (
    let index = 0;
    index < sample.length;
    index += 1
  ) {
    if (
      index % 2 === 0 &&
      sample[index] === 0
    ) {
      evenNulls += 1;
    }

    if (
      index % 2 === 1 &&
      sample[index] === 0
    ) {
      oddNulls += 1;
    }
  }

  if (
    evenNulls > oddNulls &&
    sample.length >= 8
  ) {
    return {
      encoding: "utf16be",
      bom: false,
      reason:
        "UTF-16BE null-byte pattern detected.",
    };
  }

  if (
    oddNulls > evenNulls &&
    sample.length >= 8
  ) {
    return {
      encoding: "utf16le",
      bom: false,
      reason:
        "UTF-16LE null-byte pattern detected.",
    };
  }

  return {
    encoding: "utf8",
    bom: false,
    reason:
      "No BOM or UTF-16 signature found; defaulting to UTF-8.",
  };
}


function decodeJsonBuffer(
  buffer,
  {
    fileName = "uploaded-file",
    mimetype = "application/json",
  } = {}
) {
  const { encoding, bom } =
    detectJsonEncoding(buffer);

  let payloadBuffer = buffer;

  if (
    bom &&
    (
      encoding === "utf8" ||
      encoding === "utf16le" ||
      encoding === "utf16be"
    )
  ) {
    payloadBuffer = buffer.subarray(
      encoding === "utf8" ? 3 : 2
    );
  }

  let decodedText = "";

  if (encoding === "utf16be") {
    const swapped = Buffer.alloc(
      payloadBuffer.length
    );

    for (
      let index = 0;
      index < payloadBuffer.length;
      index += 2
    ) {
      if (index + 1 < payloadBuffer.length) {
        swapped[index] =
          payloadBuffer[index + 1];

        swapped[index + 1] =
          payloadBuffer[index];
      } else {
        swapped[index] =
          payloadBuffer[index];
      }
    }

    decodedText =
      swapped.toString("utf16le");

  } else if (encoding === "utf16le") {
    decodedText =
      payloadBuffer.toString("utf16le");

  } else {
    decodedText =
      payloadBuffer.toString("utf8");
  }

  return sanitizeJsonText(decodedText);
}


function extractVoucherCollection(payload) {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload.filter(
      (item) =>
        item &&
        typeof item === "object"
    );
  }

  if (typeof payload !== "object") {
    return [];
  }

  const candidatePaths = [
    payload.tallymessage,
    payload.vouchers,
    payload.voucher,
    payload.tallyMessage,
    payload.sales,
    // Tally's HTTP JSONEx Collection export wraps results as
    // { status, data: { collection: [...] } } — check this before the
    // generic payload.data fallback below.
    payload.data && payload.data.collection,
    payload.data,
  ];

  for (const collection of candidatePaths) {
    if (Array.isArray(collection)) {
      return collection.filter(
        (item) =>
          item &&
          typeof item === "object"
      );
    }

    if (
      collection &&
      typeof collection === "object"
    ) {
      if (Array.isArray(collection.vouchers)) {
        return collection.vouchers.filter(
          (item) =>
            item &&
            typeof item === "object"
        );
      }

      if (
        Array.isArray(
          collection.tallymessage
        )
      ) {
        return collection.tallymessage.filter(
          (item) =>
            item &&
            typeof item === "object"
        );
      }

      if (Array.isArray(collection.voucher)) {
        return collection.voucher.filter(
          (item) =>
            item &&
            typeof item === "object"
        );
      }

      if (Array.isArray(collection.collection)) {
        return collection.collection.filter(
          (item) =>
            item &&
            typeof item === "object"
        );
      }
    }
  }

  return [payload];
}


// True upsert, keyed on the existing unique {tenantId, header.voucherNo}
// index. Used by the manual file-upload import, the manual live-fetch
// import, and the incremental sync worker — the one shared persistence
// path required by all three.
//
// Possible outcomes:
//   "created"   - no prior document existed; inserted.
//   "updated"   - a prior document existed and this write changed it
//                 (newer $AlterID, or no comparable AlterID on either side
//                 so we can't cheaply prove nothing changed).
//   "duplicate" - a prior document existed and its $AlterID is already >=
//                 the incoming one; no write performed (idempotent retry
//                 / re-poll of the same delta).
//   "skipped"   - the voucher couldn't be fully mapped (missing required
//                 header fields), but it carries a cancel/delete signal
//                 and no matching document exists yet to update — nothing
//                 meaningful to do.
//   "failed"    - a genuine error: couldn't be mapped and carries no
//                 cancel/delete signal, or an unexpected exception.
async function processSingleVoucher(
  voucher,
  tenantId
) {
  const voucherNo =
    voucher &&
    voucher.vouchernumber
      ? voucher.vouchernumber
      : null;

  try {
    if (
      !voucher ||
      typeof voucher !== "object"
    ) {
      throw new Error(
        "Voucher entry is not an object."
      );
    }

    // parseTallyVoucher never throws for sparse/incomplete records — it
    // always returns usable sync flags (guid/alterId/isCancelled/
    // isDeleted) even when header fields are missing. Only mapTallySale
    // (below) requires the header to be complete.
    const parsedVoucher =
      parseTallyVoucher(voucher);

    let mappedSale;

    try {
      mappedSale = mapTallySale(
        parsedVoucher,
        { tenantId }
      );
    } catch (mapError) {
      return await handleUnmappableVoucher({
        tenantId,
        voucherNo,
        parsedVoucher,
        mapError,
      });
    }

    const doc =
      new Sale(mappedSale);

    await doc.validate();

    const resolvedVoucherNo =
      mappedSale.header &&
      mappedSale.header.voucherNo
        ? mappedSale.header.voucherNo
        : voucherNo;

    const filter = {
      tenantId,
      "header.voucherNo":
        resolvedVoucherNo,
    };

    const existingSale =
      await Sale.findOne(filter)
        .select("_id tallyAlterId")
        .lean();

    // Idempotency guard: only meaningful when BOTH sides carry a
    // comparable $AlterID (i.e. this voucher came from the AlterID-based
    // sync path, not a plain file upload). If the incoming AlterID is not
    // newer than what's already stored, this is a re-poll of a delta we
    // already applied — skip the write entirely so retries are safe.
    if (
      existingSale &&
      existingSale.tallyAlterId != null &&
      mappedSale.tallyAlterId != null &&
      mappedSale.tallyAlterId <= existingSale.tallyAlterId
    ) {
      return {
        created: false,
        duplicate: true,
        updated: false,
        message:
          `Sale already up to date for tenantId ${tenantId} and voucherNo ${resolvedVoucherNo}`,
        sale: existingSale,
        saleId: String(existingSale._id),
        tenantId,
        voucherNo: resolvedVoucherNo,
        tallyAlterId: mappedSale.tallyAlterId,
        status: "duplicate",
      };
    }

    const savedSale =
      await Sale.findOneAndUpdate(
        filter,
        { $set: mappedSale },
        {
          upsert: true,
          returnDocument: "after",
          runValidators: true,
          setDefaultsOnInsert: true,
        }
      );

    const wasCreated = !existingSale;

    return {
      created: wasCreated,
      duplicate: false,
      updated: !wasCreated,
      message:
        wasCreated
          ? "Sale imported successfully"
          : "Sale updated from Tally",
      sale: savedSale.toObject(),
      saleId: String(savedSale._id),
      tenantId,
      voucherNo: resolvedVoucherNo,
      tallyAlterId: mappedSale.tallyAlterId,
      status: wasCreated ? "created" : "updated",
    };

  } catch (error) {
    const message =
      error && error.message
        ? error.message
        : "Unknown voucher import error";

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


// Defensive fallback for a voucher that couldn't be fully mapped (missing
// required header fields). If it carries a cancel/delete signal, treat a
// map failure as "this is a tombstone-shaped record, not corrupt data":
// update just the status on a matching existing document (found via
// tallyGuid, falling back to voucherNo) without touching its other
// fields. If no matching document exists, there's nothing to update —
// that's a harmless skip, not a failure. Any other map failure is a
// genuine error.
//
// This path exists because whether Tally returns full voucher data
// alongside $IsDeleted, or a sparse stub, is UNVERIFIED (see
// tallyParser.js) — this makes both possibilities safe.
async function handleUnmappableVoucher({
  tenantId,
  voucherNo,
  parsedVoucher,
  mapError,
}) {
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
        "Cancelled/deleted voucher has no identifiable voucher number or GUID to match against; nothing to update.",
      sale: null,
      saleId: null,
      tenantId,
      voucherNo,
      status: "skipped",
    };
  }

  const voucherStatus = sync.isDeleted ? "deleted" : "cancelled";

  const updatedSale = await Sale.findOneAndUpdate(
    lookup,
    {
      $set: {
        voucherStatus,
        ...(sync.alterId != null ? { tallyAlterId: sync.alterId } : {}),
      },
    },
    { returnDocument: "after" }
  ).lean();

  if (!updatedSale) {
    return {
      created: false,
      duplicate: false,
      updated: false,
      message:
        `No existing Sale found to mark ${voucherStatus} for tenantId ${tenantId} (nothing was ever synced for this voucher).`,
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
    message: `Sale marked ${voucherStatus} from Tally`,
    sale: updatedSale,
    saleId: String(updatedSale._id),
    tenantId,
    voucherNo: updatedSale.header && updatedSale.header.voucherNo,
    tallyAlterId: sync.alterId ?? null,
    status: "updated",
  };
}


// --------------------------------------------------
// Resolve the tenant a Tally import should be scoped to.
//
// The tenant is always re-derived from the Company record via the
// companyGuId carried in the caller's JWT (see auth middleware) — never
// trusted directly from client input — so an authenticated user can only
// ever import into their own company's tenant.
// --------------------------------------------------
async function resolveTenantContext(companyGuId) {
  if (!companyGuId) {
    throw new Error(
      "Company GUID is required."
    );
  }

  const company =
    await Company.findOne({
      companyGuid: companyGuId,
    }).lean();

  if (!company) {
    throw new Error(
      "Company not found."
    );
  }

  if (!company.isActive) {
    throw new Error(
      "Company is inactive."
    );
  }

  return {
    company,
    companyId: company._id,
    tenantId: company.tenantId,
  };
}


// --------------------------------------------------
// Run the shared parse -> map -> validate -> dedupe -> save pipeline over
// an array of raw Tally voucher objects, for a single resolved tenant.
// Used by both the file-upload import and the live Tally import.
// --------------------------------------------------
async function importParsedVouchers(vouchers, tenantId) {
  if (!Array.isArray(vouchers) || vouchers.length === 0) {
    throw new Error(
      "No Tally voucher data found."
    );
  }

  if (vouchers.length === 1) {
    const singleResult =
      await processSingleVoucher(
        vouchers[0],
        tenantId
      );

    if (singleResult.status === "failed") {
      throw new Error(singleResult.message);
    }

    return singleResult;
  }

  const summary = {
    total: vouchers.length,
    created: 0,
    updated: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  for (const voucher of vouchers) {
    const result =
      await processSingleVoucher(
        voucher,
        tenantId
      );

    if (result.status === "created") {
      summary.created += 1;
    } else if (result.status === "updated") {
      summary.updated += 1;
    } else if (result.status === "duplicate") {
      summary.duplicates += 1;
    } else if (result.status === "skipped") {
      summary.skipped += 1;
    } else {
      summary.failed += 1;
    }

    summary.results.push({
      voucherNo: result.voucherNo || null,
      status: result.status,
      ...(result.message ? { message: result.message } : {}),
      ...(result.saleId ? { saleId: result.saleId } : {}),
    });
  }

  return summary;
}


async function importTallySales({
  filePath,
  rawData,
  fileName,
  mimetype,
  companyGuId,
} = {}) {

  console.log(
    "IMPORT TALLY SALES - companyGuId:",
    companyGuId
  );

  const { tenantId } =
    await resolveTenantContext(companyGuId);

  console.log(
    "TENANT ID:",
    tenantId
  );

  // --------------------------------------------------
  // 4. Resolve file
  // --------------------------------------------------

  const targetPath =
    filePath ||
    path.resolve(
      __dirname,
      "../../../sample-data/tally-multi-vouchers.json"
    );

  const resolvedFileName =
    fileName ||
    path.basename(targetPath);

  let parsedPayload;

  // --------------------------------------------------
  // 5. Read and parse JSON
  // --------------------------------------------------

  try {
    let decodedText;

    if (rawData !== undefined) {

      if (Buffer.isBuffer(rawData)) {
        decodedText =
          decodeJsonBuffer(
            rawData,
            {
              fileName:
                resolvedFileName,
              mimetype,
            }
          );
      }

      else if (
        typeof rawData === "string"
      ) {
        decodedText =
          sanitizeJsonText(rawData);
      }

      else {
        parsedPayload = rawData;
      }

    } else {

      const fileBuffer =
        fs.readFileSync(
          targetPath
        );

      decodedText =
        decodeJsonBuffer(
          fileBuffer,
          {
            fileName:
              resolvedFileName,
            mimetype,
          }
        );
    }

    if (
      decodedText !== undefined
    ) {
      parsedPayload =
        JSON.parse(decodedText);
    }

  } catch (error) {

    const parseMessage =
      error && error.message
        ? error.message
        : "Unknown JSON parse error";

    throw new Error(
      `Invalid JSON in Tally file: ${parseMessage}`
    );
  }

  // --------------------------------------------------
  // 6. Extract vouchers
  // --------------------------------------------------

  const vouchers =
    extractVoucherCollection(
      parsedPayload
    );

  if (!vouchers.length) {
    throw new Error(
      "No Tally voucher data found in the uploaded JSON file."
    );
  }

  // --------------------------------------------------
  // 7. Parse -> map -> validate -> dedupe -> save
  // --------------------------------------------------

  return importParsedVouchers(vouchers, tenantId);
}


// --------------------------------------------------
// Fetch sales vouchers live from TallyPrime (HTTP JSON) and run them
// through the same parse -> map -> validate -> dedupe -> save pipeline
// used by the file-upload import. Tenant is resolved the same way, from
// the authenticated user's companyGuId - never from client input.
// --------------------------------------------------
async function importTallySalesFromTally({
  companyGuId,
  fromDate,
  toDate,
} = {}) {

  const { tenantId } =
    await resolveTenantContext(companyGuId);

  let tallyResponse;

  try {
    tallyResponse = await getSalesVouchers({ fromDate, toDate });
  } catch (error) {
    const message =
      error && error.message
        ? error.message
        : "Unable to reach TallyPrime.";

    // Bad client-supplied date range is a 400, not a connectivity problem.
    if (message.startsWith("Invalid date")) {
      throw error;
    }

    throw new Error(
      `Tally is unavailable: ${message}`
    );
  }

  let parsedPayload;

  try {
    parsedPayload =
      typeof tallyResponse === "string"
        ? JSON.parse(tallyResponse)
        : tallyResponse;
  } catch (error) {
    const parseMessage =
      error && error.message
        ? error.message
        : "Unknown JSON parse error";

    throw new Error(
      `Invalid JSON in Tally response: ${parseMessage}`
    );
  }

  const vouchers =
    extractVoucherCollection(
      parsedPayload
    );

  if (!vouchers.length) {
    throw new Error(
      "No Tally voucher data found for the requested date range."
    );
  }

  return importParsedVouchers(vouchers, tenantId);
}


module.exports = {
  extractVoucherCollection,
  importTallySales,
  importTallySalesFromTally,
  resolveTenantContext,
  processSingleVoucher,
};