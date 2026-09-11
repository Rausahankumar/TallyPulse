const fs = require("fs");

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

  return res.status(500).json({
    success: false,
    message,
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
      return res.status(400).json({
        success: false,
        message: "Only JSON files are allowed.",
      });
    }

    // Company context comes from JWT
    const companyGuId = req.user?.companyGuId;

    if (!companyGuId) {
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

    return res.status(200).json(buildImportResponseBody(result));
  } catch (error) {
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