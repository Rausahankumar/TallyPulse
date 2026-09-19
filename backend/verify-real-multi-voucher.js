require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');

const connectDB = require('./src/config/db');
const Sale = require('./src/models/sales.model');
const { parseTallyVoucher } = require('./src/services/parser/tallyParser');
const { importTallySales } = require('./src/services/import/tallySalesImport');

(async () => {
  try {
    await connectDB();

    const raw = JSON.parse(fs.readFileSync('./sample-data/tally-multi-vouchers.json', 'utf8'));
    const vouchers = raw.tallymessage || raw.vouchers || raw.voucher || [];

    const parsed = vouchers.map((voucher) => {
      const parsedVoucher = parseTallyVoucher(voucher);
      return {
        voucherNo: parsedVoucher.header.voucherNo,
        inventoryCount: parsedVoucher.inventory.length,
        ledgerCount: parsedVoucher.ledgers.length,
        ledgerNames: parsedVoucher.ledgers.slice(0, 10).map((item) => item.ledgerName),
      };
    });

    console.log('=== PARSED VOUCHERS ===');
    console.log(JSON.stringify(parsed, null, 2));

    const first = await importTallySales({ rawData: raw });
    const second = await importTallySales({ rawData: raw });

    const docs = await Sale.find({ tenantId: '507f1f77bcf86cd799439011' }).sort({ 'header.voucherNo': 1 }).lean();

    const detail = docs.map((doc) => ({
      voucherNo: doc.header && doc.header.voucherNo,
      inventoryCount: (doc.inventory || []).length,
      ledgerCount: (doc.ledgers || []).length,
      ledgerNames: (doc.ledgers || []).map((item) => item.ledgerName),
    }));

    console.log('=== FIRST IMPORT RESULT ===');
    console.log(JSON.stringify(first, null, 2));

    console.log('=== SECOND IMPORT RESULT ===');
    console.log(JSON.stringify(second, null, 2));

    console.log('=== MONGO DOCUMENT COUNT ===');
    console.log(JSON.stringify({ count: docs.length }, null, 2));

    console.log('=== STORED DOCUMENTS ===');
    console.log(JSON.stringify(detail, null, 2));

    const passed = first.total === vouchers.length && first.created === vouchers.length && second.duplicates >= 1 && docs.length === vouchers.length;
    console.log('=== FINAL RESULT ===');
    console.log(JSON.stringify({ pass: passed }, null, 2));

    await mongoose.connection.close();
    process.exit(passed ? 0 : 1);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
})();
