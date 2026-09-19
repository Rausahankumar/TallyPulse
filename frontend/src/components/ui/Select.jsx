import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";

export default function Select({ label, className, children, ...props }) {
  return (
    <label className="block text-left">
      {label && <span className="mb-1.5 block text-sm font-medium text-ink-700">{label}</span>}
      <span className="relative flex items-center">
        <select
          className={cn(
            "h-10 w-full appearance-none rounded-lg border border-surface-border bg-white px-3 pr-9 text-sm text-ink-900",
            "focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-500",
            className
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 h-4 w-4 text-ink-400" />
      </span>
    </label>
  );
}
