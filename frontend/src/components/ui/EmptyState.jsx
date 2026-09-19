import { Inbox } from "lucide-react";

export default function EmptyState({
  icon: Icon = Inbox,
  title = "Nothing here yet",
  description,
  action,
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-alt">
        <Icon className="h-5 w-5 text-ink-400" />
      </span>
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {description && <p className="max-w-sm text-[13px] text-ink-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
