import Card, { CardHeader } from "../ui/Card";
import { cn } from "../../lib/cn";

const DOT_TONE = {
  success: "bg-success-600",
  brand: "bg-brand-600",
  warning: "bg-warning-600",
};

export default function RecentActivity({ items }) {
  return (
    <Card>
      <CardHeader
        title="Recent Activity"
        action={
          <button
            disabled
            title="A full activity log isn't available yet — this list is sample data."
            className="cursor-not-allowed text-[13px] font-medium text-ink-400"
          >
            View all
          </button>
        }
      />
      <ul className="space-y-4">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT_TONE[item.tone] || DOT_TONE.brand)} />
            <div className="flex-1">
              <p className="text-[13.5px] text-ink-700">{item.text}</p>
            </div>
            <span className="shrink-0 text-[12px] text-ink-400">{item.time}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
