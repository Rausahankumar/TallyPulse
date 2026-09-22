import { NavLink } from "react-router-dom";
import { BarChart3, LogOut } from "lucide-react";
import { NAV_ITEMS } from "./navConfig";
import { useAuth } from "../../context/useAuth";
import { useCompany } from "../../context/useCompany";
import { cn } from "../../lib/cn";

export default function Sidebar({ onNavigate }) {
  const { logout, session } = useAuth();
  const { activeCompany } = useCompany();

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

      <div className="border-t border-navy-800 p-3">
        <div className="mb-2 truncate rounded-lg bg-navy-900 px-3 py-2 text-[12px] text-navy-muted">
          {activeCompany?.companyName || "Your Company"}
        </div>
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-navy-800">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500 text-[13px] font-semibold text-white">
            {(session?.userId || "U").slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[13px] font-medium text-white">My account</p>
            <p className="truncate text-[11px] capitalize text-navy-muted">{session?.role || "user"}</p>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            className="rounded-md p-1.5 text-navy-muted hover:bg-navy-700 hover:text-white"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
