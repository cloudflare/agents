import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface
} from "@cloudflare/kumo";
import {
  BrainIcon,
  CheckCircleIcon,
  GearIcon,
  GlobeIcon,
  ListIcon,
  MoonIcon,
  NotePencilIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  StopIcon,
  SunIcon,
  TerminalWindowIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import type { OpenCodeMessage } from "agents/harness/opencode";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import { useOpenCodeSession, type LiveText } from "./use-opencode-session";
import "./styles.css";

const OBJECT_KEY = "opencode-harness-object";
const SESSION_KEY = "opencode-harness-session";
const ROOT_SESSION = "ses_root";
const MODEL = "@cf/moonshotai/kimi-k2.7-code";

const SUGGESTIONS = [
  {
    icon: <NotePencilIcon size={15} />,
    label: "Save a note",
    value:
      "Save a note titled 'durable objects' with three facts about Durable Objects, then list my notes."
  },
  {
    icon: <GlobeIcon size={15} />,
    label: "Fetch a page",
    value:
      "Fetch https://developers.cloudflare.com/durable-objects/ and summarize it in three bullets."
  },
  {
    icon: <TerminalWindowIcon size={15} />,
    label: "What can you do?",
    value: "Which tools do you have here, and what can't you do?"
  }
] satisfies Array<{ icon: ReactNode; label: string; value: string }>;

type Assistant = Extract<OpenCodeMessage, { type: "assistant" }>;
type AssistantPart = Assistant["content"][number];
type ToolPart = Extract<AssistantPart, { type: "tool" }>;

/** This browser's Durable Object: one per browser, kept across reloads. */
function getObject(): string {
  const existing = localStorage.getItem(OBJECT_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(OBJECT_KEY, created);
  return created;
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

function Block({ value }: { value: unknown }) {
  return (
    <pre className="max-h-48 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function toolOutput(part: ToolPart): string {
  const state = part.state;
  if (state.status === "completed" || state.status === "error") {
    return (state.content ?? [])
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("\n");
  }
  return "";
}

function ToolCard({ part }: { part: ToolPart }) {
  const { status } = part.state;
  const output = toolOutput(part);
  const failed = status === "error";
  const done = status === "completed";
  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {failed ? (
          <XCircleIcon size={14} className="text-kumo-danger" />
        ) : done ? (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        ) : (
          <GearIcon size={14} className="animate-spin text-kumo-inactive" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-semibold">{part.name}</span>
          {output ? (
            <span className="ml-2 text-kumo-subtle">{output}</span>
          ) : null}
        </span>
        <Badge variant={failed ? "destructive" : "secondary"}>
          {failed ? "Failed" : done ? "Done" : "Running"}
        </Badge>
      </summary>
      <div className="space-y-3 border-t border-kumo-line px-3 py-3">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
            Input
          </p>
          <Block value={part.state.input} />
        </div>
        {output ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Output
            </p>
            <Block value={output} />
          </div>
        ) : null}
        {part.state.status === "error" ? (
          <Block value={part.state.error.message} />
        ) : null}
      </div>
    </details>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <Streamdown
      className="sd-theme text-sm leading-6"
      plugins={{ code }}
      controls={false}
    >
      {text}
    </Streamdown>
  );
}

function Reasoning({ text }: { text: string }) {
  return (
    <details className="rounded-xl border border-kumo-line px-3 py-2">
      <summary className="cursor-pointer list-none text-xs font-semibold text-kumo-subtle">
        Thinking
      </summary>
      <p className="mt-2 whitespace-pre-wrap text-xs italic leading-5 text-kumo-subtle">
        {text}
      </p>
    </details>
  );
}

function Avatar() {
  return (
    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
      <BrainIcon size={17} weight="bold" />
    </div>
  );
}

function AssistantMessage({
  message,
  live
}: {
  message: Assistant;
  live: LiveText | undefined;
}) {
  const streaming = message.time.completed === undefined;
  const hasText = message.content.some(
    (part) => part.type === "text" && part.text !== ""
  );
  return (
    <div className="flex items-start gap-3">
      <Avatar />
      <div className="min-w-0 flex-1 space-y-3">
        {live?.reasoning &&
        !message.content.some((part) => part.type === "reasoning") ? (
          <Reasoning text={live.reasoning} />
        ) : null}
        {message.content.map((part, index) => {
          const key = `${message.id}-${index}`;
          switch (part.type) {
            case "text":
              return part.text ? <Markdown key={key} text={part.text} /> : null;
            case "reasoning":
              return part.text ? (
                <Reasoning key={key} text={part.text} />
              ) : null;
            case "tool":
              return <ToolCard key={key} part={part} />;
          }
        })}
        {live?.text && !hasText ? <Markdown text={live.text} /> : null}
        {streaming ? <span className="streaming-cursor" /> : null}
        {message.error ? (
          <div
            role="alert"
            className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
          >
            {message.error.message}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Message({
  message,
  live
}: {
  message: OpenCodeMessage;
  live: Readonly<Record<string, LiveText>>;
}) {
  switch (message.type) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 text-sm leading-relaxed text-kumo-inverse">
            {message.text}
          </div>
        </div>
      );
    case "assistant":
      return <AssistantMessage message={message} live={live[message.id]} />;
    case "synthetic":
      return (
        <p className="text-center text-xs text-kumo-inactive">
          {message.description ?? message.text}
        </p>
      );
    case "compaction":
      return (
        <p className="text-center text-xs text-kumo-inactive">
          {message.status === "running"
            ? "Summarizing earlier messages…"
            : message.status === "failed"
              ? "Summarizing earlier messages failed"
              : "Earlier messages were summarized for the model"}
        </p>
      );
    case "idle":
      return message.outcome === "succeeded" ? null : (
        <p className="text-center text-xs text-kumo-inactive">
          Run {message.outcome}
        </p>
      );
    default:
      return null;
  }
}

function App() {
  const [object] = useState(getObject);
  const [session, setSession] = useState(
    () => localStorage.getItem(SESSION_KEY) ?? ROOT_SESSION
  );
  const [prompt, setPrompt] = useState("");
  const [sessionsOpen, setSessionsOpen] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches
  );
  const endRef = useRef<HTMLDivElement>(null);
  const {
    status,
    messages,
    busy,
    pending,
    sessions,
    live,
    error,
    submit: submitPrompt,
    abort,
    create
  } = useOpenCodeSession(object, session, () => {
    // A session this object does not have, such as one from an old
    // deployment: fall back to the root session.
    localStorage.setItem(SESSION_KEY, ROOT_SESSION);
    setSession(ROOT_SESSION);
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, busy]);

  const connected = status === "open";
  const queued = pending.filter((operation) => operation.status === "queued");

  const choose = (next: string) => {
    localStorage.setItem(SESSION_KEY, next);
    setSession(next);
  };

  /** While a run is going, Enter queues a follow-up and Steer joins the run. */
  const submit = (whenBusy: "followUp" | "steer" = "followUp") => {
    const text = prompt.trim();
    if (!text || !connected) return;
    setPrompt("");
    submitPrompt(text, whenBusy);
  };

  // Live text for an assistant message no snapshot has yet.
  const unseen = Object.entries(live).filter(
    ([id]) => !messages.some((message) => message.id === id)
  );
  const visible = messages.filter(
    (message) => message.type !== "idle" || message.outcome !== "succeeded"
  );
  const empty = visible.length === 0 && unseen.length === 0 && !busy;
  const waiting =
    busy &&
    unseen.length === 0 &&
    !messages.some(
      (message) =>
        message.type === "assistant" && message.time.completed === undefined
    );

  return (
    <div
      className={`grid h-dvh overflow-hidden bg-kumo-elevated text-kumo-default ${
        sessionsOpen
          ? "lg:grid-cols-[minmax(220px,18vw)_minmax(520px,1fr)]"
          : "grid-cols-1"
      }`}
    >
      {sessionsOpen ? (
        <aside
          className="flex min-h-0 flex-col border-r border-kumo-line bg-kumo-base"
          aria-label="Sessions"
        >
          <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
            <span className="text-sm font-semibold">Sessions</span>
            <Button
              variant="ghost"
              shape="square"
              aria-label="New session"
              disabled={!connected}
              onClick={() => {
                void create().then(choose);
              }}
              icon={<PlusIcon size={16} />}
            />
          </div>
          <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {sessions.map((info) => (
              <button
                type="button"
                key={info.id}
                onClick={() => choose(info.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs ${
                  info.id === session
                    ? "bg-kumo-elevated font-semibold"
                    : "hover:bg-kumo-elevated"
                }`}
              >
                {info.busy ? (
                  <GearIcon size={12} className="animate-spin" />
                ) : (
                  <span className="size-3" />
                )}
                <span className="truncate">
                  {info.title ??
                    (info.id === ROOT_SESSION ? "root" : info.id.slice(-10))}
                </span>
                {info.parent ? (
                  <span className="text-kumo-inactive">fork</span>
                ) : null}
              </button>
            ))}
          </nav>
        </aside>
      ) : null}

      <section className="flex min-h-0 min-w-0 flex-col" aria-label="Chat">
        <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
          <div className="mx-auto flex h-[68px] max-w-3xl items-center justify-between gap-3 px-5">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                variant="ghost"
                shape="square"
                aria-label="Sessions"
                aria-expanded={sessionsOpen}
                onClick={() => setSessionsOpen((open) => !open)}
                icon={<ListIcon size={16} />}
              />
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold">
                  OpenCode harness
                </h1>
                <p className="truncate text-xs text-kumo-subtle">
                  Session <code>{session}</code>
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge variant="secondary" className="hidden sm:inline-flex">
                {MODEL.split("/").at(-1)}
              </Badge>
              <Badge variant={connected ? "success" : "secondary"}>
                {connected
                  ? "Live"
                  : status === "connecting"
                    ? "Connecting"
                    : "Reconnecting"}
              </Badge>
              <ModeToggle />
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
            {empty ? (
              <div className="py-10 sm:py-16">
                <Empty
                  icon={<BrainIcon size={32} />}
                  title="OpenCode, in a Durable Object"
                  description="Sessions survive eviction; text and tool calls stream in as they happen."
                />
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <Button
                      key={suggestion.label}
                      variant="secondary"
                      size="sm"
                      icon={suggestion.icon}
                      disabled={!connected}
                      onClick={() => setPrompt(suggestion.value)}
                    >
                      {suggestion.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {visible.map((message) => (
              <Message key={message.id} message={message} live={live} />
            ))}

            {unseen.map(([id, text]) => (
              <div key={id} className="flex items-start gap-3">
                <Avatar />
                <div className="min-w-0 flex-1 space-y-3">
                  {text.reasoning ? <Reasoning text={text.reasoning} /> : null}
                  {text.text ? <Markdown text={text.text} /> : null}
                  <span className="streaming-cursor" />
                </div>
              </div>
            ))}

            {waiting ? (
              <div className="flex items-start gap-3">
                <Avatar />
                <Surface className="rounded-xl px-4 py-3 ring ring-kumo-line">
                  <div className="flex items-center gap-2 text-sm text-kumo-subtle">
                    <GearIcon size={15} className="animate-spin" />
                    Waiting for the model
                  </div>
                </Surface>
              </div>
            ) : null}

            {queued.length > 0 ? (
              <p className="ml-11 text-xs text-kumo-subtle">
                {queued.length} queued behind this run
              </p>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
              >
                {error}
              </div>
            ) : null}

            <div ref={endRef} />
          </div>
        </main>

        <div className="shrink-0 border-t border-kumo-line bg-kumo-base">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
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
                    submit();
                  }
                }}
                placeholder={
                  busy
                    ? "Queue a follow-up, or steer the running turn"
                    : "Ask OpenCode something"
                }
                aria-label="Message OpenCode"
                disabled={!connected}
                rows={2}
                className="flex-1 !bg-transparent !shadow-none !ring-0 !outline-none focus:!ring-0"
              />
              {busy ? (
                <div className="mb-0.5 flex gap-1.5">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="Steer"
                    disabled={prompt.trim() === ""}
                    onClick={() => submit("steer")}
                  >
                    Steer
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop"
                    onClick={abort}
                    icon={<StopIcon size={18} weight="fill" />}
                  />
                </div>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Send message"
                  disabled={!connected || prompt.trim() === ""}
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
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
