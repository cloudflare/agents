/**
 * agent-think UI.
 *
 * `/` is the command center: a metrics dashboard for everything the agent is
 * doing, fed live from the singleton CommandCenterAgent's synced state. The
 * left sidebar lists every thread in reverse-chronological order (ChatGPT
 * style); picking one routes to `/thread/:session`, which connects to that
 * ThinkAgent Durable Object over the agents WebSocket and renders the live
 * message stream. New tasks are driven by the GitHub `@agent-think` command;
 * the command center can continue a failed durable run in place.
 */

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { CommandCenterState, ThreadMeta } from "./command-center";
import "./styles.css";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** `/thread/<session>` → `<session>`; anything else → null (command center). */
function sessionFromPath(path: string): string | null {
  const m = path.match(/^\/thread\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: "text"; text: string }).text)
    .join("");
}

function relativeTime(epochMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StatusDot({ status }: { status: ConnectionStatus }) {
  const label =
    status === "connected"
      ? "live"
      : status === "connecting"
        ? "connecting…"
        : "disconnected";
  return (
    <span className={`status status--${status}`}>
      <span className="status__dot" />
      {label}
    </span>
  );
}

function ToolPart({ part }: { part: Record<string, unknown> }) {
  const name = getToolName(part as never);
  const state = part.state as string;
  const input = part.input as Record<string, unknown> | undefined;
  const output = part.output as unknown;
  const errorText = part.errorText as string | undefined;
  const running = state === "input-available" || state === "input-streaming";
  return (
    <div className={`tool ${state === "output-error" ? "tool--error" : ""}`}>
      <div className="tool__head">
        <span className={`tool__spinner ${running ? "spin" : ""}`}>⚙</span>
        <span className="tool__name">
          {running ? `running ${name}…` : name}
        </span>
        <span className="tool__state">{state}</span>
      </div>
      {input != null && (
        <pre className="tool__block">{JSON.stringify(input, null, 2)}</pre>
      )}
      {errorText && (
        <pre className="tool__block tool__block--error">{errorText}</pre>
      )}
      {output != null && (
        <pre className="tool__block">
          {typeof output === "string"
            ? output
            : JSON.stringify(output, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Thread view (unchanged behavior, now inside the shell) ─────────

function ThreadView({ session }: { session: string }) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const endRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    // Kebab-case of the DO binding `ThinkAgent`.
    agent: "think-agent",
    name: session,
    onOpen: () => setStatus("connected"),
    onClose: () => setStatus("disconnected")
  });

  const { messages } = useAgentChat({ agent });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="app">
      <header className="header">
        <div className="header__title">
          <span className="header__session">{session}</span>
        </div>
        <StatusDot status={status} />
      </header>

      <main className="thread">
        {messages.length === 0 && (
          <div className="empty">Waiting for the agent to start…</div>
        )}

        {messages.map((message) => {
          if (message.role === "user") {
            // The kickoff instruction — show it as the thread's task.
            return (
              <div key={message.id} className="msg msg--task">
                <div className="msg__label">task</div>
                <div className="msg__body">{messageText(message)}</div>
              </div>
            );
          }
          return (
            <div key={message.id} className="msg msg--assistant">
              {message.parts.map((part, i) => {
                if (part.type === "text") {
                  const text = (part as { text: string }).text;
                  if (!text) return null;
                  return (
                    <div key={i} className="msg__body">
                      {text}
                    </div>
                  );
                }
                if (part.type === "reasoning") {
                  const text = (part as { text: string }).text;
                  if (!text) return null;
                  return (
                    <div key={i} className="reasoning">
                      {text}
                    </div>
                  );
                }
                if (isToolUIPart(part)) {
                  return (
                    <ToolPart
                      key={i}
                      part={part as unknown as Record<string, unknown>}
                    />
                  );
                }
                return null;
              })}
            </div>
          );
        })}
        <div ref={endRef} />
      </main>

      <footer className="footer">
        read-only view · driven by the GitHub command · powered by Cloudflare
        Workers
      </footer>
    </div>
  );
}

// ── Command center (the `/` route) ─────────────────────────────────

function threadStatusLabel(t: ThreadMeta): string {
  return t.status === "running"
    ? "running"
    : t.status === "error"
      ? "error"
      : "done";
}

function RequesterAvatar({ thread }: { thread: ThreadMeta }) {
  const by = thread.requestedBy;
  if (!by) return null;
  return (
    <span className="avatar" data-tip={`${by.login}: ${thread.instruction}`}>
      {by.avatarUrl ? (
        <img className="avatar__img" src={by.avatarUrl} alt={by.login} />
      ) : (
        <span className="avatar__fallback">
          {by.login.slice(0, 2).toUpperCase()}
        </span>
      )}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <div className="metric__value">{value}</div>
      <div className="metric__label">{label}</div>
    </div>
  );
}

interface RepoAgg {
  repo: string;
  issues: number;
  running: number;
  done: number;
  errored: number;
  updatedAt: number;
}

function aggregateRepos(threads: ThreadMeta[]): RepoAgg[] {
  const byRepo = new Map<string, RepoAgg>();
  for (const t of threads) {
    const agg = byRepo.get(t.repo) ?? {
      repo: t.repo,
      issues: 0,
      running: 0,
      done: 0,
      errored: 0,
      updatedAt: 0
    };
    agg.issues += 1;
    if (t.status === "running") agg.running += 1;
    else if (t.status === "error") agg.errored += 1;
    else agg.done += 1;
    agg.updatedAt = Math.max(agg.updatedAt, t.updatedAt);
    byRepo.set(t.repo, agg);
  }
  return [...byRepo.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function CommandCenterView({
  threads,
  status,
  onOpen,
  onContinue,
  continuing
}: {
  threads: ThreadMeta[];
  status: ConnectionStatus;
  onOpen: (session: string) => void;
  onContinue: (thread: ThreadMeta) => void;
  continuing: string | null;
}) {
  const running = threads.filter((t) => t.status === "running").length;
  const errored = threads.filter((t) => t.status === "error").length;
  const tools = threads.reduce((n, t) => n + t.tools, 0);
  const toolErrors = threads.reduce((n, t) => n + t.toolErrors, 0);
  const runs = threads.reduce((n, t) => n + t.runs, 0);
  const last = threads[0]?.updatedAt;
  const repos = aggregateRepos(threads);

  return (
    <div className="app app--wide">
      <header className="header">
        <div className="header__title">command center</div>
        <StatusDot status={status} />
      </header>

      <main className="center">
        <div className="metrics">
          <Metric label="active runs" value={running} />
          <Metric label="threads" value={threads.length} />
          <Metric label="dispatches" value={runs} />
          <Metric label="tool calls" value={tools} />
          <Metric label="tool errors" value={toolErrors} />
          <Metric label="failed threads" value={errored} />
        </div>

        {repos.length > 0 && (
          <>
            <div className="section__label">repos</div>
            <div className="repos">
              {repos.map((r) => (
                <a
                  key={r.repo}
                  className="repoCard"
                  href={`https://github.com/${r.repo}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <div className="repoCard__name">{r.repo}</div>
                  <div className="repoCard__url">github.com/{r.repo}</div>
                  <div className="repoCard__counts">
                    {r.issues} issue{r.issues === 1 ? "" : "s"}
                    {r.running > 0 ? ` · ${r.running} running` : ""}
                    {r.done > 0 ? ` · ${r.done} done` : ""}
                    {r.errored > 0 ? ` · ${r.errored} failed` : ""}
                  </div>
                </a>
              ))}
            </div>
          </>
        )}

        <div className="section__label">
          recent activity
          {last ? ` · last event ${relativeTime(last)}` : ""}
        </div>

        {threads.length === 0 ? (
          <div className="empty">
            Nothing yet. Mention <code>@agent-think</code> on a GitHub issue to
            start a run.
          </div>
        ) : (
          <div className="runs">
            {threads.map((t) => (
              <div key={t.session} className="run">
                <button className="run__open" onClick={() => onOpen(t.session)}>
                  <span className={`run__dot run__dot--${t.status}`} />
                  <span className="run__title">
                    {t.repo}#{t.issueNumber}
                  </span>
                  <span className="run__instruction">
                    {t.status === "error" && t.lastError
                      ? t.lastError
                      : (t.issueTitle ?? t.instruction)}
                  </span>
                  <RequesterAvatar thread={t} />
                  <span className="run__meta">
                    {t.tools} tools
                    {t.toolErrors > 0 ? ` · ${t.toolErrors} err` : ""} ·{" "}
                    {threadStatusLabel(t)} · {relativeTime(t.updatedAt)}
                  </span>
                </button>
                {t.status === "error" && (
                  <button
                    className="run__continue"
                    disabled={continuing === t.session}
                    onClick={() => onContinue(t)}
                  >
                    {continuing === t.session ? "Continuing…" : "Continue"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </main>

      <footer className="footer">
        runs are driven by <code>@agent-think</code> mentions on GitHub issues
      </footer>
    </div>
  );
}

// ── Shell: sidebar + routed main pane ──────────────────────────────

function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [ccStatus, setCcStatus] = useState<ConnectionStatus>("connecting");
  const [cc, setCc] = useState<CommandCenterState>({ threads: {} });
  const [query, setQuery] = useState("");
  const [continuing, setContinuing] = useState<string | null>(null);

  useAgent<CommandCenterState>({
    // Kebab-case of the DO binding `CommandCenter`; one shared instance.
    agent: "command-center",
    name: "main",
    onOpen: () => setCcStatus("connected"),
    onClose: () => setCcStatus("disconnected"),
    onStateUpdate: (state) => setCc(state)
  });

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // HTTP hydrate + poll fallback: load a snapshot immediately so the page
  // paints without waiting for the WS handshake, and keep polling while the
  // WS sync is not connected (the WS remains the low-latency path).
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch("/api/command-center");
        if (res.ok && !stop) setCc(await res.json());
      } catch {
        /* transient — next poll retries */
      }
    };
    void load();
    const timer = setInterval(() => {
      if (ccStatus !== "connected") void load();
    }, 10_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [ccStatus]);

  const navigate = (to: string) => {
    window.history.pushState(null, "", to);
    setPath(to);
  };

  const continueThread = async (thread: ThreadMeta) => {
    const accepted = window.confirm(
      "Continue this failed run using its existing transcript and workspace?"
    );
    if (!accepted) return;
    setContinuing(thread.session);
    try {
      const response = await fetch(
        `/api/command-center/continue/${encodeURIComponent(thread.session)}`,
        { method: "POST" }
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Continuation failed");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setContinuing(null);
    }
  };

  const session = sessionFromPath(path);
  const threads = Object.values(cc.threads).sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  const q = query.trim().toLowerCase();
  const visibleThreads = q
    ? threads.filter((t) =>
        `${t.repo}#${t.issueNumber} ${t.instruction}`.toLowerCase().includes(q)
      )
    : threads;

  return (
    <div className="shell">
      <aside className="sidebar">
        <button
          className={`sidebar__home ${session ? "" : "sidebar__home--active"}`}
          onClick={() => navigate("/")}
        >
          <span className="logo">◆</span> Agent Think
        </button>

        <input
          className="sidebar__search"
          type="search"
          placeholder="Search threads"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="sidebar__label">recents</div>
        <nav className="sidebar__list">
          {visibleThreads.length === 0 && (
            <div className="sidebar__empty">
              {threads.length === 0 ? "no threads yet" : "no matches"}
            </div>
          )}
          {visibleThreads.map((t) => (
            <button
              key={t.session}
              className={`sidebar__item ${
                session === t.session ? "sidebar__item--active" : ""
              }`}
              onClick={() => navigate(`/thread/${t.session}`)}
            >
              <span className="sidebar__item-row">
                <span className={`run__dot run__dot--${t.status}`} />
                <span className="sidebar__item-title">
                  {t.repo.split("/")[1] ?? t.repo}#{t.issueNumber}
                </span>
                <span className="sidebar__item-time">
                  {relativeTime(t.updatedAt)}
                </span>
              </span>
              <span className="sidebar__item-snippet">
                {t.status === "error" && t.lastError
                  ? t.lastError
                  : (t.issueTitle ?? t.instruction)}
              </span>
            </button>
          ))}
        </nav>

        <div className="sidebar__foot">
          <StatusDot status={ccStatus} />
        </div>
      </aside>

      {session ? (
        <ThreadView key={session} session={session} />
      ) : (
        <CommandCenterView
          threads={threads}
          status={ccStatus}
          onOpen={(s) => navigate(`/thread/${s}`)}
          onContinue={(thread) => void continueThread(thread)}
          continuing={continuing}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
