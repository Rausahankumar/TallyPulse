"use strict";

// --------------------------------------------------
// Counts the provider requests ONE model call really sends. The Anthropic SDK retries a 408/409/429/5xx or a connection failure
// by itself (planner.js bounds it with maxRetries), and every attempt is a separate request the provider may bill - yet the
// application sees a single call. The SDK's `fetch` is replaced by countingFetch, which adds one to the store of the call it is
// running inside (AsyncLocalStorage keeps concurrent calls apart); countedCall marks the call's reply or error with the total as a
// non-enumerable `providerAttempts`. Nothing here changes a request, a reply or the SDK's retry policy.
// --------------------------------------------------

const { AsyncLocalStorage } = require("async_hooks");

const calls = new AsyncLocalStorage();

/** A fetch that counts each request it sends into the current counted call (a plain fetch outside one). */
function countingFetch(baseFetch) {
  return (...args) => {
    const stats = calls.getStore();
    if (stats) stats.attempts += 1;
    return (baseFetch || globalThis.fetch)(...args);
  };
}

/** Runs `fn` as one counted call and marks its result (or the error it throws) with `providerAttempts`. */
function countedCall(fn) {
  const stats = { attempts: 0 };
  const mark = (target) => {
    if (!target || typeof target !== "object") return;
    try {
      Object.defineProperty(target, "providerAttempts", { value: stats.attempts, enumerable: false, configurable: true });
    } catch (e) {
      /* a frozen object keeps no mark: the caller counts it as one request */
    }
  };
  return calls.run(stats, async () => {
    try {
      const result = await fn();
      mark(result);
      return result;
    } catch (error) {
      mark(error);
      throw error;
    }
  });
}

module.exports = { countingFetch, countedCall };
