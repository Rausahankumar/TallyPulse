import { useEffect, useState } from "react";

// Returns `value` delayed by `delayMs`, resetting the timer on every
// change — the standard debounce-a-value pattern for a controlled search
// input. Cleans up its own timer on unmount/re-run, so no stale timeout
// ever fires after the component using it is gone.
export function useDebouncedValue(value, delayMs = 350) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
