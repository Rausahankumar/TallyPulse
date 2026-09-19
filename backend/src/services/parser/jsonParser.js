const fs = require("fs");

const sanitizeJsonText = (rawText) => {
  if (typeof rawText !== "string") {
    return rawText;
  }

  let cleaned = rawText.replace(/^\uFEFF/, "");
  cleaned = cleaned.replace(/^[\u0000-\u001F\u007F]+/, "");
  return cleaned.trim();
};

const parseJsonFile = (filePath) => {
  try {
    const fileContent = fs.readFileSync(filePath, "utf8");
    return JSON.parse(sanitizeJsonText(fileContent));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON parse error";
    throw new Error(`Unable to parse JSON file: ${message}`);
  }
};

module.exports = {
  parseJsonFile
};
