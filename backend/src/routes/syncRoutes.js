const express = require("express");
const auth = require("../middleware/auth");
const { getSyncStatus } = require("../controllers/syncStatusController");

const router = express.Router();

router.get("/status", auth, getSyncStatus);

module.exports = router;
