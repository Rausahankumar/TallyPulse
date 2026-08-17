const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

const connectDB = require("./src/config/db");
const importRoutes = require("./src/routes/importRoutes");

dotenv.config();

connectDB();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api/import", importRoutes);

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "TallyPulse Backend Running"
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});