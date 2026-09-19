/**
 * List all MongoDB indexes on the sales collection
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./src/config/db');

async function listIndexes() {
  try {
    await connectDB();
    const Sale = require('./src/models/sales.model');
    const client = mongoose.connection.getClient();
    const db = client.db(process.env.MONGODB_DB || 'users');
    const collection = db.collection('sales');
    const indexes = await collection.listIndexes().toArray();

    console.log('\n========================================');
    console.log('ALL INDEXES ON sales COLLECTION');
    console.log('========================================\n');

    indexes.forEach((indexInfo) => {
      console.log(`Index: ${indexInfo.name}`);
      console.log(`Spec: ${JSON.stringify(indexInfo.key, null, 2)}`);
      console.log('Options:', JSON.stringify(indexInfo, null, 2));
      console.log('---');
    });

    console.log('\n========================================');
    console.log('INDEX ANALYSIS');
    console.log('========================================\n');

    const staleIndexes = [];
    const currentIndexes = [];

    indexes.forEach((indexInfo) => {
      if (indexInfo.name === '_id_') {
        currentIndexes.push(indexInfo.name);
        return;
      }

      // Check if index contains legacy fields
      const keyStr = JSON.stringify(indexInfo.key || {});
      if (keyStr.includes('source') || keyStr.includes('remoteId')) {
        staleIndexes.push({ name: indexInfo.name, spec: indexInfo });
      } else if (keyStr.includes('tenantId') && keyStr.includes('header.voucherNo')) {
        currentIndexes.push(indexInfo.name);
      } else {
        // Unknown index - treat as potentially stale
        staleIndexes.push({ name: indexInfo.name, spec: indexInfo });
      }
    });

    console.log(`✓ Current indexes: ${currentIndexes.join(', ')}`);
    console.log(`⚠ Stale indexes: ${staleIndexes.length}`);

    if (staleIndexes.length > 0) {
      console.log('\nStale indexes to drop:\n');
      staleIndexes.forEach(idx => {
        console.log(`  db.getCollection("sales").dropIndex("${idx.name}");`);
      });
    }

    await mongoose.connection.close();

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

listIndexes();
