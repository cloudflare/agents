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
  ChatCircleDotsIcon,
  GlobeIcon,
  CaretDownIcon,
  BrainIcon
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
    title: "Create an AI chat agent",
    description:
      "Extend AIChatAgent to get built-in message history, streaming, and tool support. Override onChatMessage to handle incoming messages with any AI provider.",
    code: `import { AIChatAgent } from "@cloudflare/ai-chat";

class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish) {
    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      messages: this.messages,
      onFinish,
    });
    return result.toDataStreamResponse();
  }
}`
  },
  {
    title: "Connect with useAgentChat",
    description:
      "The useAgentChat hook gives you a complete chat interface — messages array, input handling, submit function, and streaming status. It manages the full lifecycle over WebSocket.",
    code: `import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

const agent = useAgent({ agent: "chat-agent", name: "my-chat" });

const { messages, input, setInput, handleSubmit, isLoading } =
  useAgentChat(agent, {
    onError: (err) => console.error(err),
  });`
  }
];

function ReasoningTrace({
  text,
  state
}: {
  text: string;
  state?: "streaming" | "done";
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-xl bg-purple-500/10 border border-purple-500/20 overflow-hidden">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer"
        >
          <BrainIcon size={14} className="text-purple-400" />
          <Text size="xs" bold>
            Reasoning
          </Text>
          {state === "streaming" && (
            <Text size="xs" variant="secondary">
              Thinking...
            </Text>
          )}
          {state === "done" && <Badge variant="secondary">Complete</Badge>}
          <CaretDownIcon
            size={12}
            className={`ml-auto text-kumo-secondary transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
        {expanded && (
          <div className="px-3 pb-3">
            <Streamdown
              className="sd-theme text-xs"
              controls={false}
              isAnimating={state === "streaming"}
            >
              {text}
            </Streamdown>
          </div>
        )}
      </div>
    </div>
  );
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

function ChatUI() {
  const userId = useUserId();
  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "connecting" | "disconnected"
  >("connecting");
  const [input, setInput] = useState("");
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "ChatAgent",
    name: `chat-demo-${userId}`,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(() => setConnectionStatus("disconnected"), [])
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
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

  return (
    <DemoWrapper
      title="AI Chat"
      description={
        <>
          Extend{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            AIChatAgent
          </code>{" "}
          to get a full chat backend with built-in message history, streaming,
          and tool support. On the client,{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            useAgentChat
          </code>{" "}
          gives you messages, input handling, and streaming status out of the
          box. Messages persist in the agent's Durable Object, so they survive
          page refreshes and reconnections. Try asking about the weather.
        </>
      }
      statusIndicator={<ConnectionStatus status={connectionStatus} />}
    >
      <div className="flex flex-col h-full max-w-3xl">
        {/* Messages area */}
        <div
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto mb-4 space-y-4"
        >
          {messages.length === 0 && (
            <Empty
              icon={<ChatCircleDotsIcon size={32} />}
              title="Start a conversation"
              description='Try "What is the weather in London?" or "What timezone am I in?"'
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
                      <ReasoningTrace
                        key={partIdx}
                        text={part.text}
                        state={part.state}
                      />
                    );
                  }

                  if (isToolUIPart(part)) {
                    const toolName = getToolName(part);

                    if (part.state === "output-available") {
                      return (
                        <div
                          key={part.toolCallId}
                          className="flex justify-start"
                        >
                          <Surface className="max-w-[80%] px-3 py-2 rounded-xl ring ring-kumo-line">
                            <div className="flex items-center gap-2 mb-1">
                              {toolName === "getUserTimezone" ? (
                                <GlobeIcon
                                  size={14}
                                  className="text-kumo-inactive"
                                />
                              ) : (
                                <GearIcon
                                  size={14}
                                  className="text-kumo-inactive"
                                />
                              )}
                              <Text size="xs" variant="secondary" bold>
                                {toolName}
                              </Text>
                              <Badge variant="secondary">Done</Badge>
                            </div>
                            <pre className="font-mono text-xs text-kumo-subtle overflow-x-auto">
                              {JSON.stringify(part.output, null, 2)}
                            </pre>
                          </Surface>
                        </div>
                      );
                    }

                    if (
                      part.state === "input-available" ||
                      part.state === "input-streaming"
                    ) {
                      return (
                        <div
                          key={part.toolCallId}
                          className="flex justify-start"
                        >
                          <Surface className="max-w-[80%] px-3 py-2 rounded-xl ring ring-kumo-line">
                            <div className="flex items-center gap-2">
                              <GearIcon
                                size={14}
                                className="text-kumo-inactive animate-spin"
                              />
                              <Text size="xs" variant="secondary">
                                Running {toolName}...
                              </Text>
                            </div>
                          </Surface>
                        </div>
                      );
                    }
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
                  isConnected ? "Ask me anything..." : "Connecting to agent..."
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

export function ChatDemo() {
  return (
    <Suspense
      fallback={
        <DemoWrapper
          title="AI Chat"
          description="Chat with an AI agent powered by Workers AI. Messages persist across reconnections."
        >
          <div className="flex items-center justify-center h-64 text-kumo-inactive">
            Loading chat...
          </div>
        </DemoWrapper>
      }
    >
      <ChatUI />
    </Suspense>
  );
}
