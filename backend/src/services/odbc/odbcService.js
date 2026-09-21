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
const { resolveTallyUrl } = require("./tallyUrl");

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

// Fixed during QA (2026-09-17→18): the previous version of this function
// used a Report -> Form -> Part -> Line -> Field TDL chain that was never
// bound to any Collection, so Tally had no object to iterate and this
// always returned an empty {} regardless of what was open - it could
// never actually confirm a company, let alone expose a GUID.
//
// This uses "Type": "Company" as a real TDL Collection instead, which
// Tally resolves against whatever company/companies are currently open in
// this session. Confirmed live against a real TallyPrime instance: this
// returns the open company's native $Guid, e.g.
// "09f68f6a-ace7-4ab4-bee8-ddea59ad0731" - the exact same value Tally
// already uses as the prefix of every voucher's own tallyGuid
// (see tallySyncWorker's synced records, e.g.
// "09f68f6a-ace7-4ab4-bee8-ddea59ad0731-00000365"), which is strong
// corroborating evidence this is Tally's real internal company identity,
// not an inferred or approximated value. When no company is open (or the
// one open can't be resolved), Tally returns an empty collection ([]) -
// confirmed live - rather than an error, so callers must treat an empty
// array as "no company open," not fold it into a connection failure.
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
                name: "RTS Company Guid Collection",
                type: "Collection"
              },

              attributes: [
                {
                  "Type": "Company"
                },

                {
                  "Native Method": "Name, Guid"
                }
              ]
            }
          ]
        }
      ]
    };

    const response = await axios.post(
      resolveTallyUrl(baseUrl, DEFAULT_TALLY_URL),
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          "Version": "1",
          "TallyRequest": "Export",
          "Type": "Collection",
          "ID": "RTS Company Guid Collection"
        },
        // Every other Tally call is bounded (30s). This one is the FIRST call of
        // every sync/reconciliation/recovery run, and a hung Tally used to block
        // it forever - and with it the whole serial worker cycle. Kept shorter
        // than the others because it is a light query.
        timeout: 15000
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
// VOUCHER-TYPE-NAME FILTER HELPERS (generic Sales/Purchase classification)
// ============================================================
//
// Replaces the old "Child Of": "$$VchTypeSales" / "$$VchTypePurchase"
// pattern. Confirmed live against a customized company that "Child Of" on
// the "Vouchers:VoucherType" collection does NOT walk the voucher-type
// parent hierarchy - it only matches vouchers whose own VoucherTypeName is
// an exact match. Callers now resolve the full set of voucher-type names
// that belong to a company's Sales/Purchase class via
// voucherTypeClassifier.js (parent-chain walk over the VoucherType master,
// keyed off Tally's own immutable reservedname metadata) and pass that
// resolved list in here. This file has no knowledge of any customer's
// specific voucher-type names - it only combines whatever list it's given
// into a single Tally filter formula.

// Voucher type names come from Tally's own metadata, not arbitrary user
// input, but this is a cheap defensive guard: there's no confirmed-safe
// escape sequence for a literal double quote inside a Tally TDL formula
// string literal, so a name containing one is excluded rather than risking
// a malformed (or injectable) formula.
function isSafeVoucherTypeNameForFormula(name) {
  return typeof name === "string" && name.length > 0 && !name.includes('"');
}

// Builds a single "($VoucherTypeName = "A") OR ($VoucherTypeName = "B") OR ..."
// clause. Confirmed live: this correctly aggregates vouchers across
// multiple distinct voucher-type names in one query (e.g. a company
// recording sales under both "Sales" and "Invoice" returned the exact sum
// of each name's individual count).
function buildVoucherTypeNameFilterClause(voucherTypeNames) {
  const safeNames = (voucherTypeNames || []).filter(
    isSafeVoucherTypeNameForFormula
  );

  if (!safeNames.length) {
    throw new Error(
      "No usable voucher type names to build a Tally filter from. Refusing to query with an empty/unsafe voucher-type-name set."
    );
  }

  return safeNames
    .map((name) => `$VoucherTypeName = "${name}"`)
    .join(" OR ");
}

// "$AlterID > threshold", optionally capped with "AND $AlterID <= upTo" so a
// caller can request one bounded slice of a large backlog instead of
// everything since the checkpoint. With no cap the clause is exactly what
// the incremental queries always used.
function buildAlterIdRangeClause(afterAlterId, upToAlterId) {
  const threshold = Number(afterAlterId) || 0;

  if (upToAlterId === undefined || upToAlterId === null) {
    return `($AlterID > ${threshold})`;
  }

  const upper = Number(upToAlterId);

  if (!Number.isFinite(upper) || upper <= threshold) {
    throw new Error(
      `Invalid AlterID window: upToAlterId (${upToAlterId}) must be a number greater than afterAlterId (${threshold}).`
    );
  }

  return `($AlterID > ${threshold}) AND ($AlterID <= ${upper})`;
}

function requireVoucherTypeNames(voucherTypeNames, fnName) {
  if (!Array.isArray(voucherTypeNames) || voucherTypeNames.length === 0) {
    throw new Error(
      `${fnName} requires a resolved, non-empty voucherTypeNames array. ` +
        "Callers must resolve classification via voucherTypeClassifier first - " +
        "this function does not fall back to $$VchTypeSales/$$VchTypePurchase."
    );
  }
}


// ============================================================
// GET VOUCHER TYPE MASTERS (for generic Sales/Purchase classification)
// ============================================================
//
// Confirmed live against TallyPrime: "Type": "VoucherType" is a flat
// master collection - every voucher type in the company, each carrying its
// own "parent" (one level up) plus Tally's own ambient
// metadata.reservedname (returned automatically, without needing to ask
// for it via Native Method). reservedname is a permanent internal
// system-class tag that survives renaming - confirmed live on a company
// where the reserved "Sales" root had been renamed to "Online Sales":
// metadata.name was "Online Sales" but metadata.reservedname was still
// "Sales". voucherTypeClassifier.js is the only consumer of this
// function's output.
const getVoucherTypeMasters = async ({ baseUrl } = {}) => {
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
                name: "RTS VoucherType Master Collection",
                type: "Collection"
              },

              attributes: [
                {
                  "Type": "VoucherType"
                },

                {
                  "Native Method": "Name, Parent, Guid"
                }
              ]
            }
          ]
        }
      ]
    };

    const response = await axios.post(
      resolveTallyUrl(baseUrl, DEFAULT_TALLY_URL),
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          "Version": "1",
          "TallyRequest": "Export",
          "Type": "Collection",
          "ID": "RTS VoucherType Master Collection"
        },

        timeout: 30000
      }
    );

    return response.data;

  } catch (error) {
    console.error(
      "TALLY VOUCHERTYPE MASTER API ERROR:",
      error.response?.data || error.message
    );

    throw error;
  }
};


// ============================================================
// GET SALES VOUCHERS
// ============================================================

// `voucherTypeNames` must be pre-resolved by voucherTypeClassifier.js -
// same generic classification the incremental sync worker and
// reconciliation use, not a hardcoded literal. Replaces the old
// "Child Of": "$$VchTypeSales" attribute (confirmed live to only match
// vouchers named exactly "Sales") with a single explicit AND/OR formula
// combining the date range with every resolved type name - same pattern
// as getSalesVouchersSinceAlterId below.
const getSalesVouchers = async ({ fromDate, toDate, baseUrl, voucherTypeNames } = {}) => {
  try {

    requireVoucherTypeNames(voucherTypeNames, "getSalesVouchers");

    const today = new Date();
    const from = resolveDateBound(fromDate, today);
    const to = resolveDateBound(toDate, from);

    const fromLiteral = formatTallyDate(from);
    const toLiteral = formatTallyDate(to);
    const typeNameClause = buildVoucherTypeNameFilterClause(voucherTypeNames);

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
                  "Type": "Voucher"
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
                `($Date >= ($$Date:"${fromLiteral}") AND $Date <= ($$Date:"${toLiteral}")) AND (${typeNameClause})`
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
      resolveTallyUrl(baseUrl, DEFAULT_TALLY_URL),
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
// `voucherTypeNames` must be pre-resolved by voucherTypeClassifier.js
// (the concrete set of voucher-type names that belong to this company's
// Sales class, discovered from its own VoucherType master - never a
// hardcoded literal). Replaces the old "Child Of": "$$VchTypeSales"
// attribute (confirmed live to only match vouchers named exactly "Sales")
// with a single explicit AND/OR formula combining the AlterID threshold
// with every resolved type name - confirmed live this correctly aggregates
// across multiple distinct voucher-type names in one query.
// Optional `upToAlterId` bounds the fetch to (afterAlterId, upToAlterId] so
// the sync worker can drain a large backlog in slices (see
// batchWindow.js) instead of requesting everything at once.
const getSalesVouchersSinceAlterId = async ({ afterAlterId = 0, baseUrl, voucherTypeNames, upToAlterId } = {}) => {
  try {

    requireVoucherTypeNames(voucherTypeNames, "getSalesVouchersSinceAlterId");

    const alterIdClause = buildAlterIdRangeClause(afterAlterId, upToAlterId);
    const typeNameClause = buildVoucherTypeNameFilterClause(voucherTypeNames);

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
                  "Type": "Voucher"
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
                `${alterIdClause} AND (${typeNameClause})`
            }
          ],

        }
      ]
    };

    const response = await axios.post(
      resolveTallyUrl(baseUrl, DEFAULT_TALLY_URL),
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


// ============================================================
// GET PURCHASE VOUCHERS SINCE ALTERID (incremental sync)
// ============================================================
//
// Mirrors getSalesVouchersSinceAlterId exactly, with the Purchase-class
// voucherTypeNames set instead - see that function's comment for the full
// rationale. Kept as its own self-contained function (not a shared builder
// with the Sales version) to match this file's existing style.
const getPurchaseVouchersSinceAlterId = async ({ afterAlterId = 0, baseUrl, voucherTypeNames, upToAlterId } = {}) => {
  try {

    requireVoucherTypeNames(voucherTypeNames, "getPurchaseVouchersSinceAlterId");

    const alterIdClause = buildAlterIdRangeClause(afterAlterId, upToAlterId);
    const typeNameClause = buildVoucherTypeNameFilterClause(voucherTypeNames);

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
                name: "RTS Purchase AlterID Collection",
                type: "Collection"
              },

              attributes: [
                {
                  "Type": "Voucher"
                },

                {
                  "Native Method":
                    "Date, VoucherTypeName, VoucherNumber, PartyLedgerName, AlterID, Guid, MasterID, IsCancelled, IsDeleted, inventoryentries.* , ledgerentries.*"
                },

                {
                  "Filter": "RTS Purchase AlterID Filter"
                }
              ]
            },

            {
              metadata: {
                name: "RTS Purchase AlterID Filter",
                type: "System",
                sys_type: "Formulae",
                ismodify: true
              },

              value:
                `${alterIdClause} AND (${typeNameClause})`
            }
          ],

        }
      ]
    };

    const response = await axios.post(
      resolveTallyUrl(baseUrl, DEFAULT_TALLY_URL),
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          "Version": "1",
          "TallyRequest": "Export",
          "Type": "Collection",
          "ID": "RTS Purchase AlterID Collection"
        },

        timeout: 30000
      }
    );

    return response.data;

  } catch (error) {

    console.error(
      "TALLY PURCHASE ALTERID API ERROR:",
      error.response?.data || error.message
    );

    throw error;
  }
};


// ============================================================
// GET PENDING ALTERIDS (batch planning for incremental sync)
// ============================================================
//
// Light probe used by the sync worker to size a batch BEFORE fetching full
// vouchers: same filter as the incremental fetch, but only VoucherTypeName
// + AlterID are requested - no inventoryentries/ledgerentries walk, which
// is what makes a full fetch of thousands of vouchers exceed the 30s
// timeout. Works for any voucher class (the caller passes that class's
// resolved voucherTypeNames), so there is one function, not one per type.
// `withCancelledFlag` additionally requests IsCancelled (still a light field);
// used by voucher recovery to tell cancelled vouchers apart. Off by default so
// the sync worker's probe is unchanged.
const getPendingVoucherAlterIds = async ({ afterAlterId = 0, baseUrl, voucherTypeNames, withCancelledFlag = false } = {}) => {
  try {

    requireVoucherTypeNames(voucherTypeNames, "getPendingVoucherAlterIds");

    const alterIdClause = buildAlterIdRangeClause(afterAlterId);
    const typeNameClause = buildVoucherTypeNameFilterClause(voucherTypeNames);

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
                name: "RTS Pending AlterIDs Collection",
                type: "Collection"
              },

              attributes: [
                {
                  "Type": "Voucher"
                },

                {
                  "Native Method": withCancelledFlag ? "VoucherTypeName, AlterID, IsCancelled" : "VoucherTypeName, AlterID"
                },

                {
                  "Filter": "RTS Pending AlterIDs Filter"
                }
              ]
            },

            {
              metadata: {
                name: "RTS Pending AlterIDs Filter",
                type: "System",
                sys_type: "Formulae",
                ismodify: true
              },

              value:
                `${alterIdClause} AND (${typeNameClause})`
            }
          ],

        }
      ]
    };

    const response = await axios.post(
      resolveTallyUrl(baseUrl, DEFAULT_TALLY_URL),
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          "Version": "1",
          "TallyRequest": "Export",
          "Type": "Collection",
          "ID": "RTS Pending AlterIDs Collection"
        },

        timeout: 30000
      }
    );

    return response.data;

  } catch (error) {

    console.error(
      "TALLY PENDING ALTERIDS API ERROR:",
      error.response?.data || error.message
    );

    throw error;
  }
};


// ============================================================
// GET VOUCHERS BY EXPLICIT ALTERIDS (missing-data recovery)
// ============================================================
//
// Full vouchers (same fields as the incremental fetch, so the unchanged
// parser/mapper/persistence pipeline can consume them) for exactly the
// given AlterIDs - used by voucherRecovery.js to re-import vouchers that are
// present in Tally but missing from MongoDB, without moving any sync
// checkpoint. The id list is capped so one request stays small.
const MAX_ALTERIDS_PER_RECOVERY_QUERY = 200;

const getVouchersByAlterIds = async ({ alterIds, baseUrl, voucherTypeNames } = {}) => {
  try {

    requireVoucherTypeNames(voucherTypeNames, "getVouchersByAlterIds");

    if (
      !Array.isArray(alterIds) ||
      alterIds.length === 0 ||
      alterIds.length > MAX_ALTERIDS_PER_RECOVERY_QUERY ||
      !alterIds.every((id) => Number.isInteger(id) && id > 0)
    ) {
      throw new Error(
        `getVouchersByAlterIds requires 1-${MAX_ALTERIDS_PER_RECOVERY_QUERY} positive integer AlterIDs.`
      );
    }

    const idClause = Array.from(new Set(alterIds))
      .map((id) => `$AlterID = ${id}`)
      .join(" OR ");
    const typeNameClause = buildVoucherTypeNameFilterClause(voucherTypeNames);

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
                name: "RTS Recovery Vouchers Collection",
                type: "Collection"
              },

              attributes: [
                {
                  "Type": "Voucher"
                },

                {
                  "Native Method":
                    "Date, VoucherTypeName, VoucherNumber, PartyLedgerName, AlterID, Guid, MasterID, IsCancelled, IsDeleted, inventoryentries.* , ledgerentries.*"
                },

                {
                  "Filter": "RTS Recovery Vouchers Filter"
                }
              ]
            },

            {
              metadata: {
                name: "RTS Recovery Vouchers Filter",
                type: "System",
                sys_type: "Formulae",
                ismodify: true
              },

              value:
                `(${idClause}) AND (${typeNameClause})`
            }
          ],

        }
      ]
    };

    const response = await axios.post(
      resolveTallyUrl(baseUrl, DEFAULT_TALLY_URL),
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          "Version": "1",
          "TallyRequest": "Export",
          "Type": "Collection",
          "ID": "RTS Recovery Vouchers Collection"
        },

        timeout: 30000
      }
    );

    return response.data;

  } catch (error) {

    console.error(
      "TALLY RECOVERY VOUCHERS API ERROR:",
      error.response?.data || error.message
    );

    throw error;
  }
};


// ============================================================
// GET ALL SALES / PURCHASE VOUCHER GUIDS (reconciliation)
// ============================================================
//
// Lightest possible query for the reconciliation safety-net: no
// AlterID filter (deliberately - a deleted voucher never shows up
// regardless of AlterID, confirmed against a live TallyPrime instance,
// so filtering by AlterID here would defeat the purpose), and
// "Guid" is the only field explicitly requested in Native Method.
// Confirmed live that Tally still returns its own base field set
// regardless (metadata/date/vouchernumber/masterid/etc. always come
// through) - there is no way to get a narrower payload than this via
// this API, since Native Method only ADDS fields, it doesn't restrict
// the response to just what's asked for. Still meaningfully lighter
// than the incremental fetch: no inventoryentries/ledgerentries walk.
//
// Returns the full parsed voucher objects (not just bare guid strings)
// so callers can extract $Guid via the same unwrap-aware parsing the
// rest of the codebase already uses, rather than assuming a raw shape.
//
// Like the AlterID fetch functions above, `voucherTypeNames` must be
// pre-resolved by voucherTypeClassifier.js - this replaces the old
// "Child Of": "$$VchTypeSales"/"$$VchTypePurchase" attribute (confirmed
// live to only match vouchers named exactly "Sales"/"Purchase") with an
// explicit OR formula over every resolved type name. Confirmed live this
// still returns the plain "guid" string field the rest of the codebase
// (extractGuidSet in reconciliation.js) already expects.
function buildAllGuidsRequestBody(voucherTypeNames, collectionName) {
  const typeNameClause = buildVoucherTypeNameFilterClause(voucherTypeNames);
  const filterName = `${collectionName} Filter`;

  return {
    static_variables: [
      { name: "svExportFormat", value: "jsonex" }
    ],
    tdlmessage: [
      {
        definitions: [
          {
            metadata: { name: collectionName, type: "Collection" },
            attributes: [
              { "Type": "Voucher" },
              { "Native Method": "Guid" },
              { "Filter": filterName }
            ]
          },
          {
            metadata: {
              name: filterName,
              type: "System",
              sys_type: "Formulae",
              ismodify: true
            },
            value: typeNameClause
          }
        ]
      }
    ]
  };
}

const getAllSalesVoucherGuids = async ({ baseUrl, voucherTypeNames } = {}) => {
  try {
    requireVoucherTypeNames(voucherTypeNames, "getAllSalesVoucherGuids");

    const response = await axios.post(
      resolveTallyUrl(baseUrl, DEFAULT_TALLY_URL),
      buildAllGuidsRequestBody(voucherTypeNames, "RTS Sales All Guids Collection"),
      {
        headers: {
          "Content-Type": "application/json",
          "Version": "1",
          "TallyRequest": "Export",
          "Type": "Collection",
          "ID": "RTS Sales All Guids Collection"
        },
        timeout: 30000
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      "TALLY SALES ALL-GUIDS API ERROR:",
      error.response?.data || error.message
    );
    throw error;
  }
};

const getAllPurchaseVoucherGuids = async ({ baseUrl, voucherTypeNames } = {}) => {
  try {
    requireVoucherTypeNames(voucherTypeNames, "getAllPurchaseVoucherGuids");

    const response = await axios.post(
      resolveTallyUrl(baseUrl, DEFAULT_TALLY_URL),
      buildAllGuidsRequestBody(voucherTypeNames, "RTS Purchase All Guids Collection"),
      {
        headers: {
          "Content-Type": "application/json",
          "Version": "1",
          "TallyRequest": "Export",
          "Type": "Collection",
          "ID": "RTS Purchase All Guids Collection"
        },
        timeout: 30000
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      "TALLY PURCHASE ALL-GUIDS API ERROR:",
      error.response?.data || error.message
    );
    throw error;
  }
};


module.exports = {
  getCompanyInfo,
  getVoucherTypeMasters,
  getPendingVoucherAlterIds,
  getVouchersByAlterIds,
  MAX_ALTERIDS_PER_RECOVERY_QUERY,
  getSalesVouchers,
  getSalesVouchersSinceAlterId,
  getAllSalesVoucherGuids,
  getAllPurchaseVoucherGuids,
  getPurchaseVouchersSinceAlterId
};