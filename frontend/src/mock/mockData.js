// --------------------------------------------------------------------
// SAMPLE / DEMO DATA — clearly isolated in this one file.
//
// The backend has no REST analytics endpoints today (docs
// §10/§11/§17): every deterministic analytics function
// (getSalesSummary, getTopProducts, etc.) is only reachable through
// the AI tool-calling layer, and that layer's one entry point
// (POST /api/chat/*/message) currently returns HTTP 501 because
// callClaude() is an intentional stub. Every number in this file is
// therefore sample data for UI development, shaped to match the
// backend's REAL response contracts exactly (see
// src/services/analytics/trustEnvelope.js and freshness.js on the
// backend) so swapping this file for a real API call later requires
// no component changes — only the data source.
// --------------------------------------------------------------------

// Matches freshness.js's exact return shape.
export const MOCK_FRESHNESS = {
  state: "fresh", // fresh | stale | sync_failed | never_synced
  dataAsOf: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
  lastRunStatus: "success",
  lastError: null,
  lastAlterId: 1591,
  minutesSinceLastSync: 12,
  message: "Data is current as of the last successful sync.",
};

export const MOCK_KPIS = {
  totalSales: { value: 1248500, delta: 12.5 },
  totalPurchases: { value: 832400, delta: 8.1 },
  grossProfit: { value: 416100, delta: 18.3 },
  totalCustomers: { value: 142, delta: 6.0 },
};

export const MOCK_MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep"];

export const MOCK_SALES_VS_PURCHASES = MOCK_MONTHS.map((label, i) => ({
  label,
  sales: [310000, 355000, 398000, 420000, 445000, 480000][i],
  purchases: [210000, 240000, 268000, 285000, 300000, 320000][i],
}));

export const MOCK_SALES_TREND = MOCK_MONTHS.map((label, i) => ({
  label,
  value: [780000, 860000, 910000, 980000, 1120000, 1248500][i],
}));

export const MOCK_TOP_PRODUCTS = [
  { itemName: "Product A", totalAmount: 348500, totalQuantity: 1240, growthPercentage: 29 },
  { itemName: "Product B", totalAmount: 224100, totalQuantity: 980, growthPercentage: 18 },
  { itemName: "Product C", totalAmount: 106200, totalQuantity: 760, growthPercentage: 12 },
  { itemName: "Product D", totalAmount: 124100, totalQuantity: 540, growthPercentage: 8 },
  { itemName: "Product E", totalAmount: 90400, totalQuantity: 420, growthPercentage: -5 },
];

export const MOCK_GROWING_PRODUCTS = MOCK_TOP_PRODUCTS.filter((p) => p.growthPercentage > 0);
export const MOCK_DECLINING_PRODUCTS = MOCK_TOP_PRODUCTS.filter((p) => p.growthPercentage < 0);

export const MOCK_TOP_CUSTOMERS = [
  { customerName: "Shree Traders", totalAmount: 248500, orderCount: 48 },
  { customerName: "Metro Distributors", totalAmount: 180300, orderCount: 36 },
  { customerName: "Rajesh Enterprises", totalAmount: 146200, orderCount: 28 },
  { customerName: "Global Mart", totalAmount: 96400, orderCount: 22 },
  { customerName: "Vijay Traders", totalAmount: 76100, orderCount: 18 },
];

export const MOCK_TOP_SUPPLIERS = [
  { supplierName: "ADC Supplies", totalAmount: 214500, orderCount: 52 },
  { supplierName: "National Traders", totalAmount: 186000, orderCount: 38 },
  { supplierName: "Shree Enterprises", totalAmount: 122400, orderCount: 28 },
  { supplierName: "Metro Corp", totalAmount: 96200, orderCount: 24 },
  { supplierName: "Om Traders", totalAmount: 62700, orderCount: 14 },
];

export const MOCK_RECENT_SALES_INVOICES = [
  { date: "12 Oct 2025", customer: "Shree Traders", amount: 24500 },
  { date: "12 Oct 2025", customer: "Metro Distributors", amount: 18200 },
  { date: "11 Oct 2025", customer: "Rajesh Enterprises", amount: 14600 },
  { date: "11 Oct 2025", customer: "Global Mart", amount: 8400 },
  { date: "10 Oct 2025", customer: "Vijay Traders", amount: 8100 },
];

export const MOCK_RECENT_ACTIVITY = [
  { text: "Sales sync completed", time: "10:24 AM", tone: "success" },
  { text: "2 new customers added", time: "09:15 AM", tone: "brand" },
  { text: "Purchase invoice imported", time: "Yesterday", tone: "brand" },
  { text: "Data reconciliation completed", time: "Yesterday", tone: "success" },
];

export const MOCK_CUSTOMER_SUMMARY = {
  total: 142,
  active: 128,
  new: 14,
};

export const MOCK_CUSTOMER_SEGMENTS = [
  { name: "Top 20%", value: 58 },
  { name: "Next 30%", value: 28 },
  { name: "Others", value: 14 },
];

export const MOCK_SALES_SUMMARY_STATS = {
  totalSales: 1248500,
  totalInvoices: 486,
  avgInvoiceValue: 2569,
  growthPct: 12.9,
};

export const MOCK_PURCHASE_SUMMARY_STATS = {
  totalPurchases: 832400,
  totalBills: 362,
  avgBillValue: 2288,
  growthPct: 10.1,
};

export const MOCK_PRODUCT_PERFORMANCE = MOCK_TOP_PRODUCTS.map((p) => ({
  label: p.itemName,
  value: p.totalAmount,
  negative: p.growthPercentage < 0,
}));

// Report catalogue for the Reports page — no report-generation
// endpoint exists on the backend, so "Generate" is a UI affordance
// only (see the Reports page for how that's surfaced honestly).
export const MOCK_REPORTS = [
  { key: "sales", name: "Sales Report", description: "Detailed sales with filters" },
  { key: "purchase", name: "Purchase Report", description: "Detailed purchases with filters" },
  { key: "product", name: "Product Wise Report", description: "Sales and purchase by product" },
  { key: "customer", name: "Customer Wise Report", description: "Customer analysis and statements" },
  { key: "stock", name: "Stock Summary", description: "Current stock position" },
];

// A pre-canned assistant turn shown only when the user explicitly asks
// to preview the AI experience (see AskAI.jsx) — never shown as a real
// answer, always labeled "Demo response" in the UI.
export const MOCK_AI_DEMO_TURN = {
  question: "What were my total sales in September 2025?",
  answer:
    "Your total sales in September 2025 were ₹1,24,800 across 48 invoices. This is 12.6% higher than August 2025 (₹1,10,800).",
  trend: [
    { label: "Apr", value: 78000 },
    { label: "May", value: 86000 },
    { label: "Jun", value: 91000 },
    { label: "Jul", value: 98000 },
    { label: "Aug", value: 110800 },
    { label: "Sep", value: 124800 },
  ],
  followUps: ["View detailed report", "Compare with last year", "Show top products"],
};

export const MOCK_SUGGESTED_QUESTIONS = [
  "Top customers",
  "Purchase summary",
  "Low stock items",
  "Product growth",
];
