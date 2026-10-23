import { useEffect, useRef, useState } from "react";
import { PanelLeft, Sparkles, Trash2 } from "lucide-react";
import ChatSidebarList from "../components/chat/ChatSidebarList";
import ChatBubble from "../components/chat/ChatBubble";
import ChatInput from "../components/chat/ChatInput";
import { useCompany } from "../context/useCompany";
import { listChats, getChat, sendChatMessage, deleteChat, renameChat } from "../api/chat";
import { ApiError } from "../api/client";

// The chat-history column sits inline from Tailwind's xl width up; below it, it opens as a drawer over the chat.
const WIDE_QUERY = "(min-width: 1280px)";
const HISTORY_PREF_KEY = "tallypulse.askAi.historyOpen";

function isWide() {
  return typeof window !== "undefined" && window.matchMedia(WIDE_QUERY).matches;
}

// Narrow screens always start with the drawer closed. Wide screens use the user's last choice, else open
// only when there is room to spare (2xl), so a 1280px laptop starts with the full width for the conversation.
function initialHistoryOpen() {
  if (!isWide()) return false;
  try {
    const saved = window.localStorage.getItem(HISTORY_PREF_KEY);
    if (saved === "1" || saved === "0") return saved === "1";
  } catch {
    // Best-effort only - blocked storage falls back to the width default.
  }
  return window.matchMedia("(min-width: 1536px)").matches;
}

// Local turn state is one of: a message ({role, text, ...} as stored in the
// backend's Chat model), a "stopped" note after the user pressed Stop, or an
// "error" with a Retry. Answers only ever come back from the backend.
export default function AskAI() {
  const { activeCompany } = useCompany();
  const [chats, setChats] = useState([]);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [activeChatId, setActiveChatId] = useState(null);
  const [turns, setTurns] = useState([]);
  const [sending, setSending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(initialHistoryOpen);
  const bottomRef = useRef(null);
  // The one in-flight chat request: {controller, cancelledBy: null | "user" | "navigation"}.
  const inflight = useRef(null);

  useEffect(() => {
    refreshChatList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompany?.tenantId]);

  // Leaving the page cancels a running request (nothing would show its answer).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => cancelInflight("navigation"), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  function toggleHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (!isWide()) return;
    try {
      window.localStorage.setItem(HISTORY_PREF_KEY, next ? "1" : "0");
    } catch {
      // Best-effort only.
    }
  }

  // The drawer is in the way once a choice is made on a narrow screen; the inline column stays put.
  function closeDrawer() {
    if (!isWide()) setHistoryOpen(false);
  }

  async function refreshChatList() {
    setChatsLoading(true);
    try {
      const data = await listChats();
      setChats(data);
    } catch {
      setChats([]);
    } finally {
      setChatsLoading(false);
    }
  }

  // Aborts the HTTP request itself (not just the spinner): the backend sees the disconnect and ends the
  // turn - no further Claude call and nothing saved. Never retried or re-sent.
  function cancelInflight(by) {
    const req = inflight.current;
    if (!req) return;
    req.cancelledBy = by;
    req.controller.abort();
    inflight.current = null;
    setSending(false); // immediately: the next question can be sent right away
  }

  async function handleSelect(chatId) {
    cancelInflight("navigation");
    closeDrawer();
    setActiveChatId(chatId);
    try {
      const chat = await getChat(chatId);
      setTurns(chat.messages.map((m) => ({ kind: "message", message: m })));
    } catch {
      setTurns([{ kind: "error", text: "Couldn't load this conversation." }]);
    }
  }

  function handleNew() {
    cancelInflight("navigation");
    closeDrawer();
    setActiveChatId(null);
    setTurns([]);
  }

  // Throws on failure (the sidebar shows it) - the chat is removed from the list only once the server confirms.
  async function handleDelete(chatId) {
    await deleteChat(chatId);
    setChats((c) => c.filter((chat) => chat._id !== chatId));
    if (activeChatId === chatId) handleNew();
  }

  // Throws on failure (the sidebar shows it); the list and header update from the server's saved title.
  async function handleRename(chatId, title) {
    const saved = await renameChat(chatId, title);
    setChats((c) => c.map((chat) => (chat._id === chatId ? { ...chat, title: saved.title } : chat)));
  }

  async function handleSend(text) {
    if (inflight.current) return; // one request at a time: no duplicate submits
    const req = { controller: new AbortController(), cancelledBy: null };
    inflight.current = req;
    setTurns((t) => [...t, { kind: "message", message: { role: "user", text } }]);
    setSending(true);
    try {
      const result = await sendChatMessage({ chatId: activeChatId, message: text, signal: req.controller.signal });
      if (req.cancelledBy) return;
      setActiveChatId(result.chatId);
      setTurns((t) => [
        ...t,
        { kind: "message", message: { role: "assistant", text: result.data.answer, ...result.data } },
      ]);
      refreshChatList();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CANCELED") {
        // Stop: a fixed local note, no request of any kind. Navigation: the view already changed - say nothing.
        if (req.cancelledBy === "user") {
          setTurns((t) => [...t, { kind: "stopped" }]);
          // If the server had already finished and saved before the abort arrived, the list picks that up.
          refreshChatList();
        }
        return;
      }
      // retryText carries the original message forward so "Retry"
      // resends the exact same question as a new, explicit send — it
      // never auto-retries and never re-fires the request that just
      // failed, so one timeout can't silently turn into two requests.
      setTurns((t) => [
        ...t,
        { kind: "error", text: err instanceof ApiError ? err.message : "Something went wrong.", retryText: text },
      ]);
    } finally {
      if (inflight.current === req) {
        inflight.current = null;
        setSending(false);
      }
    }
  }

  const activeTitle = (activeChatId && chats.find((c) => c._id === activeChatId)?.title) || "New chat";

  return (
    // Fills the main area exactly: topbar 4rem + main padding 2rem (3rem from sm); from lg AppLayout hides the
    // topbar on this page, leaving only the padding. dvh follows the mobile browser's visible height.
    <div className="flex h-[calc(100dvh-6rem)] flex-col sm:h-[calc(100dvh-7rem)] lg:h-[calc(100dvh-3rem)]">
      <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-2xl border border-surface-border bg-white shadow-card">
        {historyOpen && (
          <div
            className="absolute inset-0 z-10 bg-black/20 xl:hidden"
            onClick={() => setHistoryOpen(false)}
            aria-hidden="true"
          />
        )}
        <div
          className={
            historyOpen
              ? "absolute inset-y-0 left-0 z-20 max-w-[85%] shadow-xl xl:static xl:z-auto xl:max-w-none xl:shadow-none"
              : "hidden"
          }
        >
          <ChatSidebarList
            chats={chats}
            activeChatId={activeChatId}
            onSelect={handleSelect}
            onNew={handleNew}
            onDelete={handleDelete}
            onRename={handleRename}
            loading={chatsLoading}
          />
        </div>

        {/* min-w-0: without it this flex child grows to the widest answer table instead of letting it scroll */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-surface-border px-3 py-2 sm:px-4 sm:py-2.5">
            <button
              type="button"
              onClick={toggleHistory}
              title={historyOpen ? "Hide chat history" : "Show chat history"}
              aria-label={historyOpen ? "Hide chat history" : "Show chat history"}
              aria-expanded={historyOpen}
              className="-ml-1 shrink-0 rounded-md p-1.5 text-ink-500 hover:bg-surface-alt hover:text-ink-700"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink-900" title={activeTitle}>
              {activeTitle}
            </h2>
            <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-ink-500">
              <Sparkles className="h-3.5 w-3.5 text-brand-600" />
              <span className="hidden sm:inline">Answering for</span>
              <strong className="max-w-[7rem] truncate font-medium text-ink-700 sm:max-w-[10rem]">
                {activeCompany?.companyName}
              </strong>
            </span>
            <button
              type="button"
              onClick={handleNew}
              title="Clear chat"
              aria-label="Clear chat"
              className="shrink-0 rounded-md p-1.5 text-ink-500 hover:bg-surface-alt hover:text-ink-700"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
            {/* One centred reading column (like a chat app), so long answers keep a comfortable line length. */}
            <div className="mx-auto w-full max-w-3xl space-y-6">
              {turns.length === 0 && (
                <div className="flex gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600">
                    <Sparkles className="h-4 w-4 text-white" />
                  </span>
                  <div className="max-w-[75%] rounded-2xl bg-surface-alt px-4 py-2.5 text-[13.5px] leading-relaxed text-ink-800">
                    Hello! I'm TallyPulse AI. Ask me anything about your sales, purchases, customers or
                    products.
                  </div>
                </div>
              )}

              {turns.map((turn, i) => {
                if (turn.kind === "message") return <ChatBubble key={i} message={turn.message} />;
                if (turn.kind === "stopped")
                  return (
                    <p key={i} role="status" className="text-center text-[12.5px] text-ink-500">
                      Generation stopped.
                    </p>
                  );
                if (turn.kind === "error")
                  return (
                    <div key={i} className="flex flex-col items-center gap-1">
                      <p className="text-center text-[12.5px] text-danger-600">{turn.text}</p>
                      {turn.retryText && (
                        <button
                          type="button"
                          onClick={() => handleSend(turn.retryText)}
                          disabled={sending}
                          className="text-[12.5px] font-medium text-brand-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  );
                return null;
              })}

              {sending && (
                <div className="flex gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600">
                    <Sparkles className="h-4 w-4 text-white" />
                  </span>
                  <div className="flex items-center gap-1 rounded-2xl bg-surface-alt px-4 py-3">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-400"
                        style={{ animationDelay: `${i * 0.12}s` }}
                      />
                    ))}
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          <div className="mx-auto w-full max-w-3xl">
            <ChatInput onSend={handleSend} onStop={() => cancelInflight("user")} sending={sending} />
            <p className="px-3 pb-2 text-center text-[11.5px] text-ink-400">
              TallyPulse can make mistakes. Check important figures in Tally.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
