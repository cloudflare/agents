import type { HarnessEvent } from "@cloudflare/agents-next-harness";
import { useHarnessSession } from "@cloudflare/agents-next-harness/react";
import {
  Badge,
  Button,
  Empty,
  Input,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  CheckCircleIcon,
  CodeIcon,
  FloppyDiskIcon,
  GearIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlayIcon,
  PlusIcon,
  SunIcon,
  XCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import type { SessionMessage } from "agents/sessions";
import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import type { SelfModifyingProtocol, SelfModifyingSnapshot } from "./protocol";
import "./styles.css";

type InspectorTab = "code" | "revisions" | "activity";

type ToolActivity = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly status: "running" | "completed" | "failed";
  readonly output?: unknown;
};

/** What one operation's frames say about the turn that produced them. */
type TurnActivity = {
  readonly tools: readonly ToolActivity[];
  readonly rounds: number;
  readonly revisionId: number | null;
};

const AGENT = "self-modifying-harness";
const OBJECT_KEY = "self-modifying-harness-object";
const SUGGESTIONS = [
  {
    label: "Create a roll_die tool",
    value:
      "Create a Custom tool named roll_die that accepts a number of sides and returns a random integer. Inspect your harness source, write the tool in a new file, and activate the new harness. Tell me the new revision when it is ready."
  },
  {
    label: "Explain the active harness",
    value:
      "Inspect your active harness and explain how you can modify yourself."
  }
];

function getObjectName(): string {
  const fromUrl = new URLSearchParams(location.search).get("agent");
  if (fromUrl) return fromUrl;
  const existing = localStorage.getItem(OBJECT_KEY);
  if (existing) return existing;
  const created = `harness-${crypto.randomUUID().slice(0, 8)}`;
  localStorage.setItem(OBJECT_KEY, created);
  return created;
}

function dateTime(value: number): string {
  return new Date(value).toLocaleString();
}

function shortTime(value: number): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function messageText(message: SessionMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/** The operation a `user:<id>` or `assistant:<id>` message belongs to. */
function operationOf(messageId: string): string {
  const separator = messageId.indexOf(":");
  return separator === -1 ? messageId : messageId.slice(separator + 1);
}

/** Fold the durable event log into per-operation tool and model activity. */
function activityOf(
  events: readonly HarnessEvent<SelfModifyingProtocol>[]
): Map<string, TurnActivity> {
  const turns = new Map<
    string,
    {
      tools: Map<string, ToolActivity>;
      rounds: number;
      revisionId: number | null;
    }
  >();
  for (const event of events) {
    const operationId = event.operationId;
    if (operationId === undefined) continue;
    let turn = turns.get(operationId);
    if (!turn) {
      turn = { tools: new Map(), rounds: 0, revisionId: null };
      turns.set(operationId, turn);
    }
    const body = event.body;
    if (body.type === "tool_start") {
      turn.tools.set(body.toolCallId, {
        toolCallId: body.toolCallId,
        toolName: body.toolName,
        input: body.input,
        status: "running"
      });
    } else if (body.type === "tool_end") {
      const started = turn.tools.get(body.toolCallId);
      turn.tools.set(body.toolCallId, {
        toolCallId: body.toolCallId,
        toolName: started?.toolName ?? "tool",
        input: started?.input,
        status: body.isError ? "failed" : "completed",
        output: body.output
      });
    } else if (
      body.type === "extension" &&
      body.body.type === "model_started"
    ) {
      turn.rounds = Math.max(turn.rounds, body.body.round);
    } else if (body.type === "operation_settled") {
      const raw = body.result.raw;
      if (raw && typeof raw === "object" && "revisionId" in raw) {
        const revisionId = raw.revisionId;
        if (typeof revisionId === "number") turn.revisionId = revisionId;
      }
    }
  }
  return new Map(
    [...turns].map(([operationId, turn]) => [
      operationId,
      {
        tools: [...turn.tools.values()],
        rounds: turn.rounds,
        revisionId: turn.revisionId
      }
    ])
  );
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") ?? "light"
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
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
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
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {icon}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {tool.toolName}
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
        {tool.input !== undefined ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Input
            </p>
            <JsonBlock value={tool.input} />
          </div>
        ) : null}
        {tool.output !== undefined ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Result
            </p>
            <JsonBlock value={tool.output} />
          </div>
        ) : null}
      </div>
    </details>
  );
}

function AssistantMessage({
  text,
  activity,
  running
}: {
  text: string;
  activity: TurnActivity | undefined;
  running: boolean;
}) {
  const tools = activity?.tools ?? [];
  const rounds = activity?.rounds ?? 0;

  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
        <CodeIcon size={17} weight="bold" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Text size="sm" bold>
            Harness
          </Text>
          {activity?.revisionId !== null &&
          activity?.revisionId !== undefined ? (
            <Badge variant="secondary">revision {activity.revisionId}</Badge>
          ) : null}
          {running ? (
            <span className="flex items-center gap-1.5 text-xs text-kumo-subtle">
              <span className="size-1.5 animate-pulse rounded-full bg-kumo-accent" />
              {rounds > 0 ? `Round ${rounds}` : "Starting"}
            </span>
          ) : null}
        </div>

        {running && tools.length === 0 && text === "" ? (
          <Surface className="max-w-xl rounded-xl px-4 py-3 ring ring-kumo-line">
            <div className="flex items-center gap-2 text-sm text-kumo-subtle">
              <GearIcon size={15} className="animate-spin" />
              Loading the pinned revision into a fresh isolate
            </div>
          </Surface>
        ) : null}

        {tools.length > 0 ? (
          <div className="max-w-xl space-y-2">
            {tools.map((tool) => (
              <ToolCard key={tool.toolCallId} tool={tool} />
            ))}
          </div>
        ) : null}

        {text ? (
          <Streamdown
            className="sd-theme max-w-xl text-sm leading-6"
            plugins={{ code }}
            controls={false}
          >
            {text}
          </Streamdown>
        ) : null}
      </div>
    </div>
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

function Inspector({
  snapshot,
  busy,
  onClose,
  onWrite,
  onActivate,
  onRestore
}: {
  snapshot: SelfModifyingSnapshot | null;
  busy: boolean;
  onClose: () => void;
  onWrite: (path: string, content: string) => void;
  onActivate: (note: string) => void;
  onRestore: (revisionId: number) => void;
}) {
  const [tab, setTab] = useState<InspectorTab>("code");
  const [selectedPath, setSelectedPath] = useState("src/index.ts");
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const selected =
    snapshot?.files.find((file) => file.path === selectedPath) ?? null;
  const activeRevisionId = snapshot?.active.revisionId ?? null;

  // The editor always starts from the active revision's exact source; a save
  // goes to the working tree, which only becomes visible once activated.
  useEffect(() => {
    setDraft(null);
  }, [selectedPath, activeRevisionId]);

  const content = draft ?? selected?.content ?? "";

  return (
    <aside
      className="flex min-h-0 flex-col border-l border-kumo-line bg-kumo-base"
      aria-label="Harness inspector"
    >
      <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
        <div className="min-w-0">
          <Text size="sm" bold>
            Active revision {activeRevisionId ?? "…"}
          </Text>
          <p className="truncate font-mono text-[10px] text-kumo-subtle">
            {snapshot?.active.sourceHash.slice(0, 16) ?? ""}
          </p>
        </div>
        <Button
          variant="ghost"
          shape="square"
          aria-label="Close inspector"
          onClick={onClose}
          icon={<XIcon size={16} />}
        />
      </div>

      <div className="flex gap-1 border-b border-kumo-line px-2 py-2">
        {(["code", "revisions", "activity"] as const).map((candidate) => (
          <Button
            key={candidate}
            size="sm"
            variant={tab === candidate ? "secondary" : "ghost"}
            onClick={() => setTab(candidate)}
          >
            {candidate === "code"
              ? "Code"
              : candidate === "revisions"
                ? "Revisions"
                : "Activity"}
          </Button>
        ))}
      </div>

      {tab === "code" ? (
        <div className="grid min-h-0 flex-1 grid-cols-[150px_minmax(0,1fr)]">
          <nav
            className="overflow-y-auto border-r border-kumo-line bg-kumo-elevated p-1.5"
            aria-label="Active harness files"
          >
            {snapshot?.files.map((file) => (
              <button
                type="button"
                key={file.path}
                className={`mb-0.5 block w-full rounded-md p-2 text-left text-[11px] ${
                  file.path === selectedPath
                    ? "bg-kumo-base font-semibold text-kumo-default"
                    : "text-kumo-subtle hover:bg-kumo-base"
                }`}
                onClick={() => setSelectedPath(file.path)}
              >
                <span className="block break-words">{file.path}</span>
                <span className="mt-0.5 block text-[9px] opacity-60">
                  {file.size} B
                </span>
              </button>
            ))}
          </nav>
          <div className="flex min-h-0 min-w-0 flex-col">
            <textarea
              value={content}
              spellCheck={false}
              aria-label={`Source of ${selectedPath}`}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-0 flex-1 resize-none bg-kumo-contrast p-4 font-mono text-xs leading-relaxed text-kumo-inverse outline-none"
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-kumo-line p-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || draft === null}
                icon={<FloppyDiskIcon size={13} />}
                onClick={() => {
                  if (draft === null) return;
                  onWrite(selectedPath, draft);
                  setDraft(null);
                }}
              >
                Save to working tree
              </Button>
              <Input
                value={note}
                onValueChange={setNote}
                aria-label="Activation note"
                placeholder="Activation note"
                className="min-w-0 flex-1"
              />
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                icon={<PlayIcon size={13} />}
                onClick={() => {
                  onActivate(note.trim() === "" ? "operator activation" : note);
                  setNote("");
                }}
              >
                Activate
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "revisions" ? (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {snapshot?.revisions.map((revision) => {
            const active = revision.revisionId === activeRevisionId;
            return (
              <Surface
                key={revision.revisionId}
                className="rounded-lg p-3 ring ring-kumo-line"
              >
                <div className="flex items-center justify-between gap-2">
                  <Text size="sm" bold>
                    Revision {revision.revisionId}
                  </Text>
                  {active ? (
                    <Badge variant="success">Active</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      icon={<ArrowCounterClockwiseIcon size={13} />}
                      onClick={() => onRestore(revision.revisionId)}
                    >
                      Restore
                    </Button>
                  )}
                </div>
                <p className="mt-1 text-xs text-kumo-subtle">{revision.note}</p>
                <p className="mt-2 font-mono text-[10px] text-kumo-inactive">
                  {revision.sourceHash.slice(0, 16)} ·{" "}
                  {dateTime(revision.createdAt)}
                </p>
              </Surface>
            );
          })}
        </div>
      ) : null}

      {tab === "activity" ? (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {snapshot?.journal.map((entry) => (
            <Surface
              key={entry.seq}
              className="rounded-lg p-3 ring ring-kumo-line"
            >
              <div className="flex items-center justify-between gap-2">
                <Text size="xs" bold>
                  {entry.kind.replaceAll("_", " ")}
                </Text>
                <span className="text-[10px] text-kumo-inactive">
                  {shortTime(entry.createdAt)}
                </span>
              </div>
              <JsonBlock value={entry.data} />
            </Surface>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function App() {
  const [name, setName] = useState(getObjectName);
  const [prompt, setPrompt] = useState("");
  const [snapshot, setSnapshot] = useState<SelfModifyingSnapshot | null>(null);
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches
  );
  const endRef = useRef<HTMLDivElement>(null);
  const session = useHarnessSession<SelfModifyingProtocol>({
    agent: AGENT,
    name
  });
  const { connection, status, messages, events, live, error } = session;

  const connected = connection === "open";
  const busy =
    status !== null &&
    (status.state === "running" || status.queuedOperations > 0);
  const activity = useMemo(() => activityOf(events), [events]);
  // Every settled operation may have changed the source, the revision
  // pointer or the journal, so the host snapshot is read again.
  const settlements = events.filter(
    (event) => event.body.type === "operation_settled"
  ).length;

  const loadSnapshot = useCallback(async () => {
    const response = await fetch(
      `/agents/${AGENT}/${encodeURIComponent(name)}/snapshot`
    );
    if (!response.ok) return;
    setSnapshot((await response.json()) as SelfModifyingSnapshot);
  }, [name]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot, settlements]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, live?.text, events.length]);

  const send = (text = prompt) => {
    const trimmed = text.trim();
    if (trimmed === "" || busy || !connected) return;
    setPrompt("");
    void session.prompt(trimmed);
  };

  const newObject = () => {
    const next = `harness-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(OBJECT_KEY, next);
    const url = new URL(location.href);
    url.searchParams.delete("agent");
    history.replaceState(null, "", url);
    setSnapshot(null);
    setName(next);
  };

  // A running operation is a turn only when the transcript already carries
  // its user message; `activate` and the other submissions are not turns.
  const runningOperation =
    status?.state === "running" ? status.operationId : undefined;
  const runningTurn =
    runningOperation !== undefined &&
    messages.some(
      (message) =>
        message.role === "user" && operationOf(message.id) === runningOperation
    )
      ? runningOperation
      : undefined;
  const shownError = error === dismissed ? undefined : error;

  return (
    <div
      className={`grid h-dvh overflow-hidden bg-kumo-elevated text-kumo-default ${
        inspectorOpen
          ? "lg:grid-cols-[minmax(520px,1fr)_minmax(380px,38vw)]"
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
                  Self-modifying harness
                </h1>
                <p className="truncate text-xs text-kumo-subtle">
                  Object <code>{name}</code>
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge variant={connected ? "success" : "secondary"}>
                {connected
                  ? "Live"
                  : connection === "connecting"
                    ? "Connecting"
                    : "Reconnecting"}
              </Badge>
              <Button
                size="sm"
                variant="secondary"
                aria-expanded={inspectorOpen}
                onClick={() => setInspectorOpen((open) => !open)}
                icon={<CodeIcon size={15} />}
              >
                Revision {snapshot?.active.revisionId ?? "…"}
              </Button>
              <Button
                variant="ghost"
                shape="square"
                aria-label="New object"
                onClick={newObject}
                disabled={busy}
                icon={<PlusIcon size={16} />}
              />
              <ModeToggle />
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 px-5 py-6">
            {messages.length === 0 ? (
              <div className="py-10 sm:py-16">
                <Empty
                  icon={<CodeIcon size={32} />}
                  title="Ask it to change itself"
                  description="It can rewrite its own tools and activate a new revision."
                />
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <Button
                      key={suggestion.label}
                      variant="secondary"
                      size="sm"
                      disabled={!connected || busy}
                      onClick={() => setPrompt(suggestion.value)}
                    >
                      {suggestion.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {messages.map((message) =>
              message.role === "user" ? (
                <UserMessage key={message.id} text={messageText(message)} />
              ) : (
                <AssistantMessage
                  key={message.id}
                  text={messageText(message)}
                  activity={activity.get(operationOf(message.id))}
                  running={false}
                />
              )
            )}

            {runningTurn !== undefined ? (
              <AssistantMessage
                text={live?.text ?? ""}
                activity={activity.get(runningTurn)}
                running
              />
            ) : null}

            {shownError ? (
              <div
                role="alert"
                className="flex items-start justify-between gap-3 rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
              >
                <span>{shownError}</span>
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  aria-label="Dismiss"
                  onClick={() => setDismissed(shownError)}
                  icon={<XIcon size={14} />}
                />
              </div>
            ) : null}

            <div ref={endRef} />
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
                aria-label="Message the harness"
                placeholder="Ask it to create a tool or change its behavior"
                className="flex-1 !bg-transparent !shadow-none !ring-0 !outline-none focus:!ring-0"
              />
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                loading={busy}
                disabled={busy || !connected || prompt.trim() === ""}
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            </div>
          </form>
          <div className="flex items-center justify-center gap-2 px-5 py-3">
            <span className="hidden text-[10px] text-kumo-inactive sm:inline">
              Revision {snapshot?.active.revisionId ?? "…"} runs your next
              message
            </span>
            <span className="hidden text-kumo-line sm:inline">·</span>
            <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
          </div>
        </div>
      </section>

      {inspectorOpen ? (
        <Inspector
          snapshot={snapshot}
          busy={busy || !connected}
          onClose={() => setInspectorOpen(false)}
          onWrite={(path, content) => {
            void session.submit({
              kind: "write_source",
              payload: { path, content }
            });
          }}
          onActivate={(note) => {
            void session.submit({ kind: "activate", payload: { note } });
          }}
          onRestore={(revisionId) => {
            void session.submit({ kind: "restore", payload: { revisionId } });
          }}
        />
      ) : null}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
