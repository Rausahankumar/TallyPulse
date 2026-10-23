const User = require("../models/user.model");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Company = require("../models/company");
const UserCompanyAccess = require("../models/userCompanyAccess.model");
const { detectOpenTallyCompany } = require("../services/auth/tallyCompanyGuard");
const { ensureCompanyForGuid } = require("../services/auth/companyIdentity");
const { GENERIC_SERVER_ERROR } = require("../middleware/errorHandler");

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72;

// A session token. `company` scopes it to one company; without it the token
// only identifies the account (enough to connect a company, nothing else -
// every data route needs a company context and refuses such a token).
function signToken(user, company) {
  // `tv` is the account's session version: raising User.tokenVersion invalidates
  // every token issued before (audit F-08). Accounts without the field count as 0.
  const claims = { id: user._id.toString(), role: user.role, tv: user.tokenVersion || 0 };

  if (company) {
    claims.companyGuId = company.companyGuid;
    claims.tenantId = company.tenantId;
  }

  return jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: "7d" });
}

// -----------------------------
// REGISTER - account only. No company, GUID or tenant is asked for here: the
// company is connected afterwards ("Connect Tally"), detected from Tally.
// -----------------------------
const register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "name, email and password are required",
      });
    }

    // Plain text only. Express turns JSON objects, nested form fields and
    // repeated parameters into objects/arrays, and Mongoose would use those as
    // query operators instead of values.
    if (typeof name !== "string" || typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({
        success: false,
        message: "name, email and password must be text",
      });
    }

    // Password strength (audit F-05). At least 8 characters; at most 72 BYTES,
    // because bcrypt only uses the first 72 bytes - a longer password would be
    // silently truncated, so it is refused instead of being quietly weakened.
    if (password.length < PASSWORD_MIN_LENGTH || Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
      return res.status(400).json({
        success: false,
        message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters (and at most ${PASSWORD_MAX_BYTES} bytes).`,
      });
    }

    const existingUser = await User.findOne({ email });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        // Deliberately does not say the address is registered (audit F-16).
        message: "We could not create this account. If you already have one, sign in instead.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await User.create({
      name,
      email,
      password: hashedPassword,
    });

    return res.status(201).json({
      success: true,
      message: "User registered",
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err);

    return res.status(500).json({
      success: false,
      message: GENERIC_SERVER_ERROR,
    });
  }
};

// -----------------------------
// LOGIN - email + password. The session opens on the account's default
// company; an account that has not connected a company yet gets a token
// without one (`hasCompany: false`) and is sent to "Connect Tally".
// -----------------------------
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Same rule as register: a non-text value is an input error, never a
    // database filter. (Missing values still fall through to the generic 401.)
    if ((email != null && typeof email !== "string") || (password != null && typeof password !== "string")) {
      return res.status(400).json({
        success: false,
        message: "email and password must be text",
      });
    }

    const user = email ? await User.findOne({ email }) : null;

    if (!user) {
      console.warn(`[auth] failed login (unknown account) from ${req.ip} request=${req.id || "-"}`);

      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    const matched = await bcrypt.compare(password || "", user.password);

    if (!matched) {
      console.warn(`[auth] failed login (wrong password) from ${req.ip} request=${req.id || "-"}`);

      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // Same live-record rule as everywhere else: the company claims come from
    // the Company record, never from a copy on the user.
    const company = user.companyGuId
      ? await Company.findOne({ companyGuid: user.companyGuId }).lean()
      : null;

    return res.json({
      success: true,
      token: signToken(user, company),
      hasCompany: Boolean(company),
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);

    return res.status(500).json({
      success: false,
      message: GENERIC_SERVER_ERROR,
    });
  }
};

// Friendly text for a Tally detection failure.
const TALLY_DETECTION_ERRORS = {
  unreachable: { status: 503, message: "TallyPrime is unreachable. Make sure TallyPrime is running and try again." },
  no_company_open: { status: 400, message: "Please open your company in TallyPrime and try again." },
  multiple_open: { status: 409, message: "More than one company is open in TallyPrime. Keep only the company you want to connect open and try again." },
};

// --------------------------------------------------
// CONNECT COMPANY ("Connect Tally") - attach the company that is open in
// TallyPrime right now to the CURRENT (already-authenticated) account. The
// user never supplies a GUID or a name: the backend reads them from Tally, and
// the GUID stays an internal identity (companyIdentity.js decides whether a
// tenant is created, reused or reactivated, and whether this account is
// allowed to have it at all).
//
//   - the first company needs only the session; further companies also need
//     the account password again (re-authorization, as before)
//   - a body `companyGuId`, if a client still sends one, is only an assertion:
//     it must equal the company Tally reports, never a way to pick another one
//   - reconnecting a company the account already has is fine and returns a
//     session scoped to it
// --------------------------------------------------
const addCompany = async (req, res) => {
  try {
    const { password, companyGuId: assertedGuid } = req.body || {};

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid session.",
      });
    }

    const hasCompany =
      Boolean(user.companyGuId) || (await UserCompanyAccess.exists({ userId: user._id })) !== null;

    if (hasCompany) {
      const matched =
        typeof password === "string" && password ? await bcrypt.compare(password, user.password) : false;

      if (!matched) {
        return res.status(401).json({
          success: false,
          message: password ? "Incorrect password." : "Your password is required to connect another company.",
        });
      }
    }

    // Detected live from Tally - the source of the company's identity.
    const detection = await detectOpenTallyCompany();

    if (!detection.ok) {
      const known = TALLY_DETECTION_ERRORS[detection.reason];

      return res.status(known ? known.status : 400).json({
        success: false,
        message: known ? known.message : detection.message,
      });
    }

    const detected = detection.match;

    if (assertedGuid && assertedGuid !== detected.guid) {
      return res.status(400).json({
        success: false,
        message:
          "The company currently open in TallyPrime does not match the Company GUID you entered. Please open the correct company in TallyPrime and try again.",
      });
    }

    const ensured = await ensureCompanyForGuid({
      companyGuid: detected.guid,
      companyName: detected.name || "Tally Company",
      requesterUserId: user._id,
      proveTallyPossession: async () => detection,
    });

    if (!ensured.ok) {
      console.info(
        `[connectCompany] account=${user._id} detected="${detected.name}" via=${detection.selectedBy} -> ${ensured.status} ${ensured.code}`
      );

      return res.status(ensured.status).json({
        success: false,
        message: ensured.message,
      });
    }

    const company = ensured.company;

    const existingAccess = await UserCompanyAccess.findOne({
      userId: user._id,
      companyGuid: company.companyGuid,
    });

    if (!existingAccess) {
      await UserCompanyAccess.create({
        userId: user._id,
        companyId: company._id,
        companyGuid: company.companyGuid,
        tenantId: company.tenantId,
      });
    }

    // The first company becomes the account's default (what login opens on).
    if (!user.companyGuId) {
      user.companyName = company.companyName;
      user.companyGuId = company.companyGuid;
      user.companyId = company._id;
      user.tenantId = company.tenantId;
      await user.save();
    }

    const alreadyConnected = Boolean(existingAccess) && !ensured.reactivated;

    return res.status(alreadyConnected ? 200 : 201).json({
      success: true,
      message: alreadyConnected ? "Company reconnected." : "Company connected.",
      token: signToken(user, company),
      data: {
        companyGuid: company.companyGuid,
        companyName: company.companyName,
        created: ensured.created,
        reactivated: ensured.reactivated,
      },
    });
  } catch (err) {
    console.error("CONNECT COMPANY ERROR:", err);

    return res.status(500).json({
      success: false,
      message: GENERIC_SERVER_ERROR,
    });
  }
};

// --------------------------------------------------
// LIST COMPANIES the current user can access - their default company (always
// allowed, even for accounts created before the join collection existed) plus
// every company connected via addCompany() above.
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
    if (user.companyGuId) guids.add(user.companyGuId);

    const companies = await Company.find({
      companyGuid: { $in: [...guids] },
    }).lean();

    return res.status(200).json({
      success: true,
      data: companies.map((c) => ({
        companyGuid: c.companyGuid,
        companyName: c.companyName,
        isActive: c.isActive,
        isDefault: c.companyGuid === user.companyGuId,
      })),
    });
  } catch (err) {
    console.error("LIST COMPANIES ERROR:", err);

    return res.status(500).json({
      success: false,
      message: GENERIC_SERVER_ERROR,
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

    // The identifier is used in two lookups below (access check, then the
    // company itself). It must be plain text: an object or array from the
    // request body would be read as a query operator and could make those two
    // lookups match different records.
    if (typeof companyGuId !== "string") {
      return res.status(400).json({
        success: false,
        message: "companyGuId must be text",
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

    return res.status(200).json({
      success: true,
      token: signToken(user, company),
    });
  } catch (err) {
    console.error("SWITCH COMPANY ERROR:", err);

    return res.status(500).json({
      success: false,
      message: GENERIC_SERVER_ERROR,
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

    if (!req.user.companyGuId) {
      return res.status(401).json({
        success: false,
        message: "No company is connected to this session.",
      });
    }

    if (typeof companyName !== "string" || !companyName.trim()) {
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
      },
    });
  } catch (err) {
    console.error("UPDATE COMPANY ERROR:", err);

    return res.status(500).json({
      success: false,
      message: GENERIC_SERVER_ERROR,
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
