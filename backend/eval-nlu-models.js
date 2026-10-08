"use strict";

/**
 * Multi-model NLU evaluation: measures how well each model turns the corpus questions into TallyPulse Query Plans, with the
 * existing Claude planner as the baseline. EVALUATION ONLY - the production Ask AI path never uses OpenRouter.
 *
 * Every model is run through the production planQuestion() (same prompt, Query Plan contract, validator and guards) and every
 * answer is scored by the same semantic comparator (eval/nluScoring.js) against eval/nlu-corpus.json. The questions and plans
 * are synthetic: nothing here reads a database, Tally or real business data.
 *
 * FREE MODELS ONLY (OpenRouter). Before any request, each model id is checked against the live OpenRouter catalogue: it must be
 * an exact ":free" id whose every price field is 0. A model that is not in the catalogue, is priced, or whose price cannot be
 * verified is NOT called - it is recorded as unavailable/refused and nothing is substituted. Router ids (openrouter/*), fallback
 * lists and paid fallbacks are never used: each request names one model, forbids provider fallbacks and caps the price at 0, and
 * a response that reports a cost stops that model.
 *
 *   node eval-nlu-models.js --models=vendor/model-a:free,vendor/model-b:free --sample=10   (+ the Claude baseline)
 *   OPENROUTER_EVAL_MODELS=a:free,b:free node eval-nlu-models.js --all
 *   node eval-nlu-models.js --models=claude --all --confirm-spend                          (the baseline alone)
 *   node eval-nlu-models.js --models=vendor/model-a:free --limit=5 --dry-run               (checks prices, calls nothing)
 *
 * Models:    --models=<list> or OPENROUTER_EVAL_MODELS. "claude" = the existing planner; "vendor/model:free" or
 *            "openrouter:vendor/model:free" = an OpenRouter model. The Claude baseline is added next to OpenRouter models unless --no-claude.
 * Rows:      --limit=N (the first N), --sample=N (N rows evenly spaced through the corpus: keeps the mix of groups, languages and
 *            follow-ups), or --all (one is required); --group=<name>, --ids=a,b, --no-followups, --no-gaps. Follow-up rows carry their
 *            previous plan; capability-gap rows are included by default (they are a reporting category).
 * Quota:     free OpenRouter models are rate limited, and an account without purchased credits gets a small DAILY allowance
 *            (documented as 50 requests/day for all ":free" models together). --rpm / OPENROUTER_RPM (default 15) paces requests;
 *            a model refused 8 times in a row is halted; answers are cached, so a rerun the next day only asks for the rows still missing.
 * Spend:     Claude calls cost money. More than 60 rows with Claude needs --confirm-spend.
 * Control:   --concurrency=N (or NLU_EVAL_CONCURRENCY, default 3), --structured=auto|tool|json_schema (OPENROUTER_STRUCTURED_MODE),
 *            --max-tokens=N (OPENROUTER_MAX_TOKENS), --timeout-ms=N (OPENROUTER_TIMEOUT_MS, default 30000 per request),
 *            --ablate=<name> (Claude only; one prompt change, see eval/promptAblations.js; combine with --ids=... --all),
 *            --no-cache, --cache-dir=<dir>, --out-dir=<dir>, --verbose, --dry-run, --no-pace (tests against a local stub only: real
 *            OpenRouter runs must stay paced).
 * Secrets:   OPENROUTER_API_KEY (and ANTHROPIC_API_KEY for the baseline) are read from backend/.env; they are never printed or written.
 * Output:    eval/results/nlu-models-<timestamp>.json and .txt (git-ignored), plus the comparison table on screen.
 */

const { EVAL_TIMEZONE } = require("./eval/evalTimezone"); // FIRST: the evaluation runs in UTC whatever the machine's zone (E3)
process.env.AI_USAGE_PERSIST = "off"; // an evaluation never writes usage records
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const num = (v, fallback) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback);

const { createAnthropicPlannerClient } = require("./src/services/query/planner");
const scoring = require("./eval/nluScoring");
const runner = require("./eval/nluModelRunner");
const { ABLATIONS, withAblation } = require("./eval/promptAblations");
const { createOpenRouterPlannerClient, fetchModelCapabilities, pickStructuredMode, assessFreeModel, FREE_ONLY_PROVIDER } = require("./eval/openRouterClient");

// Exit through process.exitCode (never process.exit) so open keep-alive sockets close cleanly; on Windows a hard exit with a
// live fetch connection can abort the process with a libuv assertion.
class Stop extends Error {
  constructor(code) {
    super(`stop ${code}`);
    this.exitCode = code;
  }
}
function fail(message, code = 2) {
  console.log(`\n${message}`);
  throw new Stop(code);
}

(async () => {
  // ---------------------------------------------------------------- what to evaluate
  let specs = runner.parseModelSpecs(opt("models") || process.env.OPENROUTER_EVAL_MODELS || "");
  const openRouterSpecs = specs.filter((s) => s.provider === "openrouter");
  if (!specs.length) fail("No models given. Use --models=vendor/model-a:free,vendor/model-b:free or set OPENROUTER_EVAL_MODELS. Nothing was called.");
  if (!flag("no-claude") && !specs.some((s) => s.provider === "claude")) specs = [runner.parseModelSpecs("claude")[0], ...specs];
  const withClaude = specs.some((s) => s.provider === "claude");
  const ablation = opt("ablate");
  if (ablation && (!withClaude || specs.length !== 1)) fail("--ablate applies to the Claude planner alone: use --models=claude (one target). Nothing was called.");
  if (ablation && !ABLATIONS[ablation]) fail(`Unknown --ablate "${ablation}". Known: ${Object.keys(ABLATIONS).join(", ")}. Nothing was called.`);

  const limit = opt("limit") === null ? null : Number(opt("limit"));
  const sample = opt("sample") === null ? null : Number(opt("sample"));
  if (!flag("all") && !(Number.isInteger(limit) && limit > 0) && !(Number.isInteger(sample) && sample > 0)) fail("Add --limit=N, --sample=N (for example --sample=10) or --all. Nothing was called.");
  const rows = runner.selectRows(scoring.corpus.rows, { group: opt("group"), ids: opt("ids") ? opt("ids").split(",") : null, includeFollowUps: !flag("no-followups"), includeGaps: !flag("no-gaps"), limit: flag("all") ? null : limit, sample: flag("all") ? null : sample });
  if (!rows.length) fail("No corpus rows selected. Nothing was called.");
  const concurrency = Math.max(1, Math.min(16, Math.floor(num(opt("concurrency") ?? process.env.NLU_EVAL_CONCURRENCY, 3))));
  const rpm = Math.max(1, Math.min(60, Math.floor(num(opt("rpm") ?? process.env.OPENROUTER_RPM, 15))));

  console.log(`NLU model evaluation: ${specs.length} model(s) x ${rows.length} question(s), concurrency ${concurrency}${openRouterSpecs.length ? `, OpenRouter paced at ${rpm} requests/minute, FREE MODELS ONLY` : ""}`);
  for (const s of specs) console.log(`  - ${s.label}${s.provider === "claude" ? "  (baseline: the existing planner)" : ""}`);
  if (withClaude && rows.length > 60 && !flag("confirm-spend")) fail(`The Claude baseline would make up to ${rows.length} real API calls (cached answers are reused). Add --confirm-spend to run it. Nothing was called.`);

  // ---------------------------------------------------------------- free-only gate: live catalogue, exact id, every price 0
  const structuredOverride = opt("structured") || process.env.OPENROUTER_STRUCTURED_MODE || "auto";
  if (!["auto", "tool", "json_schema"].includes(structuredOverride)) fail(`--structured must be auto, tool or json_schema (got "${structuredOverride}").`);
  const dataCollection = opt("data-collection") || process.env.OPENROUTER_DATA_COLLECTION || null;
  if (dataCollection && !["allow", "deny"].includes(dataCollection)) fail('--data-collection must be "allow" or "deny".');
  let catalogue = { reachable: false, byId: {} };
  const gates = {};
  if (openRouterSpecs.length) {
    catalogue = await fetchModelCapabilities(openRouterSpecs.map((s) => s.model)); // the public catalogue: no key is sent
    const checkedAt = new Date().toISOString();
    console.log(`\nFree-model check against the live OpenRouter catalogue (${catalogue.reachable ? "reachable" : "UNREACHABLE: nothing can be verified, so no OpenRouter model will be called"}):`);
    for (const s of openRouterSpecs) {
      gates[s.model] = { ...assessFreeModel(s.model, catalogue.byId[s.model], catalogue.reachable), checkedAt };
      const g = gates[s.model];
      console.log(`  ${g.callable ? "OK     " : "SKIPPED"} ${s.model}: ${g.status}${g.pricing ? ` pricing=${JSON.stringify(g.pricing)}` : ""}${g.reason ? ` - ${g.reason}` : ""}`);
    }
  }
  const callable = specs.filter((s) => s.provider === "claude" || (gates[s.model] && gates[s.model].callable));
  const openRouterCallable = callable.filter((s) => s.provider === "openrouter");
  if (openRouterSpecs.length && !openRouterCallable.length) console.log("\nNo OpenRouter model passed the free-model check: nothing from OpenRouter will be called.");
  if (!callable.length) fail("Nothing can be run. Nothing was called.");
  if (flag("dry-run")) {
    console.log(`\n--dry-run: nothing was called (${rows.length} question(s) x ${callable.length} model(s) would be evaluated).`);
    return;
  }
  if (withClaude && !process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY is missing (backend/.env): the Claude baseline cannot run. Nothing was called.");
  if (openRouterCallable.length && !process.env.OPENROUTER_API_KEY) fail("OPENROUTER_API_KEY is missing (add it to backend/.env): OpenRouter models cannot run. Nothing was called.");

  // ---------------------------------------------------------------- build the targets
  const cacheDir = opt("cache-dir") || path.join(__dirname, "eval", ".cache");
  const throttle = openRouterCallable.length && !flag("no-pace") ? runner.createSpacer(rpm) : null; // one pace for every OpenRouter model: the free quota is per account
  const targets = callable.map((spec) => {
    if (spec.provider === "claude") {
      const model = process.env.ANTHROPIC_PLANNER_MODEL || process.env.ANTHROPIC_MODEL || "(planner default)";
      // --ablate=<name> (evaluation only): the SAME model and settings, one prompt change - see eval/promptAblations.js
      const client = ablation ? withAblation(createAnthropicPlannerClient(), ablation) : createAnthropicPlannerClient();
      return { ...spec, model, label: ablation ? `claude+${ablation}` : "claude", client, settings: { provider: "claude", model, ...(ablation ? { ablation } : {}) }, limitations: [], pricingStatus: "anthropic_baseline_paid_api_requested_by_user" };
    }
    const picked = pickStructuredMode(catalogue.byId[spec.model], structuredOverride);
    const client = createOpenRouterPlannerClient({
      evalOnly: true,
      freeOnly: true, // the default, stated: there is no switch for paid models in this CLI
      model: spec.model,
      structuredMode: picked.mode,
      maxTokens: num(opt("max-tokens") ?? process.env.OPENROUTER_MAX_TOKENS, 0) || undefined,
      attemptTimeoutMs: num(opt("timeout-ms") ?? process.env.OPENROUTER_TIMEOUT_MS, 0) || undefined,
      provider: dataCollection ? { data_collection: dataCollection } : {},
    });
    return { ...spec, client, settings: client.describe(), limitations: picked.limitations, capability: catalogue.byId[spec.model], pricingStatus: gates[spec.model].status, throttle };
  });
  for (const t of targets) for (const l of t.limitations) console.log(`  note (${t.label}): ${l}`);

  for (const t of targets) {
    t.fingerprint = runner.configFingerprint(t.settings);
    t.cache = flag("no-cache") ? null : new runner.ResponseCache(path.join(cacheDir, runner.cacheFileName(t, t.fingerprint)));
    t.records = [];
    t.state = runner.newTargetState();
  }

  // ---------------------------------------------------------------- run (bounded concurrency over every model x row)
  const resolver = scoring.makeResolver();
  const tasks = [];
  for (const row of rows) for (const target of targets) tasks.push({ row, target });
  let done = 0;
  const started = Date.now();
  const { results, maxInFlight } = await runner.runPool(tasks, concurrency, async ({ row, target }) => {
    const record = await runner.evaluateRow({ row, target, resolver, cache: target.cache });
    done += 1;
    if (flag("verbose")) console.log(`  ${record.outcome.padEnd(22)} ${target.label} ${row.id} ${record.latencyMs ?? "-"}ms${record.cached ? " (cached)" : ""}${record.httpStatus && record.httpStatus !== 200 ? ` HTTP ${record.httpStatus}` : ""}`);
    else if (done % 10 === 0 || done === tasks.length) console.log(`  ${done}/${tasks.length} done`);
    if (target.cache && done % 10 === 0) target.cache.flush();
    return { target, record };
  });
  for (const t of targets) if (t.cache) t.cache.flush();
  for (const { target, record } of results) target.records.push(record);
  for (const t of targets) if (t.state.halted) console.log(`  HALTED ${t.label}: ${t.state.halted}`);

  // ---------------------------------------------------------------- report
  for (const t of targets) {
    t.summary = runner.aggregate(t.records);
    t.breakdown = runner.breakdown(t.records);
  }
  const mongoose = require("mongoose");
  const orTargets = targets.filter((t) => t.provider === "openrouter");
  const freeOnlyReport = openRouterSpecs.length
    ? {
        enforced: true,
        rules: ["exact :free model ids only", "live catalogue price of every field must be exactly 0", "no openrouter/* router or stealth ids", "no `models` fallback list", "provider.allow_fallbacks = false", `provider.max_price = ${JSON.stringify(FREE_ONLY_PROVIDER.max_price)}`, "a response that reports a cost halts the model"],
        catalogueReachable: catalogue.reachable,
        requestedModels: openRouterSpecs.map((s) => {
          const g = gates[s.model];
          const t = orTargets.find((x) => x.model === s.model);
          return {
            id: s.model,
            pricingStatus: g.status,
            pricing: g.pricing,
            pricingCheckedAt: g.checkedAt,
            reason: g.reason,
            tested: !!t && t.state.requests + t.summary.cachedRows > 0,
            providerRequestsMade: t ? t.state.requests : 0,
            answersServedFromCache: t ? t.summary.cachedRows : 0,
            questionsScored: t ? t.summary.questions : 0,
            questionsSkipped: t ? t.summary.skipped : 0,
            halted: t ? t.state.halted : null,
            requestsReportingACost: t ? t.state.freeViolations : 0,
            servedModelMismatches: t ? t.state.servedModelMismatches : 0,
          };
        }),
        paidModelRequestsIntentionallyMade: 0, // a model is only ever called after its catalogue pricing verified as free
        providerRequestsToNonFreeVerifiedModels: orTargets.filter((t) => t.pricingStatus !== "free_verified").reduce((n, t) => n + t.state.requests, 0),
        responsesReportingNonZeroCost: orTargets.reduce((n, t) => n + t.state.freeViolations, 0),
      }
    : null;
  const report = {
    generatedAt: new Date().toISOString(),
    kind: "nlu-model-evaluation",
    note: "NLU only: synthetic corpus questions, no database, no Tally, no real business data.",
    corpus: { version: scoring.corpus.version, referenceDate: scoring.corpus.referenceDate, totalRows: scoring.corpus.rows.length, evaluatedRows: rows.length, selection: flag("all") ? "all rows" : sample ? `${sample} evenly spaced rows` : `first ${limit} rows` },
    run: { timezone: EVAL_TIMEZONE, concurrency, rpm: openRouterCallable.length ? rpm : null, maxInFlight, elapsedMs: Date.now() - started, structuredOverride, cacheEnabled: !flag("no-cache"), databaseConnections: mongoose.connection.readyState === 0 ? 0 : 1 },
    freeOnly: freeOnlyReport,
    targets: targets.map((t) => ({
      label: t.label,
      provider: t.provider,
      model: t.model,
      pricingStatus: t.pricingStatus,
      settings: t.settings,
      promptSchemaFingerprint: t.fingerprint,
      limitations: t.limitations,
      capability: t.capability || null,
      halted: t.state.halted,
      servedModels: [...new Set(t.records.map((r) => r.servedModel).filter(Boolean))],
      summary: t.summary,
      breakdown: t.breakdown,
      results: t.records,
    })),
    leaders: runner.leaders(targets),
  };
  const outDir = opt("out-dir") || path.join(__dirname, "eval", "results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `nlu-models-${stamp}.json`);
  const freeLines = freeOnlyReport
    ? [
        "OpenRouter free-model check (live catalogue):",
        ...freeOnlyReport.requestedModels.map((m) => `  ${m.tested ? "TESTED " : "NOT TESTED"} ${m.id}: ${m.pricingStatus}${m.reason ? ` - ${m.reason}` : ""}; provider requests ${m.providerRequestsMade}, cached answers ${m.answersServedFromCache}, scored ${m.questionsScored}${m.questionsSkipped ? `, skipped ${m.questionsSkipped}` : ""}${m.halted ? `, HALTED: ${m.halted}` : ""}`),
        `  paid OpenRouter requests intentionally made: ${freeOnlyReport.paidModelRequestsIntentionallyMade} | requests to models not verified free: ${freeOnlyReport.providerRequestsToNonFreeVerifiedModels} | responses reporting a non-zero cost: ${freeOnlyReport.responsesReportingNonZeroCost}`,
        "",
      ]
    : [];
  const summaryText = [`NLU model comparison - ${report.generatedAt}`, `corpus v${report.corpus.version}, ${rows.length} of ${report.corpus.totalRows} questions (${report.corpus.selection}); evaluation time zone ${EVAL_TIMEZONE}; planner prompt/schema fingerprints: ${targets.map((t) => `${t.label}=${t.fingerprint}`).join(", ")}`, "", ...freeLines, runner.comparisonTable(targets), "", runner.breakdownTable(targets), ""].join("\n");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(jsonPath.replace(/\.json$/, ".txt"), summaryText);
  console.log(`\n${summaryText}`);
  console.log(`Leaders (facts, not a recommendation): ${JSON.stringify(report.leaders)}`);
  console.log(`Results written to ${path.relative(__dirname, jsonPath)} (git-ignored). Harness errors: ${targets.reduce((n, t) => n + t.summary.harnessErrors, 0)}. Max requests in flight: ${maxInFlight}.`);
  // Every evaluated row must sit in exactly one reporting bucket; if not, the numbers above are not to be used (the report is still written).
  const accountingErrors = targets.map((t) => ({ label: t.label, problem: runner.partitionProblem(t.summary) })).filter((e) => e.problem);
  for (const e of accountingErrors) console.log(`ACCOUNTING ERROR (${e.label}): ${e.problem}. These numbers must not be used.`);
  process.exitCode = targets.some((t) => t.summary.harnessErrors) || accountingErrors.length ? 1 : 0;
})().catch((error) => {
  if (error instanceof Stop) {
    process.exitCode = error.exitCode;
    return;
  }
  console.error(`eval-nlu-models failed: ${String(error && error.message).slice(0, 300)}`);
  process.exitCode = 1;
});
