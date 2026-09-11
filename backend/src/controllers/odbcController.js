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


// ============================================================
// TEST TALLY CONNECTION
// ============================================================

const testTallyConnection = async (req, res) => {
  try {

    const data = await getCompanyInfo();

    return res.status(200).json({
      success: true,
      message: "Tally API connection successful",
      data
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

const getSales = async (req, res) => {

  console.log("GET SALES API HIT");

  try {

    console.log("Sending request to Tally...");

    const data = await getSalesVouchers();

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