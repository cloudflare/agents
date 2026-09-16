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
  ArrowClockwiseIcon,
  CheckCircleIcon,
  CodeIcon,
  GearIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  StopCircleIcon,
  SunIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import { useHarnessSession } from "@cloudflare/agents-next-harness/react";
import type { HarnessEvent } from "@cloudflare/agents-next-harness";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import type {
  CodexProtocol,
  CodexWorkspaceFile,
  SessionMessage
} from "./protocol";

/** The tools the kernel offers the model; mirrors `workspace_tools()`. */
const TOOLS = [
  {
    name: "workspace_write",
    description: "Write UTF-8 text to a durable workspace path."
  },
  {
    name: "workspace_read",
    description:
      "Read UTF-8 text from a durable workspace path, in ranges with offset and max_bytes."
  }
] as const;

const SESSION_KEY = "codex-session";
const DEMO_FILE = "/codex/result.txt";
const DEFAULT_PROMPT =
  "Use workspace_write to save a short note in /codex/result.txt. Then use workspace_read to verify the exact contents before you finish.";

type CodexEvent = HarnessEvent<CodexProtocol>;

/** What the kernel reported on its last transition. */
type KernelStats = {
  readonly phase: string;
  readonly modelRound: number;
  readonly transitions: number;
  readonly kernelMs: number;
};

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

/** The demo's own HTTP routes, beside the harness's WebSocket link. */
function demoRoute(name: string, route: string): string {
  return `/agents/coder/${encodeURIComponent(name)}/${route}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function partText(part: SessionMessage["parts"][number]): string {
  return part.text ?? part.reasoning ?? "";
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

/** Tool calls the live event log knows about, newest state wins. */
function collectTools(
  events: readonly CodexEvent[]
): Map<string, { status: "running" | "completed" | "failed" }> {
  const tools = new Map<
    string,
    { status: "running" | "completed" | "failed" }
  >();
  for (const event of events) {
    const body = event.body;
    if (body.type === "tool_start") {
      tools.set(body.toolCallId, { status: "running" });
    } else if (body.type === "tool_end") {
      tools.set(body.toolCallId, {
        status: body.isError ? "failed" : "completed"
      });
    }
  }
  return tools;
}

/** Kernel counters from the last checkpoint frame of the log. */
function kernelStats(events: readonly CodexEvent[]): KernelStats | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const body = events[index]?.body;
    if (body?.type === "extension" && body.body.type === "kernel_checkpoint") {
      return {
        phase: body.body.phase,
        modelRound: body.body.modelRound,
        transitions: body.body.transitions,
        kernelMs: body.body.kernelMs
      };
    }
  }
  return null;
}

function kernelEventCount(events: readonly CodexEvent[]): number {
  return events.filter(
    (event) =>
      event.body.type === "extension" && event.body.body.type === "kernel_event"
  ).length;
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function toolSummary(name: string, input: unknown, running: boolean): string {
  const path =
    isRecord(input) && typeof input.path === "string" ? input.path : undefined;
  const verb =
    name === "workspace_write"
      ? running
        ? "Writing"
        : "Wrote"
      : name === "workspace_read"
        ? running
          ? "Reading"
          : "Read"
        : running
          ? "Running"
          : "Finished";
  return path ? `${verb} ${path}` : verb;
}

function ToolCard({
  name,
  callId,
  input,
  output,
  status
}: {
  name: string;
  callId: string;
  input: unknown;
  output: unknown;
  status: "running" | "completed" | "failed";
}) {
  const icon =
    status === "running" ? (
      <GearIcon size={14} className="animate-spin text-kumo-inactive" />
    ) : status === "failed" ? (
      <XCircleIcon size={14} className="text-kumo-danger" />
    ) : (
      <CheckCircleIcon size={14} className="text-kumo-success" />
    );

  return (
    <details
      key={callId}
      className="rounded-xl border border-kumo-line bg-kumo-base"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">{name}</span>
          <span className="block truncate text-xs text-kumo-subtle">
            {toolSummary(name, input, status === "running")}
          </span>
        </span>
        <Badge variant={status === "failed" ? "destructive" : "secondary"}>
          {status === "running"
            ? "Running"
            : status === "failed"
              ? "Failed"
              : "Done"}
        </Badge>
      </summary>
      <div className="space-y-3 border-t border-kumo-line px-3 py-3">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
            Arguments
          </p>
          <JsonBlock value={input ?? ""} />
        </div>
        {status !== "running" && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Result
            </p>
            <JsonBlock value={output ?? "No output recorded"} />
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

function AssistantHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
        <CodeIcon size={17} weight="bold" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">{children}</div>
    </div>
  );
}

/**
 * One stored assistant message: text, reasoning, and every tool call it
 * made, with the output the matching `tool` message holds.
 */
function AssistantMessage({
  message,
  outputs,
  tools
}: {
  message: SessionMessage;
  outputs: ReadonlyMap<string, unknown>;
  tools: ReadonlyMap<string, { status: "running" | "completed" | "failed" }>;
}) {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map(partText)
    .join("");
  const reasoning = message.parts
    .filter((part) => part.type === "reasoning")
    .map(partText)
    .join("");
  const calls = message.parts.filter(
    (part) => part.type.startsWith("tool-") && part.toolCallId
  );

  return (
    <AssistantHead>
      <Text size="sm" bold>
        Codex
      </Text>
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
      {calls.length > 0 && (
        <div className="max-w-xl space-y-2">
          {calls.map((part) => {
            const callId = part.toolCallId ?? "";
            const output = outputs.get(callId);
            return (
              <ToolCard
                key={callId}
                callId={callId}
                name={part.toolName ?? part.type.replace(/^tool-/, "")}
                input={part.input}
                output={output}
                status={
                  output !== undefined
                    ? "completed"
                    : (tools.get(callId)?.status ?? "running")
                }
              />
            );
          })}
        </div>
      )}
      {text.length > 0 && (
        <Streamdown
          className="sd-theme max-w-xl text-sm leading-6 text-kumo-default"
          controls={false}
          plugins={{ code }}
        >
          {text}
        </Streamdown>
      )}
    </AssistantHead>
  );
}

function Sidebar({
  file,
  stats,
  kernelEvents,
  onClose
}: {
  file: CodexWorkspaceFile | null;
  stats: KernelStats | null;
  kernelEvents: number;
  onClose: () => void;
}) {
  return (
    <aside
      className="flex min-h-0 flex-col border-l border-kumo-line bg-kumo-base"
      aria-label="Tools"
    >
      <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
        <Text size="sm" bold>
          Tools
        </Text>
        <Button
          variant="ghost"
          shape="square"
          aria-label="Close tools"
          onClick={onClose}
          icon={<XIcon size={16} />}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {TOOLS.map((tool) => (
          <Surface
            key={tool.name}
            className="rounded-lg p-3 ring ring-kumo-line"
          >
            <div className="flex items-center gap-2">
              <WrenchIcon size={14} className="text-kumo-inactive" />
              <code className="text-xs font-semibold">{tool.name}</code>
            </div>
            <p className="mt-1 text-xs text-kumo-subtle">{tool.description}</p>
          </Surface>
        ))}
        <div className="pt-2">
          <Text size="xs" variant="secondary" bold>
            Workspace
          </Text>
          <Surface className="mt-2 rounded-lg p-3 ring ring-kumo-line">
            <code className="text-[11px] text-kumo-subtle">
              {file?.path ?? DEMO_FILE}
            </code>
            {file?.found ? (
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap">
                {file.content}
              </pre>
            ) : (
              <p className="mt-1 text-xs text-kumo-subtle">
                Nothing written yet.
              </p>
            )}
          </Surface>
        </div>
        <div className="pt-2">
          <Text size="xs" variant="secondary" bold>
            Kernel
          </Text>
          <Surface className="mt-2 space-y-1 rounded-lg p-3 text-xs text-kumo-subtle ring ring-kumo-line">
            <p>Phase {stats?.phase ?? "idle"}</p>
            <p>Model round {stats?.modelRound ?? 0}</p>
            <p>
              {stats?.transitions ?? 0} transitions ·{" "}
              {(stats?.kernelMs ?? 0).toFixed(1)} ms
            </p>
            <p>{kernelEvents} kernel events</p>
          </Surface>
        </div>
      </div>
    </aside>
  );
}

function App() {
  const [session, setSession] = useState(getSession);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [file, setFile] = useState<CodexWorkspaceFile | null>(null);
  const [toolsOpen, setToolsOpen] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const harness = useHarnessSession<CodexProtocol>({
    agent: "coder",
    name: session
  });
  const { connection, status, messages, events, live, error } = harness;

  const connected = connection === "open";
  const busy = status?.state === "running" || status?.state === "retrying";

  const readFile = useCallback(async () => {
    const response = await fetch(demoRoute(session, "file"));
    if (!response.ok) return;
    setFile((await response.json()) as CodexWorkspaceFile);
  }, [session]);

  // The Workspace is read over HTTP, not the harness link: it is the demo's
  // own state, not part of the conversation.
  const settled = events.filter(
    (event) => event.body.type === "operation_settled"
  ).length;
  useEffect(() => {
    void readFile();
  }, [readFile, settled]);

  // Tool outputs live in the transcript's `tool` messages, keyed by call id.
  const outputs = useMemo(() => {
    const found = new Map<string, unknown>();
    for (const message of messages) {
      if (message.role !== "tool") continue;
      for (const part of message.parts) {
        if (part.toolCallId) found.set(part.toolCallId, part.output);
      }
    }
    return found;
  }, [messages]);
  const tools = useMemo(() => collectTools(events), [events]);
  const stats = useMemo(() => kernelStats(events), [events]);
  const kernelEvents = useMemo(() => kernelEventCount(events), [events]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, live?.text, status?.state]);

  const send = () => {
    const trimmed = prompt.trim();
    if (trimmed.length === 0 || busy || !connected) return;
    setPrompt("");
    void harness.prompt(trimmed);
  };

  const newSession = () => {
    const next = randomSession();
    localStorage.setItem(SESSION_KEY, next);
    setSession(next);
    setPrompt(DEFAULT_PROMPT);
    setFile(null);
  };

  const restart = () => {
    void fetch(demoRoute(session, "restart"), { method: "POST" });
  };

  const lastResult = [...events]
    .reverse()
    .find((event) => event.body.type === "operation_settled");

  return (
    <div
      className={`grid h-dvh overflow-hidden bg-kumo-elevated text-kumo-default ${
        toolsOpen
          ? "lg:grid-cols-[minmax(520px,1fr)_minmax(300px,26vw)]"
          : "grid-cols-1"
      }`}
    >
      <section className="flex min-h-0 min-w-0 flex-col" aria-label="Chat">
        <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
          <div className="mx-auto flex h-[68px] max-w-3xl items-center justify-between gap-3 px-5">
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
                  : connection === "connecting"
                    ? "Connecting"
                    : "Reconnecting"}
              </Badge>
              <Button
                variant="ghost"
                shape="square"
                aria-label="Restart and verify"
                title="Abort the Durable Object and watch the turn resume"
                onClick={restart}
                icon={<ArrowClockwiseIcon size={16} />}
              />
              <Button
                variant="ghost"
                shape="square"
                aria-label="Tools"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen((open) => !open)}
                icon={<WrenchIcon size={16} />}
              />
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
            {messages.length === 0 && (
              <div className="py-10 sm:py-16">
                <Empty
                  icon={<TerminalIcon size={32} />}
                  title="What should Codex change?"
                  description="Describe a file task."
                />
              </div>
            )}

            {messages.map((message) =>
              message.role === "user" ? (
                <UserMessage
                  key={message.id}
                  text={message.parts.map(partText).join("")}
                />
              ) : message.role === "assistant" ? (
                <AssistantMessage
                  key={message.id}
                  message={message}
                  outputs={outputs}
                  tools={tools}
                />
              ) : null
            )}

            {live && live.text.length > 0 && (
              <AssistantHead>
                <Streamdown
                  className="sd-theme max-w-xl text-sm leading-6 text-kumo-default"
                  controls={false}
                  plugins={{ code }}
                >
                  {live.text}
                </Streamdown>
              </AssistantHead>
            )}

            {busy && (
              <AssistantHead>
                <span className="flex items-center gap-2 text-sm text-kumo-subtle">
                  <GearIcon size={15} className="animate-spin" />
                  {stats
                    ? `Kernel ${stats.phase.replace(/_/g, " ")}, round ${stats.modelRound}`
                    : "Waking the durable operation"}
                </span>
              </AssistantHead>
            )}

            {lastResult?.body.type === "operation_settled" &&
              lastResult.body.result.status !== "completed" && (
                <div
                  role="alert"
                  className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
                >
                  Turn {lastResult.body.result.status}:{" "}
                  {lastResult.body.result.error?.message ??
                    lastResult.body.result.stopReason.type}
                </div>
              )}

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
              {busy ? (
                <Button
                  type="button"
                  variant="secondary"
                  shape="square"
                  aria-label="Interrupt the turn"
                  onClick={() => void harness.interrupt()}
                  icon={<StopCircleIcon size={18} />}
                  className="mb-0.5"
                />
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Run turn"
                  disabled={!connected || prompt.trim().length === 0}
                  icon={<PaperPlaneRightIcon size={18} />}
                  className="mb-0.5"
                />
              )}
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
      </section>

      {toolsOpen ? (
        <Sidebar
          file={file}
          stats={stats}
          kernelEvents={kernelEvents}
          onClose={() => setToolsOpen(false)}
        />
      ) : null}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
