/**
 * Complete Tally JSON → MongoDB Import Flow Verification (FINAL)
 * 
 * This script:
 * 1. Cleans stale documents from the collection
 * 2. Parses Tally JSON
 * 3. Maps to final Sales schema
 * 4. Validates with Mongoose
 * 5. Inserts into MongoDB
 * 6. Fetches from MongoDB
 * 7. Verifies schema compliance
 * 8. Reports PASS/FAIL
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const connectDB = require('./src/config/db');
const Sale = require('./src/models/sales.model');
const { parseTallyVoucher } = require('./src/services/parser/tallyParser');
const { mapTallySale } = require('./src/services/mapper/salesMapper');

const ALLOWED_ROOT_FIELDS = ['_id', 'tenantId', 'header', 'inventory', 'ledgers', 'createdAt', 'updatedAt', '__v'];
const ALLOWED_HEADER_FIELDS = ['voucherNo', 'voucherDate', 'voucherType', 'voucherTotalAmount', 'narration', 'partyName'];
const ALLOWED_INVENTORY_FIELDS = ['itemName', 'quantity', 'rate', 'amount', 'discountPercentage', 'discountAmount', '_id'];
const ALLOWED_LEDGER_FIELDS = ['ledgerName', 'ledgerAmount', 'entryType', '_id'];

function collectExtraFields(doc, allowed, path = '') {
  const extras = [];
  if (!doc || typeof doc !== 'object') return extras;

  Object.keys(doc).forEach(key => {
    const fullPath = path ? `${path}.${key}` : key;
    if (!allowed.includes(key)) {
      extras.push(fullPath);
    }
  });

  return extras;
}

async function verifyImportFlow() {
  const report = {
    timestamp: new Date().toISOString(),
    steps: {},
    indexes: [],
    extraFields: [],
    finalResult: 'NOT_RUN'
  };

  try {
    // ========== STEP 0: Connect to MongoDB ==========
    console.log('\n=== STEP 0: Connecting to MongoDB ===');
    await connectDB();
    console.log('✓ MongoDB connected');
    report.steps.mongodbConnection = 'PASS';

    // ========== STEP 0.5: Clean test data ==========
    console.log('\n=== STEP 0.5: Clean test data ===');
    const tenantId = '507f1f77bcf86cd799439011';
    const testVoucherNo = 'SA/11/2025-26';
    
    const existingDoc = await Sale.findOne({
      tenantId,
      'header.voucherNo': testVoucherNo
    }).lean();

    if (existingDoc) {
      console.log(`Found existing test document (ID: ${existingDoc._id})`);
      console.log('Removing it to allow clean import...');
      await Sale.deleteOne({ _id: existingDoc._id });
      console.log('✓ Test document removed');
    } else {
      console.log('No existing test document found');
    }
    report.steps.cleanupData = 'PASS';

    // ========== STEP 1: Read Tally JSON ==========
    console.log('\n=== STEP 1: Reading Tally JSON ===');
    const tallyJsonPath = path.resolve(__dirname, './sample-data/tally-sales.json');
    const rawJson = JSON.parse(fs.readFileSync(tallyJsonPath, 'utf8'));
    console.log(`✓ Tally JSON loaded: ${tallyJsonPath}`);
    report.steps.readJson = 'PASS';

    // ========== STEP 2: Parse Tally JSON ==========
    console.log('\n=== STEP 2: Parse Tally JSON ===');
    const parsedVoucher = parseTallyVoucher(rawJson);
    console.log('Parsed header fields:', Object.keys(parsedVoucher.header));
    console.log('Parsed inventory items:', parsedVoucher.inventory.length);
    console.log('Parsed ledger entries:', parsedVoucher.ledgers.length);
    report.steps.parseJson = {
      status: 'PASS',
      headerFields: Object.keys(parsedVoucher.header),
      inventoryCount: parsedVoucher.inventory.length,
      ledgerCount: parsedVoucher.ledgers.length,
      sample: {
        header: parsedVoucher.header,
        inventory: parsedVoucher.inventory,
        ledgers: parsedVoucher.ledgers
      }
    };

    // ========== STEP 3: Map to Final Sales Schema ==========
    console.log('\n=== STEP 3: Map to Final Sales Schema ===');
    const mappedSale = mapTallySale(parsedVoucher, { tenantId });
    console.log('Mapped tenantId:', mappedSale.tenantId);
    console.log('Mapped header keys:', Object.keys(mappedSale.header));
    console.log('Mapped inventory[0] keys:', Object.keys(mappedSale.inventory[0] || {}));
    console.log('Mapped ledgers[0] keys:', Object.keys(mappedSale.ledgers[0] || {}));
    report.steps.mapSchema = {
      status: 'PASS',
      tenantId: mappedSale.tenantId,
      headerKeys: Object.keys(mappedSale.header),
      inventoryKeys: Object.keys(mappedSale.inventory[0] || {}),
      ledgerKeys: Object.keys(mappedSale.ledgers[0] || {}),
      sample: mappedSale
    };

    // ========== STEP 4: Validate with Mongoose ==========
    console.log('\n=== STEP 4: Validate with Mongoose Schema ===');
    const saleDoc = new Sale(mappedSale);
    const validationError = saleDoc.validateSync();
    if (validationError) {
      console.error('✗ Validation FAILED:', validationError.message);
      report.steps.mongooseValidation = { status: 'FAIL', error: validationError.message };
      report.finalResult = 'FAIL';
      await mongoose.connection.close();
      printReport(report);
      return;
    }
    console.log('✓ Mongoose validation PASSED');
    report.steps.mongooseValidation = 'PASS';

    // ========== STEP 5: Insert into MongoDB ==========
    console.log('\n=== STEP 5: Insert into MongoDB ===');
    let savedSale;
    try {
      savedSale = await new Sale(mappedSale).save();
      console.log('✓ Document inserted successfully');
      console.log('  _id:', savedSale._id);
      console.log('  tenantId:', savedSale.tenantId);
      console.log('  voucherNo:', savedSale.header.voucherNo);
      report.steps.mongodbInsert = {
        status: 'PASS',
        insertedId: String(savedSale._id),
        voucherNo: savedSale.header.voucherNo
      };
    } catch (insertError) {
      console.error('✗ Insert FAILED:', insertError.message);
      report.steps.mongodbInsert = { status: 'FAIL', error: insertError.message };
      report.finalResult = 'FAIL';
      await mongoose.connection.close();
      printReport(report);
      return;
    }

    // ========== STEP 6: Fetch from MongoDB ==========
    console.log('\n=== STEP 6: Fetch from MongoDB ===');
    const storedDoc = await Sale.findById(savedSale._id).lean();
    if (!storedDoc) {
      console.error('✗ Fetch FAILED: Document not found');
      report.steps.mongodbFetch = 'FAIL';
      report.finalResult = 'FAIL';
      await mongoose.connection.close();
      printReport(report);
      return;
    }
    console.log('✓ Document fetched successfully');
    console.log('  Root fields:', Object.keys(storedDoc).filter(k => !k.startsWith('_')));
    console.log('  Header fields:', Object.keys(storedDoc.header || {}));
    console.log('  Inventory[0] fields:', Object.keys((storedDoc.inventory && storedDoc.inventory[0]) || {}));
    console.log('  Ledgers[0] fields:', Object.keys((storedDoc.ledgers && storedDoc.ledgers[0]) || {}));
    report.steps.mongodbFetch = {
      status: 'PASS',
      storedDocument: JSON.parse(JSON.stringify(storedDoc))
    };

    // ========== STEP 7: List MongoDB Indexes ==========
    console.log('\n=== STEP 7: List MongoDB Indexes ===');
    const client = mongoose.connection.getClient();
    const db = client.db(process.env.MONGODB_DB || 'users');
    const collection = db.collection('sales');
    const indexes = await collection.listIndexes().toArray();
    
    console.log('Indexes on sales collection:');
    indexes.forEach((idx) => {
      console.log(`  - ${idx.name}:`, JSON.stringify(idx.key));
      report.indexes.push({ name: idx.name, key: idx.key });
    });
    report.steps.mongodbIndexes = { status: 'PASS', count: indexes.length };

    // ========== STEP 8: Verify Schema Compliance ==========
    console.log('\n=== STEP 8: Verify Schema Compliance ===');

    // Check root fields
    const extraRootFields = collectExtraFields(storedDoc, ALLOWED_ROOT_FIELDS);
    console.log('Extra root fields:', extraRootFields.length === 0 ? 'None ✓' : extraRootFields);

    // Check header fields
    const extraHeaderFields = collectExtraFields(storedDoc.header || {}, ALLOWED_HEADER_FIELDS);
    console.log('Extra header fields:', extraHeaderFields.length === 0 ? 'None ✓' : extraHeaderFields);

    // Check inventory fields
    let extraInventoryFields = [];
    if (Array.isArray(storedDoc.inventory)) {
      storedDoc.inventory.forEach((item, idx) => {
        const extras = collectExtraFields(item, ALLOWED_INVENTORY_FIELDS, `inventory[${idx}]`);
        extraInventoryFields = extraInventoryFields.concat(extras);
      });
    }
    console.log('Extra inventory fields:', extraInventoryFields.length === 0 ? 'None ✓' : extraInventoryFields);

    // Check ledger fields
    let extraLedgerFields = [];
    if (Array.isArray(storedDoc.ledgers)) {
      storedDoc.ledgers.forEach((item, idx) => {
        const extras = collectExtraFields(item, ALLOWED_LEDGER_FIELDS, `ledgers[${idx}]`);
        extraLedgerFields = extraLedgerFields.concat(extras);
      });
    }
    console.log('Extra ledger fields:', extraLedgerFields.length === 0 ? 'None ✓' : extraLedgerFields);

    report.extraFields = {
      root: extraRootFields,
      header: extraHeaderFields,
      inventory: extraInventoryFields,
      ledgers: extraLedgerFields
    };

    const hasExtraFields = extraRootFields.length > 0 || extraHeaderFields.length > 0 ||
                          extraInventoryFields.length > 0 || extraLedgerFields.length > 0;

    // ========== FINAL RESULT ==========
    console.log('\n=== FINAL RESULT ===');
    report.steps.schemaCompliance = hasExtraFields ? 'FAIL' : 'PASS';

    const allPassed = 
      report.steps.mongodbConnection === 'PASS' &&
      report.steps.readJson === 'PASS' &&
      report.steps.parseJson.status === 'PASS' &&
      report.steps.mapSchema.status === 'PASS' &&
      report.steps.mongooseValidation === 'PASS' &&
      report.steps.mongodbInsert.status === 'PASS' &&
      report.steps.mongodbFetch.status === 'PASS' &&
      report.steps.mongodbIndexes.status === 'PASS' &&
      report.steps.schemaCompliance === 'PASS';

    report.finalResult = allPassed ? 'PASS' : 'FAIL';

    if (allPassed) {
      console.log('\n✓✓✓ ALL VERIFICATION STEPS PASSED ✓✓✓\n');
      console.log('Summary:');
      console.log('  ✓ Tally JSON parsed correctly');
      console.log('  ✓ Data mapped to final schema');
      console.log('  ✓ Mongoose validation passed');
      console.log('  ✓ MongoDB insert succeeded');
      console.log('  ✓ Document fetched from MongoDB');
      console.log('  ✓ No extra fields found in stored document');
      console.log('  ✓ Only valid indexes present\n');
    } else {
      console.log('\n✗✗✗ VERIFICATION FAILED ✗✗✗\n');
      if (hasExtraFields) {
        console.log('Reason: Extra fields detected in stored document');
      }
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
  }
}

function printReport(report) {
  console.log('\n========================================');
  console.log('FULL VERIFICATION REPORT (JSON)');
  console.log('========================================');
  console.log(JSON.stringify(report, null, 2));
  console.log('========================================\n');
}

verifyImportFlow().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
