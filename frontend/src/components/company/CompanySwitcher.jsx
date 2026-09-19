import { useState, useRef, useEffect } from "react";
import { ChevronDown, Building2, Plus, Check } from "lucide-react";
import { useCompany } from "../../context/CompanyContext";
import AddCompanyModal from "./AddCompanyModal";
import { cn } from "../../lib/cn";

// Real company switching (product rule #7): picking another company
// you already have access to calls POST /api/auth/switch-company
// directly — no re-login, no intermediate "Company B name + Company A
// data" flash, since AppLayout fully remounts routed content on
// CompanyContext's switchNonce right after the switch resolves.
export default function CompanySwitcher() {
  const { activeCompany, companies, switchCompany } = useCompany();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function handleSwitch(companyGuid) {
    if (companyGuid === activeCompany?.companyGuid) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    try {
      await switchCompany(companyGuid);
    } finally {
      setSwitching(false);
      setOpen(false);
    }
  }

  const others = companies.filter((c) => c.companyGuid !== activeCompany?.companyGuid);

  return (
    <>
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          disabled={switching}
          className="flex items-center gap-2 rounded-lg border border-surface-border bg-white px-3 py-2 text-sm hover:bg-surface-alt disabled:opacity-60"
        >
          <Building2 className="h-4 w-4 text-ink-500" />
          <span className="max-w-[160px] truncate font-medium text-ink-900">
            {switching ? "Switching…" : activeCompany?.companyName || "Select company"}
          </span>
          <ChevronDown className={cn("h-4 w-4 text-ink-400 transition-transform", open && "rotate-180")} />
        </button>

        {open && (
          <div className="absolute left-0 z-30 mt-2 w-72 rounded-xl border border-surface-border bg-white p-1.5 shadow-card-lg">
            <div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-400">
              Your companies
            </div>

            {companies.length === 0 && (
              <p className="px-2.5 py-2 text-[12.5px] text-ink-400">Loading companies…</p>
            )}

            {companies.map((c) => {
              const isActive = c.companyGuid === activeCompany?.companyGuid;
              return (
                <button
                  key={c.companyGuid}
                  onClick={() => handleSwitch(c.companyGuid)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px]",
                    isActive ? "bg-brand-50" : "hover:bg-surface-alt"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold",
                      isActive ? "bg-brand-600 text-white" : "bg-surface-alt text-ink-500"
                    )}
                  >
                    {(c.companyName || "?").slice(0, 2).toUpperCase()}
                  </span>
                  <span className={cn("flex-1 truncate", isActive ? "font-medium text-ink-900" : "text-ink-700")}>
                    {c.companyName}
                  </span>
                  {isActive && <Check className="h-4 w-4 text-brand-600" />}
                </button>
              );
            })}

            <div className="mt-1.5 border-t border-surface-border pt-1.5">
              <button
                onClick={() => {
                  setOpen(false);
                  setShowAddModal(true);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] font-medium text-brand-600 hover:bg-brand-50"
              >
                <Plus className="h-4 w-4" />
                Connect another company
              </button>
            </div>
          </div>
        )}
      </div>

      {showAddModal && <AddCompanyModal onClose={() => setShowAddModal(false)} />}
    </>
  );
}
