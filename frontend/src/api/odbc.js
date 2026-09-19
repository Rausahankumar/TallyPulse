import client from "./client";

// GET /api/odbc/company and /api/odbc/sales — backend/src/routes/odbcRoutes.js.
// Both are unauthenticated on the backend today (a real, flagged gap —
// see docs §7.0/§16); the frontend still sends the auth header via the
// shared client, it's simply not required by the server. These proxy
// straight to the one configured TallyPrime instance, so they're used
// here only for the "test Tally connection" action on the Sync & Data
// page — not as a per-tenant data source.

export async function testTallyConnection() {
  const { data } = await client.get("/odbc/company");
  return data; // { success, message, data: <raw Tally JSONEx company report> }
}

export async function fetchRawTallySales() {
  const { data } = await client.get("/odbc/sales");
  return data; // { success, data: <raw Tally JSONEx response> }
}

// Best-effort extraction of a human-readable company name out of
// Tally's JSONEx "RTS Company Report" shape. Tally's export format is
// intentionally loosely-typed (see tallyParser.unwrapJsonExValue on the
// backend) so this is defensive, not a guaranteed schema.
export function extractTallyCompanyName(rawTallyResponse) {
  try {
    // rawTallyResponse is the odbc controller's {success, message, data}
    // body, and `data` there is the RAW axios response from Tally's own
    // gateway - itself shaped {status, data:{metadata, collection}} - so
    // the real collection is two levels down (`.data.data.collection`),
    // not one. Found by QA (2026-09-18): this only surfaced once
    // getCompanyInfo() was fixed to return real (non-empty) data -
    // before that every response was `{}` regardless, so this extra
    // level of nesting was never actually exercised.
    const tallyData = rawTallyResponse?.data?.data ?? rawTallyResponse?.data;
    const collection = tallyData?.collection || tallyData || [];
    const first = Array.isArray(collection) ? collection[0] : collection;
    const name = first?.name ?? first?.Name ?? first?.$Name;
    if (typeof name === "string" && name.trim()) return name.trim();
    if (name && typeof name === "object" && "value" in name) return String(name.value);
    return null;
  } catch {
    return null;
  }
}

function normalize(name) {
  return String(name || "").trim().toLowerCase();
}

// --------------------------------------------------
// The real limit of what this backend can verify, found empirically
// during QA (2026-09-17): the "RTS Company Report" TDL request only
// asks Tally for $Name, never a company GUID - and Tally's response
// can come back with an EMPTY collection ({success:true, data:{}})
// even when the HTTP call itself succeeds, e.g. when no company (or a
// company the report can't resolve) is open in TallyPrime right now.
// A 200 OK from GET /api/odbc/company therefore only ever proves
// "reachable," never "the correct company is open" - there is no
// GUID in the response to compare against.
//
// This function is the honest middle ground: it uses the one real
// signal that IS available (the reported company NAME) and compares
// it to the name TallyPulse has on file for the active company. It
// deliberately returns a distinct state for "reachable but no usable
// company data" instead of folding it into "connected".
// --------------------------------------------------
export async function evaluateTallyConnection(expectedCompanyName) {
  const result = await testTallyConnection();
  const tallyCompanyName = extractTallyCompanyName(result);

  if (!tallyCompanyName) {
    return {
      state: "no_company",
      tallyCompanyName: null,
      message:
        "TallyPrime is reachable, but it returned no company data - no company may be open, or the one that's open can't be read right now.",
    };
  }

  if (expectedCompanyName && expectedCompanyName !== "Loading…") {
    const matches = normalize(tallyCompanyName) === normalize(expectedCompanyName);
    if (!matches) {
      return {
        state: "mismatch",
        tallyCompanyName,
        message: `TallyPrime is reachable, but it has "${tallyCompanyName}" open, not "${expectedCompanyName}". This can't be verified by GUID - Tally's API doesn't expose one here - so double-check the right company is open in Tally.`,
      };
    }
  }

  return {
    state: "ok",
    tallyCompanyName,
    message: expectedCompanyName
      ? `Connected — Tally company "${tallyCompanyName}" matches.`
      : `Connected — Tally company: "${tallyCompanyName}".`,
  };
}
