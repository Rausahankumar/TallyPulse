// --------------------------------------------------
// The real tenants the live-data suites compare against.
//
// Their company names, tenant ids and company GUIDs are NOT kept in the repository. A suite that reads real data takes them from
// the environment; when they are unset it finds no such tenant and skips its real-data section (the same as in CI).
//
//   REAL_TENANT_A_NAME, REAL_TENANT_A_ID (a MongoDB tenant ObjectId), REAL_TENANT_A_GUID (the Tally company GUID)
//   REAL_TENANT_B_NAME, REAL_TENANT_B_ID, REAL_TENANT_B_GUID
//
// Defaults match nothing: the id default is a valid but unused ObjectId (a query with it casts and finds no document).
// --------------------------------------------------

const UNUSED_ID = "000000000000000000000000";

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tenant(letter, env = process.env) {
  const name = (env[`REAL_TENANT_${letter}_NAME`] || "").trim() || `Real Tenant ${letter}`;
  return {
    name,
    nameRegex: new RegExp(escapeRegExp(name), "i"),
    tenantId: (env[`REAL_TENANT_${letter}_ID`] || "").trim() || UNUSED_ID,
    guid: (env[`REAL_TENANT_${letter}_GUID`] || "").trim() || `unset-real-tenant-${letter.toLowerCase()}-guid`,
  };
}

module.exports = { A: tenant("A"), B: tenant("B"), tenant, UNUSED_ID };
