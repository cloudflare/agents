import type { UIMessage} from "@ai-sdk/react";
import { isToolUIPart, getToolName } from "ai";
import type { tools } from "./tools";
import { APPROVAL } from "./utils";
import "./styles.css";
import { useAgentChat } from "agents/ai-react";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";

export default function Chat() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [input, setInput] = useState("");
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

  const {
    messages,
    sendMessage,
    addToolResult,
    clearHistory
  } = useAgentChat({
    agent,
  });

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim()) return;
      
      await sendMessage({ text: input });
      setInput("");
    },
    [input, sendMessage]
  );

  // Scroll to bottom when messages change
  useEffect(() => {
    messages.length > 0 && scrollToBottom();
  }, [messages, scrollToBottom]);

  // List of tools that require human confirmation
  const toolsRequiringConfirmation: (keyof typeof tools)[] = [
    "getWeatherInformation"
  ];

   const pendingToolCallConfirmation = messages.some(m =>
    m.parts?.some(
      part =>
        isToolUIPart(part) &&
        part.state === 'input-available' &&
        toolsRequiringConfirmation.includes(getToolName(part) as keyof typeof tools),
    ),
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
      </div>

      <div className="chat-container">
        <div className="messages-wrapper">
          {messages?.map((m) => (
            <div key={m.id} className="message">
              <strong>{`${m.role}: `}</strong>
              {m.parts?.map((part, i) => {
                switch (part.type) {
                  case "text":
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: vibes
                      <div key={i} className="message-content">
                        {part.text}
                      </div>
                    );
                  default: {
                    if (!isToolUIPart(part)) {
                      return null;
                    }
                    
                    const toolCallId = part.toolCallId;
                    const toolName = getToolName(part);

                    // render confirmation tool (client-side tool with user interaction)
                    if (
                      part.state === 'input-available' &&
                      toolsRequiringConfirmation.includes(
                        toolName as keyof typeof tools
                      )
                    ) {
                      return (
                        <div key={toolCallId} className="tool-invocation">
                          Run{" "}
                          <span className="dynamic-info">
                            {toolName}
                          </span>{" "}
                          with args:{" "}
                          <span className="dynamic-info">
                            {JSON.stringify('input' in part ? part.input : {})}
                          </span>
                          <div className="button-container">
                            <button
                              type="button"
                              className="button-approve"
                              onClick={async () => {
                                await addToolResult({
                                  tool: toolName,
                                  output: APPROVAL.YES,
                                  toolCallId,
                                });
                                sendMessage();
                              }}
                            >
                              Yes
                            </button>
                            <button
                              type="button"
                              className="button-reject"
                              onClick={async () => {
                                await addToolResult({
                                  tool: toolName,
                                  output: APPROVAL.NO,
                                  toolCallId,
                                });
                                sendMessage();
                              }}
                            >
                              No
                            </button>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  }
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
            onChange={(e) => setInput(e.target.value)}
          />
        </form>
      </div>
    </>
  );
}
