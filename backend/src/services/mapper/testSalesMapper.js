const fs = require('fs');
const path = require('path');
const { parseTallyVoucher } = require('../parser/tallyParser');
const { mapTallySale } = require('./salesMapper');
const Sale = require('../../models/sales.model');

const filePath = path.resolve(__dirname, '../../../sample-data/tally-sales.json');

try {
  const rawFile = fs.readFileSync(filePath, 'utf8');
  const rawVoucher = JSON.parse(rawFile);
  const parsed = parseTallyVoucher(rawVoucher);
  const context = { tenantId: '507f1f77bcf86cd799439011' };
  const mapped = mapTallySale(parsed, context);

  const tempDoc = new Sale(mapped);
  const validationError = tempDoc.validateSync();

  console.log(JSON.stringify(mapped, null, 2));
  if (validationError) {
    console.log('Mongoose validation: FAIL');
    console.log(validationError.message);
    process.exitCode = 1;
  } else {
    console.log('Mongoose validation: PASS');
  }
} catch (error) {
  console.error('Failed to map Tally sale:', error.message);
  process.exitCode = 1;
}
