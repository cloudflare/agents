import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
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
  ArrowClockwiseIcon
} from "@phosphor-icons/react";
import type { UIMessage } from "ai";

/** Extract plain text from a UIMessage's parts. */
function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

/**
 * Resumable Streaming Chat Client
 *
 * Demonstrates automatic resumable streaming with useAgentChat.
 * When you disconnect and reconnect during streaming:
 * 1. useAgentChat automatically detects the active stream
 * 2. Sends ACK to server
 * 3. Receives all buffered chunks and continues streaming
 *
 * Try it: Start a long response, refresh the page, and watch it resume!
 */
function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const handleOpen = useCallback(() => setConnectionStatus("connected"), []);
  const handleClose = useCallback(
    () => setConnectionStatus("disconnected"),
    []
  );
  const handleError = useCallback(
    (error: Event) => console.error("WebSocket error:", error),
    []
  );

  const agent = useAgent({
    agent: "ResumableStreamingChat",
    name: "demo",
    onOpen: handleOpen,
    onClose: handleClose,
    onError: handleError
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput("");
    try {
      await sendMessage({
        role: "user",
        parts: [{ type: "text", text }]
      });
    } catch (error) {
      console.error("Failed to send message:", error);
    }
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Resumable Chat
            </h1>
            <Badge variant="secondary">
              <ArrowClockwiseIcon size={12} weight="bold" className="mr-1" />
              Auto-resume
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
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
              icon={<ArrowClockwiseIcon size={32} />}
              title="Send a message to start chatting"
              description="Try refreshing mid-response — the stream picks up where it left off."
            />
          )}

          {messages.map((message, index) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;
            const text = getMessageText(message);

            if (isUser) {
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
                <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                  <div className="whitespace-pre-wrap">
                    {text}
                    {isLastAssistant && isStreaming && (
                      <span className="inline-block w-0.5 h-[1em] bg-kumo-brand ml-0.5 align-text-bottom animate-blink-cursor" />
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
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
              disabled={!isConnected || isStreaming}
              rows={2}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
            />
            <Button
              type="submit"
              variant="primary"
              shape="square"
              disabled={!input.trim() || !isConnected || isStreaming}
              icon={<PaperPlaneRightIcon size={18} />}
              loading={isStreaming}
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
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
