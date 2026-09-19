const { resolveTenantContext } = require("../services/import/tallySalesImport");
const { recoverMissingVouchers } = require("../services/sync/voucherRecovery");

const VOUCHER_TYPES = ["Sales", "Purchase"];

// reasonCode -> HTTP status for a recovery that could not even start.
const ABORT_STATUS = {
  company_mismatch: 409,
  needs_configuration: 409,
  classification_error: 409,
  already_running: 409,
  tally_unreachable: 503,
  registry_fetch_failed: 503,
  registry_unreadable: 502,
};

// --------------------------------------------------
// POST /api/sync/recovery  { voucherType: "Sales"|"Purchase", apply?: boolean }
//
// Compares Tally with MongoDB for the caller's own company and (only when
// apply === true) re-imports vouchers that exist in Tally but are missing
// from MongoDB. Default is a dry run that writes nothing. This is not a
// checkpoint reset and never touches the incremental sync's checkpoint.
// The tenant is re-derived from the JWT's companyGuId, never from the body.
// --------------------------------------------------
const runVoucherRecovery = async (req, res) => {
  try {
    const companyGuId = req.user?.companyGuId;

    if (!companyGuId) {
      return res.status(401).json({
        success: false,
        message: "Company GUID is missing from authentication token.",
      });
    }

    const { voucherType, apply } = req.body || {};

    if (!VOUCHER_TYPES.includes(voucherType)) {
      return res.status(400).json({
        success: false,
        message: `voucherType must be one of: ${VOUCHER_TYPES.join(", ")}.`,
      });
    }

    if (apply !== undefined && typeof apply !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "apply must be a boolean.",
      });
    }

    const { company } = await resolveTenantContext(companyGuId);

    const result = await recoverMissingVouchers({
      company,
      voucherType,
      apply: apply === true,
    });

    if (result.status === "aborted") {
      return res.status(ABORT_STATUS[result.reasonCode] || 500).json({
        success: false,
        message: result.reason,
        data: result,
      });
    }

    return res.status(200).json({
      success: result.status === "completed" || result.status === "dry_run",
      message:
        result.status === "dry_run"
          ? "Dry run only - nothing was changed."
          : `Recovery ${result.status}.`,
      data: result,
    });
  } catch (error) {
    const message = error && error.message ? error.message : "Recovery failed.";
    const notFound = message === "Company not found." || message === "Company is inactive.";

    return res.status(notFound ? 404 : 500).json({ success: false, message });
  }
};

module.exports = { runVoucherRecovery };
