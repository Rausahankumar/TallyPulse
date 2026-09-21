const fs = require("fs");
const { GENERIC_SERVER_ERROR } = require("../middleware/errorHandler");

// Longest date range one manual live import may ask Tally for (audit F-13).
// TallyPrime is a desktop application and a very wide voucher query is known
// to hang it (a 10-year range did in a real session), so the range is capped
// and larger periods are imported in pieces.
const MAX_IMPORT_RANGE_DAYS = 92;

// Returns an error message for a bad or too-wide range, or null when it is fine.
// Same rule the service applies: a missing toDate means "the same day as fromDate".
const checkImportRange = ({ fromDate, toDate }) => {
  for (const [name, value] of [["fromDate", fromDate], ["toDate", toDate]]) {
    if (value !== undefined && typeof value !== "string") {
      return `${name} must be a single date (YYYY-MM-DD).`;
    }
  }

  if (!fromDate || !toDate) return null;

  const from = new Date(fromDate);
  const to = new Date(toDate);

  // An unparseable value is reported by the service as "Invalid date ..." (a 400).
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;

  if (to < from) return "toDate must not be before fromDate.";

  const days = Math.floor((to - from) / (24 * 60 * 60 * 1000)) + 1;

  if (days > MAX_IMPORT_RANGE_DAYS) {
    return `The date range is too long (${days} days). Import at most ${MAX_IMPORT_RANGE_DAYS} days at a time.`;
  }

  return null;
};

// The upload only exists to be read once. Delete it as soon as it has been
// processed (or refused), BEFORE the response is sent, so it is gone by the time
// the client sees the answer (audit F-14). Never throws.
const removeUpload = async (file) => {
  if (!file || !file.path) return;

  try {
    await fs.promises.unlink(file.path);
  } catch {
    // already gone - nothing to do
  }
};

const {
  importTallySales,
  importTallySalesFromTally,
} = require("../services/import/tallySalesImport");

// Shared response shaping for both the file-upload and live-Tally import
// endpoints, since importTallySales/importTallySalesFromTally return the
// same result shape (single-voucher result or multi-voucher summary).
const buildImportResponseBody = (result) => {
  if (result && Array.isArray(result.results)) {
    return {
      success: true,
      message: "Tally sales import summary",
      data: {
        total: result.total,
        created: result.created,
        updated: result.updated,
        duplicates: result.duplicates,
        skipped: result.skipped,
        failed: result.failed,
        results: result.results,
      },
    };
  }

  if (result && result.duplicate) {
    return {
      success: true,
      message: "Sale already exists",
      data: {
        created: false,
        updated: false,
        duplicate: true,
        saleId:
          result.sale && result.sale._id
            ? String(result.sale._id)
            : null,
      },
    };
  }

  if (result && result.updated) {
    return {
      success: true,
      message: "Sale updated from Tally",
      data: {
        created: false,
        updated: true,
        duplicate: false,
        saleId:
          result.sale && result.sale._id
            ? String(result.sale._id)
            : null,
      },
    };
  }

  return {
    success: true,
    message: "Tally sales imported successfully",
    data: {
      created: true,
      updated: false,
      duplicate: false,
      saleId:
        result.sale && result.sale._id
          ? String(result.sale._id)
          : null,
    },
  };
};

const IMPORT_ERROR_MESSAGE_MATCHES = [
  "Invalid JSON",
  "Only JSON files are allowed",
  "No JSON file uploaded",
  "Company GUID",
  "Company not found",
  "Company is inactive",
  "No Tally voucher data found",
  "Invalid date",
  "No company is currently open in TallyPrime",
  "does not match the Company GUID you entered",
  // Generic voucher-type classification (see voucherTypeClassifier.js):
  // this company's Sales voucher types couldn't be cleanly resolved, or
  // the classification fetch itself failed - a client-actionable/company-
  // configuration problem, not a TallyPulse server bug.
  "NEEDS_CONFIGURATION",
  "CLASSIFICATION_ERROR",
];

const respondToImportError = (res, error) => {
  const message =
    error && error.message
      ? error.message
      : "Unexpected import error";

  if (message.startsWith("Tally is unavailable")) {
    return res.status(503).json({
      success: false,
      message,
    });
  }

  if (
    IMPORT_ERROR_MESSAGE_MATCHES.some((match) =>
      message.includes(match)
    )
  ) {
    return res.status(400).json({
      success: false,
      message,
    });
  }

  // Anything not recognised above is unexpected: keep the detail in the server
  // log, send a message we chose (audit F-12).
  console.error("IMPORT ERROR:", error);

  return res.status(500).json({
    success: false,
    message: GENERIC_SERVER_ERROR,
  });
};

const importTallyJson = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message:
          'No JSON file uploaded. Please send a multipart/form-data file with field name "file".',
      });
    }

    const fileName =
      req.file.originalname || "";

    const mimetype =
      req.file.mimetype ||
      "application/octet-stream";

    const rawBuffer =
      req.file.buffer &&
      req.file.buffer.length > 0
        ? req.file.buffer
        : fs.readFileSync(req.file.path);

    const isJsonFile =
      fileName.toLowerCase().endsWith(".json") ||
      mimetype === "application/json";

    if (!isJsonFile) {
      await removeUpload(req.file);

      return res.status(400).json({
        success: false,
        message: "Only JSON files are allowed.",
      });
    }

    // Company context comes from JWT
    const companyGuId = req.user?.companyGuId;

    if (!companyGuId) {
      await removeUpload(req.file);

      return res.status(401).json({
        success: false,
        message: "Company GUID is missing from authentication token.",
      });
    }

    const result = await importTallySales({
      filePath: req.file.path,
      rawData: rawBuffer,
      fileName,
      mimetype,
      companyGuId,
    });

    await removeUpload(req.file);

    return res.status(200).json(buildImportResponseBody(result));
  } catch (error) {
    await removeUpload(req.file);

    return respondToImportError(res, error);
  }
};

// --------------------------------------------------
// Live TallyPrime import — fetches sales vouchers directly from Tally's
// HTTP JSON gateway (reusing the existing odbcService integration) and
// runs them through the same parse -> map -> validate -> dedupe -> save
// pipeline as the file-upload import.
//
// Optional ?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD query params select the
// voucher date range; both default to today when omitted.
// --------------------------------------------------
const importTallyLive = async (req, res) => {
  try {
    const companyGuId = req.user?.companyGuId;

    if (!companyGuId) {
      return res.status(401).json({
        success: false,
        message: "Company GUID is missing from authentication token.",
      });
    }

    const { fromDate, toDate } = req.query || {};

    const rangeProblem = checkImportRange({ fromDate, toDate });

    if (rangeProblem) {
      return res.status(400).json({ success: false, message: rangeProblem });
    }

    const result = await importTallySalesFromTally({
      companyGuId,
      fromDate,
      toDate,
    });

    return res.status(200).json(buildImportResponseBody(result));
  } catch (error) {
    return respondToImportError(res, error);
  }
};

module.exports = {
  importTallyJson,
  importTallyLive,
};