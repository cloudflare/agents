import "./styles.css";
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
  CheckCircleIcon,
  CodeIcon,
  GearIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  SunIcon,
  TerminalIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { code } from "@streamdown/code";
import { Streamdown } from "streamdown";
import type { CodexOperationSnapshot, SessionMessage } from "./protocol";
import { useCodexSession, type KernelEvent } from "./use-codex-session";

type OperationStatus = CodexOperationSnapshot["status"];

type ToolActivity = {
  callId: string;
  name: string;
  /** Id of the assistant message holding the call's arguments. */
  callMessageId?: string;
  /** Id of the tool message holding the full output. */
  outputMessageId?: string;
  status: "running" | "completed" | "failed";
  preview?: string;
  bytes?: number;
};

const SESSION_KEY = "codex-session";
const DEFAULT_PROMPT =
  "Use workspace_write to save a short note in /codex/result.txt. Then use workspace_read to verify the exact contents before you finish.";

function randomSession(): string {
  return `demo-${crypto.randomUUID().slice(0, 8)}`;
}

function getSession(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = randomSession();
  localStorage.setItem(SESSION_KEY, created);
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[field];
  return typeof candidate === "string" ? candidate : undefined;
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
      onClick={() =>
        setMode((current) => (current === "light" ? "dark" : "light"))
      }
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function collectToolActivity(events: readonly KernelEvent[]): ToolActivity[] {
  const tools = new Map<string, ToolActivity>();
  for (const event of events) {
    if (event.type === "tool_started") {
      const callId = String(event.call_id ?? event.effect_id ?? event.seq);
      tools.set(callId, {
        callId,
        name: String(event.name ?? "Tool"),
        callMessageId: stringField(event.arguments, "$message"),
        status: "running"
      });
      continue;
    }
    if (event.type !== "tool_completed") continue;
    const callId = String(event.call_id ?? event.effect_id ?? event.seq);
    const previous = tools.get(callId);
    const output = event.output;
    tools.set(callId, {
      callId,
      name: String(event.name ?? previous?.name ?? "Tool"),
      callMessageId: previous?.callMessageId,
      outputMessageId: stringField(output, "messageId"),
      status: event.success === false ? "failed" : "completed",
      preview: stringField(output, "preview"),
      bytes:
        isRecord(output) && typeof output.bytes === "number"
          ? output.bytes
          : undefined
    });
  }
  return [...tools.values()];
}

function modelRounds(events: readonly KernelEvent[]): number {
  return events.filter((event) => event.type === "model_requested").length;
}

function reasoningText(events: readonly KernelEvent[]): string {
  return events
    .filter((event) => event.type === "reasoning_delta")
    .map((event) => String(event.delta ?? ""))
    .join("");
}

function toolSummary(tool: ToolActivity): string {
  let path: string | undefined;
  try {
    path = stringField(JSON.parse(tool.preview ?? ""), "path");
  } catch {
    path = undefined;
  }
  const verb =
    tool.name === "workspace_write"
      ? tool.status === "running"
        ? "Writing"
        : "Wrote"
      : tool.name === "workspace_read"
        ? tool.status === "running"
          ? "Reading"
          : "Read"
        : tool.status === "running"
          ? "Running"
          : "Finished";
  return path ? `${verb} ${path}` : verb;
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function toolPart(message: SessionMessage | null | undefined, callId: string) {
  return message?.parts.find((part) => part.toolCallId === callId);
}

function ToolCard({
  tool,
  messages,
  onExpand
}: {
  tool: ToolActivity;
  messages: Readonly<Record<string, SessionMessage | null>>;
  onExpand: (messageId: string) => void;
}) {
  const call = tool.callMessageId
    ? toolPart(messages[tool.callMessageId], tool.callId)
    : undefined;
  const result = tool.outputMessageId
    ? toolPart(messages[tool.outputMessageId], tool.callId)
    : undefined;
  const icon =
    tool.status === "running" ? (
      <GearIcon size={14} className="animate-spin text-kumo-inactive" />
    ) : tool.status === "failed" ? (
      <XCircleIcon size={14} className="text-kumo-danger" />
    ) : (
      <CheckCircleIcon size={14} className="text-kumo-success" />
    );

  return (
    <details
      className="rounded-xl border border-kumo-line bg-kumo-base"
      onToggle={(event) => {
        if (!event.currentTarget.open) return;
        for (const id of [tool.callMessageId, tool.outputMessageId]) {
          if (id && messages[id] === undefined) onExpand(id);
        }
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">
            {tool.name}
          </span>
          <span className="block truncate text-xs text-kumo-subtle">
            {toolSummary(tool)}
            {tool.bytes !== undefined ? ` · ${tool.bytes} bytes` : ""}
          </span>
        </span>
        <Badge variant={tool.status === "failed" ? "destructive" : "secondary"}>
          {tool.status === "running"
            ? "Running"
            : tool.status === "failed"
              ? "Failed"
              : "Done"}
        </Badge>
      </summary>
      <div className="space-y-3 border-t border-kumo-line px-3 py-3">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
            Arguments
          </p>
          <JsonBlock value={call?.input ?? "Loading from the transcript"} />
        </div>
        {tool.status !== "running" && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Result
            </p>
            <JsonBlock value={result?.output ?? tool.preview ?? ""} />
          </div>
        )}
      </div>
    </details>
  );
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 text-sm leading-relaxed text-kumo-inverse">
        {text}
      </div>
    </div>
  );
}

function AssistantMessage({
  operation,
  events,
  messages,
  onExpandTool,
  children
}: {
  operation: CodexOperationSnapshot;
  events: readonly KernelEvent[];
  messages: Readonly<Record<string, SessionMessage | null>>;
  onExpandTool: (messageId: string) => void;
  children?: ReactNode;
}) {
  const tools = useMemo(() => collectToolActivity(events), [events]);
  const reasoning = useMemo(() => reasoningText(events), [events]);
  const rounds = modelRounds(events);
  const running =
    operation.status === "queued" || operation.status === "running";

  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
        <CodeIcon size={17} weight="bold" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Text size="sm" bold>
            Codex
          </Text>
          {running ? (
            <span className="flex items-center gap-1.5 text-xs text-kumo-subtle">
              <span className="size-1.5 animate-pulse rounded-full bg-kumo-accent" />
              Working
            </span>
          ) : operation.status === "completed" ? (
            <span className="text-xs font-medium text-kumo-success">
              Turn completed
            </span>
          ) : (
            <span className="text-xs font-medium text-kumo-danger">
              Turn failed
            </span>
          )}
        </div>

        {running && events.length === 0 && (
          <Surface className="max-w-xl rounded-xl px-4 py-3 ring ring-kumo-line">
            <div className="flex items-center gap-2 text-sm text-kumo-subtle">
              <GearIcon size={15} className="animate-spin" />
              Waking the durable operation
            </div>
          </Surface>
        )}

        {reasoning.length > 0 && (
          <details className="max-w-xl rounded-xl border border-kumo-line px-3 py-2">
            <summary className="cursor-pointer list-none text-xs font-semibold text-kumo-subtle">
              Reasoning
            </summary>
            <p className="mt-2 whitespace-pre-wrap text-xs italic leading-5 text-kumo-subtle">
              {reasoning}
            </p>
          </details>
        )}

        {tools.length > 0 && (
          <div className="max-w-xl space-y-2">
            {tools.map((tool) => (
              <ToolCard
                key={tool.callId}
                tool={tool}
                messages={messages}
                onExpand={onExpandTool}
              />
            ))}
          </div>
        )}

        {operation.output && (
          <Streamdown
            className="sd-theme max-w-xl text-sm leading-6 text-kumo-default"
            controls={false}
            plugins={{ code }}
          >
            {operation.output}
          </Streamdown>
        )}

        {operation.error && (
          <div
            role="alert"
            className="max-w-xl rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
          >
            {operation.error}
          </div>
        )}

        {events.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-kumo-inactive">
            <span>
              {rounds} model {rounds === 1 ? "round" : "rounds"}
            </span>
            <span aria-hidden="true">·</span>
            <Badge variant="secondary">{events.length} events</Badge>
          </div>
        )}

        {children}
      </div>
    </div>
  );
}

function App() {
  const [session, setSession] = useState(getSession);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const {
    status,
    operations,
    events,
    messages,
    error,
    active,
    submit,
    inspectMessage
  } = useCodexSession(session);

  const connected = status === "open";
  const busy = active !== null;

  const eventCount = Object.values(events).reduce(
    (sum, list) => sum + list.length,
    0
  );
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [operations.length, eventCount, active?.status]);

  const send = () => {
    const trimmed = prompt.trim();
    if (trimmed.length === 0 || busy || !connected) return;
    setPrompt("");
    submit(trimmed);
  };

  const newSession = () => {
    const next = randomSession();
    localStorage.setItem(SESSION_KEY, next);
    setSession(next);
    setPrompt(DEFAULT_PROMPT);
  };

  return (
    <div className="flex h-dvh flex-col bg-kumo-elevated text-kumo-default">
      <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-kumo-brand text-white">
              <CodeIcon size={20} weight="bold" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">
                Codex harness
              </h1>
              <p className="truncate text-xs text-kumo-subtle">
                Session <code>{session}</code>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant="secondary" className="hidden sm:inline-flex">
              Kimi K2.7
            </Badge>
            <Badge variant={connected ? "success" : "secondary"}>
              {connected
                ? "Live"
                : status === "connecting"
                  ? "Connecting"
                  : "Reconnecting"}
            </Badge>
            <Button
              variant="ghost"
              shape="square"
              aria-label="New session"
              onClick={newSession}
              disabled={busy}
              icon={<PlusIcon size={16} />}
            />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-5 py-6">
          {operations.length === 0 && (
            <div className="py-10 sm:py-16">
              <Empty
                icon={<TerminalIcon size={32} />}
                title="What should Codex change?"
                description="Describe a file task."
              />
            </div>
          )}

          {operations.map((operation) => (
            <div key={operation.operationId} className="space-y-5">
              <UserMessage text={operation.prompt} />
              <AssistantMessage
                operation={operation}
                events={events[operation.operationId] ?? []}
                messages={messages}
                onExpandTool={inspectMessage}
              ></AssistantMessage>
            </div>
          ))}

          {error && (
            <div
              role="alert"
              className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
            >
              {error}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </main>

      <div className="shrink-0 border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
          className="mx-auto max-w-3xl px-5 pt-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
            <InputArea
              value={prompt}
              onValueChange={setPrompt}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              rows={2}
              disabled={busy || !connected}
              aria-label="Message Codex"
              placeholder="Describe a coding task"
              className="flex-1 !bg-transparent !shadow-none !ring-0 !outline-none focus:!ring-0"
            />
            <Button
              type="submit"
              variant="primary"
              shape="square"
              aria-label="Run turn"
              loading={busy}
              disabled={busy || !connected || prompt.trim().length === 0}
              icon={<PaperPlaneRightIcon size={18} />}
              className="mb-0.5"
            />
          </div>
        </form>
        <div className="flex items-center justify-center gap-2 px-5 py-3">
          <span className="hidden text-[10px] text-kumo-inactive sm:inline">
            Enter to send · Shift+Enter for a new line
          </span>
          <span className="hidden text-kumo-line sm:inline">·</span>
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
