/**
 * On-demand Stock Item -> Stock Group master refresh.
 *
 * NOT a migration and NOT the incremental voucher sync: this writes only
 * to the new, previously-empty StockItemMaster collection - it never
 * reads or writes Sale, Purchase, or SyncCheckpoint, and never contacts
 * Tally for voucher/transactional data. Safe to re-run at any time
 * (idempotent upsert, keyed by {tenantId, tallyGuid}).
 *
 * There is no scheduled worker for this yet, by design (see the
 * Stock Item master investigation report) - this script is the only way
 * to trigger a refresh right now, run manually per tenant.
 *
 * USAGE
 * -----
 *   node refresh-stock-item-master.js --tenant <tenantId> [--skip-gst]
 *
 * --tenant is REQUIRED. There is no "all tenants" mode - matches the
 * same explicit-per-tenant safety convention as
 * migrate-voucher-total-amount.js.
 *
 * After the Stock Item -> Stock Group refresh it also reads each Stock
 * Group's GST/HSN configuration from Tally (one group per request,
 * sequentially) and stores it on the items under `gst`. The result's `gst`
 * block says what was updated, unchanged, kept or skipped. --skip-gst
 * refreshes the groups only. The GST phase can never fail the group refresh.
 */

require("dotenv").config();
const connectDB = require("./src/config/db");
const mongoose = require("mongoose");
const Company = require("./src/models/company.js");
const { refreshStockItemMasters } = require("./src/services/tally/stockItemMaster");

function parseArgs(argv) {
  const args = { tenant: null, skipGst: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tenant") {
      args.tenant = argv[i + 1];
      i++;
    } else if (argv[i] === "--skip-gst") {
      args.skipGst = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.tenant) {
    console.error("Usage: node refresh-stock-item-master.js --tenant <tenantId> [--skip-gst]");
    process.exit(1);
  }

  await connectDB();

  const company = await Company.findOne({ tenantId: args.tenant }).lean();
  if (!company) {
    console.error(`No Company found for tenantId "${args.tenant}".`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Refreshing Stock Item masters for ${company.companyName} (tenant ${args.tenant})...`);

  const result = await refreshStockItemMasters({
    tenantId: args.tenant,
    companyGuid: company.companyGuid,
    baseUrl: company.tallyConnection?.baseUrl || undefined,
    includeGst: !args.skipGst,
  });

  console.log(JSON.stringify(result, null, 2));

  await mongoose.disconnect();
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
