const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

     console.log("MongoDB Connected");
    // console.log("DB Name:", mongoose.connection.name);
    // console.log("Ready State:", mongoose.connection.readyState);
  } catch (error) {
    console.error("MongoDB Connection Error:", error.message);
    process.exit(1);
  }
};

module.exports = connectDB;