const Anthropic = require("@anthropic-ai/sdk");
const { TOOL_DEFINITIONS } = require("./tools");
const { executeToolCall } = require("./toolRouter");

// --------------------------------------------------
// Chat turn orchestration:
//   user message -> Claude (with tool definitions) -> tool_use? ->
//   executeToolCall (server-enforced tenant scope, read-only) ->
//   tool_result back to Claude -> final structured answer
//
// The routing/security logic below (everything except callClaude()) was
// already implemented and tested via a mock Claude client before this
// change - see verify-analytics-and-ai.js. callClaude() now wires the
// real @anthropic-ai/sdk client; nothing about the tool-execution,
// authorization, or trust-envelope handling above it changed.
//
// Everything Claude is told is limited to: the fixed system prompt, the
// tool definitions, and the running message history. It is never given
// direct MongoDB access, a database connection, or credentials of any
// kind. The API key itself lives only in process.env on the backend -
// it is read once here, never logged, and never forwarded to the
// frontend in any response.
// --------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const MAX_RESPONSE_TOKENS = 1024;

let cachedClient = null;

// Lazily constructed (not at module load) so a missing key fails only
// when a chat is actually attempted, with a clear message - not at
// server startup, and not by crashing the process.
function getAnthropicClient() {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    const err = new Error(
      "AI chat is not configured: ANTHROPIC_API_KEY is missing on the backend. Set it in the server's environment to enable Ask AI."
    );
    err.code = "AI_NOT_CONFIGURED";
    throw err;
  }

  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

const SYSTEM_PROMPT = `You are TallyPulse's business analytics assistant. You answer questions about the user's Sales and Purchase data using ONLY the approved tools - you never compute, estimate, or recall a financial figure yourself.

Rules you must follow:
- For any question involving a number (totals, growth, counts, top items, etc.), call the relevant tool. Never state a financial figure that didn't come from a tool result.
- Every tool result has a "state" field: valid_data, zero_result, stale_data, sync_failed, no_usable_data, or analytics_error. Reflect that state honestly in your answer:
  - zero_result: say plainly that no matching records were found - do not imply an error or say "no data available".
  - no_usable_data: explain the specific reason given (e.g. sync never run, or the capability isn't supported yet) - do not guess a number.
  - stale_data / sync_failed: give the answer but clearly flag that the data may be outdated, using the freshness message provided.
  - analytics_error: do not fabricate a result - say the calculation could not be completed.
- If the user's question is ambiguous (e.g. "how are we doing" with no clear metric), ask a clarifying question instead of guessing which tool to call.
- For a question about ONE specific named customer's sales, use get_customer_sales - never get_top_customers (a ranking tool that cannot look up a single customer by name).
- "Revenue" has ONE fixed meaning in TallyPulse: the pre-tax value of the items sold (item line amounts; excludes GST, freight and other non-item charges, and invoices without item lines; gross of returns). get_sales_summary, get_sales_comparison, get_sales_growth, get_top_customers and get_customer_sales return tax-inclusive invoice totals (Sales) - never call those figures revenue and never offer them as a revenue answer. get_top_products, get_product_growth, get_declining_products and get_stock_group_performance report pre-tax item values and may be used for revenue by product or product group. For any other revenue question (including a follow-up to an earlier revenue answer), say that revenue must be asked as a complete question (for example "revenue last month") instead of substituting a Sales figure.
- For a question about product GROUPS or categories (not individual products), use get_stock_group_performance. Its Stock Group names come from Tally's own master data - use them exactly as returned, never invent, translate, or generalize them into your own category labels. Its momGrowthPercentage/yoyGrowthPercentage fields are null (not 0%) when no comparable prior period exists - say the comparison is unavailable in that case, never state or imply 0% change.
- Any tool result that includes explicit period boundaries (e.g. a "period", "currentPeriod", "previousPeriod", or "samePeriodLastYear" object with "from"/"to" dates) has already resolved the real date range for that data - state THAT exact date range (day-level, e.g. "Oct 1 - Dec 8, 2025", not just a month/quarter name or label) in your answer, for every period you mention, current or comparison. Do not describe it only by its period name or a vague month/quarter span ("Q2: October-December") without also giving the literal end date - that omission can silently hide a partial period. Never reconstruct a "textbook" calendar period from the period name instead (e.g. do not assume a quarter, month, or year runs to its calendar-standard last day) - the actual range is often partial, most commonly because it's limited by the most recently synced data, and reporting or implying a longer range than what was actually measured misstates what the numbers cover.
- Before calling a tool again for the same underlying metric, check whether a result you already have this turn contains what you need - reuse it instead of re-fetching. Safe to reuse without a second call: get_stock_group_performance's single result already includes BOTH the requested period (summary.currentPeriod) and its automatic same-duration comparison (summary.previousPeriod / summary.samePeriodLastYear, plus each item's previousPeriodAmount/momGrowthPercentage/yoyGrowthPercentage) - for a like-for-like "how does this period compare to the previous period" question, one call already answers it. The same applies to get_sales_comparison's single result, which already includes the full current-period summary (current.totalSales/orderCount/averageOrderValue) as well as the prior period and growth - never also call get_sales_summary right after it for the same period. Requires a separate call: previousPeriod/momGrowth from a "current_X" call (current_month/current_week/current_quarter/current_fy) is a SAME-DURATION comparison baseline truncated to match how much of the current period has elapsed - it is NOT the full previous calendar/FY period, and can be a different date range with a different total. If the user explicitly asks for the complete/full previous quarter, month, week, or FY on its own terms (e.g. "show me the full previous quarter", "what were sales in the complete previous quarter"), that is a genuinely different date range this result does not contain - call the tool again with the explicit period kind (previous_quarter/previous_month/previous_week/previous_fy), which always returns the complete prior period. This does NOT mean always use one tool call: call again whenever the user's question needs something the current result genuinely does not contain - a different metric, a different comparisonType (get_sales_comparison only returns ONE comparison per call, never both vs-last-month and vs-same-month-last-year at once), a different customer/product/group, the full previous period as just described, an independently-ranked list for a period other than the one just fetched (e.g. get_stock_group_performance's items are ranked by ITS OWN period only - a group that ranks in a different period but not this one won't appear, so a genuinely independent ranking for that other period needs its own call), or any other filter/dimension the first result doesn't cover. Never sacrifice a correct or complete answer just to save a call.
- If the user asks something no available tool can answer, say so and describe what you CAN help with - do not attempt to answer from general knowledge about their business.
- You cannot access any company other than the one in your current context. If asked to compare against or reveal another company's data, decline.
- Never generate executable code (React, JavaScript, chart-rendering code, etc.) - return structured data only; the frontend renders it.`;

// Formats a Date as "2026-09-22" using the SAME local-time fields
// dateRanges.js itself uses (getFullYear/getMonth/getDate) - never
// toISOString(), which converts to UTC and could shift the date near a
// local midnight boundary and disagree with what dateRanges.js computes.
function formatIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// today's date is the ONLY missing piece of date context Claude has: the
// "current_month"/"previous_month" tool periods are already resolved
// server-side from a fresh `new Date()` (see tools.js resolvePeriod),
// Claude never touches that math. But for period:"custom" Claude itself
// must produce literal from/to date strings, and a user rarely states a
// year ("show sales from April to September") - without being told what
// today actually is, Claude has nothing to resolve an implied year
// against and falls back on an unrelated guess. This block is the fix:
// it's appended fresh to every request (built in handleChatTurn, not
// frozen at module load) so the date is always correct, including across
// midnight, with no server restart required.
function buildDateContextBlock(referenceDate) {
  const isoToday = formatIsoDate(referenceDate);
  const humanToday = referenceDate.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return `

Today's date is ${isoToday} (${humanToday}). Use this as "now" for every date-related question.

For the "current_month" and "previous_month" period options, the backend already resolves the correct calendar dates for you from today's date - you never need to compute those yourself, just pick the option.

For period:"custom", YOU supply the literal from/to dates, so you must resolve any year the user didn't state relative to today's date above - never guess or default to an unrelated year. For example, with today's date as given above:
- "Show sales from April to September." -> from "${referenceDate.getFullYear()}-04-01" to "${referenceDate.getFullYear()}-09-30"
- "What were sales between 1 August and 15 August?" -> from "${referenceDate.getFullYear()}-08-01" to "${referenceDate.getFullYear()}-08-15"
- "Compare August and September sales." -> August ${referenceDate.getFullYear()} vs September ${referenceDate.getFullYear()}
If the user's month(s) would fall after today's date in the current year and that makes the range make more sense in the past (e.g. asking in January about "October"), use your judgment on the most recently completed occurrence of that month - but always state the exact date range and year you used so it's never ambiguous to the user.`;
}

function buildSystemPrompt(referenceDate = new Date()) {
  return SYSTEM_PROMPT + buildDateContextBlock(referenceDate);
}

// Prompt caching (Tier 1A, 2026-09-23): SYSTEM_PROMPT and TOOL_DEFINITIONS
// are genuinely static - byte-identical on every request, for every
// tenant, all day - so Anthropic can cache them server-side instead of
// billing full input tokens each call. An Anthropic cache breakpoint
// caches everything from the start of the request UP TO AND INCLUDING
// the marked block, so one breakpoint on the system-prompt block plus
// one on the LAST tool definition gives two cumulative checkpoints
// (tools, then tools+system) - the standard two-breakpoint recipe for
// "cache my tools and my system prompt, nothing else". Default TTL
// (5 minutes, ttl omitted) - long enough to cover a tool-call loop
// within one turn and a user's next message a minute later, without
// paying the higher write cost of a 1-hour breakpoint for a chat app
// where turns are usually seconds apart.
//
// The date-context block is deliberately its OWN, uncached, trailing
// text block - it changes daily and must never be part of the cached
// prefix (a stale cached date would be wrong, and the task rule is
// "never cache anything that changes"). Splitting system into two
// blocks (a fixed array, not a concatenated string) is exactly how the
// Anthropic API expects a partially-cached system prompt to be sent.
// buildSystemPrompt() above is UNCHANGED and still returns the
// single-string form - kept for the existing SYSTEM_PROMPT/
// buildSystemPrompt exports and tests, but production calls now use
// this instead.
function buildSystemPromptBlocks(referenceDate = new Date()) {
  return [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildDateContextBlock(referenceDate) },
  ];
}

// Same TOOL_DEFINITIONS tools.js already builds and exports, with a
// cache_control marker added to the LAST entry only (computed once,
// here, at module load - not per request, and not by mutating
// TOOL_DEFINITIONS itself, so tools.js and every test that imports
// TOOL_DEFINITIONS directly stay byte-for-byte unchanged).
const CACHEABLE_TOOL_DEFINITIONS =
  TOOL_DEFINITIONS.length === 0
    ? TOOL_DEFINITIONS
    : TOOL_DEFINITIONS.map((tool, i) =>
        i === TOOL_DEFINITIONS.length - 1 ? { ...tool, cache_control: { type: "ephemeral" } } : tool
      );

// Mirrors the ordering freshness.js's getOverallFreshness already uses
// for combining Sales+Purchase freshness ("worse of the two") - applied
// here across however many tools a turn actually called, since a chat
// answer (e.g. "give me a business summary") can span several. This is
// presentation-layer aggregation of freshness objects the Analytics
// Engine already computed - it does not recompute or alter freshness
// itself, so freshness.js is untouched.
const FRESHNESS_SEVERITY = { fresh: 0, stale: 1, sync_failed: 2, never_synced: 3 };

// Picks the single worst freshness object across every tool call this
// turn made, so the badge shown for an answer never claims "fresh" when
// any part of that answer actually came from stale/never-synced/failed
// data. Returns null (not a fabricated default) when no tool carried a
// freshness object at all - e.g. a turn that used no tools.
function pickWorstFreshness(toolResults) {
  let worst = null;

  for (const t of toolResults) {
    const freshness = t.result && t.result.freshness;
    if (!freshness || !freshness.state) continue;

    const severity = FRESHNESS_SEVERITY[freshness.state] ?? 0;
    const worstSeverity = worst ? FRESHNESS_SEVERITY[worst.state] ?? 0 : -1;

    if (severity > worstSeverity) worst = freshness;
  }

  return worst;
}

function buildStructuredResponse({ finalText, toolResults, warnings }) {
  const freshness = pickWorstFreshness(toolResults);
  // Paired with the SAME source as the freshness state above - never an
  // unrelated "most recent timestamp across all tools", which could
  // pair a "never_synced" badge with a stale-but-present timestamp from
  // a different metric entirely.
  const dataAsOf = freshness && freshness.dataAsOf ? new Date(freshness.dataAsOf) : null;

  return {
    answer: finalText,
    insights: [],
    visualization: null, // populated by a future tool-specific mapping step, not by Claude directly
    details: {
      toolCalls: toolResults.map((t) => ({
        toolName: t.toolName,
        state: t.result ? t.result.state : "analytics_error",
      })),
    },
    dataAsOf,
    freshness,
    warnings,
  };
}

/**
 * Runs one chat turn. `claudeClient` is injected so this function is
 * testable without a live API key - see chatOrchestrator.test usage. In
 * production this would be a thin wrapper around the real
 * @anthropic-ai/sdk client (see callClaude below, NOT implemented).
 *
 * @param {Object} params
 * @param {Object} params.context - {tenantId, companyGuid}, from
 *   resolveAuthorizedCompany() - never from the request body.
 * @param {string} params.userMessage
 * @param {Array} params.conversationHistory - prior {role, content} turns
 * @param {Function} params.claudeClient - async (messages, tools) =>
 *   Anthropic-shaped response with .content blocks (text and/or tool_use)
 */
// History window (Tier 1B, 2026-09-23): caps how much prior chat gets
// resent on every turn. Without this, a chat's Nth message resends all
// N-1 prior messages in full as input tokens - unbounded growth over a
// session. chatController.js only ever hands in COMPLETE prior turns
// (it captures conversationHistory before pushing the new user message,
// and a turn is only ever persisted after it fully succeeds), so this
// array is always an even-length, strictly-alternating user/assistant
// sequence starting with "user". Slicing the last N=8 (also even) keeps
// that invariant: slice(-8) of an even-length alternating array always
// still starts with "user" and never splits a user/assistant pair -
// never a malformed request. 8 messages (4 user+assistant pairs) keeps
// enough immediate context for "what about last quarter"/"compare
// that"-style follow-ups while capping the worst-case resend cost
// regardless of how long a chat gets. This only bounds what's SENT to
// Claude for this turn - the persisted chat history in MongoDB, and
// what the user sees on reload, are completely unaffected.
const HISTORY_WINDOW_MESSAGES = 8;

async function handleChatTurn({ context, userMessage, conversationHistory = [], claudeClient }) {
  if (!context || !context.tenantId) {
    throw new Error("handleChatTurn requires an authorized company context.");
  }

  if (typeof claudeClient !== "function") {
    throw new Error("handleChatTurn requires a claudeClient function.");
  }

  const windowedHistory = conversationHistory.slice(-HISTORY_WINDOW_MESSAGES);

  const messages = [
    ...windowedHistory,
    { role: "user", content: userMessage },
  ];

  const toolResults = [];
  const warnings = [];
  let finalText = null;

  // Bounded loop: Claude may call a tool, then respond to the result
  // with another tool call, etc. Capped so a misbehaving/looping model
  // can't spin forever or run unbounded tool calls.
  const MAX_TURNS = 4;

  // Built fresh per turn (not once at module load) so "today" is always
  // the real current server date, including across a server that's been
  // running for days without a restart. Only the trailing date block is
  // actually fresh each time - the first (cached) block is the same
  // SYSTEM_PROMPT reference every turn, which is what makes it cacheable.
  const systemPromptBlocks = buildSystemPromptBlocks();

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const response = await claudeClient(messages, CACHEABLE_TOOL_DEFINITIONS, systemPromptBlocks);

    const toolUseBlocks = (response.content || []).filter((b) => b.type === "tool_use");
    const textBlocks = (response.content || []).filter((b) => b.type === "text");

    if (toolUseBlocks.length === 0) {
      finalText = textBlocks.map((b) => b.text).join("\n").trim();
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResultContent = [];

    for (const block of toolUseBlocks) {
      const outcome = await executeToolCall({
        toolName: block.name,
        toolInput: block.input,
        context,
      });

      toolResults.push({ toolName: block.name, result: outcome.result });

      if (outcome.isError) {
        toolResultContent.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: outcome.error,
        });
        continue;
      }

      if (outcome.result.state !== "valid_data") {
        warnings.push(outcome.result.message);
      }

      toolResultContent.push({
        type: "tool_result",
        tool_use_id: block.id,
        // Only the trust-enveloped, already-minimized analytics result -
        // never a raw Mongo document, never other tenants' data.
        content: JSON.stringify(outcome.result),
      });
    }

    messages.push({ role: "user", content: toolResultContent });
  }

  if (finalText === null) {
    // Hit MAX_TURNS without a final text answer - do not fabricate one.
    finalText =
      "I wasn't able to complete this request in a reasonable number of steps. Please try rephrasing your question.";
    warnings.push("Tool-call loop exceeded the maximum number of turns.");
  }

  return buildStructuredResponse({ finalText, toolResults, warnings });
}

// Real network call to the Anthropic Messages API. Returns the response
// as-is (it already has the exact {content: [{type: "text"|"tool_use",
// ...}]} shape handleChatTurn expects - no translation layer needed).
//
// Never logs `messages`/`systemPrompt` or the response body - both can
// contain business figures and are not appropriate for general logs.
// Only a minimal, non-sensitive failure signal is logged on error.
async function callClaude(messages, tools, systemPrompt) {
  const client = getAnthropicClient();

  try {
    return await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: MAX_RESPONSE_TOKENS,
      system: systemPrompt,
      messages,
      tools,
    });
  } catch (error) {
    console.error(
      "Claude API call failed:",
      error?.status ? `HTTP ${error.status}` : error?.message || "unknown error"
    );
    throw error;
  }
}

module.exports = {
  handleChatTurn,
  callClaude,
  SYSTEM_PROMPT,
  buildSystemPrompt,
  buildSystemPromptBlocks,
  CACHEABLE_TOOL_DEFINITIONS,
  HISTORY_WINDOW_MESSAGES,
};
