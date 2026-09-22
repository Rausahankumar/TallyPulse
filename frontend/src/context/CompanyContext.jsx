import { useMemo, useState, useCallback, useEffect } from "react";
import { useAuth } from "./useAuth";
import { listAccessibleCompanies } from "../api/auth";
import { CompanyContext } from "./CompanyContextObject";

export function CompanyProvider({ children }) {
  const { session, switchCompany: authSwitchCompany, connectCompany: authConnectCompany } = useAuth();
  const [companies, setCompanies] = useState([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  // Bumped on every explicit company switch. AppLayout re-keys its
  // routed content on this value so every page fully remounts — the
  // guarantee that no component can go on rendering Company A's data
  // under Company B's name after a switch.
  const [switchNonce, setSwitchNonce] = useState(0);

  const refreshCompanies = useCallback(async () => {
    if (!session || !session.companyGuid) {
      setCompanies([]);
      return;
    }
    setCompaniesLoading(true);
    try {
      const list = await listAccessibleCompanies();
      setCompanies(list);
    } catch {
      setCompanies([]);
    } finally {
      setCompaniesLoading(false);
    }
  }, [session]);

  // Fetching from the backend on mount/session change - synchronizing
  // with an external system, the documented case this lint rule allows
  // an effect for (not the "adjusting state from props" case it exists
  // to catch).
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    refreshCompanies();
  }, [refreshCompanies]);

  const activeCompany = useMemo(() => {
    if (!session) return null;
    const known = companies.find((c) => c.companyGuid === session.companyGuid);
    return {
      companyGuid: session.companyGuid,
      tenantId: session.tenantId,
      // Real name once the list has loaded; a neutral placeholder for
      // the brief window before that first fetch resolves — never a
      // silently-wrong guess.
      companyName: known?.companyName || "Loading…",
    };
  }, [session, companies]);

  const switchCompany = useCallback(
    async (companyGuId) => {
      await authSwitchCompany(companyGuId);
      await refreshCompanies();
      setSwitchNonce((n) => n + 1);
    },
    [authSwitchCompany, refreshCompanies]
  );

  // "Connect Tally": the backend detects the open company. The connect call
  // already switches the session to it, so bump the nonce like any switch.
  const connectCompany = useCallback(
    async ({ password } = {}) => {
      const connected = await authConnectCompany({ password });
      await refreshCompanies();
      setSwitchNonce((n) => n + 1);
      return connected;
    },
    [authConnectCompany, refreshCompanies]
  );

  const value = useMemo(
    () => ({
      activeCompany,
      companies,
      companiesLoading,
      switchNonce,
      switchCompany,
      connectCompany,
      refreshCompanies,
    }),
    [activeCompany, companies, companiesLoading, switchNonce, switchCompany, connectCompany, refreshCompanies]
  );

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}
