import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import Card from "./Card";
import { cn } from "../../lib/cn";

export default function MiniStatCard({ label, value, delta }) {
  const positive = typeof delta === "number" ? delta >= 0 : null;
  return (
    <Card>
      <p className="text-[13px] font-medium text-ink-500">{label}</p>
      <p className="mt-1.5 text-xl font-semibold text-ink-900">{value}</p>
      {delta !== undefined && delta !== null && (
        <p
          className={cn(
            "mt-1.5 inline-flex items-center gap-1 text-[12.5px] font-medium",
            positive ? "text-success-600" : "text-danger-600"
          )}
        >
          {positive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
          {Math.abs(delta)}%
        </p>
      )}
    </Card>
  );
}
