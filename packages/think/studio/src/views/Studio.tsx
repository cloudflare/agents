import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat, getToolApproval } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName, type UIMessage } from "ai";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ChatCircleDotsIcon,
  GearIcon,
  PaperPlaneRightIcon,
  PlugsIcon,
  TrashIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { deriveWsTarget } from "../../../src/cli/target";
import type { StudioConnection } from "../types";
import { StatusPill, type ConnState } from "../components/StatusPill";
import { ThemeToggle } from "../components/ThemeToggle";
import { Inspector } from "./Inspector";

function MessageBubble({
  align,
  variant,
  children
}: {
  align: "left" | "right";
  variant: "user" | "assistant";
  children: ReactNode;
}) {
  const base = "max-w-[85%] rounded-2xl overflow-hidden";
  return (
    <div
      className={`flex ${align === "right" ? "justify-end" : "justify-start"}`}
    >
      {variant === "user" ? (
        <div
          className={`${base} rounded-br-md bg-kumo-contrast text-kumo-inverse`}
        >
          {children}
        </div>
      ) : (
        <Surface className={`${base} rounded-bl-md ring ring-kumo-line`}>
          {children}
        </Surface>
      )}
    </div>
  );
}

export function Studio({
  connection,
  onDisconnect
}: {
  connection: StudioConnection;
  onDisconnect: () => void;
}) {
  const target = useMemo(
    () =>
      deriveWsTarget({
        agent: connection.agent,
        canonicalAgent: connection.canonicalAgent,
        instance: connection.instance,
        url: connection.url,
        host: connection.host,
        protocol: connection.protocol,
        token: connection.token,
        routePrefix: connection.routePrefix
      }),
    [connection]
  );

  const [status, setStatus] = useState<ConnState>("connecting");
  const [identity, setIdentity] = useState<{
    name: string;
    agent: string;
  } | null>(null);
  const [agentState, setAgentState] = useState<unknown>(undefined);
  const [input, setInput] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: connection.agent,
    name: target.instance,
    basePath: target.basePath,
    host: target.host,
    protocol: target.protocol,
    query: target.query,
    onOpen: useCallback(() => setStatus("connected"), []),
    onClose: useCallback(() => setStatus("disconnected"), []),
    onError: useCallback(() => setStatus("disconnected"), []),
    onIdentity: useCallback(
      (name: string, ag: string) => setIdentity({ name, agent: ag }),
      []
    ),
    onStateUpdate: useCallback((s: unknown) => setAgentState(s), [])
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    status: chatStatus,
    isStreaming,
    isRecovering,
    addToolApprovalResponse
  } = useAgentChat({
    agent,
    // Studio is served from a different origin than the agent; skip the default
    // cross-origin `/get-messages` HTTP fetch and rely on the WS history
    // broadcast the agent sends on connect.
    getInitialMessages: useCallback(async (): Promise<UIMessage[]> => [], [])
  });

  const isConnected = status === "connected";
  const busy = isStreaming || isRecovering;

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || busy) return;
    // Send first, clear second: if `sendMessage` throws synchronously the
    // user's text isn't lost from the composer.
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    setInput("");
  }, [input, busy, sendMessage]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-kumo-line px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Text bold>Think Studio</Text>
          <Text size="xs" variant="secondary">
            {identity ? `${identity.agent}/${identity.name}` : target.basePath}
          </Text>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill status={status} />
          <ThemeToggle />
          <Button
            variant="secondary"
            size="sm"
            icon={<PlugsIcon size={14} />}
            onClick={onDisconnect}
          >
            Disconnect
          </Button>
        </div>
      </div>

      {/* Body: chat + inspector */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col p-4">
          <div
            ref={messagesRef}
            className="mb-4 flex-1 space-y-4 overflow-y-auto"
          >
            {messages.length === 0 ? (
              <Empty
                icon={<ChatCircleDotsIcon size={32} />}
                title="No messages yet"
                description="Send a message to drive a durable turn on this agent."
              />
            ) : null}

            {messages.map((message) => {
              const isUser = message.role === "user";
              return (
                <div key={message.id} className="space-y-2">
                  {message.parts.map((part, partIdx) => {
                    if (part.type === "text") {
                      if (!part.text || part.text.trim() === "") return null;
                      return (
                        <MessageBubble
                          key={partIdx}
                          align={isUser ? "right" : "left"}
                          variant={isUser ? "user" : "assistant"}
                        >
                          <Streamdown
                            className={`sd-theme px-4 py-2.5 text-sm leading-relaxed ${
                              isUser ? "**:text-kumo-inverse" : ""
                            }`}
                            plugins={{ code }}
                            controls={false}
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
                          <div className="max-w-[85%] rounded-xl border border-kumo-line bg-kumo-elevated px-3 py-2">
                            <Text size="xs" variant="secondary" bold>
                              Reasoning
                            </Text>
                            <div className="mt-1 whitespace-pre-wrap text-xs text-kumo-subtle">
                              {part.text}
                            </div>
                          </div>
                        </div>
                      );
                    }

                    if (!isToolUIPart(part)) return null;
                    const toolName = getToolName(part);

                    const toolInput = (part as { input?: unknown }).input;
                    const toolOutput = (part as { output?: unknown }).output;
                    const toolError = (part as { errorText?: string })
                      .errorText;

                    if (part.state === "approval-requested") {
                      const approvalId = getToolApproval(part)?.id;
                      return (
                        <div
                          key={part.toolCallId}
                          className="flex justify-start"
                        >
                          <Surface className="max-w-[85%] rounded-xl px-4 py-3 ring ring-kumo-warning">
                            <Text size="sm" bold>
                              Approval needed: {toolName}
                            </Text>
                            <pre className="mt-1 mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-kumo-elevated p-2 font-mono text-xs text-kumo-subtle">
                              {JSON.stringify(toolInput, null, 2)}
                            </pre>
                            <div className="flex gap-2">
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={!approvalId}
                                onClick={() =>
                                  approvalId &&
                                  addToolApprovalResponse({
                                    id: approvalId,
                                    approved: true
                                  })
                                }
                              >
                                Approve
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={!approvalId}
                                onClick={() =>
                                  approvalId &&
                                  addToolApprovalResponse({
                                    id: approvalId,
                                    approved: false
                                  })
                                }
                              >
                                Reject
                              </Button>
                            </div>
                          </Surface>
                        </div>
                      );
                    }

                    return (
                      <div key={part.toolCallId} className="flex justify-start">
                        <Surface className="max-w-[85%] rounded-xl px-3 py-2 ring ring-kumo-line">
                          <div className="mb-1 flex items-center gap-2">
                            <GearIcon
                              size={14}
                              className="text-kumo-inactive"
                            />
                            <Text size="xs" variant="secondary" bold>
                              {toolName}
                            </Text>
                            <ToolStateBadge state={part.state} />
                          </div>
                          <pre
                            className={`overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs ${
                              part.state === "output-error"
                                ? "text-kumo-danger"
                                : "text-kumo-subtle"
                            }`}
                          >
                            {part.state === "output-error"
                              ? (toolError ?? "Tool failed")
                              : JSON.stringify(
                                  part.state === "output-available"
                                    ? toolOutput
                                    : toolInput,
                                  null,
                                  2
                                )}
                          </pre>
                        </Surface>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Input */}
          <div className="border-t border-kumo-line pt-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3">
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
                    isConnected ? "Send a message…" : "Connecting to agent…"
                  }
                  disabled={!isConnected || busy}
                  rows={2}
                  className="flex-1 bg-transparent! shadow-none! outline-none! ring-0! focus:ring-0!"
                  aria-label="Message"
                />
                <div className="mb-0.5 flex items-center gap-2">
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
                    disabled={!input.trim() || !isConnected || busy}
                    icon={<PaperPlaneRightIcon size={18} />}
                    loading={busy}
                  />
                </div>
              </div>
            </form>
          </div>
        </div>

        {/* Inspector */}
        <div className="w-80 shrink-0 border-l border-kumo-line">
          <Inspector
            status={status}
            identity={identity}
            endpoint={target}
            state={agentState}
            messageCount={messages.length}
            isStreaming={isStreaming}
            isRecovering={isRecovering}
            chatStatus={chatStatus}
          />
        </div>
      </div>
    </div>
  );
}

function ToolStateBadge({ state }: { state: string }) {
  if (state === "output-available")
    return <Badge variant="success">Done</Badge>;
  if (state === "output-error")
    return <Badge variant="destructive">Error</Badge>;
  if (state === "output-denied")
    return <Badge variant="secondary">Denied</Badge>;
  return <Badge variant="info">Running</Badge>;
}
