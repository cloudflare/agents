import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
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
  TrashIcon,
  GearIcon,
  TerminalWindowIcon,
  CodeIcon
} from "@phosphor-icons/react";

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

/** Pick an icon and label for each tool */
function toolDisplay(toolName: string) {
  switch (toolName) {
    case "code":
      return { icon: <CodeIcon size={14} />, label: "OpenCode" };
    case "exec":
      return { icon: <TerminalWindowIcon size={14} />, label: "Shell" };
    default:
      return { icon: <GearIcon size={14} />, label: toolName };
  }
}

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "ChatAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
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

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Sandbox Agent
            </h1>
            <Badge variant="secondary">
              <TerminalWindowIcon size={12} weight="bold" className="mr-1" />
              OpenCode
            </Badge>
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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<TerminalWindowIcon size={32} />}
              title="Sandbox Agent"
              description='Ask me to build something — "Create a React todo app" or "Clone a repo and summarize it". The sandbox spins up on demand.'
            />
          )}

          {messages.map((message, index) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;

            return (
              <div key={message.id} className="space-y-2">
                {/* Text content */}
                {isUser ? (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                      {getMessageText(message)}
                    </div>
                  </div>
                ) : (
                  getMessageText(message) && (
                    <div className="flex justify-start">
                      <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                        <div className="whitespace-pre-wrap">
                          {getMessageText(message)}
                          {isLastAssistant && isStreaming && (
                            <span className="inline-block w-0.5 h-[1em] bg-kumo-brand ml-0.5 align-text-bottom animate-blink-cursor" />
                          )}
                        </div>
                      </div>
                    </div>
                  )
                )}

                {/* Tool parts */}
                {message.parts
                  .filter((part) => isToolUIPart(part))
                  .map((part) => {
                    if (!isToolUIPart(part)) return null;
                    const toolName = getToolName(part);
                    const { icon, label } = toolDisplay(toolName);

                    // Tool completed (final result, not preliminary)
                    if (
                      part.state === "output-available" &&
                      !("preliminary" in part && part.preliminary)
                    ) {
                      const output = part.output as Record<string, unknown>;
                      const success = output?.success !== false;

                      return (
                        <div
                          key={part.toolCallId}
                          className="flex justify-start"
                        >
                          <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-kumo-inactive">{icon}</span>
                              <Text size="xs" variant="secondary" bold>
                                {label}
                              </Text>
                              <Badge
                                variant={success ? "secondary" : "destructive"}
                              >
                                {success ? "Done" : "Error"}
                              </Badge>
                            </div>
                            <ToolOutput output={output} toolName={toolName} />
                          </Surface>
                        </div>
                      );
                    }

                    // Preliminary result — show spinner + live event log
                    if (
                      part.state === "output-available" &&
                      "preliminary" in part &&
                      part.preliminary
                    ) {
                      const output = part.output as Record<string, unknown>;
                      const events = (output?.events ?? []) as string[];
                      const status = (output?.status as string) ?? "coding";

                      return (
                        <div
                          key={part.toolCallId}
                          className="flex justify-start"
                        >
                          <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-kumo-inactive animate-spin">
                                {icon}
                              </span>
                              <Text size="xs" variant="secondary">
                                {status === "starting"
                                  ? "Starting sandbox..."
                                  : "Coding in sandbox..."}
                              </Text>
                            </div>
                            {events.length > 0 && <EventLog events={events} />}
                          </Surface>
                        </div>
                      );
                    }

                    // Tool executing (no output yet)
                    if (
                      part.state === "input-available" ||
                      part.state === "input-streaming"
                    ) {
                      return (
                        <div
                          key={part.toolCallId}
                          className="flex justify-start"
                        >
                          <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                            <div className="flex items-center gap-2">
                              <span className="text-kumo-inactive animate-spin">
                                {icon}
                              </span>
                              <Text size="xs" variant="secondary">
                                {toolName === "code"
                                  ? "Coding in sandbox..."
                                  : "Running command..."}
                              </Text>
                            </div>
                          </Surface>
                        </div>
                      );
                    }

                    return null;
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
              placeholder='Try: "Build a simple todo app" or "Clone https://github.com/... and explain it"'
              disabled={!isConnected || isStreaming}
              rows={2}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
            />
            <Button
              type="submit"
              variant="primary"
              shape="square"
              aria-label="Send message"
              disabled={!input.trim() || !isConnected || isStreaming}
              icon={<PaperPlaneRightIcon size={18} />}
              loading={isStreaming}
              className="mb-0.5"
            />
          </div>
        </form>
        <div className="flex justify-center pb-3">
          <PoweredByAgents />
        </div>
      </div>
    </div>
  );
}

/** Scrollable live event log shown during preliminary tool results */
function EventLog({ events }: { events: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  return (
    <div
      ref={scrollRef}
      className="mt-1 max-h-32 overflow-y-auto rounded bg-kumo-elevated border border-kumo-fill"
    >
      {events.map((event, i) => (
        <div
          key={i}
          className="px-2 py-0.5 font-mono text-[11px] text-kumo-inactive border-b border-kumo-fill last:border-0 truncate"
        >
          {event}
        </div>
      ))}
    </div>
  );
}

/** Renders tool output based on the tool type */
function ToolOutput({
  output,
  toolName
}: {
  output: Record<string, unknown>;
  toolName: string;
}) {
  if (toolName === "exec") {
    const stdout = (output.stdout as string) || "";
    const stderr = (output.stderr as string) || "";
    const display = stdout || stderr || "(no output)";
    return (
      <pre className="font-mono text-xs text-kumo-secondary whitespace-pre-wrap max-h-64 overflow-y-auto">
        {display}
      </pre>
    );
  }

  if (toolName === "code") {
    const response = (output.response as string) || "";
    const error = (output.error as string) || "";
    return (
      <div className="text-xs text-kumo-secondary whitespace-pre-wrap max-h-64 overflow-y-auto">
        {response || error || "(no output)"}
      </div>
    );
  }

  // Fallback: show raw JSON
  return (
    <pre className="font-mono text-xs text-kumo-secondary whitespace-pre-wrap max-h-64 overflow-y-auto">
      {JSON.stringify(output, null, 2)}
    </pre>
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
