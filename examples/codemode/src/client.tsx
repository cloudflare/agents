import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import "./styles.css";
import { generateId, type UIMessage } from "ai";
import { useState, useEffect, useRef } from "react";
import { Streamdown } from "streamdown";
import type { Codemode, ExecutorType } from "./server";

interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: string;
  errorText?: string;
  input?: { functionDescription?: string; [key: string]: unknown };
  output?: {
    code?: string;
    result?: string;
    logs?: string[];
    [key: string]: unknown;
  };
}

function asToolPart(part: UIMessage["parts"][0]): ToolPart | null {
  if (!part.type.startsWith("tool-")) return null;
  return part as unknown as ToolPart;
}

const EXECUTORS: { value: ExecutorType; label: string; description: string }[] =
  [
    {
      value: "dynamic-worker",
      label: "Dynamic Worker",
      description: "Sandboxed Cloudflare Worker via WorkerLoader"
    },
    {
      value: "node-server",
      label: "Node Server",
      description: "Node.js VM via external HTTP server"
    }
  ];

const TOOLS: { name: string; description: string }[] = [
  { name: "createProject", description: "Create a new project" },
  { name: "listProjects", description: "List all projects" },
  { name: "createTask", description: "Create a task in a project" },
  { name: "listTasks", description: "List tasks with optional filters" },
  { name: "updateTask", description: "Update a task's fields" },
  { name: "deleteTask", description: "Delete a task and its comments" },
  { name: "createSprint", description: "Create a sprint for a project" },
  {
    name: "listSprints",
    description: "List sprints, optionally by project"
  },
  { name: "addComment", description: "Add a comment to a task" },
  { name: "listComments", description: "List comments on a task" }
];

function extractFunctionCalls(code?: string): string[] {
  if (!code) return [];
  const matches = code.match(/codemode\.(\w+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace("codemode.", "")))];
}

// ── Icons ──

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      style={{
        transform: expanded ? "rotate(90deg)" : "none",
        transition: "transform 0.15s ease"
      }}
    >
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path
        d="M9 1.5L3 9.5h4.5L7 14.5l6-8H8.5L9 1.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 10a2 2 0 100-4 2 2 0 000 4z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M13.4 6.5l-.7-.4a5.5 5.5 0 00-.5-.9l.1-.8a.5.5 0 00-.2-.5l-1-.6a.5.5 0 00-.5 0l-.7.5a5 5 0 00-1 0l-.7-.5a.5.5 0 00-.5 0l-1 .6a.5.5 0 00-.2.5l.1.8a5 5 0 00-.5.9l-.7.4a.5.5 0 00-.3.4v1.2a.5.5 0 00.3.4l.7.4c.1.3.3.6.5.9l-.1.8a.5.5 0 00.2.5l1 .6a.5.5 0 00.5 0l.7-.5a5 5 0 001 0l.7.5a.5.5 0 00.5 0l1-.6a.5.5 0 00.2-.5l-.1-.8c.2-.3.4-.6.5-.9l.7-.4a.5.5 0 00.3-.4V6.9a.5.5 0 00-.3-.4z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M14 2L7 9M14 2l-4.5 12L7 9M14 2L2 6.5 7 9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M2.5 2.5v4h4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.5 10a5 5 0 107-7l-8 3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Components ──

function ReasoningBlock({
  text,
  isStreaming
}: {
  text: string;
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!text?.trim()) return null;

  return (
    <div className="reasoning-block">
      <button
        className="reasoning-toggle"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <ChevronIcon expanded={expanded} />
        <span className="reasoning-label">Thinking</span>
      </button>
      {expanded && (
        <div className="reasoning-content">
          <Streamdown
            className="sd-theme"
            controls={false}
            isAnimating={isStreaming}
          >
            {text}
          </Streamdown>
        </div>
      )}
    </div>
  );
}

function ToolCard({ toolPart }: { toolPart: ToolPart }) {
  const [expanded, setExpanded] = useState(false);
  const hasError = toolPart.state === "output-error" || !!toolPart.errorText;
  const isComplete = toolPart.state === "output-available";
  const isRunning = !isComplete && !hasError;

  const functionCalls = extractFunctionCalls(
    toolPart.output?.code || (toolPart.input?.code as string)
  );
  const summary =
    functionCalls.length > 0 ? functionCalls.join(", ") : "code execution";

  return (
    <div
      className={`tool-card ${hasError ? "tool-card--error" : ""} ${isComplete ? "tool-card--complete" : ""}`}
    >
      <button
        className="tool-card-header"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <ChevronIcon expanded={expanded} />
        <BoltIcon />
        <span className="tool-card-summary">
          <span className="tool-card-action">Ran code</span>
          {functionCalls.length > 0 && (
            <>
              <span className="tool-card-dot">&middot;</span>
              <span className="tool-card-fns">{summary}</span>
            </>
          )}
        </span>
        <span className="tool-card-status">
          {isComplete && <span className="status-dot status-dot--success" />}
          {hasError && <span className="status-dot status-dot--error" />}
          {isRunning && <span className="status-spinner" />}
        </span>
      </button>

      {expanded && (
        <div className="tool-card-body">
          {toolPart.output?.code && (
            <div className="tool-card-section">
              <div className="tool-card-section-label">Code</div>
              <pre className="tool-card-code">
                <code>{toolPart.output.code}</code>
              </pre>
            </div>
          )}
          {!toolPart.output?.code && toolPart.input && (
            <div className="tool-card-section">
              <div className="tool-card-section-label">Input</div>
              <pre className="tool-card-code">
                <code>{JSON.stringify(toolPart.input, null, 2)}</code>
              </pre>
            </div>
          )}
          {toolPart.output?.result !== undefined && (
            <div className="tool-card-section">
              <div className="tool-card-section-label">Result</div>
              <pre className="tool-card-code">
                <code>{JSON.stringify(toolPart.output.result, null, 2)}</code>
              </pre>
            </div>
          )}
          {toolPart.output?.logs && toolPart.output.logs.length > 0 && (
            <div className="tool-card-section">
              <div className="tool-card-section-label">Console</div>
              <pre className="tool-card-code">
                <code>{toolPart.output.logs.join("\n")}</code>
              </pre>
            </div>
          )}
          {toolPart.errorText && (
            <div className="tool-card-section tool-card-section--error">
              <div className="tool-card-section-label">Error</div>
              <pre className="tool-card-code tool-card-code--error">
                <code>{toolPart.errorText}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MessagePart({
  part,
  isStreaming
}: {
  part: UIMessage["parts"][0];
  isStreaming: boolean;
}) {
  if (part.type === "text") {
    return (
      <Streamdown
        className="sd-theme message-text"
        controls={false}
        isAnimating={isStreaming}
      >
        {part.text}
      </Streamdown>
    );
  }

  if (part.type === "step-start") return null;

  if (part.type === "reasoning") {
    return <ReasoningBlock text={part.text} isStreaming={isStreaming} />;
  }

  if (part.type === "file") {
    return (
      <div className="file-block">
        <span className="file-name">{part.filename || "Untitled"}</span>
        {part.mediaType && <span className="file-type">{part.mediaType}</span>}
        {part.url && (
          <a
            href={part.url}
            target="_blank"
            rel="noopener noreferrer"
            className="file-link"
          >
            View
          </a>
        )}
      </div>
    );
  }

  const toolPart = asToolPart(part);
  if (toolPart) {
    return <ToolCard toolPart={toolPart} />;
  }

  return (
    <div className="unknown-block">
      <pre>{JSON.stringify(part, null, 2)}</pre>
    </div>
  );
}

function SettingsPanel({
  executor,
  onExecutorChange,
  toolDef,
  loading,
  onClose
}: {
  executor: ExecutorType;
  onExecutorChange: (e: ExecutorType) => void;
  toolDef: {
    name: string;
    description: string;
    inputSchema: unknown;
  } | null;
  loading: boolean;
  onClose: () => void;
}) {
  const [showSchema, setShowSchema] = useState(false);

  return (
    <>
      <button
        type="button"
        className="settings-backdrop"
        onClick={onClose}
        aria-label="Close settings"
      />
      <aside className="settings-panel">
        <div className="settings-header">
          <h3>Settings</h3>
          <button className="settings-close" onClick={onClose} type="button">
            &times;
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-section">
            <label className="settings-label" htmlFor="executor-select">
              Executor
            </label>
            <select
              id="executor-select"
              className="settings-select"
              value={executor}
              onChange={(e) => onExecutorChange(e.target.value as ExecutorType)}
              disabled={loading}
            >
              {EXECUTORS.map((exec) => (
                <option key={exec.value} value={exec.value}>
                  {exec.label}
                </option>
              ))}
            </select>
            <p className="settings-hint">
              {EXECUTORS.find((e) => e.value === executor)?.description}
            </p>
          </div>

          <div className="settings-section">
            <span className="settings-label">Available Functions</span>
            <div className="tools-grid">
              {TOOLS.map((tool) => (
                <div key={tool.name} className="tool-chip">
                  <span className="tool-chip-name">{tool.name}</span>
                  <span className="tool-chip-desc">{tool.description}</span>
                </div>
              ))}
            </div>
          </div>

          {toolDef && (
            <div className="settings-section">
              <button
                className="settings-toggle"
                onClick={() => setShowSchema(!showSchema)}
                type="button"
              >
                <ChevronIcon expanded={showSchema} />
                <span>Tool Schema</span>
              </button>
              {showSchema && (
                <pre className="settings-schema">
                  {JSON.stringify(toolDef.inputSchema, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function EmptyState({
  onSuggestionClick
}: {
  onSuggestionClick: (text: string) => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">&#9670;</div>
      <h2>Welcome to Planwise</h2>
      <p>
        Your AI-powered project management assistant. Ask me to help organize
        projects, tasks, sprints, and more.
      </p>
      <div className="empty-state-suggestions">
        <button
          type="button"
          className="suggestion"
          onClick={() =>
            onSuggestionClick('Create a new project called "Alpha"')
          }
        >
          Create a new project
        </button>
        <button
          type="button"
          className="suggestion"
          onClick={() => onSuggestionClick("List all my tasks")}
        >
          List all tasks
        </button>
        <button
          type="button"
          className="suggestion"
          onClick={() => onSuggestionClick("Add a sprint for next week")}
        >
          Add a sprint
        </button>
      </div>
    </div>
  );
}

// ── App ──

function App() {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [inputMessage, setInputMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [executor, setExecutor] = useState<ExecutorType>("dynamic-worker");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toolDef, setToolDef] = useState<{
    name: string;
    description: string;
    inputSchema: unknown;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const toolDefFetched = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const agent = useAgent<
    Codemode,
    { messages: UIMessage[]; loading: boolean; executor: ExecutorType }
  >({
    agent: "codemode",
    onStateUpdate: (state) => {
      setMessages(state.messages);
      setLoading(state.loading);
      setExecutor(state.executor);
      if (!toolDefFetched.current) {
        toolDefFetched.current = true;
        agent.call("getToolDefinition", []).then((def: unknown) => {
          setToolDef(def as typeof toolDef);
        });
      }
    }
  });

  const handleExecutorChange = (newExecutor: ExecutorType) => {
    setExecutor(newExecutor);
    agent.call("setExecutor", [newExecutor]);
  };

  const sendMessage = async () => {
    if (!inputMessage.trim()) return;
    const userMessage: UIMessage = {
      id: generateId(),
      role: "user",
      parts: [{ type: "text", text: inputMessage }]
    };
    agent.setState({ messages: [...messages, userMessage], loading, executor });
    setInputMessage("");
  };

  const resetMessages = () => {
    agent.setState({ messages: [], loading: false, executor });
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="header-logo">&#9670;</span>
          <h1>Planwise</h1>
        </div>
        <div className="header-right">
          <button
            className="header-btn"
            onClick={resetMessages}
            disabled={messages.length === 0}
            title="New conversation"
            type="button"
          >
            <ResetIcon />
            <span>New Chat</span>
          </button>
          <button
            className="header-btn header-btn--icon"
            onClick={() => setSettingsOpen(!settingsOpen)}
            title="Settings"
            type="button"
          >
            <GearIcon />
          </button>
        </div>
      </header>

      <main className="chat-main">
        <div className="messages-scroll">
          <div className="messages-container">
            {messages.length === 0 && !loading && (
              <EmptyState
                onSuggestionClick={(text) => {
                  setInputMessage(text);
                  inputRef.current?.focus();
                }}
              />
            )}

            {messages.map((message, msgIndex) => {
              const isLastAssistant =
                message.role === "assistant" &&
                msgIndex === messages.length - 1;
              const isStreaming = loading && isLastAssistant;

              return (
                <div
                  key={message.id}
                  className={`message message--${message.role}`}
                >
                  {message.role === "assistant" && (
                    <div className="message-avatar">
                      <span>&#9670;</span>
                    </div>
                  )}
                  <div className="message-body">
                    {message.parts.map((part, index) => (
                      <div key={`${message.id}-${index}`}>
                        <MessagePart part={part} isStreaming={isStreaming} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {loading && (
              <div className="message message--assistant">
                <div className="message-avatar">
                  <span>&#9670;</span>
                </div>
                <div className="message-body">
                  <div className="loading-dots">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="input-area">
          <div className="input-container">
            <input
              ref={inputRef}
              type="text"
              placeholder="Ask me to manage your projects..."
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              disabled={loading}
            />
            <button
              className="send-btn"
              onClick={sendMessage}
              disabled={!inputMessage.trim() || loading}
              type="button"
            >
              <SendIcon />
            </button>
          </div>
          <div className="input-footer">
            <span>Powered by codemode</span>
            <span className="input-footer-dot">&middot;</span>
            <span>{EXECUTORS.find((e) => e.value === executor)?.label}</span>
          </div>
        </div>
      </main>

      {settingsOpen && (
        <SettingsPanel
          executor={executor}
          onExecutorChange={handleExecutorChange}
          toolDef={toolDef}
          loading={loading}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
