import { useEffect, useRef, useState } from "react";

// Minimal async-fetch hook shared by every page: {data, loading, error,
// reload}. Re-runs whenever `deps` changes (e.g. the active company),
// and ignores a stale response that resolves after a newer call has
// already started — relevant once real per-company API calls replace
// the mock loaders below.
export function useAsync(loader, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const callId = useRef(0);

  function run() {
    const id = ++callId.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(loader)
      .then((data) => {
        if (id === callId.current) setState({ data, loading: false, error: null });
      })
      .catch((error) => {
        if (id === callId.current) setState({ data: null, loading: false, error });
      });
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(run, deps);

  return { ...state, reload: run };
}

// A tiny artificial delay so mock-data screens still exercise their
// real loading skeletons instead of resolving instantly.
export function mockDelay(value, ms = 450) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
