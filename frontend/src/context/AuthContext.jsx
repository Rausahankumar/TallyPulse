import { useCallback, useMemo, useState } from "react";
import {
  loginAccount,
  registerAccount,
  connectCompany as connectCompanyRequest,
  switchActiveCompany,
  decodeJwtPayload,
} from "../api/auth";
import { getStoredToken, setStoredToken } from "../api/client";
import { AuthContext } from "./AuthContextObject";

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

  const login = useCallback(async ({ email, password }) => {
    const result = await loginAccount({ email, password });
    setStoredToken(result.token);
    const next = sessionFromToken(result.token);
    setSession(next);
    return next;
  }, []);

  const register = useCallback(
    async ({ name, email, password }) => {
      await registerAccount({ name, email, password });
      // Backend register doesn't return a token — log in immediately
      // after. The new account has no company yet, so the app sends it
      // straight to "Connect Tally".
      return login({ email, password });
    },
    [login]
  );

  // Connects the company that is open in TallyPrime to THIS SAME account
  // (one user, multiple companies — never a second email/account). The
  // backend detects the company; the account's password is only needed
  // from the second company on. The reply carries a session scoped to
  // the connected company, which becomes the active session.
  const connectCompany = useCallback(async ({ password } = {}) => {
    const result = await connectCompanyRequest({ password });
    setStoredToken(result.token);
    setSession(sessionFromToken(result.token));
    return result.data; // { companyGuid, companyName, created, reactivated }
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
    () => ({
      session,
      isAuthenticated: !!session,
      // A signed-in account that has not connected a company yet.
      needsCompany: !!session && !session.companyGuid,
      login,
      register,
      connectCompany,
      switchCompany,
      logout,
    }),
    [session, login, register, connectCompany, switchCompany, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
