import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Settings as SettingsIcon, LogOut } from "lucide-react";
import { useAuth } from "../../context/useAuth";
import { cn } from "../../lib/cn";

// A real, functional profile menu — was previously a plain <span>
// with no click handler at all. Shows what's actually known about
// the session (role — the backend has no "get current user" endpoint
// for name/email, see docs §16) and two real actions.
export default function ProfileMenu() {
  const { session, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();
  const initials = (session?.userId || "US").slice(0, 2).toUpperCase();

  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full bg-navy-900 text-[12px] font-semibold text-white",
          open && "ring-2 ring-brand-200"
        )}
        aria-label="Profile menu"
      >
        {initials}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-56 rounded-xl border border-surface-border bg-white p-1.5 shadow-card-lg">
          <div className="border-b border-surface-border px-2.5 py-2">
            <p className="text-[13px] font-medium text-ink-900">My account</p>
            <p className="truncate text-[11.5px] capitalize text-ink-500">{session?.role || "user"}</p>
          </div>
          <button
            onClick={() => {
              setOpen(false);
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
      )}
    </div>
  );
}
