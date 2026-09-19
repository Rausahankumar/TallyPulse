import { createContext, useContext, useMemo, useState, useCallback, useEffect } from "react";
import { useAuth } from "./AuthContext";
import { listAccessibleCompanies } from "../api/auth";

const CompanyContext = createContext(null);

export function CompanyProvider({ children }) {
  const { session, switchCompany: authSwitchCompany, addCompany: authAddCompany } = useAuth();
  const [companies, setCompanies] = useState([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  // Bumped on every explicit company switch. AppLayout re-keys its
  // routed content on this value so every page fully remounts — the
  // guarantee that no component can go on rendering Company A's data
  // under Company B's name after a switch.
  const [switchNonce, setSwitchNonce] = useState(0);

  const refreshCompanies = useCallback(async () => {
    if (!session) {
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

  useEffect(() => {
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

  const addCompany = useCallback(
    async ({ password, companyName, companyGuId }) => {
      const added = await authAddCompany({ password, companyName, companyGuId });
      await refreshCompanies();
      return added;
    },
    [authAddCompany, refreshCompanies]
  );

  const value = useMemo(
    () => ({
      activeCompany,
      companies,
      companiesLoading,
      switchNonce,
      switchCompany,
      addCompany,
      refreshCompanies,
    }),
    [activeCompany, companies, companiesLoading, switchNonce, switchCompany, addCompany, refreshCompanies]
  );

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

export function useCompany() {
  const ctx = useContext(CompanyContext);
  if (!ctx) throw new Error("useCompany must be used within CompanyProvider");
  return ctx;
}
