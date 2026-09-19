const mongoose = require("mongoose");
const Company = require("../../models/company");
const User = require("../../models/user.model");
const UserCompanyAccess = require("../../models/userCompanyAccess.model");
const SyncCheckpoint = require("../../models/syncCheckpoint.model");
const ReconciliationCheckpoint = require("../../models/reconciliationCheckpoint.model");

// --------------------------------------------------
// Company identity: the Tally company GUID is the ONLY identity. A company
// display name is never used to find, match or merge anything.
//
// Why this exists: a tenant's sync position (SyncCheckpoint) and vouchers are
// keyed by tenantId. If a company is removed and registered again and a brand
// new random tenantId is minted, the old checkpoints/vouchers are stranded
// under the old tenant and the new tenant re-syncs from AlterID 0. So the
// same GUID must keep the same tenant:
//
//   1. a Company record for the GUID already exists
//        - active   -> returned as is
//        - inactive -> reactivated (same tenantId, same checkpoints/data),
//                      only when the requester is allowed to (see below)
//   2. no Company record, but the GUID still has tenant evidence (sync /
//      reconciliation checkpoints, user access rows, users) from a removed
//      Company -> a new Company record is created with THAT tenantId
//   3. nothing known for the GUID -> a fresh tenantId (unchanged behaviour)
//
// Reactivation and orphan-tenant reuse hand the requester an existing
// tenant's data, so both require live proof that this Tally really has the
// company open (the caller supplies `proveTallyPossession`; the same
// verifyOpenTallyCompany guard the rest of the system uses). A GUID string
// alone never unlocks old data.
//
// Fail-closed cases (never guess):
//   - inactive company that other accounts still belong to, requested by an
//     account that is not one of them -> refused
//   - more than one candidate tenant for the GUID (legacy duplicates) ->
//     no reuse, a fresh tenantId is issued and a warning logged
//   - a candidate tenant already attached to a DIFFERENT company record ->
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

async function isPreviousMember(userId, company) {
  if (!userId) return false;

  const access = await UserCompanyAccess.exists({ userId, companyGuid: company.companyGuid });
  if (access) return true;

  const own = await User.exists({ _id: userId, companyGuId: company.companyGuid });
  return Boolean(own);
}

async function companyHasMembers(company) {
  const [access, users] = await Promise.all([
    UserCompanyAccess.exists({ companyGuid: company.companyGuid }),
    User.exists({ companyGuId: company.companyGuid }),
  ]);
  return Boolean(access || users);
}

async function proveOrFail(proveTallyPossession) {
  if (typeof proveTallyPossession !== "function") {
    return { ok: false, status: 400, message: "Tally verification is required for this company." };
  }

  const proof = await proveTallyPossession();

  if (!proof || !proof.ok) {
    return {
      ok: false,
      status: proof && proof.reason === "unreachable" ? 503 : 400,
      message:
        (proof && proof.message) ||
        "Could not verify this company against the company open in TallyPrime.",
    };
  }

  return { ok: true };
}

/**
 * @param {Object} params
 * @param {string} params.companyGuid   authoritative company identity
 * @param {string} params.companyName   only used when a record is created
 * @param {string} [params.requesterUserId]  the authenticated account, when
 *   there is one (addCompany); absent for a brand-new signup (register)
 * @param {Function} params.proveTallyPossession async () => {ok, reason, message}
 * @returns {Promise<{ok:true, company, created:boolean, reactivated:boolean,
 *   tenantReused:boolean} | {ok:false, status:number, message:string}>}
 */
async function ensureCompanyForGuid({
  companyGuid,
  companyName,
  requesterUserId,
  proveTallyPossession,
}) {
  const existing = await Company.findOne({ companyGuid });

  if (existing) {
    if (existing.isActive) {
      return { ok: true, company: existing, created: false, reactivated: false, tenantReused: false };
    }

    const allowed =
      (await isPreviousMember(requesterUserId, existing)) || !(await companyHasMembers(existing));

    if (!allowed) {
      return {
        ok: false,
        status: 403,
        message:
          "This company was deactivated and belongs to other accounts. Ask a previous member of the company to reconnect it.",
      };
    }

    const proof = await proveOrFail(proveTallyPossession);
    if (!proof.ok) return proof;

    existing.isActive = true;
    await existing.save();

    return { ok: true, company: existing, created: false, reactivated: true, tenantReused: true };
  }

  const candidates = await collectCandidateTenantIds(companyGuid);
  let tenantId = null;

  if (candidates.length === 1) {
    const proof = await proveOrFail(proveTallyPossession);
    if (!proof.ok) return proof;

    tenantId = candidates[0];
  } else if (candidates.length > 1) {
    console.warn(
      `[companyIdentity] ${companyGuid}: ${candidates.length} orphan tenants found (${candidates.join(", ")}); refusing to guess which to reuse - issuing a fresh tenant.`
    );
  }

  const tenantReused = tenantId !== null;

  if (!tenantReused) {
    tenantId = new mongoose.Types.ObjectId().toString();
  }

  const company = await Company.create({
    companyName,
    sourceType: "tally",
    companyGuid,
    tenantId,
    isActive: true,
  });

  return { ok: true, company, created: true, reactivated: false, tenantReused };
}

module.exports = { ensureCompanyForGuid, collectCandidateTenantIds };
