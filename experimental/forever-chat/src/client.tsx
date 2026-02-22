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
  CheckCircleIcon,
  XCircleIcon,
  GearIcon,
  InfinityIcon
} from "@phosphor-icons/react";

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "ForeverChatAgent",
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
    status
  } = useAgentChat({
    agent,
    body: { clientVersion: "1.0.0" },
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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({
      role: "user",
      parts: [{ type: "text", text }]
    });
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="flex h-screen flex-col bg-kumo-elevated">
      {/* Header */}
      <header className="border-b border-kumo-line bg-kumo-base px-5 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Forever Chat
            </h1>
            <Badge variant="primary">
              <InfinityIcon size={12} weight="bold" className="mr-1" />
              Durable Streaming
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
        <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
          {messages.length === 0 && (
            <Empty
              icon={<InfinityIcon size={32} />}
              title="Durable AI Chat"
              description="This chat uses keepAlive — the DO stays alive during streaming, preventing idle eviction during long LLM responses."
            />
          )}

          {messages.map((message, index) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;

            return (
              <div key={message.id} className="space-y-2">
                {isUser ? (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 leading-relaxed text-kumo-inverse">
                      {getMessageText(message)}
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base px-4 py-2.5 leading-relaxed text-kumo-default">
                      <div className="whitespace-pre-wrap">
                        {getMessageText(message)}
                        {isLastAssistant && isStreaming && (
                          <span className="ml-0.5 inline-block h-[1em] w-0.5 animate-blink-cursor bg-kumo-brand align-text-bottom" />
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {message.parts
                  .filter((part) => isToolUIPart(part))
                  .map((part) => {
                    if (!isToolUIPart(part)) return null;
                    const toolName = getToolName(part);

                    if (part.state === "output-available") {
                      return (
                        <div
                          key={part.toolCallId}
                          className="flex justify-start"
                        >
                          <Surface className="max-w-[85%] rounded-xl px-4 py-2.5 ring ring-kumo-line">
                            <div className="mb-1 flex items-center gap-2">
                              <GearIcon
                                size={14}
                                className="text-kumo-inactive"
                              />
                              <Text size="xs" variant="secondary" bold>
                                {toolName}
                              </Text>
                              <Badge variant="secondary">Done</Badge>
                            </div>
                            <div className="font-mono">
                              <Text size="xs" variant="secondary">
                                {JSON.stringify(part.output, null, 2)}
                              </Text>
                            </div>
                          </Surface>
                        </div>
                      );
                    }

                    if (
                      "approval" in part &&
                      part.state === "approval-requested"
                    ) {
                      const approvalId = (part.approval as { id?: string })?.id;
                      return (
                        <div
                          key={part.toolCallId}
                          className="flex justify-start"
                        >
                          <Surface className="max-w-[85%] rounded-xl px-4 py-3 ring-2 ring-kumo-warning">
                            <div className="mb-2 flex items-center gap-2">
                              <GearIcon
                                size={14}
                                className="text-kumo-warning"
                              />
                              <Text size="sm" bold>
                                Approval needed: {toolName}
                              </Text>
                            </div>
                            <div className="mb-3 font-mono">
                              <Text size="xs" variant="secondary">
                                {JSON.stringify(part.input, null, 2)}
                              </Text>
                            </div>
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

                    if (
                      part.state === "input-available" ||
                      part.state === "input-streaming"
                    ) {
                      return (
                        <div
                          key={part.toolCallId}
                          className="flex justify-start"
                        >
                          <Surface className="max-w-[85%] rounded-xl px-4 py-2.5 ring ring-kumo-line">
                            <div className="flex items-center gap-2">
                              <GearIcon
                                size={14}
                                className="animate-spin text-kumo-inactive"
                              />
                              <Text size="xs" variant="secondary">
                                Running {toolName}...
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
          className="mx-auto max-w-3xl px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
            <InputArea
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Try: What's the weather in Paris?"
              disabled={!isConnected || isStreaming}
              rows={2}
              className="flex-1 !bg-transparent !shadow-none !outline-none !ring-0 focus:!ring-0"
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

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
