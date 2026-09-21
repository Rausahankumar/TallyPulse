import { useState } from "react";
import { evaluateTallyConnection } from "../api/odbc";
import { ApiError } from "../api/client";

// Shared by the Sync & Data page and the Settings "Tally Connection"
// tab. `expectedCompanyName` (the active company's real name from
// CompanyContext) lets this distinguish "connected" from "wrong
// company open in Tally" — see api/odbc.js's evaluateTallyConnection
// for exactly what is and isn't verifiable given the current backend.
export function useTallyConnectionTest(expectedCompanyName) {
  // null | 'checking' | 'ok' | 'mismatch' | 'ambiguous' | 'no_company' | 'error'
  const [status, setStatus] = useState(null);
  const [detail, setDetail] = useState(null);

  async function run() {
    setStatus("checking");
    try {
      const result = await evaluateTallyConnection(expectedCompanyName);
      setDetail(result.message);
      setStatus(result.state);
    } catch (err) {
      setDetail(err instanceof ApiError ? err.message : "Could not reach TallyPrime.");
      setStatus("error");
    }
  }

  return { status, detail, run };
}
