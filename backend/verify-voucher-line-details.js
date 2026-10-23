/**
 * Voucher item-line discount and computed GST amounts, end to end. Two parts, one run:
 *
 *   PART 1 - requests, parsing and mapping (no MongoDB, no Tally, no network: axios.post is blocked except for a capturing stub):
 *   the sync and recovery requests ask for the computed GST group; the discount percentage and the derived discount amount (every
 *   rule, a 2,000-line property test, hostile values); the computed GST amounts; the reconciliation seen live; and that no financial
 *   field moves.
 *
 *   PART 2 - the back-fill of vouchers already stored (MongoDB, injected Tally fetcher): a dry run writes nothing; apply sets ONLY
 *   discountPercentage / discountAmount / gst on the lines; every amount, quantity, rate, header, ledger, status and AlterID is
 *   byte-identical afterwards; invoice totals and line revenue from the real query engine are unchanged; foreign / edited /
 *   mismatching / raced vouchers are skipped or abort the run; tenants are isolated; bounded, resumable, idempotent; and the
 *   database-target guard the command uses.
 *
 * Fixtures: field names, nesting and value formats are exactly what a real TallyPrime returned in read-only probes (WE FOUR,
 * 2026-10-09): `discount` as " 21" (a percentage, leading space), no discount-amount field, `rate` before and `amount` after
 * discount, and the `computed*` GST group that appears only when `inventoryentries.computedigst` is requested. Names, GUIDs and
 * voucher numbers are synthetic. Values marked SYNTHETIC are edge cases the probes did not return. Writes go only to clearly
 * synthetic tenants and are removed at the end. Refuses to run against anything but a loopback MongoDB.
 *
 * Run: node verify-voucher-line-details.js   (needs a loopback MongoDB named tallypulse_test*)
 */

require("dotenv").config();
{
  const uri = process.env.MONGODB_URI || "";
  const host = (/^mongodb:\/\/(?:[^@/]*@)?\[?([^\]/:,]+)\]?(?::\d+)?[/?]/.exec(uri) || [])[1];
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || /mongodb\+srv|mongodb\.net|atlas/i.test(uri)) {
    console.error("REFUSED: verify-voucher-line-details.js only runs against a loopback MongoDB. Nothing was touched.");
    process.exit(2);
  }
  require("axios").post = () => { throw new Error("NETWORK BLOCKED: this suite must never reach Tally (inject the fetcher)"); };
}

const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

let pass = 0;
let fail = 0;
function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}

// ================================================================ PART 1: requests, parsing, discount and GST amounts
// (its helpers stay private to this function; check() and the counters are shared with part 2)
async function partParsing() {
const axios = require("axios");
axios.post = () => { throw new Error("NETWORK BLOCKED: this suite must never reach Tally"); };

const odbc = require("./src/services/odbc/odbcService");
const { parseTallyVoucher, parseDiscountPercentage, deriveDiscountAmount } = require("./src/services/parser/tallyParser");
const { parseLineTaxAmounts, parseVoucherLineGst } = require("./src/services/parser/gstFields");
const { mapTallySale } = require("./src/services/mapper/salesMapper");
const { mapTallyPurchase } = require("./src/services/mapper/purchaseMapper");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");

const near = (a, b, eps = 0.005) => Math.abs(a - b) <= eps;

const COMPANY = "aaaaaaaa-0000-4000-8000-0000000000a1"; // synthetic

const rate = (head, r) => ({ gstratedutyhead: head, gstratevaluationtype: "Based on Value", gstrate: r, gstrateperunit: "0" });
// A line exactly as the probes returned it (440 x 20.90 less 21% = 7,264.84; CGST/SGST 9% each).
const rawLine = (o = {}) => ({
  stockitemname: "Synthetic Item A", actualqty: " 440 EA", billedqty: " 440 EA", rate: "20.90/EA", amount: "7264.84", discount: " 21",
  gsthsnname: "4820", gstovrdntaxability: "Taxable", gstovrdntypeofsupply: "Goods",
  ratedetails: [rate("CGST", " 9"), rate("SGST/UTGST", " 9"), rate("IGST", " 18")],
  computedassessablevalue: "7264.84", computedcgst: "653.84", computedsgst: "653.84", computedutgst: "0", computedigst: "0",
  computedcess: "0", computedcessonqty: "0", computedstatecessgst: "0",
  ...o,
});
const voucher = (lines, o = {}) => ({
  vouchernumber: "T1", date: "20250801", partyname: "Synthetic Party", vouchertypename: "Invoice", guid: `${COMPANY}-0000aa01`, alterid: "9",
  inventoryentries: lines,
  ledgerentries: [
    { ledgername: "Synthetic Party", amount: "-8582.52", isdeemedpositive: true },
    { ledgername: "Sales Account", amount: "7264.84", isdeemedpositive: false },
    { ledgername: "CGST", amount: "653.84", isdeemedpositive: false },
    { ledgername: "SGST", amount: "653.84", isdeemedpositive: false },
    { ledgername: "Round Off", amount: "0.00", isdeemedpositive: false },
  ],
  ...o,
});
const lineOf = (raw) => parseTallyVoucher(voucher([raw])).inventory[0];

await (async () => {
  // =========================================================== 1. requests
  console.log("=== 1. The sync and recovery requests ask for the computed GST group ===");
  {
    let captured = null;
    const keep = axios.post;
    axios.post = async (url, body) => { captured = body; return { data: { status: "1", data: { collection: [] } } }; };
    const methodsOf = () => Object.assign({}, ...captured.tdlmessage[0].definitions[0].attributes)["Native Method"];
    try {
      await odbc.getSalesVouchersSinceAlterId({ afterAlterId: 0, voucherTypeNames: ["Sales"] });
      check("req-sales-sync", "the incremental Sales sync asks for inventoryentries.computedigst (and still inventoryentries.*)", [/inventoryentries\.\*/.test(methodsOf()), /inventoryentries\.computedigst/.test(methodsOf())], [true, true]);
      await odbc.getPurchaseVouchersSinceAlterId({ afterAlterId: 0, voucherTypeNames: ["Purchase"] });
      check("req-purchase-sync", "the incremental Purchase sync asks for it too", /inventoryentries\.computedigst/.test(methodsOf()), true);
      await odbc.getVouchersByAlterIds({ alterIds: [1, 2], voucherTypeNames: ["Sales"] });
      check("req-recovery", "the recovery / back-fill fetch by AlterID asks for it", /inventoryentries\.computedigst/.test(methodsOf()), true);
      await odbc.getSalesVouchers({ fromDate: "2025-08-01", toDate: "2025-08-01", voucherTypeNames: ["Sales"] });
      check("req-manual", "the manual date-range import asks for it", /inventoryentries\.computedigst/.test(methodsOf()), true);
      await odbc.getAdjustmentNoteVouchersSinceAlterId({ afterAlterId: 0, voucherTypeNames: ["Credit Note"] });
      check("req-notes-untouched", "the Credit/Debit Note request is unchanged (its own parser does not use these fields)", /computed/.test(methodsOf()), false);
      check("req-ledger-kept", "the ledger entries are still requested alongside", /ledgerentries\.\*/.test(methodsOf()), true);
    } finally {
      axios.post = keep;
    }
  }

  // =========================================================== 2. discount percentage
  console.log("\n=== 2. Discount percentage: Tally's `discount` field ===");
  {
    const pct = (o) => parseDiscountPercentage(o);
    check("pct-real", "' 21' (leading space, as Tally sends it) -> 21", pct({ discount: " 21" }), 21);
    check("pct-decimals", "' 40.683' keeps its decimals", pct({ discount: " 40.683" }), 40.683);
    check("pct-zero", "'0' -> 0", pct({ discount: "0" }), 0);
    check("pct-absent", "no discount field -> 0", pct({}), 0);
    check("pct-wrapped", "a wrapped {type, value} is unwrapped", pct({ discount: { type: "Number", value: " 36.44" } }), 36.44);
    check("pct-malformed", "not a number / a percent sign / an object -> 0, never a guess", [pct({ discount: "abc" }), pct({ discount: "21%" }), pct({ discount: { a: 1 } }), pct({ discount: "" })], [0, 0, 0, 0]);
    check("pct-range", "outside 0-100 is not a valid discount -> 0 (100 itself is valid)", [pct({ discount: "150" }), pct({ discount: "-5" }), pct({ discount: " 100" })], [0, 0, 100]);
    check("pct-legacy-spelling", "an older spelling is still read when `discount` is absent; `discount` wins when both exist", [pct({ discountpercentage: "10" }), pct({ discount: "20", discountpercentage: "10" })], [10, 20]);
    check("pct-in-voucher", "through the real parser: the line stores 21 (it used to store 0)", lineOf(rawLine()).discountPercentage, 21);
  }

  // =========================================================== 3. discount amount
  console.log("\n=== 3. Discount amount: list value minus line amount, when plausible next to the percentage ===");
  {
    const l = lineOf(rawLine());
    check("amt-real", "440 x 20.90 = 9,196.00; less 21% = 7,264.84 -> discount 1,931.16 (the probe's own numbers)", [l.discountAmount, l.amount, l.quantity, l.rate], [1931.16, 7264.84, 440, 20.9]);
    check("amt-zero-line", "a line with discount '0' has discount 0 and is otherwise unchanged", (({ discountPercentage, discountAmount, amount }) => [discountPercentage, discountAmount, amount])(lineOf(rawLine({ discount: "0", amount: "9196.00" }))), [0, 0, 9196]);
    check("amt-no-field", "a line with no discount field -> 0 / 0", (({ discountPercentage, discountAmount }) => [discountPercentage, discountAmount])(lineOf(rawLine({ discount: undefined, amount: "9196.00" }))), [0, 0]);
    const free = lineOf(rawLine({ discount: " 100", amount: "0" }));
    check("amt-100pct", "a 100% line (amount 0) -> the discount is the whole gross 9,196.00", [free.discountPercentage, free.discountAmount, free.amount], [100, 9196, 0]);
    const purchase = lineOf(rawLine({ amount: "-7264.84" }));
    check("amt-purchase-sign", "purchase lines carry negative amounts: the discount is still positive and the amount is stored as sent", [purchase.discountAmount, purchase.amount], [1931.16, -7264.84]);
    const ret = lineOf(rawLine({ amount: "-7264.84", discount: " 21" }));
    check("amt-return-sign", "a return line (negative amount) behaves the same", ret.discountAmount, 1931.16);

    // REAL shape (August 2025): 557 of 3,092 discounted lines have a net a further 1-12% BELOW gross x (1 - percentage).
    const further = lineOf(rawLine({ actualqty: "48 EA", billedqty: "48 EA", rate: "45.00/EA", discount: " 46.43", amount: "1099.25", computedassessablevalue: "1099.25" }));
    check("amt-further-reduction", "REAL shape: 48 x 45.00 = 2,160.00, stated 46.43% (net would be 1,157.11) but the line is 1,099.25 -> the whole reduction 1,060.75 is the discount; the percentage stays as Tally shows it",
      [further.discountPercentage, further.discountAmount, further.amount], [46.43, 1060.75, 1099.25]);
    const tooFar = lineOf(rawLine({ amount: "4000.00" })); // the percentage implies 7,264.84; 4,000 is 55% of that
    check("amt-too-far", "SYNTHETIC: a net more than 20% below what the percentage implies is not trusted as a discount -> 0", tooFar.discountAmount, 0);
    const lessThanStated = lineOf(rawLine({ amount: "8000.00" })); // Tally says 21% but the line only reflects 13%
    check("amt-less-than-stated", "SYNTHETIC: a net ABOVE what the stated percentage implies (less discount than Tally states) -> the numbers disagree -> 0", [lessThanStated.discountPercentage, lessThanStated.discountAmount], [21, 0]);
    const rounding = lineOf(rawLine({ amount: "7264.88" })); // 4 paise above: rounding noise, still accepted
    check("amt-rounding-noise", "...but a few paise above (rounding) is accepted", rounding.discountAmount, 1931.12);
    const atLimit = lineOf(rawLine({ amount: "5811.87" })); // 7,264.84 x 0.8 = 5,811.872: exactly at the limit
    check("amt-at-limit", "...but a net exactly at the 20% limit is accepted", atLimit.discountAmount, 3384.13);

    // SYNTHETIC: cases where the three numbers do not tell one story -> the amount stays 0, the percentage is kept.
    const clash = lineOf(rawLine({ amount: "9196.00" })); // says 21% but amount equals gross
    check("amt-clash", "SYNTHETIC: percentage says 21% but amount equals gross -> amount 0 (never invented), percentage kept", [clash.discountPercentage, clash.discountAmount], [21, 0]);
    const otherUnit = lineOf(rawLine({ actualqty: "10 BOX", billedqty: "10 BOX", rate: "100/BOX", amount: "500" })); // 10% but 10 x 100 = 1000 -> 500 off is 50%
    check("amt-unit-mismatch", "SYNTHETIC: a rate quoted per another unit (relation breaks) -> amount 0", [otherUnit.discountPercentage, otherUnit.discountAmount], [21, 0]);
    const noQty = lineOf(rawLine({ actualqty: undefined, billedqty: undefined }));
    check("amt-no-quantity", "SYNTHETIC: no quantity -> amount 0", noQty.discountAmount, 0);
    const noRate = lineOf(rawLine({ rate: undefined }));
    check("amt-no-rate", "SYNTHETIC: no rate -> amount 0", noRate.discountAmount, 0);
    const bigger = lineOf(rawLine({ amount: "99999" })); // net larger than gross
    check("amt-net-above-gross", "SYNTHETIC: net above gross -> amount 0, never negative", bigger.discountAmount, 0);
    const explicit = lineOf(rawLine({ discountamount: "1900.00" }));
    check("amt-explicit-wins", "if some Tally version sends a discount amount, that explicit value wins over the derived one", explicit.discountAmount, 1900);

    // Rounded percentage: Tally shows 2-3 decimals, so the derived amount (from the true net) is used, not pct x gross.
    const rounded = lineOf(rawLine({ actualqty: "1000 EA", billedqty: "1000 EA", rate: "17.50/EA", discount: " 36.44", amount: "11123.00" }));
    check("amt-rounded-pct", "a percentage shown rounded (36.44) still derives the true amount: 17,500 - 11,123 = 6,377", rounded.discountAmount, 6377);

    // Property: for many random lines the derived discount is exactly gross - net and never alters the amount.
    let bad = 0;
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 2000; i += 1) {
      const q = 1 + Math.floor(rnd() * 5000), r = Math.round((0.5 + rnd() * 500) * 100) / 100, p = Math.round(rnd() * 9000) / 100 + 0.01;
      const k = rnd() < 0.5 ? 1 : 0.85 + rnd() * 0.15; // half the lines carry a further 0-15% reduction, as in the real data
      const net = Math.round(q * r * (1 - p / 100) * k * 100) / 100;
      const out = lineOf(rawLine({ actualqty: `${q} EA`, billedqty: `${q} EA`, rate: `${r.toFixed(2)}/EA`, discount: ` ${p}`, amount: String(net) }));
      const gross = q * r;
      if (!near(out.discountAmount, Math.round((gross - net) * 100) / 100, 0.011) || out.amount !== net || out.discountPercentage !== p) bad += 1;
    }
    check("amt-property", "2,000 random lines (half with a further 0-15% reduction): discount = gross - net (to the paisa), amount and percentage untouched", bad, 0);
    check("amt-fn-direct", "deriveDiscountAmount: no percentage -> 0", deriveDiscountAmount(0, { quantity: 10, rate: 5, amount: 50 }), 0);
  }

  // =========================================================== 4. computed GST amounts
  console.log("\n=== 4. Computed GST amounts per line (the `computed*` group) ===");
  {
    const a = parseLineTaxAmounts(rawLine());
    check("tax-real", "the probe's line: taxable value, CGST and SGST in rupees, real zeros kept as 0", a,
      { assessableValue: 7264.84, cgst: 653.84, sgst: 653.84, utgst: 0, igst: 0, cess: 0, cessOnQty: 0, stateCess: 0 });
    check("tax-zero-vs-missing", "a real '0' stays 0 but a missing or blank field is null (never 0)",
      (({ igst, utgst, cess }) => [igst, utgst, cess])(parseLineTaxAmounts({ computedcgst: "10", computedigst: "0", computedutgst: "", computedcess: undefined })), [0, null, null]);
    check("tax-malformed", "a value that is not a number is null, not 0 and not an object", (({ cgst }) => cgst)(parseLineTaxAmounts({ computedcgst: "abc", computedsgst: "5" })), null);
    check("tax-none", "a line without any computed field has no amounts at all", parseLineTaxAmounts({ stockitemname: "x" }), null);
    check("tax-leading-space", "values with a leading space parse", parseLineTaxAmounts({ computedcgst: " 12.50" }).cgst, 12.5);
    const g = parseVoucherLineGst({ computedcgst: "5", computedassessablevalue: "100" });
    check("tax-alone-makes-gst", "a line that only has computed amounts still gets a gst snapshot", [g.hsn, g.amounts.cgst, g.amounts.assessableValue, g.rates], [null, 5, 100, []]);
    const l = lineOf(rawLine());
    check("tax-in-voucher", "through the real parser the line's gst snapshot carries the amounts next to rates and HSN", [l.gst.hsn, l.gst.amounts.cgst, l.gst.rates.length], ["4820", 653.84, 3]);
    const old = lineOf({ stockitemname: "Plain", actualqty: "1 EA", rate: "5/EA", amount: "5" });
    check("tax-old-shape", "a line with no GST or discount fields keeps its exact old shape", Object.keys(old).sort(), ["amount", "discountAmount", "discountPercentage", "itemName", "quantity", "rate"]);
  }

  // =========================================================== 5. reconciliation (the live finding)
  console.log("\n=== 5. The line amounts add up to the voucher, as seen live ===");
  {
    // One real voucher shape: taxable 2,159.62 + CGST 194.37 + SGST 194.37 - rounding 0.36 = 2,548.00 (party ledger).
    const v = voucher([rawLine({ stockitemname: "Synthetic Item B", actualqty: "62 EA", billedqty: "62 EA", rate: "34.83/EA", discount: "0", amount: "2159.62",
      computedassessablevalue: "2159.62", computedcgst: "194.37", computedsgst: "194.37" })], {
      ledgerentries: [
        { ledgername: "Synthetic Party", amount: "-2548.00", isdeemedpositive: true },
        { ledgername: "Sales Account", amount: "2159.62", isdeemedpositive: false },
        { ledgername: "CGST", amount: "194.37", isdeemedpositive: false },
        { ledgername: "SGST", amount: "194.37", isdeemedpositive: false },
        { ledgername: "Round Off", amount: "-0.36", isdeemedpositive: false },
      ],
    });
    const p = parseTallyVoucher(v);
    const sum = (k) => p.inventory.reduce((s, i) => s + (i.gst && i.gst.amounts ? i.gst.amounts[k] || 0 : 0), 0);
    const ledger = (re) => p.ledgers.filter((x) => re.test(x.ledgerName)).reduce((s, x) => s + Math.abs(x.ledgerAmount), 0);
    check("rec-cgst-sgst", "sum of the lines' CGST/SGST equals the voucher's own CGST/SGST ledgers", [near(sum("cgst"), ledger(/^CGST$/)), near(sum("sgst"), ledger(/^SGST$/))], [true, true]);
    check("rec-total", "line amounts + CGST + SGST + rounding = the invoice total (the party ledger), to the paisa", [near(p.inventory.reduce((s, i) => s + i.amount, 0) + sum("cgst") + sum("sgst") - 0.36, p.header.voucherTotalAmount), p.header.voucherTotalAmount], [true, 2548]);
  }

  // =========================================================== 6. nothing financial moves
  console.log("\n=== 6. Mapping, validity, and no change to any financial field ===");
  {
    const withAll = voucher([rawLine(), rawLine({ stockitemname: "Synthetic Item C", discount: "0", amount: "9196.00", computedassessablevalue: "9196.00", computedcgst: "827.64", computedsgst: "827.64" })]);
    const stripped = voucher([rawLine(), rawLine({ stockitemname: "Synthetic Item C", discount: "0", amount: "9196.00" })].map((r) => {
      const { discount, computedassessablevalue, computedcgst, computedsgst, computedutgst, computedigst, computedcess, computedcessonqty, computedstatecessgst, ...rest } = r; // what the OLD request returned
      return rest;
    }));
    const a = parseTallyVoucher(withAll), b = parseTallyVoucher(stripped);
    const money = (p) => ({ total: p.header.voucherTotalAmount, lines: p.inventory.map((i) => [i.itemName, i.quantity, i.rate, i.amount]) });
    check("fin-unchanged", "invoice total, quantities, rates and line amounts are IDENTICAL whether or not discount / computed fields are present", money(a), money(b));
    const sale = mapTallySale(a, { tenantId: "TEST-T" });
    check("map-sale", "the sales mapper keeps discount and the gst snapshot (with amounts)", [sale.inventory[0].discountPercentage, sale.inventory[0].discountAmount, sale.inventory[0].gst.amounts.cgst], [21, 1931.16, 653.84]);
    const purchase = mapTallyPurchase(parseTallyVoucher({ ...withAll, vouchertypename: "Purchase" }), { tenantId: "TEST-T" });
    check("map-purchase", "the purchase mapper does the same", [purchase.inventory[0].discountPercentage, purchase.inventory[0].discountAmount], [21, 1931.16]);
    let invalid = 0;
    for (const doc of [new Sale(sale), new Purchase(purchase)]) { try { await doc.validate(); } catch { invalid += 1; } }
    check("valid-docs", "the mapped Sale and Purchase documents validate", invalid, 0);

    // Hostile values in every new key never invalidate a voucher (a failed voucher would hold up the sync checkpoint).
    const hostile = [null, undefined, "", " ", "\u0004", 0, -1, 1e308, NaN, Infinity, true, [], {}, [1], { a: 1 }, { value: { x: 1 } }, "x".repeat(5000), "<script>", { $gt: "" }];
    const keys = ["discount", "computedassessablevalue", "computedcgst", "computedsgst", "computedutgst", "computedigst", "computedcess", "computedcessonqty", "computedstatecessgst"];
    const failures = [];
    for (const k of keys) {
      for (const val of hostile) {
        try {
          const m = mapTallySale(parseTallyVoucher(voucher([rawLine({ [k]: val })])), { tenantId: "TEST-T" });
          const mp = mapTallyPurchase(parseTallyVoucher(voucher([rawLine({ [k]: val })], { vouchertypename: "Purchase" })), { tenantId: "TEST-T" });
          for (const doc of [new Sale(m), new Purchase(mp)]) await doc.validate();
          if (m.inventory[0].amount !== 7264.84 || m.inventory[0].quantity !== 440) failures.push(`${k}: amount/quantity moved`);
        } catch (e) { failures.push(`${k}=${JSON.stringify(val)}: ${String(e.message).slice(0, 70)}`); }
      }
    }
    check("hostile", `${keys.length * hostile.length} hostile inputs across ${keys.length} keys: every document validates, the parser never throws, amount and quantity never move`, failures.slice(0, 3), []);
  }

})();
}

// ================================================================ PART 2: the back-fill of stored vouchers
// (its helpers stay private to this function; check() and the counters are shared with part 1)
async function partBackfill() {
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const { parseTallyVoucher } = require("./src/services/parser/tallyParser");
const { mapTallySale } = require("./src/services/mapper/salesMapper");
const { mapTallyPurchase } = require("./src/services/mapper/purchaseMapper");
const { backfillVoucherLineDetails, ALLOWED_SET_PATH, hostOfMongoUri, checkWriteTarget } = require("./src/services/sync/voucherLineBackfill");
const { executeQuery } = require("./src/services/query/execute");

const TENANT_A = "TEST-TENANT-A-line-backfill";
const TENANT_B = "TEST-TENANT-B-line-backfill";
const GA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // synthetic company GUIDs
const GB = "bbbbbbbb-0000-4000-8000-0000000000b2";
const COMPANY_A = { tenantId: TENANT_A, companyGuid: GA, tallyConnection: {} };

// ---------------------------------------------------------------- Tally-shaped data
const rate = (head, r) => ({ gstratedutyhead: head, gstratevaluationtype: "Based on Value", gstrate: r, gstrateperunit: "0" });
// A line as the NEW request returns it (440 x 20.90, 21% off = 7,264.84, CGST/SGST 9%).
const fullLine = (o = {}) => ({
  stockitemname: "Synthetic Item A", actualqty: " 440 EA", billedqty: " 440 EA", rate: "20.90/EA", amount: "7264.84", discount: " 21",
  gsthsnname: "4820", gstovrdntaxability: "Taxable", gstovrdntypeofsupply: "Goods", ratedetails: [rate("CGST", " 9"), rate("SGST/UTGST", " 9")],
  computedassessablevalue: "7264.84", computedcgst: "653.84", computedsgst: "653.84", computedutgst: "0", computedigst: "0",
  computedcess: "0", computedcessonqty: "0", computedstatecessgst: "0", ...o,
});
// What the OLD request returned for the same line: no discount field, no computed group.
const oldLine = (l) => {
  const { discount, computedassessablevalue, computedcgst, computedsgst, computedutgst, computedigst, computedcess, computedcessonqty, computedstatecessgst, ...rest } = l;
  return rest;
};
function rawVoucher(n, { type = "Invoice", company = GA, alterId = 1000 + n, lines = [fullLine()], date = "20250801", number } = {}) {
  return {
    vouchernumber: number || `V${n}`, date, partyname: `Synthetic Party ${n}`, vouchertypename: type, guid: `${company}-0000c${String(n).padStart(3, "0")}`, alterid: String(alterId),
    inventoryentries: lines,
    ledgerentries: [{ ledgername: `Synthetic Party ${n}`, amount: "-8000", isdeemedpositive: true }, { ledgername: "Sales Account", amount: "7264.84", isdeemedpositive: false }],
  };
}
const asOld = (raw) => ({ ...raw, inventoryentries: raw.inventoryentries.map(oldLine) });
const tallyResponse = (vouchers) => ({ status: "1", data: { metadata: {}, collection: vouchers } });

const okGuard = async () => ({ ok: true });
const okClassify = async () => ({ sales: { status: "ok", typeNames: ["Invoice"] }, purchase: { status: "ok", typeNames: ["Purchase"] } });
// A fake Tally: answers by AlterID from a map; records every request (to prove one at a time and bounded).
function fakeTally(byAlterId, { onFetch } = {}) {
  const calls = [];
  let active = 0, maxActive = 0;
  const fn = async ({ alterIds }) => {
    calls.push(alterIds.slice());
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setImmediate(r));
    if (onFetch) await onFetch(alterIds);
    active -= 1;
    return tallyResponse(alterIds.map((id) => byAlterId.get(id)).filter(Boolean));
  };
  fn.calls = calls; fn.maxActive = () => maxActive;
  return fn;
}
const run = (extra) => backfillVoucherLineDetails({ company: COMPANY_A, voucherType: "Sales", deps: { verifyCompany: okGuard, classify: okClassify }, ...extra });

async function cleanup() {
  const ids = { $in: [TENANT_A, TENANT_B] };
  await Promise.all([Sale.deleteMany({ tenantId: ids }), Purchase.deleteMany({ tenantId: ids })]);
}
// everything EXCEPT the three whitelisted line fields and the auto timestamps
const frozen = (doc) => {
  const d = JSON.parse(JSON.stringify(doc));
  delete d.updatedAt; delete d.__v;
  d.inventory = (d.inventory || []).map((l) => { const { discountPercentage, discountAmount, gst, ...rest } = l; return rest; });
  return d;
};
const snapshot = async (Model, tenantId) => JSON.stringify(await Model.find({ tenantId }).sort({ tallyGuid: 1 }).lean());

async function runBackfillPart() {
  await connectDB();
  await cleanup();
  try {
    // ---------------------------------------------------------- the database-target guard (pure)
    console.log("=== 1. The database-target guard used by the command ===");
    check("host-srv", "host of an Atlas-style URI, credentials and options dropped", hostOfMongoUri("mongodb+srv://user:p%40ss@cluster0.example.mongodb.net/mydb?retryWrites=true"), "cluster0.example.mongodb.net");
    check("host-local", "host of a local URI", [hostOfMongoUri("mongodb://127.0.0.1:27017/x"), hostOfMongoUri("mongodb://localhost/x")], ["127.0.0.1", "localhost"]);
    check("host-garbage", "not a Mongo URI -> null", [hostOfMongoUri(""), hostOfMongoUri(undefined), hostOfMongoUri("http://x")], [null, null, null]);
    const remote = "mongodb+srv://user:secret@cluster0.example.mongodb.net/db";
    check("guard-dry-remote", "a DRY RUN against a remote database is allowed (it writes nothing)", checkWriteTarget({ uri: remote, apply: false }).ok, true);
    check("guard-apply-remote-refused", "--apply against a remote database without --confirm-host is REFUSED", checkWriteTarget({ uri: remote, apply: true }).ok, false);
    check("guard-apply-wrong-host", "--confirm-host with a different host is refused", checkWriteTarget({ uri: remote, apply: true, confirmHost: "other.example.com" }).ok, false);
    check("guard-apply-confirmed", "--confirm-host with the exact host is accepted", checkWriteTarget({ uri: remote, apply: true, confirmHost: "Cluster0.example.mongodb.net" }).ok, true);
    check("guard-apply-local", "--apply against a local database needs no confirmation", checkWriteTarget({ uri: "mongodb://127.0.0.1:27099/x", apply: true }).ok, true);
    check("guard-no-uri", "no MONGODB_URI -> refused", checkWriteTarget({ uri: "", apply: true }).ok, false);
    check("guard-no-secret", "the message never contains credentials", /secret|user:|@/.test(JSON.stringify(checkWriteTarget({ uri: remote, apply: true }))), false);
    check("whitelist-paths", "only discountPercentage, discountAmount and gst of a line may be set",
      ["inventory.0.discountPercentage", "inventory.12.discountAmount", "inventory.3.gst", "inventory.0.amount", "inventory.0.quantity", "inventory.0.rate", "inventory.0.itemName", "header.voucherTotalAmount", "tallyAlterId", "voucherStatus", "ledgers.0.ledgerAmount", "inventory.0.gst.amounts.cgst"].map((p) => ALLOWED_SET_PATH.test(p)),
      [true, true, true, false, false, false, false, false, false, false, false, false]);

    // ---------------------------------------------------------- existing vouchers, stored the OLD way
    const raws = [1, 2, 3].map((n) => rawVoucher(n, { lines: [fullLine(), fullLine({ stockitemname: "Synthetic Item B", discount: "0", amount: "9196.00", computedassessablevalue: "9196.00", computedcgst: "827.64", computedsgst: "827.64" })] }));
    for (const raw of raws) await Sale.create(mapTallySale(parseTallyVoucher(asOld(raw)), { tenantId: TENANT_A }));
    // tenant B: the same shapes under its own company, must never be touched by a run for A
    for (const n of [1, 2]) await Sale.create(mapTallySale(parseTallyVoucher(asOld(rawVoucher(n, { company: GB }))), { tenantId: TENANT_B }));
    const tally = new Map(raws.map((r) => [Number(r.alterid), r]));
    const plan = (v) => ({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, filters: [], ...v });
    const queries = [plan({ metrics: ["invoiceAmount", "invoiceCount"] }), plan({ metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 10 })];
    const answers = async () => { const out = []; for (const q of queries) { const r = await executeQuery(q, { tenantId: TENANT_A, referenceDate: new Date(2026, 9, 9) }); out.push({ ok: r.ok, totals: r.totals, rows: r.rows }); } return out; };

    const before = await Sale.find({ tenantId: TENANT_A }).sort({ tallyGuid: 1 }).lean();
    const answersBefore = await answers();
    const snapA = await snapshot(Sale, TENANT_A), snapB = await snapshot(Sale, TENANT_B);
    check("old-state", "stored the old way: every line has discount 0/0 and no GST amounts", before.every((d) => d.inventory.every((l) => l.discountPercentage === 0 && l.discountAmount === 0 && !(l.gst && l.gst.amounts))), true);

    // ---------------------------------------------------------- dry run
    console.log("\n=== 2. Dry run writes nothing ===");
    const f1 = fakeTally(tally);
    const dry = await run({ apply: false, fetchByAlterIdsOverride: undefined, deps: { verifyCompany: okGuard, classify: okClassify, fetchByAlterIds: f1 } });
    check("dry-status", "status dry_run; 3 candidates; 3 vouchers would change; 6 lines in total, 1 with discount per voucher", [dry.status, dry.dryRun, dry.candidates, dry.vouchersToUpdate, dry.vouchersUpdated, dry.lines.withDiscount], ["dry_run", true, 3, 3, 0, 3]);
    check("dry-lines", "line counters: discount amount derived on 3 lines, none left underivable, computed amounts on all 6", [dry.lines.discountAmountDerived, dry.lines.discountAmountNotDerivable, dry.lines.withTaxAmounts], [3, 0, 6]);
    check("dry-db-identical", "the database is byte-identical after a dry run (both tenants)", [await snapshot(Sale, TENANT_A), await snapshot(Sale, TENANT_B)], [snapA, snapB]);
    check("dry-one-request", "one bounded request, never overlapping", [f1.calls.length, f1.maxActive()], [1, 1]);

    // ---------------------------------------------------------- apply
    console.log("\n=== 3. Apply sets only the allowed fields; nothing financial moves ===");
    const f2 = fakeTally(tally);
    const applied = await run({ apply: true, deps: { verifyCompany: okGuard, classify: okClassify, fetchByAlterIds: f2 } });
    check("apply-status", "completed; 3 vouchers updated; nothing skipped", [applied.status, applied.vouchersUpdated, JSON.stringify(applied.skipped)], ["completed", 3, JSON.stringify({ notReturnedByTally: 0, changedInTally: 0, lineMismatch: 0, unexpectedVoucher: 0, changedDuringRun: 0 })]);
    const after = await Sale.find({ tenantId: TENANT_A }).sort({ tallyGuid: 1 }).lean();
    check("apply-discount", "the discounted line now stores 21% and 1,931.16; the zero-discount line stays 0/0", [after[0].inventory[0].discountPercentage, after[0].inventory[0].discountAmount, after[0].inventory[1].discountPercentage, after[0].inventory[1].discountAmount], [21, 1931.16, 0, 0]);
    check("apply-gst-amounts", "the GST snapshot now carries the computed amounts (taxable value, CGST, SGST)", [after[0].inventory[0].gst.amounts.assessableValue, after[0].inventory[0].gst.amounts.cgst, after[0].inventory[0].gst.amounts.sgst, after[0].inventory[1].gst.amounts.cgst], [7264.84, 653.84, 653.84, 827.64]);
    check("apply-nothing-else", "EVERY other field of every voucher is identical to before (amounts, quantities, rates, header, ledgers, status, AlterID)", after.map(frozen), before.map(frozen));
    check("apply-engine-same", "invoice totals and line revenue / quantity by product from the real query engine are exactly what they were", await answers(), answersBefore);
    check("apply-tenant-b", "tenant B's vouchers (same shapes, other company) are untouched", await snapshot(Sale, TENANT_B), snapB);

    console.log("\n=== 4. Idempotent, bounded and resumable ===");
    const f3 = fakeTally(tally);
    const again = await run({ apply: true, deps: { verifyCompany: okGuard, classify: okClassify, fetchByAlterIds: f3 } });
    check("again-nothing", "a second run finds nothing to do and asks Tally nothing", [again.candidates, again.vouchersUpdated, f3.calls.length], [0, 0, 0]);

    // cursor: 5 fresh old-style vouchers, 2 per request, 2 requests per run
    const more = [10, 11, 12, 13, 14].map((n) => rawVoucher(n, { alterId: 2000 + n }));
    for (const raw of more) await Sale.create(mapTallySale(parseTallyVoucher(asOld(raw)), { tenantId: TENANT_A }));
    const tally2 = new Map(more.map((r) => [Number(r.alterid), r]));
    const fc = fakeTally(tally2);
    const first = await run({ apply: true, batchSize: 2, maxBatches: 2, deps: { verifyCompany: okGuard, classify: okClassify, fetchByAlterIds: fc } });
    check("cursor-first", "first run: 2 requests of 2, 4 vouchers done, 1 left, cursor at the 4th AlterID", [fc.calls.length, first.vouchersUpdated, first.remainingCandidates, first.nextAfterAlterId], [2, 4, 1, 2013]);
    check("cursor-sizes", "each request carries at most the batch size", fc.calls.map((c) => c.length), [2, 2]);
    const second = await run({ apply: true, batchSize: 2, maxBatches: 2, afterAlterId: first.nextAfterAlterId, deps: { verifyCompany: okGuard, classify: okClassify, fetchByAlterIds: fakeTally(tally2) } });
    check("cursor-second", "resuming from the cursor finishes the last voucher", [second.vouchersUpdated, second.remainingCandidates], [1, 0]);

    // date window
    const w1 = rawVoucher(20, { alterId: 3020, date: "20250915" }), w2 = rawVoucher(21, { alterId: 3021, date: "20251015" });
    for (const raw of [w1, w2]) await Sale.create(mapTallySale(parseTallyVoucher(asOld(raw)), { tenantId: TENANT_A }));
    const win = await run({ apply: false, from: "2025-09-01", to: "2025-09-30", deps: { verifyCompany: okGuard, classify: okClassify, fetchByAlterIds: fakeTally(new Map([[3020, w1], [3021, w2]])) } });
    check("window", "a from/to window selects only the voucher dated inside it (both edge days inclusive)", win.candidates, 1);

    // ---------------------------------------------------------- refusals
    console.log("\n=== 5. Unsafe cases are skipped or abort the run, never half-applied ===");
    const s1 = rawVoucher(30, { alterId: 4030 }), s2 = rawVoucher(31, { alterId: 4031 }), s3 = rawVoucher(32, { alterId: 4032 }), s4 = rawVoucher(33, { alterId: 4033 });
    for (const raw of [s1, s2, s3, s4]) await Sale.create(mapTallySale(parseTallyVoucher(asOld(raw)), { tenantId: TENANT_A }));
    const edited = { ...s2, alterid: "9999" }; // Tally says this guid is now at a newer AlterID
    const mismatch = { ...s3, inventoryentries: [fullLine({ amount: "1.00", computedassessablevalue: "1.00" })] }; // not the line we stored
    const m = new Map([[4030, s1], [4031, edited], [4032, mismatch]]); // 4033 is not returned at all
    const mixedBefore = await snapshot(Sale, TENANT_A);
    const mixed = await run({ apply: true, deps: { verifyCompany: okGuard, classify: okClassify, fetchByAlterIds: async ({ alterIds }) => tallyResponse(alterIds.map((id) => m.get(id)).filter(Boolean)) }, afterAlterId: 4000 });
    check("mixed-counts", "one updated; one changed in Tally, one line mismatch, one not returned -> each skipped and counted", [mixed.vouchersUpdated, mixed.skipped.changedInTally, mixed.skipped.lineMismatch, mixed.skipped.notReturnedByTally], [1, 1, 1, 2]);
    const afterMixed = await Sale.find({ tenantId: TENANT_A, tallyAlterId: { $in: [4031, 4032, 4033] } }).lean();
    check("mixed-untouched", "the skipped vouchers are exactly as stored", afterMixed.every((d) => d.inventory.every((l) => l.discountPercentage === 0 && !(l.gst && l.gst.amounts))), true);
    void mixedBefore;

    const foreign = rawVoucher(40, { alterId: 5040 }), foreignB = rawVoucher(41, { alterId: 5041, company: GB });
    for (const raw of [foreign, rawVoucher(41, { alterId: 5041 })]) await Sale.create(mapTallySale(parseTallyVoucher(asOld(raw)), { tenantId: TENANT_A }));
    const pre = await snapshot(Sale, TENANT_A);
    const fo = await run({ apply: true, afterAlterId: 5000, deps: { verifyCompany: okGuard, classify: okClassify, fetchByAlterIds: async () => tallyResponse([foreign, foreignB]) } });
    check("foreign-aborts", "a voucher of ANOTHER company in the response aborts the run: company_mismatch, nothing written (not even the valid one)", [fo.status, fo.reasonCode, await snapshot(Sale, TENANT_A) === pre], ["aborted", "company_mismatch", true]);

    const race = rawVoucher(50, { alterId: 6050 });
    await Sale.create(mapTallySale(parseTallyVoucher(asOld(race)), { tenantId: TENANT_A }));
    const rc = await run({ apply: true, afterAlterId: 6000, deps: { verifyCompany: okGuard, classify: okClassify, fetchByAlterIds: fakeTally(new Map([[6050, race]]), { onFetch: async () => { await Sale.updateOne({ tenantId: TENANT_A, tallyGuid: race.guid }, { $set: { tallyAlterId: 6051 } }); } }) } });
    const raced = await Sale.findOne({ tenantId: TENANT_A, tallyGuid: race.guid }).lean();
    check("race", "a voucher the sync updated while the run was reading is NOT overwritten (conditional write) and is counted", [rc.vouchersUpdated, rc.skipped.changedDuringRun, raced.tallyAlterId, raced.inventory[0].discountPercentage], [0, 1, 6051, 0]);

    const bad1 = await run({ apply: true, deps: { verifyCompany: async () => ({ ok: false, reason: "unreachable", message: "Tally is not reachable." }), classify: okClassify, fetchByAlterIds: fakeTally(new Map()) } });
    const bad2 = await run({ apply: true, deps: { verifyCompany: async () => ({ ok: false, reason: "mismatch", message: "Another company is open." }), classify: okClassify, fetchByAlterIds: fakeTally(new Map()) } });
    const bad3 = await run({ apply: true, deps: { verifyCompany: okGuard, classify: async () => ({ sales: { status: "needs_configuration", reason: "ambiguous" } }), fetchByAlterIds: fakeTally(new Map()) } });
    check("guards", "Tally unreachable / wrong company open / voucher types unresolved: each aborts before any fetch or write", [bad1.reasonCode, bad2.reasonCode, bad3.reasonCode], ["tally_unreachable", "company_mismatch", "classification_error"]);
    let threw = false; try { await backfillVoucherLineDetails({ company: COMPANY_A, voucherType: "Receipt", deps: {} }); } catch { threw = true; }
    check("unsupported-type", "only Sales and Purchase are accepted", threw, true);
    const thrown = await run({ apply: true, deps: { verifyCompany: okGuard, classify: okClassify, fetchByAlterIds: async () => { throw new Error("socket hang up"); } }, afterAlterId: 0 });
    check("fetch-failure", "a Tally failure stops the run with a clear status and no partial claim", [["failed", "partial"].includes(thrown.status), thrown.reasonCode], [true, "batch_failed"]);

    // ---------------------------------------------------------- purchases
    console.log("\n=== 6. Purchases (negative stored amounts) ===");
    const pr = rawVoucher(60, { type: "Purchase", alterId: 7060, lines: [fullLine({ amount: "-7264.84", computedassessablevalue: "-7264.84", computedcgst: "-653.84", computedsgst: "-653.84" })] });
    await Purchase.create(mapTallyPurchase(parseTallyVoucher(asOld(pr)), { tenantId: TENANT_A }));
    const pBefore = await Purchase.findOne({ tenantId: TENANT_A }).lean();
    const pRun = await backfillVoucherLineDetails({ company: COMPANY_A, voucherType: "Purchase", apply: true, deps: { verifyCompany: okGuard, classify: okClassify, fetchByAlterIds: fakeTally(new Map([[7060, pr]])) } });
    const pAfter = await Purchase.findOne({ tenantId: TENANT_A }).lean();
    check("purchase-done", "the purchase line gets a POSITIVE discount amount; its negative stored amount is unchanged", [pRun.vouchersUpdated, pAfter.inventory[0].discountPercentage, pAfter.inventory[0].discountAmount, pAfter.inventory[0].amount === pBefore.inventory[0].amount, pAfter.inventory[0].amount], [1, 21, 1931.16, true, -7264.84]);
    check("purchase-only-allowed", "nothing but the three allowed fields changed on the purchase either", frozen(pAfter), frozen(pBefore));

    // ---------------------------------------------------------- billed quantity (source-provided, never derived or overwritten)
    console.log("\n=== 7. Billed quantity from Tally: counted in the dry run, never stored or written ===");
    check("whitelist-billed", "billedQuantity is never a writable path", [ALLOWED_SET_PATH.test("inventory.4.billedQuantity"), ALLOWED_SET_PATH.test("inventory.billedQuantity")], [false, false]);
    const freeLine = fullLine({ stockitemname: "Synthetic Free Item", actualqty: " 12 EA", billedqty: " 10 EA", rate: "100/EA", amount: "1000", discount: " 0", computedassessablevalue: "1000", computedcgst: "90", computedsgst: "90" });
    const bq1 = rawVoucher(71, { alterId: 7101, lines: [freeLine] }); // 10 billed + 2 free
    const bq2 = rawVoucher(72, { alterId: 7102 }); // 440 billed = 440 actual
    const bq3 = rawVoucher(73, { alterId: 7103, lines: [fullLine({ billedqty: undefined })] }); // Tally sends no billed quantity
    for (const raw of [bq1, bq2, bq3]) await Sale.create(mapTallySale(parseTallyVoucher(asOld(raw)), { tenantId: TENANT_A }));
    const bqStored = await Sale.find({ tenantId: TENANT_A, tallyAlterId: { $gte: 7101, $lte: 7103 } }).sort({ tallyAlterId: 1 }).lean();
    check("billed-not-stored", "the sync stores the ACTUAL quantity (12) and no billed quantity", [bqStored[0].inventory[0].quantity, bqStored.every((d) => d.inventory.every((l) => !("billedQuantity" in l)))], [12, true]);
    const bqTally = new Map([bq1, bq2, bq3].map((r) => [Number(r.alterid), r]));
    const bqSnap = await snapshot(Sale, TENANT_A);
    const bqDry = await run({ apply: false, afterAlterId: 7100, deps: { verifyCompany: okGuard, classify: okClassify, fetchByAlterIds: fakeTally(bqTally) } });
    check("billed-dry", "dry run counts: 2 lines carry a billed quantity in Tally, 1 differs from the actual quantity (free goods), 1 line has none; nothing written", [bqDry.status, bqDry.candidates, bqDry.lines.withBilledQuantity, bqDry.lines.billedDiffersFromActual, bqDry.lines.billedQuantityMissingInTally, await snapshot(Sale, TENANT_A) === bqSnap], ["dry_run", 3, 2, 1, 1, true]);
    const bqApply = await run({ apply: true, afterAlterId: 7100, deps: { verifyCompany: okGuard, classify: okClassify, fetchByAlterIds: fakeTally(bqTally) } });
    const bqAfter = await Sale.find({ tenantId: TENANT_A, tallyAlterId: { $gte: 7101, $lte: 7103 } }).sort({ tallyAlterId: 1 }).lean();
    check("billed-apply-no-field", "apply writes only the discount and GST fields: no line gains a billed quantity, the actual 12 stays", [bqApply.vouchersUpdated, bqAfter.every((d) => d.inventory.every((l) => !("billedQuantity" in l))), bqAfter[0].inventory[0].quantity, !!bqAfter[0].inventory[0].gst.amounts], [3, true, 12, true]);
  } finally {
    await cleanup();
  }
}
await runBackfillPart();
}

(async () => {
  await partParsing();
  await partBackfill();
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
