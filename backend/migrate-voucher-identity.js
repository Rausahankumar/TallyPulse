/**
 * Voucher identity migration: tenantId + voucherNo  ->  tenantId + tallyGuid
 *
 * WHY
 * ---
 * Tally voucher numbers are a manual/business field, not a stable
 * identity. Two distinct voucher masters (different GUID, different
 * AlterID) can legitimately carry the same VoucherNumber - confirmed
 * empirically against a real TallyPrime instance (see PURCHASE_SYNC
 * notes / conversation history). Worse: this company's numbering
 * series is shared ACROSS voucher types (a real Purchase voucher in
 * this database is numbered "SA/54/2025-26" - a Sales-looking number),
 * so voucherNo isn't even reliably scoped to one voucher type.
 *
 * The old unique index {tenantId, header.voucherNo} let a second,
 * unrelated voucher silently overwrite a first one that happened to
 * share a number. The correct identity is {tenantId, tallyGuid} -
 * Tally's own stable per-voucher-master identifier. voucherNo remains
 * a plain (non-unique) business/display field.
 *
 * SAFETY MODEL
 * ------------
 * This script NEVER deletes or merges documents, and never drops or
 * creates an index without an explicit conflict check first.
 *
 * Modes:
 *   node migrate-voucher-identity.js            -> report only (dry run)
 *   node migrate-voucher-identity.js --apply     -> apply, but ONLY if
 *                                                    the report found
 *                                                    zero blocking
 *                                                    conflicts
 *
 * What "apply" actually changes, per collection (sales, purchases):
 *   1. Adds a new index: { tenantId: 1, tallyGuid: 1 }, unique,
 *      partialFilterExpression: { tallyGuid: { $exists: true, $ne: null } }
 *      (partial so legacy documents with no tallyGuid never collide on
 *      a shared "null" identity)
 *   2. Drops the old unique index tenantId_1_header.voucherNo_1
 *   3. Recreates it as a PLAIN (non-unique) index on the same keys, so
 *      voucherNo lookups/display stay fast, but voucherNo no longer
 *      enforces identity.
 *
 * If any blocking conflict is found (see below), the script reports it
 * and refuses to touch indexes, in either mode.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const VOUCHER_NO_INDEX_NAME = "tenantId_1_header.voucherNo_1";
const GUID_INDEX_NAME = "tenantId_1_tallyGuid_1";

const COLLECTIONS = ["sales", "purchases"];

async function auditCollection(db, collName) {
  const coll = db.collection(collName);

  const total = await coll.countDocuments({});
  const withGuid = await coll.countDocuments({
    tallyGuid: { $exists: true, $ne: null },
  });
  const withoutGuid = total - withGuid;

  // Blocking conflict: two+ documents that already share {tenantId,
  // tallyGuid}. Creating the new unique index would fail (or worse,
  // silently pick a survivor) if this exists. Should never happen given
  // the old code already deduped on tallyGuid within the upsert, but
  // checked explicitly rather than assumed.
  const duplicateGuidGroups = await coll
    .aggregate([
      { $match: { tallyGuid: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: { tenantId: "$tenantId", tallyGuid: "$tallyGuid" },
          count: { $sum: 1 },
          ids: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  // Informational (NOT blocking): documents sharing {tenantId,
  // voucherNo} across different tallyGuids. This is exactly the
  // scenario this migration exists to stop treating as "the same
  // voucher" going forward. Under the OLD identity, only the most
  // recently-synced one would have survived in this collection - so
  // this count is expected to be low/zero looking backward (the
  // collision already silently happened before this migration ran),
  // but it's still worth surfacing.
  const sameNumberDifferentGuid = await coll
    .aggregate([
      { $match: { tallyGuid: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: { tenantId: "$tenantId", voucherNo: "$header.voucherNo" },
          guids: { $addToSet: "$tallyGuid" },
          count: { $sum: 1 },
        },
      },
      { $match: { $expr: { $gt: [{ $size: "$guids" }, 1] } } },
    ])
    .toArray();

  const existingIndexes = await coll.indexes();

  return {
    collName,
    total,
    withGuid,
    withoutGuid,
    duplicateGuidGroups,
    sameNumberDifferentGuid,
    existingIndexes,
  };
}

function printReport(report) {
  console.log(`\n=== ${report.collName} ===`);
  console.log(`  total documents:            ${report.total}`);
  console.log(`  with tallyGuid:             ${report.withGuid}`);
  console.log(`  without tallyGuid (legacy): ${report.withoutGuid}`);
  console.log(
    `  BLOCKING duplicate {tenantId, tallyGuid} groups: ${report.duplicateGuidGroups.length}`
  );

  if (report.duplicateGuidGroups.length > 0) {
    report.duplicateGuidGroups.forEach((g) => {
      console.log(
        `    - tenantId=${g._id.tenantId} tallyGuid=${g._id.tallyGuid} count=${g.count} ids=[${g.ids.join(", ")}]`
      );
    });
  }

  console.log(
    `  informational: {tenantId, voucherNo} pairs seen under >1 distinct tallyGuid historically: ${report.sameNumberDifferentGuid.length}`
  );
  if (report.sameNumberDifferentGuid.length > 0) {
    report.sameNumberDifferentGuid.forEach((g) => {
      console.log(
        `    - tenantId=${g._id.tenantId} voucherNo=${g._id.voucherNo} distinctGuids=${g.guids.length}`
      );
    });
  }

  if (report.withoutGuid > 0) {
    console.log(
      `  NOTE: ${report.withoutGuid} document(s) have no tallyGuid (e.g. imported from a manual file upload with no AlterID/GUID in the source JSON). These remain identified by {tenantId, voucherNo} only - a known, documented limitation, not something this migration can resolve without better source data.`
    );
  }

  console.log(
    `  current indexes: ${report.existingIndexes.map((i) => i.name).join(", ")}`
  );
}

async function applyIndexChanges(db, collName) {
  const coll = db.collection(collName);

  console.log(`\n--- Applying index changes: ${collName} ---`);

  // 1. New identity index (partial - never applies to guid-less docs)
  const indexes = await coll.indexes();
  const hasGuidIndex = indexes.some((i) => i.name === GUID_INDEX_NAME);

  if (hasGuidIndex) {
    console.log(`  [skip] ${GUID_INDEX_NAME} already exists`);
  } else {
    await coll.createIndex(
      { tenantId: 1, tallyGuid: 1 },
      {
        name: GUID_INDEX_NAME,
        unique: true,
        // MongoDB partial index filters only support a limited operator
        // set - $ne/$not are NOT allowed. tallyGuid defaults to literal
        // null (not "absent") in the schema, so $exists:true would
        // match every document including guid-less ones. $type:"string"
        // is the supported way to mean "has a real string value".
        partialFilterExpression: {
          tallyGuid: { $type: "string" },
        },
      }
    );
    console.log(`  [created] ${GUID_INDEX_NAME} (unique, partial)`);
  }

  // 2. Replace the old unique voucherNo index with a plain one. Drop
  // then recreate rather than trying to alter in place - Mongo has no
  // "change index options" operation.
  const stillHasOldUnique = (await coll.indexes()).find(
    (i) => i.name === VOUCHER_NO_INDEX_NAME && i.unique
  );

  if (stillHasOldUnique) {
    await coll.dropIndex(VOUCHER_NO_INDEX_NAME);
    console.log(`  [dropped] old unique ${VOUCHER_NO_INDEX_NAME}`);
    await coll.createIndex(
      { tenantId: 1, "header.voucherNo": 1 },
      { name: VOUCHER_NO_INDEX_NAME }
    );
    console.log(`  [created] ${VOUCHER_NO_INDEX_NAME} (non-unique)`);
  } else {
    console.log(
      `  [skip] ${VOUCHER_NO_INDEX_NAME} already non-unique or absent`
    );
  }
}

async function main() {
  const apply = process.argv.includes("--apply");

  await connectDB();
  const db = mongoose.connection.db;

  console.log(
    `\nVoucher identity migration - mode: ${apply ? "APPLY" : "DRY RUN (report only)"}`
  );

  const reports = [];
  for (const collName of COLLECTIONS) {
    const report = await auditCollection(db, collName);
    printReport(report);
    reports.push(report);
  }

  const anyBlocking = reports.some((r) => r.duplicateGuidGroups.length > 0);

  console.log("\n=== SUMMARY ===");
  if (anyBlocking) {
    console.log(
      "BLOCKED: one or more collections have duplicate {tenantId, tallyGuid} groups. " +
        "Resolve these manually (they indicate a real prior data problem) before re-running. " +
        "No indexes were changed."
    );
    await mongoose.connection.close();
    process.exitCode = 1;
    return;
  }

  console.log("No blocking conflicts found.");

  if (!apply) {
    console.log(
      "Dry run only - no changes made. Re-run with --apply to create the new index and relax the old one."
    );
    await mongoose.connection.close();
    return;
  }

  for (const collName of COLLECTIONS) {
    await applyIndexChanges(db, collName);
  }

  console.log("\nMigration applied successfully. No documents were modified, deleted, or merged - only indexes changed.");
  await mongoose.connection.close();
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exitCode = 1;
});
