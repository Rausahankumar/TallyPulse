/**
 * On-demand Tally Ledger master refresh (feeds "new customer/supplier").
 *
 * Writes only to the LedgerMaster collection - never Sale, Purchase or
 * SyncCheckpoint. Reads two Tally master collections (Group, Ledger), one at
 * a time. Safe to re-run: idempotent upsert keyed by the ledger GUID, and a
 * no-op when Tally's list is unchanged (pass --force to rewrite anyway).
 * The selected Tally company must be this tenant's: a foreign company's
 * masters fail the GUID ownership check and nothing is written.
 *
 * USAGE
 *   node refresh-ledger-master.js --tenant <tenantId> [--force]
 */

require("dotenv").config();
const connectDB = require("./src/config/db");
const mongoose = require("mongoose");
const Company = require("./src/models/company.js");
const { refreshLedgerMasters } = require("./src/services/tally/ledgerMaster");

function parseArgs(argv) {
  const args = { tenant: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tenant") {
      args.tenant = argv[i + 1];
      i++;
    } else if (argv[i] === "--force") {
      args.force = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.tenant) {
    console.error("Usage: node refresh-ledger-master.js --tenant <tenantId> [--force]");
    process.exit(1);
  }

  await connectDB();

  const company = await Company.findOne({ tenantId: args.tenant }).lean();
  if (!company) {
    console.error(`No Company found for tenantId "${args.tenant}".`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Refreshing Ledger masters for ${company.companyName} (tenant ${args.tenant})...`);

  const result = await refreshLedgerMasters({
    tenantId: args.tenant,
    companyGuid: company.companyGuid,
    baseUrl: company.tallyConnection?.baseUrl || undefined,
    force: args.force,
  });

  console.log(JSON.stringify(result, null, 2));

  await mongoose.disconnect();
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
