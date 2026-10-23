import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import Card from "./Card";
import { cn } from "../../lib/cn";

// Matches the reference dashboard's KPI tiles: label, big value, small
// icon chip, and a "+12.5% vs previous period" delta line underneath.
export default function KpiCard({ label, value, delta, icon: Icon, tone = "brand", hint }) {
  const positive = typeof delta === "number" ? delta >= 0 : null;

  return (
    <Card className="min-w-0">
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
    </Card>
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
