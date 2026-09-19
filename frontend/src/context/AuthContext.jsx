import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  loginAccount,
  registerAccount,
  addCompanyToAccount,
  switchActiveCompany,
  decodeJwtPayload,
} from "../api/auth";
import { getStoredToken, setStoredToken } from "../api/client";

const AuthContext = createContext(null);

function sessionFromToken(token) {
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  // exp is in seconds; treat an expired token as no session at all.
  if (payload.exp && Date.now() >= payload.exp * 1000) return null;
  return {
    token,
    userId: payload.id,
    companyGuid: payload.companyGuId,
    tenantId: payload.tenantId,
    role: payload.role,
  };
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => sessionFromToken(getStoredToken()));

  const login = useCallback(async ({ email, password, companyGuId }) => {
    const result = await loginAccount({ email, password, companyGuId });
    setStoredToken(result.token);
    const next = sessionFromToken(result.token);
    setSession(next);
    return next;
  }, []);

  const register = useCallback(
    async ({ name, email, password, companyName, companyGuId }) => {
      await registerAccount({ name, email, password, companyName, companyGuId });
      // Backend register doesn't return a token — log in immediately
      // after so the new user lands straight in the app, matching the
      // "register -> connect first company -> in you go" flow.
      return login({ email, password, companyGuId });
    },
    [login]
  );

  // Adds a company to THIS SAME account (one user, multiple companies —
  // never a second email/account). Re-supplies the account's existing
  // password purely to authorize the action; the account identity comes
  // from the already-stored JWT, not from anything in this call.
  const addCompany = useCallback(async ({ password, companyName, companyGuId }) => {
    return addCompanyToAccount({ password, companyName, companyGuId });
  }, []);

  // Re-scopes the current session to a different company the account
  // already has access to. No password needed — this changes which
  // authorized company the existing session acts as, it doesn't
  // re-authenticate the account.
  const switchCompany = useCallback(async (companyGuId) => {
    const token = await switchActiveCompany(companyGuId);
    setStoredToken(token);
    const next = sessionFromToken(token);
    setSession(next);
    return next;
  }, []);

  const logout = useCallback(() => {
    setStoredToken(null);
    setSession(null);
  }, []);

  const value = useMemo(
    () => ({ session, isAuthenticated: !!session, login, register, addCompany, switchCompany, logout }),
    [session, login, register, addCompany, switchCompany, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
