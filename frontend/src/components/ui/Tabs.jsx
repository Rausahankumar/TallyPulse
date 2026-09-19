import { cn } from "../../lib/cn";

// tabs: [{ key, label }]
export default function Tabs({ tabs, active, onChange }) {
  return (
    <div className="mb-5 flex flex-wrap gap-1 rounded-xl border border-surface-border bg-white p-1">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={cn(
            "rounded-lg px-3.5 py-2 text-[13.5px] font-medium transition-colors",
            active === tab.key ? "bg-brand-600 text-white" : "text-ink-500 hover:bg-surface-alt"
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
