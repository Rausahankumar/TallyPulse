// --------------------------------------------------
// Small in-process rate limiter (audit finding F-04).
//
// Deliberately NOT a shared store (Redis etc.): TallyPulse runs as one backend
// process, and the goal is to stop password guessing and account-creation
// floods, not to meter an API. If the backend is ever run as several
// instances, move the counters to a shared store then - not before.
//
// How it works: every request maps to a key (for example the client IP plus the
// e-mail being tried). Each key gets `max` requests per `windowMs`; the request
// after that is answered 429 with a Retry-After header. With
// `refundOnSuccess` a request that ends with a status below 400 gives its slot
// back, so only FAILED attempts use up the budget and a person who logs in
// correctly is never locked out by their own successful logins.
//
// Behind a reverse proxy, set Express `trust proxy` so `req.ip` is the real
// client address; otherwise every client shares the proxy's address.
// --------------------------------------------------

const registry = new Set();

function createRateLimiter({
  name = "limiter",
  windowMs,
  max,
  keyFn,
  message = "Too many attempts. Please wait a few minutes and try again.",
  refundOnSuccess = false,
  maxKeys = 10000,
}) {
  const hits = new Map(); // key -> { count, resetAt }

  function sweep(now) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }

  // Housekeeping so memory cannot grow without bound; never keeps the process alive.
  const timer = setInterval(() => sweep(Date.now()), Math.min(windowMs, 60 * 1000));
  if (typeof timer.unref === "function") timer.unref();

  function middleware(req, res, next) {
    const key = keyFn(req);
    if (key === null || key === undefined) return next();

    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.delete(key); // re-insert so Map order stays oldest-first
      hits.set(key, entry);

      if (hits.size > maxKeys) {
        sweep(now);
        // Still full of live entries (a flood of distinct keys): drop the oldest.
        while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      }
    }

    if (entry.count >= max) {
      // One line per window when the limit is first hit (never the key: it can contain an e-mail address).
      if (!entry.logged) {
        entry.logged = true;
        console.warn(`[rateLimit] "${name}" limit reached from ${clientIp(req)} request=${req.id || "-"}`);
      }

      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ success: false, message, retryAfterSeconds });
    }

    entry.count += 1;

    if (refundOnSuccess) {
      res.on("finish", () => {
        if (res.statusCode < 400 && entry.count > 0) entry.count -= 1;
      });
    }

    return next();
  }

  middleware.reset = () => hits.clear();
  registry.add(middleware);
  return middleware;
}

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

// The e-mail part of a login key: only a real string is used (anything else is
// rejected by the controller anyway), trimmed, lower-cased and length-capped so
// the key cannot be used to bloat memory.
const emailKey = (req) => {
  const email = req.body && req.body.email;
  return typeof email === "string" ? email.trim().toLowerCase().slice(0, 254) : "";
};

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

// Login: at most 10 failed attempts per client + e-mail per 15 minutes, and at
// most 100 failed attempts per client overall (so one client cannot walk a list
// of e-mail addresses).
const loginLimiters = [
  createRateLimiter({ name: "login (per address + e-mail)", windowMs: FIFTEEN_MINUTES, max: 10, refundOnSuccess: true, keyFn: (req) => `login|${clientIp(req)}|${emailKey(req)}` }),
  createRateLimiter({ name: "login (per address)", windowMs: FIFTEEN_MINUTES, max: 100, refundOnSuccess: true, keyFn: (req) => `login-ip|${clientIp(req)}` }),
];

// Register: every attempt counts (a flood of new accounts is the abuse).
const registerLimiter = createRateLimiter({
  name: "register",
  windowMs: ONE_HOUR,
  max: 20,
  keyFn: (req) => `register|${clientIp(req)}`,
  message: "Too many accounts were created from this address. Please try again later.",
});

// Connect / re-authorize a company: this endpoint re-checks the account password
// for a signed-in user, so it is also a password-guessing surface. Keyed by user.
const connectCompanyLimiter = createRateLimiter({
  name: "connect company",
  windowMs: FIFTEEN_MINUTES,
  max: 10,
  refundOnSuccess: true,
  keyFn: (req) => (req.user && req.user.id ? `connect|${req.user.id}` : null),
});

// For tests: forget every counter.
function resetAllRateLimiters() {
  for (const limiter of registry) limiter.reset();
}

module.exports = {
  createRateLimiter,
  loginLimiters,
  registerLimiter,
  connectCompanyLimiter,
  resetAllRateLimiters,
};
