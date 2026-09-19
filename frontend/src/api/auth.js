import client from "./client";

// POST /api/auth/register — backend/src/controllers/authController.js
// Required fields, exactly as the backend validates them: name, email,
// password, companyName, companyGuId. Creates the Company AND the
// User in one atomic call — this is the ONLY endpoint that creates a
// new TallyPulse account. Adding a second company to an EXISTING
// account goes through addCompany() below instead, never this one.
export async function registerAccount({
  name,
  email,
  password,
  companyName,
  companyGuId,
}) {
  const { data } = await client.post("/auth/register", {
    name,
    email,
    password,
    companyName,
    companyGuId,
  });
  return data; // { success, message }
}

// POST /api/auth/login — requires companyGuId alongside email/password
// (backend looks the user up as {email, companyGuId} together).
export async function loginAccount({ email, password, companyGuId }) {
  const { data } = await client.post("/auth/login", {
    email,
    password,
    companyGuId,
  });
  return data; // { success, token }
}

// POST /api/auth/companies — connect an ADDITIONAL company to the
// currently logged-in account. Requires the caller's existing JWT
// (sent automatically by client.js) plus their existing password to
// authorize the action — never a new email/account.
export async function addCompanyToAccount({ password, companyName, companyGuId }) {
  const { data } = await client.post("/auth/companies", {
    password,
    companyName,
    companyGuId,
  });
  return data.data; // { companyGuid, companyName, tenantId }
}

// GET /api/auth/companies — every company the current account can
// access (their original registration company + anything added via
// addCompanyToAccount above).
export async function listAccessibleCompanies() {
  const { data } = await client.get("/auth/companies");
  return data.data; // [{ companyGuid, companyName, tenantId, isActive, isDefault }]
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
  return data.data; // { companyGuid, companyName, tenantId }
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
