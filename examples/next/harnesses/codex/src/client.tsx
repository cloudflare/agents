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
  ArrowCounterClockwiseIcon,
  CheckCircleIcon,
  CodeIcon,
  DatabaseIcon,
  FileTextIcon,
  GearIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  SunIcon,
  TerminalIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { code } from "@streamdown/code";
import { Streamdown } from "streamdown";

type OperationStatus = "queued" | "running" | "completed" | "failed";

type OperationSnapshot = {
  operationId: string;
  streamId: string;
  status: OperationStatus;
  prompt: string;
  checkpoint: Record<string, unknown> | null;
  action: Record<string, unknown> | null;
  transitions: number;
  kernelMs: number;
  startedAt: number;
  completedAt?: number;
  output?: string;
  error?: string;
};

type KernelEvent = {
  seq: number;
  type: string;
  [key: string]: unknown;
};

type WorkspaceFile = {
  path: string;
  found: boolean;
  content?: string;
};

type RunState =
  | { type: "idle" }
  | { type: "submitting" }
  | { type: "running"; operationId: string }
  | { type: "completed"; operationId: string }
  | { type: "failed"; operationId?: string; message: string };

type ArchivedTurn = {
  operationId: string;
  prompt: string;
  status: "completed" | "failed";
  output?: string;
  error?: string;
  events: KernelEvent[];
};

type ToolActivity = {
  callId: string;
  name: string;
  arguments: unknown;
  status: "running" | "completed" | "failed";
  output?: unknown;
};

const DEFAULT_PROMPT =
  "Use workspace_write to save a short note in /codex/result.txt. Then use workspace_read to verify the exact contents before you finish.";
const POLL_INTERVAL_MS = 400;
const POLL_LIMIT = 300;

function randomSession(): string {
  return `demo-${crypto.randomUUID().slice(0, 8)}`;
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

function StatusBadge({ status }: { status: OperationStatus }) {
  if (status === "completed") return <Badge variant="success">Completed</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (status === "running") return <Badge variant="primary">Running</Badge>;
  return <Badge variant="secondary">Queued</Badge>;
}

function collectToolActivity(events: KernelEvent[]): ToolActivity[] {
  const tools = new Map<string, ToolActivity>();
  for (const event of events) {
    if (event.type === "tool_started") {
      const callId = String(event.call_id ?? event.effect_id ?? event.seq);
      tools.set(callId, {
        callId,
        name: String(event.name ?? "Tool"),
        arguments: event.arguments ?? {},
        status: "running"
      });
      continue;
    }
    if (event.type !== "tool_completed") continue;
    const callId = String(event.call_id ?? event.effect_id ?? event.seq);
    const previous = tools.get(callId);
    tools.set(callId, {
      callId,
      name: String(event.name ?? previous?.name ?? "Tool"),
      arguments: previous?.arguments ?? {},
      status: event.success === false ? "failed" : "completed",
      output: event.output
    });
  }
  return [...tools.values()];
}

function modelRounds(events: KernelEvent[]): number {
  return events.filter((event) => event.type === "model_requested").length;
}

function reasoningText(events: KernelEvent[]): string {
  return events
    .filter((event) => event.type === "reasoning_delta")
    .map((event) => String(event.delta ?? ""))
    .join("");
}

function toolSummary(tool: ToolActivity): string {
  const path = stringField(tool.arguments, "path");
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

function ToolCard({ tool }: { tool: ToolActivity }) {
  const icon =
    tool.status === "running" ? (
      <GearIcon size={14} className="animate-spin text-kumo-inactive" />
    ) : tool.status === "failed" ? (
      <XCircleIcon size={14} className="text-kumo-danger" />
    ) : (
      <CheckCircleIcon size={14} className="text-kumo-success" />
    );

  return (
    <details className="tool-card rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">
            {tool.name}
          </span>
          <span className="block truncate text-xs text-kumo-subtle">
            {toolSummary(tool)}
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
          <pre className="max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
            {JSON.stringify(tool.arguments, null, 2)}
          </pre>
        </div>
        {tool.output !== undefined && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Result
            </p>
            <pre className="max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
              {typeof tool.output === "string"
                ? tool.output
                : JSON.stringify(tool.output, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[88%] rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 text-sm leading-6 text-kumo-inverse sm:max-w-[78%]">
        {text}
      </div>
    </div>
  );
}

function AssistantMessage({
  status,
  events,
  output,
  error,
  children
}: {
  status: OperationStatus | "submitting";
  events: KernelEvent[];
  output?: string;
  error?: string;
  children?: ReactNode;
}) {
  const tools = useMemo(() => collectToolActivity(events), [events]);
  const reasoning = useMemo(() => reasoningText(events), [events]);
  const rounds = modelRounds(events);
  const running =
    status === "submitting" || status === "queued" || status === "running";

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
              {status === "submitting" ? "Starting turn" : "Working"}
            </span>
          ) : status === "completed" ? (
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
              Waking the durable operation...
            </div>
          </Surface>
        )}

        {reasoning.length > 0 && (
          <Surface className="max-w-xl rounded-xl px-4 py-3 ring ring-kumo-line">
            <div className="mb-1 flex items-center gap-2">
              <GearIcon size={14} className="text-kumo-inactive" />
              <Text size="xs" variant="secondary" bold>
                Reasoning
              </Text>
            </div>
            <p className="whitespace-pre-wrap text-xs italic leading-5 text-kumo-subtle">
              {reasoning}
            </p>
          </Surface>
        )}

        {tools.length > 0 && (
          <div className="max-w-xl space-y-2">
            {tools.map((tool) => (
              <ToolCard key={tool.callId} tool={tool} />
            ))}
          </div>
        )}

        {output && (
          <Streamdown
            className="sd-theme max-w-xl text-sm leading-6 text-kumo-default"
            controls={false}
            plugins={{ code }}
          >
            {output}
          </Streamdown>
        )}

        {error && (
          <div
            role="alert"
            className="max-w-xl rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
          >
            {error}
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

function JsonInspector({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-lg bg-kumo-elevated p-3 text-xs leading-5 text-kumo-default ring ring-kumo-line whitespace-pre-wrap break-words">
      {value === null ? "No checkpoint yet" : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function RunDetails({
  snapshot,
  file,
  events,
  recovered,
  restarting,
  onVerifyRestart
}: {
  snapshot: OperationSnapshot;
  file: WorkspaceFile | null;
  events: KernelEvent[];
  recovered: boolean;
  restarting: boolean;
  onVerifyRestart: () => void;
}) {
  const duration =
    snapshot.completedAt === undefined
      ? null
      : snapshot.completedAt - snapshot.startedAt;

  return (
    <details className="run-details max-w-xl overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        <DatabaseIcon size={14} className="text-kumo-inactive" />
        <span className="flex-1 text-xs font-semibold">Run details</span>
        {recovered && <Badge variant="success">Recovered</Badge>}
        <StatusBadge status={snapshot.status} />
      </summary>
      <div className="space-y-4 border-t border-kumo-line p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ["Model", "Kimi K2.7"],
            ["Transitions", String(snapshot.transitions)],
            ["Kernel", `${snapshot.kernelMs.toFixed(3)} ms`],
            ["Duration", duration === null ? "Running" : `${duration} ms`]
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-kumo-elevated p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-kumo-inactive">
                {label}
              </p>
              <p className="mt-1 truncate text-xs font-medium">{value}</p>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-kumo-line">
          <div className="flex items-center justify-between gap-2 border-b border-kumo-line px-3 py-2">
            <div className="flex items-center gap-2">
              <FileTextIcon size={14} className="text-kumo-inactive" />
              <span className="text-xs font-semibold">Workspace file</span>
            </div>
            {file?.found && <Badge variant="success">Persisted</Badge>}
          </div>
          <div className="p-3">
            {file?.found ? (
              <>
                <code className="text-[11px] text-kumo-subtle">
                  {file.path}
                </code>
                <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap">
                  {file.content}
                </pre>
              </>
            ) : (
              <Text size="xs" variant="secondary">
                No persisted file yet.
              </Text>
            )}
          </div>
        </div>

        <details>
          <summary className="cursor-pointer text-xs font-semibold text-kumo-subtle">
            Kernel checkpoint
          </summary>
          <div className="mt-2">
            <JsonInspector value={snapshot.checkpoint} />
          </div>
        </details>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
          <span className="text-[11px] text-kumo-inactive">
            {events.length} durable events · static Wasm
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={onVerifyRestart}
            loading={restarting}
            disabled={snapshot.status !== "completed" || restarting}
            icon={<ArrowCounterClockwiseIcon size={14} />}
          >
            Restart and verify
          </Button>
        </div>
      </div>
    </details>
  );
}

function App() {
  const [session, setSession] = useState(
    () => localStorage.getItem("codex-demo-session") || randomSession()
  );
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [activePrompt, setActivePrompt] = useState<string | null>(null);
  const [archivedTurns, setArchivedTurns] = useState<ArchivedTurn[]>([]);
  const [runState, setRunState] = useState<RunState>({ type: "idle" });
  const [snapshot, setSnapshot] = useState<OperationSnapshot | null>(null);
  const [events, setEvents] = useState<KernelEvent[]>([]);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const runGeneration = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem("codex-demo-session", session);
  }, [session]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [archivedTurns.length, events.length, runState.type, snapshot?.output]);

  const api = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(
        `/sessions/${encodeURIComponent(session)}${path}`,
        init
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : `Request failed with ${response.status}`;
        throw new Error(message);
      }
      // SAFETY: Each call site supplies the response type for one owned API
      // route. The server and client live in this package and change together.
      return body as T;
    },
    [session]
  );

  const pollOperation = useCallback(
    async (operationId: string, generation: number) => {
      for (let attempt = 0; attempt < POLL_LIMIT; attempt++) {
        if (runGeneration.current !== generation) return;
        const [next, eventResult] = await Promise.all([
          api<OperationSnapshot>(
            `/operations/${encodeURIComponent(operationId)}`
          ),
          api<{ events: KernelEvent[] }>(
            `/events/${encodeURIComponent(operationId)}`
          )
        ]);
        setSnapshot(next);
        setEvents(eventResult.events);
        if (next.status === "completed") {
          const fileResult = await api<WorkspaceFile>(
            "/file?path=/codex/result.txt"
          );
          if (runGeneration.current === generation) {
            setFile(fileResult);
            setRunState({ type: "completed", operationId });
          }
          return;
        }
        if (next.status === "failed") {
          if (runGeneration.current === generation) {
            setRunState({
              type: "failed",
              operationId,
              message: next.error ?? "Codex turn failed"
            });
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (runGeneration.current === generation) {
        setRunState({
          type: "failed",
          operationId,
          message: "Timed out while waiting for the durable turn"
        });
      }
    },
    [api]
  );

  const submit = useCallback(async () => {
    const trimmed = prompt.trim();
    if (trimmed.length === 0) return;

    if (
      activePrompt !== null &&
      snapshot !== null &&
      (snapshot.status === "completed" || snapshot.status === "failed")
    ) {
      const archived: ArchivedTurn = {
        operationId: snapshot.operationId,
        prompt: activePrompt,
        status: snapshot.status,
        events,
        ...(snapshot.output === undefined ? {} : { output: snapshot.output }),
        ...(snapshot.error === undefined ? {} : { error: snapshot.error })
      };
      setArchivedTurns((current) => [...current, archived]);
    }

    const generation = ++runGeneration.current;
    setActivePrompt(trimmed);
    setPrompt("");
    setRunState({ type: "submitting" });
    setSnapshot(null);
    setEvents([]);
    setFile(null);
    setRecovered(false);
    try {
      const receipt = await api<{
        operationId: string;
        streamId: string;
        accepted: boolean;
      }>("/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: trimmed })
      });
      setRunState({ type: "running", operationId: receipt.operationId });
      await pollOperation(receipt.operationId, generation);
    } catch (error) {
      if (runGeneration.current === generation) {
        setRunState({
          type: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }, [activePrompt, api, events, pollOperation, prompt, snapshot]);

  const verifyRestart = useCallback(async () => {
    if (!snapshot || snapshot.status !== "completed") return;
    setRestarting(true);
    setRecovered(false);
    try {
      await api<{ restarting: boolean }>("/restart", { method: "POST" });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const restored = await api<OperationSnapshot>(
        `/operations/${encodeURIComponent(snapshot.operationId)}`
      );
      const restoredFile = await api<WorkspaceFile>(
        "/file?path=/codex/result.txt"
      );
      setSnapshot(restored);
      setFile(restoredFile);
      setRecovered(restored.status === "completed" && restoredFile.found);
    } catch (error) {
      setRunState({
        type: "failed",
        operationId: snapshot.operationId,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setRestarting(false);
    }
  }, [api, snapshot]);

  const newSession = useCallback(() => {
    runGeneration.current += 1;
    setSession(randomSession());
    setPrompt(DEFAULT_PROMPT);
    setActivePrompt(null);
    setArchivedTurns([]);
    setRunState({ type: "idle" });
    setSnapshot(null);
    setEvents([]);
    setFile(null);
    setRecovered(false);
  }, []);

  const busy = runState.type === "submitting" || runState.type === "running";
  const currentStatus: OperationStatus | "submitting" =
    snapshot?.status ??
    (runState.type === "submitting"
      ? "submitting"
      : runState.type === "failed"
        ? "failed"
        : "queued");
  const currentError =
    runState.type === "failed"
      ? runState.message
      : snapshot?.status === "failed"
        ? snapshot.error
        : undefined;

  return (
    <div className="flex h-dvh flex-col bg-kumo-elevated text-kumo-default">
      <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-kumo-brand text-white">
              <CodeIcon size={20} weight="bold" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">
                Codex Harness
              </h1>
              <p className="truncate text-xs text-kumo-subtle">
                <span className="hidden sm:inline">Workspace session </span>
                <code>{session}</code>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant="secondary" className="hidden sm:inline-flex">
              LanguageModelV4 · Kimi K2.7
            </Badge>
            <Button
              variant="ghost"
              shape="square"
              aria-label="New session"
              onClick={newSession}
              disabled={busy}
              icon={<ArrowCounterClockwiseIcon size={16} />}
            />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-5 sm:py-8">
          {archivedTurns.length === 0 && activePrompt === null && (
            <div className="py-10 sm:py-16">
              <Empty
                icon={<TerminalIcon size={32} />}
                title="What should Codex change?"
                description="Describe a file task. Codex will call Workspace tools through a durable Rust/Wasm turn and show each step here."
              />
            </div>
          )}

          {archivedTurns.map((turn) => (
            <div key={turn.operationId} className="space-y-5">
              <UserMessage text={turn.prompt} />
              <AssistantMessage
                status={turn.status}
                events={turn.events}
                output={turn.output}
                error={turn.error}
              />
            </div>
          ))}

          {activePrompt !== null && (
            <div className="space-y-5">
              <UserMessage text={activePrompt} />
              <AssistantMessage
                status={currentStatus}
                events={events}
                output={snapshot?.output}
                error={currentError}
              >
                {snapshot && (
                  <RunDetails
                    snapshot={snapshot}
                    file={file}
                    events={events}
                    recovered={recovered}
                    restarting={restarting}
                    onVerifyRestart={() => void verifyRestart()}
                  />
                )}
              </AssistantMessage>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </main>

      <div className="shrink-0 border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="mx-auto max-w-3xl px-4 pt-3 sm:px-5 sm:pt-4"
        >
          <div className="flex items-end gap-2 rounded-xl border border-kumo-line bg-kumo-base p-2.5 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
            <InputArea
              id="codex-prompt"
              value={prompt}
              onValueChange={setPrompt}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              disabled={busy}
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
              disabled={busy || prompt.trim().length === 0}
              icon={<PaperPlaneRightIcon size={18} />}
              className="mb-0.5"
            />
          </div>
        </form>
        <div className="flex items-center justify-center gap-2 px-4 py-2.5">
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
