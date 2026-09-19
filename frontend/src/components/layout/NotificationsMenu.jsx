import { useEffect, useRef, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { cn } from "../../lib/cn";

// The backend has no notifications feature (no model, no route) - so
// this deliberately does NOT show a fake unread dot or invent sample
// alerts. Clicking it opens an honest "not available yet" panel
// instead of being a dead, clickable-looking icon that does nothing.
export default function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

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
        className={cn("rounded-full p-2 text-ink-500 hover:bg-surface-alt", open && "bg-surface-alt")}
        aria-label="Notifications"
      >
        <Bell className="h-4.5 w-4.5" />
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-72 rounded-xl border border-surface-border bg-white p-4 shadow-card-lg">
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-alt">
              <BellOff className="h-4.5 w-4.5 text-ink-400" />
            </span>
            <p className="text-[13px] font-medium text-ink-700">Notifications aren't available yet</p>
            <p className="text-[12px] text-ink-500">
              This backend doesn't have a notifications feature yet — nothing to show here.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
