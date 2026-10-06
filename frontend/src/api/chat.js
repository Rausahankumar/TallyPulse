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

// PATCH /api/chat/:chatId - only the title changes (the backend trims, bounds and ownership-checks it).
export const MAX_CHAT_TITLE_CHARS = 100;
export async function renameChat(chatId, title) {
  const { data } = await client.patch(`/chat/${chatId}`, { title });
  return data.data; // {_id, title, createdAt, updatedAt}
}

export async function deleteChat(chatId) {
  const { data } = await client.delete(`/chat/${chatId}`);
  return data;
}

// POST /api/chat/message (new chat) or /api/chat/:chatId/message
// (continue). The backend has Claude turn the question into a structured
// query plan, then computes the answer with the deterministic query engine.
// A failure to plan is answered with an honest message (HTTP 200), so the
// caller only sees an ApiError for transport and server errors.
//
// Chat requests get their own, longer timeout (per-call override, not a
// change to `client`'s shared default): planning plus a large aggregation
// can legitimately take longer than the 20s default that exists for
// Tally/network protection on every other endpoint. See client.js's own
// comment for why that default exists and stays untouched for every other
// call.
const CHAT_TIMEOUT_MS = 60000;

// `signal` (AbortController): aborting it cancels the HTTP request; the backend sees the disconnect and
// stops the turn (no further Claude call, nothing saved). It rejects with ApiError code "CANCELED".
export async function sendChatMessage({ chatId, message, signal }) {
  const path = chatId ? `/chat/${chatId}/message` : "/chat/message";
  const { data } = await client.post(path, { message }, { timeout: CHAT_TIMEOUT_MS, signal });
  return data; // { success, chatId, data: structuredResponse }
}

export const AI_NOT_CONFIGURED_STATUS = 503;
