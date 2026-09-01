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
import type {
  ChatResponse,
  TranscriptMessage,
  TranscriptPart
} from "./protocol";
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

function Message({ message }: { message: TranscriptMessage }) {
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
  const [messages, setMessages] = useState<readonly TranscriptMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);

  const endpoint = `/api/sessions/${encodeURIComponent(session)}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(endpoint)
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return (await response.json()) as readonly TranscriptMessage[];
      })
      .then((value) => {
        if (!cancelled) {
          setMessages(value);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || loading) return;
    setPrompt("");
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text })
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof payload === "object" &&
            payload !== null &&
            "error" in payload &&
            typeof payload.error === "string"
            ? payload.error
            : "Pi request failed"
        );
      }
      setMessages((payload as ChatResponse).messages);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const newSession = () => {
    const next = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, next);
    setSession(next);
    setMessages([]);
    setError(undefined);
  };

  return (
    <div className="min-h-screen bg-kumo-elevated text-kumo-default">
      <header className="border-b border-kumo-line bg-kumo-base px-5 py-4">
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

      <main className="mx-auto flex min-h-[calc(100vh-74px)] max-w-4xl flex-col gap-4 px-5 py-5">
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
                  Ask Pi to calculate, roll dice, read UTC time, or remember and
                  recall facts. Model calls and every tool intent/result are
                  persisted in the Durable Object.
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
              disabled={loading}
              onClick={() => setPrompt(example.value)}
            >
              {example.label}
            </Button>
          ))}
        </div>

        <Surface className="min-h-[24rem] flex-1 rounded-xl p-4 ring ring-kumo-line">
          {messages.length === 0 && !loading ? (
            <div className="flex min-h-72 items-center justify-center text-center text-sm text-kumo-subtle">
              Pick a prompt or ask Pi something that needs a tool.
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message) => (
                <Message key={message.id} message={message} />
              ))}
            </div>
          )}
          {loading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-kumo-subtle">
              <span className="loading-dot" />
              Pi is running. Tool calls will appear when the turn commits.
            </div>
          ) : null}
          <div ref={endRef} />
        </Surface>

        {error ? (
          <Surface className="rounded-xl p-3 text-sm text-kumo-danger ring ring-kumo-danger">
            {error}
          </Surface>
        ) : null}

        <form
          onSubmit={(event) => void submit(event)}
          className="flex items-end gap-3"
        >
          <label className="min-w-0 flex-1" htmlFor="prompt">
            <span className="sr-only">Message Pi</span>
            <Textarea
              id="prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Ask Pi to use a tool…"
              className="min-h-20 resize-y"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            disabled={loading || prompt.trim() === ""}
            icon={<PaperPlaneRightIcon size={16} />}
          >
            Send
          </Button>
        </form>

        <footer className="flex items-center justify-between gap-3 pb-2 text-xs text-kumo-subtle">
          <span>Session {session.slice(0, 8)}</span>
          <PoweredByCloudflare />
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
