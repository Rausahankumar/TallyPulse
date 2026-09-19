import { CheckCircle2, AlertTriangle, XCircle, HelpCircle } from "lucide-react";
import Badge from "./Badge";

// Renders the exact freshness contract the backend's analytics tools
// return (docs §10/§17: freshness.state is one of fresh | stale |
// sync_failed | never_synced, plus dataAsOf + message). This component
// never invents a freshness state on its own — it only formats
// whatever the caller passes in, so it drops in unchanged once real
// analytics data starts flowing through it.
const CONFIG = {
  fresh: { tone: "success", label: "Data is fresh", icon: CheckCircle2 },
  stale: { tone: "warning", label: "Data is stale", icon: AlertTriangle },
  sync_failed: { tone: "danger", label: "Last sync failed", icon: XCircle },
  never_synced: { tone: "neutral", label: "Never synced", icon: HelpCircle },
};

function formatDataAsOf(dataAsOf) {
  if (!dataAsOf) return null;
  const date = new Date(dataAsOf);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function FreshnessBadge({ freshness, className }) {
  if (!freshness) return null;
  const config = CONFIG[freshness.state] || CONFIG.never_synced;
  const Icon = config.icon;
  const stamp = formatDataAsOf(freshness.dataAsOf);

  return (
    <Badge tone={config.tone} className={className}>
      <Icon className="h-3.5 w-3.5" />
      {config.label}
      {stamp && <span className="text-ink-400">· as of {stamp}</span>}
    </Badge>
  );
}
