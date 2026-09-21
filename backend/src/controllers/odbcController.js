// const {
//   getCompanyInfo,
//   getSalesVouchers,
// } = require("../services/odbc/odbcService");


// // =========================
// // TEST ODBC CONNECTION
// // =========================

// const testOdbcConnection = async (req, res) => {
//   try {
//     const company = await getCompanyInfo();

//     return res.status(200).json({
//       success: true,
//       message: "ODBC connection successful",
//       data: company,
//     });

//   } catch (error) {
//     return res.status(500).json({
//       success: false,
//       message: error.message,
//     });
//   }
// };


// // =========================
// // BUILD SALES DATA
// // =========================

// const buildSalesData = (inventoryRows, ledgerRows) => {

//   const salesMap = new Map();


//   // =========================
//   // INVENTORY
//   // =========================

//   for (const row of inventoryRows) {

//     const voucherNo = row.$V_VchNo;

//     if (!salesMap.has(voucherNo)) {

//       salesMap.set(voucherNo, {
//         voucherNo: row.$V_VchNo,
//         voucherDate: row.$V_Date,
//         voucherType: row.$V_VchType,
//         voucherTotalAmount: row.$V_Total,
//         narration: row.$V_Narration,
//         partyName: row.$V_Party,

//         inventory: [],
//         ledgers: [],
//       });

//     }

//     salesMap.get(voucherNo).inventory.push({

//       itemName: row.$StockItemName,
//       quantity: row.$ActualQty,
//       rate: row.$Rate,
//       amount: row.$Amount,
//       discountPercentage: row.$Discount,
//       discountAmount: row.$DiscountAmount,

//     });
//   }


//   // =========================
//   // LEDGERS
//   // =========================

//   for (const row of ledgerRows) {

//     const voucherNo = row.$V_VchNo;

//     if (!salesMap.has(voucherNo)) {

//       salesMap.set(voucherNo, {   

//         voucherNo: row.$V_VchNo,
//         voucherDate: row.$V_Date,
//         voucherType: row.$V_VchType,
//         voucherTotalAmount: null,
//         narration: null,
//         partyName: row.$V_Party,

//         inventory: [],
//         ledgers: [],

//       });
//     }

//     salesMap.get(voucherNo).ledgers.push({

//       ledgerName: row.$LedgerName,

//       ledgerAmount: row.$Amount,

//       entryType: Number(row.$Amount) < 0? "Credit" : "Debit",

//     });
//   }


//   return Array.from(salesMap.values());
// };


// // =========================
// // GET SALES
// // =========================

// const getSales = async (req, res) => {

//   console.log("GET SALES API HIT");

//   try {

//     console.log("Calling Tally ODBC...");

//     const data = await getSalesVouchers();

//     console.log("Tally response received");

//     console.log(
//       "Inventory rows:",
//       data.inventory.length
//     );

//     console.log(
//       "Ledger rows:",
//       data.ledgers.length
//     );


//     // Combine Inventory + Ledger
//     const salesData = buildSalesData(
//       data.inventory,
//       data.ledgers
//     );


//     return res.status(200).json({

//       success: true,

//       count: salesData.length,

//       data: salesData,

//     });

//   } catch (error) {

//     console.error(
//       "SALES ODBC ERROR:",
//       error
//     );

//     return res.status(500).json({

//       success: false,

//       message: error.message,

//     });

//   }
// };


// module.exports = {
//   testOdbcConnection,
//   getSales,
// };


const {
  getCompanyInfo,
  getSalesVouchers,
} = require("../services/odbc/odbcService");
const { resolveSelectedOpenCompany } = require("../services/auth/tallyCompanyGuard");
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

    return res.status(500).json({
      success: false,
      message: error.message
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
      message: error.message
    });

  }
};


module.exports = {
  testTallyConnection,
  getSales
};