const fs = require('fs');
const path = require('path');
const { parseTallyVoucher } = require('./tallyParser');

const filePath = path.resolve(__dirname, '../../../sample-data/tally-sales.json');

try {
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const rawVoucher = JSON.parse(fileContent);
  const parsed = parseTallyVoucher(rawVoucher);

  console.log(JSON.stringify(parsed, null, 2));
} catch (error) {
  console.error('Failed to parse Tally voucher:', error.message);
  process.exitCode = 1;
}
