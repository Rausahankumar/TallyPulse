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
// unclassified:     no inventory lines at all (a pure ledger adjustment), or a
//                   cancelled/deleted voucher (set at store time and when a
//                   note is cancelled) - still queryable, but never counted as
//                   any return.
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

/**
 * A note is classified when it is STORED, from the Ledger master's account roles. Notes stored while the Ledger master was empty (or
 * before a ledger existed in it) all became "value_adjustment", so returns read zero. Once the master has the roles, this re-reads the
 * stored lines (accountingAllocationLedger) and UPGRADES those notes with the same rule as classifyAdjustmentNote. No Tally call.
 *
 * Upgrade only, on purpose: "value_adjustment" -> "sales_return" / "purchase_return". A stored return is never downgraded (a ledger
 * deleted from Tally later must not rewrite history), "unclassified" notes (no inventory lines) are never touched, and the write
 * is conditional on the note still being a value_adjustment, so it cannot overwrite a concurrent change.
 *
 * @param {{tenantId: string, apply?: boolean, batchSize?: number}} p  apply=false only counts (dry run)
 * @returns {Promise<{ok: boolean, scanned: number, upgrades: number, applied: boolean, byTransition: Object, reason?: string}>}
 */
async function reclassifyAdjustmentNotes({ tenantId, apply = false, batchSize = 500 } = {}) {
  if (typeof tenantId !== "string" || !tenantId.trim()) {
    return { ok: false, scanned: 0, upgrades: 0, applied: false, byTransition: {}, reason: "No tenantId supplied." };
  }
  const AdjustmentNote = require("../../models/adjustmentNote.model");
  const out = { ok: true, scanned: 0, upgrades: 0, applied: Boolean(apply), byTransition: {} };

  let afterId = null;
  for (;;) {
    // Only active vouchers: cancelled/deleted notes are never counted as returns (analytics and the query engine count active only).
    const filter = { tenantId, voucherStatus: "active", classification: "value_adjustment", "inventory.0": { $exists: true } };
    if (afterId) filter._id = { $gt: afterId };
    const page = await AdjustmentNote.find(filter, { noteType: 1, "inventory.accountingAllocationLedger": 1 }).sort({ _id: 1 }).limit(batchSize).lean();
    if (!page.length) break;
    afterId = page[page.length - 1]._id;
    out.scanned += page.length;

    const roles = await resolveAccountRoles(tenantId, page.flatMap((n) => (n.inventory || []).map((l) => l.accountingAllocationLedger)));
    const ops = [];
    for (const note of page) {
      const computed = classifyAdjustmentNote({ inventory: note.inventory || [] }, note.noteType, roles);
      if (computed !== "sales_return" && computed !== "purchase_return") continue;
      out.upgrades += 1;
      const key = `value_adjustment->${computed}`;
      out.byTransition[key] = (out.byTransition[key] || 0) + 1;
      ops.push({ updateOne: { filter: { _id: note._id, tenantId, classification: "value_adjustment" }, update: { $set: { classification: computed } } } });
    }
    if (apply && ops.length) await AdjustmentNote.bulkWrite(ops, { ordered: false });
    if (page.length < batchSize) break;
  }
  return out;
}

module.exports = { classifyAdjustmentNote, resolveAccountRoles, reclassifyAdjustmentNotes, NOTE_ROLE, NOTE_CLASSIFICATION };
