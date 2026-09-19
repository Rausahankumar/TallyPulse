import { Plus, MessageSquare, Trash2 } from "lucide-react";
import { cn } from "../../lib/cn";

export default function ChatSidebarList({ chats, activeChatId, onSelect, onNew, onDelete, loading }) {
  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-surface-border bg-white">
      <div className="p-3">
        <button
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-3 py-2.5 text-[13.5px] font-medium text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" />
          New chat
        </button>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <div className="space-y-2 px-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-surface-alt" />
            ))}
          </div>
        ) : chats.length === 0 ? (
          <p className="px-2 pt-4 text-center text-[12.5px] text-ink-400">
            No conversations yet — start one below.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {chats.map((chat) => (
              <li key={chat._id} className="group relative">
                <button
                  onClick={() => onSelect(chat._id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-2.5 text-left text-[13px]",
                    activeChatId === chat._id
                      ? "bg-brand-50 text-brand-700"
                      : "text-ink-600 hover:bg-surface-alt"
                  )}
                >
                  <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1 truncate">{chat.title || "New chat"}</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(chat._id);
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-400 opacity-0 hover:bg-surface-border hover:text-danger-600 group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
