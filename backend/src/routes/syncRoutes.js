const express = require("express");
const auth = require("../middleware/auth");
const { liveCompanyContext } = require("../services/auth/companyContext");
const { getSyncStatus } = require("../controllers/syncStatusController");
const { runVoucherRecovery } = require("../controllers/syncRecoveryController");

const router = express.Router();

// The controllers read the company from the JWT, so access to it is re-checked
// against the live account first (audit F-06): a removed user stops here.
router.get("/status", auth, liveCompanyContext, getSyncStatus);
router.post("/recovery", auth, liveCompanyContext, runVoucherRecovery);

module.exports = router;
