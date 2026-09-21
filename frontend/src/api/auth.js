import client from "./client";

// POST /api/auth/register — backend/src/controllers/authController.js
// Account only: name, email, password. No company, GUID or tenant is
// entered here — the company is connected afterwards with
// connectCompany() below, straight from whatever is open in TallyPrime.
export async function registerAccount({ name, email, password }) {
  const { data } = await client.post("/auth/register", { name, email, password });
  return data; // { success, message }
}

// POST /api/auth/login — email + password. The token opens on the
// account's default company; an account that has not connected one yet
// gets a company-less token ({ hasCompany: false }).
export async function loginAccount({ email, password }) {
  const { data } = await client.post("/auth/login", { email, password });
  return data; // { success, token, hasCompany }
}

// POST /api/auth/companies — "Connect Tally": the backend detects the
// company that is open in TallyPrime and connects it to the current
// account; nothing about the company is typed by the user. The very
// first company needs no password; any further company also needs the
// account password (re-authorization). Never a new email/account.
export async function connectCompany({ password } = {}) {
  const { data } = await client.post("/auth/companies", password ? { password } : {});
  return data; // { success, message, token, data: { companyGuid, companyName, created, reactivated } }
}

// GET /api/auth/companies — every company the current account can
// access (their default company + anything connected via connectCompany
// above). companyGuid is only an opaque key for switching; it is never shown.
export async function listAccessibleCompanies() {
  const { data } = await client.get("/auth/companies");
  return data.data; // [{ companyGuid, companyName, isActive, isDefault }]
}

// POST /api/auth/switch-company — re-scopes the session's JWT to a
// different company the account already has access to. No password
// needed (the account itself is already authenticated) — this only
// changes which authorized company that session acts as.
export async function switchActiveCompany(companyGuId) {
  const { data } = await client.post("/auth/switch-company", { companyGuId });
  return data.token;
}

// PATCH /api/auth/company — renames the CURRENT active company (the
// one the caller's JWT is scoped to). A real backend save, replacing
// what used to be a browser-local-only "Update Company" mock.
export async function renameActiveCompany(companyName) {
  const { data } = await client.patch("/auth/company", { companyName });
  return data.data; // { companyGuid, companyName }
}

// The backend issues a JWT but has no GET /me endpoint. Decoding the
// payload client-side (no verification needed — it's the token we
// just received) is the only way to read {id, companyGuId, tenantId,
// role} back out for display; it is never used as an authorization
// decision, only for showing the right label in the UI. Every actual
// authorization check still happens server-side per request.
export function decodeJwtPayload(token) {
  try {
    const [, payload] = token.split(".");
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}
