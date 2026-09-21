const express = require("express");
const upload = require("../middleware/upload");
const auth = require("../middleware/auth");
const { liveCompanyContext } = require("../services/auth/companyContext");
const {
  importTallyJson,
  importTallyLive,
} = require("../controllers/importController");

const router = express.Router();


// liveCompanyContext runs BEFORE the upload middleware so a user whose access
// was removed cannot even store a file (audit F-06).
router.post(
  "/tally-json",
  auth,
  liveCompanyContext,
  upload.single("file"),
  importTallyJson
);

router.post(
  "/tally-live",
  auth,
  liveCompanyContext,
  importTallyLive
);

module.exports = router;