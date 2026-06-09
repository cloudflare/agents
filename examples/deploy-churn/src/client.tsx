import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  StopIcon,
  SunIcon
} from "@phosphor-icons/react";
import "./styles.css";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

type TurnRecord = {
  at: number;
  requestId: string;
  continuation: boolean;
  status: "completed" | "error" | "aborted";
  error?: string;
  textLength: number;
};

type ChatErrorRecord = {
  at: number;
  requestId?: string;
  stage: string;
  name: string;
  message: string;
};

type IncidentRecord = {
  incidentId: string;
  attempt: number;
  maxAttempts: number;
  status: string;
  recoveryKind: string;
  reason?: string;
};

type AgentStatus = {
  name: string;
  messageCount: number;
  assistantMessages: number;
  turns: TurnRecord[];
  chatErrors: ChatErrorRecord[];
  agentErrors: Array<{ at: number; name: string; message: string }>;
  recoveryContexts: unknown[];
  incidents: IncidentRecord[];
  exhausted: unknown;
  hasFiberRows: boolean;
};

const SESSION_NAME = "default";

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

function statusBadge(status: string) {
  if (status === "finished" || status === "completed")
    return <Badge variant="primary">{status}</Badge>;
  if (
    status === "exhausted" ||
    status === "failed" ||
    status === "error" ||
    status === "aborted"
  )
    return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("stream a response for 90 seconds");
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "DeployChurnAgent",
    name: SESSION_NAME,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const { messages, sendMessage, isStreaming, isRecovering, stop } =
    useAgentChat({ agent });

  // Poll the agent's recovery view so we can watch incidents/turns evolve while
  // deploys churn underneath. Cheap RPC; harness-only.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = (await agent.call("getStatus")) as AgentStatus;
        if (!cancelled) setStatus(next);
      } catch {
        // Connection is bouncing during a deploy; ignore and retry.
      }
    };
    void tick();
    const interval = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [agent]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  const isConnected = connectionStatus === "connected";
  const turns = status?.turns ?? [];
  const incidents = status?.incidents ?? [];
  const chatErrors = status?.chatErrors ?? [];

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Deploy Churn
            </h1>
            <Badge variant="secondary">
              <ArrowsClockwiseIcon size={12} weight="bold" className="mr-1" />
              Recovery harness
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-5 py-6 grid gap-5 lg:grid-cols-[1fr_22rem]">
          <div className="space-y-5">
            <Surface className="p-4 rounded-xl ring ring-kumo-line">
              <div className="flex gap-3">
                <InfoIcon
                  size={20}
                  weight="bold"
                  className="text-kumo-accent shrink-0 mt-0.5"
                />
                <div>
                  <Text size="sm" bold>
                    What this shows
                  </Text>
                  <span className="mt-1 block">
                    <Text size="xs" variant="secondary">
                      Start a long turn (the assistant streams one token per
                      second). Then run <code>npm run deploy</code> in another
                      terminal — or <code>npm run churn</code> to script it — so
                      a real script-version change resets the Durable Object
                      mid-turn. Watch whether durable chat recovery continues
                      the turn or burns its attempt budget and gives up.
                    </Text>
                  </span>
                </div>
              </div>
            </Surface>

            <div className="space-y-2">
              {messages.length === 0 && (
                <Empty
                  icon={<ArrowsClockwiseIcon size={32} />}
                  title="No turn yet"
                  description="Send a message to start a long, interruptible streaming turn."
                />
              )}
              {messages.map((message) => {
                const isUser = message.role === "user";
                return (
                  <div
                    key={message.id}
                    className={
                      isUser ? "flex justify-end" : "flex justify-start"
                    }
                  >
                    <div
                      className={
                        isUser
                          ? "max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed"
                          : "max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed whitespace-pre-wrap break-words"
                      }
                    >
                      {getMessageText(message)}
                      {!isUser && isStreaming && (
                        <span className="inline-block w-0.5 h-[1em] bg-kumo-brand ml-0.5 align-text-bottom animate-blink-cursor" />
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Recovery panel */}
          <div className="space-y-4">
            <Surface className="p-4 rounded-xl ring ring-kumo-line space-y-3">
              <Text size="sm" bold>
                Recovery state
              </Text>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <Stat label="Turns" value={turns.length} />
                <Stat
                  label="Recoveries"
                  value={status?.recoveryContexts?.length ?? 0}
                />
                <Stat
                  label="Assistant msgs"
                  value={status?.assistantMessages ?? 0}
                />
                <Stat
                  label="Fiber rows"
                  value={status?.hasFiberRows ? "yes" : "no"}
                  danger={status?.hasFiberRows}
                />
              </div>
              {status?.exhausted ? (
                <div className="rounded-lg bg-red-50 dark:bg-red-950/20 p-2">
                  <Text size="xs" variant="secondary">
                    Recovery exhausted — the interrupted turn was abandoned and
                    will not retry until a new message.
                  </Text>
                </div>
              ) : null}
            </Surface>

            <Surface className="p-4 rounded-xl ring ring-kumo-line space-y-2">
              <Text size="sm" bold>
                Turns
              </Text>
              {turns.length === 0 ? (
                <Text size="xs" variant="secondary">
                  None yet.
                </Text>
              ) : (
                turns.map((t) => (
                  <div
                    key={`${t.requestId}-${t.at}`}
                    className="flex items-center justify-between gap-2 border-b border-kumo-line last:border-0 pb-2 last:pb-0"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="secondary">
                          {t.continuation ? "continuation" : "user"}
                        </Badge>
                        {statusBadge(t.status)}
                      </div>
                      <span className="text-[11px] font-mono text-kumo-subtle truncate block mt-0.5">
                        {t.requestId}
                      </span>
                    </div>
                    <span className="text-xs text-kumo-subtle shrink-0">
                      {t.textLength} chars
                    </span>
                  </div>
                ))
              )}
            </Surface>

            <Surface className="p-4 rounded-xl ring ring-kumo-line space-y-2">
              <Text size="sm" bold>
                Errors
              </Text>
              {chatErrors.length === 0 ? (
                <Text size="xs" variant="secondary">
                  None yet.
                </Text>
              ) : (
                chatErrors.map((e, i) => (
                  <div
                    key={`${e.at}-${i}`}
                    className="border-b border-kumo-line last:border-0 pb-2 last:pb-0"
                  >
                    <div className="flex items-center gap-1.5">
                      <Badge variant="destructive">{e.stage}</Badge>
                      <span className="text-[11px] text-kumo-subtle">
                        {e.name}
                      </span>
                    </div>
                    <span className="text-[11px] font-mono text-kumo-subtle break-words block mt-0.5">
                      {e.message}
                    </span>
                  </div>
                ))
              )}
            </Surface>

            <Surface className="p-4 rounded-xl ring ring-kumo-line space-y-2">
              <Text size="sm" bold>
                Recovery incidents
              </Text>
              {incidents.length === 0 ? (
                <Text size="xs" variant="secondary">
                  None yet.
                </Text>
              ) : (
                incidents.map((inc) => (
                  <div
                    key={inc.incidentId}
                    className="flex items-center justify-between gap-2 border-b border-kumo-line last:border-0 pb-2 last:pb-0"
                  >
                    <div className="flex items-center gap-1.5">
                      {statusBadge(inc.status)}
                      <span className="text-xs text-kumo-subtle">
                        {inc.recoveryKind}
                      </span>
                    </div>
                    <span className="text-xs text-kumo-subtle shrink-0">
                      attempt {inc.attempt}/{inc.maxAttempts}
                    </span>
                  </div>
                ))
              )}
            </Surface>
          </div>
        </div>
      </div>

      <div className="border-t border-kumo-line bg-kumo-base">
        {/* #1620: a live "recovering…" hint from `useAgentChat.isRecovering`, so
            a turn being recovered across a deploy reads as working, not frozen. */}
        {isRecovering && (
          <div className="max-w-5xl mx-auto px-5 pt-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-kumo-line bg-kumo-base px-3 py-1">
              <span className="size-2 rounded-full bg-kumo-accent animate-pulse" />
              <Text size="xs" variant="secondary">
                Recovering the interrupted turn…
              </Text>
            </span>
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-5xl mx-auto px-5 py-4"
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
              placeholder="e.g. stream a response for 90 seconds"
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

function Stat({
  label,
  value,
  danger
}: {
  label: string;
  value: string | number;
  danger?: boolean;
}) {
  return (
    <div className="rounded-lg bg-kumo-elevated px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-kumo-inactive font-semibold">
        {label}
      </div>
      <div
        className={`text-sm font-semibold ${danger ? "text-kumo-danger" : "text-kumo-default"}`}
      >
        {value}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <Suspense
    fallback={
      <div className="flex items-center justify-center h-screen text-kumo-inactive">
        Loading...
      </div>
    }
  >
    <App />
  </Suspense>
);
