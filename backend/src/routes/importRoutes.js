const express = require("express");

const router = express.Router();

router.post("/tally-json", (req, res) => {
  res.json({
    success: true,
    message: "Import route working"
  });
});

module.exports = router;
