/**
 * Tally Purchase voucher -> Purchase document: parser (tallyParser.parseTallyVoucher) -> mapper
 * (purchaseMapper.mapTallyPurchase) -> the Purchase schema. The same path processSinglePurchaseVoucher (voucherPersistence.js)
 * runs before every Purchase write, for the sync worker, recovery and the import.
 *
 * Every expected amount below is worked out by hand from the fixture's own numbers (see the comment next to each), never
 * read back from the mapper. Contract (docs/PROJECT_CONTEXT.md, "Stored signs"; tallyParser.js computePartyLedgerTotal):
 * the voucher total is the supplier (party) ledger's net amount, made absolute - tax-inclusive - while item amounts are
 * stored exactly as Tally sends them (NEGATIVE on a purchase) and are pre-tax.
 *
 * Pure and offline: synthetic vouchers defined inline, no MongoDB connection, no Tally, no network.
 *
 * Run: node verify-purchase-mapper.js
 */

const { parseTallyVoucher } = require("./src/services/parser/tallyParser");
const { mapTallyPurchase } = require("./src/services/mapper/purchaseMapper");
const Purchase = require("./src/models/purchase.model");

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 300)})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);

// Raw-Tally-shaped purchase (lowercase keys, string amounts), synthetic names only. On a purchase Tally sends the item
// amounts negative and the supplier ledger positive (the supplier is credited).
const raw = (o = {}) => ({
  vouchernumber: "PUR-1",
  date: "20260905",
  partyname: "Test Supplier",
  vouchertypename: "Purchase",
  guid: "guid-PUR-1",
  alterid: "11",
  narration: "synthetic purchase",
  inventoryentries: [
    { stockitemname: "Item A", actualqty: "10", rate: "100", amount: "-1000" },
    { stockitemname: "Item B", actualqty: "5", rate: "20.50", amount: "-102.50" },
  ],
  ledgerentries: [
    { ledgername: "Test Supplier", amount: "1300.96", isdeemedpositive: "No" },
    { ledgername: "Purchase Account", amount: "-1102.50", isdeemedpositive: "Yes" },
    { ledgername: "Input CGST", amount: "-99.23", isdeemedpositive: "Yes" },
    { ledgername: "Input SGST", amount: "-99.23", isdeemedpositive: "Yes" },
  ],
  ...o,
});
const TENANT = "TEST-TENANT-purchase-mapper";
const map = (voucher, ctx = { tenantId: TENANT }) => mapTallyPurchase(parseTallyVoucher(voucher), ctx);
const throwsWith = (fn, pattern) => {
  try {
    fn();
    return false;
  } catch (e) {
    return pattern.test(e.message);
  }
};

(async () => {
  section("1. a purchase with GST: the total is the supplier ledger (tax-inclusive), items stay pre-tax and negative");
  {
    const m = map(raw());
    // 10 x 100 = 1000.00 and 5 x 20.50 = 102.50 -> pre-tax subtotal 1102.50; + CGST 99.23 + SGST 99.23 = 1300.96.
    check("voucherTotalAmount is the supplier ledger total 1300.96 (1102.50 + 99.23 + 99.23)", m.header.voucherTotalAmount === 1300.96, m.header.voucherTotalAmount);
    check("the total is NOT the pre-tax item subtotal 1102.50", m.header.voucherTotalAmount !== 1102.5);
    check("the total is positive although the item amounts are negative", m.header.voucherTotalAmount > 0);
    check("item lines keep Tally's negative amounts: -1000 and -102.50", m.inventory.length === 2 && m.inventory[0].amount === -1000 && m.inventory[1].amount === -102.5, JSON.stringify(m.inventory.map((l) => l.amount)));
    check("item lines keep quantity and rate: 10 @ 100 and 5 @ 20.50", m.inventory[0].quantity === 10 && m.inventory[0].rate === 100 && m.inventory[1].quantity === 5 && m.inventory[1].rate === 20.5, JSON.stringify(m.inventory.map((l) => [l.quantity, l.rate])));
    check("the pre-tax lines and the tax-inclusive total differ by exactly the tax (198.46 = 2 x 99.23)", Math.abs(m.header.voucherTotalAmount - Math.abs(m.inventory[0].amount + m.inventory[1].amount) - 198.46) < 1e-9);
    check("no discount on the lines -> discount fields are 0", m.inventory.every((l) => l.discountPercentage === 0 && l.discountAmount === 0));
  }

  section("2. identity, date, type and status");
  {
    const m = map(raw());
    check("tenant comes from the context, never from the Tally data", m.tenantId === TENANT);
    check("header: number, type, supplier, narration", m.header.voucherNo === "PUR-1" && m.header.voucherType === "Purchase" && m.header.partyName === "Test Supplier" && m.header.narration === "synthetic purchase", JSON.stringify(m.header));
    check("date is UTC midnight of the voucher day 2026-09-05 (no timezone drift)", m.header.voucherDate instanceof Date && m.header.voucherDate.toISOString() === "2026-09-05T00:00:00.000Z", m.header.voucherDate);
    check("identity fields: tallyGuid guid-PUR-1 and numeric tallyAlterId 11", m.tallyGuid === "guid-PUR-1" && m.tallyAlterId === 11, JSON.stringify([m.tallyGuid, m.tallyAlterId]));
    check("an ordinary purchase is active", m.voucherStatus === "active");
    check("a cancelled purchase maps to voucherStatus cancelled", map(raw({ iscancelled: "Yes" })).voucherStatus === "cancelled");
    check("a deleted purchase maps to voucherStatus deleted", map(raw({ isdeleted: "Yes" })).voucherStatus === "deleted");
    check("ledger entries keep name, amount and a Debit/Credit type", m.ledgers.length === 4 && m.ledgers[0].ledgerName === "Test Supplier" && m.ledgers[0].ledgerAmount === 1300.96 && m.ledgers.every((l) => ["Debit", "Credit"].includes(l.entryType)), JSON.stringify(m.ledgers[0]));
  }

  section("3. decimals, formatted amounts, zero and invalid values");
  {
    // A thousands separator in the supplier amount: "1,234.56" is 1234.56.
    let m = map(raw({ ledgerentries: [{ ledgername: "Test Supplier", amount: "1,234.56", isdeemedpositive: "No" }, { ledgername: "Purchase Account", amount: "-1,234.56", isdeemedpositive: "Yes" }] }));
    check("a formatted supplier amount '1,234.56' gives a total of 1234.56", m.header.voucherTotalAmount === 1234.56, m.header.voucherTotalAmount);

    // Two lines for the same supplier net before the absolute value: 300.00 - 50.00 = 250.00 (not 350.00).
    m = map(raw({ ledgerentries: [{ ledgername: "Test Supplier", amount: "300", isdeemedpositive: "No" }, { ledgername: "Test Supplier", amount: "-50", isdeemedpositive: "Yes" }, { ledgername: "Purchase Account", amount: "-250", isdeemedpositive: "Yes" }] }));
    check("two supplier lines (+300, -50) net to a total of 250, not 350", m.header.voucherTotalAmount === 250, m.header.voucherTotalAmount);

    // A supplier ledger that genuinely nets to 0 is a real total of 0 - it must not fall back to the 1102.50 of the items.
    m = map(raw({ ledgerentries: [{ ledgername: "Test Supplier", amount: "0", isdeemedpositive: "No" }, { ledgername: "Purchase Account", amount: "0", isdeemedpositive: "Yes" }] }));
    check("a supplier ledger of 0 gives a total of 0 (no fallback to the item subtotal)", m.header.voucherTotalAmount === 0, m.header.voucherTotalAmount);

    // A non-numeric supplier amount is read as 0 (a finite number), never NaN.
    m = map(raw({ ledgerentries: [{ ledgername: "Test Supplier", amount: "not a number", isdeemedpositive: "No" }] }));
    check("a non-numeric supplier amount gives a finite total of 0, never NaN", m.header.voucherTotalAmount === 0 && Number.isFinite(m.header.voucherTotalAmount), m.header.voucherTotalAmount);

    // A non-numeric item amount is read as 0; the total still comes from the supplier ledger (1300.96).
    m = map(raw({ inventoryentries: [{ stockitemname: "Item A", actualqty: "10", rate: "100", amount: "junk" }] }));
    check("a non-numeric item amount is stored as 0 and does not change the supplier total 1300.96", m.inventory[0].amount === 0 && m.header.voucherTotalAmount === 1300.96, JSON.stringify([m.inventory[0].amount, m.header.voucherTotalAmount]));
  }

  section("4. fallback when no supplier ledger line carries the total");
  {
    // No inventory and no ledger line named after the supplier: the fallback is half the sum of the absolute ledger
    // amounts of a balanced voucher, (150 + 150) / 2 = 150.
    const m = map(raw({
      partyname: "Supplier Not In Ledgers",
      inventoryentries: [],
      ledgerentries: [{ ledgername: "Freight Expense", amount: "-150", isdeemedpositive: "Yes" }, { ledgername: "Cash", amount: "150", isdeemedpositive: "No" }],
    }));
    check("no inventory and no supplier line: total falls back to the balanced ledger amount 150", m.header.voucherTotalAmount === 150, m.header.voucherTotalAmount);

    // Items but no ledger line named after the supplier: the fallback is the item subtotal. A purchase's items arrive
    // negative (-200 and -50.25), but the stored voucher total is absolute (docs/PROJECT_CONTEXT.md, "Stored signs"),
    // so the expected total is 200 + 50.25 = 250.25 - never -250.25, which purchase totals would subtract.
    const f = map(raw({
      partyname: "Supplier Not In Ledgers",
      inventoryentries: [
        { stockitemname: "Item A", actualqty: "2", rate: "100", amount: "-200" },
        { stockitemname: "Item B", actualqty: "1", rate: "50.25", amount: "-50.25" },
      ],
      ledgerentries: [{ ledgername: "Purchase Account", amount: "-250.25", isdeemedpositive: "Yes" }],
    }));
    check("items but no supplier line: total falls back to the item subtotal as a positive 250.25 (not -250.25)", f.header.voucherTotalAmount === 250.25, f.header.voucherTotalAmount);
    check("...while the item amounts themselves stay negative as Tally sent them", f.inventory[0].amount === -200 && f.inventory[1].amount === -50.25, JSON.stringify(f.inventory.map((l) => l.amount)));
  }

  section("5. required fields are refused, never invented");
  {
    check("no tenantId in the context -> refused (the tenant is never guessed from Tally data)", throwsWith(() => map(raw(), {}), /tenantId/));
    check("no context at all -> refused", throwsWith(() => mapTallyPurchase(parseTallyVoucher(raw()), null), /context/));
    check("a voucher without a number is refused", throwsWith(() => map(raw({ vouchernumber: "" })), /voucherNo/));
    check("a voucher without a date is refused", throwsWith(() => map(raw({ date: "" })), /voucherDate/));
    check("a voucher without a supplier is refused", throwsWith(() => map(raw({ partyname: "" })), /partyName/));
    check("an inventory line without an item name is refused", throwsWith(() => map(raw({ inventoryentries: [{ stockitemname: "", actualqty: "1", rate: "1", amount: "-1" }] })), /itemName/));
  }

  section("6. the mapped document satisfies the Purchase schema exactly");
  {
    const m = map(raw());
    let err = null;
    try {
      await new Purchase(m).validate();
    } catch (e) {
      err = e;
    }
    check("Mongoose validation passes", err === null, err && err.message);
    const allowedRoot = new Set(Object.keys(Purchase.schema.paths).map((p) => p.split(".")[0]));
    check("no field outside the schema at the root", Object.keys(m).every((k) => allowedRoot.has(k)), Object.keys(m).filter((k) => !allowedRoot.has(k)).join(","));
  }

  console.log(`\nverify-purchase-mapper: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
