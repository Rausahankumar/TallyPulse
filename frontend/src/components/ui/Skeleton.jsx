import { cn } from "../../lib/cn";

export default function Skeleton({ className, ...props }) {
  return <div className={cn("animate-pulse rounded-lg bg-surface-alt", className)} {...props} />;
}

export function KpiCardSkeleton() {
  return (
    <div className="rounded-2xl border border-surface-border bg-white p-5">
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className="mt-3 h-7 w-28" />
      <Skeleton className="mt-3 h-3 w-32" />
    </div>
  );
}

export function ChartCardSkeleton({ height = 260 }) {
  return (
    <div className="rounded-2xl border border-surface-border bg-white p-5">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="mt-4 w-full" style={{ height }} />
    </div>
  );
}

export function TableSkeleton({ rows = 5 }) {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}
