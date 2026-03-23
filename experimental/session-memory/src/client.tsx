import { useState, useEffect, useRef, useCallback } from "react";
import { Button, Badge, InputArea, Empty } from "@cloudflare/kumo";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import {
  PaperPlaneRightIcon,
  TrashIcon,
  ArrowsClockwiseIcon,
  ChatCircleDotsIcon,
  StackIcon,
  SidebarIcon,
  XIcon
} from "@phosphor-icons/react";
import { useAgent } from "agents/react";
import type { ChatAgent } from "./server";
import type { UIMessage } from "ai";

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [debugMessages, setDebugMessages] = useState<UIMessage[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasFetched = useRef(false);

  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    name: "default",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => {
      setConnectionStatus("disconnected");
      hasFetched.current = false;
    }, [])
  });

  useEffect(() => {
    if (connectionStatus !== "connected" || hasFetched.current) return;
    hasFetched.current = true;
    const load = async () => {
      try {
        await agent.ready;
        const msgs = await agent.call<UIMessage[]>("getMessages");
        setMessages(msgs);
      } catch (err) {
        console.error("Failed to fetch messages:", err);
      }
    };
    load();
  }, [connectionStatus, agent]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const refreshDebug = useCallback(async () => {
    try {
      const msgs = await agent.call<UIMessage[]>("getHistory");
      setDebugMessages(msgs);
    } catch (err) {
      console.error("Failed to fetch debug:", err);
    }
  }, [agent]);

  useEffect(() => {
    if (drawerOpen) refreshDebug();
  }, [drawerOpen, messages, refreshDebug]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setInput("");
    setIsLoading(true);

    const userMsg: UIMessage = {
      id: `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text }]
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const response = await agent.call<string>("chat", [text]);
      const assistantMsg: UIMessage = {
        id: `assistant-${crypto.randomUUID()}`,
        role: "assistant",
        parts: [{ type: "text", text: response }]
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      console.error("Failed to send:", err);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, agent]);

  const clearHistory = async () => {
    await agent.call("clearMessages");
    setMessages([]);
    setDebugMessages([]);
  };

  const compactSession = async () => {
    setIsCompacting(true);
    try {
      await agent.call<{ success: boolean }>("compact");
      const msgs = await agent.call<UIMessage[]>("getMessages");
      setMessages(msgs);
    } catch (err) {
      console.error("Failed to compact:", err);
    } finally {
      setIsCompacting(false);
    }
  };

  const isConnected = connectionStatus === "connected";

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* Main chat area */}
      <div className={`flex flex-col flex-1 transition-all ${drawerOpen ? "mr-[400px]" : ""}`}>
        <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
          <div className="max-w-3xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-kumo-default">
                Session Memory
              </h1>
              <Badge variant="secondary">
                {messages.length} msgs
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <ConnectionIndicator status={connectionStatus} />
              <ModeToggle />
              <Button
                variant="secondary"
                icon={<ArrowsClockwiseIcon size={16} />}
                onClick={compactSession}
                disabled={isCompacting || isLoading || messages.length < 4}
              >
                {isCompacting ? "..." : "Compact"}
              </Button>
              <Button
                variant="secondary"
                icon={<TrashIcon size={16} />}
                onClick={clearHistory}
              />
              <Button
                variant={drawerOpen ? "primary" : "secondary"}
                icon={<SidebarIcon size={16} />}
                onClick={() => setDrawerOpen(!drawerOpen)}
              />
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
            {messages.length === 0 && !isLoading && (
              <Empty
                icon={<ChatCircleDotsIcon size={32} />}
                title="Start a conversation"
                description="Messages persist in SQLite. Try compacting after a few exchanges."
              />
            )}

            {messages.map((message) => {
              const text = getMessageText(message);
              if (!text) return null;

              const isCompaction = message.id.startsWith("compaction_");

              if (message.role === "user") {
                return (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                      {text}
                    </div>
                  </div>
                );
              }

              return (
                <div key={message.id} className="flex justify-start">
                  <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md leading-relaxed whitespace-pre-wrap ${
                    isCompaction
                      ? "bg-amber-50 dark:bg-amber-950/30 text-kumo-default border border-amber-200 dark:border-amber-800"
                      : "bg-kumo-base text-kumo-default"
                  }`}>
                    {isCompaction && (
                      <div className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-2 flex items-center gap-1">
                        <StackIcon size={12} weight="bold" />
                        Compacted Summary
                      </div>
                    )}
                    {text}
                  </div>
                </div>
              );
            })}

            {isLoading && (
              <div className="flex justify-start">
                <div className="px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default">
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
            <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent">
              <InputArea
                value={input}
                onValueChange={setInput}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Type a message..."
                disabled={!isConnected || isLoading}
                rows={2}
                className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
              />
              <Button
                type="submit"
                variant="primary"
                shape="square"
                disabled={!input.trim() || !isConnected || isLoading}
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            </div>
          </form>
          <div className="flex justify-center pb-3">
            <PoweredByAgents />
          </div>
        </div>
      </div>

      {/* Debug drawer */}
      <div className={`fixed right-0 top-0 h-full w-[400px] bg-kumo-base border-l border-kumo-line shadow-xl transition-transform z-50 ${
        drawerOpen ? "translate-x-0" : "translate-x-full"
      }`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-kumo-line">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-kumo-default">LLM Context</h2>
            <Badge variant="secondary">{debugMessages.length} msgs</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="small" onClick={refreshDebug} icon={<ArrowsClockwiseIcon size={14} />} />
            <Button variant="secondary" size="small" onClick={() => setDrawerOpen(false)} icon={<XIcon size={14} />} />
          </div>
        </div>
        <div className="overflow-y-auto h-[calc(100%-49px)] p-3 space-y-2">
          {debugMessages.map((msg, i) => {
            const text = getMessageText(msg);
            const isCompaction = msg.id.startsWith("compaction_");
            return (
              <div
                key={msg.id}
                className={`p-3 rounded-lg border text-xs ${
                  isCompaction
                    ? "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800"
                    : msg.role === "user"
                      ? "bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-900"
                      : "bg-kumo-elevated border-kumo-line"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`font-bold ${
                    isCompaction
                      ? "text-amber-600 dark:text-amber-400"
                      : msg.role === "user"
                        ? "text-blue-600 dark:text-blue-400"
                        : "text-kumo-subtle"
                  }`}>
                    {isCompaction ? "SUMMARY" : msg.role.toUpperCase()}
                  </span>
                  <span className="text-kumo-subtle">#{i + 1}</span>
                </div>
                <pre className="whitespace-pre-wrap text-kumo-default leading-relaxed font-mono">
                  {text.length > 300 ? text.slice(0, 300) + "…" : text}
                </pre>
              </div>
            );
          })}
          {debugMessages.length === 0 && (
            <div className="text-sm text-kumo-subtle text-center py-8">
              No messages yet
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return <Chat />;
}
