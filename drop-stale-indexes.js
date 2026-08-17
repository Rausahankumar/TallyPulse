/**
 * Drop stale MongoDB indexes from the sales collection
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./src/config/db');

async function dropStaleIndexes() {
  try {
    await connectDB();
    const client = mongoose.connection.getClient();
    const db = client.db(process.env.MONGODB_DB || 'users');
    const collection = db.collection('sales');

    const staleIndexes = [
      'tenantId_1',
      'tenantId_1_source.remoteId_1',
      'tenantId_1_invoice.number_1',
      'tenantId_1_header.invoiceNumber_1'
    ];

    console.log('\n========================================');
    console.log('DROPPING STALE INDEXES');
    console.log('========================================\n');

    for (const indexName of staleIndexes) {
      try {
        console.log(`Dropping index: ${indexName}`);
        await collection.dropIndex(indexName);
        console.log(`✓ Successfully dropped: ${indexName}`);
      } catch (error) {
        if (error.message.includes('index not found')) {
          console.log(`⚠ Index not found (already dropped?): ${indexName}`);
        } else {
          console.error(`✗ Failed to drop ${indexName}:`, error.message);
        }
      }
    }

    console.log('\n========================================');
    console.log('REMAINING INDEXES');
    console.log('========================================\n');

    const remainingIndexes = await collection.listIndexes().toArray();
    remainingIndexes.forEach((idx) => {
      console.log(`- ${idx.name}:`, JSON.stringify(idx.key));
    });

    console.log('\n========================================');
    console.log('✓ Cleanup complete');
    console.log('========================================\n');

    await mongoose.connection.close();

  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

dropStaleIndexes();
