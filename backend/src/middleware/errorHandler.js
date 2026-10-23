// --------------------------------------------------
// Error responses (audit finding F-12).
//
// Rule: what a client sees is a message WE chose. Library and database error
// text (Mongoose model names, bcrypt/parser messages, stack details) is logged
// on the server and never sent. Used by server.js and by the probe suite.
//
// - Errors thrown on purpose with a user-facing message set `userFacing = true`
//   (and a 4xx `status`); only those messages are passed through.
// - Known framework errors (bad JSON, body too large, multer upload limits) get
//   a fixed, friendly message.
// - Anything else with a 4xx status gets a generic message for that status;
//   anything else at all is a generic 500.
// --------------------------------------------------

const GENERIC_SERVER_ERROR = "Something went wrong on the server. Please try again.";

const STATUS_TEXT = {
  400: "The request could not be understood.",
  401: "Authentication is required.",
  403: "You are not allowed to do that.",
  404: "Not found.",
  409: "The request conflicts with the current state.",
  413: "The request is too large.",
  415: "Unsupported content type.",
  429: "Too many requests. Please try again later.",
};

const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: { status: 413, message: "The file is too large." },
  LIMIT_UNEXPECTED_FILE: { status: 400, message: 'Unexpected file field. Send the file in a field named "file".' },
  LIMIT_FILE_COUNT: { status: 400, message: "Too many files were uploaded." },
  LIMIT_PART_COUNT: { status: 400, message: "The upload has too many parts." },
  LIMIT_FIELD_KEY: { status: 400, message: "The upload could not be processed." },
  LIMIT_FIELD_VALUE: { status: 400, message: "The upload could not be processed." },
  LIMIT_FIELD_COUNT: { status: 400, message: "The upload could not be processed." },
};

// Error to throw for a client mistake whose message is safe to show.
function userError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.userFacing = true;
  return err;
}

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: "Route not found" });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let status = err && (err.status || err.statusCode);
  let message;

  if (err && err.type === "entity.parse.failed") {
    status = 400;
    message = "The request body is not valid JSON.";
  } else if (err && err.type === "entity.too.large") {
    status = 413;
    message = STATUS_TEXT[413];
  } else if (err && err.name === "MulterError") {
    const known = MULTER_MESSAGES[err.code] || { status: 400, message: "The upload could not be processed." };
    status = known.status;
    message = known.message;
  } else if (err && err.userFacing === true && status >= 400 && status < 500) {
    message = err.message;
  } else if (status >= 400 && status < 500) {
    message = STATUS_TEXT[status] || STATUS_TEXT[400];
  } else {
    // Unexpected: keep the detail in the server log only, under the request id
    // (the same id is in the response, so a user can quote it to find this line).
    console.error(`UNHANDLED ERROR request=${(req && req.id) || "-"} ${req && req.method} ${req && req.originalUrl && req.originalUrl.split("?")[0]}:`, err);
    status = 500;
    message = GENERIC_SERVER_ERROR;
  }

  const body = { success: false, message };

  if (status >= 500 && req && req.id) body.requestId = req.id;

  return res.status(status).json(body);
}

module.exports = { errorHandler, notFoundHandler, userError, GENERIC_SERVER_ERROR };
