import { WifiOff, Sparkles } from "lucide-react";
import Button from "../ui/Button";

// The Claude integration itself (auth, company context, chat
// persistence, tool routing, and the live Anthropic API call) is fully
// wired up server-side. This notice only appears when the backend
// reports it can't currently reach/use Claude — most commonly
// ANTHROPIC_API_KEY missing on the server (503) — so it shows the
// backend's own honest message rather than assuming a specific cause.
export default function AiNotConnectedNotice({ message, onShowDemo }) {
  return (
    <div className="flex gap-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning-50">
        <WifiOff className="h-4 w-4 text-warning-600" />
      </span>
      <div className="max-w-[80%] rounded-2xl border border-warning-50 bg-warning-50/60 px-4 py-3 text-[13px] leading-relaxed text-ink-700">
        <p className="font-medium text-ink-900">TallyPulse AI isn't available right now</p>
        <p className="mt-1 text-ink-600">
          {message ||
            "The assistant's analytics tools and security layer are built and tested, but the AI service isn't reachable right now."}
        </p>
        {onShowDemo && (
          <Button variant="secondary" size="sm" icon={Sparkles} onClick={onShowDemo} className="mt-3">
            Show demo response
          </Button>
        )}
      </div>
    </div>
  );
}
