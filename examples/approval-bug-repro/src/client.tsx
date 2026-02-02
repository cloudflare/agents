/**
 * Bug Reproduction UI for addToolApprovalResponse duplicate messages
 *
 * This UI demonstrates the bug where calling addToolApprovalResponse
 * creates a new message instead of updating the existing one.
 */

import { createRoot } from "react-dom/client";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { isToolUIPart, getToolName } from "ai";
import { useState, useCallback, useEffect } from "react";

interface DebugData {
  totalMessages: number;
  messages: Array<{
    dbId: string;
    createdAt: string;
    message: {
      id: string;
      role: string;
      parts: Array<{
        type: string;
        toolCallId?: string;
        state?: string;
        input?: unknown;
        approval?: { id: string; approved: boolean };
      }>;
    };
  }>;
  duplicates: Array<{
    toolCallId: string;
    messages: Array<{ messageId: string; state: string }>;
  }>;
  hasDuplicates: boolean;
}

function App() {
  const agent = useAgent({ agent: "approval-bug-agent" });

  // Get addToolApprovalResponse from useAgentChat - THIS IS THE BUGGY FUNCTION
  const {
    messages,
    sendMessage,
    addToolApprovalResponse,
    addToolResult,
    clearHistory
  } = useAgentChat({ agent });

  const [input, setInput] = useState("");
  const [debugData, setDebugData] = useState<DebugData | null>(null);

  // Fetch server-side persisted messages
  const fetchDebugData = useCallback(async () => {
    try {
      const result = (await agent.call("getDebugMessages")) as DebugData;
      setDebugData(result);
    } catch (error) {
      console.error("Failed to fetch debug data:", error);
    }
  }, [agent]);

  // Auto-refresh debug data when messages change
  useEffect(() => {
    const timer = setTimeout(fetchDebugData, 500);
    return () => clearTimeout(timer);
  }, [messages, fetchDebugData]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      sendMessage({ role: "user", parts: [{ type: "text", text: input }] });
      setInput("");
    }
  };

  // Find tool parts that need approval (in "approval-requested" state)
  // The AI SDK transitions tools to "approval-requested" when they have needsApproval: true
  const pendingToolParts = messages.flatMap((msg) =>
    (msg.parts || [])
      .filter(
        (part) => isToolUIPart(part) && part.state === "approval-requested"
      )
      .map((part) => ({ messageId: msg.id, part }))
  );

  return (
    <div
      style={{
        fontFamily: "system-ui",
        padding: "20px",
        maxWidth: "1200px",
        margin: "0 auto"
      }}
    >
      <h1>addToolApprovalResponse Bug Reproduction</h1>

      <div
        style={{
          background: "#f5f5f5",
          padding: "15px",
          borderRadius: "8px",
          marginBottom: "20px"
        }}
      >
        <h3 style={{ margin: "0 0 10px 0" }}>Instructions:</h3>
        <ol style={{ margin: 0, paddingLeft: "20px" }}>
          <li>Click "Send Test Message" to trigger a tool call</li>
          <li>Click "Approve (BUG)" to call addToolApprovalResponse</li>
          <li>Check the "Server Persisted Messages" panel for duplicates</li>
          <li>Compare with "Approve (Working)" which uses addToolResult</li>
        </ol>
      </div>

      {/* Controls */}
      <div style={{ marginBottom: "20px", display: "flex", gap: "10px" }}>
        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", gap: "10px", flex: 1 }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            style={{ flex: 1, padding: "10px", fontSize: "16px" }}
          />
          <button type="submit" style={{ padding: "10px 20px" }}>
            Send
          </button>
        </form>
        <button
          onClick={() => {
            sendMessage({
              role: "user",
              parts: [{ type: "text", text: "What is the weather in Paris?" }]
            });
          }}
          style={{
            padding: "10px 20px",
            background: "#4CAF50",
            color: "white",
            border: "none",
            cursor: "pointer"
          }}
        >
          Send Test Message
        </button>
        <button
          onClick={() => {
            clearHistory();
            setDebugData(null);
          }}
          style={{ padding: "10px 20px" }}
        >
          Clear History
        </button>
        <button onClick={fetchDebugData} style={{ padding: "10px 20px" }}>
          Refresh Debug
        </button>
      </div>

      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}
      >
        {/* Left: Client Messages */}
        <div>
          <h2>Client Messages ({messages.length})</h2>

          {/* Pending Approvals */}
          {pendingToolParts.length > 0 && (
            <div
              style={{
                background: "#fff3cd",
                padding: "15px",
                borderRadius: "8px",
                marginBottom: "15px"
              }}
            >
              <h3 style={{ margin: "0 0 10px 0" }}>Pending Approvals</h3>
              {pendingToolParts.map(({ messageId, part }) => {
                // Tool part in approval-requested state has an approval object with id
                const toolPart = part as {
                  toolCallId: string;
                  state: string;
                  input: unknown;
                  approval?: { id: string };
                };
                const approvalId = toolPart.approval?.id;
                return (
                  <div
                    key={toolPart.toolCallId}
                    style={{ marginBottom: "10px" }}
                  >
                    <div>
                      <strong>Tool:</strong> {getToolName(part)}
                    </div>
                    <div>
                      <strong>toolCallId:</strong>{" "}
                      <code>{toolPart.toolCallId}</code>
                    </div>
                    <div>
                      <strong>approvalId:</strong>{" "}
                      <code>{approvalId || "N/A"}</code>
                    </div>
                    <div>
                      <strong>State:</strong> <code>{toolPart.state}</code>
                    </div>
                    <div>
                      <strong>Input:</strong> {JSON.stringify(toolPart.input)}
                    </div>
                    <div
                      style={{
                        marginTop: "10px",
                        display: "flex",
                        gap: "10px"
                      }}
                    >
                      <button
                        onClick={() => {
                          console.log(
                            "=== BUG TRIGGER: addToolApprovalResponse ==="
                          );
                          console.log("toolCallId:", toolPart.toolCallId);
                          console.log("approvalId:", approvalId);
                          if (!approvalId) {
                            console.error("No approvalId found on tool part!");
                            return;
                          }
                          // addToolApprovalResponse uses the approvalId (not toolCallId)
                          addToolApprovalResponse({
                            id: approvalId,
                            approved: true
                          });
                          // Need to call sendMessage to continue the conversation
                          sendMessage();
                        }}
                        style={{
                          padding: "8px 16px",
                          background: "#dc3545",
                          color: "white",
                          border: "none",
                          cursor: "pointer"
                        }}
                        disabled={!approvalId}
                      >
                        Approve (BUG - addToolApprovalResponse)
                      </button>
                      <button
                        onClick={() => {
                          console.log("=== WORKING: addToolResult ===");
                          console.log("toolCallId:", toolPart.toolCallId);
                          addToolResult({
                            tool: getToolName(part),
                            toolCallId: toolPart.toolCallId,
                            output: "Weather in Paris: Sunny, 22C"
                          });
                        }}
                        style={{
                          padding: "8px 16px",
                          background: "#28a745",
                          color: "white",
                          border: "none",
                          cursor: "pointer"
                        }}
                      >
                        Approve (Working - addToolResult)
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Message List */}
          <div
            style={{
              background: "#f8f9fa",
              padding: "15px",
              borderRadius: "8px",
              maxHeight: "400px",
              overflow: "auto"
            }}
          >
            {messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  marginBottom: "15px",
                  padding: "10px",
                  background: "white",
                  borderRadius: "4px"
                }}
              >
                <div style={{ fontWeight: "bold", marginBottom: "5px" }}>
                  {msg.role}{" "}
                  <span
                    style={{
                      fontWeight: "normal",
                      color: "#666",
                      fontSize: "12px"
                    }}
                  >
                    (id: {msg.id})
                  </span>
                </div>
                {msg.parts?.map((part, i) => (
                  <div key={i} style={{ marginLeft: "10px", fontSize: "14px" }}>
                    {part.type === "text" && (
                      <div>{(part as { text: string }).text}</div>
                    )}
                    {isToolUIPart(part) && (
                      <div
                        style={{
                          background: "#e9ecef",
                          padding: "8px",
                          borderRadius: "4px",
                          marginTop: "5px"
                        }}
                      >
                        <div>
                          <strong>Tool:</strong> {getToolName(part)}
                        </div>
                        <div>
                          <strong>State:</strong>{" "}
                          {(part as { state: string }).state}
                        </div>
                        <div>
                          <strong>toolCallId:</strong>{" "}
                          {(part as { toolCallId: string }).toolCallId}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {messages.length === 0 && (
              <div style={{ color: "#666" }}>No messages yet</div>
            )}
          </div>
        </div>

        {/* Right: Server Persisted Messages */}
        <div>
          <h2>
            Server Persisted Messages
            {debugData?.hasDuplicates && (
              <span style={{ color: "red", marginLeft: "10px" }}>
                DUPLICATES FOUND!
              </span>
            )}
          </h2>

          {/* Duplicate Warning */}
          {debugData?.hasDuplicates && (
            <div
              style={{
                background: "#f8d7da",
                padding: "15px",
                borderRadius: "8px",
                marginBottom: "15px"
              }}
            >
              <h3 style={{ margin: "0 0 10px 0", color: "#721c24" }}>
                Bug Detected: Duplicate Messages
              </h3>
              <p style={{ margin: "0 0 10px 0" }}>
                The following toolCallIds have multiple messages:
              </p>
              {debugData.duplicates.map((dup) => (
                <div key={dup.toolCallId} style={{ marginBottom: "10px" }}>
                  <strong>toolCallId:</strong> {dup.toolCallId}
                  <ul style={{ margin: "5px 0", paddingLeft: "20px" }}>
                    {dup.messages.map((m, i) => (
                      <li key={i}>
                        messageId: <code>{m.messageId}</code>, state:{" "}
                        <code>{m.state}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {/* Raw Messages */}
          <div
            style={{
              background: "#f8f9fa",
              padding: "15px",
              borderRadius: "8px",
              maxHeight: "500px",
              overflow: "auto"
            }}
          >
            <pre
              style={{ margin: 0, fontSize: "12px", whiteSpace: "pre-wrap" }}
            >
              {debugData
                ? JSON.stringify(debugData.messages, null, 2)
                : "Loading..."}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

// Mount the app
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
