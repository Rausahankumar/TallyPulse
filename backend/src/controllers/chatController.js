const mongoose = require("mongoose");
const { GENERIC_SERVER_ERROR } = require("../middleware/errorHandler");
const Chat = require("../models/chat.model");
const { handleChatTurn, callClaude } = require("../services/ai/chatOrchestrator");
const { tryAnswerWithQueryEngine, createTurnDates, chatTelemetry } = require("../services/query/queryChat");

const { now, meterClaudeClient, emitChatTurn } = chatTelemetry;

// --------------------------------------------------
// POST /api/chat/:chatId?/message
//
// Flow: auth middleware (JWT) -> activeCompanyContext middleware
// (authorization-verified tenant) -> this controller persists/loads chat
// history scoped to {tenantId, userId} -> handleChatTurn (tool layer) ->
// persist the assistant's structured response.
//
// If ANTHROPIC_API_KEY isn't configured on the backend, callClaude()
// throws an AI_NOT_CONFIGURED error caught below and returned as a 503 -
// a distinct, honest "AI isn't available right now" state, never a
// fabricated answer and never a raw stack trace to the client.
// --------------------------------------------------

// Status recorded (telemetry only - nothing is sent) when the client closed the connection first.
const CLIENT_CLOSED_REQUEST = 499;

const sendChatMessage = async (req, res) => {
  const turnStart = now();
  let turn = null; // per-turn telemetry (P1-1); set once the AI part of the turn starts
  // Stop / navigation in the browser aborts the HTTP request, which closes this response before it is
  // written. From then on: no planner call, no legacy Claude call, no further Claude round, no save.
  // (`res` "close", not `req` "close": the latter also fires once the request body has been read.)
  // A Stop that lands while auth/company middleware is still running closes the connection BEFORE this
  // listener exists, and "close" is never re-emitted - so an already-closed response is checked directly.
  const clientAbort = new AbortController();
  const onClientClose = () => {
    if (!res.writableFinished) clientAbort.abort();
  };
  if (res.destroyed || res.closed) onClientClose();
  else res.on("close", onClientClose);
  const { signal } = clientAbort;
  const endIfAborted = () => {
    if (!signal.aborted) return false;
    if (turn) {
      turn.httpStatus = CLIENT_CLOSED_REQUEST;
      turn.clientAborted = true;
    }
    return true;
  };
  try {
    const { message } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: "A non-empty 'message' field is required.",
      });
    }

    // req.companyContext is set by the activeCompanyContext middleware -
    // already authorization-checked. Never derive tenant from req.body.
    const { tenantId } = req.companyContext;
    const userId = req.user.id;

    let chat;
    if (req.params.chatId) {
      if (!mongoose.isValidObjectId(req.params.chatId)) {
        return res.status(404).json({ success: false, message: "Chat not found." });
      }

      chat = await Chat.findOne({ _id: req.params.chatId, tenantId, userId });
      if (!chat) {
        return res.status(404).json({
          success: false,
          message: "Chat not found (or not owned by this user/company).",
        });
      }
    } else {
      // In-memory only until the turn actually succeeds below (chat.save())
      // - a failed AI call (e.g. Claude API down) should not leave an
      // empty orphan chat behind.
      chat = new Chat({
        tenantId,
        userId,
        title: message.slice(0, 60),
        messages: [],
      });
    }

    const conversationHistory = chat.messages.map((m) => ({
      role: m.role,
      content: m.text,
    }));
    // Structured context of the previous ENGINE answer (the plan it ran), for follow-ups such as "and by
    // customer?". Server-side only: it is never part of the history sent to Claude.
    const last = chat.messages[chat.messages.length - 1];
    const previousQuery = last && last.role === "assistant" && last.queryContext ? last.queryContext : null;

    chat.messages.push({ role: "user", text: message });

    const chatContext = { tenantId, companyGuid: req.companyContext.companyGuid };

    // Sales/Purchase questions go router -> planner -> validator -> cache -> engine first. Anything that
    // path cannot answer (or a disabled/failed engine) falls through to the existing tool chat unchanged.
    // ONE tenant reference date per turn (read at most once, only if needed), shared by the engine and legacy chat.
    const turnDates = createTurnDates(tenantId);
    // req.id: the same id already returned as the X-Request-Id response header (middleware/requestId.js) -
    // carried into the cost telemetry line so a specific request can be matched to its exact Claude-cost
    // decision (P0 cost-forensics, Phase 8: "which exact code path called Claude").
    turn = { tenantId, requestId: req.id, metrics: null, legacy: null, legacyMs: null, httpStatus: null, turnDates, clientAborted: false };
    const engine = await tryAnswerWithQueryEngine({ context: chatContext, userMessage: message, conversationHistory, previousQuery, getDateContext: turnDates, signal });
    turn.metrics = engine.telemetry || null;
    // Checked BEFORE the legacy branch: a cancelled turn never becomes a legacy Claude call.
    if (endIfAborted()) return;

    // Legacy path: the same Claude client, only counted (calls + the usage Claude already returns) for the turn event.
    if (!engine.handled) turn.legacy = meterClaudeClient(callClaude);
    const legacyStart = now();

    const structured = engine.handled
      ? engine.structured
      : await handleChatTurn({
          context: chatContext,
          userMessage: message,
          conversationHistory,
          claudeClient: turn.legacy.client,
          getDateContext: turnDates,
          signal,
        }).finally(() => {
          turn.legacyMs = now() - legacyStart;
        });
    // Nobody is waiting for this answer any more: don't persist a turn the user stopped.
    if (endIfAborted()) return;

    chat.messages.push({
      role: "assistant",
      text: structured.answer,
      toolCalls: structured.details.toolCalls,
      visualization: structured.visualization,
      dataAsOf: structured.dataAsOf,
      freshness: structured.freshness,
      warnings: structured.warnings,
      queryContext: engine.handled && engine.queryContext ? engine.queryContext : undefined,
    });

    await chat.save();

    turn.httpStatus = 200;
    return res.status(200).json({
      success: true,
      chatId: String(chat._id),
      data: structured,
    });
  } catch (error) {
    // The client is gone (its abort also rejects the in-flight Claude request): nothing to answer, nothing to log.
    if (endIfAborted()) return;
    if (turn) turn.httpStatus = error && error.code === "AI_NOT_CONFIGURED" ? 503 : error && typeof error.status === "number" ? error.status : 500;
    // Missing/misconfigured API key -> a distinct, honest "not
    // available" response, never a generic 500 or a fabricated answer.
    if (error.code === "AI_NOT_CONFIGURED") {
      return res.status(503).json({
        success: false,
        message: error.message,
      });
    }

    // The Anthropic SDK attaches `status` to HTTP-level failures (rate
    // limit, auth, overloaded, etc.) - surface that status rather than
    // always answering 500, without leaking the raw error body.
    const upstreamStatus = typeof error.status === "number" ? error.status : null;

    if (!upstreamStatus) {
      // Name and message only: never the request, the prompt or a response body.
      console.error("CHAT ERROR:", error && error.name, error && error.message);
    }

    return res.status(upstreamStatus || 500).json({
      success: false,
      message: upstreamStatus
        ? "The AI service is temporarily unavailable. Please try again shortly."
        : GENERIC_SERVER_ERROR,
    });
  } finally {
    // One structured event per AI turn; emitChatTurn never throws.
    if (turn) emitChatTurn({ ...turn, dates: turn.turnDates.peek(), totalMs: now() - turnStart });
  }
};

const listChats = async (req, res) => {
  const { tenantId } = req.companyContext;
  const userId = req.user.id;

  const chats = await Chat.find({ tenantId, userId })
    .select("title createdAt updatedAt")
    .sort({ updatedAt: -1 })
    .lean();

  return res.status(200).json({ success: true, data: chats });
};

const getChat = async (req, res) => {
  const { tenantId } = req.companyContext;
  const userId = req.user.id;

  // A malformed id can never match a chat: answer "not found", not a database error (F-12).
  if (!mongoose.isValidObjectId(req.params.chatId)) {
    return res.status(404).json({ success: false, message: "Chat not found." });
  }

  const chat = await Chat.findOne({ _id: req.params.chatId, tenantId, userId }).lean();

  if (!chat) {
    return res.status(404).json({ success: false, message: "Chat not found." });
  }

  return res.status(200).json({ success: true, data: chat });
};

const deleteChat = async (req, res) => {
  const { tenantId } = req.companyContext;
  const userId = req.user.id;

  if (!mongoose.isValidObjectId(req.params.chatId)) {
    return res.status(404).json({ success: false, message: "Chat not found." });
  }

  const result = await Chat.deleteOne({ _id: req.params.chatId, tenantId, userId });

  if (result.deletedCount === 0) {
    return res.status(404).json({ success: false, message: "Chat not found." });
  }

  return res.status(200).json({ success: true, message: "Chat deleted." });
};

const MAX_CHAT_TITLE_CHARS = 100;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

// PATCH /api/chat/:chatId  {title}. Only the title changes: messages, id and ordering are untouched
// (timestamps are not bumped, so a rename doesn't move the chat to the top of the list). Same ownership
// filter as getChat/deleteChat - another user's or another company's chat is simply "not found".
const renameChat = async (req, res) => {
  const { tenantId } = req.companyContext;
  const userId = req.user.id;

  if (!mongoose.isValidObjectId(req.params.chatId)) {
    return res.status(404).json({ success: false, message: "Chat not found." });
  }

  const raw = req.body ? req.body.title : undefined;
  if (typeof raw !== "string") {
    return res.status(400).json({ success: false, message: "A 'title' is required." });
  }
  const title = raw.trim();
  if (!title) {
    return res.status(400).json({ success: false, message: "The chat name can't be empty." });
  }
  if (title.length > MAX_CHAT_TITLE_CHARS) {
    return res.status(400).json({ success: false, message: `The chat name can be at most ${MAX_CHAT_TITLE_CHARS} characters.` });
  }
  if (CONTROL_CHARS_RE.test(title)) {
    return res.status(400).json({ success: false, message: "The chat name can't contain line breaks or control characters." });
  }

  const chat = await Chat.findOneAndUpdate(
    { _id: req.params.chatId, tenantId, userId },
    { $set: { title } },
    { returnDocument: "after", runValidators: true, timestamps: false, projection: { title: 1, createdAt: 1, updatedAt: 1 } }
  ).lean();

  if (!chat) {
    return res.status(404).json({ success: false, message: "Chat not found." });
  }

  return res.status(200).json({ success: true, data: chat });
};

module.exports = {
  sendChatMessage,
  listChats,
  getChat,
  renameChat,
  deleteChat,
  MAX_CHAT_TITLE_CHARS,
};
