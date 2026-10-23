// --------------------------------------------------
// Request id (audit finding F-19).
//
// Every request gets an id, sent back in the X-Request-Id response header, and
// the error log lines carry the same id - so "this request failed" can be traced
// to exactly one place in the server log, and one user's report to one line.
//
// An id sent by the client is only reused when it is short and plain
// (letters, digits, dashes, underscores) - anything else is replaced, so it
// cannot be used to inject text into the log.
// --------------------------------------------------

const crypto = require("crypto");

const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

function requestId(req, res, next) {
  const incoming = req.headers["x-request-id"];

  req.id = typeof incoming === "string" && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);

  next();
}

module.exports = requestId;
