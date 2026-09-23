import { Link } from "react-router-dom";
import Card, { CardHeader } from "../ui/Card";
import EmptyState from "../ui/EmptyState";
import { Inbox } from "lucide-react";
import { cn } from "../../lib/cn";

const DOT_TONE = {
  success: "bg-success-600",
  brand: "bg-brand-600",
  warning: "bg-warning-600",
};

// items: the 10 most-recently-updated Sale/Purchase vouchers for this
// tenant (see Dashboard.jsx) - real data, not sample. "View all" links to
// the Sync & Data page, which shows the same recent-voucher lists.
export default function RecentActivity({ items }) {
  return (
    <Card>
      <CardHeader
        title="Recent Activity"
        action={
          <Link to="/sync" className="text-[13px] font-medium text-brand-600 hover:text-brand-700">
            View all
          </Link>
        }
      />
      {items.length === 0 ? (
        <EmptyState icon={Inbox} title="No recent vouchers" description="Nothing has synced for this company yet." />
      ) : (
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
      )}
    </Card>
  );
}
