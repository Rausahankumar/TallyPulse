const mongoose = require("mongoose");
const User = require("../models/user.model");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Company = require("../models/company");
const UserCompanyAccess = require("../models/userCompanyAccess.model");
const { verifyOpenTallyCompany } = require("../services/auth/tallyCompanyGuard");

const register = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      companyName,
      companyGuId,
    } = req.body;

    // -----------------------------
    // Basic validation
    // -----------------------------
    if (
      !name ||
      !email ||
      !password ||
      !companyName ||
      !companyGuId
    ) {
      return res.status(400).json({
        success: false,
        message:
          "name, email, password, companyName and companyGuId are required",
      });
    }

    // -----------------------------
    // Check existing user
    // -----------------------------
    const existingUser = await User.findOne({
      email,
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "Email already registered",
      });
    }

    // -----------------------------
    // Check existing company
    // -----------------------------
    const existingCompany = await Company.findOne({
      companyGuid: companyGuId,
    });

    if (existingCompany) {
      return res.status(400).json({
        success: false,
        message: "Company is already registered",
      });
    }

    // -----------------------------
    // Hash password
    // -----------------------------
    const hashedPassword = await bcrypt.hash(
      password,
      10
    );

    // -----------------------------
    // Generate tenantId
    // -----------------------------
    const tenantId =
      new mongoose.Types.ObjectId().toString();

    console.log(
      "===== COMPANY CREATE DEBUG ====="
    );

    console.log(
      "Generated tenantId:",
      tenantId
    );

    console.log(
      "Company object before create:",
      {
        companyName,
        sourceType: "tally",
        companyGuid: companyGuId,
        tenantId,
        isActive: true,
      }
    );

    console.log(
      "Company schema paths:",
      Object.keys(Company.schema.paths)
    );

    console.log(
      "================================"
    );

    // -----------------------------
    // Create Company
    // -----------------------------
    const company = await Company.create({
      companyName,
      sourceType: "tally",
      companyGuid: companyGuId,
      tenantId,
      isActive: true,
    });

    console.log(
      "===== COMPANY CREATED ====="
    );

    console.log("Company ID:", company._id);
    console.log(
      "Company GUID:",
      company.companyGuid
    );
    console.log(
      "Company tenantId:",
      company.tenantId
    );

    console.log(
      "Company document:",
      company.toObject()
    );

    console.log(
      "==========================="
    );

    // -----------------------------
    // Create User
    // -----------------------------
    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      companyName,
      companyGuId,
      companyId: company._id,
      tenantId,
    });

    console.log(
      "===== USER CREATED ====="
    );

    console.log("User ID:", user._id);
    console.log("User email:", user.email);
    console.log(
      "User companyId:",
      user.companyId
    );
    console.log(
      "User companyGuId:",
      user.companyGuId
    );
    console.log(
      "User tenantId:",
      user.tenantId
    );

    console.log(
      "========================"
    );

    // Mirror the first company into the same join collection
    // addCompany()/listCompanies() use below, so "every company this
    // user can access" always has one consistent place to read from -
    // including the one just created here at signup.
    await UserCompanyAccess.create({
      userId: user._id,
      companyId: company._id,
      companyGuid: company.companyGuid,
      tenantId: company.tenantId,
    });

    return res.status(201).json({
      success: true,
      message: "User registered",
    });

  } catch (err) {
    console.error(
      "REGISTER ERROR:",
      err
    );

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};


// -----------------------------
// LOGIN
// -----------------------------
const login = async (req, res) => {
  try {
    const {
      email,
      password,
      companyGuId,
    } = req.body;

    const user = await User.findOne({
      email,
      companyGuId,
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message:
          "Invalid credentials or company GUID",
      });
    }

    const matched = await bcrypt.compare(
      password,
      user.password
    );

    if (!matched) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    console.log(
      "===== LOGIN DEBUG ====="
    );

    console.log("User ID:", user._id);
    console.log("Email:", user.email);
    console.log(
      "Company GUID:",
      user.companyGuId
    );
    console.log(
      "Tenant ID:",
      user.tenantId
    );
    console.log(
      "Role:",
      user.role
    );

    console.log(
      "======================="
    );

    // companyGuId is the company context.
    // companyId is NOT required in JWT.
    const token = jwt.sign(
      {
        id: user._id.toString(),
        companyGuId: user.companyGuId,
        tenantId: user.tenantId,
        role: user.role,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    const decodedToken =
      jwt.decode(token);

    console.log(
      "===== JWT DEBUG ====="
    );

    console.log(
      "JWT Payload:",
      decodedToken
    );

    console.log(
      "JWT Company GUID:",
      decodedToken?.companyGuId
    );

    console.log(
      "JWT Tenant ID:",
      decodedToken?.tenantId
    );

    console.log(
      "====================="
    );

    return res.json({
      success: true,
      token,
    });

  } catch (err) {
    console.error(
      "LOGIN ERROR:",
      err
    );

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};


// --------------------------------------------------
// ADD COMPANY - connect an additional company to the CURRENT
// (already-authenticated) account. Product rule: this must never
// require a second TallyPulse account/email - the caller is already
// identified by their JWT (req.user.id, set by the auth middleware);
// they re-supply their existing password only to authorize the action
// (same pattern as re-entering a password to add a workspace in other
// SaaS products), not to create or look up a different user.
// --------------------------------------------------
const addCompany = async (req, res) => {
  try {
    const { password, companyName, companyGuId } = req.body;

    if (!password || !companyName || !companyGuId) {
      return res.status(400).json({
        success: false,
        message: "password, companyName and companyGuId are required",
      });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid session.",
      });
    }

    const matched = await bcrypt.compare(password, user.password);

    if (!matched) {
      return res.status(401).json({
        success: false,
        message: "Incorrect password.",
      });
    }

    // Safety gate (product rule): the requested companyGuId must be the
    // company Tally itself currently has open right now - checked live,
    // on the backend, never trusted from the client alone. This is what
    // stops "Tally has Company A open, user typed Company B's GUID" from
    // silently succeeding.
    const guard = await verifyOpenTallyCompany(companyGuId);

    if (!guard.ok) {
      const status = guard.reason === "unreachable" ? 503 : 400;
      return res.status(status).json({
        success: false,
        message: guard.message,
      });
    }

    // Reuse the Company record if this GUID is already registered
    // (e.g. a teammate connecting to the same real Tally company);
    // otherwise create it fresh - same shape register() creates.
    let company = await Company.findOne({ companyGuid: companyGuId });

    if (!company) {
      const tenantId = new mongoose.Types.ObjectId().toString();
      company = await Company.create({
        companyName,
        sourceType: "tally",
        companyGuid: companyGuId,
        tenantId,
        isActive: true,
      });
    }

    const existingAccess = await UserCompanyAccess.findOne({
      userId: user._id,
      companyGuid: company.companyGuid,
    });

    if (existingAccess) {
      return res.status(400).json({
        success: false,
        message: "This company is already connected to your account.",
      });
    }

    await UserCompanyAccess.create({
      userId: user._id,
      companyId: company._id,
      companyGuid: company.companyGuid,
      tenantId: company.tenantId,
    });

    return res.status(201).json({
      success: true,
      message: "Company connected.",
      data: {
        companyGuid: company.companyGuid,
        companyName: company.companyName,
        tenantId: company.tenantId,
      },
    });
  } catch (err) {
    console.error("ADD COMPANY ERROR:", err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// --------------------------------------------------
// LIST COMPANIES the current user can access - their original
// registration company (always allowed, even for accounts created
// before this join collection existed) plus anything added via
// addCompany() above.
// --------------------------------------------------
const listCompanies = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).lean();

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid session.",
      });
    }

    const accessRows = await UserCompanyAccess.find({ userId: user._id }).lean();
    const guids = new Set(accessRows.map((row) => row.companyGuid));
    guids.add(user.companyGuId);

    const companies = await Company.find({
      companyGuid: { $in: [...guids] },
    }).lean();

    return res.status(200).json({
      success: true,
      data: companies.map((c) => ({
        companyGuid: c.companyGuid,
        companyName: c.companyName,
        tenantId: c.tenantId,
        isActive: c.isActive,
        isDefault: c.companyGuid === user.companyGuId,
      })),
    });
  } catch (err) {
    console.error("LIST COMPANIES ERROR:", err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// --------------------------------------------------
// SWITCH ACTIVE COMPANY - re-scopes the JWT to a company the user
// already has access to (their own, or one added via addCompany()).
// Deliberately does NOT require the password again: the user is
// already authenticated for their account, this only changes which
// already-authorized company that session is acting as - exactly the
// "future company-switcher UI" companyContext.js's
// activeCompanyContext middleware was already designed to support.
// --------------------------------------------------
const switchCompany = async (req, res) => {
  try {
    const { companyGuId } = req.body;

    if (!companyGuId) {
      return res.status(400).json({
        success: false,
        message: "companyGuId is required",
      });
    }

    const user = await User.findById(req.user.id).lean();

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid session.",
      });
    }

    const isOwnCompany = companyGuId === user.companyGuId;

    const hasAccess =
      isOwnCompany ||
      !!(await UserCompanyAccess.findOne({
        userId: user._id,
        companyGuid: companyGuId,
      }).lean());

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized for the requested company.",
      });
    }

    const company = await Company.findOne({ companyGuid: companyGuId }).lean();

    if (!company || !company.isActive) {
      return res.status(404).json({
        success: false,
        message: "Company not found or inactive.",
      });
    }

    const token = jwt.sign(
      {
        id: user._id.toString(),
        companyGuId: company.companyGuid,
        tenantId: company.tenantId,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      success: true,
      token,
    });
  } catch (err) {
    console.error("SWITCH COMPANY ERROR:", err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// --------------------------------------------------
// RENAME the CURRENT active company (req.user.companyGuId, from the
// JWT - never a company id supplied by the client). Small, additive
// fix: the frontend previously "saved" a company name change only to
// browser localStorage and never called the backend at all. That's a
// fake success the QA pass flagged - this makes the save real.
// --------------------------------------------------
const updateCompanyName = async (req, res) => {
  try {
    const { companyName } = req.body;

    if (!companyName || !companyName.trim()) {
      return res.status(400).json({
        success: false,
        message: "companyName is required",
      });
    }

    const company = await Company.findOneAndUpdate(
      { companyGuid: req.user.companyGuId },
      { $set: { companyName: companyName.trim() } },
      { new: true }
    );

    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Company not found.",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        companyGuid: company.companyGuid,
        companyName: company.companyName,
        tenantId: company.tenantId,
      },
    });
  } catch (err) {
    console.error("UPDATE COMPANY ERROR:", err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

module.exports = {
  register,
  login,
  addCompany,
  listCompanies,
  switchCompany,
  updateCompanyName,
};