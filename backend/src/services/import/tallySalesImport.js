const fs = require("fs");
const path = require("path");

const Company = require("../../models/company");
const Sale = require("../../models/sales.model");

const { mapTallySale } = require("../mapper/salesMapper");
const { getSalesVouchers } = require("../odbc/odbcService");
const { createVoucherPersistence } = require("../sync/voucherPersistence");
const { verifyOpenTallyCompany } = require("../auth/tallyCompanyGuard");
const {
  resolveVoucherTypeClassification,
} = require("../tally/voucherTypeClassifier");
const { assertBatchOwnership } = require("../tally/companyOwnership");


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
// This is a thin wrapper over the generic, voucher-type-agnostic core in
// voucherPersistence.js (also used by Purchase sync) — same external
// signature and behavior as before that extraction; see
// voucherPersistence.js for the outcome status meanings ("created"/
// "updated"/"duplicate"/"skipped"/"failed").
const { processSingleVoucher } =
  createVoucherPersistence({
    Model: Sale,
    mapVoucher: mapTallySale,
    entityLabel: "Sale",
  });


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

  if (!filePath && rawData === undefined) {
    throw new Error(
      "importTallySales requires either filePath or rawData."
    );
  }

  const targetPath = filePath;

  const resolvedFileName =
    fileName ||
    (filePath ? path.basename(filePath) : "upload.json");

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

  const { company, tenantId } =
    await resolveTenantContext(companyGuId);

  // Safety gate (product rule): Sales Sync must never import whatever
  // company happens to be open in Tally into a DIFFERENT TallyPulse
  // company's tenant. Re-checks live, on every sync, that the company
  // actually open in Tally right now is this tenant's own company -
  // never assumed just because the user is scoped to this tenant in
  // TallyPulse. Uses the resolved Company doc's own companyGuid (not the
  // raw caller-supplied companyGuId) as the expected value.
  const guard = await verifyOpenTallyCompany(company.companyGuid);

  if (!guard.ok) {
    throw new Error(
      guard.reason === "unreachable"
        ? `Tally is unavailable: ${guard.message}`
        : guard.message
    );
  }

  // Generic Sales voucher-type discovery - the same voucherTypeClassifier
  // (and its cache) already used by the incremental sync worker and
  // reconciliation, so all three paths always agree on what "Sales" means
  // for this company. Never a per-customer hardcoded name, and never
  // silently falls back to the old $$VchTypeSales token if classification
  // can't be cleanly resolved - a company whose Sales voucher types are
  // ambiguous/unconfigured fails this request loudly instead of
  // returning an empty or wrong result.
  const classification = await resolveVoucherTypeClassification({
    companyGuid: company.companyGuid,
  });

  const salesClass = classification.sales;

  if (!salesClass || salesClass.status !== "ok") {
    const reasonPrefix =
      salesClass && salesClass.status === "needs_configuration"
        ? "NEEDS_CONFIGURATION"
        : "CLASSIFICATION_ERROR";

    throw new Error(
      `${reasonPrefix}: ${
        (salesClass && salesClass.reason) ||
        "Could not resolve Sales voucher-type classification for this company."
      }`
    );
  }

  let tallyResponse;

  try {
    tallyResponse = await getSalesVouchers({
      fromDate,
      toDate,
      voucherTypeNames: salesClass.typeNames,
    });
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

  // Same boundary as the background sync: the whole response must belong to
  // this tenant's company before any voucher is imported.
  assertBatchOwnership(vouchers, company.companyGuid, {
    tenantId,
    companyGuid: company.companyGuid,
    source: "manual-import",
  });

  return importParsedVouchers(vouchers, tenantId);
}


module.exports = {
  extractVoucherCollection,
  importTallySales,
  importTallySalesFromTally,
  resolveTenantContext,
  processSingleVoucher,
};