import "./styles.css";

import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
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
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  LinkIcon,
  MoonIcon,
  RobotIcon,
  SparkleIcon,
  SunIcon
} from "@phosphor-icons/react";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

type Action = "markdown" | "links" | "extract" | "screenshot" | "ask";

const ACTIONS: {
  id: Action;
  label: string;
  icon: typeof FileTextIcon;
  method: string;
}[] = [
  {
    id: "markdown",
    label: "Markdown",
    icon: FileTextIcon,
    method: "toMarkdown"
  },
  { id: "links", label: "Links", icon: LinkIcon, method: "links" },
  { id: "extract", label: "Extract", icon: SparkleIcon, method: "extract" },
  {
    id: "screenshot",
    label: "Screenshot",
    icon: ImageIcon,
    method: "screenshot"
  },
  { id: "ask", label: "Ask AI", icon: RobotIcon, method: "ask" }
];

const PROMPTING_ACTIONS: Action[] = ["extract", "ask"];

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";
  return (
    <output className="flex items-center gap-2">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className="text-xs text-kumo-subtle">{label}</span>
    </output>
  );
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
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

type Result =
  | { kind: "markdown"; text: string }
  | { kind: "links"; links: string[] }
  | { kind: "json"; value: unknown }
  | { kind: "image"; src: string }
  | { kind: "answer"; text: string; tools: string[] };

function ResultView({ result }: { result: Result }) {
  if (result.kind === "answer") {
    return (
      <div className="space-y-3">
        {result.tools.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Text size="xs" variant="secondary">
              Tools used:
            </Text>
            {result.tools.map((name) => (
              <Badge key={name} variant="secondary">
                {name}
              </Badge>
            ))}
          </div>
        )}
        <pre className="whitespace-pre-wrap wrap-break-word text-sm text-kumo-default">
          {result.text}
        </pre>
      </div>
    );
  }
  if (result.kind === "image") {
    return (
      <img
        src={result.src}
        alt="Screenshot of the page"
        className="max-w-full rounded-lg ring ring-kumo-line"
      />
    );
  }
  if (result.kind === "links") {
    return (
      <ul className="space-y-1">
        {result.links.map((link) => (
          <li key={link}>
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="text-kumo-accent break-all hover:underline"
            >
              <Text size="sm">{link}</Text>
            </a>
          </li>
        ))}
      </ul>
    );
  }
  const text =
    result.kind === "markdown"
      ? result.text
      : JSON.stringify(result.value, null, 2);
  return (
    <pre className="whitespace-pre-wrap wrap-break-word text-sm text-kumo-default">
      {text}
    </pre>
  );
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [url, setUrl] = useState("https://developers.cloudflare.com/agents/");
  const [prompt, setPrompt] = useState("List the main products on this page");
  const [action, setAction] = useState<Action>("markdown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const agent = useAgent({
    agent: "QuickActionsAgent",
    name: "default",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (event: Event) => console.error("Agent connection error", event),
      []
    )
  });

  const isConnected = connectionStatus === "connected";

  const run = useCallback(async () => {
    const target = url.trim();
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const args = PROMPTING_ACTIONS.includes(action)
        ? [target, prompt]
        : [target];
      const output = await agent.call(
        ACTIONS.find((a) => a.id === action)!.method,
        args
      );
      if (action === "markdown") {
        setResult({ kind: "markdown", text: output as string });
      } else if (action === "links") {
        setResult({ kind: "links", links: output as string[] });
      } else if (action === "screenshot") {
        setResult({ kind: "image", src: output as string });
      } else if (action === "ask") {
        const { answer, toolsUsed } = output as {
          answer: string;
          toolsUsed: string[];
        };
        setResult({ kind: "answer", text: answer, tools: toolsUsed });
      } else {
        setResult({ kind: "json", value: output });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [agent, action, url, prompt, busy]);

  return (
    <div className="flex min-h-screen flex-col bg-kumo-elevated text-kumo-default">
      <header className="border-b border-kumo-line bg-kumo-base px-5 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">Browser Quick Actions</h1>
            <Badge variant="secondary">
              <GlobeIcon size={12} weight="bold" className="mr-1" />
              Stateless browsing
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-4 px-5 py-6">
        <Surface className="rounded-xl p-4 ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={20}
              weight="bold"
              className="mt-0.5 shrink-0 text-kumo-accent"
            />
            <div>
              <Text size="sm" bold>
                One-shot browser tasks, no session required
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  Enter a URL and pick an action. The first four call a Browser
                  Run Quick Action directly through the BROWSER binding — read
                  the page as Markdown, list its links, extract structured data
                  with AI, or capture a screenshot. "Ask AI" instead hands those
                  same Quick Actions to a model as tools and lets it decide
                  which to call. No Durable Object, sandbox, or CDP session
                  involved.
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        <Surface className="space-y-4 rounded-xl p-4 ring ring-kumo-line">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            aria-label="URL to fetch"
          />

          <div className="flex flex-wrap gap-2">
            {ACTIONS.map((a) => {
              const Icon = a.icon;
              return (
                <Button
                  key={a.id}
                  variant={action === a.id ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => setAction(a.id)}
                  icon={<Icon size={14} weight="bold" />}
                >
                  {a.label}
                </Button>
              );
            })}
          </div>

          {PROMPTING_ACTIONS.includes(action) && (
            <InputArea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                action === "ask"
                  ? "Ask a question about the page..."
                  : "Describe what to extract..."
              }
              aria-label={
                action === "ask" ? "Question for the AI" : "Extraction prompt"
              }
              rows={2}
            />
          )}

          <Button
            variant="primary"
            onClick={run}
            disabled={!isConnected || busy}
            loading={busy}
          >
            {busy ? "Running..." : "Run"}
          </Button>
        </Surface>

        {error && (
          <Surface className="rounded-xl border border-red-500/40 p-4">
            <Text size="sm">{error}</Text>
          </Surface>
        )}

        {result ? (
          <Surface className="overflow-x-auto rounded-xl p-4 ring ring-kumo-line">
            <ResultView result={result} />
          </Surface>
        ) : (
          !error && (
            <Empty
              icon={<GlobeIcon size={24} />}
              title="No result yet"
              description="Pick an action and run it to see the output here."
            />
          )
        )}
      </main>

      <footer className="border-t border-kumo-line px-5 py-3">
        <div className="mx-auto flex max-w-4xl justify-center">
          <PoweredByCloudflare />
        </div>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
