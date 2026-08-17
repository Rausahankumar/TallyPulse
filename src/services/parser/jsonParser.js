const fs = require("fs");

const parseJsonFile = (filePath) => {
  try {
    const fileContent = fs.readFileSync(filePath, "utf8");
    return JSON.parse(fileContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON parse error";
    throw new Error(`Unable to parse JSON file: ${message}`);
  }
};

module.exports = {
  parseJsonFile
};
