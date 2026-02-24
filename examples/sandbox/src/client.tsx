import {
  Suspense,
  useCallback,
  useState,
  useEffect,
  useRef,
  useMemo
} from "react";
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
  CodeIcon,
  PlayIcon,
  SidebarSimpleIcon,
  CircleIcon
} from "@phosphor-icons/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SandboxAddon } from "@cloudflare/sandbox/xterm";
import type { ConnectionState } from "@cloudflare/sandbox/xterm";

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
    case "run_in_terminal":
      return { icon: <PlayIcon size={14} />, label: "Terminal" };
    default:
      return { icon: <GearIcon size={14} />, label: toolName };
  }
}

// ─── Terminal Panel ──────────────────────────────────────────────────

interface TerminalPanelProps {
  agentName: string;
  writeToTerminalRef: React.MutableRefObject<((data: string) => void) | null>;
}

function TerminalPanel({ agentName, writeToTerminalRef }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sandboxAddonRef = useRef<SandboxAddon | null>(null);
  const [termState, setTermState] = useState<ConnectionState>("disconnected");

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
      theme: {
        background: "#1a1a2e",
        foreground: "#e0e0e0",
        cursor: "#f97316",
        selectionBackground: "#3b3b5c"
      }
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const sandboxAddon = new SandboxAddon({
      getWebSocketUrl: ({ origin }) => {
        const params = new URLSearchParams({ name: agentName });
        return `${origin}/ws/terminal?${params}`;
      },
      onStateChange: (state) => {
        setTermState(state);
      }
    });
    terminal.loadAddon(sandboxAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();

    // Connect to the sandbox terminal
    sandboxAddon.connect({ sandboxId: agentName });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    sandboxAddonRef.current = sandboxAddon;

    // Expose a write function so the chat can inject commands
    writeToTerminalRef.current = (data: string) => {
      // paste() triggers the onData event which the SandboxAddon forwards
      // to the PTY WebSocket. \r simulates pressing Enter.
      terminal.paste(data + "\r");
    };

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      writeToTerminalRef.current = null;
      resizeObserver.disconnect();
      sandboxAddon.disconnect();
      terminal.dispose();
    };
  }, [agentName, writeToTerminalRef]);

  const stateColor =
    termState === "connected"
      ? "text-green-500"
      : termState === "connecting"
        ? "text-yellow-500"
        : "text-kumo-inactive";

  return (
    <div className="flex flex-col h-full bg-[#1a1a2e] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-[#16162a] border-b border-[#2a2a4a]">
        <div className="flex items-center gap-2">
          <TerminalWindowIcon size={14} className="text-kumo-inactive" />
          <span className="text-xs font-medium text-kumo-inactive">
            Terminal
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <CircleIcon size={8} weight="fill" className={stateColor} />
          <span className="text-[10px] text-kumo-inactive">{termState}</span>
        </div>
      </div>
      <div ref={containerRef} className="flex-1 px-1 py-1" />
    </div>
  );
}

// ─── Chat Panel ──────────────────────────────────────────────────────

interface ChatPanelProps {
  writeToTerminal: (data: string) => void;
  onToggleTerminal: () => void;
  onAgentName: (name: string) => void;
}

function ChatPanel({
  writeToTerminal,
  onToggleTerminal,
  onAgentName
}: ChatPanelProps) {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Track which run_in_terminal tool calls have already been injected
  const injectedCommandsRef = useRef<Set<string>>(new Set());

  const agent = useAgent({
    agent: "ChatAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const agentName = useMemo(() => agent.name, [agent]);

  // Report agent name to parent so the terminal can connect to the same sandbox
  useEffect(() => {
    onAgentName(agentName);
  }, [agentName, onAgentName]);

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-inject run_in_terminal commands into the terminal
  useEffect(() => {
    for (const message of messages) {
      for (const part of message.parts) {
        if (!isToolUIPart(part)) continue;
        if (getToolName(part) !== "run_in_terminal") continue;
        if (part.state !== "output-available") continue;
        if ("preliminary" in part && part.preliminary) continue;
        if (injectedCommandsRef.current.has(part.toolCallId)) continue;

        const output = part.output as Record<string, unknown>;
        if (output?.runInTerminal && typeof output.command === "string") {
          injectedCommandsRef.current.add(part.toolCallId);
          writeToTerminal(output.command);
        }
      }
    }
  }, [messages, writeToTerminal]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="flex flex-col h-full bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-3 bg-kumo-base border-b border-kumo-line shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Sandbox Agent
            </h1>
            <Badge variant="secondary">
              <TerminalWindowIcon size={12} weight="bold" className="mr-1" />
              OpenCode
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="secondary"
              shape="square"
              icon={<SidebarSimpleIcon size={16} />}
              onClick={onToggleTerminal}
              aria-label="Toggle terminal"
            />
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
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<TerminalWindowIcon size={32} />}
              title="Sandbox Agent"
              description='Ask me to build something — "Create a React todo app" or "Clone a repo and summarize it". The sandbox spins up on demand and a live terminal appears alongside.'
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
                            <ToolOutput
                              output={output}
                              toolName={toolName}
                              writeToTerminal={writeToTerminal}
                            />
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
                                  : toolName === "run_in_terminal"
                                    ? "Running in terminal..."
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
      <div className="border-t border-kumo-line bg-kumo-base shrink-0">
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

// ─── Shared Sub-components ───────────────────────────────────────────

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
  toolName,
  writeToTerminal
}: {
  output: Record<string, unknown>;
  toolName: string;
  writeToTerminal: (data: string) => void;
}) {
  if (toolName === "run_in_terminal") {
    const command = (output.command as string) || "";
    return (
      <div className="flex items-center gap-2">
        <code className="font-mono text-xs text-kumo-secondary bg-kumo-elevated px-2 py-1 rounded flex-1 truncate">
          {command}
        </code>
        <Button
          variant="secondary"
          size="sm"
          icon={<PlayIcon size={12} />}
          onClick={() => writeToTerminal(command)}
        >
          Re-run
        </Button>
      </div>
    );
  }

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

// ─── App Shell ───────────────────────────────────────────────────────

function AppShell() {
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [agentName, setAgentName] = useState<string | null>(null);
  const writeToTerminalRef = useRef<((data: string) => void) | null>(null);

  const onAgentName = useCallback((name: string) => {
    setAgentName(name);
  }, []);

  const writeToTerminal = useCallback((data: string) => {
    writeToTerminalRef.current?.(data);
  }, []);

  return (
    <div className="flex h-screen w-screen">
      {/* Chat panel — takes remaining space */}
      <div
        className={`flex flex-col ${terminalOpen ? "w-1/2" : "w-full"} transition-all duration-200`}
      >
        <ChatPanel
          writeToTerminal={writeToTerminal}
          onToggleTerminal={() => setTerminalOpen((o) => !o)}
          onAgentName={onAgentName}
        />
      </div>

      {/* Terminal panel — right side */}
      {terminalOpen && agentName && (
        <div className="w-1/2 border-l border-kumo-line p-2 bg-kumo-elevated">
          <TerminalPanel
            agentName={agentName}
            writeToTerminalRef={writeToTerminalRef}
          />
        </div>
      )}
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
      <AppShell />
    </Suspense>
  );
}
