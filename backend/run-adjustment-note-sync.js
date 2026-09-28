/**
 * One-off / manual Credit Note + Debit Note sync for a single tenant.
 * Reuses the EXACT same code path as the background worker
 * (runSyncForCompanyModule + CREDIT_NOTE_SYNC_MODULE/DEBIT_NOTE_SYNC_MODULE
 * from tallySyncWorker.js) - same ownership guard, same completeness check,
 * same checkpoint semantics, same minimal-field Tally request. Not a
 * parallel implementation.
 *
 * USAGE
 *   node run-adjustment-note-sync.js --tenant <tenantId>
 */

require("dotenv").config();
const connectDB = require("./src/config/db");
const mongoose = require("mongoose");
const Company = require("./src/models/company.js");
const { runSyncForCompanyModule, CREDIT_NOTE_SYNC_MODULE, DEBIT_NOTE_SYNC_MODULE } = require("./src/services/sync/tallySyncWorker");

function parseArgs(argv) {
  const args = { tenant: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tenant") {
      args.tenant = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenant) {
    console.error("Usage: node run-adjustment-note-sync.js --tenant <tenantId>");
    process.exit(1);
  }

  await connectDB();

  const company = await Company.findOne({ tenantId: args.tenant }).lean();
  if (!company) {
    console.error(`No Company found for tenantId "${args.tenant}".`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Syncing Credit/Debit Notes for ${company.companyName} (tenant ${args.tenant})...`);

  const creditResult = await runSyncForCompanyModule(company, CREDIT_NOTE_SYNC_MODULE, {});
  console.log("Credit Note:", JSON.stringify(creditResult));

  const debitResult = await runSyncForCompanyModule(company, DEBIT_NOTE_SYNC_MODULE, {});
  console.log("Debit Note:", JSON.stringify(debitResult));

  await mongoose.disconnect();
  process.exit(creditResult.error || debitResult.error ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
