import type React from "react";
import { Suspense, useState, useRef, useEffect } from "react";
import { useAgent } from "agents/react";
import { useAgentChat, type AITool } from "agents/ai-react";
import type { UIMessage } from "ai";

/**
 * Client Tools Example
 *
 * This example demonstrates client-defined tools that execute in the browser.
 * The changeBackgroundColor tool executes ONLY on the client.
 *
 * The architecture uses server-authoritative message state:
 * - Client executes tools and sends CF_AGENT_TOOL_RESULT to server
 * - Server updates its canonical message state and broadcasts updates
 * - No duplicate messages are created
 */

// Client tools that execute in the browser
const clientTools: Record<string, AITool> = {
  changeBackgroundColor: {
    description:
      "Change the background color of the website. Use this when the user asks to change the background color.",
    parameters: {
      type: "object",
      properties: {
        color: {
          type: "string",
          description:
            "The color to change the background to (e.g., 'red', 'blue', '#ff0000')"
        }
      },
      required: ["color"]
    },
    execute: async (input: unknown) => {
      const { color } = input as { color: string };
      console.log("[Client Tool] Changing background color to:", color);
      document.body.style.backgroundColor = color;
      return { success: true, color };
    }
  }
};

function Chat() {
  const [isConnected, setIsConnected] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "ClientToolsAgent",
    name: "demo",
    onOpen: () => {
      console.log("WebSocket connected");
      setIsConnected(true);
      setError(null);
    },
    onClose: (event) => {
      console.log("WebSocket disconnected", event?.code, event?.reason);
      setIsConnected(false);
    },
    onError: (err) => {
      console.error("WebSocket error:", err);
      setError("Connection error");
    }
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent,
    tools: clientTools,
    experimental_automaticToolResolution: true,
    onError: (err) => {
      console.error("Chat error:", err);
      setError(err.message);
    }
  });

  const isStreaming = status === "streaming";

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;

    const message = input;
    setInput("");
    setError(null);

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
  const getMessageContent = (message: UIMessage) => {
    const parts: React.ReactNode[] = [];

    for (const part of message.parts) {
      if (part.type === "text") {
        parts.push(
          <div key={`text-${parts.length}`} style={{ whiteSpace: "pre-wrap" }}>
            {part.text}
          </div>
        );
      } else if (part.type === "reasoning") {
        const reasoningPart = part as { type: "reasoning"; text?: string };
        parts.push(
          <div
            key={`reasoning-${parts.length}`}
            style={{
              fontSize: "0.75rem",
              color: "#6b7280",
              fontStyle: "italic",
              marginBottom: "0.5rem"
            }}
          >
            Thinking: {reasoningPart.text || "(reasoning)"}
          </div>
        );
      } else if ("toolCallId" in part) {
        const toolPart = part as {
          type: string;
          toolCallId: string;
          state?: string;
          output?: unknown;
        };
        parts.push(
          <div
            key={`tool-${toolPart.toolCallId}`}
            style={{
              fontSize: "0.75rem",
              padding: "0.5rem",
              backgroundColor: "#f3f4f6",
              borderRadius: "0.25rem",
              marginBottom: "0.5rem",
              fontFamily: "monospace"
            }}
          >
            Tool: {toolPart.type.replace("tool-", "")}
            <br />
            State: {toolPart.state || "unknown"}
            {toolPart.output !== undefined && (
              <>
                <br />
                Output: {String(JSON.stringify(toolPart.output))}
              </>
            )}
          </div>
        );
      }
    }

    return parts;
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
      {/* Header */}
      <div
        style={{
          padding: "1rem",
          borderBottom: "1px solid #e5e7eb",
          backgroundColor: "#f9fafb"
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: "bold" }}>
              Client Tools Example
            </h1>
            <p
              style={{
                margin: "0.25rem 0 0 0",
                fontSize: "0.875rem",
                color: "#6b7280"
              }}
            >
              Try: "Change the background to red" then "Thanks!" (works now!)
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
              {isConnected ? "Connected" : "Disconnected"}
            </div>
            <button
              type="button"
              onClick={() => {
                clearHistory();
                document.body.style.backgroundColor = "";
                setError(null);
              }}
              style={{
                padding: "0.5rem 1rem",
                backgroundColor: "#ef4444",
                color: "white",
                border: "none",
                borderRadius: "0.375rem",
                cursor: "pointer",
                fontSize: "0.875rem"
              }}
            >
              Clear & Reset
            </button>
          </div>
        </div>

        {/* Error display */}
        {error && (
          <div
            style={{
              marginTop: "0.5rem",
              padding: "0.75rem",
              backgroundColor: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: "0.375rem",
              color: "#dc2626",
              fontSize: "0.875rem"
            }}
          >
            <strong>Error:</strong> {error}
          </div>
        )}
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
              marginTop: "2rem"
            }}
          >
            <p>Send a message to start.</p>
            <p style={{ fontSize: "0.875rem" }}>
              <strong>Try it out:</strong>
              <br />
              1. Say "Change the background to red"
              <br />
              2. Wait for the tool to execute
              <br />
              3. Say "Thanks!" or any follow-up
              <br />
              4. It works! No duplicate errors.
            </p>
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
                <span
                  style={{
                    marginLeft: "0.5rem",
                    fontFamily: "monospace",
                    fontSize: "0.625rem"
                  }}
                >
                  ({message.id.substring(0, 8)}...)
                </span>
              </div>
              {getMessageContent(message)}
            </div>
          </div>
        ))}

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
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Type a message... (Enter to send)"
            disabled={!isConnected || isStreaming}
            style={{
              flex: 1,
              padding: "0.75rem",
              border: "1px solid #d1d5db",
              borderRadius: "0.375rem",
              resize: "none",
              fontSize: "0.875rem",
              minHeight: "60px"
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
              fontSize: "0.875rem"
            }}
          >
            {isStreaming ? "..." : "Send"}
          </button>
        </div>
      </form>

      {/* Debug info */}
      <div
        style={{
          padding: "0.5rem 1rem",
          backgroundColor: "#1f2937",
          color: "#9ca3af",
          fontSize: "0.75rem",
          fontFamily: "monospace"
        }}
      >
        Messages: {messages.length} | Status: {status} | Check console for
        server logs
      </div>
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
