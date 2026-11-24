// --------------------------------------------------
// Reaching Tally through a Cloudflare Tunnel protected by Cloudflare Access.
//
// TallyPrime has no login of its own. When the backend runs in the cloud (for example on Render) it reaches Tally through a
// Cloudflare Tunnel, and Cloudflare Access only lets a request in when it carries a service token. This file adds that
// token's two headers to Tally requests. Nothing changes when the two env values are not set (the normal local setup).
//
//   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET   the service token (set both, or neither)
//
// The secret is sent only to the address in TALLY_URL, and only over https. It is never sent to a per-company
// `tallyConnection.baseUrl` on another host, and never over plain http.
// --------------------------------------------------

const ID_HEADER = "CF-Access-Client-Id";
const SECRET_HEADER = "CF-Access-Client-Secret";

let warnedHalfConfigured = false;

function configured() {
  const id = (process.env.CF_ACCESS_CLIENT_ID || "").trim();
  const secret = (process.env.CF_ACCESS_CLIENT_SECRET || "").trim();
  if (id && secret) return { id, secret };
  if ((id || secret) && !warnedHalfConfigured) {
    warnedHalfConfigured = true;
    console.warn("[tally] CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must both be set; sending no Access headers.");
  }
  return null;
}

function originOf(text) {
  try {
    return new URL(text).origin;
  } catch {
    return null;
  }
}

// The extra axios options for a request to `url`: {} unless the token applies to that address.
function tallyAccessOptions(url) {
  const token = configured();
  if (!token) return {};
  const target = originOf(url);
  const tallyOrigin = originOf(process.env.TALLY_URL || "");
  if (!target || !tallyOrigin || target !== tallyOrigin || !target.startsWith("https://")) return {};
  // A wrong or expired token makes Cloudflare answer with a redirect to its login page; do not follow it (the sync would
  // otherwise read an HTML page as a Tally answer) - the redirect surfaces as a clear request error instead.
  return { headers: { [ID_HEADER]: token.id, [SECRET_HEADER]: token.secret }, maxRedirects: 0 };
}

// axios.post for a Tally request: the same call, plus the Access headers when they apply.
function postToTally(axios, url, body, config = {}) {
  const extra = tallyAccessOptions(url);
  if (!extra.headers) return axios.post(url, body, config);
  return axios.post(url, body, { ...config, ...extra, headers: { ...(config.headers || {}), ...extra.headers } });
}

// One line for the start-up log, and a warning when the sync cannot work: a deployed (production) backend that still points at
// this machine's own localhost has no Tally to read, so every sync would fail. Never prints the token.
function describeTallyTarget(env = process.env) {
  const raw = (env.TALLY_URL || "").trim();
  const origin = originOf(raw);
  const local = !raw || !origin || /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(new URL(origin).hostname);
  const tokenSet = !!((env.CF_ACCESS_CLIENT_ID || "").trim() && (env.CF_ACCESS_CLIENT_SECRET || "").trim());
  const line = `[server] Tally: ${local ? "local (localhost)" : origin}${tokenSet ? ", Cloudflare Access token set" : ""}`;
  const warning = env.NODE_ENV === "production" && local
    ? "TALLY_URL is unset or points at localhost in production: the sync cannot reach Tally from this server (set TALLY_URL to the tunnel address)."
    : null;
  return { line, warning };
}

module.exports = { tallyAccessOptions, postToTally, describeTallyTarget, ID_HEADER, SECRET_HEADER };
