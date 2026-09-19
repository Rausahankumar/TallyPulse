import { cn } from "../../lib/cn";

export default function Card({ className, children, padded = true, ...props }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-surface-border bg-white shadow-card",
        padded && "p-5",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action, className }) {
  return (
    <div className={cn("mb-4 flex items-start justify-between gap-3", className)}>
      <div>
        <h3 className="text-[15px] font-semibold text-ink-900">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[13px] text-ink-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
