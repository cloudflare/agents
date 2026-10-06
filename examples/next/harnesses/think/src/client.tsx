import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "agents/chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text,
  PoweredByCloudflare
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  CheckCircleIcon,
  XCircleIcon,
  GearIcon,
  BrainIcon,
  InfoIcon,
  MoonIcon,
  SunIcon
} from "@phosphor-icons/react";
import "./styles.css";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const text =
    status === "connected"
      ? "text-kumo-success"
      : status === "connecting"
        ? "text-kumo-warning"
        : "text-kumo-danger";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";
  return (
    <output className="flex items-center gap-2">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`text-xs ${text}`}>{label}</span>
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

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

/** Text and reasoning parts use `state: streaming` with empty `text` until the first delta. */
function shouldShowStreamedTextPart(part: {
  text: string;
  state?: "streaming" | "done";
}): boolean {
  return part.text.length > 0 || part.state === "streaming";
}

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "ThinkAgent",
    name: "demo",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    isStreaming
  } = useAgentChat({
    agent,
    // getUserTimezone has no execute on the server, so the browser runs it.
    onToolCall: async ({ toolCall, addToolOutput }) => {
      if (toolCall.toolName === "getUserTimezone") {
        addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            localTime: new Date().toLocaleTimeString()
          }
        });
      }
    }
  });

  const isConnected = connectionStatus === "connected";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    try {
      await sendMessage({ role: "user", parts: [{ type: "text", text }] });
    } catch (error) {
      console.error("Failed to send message:", error);
    }
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrainIcon size={22} className="text-kumo-accent" weight="bold" />
            <h1 className="text-lg font-semibold text-kumo-default">
              Think harness
            </h1>
            <Badge variant="secondary">Experimental</Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  Think's agent loop on a plain Durable Object
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    ThinkHarness keeps the transcript in Sessions and runs every
                    tool call itself. getWeather runs on the server and is rerun
                    if an eviction cuts it short, sendNotification waits for
                    your approval, and getUserTimezone runs in this browser.
                    Refresh mid-answer and the stream resumes.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {messages.length === 0 && (
            <Empty
              icon={<BrainIcon size={32} />}
              title="Start a conversation"
              description='Try "What is the weather in Lisbon?", "What time zone am I in?" or "Notify Sam that lunch is ready".'
            />
          )}

          {messages.map((message, index) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;

            if (isUser) {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                    {getMessageText(message)}
                  </div>
                </div>
              );
            }

            // Assistant: render parts in order
            return (
              <div key={message.id} className="space-y-2">
                {message.parts.map((part, partIndex) => {
                  // Text
                  if (part.type === "text") {
                    if (!shouldShowStreamedTextPart(part)) return null;
                    const isLastTextPart = message.parts
                      .slice(partIndex + 1)
                      .every((p) => p.type !== "text");
                    return (
                      <div key={partIndex} className="flex justify-start">
                        <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                          <Streamdown
                            className="sd-theme min-h-[1.25em]"
                            plugins={{ code }}
                            controls={false}
                            isAnimating={
                              isLastAssistant && isLastTextPart && isStreaming
                            }
                          >
                            {part.text}
                          </Streamdown>
                        </div>
                      </div>
                    );
                  }

                  // Reasoning
                  if (part.type === "reasoning") {
                    if (!part.text) return null;
                    return (
                      <div key={partIndex} className="flex justify-start">
                        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line opacity-70">
                          <div className="flex items-center gap-2 mb-1">
                            <GearIcon
                              size={14}
                              className="text-kumo-inactive"
                            />
                            <Text size="xs" variant="secondary" bold>
                              Thinking
                            </Text>
                          </div>
                          <div className="whitespace-pre-wrap text-xs text-kumo-subtle italic">
                            {part.text}
                          </div>
                        </Surface>
                      </div>
                    );
                  }

                  // Tool invocations
                  if (!isToolUIPart(part)) return null;
                  const toolName = getToolName(part);
                  const toolInput = part.input as
                    | Record<string, unknown>
                    | undefined;
                  const toolOutput = (part as { output?: unknown }).output;
                  const errorText = (part as { errorText?: string }).errorText;
                  const hasCode =
                    toolInput != null &&
                    typeof toolInput === "object" &&
                    typeof toolInput.code === "string";

                  const isRunning =
                    part.state === "input-available" ||
                    part.state === "input-streaming";
                  const isDone = part.state === "output-available";
                  const isError = part.state === "output-error";
                  const isDenied = part.state === "output-denied";
                  const isApproval =
                    "approval" in part && part.state === "approval-requested";

                  // Tool needs approval
                  if (isApproval) {
                    const approvalId = (part.approval as { id?: string })?.id;
                    return (
                      <div key={part.toolCallId} className="flex justify-start">
                        <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning overflow-hidden">
                          <div className="flex items-center gap-2 mb-2">
                            <GearIcon size={14} className="text-kumo-warning" />
                            <Text size="sm" bold>
                              Approval needed: {toolName}
                            </Text>
                          </div>
                          {toolInput != null && (
                            <pre className="mb-3 p-2 rounded-lg bg-kumo-elevated text-xs font-mono text-kumo-subtle overflow-x-auto max-h-40 overflow-y-auto">
                              {hasCode
                                ? (toolInput.code as string)
                                : JSON.stringify(toolInput, null, 2)}
                            </pre>
                          )}
                          <div className="flex gap-2">
                            <Button
                              variant="primary"
                              size="sm"
                              icon={<CheckCircleIcon size={14} />}
                              onClick={() => {
                                if (approvalId) {
                                  addToolApprovalResponse({
                                    id: approvalId,
                                    approved: true
                                  });
                                }
                              }}
                            >
                              Approve
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<XCircleIcon size={14} />}
                              onClick={() => {
                                if (approvalId) {
                                  addToolApprovalResponse({
                                    id: approvalId,
                                    approved: false
                                  });
                                }
                              }}
                            >
                              Reject
                            </Button>
                          </div>
                        </Surface>
                      </div>
                    );
                  }

                  // All other tool states: running, done, error, denied, unknown
                  const statusBadge = isDone ? (
                    <Badge variant="secondary">Done</Badge>
                  ) : isError ? (
                    <Badge variant="destructive">Error</Badge>
                  ) : isDenied ? (
                    <Badge variant="secondary">Denied</Badge>
                  ) : isRunning ? null : (
                    <Badge variant="secondary">{part.state}</Badge>
                  );

                  const statusIcon =
                    isError || isDenied ? (
                      <XCircleIcon size={14} className="text-kumo-inactive" />
                    ) : isRunning ? (
                      <GearIcon
                        size={14}
                        className="text-kumo-inactive animate-spin"
                      />
                    ) : (
                      <GearIcon size={14} className="text-kumo-inactive" />
                    );

                  return (
                    <div key={part.toolCallId} className="flex justify-start">
                      <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line overflow-hidden">
                        <div className="flex items-center gap-2 mb-1">
                          {statusIcon}
                          <Text size="xs" variant="secondary" bold>
                            {isRunning ? `Running ${toolName}...` : toolName}
                          </Text>
                          {statusBadge}
                        </div>
                        {toolInput != null && (
                          <div className="mt-2">
                            <span className="text-[10px] uppercase tracking-wider text-kumo-inactive font-semibold">
                              Input
                            </span>
                            <pre className="mt-1 p-2 rounded-lg bg-kumo-elevated text-xs font-mono text-kumo-subtle overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
                              {hasCode
                                ? (toolInput.code as string)
                                : JSON.stringify(toolInput, null, 2)}
                            </pre>
                          </div>
                        )}
                        {errorText && (
                          <div className="mt-2">
                            <span className="text-[10px] uppercase tracking-wider text-red-400 font-semibold">
                              Error
                            </span>
                            <pre className="mt-1 p-2 rounded-lg bg-red-50 dark:bg-red-950/20 text-xs font-mono text-red-600 dark:text-red-400 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
                              {errorText}
                            </pre>
                          </div>
                        )}
                        {toolOutput != null && (
                          <div className="mt-2">
                            <span className="text-[10px] uppercase tracking-wider text-kumo-inactive font-semibold">
                              Output
                            </span>
                            <pre className="mt-1 p-2 rounded-lg bg-kumo-elevated text-xs font-mono text-kumo-subtle overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all">
                              {typeof toolOutput === "string"
                                ? toolOutput
                                : JSON.stringify(toolOutput, null, 2)}
                            </pre>
                          </div>
                        )}
                      </Surface>
                    </div>
                  );
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
          className="max-w-3xl mx-auto px-5 py-4"
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
              placeholder="Try: What is the weather in Lisbon?"
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
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </div>
    </div>
  );
}

function App() {
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

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
