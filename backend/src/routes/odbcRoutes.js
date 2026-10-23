// const express = require("express");
// const auth = require("../middleware/auth");
// const  {testOdbcConnection , getSales} = require("../controllers/odbcController");

// const router = express.Router();

// //console.log("getsale" , typeof getSales)

// router.get(
//   "/test",
//   auth,
//   testOdbcConnection
// );

// router.get("/sales", auth, getSales);

// module.exports = router;


const express = require("express");

const auth = require("../middleware/auth");
const { liveCompanyContext } = require("../services/auth/companyContext");
const {
  testTallyConnection,
  getSales
} = require("../controllers/odbcController");

const router = express.Router();

// Both routes need a signed-in user (audit F-03). They used to be open, and /sales
// returned raw Tally vouchers to anyone who could reach the port.
//
// /company only lists which company Tally reports, and is used during onboarding
// (before a company is connected), so a valid account token is enough.
router.get("/company", auth, testTallyConnection);

// /sales returns raw vouchers of whichever company Tally has selected, so the
// caller must also hold a live, authorized company - and the controller refuses
// unless that is the company Tally has selected.
router.get("/sales", auth, liveCompanyContext, getSales);

module.exports = router;