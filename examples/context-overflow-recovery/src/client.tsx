import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import {
  ArrowsInIcon,
  ChatCircleTextIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  StackPlusIcon,
  SunIcon,
  TrashIcon
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Empty,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import "./styles.css";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

type CompactionEntry = {
  at: number;
  removed: number;
  reason: string;
};

function truncate(value: string, max = 280): string {
  return value.length > max ? `${value.slice(0, max)} …[truncated]` : value;
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

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("Hi! Tell me a short fun fact.");
  const [compactions, setCompactions] = useState<CompactionEntry[]>([]);
  const [fillerCount, setFillerCount] = useState(0);

  const agent = useAgent({
    agent: "ContextOverflowAgent",
    name: "demo",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback((event: Event) => {
      console.error("Agent connection error", event);
      setConnectionStatus("disconnected");
    }, [])
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming" || status === "submitted";

  const refreshCompactions = useCallback(() => {
    agent
      .call("getCompactionLog", [])
      .then((result) => setCompactions(result as CompactionEntry[]))
      .catch((error) => console.error("Failed to load compaction log", error));
  }, [agent]);

  // Poll the compaction log whenever a turn settles, so recovery events show up.
  useEffect(() => {
    if (status === "ready") refreshCompactions();
  }, [status, refreshCompactions]);

  function send() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }

  // Inflate the stored history with a large background "document" exchange
  // (server-side, no model turn). After a few of these, a normal small chat
  // message overflows the window and triggers recovery — which can summarize the
  // bulky background while keeping the live message.
  async function addFiller() {
    if (isStreaming) return;
    try {
      await agent.call("addFillerExchange", []);
      setFillerCount((n) => n + 1);
    } catch (error) {
      console.error("Failed to add filler context", error);
    }
  }

  async function reset() {
    await clearHistory();
    await agent.call("clearCompactionLog", []).catch(() => {});
    setCompactions([]);
    setFillerCount(0);
  }

  return (
    <main className="min-h-screen bg-kumo-base text-kumo-default">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <Text size="lg" bold>
              Context-Overflow Recovery
            </Text>
            <span className="mt-1 block">
              <Text size="sm" variant="secondary">
                A Think agent that compacts and recovers when a turn outgrows
                the model's context window.
              </Text>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
          </div>
        </header>

        <Surface className="rounded-xl p-4 ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={20}
              weight="bold"
              className="mt-0.5 shrink-0 text-kumo-accent"
            />
            <div>
              <Text size="sm" bold>
                What this demo shows
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  The agent sets `contextOverflow` (a proactive guard plus a
                  reactive backstop) and the bundled
                  `defaultContextOverflowClassifier`. Click "Add background
                  document" 3+ times to stuff the stored history, then send a
                  normal message: it overflows the model's ~8K window, and
                  instead of failing, Think compacts the bulky history and
                  answers anyway. Each recovery appears in the Compactions
                  panel.
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        <section className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <Surface className="flex min-h-128 flex-col rounded-xl ring ring-kumo-line">
            <div className="border-b border-kumo-line p-4">
              <Text size="sm" bold>
                Chat
              </Text>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-center">
                  <div>
                    <ChatCircleTextIcon
                      size={32}
                      className="mx-auto text-kumo-subtle"
                    />
                    <span className="mt-2 block">
                      <Text size="sm" variant="secondary">
                        Add a few background documents, then send a normal
                        message to trigger recovery.
                      </Text>
                    </span>
                  </div>
                </div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={`rounded-xl border border-kumo-line p-3 ${
                      message.role === "user"
                        ? "bg-kumo-surface"
                        : "bg-kumo-elevated"
                    }`}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <Badge>{message.role}</Badge>
                    </div>
                    <div className="space-y-2">
                      {(message.parts ?? []).map((part, index) =>
                        part.type === "text" && part.text ? (
                          <pre
                            key={index}
                            className="whitespace-pre-wrap font-sans text-sm text-kumo-default"
                          >
                            {truncate(part.text)}
                          </pre>
                        ) : null
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-kumo-line p-4">
              <textarea
                aria-label="Message"
                className="min-h-20 w-full rounded-lg border border-kumo-line bg-kumo-surface p-3 text-sm outline-none"
                value={input}
                onChange={(event) => setInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    send();
                  }
                }}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  disabled={isStreaming || input.trim().length === 0}
                  onClick={send}
                  icon={<PaperPlaneRightIcon size={16} />}
                >
                  Send
                </Button>
                <Button
                  variant="secondary"
                  disabled={isStreaming}
                  onClick={addFiller}
                  icon={<StackPlusIcon size={16} />}
                >
                  {fillerCount > 0
                    ? `Add background document (${fillerCount} added)`
                    : "Add background document"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={reset}
                  icon={<TrashIcon size={16} />}
                >
                  Reset
                </Button>
              </div>
            </div>
          </Surface>

          <aside className="space-y-4">
            <Surface className="rounded-xl p-4 ring ring-kumo-line">
              <div className="mb-3 flex items-center gap-2">
                <ArrowsInIcon size={18} className="text-kumo-accent" />
                <Text size="sm" bold>
                  Compactions
                </Text>
              </div>
              {compactions.length === 0 ? (
                <Empty
                  title="No compactions yet"
                  description="Grow the context until a turn would overflow."
                />
              ) : (
                <div className="space-y-2">
                  {compactions.map((entry, index) => (
                    <div
                      key={index}
                      className="rounded-lg border border-kumo-line p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Text size="sm" bold>
                          Recovered
                        </Text>
                        <Badge>{`-${entry.removed} msg`}</Badge>
                      </div>
                      <span className="mt-1 block">
                        <Text size="xs" variant="secondary">
                          {new Date(entry.at).toLocaleTimeString()}
                        </Text>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Surface>
          </aside>
        </section>

        <footer className="flex justify-center">
          <PoweredByCloudflare />
        </footer>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
