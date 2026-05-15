import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
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
  ArrowClockwiseIcon,
  CodeIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PresentationChartIcon,
  StopIcon,
  SunIcon,
  TrashIcon
} from "@phosphor-icons/react";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SlideDeckState } from "./server";
import "./styles.css";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

const STORAGE_KEY = "think-slide-deck-user-id";

function getUserId() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}

function getMessageText(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
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
      ? "bg-kumo-success"
      : status === "connecting"
        ? "bg-kumo-warning"
        : "bg-kumo-danger";
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

function ToolCallPart({ part }: { part: Parameters<typeof getToolName>[0] }) {
  const name = getToolName(part);
  return (
    <div className="flex justify-start">
      <Badge variant="secondary">
        <CodeIcon size={12} className="mr-1" />
        {name}
      </Badge>
    </div>
  );
}

function SourcePanel({ state }: { state: SlideDeckState }) {
  const entries = Object.entries(state.sourceFiles ?? {});
  if (entries.length === 0) {
    return (
      <Empty
        icon={<CodeIcon size={24} />}
        title="No source yet"
        description="Ask the agent to create or build a slide deck."
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3">
      {entries.map(([path, content]) => (
        <details
          key={path}
          className="rounded-lg border border-kumo-line bg-kumo-elevated"
        >
          <summary className="cursor-pointer px-3 py-2 text-xs font-mono text-kumo-default">
            {path}
          </summary>
          <pre className="max-h-72 overflow-auto border-t border-kumo-line p-3 text-xs leading-relaxed">
            {content}
          </pre>
        </details>
      ))}
    </div>
  );
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [deckState, setDeckState] = useState<SlideDeckState | null>(null);
  const [panel, setPanel] = useState<"preview" | "source">("preview");
  const [previewKey, setPreviewKey] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasOpenedFirstPreviewRef = useRef(false);
  const userId = useMemo(getUserId, []);

  const agent = useAgent({
    agent: "SlideDeckAgent",
    name: userId,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback((event: Event) => {
      console.error("Agent connection error", event);
      setConnectionStatus("disconnected");
    }, []),
    onStateUpdate: useCallback((state: SlideDeckState) => {
      setDeckState(state);
      setActionError(state.error ?? null);
      if (state?.built) {
        setPreviewKey((key) => key + 1);
        if (!hasOpenedFirstPreviewRef.current) {
          hasOpenedFirstPreviewRef.current = true;
          setPanel("preview");
        }
      }
    }, [])
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent
  });
  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";
  const previewUrl =
    deckState?.built === true
      ? `/preview/${encodeURIComponent(userId)}/?v=${deckState.previewVersion}&k=${previewKey}`
      : null;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  const rebuild = useCallback(async () => {
    setIsBuilding(true);
    setActionError(null);
    try {
      const state = (await agent.call("buildDeck", [])) as SlideDeckState;
      setDeckState(state);
      setPreviewKey((key) => key + 1);
      if (state.error) setActionError(state.error);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBuilding(false);
    }
  }, [agent]);

  const reset = useCallback(async () => {
    setIsResetting(true);
    setActionError(null);
    try {
      const state = (await agent.call("resetDeck", [])) as SlideDeckState;
      clearHistory();
      setDeckState(state);
      setPreviewKey((key) => key + 1);
      setPanel("preview");
      hasOpenedFirstPreviewRef.current = true;
      if (state.error) setActionError(state.error);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsResetting(false);
    }
  }, [agent, clearHistory]);

  return (
    <main className="flex h-screen flex-col bg-kumo-elevated text-kumo-default">
      <header className="border-b border-kumo-line bg-kumo-base px-5 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <PresentationChartIcon
              size={24}
              weight="bold"
              className="text-kumo-accent"
            />
            <div>
              <Text size="lg" bold>
                Think Slide Deck
              </Text>
              <span className="block">
                <Text size="xs" variant="secondary">
                  Durable workspace, Think agent, Worker Bundler preview.
                </Text>
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="secondary"
              icon={<ArrowClockwiseIcon size={16} />}
              disabled={!isConnected || isBuilding || isResetting}
              onClick={() => void rebuild()}
            >
              {isBuilding ? "Building..." : "Build"}
            </Button>
            <Button
              variant="ghost"
              icon={<TrashIcon size={16} />}
              disabled={!isConnected || isBuilding || isResetting}
              onClick={() => void reset()}
            >
              {isResetting ? "Resetting..." : "Reset"}
            </Button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col lg:w-[420px] lg:flex-none xl:w-[460px]">
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
              {messages.length === 0 && (
                <div className="space-y-4">
                  <Surface className="rounded-xl p-4 ring ring-kumo-line">
                    <div className="flex gap-3">
                      <InfoIcon
                        size={20}
                        weight="bold"
                        className="mt-0.5 shrink-0 text-kumo-accent"
                      />
                      <div>
                        <Text size="sm" bold>
                          What this example explores
                        </Text>
                        <span className="mt-1 block">
                          <Text size="xs" variant="secondary">
                            The agent writes React slide files into Think&apos;s
                            workspace. Worker Bundler snapshots that workspace
                            and serves a preview without a container or Vite dev
                            server.
                          </Text>
                        </span>
                      </div>
                    </div>
                  </Surface>
                  <Empty
                    icon={<PresentationChartIcon size={32} />}
                    title="Ask for a deck"
                    description={
                      'Try "Make a three-slide deck about why Think is useful for generated apps."'
                    }
                  />
                </div>
              )}

              {messages.map((message) => {
                const isUser = message.role === "user";
                if (isUser) {
                  return (
                    <div key={message.id} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 leading-relaxed text-kumo-inverse">
                        {getMessageText(message)}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={message.id} className="space-y-2">
                    {message.parts.map((part, index) => {
                      if (part.type === "text") {
                        if (!part.text) return null;
                        return (
                          <div key={index} className="flex justify-start">
                            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-kumo-base px-4 py-2.5 leading-relaxed text-kumo-default">
                              {part.text}
                            </div>
                          </div>
                        );
                      }
                      if (part.type === "step-start") {
                        return (
                          <div
                            key={`step-${index}`}
                            className="my-1 border-t border-kumo-line/40"
                          />
                        );
                      }
                      if (isToolUIPart(part)) {
                        return (
                          <ToolCallPart key={part.toolCallId} part={part} />
                        );
                      }
                      return null;
                    })}
                  </div>
                );
              })}

              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="border-t border-kumo-line bg-kumo-base">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
              className="mx-auto max-w-3xl px-5 py-4"
            >
              <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
                <InputArea
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      send();
                    }
                  }}
                  placeholder="Describe the slide deck you want..."
                  disabled={!isConnected || isStreaming}
                  rows={2}
                  className="shadow-none! flex-1 bg-transparent! outline-none! ring-0! focus:ring-0!"
                />
                {isStreaming ? (
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop streaming"
                    onClick={stop}
                    icon={<StopIcon size={18} weight="fill" />}
                    className="mb-0.5"
                  />
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    aria-label="Send message"
                    disabled={!input.trim() || !isConnected}
                    icon={<PaperPlaneRightIcon size={18} />}
                    className="mb-0.5"
                  />
                )}
              </div>
            </form>
            <div className="flex justify-center pb-3">
              <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
            </div>
          </div>
        </section>

        <aside className="hidden min-w-0 flex-1 flex-col border-l border-kumo-line bg-kumo-base lg:flex">
          <div className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={panel === "preview" ? "primary" : "secondary"}
                onClick={() => setPanel("preview")}
              >
                Preview
              </Button>
              <Button
                size="sm"
                variant={panel === "source" ? "primary" : "secondary"}
                onClick={() => setPanel("source")}
              >
                Source
              </Button>
            </div>
            {deckState && (
              <Badge variant={deckState.built ? "primary" : "secondary"}>
                {deckState.built
                  ? `${deckState.slideCount} slide${deckState.slideCount === 1 ? "" : "s"}`
                  : "Not built"}
              </Badge>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {actionError && (
              <div className="border-b border-kumo-line bg-kumo-danger-tint px-4 py-3 text-sm text-kumo-danger">
                {actionError}
              </div>
            )}

            <div className="min-h-0 flex-1">
              {panel === "preview" &&
                (previewUrl ? (
                  <iframe
                    key={previewUrl}
                    src={previewUrl}
                    title="Slide deck preview"
                    className="h-full w-full border-0 bg-white"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-6 text-center">
                    <Text size="sm" variant="secondary">
                      Build a deck to see the bundled preview.
                    </Text>
                  </div>
                ))}

              {panel === "source" &&
                (deckState ? (
                  <SourcePanel state={deckState} />
                ) : (
                  <div className="flex h-full items-center justify-center p-6 text-center">
                    <Text size="sm" variant="secondary">
                      Source files will appear after the agent starts.
                    </Text>
                  </div>
                ))}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(<App />);
