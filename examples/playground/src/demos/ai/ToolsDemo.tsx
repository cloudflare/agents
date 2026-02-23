import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import {
  Button,
  Surface,
  Text,
  InputArea,
  Empty,
  Badge
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  TrashIcon,
  GearIcon,
  WrenchIcon,
  GlobeIcon,
  MonitorIcon,
  CheckCircleIcon,
  XCircleIcon,
  LightningIcon,
  ShieldCheckIcon,
  BrowserIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { DemoWrapper } from "../../layout";
import {
  ConnectionStatus,
  CodeExplanation,
  type CodeSection
} from "../../components";
import { useUserId } from "../../hooks";

const codeSections: CodeSection[] = [
  {
    title: "Define tools for the AI to call",
    description:
      "Use the AI SDK's tool() function to define tools with Zod schemas. Tools can run server-side (in the agent) or client-side (in the browser) via executions.",
    code: `import { tool } from "ai";
import { z } from "zod";

const tools = {
  getWeather: tool({
    description: "Get the current weather for a location",
    parameters: z.object({
      city: z.string().describe("City name"),
    }),
    execute: async ({ city }) => {
      return { temperature: 72, condition: "sunny", city };
    },
  }),
};`
  },
  {
    title: "Client-side tool execution",
    description:
      "Some tools need to run in the browser — accessing the DOM, camera, or user interactions. Mark them with executions and handle them on the client with useAgentChat.",
    code: `const { messages, addToolResult } = useAgentChat(agent, {
  // Handle tool calls that need client-side execution
  onToolCall: async ({ toolCall }) => {
    if (toolCall.toolName === "getUserLocation") {
      const position = await navigator.geolocation.getCurrentPosition();
      return { lat: position.coords.latitude, lng: position.coords.longitude };
    }
  },
});`
  }
];

const TOOL_META: Record<
  string,
  { icon: ReactNode; label: string; type: string }
> = {
  getWeather: {
    icon: <GlobeIcon size={14} />,
    label: "getWeather",
    type: "Server"
  },
  rollDice: {
    icon: <LightningIcon size={14} />,
    label: "rollDice",
    type: "Server"
  },
  getUserTimezone: {
    icon: <BrowserIcon size={14} />,
    label: "getUserTimezone",
    type: "Client"
  },
  getScreenSize: {
    icon: <MonitorIcon size={14} />,
    label: "getScreenSize",
    type: "Client"
  },
  calculate: {
    icon: <ShieldCheckIcon size={14} />,
    label: "calculate",
    type: "Approval"
  },
  deleteFile: {
    icon: <ShieldCheckIcon size={14} />,
    label: "deleteFile",
    type: "Approval"
  }
};

function typeBadgeVariant(
  type: string
): "secondary" | "primary" | "destructive" {
  if (type === "Server") return "secondary";
  if (type === "Client") return "primary";
  return "destructive";
}

function MessageBubble({
  align,
  variant,
  children
}: {
  align: "left" | "right";
  variant: "user" | "assistant";
  children: ReactNode;
}) {
  const base = "max-w-[80%] rounded-2xl overflow-hidden";
  const userStyle = `${base} rounded-br-md bg-kumo-contrast text-kumo-inverse`;
  const assistantStyle = `${base} rounded-bl-md ring ring-kumo-line`;

  return (
    <div
      className={`flex ${align === "right" ? "justify-end" : "justify-start"}`}
    >
      {variant === "user" ? (
        <div className={userStyle}>{children}</div>
      ) : (
        <Surface className={assistantStyle}>{children}</Surface>
      )}
    </div>
  );
}

function ToolCard({
  toolName,
  state,
  input: toolInput,
  output,
  approvalId,
  onApprove,
  onReject
}: {
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  approvalId?: string;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
}) {
  const meta = TOOL_META[toolName] ?? {
    icon: <GearIcon size={14} />,
    label: toolName,
    type: "Unknown"
  };

  const isApproval = state === "approval-requested";
  const isDone = state === "output-available";
  const isDenied = state === "output-denied";
  const isError = state === "output-error";
  const isRunning = state === "input-available" || state === "input-streaming";

  return (
    <div className="flex justify-start">
      <Surface
        className={`max-w-[80%] px-3 py-2.5 rounded-xl ring ${
          isApproval ? "ring-2 ring-kumo-warning" : "ring-kumo-line"
        }`}
      >
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-kumo-inactive">{meta.icon}</span>
          <Text size="xs" bold>
            {meta.label}
          </Text>
          <Badge variant={typeBadgeVariant(meta.type)}>{meta.type}</Badge>
          {isDone && (
            <Badge variant="secondary">
              <CheckCircleIcon size={10} className="mr-0.5" />
              Done
            </Badge>
          )}
          {isRunning && (
            <Badge variant="secondary">
              <GearIcon size={10} className="mr-0.5 animate-spin" />
              Running
            </Badge>
          )}
          {isApproval && <Badge variant="destructive">Needs Approval</Badge>}
          {isDenied && (
            <Badge variant="secondary">
              <XCircleIcon size={10} className="mr-0.5" />
              Denied
            </Badge>
          )}
          {isError && (
            <Badge variant="secondary">
              <XCircleIcon size={10} className="mr-0.5" />
              Error
            </Badge>
          )}
        </div>

        {toolInput != null && (
          <pre className="font-mono text-xs text-kumo-subtle overflow-x-auto mb-1.5 bg-kumo-elevated rounded p-2">
            {JSON.stringify(toolInput, null, 2)}
          </pre>
        )}

        {isDone && output != null && (
          <pre className="font-mono text-xs text-kumo-subtle overflow-x-auto bg-green-500/5 rounded p-2 border border-green-500/20">
            {JSON.stringify(output, null, 2)}
          </pre>
        )}

        {isApproval && approvalId && onApprove && onReject && (
          <div className="flex gap-2 mt-2">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircleIcon size={14} />}
              onClick={() => onApprove(approvalId)}
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<XCircleIcon size={14} />}
              onClick={() => onReject(approvalId)}
            >
              Reject
            </Button>
          </div>
        )}
      </Surface>
    </div>
  );
}

function ToolsUI() {
  const userId = useUserId();
  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "connecting" | "disconnected"
  >("connecting");
  const [input, setInput] = useState("");
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "ToolsAgent",
    name: `tools-demo-${userId}`,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(() => setConnectionStatus("disconnected"), [])
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    status
  } = useAgentChat({
    agent,
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
      if (toolCall.toolName === "getScreenSize") {
        addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: {
            width: window.innerWidth,
            height: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio
          }
        });
      }
    }
  });

  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  const handleApprove = useCallback(
    (id: string) => addToolApprovalResponse({ id, approved: true }),
    [addToolApprovalResponse]
  );

  const handleReject = useCallback(
    (id: string) => addToolApprovalResponse({ id, approved: false }),
    [addToolApprovalResponse]
  );

  return (
    <DemoWrapper
      title="Tools"
      description={
        <>
          AI agents can use tools — functions the model calls during a
          conversation. Tools can run server-side (inside the agent),
          client-side (in the browser, e.g. geolocation), or require human
          approval before executing. Define them with Zod schemas for type-safe
          argument validation.
        </>
      }
      statusIndicator={<ConnectionStatus status={connectionStatus} />}
    >
      <div className="flex flex-col h-full max-w-3xl">
        {/* Tool legend */}
        <div className="flex flex-wrap gap-3 mb-4 px-1">
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary">Server</Badge>
            <Text size="xs" variant="secondary">
              Auto-executed on server
            </Text>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="primary">Client</Badge>
            <Text size="xs" variant="secondary">
              Runs in your browser
            </Text>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="destructive">Approval</Badge>
            <Text size="xs" variant="secondary">
              Needs your confirmation
            </Text>
          </div>
        </div>

        {/* Messages area */}
        <div
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto mb-4 space-y-4"
        >
          {messages.length === 0 && (
            <Empty
              icon={<WrenchIcon size={32} />}
              title="Try the tools"
              description={
                'Try "What\'s the weather in Tokyo?", "Roll 3d20", ' +
                '"What timezone am I in?", "What\'s my screen size?", ' +
                '"What is 42 * 38?", "What is 5000 + 3000?", or "Delete /tmp/old.log"'
              }
            />
          )}

          {messages.map((message, index) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;

            return (
              <div key={message.id} className="space-y-2">
                {message.parts.map((part, partIdx) => {
                  if (part.type === "text") {
                    if (!part.text || part.text.trim() === "") return null;

                    if (isUser) {
                      return (
                        <MessageBubble
                          key={partIdx}
                          align="right"
                          variant="user"
                        >
                          <Streamdown
                            className="sd-theme px-4 py-2.5 text-sm leading-relaxed **:text-kumo-inverse"
                            controls={false}
                          >
                            {part.text}
                          </Streamdown>
                        </MessageBubble>
                      );
                    }

                    return (
                      <MessageBubble
                        key={partIdx}
                        align="left"
                        variant="assistant"
                      >
                        <Streamdown
                          className="sd-theme px-4 py-2.5 text-sm leading-relaxed"
                          controls={false}
                          isAnimating={isLastAssistant && isStreaming}
                        >
                          {part.text}
                        </Streamdown>
                      </MessageBubble>
                    );
                  }

                  if (part.type === "reasoning") {
                    if (!part.text || part.text.trim() === "") return null;
                    return (
                      <div key={partIdx} className="flex justify-start">
                        <Surface className="max-w-[80%] px-3 py-2 rounded-xl bg-purple-500/10 border border-purple-500/20">
                          <Text size="xs" variant="secondary">
                            <em>Thinking: {part.text}</em>
                          </Text>
                        </Surface>
                      </div>
                    );
                  }

                  if (isToolUIPart(part)) {
                    const toolName = getToolName(part);
                    const approvalId =
                      "approval" in part
                        ? (part.approval as { id?: string })?.id
                        : undefined;

                    return (
                      <ToolCard
                        key={part.toolCallId}
                        toolName={toolName}
                        state={part.state}
                        input={part.input}
                        output={
                          part.state === "output-available"
                            ? part.output
                            : undefined
                        }
                        approvalId={approvalId}
                        onApprove={handleApprove}
                        onReject={handleReject}
                      />
                    );
                  }

                  return null;
                })}
              </div>
            );
          })}

          <div />
        </div>

        {/* Input area */}
        <div className="border-t border-kumo-line pt-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
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
                placeholder={
                  isConnected
                    ? 'Try "What\'s the weather in Tokyo?" or "What is 5000 + 3000?"'
                    : "Connecting to agent..."
                }
                disabled={!isConnected || isStreaming}
                rows={2}
                className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none!"
              />
              <div className="flex items-center gap-2 mb-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  shape="square"
                  size="sm"
                  aria-label="Clear history"
                  onClick={clearHistory}
                  disabled={messages.length === 0}
                  icon={<TrashIcon size={16} />}
                />
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Send message"
                  disabled={!input.trim() || !isConnected || isStreaming}
                  icon={<PaperPlaneRightIcon size={18} />}
                  loading={isStreaming}
                />
              </div>
            </div>
          </form>
        </div>
      </div>
      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}

export function ToolsDemo() {
  return (
    <Suspense
      fallback={
        <DemoWrapper
          title="Tools"
          description="Server-side, client-side, and approval-required tools in action."
        >
          <div className="flex items-center justify-center h-64 text-kumo-inactive">
            Loading tools demo...
          </div>
        </DemoWrapper>
      }
    >
      <ToolsUI />
    </Suspense>
  );
}
