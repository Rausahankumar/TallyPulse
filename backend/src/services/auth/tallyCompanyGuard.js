const { getCompanyInfo } = require("../odbc/odbcService");
const { extractOpenCompanies } = require("../parser/tallyParser");

// Central safety check reused by both "add another company" (verify the
// requested GUID is the one actually open in Tally before linking it to
// the account) and the live Sales Sync import (never import vouchers from
// whatever company happens to be open into the wrong TallyPulse tenant).
// Always asks Tally directly, live, for whichever company is open right
// now - never trusts a client-supplied or previously-cached GUID on its
// own. Fails closed: any ambiguity (unreachable, nothing open, no match)
// is a rejection, never a best-effort pass.
async function verifyOpenTallyCompany(expectedGuid, { baseUrl } = {}) {
  let rawResponse;

  try {
    rawResponse = await getCompanyInfo({ baseUrl });
  } catch (error) {
    return {
      ok: false,
      reason: "unreachable",
      openCompanies: [],
      message:
        "Could not reach TallyPrime to verify the company. Make sure TallyPrime is running and reachable, then try again.",
    };
  }

  const openCompanies = extractOpenCompanies(rawResponse);

  if (openCompanies.length === 0) {
    return {
      ok: false,
      reason: "no_company_open",
      openCompanies,
      message:
        "No company is currently open in TallyPrime. Open the company you want to connect in TallyPrime and try again.",
    };
  }

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

module.exports = { verifyOpenTallyCompany };
