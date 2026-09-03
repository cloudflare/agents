import {
  Badge,
  Button,
  PoweredByCloudflare,
  Surface,
  Text,
  Textarea
} from "@cloudflare/kumo";
import {
  BrainIcon,
  CalculatorIcon,
  ClockIcon,
  DiceFiveIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  SunIcon,
  WrenchIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import type { TranscriptMessage, TranscriptPart } from "./protocol";
import { usePiSession } from "./use-pi-session";
import "./styles.css";

const SESSION_KEY = "pi-harness-playground-session";
const MODEL = "@cf/moonshotai/kimi-k2.7-code";

function getSession(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, created);
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

function ToolPart({
  part
}: {
  part: Extract<TranscriptPart, { type: "tool-call" }>;
}) {
  return (
    <div className="tool-card">
      <div className="flex items-center gap-2 text-xs font-medium">
        <WrenchIcon size={14} />
        {part.name}
      </div>
      <pre>{JSON.stringify(part.arguments, null, 2)}</pre>
    </div>
  );
}

function ToolResult({
  part
}: {
  part: Extract<TranscriptPart, { type: "tool-result" }>;
}) {
  return (
    <div className={`tool-card ${part.error ? "tool-error" : ""}`}>
      <div className="flex items-center gap-2 text-xs font-medium">
        <WrenchIcon size={14} />
        {part.name} result
      </div>
      {part.content.map((content, index) =>
        content.type === "text" ? (
          <p key={index}>{content.text}</p>
        ) : (
          <img
            key={index}
            src={`data:${content.mimeType};base64,${content.data}`}
            alt={`${part.name} output`}
          />
        )
      )}
      {part.details !== undefined ? (
        <details>
          <summary>Details</summary>
          <pre>{JSON.stringify(part.details, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

function MessagePart({
  part,
  assistant
}: {
  part: TranscriptPart;
  assistant: boolean;
}) {
  switch (part.type) {
    case "text":
      return assistant ? (
        <Streamdown className="sd-theme" plugins={{ code }} controls={false}>
          {part.text}
        </Streamdown>
      ) : (
        <p className="whitespace-pre-wrap">{part.text}</p>
      );
    case "thinking":
      return (
        <details className="thinking">
          <summary>Thinking</summary>
          <p className="whitespace-pre-wrap">{part.text}</p>
        </details>
      );
    case "tool-call":
      return <ToolPart part={part} />;
    case "tool-result":
      return <ToolResult part={part} />;
  }
}

function Message({
  message,
  streaming = false
}: {
  message: TranscriptMessage;
  streaming?: boolean;
}) {
  const label =
    message.role === "user"
      ? "You"
      : message.role === "assistant"
        ? "Pi"
        : "Tool";
  return (
    <article className={`message message-${message.role}`}>
      <div className="message-label">{label}</div>
      <div className="space-y-3">
        {message.parts.map((part, index) => (
          <MessagePart
            key={`${message.id}-${index}`}
            part={part}
            assistant={message.role === "assistant"}
          />
        ))}
        {streaming ? <span className="streaming-cursor" /> : null}
        {message.error ? (
          <p className="text-kumo-danger">{message.error}</p>
        ) : null}
      </div>
    </article>
  );
}

const prompts = [
  {
    icon: <DiceFiveIcon size={15} />,
    label: "Roll 4d12 and total them",
    value: "Roll four 12-sided dice and tell me the total."
  },
  {
    icon: <CalculatorIcon size={15} />,
    label: "Calculate 47 × 19",
    value: "Use the calculator to multiply 47 by 19."
  },
  {
    icon: <BrainIcon size={15} />,
    label: "Remember a fact",
    value: "Remember that my favourite launch snack is stroopwafels."
  },
  {
    icon: <ClockIcon size={15} />,
    label: "What time is it?",
    value: "Use a tool to tell me the current UTC time."
  }
] satisfies Array<{ icon: ReactNode; label: string; value: string }>;

function App() {
  const [session, setSession] = useState(getSession);
  const [prompt, setPrompt] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const {
    status,
    messages,
    live,
    running,
    runningTools,
    error,
    submit: submitPrompt,
    abort
  } = usePiSession(session);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || running) return;
    setPrompt("");
    submitPrompt(text);
  };

  const newSession = () => {
    const next = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, next);
    setSession(next);
  };

  return (
    <div className="flex h-dvh flex-col bg-kumo-elevated text-kumo-default">
      <header className="shrink-0 border-b border-kumo-line bg-kumo-base px-5 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-kumo-accent p-2 text-white">
              <BrainIcon size={21} weight="bold" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Pi harness playground</h1>
              <p className="text-xs text-kumo-subtle">
                Durable Object + Lifecycle + pi AgentHarness
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{MODEL.split("/").at(-1)}</Badge>
            <Badge variant={status === "open" ? "success" : "secondary"}>
              {status === "open"
                ? "live"
                : status === "connecting"
                  ? "connecting…"
                  : "reconnecting…"}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              icon={<PlusIcon size={15} />}
              onClick={newSession}
            >
              New session
            </Button>
            <ModeToggle />
          </div>
        </div>
      </header>

      {/* Only this column scrolls; the header above and the input bar below
          stay pinned to the viewport regardless of transcript length. */}
      <main className="mx-auto flex w-full min-w-0 max-w-4xl flex-1 flex-col gap-4 overflow-hidden px-5 py-5">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <Surface className="rounded-xl p-4 ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="mt-0.5 shrink-0 text-kumo-accent"
              />
              <div>
                <Text size="sm" bold>
                  A real pi session on Workers AI
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    Ask Pi to calculate, roll dice, read UTC time, or remember
                    and recall facts. Model calls and every tool intent/result
                    are persisted in the Durable Object.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          <div className="flex flex-wrap gap-2">
            {prompts.map((example) => (
              <Button
                key={example.label}
                variant="secondary"
                size="sm"
                icon={example.icon}
                disabled={running}
                onClick={() => setPrompt(example.value)}
              >
                {example.label}
              </Button>
            ))}
          </div>

          <Surface className="min-h-72 rounded-xl p-4 ring ring-kumo-line">
            {messages.length === 0 && !live ? (
              <div className="flex min-h-64 items-center justify-center text-center text-sm text-kumo-subtle">
                Pick a prompt or ask Pi something that needs a tool.
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((message) => (
                  <Message key={message.id} message={message} />
                ))}
                {live ? <Message message={live} streaming /> : null}
              </div>
            )}
            {running ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-kumo-subtle">
                <span className="loading-dot" />
                {runningTools.length > 0
                  ? `Running ${runningTools.join(", ")}…`
                  : "Pi is running. Output streams in as it's generated."}
                <Button variant="ghost" size="sm" onClick={abort}>
                  Stop
                </Button>
              </div>
            ) : null}
            <div ref={endRef} />
          </Surface>

          {error ? (
            <Surface className="rounded-xl p-3 text-sm text-kumo-danger ring ring-kumo-danger">
              {error}
            </Surface>
          ) : null}
        </div>

        <form
          onSubmit={(event) => submit(event)}
          className="flex shrink-0 items-end gap-3"
        >
          <label className="min-w-0 flex-1" htmlFor="prompt">
            <span className="sr-only">Message Pi</span>
            <Textarea
              id="prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Ask Pi to use a tool…"
              className="min-h-20 w-full resize-y"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            disabled={running || prompt.trim() === ""}
            icon={<PaperPlaneRightIcon size={16} />}
          >
            Send
          </Button>
        </form>

        <footer className="flex shrink-0 items-center justify-between gap-3 pb-2 text-xs text-kumo-subtle">
          <span>Session {session.slice(0, 8)}</span>
          <PoweredByCloudflare />
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
