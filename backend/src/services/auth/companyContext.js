const Company = require("../../models/company");
const UserCompanyAccess = require("../../models/userCompanyAccess.model");

// --------------------------------------------------
// Active Company Context resolution - the one place that decides "which
// company's data is this request allowed to see."
//
// CURRENT DATA MODEL: User (src/models/user.model.js) has exactly one
// companyId/companyGuId/tenantId - true multi-company-per-user support
// (a user with access to Company A, B, and C) does not exist in the
// schema yet. See the architecture report for the recommended
// UserCompanyAccess join-collection design to add that later.
//
// This module exists so that, even under the CURRENT single-company
// model, there is exactly one function everything (HTTP routes, the
// Claude tool layer, anything added later) calls to resolve "which
// company," and exactly one place authorization is enforced. When
// multi-company is added later, only resolveAuthorizedCompany's
// internals change (check a join collection instead of a single field)
// - every caller stays the same. That is the actual point of building
// this now instead of skipping straight to a full multi-company
// rewrite.
//
// SECURITY INVARIANT: the requested company identifier may come from a
// client request (a future company-switcher UI) but is NEVER trusted
// on its own. It is always re-verified against what the authenticated
// user (req.user, already JWT-verified) is actually authorized for,
// and the tenantId used downstream always comes from the freshly
// re-fetched Company record - never from client input, never from
// anything Claude/the AI layer supplies.
// --------------------------------------------------

/**
 * Resolve and authorize the active company context for an authenticated
 * request.
 *
 * @param {Object} authUser - req.user, the JWT-decoded payload (already
 *   verified by the auth middleware). Must carry companyGuId.
 * @param {string} [requestedCompanyGuid] - a company the caller is
 *   asking to switch to/operate as (e.g. a company-selector UI or a
 *   future multi-company session). Optional - when omitted, the user's
 *   own default company is used.
 * @returns {Promise<{tenantId: string, companyGuid: string, companyId: string, companyName: string}>}
 * @throws {Error} with `.status` set (401/403/404) on any authorization
 *   failure - callers should map this to an HTTP response, not swallow it.
 */
async function resolveAuthorizedCompany(authUser, requestedCompanyGuid) {
  if (!authUser || !authUser.companyGuId) {
    const err = new Error("No authenticated company context on this request.");
    err.status = 401;
    throw err;
  }

  const targetGuid = requestedCompanyGuid || authUser.companyGuId;

  // Authorization check. A user's own default company (set at
  // registration) is always allowed via the direct equality check
  // below. Any OTHER company requires a matching UserCompanyAccess row
  // - the join collection this function's own comments anticipated -
  // so a user can only ever operate as a company they (or an admin)
  // explicitly connected via POST /api/auth/companies.
  if (targetGuid !== authUser.companyGuId) {
    const access = await UserCompanyAccess.findOne({
      userId: authUser.id,
      companyGuid: targetGuid,
    }).lean();

    if (!access) {
      const err = new Error(
        "You are not authorized for the requested company."
      );
      err.status = 403;
      throw err;
    }
  }

  // Never trust the JWT's own tenantId/companyGuId claims for data
  // access without re-verifying against the live Company record - same
  // invariant the existing sync pipeline already follows
  // (resolveTenantContext in tallySalesImport.js). A JWT could be
  // stale (company deactivated after it was issued, etc.).
  const company = await Company.findOne({ companyGuid: targetGuid }).lean();

  if (!company) {
    const err = new Error("Company not found.");
    err.status = 404;
    throw err;
  }

  if (!company.isActive) {
    const err = new Error("Company is inactive.");
    err.status = 403;
    throw err;
  }

  return {
    tenantId: company.tenantId,
    companyGuid: company.companyGuid,
    companyId: String(company._id),
    companyName: company.companyName,
  };
}

/**
 * Express middleware wrapper: resolves the active company context and
 * attaches it to req.companyContext. Accepts an optional company
 * override from the request (header or query param) for a future
 * company-switcher UI - fully authorization-checked, never trusted
 * blindly.
 */
function activeCompanyContext(req, res, next) {
  const requestedCompanyGuid =
    (req.headers && req.headers["x-company-guid"]) ||
    (req.query && req.query.companyGuId) ||
    undefined;

  resolveAuthorizedCompany(req.user, requestedCompanyGuid)
    .then((companyContext) => {
      req.companyContext = companyContext;
      next();
    })
    .catch((error) => {
      res.status(error.status || 500).json({
        success: false,
        message: error.message || "Unable to resolve company context.",
      });
    });
}

module.exports = {
  resolveAuthorizedCompany,
  activeCompanyContext,
};
