import { useEffect, useRef, useState } from "react";
import { Sparkles, Trash2 } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import ChatSidebarList from "../components/chat/ChatSidebarList";
import ChatBubble from "../components/chat/ChatBubble";
import ChatInput from "../components/chat/ChatInput";
import SuggestedQuestions from "../components/chat/SuggestedQuestions";
import Button from "../components/ui/Button";
import { useCompany } from "../context/useCompany";
import { listChats, getChat, sendChatMessage, deleteChat, renameChat } from "../api/chat";
import { ApiError } from "../api/client";

// Prompt chips shown under the conversation; each one is a question the query engine can answer.
const SUGGESTED_QUESTIONS = ["Top customers", "Purchase summary", "Sales this month", "Product growth"];

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
    <div className="flex h-[calc(100vh-8.5rem)] flex-col lg:h-[calc(100vh-7rem)]">
      <PageHeader
        title="Ask TallyPulse"
        subtitle="Your AI assistant for business insights"
        action={
          <Button variant="secondary" size="sm" icon={Trash2} onClick={handleNew}>
            Clear chat
          </Button>
        }
      />

      <div className="flex flex-1 overflow-hidden rounded-2xl border border-surface-border bg-white shadow-card">
        <div className="hidden md:block">
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
          <div className="flex items-center justify-between gap-3 border-b border-surface-border px-4 py-2.5">
            <h2 className="min-w-0 truncate text-[13.5px] font-semibold text-ink-900" title={activeTitle}>
              {activeTitle}
            </h2>
            <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-ink-500">
              <Sparkles className="h-3.5 w-3.5 text-brand-600" />
              <span className="hidden sm:inline">Answering for</span>
              <strong className="max-w-[10rem] truncate font-medium text-ink-700">{activeCompany?.companyName}</strong>
            </span>
          </div>

          <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-4">
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

          <SuggestedQuestions questions={SUGGESTED_QUESTIONS} onPick={handleSend} />
          <ChatInput onSend={handleSend} onStop={() => cancelInflight("user")} sending={sending} />
        </div>
      </div>
    </div>
  );
}
