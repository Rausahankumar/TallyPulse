import { useState } from "react";
import { Outlet } from "react-router-dom";
import { X } from "lucide-react";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import { useCompany } from "../../context/useCompany";

export default function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { activeCompany, switchNonce } = useCompany();

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      {/* Desktop sidebar */}
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      {/* Mobile sidebar drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="relative h-full w-64">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-4 rounded-md p-1 text-white/70 hover:bg-white/10"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenMenu={() => setMobileOpen(true)} />
        <main className="scroll-thin flex-1 overflow-y-auto p-4 sm:p-6">
          {/* Keying on tenantId + switchNonce forces every routed page to
              fully unmount/remount on a company switch — the simplest
              guarantee that no component can render Company A's cached
              state under Company B's name. */}
          <div key={`${activeCompany?.tenantId}-${switchNonce}`}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
