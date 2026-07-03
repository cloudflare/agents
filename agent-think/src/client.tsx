/**
 * agent-think UI.
 *
 * `/` is the command center: a metrics dashboard for everything the agent is
 * doing, fed live from the singleton CommandCenterAgent's synced state. The
 * left sidebar lists every thread in reverse-chronological order (ChatGPT
 * style); picking one routes to `/thread/:session`, which connects to that
 * ThinkAgent Durable Object over the agents WebSocket and renders the live
 * message stream. It is a viewer: there is no input box, because runs are
 * driven by the GitHub `@agent-think` command, not the browser.
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

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <div className="metric__value">{value}</div>
      <div className="metric__label">{label}</div>
    </div>
  );
}

function CommandCenterView({
  threads,
  status,
  onOpen
}: {
  threads: ThreadMeta[];
  status: ConnectionStatus;
  onOpen: (session: string) => void;
}) {
  const running = threads.filter((t) => t.status === "running").length;
  const errored = threads.filter((t) => t.status === "error").length;
  const tools = threads.reduce((n, t) => n + t.tools, 0);
  const toolErrors = threads.reduce((n, t) => n + t.toolErrors, 0);
  const runs = threads.reduce((n, t) => n + t.runs, 0);
  const last = threads[0]?.updatedAt;

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
              <button
                key={t.session}
                className="run"
                onClick={() => onOpen(t.session)}
              >
                <span className={`run__dot run__dot--${t.status}`} />
                <span className="run__title">
                  {t.repo}#{t.issueNumber}
                </span>
                <span className="run__instruction">{t.instruction}</span>
                <span className="run__meta">
                  {t.tools} tools
                  {t.toolErrors > 0 ? ` · ${t.toolErrors} err` : ""} ·{" "}
                  {threadStatusLabel(t)} · {relativeTime(t.updatedAt)}
                </span>
              </button>
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

  const navigate = (to: string) => {
    window.history.pushState(null, "", to);
    setPath(to);
  };

  const session = sessionFromPath(path);
  const threads = Object.values(cc.threads).sort(
    (a, b) => b.updatedAt - a.updatedAt
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <button
          className={`sidebar__home ${session ? "" : "sidebar__home--active"}`}
          onClick={() => navigate("/")}
        >
          <span className="logo">◆</span> agent-think
        </button>

        <div className="sidebar__label">threads</div>
        <nav className="sidebar__list">
          {threads.length === 0 && (
            <div className="sidebar__empty">no threads yet</div>
          )}
          {threads.map((t) => (
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
              <span className="sidebar__item-snippet">{t.instruction}</span>
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
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
