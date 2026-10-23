import { useEffect, useRef, useState } from "react";
import { Check, MessageSquare, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
import { MAX_CHAT_TITLE_CHARS } from "../../api/chat";
import { cn } from "../../lib/cn";

// Per-chat actions (⋯ → Rename / Delete) open inline under the row, so they are never clipped by the
// scrolling list. Selecting a chat, renaming it and deleting it are three separate controls: clicking the
// row only ever opens the chat.
export default function ChatSidebarList({ chats, activeChatId, onSelect, onNew, onDelete, onRename, loading }) {
  const [menuFor, setMenuFor] = useState(null); // chat id whose actions are open
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(null); // chat id being renamed
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const menuRef = useRef(null);
  const triggerRefs = useRef({});

  const closeMenu = (restoreFocus) => {
    const id = menuFor;
    setMenuFor(null);
    setConfirmDelete(false);
    if (restoreFocus && id) triggerRefs.current[id]?.focus();
  };

  // Outside click / Escape closes the actions panel.
  useEffect(() => {
    if (!menuFor) return undefined;
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || triggerRefs.current[menuFor]?.contains(e.target)) return;
      setMenuFor(null);
      setConfirmDelete(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") closeMenu(true);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuFor]);

  function startRename(chat) {
    setMenuFor(null);
    setConfirmDelete(false);
    setRenaming(chat._id);
    setDraft(chat.title || "");
    setRenameError("");
  }

  function cancelRename() {
    const id = renaming;
    setRenaming(null);
    setRenameError("");
    if (id) setTimeout(() => triggerRefs.current[id]?.focus(), 0);
  }

  async function saveRename(e) {
    e.preventDefault();
    const title = draft.trim();
    if (!title) {
      setRenameError("The name can't be empty.");
      return;
    }
    const current = chats.find((c) => c._id === renaming);
    if (current && current.title === title) {
      cancelRename();
      return;
    }
    setBusy(true);
    try {
      await onRename(renaming, title);
      cancelRename();
    } catch (err) {
      setRenameError(err?.message || "Couldn't rename this chat.");
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(chatId) {
    setBusy(true);
    setDeleteError("");
    try {
      await onDelete(chatId);
      setMenuFor(null);
      setConfirmDelete(false);
    } catch (err) {
      setDeleteError(err?.message || "Couldn't delete this chat.");
    } finally {
      setBusy(false);
    }
  }

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
            {chats.map((chat) => {
              const active = activeChatId === chat._id;
              const open = menuFor === chat._id;

              if (renaming === chat._id) {
                return (
                  <li key={chat._id} className="rounded-lg bg-surface-alt p-1.5">
                    <form onSubmit={saveRename} className="flex items-center gap-1">
                      <input
                        autoFocus
                        onFocus={(e) => e.target.select()}
                        value={draft}
                        maxLength={MAX_CHAT_TITLE_CHARS}
                        onChange={(e) => {
                          setDraft(e.target.value);
                          if (renameError) setRenameError("");
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancelRename();
                          }
                        }}
                        disabled={busy}
                        aria-label="Chat name"
                        aria-invalid={!!renameError}
                        className="h-8 min-w-0 flex-1 rounded-md border border-surface-border bg-white px-2 text-[13px] text-ink-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
                      />
                      <button
                        type="submit"
                        disabled={busy}
                        title="Save name"
                        aria-label="Save name"
                        className="rounded-md p-1.5 text-brand-600 hover:bg-white disabled:opacity-40"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={cancelRename}
                        disabled={busy}
                        title="Cancel"
                        aria-label="Cancel renaming"
                        className="rounded-md p-1.5 text-ink-500 hover:bg-white"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </form>
                    {renameError && (
                      <p role="alert" className="px-1 pt-1 text-[11.5px] text-danger-600">
                        {renameError}
                      </p>
                    )}
                  </li>
                );
              }

              return (
                <li key={chat._id} className="group">
                  <div className="relative">
                    <button
                      onClick={() => onSelect(chat._id)}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg py-2.5 pl-2.5 pr-9 text-left text-[13px]",
                        active ? "bg-brand-50 text-brand-700" : "text-ink-700 hover:bg-surface-alt"
                      )}
                    >
                      <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                      <span className="flex-1 truncate" title={chat.title || "New chat"}>
                        {chat.title || "New chat"}
                      </span>
                    </button>
                    <button
                      ref={(el) => {
                        triggerRefs.current[chat._id] = el;
                      }}
                      onClick={() => {
                        setConfirmDelete(false);
                        setDeleteError("");
                        setMenuFor(open ? null : chat._id);
                      }}
                      title="Chat actions"
                      aria-label={`Actions for ${chat.title || "chat"}`}
                      aria-expanded={open}
                      aria-controls={open ? `chat-actions-${chat._id}` : undefined}
                      className={cn(
                        "absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-500 hover:bg-surface-border hover:text-ink-900 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200",
                        open || active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                      )}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </div>

                  {open && (
                    <div
                      id={`chat-actions-${chat._id}`}
                      ref={menuRef}
                      className="mx-1 mt-1 mb-1.5 rounded-lg border border-surface-border bg-white p-1 shadow-sm"
                    >
                      {confirmDelete ? (
                        <div className="p-1.5">
                          <p className="mb-2 text-[12.5px] text-ink-700">Delete this chat? This can’t be undone.</p>
                          {deleteError && (
                            <p role="alert" className="mb-2 text-[11.5px] text-danger-600">
                              {deleteError}
                            </p>
                          )}
                          <div className="flex gap-1.5">
                            <button
                              autoFocus
                              onClick={() => doDelete(chat._id)}
                              disabled={busy}
                              className="flex-1 rounded-md bg-danger-600 px-2 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                            >
                              Delete
                            </button>
                            <button
                              onClick={() => closeMenu(true)}
                              disabled={busy}
                              className="flex-1 rounded-md border border-surface-border px-2 py-1.5 text-[12.5px] text-ink-700 hover:bg-surface-alt"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <button
                            autoFocus
                            onClick={() => startRename(chat)}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-700 hover:bg-surface-alt focus:bg-surface-alt focus:outline-none"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Rename
                          </button>
                          <button
                            onClick={() => setConfirmDelete(true)}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-danger-600 hover:bg-danger-50 focus:bg-danger-50 focus:outline-none"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
