const express = require("express");
const auth = require("../middleware/auth");
const { activeCompanyContext } = require("../services/auth/companyContext");
const {
  getProductReport,
  getCustomerReport,
  exportSalesReport,
  exportPurchaseReport,
  exportProductReport,
  exportCustomerReport,
} = require("../controllers/reportController");

const router = express.Router();

// Same auth chain as every other data-bearing route: verified JWT ->
// re-derive/authorize the active company server-side -> tenant-scoped
// query only. Sales Report and Purchase Report have no dedicated
// endpoints here (deliberately) - their headers reuse
// GET /api/analytics/sales|purchases/summary and their line-item tables
// reuse GET /api/vouchers/sales|purchases, both already built and tested.
router.use(auth, activeCompanyContext);

router.get("/products", getProductReport);
router.get("/customers", getCustomerReport);
router.get("/sales/export", exportSalesReport);
router.get("/purchases/export", exportPurchaseReport);
router.get("/products/export", exportProductReport);
router.get("/customers/export", exportCustomerReport);

module.exports = router;
