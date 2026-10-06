import { useState } from "react";

// Persists a page's date-range filter selection to localStorage, keyed
// per page (`storageKey`), so a browser refresh restores exactly what
// the user last picked instead of silently resetting to the default
// range. Per-viewer convenience only (never synced, never read back by
// the backend) - wrapped in try/catch since localStorage can throw in a
// private window or with site data blocked, and the page must still
// work correctly if it does (falls back to the given default).
function readStored(storageKey) {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const from = new Date(parsed.from);
    const to = new Date(parsed.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
    return { from, to };
  } catch {
    return null;
  }
}

function writeStored(storageKey, range) {
  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ from: range.from.toISOString(), to: range.to.toISOString() })
    );
  } catch {
    // Best-effort only - a blocked/full localStorage must never break the page.
  }
}

// Returns {range, setRange, reset} - same shape as a useState call for
// `range`, so call sites barely change, but the setter also persists.
// `override` (optional, e.g. a Dashboard deep link) wins over the stored range and is stored itself, so a refresh
// keeps what is on screen exactly like a range the user picked. Writing here is idempotent.
export function usePersistedRange(storageKey, defaultRange, override = null) {
  const [range, setRangeState] = useState(() => {
    if (override) {
      writeStored(storageKey, override);
      return override;
    }
    return readStored(storageKey) || defaultRange;
  });

  function setRange(next) {
    setRangeState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      writeStored(storageKey, value);
      return value;
    });
  }

  function reset() {
    writeStored(storageKey, defaultRange);
    setRangeState(defaultRange);
  }

  return { range, setRange, reset };
}
