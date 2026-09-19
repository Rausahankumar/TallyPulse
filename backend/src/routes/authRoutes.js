const express = require("express");
const auth = require("../middleware/auth");

const router = express.Router();

const {
  register,
  login,
  addCompany,
  listCompanies,
  switchCompany,
  updateCompanyName,
} = require("../controllers/authController");

router.post("/register", register);
router.post("/login", login);

// Multi-company-per-account: connecting or switching companies always
// requires an existing authenticated session (the JWT already
// identifies the account) - never a second email/account.
router.post("/companies", auth, addCompany);
router.get("/companies", auth, listCompanies);
router.post("/switch-company", auth, switchCompany);
router.patch("/company", auth, updateCompanyName);

module.exports = router;