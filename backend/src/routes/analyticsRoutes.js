const express = require("express");
const auth = require("../middleware/auth");
const { activeCompanyContext } = require("../services/auth/companyContext");
const {
  getDiscountSummary,
  getProductRates,
  getSupplierRates,
  getSalesSummary,
  getSalesComparison,
  getTopProducts,
  getGrowingProducts,
  getDecliningProducts,
  getTopCustomers,
  getSalesTrend,
  getCustomerCounts,
  getStockGroupPerformance,
  getPurchaseSummary,
  getPurchaseComparison,
  getTopSuppliers,
  getPurchaseTrend,
} = require("../controllers/analyticsController");

const router = express.Router();

// Every route: verified JWT -> re-derive/authorize the active company
// (never trust a client-supplied tenant/company id) -> deterministic
// Analytics Engine call, scoped by that company's own tenantId only.
router.use(auth, activeCompanyContext);

router.get("/sales/summary", getSalesSummary);
router.get("/sales/comparison", getSalesComparison);
router.get("/sales/top-products", getTopProducts);
router.get("/sales/growing-products", getGrowingProducts);
router.get("/sales/declining-products", getDecliningProducts);
router.get("/sales/top-customers", getTopCustomers);
router.get("/sales/trend", getSalesTrend);
router.get("/sales/customer-counts", getCustomerCounts);
router.get("/sales/stock-groups", getStockGroupPerformance);
router.get("/purchases/summary", getPurchaseSummary);
router.get("/purchases/comparison", getPurchaseComparison);
router.get("/purchases/top-suppliers", getTopSuppliers);
router.get("/purchases/trend", getPurchaseTrend);
router.get("/discounts", getDiscountSummary);
router.get("/products/rates", getProductRates);
router.get("/purchases/supplier-rates", getSupplierRates);

module.exports = router;
