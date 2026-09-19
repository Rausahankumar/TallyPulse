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
export async function sendChatMessage({ chatId, message }) {
  const path = chatId ? `/chat/${chatId}/message` : "/chat/message";
  const { data } = await client.post(path, { message });
  return data; // { success, chatId, data: structuredResponse }
}

export const AI_NOT_CONFIGURED_STATUS = 503;
