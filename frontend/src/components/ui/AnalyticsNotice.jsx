import { AlertTriangle, HelpCircle, Inbox, XCircle } from "lucide-react";
import EmptyState from "./EmptyState";

// Renders the Analytics Engine's trust-envelope `state` honestly (see
// backend/src/services/analytics/trustEnvelope.js). Used for the states
// where there's nothing sensible to chart/table — `state` here is never
// invented by the frontend, only formatted.
const CONFIG = {
  zero_result: { icon: Inbox, title: "No matching records for this range" },
  no_usable_data: { icon: HelpCircle, title: "Not available yet" },
  sync_failed: { icon: XCircle, title: "Last sync failed" },
  analytics_error: { icon: AlertTriangle, title: "Couldn't calculate this" },
};

export default function AnalyticsNotice({ state, message }) {
  const config = CONFIG[state] || CONFIG.zero_result;
  return <EmptyState icon={config.icon} title={config.title} description={message} />;
}

// A non-blocking warning strip shown ABOVE real (but stale) data — the
// data itself still renders normally underneath this.
export function StaleDataBanner({ message }) {
  return (
    <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning-100 bg-warning-50 px-3.5 py-2 text-[13px] text-warning-700">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message || "This data may be stale."}</span>
    </div>
  );
}
