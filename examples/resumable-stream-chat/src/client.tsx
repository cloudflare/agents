import type React from "react";
import { useEffect, useState, useRef } from "react";
import { useAgent } from "agents/react";
import type { ResumableMessage } from "agents";
import type { ResumableStreamingChatState } from "./server";

type StreamingMessage = {
  id: string;
  role: "assistant";
  content: string;
  isStreaming: boolean;
  streamId: string;
};

export default function App() {
  const [messages, setMessages] = useState<ResumableMessage[]>([]);
  const [streamingMessage, setStreamingMessage] =
    useState<StreamingMessage | null>(null);
  const [input, setInput] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeStreamIdRef = useRef<string | null>(null);
  const replayedStreamsRef = useRef<Set<string>>(new Set());

  const agent = useAgent<ResumableStreamingChatState>({
    agent: "ResumableStreamingChat",
    name: "demo",
    host: import.meta.env.DEV
      ? "http://localhost:8787"
      : `https://${window.location.host}`,
    onStateUpdate: (state, source) => {
      console.log("📡 State update received:", {
        source,
        messageCount: state.messages.length,
        activeStreamId: state.activeStreamId,
        messages: state.messages
      });
      setMessages(state.messages);

      // If there's an active stream, replay its history
      if (
        state.activeStreamId &&
        !replayedStreamsRef.current.has(state.activeStreamId)
      ) {
        console.log("🔄 Active stream detected, fetching history...");
        replayedStreamsRef.current.add(state.activeStreamId);
        replayStream(state.activeStreamId);
      }
    },
    onMessage: (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case "stream_start":
            activeStreamIdRef.current = data.data.streamId;
            setStreamingMessage({
              id: data.data.messageId,
              role: "assistant",
              content: "",
              isStreaming: true,
              streamId: data.data.streamId
            });
            break;

          case "stream_chunk":
            if (data.data.streamId === activeStreamIdRef.current) {
              setStreamingMessage((prev) =>
                prev
                  ? {
                      ...prev,
                      content: prev.content + data.data.chunk
                    }
                  : {
                      id: data.data.messageId,
                      role: "assistant",
                      content: data.data.chunk,
                      isStreaming: true,
                      streamId: data.data.streamId
                    }
              );
            }
            break;

          case "stream_complete":
            if (data.data.streamId === activeStreamIdRef.current) {
              setStreamingMessage(null);
              activeStreamIdRef.current = null;
            }
            break;

          case "stream_error":
            if (data.data.streamId === activeStreamIdRef.current) {
              console.error("Stream error:", data.data.error);
              setStreamingMessage(null);
              activeStreamIdRef.current = null;
            }
            break;
        }
      } catch (_error) {
        // Ignore JSON parse errors for non-JSON messages
      }
    },
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
    onError: () => {
      if (import.meta.env.DEV) {
        console.log("⚠️ WebSocket error (likely hot-reload)");
      }
    }
  });

  // this is how we replay stream history
  const replayStream = async (streamId: string) => {
    try {
      console.log("Replaying stream history for:", streamId);
      const { chunks, metadata } = await agent.call<{
        chunks: Array<{ content: string; index: number }>;
        metadata: { status: string; messageId: string } | null;
      }>("getStreamHistory", [streamId]);

      if (!metadata) {
        console.warn("No metadata found for stream:", streamId);
        return;
      }

      // Reconstruct the streaming message from chunks
      const fullContent = chunks
        .sort((a, b) => a.index - b.index)
        .map((c) => c.content)
        .join("");

      if (metadata.status === "streaming") {
        // Stream is still active, show it as streaming
        activeStreamIdRef.current = streamId;
        setStreamingMessage({
          id: metadata.messageId,
          role: "assistant",
          content: fullContent,
          isStreaming: true,
          streamId
        });
      } else if (metadata.status === "completed") {
        // Stream completed while disconnected
        setStreamingMessage(null);
        activeStreamIdRef.current = null;
      }
    } catch (error) {
      console.error("Error replaying stream:", error);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingMessage]);

  const handleSend = async () => {
    if (!input.trim() || isSending) return;

    setIsSending(true);
    const messageText = input;
    setInput("");

    try {
      const { messageId, streamId } = await agent.call<{
        messageId: string;
        streamId: string;
      }>("sendMessage", [messageText]);

      console.log("Message sent:", messageId, "Stream ID:", streamId);
      activeStreamIdRef.current = streamId;
    } catch (error) {
      console.error("Error sending message:", error);
      // Restore input on error
      setInput(messageText);
    } finally {
      setIsSending(false);
    }
  };

  const handleClear = async () => {
    try {
      await agent.call("clearHistory", []);
      setMessages([]);
      setStreamingMessage(null);
      activeStreamIdRef.current = null;
    } catch (error) {
      console.error("Error clearing history:", error);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
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
            onClick={handleClear}
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
        {messages.length === 0 && !streamingMessage && (
          <div
            style={{
              textAlign: "center",
              color: "#9ca3af",
              marginTop: "2rem",
              fontSize: "0.875rem"
            }}
          >
            Send a message to start the conversation
          </div>
        )}

        {messages.map((message) => (
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
                  opacity: 0.8
                }}
              >
                {message.role === "user" ? "You" : "Assistant"}
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>
            </div>
          </div>
        ))}

        {streamingMessage && (
          <div style={{ display: "flex", marginBottom: "1rem" }}>
            <div
              style={{
                maxWidth: "70%",
                padding: "0.75rem 1rem",
                borderRadius: "0.5rem",
                backgroundColor: "#f3f4f6",
                color: "#1f2937"
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
                <span>Assistant</span>
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
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>
                {streamingMessage.content}
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
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        style={{
          padding: "1rem",
          borderTop: "1px solid #e5e7eb",
          backgroundColor: "#f9fafb"
        }}
      >
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Type your message... (Press Enter to send, Shift+Enter for new line)"
            disabled={!isConnected || isSending}
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
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || !isConnected || isSending}
            style={{
              padding: "0.75rem 1.5rem",
              backgroundColor:
                !input.trim() || !isConnected || isSending
                  ? "#d1d5db"
                  : "#3b82f6",
              color: "white",
              border: "none",
              borderRadius: "0.375rem",
              cursor:
                !input.trim() || !isConnected || isSending
                  ? "not-allowed"
                  : "pointer",
              fontSize: "0.875rem",
              fontWeight: "500",
              minWidth: "80px"
            }}
          >
            {isSending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>

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
