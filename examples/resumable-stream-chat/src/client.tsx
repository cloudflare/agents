import type React from "react";
import { Suspense, useState, useRef, useEffect } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "agents/ai-react";
import type { UIMessage } from "ai";

/**
 * Resumable Streaming Chat Client
 *
 * This example demonstrates automatic resumable streaming with useAgentChat.
 * When you disconnect and reconnect during streaming:
 * 1. useAgentChat automatically detects the active stream
 * 2. Sends ACK to server
 * 3. Receives all buffered chunks and continues streaming
 *
 * Try it: Start a long response, refresh the page, and watch it resume!
 */
function Chat() {
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "ResumableStreamingChat",
    name: "demo",
    onOpen: () => {
      const connectMsg = isReconnecting
        ? "WebSocket reconnected"
        : "WebSocket connected";
      console.log(connectMsg);
      setIsConnected(true);
      setIsReconnecting(false);
    },
    onClose: (event) => {
      console.log("WebSocket disconnected", {
        code: event?.code,
        reason: event?.reason || "No reason provided",
        wasClean: event?.wasClean
      });
      setIsConnected(false);
      setIsReconnecting(true);
    },
    onError: (error) => {
      console.error("WebSocket error:", error);
    }
  });

  // useAgentChat handles everything:
  // - Message persistence
  // - Streaming
  // - Automatic resume on reconnect (via resume: true default)
  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
    // resume: true is the default - streams automatically resume on reconnect
  });

  const isStreaming = status === "streaming";

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;

    const message = input;
    setInput("");

    // Send message to agent
    await sendMessage({
      role: "user",
      parts: [{ type: "text", text: message }]
    });
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  // Extract text content from message parts
  const getMessageText = (message: UIMessage): string => {
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { type: "text"; text: string }).text)
      .join("");
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        fontFamily: "system-ui, -apple-system, sans-serif"
      }}
    >
      <div
        style={{
          padding: "1rem",
          borderBottom: "1px solid #e5e7eb",
          backgroundColor: "#f9fafb",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: "bold" }}>
            Resumable Streaming Chat
          </h1>
          <p
            style={{
              margin: "0.25rem 0 0 0",
              fontSize: "0.875rem",
              color: "#6b7280"
            }}
          >
            Real-time AI chat with automatic resume on disconnect
          </p>
        </div>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              fontSize: "0.875rem",
              color: isConnected ? "#059669" : "#dc2626"
            }}
          >
            <div
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: isConnected ? "#059669" : "#dc2626"
              }}
            />
            {isConnected
              ? "Connected"
              : isReconnecting
                ? "Reconnecting..."
                : "Disconnected"}
          </div>
          <button
            type="button"
            onClick={clearHistory}
            style={{
              padding: "0.5rem 1rem",
              backgroundColor: "#ef4444",
              color: "white",
              border: "none",
              borderRadius: "0.375rem",
              cursor: "pointer",
              fontSize: "0.875rem",
              fontWeight: "500"
            }}
          >
            Clear History
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "1rem",
          backgroundColor: "#ffffff"
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              textAlign: "center",
              color: "#9ca3af",
              marginTop: "2rem",
              fontSize: "0.875rem"
            }}
          >
            Send a message to start the conversation.
            <br />
            <span
              style={{
                fontSize: "0.75rem",
                marginTop: "0.5rem",
                display: "block"
              }}
            >
              Try refreshing during a response to see automatic resume!
            </span>
          </div>
        )}

        {messages.map((message, index) => {
          const isLastAssistant =
            message.role === "assistant" && index === messages.length - 1;
          const text = getMessageText(message);

          return (
            <div
              key={message.id}
              style={{
                display: "flex",
                justifyContent:
                  message.role === "user" ? "flex-end" : "flex-start",
                marginBottom: "1rem"
              }}
            >
              <div
                style={{
                  maxWidth: "70%",
                  padding: "0.75rem 1rem",
                  borderRadius: "0.5rem",
                  backgroundColor:
                    message.role === "user" ? "#3b82f6" : "#f3f4f6",
                  color: message.role === "user" ? "white" : "#1f2937"
                }}
              >
                <div
                  style={{
                    fontSize: "0.75rem",
                    marginBottom: "0.25rem",
                    opacity: 0.8,
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem"
                  }}
                >
                  <span>{message.role === "user" ? "You" : "Assistant"}</span>
                  {isLastAssistant && isStreaming && (
                    <span
                      style={{
                        display: "inline-block",
                        width: "6px",
                        height: "6px",
                        borderRadius: "50%",
                        backgroundColor: "#3b82f6",
                        animation: "pulse 1.5s ease-in-out infinite"
                      }}
                    />
                  )}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>
                  {text}
                  {isLastAssistant && isStreaming && (
                    <span
                      style={{
                        display: "inline-block",
                        width: "2px",
                        height: "1em",
                        backgroundColor: "#3b82f6",
                        marginLeft: "2px",
                        animation: "blink 1s step-end infinite"
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        style={{
          padding: "1rem",
          borderTop: "1px solid #e5e7eb",
          backgroundColor: "#f9fafb"
        }}
      >
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <textarea
            value={input}
            onChange={handleInputChange}
            onKeyPress={handleKeyPress}
            placeholder="Type your message... (Press Enter to send, Shift+Enter for new line)"
            disabled={!isConnected || isStreaming}
            style={{
              flex: 1,
              padding: "0.75rem",
              border: "1px solid #d1d5db",
              borderRadius: "0.375rem",
              resize: "none",
              fontSize: "0.875rem",
              minHeight: "60px",
              fontFamily: "inherit"
            }}
          />
          <button
            type="submit"
            disabled={!input.trim() || !isConnected || isStreaming}
            style={{
              padding: "0.75rem 1.5rem",
              backgroundColor:
                !input.trim() || !isConnected || isStreaming
                  ? "#d1d5db"
                  : "#3b82f6",
              color: "white",
              border: "none",
              borderRadius: "0.375rem",
              cursor:
                !input.trim() || !isConnected || isStreaming
                  ? "not-allowed"
                  : "pointer",
              fontSize: "0.875rem",
              fontWeight: "500",
              minWidth: "80px"
            }}
          >
            {isStreaming ? "Streaming..." : "Send"}
          </button>
        </div>
      </form>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: "2rem", textAlign: "center" }}>Loading...</div>
      }
    >
      <Chat />
    </Suspense>
  );
}
