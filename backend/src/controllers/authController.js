const mongoose = require("mongoose");
const User = require("../models/user.model");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Company = require("../models/company");

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


module.exports = {
  register,
  login,
};