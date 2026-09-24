/**
 * Minimum-necessary live Anthropic validation for Tier 2A (redundant
 * tool-call reduction). One question, using the same instrumented-
 * client pattern as the prior Tier 1 live script (wraps the REAL
 * callClaude via handleChatTurn's injectable claudeClient).
 *
 * IMPORTANT NUANCE being tested honestly, not assumed: a single
 * get_stock_group_performance(period:"current_quarter") call's built-in
 * previousPeriod is a TRUNCATED, same-day-count comparison window
 * (documented in stockGroupAnalytics.js/periodEngine.js - deliberate,
 * for a fair MoM% calculation), NOT the full calendar previous quarter
 * a separate period:"previous_quarter" call returns. If Claude follows
 * the new instruction and reuses the built-in field instead of making
 * a second call, the reported previous-period date range may genuinely
 * differ from "Jul 1 - Sep 30, 2025" (the full-quarter figure this
 * task's own stated ground truth uses). This script reports whichever
 * actually happens, plainly - it does not force or assume either
 * outcome.
 *
 * Run: node verify-tier2a-redundant-calls-live.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Company = require("./src/models/company.js");
const { handleChatTurn, callClaude } = require("./src/services/ai/chatOrchestrator");
const stockGroupAnalytics = require("./src/services/analytics/stockGroupAnalytics");
const periodEngine = require("./src/services/analytics/periodEngine");
const { getTenantReferenceDate } = require("./src/services/analytics/referenceDate");

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
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? null,
      cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? null,
      stopReason: response.stop_reason,
    });
    return response;
  };
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

  console.log("=== GROUND TRUTH (independent, both interpretations) ===");
  const referenceDate = await getTenantReferenceDate(weFour.tenantId);
  const current = periodEngine.resolvePeriod("current_quarter", referenceDate);
  const truncatedPrevious = periodEngine.resolveComparisonPeriod("current_quarter", referenceDate);
  const fullPrevious = periodEngine.resolvePeriod("previous_quarter", referenceDate);

  const singleCallResult = await stockGroupAnalytics.getTopStockGroups(weFour.tenantId, current, truncatedPrevious, null, { limit: 10 });
  const fullPreviousResult = await stockGroupAnalytics.getTopStockGroups(weFour.tenantId, fullPrevious, null, null, { limit: 10 });

  console.log(`Current quarter:            ${current.from.toISOString()} - ${current.to.toISOString()}`);
  console.log(`  Total: Rs.${singleCallResult.summary.currentPeriod.totalAmount.toFixed(2)}`);
  console.log(`Built-in (truncated) previous: ${truncatedPrevious.from.toISOString()} - ${truncatedPrevious.to.toISOString()}`);
  console.log(`  Total: Rs.${singleCallResult.summary.previousPeriod.totalAmount.toFixed(2)}`);
  console.log(`  MoM growth (current vs truncated previous): ${singleCallResult.summary.momGrowth.growthPercentage.toFixed(1)}%`);
  console.log(`Full calendar previous quarter: ${fullPrevious.from.toISOString()} - ${fullPrevious.to.toISOString()}`);
  console.log(`  Total: Rs.${fullPreviousResult.summary.currentPeriod.totalAmount.toFixed(2)}`);

  console.log("\n=== LIVE ANTHROPIC CALL ===");
  const question = "Compare my product group sales this quarter vs last quarter, with exact date ranges";
  console.log(`Question: "${question}"`);

  const log = [];
  const result = await handleChatTurn({ context, userMessage: question, claudeClient: makeInstrumentedClient(log) });

  console.log("\n--- AI final answer ---");
  console.log(result.answer);

  console.log("\n--- Tool calls made ---");
  console.log(JSON.stringify(result.details.toolCalls, null, 1));

  console.log("\n--- Anthropic call log ---");
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
  const totalCacheCreation = log.reduce((s, c) => s + (c.cacheCreationInputTokens || 0), 0);
  const totalCacheRead = log.reduce((s, c) => s + (c.cacheReadInputTokens || 0), 0);
  const totalLatency = log.reduce((s, c) => s + (c.latencyMs || 0), 0);
  console.log(
    `\n  TOTAL: ${log.length} Anthropic call(s), input=${totalInput}, output=${totalOutput}, cache_creation=${totalCacheCreation}, cache_read=${totalCacheRead}, latency=${totalLatency}ms`
  );
  console.log(`  Tool calls: ${result.details.toolCalls.length} (${result.details.toolCalls.map((t) => t.toolName).join(", ")})`);

  console.log("\n=== BEFORE / AFTER vs. documented Tier 1 baseline for this exact question ===");
  console.log("BEFORE Tier 2A (post-Tier-1, 2 tool calls): 2 Anthropic calls total");
  console.log(`AFTER  Tier 2A: ${log.length} Anthropic call(s), ${result.details.toolCalls.length} tool call(s)`);

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
