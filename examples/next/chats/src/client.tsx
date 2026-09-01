import {
  Badge,
  Button,
  Empty,
  Input,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ChatCircleIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  SunIcon,
  TrashIcon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import type { RoutedAgentEntry } from "agents/routing";
import "./styles.css";

const USER_KEY = "next-chats-user";
const userId =
  localStorage.getItem(USER_KEY) ?? crypto.randomUUID().slice(0, 8);
localStorage.setItem(USER_KEY, userId);

type ChatEntry = RoutedAgentEntry<{
  title: string | null;
  lastMessage: string | null;
}>;

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  at: number;
};

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") ?? "light"
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
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function ChatPane({
  chatId,
  onActivity
}: {
  chatId: string;
  onActivity: () => void;
}) {
  // One WebSocket per open chat. The upgrade goes through the user hub,
  // which resolves the chat ID; the chat's own DO then owns the socket,
  // so the hub is not on the message path.
  const chat = useAgent({
    agent: "chat-agent",
    basePath: `agents/user-agent/${encodeURIComponent(userId)}/chats/${encodeURIComponent(chatId)}`
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setMessages((await chat.call("getMessages")) as ChatMessage[]);
  }, [chat]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const send = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const text = draft.trim();
      if (!text || busy) return;
      setBusy(true);
      setDraft("");
      try {
        await chat.call("addMessage", ["user", text]);
        // No model is wired into this example — the "assistant" reply
        // just proves both roles land in the chat's own SQLite.
        await chat.call("addMessage", [
          "assistant",
          `Echo from ${chatId.slice(0, 8)}: ${text}`
        ]);
        await refresh();
        onActivity();
      } finally {
        setBusy(false);
      }
    },
    [busy, chat, chatId, draft, onActivity, refresh]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <Empty
            icon={<ChatCircleIcon size={24} />}
            title="No messages yet"
            description="Everything you send lives in this chat's own Durable Object."
          />
        ) : (
          messages.map((message, index) => (
            <div
              key={`${message.at}-${index}`}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <Surface
                className={`max-w-[80%] rounded-lg px-3 py-2 ${
                  message.role === "user" ? "bg-kumo-brand/10" : ""
                }`}
              >
                <Text size="sm">{message.text}</Text>
              </Surface>
            </div>
          ))
        )}
      </div>
      <form
        onSubmit={send}
        className="flex gap-2 border-t border-kumo-line p-3"
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="Say something…"
          className="flex-1"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={busy || draft.trim() === ""}
          icon={<PaperPlaneRightIcon size={16} />}
        >
          Send
        </Button>
      </form>
    </div>
  );
}

function App() {
  // One connection to the per-user index DO. Listing and search read
  // only this object — no chat DO wakes up for the sidebar.
  const user = useAgent({ agent: "user-agent", name: userId });
  const [chats, setChats] = useState<ChatEntry[]>([]);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  const refreshChats = useCallback(async () => {
    const method = query.trim() === "" ? "listChats" : "searchChats";
    const args = query.trim() === "" ? [] : [query.trim()];
    setChats((await user.call(method, args)) as ChatEntry[]);
  }, [query, user]);

  useEffect(() => {
    void refreshChats();
  }, [refreshChats]);

  const createChat = useCallback(async () => {
    const chatId = (await user.call("createChat")) as string;
    setActiveId(chatId);
    await refreshChats();
  }, [refreshChats, user]);

  const deleteChat = useCallback(
    async (chatId: string) => {
      await user.call("deleteChat", [chatId]);
      if (activeId === chatId) setActiveId(null);
      await refreshChats();
    },
    [activeId, refreshChats, user]
  );

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Text bold>Chats</Text>
          <Badge variant="secondary">one DO per chat</Badge>
          <Badge variant="secondary">user {userId}</Badge>
        </div>
        <ModeToggle />
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 flex-col border-r border-kumo-line">
          <div className="flex items-center gap-2 p-3">
            <Input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search all chats…"
              className="flex-1"
            />
            <Button
              variant="primary"
              shape="square"
              aria-label="New chat"
              onClick={() => void createChat()}
              icon={<PlusIcon size={16} />}
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {chats.length === 0 ? (
              <div className="p-4">
                <Text size="sm" variant="secondary">
                  {query
                    ? "No chats match — the search ran over the index only."
                    : "No chats yet. Each one you create is its own Durable Object."}
                </Text>
              </div>
            ) : (
              chats.map((chat) => (
                <button
                  type="button"
                  key={chat.id}
                  onClick={() => setActiveId(chat.id)}
                  className={`group flex w-full items-center justify-between px-4 py-3 text-left hover:bg-kumo-elevated ${
                    activeId === chat.id ? "bg-kumo-elevated" : ""
                  }`}
                >
                  <div className="min-w-0">
                    <div className="truncate">
                      <Text size="sm" bold>
                        {chat.metadata?.title ?? "New chat"}
                      </Text>
                    </div>
                    <div className="truncate">
                      <Text size="xs" variant="secondary">
                        {chat.metadata?.lastMessage ?? "No messages yet"}
                      </Text>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    shape="square"
                    aria-label="Delete chat"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      void deleteChat(chat.id);
                    }}
                    icon={<TrashIcon size={14} />}
                  />
                </button>
              ))
            )}
          </div>
          <div className="border-t border-kumo-line p-3">
            <PoweredByCloudflare />
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          {activeId ? (
            <ChatPane
              key={activeId}
              chatId={activeId}
              onActivity={() => void refreshChats()}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8">
              <Empty
                icon={<ChatCircleIcon size={24} />}
                title="Pick or create a chat"
                description="Sidebar listing and search read only the per-user hub; each conversation lives in its own Durable Object with its own SQLite, alarms, and placement, reached through the hub's route."
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
