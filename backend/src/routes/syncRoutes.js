const express = require("express");
const auth = require("../middleware/auth");
const { getSyncStatus } = require("../controllers/syncStatusController");
const { runVoucherRecovery } = require("../controllers/syncRecoveryController");

const router = express.Router();

router.get("/status", auth, getSyncStatus);
router.post("/recovery", auth, runVoucherRecovery);

module.exports = router;
