/**
 * Two production safeguards, tested on a real Express app over a loopback socket (no database, no network beyond 127.0.0.1):
 *  1. TRUST_PROXY (httpSecurity.parseTrustProxy + app.set("trust proxy")): behind a proxy every client reaches the app from the
 *     proxy's address, so a per-address limit is one bucket for everybody. With the proxy count set, X-Forwarded-For gives each
 *     client its own bucket; with it unset (a direct connection) the header is ignored, so a client cannot choose its own address.
 *  2. chatLimiters (rateLimit.js): the paid chat route is limited per signed-in user, per minute and per day; one user's
 *     questions never use up another's; both question routes are wired to it and the read-only ones are not.
 * Run: node verify-proxy-and-chat-limits.js
 */
process.env.CHAT_MAX_PER_MINUTE = "3"; // read once when rateLimit.js loads
process.env.CHAT_MAX_PER_DAY = "5";

const http = require("http");
const express = require("express");
const { parseTrustProxy } = require("./src/middleware/httpSecurity");
const { createRateLimiter, chatLimiters, resetAllRateLimiters } = require("./src/middleware/rateLimit");
const { createChecker } = require("./test/check");

const t = createChecker();
const check = t.check;

function listen(app) {
  return new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })); });
}
function get(port, path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => { let json = null; try { json = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, retryAfter: res.headers["retry-after"], json }); });
    });
    req.on("error", reject); req.end();
  });
}
const close = (s) => new Promise((r) => s.close(r));

(async () => {
  // ---------------------------------------------------------------- 1. TRUST_PROXY value parsing
  console.log("=== TRUST_PROXY parsing ===");
  const cases = [["1", 1], ["2", 2], [" 3 ", 3], [undefined, null], ["", null], ["0", null], ["-1", null], ["1.5", null], ["abc", null], ["true", null], ["1000", null], [1, 1]];
  // strict equality: JSON would show NaN and null as the same thing
  for (const [input, want] of cases) check(`parse ${JSON.stringify(input)}`, `TRUST_PROXY value is exactly ${want}`, parseTrustProxy(input) === want, true);

  // ---------------------------------------------------------------- 2. per-address limit behind a proxy
  console.log("\n=== per-address limit with and without trust proxy ===");
  async function addressApp(trust) {
    const app = express();
    if (trust !== null) app.set("trust proxy", trust);
    const limiter = createRateLimiter({ name: `addr-${trust}`, windowMs: 60000, max: 2, keyFn: (req) => `addr|${req.ip}` });
    app.get("/x", limiter, (req, res) => res.json({ ip: req.ip }));
    return listen(app);
  }
  {
    const { server, port } = await addressApp(1);
    const a = [await get(port, "/x", { headers: { "X-Forwarded-For": "203.0.113.5" } }), await get(port, "/x", { headers: { "X-Forwarded-For": "203.0.113.5" } }), await get(port, "/x", { headers: { "X-Forwarded-For": "203.0.113.5" } })];
    const other = await get(port, "/x", { headers: { "X-Forwarded-For": "198.51.100.9" } });
    check("proxy on: the same client is limited after its 2nd request", "statuses of one client", a.map((r) => r.status), [200, 200, 429]);
    check("proxy on: a different client has its own bucket", "second client", other.status, 200);
    check("proxy on: the real client address is read from X-Forwarded-For", "req.ip", a[0].json.ip, "203.0.113.5");
    await close(server);
  }
  {
    const { server, port } = await addressApp(null);
    const s = [];
    for (let i = 0; i < 3; i++) s.push((await get(port, "/x", { headers: { "X-Forwarded-For": `10.0.0.${i}` } })).status);
    check("proxy off: X-Forwarded-For is ignored, so changing it does not give a client a fresh bucket", "statuses with 3 different forwarded addresses", s, [200, 200, 429]);
    await close(server);
  }

  // ---------------------------------------------------------------- 3. chat limiter
  console.log("\n=== chat limiter (3 per minute, 5 per day in this test) ===");
  resetAllRateLimiters();
  const app = express();
  app.use((req, res, next) => { const u = req.headers["x-test-user"]; if (u) req.user = { id: u }; next(); });
  app.post("/ask", ...chatLimiters, (req, res) => res.json({ ok: true }));
  const { server, port } = await listen(app);
  const ask = (user) => get(port, "/ask", { method: "POST", headers: user ? { "X-Test-User": user } : {} });

  const alice = [];
  for (let i = 0; i < 4; i++) alice.push(await ask("alice"));
  check("a user may ask 3 questions a minute, the 4th is refused (429)", "alice statuses", alice.map((r) => r.status), [200, 200, 200, 429]);
  check("the refusal says why and when to retry", "429 body", [alice[3].json.success, typeof alice[3].json.message, Number(alice[3].retryAfter) > 0], [false, "string", true]);
  const bob = await ask("bob");
  check("another user is not affected by alice's questions", "bob status", bob.status, 200);

  resetAllRateLimiters();
  const day = [];
  for (let i = 0; i < 6; i++) { day.push((await ask("carol")).status); if (i === 2) { /* minute window is 3: wait it out by resetting only that counter */ chatLimiters[0].reset(); } }
  check("the daily limit stops a user at 5 even when the per-minute counter is fresh", "carol statuses", day, [200, 200, 200, 200, 200, 429]);

  resetAllRateLimiters();
  const anon = [];
  for (let i = 0; i < 5; i++) anon.push((await ask(null)).status);
  check("no signed-in user = no key (auth comes first in the real route), so the limiter does not block", "anonymous statuses", anon, [200, 200, 200, 200, 200]);
  await close(server);

  // ---------------------------------------------------------------- 4. wiring of the real chat routes
  console.log("\n=== the real chat routes ===");
  const router = require("./src/routes/chatRoutes");
  const layers = router.stack.filter((l) => l.route).map((l) => ({ path: l.route.path, method: Object.keys(l.route.methods)[0], handlers: l.route.stack.map((s) => s.handle) }));
  const limited = (l) => chatLimiters.every((lim) => l.handlers.includes(lim));
  const find = (m, p) => layers.find((l) => l.method === m && l.path === p);
  check("POST /message is rate-limited", "wired", limited(find("post", "/message")), true);
  check("POST /:chatId/message is rate-limited", "wired", limited(find("post", "/:chatId/message")), true);
  check("the read-only and housekeeping routes are not limited (list, open, rename, delete)", "wired", [find("get", "/"), find("get", "/:chatId"), find("patch", "/:chatId"), find("delete", "/:chatId")].map(limited), [false, false, false, false]);
  const order = find("post", "/message").handlers;
  check("the limiters run before the controller", "limiters before last handler", chatLimiters.every((lim) => order.indexOf(lim) < order.length - 1), true);

  console.log(t.summary());
  process.exit(t.fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
