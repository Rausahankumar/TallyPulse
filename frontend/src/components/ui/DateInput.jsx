import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "../../lib/cn";
import { formatTypedDate, parseDateInputValue, parseTypedDate, toDateInputValue } from "../../lib/mockDateRange";

// A date field you can type into directly ("1-May-2025") or pick from
// a native calendar, overlaid transparently on the right so clicking
// that edge opens it without needing browser support for
// `showPicker()`. Typing is free-form while focused; it's only parsed
// on blur/Enter, falling back to the last valid value if it doesn't
// parse (rejects nonsense dates too, e.g. "31-Feb-2025").
export default function DateInput({ value, onChange, className }) {
  const [text, setText] = useState(() => formatTypedDate(value));
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setText(formatTypedDate(value));
  }

  function commitText() {
    const parsed = parseTypedDate(text);
    if (parsed) {
      onChange(parsed);
      setText(formatTypedDate(parsed));
    } else {
      setText(formatTypedDate(value));
    }
  }

  function handlePicked(e) {
    if (!e.target.value) return;
    const parsed = parseDateInputValue(e.target.value);
    onChange(parsed);
    setText(formatTypedDate(parsed));
  }

  return (
    <div className={cn("relative", className)}>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commitText();
            e.currentTarget.blur();
          }
        }}
        placeholder="1-May-2025"
        className="h-9 w-full rounded-lg border border-surface-border px-2.5 pr-8 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand-200"
      />
      <CalendarDays className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
      <input
        type="date"
        value={toDateInputValue(value)}
        onChange={handlePicked}
        tabIndex={-1}
        aria-label="Pick a date"
        className="absolute right-0 top-0 h-9 w-8 cursor-pointer opacity-0"
      />
    </div>
  );
}
