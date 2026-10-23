/**
 * Tally voucher -> Sale document: parser (tallyParser.parseTallyVoucher) -> mapper (salesMapper.mapTallySale) -> the
 * Sale schema, with the guarantees the sync and the manual import rely on. Pure and offline: synthetic vouchers
 * defined inline, no MongoDB connection, no Tally, no network.
 *
 * Run: node verify-sales-mapper.js
 */

const { parseTallyVoucher } = require("./src/services/parser/tallyParser");
const { mapTallySale, normalizeVoucherType } = require("./src/services/mapper/salesMapper");
const Sale = require("./src/models/sales.model");

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

// Raw-Tally-shaped fixture (lowercase field names, string amounts), synthetic names only.
const raw = (o = {}) => ({
  vouchernumber: "S-1",
  date: "20260905",
  partyname: "Test Customer",
  vouchertypename: "Sales",
  guid: "guid-S-1",
  alterid: "7",
  narration: "synthetic voucher",
  inventoryentries: [
    { stockitemname: "Item A", actualqty: "6", rate: "151.53", amount: "909.20" },
    { stockitemname: "Item B", actualqty: "2", rate: "50", amount: "100" },
  ],
  ledgerentries: [
    { ledgername: "Test Customer", amount: "-1189", isdeemedpositive: "Yes" },
    { ledgername: "Sales Account", amount: "1009.20", isdeemedpositive: "No" },
    { ledgername: "CGST", amount: "89.9", isdeemedpositive: "No" },
    { ledgername: "SGST", amount: "89.9", isdeemedpositive: "No" },
  ],
  ...o,
});
const TENANT = "TEST-TENANT-sales-mapper";
const map = (voucher, ctx = { tenantId: TENANT }) => mapTallySale(parseTallyVoucher(voucher), ctx);

(async () => {
  section("1. a normal voucher maps to a complete, tenant-stamped Sale document");
  {
    const m = map(raw());
    check("tenant comes from the context, never from the Tally data", m.tenantId === TENANT);
    check("header: number, type, party, narration", m.header.voucherNo === "S-1" && m.header.voucherType === "Sales" && m.header.partyName === "Test Customer" && m.header.narration === "synthetic voucher");
    check("date is UTC midnight of the voucher day (no timezone drift)", m.header.voucherDate.toISOString() === "2026-09-05T00:00:00.000Z", m.header.voucherDate);
    check("voucherTotalAmount is the party ledger total (1189.00), not the inventory subtotal (1009.20)", m.header.voucherTotalAmount === 1189);
    check("inventory lines keep item, quantity, rate and amount", m.inventory.length === 2 && m.inventory[0].itemName === "Item A" && m.inventory[0].quantity === 6 && m.inventory[0].rate === 151.53 && m.inventory[0].amount === 909.2);
    check("ledger entries keep name, amount and a Debit/Credit type", m.ledgers.length === 4 && m.ledgers[0].ledgerName === "Test Customer" && ["Debit", "Credit"].includes(m.ledgers[0].entryType));
    check("identity fields: tallyGuid + tallyAlterId", m.tallyGuid === "guid-S-1" && m.tallyAlterId === 7);
    check("an ordinary voucher is active", m.voucherStatus === "active");
  }

  section("2. the mapped document satisfies the Sale schema exactly");
  {
    const m = map(raw());
    const doc = new Sale(m);
    let err = null;
    try {
      await doc.validate();
    } catch (e) {
      err = e;
    }
    check("Mongoose validation passes", err === null, err && err.message);
    const paths = new Set(Object.keys(Sale.schema.paths).map((p) => p.split(".")[0]));
    const extraRoot = Object.keys(m).filter((k) => !paths.has(k));
    check("no field outside the schema at the root", extraRoot.length === 0, extraRoot.join(","));
    const invPaths = new Set(Object.keys(Sale.schema.path("inventory").schema.paths));
    const ledPaths = new Set(Object.keys(Sale.schema.path("ledgers").schema.paths));
    check("no field outside the schema in inventory lines or ledger entries", m.inventory.every((i) => Object.keys(i).every((k) => invPaths.has(k))) && m.ledgers.every((l) => Object.keys(l).every((k) => ledPaths.has(k))));
  }

  section("3. cancelled / deleted vouchers are marked, never treated as active");
  {
    const cancelled = map(raw({ iscancelled: "Yes" }));
    check("a cancelled voucher maps to voucherStatus cancelled", cancelled.voucherStatus === "cancelled", cancelled.voucherStatus);
  }

  section("4. fail closed: nothing is invented");
  {
    const throws = (fn) => {
      try {
        fn();
        return null;
      } catch (e) {
        return e.message;
      }
    };
    check("no tenantId in the context -> refused (the tenant is never guessed from Tally data)", /tenantId/.test(throws(() => map(raw(), {})) || ""));
    check("no context at all -> refused", /context object/.test(throws(() => mapTallySale(parseTallyVoucher(raw()))) || "") || /tenantId/.test(throws(() => mapTallySale(parseTallyVoucher(raw()))) || ""));
    check("a voucher without a number is refused", /voucherNo/.test(throws(() => map(raw({ vouchernumber: "" }))) || ""));
    check("a voucher without a party is refused", /partyName/.test(throws(() => map(raw({ partyname: "" }))) || ""));
    check("an inventory line without an item name is refused", /itemName/.test(throws(() => map(raw({ inventoryentries: [{ stockitemname: "", actualqty: "1", rate: "1", amount: "1" }] }))) || ""));
    check("a non-object voucher is refused", throws(() => mapTallySale(null, { tenantId: TENANT })) !== null);
    check("an empty voucher type defaults to Sales, a custom one is kept", normalizeVoucherType("") === "Sales" && normalizeVoucherType(" Tax Invoice ") === "Tax Invoice");
  }

  console.log(`\nverify-sales-mapper: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
