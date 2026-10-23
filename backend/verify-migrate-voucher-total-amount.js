/**
 * Migration tests for migrate-voucher-total-amount.js, against a fully
 * isolated synthetic fixture - NEVER real WE FOUR/Nirmal data. Invokes
 * the actual CLI (child process) exactly as an operator would, so
 * argument parsing, dry-run gating, and the --export requirement are all
 * exercised for real, not bypassed.
 *
 * Run: node verify-migrate-voucher-total-amount.js
 */

require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");

const TENANT_A = "verify-migrate-vta-tenant-A";
const TENANT_B = "verify-migrate-vta-tenant-B";

let pass = 0;
let fail = 0;

function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`PASS | ${id} - ${description}`);
  } else {
    fail += 1;
    console.log(`FAIL | ${id} - ${description}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

function runMigration(args) {
  try {
    const stdout = execFileSync("node", ["migrate-voucher-total-amount.js", ...args], { encoding: "utf8" });
    return { stdout, code: 0 };
  } catch (error) {
    return { stdout: (error.stdout || "") + (error.stderr || ""), code: error.status };
  }
}

async function cleanup() {
  await Sale.deleteMany({ tenantId: { $in: [TENANT_A, TENANT_B] } });
  await Purchase.deleteMany({ tenantId: { $in: [TENANT_A, TENANT_B] } });
}

function wrongSaleDoc(tenantId, voucherNo) {
  // Mirrors a real understated document: header.voucherTotalAmount holds
  // the old (wrong) inventory subtotal; ledgers hold the real party
  // ledger + tax, from which the correct total (1073.00) is derivable.
  return {
    tenantId,
    header: {
      voucherNo,
      voucherDate: new Date("2025-08-01"),
      voucherType: "Sales",
      voucherTotalAmount: 909.20, // WRONG - old inventory-subtotal formula
      narration: "",
      partyName: "Migration Test Party",
    },
    inventory: [{ itemName: "Item A", quantity: 6, rate: 151.53, amount: 909.20, discountPercentage: 0, discountAmount: 0 }],
    ledgers: [
      { ledgerName: "Migration Test Party", ledgerAmount: -1073, entryType: "Credit" },
      { ledgerName: "CGST", ledgerAmount: 81.83, entryType: "Debit" },
      { ledgerName: "SGST", ledgerAmount: 81.83, entryType: "Debit" },
      { ledgerName: "Rounding Off", ledgerAmount: 0.14, entryType: "Debit" },
    ],
    tallyGuid: `migration-test-guid-${voucherNo}`,
    tallyAlterId: 42,
    voucherStatus: "active",
  };
}

function alreadyCorrectSaleDoc(tenantId, voucherNo) {
  // No tax component - old formula and new formula agree (500.00 both
  // ways) - this document should be reported "already correct", never
  // written.
  return {
    tenantId,
    header: {
      voucherNo,
      voucherDate: new Date("2025-08-02"),
      voucherType: "Sales",
      voucherTotalAmount: 500,
      narration: "",
      partyName: "Already Correct Party",
    },
    inventory: [{ itemName: "Item B", quantity: 1, rate: 500, amount: 500, discountPercentage: 0, discountAmount: 0 }],
    ledgers: [
      { ledgerName: "Already Correct Party", ledgerAmount: -500, entryType: "Credit" },
      { ledgerName: "Sales", ledgerAmount: 500, entryType: "Debit" },
    ],
    tallyGuid: `migration-test-guid-${voucherNo}`,
    tallyAlterId: 1,
    voucherStatus: "active",
  };
}

function wrongPurchaseDoc(tenantId, voucherNo) {
  return {
    tenantId,
    header: {
      voucherNo,
      voucherDate: new Date("2025-08-03"),
      voucherType: "Purchase",
      voucherTotalAmount: -2540.70, // WRONG - old inventory-subtotal formula (Purchase sign convention)
      narration: "",
      partyName: "Migration Test Supplier",
    },
    inventory: [{ itemName: "Item C", quantity: 5, rate: 508.14, amount: -2540.70, discountPercentage: 0, discountAmount: 0 }],
    ledgers: [
      { ledgerName: "Migration Test Supplier", ledgerAmount: 3057, entryType: "Debit" },
      { ledgerName: "IGST", ledgerAmount: -466.33, entryType: "Credit" },
    ],
    tallyGuid: `migration-test-guid-${voucherNo}`,
    tallyAlterId: 7,
    voucherStatus: "active",
  };
}

async function main() {
  await connectDB();
  await cleanup();

  const tmpExportPath = path.join(os.tmpdir(), `verify-migrate-vta-export-${Date.now()}.json`);

  try {
    // ---- Seed fixtures ----
    await Sale.create(wrongSaleDoc(TENANT_A, "VERIFY-VTA-SALE-1"));
    await Sale.create(alreadyCorrectSaleDoc(TENANT_A, "VERIFY-VTA-SALE-2"));
    await Purchase.create(wrongPurchaseDoc(TENANT_A, "VERIFY-VTA-PURCH-1"));
    await Sale.create(wrongSaleDoc(TENANT_B, "VERIFY-VTA-SALE-B1"));

    const beforeDryRun = await Sale.findOne({ tenantId: TENANT_A, "header.voucherNo": "VERIFY-VTA-SALE-1" }).lean();

    // ---- Test 1: dry run -> zero writes ----
    const dryRun = runMigration(["--tenant", TENANT_A, "--collection", "sales"]);
    check("1a-dry-run-exit-code", "Dry run exits 0", dryRun.code, 0);
    check("1b-dry-run-reports-affected", "Dry run reports 1 requiring correction", /requiring correction:\s+1/.test(dryRun.stdout), true);
    check("1c-dry-run-no-write-message", "Dry run prints DRY RUN COMPLETE, no writes", /DRY RUN COMPLETE/.test(dryRun.stdout), true);

    const afterDryRun = await Sale.findOne({ tenantId: TENANT_A, "header.voucherNo": "VERIFY-VTA-SALE-1" }).lean();
    check("1d-dry-run-db-unchanged", "Database is byte-identical after dry run", JSON.stringify(afterDryRun), JSON.stringify(beforeDryRun));

    // ---- Refuses to write without --export ----
    const writeWithoutExport = runMigration(["--tenant", TENANT_A, "--collection", "sales", "--write"]);
    check("1e-refuses-write-without-export", "Refuses --write without --export", writeWithoutExport.code !== 0 && /REFUSING TO WRITE/.test(writeWithoutExport.stdout), true);

    // ---- Test 2: write mode -> only header.voucherTotalAmount changes ----
    const write = runMigration(["--tenant", TENANT_A, "--collection", "sales", "--write", "--export", tmpExportPath]);
    check("2a-write-exit-code", "Write run exits 0", write.code, 0);
    check("2b-write-complete-message", "Write run prints WRITE COMPLETE", /WRITE COMPLETE/.test(write.stdout), true);

    const afterWrite = await Sale.findOne({ tenantId: TENANT_A, "header.voucherNo": "VERIFY-VTA-SALE-1" }).lean();
    check("2c-amount-corrected", "voucherTotalAmount corrected to 1073.00", afterWrite.header.voucherTotalAmount, 1073.00);
    check("2d-tallyGuid-unchanged", "tallyGuid unchanged", afterWrite.tallyGuid, beforeDryRun.tallyGuid);
    check("2e-tallyAlterId-unchanged", "tallyAlterId unchanged", afterWrite.tallyAlterId, beforeDryRun.tallyAlterId);
    check("2f-voucherStatus-unchanged", "voucherStatus unchanged", afterWrite.voucherStatus, beforeDryRun.voucherStatus);
    check("2g-tenantId-unchanged", "tenantId unchanged", afterWrite.tenantId, beforeDryRun.tenantId);
    check("2h-partyName-unchanged", "header.partyName unchanged", afterWrite.header.partyName, beforeDryRun.header.partyName);
    check("2i-inventory-unchanged", "inventory unchanged", JSON.stringify(afterWrite.inventory), JSON.stringify(beforeDryRun.inventory));
    check("2j-ledgers-unchanged", "ledgers unchanged", JSON.stringify(afterWrite.ledgers), JSON.stringify(beforeDryRun.ledgers));

    const alreadyCorrectAfter = await Sale.findOne({ tenantId: TENANT_A, "header.voucherNo": "VERIFY-VTA-SALE-2" }).lean();
    check("2k-already-correct-untouched", "Already-correct document's amount is unchanged", alreadyCorrectAfter.header.voucherTotalAmount, 500);

    const exportData = JSON.parse(fs.readFileSync(tmpExportPath, "utf8"));
    check("2l-export-file-has-old-value", "Export file records the OLD value for recovery reference", exportData.find((r) => r.voucherNo === "VERIFY-VTA-SALE-1").oldAmount, 909.20);

    // ---- Test 3: idempotency - run again, zero additional corrections ----
    const secondWrite = runMigration(["--tenant", TENANT_A, "--collection", "sales", "--write", "--export", tmpExportPath]);
    check("3a-idempotent-zero-affected", "Second run reports 0 requiring correction", /requiring correction:\s+0/.test(secondWrite.stdout), true);
    check("3b-idempotent-already-correct-count", "Second run reports 2 already correct (both docs)", /already correct:\s+2/.test(secondWrite.stdout), true);

    const afterSecondWrite = await Sale.findOne({ tenantId: TENANT_A, "header.voucherNo": "VERIFY-VTA-SALE-1" }).lean();
    check("3c-value-stable", "Value unchanged by the second run", afterSecondWrite.header.voucherTotalAmount, 1073.00);

    // ---- Test 4: tenant isolation ----
    const tenantBDoc = await Sale.findOne({ tenantId: TENANT_B, "header.voucherNo": "VERIFY-VTA-SALE-B1" }).lean();
    check("4-tenant-isolation", "Tenant B's document was NEVER touched by a tenant-A-scoped migration", tenantBDoc.header.voucherTotalAmount, 909.20);

    // ---- Test 5: collection isolation ----
    const purchaseDocStillWrong = await Purchase.findOne({ tenantId: TENANT_A, "header.voucherNo": "VERIFY-VTA-PURCH-1" }).lean();
    check("5a-collection-isolation-purchase-untouched", "Purchase document untouched by a sales-only migration run", purchaseDocStillWrong.header.voucherTotalAmount, -2540.70);

    // Now correct Purchase explicitly and confirm it also works + Sales stays untouched
    const purchaseExportPath = path.join(os.tmpdir(), `verify-migrate-vta-export-purch-${Date.now()}.json`);
    const purchaseWrite = runMigration(["--tenant", TENANT_A, "--collection", "purchases", "--write", "--export", purchaseExportPath]);
    check("5b-purchase-write-exit-code", "Purchase-collection write exits 0", purchaseWrite.code, 0);
    const purchaseDocFixed = await Purchase.findOne({ tenantId: TENANT_A, "header.voucherNo": "VERIFY-VTA-PURCH-1" }).lean();
    check("5c-purchase-corrected", "Purchase document corrected to 3057.00", purchaseDocFixed.header.voucherTotalAmount, 3057.00);
    const salesStillFixed = await Sale.findOne({ tenantId: TENANT_A, "header.voucherNo": "VERIFY-VTA-SALE-1" }).lean();
    check("5d-collection-isolation-sales-unaffected", "Sales document unaffected by a purchases-only migration run", salesStillFixed.header.voucherTotalAmount, 1073.00);
    fs.unlinkSync(purchaseExportPath);
  } finally {
    await cleanup();
    if (fs.existsSync(tmpExportPath)) fs.unlinkSync(tmpExportPath);
    await mongoose.disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("TEST SUITE ERROR:", err);
  try { await cleanup(); await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
