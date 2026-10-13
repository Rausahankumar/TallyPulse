// DB-free tests for the connection guard in src/config/db.js.
// Nothing here connects to MongoDB: the guard is a pure decision function.
// Run: node verify-db-connection-guard.js
const assert = require("assert");
const { checkConnectionTarget, isTestMode, parseMongoUri } = require("./src/config/db");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

const ATLAS = "mongodb+srv://appuser:S3cretPass@cluster0.example.mongodb.net/tallypulse?retryWrites=true";
const LOCAL_CI = "mongodb://127.0.0.1:27017/tallypulse_ci";

// ---- test-mode detection
check("NODE_ENV=test enables test mode", () => {
  assert.strictEqual(isTestMode({ NODE_ENV: "test" }, "/x/server.js"), true);
});
check("TALLYPULSE_TEST_MODE=1 enables test mode", () => {
  assert.strictEqual(isTestMode({ TALLYPULSE_TEST_MODE: "1" }, "/x/server.js"), true);
});
check("verify-*.js entry script enables test mode", () => {
  assert.strictEqual(isTestMode({}, "D:\\TallyPulse\\backend\\verify-sales-mapper.js"), true);
  assert.strictEqual(isTestMode({}, "/x/verify-company-identity.js"), true);
});
check("server.js with no env markers is NOT test mode", () => {
  assert.strictEqual(isTestMode({}, "/x/server.js"), false);
  assert.strictEqual(isTestMode({}, null), false); // null, not undefined: undefined takes the process.argv default
});

// ---- URI parsing
check("parseMongoUri extracts host and db name", () => {
  assert.deepStrictEqual(parseMongoUri(LOCAL_CI), { srv: false, hosts: ["127.0.0.1"], host: "127.0.0.1", dbName: "tallypulse_ci" });
});
check("parseMongoUri rejects non-mongo strings", () => {
  assert.strictEqual(parseMongoUri("http://127.0.0.1/tallypulse_ci"), null);
  assert.strictEqual(parseMongoUri("not a uri"), null);
  assert.strictEqual(parseMongoUri(""), null);
  assert.strictEqual(parseMongoUri(undefined), null);
});

// ---- production: unchanged behaviour
check("production accepts the Atlas URI (no restriction)", () => {
  assert.strictEqual(checkConnectionTarget(ATLAS, { testMode: false }).ok, true);
});
check("production accepts any valid URI, local or remote", () => {
  assert.strictEqual(checkConnectionTarget(LOCAL_CI, { testMode: false }).ok, true);
  assert.strictEqual(checkConnectionTarget("mongodb://10.0.0.5:27017/anything", { testMode: false }).ok, true);
});
check("production still refuses a missing or invalid URI", () => {
  assert.strictEqual(checkConnectionTarget(undefined, { testMode: false }).ok, false);
  assert.strictEqual(checkConnectionTarget("nope", { testMode: false }).ok, false);
});

// ---- test mode: fail closed
check("test mode refuses the Atlas URI", () => {
  const r = checkConnectionTarget(ATLAS, { testMode: true });
  assert.strictEqual(r.ok, false);
});
check("test mode refused reason never contains credentials or the Atlas host", () => {
  const r = checkConnectionTarget(ATLAS, { testMode: true });
  assert.ok(!r.reason.includes("S3cretPass"), "password leaked into reason");
  assert.ok(!r.reason.includes("appuser"), "username leaked into reason");
  assert.ok(!r.reason.includes("cluster0"), "Atlas host leaked into reason");
  assert.ok(r.reason.includes("non-loopback host"));
});
check("test mode accepts loopback + tallypulse_ci (the CI target)", () => {
  assert.strictEqual(checkConnectionTarget(LOCAL_CI, { testMode: true }).ok, true);
});
check("test mode accepts loopback + tallypulse_test* names", () => {
  assert.strictEqual(checkConnectionTarget("mongodb://127.0.0.1:27017/tallypulse_test", { testMode: true }).ok, true);
  assert.strictEqual(checkConnectionTarget("mongodb://localhost:27017/tallypulse_test_recovery", { testMode: true }).ok, true);
  assert.strictEqual(checkConnectionTarget("mongodb://[::1]:27017/tallypulse_ci-run2", { testMode: true }).ok, true);
});
check("test mode refuses loopback with a non-test database name", () => {
  for (const uri of [
    "mongodb://127.0.0.1:27017/tallypulse",
    "mongodb://127.0.0.1:27017/dead_no_db",
    "mongodb://127.0.0.1:27017/tallypulse_production",
    "mongodb://127.0.0.1:27017/mytallypulse_ci",
    "mongodb://127.0.0.1:27017/",
    "mongodb://127.0.0.1:27017",
  ]) {
    assert.strictEqual(checkConnectionTarget(uri, { testMode: true }).ok, false, uri);
  }
});
check("test mode refuses a remote host even with a test database name", () => {
  assert.strictEqual(checkConnectionTarget("mongodb://db.example.com:27017/tallypulse_ci", { testMode: true }).ok, false);
});
check("test mode refuses a multi-host list that mixes loopback and remote", () => {
  const uri = "mongodb://127.0.0.1:27017,evil.example.com:27017/tallypulse_ci";
  const r = checkConnectionTarget(uri, { testMode: true });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes("non-loopback host"), `refused for the wrong reason: ${r.reason}`);
  assert.ok(!r.reason.includes("evil.example.com"), "remote host name leaked into reason");
});

// ---- multi-host (replica set) URIs
check("production accepts a valid multi-host replica-set URI", () => {
  const uri = "mongodb://a.example.com:27017,b.example.com:27017,c.example.com:27017/tallypulse?replicaSet=rs0";
  const r = checkConnectionTarget(uri, { testMode: false });
  assert.strictEqual(r.ok, true, r.reason);
  assert.deepStrictEqual(parseMongoUri(uri).hosts, ["a.example.com", "b.example.com", "c.example.com"]);
});
check("production accepts a multi-host URI with credentials and IPv6 hosts", () => {
  const uri = "mongodb://app:pw@[::1]:27017,10.0.0.5:27018/app?replicaSet=rs0";
  assert.strictEqual(checkConnectionTarget(uri, { testMode: false }).ok, true);
  assert.deepStrictEqual(parseMongoUri(uri).hosts, ["[::1]", "10.0.0.5"]);
});
check("test mode refuses a multi-host URI containing any remote host", () => {
  const uri = "mongodb://127.0.0.1:27017,db.example.com:27017/tallypulse_ci";
  assert.strictEqual(checkConnectionTarget(uri, { testMode: true }).ok, false);
});
check("test mode accepts a multi-host URI of loopback hosts with a test database name", () => {
  assert.strictEqual(checkConnectionTarget("mongodb://127.0.0.1:27017,localhost:27018/tallypulse_ci", { testMode: true }).ok, true);
});
check("test mode refuses a multi-host loopback URI with a non-test database name", () => {
  assert.strictEqual(checkConnectionTarget("mongodb://127.0.0.1:27017,localhost:27018/tallypulse", { testMode: true }).ok, false);
});

// ---- single host and SRV
check("single-host standard URI parses to one host and its db name", () => {
  assert.deepStrictEqual(parseMongoUri("mongodb://127.0.0.1:27017/tallypulse_ci"), {
    srv: false, hosts: ["127.0.0.1"], host: "127.0.0.1", dbName: "tallypulse_ci",
  });
});
check("SRV URI is a single host (not a comma list) and is accepted in production", () => {
  const uri = "mongodb+srv://user:pw@cluster0.example.net/app?retryWrites=true";
  assert.deepStrictEqual(parseMongoUri(uri), { srv: true, hosts: ["cluster0.example.net"], host: "cluster0.example.net", dbName: "app" });
  assert.strictEqual(checkConnectionTarget(uri, { testMode: false }).ok, true);
});
check("SRV URI with a comma-separated host list is malformed", () => {
  assert.strictEqual(parseMongoUri("mongodb+srv://a.example.net,b.example.net/app"), null);
  assert.strictEqual(checkConnectionTarget("mongodb+srv://a.example.net,b.example.net/app", { testMode: false }).ok, false);
});

// ---- malformed URIs are rejected in every mode
check("malformed URIs are rejected", () => {
  for (const uri of [
    "localhost:27017/db",          // no scheme
    "mongodb://",                  // no host
    "mongodb:///db",               // empty host
    "mongodb://a:27017,,b:27017/db", // empty host in the list
    "mongodb://host:abc/db",       // non-numeric port
    "mongodb://host:/db",          // empty port
    "mongodb://[::1/db",           // unclosed IPv6 bracket
    "http://127.0.0.1/tallypulse_ci",
  ]) {
    assert.strictEqual(parseMongoUri(uri), null, `parsed as valid: ${uri}`);
    assert.strictEqual(checkConnectionTarget(uri, { testMode: false }).ok, false, `production accepted: ${uri}`);
    assert.strictEqual(checkConnectionTarget(uri, { testMode: true }).ok, false, `test mode accepted: ${uri}`);
  }
});
check("test mode refuses a missing URI", () => {
  assert.strictEqual(checkConnectionTarget(undefined, { testMode: true }).ok, false);
});

// ---- connectGuarded: refuses before any network call, and never leaks the URI
const { connectGuarded } = require("./src/config/db");
const fs = require("fs");
const pathMod = require("path");

// Explicit test mode (not just the filename), and a spy on mongoose.connect: the refusal must
// happen before connect is ever called. If the guard failed, the spy would record a call and
// the real connect would be attempted, so this test must never reach the network.
async function connectGuardedRefusesAtlas() {
  const mongoose = require("mongoose");
  const saved = { uri: process.env.MONGODB_URI, mode: process.env.TALLYPULSE_TEST_MODE, connect: mongoose.connect };
  let connectCalls = 0;
  process.env.TALLYPULSE_TEST_MODE = "1";
  process.env.MONGODB_URI = ATLAS;
  mongoose.connect = () => {
    connectCalls += 1;
    return Promise.reject(new Error("spy: connect must not be reached for a refused target"));
  };
  try {
    await connectGuarded({ serverSelectionTimeoutMS: 10 });
    return "connectGuarded resolved for the Atlas URI in test mode";
  } catch (err) {
    if (connectCalls !== 0) return `mongoose.connect was called ${connectCalls} time(s) for a refused target`;
    if (err.refused !== true) return `expected err.refused === true, got ${err.refused}`;
    if (/S3cretPass|appuser|cluster0/.test(err.message)) return "refusal message leaked credentials or host";
    return null;
  } finally {
    mongoose.connect = saved.connect;
    if (saved.uri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = saved.uri;
    if (saved.mode === undefined) delete process.env.TALLYPULSE_TEST_MODE;
    else process.env.TALLYPULSE_TEST_MODE = saved.mode;
  }
}

// No verify-*.js may call mongoose.connect() directly: that would bypass the guard. Only db.js may.
function noDirectMongooseConnect() {
  const dir = pathMod.join(__dirname);
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((n) => /^verify-.*\.js$/.test(n) && n !== "verify-db-connection-guard.js")) {
    const text = fs.readFileSync(pathMod.join(dir, f), "utf8");
    if (/\bmongoose\.connect\(/.test(text)) offenders.push(f);
  }
  return offenders;
}

(async () => {
  const refusalProblem = await connectGuardedRefusesAtlas();
  if (refusalProblem) {
    failed += 1;
    console.log(`FAIL connectGuarded refuses Atlas: ${refusalProblem}`);
  } else {
    passed += 1;
  }

  check("no verify-*.js calls mongoose.connect() directly (all go through the guard)", () => {
    const offenders = noDirectMongooseConnect();
    assert.deepStrictEqual(offenders, [], `direct mongoose.connect() found in: ${offenders.join(", ")}`);
  });

  check("the three formerly-direct suites now use connectGuarded", () => {
    for (const f of ["verify-comparison-period-capability.js", "verify-growth-comparison-capability.js", "verify-semantic-foundation.js"]) {
      const text = fs.readFileSync(pathMod.join(__dirname, f), "utf8");
      assert.ok(text.includes("connectGuarded("), `${f} does not use connectGuarded`);
    }
  });

  console.log(`verify-db-connection-guard: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

