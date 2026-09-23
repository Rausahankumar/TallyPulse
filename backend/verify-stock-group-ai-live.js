/**
 * ONE real Anthropic API call, end-to-end, for exactly the one required
 * validation question: "What are my top 10 product groups this quarter?"
 *
 * This is a manual, one-off script - NOT part of the automated
 * regression suite, and not something CI or any other verify-*.js
 * script depends on. Run it once, by hand, to establish:
 *   - that the real Claude API correctly calls get_stock_group_performance
 *     and answers using its (never invented) result, and
 *   - a token-usage/latency baseline (no optimization implemented here).
 *
 * Ground truth is computed INDEPENDENTLY, via the same deterministic
 * backend path already verified in verify-stock-group-analytics.js -
 * never by calling the AI and trusting its own output.
 *
 * Run: node verify-stock-group-ai-live.js
 * Requires: ANTHROPIC_API_KEY set and real credits available. If the
 * call fails (missing key, exhausted credits, network), this script
 * reports that plainly and exits non-zero - it never substitutes a
 * fabricated result.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Company = require("./src/models/company.js");
const { handleChatTurn, callClaude } = require("./src/services/ai/chatOrchestrator");
const stockGroupAnalytics = require("./src/services/analytics/stockGroupAnalytics");
const periodEngine = require("./src/services/analytics/periodEngine");
const { getTenantReferenceDate } = require("./src/services/analytics/referenceDate");

async function independentGroundTruth(tenantId) {
  const referenceDate = await getTenantReferenceDate(tenantId);
  const current = periodEngine.resolvePeriod("current_quarter", referenceDate);
  const previous = periodEngine.resolveComparisonPeriod("current_quarter", referenceDate);
  const yoy = periodEngine.resolveSamePeriodLastYear("current_quarter", referenceDate);
  const result = await stockGroupAnalytics.getTopStockGroups(tenantId, current, previous, yoy, { limit: 10 });
  return { result, current, previous, yoy };
}

async function main() {
  await connectDB();

  const weFour = await Company.findOne({ companyName: "WE FOUR" }).lean();
  if (!weFour) {
    console.log("ABORT: no WE FOUR company found in this database.");
    await mongoose.disconnect();
    process.exit(1);
  }
  const context = { tenantId: weFour.tenantId, companyGuid: weFour.companyGuid };

  console.log("=== GROUND TRUTH (independent deterministic backend call, NOT via AI) ===");
  const { result: groundTruth, current, previous, yoy } = await independentGroundTruth(weFour.tenantId);
  console.log(`Period: ${current.from.toISOString()} - ${current.to.toISOString()}`);
  groundTruth.items.forEach((g, i) => {
    console.log(`  ${i + 1}. ${g.stockGroupName} — ₹${g.salesAmount.toFixed(2)} (qty ${g.salesQuantity}) | MoM: ${g.momGrowthPercentage === null ? "N/A" : g.momGrowthPercentage.toFixed(1) + "%"} | YoY: ${g.yoyGrowthPercentage === null ? "N/A" : g.yoyGrowthPercentage.toFixed(1) + "%"}`);
  });
  console.log(`Mapped: ${groundTruth.mapping.mappedLines} lines / ₹${groundTruth.mapping.mappedAmount.toFixed(2)} | Unmapped: ${groundTruth.mapping.unmappedLines} lines / ₹${groundTruth.mapping.unmappedAmount.toFixed(2)}`);
  console.log(`Overall MoM growth: ${groundTruth.summary.momGrowth?.growthPercentage === null || groundTruth.summary.momGrowth === null ? "N/A" : groundTruth.summary.momGrowth.growthPercentage.toFixed(1) + "%"}`);
  console.log(`Overall YoY growth: ${groundTruth.summary.yoyGrowth?.growthPercentage === null || groundTruth.summary.yoyGrowth === null ? "N/A" : groundTruth.summary.yoyGrowth.growthPercentage.toFixed(1) + "%"}`);

  // Instrument the REAL callClaude (not a mock) to capture usage/timing
  // per API call - handleChatTurn's claudeClient injection point already
  // exists for exactly this kind of measurement, no chatOrchestrator.js
  // change needed.
  const callLog = [];
  const instrumentedClient = async (messages, tools, systemPrompt) => {
    const start = Date.now();
    let response;
    try {
      response = await callClaude(messages, tools, systemPrompt);
    } catch (error) {
      callLog.push({ error: error.message || String(error), latencyMs: Date.now() - start });
      throw error;
    }
    callLog.push({
      latencyMs: Date.now() - start,
      model: response.model,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      stopReason: response.stop_reason,
    });
    return response;
  };

  const question = "What are my top 10 product groups this quarter?";
  console.log(`\n=== LIVE ANTHROPIC CALL ===\nQuestion: "${question}"`);

  let chatResult;
  try {
    chatResult = await handleChatTurn({ context, userMessage: question, claudeClient: instrumentedClient });
  } catch (error) {
    console.log("\nLIVE AI VALIDATION COULD NOT BE PERFORMED.");
    console.log("Reason:", error.message || String(error));
    console.log("\nNo AI response is substituted below - stopping after tool-level tests, as instructed.");
    console.log("\nCall log so far:", JSON.stringify(callLog, null, 1));
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("\n--- AI final answer ---");
  console.log(chatResult.answer);

  console.log("\n--- Tool calls made this turn ---");
  console.log(JSON.stringify(chatResult.details.toolCalls, null, 1));

  console.log("\n--- Token usage / latency per Claude API call in this turn ---");
  callLog.forEach((c, i) => console.log(`  Call ${i + 1}: model=${c.model} input=${c.inputTokens} output=${c.outputTokens} total=${c.inputTokens + c.outputTokens} latency=${c.latencyMs}ms stop_reason=${c.stopReason}`));
  const totalInput = callLog.reduce((s, c) => s + (c.inputTokens || 0), 0);
  const totalOutput = callLog.reduce((s, c) => s + (c.outputTokens || 0), 0);
  const totalLatency = callLog.reduce((s, c) => s + (c.latencyMs || 0), 0);
  console.log(`\n  TOTAL across ${callLog.length} API call(s): input=${totalInput} output=${totalOutput} total=${totalInput + totalOutput} tokens, latency=${totalLatency}ms`);
  console.log(`  Number of tool calls made: ${chatResult.details.toolCalls.length}`);
  console.log(`  Tools called: ${chatResult.details.toolCalls.map((t) => t.toolName).join(", ") || "(none)"}`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("UNEXPECTED ERROR:", err);
  try { await mongoose.disconnect(); } catch { /* best-effort */ }
  process.exit(1);
});
