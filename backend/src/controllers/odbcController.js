const {
  getCompanyInfo,
  getSalesVouchers,
} = require("../services/odbc/odbcService");
const { resolveSelectedOpenCompany } = require("../services/auth/tallyCompanyGuard");
const TALLY_REQUEST_FAILED = "Could not get a response from TallyPrime. Make sure TallyPrime is running and try again.";
const {
  resolveVoucherTypeClassification,
} = require("../services/tally/voucherTypeClassifier");


// ============================================================
// TEST TALLY CONNECTION
// ============================================================

const testTallyConnection = async (req, res) => {
  try {

    const data = await getCompanyInfo();

    // The authoritative answer to "which company is TallyPulse talking to?":
    // the only open company, or - when several are open - the one Tally has
    // SELECTED (resolveSelectedOpenCompany). Clients must use this, never the
    // first entry of the raw company list. Name only: the GUID stays internal.
    const detection = await resolveSelectedOpenCompany();
    const detected = detection.ok
      ? { state: "ok", companyName: detection.match.name || null }
      : {
          state:
            detection.reason === "multiple_open"
              ? "ambiguous"
              : detection.reason === "no_company_open"
                ? "no_company"
                : "unreachable",
          companyName: null,
          message: detection.message,
        };

    return res.status(200).json({
      success: true,
      message: "Tally API connection successful",
      data,
      detected
    });

  } catch (error) {

    console.error("TALLY CONNECTION ERROR:", error.message);

    return res.status(500).json({
      success: false,
      message: TALLY_REQUEST_FAILED
    });

  }
};


// ============================================================
// GET SALES
// ============================================================

// No auth/tenant context on this route (a legacy diagnostic endpoint, not
// the real tenant-scoped /api/import/tally-live path) - so unlike that
// path, there's no companyGuId to resolve a Company from. Instead it
// resolves classification for whichever company Tally currently has
// open, same generic voucherTypeClassifier the rest of the app uses,
// never a hardcoded name and never a silent fallback to $$VchTypeSales.
const getSales = async (req, res) => {

  console.log("GET SALES API HIT");

  try {

    // The selected company - never "whichever is listed first".
    const detection = await resolveSelectedOpenCompany();

    if (!detection.ok) {
      return res.status(detection.reason === "unreachable" ? 503 : detection.reason === "multiple_open" ? 409 : 400).json({
        success: false,
        message: detection.message,
      });
    }

    // These are raw vouchers of the company Tally has SELECTED. Only the account
    // that owns that company may read them (audit F-03): a signed-in user of a
    // different company must not see it, even though they are authenticated.
    if (!req.companyContext || req.companyContext.companyGuid !== detection.match.guid) {
      return res.status(403).json({
        success: false,
        message: "The company open in TallyPrime is not the company you are signed in to.",
      });
    }

    const classification = await resolveVoucherTypeClassification({
      companyGuid: detection.match.guid,
    });

    const salesClass = classification.sales;

    if (!salesClass || salesClass.status !== "ok") {
      const reasonPrefix =
        salesClass && salesClass.status === "needs_configuration"
          ? "NEEDS_CONFIGURATION"
          : "CLASSIFICATION_ERROR";

      return res.status(400).json({
        success: false,
        message: `${reasonPrefix}: ${
          (salesClass && salesClass.reason) ||
          "Could not resolve Sales voucher-type classification for this company."
        }`,
      });
    }

    console.log("Sending request to Tally...");

    const data = await getSalesVouchers({ voucherTypeNames: salesClass.typeNames });

    console.log("Tally response received");

    return res.status(200).json({
      success: true,
      data
    });

  } catch (error) {

    console.error(
      "SALES TALLY API ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message: TALLY_REQUEST_FAILED
    });

  }
};


module.exports = {
  testTallyConnection,
  getSales
};