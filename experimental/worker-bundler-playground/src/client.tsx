import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, isReasoningUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  PlayIcon,
  CodeIcon,
  InfoIcon,
  RocketLaunchIcon,
  ArrowRightIcon,
  BrainIcon,
  WarningCircleIcon,
  CaretDownIcon
} from "@phosphor-icons/react";
import type { WorkerState } from "./server";

const STORAGE_KEY = "worker-bundler-playground-user-id";

function getUserId(): string {
  if (typeof window === "undefined") return "default";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

// ─── Request Tester Panel ──────────────────────────────────────────────────

function RequestTester({
  onTest,
  disabled
}: {
  onTest: (
    method: string,
    path: string,
    body?: string
  ) => Promise<{ status: number; body: string }>;
  disabled: boolean;
}) {
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/");
  const [body, setBody] = useState("");
  const [response, setResponse] = useState<{
    status: number;
    body: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTest = async () => {
    setLoading(true);
    setError(null);
    setResponse(null);
    try {
      const result = await onTest(
        method,
        path,
        method !== "GET" && method !== "HEAD" ? body : undefined
      );
      setResponse(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Surface className="rounded-xl ring ring-kumo-line p-4 space-y-3">
      <div className="flex items-center gap-2">
        <PlayIcon size={16} weight="bold" className="text-kumo-accent" />
        <Text size="sm" bold>
          Test Worker
        </Text>
      </div>

      <div className="flex gap-2">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="px-2 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default font-mono"
        >
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
        </select>
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/"
          className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive font-mono focus:outline-none focus:ring-1 focus:ring-kumo-accent"
        />
        <Button
          variant="primary"
          size="sm"
          icon={<ArrowRightIcon size={14} />}
          onClick={handleTest}
          disabled={disabled || loading}
        >
          {loading ? "..." : "Send"}
        </Button>
      </div>

      {method !== "GET" && method !== "HEAD" && (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder='{"key": "value"}'
          rows={3}
          className="w-full px-3 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive font-mono resize-none focus:outline-none focus:ring-1 focus:ring-kumo-accent"
        />
      )}

      {error && (
        <div className="px-3 py-2 rounded-lg bg-red-50 text-red-700 text-sm dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {response && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant={response.status < 400 ? "primary" : "destructive"}>
              {response.status}
            </Badge>
          </div>
          <pre className="px-3 py-2 rounded-lg bg-kumo-elevated text-kumo-default text-xs font-mono whitespace-pre-wrap overflow-auto max-h-48 border border-kumo-line">
            {response.body}
          </pre>
        </div>
      )}
    </Surface>
  );
}

// ─── Source Code Preview ───────────────────────────────────────────────────

function SourcePreview({ source }: { source: Record<string, string> }) {
  const keys = Object.keys(source);
  const keysKey = keys.join(",");
  const [activeFile, setActiveFile] = useState(keys[0]);

  // Reset active file when source files change
  useEffect(() => {
    if (!keys.includes(activeFile)) {
      setActiveFile(keys[0]);
    }
  }, [keysKey, activeFile, keys]);

  return (
    <Surface className="rounded-xl ring ring-kumo-line overflow-hidden">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-kumo-line overflow-x-auto">
        {Object.keys(source).map((path) => (
          <button
            key={path}
            onClick={() => setActiveFile(path)}
            className={[
              "px-2 py-1 text-xs font-mono rounded-md whitespace-nowrap transition-colors",
              activeFile === path
                ? "bg-kumo-accent text-white"
                : "text-kumo-subtle hover:bg-kumo-elevated"
            ].join(" ")}
          >
            {path}
          </button>
        ))}
      </div>
      <pre className="px-4 py-3 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-64 text-kumo-default leading-relaxed">
        {source[activeFile]}
      </pre>
    </Surface>
  );
}

// ─── Reasoning Trace ───────────────────────────────────────────────────────

function ReasoningTrace({
  text,
  isStreaming
}: {
  text: string;
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!text) return null;

  return (
    <div className="flex justify-start">
      <Surface className="max-w-[85%] rounded-xl ring ring-kumo-line overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-kumo-elevated/50 transition-colors"
        >
          <BrainIcon
            size={14}
            weight="fill"
            className={
              isStreaming ? "text-purple-500 animate-pulse" : "text-purple-400"
            }
          />
          <Text size="xs" variant="secondary" bold>
            {isStreaming ? "Thinking..." : "Reasoning"}
          </Text>
          <CaretDownIcon
            size={12}
            className={[
              "ml-auto text-kumo-inactive transition-transform",
              expanded ? "rotate-180" : ""
            ].join(" ")}
          />
        </button>
        {expanded && (
          <div className="px-3 pb-2">
            <pre className="text-xs font-mono text-kumo-subtle whitespace-pre-wrap leading-relaxed max-h-48 overflow-auto">
              {text}
            </pre>
          </div>
        )}
      </Surface>
    </div>
  );
}

// ─── Tool Call Part ────────────────────────────────────────────────────────

function ToolCallPart({
  part
}: {
  part: {
    toolCallId: string;
    state: string;
    input?: unknown;
    output?: unknown;
    errorText?: string;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const toolName = getToolName(part as Parameters<typeof getToolName>[0]);

  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";
  const isDone = part.state === "output-available";
  const isError = part.state === "output-error";

  const icon = isRunning ? (
    <GearIcon size={14} className="text-kumo-inactive animate-spin" />
  ) : isError ? (
    <WarningCircleIcon size={14} className="text-red-500" />
  ) : toolName === "generateWorker" ? (
    <CodeIcon size={14} className="text-kumo-accent" />
  ) : (
    <PlayIcon size={14} className="text-kumo-accent" />
  );

  const label = isRunning
    ? toolName === "generateWorker"
      ? "Building worker..."
      : "Sending request..."
    : isError
      ? `${toolName} failed`
      : toolName === "generateWorker"
        ? "Worker built"
        : "Request sent";

  return (
    <div className="flex justify-start">
      <Surface className="max-w-[85%] rounded-xl ring ring-kumo-line overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-kumo-elevated/50 transition-colors"
        >
          {icon}
          <Text size="xs" variant="secondary" bold>
            {label}
          </Text>
          {isDone && <Badge variant="primary">Done</Badge>}
          {isError && <Badge variant="destructive">Error</Badge>}
          <CaretDownIcon
            size={12}
            className={[
              "ml-auto text-kumo-inactive transition-transform",
              expanded ? "rotate-180" : ""
            ].join(" ")}
          />
        </button>
        {expanded && (
          <div className="px-3 pb-2 space-y-2">
            {part.input != null && (
              <div>
                <Text size="xs" variant="secondary" bold>
                  Input
                </Text>
                <pre className="mt-1 px-2 py-1.5 rounded bg-kumo-elevated text-xs font-mono whitespace-pre-wrap max-h-32 overflow-auto text-kumo-default">
                  {typeof part.input === "string"
                    ? part.input
                    : JSON.stringify(part.input, null, 2)}
                </pre>
              </div>
            )}
            {isDone && part.output != null && (
              <div>
                <Text size="xs" variant="secondary" bold>
                  Output
                </Text>
                <pre className="mt-1 px-2 py-1.5 rounded bg-kumo-elevated text-xs font-mono whitespace-pre-wrap max-h-32 overflow-auto text-kumo-default">
                  {typeof part.output === "string"
                    ? part.output
                    : JSON.stringify(part.output, null, 2)}
                </pre>
              </div>
            )}
            {isError && part.errorText && (
              <div className="px-2 py-1.5 rounded bg-red-50 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
                {part.errorText}
              </div>
            )}
          </div>
        )}
      </Surface>
    </div>
  );
}

// ─── Main Chat ─────────────────────────────────────────────────────────────

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [workerState, setWorkerState] = useState<WorkerState | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "WorkerPlayground",
    name: getUserId(),
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback((state: WorkerState) => {
      setWorkerState(state?.built ? state : null);
    }, [])
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  const handleManualTest = async (
    method: string,
    path: string,
    body?: string
  ): Promise<{ status: number; body: string }> => {
    const result = await agent.call("testWorker", [method, path, body]);
    return result as { status: number; body: string };
  };

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Worker Bundler Playground
            </h1>
            <Badge variant="secondary">
              <RocketLaunchIcon size={12} weight="bold" className="mr-1" />
              AI + Worker Bundler
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={() => {
                clearHistory();
                setWorkerState(null);
                agent.call("clearWorkspace", []);
              }}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      {/* Body: chat on left, preview on right */}
      <div className="flex-1 flex overflow-hidden">
        {/* Chat Panel */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-5 py-6 space-y-5">
              {messages.length === 0 && (
                <div className="space-y-4">
                  <Surface className="p-4 rounded-xl ring ring-kumo-line">
                    <div className="flex gap-3">
                      <InfoIcon
                        size={20}
                        weight="bold"
                        className="text-kumo-accent shrink-0 mt-0.5"
                      />
                      <div>
                        <Text size="sm" bold>
                          Worker Bundler Playground
                        </Text>
                        <span className="mt-1 block">
                          <Text size="xs" variant="secondary">
                            Describe a Worker and the AI will generate, bundle,
                            and load it. You can then test it with HTTP requests
                            right here.
                          </Text>
                        </span>
                      </div>
                    </div>
                  </Surface>
                  <Empty
                    icon={<CodeIcon size={32} />}
                    title="Describe your Worker"
                    description={
                      '"Build a Worker that returns a random joke as JSON" or ' +
                      '"Make an API with GET /hello/:name that returns a greeting"'
                    }
                  />
                </div>
              )}

              {messages.map((message) => {
                const isUser = message.role === "user";

                if (isUser) {
                  return (
                    <div key={message.id} className="flex justify-end">
                      <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                        {getMessageText(message)}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={message.id} className="space-y-2">
                    {message.parts.map((part, partIndex) => {
                      if (part.type === "text") {
                        if (!part.text) return null;
                        return (
                          <div key={partIndex} className="flex justify-start">
                            <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed whitespace-pre-wrap">
                              {part.text}
                            </div>
                          </div>
                        );
                      }

                      if (part.type === "step-start") {
                        return (
                          <div
                            key={`step-${partIndex}`}
                            className="border-t border-kumo-line/40 my-1"
                          />
                        );
                      }

                      if (isReasoningUIPart(part)) {
                        return (
                          <ReasoningTrace
                            key={partIndex}
                            text={part.text}
                            isStreaming={part.state === "streaming"}
                          />
                        );
                      }

                      if (!isToolUIPart(part)) return null;
                      return <ToolCallPart key={part.toolCallId} part={part} />;
                    })}
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
              className="max-w-2xl mx-auto px-5 py-4"
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
                  placeholder="Describe a Worker to build..."
                  disabled={!isConnected || isStreaming}
                  rows={2}
                  className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
                />
                {isStreaming ? (
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop streaming"
                    onClick={stop}
                    icon={<StopIcon size={18} weight="fill" />}
                    className="mb-0.5"
                  />
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    aria-label="Send message"
                    disabled={!input.trim() || !isConnected}
                    icon={<PaperPlaneRightIcon size={18} />}
                    className="mb-0.5"
                  />
                )}
              </div>
            </form>
            <div className="flex justify-center pb-3">
              <PoweredByAgents />
            </div>
          </div>
        </div>

        {/* Right Panel: Source + Tester */}
        <div className="w-[420px] shrink-0 border-l border-kumo-line bg-kumo-base overflow-y-auto p-4 space-y-4 hidden lg:block">
          {!workerState ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <CodeIcon size={48} className="text-kumo-inactive mb-4" />
              <Text size="sm" variant="secondary">
                Generated Worker code and test panel will appear here.
              </Text>
            </div>
          ) : (
            <>
              {/* Build Status */}
              <div className="flex items-center gap-2">
                <Badge variant="primary">
                  <RocketLaunchIcon size={12} className="mr-1" />
                  Built
                </Badge>
                <span className="text-xs font-mono text-kumo-subtle">
                  {workerState.mainModule}
                </span>
              </div>

              {workerState.warnings && workerState.warnings.length > 0 && (
                <div className="px-3 py-2 rounded-lg bg-yellow-50 text-yellow-700 text-xs dark:bg-yellow-950 dark:text-yellow-300">
                  {workerState.warnings.join("\n")}
                </div>
              )}

              {/* Source Preview */}
              {workerState.source && (
                <SourcePreview source={workerState.source} />
              )}

              {/* Request Tester */}
              <RequestTester
                onTest={handleManualTest}
                disabled={!workerState.built}
              />
            </>
          )}
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
