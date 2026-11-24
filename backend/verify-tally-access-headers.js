/**
 * Cloudflare Access headers on Tally requests (services/odbc/tallyAccess.js), through the real odbcService.
 * Offline: axios is replaced by a recorder, so no request leaves the machine and no Tally is needed.
 * Run: node verify-tally-access-headers.js
 */
const path = require("path");
const { createChecker } = require("./test/check");

const t = createChecker();
const check = t.check;

// Fake axios: records every post and answers with an empty Tally-looking body.
const posts = [];
const axiosFile = require.resolve("axios");
require.cache[axiosFile] = { id: axiosFile, filename: axiosFile, loaded: true, exports: { post: async (url, body, config) => { posts.push({ url, config }); return { status: 200, data: { collection: [] } }; } } };

const ID = "test-client-id.access";
const SECRET = "test-secret-value-not-real";
const setEnv = (e) => { for (const k of ["TALLY_URL", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]) { if (e[k] === undefined) delete process.env[k]; else process.env[k] = e[k]; } };
const loadService = () => { for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}services${path.sep}odbc${path.sep}`)) delete require.cache[k]; return require("./src/services/odbc/odbcService"); };
const lastHeaders = () => posts[posts.length - 1].config.headers;

(async () => {
  const origWarn = console.warn;
  let warnings = 0;
  console.warn = () => { warnings += 1; };

  // 1. Not configured (the normal local setup): requests are exactly as before.
  setEnv({ TALLY_URL: "https://tally.example.test" });
  let svc = loadService();
  await svc.getCompanyInfo();
  check("A1", "no token configured: no Access headers", Object.keys(lastHeaders()).filter((k) => k.startsWith("CF-")), []);
  check("A2", "no token configured: redirects are not disabled", posts[0].config.maxRedirects, undefined);
  check("A3", "no token configured: Tally's own headers are unchanged", lastHeaders().TallyRequest, "Export");

  // 2. Configured, Tally at an https address: every Tally request carries the token and keeps its own headers.
  setEnv({ TALLY_URL: "https://tally.example.test", CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET });
  svc = loadService();
  const before = posts.length;
  await svc.getCompanyInfo();
  await svc.getVoucherTypeMasters();
  await svc.getLedgerMasters();
  await svc.getSalesVouchersSinceAlterId({ afterAlterId: 0, voucherTypeNames: ["Sales"] });
  await svc.getVouchersByAlterIds({ alterIds: [1], voucherTypeNames: ["Sales"] });
  check("B1", "five different Tally calls were made", posts.length - before, 5);
  check("B2", "every one carries the client id", posts.slice(before).map((p) => p.config.headers["CF-Access-Client-Id"]), Array(5).fill(ID));
  check("B3", "every one carries the client secret", posts.slice(before).map((p) => p.config.headers["CF-Access-Client-Secret"]), Array(5).fill(SECRET));
  check("B4", "Tally's own headers are kept next to them", posts.slice(before).every((p) => p.config.headers.TallyRequest === "Export" && p.config.headers["Content-Type"] === "application/json"), true);
  check("B5", "the request timeout is kept", posts.slice(before).map((p) => p.config.timeout), [15000, 30000, 30000, 30000, 30000]);
  check("B6", "a redirect (Access login page) is not followed", posts.slice(before).every((p) => p.config.maxRedirects === 0), true);

  // 3. The secret never goes to another address, and never over plain http.
  await svc.getCompanyInfo({ baseUrl: "https://other-host.example.test" });
  check("C1", "a per-company address on another host gets no token", Object.keys(lastHeaders()).filter((k) => k.startsWith("CF-")), []);
  setEnv({ TALLY_URL: "http://tally.example.test", CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET });
  svc = loadService();
  await svc.getCompanyInfo();
  check("C2", "TALLY_URL over plain http: no token is sent", Object.keys(lastHeaders()).filter((k) => k.startsWith("CF-")), []);
  setEnv({ CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET });
  svc = loadService();
  await svc.getCompanyInfo();
  check("C3", "TALLY_URL unset (local default): no token is sent", Object.keys(lastHeaders()).filter((k) => k.startsWith("CF-")), []);

  // 4. Half a token is refused, with one warning, never sent.
  setEnv({ TALLY_URL: "https://tally.example.test", CF_ACCESS_CLIENT_ID: ID });
  svc = loadService();
  warnings = 0;
  await svc.getCompanyInfo();
  await svc.getCompanyInfo();
  check("D1", "only the id set: nothing is sent", Object.keys(lastHeaders()).filter((k) => k.startsWith("CF-")), []);
  check("D2", "and the operator is warned once, not on every request", warnings, 1);

  // 5. The secret is never part of an error line the service logs.
  setEnv({ TALLY_URL: "https://tally.example.test", CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET });
  svc = loadService();
  const logged = [];
  const origError = console.error;
  console.error = (...a) => logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  require("axios").post = async () => { const e = new Error("connect ECONNREFUSED"); e.config = { headers: { "CF-Access-Client-Secret": SECRET } }; throw e; };
  let threw = false;
  try { await svc.getCompanyInfo(); } catch { threw = true; }
  console.error = origError;
  check("E1", "a failed request still throws", threw, true);
  check("E2", "the secret does not appear in the logged error", logged.some((l) => l.includes(SECRET)), false);

  // 6. The start-up line and the production warning (never prints the token).
  const { describeTallyTarget } = require("./src/services/odbc/tallyAccess");
  const tunnel = describeTallyTarget({ TALLY_URL: "https://tally.example.test/x", CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET, NODE_ENV: "production" });
  check("F1", "a tunnel address: its host and 'token set', no warning", [tunnel.line, tunnel.warning], ["[server] Tally: https://tally.example.test, Cloudflare Access token set", null]);
  check("F2", "the start-up line never holds the token", JSON.stringify(tunnel).includes(SECRET) || JSON.stringify(tunnel).includes(ID), false);
  check("F3", "production with TALLY_URL unset: a warning", !!describeTallyTarget({ NODE_ENV: "production" }).warning, true);
  check("F4", "production with TALLY_URL on localhost: a warning", !!describeTallyTarget({ NODE_ENV: "production", TALLY_URL: "http://localhost:9000" }).warning, true);
  check("F5", "development with localhost: no warning", describeTallyTarget({ TALLY_URL: "http://localhost:9000" }).warning, null);
  check("F7", "IPv6 localhost in production: a warning", !!describeTallyTarget({ NODE_ENV: "production", TALLY_URL: "http://[::1]:9000" }).warning, true);
  check("F8", "127.0.0.1 in production: a warning", !!describeTallyTarget({ NODE_ENV: "production", TALLY_URL: "http://127.0.0.1:9000" }).warning, true);
  check("F9", "a look-alike host (dots are not wildcards) is not local", describeTallyTarget({ NODE_ENV: "production", TALLY_URL: "https://127x0y0z1" }).warning, null);
  check("F6", "a private LAN address in production is not called local", describeTallyTarget({ NODE_ENV: "production", TALLY_URL: "http://192.168.1.20:9000" }).warning, null);

  console.warn = origWarn;
  console.log(t.summary());
  process.exit(t.fail > 0 ? 1 : 0);
})();
