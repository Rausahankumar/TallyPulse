const mongoose = require("mongoose");
const Company = require("../../models/company");
const User = require("../../models/user.model");
const UserCompanyAccess = require("../../models/userCompanyAccess.model");
const SyncCheckpoint = require("../../models/syncCheckpoint.model");
const ReconciliationCheckpoint = require("../../models/reconciliationCheckpoint.model");

// --------------------------------------------------
// Company identity: the Tally company GUID is the ONLY identity, and users
// never type it - "Connect Tally" detects the open company and passes its GUID
// here. A company display name is never used to find, match or merge anything.
//
// Why the tenant must follow the GUID: a tenant's sync position
// (SyncCheckpoint) and vouchers are keyed by tenantId. If a company is removed
// and connected again and a brand new random tenantId is minted, the old
// checkpoints/vouchers are stranded under the old tenant and the new tenant
// re-syncs from AlterID 0. So the same GUID keeps the same tenant:
//
//   1. a Company record for the GUID already exists
//        - the requester belongs to it (or nobody does)  -> returned; an
//          inactive one is reactivated (same tenantId, checkpoints, data)
//        - other accounts own it and the requester is not one of them ->
//          REFUSED. Knowing/being able to open a company is not authorization:
//          there is no invitation mechanism yet, so this fails closed.
//   2. no Company record, but the GUID still has tenant evidence (sync /
//      reconciliation checkpoints, user access rows, users) -> the new record
//      reuses THAT tenantId, only when exactly one tenant qualifies and no
//      other account owns it
//   3. nothing known for the GUID -> a fresh tenantId
//
// "Owner" = a User that still exists and either has the company as its
// default or holds a UserCompanyAccess row for it. Rows pointing at deleted
// users own nothing.
//
// Everything that creates, reactivates or claims a company needs live proof
// (`proveTallyPossession`) that this Tally really has the company open.
//
// Fail-closed cases (never guess, never merge):
//   - not an owner of a company others own                     -> 403 not_authorized
//   - more than one candidate tenant for the GUID (legacy
//     duplicates)                                              -> 409 ambiguous
//   - a candidate tenant already attached to a DIFFERENT company record is
//     not a candidate
// --------------------------------------------------

async function collectCandidateTenantIds(companyGuid) {
  const [syncTenants, reconTenants, accessTenants, userTenants] = await Promise.all([
    SyncCheckpoint.distinct("tenantId", { companyGuid }),
    ReconciliationCheckpoint.distinct("tenantId", { companyGuid }),
    UserCompanyAccess.distinct("tenantId", { companyGuid }),
    User.distinct("tenantId", { companyGuId: companyGuid }),
  ]);

  const candidates = [
    ...new Set([...syncTenants, ...reconTenants, ...accessTenants, ...userTenants]),
  ].filter((id) => typeof id === "string" && id.trim());

  if (candidates.length === 0) return [];

  // A tenant already owned by some Company record is not an orphan.
  const owned = await Company.distinct("tenantId", { tenantId: { $in: candidates } });
  const ownedSet = new Set(owned);

  return candidates.filter((id) => !ownedSet.has(id));
}

// String ids of the users that still exist and belong to this company.
async function survivingOwnerIds(companyGuid) {
  const [accessUserIds, defaultUserIds] = await Promise.all([
    UserCompanyAccess.distinct("userId", { companyGuid }),
    User.distinct("_id", { companyGuId: companyGuid }),
  ]);

  const ids = [...new Set([...accessUserIds, ...defaultUserIds].map(String))];

  if (ids.length === 0) return new Set();

  const alive = await User.find({ _id: { $in: ids } }).select("_id").lean();
  return new Set(alive.map((u) => String(u._id)));
}

const isAllowed = (owners, requesterUserId) =>
  owners.size === 0 || (requesterUserId ? owners.has(String(requesterUserId)) : false);

// 403 only for a company whose EXACT GUID already has a surviving owner other
// than the requester. The message names the company Tally reported (it is the
// company open in the requester's own Tally, so nothing is disclosed): the most
// common cause of an unexpected 403 is that Tally's SELECTED company is not the
// one the user meant, and the name makes that visible.
const notAuthorized = (companyName) => ({
  ok: false,
  status: 403,
  code: "not_authorized",
  message:
    `You don't have access to this company${companyName ? ` ("${companyName}")` : ""}. ` +
    "If you meant to connect a different company, select it in TallyPrime and try again.",
});

async function proveOrFail(proveTallyPossession) {
  if (typeof proveTallyPossession !== "function") {
    return {
      ok: false,
      status: 400,
      code: "tally_unverified",
      message: "Tally verification is required for this company.",
    };
  }

  const proof = await proveTallyPossession();

  if (!proof || !proof.ok) {
    const unreachable = proof && proof.reason === "unreachable";

    return {
      ok: false,
      status: unreachable ? 503 : 400,
      code: unreachable ? "tally_unreachable" : "tally_mismatch",
      message:
        (proof && proof.message) ||
        "Could not verify this company against the company open in TallyPrime.",
    };
  }

  return { ok: true };
}

/**
 * @param {Object} params
 * @param {string} params.companyGuid   authoritative identity, detected from Tally
 * @param {string} params.companyName   only used when a record is created
 * @param {string} params.requesterUserId  the authenticated account
 * @param {Function} params.proveTallyPossession async () => {ok, reason, message}
 * @returns {Promise<{ok:true, company, created:boolean, reactivated:boolean,
 *   tenantReused:boolean} | {ok:false, status:number, code:string, message:string}>}
 */
async function ensureCompanyForGuid({
  companyGuid,
  companyName,
  requesterUserId,
  proveTallyPossession,
}) {
  const owners = await survivingOwnerIds(companyGuid);
  const requesterOwns = requesterUserId ? owners.has(String(requesterUserId)) : false;
  const existing = await Company.findOne({ companyGuid });

  if (existing) {
    if (!isAllowed(owners, requesterUserId)) return notAuthorized(companyName || existing.companyName);

    // An owner reconnecting an active company needs nothing more.
    if (existing.isActive && requesterOwns) {
      return { ok: true, company: existing, created: false, reactivated: false, tenantReused: false };
    }

    const proof = await proveOrFail(proveTallyPossession);
    if (!proof.ok) return proof;

    if (existing.isActive) {
      return { ok: true, company: existing, created: false, reactivated: false, tenantReused: false };
    }

    existing.isActive = true;
    await existing.save();

    return { ok: true, company: existing, created: false, reactivated: true, tenantReused: true };
  }

  // No Company record. Whatever tenant evidence exists for this GUID must not
  // belong to another account.
  if (!isAllowed(owners, requesterUserId)) return notAuthorized(companyName);

  const candidates = await collectCandidateTenantIds(companyGuid);

  if (candidates.length > 1) {
    console.warn(
      `[companyIdentity] ${companyGuid}: ${candidates.length} orphan tenants found (${candidates.join(", ")}); refusing to guess which to reuse.`
    );

    return {
      ok: false,
      status: 409,
      code: "ambiguous",
      message: "Company connection is ambiguous; contact administrator.",
    };
  }

  const proof = await proveOrFail(proveTallyPossession);
  if (!proof.ok) return proof;

  const tenantReused = candidates.length === 1;
  const tenantId = tenantReused ? candidates[0] : new mongoose.Types.ObjectId().toString();

  const company = await Company.create({
    companyName,
    sourceType: "tally",
    companyGuid,
    tenantId,
    isActive: true,
  });

  return { ok: true, company, created: true, reactivated: false, tenantReused };
}

module.exports = { ensureCompanyForGuid };
