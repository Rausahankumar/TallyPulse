const mongoose = require("mongoose");
const { GENERIC_SERVER_ERROR } = require("../middleware/errorHandler");
const Chat = require("../models/chat.model");
const { handleChatTurn, callClaude } = require("../services/ai/chatOrchestrator");

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

const sendChatMessage = async (req, res) => {
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

    chat.messages.push({ role: "user", text: message });

    const structured = await handleChatTurn({
      context: { tenantId, companyGuid: req.companyContext.companyGuid },
      userMessage: message,
      conversationHistory,
      claudeClient: callClaude,
    });

    chat.messages.push({
      role: "assistant",
      text: structured.answer,
      toolCalls: structured.details.toolCalls,
      visualization: structured.visualization,
      dataAsOf: structured.dataAsOf,
      freshness: structured.freshness,
      warnings: structured.warnings,
    });

    await chat.save();

    return res.status(200).json({
      success: true,
      chatId: String(chat._id),
      data: structured,
    });
  } catch (error) {
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

module.exports = {
  sendChatMessage,
  listChats,
  getChat,
  deleteChat,
};
