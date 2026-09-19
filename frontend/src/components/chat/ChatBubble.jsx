import { Sparkles } from "lucide-react";
import FreshnessBadge from "../ui/FreshnessBadge";
import { cn } from "../../lib/cn";

// Renders one persisted message exactly as chat.model.js stores it on
// the backend: {role, text, toolCalls, visualization, dataAsOf,
// freshness, warnings}. Nothing here is invented — visualization/
// toolCalls/freshness simply render as nothing until the AI layer
// actually populates them. `freshness` is the real trust-envelope
// freshness object (state: fresh | stale | sync_failed | never_synced)
// the Analytics Engine returned for this answer — never hardcoded.
export default function ChatBubble({ message }) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex gap-2.5", isUser && "justify-end")}>
      {!isUser && (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600">
          <Sparkles className="h-4 w-4 text-white" />
        </span>
      )}
      <div className={cn("max-w-[75%] space-y-2", isUser && "items-end")}>
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed",
            isUser ? "bg-brand-600 text-white" : "bg-surface-alt text-ink-800"
          )}
        >
          {message.text}
        </div>

        {!isUser && message.toolCalls?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {message.toolCalls.map((tc, i) => (
              <span
                key={i}
                className="rounded-full border border-surface-border bg-white px-2 py-0.5 text-[11px] text-ink-500"
              >
                {tc.toolName} · {tc.state}
              </span>
            ))}
          </div>
        )}

        {!isUser && message.warnings?.length > 0 && (
          <div className="space-y-1">
            {message.warnings.map((w, i) => (
              <p key={i} className="text-[12px] text-warning-600">
                ⚠ {w}
              </p>
            ))}
          </div>
        )}

        {!isUser && message.freshness && <FreshnessBadge freshness={message.freshness} />}
      </div>
    </div>
  );
}
