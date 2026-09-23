import client from "./client";

// All routes in backend/src/routes/chatRoutes.js — every one requires
// JWT auth + a resolved company context, both enforced server-side.

export async function listChats() {
  const { data } = await client.get("/chat/");
  return data.data; // [{_id, title, createdAt, updatedAt}]
}

export async function getChat(chatId) {
  const { data } = await client.get(`/chat/${chatId}`);
  return data.data; // {_id, tenantId, userId, title, messages:[...]}
}

export async function deleteChat(chatId) {
  const { data } = await client.delete(`/chat/${chatId}`);
  return data;
}

// POST /api/chat/message (new chat) or /api/chat/:chatId/message
// (continue). The backend calls the real Anthropic API and the
// deterministic Analytics Engine tools. If ANTHROPIC_API_KEY isn't
// configured on the server, this comes back as HTTP 503 — callers
// should treat that as an expected, distinct "AI not available" state,
// not a generic error.
//
// Chat requests get their own, longer timeout (per-call override, not a
// change to `client`'s shared default): a turn needing 2-3 sequential
// Claude tool calls can legitimately take longer than the 20s default
// that exists for Tally/network protection on every other endpoint. See
// client.js's own comment for why that default exists and stays
// untouched for every other call.
const CHAT_TIMEOUT_MS = 60000;

export async function sendChatMessage({ chatId, message }) {
  const path = chatId ? `/chat/${chatId}/message` : "/chat/message";
  const { data } = await client.post(path, { message }, { timeout: CHAT_TIMEOUT_MS });
  return data; // { success, chatId, data: structuredResponse }
}

export const AI_NOT_CONFIGURED_STATUS = 503;
