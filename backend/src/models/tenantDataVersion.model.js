const mongoose = require("mongoose");

// One tiny counter per tenant. Every committed write to a tenant's
// Sales / Purchase / Stock Item master data increments it (see
// services/query/dataVersion.js). The answer cache keys on this value, so a
// changed dataset can never be answered from an old cached result.
//
// tenantId "*" is a reserved GLOBAL counter, bumped when a write cannot be
// attributed to a single tenant (fail closed: it invalidates everyone).
const tenantDataVersionSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, unique: true, index: true },
    version: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model("TenantDataVersion", tenantDataVersionSchema);
