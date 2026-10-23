const path = require("path");
const mongoose = require("mongoose");

// --------------------------------------------------
// Database connection guard.
//
// Production / development: unchanged. MONGODB_URI is used as given (the Atlas cluster
// in backend/.env is a legitimate target there).
//
// Test mode: fail closed. A verification suite must never connect to the live cluster
// because backend/.env happens to be loaded. In test mode the URI must point at a
// loopback host AND name a database whose name starts with "tallypulse_ci" or
// "tallypulse_test" (for example tallypulse_ci, tallypulse_test_recovery).
//
// Test mode is on when any of these hold:
//   - NODE_ENV=test
//   - TALLYPULSE_TEST_MODE=1
//   - the entry script is a verify-*.js file (every suite is run this way)
// --------------------------------------------------

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TEST_DB_NAME = /^tallypulse_(ci|test)([_-][a-z0-9_-]*)?$/i;

function isTestMode(env = process.env, entryScript = process.argv[1]) {
  if (env.NODE_ENV === "test") return true;
  if (env.TALLYPULSE_TEST_MODE === "1") return true;
  return /^verify-.*\.js$/i.test(path.basename(String(entryScript || "")));
}

// Parses a mongodb:// or mongodb+srv:// URI without keeping credentials.
// Returns null when the string is not a usable connection string.
// Manual parsing on purpose: WHATWG URL rejects valid standard URIs with several hosts
// (mongodb://a:27017,b:27017/db). Returns { srv, hosts, host, dbName } or null.
// Credentials are dropped here and never returned.
function parseMongoUri(uri) {
  if (typeof uri !== "string") return null;
  const text = uri.trim();
  const prefix = /^mongodb(\+srv)?:\/\//i.exec(text);
  if (!prefix) return null;

  const isSrv = Boolean(prefix[1]);
  const rest = text.slice(prefix[0].length);
  const cut = rest.search(/[/?]/);
  let authority = cut === -1 ? rest : rest.slice(0, cut);
  const pathAndQuery = cut === -1 ? "" : rest.slice(cut);

  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);
  if (!authority) return null;

  const hosts = [];
  for (const entry of authority.split(",")) {
    let host;
    let port = null;
    if (entry.startsWith("[")) {
      const close = entry.indexOf("]");
      if (close === -1) return null;
      host = entry.slice(0, close + 1);
      const after = entry.slice(close + 1);
      if (after) {
        if (!after.startsWith(":")) return null;
        port = after.slice(1);
      }
    } else {
      const colon = entry.indexOf(":");
      host = colon === -1 ? entry : entry.slice(0, colon);
      port = colon === -1 ? null : entry.slice(colon + 1);
    }
    if (!host) return null;
    if (port !== null && !/^\d+$/.test(port)) return null;
    hosts.push(host.toLowerCase());
  }

  // An SRV URI names exactly one host; a comma list there is not valid.
  if (isSrv && hosts.length !== 1) return null;

  const dbName = pathAndQuery.startsWith("/") ? pathAndQuery.slice(1).split("?")[0] : "";
  return { srv: isSrv, hosts, host: hosts[0], dbName };
}

// Pure decision function: no I/O, no connection. Returns { ok, reason }.
// `reason` never contains credentials, and shows the host only when it is loopback.
function checkConnectionTarget(uri, { testMode = isTestMode() } = {}) {
  const target = parseMongoUri(uri);
  if (!target) {
    return { ok: false, reason: "MONGODB_URI is missing or is not a valid mongodb:// connection string." };
  }

  if (!testMode) {
    return { ok: true, reason: null };
  }

  // Every listed host must be loopback. The host name is never shown unless it is loopback.
  if (target.hosts.some((h) => !LOOPBACK_HOSTS.has(h))) {
    return { ok: false, reason: "Test mode refuses a non-loopback host. Test suites may only use a loopback MongoDB." };
  }
  if (!TEST_DB_NAME.test(target.dbName)) {
    return {
      ok: false,
      reason: `Test mode refuses database "${target.dbName || "(none)"}". Use a database named tallypulse_ci or tallypulse_test*.`,
    };
  }
  return { ok: true, reason: null };
}

const connectDB = async () => {
  const check = checkConnectionTarget(process.env.MONGODB_URI);
  if (!check.ok) {
    console.error(`MongoDB connection refused: ${check.reason}`);
    process.exit(1);
  }

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

// For suites that manage their own errors and must not exit the process. Applies the same
// guard as connectDB, but throws (with err.refused = true) instead of exiting, so a refusal
// can be told apart from "MongoDB is not reachable".
async function connectGuarded(options = {}) {
  const check = checkConnectionTarget(process.env.MONGODB_URI);
  if (!check.ok) {
    const err = new Error(`MongoDB connection refused: ${check.reason}`);
    err.refused = true;
    throw err;
  }
  return mongoose.connect(process.env.MONGODB_URI, options);
}

// Default export stays the connectDB function (47 callers use it that way).
// The pure helpers are attached for the focused guard tests only.
module.exports = connectDB;
module.exports.connectGuarded = connectGuarded;
module.exports.checkConnectionTarget = checkConnectionTarget;
module.exports.isTestMode = isTestMode;
module.exports.parseMongoUri = parseMongoUri;
