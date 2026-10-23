const express = require("express");
const dotenv = require("dotenv");

const connectDB = require("./src/config/db");
const { applyHttpSecurity } = require("./src/middleware/httpSecurity");
const { errorHandler, notFoundHandler } = require("./src/middleware/errorHandler");
const requestId = require("./src/middleware/requestId");
const { startTallySyncWorker } = require("./src/services/sync/tallySyncWorker");
const { startReconciliationWorker } = require("./src/services/sync/reconciliationWorker");

const authRoutes = require("./src/routes/authRoutes");
const importRoutes = require("./src/routes/importRoutes");
const odbcRoutes = require("./src/routes/odbcRoutes");
const chatRoutes = require("./src/routes/chatRoutes");
const syncRoutes = require("./src/routes/syncRoutes");
const analyticsRoutes = require("./src/routes/analyticsRoutes");
const voucherRoutes = require("./src/routes/voucherRoutes");
const reportRoutes = require("./src/routes/reportRoutes");


//console.log("Odbc routes" , typeof odbcRoutes);

dotenv.config();

// The background sync worker touches Company/SyncCheckpoint/Sale
// collections, so it only starts once the MongoDB connection in
// connectDB() has actually resolved - not before.
connectDB().then(() => {
  startTallySyncWorker();
  // Separate job, separate cadence, separate checkpoint model - the
  // deletion-reconciliation safety-net (see reconciliation.js). Does not
  // touch or depend on the incremental sync worker above.
  startReconciliationWorker();
});

const app = express();

// Middleware
// Security headers + CORS allow-list (audit F-11) - see src/middleware/httpSecurity.js
applyHttpSecurity(app);
app.use(requestId); // X-Request-Id on every response; the same id is in error logs (audit F-19)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health Check
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "TallyPulse Backend Running",
    version: "1.0.0",
  });
});

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/import", importRoutes);
app.use("/api/odbc", odbcRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/sync", syncRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/vouchers", voucherRoutes);
app.use("/api/reports", reportRoutes);


// 404 Handler
app.use(notFoundHandler);

// Global Error Handler - clients only ever see messages we chose; library and
// database error text stays in the server log (audit F-12).
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});