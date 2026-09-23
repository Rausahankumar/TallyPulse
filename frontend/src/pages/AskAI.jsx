import { useEffect, useRef, useState } from "react";
import { Sparkles, Trash2 } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import ChatSidebarList from "../components/chat/ChatSidebarList";
import ChatBubble from "../components/chat/ChatBubble";
import ChatInput from "../components/chat/ChatInput";
import SuggestedQuestions from "../components/chat/SuggestedQuestions";
import AiNotConnectedNotice from "../components/chat/AiNotConnectedNotice";
import DemoInsightCard from "../components/chat/DemoInsightCard";
import Button from "../components/ui/Button";
import { useCompany } from "../context/useCompany";
import { listChats, getChat, sendChatMessage, deleteChat } from "../api/chat";
import { ApiError } from "../api/client";
import { MOCK_AI_DEMO_TURN, MOCK_SUGGESTED_QUESTIONS } from "../mock/mockData";

// Every piece of local turn state below is one of three real kinds:
// a persisted {role, text, ...} message straight from the backend's
// Chat model, a "system" notice (AI not connected — 501), or a "demo"
// turn the user explicitly asked to preview. Nothing is presented as
// a real AI answer unless it actually came back from the backend.
export default function AskAI() {
  const { activeCompany } = useCompany();
  const [chats, setChats] = useState([]);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [activeChatId, setActiveChatId] = useState(null);
  const [turns, setTurns] = useState([]);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    refreshChatList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompany?.tenantId]);

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

  async function handleSelect(chatId) {
    setActiveChatId(chatId);
    try {
      const chat = await getChat(chatId);
      setTurns(chat.messages.map((m) => ({ kind: "message", message: m })));
    } catch {
      setTurns([{ kind: "error", text: "Couldn't load this conversation." }]);
    }
  }

  function handleNew() {
    setActiveChatId(null);
    setTurns([]);
  }

  async function handleDelete(chatId) {
    await deleteChat(chatId).catch(() => {});
    setChats((c) => c.filter((chat) => chat._id !== chatId));
    if (activeChatId === chatId) handleNew();
  }

  async function handleSend(text) {
    setTurns((t) => [...t, { kind: "message", message: { role: "user", text } }]);
    setSending(true);
    try {
      const result = await sendChatMessage({ chatId: activeChatId, message: text });
      setActiveChatId(result.chatId);
      setTurns((t) => [
        ...t,
        { kind: "message", message: { role: "assistant", text: result.data.answer, ...result.data } },
      ]);
      refreshChatList();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 503 || err.status === 501)) {
        setTurns((t) => [...t, { kind: "not-connected", message: err.message }]);
      } else {
        // retryText carries the original message forward so "Retry"
        // resends the exact same question as a new, explicit send — it
        // never auto-retries and never re-fires the request that just
        // failed, so one timeout can't silently turn into two requests.
        setTurns((t) => [
          ...t,
          { kind: "error", text: err instanceof ApiError ? err.message : "Something went wrong.", retryText: text },
        ]);
      }
    } finally {
      setSending(false);
    }
  }

  function handleShowDemo() {
    setTurns((t) => [...t, { kind: "demo", turn: MOCK_AI_DEMO_TURN }]);
  }

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
            loading={chatsLoading}
          />
        </div>

        <div className="flex flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-surface-border px-4 py-2.5">
            <span className="flex items-center gap-1.5 text-[12.5px] text-ink-500">
              <Sparkles className="h-3.5 w-3.5 text-brand-600" />
              Answering for <strong className="font-medium text-ink-700">{activeCompany?.companyName}</strong>
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
              if (turn.kind === "not-connected")
                return <AiNotConnectedNotice key={i} message={turn.message} onShowDemo={handleShowDemo} />;
              if (turn.kind === "demo") return <DemoInsightCard key={i} turn={turn.turn} onFollowUp={handleSend} />;
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

          <SuggestedQuestions questions={MOCK_SUGGESTED_QUESTIONS} onPick={handleSend} />
          <ChatInput onSend={handleSend} disabled={sending} />
        </div>
      </div>
    </div>
  );
}
