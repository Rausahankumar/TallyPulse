import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import Card from "./Card";
import { cn } from "../../lib/cn";

// Matches the reference dashboard's KPI tiles: label, big value, small
// icon chip, and a "+12.5% vs previous period" delta line underneath.
// `to` (optional) makes the whole card one real link (keyboard focusable, Enter opens it, middle-click works);
// `linkLabel` is its accessible name / tooltip. Without `to` the card is exactly what it always was.
export default function KpiCard({ label, value, delta, icon: Icon, tone = "brand", hint, to, linkLabel }) {
  const positive = typeof delta === "number" ? delta >= 0 : null;

  const card = (
    <Card className={cn("min-w-0", to && "relative h-full transition-shadow group-hover:border-brand-200 group-hover:shadow-card-lg group-focus-visible:border-brand-500")}>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-ink-500">{label}</span>
        {Icon && (
          <span
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg",
              TONE_BG[tone]
            )}
          >
            <Icon className={cn("h-4 w-4", TONE_ICON[tone])} />
          </span>
        )}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-ink-900">{value}</div>
      {hint && <p className="mt-1.5 text-[12px] text-ink-400">{hint}</p>}
      {delta !== undefined && delta !== null && (
        <div
          className={cn(
            "mt-2 inline-flex items-center gap-1 text-[13px] font-medium",
            positive ? "text-success-600" : "text-danger-600"
          )}
        >
          {positive ? (
            <ArrowUpRight className="h-3.5 w-3.5" />
          ) : (
            <ArrowDownRight className="h-3.5 w-3.5" />
          )}
          {Math.abs(delta).toFixed(1)}% <span className="font-normal text-ink-400">vs previous period</span>
        </div>
      )}
      {to && (
        <span className="pointer-events-none absolute bottom-3 right-4 inline-flex items-center gap-1 text-[12px] font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          View report <ArrowRight className="h-3.5 w-3.5" />
        </span>
      )}
    </Card>
  );

  if (!to) return card;
  return (
    <Link
      to={to}
      aria-label={linkLabel}
      title={linkLabel}
      className="group block min-w-0 rounded-2xl outline-none transition-transform focus-visible:ring-2 focus-visible:ring-brand-500 active:scale-[0.99]"
    >
      {card}
    </Link>
  );
}

const TONE_BG = {
  brand: "bg-brand-50",
  success: "bg-success-50",
  warning: "bg-warning-50",
  violet: "bg-[#f1efff]",
};

const TONE_ICON = {
  brand: "text-brand-600",
  success: "text-success-600",
  warning: "text-warning-600",
  violet: "text-chart-violet",
};
