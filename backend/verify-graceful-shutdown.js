/**
 * Graceful shutdown (services/lifecycle/shutdown.js): a real loopback HTTP server, fake workers, a fake database close and a
 * recorded exit code. No database, no Tally, no signal is sent to this process.
 * Run: node verify-graceful-shutdown.js
 */
const http = require("http");
const { createChecker } = require("./test/check");
const { createShutdown, resolveGraceMs } = require("./src/services/lifecycle/shutdown");
const syncWorker = require("./src/services/sync/tallySyncWorker");
const reconWorker = require("./src/services/sync/reconciliationWorker");

const t = createChecker();
const check = t.check;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => res.end("ok"));
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

(async () => {
  // grace setting
  check("G1", "default grace is 25s", resolveGraceMs(undefined), 25000);
  check("G2", "a number of seconds", resolveGraceMs("10"), 10000);
  check("G3", "0 is allowed (do not wait)", resolveGraceMs("0"), 0);
  check("G4", "junk or negative falls back to the default", [resolveGraceMs("abc"), resolveGraceMs("-5")], [25000, 25000]);

  // worker accessors are real and read the real cycle flags (idle when nothing runs)
  check("W1", "the sync worker reports no running cycle when idle", syncWorker.isSyncCycleRunning(), false);
  check("W2", "the reconciliation worker reports no running cycle when idle", reconWorker.isReconciliationCycleRunning(), false);

  // 1. idle: stops workers, closes the server and the database, exits 0
  {
    const server = await listen();
    const events = [];
    let code = null;
    const shutdown = createShutdown({
      server, graceMs: 2000, log: quiet,
      stopWorkers: [() => events.push("stop-a"), () => events.push("stop-b")],
      isBusy: [() => false],
      closeDb: async () => { events.push("db"); },
      exit: (c) => { code = c; },
    });
    await shutdown("SIGTERM");
    check("I1", "both workers are stopped", events.filter((e) => e.startsWith("stop")), ["stop-a", "stop-b"]);
    check("I2", "the database is closed after the workers", events.indexOf("db") > events.indexOf("stop-b"), true);
    check("I3", "the server no longer listens", server.listening, false);
    check("I4", "exit code 0", code, 0);
  }

  // 2. a running cycle is waited for, then the process exits cleanly
  {
    const server = await listen();
    let busy = true;
    const events = [];
    let code = null;
    setTimeout(() => { busy = false; events.push("cycle-ended"); }, 600);
    const shutdown = createShutdown({
      server, graceMs: 5000, log: quiet,
      isBusy: [() => busy],
      closeDb: async () => { events.push("db"); },
      exit: (c) => { code = c; },
    });
    const started = Date.now();
    await shutdown("SIGTERM");
    check("B1", "the database closes only after the cycle ended", events, ["cycle-ended", "db"]);
    check("B2", "it waited for the cycle (not instant, not the whole grace)", Date.now() - started >= 500 && Date.now() - started < 3000, true);
    check("B3", "exit code 0 after a clean wait", code, 0);
  }

  // 3. a cycle that never ends: closed after the grace period, exit code 1
  {
    const server = await listen();
    let code = null;
    const events = [];
    const shutdown = createShutdown({
      server, graceMs: 700, log: quiet,
      isBusy: [() => true],
      closeDb: async () => { events.push("db"); },
      exit: (c) => { code = c; },
    });
    const started = Date.now();
    await shutdown("SIGTERM");
    const took = Date.now() - started;
    check("F1", "waited about the grace period, no longer", took >= 650 && took < 3000, true);
    check("F2", "the database is still closed", events, ["db"]);
    check("F3", "exit code 1 (forced)", code, 1);
  }

  // 4. a request in flight finishes before the server closes
  {
    const server = http.createServer((req, res) => setTimeout(() => res.end("slow-done"), 500));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const reply = new Promise((resolve) => http.get({ host: "127.0.0.1", port, agent: false }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b)); }).on("error", (e) => resolve("ERR " + e.code)));
    await sleep(100);
    let busy = true;
    setTimeout(() => { busy = false; }, 800);
    const shutdown = createShutdown({ server, graceMs: 3000, log: quiet, isBusy: [() => busy], exit: () => {} });
    await shutdown("SIGTERM");
    check("R1", "a request already in flight got its answer", await reply, "slow-done");
  }

  // 4b. nothing is syncing, but a request is still in flight: it must still get its answer
  {
    const server = http.createServer((req, res) => setTimeout(() => res.end("slow-done"), 500));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const reply = new Promise((resolve) => http.get({ host: "127.0.0.1", port, agent: false }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b)); }).on("error", (e) => resolve("ERR " + e.code)));
    await sleep(100);
    const shutdown = createShutdown({ server, graceMs: 3000, log: quiet, isBusy: [() => false], exit: () => {} });
    await shutdown("SIGTERM");
    check("R2", "idle workers: an in-flight request still got its answer", await reply, "slow-done");
  }

  // 5. calling twice runs once; a failing worker or database does not stop the shutdown
  {
    const server = await listen();
    let stops = 0;
    let code = null;
    const shutdown = createShutdown({
      server, graceMs: 500, log: quiet,
      stopWorkers: [() => { stops += 1; throw new Error("boom"); }],
      closeDb: async () => { throw new Error("db boom"); },
      exit: (c) => { code = c; },
    });
    const p1 = shutdown("SIGTERM");
    const p2 = shutdown("SIGINT");
    await Promise.all([p1, p2]);
    check("T1", "two signals stop the workers once", stops, 1);
    check("T2", "a failing worker stop and database close still end in exit 0", code, 0);
  }

  console.log(t.summary());
  process.exit(t.fail > 0 ? 1 : 0);
})();
