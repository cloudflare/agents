/**
 * The browser half. Every harness example uses the same hook, so this file
 * is entirely about rendering: `useHarnessSession` supplies status, the
 * transcript, open requests and live token deltas, and the four buttons that
 * change anything call `prompt`, `interrupt` and `reply`.
 *
 * The one thing worth reading twice is the permission card. A permission is
 * a durable request, not a modal: it survives a reload, a Durable Object
 * eviction and a container restart, and it renders identically whether it
 * arrived in the snapshot or as a live `request_raised` event.
 */
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
  BrainIcon,
  CheckCircleIcon,
  FileTextIcon,
  GearIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  ShieldWarningIcon,
  StopIcon,
  SunIcon,
  TerminalWindowIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import { useHarnessSession } from "@cloudflare/agents-next-harness/react";
import type {
  HarnessRequest,
  HarnessStatus
} from "@cloudflare/agents-next-harness";
// The harness transcript is `SessionMessage`; the shared package does not
// re-export it. Type-only, so this never reaches the browser bundle.
import type { SessionMessage, SessionMessagePart } from "agents/sessions";
import type { ClaudeCodeProtocol } from "./claude-code-protocol";
import "./styles.css";

const SESSION_KEY = "claude-code-harness-session";

const SUGGESTIONS = [
  {
    icon: <FileTextIcon size={15} />,
    label: "List the workspace",
    value: "List the files in the workspace."
  },
  {
    icon: <PaperPlaneRightIcon size={15} />,
    label: "Write a haiku",
    value: "Create hello.txt containing a haiku about containers."
  },
  {
    icon: <TerminalWindowIcon size={15} />,
    label: "Run uname (asks)",
    value: "Run `uname -a` and tell me what you see."
  }
] satisfies Array<{ icon: ReactNode; label: string; value: string }>;

/** Reuse the id across reloads: a harness session outlives the page. */
async function getSession(): Promise<string> {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const response = await fetch("/api/session");
  const { session } = (await response.json()) as { session: string };
  localStorage.setItem(SESSION_KEY, session);
  return session;
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

function StatePill({ status }: { status: HarnessStatus | null }) {
  const state = status?.state ?? "idle";
  const variant =
    state === "running"
      ? "secondary"
      : state === "blocked"
        ? "destructive"
        : state === "retrying"
          ? "secondary"
          : "success";
  return <Badge variant={variant}>{state}</Badge>;
}

/** A tool call, rendered from its `tool-call` part. */
function ToolCallCard({
  part,
  running
}: {
  part: SessionMessagePart;
  running: boolean;
}) {
  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {running ? (
          <GearIcon size={14} className="animate-spin text-kumo-inactive" />
        ) : (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {part.toolName ?? "tool"}
        </span>
        <Badge variant="secondary">{running ? "Running" : "Called"}</Badge>
      </summary>
      <div className="border-t border-kumo-line px-3 py-3">
        <p className="mb-1 text-[10px] font-semibold tracking-wide text-kumo-inactive uppercase">
          Input
        </p>
        <JsonBlock value={part.input} />
      </div>
    </details>
  );
}

function ToolResultCard({ part }: { part: SessionMessagePart }) {
  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        <CheckCircleIcon size={14} className="text-kumo-success" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {part.toolName ?? "result"}
        </span>
        <Badge variant="secondary">Done</Badge>
      </summary>
      <div className="border-t border-kumo-line px-3 py-3">
        <JsonBlock value={part.output} />
      </div>
    </details>
  );
}

function Part({
  part,
  running
}: {
  part: SessionMessagePart;
  running: boolean;
}) {
  switch (part.type) {
    case "text":
      return (
        <Streamdown
          className="sd-theme text-sm leading-6"
          plugins={{ code }}
          controls={false}
        >
          {part.text ?? ""}
        </Streamdown>
      );
    case "reasoning":
      return (
        <details className="rounded-xl border border-kumo-line px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-semibold text-kumo-subtle">
            Thinking
          </summary>
          <p className="mt-2 text-xs leading-5 whitespace-pre-wrap italic text-kumo-subtle">
            {part.text ?? part.reasoning ?? ""}
          </p>
        </details>
      );
    case "tool-call":
      return <ToolCallCard part={part} running={running} />;
    case "tool-result":
      return <ToolResultCard part={part} />;
    default:
      return null;
  }
}

function Message({
  message,
  runningTools
}: {
  message: SessionMessage;
  runningTools: readonly string[];
}) {
  if (message.role === "user") {
    const text = message.parts
      .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
      .join("");
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-kumo-inverse">
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
        <BrainIcon size={17} weight="bold" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {message.parts.map((part, index) => (
          <Part
            key={`${message.id}-${index}`}
            part={part}
            running={
              part.type === "tool-call" &&
              part.toolCallId !== undefined &&
              runningTools.includes(part.toolCallId)
            }
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One open request. A permission is answered with allow or deny; a question
 * renders its options; anything else falls back to a plain acknowledgement.
 */
function RequestCard({
  request,
  onReply
}: {
  request: HarnessRequest;
  onReply: (requestId: string, decision: "allow" | "deny") => void;
}) {
  return (
    <Surface className="rounded-xl p-4 ring ring-kumo-warning">
      <div className="flex items-start gap-3">
        <ShieldWarningIcon size={18} className="mt-0.5 text-kumo-warning" />
        <div className="min-w-0 flex-1 space-y-2">
          {request.type === "permission" ? (
            <>
              <Text size="sm" bold>
                Allow {request.action}?
              </Text>
              {request.resources.length > 0 ? (
                <JsonBlock value={request.resources.join("\n")} />
              ) : null}
            </>
          ) : request.type === "question" ? (
            <>
              {request.questions.map((question) => (
                <div key={question.header} className="space-y-1">
                  <Text size="sm" bold>
                    {question.question}
                  </Text>
                  <ul className="list-disc pl-5 text-xs text-kumo-subtle">
                    {question.options.map((option) => (
                      <li key={option.label}>{option.label}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          ) : (
            <>
              <Text size="sm" bold>
                {request.type === "tool"
                  ? `Run the host tool ${request.toolName}?`
                  : `Answer ${request.type}`}
              </Text>
              <JsonBlock value={request} />
            </>
          )}
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              variant="primary"
              onClick={() => onReply(request.requestId, "allow")}
            >
              Allow
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onReply(request.requestId, "deny")}
            >
              Deny
            </Button>
          </div>
        </div>
      </div>
    </Surface>
  );
}

function App({ session }: { session: string }) {
  const [prompt, setPrompt] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const harness = useHarnessSession<ClaudeCodeProtocol>({
    agent: "claude-code-session",
    name: session
  });

  // `tool_start` opens an activity row and `tool_end` closes it; the
  // transcript itself is authoritative once the turn settles.
  const runningTools: string[] = [];
  for (const event of harness.events) {
    const body = event.body;
    if (body.type === "tool_start") runningTools.push(body.toolCallId);
    if (body.type === "tool_end") {
      const index = runningTools.indexOf(body.toolCallId);
      if (index >= 0) runningTools.splice(index, 1);
    }
  }

  const running =
    harness.status?.state === "running" || harness.status?.state === "retrying";
  const connected = harness.connection === "open";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [harness.messages, harness.live, harness.requests]);

  const send = () => {
    const text = prompt.trim();
    if (!text || !connected) return;
    setPrompt("");
    void harness.prompt(text);
  };

  const newSession = () => {
    localStorage.removeItem(SESSION_KEY);
    window.location.reload();
  };

  const empty =
    harness.messages.length === 0 &&
    !harness.live &&
    !running &&
    !harness.replaying;

  return (
    <div className="grid h-dvh grid-cols-1 overflow-hidden bg-kumo-elevated text-kumo-default">
      <section className="flex min-h-0 min-w-0 flex-col" aria-label="Chat">
        <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
          <div className="mx-auto flex h-[68px] max-w-3xl items-center justify-between gap-3 px-5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-kumo-brand text-white">
                <TerminalWindowIcon size={20} weight="bold" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold">
                  Claude Code harness
                </h1>
                <p className="truncate text-xs text-kumo-subtle">
                  Session <code>{session.slice(0, 8)}</code> · one container
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <StatePill status={harness.status} />
              <Badge variant={connected ? "success" : "secondary"}>
                {connected
                  ? "Live"
                  : harness.connection === "connecting"
                    ? "Connecting"
                    : "Reconnecting"}
              </Badge>
              <Button
                variant="ghost"
                shape="square"
                aria-label="New session"
                onClick={newSession}
                disabled={running}
                icon={<PlusIcon size={16} />}
              />
              <ModeToggle />
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
            {empty ? (
              <div className="py-10 sm:py-16">
                <Empty
                  icon={<TerminalWindowIcon size={32} />}
                  title="Claude Code, in a container, driven from here"
                  description="The workspace is /workspace inside the container. Tools that are not on the allow list ask first."
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

            {harness.messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                runningTools={runningTools}
              />
            ))}

            {harness.live &&
            (harness.live.text !== "" || harness.live.reasoning !== "") ? (
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
                  <BrainIcon size={17} weight="bold" />
                </div>
                <div className="min-w-0 flex-1 space-y-3">
                  {harness.live.reasoning ? (
                    <p className="text-xs leading-5 whitespace-pre-wrap italic text-kumo-subtle">
                      {harness.live.reasoning}
                    </p>
                  ) : null}
                  <Streamdown
                    className="sd-theme text-sm leading-6"
                    plugins={{ code }}
                    controls={false}
                  >
                    {harness.live.text}
                  </Streamdown>
                  <span className="streaming-cursor" />
                </div>
              </div>
            ) : null}

            {harness.requests.map((request) => (
              <RequestCard
                key={request.requestId}
                request={request}
                onReply={(requestId, decision) => {
                  void harness.reply(requestId, {
                    type: "permission",
                    decision
                  });
                }}
              />
            ))}

            {running && !harness.live ? (
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
                  <BrainIcon size={17} weight="bold" />
                </div>
                <Surface className="rounded-xl px-4 py-3 ring ring-kumo-line">
                  <div className="flex items-center gap-2 text-sm text-kumo-subtle">
                    <GearIcon size={15} className="animate-spin" />
                    {runningTools.length > 0
                      ? `Running ${runningTools.length} tool${runningTools.length === 1 ? "" : "s"}`
                      : "Waking the container"}
                  </div>
                </Surface>
              </div>
            ) : null}

            {harness.error ? (
              <div
                role="alert"
                className="flex items-center gap-2 rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
              >
                <XCircleIcon size={16} />
                {harness.error}
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
                placeholder="Ask Claude Code to change the workspace"
                aria-label="Message Claude Code"
                disabled={!connected}
                rows={2}
                className="flex-1 !bg-transparent !shadow-none !ring-0 !outline-none focus:!ring-0"
              />
              {running ? (
                <Button
                  type="button"
                  variant="secondary"
                  shape="square"
                  aria-label="Stop"
                  onClick={() => void harness.interrupt()}
                  icon={<StopIcon size={18} weight="fill" />}
                  className="mb-0.5"
                />
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

function Boot() {
  const [session, setSession] = useState<string | null>(null);
  useEffect(() => {
    void getSession().then(setSession);
  }, []);
  return session === null ? null : <App session={session} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<Boot />);
