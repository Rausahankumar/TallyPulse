/**
 * Parser unit tests for the corrected header.voucherTotalAmount formula
 * (financial-data-correctness fix, tallyParser.js computePartyLedgerTotal /
 * parseTallyVoucher). Pure unit tests - no MongoDB, no Tally, no network.
 *
 * Run: node verify-tally-parser-voucher-total.js
 */

const assert = require("assert");
const { parseTallyVoucher, computePartyLedgerTotal } = require("./src/services/parser/tallyParser");

let pass = 0;
let fail = 0;

function check(id, description, actual, expected) {
  const ok =
    typeof expected === "number"
      ? Math.abs(actual - expected) < 0.005
      : actual === expected;

  if (ok) {
    pass += 1;
    console.log(`PASS | ${id} - ${description}`);
  } else {
    fail += 1;
    console.log(`FAIL | ${id} - ${description}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

// Raw-Tally-shaped fixture helpers, matching the existing convention used
// in verify-voucher-lifecycle.js (lowercase field names, string amounts).
function inv({ itemName, quantity = 1, rate, amount }) {
  return { stockitemname: itemName, actualqty: String(quantity), rate: String(rate), amount: String(amount) };
}
function ledg({ name, amount, isDeemedPositive }) {
  return { ledgername: name, amount: String(amount), isdeemedpositive: isDeemedPositive };
}
function voucher({ voucherNo, party, type = "Sales", inventoryentries, ledgerentries, guid = `guid-${voucherNo}`, alterid = 1 }) {
  const v = {
    vouchernumber: voucherNo,
    date: "20260905",
    partyname: party,
    vouchertypename: type,
    guid,
    alterid: String(alterid),
    ledgerentries,
  };
  if (inventoryentries) v.inventoryentries = inventoryentries;
  return v;
}

// --------------------------------------------------
// 1. Sales with GST
// --------------------------------------------------
{
  const v = voucher({
    voucherNo: "T1", party: "Gupta Book Depo", type: "Sales",
    inventoryentries: [inv({ itemName: "Item A", quantity: 6, rate: 151.53, amount: 909.20 })],
    ledgerentries: [
      ledg({ name: "Gupta Book Depo", amount: -1073, isDeemedPositive: true }),
      ledg({ name: "CGST", amount: 81.83, isDeemedPositive: false }),
      ledg({ name: "SGST", amount: 81.83, isDeemedPositive: false }),
      ledg({ name: "Rounding Off", amount: 0.14, isDeemedPositive: false }),
    ],
  });
  const parsed = parseTallyVoucher(v);
  check("1-sales-with-gst", "Sales+GST uses party ledger (1073.00), not inventory subtotal (909.20)", parsed.header.voucherTotalAmount, 1073.00);
}

// --------------------------------------------------
// 2. Sales without tax
// --------------------------------------------------
{
  const v = voucher({
    voucherNo: "T2", party: "Plain Customer", type: "Sales",
    inventoryentries: [inv({ itemName: "Item B", quantity: 1, rate: 500, amount: 500 })],
    ledgerentries: [
      ledg({ name: "Plain Customer", amount: -500, isDeemedPositive: true }),
      ledg({ name: "Sales", amount: 500, isDeemedPositive: false }),
    ],
  });
  const parsed = parseTallyVoucher(v);
  check("2-sales-no-tax", "Sales with no tax component: party ledger equals inventory total (500.00)", parsed.header.voucherTotalAmount, 500.00);
}

// --------------------------------------------------
// 3. Purchase with GST
// --------------------------------------------------
{
  const v = voucher({
    voucherNo: "T3", party: "PENNRITE PVT. LTD", type: "Purchase",
    inventoryentries: [inv({ itemName: "Item C", quantity: 5, rate: 508.14, amount: -2540.70 })],
    ledgerentries: [
      ledg({ name: "PENNRITE PVT. LTD", amount: 3057.00, isDeemedPositive: false }),
      ledg({ name: "IGST", amount: -466.33, isDeemedPositive: true }),
    ],
  });
  const parsed = parseTallyVoucher(v);
  check("3-purchase-with-gst", "Purchase+GST uses party ledger (3057.00), not negative inventory subtotal", parsed.header.voucherTotalAmount, 3057.00);
}

// --------------------------------------------------
// 4. Purchase with freight
// --------------------------------------------------
{
  const v = voucher({
    voucherNo: "T4", party: "Freight Supplier", type: "Purchase",
    inventoryentries: [inv({ itemName: "Item D", quantity: 2, rate: 100, amount: -200 })],
    ledgerentries: [
      ledg({ name: "Freight Supplier", amount: 250, isDeemedPositive: false }),
      ledg({ name: "X Freight & Cartage GST", amount: -50, isDeemedPositive: true }),
    ],
  });
  const parsed = parseTallyVoucher(v);
  check("4-purchase-with-freight", "Purchase+freight: total (250.00) includes the freight ledger", parsed.header.voucherTotalAmount, 250.00);
}

// --------------------------------------------------
// 5. Purchase with rounding
// --------------------------------------------------
{
  const v = voucher({
    voucherNo: "T5", party: "Rounding Supplier", type: "Purchase",
    inventoryentries: [inv({ itemName: "Item E", quantity: 1, rate: 99.97, amount: -99.97 })],
    ledgerentries: [
      ledg({ name: "Rounding Supplier", amount: 100, isDeemedPositive: false }),
      ledg({ name: "Rounding Off", amount: -0.03, isDeemedPositive: true }),
    ],
  });
  const parsed = parseTallyVoucher(v);
  check("5-purchase-with-rounding", "Purchase+rounding: total (100.00) includes the rounding ledger", parsed.header.voucherTotalAmount, 100.00);
}

// --------------------------------------------------
// 6. Inventory voucher (general case, already covered by 1/3, asserted
// separately here to lock in "has inventory" as its own scenario)
// --------------------------------------------------
{
  const v = voucher({
    voucherNo: "T6", party: "Inventory Party", type: "Sales",
    inventoryentries: [inv({ itemName: "Item F", quantity: 3, rate: 100, amount: 300 })],
    ledgerentries: [
      ledg({ name: "Inventory Party", amount: -354, isDeemedPositive: true }),
      ledg({ name: "CGST", amount: 27, isDeemedPositive: false }),
      ledg({ name: "SGST", amount: 27, isDeemedPositive: false }),
    ],
  });
  const parsed = parseTallyVoucher(v);
  check("6-inventory-voucher", "Inventory voucher correctly overridden by party ledger (354.00)", parsed.header.voucherTotalAmount, 354.00);
}

// --------------------------------------------------
// 7. Non-inventory voucher (no inventoryentries key at all - matches the
// existing purchaseVoucher()/salesVoucher() fixture idiom already used
// elsewhere in this repo's test suite)
// --------------------------------------------------
{
  const v = voucher({
    voucherNo: "T7", party: "Verify Vendor", type: "Purchase",
    ledgerentries: [
      ledg({ name: "Purchase AC", amount: 100, isDeemedPositive: true }),
      ledg({ name: "Verify Vendor", amount: -100, isDeemedPositive: false }),
    ],
  });
  const parsed = parseTallyVoucher(v);
  check("7-non-inventory-voucher", "Non-inventory voucher: party ledger total (100.00), no regression vs the old ledgerTotal fallback (also 100.00 here)", parsed.header.voucherTotalAmount, 100.00);
}

// --------------------------------------------------
// 8. Multiple ledger entries (more than one non-party ledger line)
// --------------------------------------------------
{
  const v = voucher({
    voucherNo: "T8", party: "Multi Ledger Party", type: "Sales",
    inventoryentries: [inv({ itemName: "Item G", quantity: 1, rate: 1000, amount: 1000 })],
    ledgerentries: [
      ledg({ name: "Multi Ledger Party", amount: -1210, isDeemedPositive: true }),
      ledg({ name: "CGST", amount: 90, isDeemedPositive: false }),
      ledg({ name: "SGST", amount: 90, isDeemedPositive: false }),
      ledg({ name: "Freight", amount: 30, isDeemedPositive: false }),
      ledg({ name: "Rounding Off", amount: 0, isDeemedPositive: false }),
    ],
  });
  const parsed = parseTallyVoucher(v);
  check("8-multiple-ledger-entries", "4 non-party ledger lines: formula only reads the party-matching entry (1210.00)", parsed.header.voucherTotalAmount, 1210.00);
}

// --------------------------------------------------
// 9. Sales sign convention
// --------------------------------------------------
{
  const v = voucher({
    voucherNo: "T9", party: "Sign Check Sales", type: "Sales",
    inventoryentries: [inv({ itemName: "Item H", quantity: 1, rate: 200, amount: 200 })],
    ledgerentries: [
      ledg({ name: "Sign Check Sales", amount: -200, isDeemedPositive: true }),
      ledg({ name: "Sales", amount: 200, isDeemedPositive: false }),
    ],
  });
  const parsed = parseTallyVoucher(v);
  check("9-sales-sign-convention", "Sales: positive inventoryTotal input still yields a positive absolute total (200.00)", parsed.header.voucherTotalAmount, 200.00);
  check("9-sales-sign-convention-positive", "voucherTotalAmount is never negative for a positive-signed inventory voucher", parsed.header.voucherTotalAmount >= 0, true);
}

// --------------------------------------------------
// 10. Purchase sign convention
// --------------------------------------------------
{
  const v = voucher({
    voucherNo: "T10", party: "Sign Check Purchase", type: "Purchase",
    inventoryentries: [inv({ itemName: "Item I", quantity: 1, rate: 200, amount: -200 })],
    ledgerentries: [
      ledg({ name: "Sign Check Purchase", amount: 200, isDeemedPositive: false }),
    ],
  });
  const parsed = parseTallyVoucher(v);
  check("10-purchase-sign-convention", "Purchase: negative inventoryTotal input still yields a positive absolute total (200.00), not negative", parsed.header.voucherTotalAmount, 200.00);
  check("10-purchase-sign-convention-positive", "voucherTotalAmount is never negative for a negative-signed (Purchase) inventory voucher", parsed.header.voucherTotalAmount >= 0, true);
}

// --------------------------------------------------
// 11. Missing party ledger (no ledger entry's name matches partyName) -
// must fall back to the old inventoryTotal||ledgerTotal||0 formula, never
// crash, never silently return 0 for a voucher that clearly has value.
// --------------------------------------------------
{
  const v = voucher({
    voucherNo: "T11", party: "Party Name Not In Ledgers", type: "Sales",
    inventoryentries: [inv({ itemName: "Item J", quantity: 1, rate: 400, amount: 400 })],
    ledgerentries: [
      // Deliberately does NOT include a "Party Name Not In Ledgers" entry.
      ledg({ name: "Some Other Ledger", amount: -400, isDeemedPositive: true }),
    ],
  });
  const parsed = parseTallyVoucher(v);
  check("11-missing-party-ledger", "No party-matching ledger: falls back to inventoryTotal (400.00), not a crash or 0", parsed.header.voucherTotalAmount, 400.00);
  check("11-missing-party-ledger-helper", "computePartyLedgerTotal itself returns null (not 0) when no match exists", computePartyLedgerTotal([{ ledgerName: "Some Other Ledger", ledgerAmount: -400 }], "Party Name Not In Ledgers"), null);
}

// --------------------------------------------------
// 12. Zero/invalid ledger amount
// --------------------------------------------------
{
  // A party ledger that genuinely nets to zero (e.g. a fully-offsetting
  // reversal) - this is a legitimate real value, not an error: the total
  // really is 0, and the formula must not fall back to inventoryTotal in
  // this case (that would silently ignore a real zero-value voucher).
  const zeroNet = computePartyLedgerTotal(
    [{ ledgerName: "Zero Party", ledgerAmount: 500 }, { ledgerName: "Zero Party", ledgerAmount: -500 }],
    "Zero Party"
  );
  check("12a-zero-net-party-ledger", "Party ledger entries that net to exactly 0 return 0 (not null, not a fallback)", zeroNet, 0);

  // "Invalid" (non-numeric) ledger amounts never actually reach
  // computePartyLedgerTotal in the real pipeline - parseAmount() (used to
  // build parsedLedgers before this function runs) already sanitizes
  // non-numeric text down to 0. Verified end-to-end here, not assumed.
  const v = voucher({
    voucherNo: "T12", party: "Garbage Amount Party", type: "Sales",
    inventoryentries: [inv({ itemName: "Item K", quantity: 1, rate: 50, amount: 50 })],
    ledgerentries: [
      ledg({ name: "Garbage Amount Party", amount: "not-a-number", isDeemedPositive: true }),
    ],
  });
  const parsed = parseTallyVoucher(v);
  check("12b-invalid-ledger-amount-sanitized-upstream", "Non-numeric ledger amount text is sanitized to 0 by parseAmount() before it reaches computePartyLedgerTotal - result is a finite number, never NaN", Number.isFinite(parsed.header.voucherTotalAmount), true);
}

// --------------------------------------------------
// 13. Case/identity behavior of party name (documents current, real,
// CASE-SENSITIVE exact-match behavior - deliberately NOT made
// case-insensitive here, since that would be inventing an untested rule
// for a scenario with zero supporting evidence in the 5,929-voucher
// audit. See the final report for why this is flagged, not silently
// "fixed".)
// --------------------------------------------------
{
  const exactMatch = computePartyLedgerTotal([{ ledgerName: "ABC Traders", ledgerAmount: -500 }], "ABC Traders");
  check("13a-case-exact-match", "Exact-case match works", exactMatch, 500);

  const caseMismatch = computePartyLedgerTotal([{ ledgerName: "abc traders", ledgerAmount: -500 }], "ABC Traders");
  check("13b-case-mismatch-is-not-matched", "A case-different ledgerName is NOT treated as a match (case-sensitive by design) - returns null so the caller's fallback applies", caseMismatch, null);
}

// --------------------------------------------------
// 14. Multiple ledger entries with the SAME party name - entries are
// summed (net) BEFORE taking the absolute value, never summed as
// separate absolutes. Uses opposite-signed entries specifically so the
// two possible behaviors give different, distinguishable answers.
// --------------------------------------------------
{
  // net = -1200 + 127 = -1073 -> abs = 1073 (correct: the party's net position)
  // WRONG alternative would be abs(-1200)+abs(127) = 1327
  const netThenAbs = computePartyLedgerTotal(
    [{ ledgerName: "Split Party", ledgerAmount: -1200 }, { ledgerName: "Split Party", ledgerAmount: 127 }],
    "Split Party"
  );
  check("14-duplicate-party-ledger-net-then-abs", "Multiple same-name party entries are summed (net) then abs'd: 1073.00, not 1327.00", netThenAbs, 1073.00);
}

console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
if (fail > 0) process.exit(1);
process.exit(0);
