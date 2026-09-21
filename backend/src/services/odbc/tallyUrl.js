// --------------------------------------------------
// Which addresses may TallyPulse send Tally requests to? (audit finding F-10)
//
// Each company can carry its own `tallyConnection.baseUrl`. No API sets it today
// (only direct database edits do), but it is used as the destination of every
// Tally request, so it is checked at the moment of use - a bad value fails
// closed instead of turning the backend into a proxy for other internal
// services.
//
// Rules:
//   - must be an http:// or https:// URL, with no user name / password in it
//   - link-local addresses are refused: 169.254.0.0/16 (this is where cloud
//     metadata services live, e.g. 169.254.169.254), fe80::/10, the AWS IPv6
//     metadata address, and the unspecified addresses 0.0.0.0/8 and ::
//   - well-known metadata host names are refused
//
// Loopback (localhost) and private LAN addresses (192.168.x.x, 10.x.x.x, ...)
// are ALLOWED on purpose: TallyPrime is a desktop application, usually on the
// same machine or the same office network, so those are the normal case.
//
// Known limit: only the literal address / host name is checked. A DNS name that
// resolves to a blocked address is not caught here.
// --------------------------------------------------

const net = require("net");

const blocked = new net.BlockList();
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addAddress("fd00:ec2::254", "ipv6");
blocked.addAddress("::", "ipv6");

const BLOCKED_HOSTNAMES = new Set(["metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal"]);

const MAX_URL_LENGTH = 2048;

function fail(reason) {
  return new Error(`Invalid Tally connection URL: ${reason}`);
}

// Returns the URL (trimmed, otherwise unchanged) when it is acceptable; throws otherwise.
function assertSafeTallyUrl(input) {
  if (typeof input !== "string" || !input.trim()) throw fail("it must be a non-empty text value.");

  const text = input.trim();

  if (text.length > MAX_URL_LENGTH) throw fail("it is too long.");

  let url;
  try {
    url = new URL(text);
  } catch {
    throw fail("it is not a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") throw fail("only http:// and https:// are allowed.");
  if (url.username || url.password) throw fail("user names and passwords in the URL are not allowed.");

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (!host) throw fail("it has no host name.");
  if (BLOCKED_HOSTNAMES.has(host)) throw fail("that host is not allowed.");

  const family = net.isIP(host);
  if (family && blocked.check(host, family === 6 ? "ipv6" : "ipv4")) throw fail("that address is not allowed.");

  return text;
}

function isSafeTallyUrl(input) {
  try {
    assertSafeTallyUrl(input);
    return true;
  } catch {
    return false;
  }
}

// The URL to use for a request: the company's own, or the default when none is set.
function resolveTallyUrl(baseUrl, defaultUrl) {
  return assertSafeTallyUrl(baseUrl || defaultUrl);
}

module.exports = { assertSafeTallyUrl, isSafeTallyUrl, resolveTallyUrl };
