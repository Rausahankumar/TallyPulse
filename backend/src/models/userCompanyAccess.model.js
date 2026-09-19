const mongoose = require("mongoose");

// --------------------------------------------------
// The join collection companyContext.js explicitly anticipated
// ("this is the exact line that becomes a join-collection lookup once
// multi-company is implemented, without changing anything that calls
// this function" — see resolveAuthorizedCompany). One row per
// {user, company} pairing a user is allowed to operate as.
//
// A user's ORIGINAL company (User.companyId/companyGuId/tenantId, set
// at registration) is still the source of truth for their default
// login context and is NOT required to have a row here — this
// collection only needs a row for every ADDITIONAL company a user
// connects via POST /api/auth/companies, plus a mirrored row for the
// first company (created at registration too) so a single "list my
// companies" query has one consistent place to read from.
// --------------------------------------------------
const userCompanyAccessSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },

    companyGuid: {
      type: String,
      required: true,
    },

    tenantId: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// A user can be linked to the same company only once.
userCompanyAccessSchema.index({ userId: 1, companyGuid: 1 }, { unique: true });

module.exports = mongoose.model("UserCompanyAccess", userCompanyAccessSchema);
