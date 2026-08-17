/**
 * Duplicate Import Verification
 * 
 * Steps:
 * 1. Use the same Tally JSON file
 * 2. Import it once
 * 3. Import it again without changing data
 * 4. Verify only one document exists
 * 5. Report PASS or FAIL
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const connectDB = require('./src/config/db');
const Sale = require('./src/models/sales.model');
const { importTallySales } = require('./src/services/import/tallySalesImport');

const TEST_TENANT_ID = '507f1f77bcf86cd799439011';
const TEST_VOUCHER_NO = 'SA/11/2025-26';

async function verifyDuplicateProtection() {
  const report = {
    timestamp: new Date().toISOString(),
    firstImport: null,
    secondImport: null,
    documentCount: null,
    finalResult: 'NOT_RUN'
  };

  try {
    // ========== STEP 0: Connect to MongoDB ==========
    console.log('\n=== STEP 0: Connecting to MongoDB ===');
    await connectDB();
    console.log('✓ MongoDB connected');

    // ========== STEP 0.5: Clean previous test data ==========
    console.log('\n=== STEP 0.5: Clean previous test data ===');
    const existingDoc = await Sale.findOne({
      tenantId: TEST_TENANT_ID,
      'header.voucherNo': TEST_VOUCHER_NO
    }).lean();

    if (existingDoc) {
      console.log(`Found existing document (ID: ${existingDoc._id})`);
      console.log('Removing it to start fresh...');
      await Sale.deleteOne({ _id: existingDoc._id });
      console.log('✓ Test document removed');
    } else {
      console.log('No existing test document found');
    }

    // ========== STEP 1: Verify JSON file exists ==========
    console.log('\n=== STEP 1: Verify Tally JSON file ===');
    const tallyJsonPath = path.resolve(__dirname, './sample-data/tally-sales.json');
    if (!fs.existsSync(tallyJsonPath)) {
      throw new Error(`Tally JSON file not found: ${tallyJsonPath}`);
    }
    const rawJson = JSON.parse(fs.readFileSync(tallyJsonPath, 'utf8'));
    console.log(`✓ Tally JSON loaded: ${tallyJsonPath}`);

    // ========== STEP 2: First Import ==========
    console.log('\n=== STEP 2: First Import ===');
    console.log('Importing Tally JSON (first time)...');
    const firstResult = await importTallySales({ rawData: rawJson });
    
    console.log('\nFirst Import Result:');
    console.log(`  Status: ${firstResult.status}`);
    console.log(`  Created: ${firstResult.created}`);
    console.log(`  Duplicate: ${firstResult.duplicate}`);
    console.log(`  VoucherNo: ${firstResult.voucherNo}`);
    console.log(`  SaleId: ${firstResult.saleId}`);
    console.log(`  Message: ${firstResult.message}`);
    
    report.firstImport = {
      status: firstResult.status,
      created: firstResult.created,
      duplicate: firstResult.duplicate,
      voucherNo: firstResult.voucherNo,
      saleId: firstResult.saleId,
      message: firstResult.message
    };

    if (!firstResult.created) {
      throw new Error(`First import failed: ${firstResult.message}`);
    }

    // ========== STEP 3: Second Import (same data) ==========
    console.log('\n=== STEP 3: Second Import (same data) ===');
    console.log('Importing Tally JSON (second time, no data change)...');
    const secondResult = await importTallySales({ rawData: rawJson });
    
    console.log('\nSecond Import Result:');
    console.log(`  Status: ${secondResult.status}`);
    console.log(`  Created: ${secondResult.created}`);
    console.log(`  Duplicate: ${secondResult.duplicate}`);
    console.log(`  VoucherNo: ${secondResult.voucherNo}`);
    console.log(`  SaleId: ${secondResult.saleId}`);
    console.log(`  Message: ${secondResult.message}`);
    
    report.secondImport = {
      status: secondResult.status,
      created: secondResult.created,
      duplicate: secondResult.duplicate,
      voucherNo: secondResult.voucherNo,
      saleId: secondResult.saleId,
      message: secondResult.message
    };

    if (!secondResult.duplicate) {
      throw new Error('Second import was not detected as duplicate');
    }

    // ========== STEP 4: Verify document count ==========
    console.log('\n=== STEP 4: Verify Document Count ===');
    const count = await Sale.countDocuments({
      tenantId: TEST_TENANT_ID,
      'header.voucherNo': TEST_VOUCHER_NO
    });

    console.log(`Document count for tenantId=${TEST_TENANT_ID}, voucherNo=${TEST_VOUCHER_NO}:`);
    console.log(`  Count: ${count}`);
    
    report.documentCount = count;

    if (count !== 1) {
      throw new Error(`Expected 1 document, but found ${count}`);
    }

    // ========== STEP 5: Fetch and verify the document ==========
    console.log('\n=== STEP 5: Verify Stored Document ===');
    const storedDoc = await Sale.findOne({
      tenantId: TEST_TENANT_ID,
      'header.voucherNo': TEST_VOUCHER_NO
    }).lean();

    if (!storedDoc) {
      throw new Error('Document not found in MongoDB');
    }

    console.log('Stored document details:');
    console.log(`  _id: ${storedDoc._id}`);
    console.log(`  tenantId: ${storedDoc.tenantId}`);
    console.log(`  voucherNo: ${storedDoc.header.voucherNo}`);
    console.log(`  partyName: ${storedDoc.header.partyName}`);
    console.log(`  voucherTotalAmount: ${storedDoc.header.voucherTotalAmount}`);
    console.log(`  inventoryItems: ${storedDoc.inventory.length}`);
    console.log(`  ledgerEntries: ${storedDoc.ledgers.length}`);

    // ========== FINAL RESULT ==========
    console.log('\n=== FINAL RESULT ===');

    const firstImportOk = firstResult.created === true && firstResult.duplicate === false;
    const secondImportOk = secondResult.created === false && secondResult.duplicate === true;
    const documentCountOk = count === 1;
    const saleIdConsistent = firstResult.saleId === secondResult.saleId;

    const allPassed = firstImportOk && secondImportOk && documentCountOk && saleIdConsistent;

    console.log(`\nExpectation checks:`);
    console.log(`  First import created? ${firstImportOk ? '✓' : '✗'} (created=${firstResult.created}, duplicate=${firstResult.duplicate})`);
    console.log(`  Second import duplicate? ${secondImportOk ? '✓' : '✗'} (created=${secondResult.created}, duplicate=${secondResult.duplicate})`);
    console.log(`  Document count = 1? ${documentCountOk ? '✓' : '✗'} (count=${count})`);
    console.log(`  Sale IDs consistent? ${saleIdConsistent ? '✓' : '✗'} (first=${firstResult.saleId}, second=${secondResult.saleId})`);

    report.finalResult = allPassed ? 'PASS' : 'FAIL';

    if (allPassed) {
      console.log('\n✓✓✓ DUPLICATE PROTECTION VERIFIED - PASS ✓✓✓\n');
    } else {
      console.log('\n✗✗✗ DUPLICATE PROTECTION FAILED ✗✗✗\n');
    }

    await mongoose.connection.close();
    printReport(report);

  } catch (error) {
    console.error('\n✗✗✗ FATAL ERROR ✗✗✗');
    console.error(error.stack || error.message);
    report.finalResult = 'ERROR';
    report.error = error.message;
    printReport(report);
    await mongoose.connection.close();
    process.exit(1);
  }
}

function printReport(report) {
  console.log('\n========================================');
  console.log('DUPLICATE IMPORT VERIFICATION REPORT');
  console.log('========================================');
  console.log(JSON.stringify(report, null, 2));
  console.log('========================================\n');
}

verifyDuplicateProtection().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
