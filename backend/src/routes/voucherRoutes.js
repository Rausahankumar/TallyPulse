const express = require("express");
const auth = require("../middleware/auth");
const { liveCompanyContext } = require("../services/auth/companyContext");
const { listSalesVouchers, listPurchaseVouchers } = require("../controllers/voucherController");

const router = express.Router();

// Same pattern as syncRoutes: verified JWT -> re-checked against the
// live account (a removed/revoked user stops here) -> tenant-scoped
// query, never a client-supplied tenant id.
router.use(auth, liveCompanyContext);

router.get("/sales", listSalesVouchers);
router.get("/purchases", listPurchaseVouchers);

module.exports = router;
