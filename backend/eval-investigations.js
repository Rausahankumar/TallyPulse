/**
 * Planted-cause investigation evaluation (manual; never part of Ask AI).
 *
 * Seeds the synthetic company of eval/investigation/scenarios.js (known, planted causes) into a LOCAL test database, asks
 * each scenario's questions through the real chat turn (queryChat.tryAnswerWithQueryEngine: planner -> analysis plan ->
 * validator -> engine / insight tools -> answer), grades every answer with eval/investigation/grader.js and writes a report
 * to eval/results/ (git-ignored). The data is removed at the end.
 *
 * Modes:
 *   --mode=ceiling (default)  OFFLINE. A scripted "perfect planner" sends the best plan today's contract can express for each
 *                             question (ceilingReplies). No model call, no network. It measures what the CURRENT architecture
 *                             can deliver at best: a criterion that fails here cannot pass with any model.
 *   --mode=live               The real planner (Anthropic, BILLED). Refused unless --confirm-spend is also given. Never run
 *                             it without the owner's explicit approval.
 * Options: --analysis=on|basic|off (default on), --only=<scenario id>[,<id>...], --verbose (print each answer).
 *
 * Run: MONGODB_URI=mongodb://127.0.0.1:27017/tallypulse_eval node eval-investigations.js
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const flag = (name) => args.includes(`--${name}`);
const MODE = opt("mode") || "ceiling";
const ANALYSIS = opt("analysis") || "on";
const ONLY = opt("only") ? opt("only").split(",") : null;

function refuse(msg) {
  console.error(`REFUSED: ${msg} Nothing was touched.`);
  process.exit(2);
}
{
  // a LOCAL, throwaway database only: the run writes synthetic vouchers and checkpoints, then deletes them
  const uri = process.env.MONGODB_URI || "";
  const m = /^mongodb:\/\/(?:[^@/]*@)?\[?([^\]/:,]+)\]?(?::\d+)?\/([^/?]+)/.exec(uri);
  if (!m || !["127.0.0.1", "localhost", "::1"].includes(m[1]) || !/^tallypulse_(?:eval|test|ci)/.test(m[2])) {
    refuse("eval-investigations.js needs MONGODB_URI on a loopback host with a database named tallypulse_eval*, tallypulse_test* or tallypulse_ci*.");
  }
  if (!["ceiling", "live"].includes(MODE)) refuse(`unknown --mode=${MODE} (ceiling or live).`);
  if (!["on", "basic", "off"].includes(ANALYSIS)) refuse(`unknown --analysis=${ANALYSIS} (on, basic or off).`);
  if (MODE === "live" && !flag("confirm-spend")) refuse("--mode=live calls the real (billed) planner: add --confirm-spend only with the owner's approval.");
  if (MODE === "ceiling") require("axios").post = () => { throw new Error("NETWORK BLOCKED (ceiling mode)"); };
}
process.env.AI_USAGE_PERSIST = "off";

const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const TenantDataVersion = require("./src/models/tenantDataVersion.model");
const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");
const { PLANNER_TOOL_NAME, createAnthropicPlannerClient } = require("./src/services/query/planner");
const followUp = require("./src/services/query/followUp");

let live = null; // live mode: the production planner client (one per run)
const liveClient = () => (live = live || createAnthropicPlannerClient());

/** Records every planner request of a turn (the request only; the reply is untouched). */
function recording(client, requests) {
  return async (req, opts) => { requests.push(req); return client(req, opts); };
}
const requestText = (req) => (req && Array.isArray(req.messages) ? req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n") : "");
/**
 * Context was CARRIED when the previous turn's saved state re-reads strictly AND a planner request of this turn actually
 * contained it (the previous plan, or the analysis scope as framed for the planner) - not merely when a state existed.
 */
function contextReached(previousQuery, requests) {
  const state = followUp.readQueryState(previousQuery);
  if (!state || !state.plan) return false;
  const scope = JSON.stringify(followUp.scopeOf(state));
  return requests.some((r) => {
    const t = requestText(r);
    return state.source === "analysis" ? t.includes("Previous turn's analysis scope") && t.includes(scope) : t.includes("Previous query plan (structured JSON)");
  });
}
const { ANALYSIS_TOOL_NAME } = require("./src/services/query/analysisPlanner");
const S = require("./eval/investigation/scenarios");
const { grade } = require("./eval/investigation/grader");

const toolReply = (name, input) => ({ content: [{ type: "tool_use", id: `tu_${Math.random().toString(36).slice(2, 8)}`, name, input }], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
/** The scripted perfect planner for one turn: [query planner reply, analysis planner reply]. */
function scriptedModel([queryReply, analysisReply]) {
  const queue = { [PLANNER_TOOL_NAME]: [queryReply], [ANALYSIS_TOOL_NAME]: [analysisReply] };
  return async (req) => {
    const next = (queue[req.tool_choice.name] || []).shift();
    if (next === undefined) throw new Error(`ceiling script has no reply for ${req.tool_choice.name}`);
    return toolReply(req.tool_choice.name, next);
  };
}

async function cleanup() {
  const ids = { $in: [S.TENANT, S.NOISE_TENANT] };
  await Promise.all([Sale.deleteMany({ tenantId: ids }), Purchase.deleteMany({ tenantId: ids }), SyncCheckpoint.deleteMany({ tenantId: ids }), TenantDataVersion.deleteMany({ tenantId: ids })]);
}

async function seed(months) {
  const { sales, purchases } = S.buildVouchers(months);
  await Sale.insertMany(sales);
  await Purchase.insertMany(purchases);
  const now = new Date();
  for (const [tenantId, companyGuid] of [[S.TENANT, S.COMPANY_GUID], [S.NOISE_TENANT, S.NOISE_GUID]]) {
    for (const voucherType of ["Sales", "Purchase"]) {
      await SyncCheckpoint.create({ tenantId, companyGuid, voucherType, lastAlterId: 1000, lastRunStatus: "success", lastSyncedAt: now, isRunning: false, lockedAt: null });
    }
  }
}

/** Runs every turn of a scenario through the real chat turn; returns the graded turns. */
async function runScenario(sc, replies) {
  const turns = [];
  let previousQuery;
  const history = [];
  for (const [i, turn] of sc.turns.entries()) {
    // analysisMode where the code has modes (on/basic/off); analysisEnabled for code that has only the on/off switch
    const deps = { analysisMode: ANALYSIS, ...(ANALYSIS === "basic" ? {} : { analysisEnabled: ANALYSIS === "on" }) };
    const requests = [];
    deps.plannerClient = recording(MODE === "ceiling" ? scriptedModel(replies[i]) : liveClient(), requests);
    const t0 = Date.now();
    const out = await tryAnswerWithQueryEngine({ context: { tenantId: S.TENANT, userId: "eval-investigations" }, userMessage: turn.question, conversationHistory: history.slice(), previousQuery, deps });
    const ms = Date.now() - t0;
    const text = out && out.structured ? out.structured.answer : "";
    const meta = (out && out.structured && out.structured.details && out.structured.details.queryEngine) || {};
    const answer = { text, contextCarried: i > 0 ? contextReached(previousQuery, requests) : undefined };
    turns.push({ question: turn.question, route: meta.route, status: meta.status, steps: meta.steps, claudeCalls: meta.claudeCalls, ms, contextCarried: answer.contextCarried, text, warnings: (out && out.structured && out.structured.warnings) || [], grade: turn.criteria.length ? grade(turn.criteria, answer) : null });
    history.push({ role: "user", content: turn.question }, { role: "assistant", content: text });
    previousQuery = out && out.queryContext ? out.queryContext : undefined; // what the chat would store for the next turn
  }
  return turns;
}

function summarise(results) {
  const cat = {};
  let passed = 0;
  let total = 0;
  const safety = [];
  for (const r of results) for (const t of r.turns) {
    if (!t.grade) continue;
    passed += t.grade.passed;
    total += t.grade.total;
    for (const [k, v] of Object.entries(t.grade.byCategory)) {
      cat[k] = cat[k] || { passed: 0, total: 0 };
      cat[k].passed += v.passed;
      cat[k].total += v.total;
    }
    safety.push(...t.grade.safetyFailures.map((s) => `${r.id}:${s}`));
  }
  return { passed, total, score: total ? Math.round((passed / total) * 1000) / 10 : null, byCategory: cat, safetyFailures: safety };
}

function report(run) {
  const L = [];
  L.push(`Investigation evaluation - ${run.at}`);
  L.push(`mode ${run.mode} (${run.mode === "ceiling" ? "scripted perfect planner, no model call" : "REAL planner"}), ASK_AI_ANALYSIS=${run.analysis}, months ${run.months.map((m) => m.short).join(", ")}`);
  L.push("");
  for (const r of run.results) {
    for (const [i, t] of r.turns.entries()) {
      if (!t.grade) continue;
      L.push(`${r.id}${r.turns.length > 1 ? ` (turn ${i + 1})` : ""}: ${t.grade.passed}/${t.grade.total} (${t.grade.score}%)  route=${t.route || "-"} status=${t.status || "-"}${t.steps ? ` steps=${t.steps.join("/")}` : ""}`);
      L.push(`  "${t.question}"`);
      for (const c of t.grade.results.filter((x) => !x.pass)) L.push(`  FAIL ${c.category}/${c.id}${c.note ? ` - ${c.note}` : ""}${c.detail ? ` (${c.detail})` : ""}`);
    }
  }
  const s = run.summary;
  L.push("");
  L.push(`OVERALL ${s.passed}/${s.total} criteria (${s.score}%)`);
  for (const [k, v] of Object.entries(s.byCategory)) L.push(`  ${k.padEnd(12)} ${v.passed}/${v.total}`);
  L.push(`  safety failures: ${s.safetyFailures.length ? s.safetyFailures.join(", ") : "none"}`);
  return L.join("\n");
}

async function main() {
  const months = S.monthsBefore(new Date());
  const truth = S.groundTruth(months);
  const all = S.scenarios(truth).filter((sc) => !ONLY || ONLY.includes(sc.id));
  const replies = S.ceilingReplies();
  await connectDB();
  await cleanup();
  const results = [];
  try {
    await seed(months);
    for (const sc of all) results.push({ id: sc.id, turns: await runScenario(sc, replies[sc.id]) });
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }
  const run = { at: new Date().toISOString(), mode: MODE, analysis: ANALYSIS, months, results, summary: summarise(results) };
  const text = report(run);
  console.log(text);
  if (flag("verbose")) for (const r of results) for (const t of r.turns) console.log(`\n----- ${r.id}: ${t.question}\n${t.text}\n[warnings] ${t.warnings.join(" | ")}`);
  const dir = path.join(__dirname, "eval", "results");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = run.at.replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(dir, `investigations-${MODE}-${stamp}.json`), JSON.stringify(run, null, 2));
  fs.writeFileSync(path.join(dir, `investigations-${MODE}-${stamp}.txt`), `${text}\n`);
  console.log(`\nreport: eval/results/investigations-${MODE}-${stamp}.{txt,json}`);
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error("EVALUATION CRASHED:", e);
    try { await cleanup(); await mongoose.disconnect(); } catch (_) {}
    process.exitCode = 1;
  });
}

module.exports = { runScenario, summarise, report, scriptedModel };
