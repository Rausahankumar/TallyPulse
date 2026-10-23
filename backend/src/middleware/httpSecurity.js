// --------------------------------------------------
// HTTP hardening (audit finding F-11): security headers and a CORS allow-list.
//
// Used by server.js AND by the security probe suite, so the probes test the
// exact configuration the real server runs.
//
// CORS: the API uses a bearer token in the Authorization header (not cookies),
// so this is defence in depth, not the only line of defence - but a browser
// page from an unknown origin should still be unable to read API responses.
// Allowed origins come from CORS_ORIGINS (comma-separated). If it is not set,
// only the local development origins are allowed - a deployed frontend on
// another origin MUST be listed there, otherwise the browser will block it.
// Requests without an Origin header (curl, server-to-server, the Vite dev
// proxy) are not affected.
// --------------------------------------------------

const cors = require("cors");
const helmet = require("helmet");

const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

function parseAllowedOrigins(value) {
  const list = String(value || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  return list.length > 0 ? list : DEV_ORIGINS;
}

function applyHttpSecurity(app, { allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGINS) } = {}) {
  // helmet() sends the standard header set (Content-Security-Policy,
  // Strict-Transport-Security, X-Content-Type-Options, X-Frame-Options, ...)
  // and removes X-Powered-By.
  app.disable("x-powered-by");
  app.use(helmet());

  app.use(
    cors({
      // An origin that is not on the list simply gets no CORS headers, so the
      // browser refuses to expose the response to that page.
      origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
    })
  );

  return allowedOrigins;
}

module.exports = { applyHttpSecurity, parseAllowedOrigins, DEV_ORIGINS };
