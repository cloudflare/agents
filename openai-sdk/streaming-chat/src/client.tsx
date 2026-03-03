import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { createRoot } from "react-dom/client";
import type { AgentInputItem, AgentState, StreamChunk } from "./server";

/** flattened messges for display */
type DisplayMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | {
      role: "tool-result";
      toolCallId: string;
      toolName: string;
      output: unknown;
    };

/** AgentInputItem into renderable message */
function toDisplay(item: AgentInputItem): DisplayMessage | null {
  // User message
  if ("role" in item && item.role === "user") {
    const content =
      typeof item.content === "string"
        ? item.content
        : Array.isArray(item.content)
          ? item.content
              .filter((c) => c.type === "input_text")
              .map((c) => ("text" in c ? c.text : ""))
              .join("")
          : "";
    return { role: "user", content };
  }

  // Assistant message
  if ("role" in item && item.role === "assistant") {
    const text = item.content
      .filter((c) => c.type === "output_text")
      .map((c) => ("text" in c ? c.text : ""))
      .join("");
    return { role: "assistant", content: text };
  }

  // Tool call
  if ("type" in item && item.type === "function_call") {
    return {
      role: "tool-call",
      toolCallId: item.callId,
      toolName: item.name,
      input: JSON.parse(item.arguments)
    };
  }

  // tool call result
  if ("type" in item && item.type === "function_call_result") {
    return {
      role: "tool-result",
      toolCallId: item.callId,
      toolName: item.name,
      output: item.output
    };
  }

  return null;
}

function parseToolOutput(output: unknown): Record<string, string> | string {
  if (typeof output === "string") {
    try {
      return parseToolOutput(JSON.parse(output));
    } catch {
      return output;
    }
  }
  if (typeof output === "object" && output !== null) {
    const obj = output as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") {
      return parseToolOutput(obj.text);
    }
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    return result;
  }
  return String(output);
}

/** snake_case or kebab-case into Title Case */
function formatKey(key: string): string {
  return key.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Extract tool args as displayable key-value pairs */
function formatArgs(input: unknown): { key: string; value: string }[] {
  if (typeof input === "object" && input !== null) {
    return Object.entries(input as Record<string, unknown>).map(([k, v]) => ({
      key: formatKey(k),
      value: typeof v === "object" ? JSON.stringify(v) : String(v)
    }));
  }
  return [];
}

function Chat() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "my-agent",
    onStateUpdate(state: AgentState) {
      setMessages(
        state.messages
          .map(toDisplay)
          .filter((m): m is DisplayMessage => m !== null)
      );
    }
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    setIsStreaming(true);

    // Optimistically add the user message and a placeholder assistant message
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "" }
    ]);

    agent.call("chat", [text], {
      onChunk(chunk: unknown) {
        const c = chunk as StreamChunk;

        if (c.type === "text-delta") {
          // Append delta to the last assistant message
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              updated[updated.length - 1] = {
                ...last,
                content: last.content + c.delta
              };
            }
            return updated;
          });
        }

        if (c.type === "tool-call") {
          // Insert tool-call before the trailing assistant placeholder
          setMessages((prev) => {
            const updated = [...prev];
            const assistantIdx = updated.length - 1;
            updated.splice(assistantIdx, 0, {
              role: "tool-call",
              toolCallId: c.toolCallId,
              toolName: c.toolName,
              input: c.input
            });
            return updated;
          });
        }

        if (c.type === "tool-result") {
          // Insert tool-result before the trailing assistant placeholder
          setMessages((prev) => {
            const updated = [...prev];
            const assistantIdx = updated.length - 1;
            // Find the matching tool-call to get toolName
            const call = updated.find(
              (m) => m.role === "tool-call" && m.toolCallId === c.toolCallId
            );
            updated.splice(assistantIdx, 0, {
              role: "tool-result",
              toolCallId: c.toolCallId,
              toolName: call?.role === "tool-call" ? call.toolName : "unknown",
              output: c.output
            });
            return updated;
          });
        }
      },

      onDone() {
        setIsStreaming(false);
      },

      onError(error: string) {
        console.error("Stream error:", error);
        setIsStreaming(false);
      }
    });
  }, [input, isStreaming, agent]);

  const clearHistory = useCallback(() => {
    agent.call("clearHistory", []);
    setMessages([]);
  }, [agent]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        fontFamily: "system-ui, -apple-system, sans-serif",
        backgroundColor: "#f9fafb"
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid #e5e7eb",
          backgroundColor: "white"
        }}
      >
        <div
          style={{
            maxWidth: "700px",
            margin: "0 auto",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>
              OpenAI Agents SDK &mdash; Streaming Chat
            </h1>
            <p
              style={{
                margin: "4px 0 0",
                fontSize: "13px",
                color: "#6b7280"
              }}
            >
              @callable(&#123; streaming: true &#125;) + @openai/agents
            </p>
          </div>
          <button
            type="button"
            onClick={clearHistory}
            style={{
              padding: "6px 12px",
              fontSize: "13px",
              backgroundColor: "#f3f4f6",
              border: "1px solid #d1d5db",
              borderRadius: "6px",
              cursor: "pointer"
            }}
          >
            Clear
          </button>
        </div>
      </header>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 0" }}>
        <div style={{ maxWidth: "700px", margin: "0 auto", padding: "0 20px" }}>
          {messages.length === 0 && (
            <div
              style={{
                textAlign: "center",
                color: "#9ca3af",
                marginTop: "60px"
              }}
            >
              <p style={{ fontSize: "15px" }}>
                Send a message to start chatting.
              </p>
              <p style={{ fontSize: "13px", marginTop: "4px" }}>
                Try: &quot;What&apos;s the weather in Paris?&quot;
              </p>
            </div>
          )}

          {messages.map((message, i) => (
            <MessageBubble key={i} message={message} />
          ))}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div
        style={{
          borderTop: "1px solid #e5e7eb",
          backgroundColor: "white",
          padding: "16px 20px"
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          style={{
            maxWidth: "700px",
            margin: "0 auto",
            display: "flex",
            gap: "8px"
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            disabled={isStreaming}
            style={{
              flex: 1,
              padding: "10px 14px",
              fontSize: "14px",
              border: "1px solid #d1d5db",
              borderRadius: "8px",
              outline: "none"
            }}
          />
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            style={{
              padding: "10px 20px",
              fontSize: "14px",
              backgroundColor:
                isStreaming || !input.trim() ? "#9ca3af" : "#2563eb",
              color: "white",
              border: "none",
              borderRadius: "8px",
              cursor: isStreaming || !input.trim() ? "not-allowed" : "pointer"
            }}
          >
            {isStreaming ? "Streaming..." : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: DisplayMessage }) {
  if (message.role === "tool-call") {
    const args = formatArgs(message.input);
    return (
      <div style={{ marginBottom: "2px", paddingLeft: "12px" }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "5px 10px",
            borderRadius: "6px",
            backgroundColor: "#f3f4f6",
            border: "1px solid #e5e7eb",
            fontSize: "12px",
            color: "#6b7280"
          }}
        >
          <span style={{ fontSize: "14px" }}>&#9881;</span>
          <span>
            Calling{" "}
            <strong style={{ color: "#374151" }}>{message.toolName}</strong>
          </span>
          {args.length > 0 && (
            <span style={{ color: "#9ca3af" }}>
              ({args.map((a) => `${a.key}: ${a.value}`).join(", ")})
            </span>
          )}
        </div>
      </div>
    );
  }

  if (message.role === "tool-result") {
    const parsed = parseToolOutput(message.output);
    const isObject = typeof parsed === "object";

    return (
      <div style={{ marginBottom: "12px", paddingLeft: "12px" }}>
        <div
          style={{
            display: "inline-block",
            borderRadius: "8px",
            border: "1px solid #d1fae5",
            overflow: "hidden",
            fontSize: "13px"
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "5px 10px",
              backgroundColor: "#ecfdf5",
              borderBottom: isObject ? "1px solid #d1fae5" : "none",
              color: "#059669",
              fontSize: "12px",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: "6px"
            }}
          >
            <span>&#10003;</span>
            <span>{message.toolName}</span>
          </div>

          {/* Body */}
          {isObject ? (
            <div style={{ padding: "4px 0", backgroundColor: "#f0fdf4" }}>
              {Object.entries(parsed as Record<string, string>).map(
                ([key, value]) => (
                  <div
                    key={key}
                    style={{
                      display: "flex",
                      padding: "2px 10px",
                      gap: "12px"
                    }}
                  >
                    <span
                      style={{
                        color: "#6b7280",
                        fontSize: "12px",
                        minWidth: "90px"
                      }}
                    >
                      {formatKey(key)}
                    </span>
                    <span
                      style={{
                        color: "#1f2937",
                        fontSize: "12px",
                        fontWeight: 500
                      }}
                    >
                      {value}
                    </span>
                  </div>
                )
              )}
            </div>
          ) : (
            <div
              style={{
                padding: "6px 10px",
                backgroundColor: "#f0fdf4",
                color: "#374151",
                fontSize: "12px"
              }}
            >
              {parsed}
            </div>
          )}
        </div>
      </div>
    );
  }

  const isUser = message.role === "user";
  if (!message.content) return null;

  return (
    <div
      style={{
        marginBottom: "16px",
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start"
      }}
    >
      <div
        style={{
          maxWidth: "80%",
          padding: "10px 14px",
          borderRadius: isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
          backgroundColor: isUser ? "#2563eb" : "#f3f4f6",
          color: isUser ? "white" : "#1f2937",
          whiteSpace: "pre-wrap",
          lineHeight: "1.5",
          fontSize: "14px"
        }}
      >
        {message.content}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<Chat />);
