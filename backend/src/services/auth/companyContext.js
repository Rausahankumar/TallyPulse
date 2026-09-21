const mongoose = require("mongoose");
const { GENERIC_SERVER_ERROR } = require("../../middleware/errorHandler");
const Company = require("../../models/company");
const User = require("../../models/user.model");
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
async function resolveAuthorizedCompany(authUser, requestedCompanyGuid, preloadedUser) {
  if (!authUser || !authUser.companyGuId) {
    const err = new Error("No authenticated company context on this request.");
    err.status = 401;
    throw err;
  }

  // A requested company must be plain text. A repeated query parameter
  // (?companyGuId=a&companyGuId=b) arrives here as an array, and Mongoose would
  // treat an array or object as a query operator in the two lookups below -
  // the access check and the company lookup could then match different records.
  if (requestedCompanyGuid != null && typeof requestedCompanyGuid !== "string") {
    const err = new Error("Invalid company identifier.");
    err.status = 400;
    throw err;
  }

  const targetGuid = requestedCompanyGuid || authUser.companyGuId;

  // Authorization check - ALWAYS against the live account, never against the
  // company written into the JWT (audit F-06). The token only says who the
  // user was when it was issued; access can be removed after that. The user
  // must still exist, and the target company must be either their CURRENT
  // default company (stored on the User) or one they hold a UserCompanyAccess
  // row for (a company connected via POST /api/auth/companies).
  if (!mongoose.isValidObjectId(authUser.id)) {
    const err = new Error("Invalid session.");
    err.status = 401;
    throw err;
  }

  // auth.js has already loaded this user for the request; reuse it when it is the same account.
  const user =
    preloadedUser && String(preloadedUser._id) === String(authUser.id)
      ? preloadedUser
      : await User.findById(authUser.id).select("companyGuId").lean();

  if (!user) {
    const err = new Error("Invalid session.");
    err.status = 401;
    throw err;
  }

  if (targetGuid !== user.companyGuId) {
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

  resolveAndContinue(req, res, next, requestedCompanyGuid);
}

/**
 * Same live authorization, but WITHOUT any client-supplied company: it
 * verifies the company named in the JWT is still one this account may use.
 * For routes whose controllers read `req.user.companyGuId` directly (sync
 * status/recovery, imports, company rename) - they keep working unchanged,
 * but a user whose access was removed is stopped here (audit F-06).
 */
function liveCompanyContext(req, res, next) {
  resolveAndContinue(req, res, next, undefined);
}

function resolveAndContinue(req, res, next, requestedCompanyGuid) {
  resolveAuthorizedCompany(req.user, requestedCompanyGuid, req.userRecord)
    .then((companyContext) => {
      req.companyContext = companyContext;
      next();
    })
    .catch((error) => {
      // Errors thrown above carry a status and a message we wrote. Anything else
      // (a database problem) is logged, not shown (audit F-12).
      if (!error.status) {
        console.error("COMPANY CONTEXT ERROR:", error);
        return res.status(500).json({ success: false, message: GENERIC_SERVER_ERROR });
      }

      return res.status(error.status).json({ success: false, message: error.message });
    });
}

module.exports = {
  resolveAuthorizedCompany,
  activeCompanyContext,
  liveCompanyContext,
};
