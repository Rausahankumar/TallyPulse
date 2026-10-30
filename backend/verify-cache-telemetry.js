/**
 * Cache and AI-cost measurement (Phase 0): the per-turn counters are truthful, tenant-scoped and private.
 *  - reported model calls (claudeCalls / plannerCalls) = the scripted model's actual calls, in every turn, caches on or off;
 *    a planner-cache hit is counted as a hit, never as a call;
 *  - engine executions are counted by the answer cache's own status, for single queries AND every analysis step; engine
 *    computes = misses + bypasses; insight tool runs are counted;
 *  - the counters reach the persisted AiTurnUsage record (allow-listed schema fields, numbers only);
 *  - no question text, names, plans or figures in the telemetry event or the record; each record carries its own tenant only.
 * Uses eval-cache-baseline.js's scripted conversation (offline: scripted model, in-memory engine, no database, no network).
 *
 * Run: node verify-cache-telemetry.js
 */

process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const { runBaseline, invariants, Q } = require("./eval-cache-baseline");
const { buildUsageRecord } = require("./src/services/query/usageStore");
const { buildTurnEvent } = require("./src/services/query/turnTelemetry");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 900)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const COUNTERS = ["plannerCacheHits", "plannerCacheMisses", "plannerCacheBypasses", "queryExecutions", "answerCacheHits", "answerCacheMisses", "answerCacheCoalesced", "answerCacheBypasses", "insightRuns"];

(async () => {
  const off = await runBaseline({ caches: false });
  const on = await runBaseline({ caches: true });
  const t = (run, n) => run.turns[n - 1];

  // ---- counter accuracy
  check("invariants-off", "caches off: reported model calls = actual calls, engine computes = bypasses, every turn answered", invariants(off).length === 0, invariants(off).join("; "));
  check("invariants-on", "caches on: reported model calls = actual calls (hits excluded), engine computes = answer-cache misses + bypasses", invariants(on).length === 0, invariants(on).join("; "));
  check("off-no-hits", "caches off: no planner or answer-cache hit is ever reported", off.turns.every((x) => !x.plannerCacheHits && !x.answerCacheHits));
  check("exact-repeat", "exact repeat in a new chat: 0 model calls, 1 planner hit, engine result from the answer cache", t(on, 2).modelCallsActual === 0 && t(on, 2).claudeCalls === 0 && t(on, 2).plannerCacheHits === 1 && t(on, 2).answerCacheHits === 1 && t(on, 2).engineComputesActual === 0);
  check("paraphrase", "paraphrase: 1 model call (a new request), but the same plan's engine result is reused", t(on, 3).claudeCalls === 1 && t(on, 3).plannerCacheMisses === 1 && t(on, 3).answerCacheHits === 1 && t(on, 3).engineComputesActual === 0);
  check("same-chat", "same chat: the first repeat is a call (context in the request), the second is a hit", t(on, 4).claudeCalls === 1 && t(on, 5).claudeCalls === 0 && t(on, 5).plannerCacheHits === 1);
  check("why", "a 'why' turn: 3 model calls counted (query planner, analysis planner, investigation), its query step and insight run counted", t(on, 7).claudeCalls === 3 && t(on, 7).plannerCacheMisses === 3 && t(on, 7).queryExecutions === 1 && t(on, 7).insightRuns === 1);
  check("why-repeat", "the repeated 'why' turn: 0 model calls, 3 hits; the analysis step's engine result is an answer-cache hit; the insight still runs (no result cache)", t(on, 8).claudeCalls === 0 && t(on, 8).plannerCacheHits === 3 && t(on, 8).answerCacheHits === 1 && t(on, 8).insightRuns === 1, JSON.stringify(t(on, 8)));
  check("data-change", "after a data change: the remembered plan (0 calls) but the engine recomputes (answer-cache miss)", t(on, 9).claudeCalls === 0 && t(on, 9).answerCacheMisses === 1 && t(on, 9).engineComputesActual === 1);
  check("midnight", "across midnight: the remembered plan, but the engine recomputes for the new day", t(on, 10).claudeCalls === 1 && t(on, 11).claudeCalls === 0 && t(on, 11).engineComputesActual === 1 && t(on, 11).answerCacheMisses === 1);
  check("totals", "this scripted conversation: 16 model calls with caches off, 9 with caches on; 12 vs 7 engine computes (call counts, no money)", off.totals.modelCallsActual === 16 && on.totals.modelCallsActual === 9 && off.totals.engineComputesActual === 12 && on.totals.engineComputesActual === 7, JSON.stringify({ off: off.totals, on: on.totals }));

  // ---- tenant isolation
  const other = t(on, 12);
  check("tenant-isolation", "another company asking the same words: its own model call and engine run, and its record names only itself", other.claudeCalls === 1 && other.plannerCacheHits === 0 && other.answerCacheHits === 0 && other.record.tenantId === "T-OTHER" && on.turns.slice(0, 11).every((x) => x.record.tenantId === "T-BASE"));

  // ---- the persisted record and privacy
  const AiTurnUsage = require("./src/models/aiTurnUsage.model");
  const ALLOWED = Object.keys(AiTurnUsage.schema.paths).filter((k) => k !== "_id");
  check("schema", "the record's counters are schema fields of AiTurnUsage", COUNTERS.every((k) => ALLOWED.includes(k)) && on.turns.every((x) => Object.keys(x.record).every((k) => ALLOWED.includes(k))), COUNTERS.filter((k) => !ALLOWED.includes(k)).join());
  check("numbers-only", "every counter is a non-negative integer in every record", on.turns.concat(off.turns).every((x) => COUNTERS.every((k) => Number.isInteger(x.record[k]) && x.record[k] >= 0)));
  const words = [...Object.values(Q), "Synthetic", "August", "October", "invoiceAmount", "previous_month", "customer"];
  const leaked = on.turns.flatMap((x) => words.filter((w) => JSON.stringify(x.record).includes(w)));
  check("privacy-record", "no question text, names, plan contents or metric ids in any persisted record", leaked.length === 0, leaked.join(", "));
  const rawEvent = buildTurnEvent({ tenantId: "T-BASE", metrics: { plannerCacheHits: 2, queryExecutions: "sales August 2025", insightRuns: -1, answerCacheHits: 1.5 } });
  check("privacy-event", "the telemetry allow-list keeps counters numeric: text, negative or fractional values are dropped", rawEvent.plannerCacheHits === 2 && rawEvent.queryExecutions === null && rawEvent.insightRuns === null && rawEvent.answerCacheHits === null && !JSON.stringify(rawEvent).includes("August"));
  const old = buildUsageRecord(buildTurnEvent({ tenantId: "T-BASE", metrics: { plannerAttempts: 1, ok: true } }));
  check("absent-counters", "a turn without these counters (e.g. no engine run) persists them as 0, never missing or invented", COUNTERS.every((k) => old[k] === 0) && old.claudeCalls === 1);

  console.log(`\nverify-cache-telemetry: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
