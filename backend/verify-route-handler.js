/**
 * routeHandler (middleware/errorHandler.js): the one copy of the wrapper the analytics and report controllers use.
 * What it must keep doing (it replaced two identical copies):
 *   - an error with a 4xx `status` is answered with that status and ITS OWN message (the controllers write those messages);
 *   - any other error (no status, or 5xx) is answered 500 with the generic message, never the error text, and is logged
 *     under the controller's label;
 *   - a handler that does not throw is left alone.
 * It is deliberately NOT the same rule as the central errorHandler (which shows a 4xx message only for `userFacing` errors).
 * Offline: no database, no network. Run: node verify-route-handler.js
 */
const assert = require("assert");
const { routeHandler, errorHandler, userError, GENERIC_SERVER_ERROR } = require("./src/middleware/errorHandler");

let pass = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass += 1; console.log("PASS |", name); }, (e) => { realError("FAIL |", name, "-", e.message); process.exitCode = 1; });

const fakeRes = () => { const r = { code: null, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const withErr = (status, message) => Object.assign(new Error(message), status === undefined ? {} : { status });
const logged = [];
const realError = console.error;

(async () => {
  console.error = (...a) => logged.push(a);
  try {
    const handle = routeHandler("TEST ERROR");

    await check("a 4xx error keeps its status and its own message", async () => {
      const res = fakeRes();
      await handle(async () => { throw withErr(400, 'Invalid period "x".'); })({}, res);
      assert.strictEqual(res.code, 400);
      assert.deepStrictEqual(res.body, { success: false, message: 'Invalid period "x".' });
    });

    await check("another 4xx (404) is passed through the same way", async () => {
      const res = fakeRes();
      await handle(async () => { throw withErr(404, "Not here."); })({}, res);
      assert.strictEqual(res.code, 404);
      assert.strictEqual(res.body.message, "Not here.");
    });

    await check("an error with no status is a 500 with the generic message (the text is not leaked) and is logged under the label", async () => {
      logged.length = 0;
      const res = fakeRes();
      await handle(async () => { throw new Error("mongo secret detail"); })({}, res);
      assert.strictEqual(res.code, 500);
      assert.deepStrictEqual(res.body, { success: false, message: GENERIC_SERVER_ERROR });
      assert.strictEqual(logged.length, 1);
      assert.strictEqual(logged[0][0], "TEST ERROR:");
    });

    await check("a 5xx status is still the generic 500, not the message", async () => {
      logged.length = 0;
      const res = fakeRes();
      await handle(async () => { throw withErr(503, "db down at 10.0.0.5"); })({}, res);
      assert.strictEqual(res.code, 500);
      assert.strictEqual(res.body.message, GENERIC_SERVER_ERROR);
    });

    await check("a 4xx error is NOT logged as a server error", async () => {
      logged.length = 0;
      await handle(async () => { throw withErr(400, "bad"); })({}, fakeRes());
      assert.strictEqual(logged.length, 0);
    });

    await check("a handler that does not throw is untouched (it answers itself)", async () => {
      const res = fakeRes();
      await handle(async (req, r) => r.status(200).json({ success: true }))({}, res);
      assert.strictEqual(res.code, 200);
      assert.deepStrictEqual(res.body, { success: true });
    });

    await check("the generic message is the one the controllers always used", async () => {
      assert.strictEqual(GENERIC_SERVER_ERROR, "Something went wrong on the server. Please try again.");
    });

    await check("the two rules stay different: central errorHandler hides a 4xx message unless userFacing", async () => {
      const mk = (err) => { const res = fakeRes(); errorHandler(err, { id: "r1" }, res, () => {}); return res; };
      assert.notStrictEqual(mk(withErr(400, "private wording")).body.message, "private wording");
      assert.strictEqual(mk(userError(400, "shown to the user")).body.message, "shown to the user");
    });

    await check("both controllers load and use the shared wrapper (no local copy)", async () => {
      const fs = require("fs");
      for (const f of ["analyticsController.js", "reportController.js"]) {
        const src = fs.readFileSync(require("path").join(__dirname, "src/controllers", f), "utf8");
        assert.ok(/routeHandler\("[A-Z ]+ERROR"\)/.test(src), f + " uses routeHandler");
        assert.ok(!/function handle\(/.test(src), f + " has no local handle()");
        require("./src/controllers/" + f);
      }
    });
  } finally {
    console.error = realError;
  }
  console.log(`\nverify-route-handler: ${pass} checks passed${process.exitCode ? " (some FAILED)" : ""}`);
})();
