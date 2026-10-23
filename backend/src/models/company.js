const mongoose = require("mongoose");
const { isSafeTallyUrl } = require("../services/odbc/tallyUrl");

const companySchema = new mongoose.Schema(
  {
    companyName: {
      type: String,
      required: true,
      trim: true,
    },

    sourceType: {
      type: String,
      required: true,
      default: "tally",
    },

    companyGuid: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    tenantId: {
      type: String,
      required: true,
      unique: true,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    // Optional per-company Tally connection override. When unset, the
    // Tally service falls back to its own default (currently
    // http://localhost:9000 — the one local TallyPrime instance this
    // project talks to today). This is what lets each tenant eventually
    // point at its own TallyPrime instance without changing worker code.
    tallyConnection: {
      baseUrl: {
        type: String,
        default: null,
        trim: true,
        // http(s) only, no credentials, no link-local / metadata addresses (audit
        // F-10). Also enforced again at the moment of use in odbcService.
        validate: {
          validator: (value) => value === null || value === undefined || value === "" || isSafeTallyUrl(value),
          message: "tallyConnection.baseUrl is not an allowed Tally address.",
        },
      },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model(
  "Company",
  companySchema
);