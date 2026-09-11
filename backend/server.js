const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

const connectDB = require("./src/config/db");
const { startTallySyncWorker } = require("./src/services/sync/tallySyncWorker");

const authRoutes = require("./src/routes/authRoutes");
const importRoutes = require("./src/routes/importRoutes");
const odbcRoutes = require("./src/routes/odbcRoutes");


//console.log("Odbc routes" , typeof odbcRoutes);

dotenv.config();

// The background sync worker touches Company/SyncCheckpoint/Sale
// collections, so it only starts once the MongoDB connection in
// connectDB() has actually resolved - not before.
connectDB().then(() => {
  startTallySyncWorker();
});

const app = express();

// Middleware
app.use(cors());
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


// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(err);

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});