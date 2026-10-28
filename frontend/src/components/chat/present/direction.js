import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

// Icon and colours of a change's direction (the backend's own "up" / "down" / "flat"), shared by the change and KPI cards.
export const DIRECTION = {
  up: { icon: ArrowUpRight, cls: "bg-success-50 text-success-600" },
  down: { icon: ArrowDownRight, cls: "bg-danger-50 text-danger-600" },
  flat: { icon: Minus, cls: "bg-surface-alt text-ink-500" },
};
