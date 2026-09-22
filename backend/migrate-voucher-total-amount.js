/**
 * header.voucherTotalAmount backfill: inventory-subtotal -> party-ledger total
 *
 * WHY
 * ---
 * tallyParser.js previously derived header.voucherTotalAmount from the
 * pre-tax inventory subtotal whenever a voucher had inventory, silently
 * excluding GST/freight/rounding. Fixed in tallyParser.js
 * (computePartyLedgerTotal) for vouchers synced FROM NOW ON. This script
 * corrects documents that were already stored under the old, wrong
 * formula - see the financial-data-correctness audit for the full
 * investigation and evidence.
 *
 * SOURCE OF TRUTH
 * ----------------
 * Every affected document already stores its own complete `ledgers`
 * array. Nothing is re-fetched from Tally; the correct total is
 * recomputed from data already sitting in that same document, using the
 * EXACT SAME function tallyParser.js now uses going forward
 * (computePartyLedgerTotal, required from tallyParser.js - one
 * definition, no drift between the parser and this backfill).
 *
 * SAFETY MODEL
 * ------------
 * - DRY RUN BY DEFAULT. No write happens unless --write is passed.
 * - --tenant <tenantId> is REQUIRED. There is no "all tenants" mode -
 *   an operator must explicitly choose one tenant per run.
 * - --collection sales|purchases is REQUIRED (repeatable, e.g.
 *   --collection sales --collection purchases, or comma-separated
 *   --collection sales,purchases). There is no default "both".
 * - Refuses to write (even with --write) if the party-ledger match rate
 *   for this run is unexpectedly below MIN_MATCH_RATE - a sign something
 *   about this tenant's data doesn't match the validated baseline, worth
 *   investigating before touching anything.
 * - Only ever updates header.voucherTotalAmount via a targeted $set per
 *   document (bulkWrite). Never touches tallyGuid, tallyAlterId,
 *   voucherStatus, tenantId, inventory, ledgers, or any other field.
 * - Idempotent: recomputing an already-correct document is a no-op
 *   (reported separately as "already correct", never re-written).
 * - --export <path> writes a JSON list of {_id, tallyGuid, voucherNo,
 *   tenantId, oldAmount} for every AFFECTED document before any write,
 *   so the previous values can be reconstructed if ever needed. This is
 *   a recovery REFERENCE, not automatic rollback.
 * - Never touches SyncCheckpoint, never contacts Tally, never triggers
 *   the sync worker/reconciliation/self-heal.
 *
 * USAGE
 * -----
 *   node migrate-voucher-total-amount.js --tenant <id> --collection sales [--collection purchases] [--export path.json] [--write]
 *
 * Omit --write for a dry run (the default and recommended first step).
 */

require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const { computePartyLedgerTotal } = require("./src/services/parser/tallyParser");

const EPS = 0.005; // matches the audit's rounding tolerance
const MIN_MATCH_RATE = 0.99; // refuse to write if below this - see file header

const MODELS = { sales: Sale, purchases: Purchase };

function parseArgs(argv) {
  const args = { tenant: null, collections: [], write: false, export: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tenant") {
      args.tenant = argv[i + 1];
      i += 1;
    } else if (arg === "--collection") {
      const value = argv[i + 1];
      i += 1;
      if (value) args.collections.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (arg === "--write") {
      args.write = true;
    } else if (arg === "--export") {
      args.export = argv[i + 1];
      i += 1;
    }
  }

  return args;
}

function validateArgs(args) {
  const errors = [];

  if (!args.tenant || typeof args.tenant !== "string" || !args.tenant.trim()) {
    errors.push('--tenant <tenantId> is required. This script never runs against "all tenants".');
  }

  if (args.collections.length === 0) {
    errors.push('--collection <sales|purchases> is required (repeatable). There is no default.');
  }

  const invalidCollections = args.collections.filter((c) => !(c in MODELS));
  if (invalidCollections.length > 0) {
    errors.push(`Unknown --collection value(s): ${invalidCollections.join(", ")}. Valid: sales, purchases.`);
  }

  return errors;
}

async function analyzeCollection(Model, collectionLabel, tenantId) {
  const docs = await Model.find({ tenantId }).lean();

  const report = {
    collection: collectionLabel,
    tenantId,
    scanned: docs.length,
    alreadyCorrect: 0,
    requiringCorrection: 0,
    partyLedgerNotFound: 0,
    totalOldAmount: 0,
    totalNewAmount: 0,
    affected: [], // {_id, tallyGuid, voucherNo, oldAmount, newAmount, diff}
    notFoundSamples: [], // {_id, tallyGuid, voucherNo, partyName}
  };

  for (const doc of docs) {
    const oldAmount = doc.header.voucherTotalAmount;
    const newAmount = computePartyLedgerTotal(doc.ledgers, doc.header.partyName);

    report.totalOldAmount += oldAmount;

    if (newAmount === null) {
      report.partyLedgerNotFound += 1;
      // Old value carried forward unchanged for the not-found case - this
      // script never guesses a total for a voucher it can't validate.
      report.totalNewAmount += oldAmount;
      if (report.notFoundSamples.length < 20) {
        report.notFoundSamples.push({
          _id: String(doc._id), tallyGuid: doc.tallyGuid, voucherNo: doc.header.voucherNo, partyName: doc.header.partyName,
        });
      }
      continue;
    }

    report.totalNewAmount += newAmount;

    if (Math.abs(newAmount - oldAmount) <= EPS) {
      report.alreadyCorrect += 1;
      continue;
    }

    report.requiringCorrection += 1;
    report.affected.push({
      _id: String(doc._id),
      tallyGuid: doc.tallyGuid,
      voucherNo: doc.header.voucherNo,
      tenantId: doc.tenantId,
      oldAmount,
      newAmount,
      difference: Math.round((newAmount - oldAmount) * 100) / 100,
    });
  }

  report.totalOldAmount = Math.round(report.totalOldAmount * 100) / 100;
  report.totalNewAmount = Math.round(report.totalNewAmount * 100) / 100;
  report.totalDifference = Math.round((report.totalNewAmount - report.totalOldAmount) * 100) / 100;
  report.matchRate = report.scanned > 0 ? (report.scanned - report.partyLedgerNotFound) / report.scanned : 1;

  return report;
}

function printReport(report) {
  console.log(`\n=== ${report.collection} / tenant ${report.tenantId} ===`);
  console.log(`  documents scanned:            ${report.scanned}`);
  console.log(`  requiring correction:         ${report.requiringCorrection}`);
  console.log(`  already correct:              ${report.alreadyCorrect}`);
  console.log(`  party ledger not found:       ${report.partyLedgerNotFound}`);
  console.log(`  match rate:                   ${(report.matchRate * 100).toFixed(2)}%`);
  console.log(`  total old amount:             ${report.totalOldAmount}`);
  console.log(`  total new amount:             ${report.totalNewAmount}`);
  console.log(`  total difference:             ${report.totalDifference}`);

  if (report.partyLedgerNotFound > 0) {
    console.log(`\n  !! PARTY LEDGER NOT FOUND (${report.partyLedgerNotFound}) - left unchanged, sample:`);
    for (const s of report.notFoundSamples) {
      console.log(`     _id=${s._id} tallyGuid=${s.tallyGuid} voucherNo=${s.voucherNo} partyName="${s.partyName}"`);
    }
  }

  if (report.affected.length > 0) {
    console.log(`\n  affected documents (${report.affected.length}):`);
    for (const a of report.affected) {
      console.log(`     _id=${a._id} tallyGuid=${a.tallyGuid} voucherNo=${a.voucherNo} old=${a.oldAmount} new=${a.newAmount} diff=${a.difference}`);
    }
  }
}

async function writeCorrections(Model, report) {
  if (report.affected.length === 0) return { modified: 0 };

  const ops = report.affected.map((a) => ({
    updateOne: {
      filter: { _id: a._id },
      // Only this one field is ever touched - never tallyGuid,
      // tallyAlterId, voucherStatus, tenantId, inventory, or ledgers.
      update: { $set: { "header.voucherTotalAmount": a.newAmount } },
    },
  }));

  const result = await Model.bulkWrite(ops, { ordered: false });
  return { modified: result.modifiedCount };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = validateArgs(args);

  if (errors.length > 0) {
    console.error("Invalid arguments:");
    for (const e of errors) console.error(`  - ${e}`);
    console.error("\nUsage: node migrate-voucher-total-amount.js --tenant <id> --collection sales [--collection purchases] [--export path.json] [--write]");
    process.exit(1);
  }

  await connectDB();

  console.log(`Mode: ${args.write ? "WRITE" : "DRY RUN (no writes - pass --write to apply)"}`);
  console.log(`Tenant: ${args.tenant}`);
  console.log(`Collections: ${args.collections.join(", ")}`);

  const reports = [];

  for (const collectionLabel of args.collections) {
    const Model = MODELS[collectionLabel];
    const report = await analyzeCollection(Model, collectionLabel, args.tenant);
    reports.push({ collectionLabel, Model, report });
    printReport(report);
  }

  const exportRows = reports.flatMap(({ collectionLabel, report }) =>
    report.affected.map((a) => ({ collection: collectionLabel, ...a }))
  );

  if (args.export) {
    fs.writeFileSync(args.export, JSON.stringify(exportRows, null, 2));
    console.log(`\nExported ${exportRows.length} affected-document records (recovery reference) to ${args.export}`);
  }

  const totalAffected = reports.reduce((s, r) => s + r.report.requiringCorrection, 0);
  const totalScanned = reports.reduce((s, r) => s + r.report.scanned, 0);
  const worstMatchRate = reports.length > 0 ? Math.min(...reports.map((r) => r.report.matchRate)) : 1;

  console.log(`\n=== TOTAL: ${totalAffected} of ${totalScanned} documents require correction across ${reports.length} collection(s) ===`);

  if (!args.write) {
    console.log("\nDRY RUN COMPLETE. No documents were modified. Re-run with --write to apply.");
    await mongoose.disconnect();
    process.exit(0);
  }

  if (worstMatchRate < MIN_MATCH_RATE) {
    console.error(
      `\nREFUSING TO WRITE: party-ledger match rate ${(worstMatchRate * 100).toFixed(2)}% is below the required minimum ${(MIN_MATCH_RATE * 100).toFixed(2)}%. ` +
      "This tenant's data doesn't match the validated baseline (0 not-found cases across 5,929 real vouchers) - investigate the 'party ledger not found' samples above before writing."
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!args.export) {
    console.error("\nREFUSING TO WRITE: --write requires --export <path.json> too, so a recovery reference of the old values exists before anything changes.");
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("\nApplying corrections...");
  for (const { collectionLabel, Model, report } of reports) {
    const { modified } = await writeCorrections(Model, report);
    console.log(`  ${collectionLabel}: ${modified} document(s) updated`);
  }

  console.log("\nWRITE COMPLETE.");
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("MIGRATION ERROR:", err);
  process.exit(1);
});
