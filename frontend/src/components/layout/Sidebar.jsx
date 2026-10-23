import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { BarChart3, ChevronsUpDown, LogOut, Settings as SettingsIcon } from "lucide-react";
import { NAV_ITEMS } from "./navConfig";
import { useAuth } from "../../context/useAuth";
import { useCompany } from "../../context/useCompany";
import CompanyList from "../company/CompanyList";
import AddCompanyModal from "../company/AddCompanyModal";
import { cn } from "../../lib/cn";

export default function Sidebar({ onNavigate }) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col bg-navy-950 text-white">
      <div className="flex items-center gap-2 px-5 pt-6 pb-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600">
          <BarChart3 className="h-4.5 w-4.5 text-white" />
        </span>
        <div className="leading-tight">
          <p className="text-[15px] font-semibold">TallyPulse</p>
          <p className="text-[11px] text-navy-muted">From Data to Decisions</p>
        </div>
      </div>

      <nav className="scroll-thin flex-1 space-y-0.5 overflow-y-auto px-3">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] font-medium transition-colors",
                isActive
                  ? "bg-brand-600 text-white shadow-card"
                  : "text-navy-muted hover:bg-navy-800 hover:text-white"
              )
            }
          >
            <item.icon className="h-4.5 w-4.5 shrink-0" />
            <span className="flex-1 truncate">{item.label}</span>
            {item.badge && (
              <span className="rounded-full bg-brand-400/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {item.badge}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <AccountMenu onNavigate={onNavigate} />
    </aside>
  );
}

// The account block at the foot of the sidebar: shows the open company, and opens a menu (upwards) to switch
// company, connect another one, open Settings or sign out - so pages can do without the top bar's switcher.
function AccountMenu({ onNavigate }) {
  const { logout, session } = useAuth();
  const { activeCompany, switchCompany } = useCompany();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

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
      onNavigate?.();
    }
  }

  return (
    <div ref={ref} className="relative border-t border-navy-800 p-3">
      {open && (
        <div className="absolute inset-x-3 bottom-full z-30 mb-2 rounded-xl border border-surface-border bg-white p-1.5 text-ink-900 shadow-card-lg">
          <CompanyList
            onPick={handleSwitch}
            disabled={switching}
            onAdd={() => {
              setOpen(false);
              setShowAddModal(true);
            }}
          />
          <div className="mt-1.5 border-t border-surface-border pt-1.5">
            <button
              onClick={() => {
                setOpen(false);
                onNavigate?.();
                navigate("/settings");
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink-700 hover:bg-surface-alt"
            >
              <SettingsIcon className="h-4 w-4" />
              Settings
            </button>
            <button
              onClick={logout}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-danger-600 hover:bg-danger-50"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        disabled={switching}
        aria-label="Account and company menu"
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-navy-800 disabled:opacity-60",
          open && "bg-navy-800"
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500 text-[13px] font-semibold text-white">
          {(session?.userId || "U").slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[13px] font-medium text-white">
            {switching ? "Switching…" : activeCompany?.companyName || "Your Company"}
          </p>
          <p className="truncate text-[11px] capitalize text-navy-muted">My account · {session?.role || "user"}</p>
        </div>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-navy-muted" />
      </button>

      {showAddModal && <AddCompanyModal onClose={() => setShowAddModal(false)} />}
    </div>
  );
}
