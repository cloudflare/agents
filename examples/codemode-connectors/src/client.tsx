import { useAgent } from "agents/react";
import { useAgentChat } from "agents/ai-react";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Surface, Text, PoweredByCloudflare } from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { isToolUIPart } from "ai";
import {
  PaperPlaneRightIcon,
  TrashIcon,
  CodeIcon,
  ShieldCheckIcon,
  MoonIcon,
  SunIcon,
  LightningIcon,
  CheckCircleIcon,
  WarningCircleIcon,
  CircleNotchIcon,
  PauseCircleIcon,
  TerminalIcon,
  BrainIcon,
  CaretDownIcon
} from "@phosphor-icons/react";
import { nanoid } from "nanoid";
import "./styles.css";

let sessionId = localStorage.getItem("sessionId");
if (!sessionId) {
  sessionId = nanoid(8);
  localStorage.setItem("sessionId", sessionId);
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";

type PendingAction = {
  executionId: string;
  seq: number;
  connector: string;
  method: string;
  args: unknown;
};

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";
  return (
    <output className="flex items-center gap-2">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className="text-xs text-kumo-subtle">{label}</span>
    </output>
  );
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);
  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

// The codemode tool's output shape (ProxyToolOutput), as the UI consumes it.
type CodemodeOutput = {
  status?: "completed" | "paused" | "error";
  executionId?: string;
  result?: unknown;
  logs?: string[];
  error?: string;
  pending?: Array<{ connector: string; method: string }>;
};

type ToolPart = {
  type: string;
  state?: string;
  errorText?: string;
  input?: { code?: string };
  output?: CodemodeOutput;
};

// Surface the connector/platform calls the model made, so the collapsed header
// is informative without expanding the code. (Example connectors are known.)
const CONNECTOR_CALL = /\b(codemode|github|repoApi)\.(\w+)\s*\(/g;
function extractCalls(src?: string): string[] {
  if (!src) return [];
  const found = new Set<string>();
  for (const m of src.matchAll(CONNECTOR_CALL)) found.add(`${m[1]}.${m[2]}`);
  return [...found];
}

function CodeBlock({ source }: { source: string }) {
  return (
    <Streamdown
      className="sd-theme text-xs leading-relaxed"
      plugins={{ code }}
      controls={false}
    >
      {`\`\`\`ts\n${source}\n\`\`\``}
    </Streamdown>
  );
}

function SectionLabel({
  icon,
  children
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 mb-1">
      {icon}
      <Text size="xs" variant="secondary" bold>
        {children}
      </Text>
    </div>
  );
}

function ToolCard({ part }: { part: ToolPart }) {
  const [expanded, setExpanded] = useState(true);
  const calls = extractCalls(part.input?.code);
  const status = part.output?.status;
  const hasError =
    part.state === "output-error" || status === "error" || !!part.errorText;
  const isPaused = status === "paused";
  const isDone = part.state === "output-available" && status === "completed";
  const isRunning = !isDone && !hasError && !isPaused;
  const errorText = part.errorText ?? part.output?.error;

  return (
    <Surface
      className={`rounded-xl ring overflow-hidden ${
        hasError ? "ring-kumo-danger" : "ring-kumo-line"
      }`}
    >
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-kumo-elevated transition-colors"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <LightningIcon size={14} className="text-kumo-accent shrink-0" />
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <Text size="xs" bold>
            codemode
          </Text>
          {calls.length > 0 && (
            <>
              <span className="text-kumo-inactive">&middot;</span>
              <span className="font-mono text-xs text-kumo-secondary truncate">
                {calls.join(", ")}
              </span>
            </>
          )}
        </div>
        {isDone && <CheckCircleIcon size={14} className="text-green-500" />}
        {isPaused && (
          <PauseCircleIcon size={14} className="text-kumo-warning" />
        )}
        {hasError && <WarningCircleIcon size={14} className="text-red-500" />}
        {isRunning && (
          <CircleNotchIcon
            size={14}
            className="text-kumo-inactive animate-spin"
          />
        )}
        <CaretDownIcon
          size={12}
          className={`text-kumo-inactive transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-kumo-line space-y-3 pt-2">
          {part.input?.code && (
            <div>
              <SectionLabel
                icon={<CodeIcon size={11} className="text-kumo-inactive" />}
              >
                Code
              </SectionLabel>
              <CodeBlock source={part.input.code} />
            </div>
          )}

          {isPaused && (
            <div className="flex items-start gap-2 rounded-lg bg-kumo-warning/10 p-2.5">
              <PauseCircleIcon
                size={14}
                weight="bold"
                className="text-kumo-warning shrink-0 mt-0.5"
              />
              <Text size="xs" variant="secondary">
                Paused for approval — review the request in the panel above.
              </Text>
            </div>
          )}

          {part.output?.result !== undefined && (
            <div>
              <SectionLabel
                icon={
                  <CheckCircleIcon size={11} className="text-kumo-inactive" />
                }
              >
                Result
              </SectionLabel>
              <pre className="font-mono text-xs text-kumo-default bg-green-500/5 border border-green-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap wrap-break-word">
                {typeof part.output.result === "string"
                  ? part.output.result
                  : JSON.stringify(part.output.result, null, 2)}
              </pre>
            </div>
          )}

          {part.output?.logs?.length ? (
            <div>
              <SectionLabel
                icon={<TerminalIcon size={11} className="text-kumo-inactive" />}
              >
                Console
              </SectionLabel>
              <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded p-2 overflow-x-auto whitespace-pre-wrap wrap-break-word">
                {part.output.logs.join("\n")}
              </pre>
            </div>
          ) : null}

          {errorText && (
            <div>
              <SectionLabel
                icon={<WarningCircleIcon size={11} className="text-red-500" />}
              >
                Error
              </SectionLabel>
              <pre className="font-mono text-xs text-red-500 bg-red-500/5 border border-red-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap wrap-break-word">
                {errorText}
              </pre>
            </div>
          )}
        </div>
      )}
    </Surface>
  );
}

function ReasoningBlock({
  text,
  streaming
}: {
  text: string;
  streaming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Surface className="rounded-xl ring ring-kumo-line overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-kumo-elevated transition-colors"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <BrainIcon size={14} className="text-kumo-secondary shrink-0" />
        <Text size="xs" bold>
          Reasoning
        </Text>
        <div className="flex-1" />
        {streaming && (
          <CircleNotchIcon
            size={14}
            className="text-kumo-inactive animate-spin"
          />
        )}
        <CaretDownIcon
          size={12}
          className={`text-kumo-inactive transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t border-kumo-line pt-2">
          <Streamdown
            className="sd-theme text-xs leading-relaxed text-kumo-secondary **:text-kumo-secondary"
            plugins={{ code }}
            controls={false}
            isAnimating={streaming}
          >
            {text}
          </Streamdown>
        </div>
      )}
    </Surface>
  );
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [busy, setBusy] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const agent = useAgent({
    agent: "chat",
    name: sessionId!,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), [])
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming";

  const refreshPending = useCallback(async () => {
    try {
      const next = (await agent.call("pendingApprovals")) as PendingAction[];
      setPending(next ?? []);
    } catch {
      // agent not ready yet
    }
  }, [agent]);

  // Refresh the approval queue whenever a turn settles.
  useEffect(() => {
    if (status === "ready") refreshPending();
  }, [status, messages, refreshPending]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    const message = input;
    setInput("");
    await sendMessage({
      role: "user",
      parts: [{ type: "text", text: message }]
    });
  };

  const approve = async (action: PendingAction) => {
    setBusy(true);
    try {
      await agent.call("approveExecution", [action.executionId]);
      await refreshPending();
      await sendMessage({
        role: "user",
        parts: [
          {
            type: "text",
            text: `I approved ${action.connector}.${action.method}. Please continue and summarize the result.`
          }
        ]
      });
    } finally {
      setBusy(false);
    }
  };

  const reject = async (action: PendingAction) => {
    setBusy(true);
    try {
      await agent.call("rejectExecution", [action.executionId, action.seq]);
      await refreshPending();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (messages.length > 0) scrollToBottom();
  }, [messages, scrollToBottom]);

  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CodeIcon size={22} className="text-kumo-accent" weight="bold" />
            <h1 className="text-lg font-semibold text-kumo-default">
              Codemode Connectors
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="ghost"
              size="sm"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-3xl mx-auto space-y-4">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <CodeIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  One tool, many connectors
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    The model gets a single <code>codemode</code> tool that runs
                    TypeScript in a sandbox. A GitHub-style MCP server and an
                    OpenAPI service are exposed as <code>github</code> and{" "}
                    <code>repoApi</code>. Writes like{" "}
                    <code>github.create_issue</code> pause for your approval
                    below.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {pending.length > 0 && (
            <Surface className="p-4 rounded-xl ring ring-kumo-warning">
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheckIcon
                  size={16}
                  weight="bold"
                  className="text-kumo-warning"
                />
                <Text size="sm" bold>
                  Approval required
                </Text>
              </div>
              <div className="space-y-3">
                {pending.map((action) => (
                  <div
                    key={`${action.executionId}-${action.seq}`}
                    className="flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-mono text-kumo-default truncate">
                        {action.connector}.{action.method}
                      </div>
                      <div className="text-xs font-mono text-kumo-subtle truncate">
                        {JSON.stringify(action.args)}
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        onClick={() => approve(action)}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => reject(action)}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Surface>
          )}

          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Text size="sm" variant="secondary">
                Try one of these:
              </Text>
              <div className="flex flex-wrap justify-center gap-2 max-w-lg">
                {[
                  "List open pull requests for cloudflare/agents",
                  "Get repo metadata and latest releases for cloudflare/agents",
                  "Open an issue titled 'Docs typo' on cloudflare/agents"
                ].map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => setInput(prompt)}
                    className="px-3 py-1.5 text-xs rounded-full border border-kumo-line text-kumo-subtle hover:bg-kumo-elevated"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => {
              const isUser = message.role === "user";
              return (
                <div
                  key={message.id}
                  className={isUser ? "flex justify-end" : "space-y-2"}
                >
                  {message.parts?.map((part, i) => {
                    if (part.type === "text") {
                      return (
                        <Surface
                          key={`text-${i}`}
                          className={`rounded-2xl ${
                            isUser
                              ? "max-w-[80%] rounded-br-md bg-kumo-contrast"
                              : "rounded-bl-md ring ring-kumo-line"
                          }`}
                        >
                          <Streamdown
                            className={`sd-theme px-4 py-2.5 text-sm leading-relaxed ${
                              isUser ? "**:text-kumo-inverse" : ""
                            }`}
                            plugins={{ code }}
                            controls={false}
                            isAnimating={isStreaming && !isUser}
                          >
                            {part.text}
                          </Streamdown>
                        </Surface>
                      );
                    }
                    if (part.type === "reasoning") {
                      return (
                        <ReasoningBlock
                          key={`reasoning-${i}`}
                          text={part.text}
                          streaming={part.state === "streaming"}
                        />
                      );
                    }
                    if (isToolUIPart(part)) {
                      return (
                        <ToolCard
                          key={`tool-${i}`}
                          part={part as unknown as ToolPart}
                        />
                      );
                    }
                    return null;
                  })}
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>
      </main>

      <div className="border-t border-kumo-line p-4">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto flex gap-2">
          <input
            type="text"
            aria-label="Message input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about pull requests, repo metadata, or open an issue..."
            className="flex-1 px-4 py-2.5 text-sm rounded-xl border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!input.trim()}
            icon={<PaperPlaneRightIcon size={16} />}
          >
            Send
          </Button>
        </form>
      </div>

      <footer className="border-t border-kumo-line py-3">
        <div className="flex justify-center">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
