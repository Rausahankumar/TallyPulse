const { getCompanyInfo } = require("../odbc/odbcService");
const { extractOpenCompanies } = require("../parser/tallyParser");

const UNREACHABLE_MESSAGE =
  "Could not reach TallyPrime to verify the company. Make sure TallyPrime is running and reachable, then try again.";
const NO_COMPANY_MESSAGE =
  "No company is currently open in TallyPrime. Open the company you want to connect in TallyPrime and try again.";

// Asks Tally directly, live, which companies are open right now. The one
// place that talks to Tally for company identity; both guards below use it.
async function readOpenCompanies({ baseUrl } = {}) {
  let rawResponse;

  try {
    rawResponse = await getCompanyInfo({ baseUrl });
  } catch (error) {
    return { ok: false, reason: "unreachable", openCompanies: [], message: UNREACHABLE_MESSAGE };
  }

  const openCompanies = extractOpenCompanies(rawResponse);

  if (openCompanies.length === 0) {
    return { ok: false, reason: "no_company_open", openCompanies, message: NO_COMPANY_MESSAGE };
  }

  return { ok: true, openCompanies };
}

// Central safety check reused by both "add another company" (verify the
// requested GUID is the one actually open in Tally before linking it to
// the account) and the live Sales Sync import (never import vouchers from
// whatever company happens to be open into the wrong TallyPulse tenant).
// Always asks Tally directly, live, for whichever company is open right
// now - never trusts a client-supplied or previously-cached GUID on its
// own. Fails closed: any ambiguity (unreachable, nothing open, no match)
// is a rejection, never a best-effort pass.
async function verifyOpenTallyCompany(expectedGuid, { baseUrl } = {}) {
  const read = await readOpenCompanies({ baseUrl });

  if (!read.ok) return read;

  const { openCompanies } = read;
  const match = openCompanies.find((company) => company.guid === expectedGuid);

  if (!match) {
    return {
      ok: false,
      reason: "mismatch",
      openCompanies,
      message:
        "The company currently open in TallyPrime does not match the Company GUID you entered. Please open the correct company in TallyPrime and try again.",
    };
  }

  return { ok: true, reason: "ok", openCompanies, match };
}

// "Connect Tally": the user never types a GUID. The backend asks Tally which
// company is open and uses THAT company's GUID as the internal identity.
// Exactly one company must be open - with several open there is no safe way
// to know which one the user means, so it fails closed instead of picking.
// The result carries the same {ok, reason, openCompanies, match} shape as
// verifyOpenTallyCompany (match = the detected company), so it can be passed
// wherever a Tally proof is expected.
async function detectOpenTallyCompany({ baseUrl } = {}) {
  const read = await readOpenCompanies({ baseUrl });

  if (!read.ok) return read;

  if (read.openCompanies.length > 1) {
    return {
      ok: false,
      reason: "multiple_open",
      openCompanies: read.openCompanies,
      message:
        "More than one company is open in TallyPrime. Keep only the company you want to connect open and try again.",
    };
  }

  const [match] = read.openCompanies;

  return { ok: true, reason: "ok", openCompanies: read.openCompanies, match };
}

module.exports = { verifyOpenTallyCompany, detectOpenTallyCompany };
