import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import {
  Button,
  InputArea,
  Surface,
  Text,
  PoweredByCloudflare
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  MoonIcon,
  SunIcon,
  ChatCircleIcon,
  InfoIcon,
  BrainIcon
} from "@phosphor-icons/react";
import type { ChatSummary, InboxState } from "./server";

const DEMO_USER = "demo-user";

// ── Small UI helpers ───────────────────────────────────────────────

function ConnectionDot({
  status
}: {
  status: "connecting" | "connected" | "disconnected";
}) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  return <span className={`size-2 rounded-full ${dot}`} />;
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);
  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function messageText(m: UIMessage): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

// ── Active chat pane ───────────────────────────────────────────────

function ActiveChat({ chatId }: { chatId: string }) {
  // The active chat lives as a facet of the user's Inbox. The `sub`
  // option builds the nested URL
  // `/agents/inbox/{DEMO_USER}/sub/chat/{chatId}` — no separate DO
  // binding, no custom routing on the server. The parent's
  // `onBeforeSubAgent` gate runs once at connection time; after the
  // WebSocket is upgraded, frames flow straight to the `Chat` DO.
  const agent = useAgent({
    agent: "Inbox",
    name: DEMO_USER,
    sub: [{ agent: "Chat", name: chatId }]
  });
  const { messages, sendMessage, status, setMessages } = useAgentChat({
    agent
  });

  // Clear local state when switching chats.
  const prevId = useRef(chatId);
  useEffect(() => {
    if (prevId.current !== chatId) {
      prevId.current = chatId;
      setMessages([]);
    }
  }, [chatId, setMessages]);

  const [input, setInput] = useState("");
  const send = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim()) return;
      sendMessage({ text: input });
      setInput("");
    },
    [input, sendMessage]
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [messages.length]);

  return (
    <div className="flex flex-col h-full">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 flex flex-col gap-3"
      >
        {messages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <Text variant="secondary" size="sm">
              Send the first message to start this chat.
            </Text>
          </div>
        ) : (
          messages.map((m) => (
            <Surface
              key={m.id}
              className={`p-3 rounded-xl max-w-[85%] ${
                m.role === "user" ? "self-end bg-kumo-accent/10" : "self-start"
              }`}
            >
              <Text size="xs" variant="secondary">
                {m.role}
              </Text>
              <div className="mt-1 whitespace-pre-wrap">
                <Text size="sm">{messageText(m)}</Text>
              </div>
            </Surface>
          ))
        )}
      </div>
      <form
        onSubmit={send}
        className="border-t border-kumo-line p-3 flex gap-2"
      >
        <InputArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          disabled={status !== "ready"}
          className="flex-1"
        />
        <Button
          type="submit"
          disabled={status !== "ready" || !input.trim()}
          icon={<PaperPlaneRightIcon size={16} />}
        >
          Send
        </Button>
      </form>
    </div>
  );
}

// ── Main app ───────────────────────────────────────────────────────

export default function App() {
  // Single connection to the user's Inbox. Drives the sidebar state
  // + the memory editor via @callable.
  const inbox = useAgent<InboxState>({
    agent: "inbox",
    name: DEMO_USER
  });

  const chats: ChatSummary[] = useMemo(
    () => inbox.state?.chats ?? [],
    [inbox.state]
  );
  const [activeId, setActiveId] = useState<string | null>(null);

  // When the sidebar updates, auto-select the most recent chat if
  // nothing is active or the active one was deleted.
  useEffect(() => {
    if (chats.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!activeId || !chats.some((c) => c.id === activeId)) {
      setActiveId(chats[0].id);
    }
  }, [chats, activeId]);

  const createChat = useCallback(async () => {
    const created = (await inbox.call("createChat")) as ChatSummary;
    setActiveId(created.id);
  }, [inbox]);

  const deleteChat = useCallback(
    async (id: string) => {
      await inbox.call("deleteChat", [id]);
      if (activeId === id) setActiveId(null);
    },
    [inbox, activeId]
  );

  const renameChat = useCallback(
    async (id: string) => {
      const title = window.prompt("New chat title");
      if (!title) return;
      await inbox.call("renameChat", [id, title]);
    },
    [inbox]
  );

  // ── Shared memory editor ────────────────────────────────────────
  const [memory, setMemory] = useState<string>("");
  const [memoryLoaded, setMemoryLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const current = (await inbox.call("getSharedMemory", ["memory"])) as
        | string
        | null;
      if (!cancelled) {
        setMemory(current ?? "");
        setMemoryLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inbox]);

  const saveMemory = useCallback(async () => {
    await inbox.call("setSharedMemory", ["memory", memory]);
  }, [inbox, memory]);

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeId),
    [chats, activeId]
  );

  return (
    <div className="h-full flex flex-col bg-kumo-base text-kumo-default">
      {/* ── Header ────────────────────────────────────────────── */}
      <header className="border-b border-kumo-line px-4 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <ChatCircleIcon size={18} />
          <Text bold>Multi AI Chat</Text>
          <ConnectionDot
            status={
              inbox.readyState === 1
                ? "connected"
                : inbox.readyState === 0
                  ? "connecting"
                  : "disconnected"
            }
          />
        </div>
        <ModeToggle />
      </header>

      {/* ── Explainer ─────────────────────────────────────────── */}
      <div className="p-3 shrink-0">
        <Surface className="p-3 rounded-xl ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={18}
              weight="bold"
              className="text-kumo-accent shrink-0 mt-0.5"
            />
            <div>
              <Text size="sm" bold>
                Multi-session AI chat
              </Text>
              <span className="block mt-1">
                <Text size="xs" variant="secondary">
                  One <code>Inbox</code> Durable Object owns the list of chats +
                  shared per-user memory. Each chat in the sidebar is its own{" "}
                  <code>AIChatAgent</code> Durable Object. Memory you save below
                  is injected into every chat's system prompt.
                </Text>
              </span>
            </div>
          </div>
        </Surface>
      </div>

      {/* ── Main 2-pane layout ───────────────────────────────── */}
      <div className="flex-1 min-h-0 flex">
        {/* Sidebar */}
        <aside className="w-72 shrink-0 border-r border-kumo-line flex flex-col">
          <div className="p-3 border-b border-kumo-line flex items-center justify-between">
            <Text size="sm" bold>
              Chats
            </Text>
            <Button
              size="sm"
              onClick={createChat}
              icon={<PlusIcon size={14} />}
            >
              New
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {chats.length === 0 ? (
              <div className="p-4 text-center">
                <Text size="xs" variant="secondary">
                  No chats yet. Click <strong>New</strong> to start one.
                </Text>
              </div>
            ) : (
              chats.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`w-full text-left p-2 border-b border-kumo-line cursor-pointer hover:bg-kumo-hover flex items-start justify-between gap-2 ${
                    c.id === activeId ? "bg-kumo-hover" : ""
                  }`}
                  onClick={() => setActiveId(c.id)}
                >
                  <div className="min-w-0 flex-1">
                    <Text size="sm" bold>
                      {c.title}
                    </Text>
                    <div className="mt-0.5 truncate">
                      <Text size="xs" variant="secondary">
                        {c.lastMessagePreview ?? "No messages yet"}
                      </Text>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Button
                      variant="ghost"
                      shape="square"
                      size="sm"
                      aria-label="Rename"
                      onClick={(e) => {
                        e.stopPropagation();
                        renameChat(c.id);
                      }}
                      icon={<PencilIcon size={12} />}
                    />
                    <Button
                      variant="ghost"
                      shape="square"
                      size="sm"
                      aria-label="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteChat(c.id);
                      }}
                      icon={<TrashIcon size={12} />}
                    />
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Shared memory editor */}
          <div className="border-t border-kumo-line p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <BrainIcon size={14} />
              <Text size="xs" bold>
                Shared memory
              </Text>
            </div>
            <InputArea
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
              placeholder={
                memoryLoaded ? "Facts to remember across chats…" : "Loading…"
              }
              rows={3}
              className="text-xs"
            />
            <Button size="sm" onClick={saveMemory} disabled={!memoryLoaded}>
              Save memory
            </Button>
          </div>
        </aside>

        {/* Active chat */}
        <main className="flex-1 min-w-0">
          {activeId && activeChat ? (
            <div className="h-full flex flex-col">
              <div className="border-b border-kumo-line p-3">
                <Text size="sm" bold>
                  {activeChat.title}
                </Text>
              </div>
              <div className="flex-1 min-h-0">
                <ActiveChat key={activeId} chatId={activeId} />
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <Text variant="secondary">Create a chat to get started.</Text>
            </div>
          )}
        </main>
      </div>

      <footer className="border-t border-kumo-line px-3 py-2 shrink-0 flex justify-end">
        <PoweredByCloudflare />
      </footer>
    </div>
  );
}
