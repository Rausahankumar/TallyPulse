const { getCompanyInfo, getVoucherTypeMasters } = require("../odbc/odbcService");
const { extractOpenCompanies } = require("../parser/tallyParser");
const { validateMasterOwnership } = require("../tally/companyOwnership");

const UNREACHABLE_MESSAGE =
  "Could not reach TallyPrime to verify the company. Make sure TallyPrime is running and reachable, then try again.";
const NO_COMPANY_MESSAGE =
  "No company is currently open in TallyPrime. Open the company you want to connect in TallyPrime and try again.";
const MULTIPLE_OPEN_MESSAGE =
  "More than one company is open in TallyPrime. Keep only the company you want to connect open and try again.";

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
//
// NOTE: with several companies open this only proves the GUID is among them.
// It does not say which one Tally answers for - data is separately checked
// against the tenant's company (companyOwnership.js), and "Connect Tally"
// resolves the selected company (resolveSelectedOpenCompany below).
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

// Which of several open companies is the SELECTED one? Tally's company list
// does not say, but its voucher and master queries answer for the selected
// company only, and every master carries "<companyGuid>-<id>". So ONE light
// VoucherType-master query identifies it: the open company whose GUID owns the
// returned masters. Reuses the same ownership rule as the classifier
// (validateMasterOwnership: no foreign master, at least one verified), so a
// mixed, unmatched or ambiguous answer identifies nobody. Never list order,
// never a display name.
async function selectedCompanyFromMasters(openCompanies, baseUrl) {
  let raw;

  try {
    raw = await getVoucherTypeMasters({ baseUrl });
  } catch (error) {
    return { status: "unreachable" };
  }

  const masters = raw && raw.data && Array.isArray(raw.data.collection) ? raw.data.collection : [];
  const owners = openCompanies.filter((company) => validateMasterOwnership(masters, company.guid).ok);

  return owners.length === 1 ? { status: "selected", company: owners[0] } : { status: "ambiguous" };
}

/**
 * The company TallyPulse should treat as "the one open in Tally": the only open
 * company, or - when several are open - the one Tally has SELECTED, proven by
 * the voucher-type masters. Anything less certain is an explicit ambiguity.
 * Returns the {ok, reason, openCompanies, match} shape verifyOpenTallyCompany
 * uses (match = the selected company), plus `selectedBy`.
 */
async function resolveSelectedOpenCompany({ baseUrl } = {}) {
  const read = await readOpenCompanies({ baseUrl });

  if (!read.ok) return read;

  const { openCompanies } = read;

  if (openCompanies.length === 1) {
    return { ok: true, reason: "ok", openCompanies, match: openCompanies[0], selectedBy: "only_open" };
  }

  const selection = await selectedCompanyFromMasters(openCompanies, baseUrl);

  if (selection.status === "selected") {
    return { ok: true, reason: "ok", openCompanies, match: selection.company, selectedBy: "voucher_type_masters" };
  }

  if (selection.status === "unreachable") {
    return { ok: false, reason: "unreachable", openCompanies, message: UNREACHABLE_MESSAGE };
  }

  return { ok: false, reason: "multiple_open", openCompanies, message: MULTIPLE_OPEN_MESSAGE };
}

// "Connect Tally": the user never types a GUID. The backend asks Tally which
// company is open (and selected) and uses THAT company's GUID as the identity.
// Kept under its original name; it is resolveSelectedOpenCompany.
const detectOpenTallyCompany = resolveSelectedOpenCompany;

module.exports = { verifyOpenTallyCompany, detectOpenTallyCompany, resolveSelectedOpenCompany };
