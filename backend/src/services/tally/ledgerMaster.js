const { getLedgerMasters, getGroupMasters } = require("../odbc/odbcService");
const { validateMasterOwnership } = require("./companyOwnership");
const { parseTallyDate } = require("../parser/tallyParser");
const LedgerMaster = require("../../models/ledgerMaster.model");

// --------------------------------------------------
// Tally Ledger master layer (mirrors stockItemMaster.js).
//
// Explicit/on-demand only (refresh-ledger-master.js) - no scheduled worker,
// and the incremental voucher sync is untouched. Every refresh is a FULL
// read (1,979 ledgers took 0.46 s live): Tally's incremental $AlterID
// filter cannot see deletions, so a full list is the only way to know a
// ledger is gone. Writes are skipped when the list is unchanged.
//
// Fails closed: any fetch/parse/ownership problem, or a refresh that would
// remove more than half the stored ledgers, leaves the stored master
// exactly as it was.
// --------------------------------------------------

const SUNDRY_DEBTORS = "sundry debtors";
const SUNDRY_CREDITORS = "sundry creditors";
const SALES_ACCOUNTS = "sales accounts";
const PURCHASE_ACCOUNTS = "purchase accounts";
const MAX_GROUP_DEPTH = 64;
const MAX_REMOVAL_RATIO = 0.5;

const unwrap = (v) => (v && typeof v === "object" && !Array.isArray(v) && "value" in v ? v.value : v);
const text = (v) => {
  const u = unwrap(v);
  return u === undefined || u === null ? "" : String(u).trim();
};
const num = (v) => {
  const t = text(v);
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

function collectionOf(raw) {
  const c = raw && raw.data && raw.data.collection;
  return Array.isArray(c) ? c : [];
}

// [{name, parent, reservedName, guid}] - every group, as Tally returned it.
function parseGroupMasterList(raw) {
  return collectionOf(raw)
    .map((e) => {
      const meta = (e && e.metadata) || {};
      return { name: text(meta.name), parent: text(e && e.parent), reservedName: text(meta.reservedname), guid: text(e && e.guid) };
    })
    .filter((g) => g.name);
}

// [{name, parent, guid, alterId, masterId, createdDate}] - every ledger with a name.
function parseLedgerMasterList(raw) {
  return collectionOf(raw)
    .map((e) => {
      const meta = (e && e.metadata) || {};
      return {
        name: text(meta.name),
        parent: text(e && e.parent),
        guid: text(e && e.guid),
        alterId: num(e && e.alterid),
        masterId: num(e && e.masterid),
        createdDate: parseTallyDate(e && e.createddate) || null,
      };
    })
    .filter((l) => l.name);
}

// Walks the group chain up to a group Tally itself reserves under one of
// `reservedRoleMap`'s keys. Renamed or nested sub-groups resolve through the
// chain; a broken or cyclic chain (or one that never reaches a reserved
// group in the map) is "other", never a guess.
function deriveRole(parentGroup, groupsByName, reservedRoleMap) {
  let name = parentGroup;
  const seen = new Set();
  for (let depth = 0; name && depth < MAX_GROUP_DEPTH; depth += 1) {
    if (seen.has(name)) return "other";
    seen.add(name);
    const g = groupsByName.get(name);
    if (!g) return "other";
    const role = reservedRoleMap.get(g.reservedName.toLowerCase());
    if (role) return role;
    name = g.parent;
  }
  return "other";
}

const PARTY_ROLE_MAP = new Map([[SUNDRY_DEBTORS, "debtor"], [SUNDRY_CREDITORS, "creditor"]]);
// Used by adjustmentNoteClassifier.js: the group an inventory line's
// accounting-allocation ledger belongs to (never the party's group -
// see the CN/DN diagnostic: a debtor can receive a Debit Note).
const ACCOUNT_ROLE_MAP = new Map([[SALES_ACCOUNTS, "sales_accounts"], [PURCHASE_ACCOUNTS, "purchase_accounts"]]);

function derivePartyRole(parentGroup, groupsByName) {
  return deriveRole(parentGroup, groupsByName, PARTY_ROLE_MAP);
}

function deriveAccountRole(parentGroup, groupsByName) {
  return deriveRole(parentGroup, groupsByName, ACCOUNT_ROLE_MAP);
}

function buildFailureResult(reason) {
  return { ok: false, written: 0, removed: 0, totalFetched: 0, reason, resolvedAt: new Date() };
}

function parsePayload(raw, label) {
  try {
    return { ok: true, value: typeof raw === "string" ? JSON.parse(raw) : raw };
  } catch (error) {
    return { ok: false, reason: `${label} master response was not valid JSON: ${error.message}` };
  }
}

/**
 * Fetch this tenant's Ledger (and Group) masters from Tally, verify company
 * ownership of BOTH lists, and only then upsert into LedgerMaster.
 *
 * @param {Object} params
 * @param {string} params.tenantId - the app's own tenant id (never from Tally).
 * @param {string} params.companyGuid - trusted, from the Company record.
 * @param {string} [params.baseUrl] - this company's Tally connection URL.
 * @param {boolean} [params.force] - rewrite even when the list looks unchanged.
 * @param {Function} [params.fetchLedgers] / [params.fetchGroups] - default to
 *   live Tally; injectable so tests run the full flow on synthetic data.
 */
async function refreshLedgerMasters({ tenantId, companyGuid, baseUrl, force = false, fetchLedgers = getLedgerMasters, fetchGroups = getGroupMasters } = {}) {
  if (typeof tenantId !== "string" || !tenantId.trim()) {
    return buildFailureResult("No tenantId supplied - refusing to write company-less Ledger data.");
  }
  if (typeof companyGuid !== "string" || !companyGuid.trim()) {
    return buildFailureResult("No trusted companyGuid supplied - refusing to accept unverifiable Tally data.");
  }

  // One Tally request at a time (the gateway hangs under concurrent load).
  let rawGroups;
  let rawLedgers;
  try {
    rawGroups = await fetchGroups({ baseUrl });
    rawLedgers = await fetchLedgers({ baseUrl });
  } catch (error) {
    return buildFailureResult(`Could not fetch Ledger/Group masters from Tally: ${error.message || error}`);
  }

  const pg = parsePayload(rawGroups, "Group");
  if (!pg.ok) return buildFailureResult(pg.reason);
  const pl = parsePayload(rawLedgers, "Ledger");
  if (!pl.ok) return buildFailureResult(pl.reason);

  const groups = parseGroupMasterList(pg.value);
  const ledgersRaw = parseLedgerMasterList(pl.value);
  if (ledgersRaw.length === 0) return buildFailureResult("Tally returned zero Ledgers - nothing to refresh.");
  if (groups.length === 0) return buildFailureResult("Tally returned zero Groups - party roles cannot be derived.");

  // Ownership over the FULL raw lists, before any filtering, so a foreign
  // response is rejected on its own GUIDs.
  for (const [label, list] of [["Group", groups], ["Ledger", ledgersRaw]]) {
    const ownership = validateMasterOwnership(list, companyGuid);
    if (!ownership.ok) {
      console.warn(
        `[ledgerMaster] REJECTED ${label} masters tenant=${tenantId} company=${String(companyGuid).slice(0, 8)}... total=${ownership.total} foreign=${ownership.foreign} verified=${ownership.verified} sample=[${ownership.sample.join(",")}]`
      );
      return buildFailureResult(ownership.reason);
    }
  }

  const ledgers = ledgersRaw.filter((l) => l.guid);
  const unusable = ledgersRaw.length - ledgers.length;
  const groupsByName = new Map(groups.map((g) => [g.name, g]));
  const maxAlterId = ledgers.reduce((m, l) => (l.alterId !== null && l.alterId > m ? l.alterId : m), 0);
  const undated = ledgers.filter((l) => !l.createdDate).length;

  const stored = await LedgerMaster.find({ tenantId, removedAt: null }, { ledgerGuid: 1, alterId: 1, _id: 0 }).lean();
  const storedMaxAlterId = stored.reduce((m, d) => (typeof d.alterId === "number" && d.alterId > m ? d.alterId : m), 0);
  const fetchedGuids = new Set(ledgers.map((l) => l.guid));
  const toRemove = stored.filter((d) => !fetchedGuids.has(d.ledgerGuid)).length;

  const base = { totalFetched: ledgersRaw.length, usable: ledgers.length, unusable, undated, maxAlterId };

  if (!force && stored.length === ledgers.length && storedMaxAlterId === maxAlterId && toRemove === 0) {
    return { ok: true, unchanged: true, written: 0, removed: 0, ...base, resolvedAt: new Date() };
  }
  if (stored.length > 0 && toRemove / stored.length > MAX_REMOVAL_RATIO) {
    return buildFailureResult(`Refusing refresh: ${toRemove} of ${stored.length} stored ledgers are missing from Tally's list (more than ${MAX_REMOVAL_RATIO * 100}%).`);
  }

  const now = new Date();
  const ops = ledgers.map((l) => ({
    updateOne: {
      filter: { tenantId, companyGuid, ledgerGuid: l.guid },
      update: {
        $set: {
          tenantId,
          companyGuid,
          ledgerGuid: l.guid,
          name: l.name,
          parentGroup: l.parent || null,
          partyRole: derivePartyRole(l.parent, groupsByName),
          accountRole: deriveAccountRole(l.parent, groupsByName),
          alterId: l.alterId,
          masterId: l.masterId,
          createdDate: l.createdDate,
          syncedAt: now,
          removedAt: null,
        },
      },
      upsert: true,
    },
  }));
  const result = await LedgerMaster.bulkWrite(ops, { ordered: false });

  let removed = 0;
  if (toRemove > 0) {
    const r = await LedgerMaster.updateMany({ tenantId, removedAt: null, ledgerGuid: { $nin: [...fetchedGuids] } }, { $set: { removedAt: now } });
    removed = r.modifiedCount || 0;
  }

  return {
    ok: true,
    unchanged: false,
    written: (result.upsertedCount || 0) + (result.modifiedCount || 0),
    removed,
    ...base,
    resolvedAt: now,
  };
}

module.exports = {
  parseGroupMasterList,
  parseLedgerMasterList,
  derivePartyRole,
  deriveAccountRole,
  refreshLedgerMasters,
  MAX_REMOVAL_RATIO,
};
