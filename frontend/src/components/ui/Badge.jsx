import { cn } from "../../lib/cn";

const TONES = {
  success: "bg-success-50 text-success-600",
  danger: "bg-danger-50 text-danger-600",
  warning: "bg-warning-50 text-warning-600",
  brand: "bg-brand-50 text-brand-600",
  neutral: "bg-surface-alt text-ink-500",
};

export default function Badge({ tone = "neutral", className, children, dot = false }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        TONES[tone],
        className
      )}
    >
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", DOT_TONES[tone])} />}
      {children}
    </span>
  );
}

const DOT_TONES = {
  success: "bg-success-600",
  danger: "bg-danger-600",
  warning: "bg-warning-600",
  brand: "bg-brand-600",
  neutral: "bg-ink-400",
};
