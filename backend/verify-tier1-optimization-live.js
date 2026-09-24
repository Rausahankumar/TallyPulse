/**
 * Minimum-necessary live Anthropic validation for Tier 1 AI cost
 * optimization (prompt caching + history windowing). NOT part of the
 * automated regression suite - a manual, one-off measurement script,
 * run by hand once credits/measurements are needed.
 *
 * Three scenarios, each using the SAME instrumented-client pattern
 * already established in verify-stock-group-ai-live.js (wraps the REAL
 * callClaude via handleChatTurn's injectable claudeClient - no
 * chatOrchestrator.js change needed to capture per-call usage):
 *
 *   1. Baseline re-measurement: the EXACT Stock Group question used to
 *      establish the original baseline (9,727 input / 646 output / 2
 *      calls / ~11.6s, no caching) - now measuring cache_creation vs
 *      cache_read tokens on the same 2 internal calls.
 *   2. Test A (follow-up context): "top product groups this quarter"
 *      then "What about last quarter?" - conversationHistory built the
 *      same way chatController.js builds it from stored {role, text}
 *      messages.
 *   3. Test B (follow-up context): "sales this month" then "Compare
 *      that with last month."
 *
 * Ground truth is NOT recomputed here - the underlying calculations
 * were already independently verified in prior sessions; this script's
 * only job is measuring the optimization's effect and confirming
 * follow-up answers are still coherent, not re-verifying financial
 * correctness from scratch.
 *
 * Run: node verify-tier1-optimization-live.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Company = require("./src/models/company.js");
const { handleChatTurn, callClaude } = require("./src/services/ai/chatOrchestrator");

function makeInstrumentedClient(log) {
  return async (messages, tools, systemPrompt) => {
    const start = Date.now();
    let response;
    try {
      response = await callClaude(messages, tools, systemPrompt);
    } catch (error) {
      log.push({ error: error.message || String(error), latencyMs: Date.now() - start });
      throw error;
    }
    log.push({
      latencyMs: Date.now() - start,
      model: response.model,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? null,
      cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? null,
      stopReason: response.stop_reason,
    });
    return response;
  };
}

function printLog(label, log) {
  console.log(`\n--- ${label}: ${log.length} Anthropic call(s) ---`);
  log.forEach((c, i) => {
    if (c.error) {
      console.log(`  Call ${i + 1}: ERROR - ${c.error}`);
      return;
    }
    console.log(
      `  Call ${i + 1}: input=${c.inputTokens} output=${c.outputTokens} cache_creation=${c.cacheCreationInputTokens} cache_read=${c.cacheReadInputTokens} latency=${c.latencyMs}ms stop=${c.stopReason}`
    );
  });
  const totalInput = log.reduce((s, c) => s + (c.inputTokens || 0), 0);
  const totalOutput = log.reduce((s, c) => s + (c.outputTokens || 0), 0);
  const totalCacheRead = log.reduce((s, c) => s + (c.cacheReadInputTokens || 0), 0);
  const totalCacheCreation = log.reduce((s, c) => s + (c.cacheCreationInputTokens || 0), 0);
  const totalLatency = log.reduce((s, c) => s + (c.latencyMs || 0), 0);
  console.log(
    `  TOTAL: input=${totalInput} output=${totalOutput} cache_creation=${totalCacheCreation} cache_read=${totalCacheRead} latency=${totalLatency}ms`
  );
  return { totalInput, totalOutput, totalCacheRead, totalCacheCreation, totalLatency, calls: log.length };
}

async function main() {
  await connectDB();

  const weFour = await Company.findOne({ companyName: "WE FOUR" }).lean();
  if (!weFour) {
    console.log("ABORT: no WE FOUR company found.");
    await mongoose.disconnect();
    process.exit(1);
  }
  const context = { tenantId: weFour.tenantId, companyGuid: weFour.companyGuid };

  // ============================================================
  // Scenario 1: baseline re-measurement (same question as the
  // original, pre-optimization baseline)
  // ============================================================
  console.log("=== Scenario 1: baseline re-measurement (Stock Group question) ===");
  console.log('Question: "What are my top 10 product groups this quarter?"');
  const log1 = [];
  const result1 = await handleChatTurn({
    context,
    userMessage: "What are my top 10 product groups this quarter?",
    claudeClient: makeInstrumentedClient(log1),
  });
  console.log("\nAnswer:\n" + result1.answer);
  const totals1 = printLog("Scenario 1", log1);

  // ============================================================
  // Scenario 2 (Test A): follow-up "what about" context
  // ============================================================
  console.log("\n\n=== Scenario 2 / Test A: follow-up context (\"What about last quarter?\") ===");
  const log2a = [];
  const q2a = "What are my top 10 product groups this quarter?";
  console.log(`Turn 1: "${q2a}"`);
  const r2a = await handleChatTurn({ context, userMessage: q2a, claudeClient: makeInstrumentedClient(log2a) });
  console.log("Turn 1 answer:\n" + r2a.answer);

  const log2b = [];
  const q2b = "What about last quarter?";
  console.log(`\nTurn 2: "${q2b}"`);
  const conversationHistory2 = [
    { role: "user", content: q2a },
    { role: "assistant", content: r2a.answer },
  ];
  const r2b = await handleChatTurn({
    context,
    userMessage: q2b,
    conversationHistory: conversationHistory2,
    claudeClient: makeInstrumentedClient(log2b),
  });
  console.log("Turn 2 answer:\n" + r2b.answer);
  printLog("Scenario 2 / Test A - Turn 1", log2a);
  printLog("Scenario 2 / Test A - Turn 2", log2b);

  // ============================================================
  // Scenario 3 (Test B): follow-up "compare that" context
  // ============================================================
  console.log("\n\n=== Scenario 3 / Test B: follow-up context (\"Compare that with last month.\") ===");
  const log3a = [];
  const q3a = "What were my sales this month?";
  console.log(`Turn 1: "${q3a}"`);
  const r3a = await handleChatTurn({ context, userMessage: q3a, claudeClient: makeInstrumentedClient(log3a) });
  console.log("Turn 1 answer:\n" + r3a.answer);

  const log3b = [];
  const q3b = "Compare that with last month.";
  console.log(`\nTurn 2: "${q3b}"`);
  const conversationHistory3 = [
    { role: "user", content: q3a },
    { role: "assistant", content: r3a.answer },
  ];
  const r3b = await handleChatTurn({
    context,
    userMessage: q3b,
    conversationHistory: conversationHistory3,
    claudeClient: makeInstrumentedClient(log3b),
  });
  console.log("Turn 2 answer:\n" + r3b.answer);
  printLog("Scenario 3 / Test B - Turn 1", log3a);
  printLog("Scenario 3 / Test B - Turn 2", log3b);

  // ============================================================
  // Summary vs. the documented pre-optimization baseline
  // ============================================================
  console.log("\n\n=== BEFORE / AFTER vs. documented baseline (same question) ===");
  console.log("BEFORE (no caching, no windowing): 2 calls, input=9727, output=646, total=10373, latency=~11.6s");
  console.log(
    `AFTER  (Tier 1): ${totals1.calls} calls, input=${totals1.totalInput}, output=${totals1.totalOutput}, cache_creation=${totals1.totalCacheCreation}, cache_read=${totals1.totalCacheRead}, total_billed_input=${totals1.totalInput}, latency=${totals1.totalLatency}ms`
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("UNEXPECTED ERROR:", err);
  try {
    await mongoose.disconnect();
  } catch {
    /* best-effort */
  }
  process.exit(1);
});
