const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/user.model");

const auth = async (req, res, next) => {
  let decoded;

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: "Token required",
      });
    }

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Bearer token required",
      });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Token required",
      });
    }

    decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );
  } catch (err) {
    console.error("AUTH ERROR:", err.message);

    return res.status(401).json({
      success: false,
      message: "Invalid token",
    });
  }

  // The signature only proves we issued this token. The account must still exist
  // and the token must belong to its CURRENT session version (audit F-08 /
  // F-06): a deleted user, or one whose sessions were revoked by raising
  // User.tokenVersion, is refused here. Tokens issued before this check carry no
  // `tv` and count as version 0, matching accounts without the field.
  try {
    if (!mongoose.isValidObjectId(decoded.id)) {
      return res.status(401).json({ success: false, message: "Invalid session." });
    }

    const user = await User.findById(decoded.id).select("tokenVersion companyGuId").lean();

    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid session." });
    }

    if ((decoded.tv || 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({
        success: false,
        message: "Your session has ended. Please sign in again.",
      });
    }

    req.user = decoded;
    req.userRecord = user; // reused by the company-context check: one read per request, not two

    return next();
  } catch (err) {
    // A database problem is NOT "your token is bad" - do not sign people out for it.
    return next(err);
  }
};

module.exports = auth;