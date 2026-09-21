const express = require("express");
const auth = require("../middleware/auth");
const { loginLimiters, registerLimiter, connectCompanyLimiter } = require("../middleware/rateLimit");
const { liveCompanyContext } = require("../services/auth/companyContext");

const router = express.Router();

const {
  register,
  login,
  addCompany,
  listCompanies,
  switchCompany,
  updateCompanyName,
} = require("../controllers/authController");

// Abuse limits (audit F-04): login counts FAILED attempts per client + e-mail
// and per client; register counts every attempt per client. See middleware/rateLimit.js.
router.post("/register", registerLimiter, register);
router.post("/login", ...loginLimiters, login);

// Multi-company-per-account: connecting or switching companies always
// requires an existing authenticated session (the JWT already
// identifies the account) - never a second email/account.
router.post("/companies", auth, connectCompanyLimiter, addCompany);
router.get("/companies", auth, listCompanies);
router.post("/switch-company", auth, switchCompany);
// Renames the company named in the JWT, so access to it is re-checked live (F-06).
router.patch("/company", auth, liveCompanyContext, updateCompanyName);

module.exports = router;