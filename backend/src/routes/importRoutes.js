const express = require("express");
const upload = require("../middleware/upload");
const auth = require("../middleware/auth");
const {
  importTallyJson,
  importTallyLive,
} = require("../controllers/importController");

const router = express.Router();


router.post(
  "/tally-json",
  auth,
  upload.single("file"),
  importTallyJson
);

router.post(
  "/tally-live",
  auth,
  importTallyLive
);

module.exports = router;