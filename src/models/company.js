const mongoose = require("mongoose");

const companySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },

  tenantId: {
    type: String,
    required: true
  },

  sourceType: {
    type: String,
    required: true
  },

  companyGuid: {
    type: String,
    required: true
  },

  isActive: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

module.exports = mongoose.model("Company", companySchema);