import { useState, useRef, useEffect } from "react";
import { ChevronDown, Building2 } from "lucide-react";
import { useCompany } from "../../context/useCompany";
import AddCompanyModal from "./AddCompanyModal";
import CompanyList from "./CompanyList";
import { cn } from "../../lib/cn";

// Real company switching (product rule #7): picking another company
// you already have access to calls POST /api/auth/switch-company
// directly — no re-login, no intermediate "Company B name + Company A
// data" flash, since AppLayout fully remounts routed content on
// CompanyContext's switchNonce right after the switch resolves.
export default function CompanySwitcher() {
  const { activeCompany, switchCompany } = useCompany();
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
            <CompanyList
              onPick={handleSwitch}
              disabled={switching}
              onAdd={() => {
                setOpen(false);
                setShowAddModal(true);
              }}
            />
          </div>
        )}
      </div>

      {showAddModal && <AddCompanyModal onClose={() => setShowAddModal(false)} />}
    </>
  );
}
