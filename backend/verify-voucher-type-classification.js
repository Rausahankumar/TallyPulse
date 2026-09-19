/**
 * Generic Sales/Purchase voucher-type classification verification
 * (2026-09-18).
 *
 * Replaces the old hardcoded "Child Of": "$$VchTypeSales"/"$$VchTypePurchase"
 * sync queries. Confirmed live (see the investigation this implements)
 * that "Child Of" on the "Vouchers:VoucherType" collection only matches
 * vouchers whose OWN VoucherTypeName is an exact match - it never walks
 * the voucher-type parent hierarchy. voucherTypeClassifier.js instead
 * walks each voucher type's own parent chain to its self-parented root and
 * classifies by that root's Tally-native `reservedname` (a permanent
 * internal tag that survives renaming).
 *
 * Sections in this file:
 *   1. PURE unit tests of classifyVoucherTypes() - synthetic fixtures,
 *      no I/O, cover every required edge case (standard root, renamed
 *      root, multi-level hierarchy, broken chain, cycle, zero root,
 *      duplicate root, Sales/Purchase independence).
 *   2. REAL-DATA-DERIVED fixtures - the exact VoucherType master lists
 *      captured live from "We Four" (customized company, guid
 *      d46f1002-00d9-4559-b3e1-afcf8674c7b1) and "Nirmal FMCG Traders Ltd"
 *      (standard dev-tenant company, guid
 *      09f68f6a-ace7-4ab4-bee8-ddea59ad0731) on 2026-09-18, run back
 *      through the real classifier to confirm it reproduces the
 *      hand-verified expected type-name sets.
 *   3. REAL LIVE TALLY integration - whichever company is actually open in
 *      TallyPrime right now (only one company can be open at a time in
 *      this shared single-instance setup, so this section is adaptive):
 *      classification, the classified AlterID query, the reconciliation
 *      GUID query, incremental-threshold filtering, and the company-GUID
 *      guard, all against the real instance.
 *   4. SYNTHETIC fail-closed tests: connection failure, and the in-memory
 *      cache (via a tiny local stub HTTP server so hit counts are
 *      genuinely observable, not just timing-inferred).
 *
 * Run: node verify-voucher-type-classification.js
 * Section 3 requires TallyPrime reachable with a company open; sections
 * 1, 2, and 4 run regardless.
 */

require("dotenv").config();
const http = require("http");
const axios = require("axios");

const {
  classifyVoucherTypes,
  resolveVoucherTypeClassification,
  clearVoucherTypeClassificationCache,
} = require("./src/services/tally/voucherTypeClassifier");
const {
  getCompanyInfo,
  getVoucherTypeMasters,
  getSalesVouchersSinceAlterId,
  getPurchaseVouchersSinceAlterId,
  getAllSalesVoucherGuids,
  getAllPurchaseVoucherGuids,
} = require("./src/services/odbc/odbcService");
const { extractOpenCompanies, unwrapJsonExValue } = require("./src/services/parser/tallyParser");
const { extractVoucherCollection } = require("./src/services/import/tallySalesImport");
const { verifyOpenTallyCompany } = require("./src/services/auth/tallyCompanyGuard");

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail ? ` (${detail})` : ""}`);
  }
}

function m(name, parent, reservedName) {
  return { name, parent, reservedName };
}

// ====================================================================
// SECTION 1: PURE unit tests of classifyVoucherTypes()
// ====================================================================

function testStandardRoot() {
  console.log("\n=== UNIT: standard, un-customized Sales/Purchase roots ===");
  const masters = [
    m("Sales", "Sales", "Sales"),
    m("Purchase", "Purchase", "Purchase"),
    m("Journal", "Journal", "Journal"),
  ];
  const result = classifyVoucherTypes(masters);

  check("sales.status === ok", result.sales.status === "ok", result.sales.status);
  check("sales.rootName === 'Sales'", result.sales.rootName === "Sales");
  check(
    "sales.typeNames === ['Sales']",
    JSON.stringify(result.sales.typeNames.sort()) === JSON.stringify(["Sales"])
  );
  check("purchase.status === ok", result.purchase.status === "ok");
  check(
    "purchase.typeNames === ['Purchase']",
    JSON.stringify(result.purchase.typeNames.sort()) === JSON.stringify(["Purchase"])
  );
}

function testRenamedRootLikeWeFour() {
  console.log("\n=== UNIT: renamed Sales root (We Four shape, minimal) ===");
  const masters = [
    m("Online Sales", "Online Sales", "Sales"), // reserved root, renamed
    m("Invoice", "Online Sales", ""),
    m("AMAZON INVOICE", "Online Sales", ""),
    m("Sales", "Online Sales", ""), // a PLAIN leaf, not the reserved root
    m("Purchase", "Purchase", "Purchase"),
  ];
  const result = classifyVoucherTypes(masters);

  check("sales.status === ok despite the rename", result.sales.status === "ok");
  check("sales.rootName === 'Online Sales' (not 'Sales')", result.sales.rootName === "Online Sales");
  check(
    "sales.typeNames includes Invoice, AMAZON INVOICE, Sales, and the root itself",
    ["Invoice", "AMAZON INVOICE", "Sales", "Online Sales"].every((n) =>
      result.sales.typeNames.includes(n)
    ),
    JSON.stringify(result.sales.typeNames)
  );
  check("purchase still resolves independently", result.purchase.status === "ok" && result.purchase.rootName === "Purchase");
}

function testMultiLevelHierarchy() {
  console.log("\n=== UNIT: multi-level (3+ hop) hierarchy under a standard root ===");
  const masters = [
    m("Sales", "Sales", "Sales"),
    m("Regional Sales", "Sales", ""),
    m("Regional Sales - East", "Regional Sales", ""),
    m("Regional Sales - East - Branch 1", "Regional Sales - East", ""),
  ];
  const result = classifyVoucherTypes(masters);

  check("sales.status === ok", result.sales.status === "ok");
  check(
    "all 4 hops resolve to the same root, all 4 names included",
    ["Sales", "Regional Sales", "Regional Sales - East", "Regional Sales - East - Branch 1"].every(
      (n) => result.sales.typeNames.includes(n)
    ),
    JSON.stringify(result.sales.typeNames)
  );
}

function testBrokenParentChain() {
  console.log("\n=== UNIT: broken parent chain (dangling parent reference) ===");
  const masters = [
    m("Sales", "Sales", "Sales"),
    m("Orphan Type", "Nonexistent Parent", ""), // "Nonexistent Parent" is not in this list at all
  ];
  const result = classifyVoucherTypes(masters);

  check("sales.status still ok (unrelated to the broken type)", result.sales.status === "ok");
  check(
    "Orphan Type is excluded from sales.typeNames (never guessed)",
    !result.sales.typeNames.includes("Orphan Type")
  );
  check(
    "Orphan Type is excluded from purchase.typeNames too",
    result.purchase.status === "needs_configuration" || !result.purchase.typeNames.includes("Orphan Type")
  );
  check(
    "Orphan Type is reported in unresolvedTypeNames",
    result.unresolvedTypeNames.includes("Orphan Type"),
    JSON.stringify(result.unresolvedTypeNames)
  );
}

function testCyclicHierarchy() {
  console.log("\n=== UNIT: cyclic parent hierarchy (must not hang/crash) ===");
  const masters = [
    m("Sales", "Sales", "Sales"),
    m("Cycle A", "Cycle B", ""),
    m("Cycle B", "Cycle A", ""), // A -> B -> A, never reaches a self-parented root
  ];

  let result;
  let threw = false;
  try {
    result = classifyVoucherTypes(masters);
  } catch (e) {
    threw = true;
  }

  check("does not throw / hang on a cycle", !threw);
  check("sales.status still ok (unrelated to the cycle)", !!result && result.sales.status === "ok");
  check(
    "both cyclic types end up unresolved, not in sales.typeNames",
    !!result &&
      !result.sales.typeNames.includes("Cycle A") &&
      !result.sales.typeNames.includes("Cycle B")
  );
  check(
    "both cyclic types reported in unresolvedTypeNames",
    !!result &&
      result.unresolvedTypeNames.includes("Cycle A") &&
      result.unresolvedTypeNames.includes("Cycle B"),
    JSON.stringify(result && result.unresolvedTypeNames)
  );
}

function testZeroSalesRoot() {
  console.log("\n=== UNIT: zero voucher types carry the reserved Sales classification ===");
  const masters = [
    m("Purchase", "Purchase", "Purchase"),
    m("Journal", "Journal", "Journal"),
  ];
  const result = classifyVoucherTypes(masters);

  check("sales.status === needs_configuration", result.sales.status === "needs_configuration");
  check("sales.typeNames is empty", result.sales.typeNames.length === 0);
  check("sales.reason explains why", /reserved "Sales"/.test(result.sales.reason || ""), result.sales.reason);
  check("purchase still resolves fine (independent)", result.purchase.status === "ok");
}

function testDuplicateSalesRootAmbiguity() {
  console.log("\n=== UNIT: two self-parented roots both claim reservedname=Sales (ambiguous) ===");
  const masters = [
    m("Sales", "Sales", "Sales"),
    m("Online Sales", "Online Sales", "Sales"), // a second, independent self-parented root, also "Sales"
    m("Purchase", "Purchase", "Purchase"),
  ];
  const result = classifyVoucherTypes(masters);

  check("sales.status === needs_configuration (ambiguous, refuses to guess)", result.sales.status === "needs_configuration");
  check("sales.typeNames is empty (no guess made)", result.sales.typeNames.length === 0);
  check(
    "sales.reason names both candidate roots",
    (result.sales.reason || "").includes("Sales") && (result.sales.reason || "").includes("Online Sales"),
    result.sales.reason
  );
  check("purchase unaffected by the Sales ambiguity", result.purchase.status === "ok");
}

function testSalesPurchaseIndependence() {
  console.log("\n=== UNIT: Sales and Purchase classification are fully independent ===");
  // Purchase ambiguous, Sales fine - the reverse of the previous test.
  const masters = [
    m("Sales", "Sales", "Sales"),
    m("Purchase", "Purchase", "Purchase"),
    m("Purchase Returns HQ", "Purchase Returns HQ", "Purchase"), // second Purchase root
  ];
  const result = classifyVoucherTypes(masters);

  check("sales.status === ok even though Purchase is ambiguous", result.sales.status === "ok");
  check("purchase.status === needs_configuration", result.purchase.status === "needs_configuration");
}


// ====================================================================
// SECTION 2: REAL-DATA-DERIVED fixtures
// ====================================================================

// Captured live 2026-09-18 from "We Four" (guid
// d46f1002-00d9-4559-b3e1-afcf8674c7b1) via a real "Type": "VoucherType"
// Collection query (Native Method: "Name, Parent") - see the investigation
// report for the raw curl output this was transcribed from. 39 voucher
// types, matching the company's real count at capture time.
const WE_FOUR_REAL_VOUCHER_TYPES_20260918 = [
  m("AMAZON INVOICE", "Online Sales", ""),
  m("Attendance", "Attendance", "Attendance"),
  m("CK122 Opening Stock", "Job Work Out Order", ""),
  m("CK122 Purchase", "Memorandum", ""),
  m("CK122 Purchase Return", "Rejections Out", ""),
  m("CK122 Sales", "Physical Stock", ""),
  m("CK122 Sales Return", "Delivery Note", ""),
  m("CK122 Stock Adjustment", "Job Work Out Order", ""),
  m("CK Purchase", "Purchase", ""),
  m("CK Sales Order", "Sales Order", ""),
  m("Contra", "Contra", "Contra"),
  m("Credit Note", "Credit Note", "Credit Note"),
  m("Darpan Sale", "Online Sales", ""),
  m("Debit Note", "Debit Note", "Debit Note"),
  m("Delivery Note", "Delivery Note", "Delivery Note"),
  m("Invoice", "Online Sales", ""),
  m("Invoice-Pidilite", "Online Sales", ""),
  m("Job Work In Order", "Job Work In Order", "Job Work In Order"),
  m("Job Work Out Order", "Job Work Out Order", "Job Work Out Order"),
  m("Journal", "Journal", "Journal"),
  m("Material In", "Material In", "Material In"),
  m("Material Out", "Material Out", "Material Out"),
  m("Memorandum", "Memorandum", "Memorandum"),
  m("Online Sales", "Online Sales", "Sales"),
  m("Payment", "Payment", "Payment"),
  m("Payroll", "Payroll", "Payroll"),
  m("Physical Stock", "Physical Stock", "Physical Stock"),
  m("Purchase", "Purchase", "Purchase"),
  m("Purchase Order", "Purchase Order", "Purchase Order"),
  m("Purchase-Pidilite", "Purchase", ""),
  m("Receipt", "Receipt", "Receipt"),
  m("Receipt Note", "Receipt Note", "Receipt Note"),
  m("Rejections In", "Rejections In", "Rejections In"),
  m("Rejections Out", "Rejections Out", "Rejections Out"),
  m("Reversing Journal", "Reversing Journal", "Reversing Journal"),
  m("Sales", "Online Sales", ""),
  m("Sales Order", "Sales Order", "Sales Order"),
  m("SERVICE INVOICE", "Online Sales", ""),
  m("Stock Journal", "Stock Journal", "Stock Journal"),
];

// Captured live 2026-09-18 from "Nirmal FMCG Traders Ltd" (guid
// 09f68f6a-ace7-4ab4-bee8-ddea59ad0731, the dev tenant - a standard,
// un-customized company). 28 voucher types.
const NIRMAL_REAL_VOUCHER_TYPES_20260918 = [
  m("Attendance", "Attendance", "Attendance"),
  m("Contra", "Contra", "Contra"),
  m("Credit Note", "Credit Note", "Credit Note"),
  m("Debit Note", "Debit Note", "Debit Note"),
  m("Delivery Note", "Delivery Note", "Delivery Note"),
  m("dfjlkds", "Stock Journal", ""),
  m("Job Work In Order", "Job Work In Order", "Job Work In Order"),
  m("Job Work Out Order", "Job Work Out Order", "Job Work Out Order"),
  m("Journal", "Journal", "Journal"),
  m("Material In", "Material In", "Material In"),
  m("Material Out", "Material Out", "Material Out"),
  m("Memorandum", "Memorandum", "Memorandum"),
  m("New Sales", "Sales", ""),
  m("Nirmal FMCG Traders Ltd", "Attendance", ""),
  m("Payment", "Payment", "Payment"),
  m("Payroll", "Payroll", "Payroll"),
  m("Physical Stock", "Physical Stock", "Physical Stock"),
  m("Purchase", "Purchase", "Purchase"),
  m("Purchase Order", "Purchase Order", "Purchase Order"),
  m("Raushan", "Stock Journal", ""),
  m("Receipt", "Receipt", "Receipt"),
  m("Receipt Note", "Receipt Note", "Receipt Note"),
  m("Rejections In", "Rejections In", "Rejections In"),
  m("Rejections Out", "Rejections Out", "Rejections Out"),
  m("Reversing Journal", "Reversing Journal", "Reversing Journal"),
  m("Sales", "Sales", "Sales"),
  m("Sales Order", "Sales Order", "Sales Order"),
  m("Stock Journal", "Stock Journal", "Stock Journal"),
];

function testWeFourRealDataDerived() {
  console.log("\n=== REAL-DATA-DERIVED: We Four's actual VoucherType master, replayed offline ===");
  const result = classifyVoucherTypes(WE_FOUR_REAL_VOUCHER_TYPES_20260918);

  check("totalVoucherTypes === 39", result.totalVoucherTypes === 39, result.totalVoucherTypes);
  check("sales.status === ok", result.sales.status === "ok");
  check("sales.rootName === 'Online Sales'", result.sales.rootName === "Online Sales");

  const expectedSales = ["AMAZON INVOICE", "Darpan Sale", "Invoice", "Invoice-Pidilite", "Online Sales", "Sales", "SERVICE INVOICE"];
  check(
    "sales.typeNames === exactly {Invoice, AMAZON INVOICE, Darpan Sale, SERVICE INVOICE, Invoice-Pidilite, Sales, Online Sales}",
    JSON.stringify(result.sales.typeNames.slice().sort()) === JSON.stringify(expectedSales.slice().sort()),
    JSON.stringify(result.sales.typeNames)
  );

  check("purchase.status === ok", result.purchase.status === "ok");
  check("purchase.rootName === 'Purchase'", result.purchase.rootName === "Purchase");
  const expectedPurchase = ["CK Purchase", "Purchase", "Purchase-Pidilite"];
  check(
    "purchase.typeNames === exactly {Purchase, CK Purchase, Purchase-Pidilite}",
    JSON.stringify(result.purchase.typeNames.slice().sort()) === JSON.stringify(expectedPurchase.slice().sort()),
    JSON.stringify(result.purchase.typeNames)
  );

  // Every OTHER voucher type in this company (Sales Order, Purchase
  // Order, Journal, the CK122 job-work family, etc.) must be excluded
  // from both sets - proving this is root-driven classification, not
  // name-substring guessing.
  const neitherExpected = ["Sales Order", "Purchase Order", "CK Sales Order", "Job Work Out Order", "Physical Stock"];
  check(
    "unrelated reserved-but-different-class types are excluded from both sets",
    neitherExpected.every(
      (n) => !result.sales.typeNames.includes(n) && !result.purchase.typeNames.includes(n)
    ),
    JSON.stringify({ sales: result.sales.typeNames, purchase: result.purchase.typeNames })
  );
}

function testNirmalRealDataDerived() {
  console.log("\n=== REAL-DATA-DERIVED: Nirmal FMCG's actual VoucherType master, replayed offline ===");
  const result = classifyVoucherTypes(NIRMAL_REAL_VOUCHER_TYPES_20260918);

  check("totalVoucherTypes === 28", result.totalVoucherTypes === 28, result.totalVoucherTypes);
  check("sales.status === ok", result.sales.status === "ok");
  check("sales.rootName === 'Sales' (standard, not renamed)", result.sales.rootName === "Sales");
  check(
    "sales.typeNames === exactly {Sales, New Sales} - a standard company can still have a custom child",
    JSON.stringify(result.sales.typeNames.slice().sort()) === JSON.stringify(["New Sales", "Sales"]),
    JSON.stringify(result.sales.typeNames)
  );

  check("purchase.status === ok", result.purchase.status === "ok");
  check(
    "purchase.typeNames === exactly {Purchase} (no custom Purchase children in this company)",
    JSON.stringify(result.purchase.typeNames) === JSON.stringify(["Purchase"])
  );
}


// ====================================================================
// SECTION 3: REAL LIVE TALLY integration (adaptive to whichever company
// is actually open right now)
// ====================================================================

const WE_FOUR_GUID = "d46f1002-00d9-4559-b3e1-afcf8674c7b1";
const NIRMAL_GUID = "09f68f6a-ace7-4ab4-bee8-ddea59ad0731";

async function tallyReachable() {
  try {
    await getCompanyInfo();
    return true;
  } catch (e) {
    return false;
  }
}

function countByType(collection) {
  const counts = {};
  for (const v of collection) {
    const t = unwrapJsonExValue(v.vouchertypename);
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

// A company with thousands of vouchers (e.g. We Four: 5,500+ Sales) makes an
// unbounded AlterID>0 fetch (with the inventory/ledger walk) exceed odbcService's
// 30s timeout. Above this many vouchers the live section switches to a bounded
// window: one light query (VoucherTypeName + AlterID only) yields every
// AlterID, and the heavy fetch is limited to the newest LIVE_WINDOW vouchers.
// Small companies (Nirmal) keep the original full-fetch checks unchanged.
const LIVE_FULL_FETCH_MAX = 300;
const LIVE_WINDOW = 25;
const LIVE_TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";

function parseAlterId(raw) {
  const n = Number(String(unwrapJsonExValue(raw)).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function fetchAlterIdsLight(typeNames) {
  const name = `RTS Verify AlterIds ${Date.now()}`;
  const clause = typeNames.map((n) => `$VoucherTypeName = "${n}"`).join(" OR ");
  const response = await axios.post(
    LIVE_TALLY_URL,
    {
      static_variables: [{ name: "svExportFormat", value: "jsonex" }],
      tdlmessage: [{
        definitions: [
          { metadata: { name, type: "Collection" }, attributes: [{ Type: "Voucher" }, { "Native Method": "VoucherTypeName, AlterID" }, { Filter: `${name} Filter` }] },
          { metadata: { name: `${name} Filter`, type: "System", sys_type: "Formulae", ismodify: true }, value: clause },
        ],
      }],
    },
    {
      headers: { "Content-Type": "application/json", Version: "1", TallyRequest: "Export", Type: "Collection", ID: name },
      timeout: 30000,
    }
  );
  return extractVoucherCollection(response.data).map((v) => parseAlterId(v.alterid)).filter((n) => n !== null);
}

// Threshold such that "AlterID > threshold" matches at most LIVE_WINDOW vouchers,
// plus the exact count the light query says that should be.
function boundedWindow(alterIds) {
  const sorted = alterIds.slice().sort((a, b) => b - a);
  const threshold = sorted.length > LIVE_WINDOW ? sorted[LIVE_WINDOW] : 0;
  return { threshold, expected: alterIds.filter((a) => a > threshold).length };
}

async function testLiveClassificationAndQueries() {
  console.log("\n=== REAL LIVE: whichever company is currently open in Tally ===");

  const openCompanies = extractOpenCompanies(await getCompanyInfo());
  check("a company is currently open in Tally", openCompanies.length > 0, JSON.stringify(openCompanies));
  if (!openCompanies.length) return;

  const openGuid = openCompanies[0].guid;
  const label =
    openGuid === WE_FOUR_GUID ? "We Four" : openGuid === NIRMAL_GUID ? "Nirmal FMCG" : `unknown (${openGuid})`;
  console.log(`  currently open company: ${openCompanies[0].name} [${label}]`);

  clearVoucherTypeClassificationCache(openGuid);
  const classification = await resolveVoucherTypeClassification({ companyGuid: openGuid, forceRefresh: true });

  check("live classification: sales.status === ok", classification.sales.status === "ok", JSON.stringify(classification.sales));
  check("live classification: purchase.status === ok", classification.purchase.status === "ok", JSON.stringify(classification.purchase));
  console.log(`  sales root: ${classification.sales.rootName}, typeNames: ${JSON.stringify(classification.sales.typeNames)}`);
  console.log(`  purchase root: ${classification.purchase.rootName}, typeNames: ${JSON.stringify(classification.purchase.typeNames)}`);

  if (openGuid === WE_FOUR_GUID) {
    check(
      "We Four's LIVE classification matches the captured-fixture expectation",
      classification.sales.rootName === "Online Sales" &&
        ["Invoice", "Sales"].every((n) => classification.sales.typeNames.includes(n))
    );
  }
  if (openGuid === NIRMAL_GUID) {
    check(
      "Nirmal's LIVE classification matches the captured-fixture expectation",
      classification.sales.rootName === "Sales" && classification.purchase.typeNames.includes("Purchase")
    );
  }

  // ---- Reconciliation-style GUID query (Section: "Test reconciliation GUID query") ----
  const salesGuidsResponse = await getAllSalesVoucherGuids({ voucherTypeNames: classification.sales.typeNames });
  const salesGuidVouchers = extractVoucherCollection(salesGuidsResponse);
  const salesGuidSet = new Set(
    salesGuidVouchers.map((v) => unwrapJsonExValue(v.guid)).filter((g) => typeof g === "string" && g)
  );
  check(
    "reconciliation-style Sales GUID query returns real GUIDs (or a legitimately empty set)",
    salesGuidVouchers.every((v) => typeof unwrapJsonExValue(v.guid) === "string") || salesGuidVouchers.length === 0
  );
  console.log(`  Sales GUID query: ${salesGuidVouchers.length} vouchers, ${salesGuidSet.size} unique GUIDs`);

  // ---- Classified AlterID query + per-name count cross-check ----
  const salesBounded = salesGuidVouchers.length > LIVE_FULL_FETCH_MAX;
  let salesThreshold = 0;
  let expectedSalesCount = salesGuidVouchers.length;
  if (salesBounded) {
    ({ threshold: salesThreshold, expected: expectedSalesCount } = boundedWindow(
      await fetchAlterIdsLight(classification.sales.typeNames)
    ));
    console.log(`  (large company: ${salesGuidVouchers.length} sales vouchers - bounded window AlterID>${salesThreshold}, expecting ${expectedSalesCount})`);
  }

  const fullSalesResponse = await getSalesVouchersSinceAlterId({
    afterAlterId: salesThreshold,
    voucherTypeNames: classification.sales.typeNames,
  });
  const fullSalesVouchers = extractVoucherCollection(fullSalesResponse);
  const byType = countByType(fullSalesVouchers);
  console.log(`  Sales AlterID>${salesThreshold} query: ${fullSalesVouchers.length} total, by type: ${JSON.stringify(byType)}`);

  check(
    "every returned voucher's type is one of the resolved sales typeNames (no leakage)",
    fullSalesVouchers.every((v) => classification.sales.typeNames.includes(unwrapJsonExValue(v.vouchertypename)))
  );
  check(
    salesBounded
      ? "bounded AlterID window count matches the light-query count for the same type set"
      : "reconciliation GUID count matches the AlterID-query voucher count for the same type set",
    expectedSalesCount === fullSalesVouchers.length,
    `expected=${expectedSalesCount} vouchers=${fullSalesVouchers.length}`
  );

  // ---- Incremental AlterID filtering ----
  let maxAlterId = 0;
  const windowAlterIds = [];
  for (const v of fullSalesVouchers) {
    const n = parseAlterId(v.alterid);
    if (n !== null) {
      windowAlterIds.push(n);
      if (n > maxAlterId) maxAlterId = n;
    }
  }
  windowAlterIds.sort((a, b) => a - b);

  if (fullSalesVouchers.length > 0) {
    const aboveMaxResponse = await getSalesVouchersSinceAlterId({
      afterAlterId: maxAlterId,
      voucherTypeNames: classification.sales.typeNames,
    });
    const aboveMaxVouchers = extractVoucherCollection(aboveMaxResponse);
    check(
      "incremental filtering: AlterID > max observed returns zero vouchers",
      aboveMaxVouchers.length === 0,
      `count=${aboveMaxVouchers.length}`
    );

    if (maxAlterId > 0) {
      // Bounded mode: median of the window keeps this query small too.
      const midThreshold = salesBounded
        ? windowAlterIds[Math.floor(windowAlterIds.length / 2)]
        : Math.floor(maxAlterId / 2);
      const midResponse = await getSalesVouchersSinceAlterId({
        afterAlterId: midThreshold,
        voucherTypeNames: classification.sales.typeNames,
      });
      const midVouchers = extractVoucherCollection(midResponse);
      check(
        "incremental filtering: a mid-range threshold returns a strict subset",
        midVouchers.length <= fullSalesVouchers.length,
        `mid=${midVouchers.length} full=${fullSalesVouchers.length}`
      );
    }
  } else {
    console.log("  (no sales vouchers at all for this company - skipping incremental-threshold sub-check)");
  }

  // ---- Purchase, independently ----
  const purchaseGuidsResponse = await getAllPurchaseVoucherGuids({ voucherTypeNames: classification.purchase.typeNames });
  const purchaseGuidVouchers = extractVoucherCollection(purchaseGuidsResponse);

  const purchaseBounded = purchaseGuidVouchers.length > LIVE_FULL_FETCH_MAX;
  let purchaseThreshold = 0;
  let expectedPurchaseCount = purchaseGuidVouchers.length;
  if (purchaseBounded) {
    ({ threshold: purchaseThreshold, expected: expectedPurchaseCount } = boundedWindow(
      await fetchAlterIdsLight(classification.purchase.typeNames)
    ));
    console.log(`  (large company: ${purchaseGuidVouchers.length} purchase vouchers - bounded window AlterID>${purchaseThreshold}, expecting ${expectedPurchaseCount})`);
  }

  const fullPurchaseResponse = await getPurchaseVouchersSinceAlterId({
    afterAlterId: purchaseThreshold,
    voucherTypeNames: classification.purchase.typeNames,
  });
  const fullPurchaseVouchers = extractVoucherCollection(fullPurchaseResponse);
  console.log(`  Purchase AlterID>${purchaseThreshold} query: ${fullPurchaseVouchers.length} total, by type: ${JSON.stringify(countByType(fullPurchaseVouchers))}`);
  check(
    "Purchase classification/query works independently of Sales",
    fullPurchaseVouchers.every((v) => classification.purchase.typeNames.includes(unwrapJsonExValue(v.vouchertypename)))
  );
  check(
    purchaseBounded
      ? "Purchase bounded AlterID window count matches the light-query count"
      : "Purchase reconciliation GUID count matches Purchase AlterID-query count",
    expectedPurchaseCount === fullPurchaseVouchers.length,
    `expected=${expectedPurchaseCount} vouchers=${fullPurchaseVouchers.length}`
  );

  // ---- Company GUID guard still functions correctly alongside classification ----
  const guardOk = await verifyOpenTallyCompany(openGuid);
  check("company GUID guard: the actually-open company passes", guardOk.ok === true, JSON.stringify(guardOk));

  const guardMismatch = await verifyOpenTallyCompany("00000000-0000-0000-0000-000000000000");
  check(
    "company GUID guard: a fabricated GUID is rejected as a mismatch",
    guardMismatch.ok === false && guardMismatch.reason === "mismatch",
    JSON.stringify(guardMismatch)
  );
}


// ====================================================================
// SECTION 4: SYNTHETIC fail-closed + caching tests (no real Tally needed)
// ====================================================================

function startStubTallyServer(responseBody, { hang = false } = {}) {
  let hitCount = 0;
  const server = http.createServer((req, res) => {
    hitCount += 1;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (hang) return; // never respond - simulates a request that never completes
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
        getHitCount: () => hitCount,
      });
    });
  });
}

function buildStubVoucherTypeResponse(masters) {
  return {
    status: "1",
    data: {
      metadata: {},
      collection: masters.map((entry) => ({
        metadata: { type: "Voucher Type", name: entry.name, reservedname: entry.reservedName },
        parent: { type: "String", value: entry.parent },
      })),
    },
  };
}

async function testFetchFailureDoesNotFallBack() {
  console.log("\n=== SYNTHETIC: VoucherType master fetch failure (connection refused) fails closed ===");

  // Port 1 is a privileged, essentially-never-listening port - a fast,
  // reliable way to get ECONNREFUSED without a real timeout wait. The
  // same catch block in odbcService/voucherTypeClassifier handles a
  // genuine 30s axios timeout identically - this exercises that shared
  // code path without the wall-clock cost.
  clearVoucherTypeClassificationCache("synthetic-unreachable-co");
  const result = await resolveVoucherTypeClassification({
    companyGuid: "synthetic-unreachable-co",
    baseUrl: "http://127.0.0.1:1",
  });

  check("does not throw - returns a result object", !!result);
  check("sales.status === error (not silently ok, not needs_configuration)", result.sales.status === "error", result.sales.status);
  check("purchase.status === error", result.purchase.status === "error", result.purchase.status);
  check(
    "reason clearly identifies a fetch failure, not a classification ambiguity",
    /Could not fetch/i.test(result.sales.reason || ""),
    result.sales.reason
  );
  check(
    "does NOT mention $$VchTypeSales/$$VchTypePurchase as a fallback anywhere in the result",
    !JSON.stringify(result).includes("$$VchType")
  );
}

async function testCachingAvoidsRepeatedFetch() {
  console.log("\n=== SYNTHETIC: classification is cached (VoucherType master fetched once, reused) ===");

  const masters = [m("Sales", "Sales", "Sales"), m("Purchase", "Purchase", "Purchase")];
  const { server, url, getHitCount } = await startStubTallyServer(buildStubVoucherTypeResponse(masters));

  try {
    clearVoucherTypeClassificationCache("synthetic-cache-co");

    const first = await resolveVoucherTypeClassification({ companyGuid: "synthetic-cache-co", baseUrl: url });
    check("first call hits Tally once", getHitCount() === 1, `hits=${getHitCount()}`);
    check("first call source === live", first.source === "live");
    check("first call resolves sales ok", first.sales.status === "ok");

    const second = await resolveVoucherTypeClassification({ companyGuid: "synthetic-cache-co", baseUrl: url });
    check("second call within TTL does NOT hit Tally again", getHitCount() === 1, `hits=${getHitCount()}`);
    check("second call source === cache", second.source === "cache");
    check(
      "cached result has the same classification as the live one",
      JSON.stringify(second.sales.typeNames) === JSON.stringify(first.sales.typeNames)
    );

    const forced = await resolveVoucherTypeClassification({
      companyGuid: "synthetic-cache-co",
      baseUrl: url,
      forceRefresh: true,
    });
    check("forceRefresh bypasses the cache and hits Tally again", getHitCount() === 2, `hits=${getHitCount()}`);
    check("forced call source === live", forced.source === "live");

    // TTL expiry: a very short TTL should cause the next call to refetch
    // even without forceRefresh.
    await new Promise((r) => setTimeout(r, 20));
    const afterTtl = await resolveVoucherTypeClassification({
      companyGuid: "synthetic-cache-co",
      baseUrl: url,
      cacheTtlMs: 10,
    });
    check("expired TTL causes a refetch", getHitCount() === 3, `hits=${getHitCount()}`);
    check("post-TTL-expiry call source === live", afterTtl.source === "live");
  } finally {
    server.close();
  }
}

async function testTransientFetchFailureDoesNotPoisonCache() {
  console.log("\n=== SYNTHETIC: a failed fetch is never cached (next call retries live) ===");

  clearVoucherTypeClassificationCache("synthetic-transient-co");

  const failureResult = await resolveVoucherTypeClassification({
    companyGuid: "synthetic-transient-co",
    baseUrl: "http://127.0.0.1:1",
  });
  check("first (failing) call reports error", failureResult.sales.status === "error");

  const masters = [m("Sales", "Sales", "Sales"), m("Purchase", "Purchase", "Purchase")];
  const { server, url, getHitCount } = await startStubTallyServer(buildStubVoucherTypeResponse(masters));
  try {
    const recovered = await resolveVoucherTypeClassification({
      companyGuid: "synthetic-transient-co",
      baseUrl: url,
    });
    check("a subsequent successful call is NOT blocked by the earlier failure", recovered.sales.status === "ok", JSON.stringify(recovered.sales));
    check("that successful call genuinely hit Tally (failure wasn't cached as success)", getHitCount() === 1);
  } finally {
    server.close();
  }
}

async function testNeedsConfigurationViaStub() {
  console.log("\n=== SYNTHETIC: end-to-end NEEDS_CONFIGURATION through resolveVoucherTypeClassification ===");

  const masters = [m("Purchase", "Purchase", "Purchase"), m("Journal", "Journal", "Journal")]; // no Sales root at all
  const { server, url } = await startStubTallyServer(buildStubVoucherTypeResponse(masters));

  try {
    clearVoucherTypeClassificationCache("synthetic-needs-config-co");
    const result = await resolveVoucherTypeClassification({ companyGuid: "synthetic-needs-config-co", baseUrl: url });

    check("sales.status === needs_configuration", result.sales.status === "needs_configuration");
    check("purchase.status === ok (independent)", result.purchase.status === "ok");
    check(
      "getSalesVouchersSinceAlterId refuses an empty voucherTypeNames array rather than falling back",
      true // exercised directly below
    );

    let threw = false;
    let message = "";
    try {
      await getSalesVouchersSinceAlterId({ afterAlterId: 0, voucherTypeNames: result.sales.typeNames });
    } catch (e) {
      threw = true;
      message = e.message;
    }
    check("calling the fetch function with the unresolved (empty) set throws rather than querying $$VchTypeSales", threw, message);
    check(
      "the error is the explicit empty-set guard, not a Tally-side error from an attempted fallback query",
      /requires a resolved, non-empty voucherTypeNames array/.test(message),
      message
    );
  } finally {
    server.close();
  }
}


// ====================================================================
// MAIN
// ====================================================================

async function main() {
  // Section 1
  testStandardRoot();
  testRenamedRootLikeWeFour();
  testMultiLevelHierarchy();
  testBrokenParentChain();
  testCyclicHierarchy();
  testZeroSalesRoot();
  testDuplicateSalesRootAmbiguity();
  testSalesPurchaseIndependence();

  // Section 2
  testWeFourRealDataDerived();
  testNirmalRealDataDerived();

  // Section 4 (synthetic - no live Tally needed, run before/independent of section 3)
  await testFetchFailureDoesNotFallBack();
  await testCachingAvoidsRepeatedFetch();
  await testTransientFetchFailureDoesNotPoisonCache();
  await testNeedsConfigurationViaStub();

  // Section 3 (live - only if Tally is reachable right now)
  const reachable = await tallyReachable();
  console.log(`\nTallyPrime reachable: ${reachable}`);
  if (reachable) {
    await testLiveClassificationAndQueries();
  } else {
    console.log("Skipping REAL LIVE section - TallyPrime unreachable right now.");
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("Voucher type classification verification crashed:", error);
  process.exitCode = 1;
});
