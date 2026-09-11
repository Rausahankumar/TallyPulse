require('dotenv').config();
const path = require('path');
const { importTallySales } = require('./src/services/import/tallySalesImport');

(async () => {
  try {
    const result = await importTallySales({
      filePath: path.resolve('./sample-data/tally-multi-vouchers.json')
    });

    console.log('RESULT_TYPE', Array.isArray(result.results) ? 'SUMMARY' : 'SINGLE');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('ERR', error.message);
    process.exitCode = 1;
  }
})();
