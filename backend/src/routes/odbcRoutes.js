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

const {
  testTallyConnection,
  getSales
} = require("../controllers/odbcController");

const router = express.Router();

router.get("/company", testTallyConnection);

router.get("/sales", getSales);

module.exports = router;