import { useState } from "react";
import { Send } from "lucide-react";

export default function ChatInput({ onSend, disabled }) {
  const [value, setValue] = useState("");

  function submit(e) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue("");
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-2 border-t border-surface-border bg-white p-3">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Ask anything about your business…"
        className="h-11 flex-1 rounded-xl border border-surface-border bg-surface px-4 text-[13.5px] focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-500"
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
      >
        <Send className="h-4.5 w-4.5" />
      </button>
    </form>
  );
}
