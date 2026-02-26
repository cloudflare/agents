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
  StackIcon
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasFetched = useRef(false);

  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    name: "default",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), [])
  });

  // Fetch messages once on connect
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
  };

  const compactSession = async () => {
    setIsCompacting(true);
    try {
      const result = await agent.call<{ success: boolean; error?: string }>(
        "compact"
      );
      if (result.success) {
        const msgs = await agent.call<UIMessage[]>("getMessages");
        setMessages(msgs);
      } else {
        alert(`Compaction failed: ${result.error}`);
      }
    } catch (err) {
      console.error("Failed to compact:", err);
    } finally {
      setIsCompacting(false);
    }
  };

  const isConnected = connectionStatus === "connected";

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Session Memory
            </h1>
            <Badge variant="secondary">
              <StackIcon size={12} weight="bold" className="mr-1" />
              Compaction
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="secondary"
              icon={<ArrowsClockwiseIcon size={16} />}
              onClick={compactSession}
              disabled={isCompacting || isLoading || messages.length < 4}
            >
              Compact
            </Button>
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
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
                <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed whitespace-pre-wrap">
                  {text}
                </div>
              </div>
            );
          })}

          {isLoading && (
            <div className="flex justify-start">
              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default">
                <span className="inline-block w-2 h-2 bg-kumo-brand rounded-full mr-1 animate-pulse" />
                <span className="inline-block w-2 h-2 bg-kumo-brand rounded-full mr-1 animate-pulse delay-100" />
                <span className="inline-block w-2 h-2 bg-kumo-brand rounded-full animate-pulse delay-200" />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <InputArea
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Type a message..."
              disabled={!isConnected || isLoading}
              rows={2}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
            />
            <Button
              type="submit"
              variant="primary"
              shape="square"
              aria-label="Send message"
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
  );
}

export default function App() {
  return <Chat />;
}
