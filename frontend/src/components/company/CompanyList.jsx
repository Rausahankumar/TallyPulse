import { Check, Plus } from "lucide-react";
import { useCompany } from "../../context/useCompany";
import { cn } from "../../lib/cn";

// The "Your companies" list + "Connect another company" shared by the top-bar switcher and the sidebar
// account menu. Render only: the caller owns the switch call, the busy state and the Add Company modal.
export default function CompanyList({ onPick, onAdd, disabled }) {
  const { activeCompany, companies } = useCompany();

  return (
    <>
      <div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-400">Your companies</div>

      {companies.length === 0 && <p className="px-2.5 py-2 text-[12.5px] text-ink-400">Loading companies…</p>}

      {companies.map((c) => {
        const isActive = c.companyGuid === activeCompany?.companyGuid;
        return (
          <button
            key={c.companyGuid}
            onClick={() => onPick(c.companyGuid)}
            disabled={disabled}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] disabled:opacity-60",
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
          onClick={onAdd}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] font-medium text-brand-600 hover:bg-brand-50"
        >
          <Plus className="h-4 w-4" />
          Connect another company
        </button>
      </div>
    </>
  );
}
