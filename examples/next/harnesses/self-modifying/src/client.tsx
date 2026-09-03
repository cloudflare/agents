import {
  Badge,
  Banner,
  Button,
  Empty,
  Input,
  PoweredByCloudflare,
  Surface,
  Text,
  Textarea
} from "@cloudflare/kumo";
import {
  CodeIcon,
  InfoIcon,
  MoonIcon,
  SunIcon,
  XIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
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
import "./styles.css";

type Revision = {
  revisionId: number;
  sourceHash: string;
  parentRevisionId: number | null;
  note: string;
  createdAt: number;
};

type SourceFile = {
  path: string;
  size: number;
  updatedAt: number;
  content: string | null;
};

type ActiveSourceFile = {
  path: string;
  size: number;
  content: string;
};

type Turn = {
  turnId: string;
  streamId: string;
  revisionId: number;
  state: "queued" | "running" | "completed" | "failed";
  prompt: string;
  output: string | null;
  error: string | null;
  rounds: number | null;
  isolateRun: number | null;
  createdAt: number;
};

type JournalRecord = {
  seq: number;
  turnId: string | null;
  kind: string;
  data: Record<string, unknown>;
  createdAt: number;
};

type Snapshot = {
  active: Revision;
  activeFiles: ActiveSourceFile[];
  revisions: Revision[];
  files: SourceFile[];
  turns: Turn[];
  journal: JournalRecord[];
};

type TurnReceipt = {
  turnId: string;
  streamId: string;
  revisionId: number;
  accepted: boolean;
};

type InspectorTab = "code" | "revisions" | "activity";

const initialName = new URLSearchParams(location.search).get("agent") ?? "main";
const CREATE_TOOL_PROMPT =
  "Create a Custom tool named roll_die that accepts a number of sides and returns a random integer. Inspect your harness source, write the tool in a new file, and activate the new harness. Tell me the new revision when it is ready.";

function endpoint(agent: string, path: string): string {
  return `/api/objects/${encodeURIComponent(agent)}${path}`;
}

async function request<T>(
  agent: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(endpoint(agent, path), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers }
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return body;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function replaceTurn(snapshot: Snapshot, next: Turn): Snapshot {
  const found = snapshot.turns.some((turn) => turn.turnId === next.turnId);
  return {
    ...snapshot,
    turns: found
      ? snapshot.turns.map((turn) =>
          turn.turnId === next.turnId ? next : turn
        )
      : [next, ...snapshot.turns]
  };
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

function SelfModifyingHarnessApp() {
  const [agent, setAgent] = useState(initialName);
  const [agentDraft, setAgentDraft] = useState(initialName);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState(
    "src/tools/describe-self.ts"
  );
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches
  );
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("code");
  const conversationEnd = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await request<Snapshot>(agent, "/state");
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [agent]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ block: "end" });
  }, [sending, snapshot?.turns]);

  const selected = useMemo(
    () =>
      snapshot?.activeFiles.find((file) => file.path === selectedPath) ?? null,
    [selectedPath, snapshot]
  );

  const turns = useMemo(
    () => [...(snapshot?.turns ?? [])].reverse(),
    [snapshot?.turns]
  );

  async function submitPrompt(text: string): Promise<void> {
    const message = text.trim();
    if (message === "" || sending) return;
    setPrompt("");
    setSending(true);
    setError(null);
    try {
      const receipt = await request<TurnReceipt>(agent, "/turns", {
        method: "POST",
        body: JSON.stringify({ prompt: message, wait: false })
      });
      await refresh();

      for (let attempt = 0; attempt < 360; attempt++) {
        const turn = await request<Turn>(agent, `/turns/${receipt.turnId}`);
        setSnapshot((current) =>
          current ? replaceTurn(current, turn) : current
        );
        if (turn.state === "completed" || turn.state === "failed") break;
        await delay(500);
      }
      await refresh();
    } catch (cause) {
      setPrompt(message);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  function switchAgent() {
    const nextAgent = agentDraft.trim();
    if (nextAgent === "") return;
    const url = new URL(location.href);
    url.searchParams.set("agent", nextAgent);
    history.replaceState(null, "", url);
    setSnapshot(null);
    setError(null);
    setAgent(nextAgent);
  }

  return (
    <main
      className={`grid h-screen overflow-hidden bg-kumo-base text-kumo-default ${
        inspectorOpen
          ? "lg:grid-cols-[minmax(540px,1fr)_minmax(390px,38vw)]"
          : "grid-cols-1"
      }`}
    >
      <section className="flex min-h-0 min-w-0 flex-col" aria-label="Chat">
        <header className="flex min-h-18 items-center justify-between gap-3 border-b border-kumo-line px-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-kumo-contrast text-sm font-bold text-kumo-inverse">
              S
            </div>
            <div className="min-w-0">
              <Text bold>Self-modifying harness</Text>
              <div className="mt-1 flex items-center gap-2">
                <Text size="xs" variant="secondary">
                  Workers AI
                </Text>
                <Badge variant="secondary">fresh isolate per turn</Badge>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setInspectorTab("revisions");
                setInspectorOpen(true);
              }}
            >
              Revision {snapshot?.active.revisionId ?? "..."}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-expanded={inspectorOpen}
              onClick={() => setInspectorOpen((open) => !open)}
              icon={<CodeIcon size={15} />}
            >
              {inspectorOpen ? "Hide harness" : "View harness"}
            </Button>
            <ModeToggle />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto scroll-smooth px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-6" aria-live="polite">
            {turns.length === 0 && !sending ? (
              <div className="space-y-4 py-8">
                <Surface className="rounded-xl p-4 ring ring-kumo-line">
                  <div className="flex gap-3">
                    <InfoIcon
                      size={20}
                      weight="bold"
                      className="mt-0.5 shrink-0 text-kumo-accent"
                    />
                    <div>
                      <Text size="sm" bold>
                        The agent can rewrite its own harness
                      </Text>
                      <span className="mt-1 block">
                        <Text size="xs" variant="secondary">
                          System tools let it inspect source and activate a
                          revision. Custom tools are files it writes under
                          /harness/src/tools and run in the next turn isolate.
                        </Text>
                      </span>
                    </div>
                  </div>
                </Surface>
                <Empty
                  icon={<CodeIcon size={32} />}
                  title="Ask it to change itself"
                  description="Create a tool, change its identity, or inspect the active revision."
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    className="rounded-xl border border-kumo-line bg-kumo-base p-3 text-left text-sm hover:bg-kumo-elevated"
                    onClick={() => void submitPrompt(CREATE_TOOL_PROMPT)}
                  >
                    Create and activate a roll_die tool
                  </button>
                  <button
                    type="button"
                    className="rounded-xl border border-kumo-line bg-kumo-base p-3 text-left text-sm hover:bg-kumo-elevated"
                    onClick={() =>
                      void submitPrompt(
                        "Inspect your active harness and explain how you can modify yourself."
                      )
                    }
                  >
                    Explain the active harness
                  </button>
                </div>
              </div>
            ) : null}

            {turns.map((turn) => (
              <article className="space-y-3" key={turn.turnId}>
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 text-kumo-inverse">
                    <p className="whitespace-pre-wrap leading-relaxed">
                      {turn.prompt}
                    </p>
                    <div className="mt-1 text-right text-[10px] opacity-60">
                      {shortTime(turn.createdAt)}
                    </div>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <div className="grid size-7 shrink-0 place-items-center rounded-md bg-kumo-contrast text-xs font-bold text-kumo-inverse">
                    S
                  </div>
                  <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-elevated px-4 py-2.5 leading-relaxed">
                    {turn.output ? (
                      <Streamdown
                        className="sd-theme"
                        plugins={{ code }}
                        controls={false}
                      >
                        {turn.output}
                      </Streamdown>
                    ) : null}
                    {turn.error ? (
                      <p className="text-kumo-danger">{turn.error}</p>
                    ) : null}
                    {turn.state === "queued" || turn.state === "running" ? (
                      <div className="flex h-6 items-center gap-1 text-xs text-kumo-subtle">
                        Working on revision {turn.revisionId}...
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant="secondary">
                        revision {turn.revisionId}
                      </Badge>
                      {turn.rounds !== null ? (
                        <Badge variant="secondary">{turn.rounds} rounds</Badge>
                      ) : null}
                      <Badge variant="secondary">{turn.state}</Badge>
                    </div>
                  </div>
                </div>
              </article>
            ))}
            <div ref={conversationEnd} />
          </div>
        </div>

        {error ? (
          <div className="mx-auto mb-2 w-[calc(100%-2rem)] max-w-3xl">
            <Banner variant="error">{error}</Banner>
          </div>
        ) : null}

        <form
          className="mx-auto grid w-[calc(100%-2rem)] max-w-3xl grid-cols-[minmax(0,1fr)_auto] gap-2 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submitPrompt(prompt);
          }}
        >
          <Textarea
            aria-label="Message the self-modifying harness"
            placeholder="Ask it to create a tool or change its behavior"
            rows={2}
            value={prompt}
            disabled={sending}
            className="min-h-14 resize-y"
            onChange={(event) => setPrompt(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitPrompt(prompt);
              }
            }}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={sending || prompt.trim() === ""}
          >
            {sending ? "Working" : "Send"}
          </Button>
          <div className="col-span-2 text-center">
            <Text size="xs" variant="secondary">
              This message stays on revision{" "}
              {snapshot?.active.revisionId ?? "..."}. Activations apply to the
              next message.
            </Text>
          </div>
        </form>
      </section>

      <aside
        className={`${
          inspectorOpen ? "flex" : "hidden"
        } fixed inset-0 z-10 min-h-0 flex-col border-l border-kumo-line bg-kumo-base lg:static`}
        aria-label="Harness inspector"
      >
        <header className="flex min-h-18 items-center justify-between border-b border-kumo-line px-4">
          <div>
            <Text size="xs" variant="secondary">
              Active harness
            </Text>
            <div className="mt-1">
              <Text bold>Revision {snapshot?.active.revisionId ?? "..."}</Text>
            </div>
          </div>
          <Button
            variant="ghost"
            shape="square"
            aria-label="Close harness inspector"
            onClick={() => setInspectorOpen(false)}
            icon={<XIcon size={16} />}
          />
        </header>

        <nav
          className="grid grid-cols-3 border-b border-kumo-line"
          aria-label="Harness views"
        >
          {(["code", "revisions", "activity"] as const).map((tab) => (
            <button
              type="button"
              className={`border-b-2 px-3 py-2.5 text-xs capitalize ${
                inspectorTab === tab
                  ? "border-kumo-accent text-kumo-accent"
                  : "border-transparent text-kumo-subtle hover:bg-kumo-elevated"
              }`}
              key={tab}
              onClick={() => setInspectorTab(tab)}
            >
              {tab}
            </button>
          ))}
        </nav>

        {inspectorTab === "code" ? (
          <div className="grid min-h-0 flex-1 grid-cols-[145px_minmax(0,1fr)]">
            <nav
              className="overflow-y-auto border-r border-kumo-line bg-kumo-elevated p-1.5"
              aria-label="Active harness files"
            >
              {snapshot?.activeFiles.map((file) => (
                <button
                  type="button"
                  className={`mb-0.5 block w-full rounded-md p-2 text-left text-[11px] ${
                    file.path === selectedPath
                      ? "bg-kumo-base text-kumo-accent"
                      : "text-kumo-subtle hover:bg-kumo-base"
                  }`}
                  key={file.path}
                  onClick={() => setSelectedPath(file.path)}
                >
                  <span className="block break-words">{file.path}</span>
                  <span className="mt-0.5 block text-[9px] opacity-60">
                    {file.size} B
                  </span>
                </button>
              ))}
            </nav>
            <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-kumo-contrast text-kumo-inverse">
              <header className="flex items-center justify-between border-b border-kumo-line px-3 py-2 font-mono text-[11px] opacity-70">
                <span>/harness/{selectedPath}</span>
                <span>active revision</span>
              </header>
              <pre className="m-0 overflow-auto p-4 text-xs leading-relaxed">
                <code>{selected?.content ?? "Select a source file"}</code>
              </pre>
            </div>
          </div>
        ) : null}

        {inspectorTab === "revisions" ? (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {snapshot?.revisions.map((revision) => (
              <Surface
                className="rounded-lg p-3 ring ring-kumo-line"
                key={revision.revisionId}
              >
                <div className="flex items-center justify-between gap-2">
                  <Text size="sm" bold>
                    Revision {revision.revisionId}
                  </Text>
                  {revision.revisionId === snapshot.active.revisionId ? (
                    <Badge variant="secondary">active</Badge>
                  ) : null}
                </div>
                <div className="mt-2">
                  <Text size="xs" variant="secondary">
                    {revision.note}
                  </Text>
                </div>
                <code className="mt-2 block break-all font-mono text-[10px] text-kumo-subtle">
                  {revision.sourceHash}
                </code>
                <time className="mt-2 block text-[10px] text-kumo-subtle">
                  {dateTime(revision.createdAt)}
                </time>
              </Surface>
            ))}
          </div>
        ) : null}

        {inspectorTab === "activity" ? (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {snapshot?.journal.map((entry) => (
              <Surface
                className="rounded-lg p-3 ring ring-kumo-line"
                key={entry.seq}
              >
                <div className="flex items-center justify-between gap-2">
                  <Text size="xs" bold>
                    {entry.kind.replaceAll("_", " ")}
                  </Text>
                  <time className="text-[10px] text-kumo-subtle">
                    {shortTime(entry.createdAt)}
                  </time>
                </div>
                <code className="mt-2 block whitespace-pre-wrap break-words font-mono text-[10px] text-kumo-subtle">
                  {JSON.stringify(entry.data, null, 2)}
                </code>
              </Surface>
            ))}
          </div>
        ) : null}

        <footer className="border-t border-kumo-line p-3">
          <div className="mb-3 flex gap-2">
            <Input
              aria-label="Durable Object name"
              value={agentDraft}
              onChange={(event) => setAgentDraft(event.currentTarget.value)}
              onKeyDown={(event) => event.key === "Enter" && switchAgent()}
              className="min-w-0 flex-1"
            />
            <Button size="sm" variant="secondary" onClick={switchAgent}>
              Open
            </Button>
          </div>
          <PoweredByCloudflare />
        </footer>
      </aside>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <SelfModifyingHarnessApp />
  </StrictMode>
);
