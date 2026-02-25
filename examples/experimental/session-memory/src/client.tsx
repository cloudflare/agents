import { useState, useEffect, useRef, useCallback } from "react";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text
} from "@cloudflare/kumo";
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

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}

interface MessagesResponse {
  messages: {
    id: string;
    role: string;
    parts: { type: string; text: string }[];
  }[];
}

interface ChatResponse {
  response: string;
}

interface CompactResponse {
  success: boolean;
  error?: string;
}

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId] = useState(() => `session-${Date.now()}`);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const baseUrl = `/agents/chat-agent/${sessionId}`;

  // Fetch messages on mount
  useEffect(() => {
    fetchMessages();
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const fetchMessages = async () => {
    try {
      const res = await fetch(`${baseUrl}/messages`);
      if (res.ok) {
        const data = (await res.json()) as MessagesResponse;
        const msgs: Message[] = data.messages.map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant" | "system",
          text: m.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n")
        }));
        setMessages(msgs);
        setConnectionStatus("connected");
      }
    } catch (err) {
      console.error("Failed to fetch messages:", err);
      setConnectionStatus("disconnected");
    }
  };

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setInput("");
    setIsLoading(true);

    // Optimistic update
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      text
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const res = await fetch(`${baseUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text })
      });

      if (res.ok) {
        const data = (await res.json()) as ChatResponse;
        const assistantMsg: Message = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: data.response
        };
        setMessages((prev) => [...prev, assistantMsg]);
      }
    } catch (err) {
      console.error("Failed to send message:", err);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, baseUrl]);

  const clearHistory = async () => {
    try {
      await fetch(`${baseUrl}/messages`, { method: "DELETE" });
      setMessages([]);
    } catch (err) {
      console.error("Failed to clear history:", err);
    }
  };

  const compactSession = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${baseUrl}/compact`, { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as CompactResponse;
        if (data.success) {
          await fetchMessages();
        } else {
          alert(`Compaction failed: ${data.error}`);
        }
      }
    } catch (err) {
      console.error("Failed to compact:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const isConnected = connectionStatus === "connected";

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
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
              disabled={isLoading || messages.length < 4}
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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<ChatCircleDotsIcon size={32} />}
              title="Start a conversation"
              description="Messages are stored in the Agent's SQLite database. Try compacting after a few exchanges to see summarization in action."
            />
          )}

          {messages.map((message) => {
            const isUser = message.role === "user";
            const isSystem = message.role === "system";

            if (isSystem) {
              return (
                <div key={message.id} className="flex justify-start">
                  <Surface className="max-w-[90%] px-4 py-3 rounded-xl ring ring-kumo-line bg-kumo-fill">
                    <div className="flex items-center gap-2 mb-1">
                      <StackIcon size={14} className="text-kumo-brand" />
                      <Text size="xs" variant="secondary" bold>
                        Summary
                      </Text>
                    </div>
                    <div className="whitespace-pre-wrap">
                      <Text size="sm" variant="secondary">
                        {message.text}
                      </Text>
                    </div>
                  </Surface>
                </div>
              );
            }

            return (
              <div key={message.id} className="space-y-2">
                {isUser ? (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                      {message.text}
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed whitespace-pre-wrap">
                      {message.text}
                    </div>
                  </div>
                )}
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

      {/* Input */}
      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage();
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
                  sendMessage();
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
