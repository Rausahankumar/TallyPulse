/**
 * Back-fill the discount and the computed GST amounts of vouchers that are already stored.
 *
 * Why this exists: the voucher parser used to drop the item-line discount percentage (Tally's `discount` field) and ignore
 * the computed GST group, so every voucher synced before that fix has discount 0/0 and no `gst.amounts`. The incremental
 * sync will not re-read them (their AlterID did not change). This reads them once more from Tally, by explicit AlterID,
 * and sets ONLY: inventory[].discountPercentage, inventory[].discountAmount and inventory[].gst. It never changes an amount,
 * quantity, rate, header, ledger, status or AlterID. See src/services/sync/voucherLineBackfill.js for every safety rule.
 *
 * USAGE
 *   node backfill-voucher-line-details.js --tenant <tenantId> --type Sales|Purchase [options]
 *
 *   --apply                 actually write (the default is a DRY RUN that reads Tally and MongoDB and writes nothing)
 *   --confirm-host <host>   required with --apply when the database is not local; must equal the host this script prints
 *   --after-alter-id N      resume after this AlterID (each run prints the next one)
 *   --batch-size N          AlterIDs per Tally request (default 100, max 200)
 *   --max-batches N         requests per run (default 5, max 50): a run is bounded on purpose
 *   --from YYYY-MM-DD --to YYYY-MM-DD   optional voucher-date window
 *
 * Tally must be running with this tenant's company open. Run a dry run first and read its numbers.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Company = require("./src/models/company.js");
const { backfillVoucherLineDetails, checkWriteTarget } = require("./src/services/sync/voucherLineBackfill");

function parseArgs(argv) {
  const args = { tenant: null, type: null, apply: false, confirmHost: null, afterAlterId: 0, batchSize: undefined, maxBatches: undefined, from: null, to: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--tenant") args.tenant = next();
    else if (a === "--type") args.type = next();
    else if (a === "--apply") args.apply = true;
    else if (a === "--confirm-host") args.confirmHost = next();
    else if (a === "--after-alter-id") args.afterAlterId = Number(next());
    else if (a === "--batch-size") args.batchSize = Number(next());
    else if (a === "--max-batches") args.maxBatches = Number(next());
    else if (a === "--from") args.from = next();
    else if (a === "--to") args.to = next();
    else { console.error(`Unknown argument: ${a}`); process.exit(1); }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenant || !["Sales", "Purchase"].includes(args.type)) {
    console.error("Usage: node backfill-voucher-line-details.js --tenant <tenantId> --type Sales|Purchase [--apply --confirm-host <host>] [--after-alter-id N] [--batch-size N] [--max-batches N] [--from YYYY-MM-DD --to YYYY-MM-DD]");
    process.exit(1);
  }

  // Say which database this is BEFORE connecting, and refuse a non-local write that was not confirmed.
  const target = checkWriteTarget({ uri: process.env.MONGODB_URI, apply: args.apply, confirmHost: args.confirmHost });
  console.log(`Mode: ${target.mode.toUpperCase()} | MongoDB host: ${target.host || "(unknown)"} (${target.loopback ? "local" : "NOT local"}) | tenant: ${args.tenant} | type: ${args.type}`);
  if (!target.ok) {
    console.error(`REFUSED: ${target.reason}`);
    process.exit(2);
  }

  await connectDB();
  const company = await Company.findOne({ tenantId: args.tenant }).lean();
  if (!company) {
    console.error(`No Company found for tenantId "${args.tenant}".`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Company: ${company.companyName}`);

  const result = await backfillVoucherLineDetails({
    company,
    voucherType: args.type,
    apply: args.apply,
    afterAlterId: args.afterAlterId,
    batchSize: args.batchSize,
    maxBatches: args.maxBatches,
    from: args.from || undefined,
    to: args.to || undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "dry_run") console.log("\nDRY RUN: nothing was written. Re-run with --apply (and --confirm-host if the database is not local) to write.");
  if (result.remainingCandidates > 0) console.log(`\n${result.remainingCandidates} more voucher(s) need this. Continue with: --after-alter-id ${result.nextAfterAlterId}`);

  await mongoose.disconnect();
  process.exit(["completed", "dry_run"].includes(result.status) ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
