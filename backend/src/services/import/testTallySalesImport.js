const mongoose = require('mongoose');
const connectDB = require('../../config/db');
const { importTallySales } = require('./tallySalesImport');

(async () => {
  try {
    await connectDB();

    const firstResult = await importTallySales();

    console.log('FIRST IMPORT RESULT');
    console.log(JSON.stringify({
      tenantId: firstResult.tenantId,
      voucherNo: firstResult.sale && firstResult.sale.header ? firstResult.sale.header.voucherNo : null,
      partyName: firstResult.sale && firstResult.sale.header ? firstResult.sale.header.partyName : null,
      itemCount: firstResult.sale && Array.isArray(firstResult.sale.inventory) ? firstResult.sale.inventory.length : 0,
      saleId: firstResult.sale && firstResult.sale._id ? String(firstResult.sale._id) : null,
      created: firstResult.created,
      duplicate: firstResult.duplicate,
      message: firstResult.message,
    }, null, 2));

    const secondResult = await importTallySales();

    console.log('SECOND IMPORT RESULT');
    console.log(JSON.stringify({
      created: secondResult.created,
      duplicate: secondResult.duplicate,
      message: secondResult.message,
      tenantId: secondResult.tenantId,
      voucherNo: secondResult.sale && secondResult.sale.header ? secondResult.sale.header.voucherNo : null,
      saleId: secondResult.sale && secondResult.sale._id ? String(secondResult.sale._id) : null,
    }, null, 2));

    await mongoose.connection.close();
  } catch (error) {
    console.error('Import test failed:', error.message);
    process.exitCode = 1;
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }
  }
})();
