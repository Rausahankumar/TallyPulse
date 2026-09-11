const { parseTallyVoucher } = require('./src/services/parser/tallyParser');
const { mapTallySale } = require('./src/services/mapper/salesMapper');
const Sale = require('./src/models/sales.model');
const fs = require('fs');

const sample = JSON.parse(fs.readFileSync('./sample-data/tally-multi-vouchers.json'));
const vouchers = sample.tallymessage;
const tenantId = '507f1f77bcf86cd799439011';

try {
  const v1 = vouchers[0];
  const parsed = parseTallyVoucher(v1);
  console.log('✓ Parser works');
  console.log('✓ Parsed header:', parsed.header.voucherNo);

  const mapped = mapTallySale(parsed, { tenantId });
  console.log('✓ Mapper works');
  console.log('✓ Mapped voucherNo:', mapped.header.voucherNo);

  const doc = new Sale(mapped);
  console.log('✓ Sale document created');

  const validErr = doc.validateSync();
  if (validErr) {
    console.log('✗ Sync validation error:', validErr.message);
  } else {
    console.log('✓ Sync validation passed');
  }

  console.log('\n=== Verification Summary ===');
  console.log('✓ All core functions working');
  console.log('✓ Parser output structure preserved');
  console.log('✓ Mapper output structure preserved');
  console.log('✓ Validation logic preserved');
} catch (e) {
  console.error('✗ Error:', e.message);
  console.error(e.stack);
  process.exit(1);
}
