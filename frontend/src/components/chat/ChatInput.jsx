import { useState } from "react";
import { Send, Square } from "lucide-react";

// While a request is running the Send button becomes Stop (same size and place: no layout jump). The text
// field stays editable so the next question can be typed, but Enter does nothing until the turn ends.
export default function ChatInput({ onSend, onStop, sending }) {
  const [value, setValue] = useState("");

  function submit(e) {
    e.preventDefault();
    if (sending) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue("");
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-2 bg-white px-3 pt-2 pb-1.5">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Ask anything about your business…"
        aria-label="Ask a question"
        className="h-11 min-w-0 flex-1 rounded-xl border border-surface-border bg-surface px-4 text-[13.5px] focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-500"
      />
      {sending ? (
        <button
          type="button"
          onClick={onStop}
          title="Stop generating"
          aria-label="Stop generating"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-ink-700 bg-ink-900 text-white hover:bg-ink-700 focus:outline-none focus:ring-2 focus:ring-brand-200"
        >
          <Square className="h-3.5 w-3.5 fill-current" />
        </button>
      ) : (
        <button
          type="submit"
          disabled={!value.trim()}
          title="Send"
          aria-label="Send"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-brand-600 bg-brand-600 text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:opacity-50"
        >
          <Send className="h-4.5 w-4.5" />
        </button>
      )}
    </form>
  );
}
