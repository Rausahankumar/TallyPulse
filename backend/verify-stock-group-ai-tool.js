/**
 * Regression tests for the get_stock_group_performance AI tool
 * (tools.js registration + toolRouter.js dispatch + the handler's own
 * period resolution and pass-through to stockGroupAnalytics.js).
 *
 * NO Anthropic/Claude API call anywhere in this file - the one required
 * live end-to-end validation is a SEPARATE script
 * (verify-stock-group-ai-live.js), run manually, once, and reported
 * independently (per the task's explicit "do not run a large test
 * matrix, do not burn credits" instruction).
 *
 * Mocking approach: stockGroupAnalytics.getTopStockGroups is monkey-
 * patched directly on the required module object (no mocking library,
 * no new dependency) for the "period forwarding" and "correct function
 * invocation" tests, then restored - every other test calls the real
 * function against real or synthetic MongoDB data.
 *
 * Run: node verify-stock-group-ai-tool.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Sale = require("./src/models/sales.model");
const StockItemMaster = require("./src/models/stockItemMaster.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const { TOOLS, TOOL_HANDLERS, TOOL_DEFINITIONS, stockGroupPeriodSchema } = require("./src/services/ai/tools");
const { executeToolCall } = require("./src/services/ai/toolRouter");
const stockGroupAnalytics = require("./src/services/analytics/stockGroupAnalytics");

let pass = 0;
let fail = 0;

function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}

const TENANT_A = "TEST-TENANT-A-stockgroup-ai-tool";
const TENANT_B = "TEST-TENANT-B-stockgroup-ai-tool";

function inv(itemName, quantity, rate, amount) {
  return { itemName, quantity, rate, amount, discountPercentage: 0, discountAmount: 0 };
}
let voucherSeq = 0;
function makeSale({ tenantId, date, inventory, voucherStatus = "active" }) {
  voucherSeq += 1;
  return {
    tenantId,
    header: {
      voucherNo: `TAI-${voucherSeq}`,
      voucherDate: date,
      voucherType: "Sales",
      voucherTotalAmount: inventory.reduce((s, i) => s + i.amount, 0),
      narration: "",
      partyName: "Test Customer",
    },
    inventory,
    ledgers: [],
    voucherStatus,
  };
}

async function cleanup() {
  await Sale.deleteMany({ tenantId: { $in: [TENANT_A, TENANT_B] } });
  await StockItemMaster.deleteMany({ tenantId: { $in: [TENANT_A, TENANT_B] } });
  await SyncCheckpoint.deleteMany({ tenantId: { $in: [TENANT_A, TENANT_B] } });
}

async function seedFixtures() {
  await StockItemMaster.insertMany([
    { tenantId: TENANT_A, itemName: "WidgetX", stockGroupName: "Widgets", tallyGuid: "guidX-1", syncedAt: new Date() },
    { tenantId: TENANT_B, itemName: "WidgetX", stockGroupName: "ForeignGroup", tallyGuid: "guidX-2", syncedAt: new Date() },
  ]);
  await Sale.create([
    makeSale({ tenantId: TENANT_A, date: new Date("2025-05-10T00:00:00.000Z"), inventory: [inv("WidgetX", 5, 200, 1000)] }),
    makeSale({ tenantId: TENANT_B, date: new Date("2025-05-10T00:00:00.000Z"), inventory: [inv("WidgetX", 999, 999, 99900)] }),
  ]);
  // wrapAnalyticsResult checks freshness via SyncCheckpoint BEFORE
  // returning any data - without one, a synthetic tenant with real Sale
  // documents still comes back "never_synced" (data: null), the same
  // trap this file's own tests exist to catch elsewhere. Matches the
  // exact seeding shape already established in verify-analytics-and-ai.js.
  await SyncCheckpoint.create([
    { tenantId: TENANT_A, companyGuid: "irrelevant-A", voucherType: "Sales", lastAlterId: 1, lastRunStatus: "success", lastSyncedAt: new Date(), isRunning: false, lockedAt: null },
    { tenantId: TENANT_B, companyGuid: "irrelevant-B", voucherType: "Sales", lastAlterId: 1, lastRunStatus: "success", lastSyncedAt: new Date(), isRunning: false, lockedAt: null },
  ]);
}

function testToolRegistration() {
  console.log("\n=== 1. Tool registration ===");
  const tool = TOOLS.find((t) => t.name === "get_stock_group_performance");
  check("tool-in-TOOLS", "get_stock_group_performance is registered in TOOLS", !!tool, true);
  check("tool-has-handler", "the registered tool has a handler function", typeof tool?.handler, "function");
  check("tool-in-HANDLERS-map", "get_stock_group_performance is in TOOL_HANDLERS", typeof TOOL_HANDLERS.get_stock_group_performance, "function");
  check("tool-in-DEFINITIONS", "get_stock_group_performance is in TOOL_DEFINITIONS (what's actually sent to Claude)",
    TOOL_DEFINITIONS.some((t) => t.name === "get_stock_group_performance"), true);
  const def = TOOL_DEFINITIONS.find((t) => t.name === "get_stock_group_performance");
  check("tool-description-mentions-group", "the tool description explicitly says GROUP, not individual products",
    /group/i.test(def.description), true);
  check("tool-description-warns-against-renaming", "the tool description explicitly warns against renaming/inventing group names",
    /never (rename|invent)/i.test(def.description) || /exactly as returned/i.test(def.description), true);
}

function testInputValidation() {
  console.log("\n=== 2. Tool input validation ===");
  const validParse = stockGroupPeriodSchema.safeParse({ period: "current_month" });
  check("schema-accepts-default-shape", "a minimal valid input parses successfully", validParse.success, true);

  const badPeriod = stockGroupPeriodSchema.safeParse({ period: "next_decade" });
  check("schema-rejects-unknown-period", "an unrecognized period string is rejected by the schema", badPeriod.success, false);

  const extraField = stockGroupPeriodSchema.safeParse({ period: "current_month", tenantId: "attacker-supplied" });
  check("schema-rejects-unknown-field", "an unexpected field (e.g. a smuggled tenantId) is rejected outright by .strict(), not silently stripped", extraField.success, false);

  const limitTooHigh = stockGroupPeriodSchema.safeParse({ period: "current_month", limit: 500 });
  check("schema-rejects-limit-out-of-range", "a limit outside the allowed range is rejected", limitTooHigh.success, false);
}

async function testUnsupportedPeriodHandling() {
  console.log("\n=== 7. Unsupported/invalid period handling ===");
  const context = { tenantId: TENANT_A, companyGuid: "irrelevant" };
  const missingCustomBounds = await executeToolCall({ toolName: "get_stock_group_performance", toolInput: { period: "custom" }, context });
  check("custom-without-bounds-errors", 'period "custom" without from/to is rejected as a tool error (not a crash)', missingCustomBounds.isError, true);

  const missingFy = await executeToolCall({ toolName: "get_stock_group_performance", toolInput: { period: "specific_fy" }, context });
  check("specific-fy-without-fy-errors", 'period "specific_fy" without fy is rejected as a tool error', missingFy.isError, true);
}

async function testPeriodForwardingAndInvocation() {
  console.log("\n=== 3 & 4. Period forwarding / correct analytics function invocation (mocked) ===");
  const originalFn = stockGroupAnalytics.getTopStockGroups;
  let capturedArgs = null;
  stockGroupAnalytics.getTopStockGroups = async (...args) => {
    capturedArgs = args;
    return {
      items: [], totalGroups: 0, amountBasis: "line_item_pre_tax",
      summary: { currentPeriod: {}, previousPeriod: null, samePeriodLastYear: null, momGrowth: null, yoyGrowth: null },
      mapping: { mappedLines: 0, unmappedLines: 0, mappedAmount: 0, unmappedAmount: 0 },
      hasData: false,
    };
  };

  try {
    const context = { tenantId: "MOCK-TENANT-XYZ", companyGuid: "irrelevant" };
    await executeToolCall({ toolName: "get_stock_group_performance", toolInput: { period: "current_month", limit: 7 }, context });

    check("mock-called", "the real stockGroupAnalytics.getTopStockGroups function is the one invoked (not a duplicate calculation elsewhere)", capturedArgs !== null, true);
    check("mock-tenant-forwarded", "the tool forwards the context's tenantId as the first argument", capturedArgs[0], "MOCK-TENANT-XYZ");
    check("mock-limit-forwarded", "the tool forwards the requested limit through to the options argument", capturedArgs[4]?.limit, 7);
    check("mock-current-period-is-dates", "a resolved {from,to} current-period object (real Date instances, not raw strings) is passed as the 2nd argument",
      capturedArgs[1]?.from instanceof Date && capturedArgs[1]?.to instanceof Date, true);
  } finally {
    stockGroupAnalytics.getTopStockGroups = originalFn;
  }

  // Confirm current_quarter resolves to a DIFFERENT period than
  // current_month (proves the period KIND is actually threaded through
  // to periodEngine, not ignored/hardcoded).
  const capturedPeriods = {};
  stockGroupAnalytics.getTopStockGroups = async (tenantId, current) => {
    capturedPeriods.current = current;
    return { items: [], totalGroups: 0, amountBasis: "line_item_pre_tax", summary: {}, mapping: { mappedLines: 0, unmappedLines: 0, mappedAmount: 0, unmappedAmount: 0 }, hasData: false };
  };
  try {
    const context = { tenantId: "MOCK-TENANT-XYZ", companyGuid: "irrelevant" };
    await executeToolCall({ toolName: "get_stock_group_performance", toolInput: { period: "current_month" }, context });
    const monthFrom = capturedPeriods.current.from.getTime();
    await executeToolCall({ toolName: "get_stock_group_performance", toolInput: { period: "current_quarter" }, context });
    const quarterFrom = capturedPeriods.current.from.getTime();
    check("period-kind-changes-resolved-range", "current_month and current_quarter resolve to genuinely different `from` boundaries", monthFrom !== quarterFrom, true);
  } finally {
    stockGroupAnalytics.getTopStockGroups = originalFn;
  }
}

async function testOutputShape() {
  console.log("\n=== 5, 8, 9, 10. Tool output shape / N/A handling / amount-basis / Top-10 preservation (real synthetic data) ===");
  const context = { tenantId: TENANT_A, companyGuid: "irrelevant" };
  const result = await executeToolCall({
    toolName: "get_stock_group_performance",
    toolInput: { period: "custom", from: "2025-05-01", to: "2025-05-31" },
    context,
  });

  check("output-not-error", "a valid call against real (synthetic) data does not error", result.isError, false);
  check("output-has-trust-envelope-state", "the output is wrapped in the standard trust envelope (has a state field)", typeof result.result.state, "string");
  check("output-has-items-array", "the output preserves items[] (Top 10 list)", Array.isArray(result.result.data.items), true);
  check("output-item-has-group-name", "each item preserves stockGroupName exactly as returned by the analytics layer", result.result.data.items[0].stockGroupName, "Widgets");
  check("output-item-has-sales-amount", "each item preserves salesAmount", result.result.data.items[0].salesAmount, 1000);
  check("output-item-has-sales-quantity", "each item preserves salesQuantity", result.result.data.items[0].salesQuantity, 5);
  check("output-preserves-amount-basis", 'the output preserves amountBasis: "line_item_pre_tax" unchanged', result.result.data.amountBasis, "line_item_pre_tax");
  check("output-preserves-mapping", "the output preserves the mapping diagnostic block", typeof result.result.data.mapping.mappedLines, "number");
  check("output-null-yoy-not-zero", "when no prior-year comparison exists, yoyGrowthPercentage is null - never coerced to 0", result.result.data.items[0].yoyGrowthPercentage, null);
  check("output-null-mom-not-zero", "when no prior-period comparison exists (custom range, no natural MoM), momGrowthPercentage is null", result.result.data.items[0].momGrowthPercentage, null);
  check("output-explicit-null-in-json", "the null survives a JSON round-trip as a real `null` Claude will see (not an omitted/undefined key)",
    JSON.parse(JSON.stringify(result.result.data.items[0])).yoyGrowthPercentage, null);
}

async function testTenantIsolation() {
  console.log("\n=== 6 & 19. Tenant context propagation / tenant isolation regression ===");
  const contextA = { tenantId: TENANT_A, companyGuid: "irrelevant" };
  const contextB = { tenantId: TENANT_B, companyGuid: "irrelevant" };
  const periodArgs = { period: "custom", from: "2025-05-01", to: "2025-05-31" };

  const resultA = await executeToolCall({ toolName: "get_stock_group_performance", toolInput: periodArgs, context: contextA });
  const resultB = await executeToolCall({ toolName: "get_stock_group_performance", toolInput: periodArgs, context: contextB });

  check("tenant-a-sees-own-group", "tenant A's context returns ONLY tenant A's group (Widgets)", resultA.result.data.items.map((i) => i.stockGroupName), ["Widgets"]);
  check("tenant-b-sees-own-group", "tenant B's context returns ONLY tenant B's group (ForeignGroup), same item name, completely different group/amount", resultB.result.data.items.map((i) => i.stockGroupName), ["ForeignGroup"]);
  check("tenant-a-amount-not-inflated", "tenant A's amount (1000) is never inflated by tenant B's 99,900 (same item name WidgetX)", resultA.result.data.items[0].salesAmount, 1000);

  // The critical injection-defense case: a tool call carrying an
  // ATTACKER-SUPPLIED tenantId inside toolInput (not context) must be
  // rejected outright by the schema's .strict(), never silently used.
  const injected = await executeToolCall({
    toolName: "get_stock_group_performance",
    toolInput: { period: "current_month", tenantId: TENANT_B },
    context: contextA,
  });
  check("injected-tenantId-in-args-rejected", "a tool call with a tenantId smuggled into the ARGUMENTS (not the server-derived context) is rejected outright, never used to cross into tenant B's data", injected.isError, true);

  const noContext = await executeToolCall({ toolName: "get_stock_group_performance", toolInput: { period: "current_month" }, context: null });
  check("no-context-refuses", "a call with no authorized context at all refuses execution", noContext.isError, true);
}

async function main() {
  await connectDB();
  await cleanup();

  try {
    await seedFixtures();

    testToolRegistration();
    testInputValidation();
    await testUnsupportedPeriodHandling();
    await testPeriodForwardingAndInvocation();
    await testOutputShape();
    await testTenantIsolation();
  } finally {
    await cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { await cleanup(); await mongoose.disconnect(); } catch { /* best-effort cleanup on failure */ }
  process.exit(1);
});
