const LedgerMaster = require("../../models/ledgerMaster.model");

// --------------------------------------------------
// Deterministic Credit/Debit Note classification, per the CN/DN diagnostic
// (docs/../generic-tumbling-magpie.md sections 2-3): the voucher type name
// alone is NEVER the classifier, and the party's ledger group is NEVER
// required (a debtor can receive a Debit Note - confirmed live).
//
// sales_return:    noteType "credit" AND every inventory line has ONE
//                   resolvable accounting-allocation ledger, and EVERY one
//                   of those ledgers' account role (LedgerMaster.accountRole,
//                   derived from the reserved "Sales Accounts" group chain)
//                   is "sales_accounts".
// purchase_return:  same, for noteType "debit" and "purchase_accounts".
// value_adjustment: anything else with readable inventory (no evidence, or
//                   mixed/contradicting evidence) - the safe default, never
//                   a guessed return.
// unclassified:     no inventory lines at all (a pure ledger adjustment) -
//                   still queryable, but never counted as any return.
// --------------------------------------------------

const NOTE_ROLE = { credit: "sales_accounts", debit: "purchase_accounts" };
const NOTE_CLASSIFICATION = { credit: "sales_return", debit: "purchase_return" };

/**
 * @param {Object} parsedVoucher - from adjustmentNoteParser.parseAdjustmentNoteVoucher
 * @param {"credit"|"debit"} noteType
 * @param {Map<string,string>} accountRoleByLedgerName - THIS tenant's LedgerMaster
 *   name -> accountRole, pre-resolved by the caller (one bounded query per
 *   voucher's distinct ledger names - see resolveAccountRoles below).
 * @returns {"sales_return"|"purchase_return"|"value_adjustment"|"unclassified"}
 */
function classifyAdjustmentNote(parsedVoucher, noteType, accountRoleByLedgerName) {
  const inventory = (parsedVoucher && parsedVoucher.inventory) || [];
  if (inventory.length === 0) return "unclassified";

  const wantRole = NOTE_ROLE[noteType];
  if (!wantRole) return "value_adjustment";

  const everyLineMatches = inventory.every((line) => {
    if (!line.accountingAllocationLedger) return false; // no single resolvable ledger - no evidence
    const role = accountRoleByLedgerName.get(line.accountingAllocationLedger);
    return role === wantRole;
  });

  return everyLineMatches ? NOTE_CLASSIFICATION[noteType] : "value_adjustment";
}

// One bounded, tenant-scoped, indexed lookup ({tenantId, name} index) per
// distinct ledger name a batch of notes actually references - never a full
// LedgerMaster scan, and never a Tally call (LedgerMaster is sync-time
// data). Ambiguous (same-name) ledgers resolve to "other" (never guessed),
// same fail-closed posture as ledgerMaster.js's own new-party resolution.
async function resolveAccountRoles(tenantId, ledgerNames) {
  const names = [...new Set(ledgerNames.filter(Boolean))];
  const map = new Map();
  if (!names.length) return map;

  const docs = await LedgerMaster.find({ tenantId, removedAt: null, name: { $in: names } }, { name: 1, accountRole: 1, _id: 0 }).lean();
  const seen = new Map();
  for (const d of docs) {
    if (seen.has(d.name)) {
      seen.set(d.name, "ambiguous");
    } else {
      seen.set(d.name, d.accountRole || "other");
    }
  }
  for (const name of names) {
    const role = seen.get(name);
    map.set(name, role === "ambiguous" ? "other" : role || "other");
  }
  return map;
}

module.exports = { classifyAdjustmentNote, resolveAccountRoles, NOTE_ROLE, NOTE_CLASSIFICATION };
