// const odbc = require("odbc");

// const connectTally = async () => {
//   try {
//     console.log("Connecting to Tally ODBC...");

//     const connection = await odbc.connect(
//       "DSN=TallyODBC64_9000;"
//     );

//     console.log("Tally ODBC connected");

//     return connection;
//   } catch (error) {
//     console.error("TALLY CONNECTION ERROR:", error);
//     throw error;
//   }
// };



// const getCompanyInfo = async (connection) => {
//   const result = await connection.query(`
//     SELECT
//       $CompanyName,
//       $CompanyGuid,
//       $SourceType,
//       $TenantId,
//       $IsActive
//     FROM Company
//   `);
// }

// const getSalesVouchers = async () => {
//   const connection = await connectTally();

//   try {
//      const inventoryResult = await connection.query(`
//     //   SELECT
//     //     $V_Date,
//     //     $V_VchNo,
//     //     $V_VchType,
//     //     $V_Party,
//     //     $V_Narration,
//     //     $V_Total,
//     //     $StockItemName,
//     //     $ActualQty,
//     //     $Rate,
//     //     $Amount,
//     //     $Discount,
//     //     $DiscountAmount
//     //   FROM RTSSalesInventory


//    `);

//     // const ledgerResult = await connection.query(`
//     //   SELECT
//     //     $V_Date,
//     //     $V_VchNo,
//     //     $V_VchType,
//     //     $V_Party,
//     //     $LedgerName,
//     //     $Amount
//     //   FROM RTSSalesLedger
//     // `);


//     // return {
//     //   inventory: inventoryResult,
//     //   ledgers: ledgerResult
//     // };

  

//   } finally {
//     await connection.close();
//   }
// };

// module.exports = {
//   connectTally,
//   getSalesVouchers,
// };


const axios = require("axios");

// Default Tally HTTP/JSONEx gateway. Every function below accepts an
// optional `baseUrl` override (falling back to this) so the connection can
// eventually be resolved per Company instead of being hardcoded here.
// Existing call sites that don't pass baseUrl keep talking to exactly this
// address, unchanged.
const DEFAULT_TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";


// ============================================================
// DATE HELPERS
// ============================================================

// Tally's $$Date literal expects DD-MM-YYYY.
function formatTallyDate(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

function resolveDateBound(input, fallback) {
  if (!input) return fallback;

  const parsed = input instanceof Date ? input : new Date(input);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: "${input}". Expected a value parseable as a date (e.g. YYYY-MM-DD).`);
  }

  return parsed;
}


// ============================================================
// GET COMPANY INFO
// ============================================================

const getCompanyInfo = async ({ baseUrl } = {}) => {
  try {
    const requestBody = {
      static_variables: [
        {
          name: "svExportFormat",
          value: "jsonex"
        }
      ],

      tdlmessage: [
        {
          definitions: [
            {
              metadata: {
                name: "RTS Company Report",
                type: "Report"
              },

              attributes: [
                {
                  "Form": "RTS Company Form"
                }
              ]
            },

            {
              metadata: {
                name: "RTS Company Form",
                type: "Form"
              },

              attributes: [
                {
                  "Parts": "RTS Company Part"
                }
              ]
            },

            {
              metadata: {
                name: "RTS Company Part",
                type: "Part"
              },

              attributes: [
                {
                  "Lines": "RTS Company Line"
                }
              ]
            },

            {
              metadata: {
                name: "RTS Company Line",
                type: "Line"
              },

              attributes: [
                {
                  "Fields": "RTS Company Name"
                }
              ]
            },

            {
              metadata: {
                name: "RTS Company Name",
                type: "Field"
              },

              attributes: [
                {
                SetAs: "$Name"
                }
              ]
            }
          ]
        }
      ]
    };

    const response = await axios.post(
      baseUrl || DEFAULT_TALLY_URL,
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          "Version": "1",
          "TallyRequest": "Export",
          "Type": "Data",
          "ID": "RTS Company Report"
        }
      }
    );

    return response.data;

  } catch (error) {
    console.error(
      "TALLY COMPANY API ERROR:",
      error.response?.data || error.message
    );

    throw error;
  }
};


// ============================================================
// GET SALES VOUCHERS
// ============================================================

const getSalesVouchers = async ({ fromDate, toDate, baseUrl } = {}) => {
  try {

    const today = new Date();
    const from = resolveDateBound(fromDate, today);
    const to = resolveDateBound(toDate, from);

    const fromLiteral = formatTallyDate(from);
    const toLiteral = formatTallyDate(to);

    const requestBody = {

      static_variables: [
        {
          name: "svExportFormat",
          value: "jsonex"
        }
      ],

      tdlmessage: [
        {
          definitions: [
            {
              metadata: {
                name: "RTS Sales Collection",
                type: "Collection"
              },

              attributes: [
                {
                  "Type": "Vouchers:VoucherType"
                },

                {
                  "Child Of": "$$VchTypeSales"
                },

                {
                  "Native Method":
                    "Date, VoucherTypeName, VoucherNumber, PartyLedgerName, inventoryentries.* , ledgerentries.*"
                },

                {
                  "Filter": "RTS Period Filter"
                }
              ]
            },

            {
              metadata: {
                name: "RTS Period Filter",
                type: "System",
                sys_type: "Formulae",
                ismodify: true
              },

              value:
                `$Date >= ($$Date:"${fromLiteral}") AND $Date <= ($$Date:"${toLiteral}")`
            },
            {
              metadata: {
                name: "RTS Sales Inventory",
                type: "Collection"
              },

              attributes: 
              [
                {
                  "Source Collection": "RTS Sales Collection"
                },

                {
                  Walk: "All Inventory Entries"
                },

                {
                  "Native Method":
                    "StockItemName, ActualQty, Rate, Amount, Discount, DiscountAmount"
                }
              ]
            },
          ], 
   
        }
      ]
    };


    const response = await axios.post(
      baseUrl || DEFAULT_TALLY_URL,
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          "Version": "1",
          "TallyRequest": "Export",

          // IMPORTANT
          "Type": "Collection",

          // IMPORTANT
          "ID": "RTS Sales Collection"
        },

        timeout: 30000
      }
    );

    return response.data;

  } catch (error) {

    console.error(
      "TALLY SALES API ERROR:",
      error.response?.data || error.message
    );

    throw error;
  }
};


// ============================================================
// GET SALES VOUCHERS SINCE ALTERID (incremental sync)
// ============================================================
//
// Unlike getSalesVouchers (date-range based, used by the manual
// /tally-live endpoint), this filters on Tally's $AlterID — a per-object
// counter that increases on every create AND modify, regardless of the
// voucher's own date. That's what makes it a correct incremental feed:
// editing a months-old voucher still surfaces here even though its $Date
// never changes. Confirmed against a live TallyPrime instance that
// $AlterID is both present on every voucher and genuinely filterable
// server-side (not just accepted and ignored).
const getSalesVouchersSinceAlterId = async ({ afterAlterId = 0, baseUrl } = {}) => {
  try {

    const threshold = Number(afterAlterId) || 0;

    const requestBody = {

      static_variables: [
        {
          name: "svExportFormat",
          value: "jsonex"
        }
      ],

      tdlmessage: [
        {
          definitions: [
            {
              metadata: {
                name: "RTS Sales AlterID Collection",
                type: "Collection"
              },

              attributes: [
                {
                  "Type": "Vouchers:VoucherType"
                },

                {
                  "Child Of": "$$VchTypeSales"
                },

                {
                  "Native Method":
                    "Date, VoucherTypeName, VoucherNumber, PartyLedgerName, AlterID, Guid, MasterID, IsCancelled, IsDeleted, inventoryentries.* , ledgerentries.*"
                },

                {
                  "Filter": "RTS AlterID Filter"
                }
              ]
            },

            {
              metadata: {
                name: "RTS AlterID Filter",
                type: "System",
                sys_type: "Formulae",
                ismodify: true
              },

              value:
                `$AlterID > ${threshold}`
            }
          ],

        }
      ]
    };

    const response = await axios.post(
      baseUrl || DEFAULT_TALLY_URL,
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          "Version": "1",
          "TallyRequest": "Export",
          "Type": "Collection",
          "ID": "RTS Sales AlterID Collection"
        },

        timeout: 30000
      }
    );

    return response.data;

  } catch (error) {

    console.error(
      "TALLY SALES ALTERID API ERROR:",
      error.response?.data || error.message
    );

    throw error;
  }
};


module.exports = {
  getCompanyInfo,
  getSalesVouchers,
  getSalesVouchersSinceAlterId
};