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
async function handleChatTurn({ context, userMessage, conversationHistory = [], claudeClient }) {
  if (!context || !context.tenantId) {
    throw new Error("handleChatTurn requires an authorized company context.");
  }

  if (typeof claudeClient !== "function") {
    throw new Error("handleChatTurn requires a claudeClient function.");
  }

  const messages = [
    ...conversationHistory,
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
  // running for days without a restart.
  const systemPrompt = buildSystemPrompt();

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const response = await claudeClient(messages, TOOL_DEFINITIONS, systemPrompt);

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
};
