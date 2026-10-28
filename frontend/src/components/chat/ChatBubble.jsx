import { useCallback, useRef, useState } from "react";
import { Calculator, HelpCircle, SearchX, Sparkles } from "lucide-react";
import FreshnessBadge from "../ui/FreshnessBadge";
import MarkdownMessage from "./MarkdownMessage";
import PresentationView from "./present/PresentationView";
import AnalysisView from "./present/AnalysisView";
import { isPresentation, hasCalculation } from "./present/isPresentation";
import CalculationPanel from "./present/CalculationPanel";
import { cn } from "../../lib/cn";

// Renders one persisted message exactly as chat.model.js stores it on
// the backend: {role, text, toolCalls, visualization, dataAsOf,
// freshness, warnings}. Nothing here is invented — visualization/
// toolCalls/freshness simply render as nothing until the AI layer
// actually populates them. `freshness` is the real trust-envelope
// freshness object (state: fresh | stale | sync_failed | never_synced)
// the Analytics Engine returned for this answer — never hardcoded.
const NO_DATA_STATES = new Set(["zero_result", "no_usable_data"]);

// Visual variant from fields the backend already sends - nothing is re-requested or inferred from the text.
// `details` exists only on a live turn (not persisted), so a reloaded clarification shows as a normal answer.
function variantOf(message) {
  if (message.details?.queryEngine?.status === "needs_clarification") return "clarification";
  if (message.toolCalls?.some((tc) => NO_DATA_STATES.has(tc.state))) return "no_data";
  return "answer";
}

const VARIANTS = {
  // A plain answer reads as page text (no bubble), like a chat app; only the special states keep a box.
  answer: { bubble: "px-0 py-0.5 text-ink-800", label: null },
  clarification: {
    bubble: "border border-brand-200 bg-brand-50 text-ink-800",
    label: { icon: HelpCircle, text: "Clarification needed", className: "text-brand-700" },
  },
  no_data: {
    bubble: "border border-surface-border bg-white text-ink-800",
    label: { icon: SearchX, text: "No matching data", className: "text-ink-500" },
  },
};

export default function ChatBubble({ message }) {
  const isUser = message.role === "user";
  const variant = VARIANTS[isUser ? "answer" : variantOf(message)];
  // A structured answer (KPI / ranking / trend / comparison / empty state) is shown from the backend's own
  // presentation model; everything else (clarifications, refusals, failures) stays Markdown text.
  const presentation = !isUser && isPresentation(message.visualization) ? message.visualization : null;
  const Label = presentation ? null : variant.label;
  // "View calculation": only when the backend saved a calculation record with this answer (read-only)
  const calculation = presentation && hasCalculation(presentation) ? presentation.calculation : null;
  const [calcOpen, setCalcOpen] = useState(false);
  const calcButton = useRef(null);
  const closeCalc = useCallback(() => setCalcOpen(false), []);

  return (
    <div className={cn("flex gap-2.5", isUser && "justify-end")}>
      {!isUser && (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600">
          <Sparkles className="h-4 w-4 text-white" />
        </span>
      )}
      <div className={cn("min-w-0 space-y-2", isUser ? "max-w-[80%] items-end" : "w-full flex-1")}>
        {isUser ? (
          // The user's question exactly as typed: plain text, never parsed as Markdown.
          <div className="whitespace-pre-wrap break-words rounded-2xl bg-brand-600 px-4 py-2.5 text-[13.5px] leading-relaxed text-white">
            {message.text}
          </div>
        ) : (
          <div className={cn("rounded-2xl", variant.bubble === VARIANTS.answer.bubble ? variant.bubble : cn("px-4 py-2.5", variant.bubble))}>
            {Label && (
              <p className={cn("mb-1.5 flex items-center gap-1.5 text-[12px] font-medium", Label.className)}>
                <Label.icon className="h-3.5 w-3.5" />
                {Label.text}
              </p>
            )}
            {presentation ? (
              presentation.kind === "analysis" ? <AnalysisView presentation={presentation} /> : <PresentationView presentation={presentation} />
            ) : (
              <MarkdownMessage text={message.text} />
            )}
          </div>
        )}

        {calculation && (
          <>
            <button
              ref={calcButton}
              type="button"
              onClick={() => setCalcOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={calcOpen}
              className="inline-flex items-center gap-1.5 rounded-md text-[12.5px] font-medium text-brand-600 hover:text-brand-700 hover:underline"
            >
              <Calculator className="h-3.5 w-3.5" />
              View calculation
            </button>
            <CalculationPanel calculation={calculation} open={calcOpen} onClose={closeCalc} returnFocusRef={calcButton} />
          </>
        )}

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
          // One collapsed line (long sync notices crowded small screens); the full text is a click away.
          <details className="group text-[12px] text-warning-600">
            <summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
              <span className="shrink-0">⚠</span>
              <span className="min-w-0 truncate group-open:hidden">
                {message.warnings.length === 1 ? message.warnings[0] : `${message.warnings.length} data notices`}
              </span>
              <span className="hidden group-open:inline">
                {message.warnings.length === 1 ? "Data notice" : `${message.warnings.length} data notices`}
              </span>
              <span className="shrink-0 text-ink-400 group-open:hidden">· show</span>
              <span className="hidden shrink-0 text-ink-400 group-open:inline">· hide</span>
            </summary>
            <div className="mt-1 space-y-1">
              {message.warnings.map((w, i) => (
                <p key={i}>⚠ {w}</p>
              ))}
            </div>
          </details>
        )}

        {!isUser && message.freshness && <FreshnessBadge freshness={message.freshness} />}
      </div>
    </div>
  );
}
