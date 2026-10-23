const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { userError } = require("./errorHandler");

const uploadDir = path.join(__dirname, "../../uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "_");                                                      
    cb(null, `${Date.now()}-${safeName}`);           
  }
});

const fileFilter = (req, file, cb) => {
  const isJson = file.mimetype === "application/json" || file.originalname.toLowerCase().endsWith(".json");

  if (!isJson) {
    return cb(userError(400, "Only JSON files are allowed."));
  }

  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

module.exports = upload;
