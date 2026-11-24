// --------------------------------------------------
// Graceful shutdown (SIGTERM / SIGINT).
//
// A host such as Render sends SIGTERM when it deploys a new version or restarts the service, then SIGKILLs the process after a
// short delay. Without this the process dies in the middle of a sync cycle: a voucher batch can be half written and the
// company's sync lock stays "running" until it goes stale. So, in order:
//   1. stop the schedulers (no new sync or reconciliation cycle starts)
//   2. stop taking new HTTP connections (requests already in flight finish)
//   3. wait for a running cycle to end, but never longer than the grace period
//   4. close the database connection, then exit
// The grace period (SHUTDOWN_GRACE_SECONDS, default 25) must stay below the host's own kill delay.
// Calling it twice is harmless (the second call waits for the first).
// --------------------------------------------------

const DEFAULT_GRACE_SECONDS = 25;
const POLL_MS = 200;

function resolveGraceMs(value, fallbackSeconds = DEFAULT_GRACE_SECONDS) {
  const n = Number(value);
  return (Number.isFinite(n) && n >= 0 ? n : fallbackSeconds) * 1000;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// server: the http.Server. stopWorkers: functions that stop the schedulers. isBusy: functions that return true while a cycle
// runs. closeDb: async function. exit: process.exit (replaceable in tests).
function createShutdown({ server, stopWorkers = [], isBusy = [], closeDb = async () => {}, graceMs = DEFAULT_GRACE_SECONDS * 1000, exit = process.exit, log = console.log } = {}) {
  let running = null;

  const busy = () => isBusy.some((fn) => { try { return !!fn(); } catch { return false; } });

  async function run(signal) {
    log(`[shutdown] ${signal}: stopping.`);
    for (const stop of stopWorkers) { try { stop(); } catch (e) { log(`[shutdown] could not stop a worker: ${e.message}`); } }

    // No new connections; keep-alive connections that are idle are closed so close() can finish.
    let serverClosed = false;
    const closed = new Promise((resolve) => { if (!server || !server.listening) { serverClosed = true; return resolve(); } server.close(() => { serverClosed = true; resolve(); }); });
    if (server && typeof server.closeIdleConnections === "function") server.closeIdleConnections();

    // Wait for the running cycle AND for requests already in flight (server.close() calls back when the last one ends).
    const deadline = Date.now() + graceMs;
    while ((busy() || !serverClosed) && Date.now() < deadline) {
      if (server && typeof server.closeIdleConnections === "function") server.closeIdleConnections();
      await sleep(POLL_MS);
    }
    const clean = !busy() && serverClosed;
    if (!clean) log(`[shutdown] a cycle or request was still running after ${Math.round(graceMs / 1000)}s: closing anyway.`);

    if (server && typeof server.closeAllConnections === "function") server.closeAllConnections();
    await Promise.race([closed, sleep(1000)]);
    try { await closeDb(); } catch (e) { log(`[shutdown] database close failed: ${e.message}`); }
    log(`[shutdown] done${clean ? "" : " (forced)"}.`);
    exit(clean ? 0 : 1);
  }

  return (signal = "SIGTERM") => { if (!running) running = run(signal); return running; };
}

module.exports = { createShutdown, resolveGraceMs, DEFAULT_GRACE_SECONDS };
