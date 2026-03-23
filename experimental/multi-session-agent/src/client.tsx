import { useState, useRef, useCallback } from "react";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text,
} from "@cloudflare/kumo";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus,
} from "@cloudflare/agents-ui";
import {
  PaperPlaneRightIcon,
  TrashIcon,
  PlusIcon,
  ChatCircleDotsIcon,
  MagnifyingGlassIcon,
  CaretRightIcon,
  CheckCircleIcon,
  StackIcon,
} from "@phosphor-icons/react";
import { useAgent } from "agents/react";
import type { MultiSessionAgent } from "./server";
import type { UIMessage } from "ai";

interface Chat {
  id: string;
  name: string;
  created_at: string;
}

type ToolPart = {
  type: string;
  toolCallId: string;
  toolName: string;
  state: string;
  input?: Record<string, unknown>;
  output?: unknown;
};

function isToolPart(part: UIMessage["parts"][number]): part is ToolPart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function ToolCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const done = part.state === "output-available";
  const label = [part.input?.action, part.input?.label].filter(Boolean).join(" ");

  return (
    <Surface className="rounded-xl ring ring-kumo-line overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-kumo-elevated transition-colors"
        onClick={() => setOpen(!open)}
      >
        <CaretRightIcon size={12} className={`text-kumo-secondary transition-transform ${open ? "rotate-90" : ""}`} />
        <Text size="xs" bold>{part.toolName}</Text>
        {label && <span className="font-mono text-xs text-kumo-secondary truncate">{label}</span>}
        {done && <CheckCircleIcon size={14} className="text-green-500 ml-auto shrink-0" />}
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-kumo-line space-y-2 pt-2">
          {part.input && (
            <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(part.input, null, 2)}
            </pre>
          )}
          {part.output != null && (
            <pre className="font-mono text-xs text-green-600 dark:text-green-400 bg-green-500/5 border border-green-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {typeof part.output === "string" ? part.output : JSON.stringify(part.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </Surface>
  );
}

function App() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ chatId: string; chatName: string; results: Array<{ role: string; content: string }> }>>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasFetched = useRef(false);

  const agent = useAgent<MultiSessionAgent>({
    agent: "MultiSessionAgent",
    name: "default",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => { setConnectionStatus("disconnected"); hasFetched.current = false; }, []),
  });

  // Load chats once on connect
  if (connectionStatus === "connected" && !hasFetched.current) {
    hasFetched.current = true;
    agent.call<Chat[]>("listChats").then(setChats).catch(console.error);
  }

  const selectChat = async (chatId: string) => {
    setActiveChat(chatId);
    setMessages([]);
    try {
      const msgs = await agent.call<UIMessage[]>("getHistory", [chatId]);
      setMessages(msgs);
    } catch (err) { console.error("Failed to load history:", err); }
  };

  const createChat = async () => {
    const name = `Chat ${chats.length + 1}`;
    try {
      const chat = await agent.call<Chat>("createChat", [name]);
      setChats((prev) => [chat, ...prev]);
      setActiveChat(chat.id);
      setMessages([]);
    } catch (err) { console.error("Failed to create chat:", err); }
  };

  const deleteChat = async (chatId: string) => {
    try {
      await agent.call("deleteChat", [chatId]);
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (activeChat === chatId) { setActiveChat(null); setMessages([]); }
    } catch (err) { console.error("Failed to delete:", err); }
  };

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading || !activeChat) return;
    setInput("");
    setIsLoading(true);
    const userMsg: UIMessage = { id: `user-${crypto.randomUUID()}`, role: "user", parts: [{ type: "text", text }] };
    setMessages((prev) => [...prev, userMsg]);
    try {
      const msg = await agent.call<UIMessage>("chat", [activeChat, text]);
      setMessages((prev) => [...prev, msg]);
    } catch (err) { console.error("Failed to send:", err); }
    finally { setIsLoading(false); }
  }, [input, isLoading, activeChat, agent]);

  const search = async () => {
    if (!searchQuery.trim()) return;
    try {
      const results = await agent.call<typeof searchResults>("searchAll", [searchQuery]);
      setSearchResults(results);
    } catch (err) { console.error("Search failed:", err); }
  };

  const isConnected = connectionStatus === "connected";
  const activeChatName = chats.find((c) => c.id === activeChat)?.name ?? "";

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* Sidebar */}
      <div className="w-64 bg-kumo-base border-r border-kumo-line flex flex-col">
        <div className="px-4 py-4 border-b border-kumo-line">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-sm font-semibold text-kumo-default">Multichat</h1>
            <ConnectionIndicator status={connectionStatus} />
          </div>
          <Button variant="secondary" icon={<PlusIcon size={14} />} onClick={createChat} disabled={!isConnected} className="w-full">
            New Chat
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {chats.map((chat) => (
            <div
              key={chat.id}
              className={`flex items-center gap-2 px-4 py-3 cursor-pointer border-b border-kumo-line transition-colors ${
                activeChat === chat.id ? "bg-kumo-elevated" : "hover:bg-kumo-elevated/50"
              }`}
              onClick={() => selectChat(chat.id)}
            >
              <ChatCircleDotsIcon size={16} className="text-kumo-secondary shrink-0" />
              <span className="text-sm text-kumo-default truncate flex-1">{chat.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); deleteChat(chat.id); }}
                className="p-1 text-kumo-inactive hover:text-red-500 transition-colors shrink-0"
              >
                <TrashIcon size={12} />
              </button>
            </div>
          ))}
          {chats.length === 0 && isConnected && (
            <div className="text-xs text-kumo-subtle text-center py-8">No chats yet</div>
          )}
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-t border-kumo-line">
          <div className="flex gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder="Search all chats..."
              className="flex-1 text-xs px-2 py-1.5 rounded bg-kumo-elevated border border-kumo-line text-kumo-default outline-none focus:ring-1 focus:ring-kumo-ring"
            />
            <button onClick={search} className="p-1.5 text-kumo-secondary hover:text-kumo-default">
              <MagnifyingGlassIcon size={14} />
            </button>
          </div>
          {searchResults.length > 0 && (
            <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
              {searchResults.map((sr) => (
                <div key={sr.chatId} className="text-xs">
                  <span className="font-semibold text-kumo-default">{sr.chatName}</span>
                  {sr.results.map((r, i) => (
                    <div key={i} className="text-kumo-subtle truncate pl-2">{r.content}</div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 py-2 border-t border-kumo-line">
          <ModeToggle />
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col">
        {activeChat ? (
          <>
            <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-kumo-default">{activeChatName}</h2>
                <Badge variant="secondary">{messages.length} msgs</Badge>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto">
              <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
                {messages.map((message) => {
                  if (message.role === "user") {
                    return (
                      <div key={message.id} className="flex justify-end">
                        <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse text-sm leading-relaxed">
                          {message.parts.filter((p) => p.type === "text").map((p) => p.type === "text" ? p.text : "").join("")}
                        </div>
                      </div>
                    );
                  }

                  const isCompaction = message.id.startsWith("compaction_");
                  return (
                    <div key={message.id} className="space-y-2">
                      {isCompaction && (
                        <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 font-semibold">
                          <StackIcon size={12} weight="bold" /> Compacted Summary
                        </div>
                      )}
                      {message.parts.map((part, i) => {
                        if (part.type === "text" && part.text?.trim()) {
                          return (
                            <div key={i} className="flex justify-start">
                              <Surface className={`max-w-[80%] rounded-2xl rounded-bl-md ring ${isCompaction ? "ring-amber-200 dark:ring-amber-800 bg-amber-50 dark:bg-amber-950/30" : "ring-kumo-line"}`}>
                                <div className="px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">{part.text}</div>
                              </Surface>
                            </div>
                          );
                        }
                        if (isToolPart(part)) {
                          return <div key={part.toolCallId ?? i} className="max-w-[80%]"><ToolCard part={part} /></div>;
                        }
                        return null;
                      })}
                    </div>
                  );
                })}

                {isLoading && (
                  <div className="flex justify-start">
                    <div className="px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base">
                      <span className="inline-block w-2 h-2 bg-kumo-brand rounded-full mr-1 animate-pulse" />
                      <span className="inline-block w-2 h-2 bg-kumo-brand rounded-full mr-1 animate-pulse" style={{ animationDelay: "150ms" }} />
                      <span className="inline-block w-2 h-2 bg-kumo-brand rounded-full animate-pulse" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            <div className="border-t border-kumo-line bg-kumo-base">
              <form onSubmit={(e) => { e.preventDefault(); send(); }} className="max-w-3xl mx-auto px-5 py-4">
                <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
                  <InputArea
                    value={input}
                    onValueChange={setInput}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                    placeholder="Type a message..."
                    disabled={!isConnected || isLoading}
                    rows={2}
                    className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
                  />
                  <Button type="submit" variant="primary" shape="square" size="sm" disabled={!input.trim() || !isConnected || isLoading} icon={<PaperPlaneRightIcon size={18} />} loading={isLoading} className="mb-0.5" />
                </div>
              </form>
              <div className="flex justify-center pb-3"><PoweredByAgents /></div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <Empty
              icon={<ChatCircleDotsIcon size={32} />}
              title="Select or create a chat"
              description="Each chat has its own memory, context blocks, and conversation history."
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
