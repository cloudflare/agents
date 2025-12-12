import type { UIMessage as Message } from "ai";
import { getToolName, isToolUIPart } from "ai";
import { clientTools } from "./tools";
import { APPROVAL, toolsRequiringConfirmation } from "./utils";
import "./styles.css";
import { useAgentChat, type AITool } from "agents/ai-react";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";

export default function Chat() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [showMetadata, setShowMetadata] = useState(true);
  const [lastResponseTime, setLastResponseTime] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    // Set initial theme
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Scroll to bottom on mount
  useEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  const toggleTheme = () => {
    const newTheme = theme === "dark" ? "light" : "dark";
    setTheme(newTheme);
    document.documentElement.setAttribute("data-theme", newTheme);
  };

  const agent = useAgent({
    agent: "human-in-the-loop"
  });

  const { messages, sendMessage, addToolResult, clearHistory } = useAgentChat({
    agent,
    experimental_automaticToolResolution: true,
    toolsRequiringConfirmation,
    tools: clientTools satisfies Record<string, AITool>,
    // Enable server auto-continuation after tool results for seamless UX
    autoContinueAfterToolResult: true
  });

  const [input, setInput] = useState("");

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (input.trim()) {
        const startTime = Date.now();
        sendMessage({ role: "user", parts: [{ type: "text", text: input }] });
        setInput("");
        // Simulate response time tracking
        setTimeout(() => {
          setLastResponseTime(Date.now() - startTime);
        }, 1000);
      }
    },
    [input, sendMessage]
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
  };

  // Scroll to bottom when messages change
  useEffect(() => {
    messages.length > 0 && scrollToBottom();
  }, [messages, scrollToBottom]);

  // Tools requiring confirmation are auto-detected by useAgentChat from tools object
  // Tools without execute function need confirmation (getWeatherInformation)
  // Tools with execute function are automatic (getLocalTime)
  const pendingToolCallConfirmation = messages.some((m: Message) =>
    m.parts?.some(
      (part) => isToolUIPart(part) && part.state === "input-available"
    )
  );

  return (
    <>
      <div className="controls-container">
        <button
          type="button"
          onClick={toggleTheme}
          className="theme-switch"
          data-theme={theme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          <div className="theme-switch-handle" />
        </button>
        <button type="button" onClick={clearHistory} className="clear-history">
          🗑️ Clear History
        </button>
        <button
          type="button"
          onClick={() => setShowMetadata(!showMetadata)}
          className="clear-history"
          style={{ marginLeft: "10px" }}
        >
          {showMetadata ? "📊 Hide" : "📊 Show"} Metadata
        </button>
      </div>

      {/* Metadata Display Panel */}
      {showMetadata && (
        <div
          style={{
            background: "var(--background-secondary)",
            border: "1px solid var(--border-color)",
            borderRadius: "8px",
            padding: "15px",
            margin: "10px 20px",
            fontSize: "14px"
          }}
        >
          <h3 style={{ margin: "0 0 10px 0", color: "var(--text-primary)" }}>
            📊 Response Metadata
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "10px",
              color: "var(--text-secondary)"
            }}
          >
            <div>
              <strong>Model:</strong> gpt-4o
            </div>
            <div>
              <strong>Messages:</strong> {messages.length}
            </div>
            <div>
              <strong>Conversation Turns:</strong>{" "}
              {Math.floor(messages.length / 2)}
            </div>
            <div>
              <strong>Tools Available:</strong>{" "}
              {Object.keys(clientTools).length}
            </div>
            <div>
              <strong>Human-in-Loop:</strong> ✓ Enabled
            </div>
            <div>
              <strong>Session ID:</strong> {agent.id || "Active"}
            </div>
            {lastResponseTime && (
              <div>
                <strong>Last Response:</strong> {lastResponseTime}ms
              </div>
            )}
            <div>
              <strong>Timestamp:</strong> {new Date().toLocaleTimeString()}
            </div>
          </div>
          <div
            style={{
              marginTop: "10px",
              padding: "10px",
              background: "var(--background-primary)",
              borderRadius: "4px",
              fontSize: "12px",
              color: "var(--text-tertiary)"
            }}
          />
        </div>
      )}

      <div className="chat-container">
        <div className="messages-wrapper">
          {messages?.map((m: Message) => (
            <div key={m.id} className="message">
              <strong>{`${m.role}: `}</strong>
              {m.parts?.map((part, i) => {
                switch (part.type) {
                  case "text":
                    return (
                      <div key={i} className="message-content">
                        {part.text}
                      </div>
                    );
                  default:
                    if (isToolUIPart(part)) {
                      const toolCallId = part.toolCallId;
                      const toolName = getToolName(part);

                      // Show tool results for automatic tools
                      if (part.state === "output-available") {
                        return (
                          <div key={toolCallId} className="tool-invocation">
                            <span className="dynamic-info">{toolName}</span>{" "}
                            returned:{" "}
                            <span className="dynamic-info">
                              {JSON.stringify(part.output, null, 2)}
                            </span>
                          </div>
                        );
                      }

                      // render confirmation tool (client-side tool with user interaction)
                      if (part.state === "input-available") {
                        const tool = clientTools[toolName];
                        // Don't show confirmation UI for server-executed tools
                        if (!toolsRequiringConfirmation.includes(toolName)) {
                          return (
                            <div key={toolCallId} className="tool-invocation">
                              <span className="dynamic-info">{toolName}</span>{" "}
                              executing...
                            </div>
                          );
                        }
                        return (
                          <div key={toolCallId} className="tool-invocation">
                            Run <span className="dynamic-info">{toolName}</span>{" "}
                            with args:{" "}
                            <span className="dynamic-info">
                              {JSON.stringify(part.input)}
                            </span>
                            <div className="button-container">
                              <button
                                type="button"
                                className="button-approve"
                                onClick={async () => {
                                  // If it's a client-side tool requiring approval
                                  // we execute it and set the result, otherwise we
                                  // set the approval and let the server handle it
                                  const output = tool.execute
                                    ? await tool.execute(part.input)
                                    : APPROVAL.YES;
                                  addToolResult({
                                    tool: toolName,
                                    output,
                                    toolCallId
                                  });
                                }}
                              >
                                Yes
                              </button>
                              <button
                                type="button"
                                className="button-reject"
                                onClick={() => {
                                  const output = tool.execute
                                    ? "User declined to run tool"
                                    : APPROVAL.NO;
                                  addToolResult({
                                    tool: toolName,
                                    output,
                                    toolCallId
                                  });
                                }}
                              >
                                No
                              </button>
                            </div>
                          </div>
                        );
                      }
                    }
                    return null;
                }
              })}
              <br />
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={handleSubmit}>
          <input
            disabled={pendingToolCallConfirmation}
            className="chat-input"
            value={input}
            placeholder="Say something..."
            onChange={handleInputChange}
          />
        </form>
      </div>
    </>
  );
}
