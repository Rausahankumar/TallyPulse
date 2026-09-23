import { useEffect, useRef, useState } from "react";

// Fetches once immediately (with a loading state, like useAsync), then
// quietly re-fetches on a fixed interval without flipping `loading` back
// on — background ticks swap `data` in place so the UI never flickers
// back to a skeleton every poll cycle. A failed tick keeps the last good
// `data` (the failure is surfaced separately via `pollError`, never
// thrown away) and backs off (doubling, capped at `maxIntervalMs`)
// instead of hammering a down server; a successful tick resets the
// interval back to `intervalMs`. Exactly one timer is ever alive per
// mount, cleaned up on unmount or when `deps`/`enabled` change — no
// request fires after the component using this hook is gone.
export function usePolling(
  loader,
  { deps = [], intervalMs = 15000, maxIntervalMs = 120000, enabled = true } = {}
) {
  const [state, setState] = useState({ data: null, loading: true, error: null, pollError: null });
  const failureCountRef = useRef(0);

  function runInitial() {
    failureCountRef.current = 0;
    setState({ data: null, loading: true, error: null, pollError: null });
    Promise.resolve()
      .then(loader)
      .then((data) => setState({ data, loading: false, error: null, pollError: null }))
      .catch((error) => setState({ data: null, loading: false, error, pollError: null }));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(runInitial, deps);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    let timer = null;

    async function tick() {
      try {
        const data = await loader();
        if (cancelled) return;
        failureCountRef.current = 0;
        setState((s) => ({ ...s, data, pollError: null }));
      } catch (error) {
        if (cancelled) return;
        failureCountRef.current += 1;
        setState((s) => ({ ...s, pollError: error }));
      }
      if (!cancelled) {
        const delay = Math.min(intervalMs * 2 ** failureCountRef.current, maxIntervalMs);
        timer = setTimeout(tick, delay);
      }
    }

    timer = setTimeout(tick, intervalMs);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, maxIntervalMs, ...deps]);

  return { ...state, reload: runInitial };
}
