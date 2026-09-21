const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: String,

    email: {
      type: String,
      unique: true,
      required: true,
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      required: true,
    },

    role: {
      type: String,
      default: "user",
    },

    // The user's DEFAULT company. Empty until the user connects their first
    // company ("Connect Tally"), which fills it in; every company the user can
    // use (this one included) is also listed in UserCompanyAccess.
    companyName: {
      type: String,
      default: null,
    },

    companyGuId: {
      type: String,
      default: null,
    },

    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
    },

    tenantId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("User", userSchema);