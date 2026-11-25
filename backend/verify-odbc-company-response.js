/**
 * GET /api/odbc/company (odbcController.testTallyConnection): the response carries the connection state and the detected company
 * NAME, and never Tally's raw company report (any logged-in user could otherwise read which companies the shared Tally has open).
 * An unreachable Tally is still an error response, as before. Offline: the two Tally-facing modules are replaced by stubs.
 * Run: node verify-odbc-company-response.js
 */
const assert = require("assert");
const path = require("path");

const stubModule = (rel, exports) => { const file = require.resolve(path.join(__dirname, "src", rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };

let calls = 0;
let companyInfo = async () => { calls += 1; return { status: 200, data: { collection: [{ NAME: "SECRET OPEN COMPANY LTD" }] } }; };
let detection = async () => ({ ok: true, match: { name: "Acme Traders", guid: "g-1" } });
stubModule("services/odbc/odbcService.js", { getCompanyInfo: (...a) => companyInfo(...a), getSalesVouchers: async () => ({}) });
stubModule("services/auth/tallyCompanyGuard.js", { resolveSelectedOpenCompany: (...a) => detection(...a) });

const { testTallyConnection } = require("./src/controllers/odbcController");

const fakeRes = () => { const r = { code: null, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
let pass = 0;
const check = async (name, fn) => { try { await fn(); pass += 1; console.log("PASS |", name); } catch (e) { console.log("FAIL |", name, "-", e.message); process.exitCode = 1; } };

(async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    await check("success: 200, connection state and detected company name, no raw `data`", async () => {
      const res = fakeRes();
      await testTallyConnection({}, res);
      assert.strictEqual(res.code, 200);
      assert.strictEqual(res.body.success, true);
      assert.deepStrictEqual(res.body.detected, { state: "ok", companyName: "Acme Traders" });
      assert.ok(!("data" in res.body), "response must not carry `data`");
      assert.ok(!JSON.stringify(res.body).includes("SECRET OPEN COMPANY"), "raw company report leaked");
      assert.strictEqual(calls, 1, "the reachability probe still runs");
    });

    await check("several companies open: state 'ambiguous', still no raw data", async () => {
      detection = async () => ({ ok: false, reason: "multiple_open", message: "More than one company is open." });
      const res = fakeRes();
      await testTallyConnection({}, res);
      assert.strictEqual(res.body.detected.state, "ambiguous");
      assert.ok(!("data" in res.body));
    });

    await check("Tally unreachable: still an error response (500), nothing from Tally in it", async () => {
      companyInfo = async () => { throw new Error("ECONNREFUSED 10.0.0.9:9000"); };
      const res = fakeRes();
      await testTallyConnection({}, res);
      assert.strictEqual(res.code, 500);
      assert.strictEqual(res.body.success, false);
      assert.ok(!JSON.stringify(res.body).includes("ECONNREFUSED"), "internal error text leaked");
    });
  } finally {
    console.error = origError;
  }
  console.log(`\nverify-odbc-company-response: ${pass} checks passed${process.exitCode ? " (some FAILED)" : ""}`);
})();
