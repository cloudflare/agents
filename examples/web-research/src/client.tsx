import "./styles.css";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  Loader,
  PoweredByCloudflare,
  Surface,
  Tabs,
  Text
} from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  BrainIcon,
  GlobeHemisphereWestIcon,
  InfoIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  StopIcon,
  SunIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import { useAgent } from "agents/react";
import {
  renderWebSearchResults,
  type WebSearchResult,
  type WebSearchToolOutput
} from "agents/websearch";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import { MAX_DESCRIPTION_CHARS, type ResearchMessage } from "./shared";

type SearchPart = Extract<
  ResearchMessage["parts"][number],
  { type: "tool-web_search" }
>;

const SUGGESTIONS = [
  "Who won the most recent Formula 1 Grand Prix?",
  "What's new in the Cloudflare Agents SDK this month?",
  "Compare Exa, Linkup, and Ceramic as search APIs for agents."
];

// ── Shell ──────────────────────────────────────────────────────────

type ConnectionStatus = "connecting" | "connected" | "disconnected";

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const text =
    status === "connected"
      ? "text-kumo-success"
      : status === "connecting"
        ? "text-kumo-warning"
        : "text-kumo-danger";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";
  return (
    <output className="flex items-center gap-2">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`hidden text-xs sm:inline ${text}`}>{label}</span>
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

function Explainer() {
  return (
    <Surface className="p-4 rounded-xl ring ring-kumo-line">
      <div className="flex gap-3">
        <InfoIcon
          size={20}
          weight="bold"
          className="text-kumo-accent shrink-0 mt-0.5"
        />
        <div>
          <Text size="sm" bold>
            Answers from the live web
          </Text>
          <span className="mt-1 block">
            <Text size="xs" variant="secondary">
              The agent searches with the web_search tool from
              agents/websearch/ai-sdk and cites what it finds. Every search
              shows up under Research: the results, the trimmed text the model
              read, and the full response your code got. Searches run through
              your account's AI Gateway and are billed there.
            </Text>
          </span>
        </div>
      </div>
    </Surface>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function getMessageText(message: ResearchMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** Text and reasoning parts use `state: streaming` with empty `text` until the first delta. */
function shouldShowStreamedTextPart(part: {
  text: string;
  state?: "streaming" | "done";
}): boolean {
  return part.text.length > 0 || part.state === "streaming";
}

function isSearchPart(
  part: ResearchMessage["parts"][number]
): part is SearchPart {
  return part.type === "tool-web_search";
}

function isSearching(part: SearchPart): boolean {
  return part.state === "input-streaming" || part.state === "input-available";
}

/** Results come from third-party providers, so only link to http(s) URLs. */
function safeHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

const encoder = new TextEncoder();

function formatSize(text: string): string {
  const bytes = encoder.encode(text).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

function searchElementId(toolCallId: string): string {
  return `search-${toolCallId}`;
}

// ── Chat ───────────────────────────────────────────────────────────

/** A search, inline in the transcript where the model ran it. */
function SearchChip({
  part,
  onSelect
}: {
  part: SearchPart;
  onSelect: (toolCallId: string) => void;
}) {
  const query = part.input?.query ?? "";

  if (part.state === "output-error") {
    return (
      <div className="max-w-[85%] rounded-xl bg-kumo-danger-tint px-4 py-2.5 ring ring-kumo-danger/30">
        <div className="flex items-center gap-2 text-xs font-semibold text-kumo-danger">
          <WarningCircleIcon size={14} weight="bold" />
          Search failed: “{query}”
        </div>
        <p className="mt-1 text-xs text-kumo-danger">{part.errorText}</p>
      </div>
    );
  }

  const searching = isSearching(part);
  const count =
    part.state === "output-available" ? part.output.items.length : 0;

  return (
    <button
      type="button"
      onClick={() => onSelect(part.toolCallId)}
      className="flex max-w-[85%] items-center gap-2 rounded-full bg-kumo-base px-3 py-1.5 text-left text-xs text-kumo-subtle ring ring-kumo-line transition-colors hover:bg-kumo-tint"
    >
      {searching ? (
        <Loader size="sm" aria-label="Searching" />
      ) : (
        <MagnifyingGlassIcon size={14} className="shrink-0 text-kumo-accent" />
      )}
      <span className="truncate">
        {searching ? "Searching for " : "Searched for "}
        <span className="font-medium text-kumo-default">“{query}”</span>
      </span>
      {part.state === "output-available" && (
        <span className="shrink-0 text-kumo-inactive">
          · {count} result{count === 1 ? "" : "s"}
        </span>
      )}
    </button>
  );
}

function AssistantMessage({
  message,
  isAnimating,
  onSelectSearch
}: {
  message: ResearchMessage;
  isAnimating: boolean;
  onSelectSearch: (toolCallId: string) => void;
}) {
  return (
    <div className="space-y-2">
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          if (!shouldShowStreamedTextPart(part)) return null;
          const isLastTextPart = message.parts
            .slice(index + 1)
            .every((p) => p.type !== "text");
          return (
            <div key={index} className="flex justify-start">
              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                <Streamdown
                  className="sd-theme min-h-[1.25em]"
                  plugins={{ code }}
                  controls={false}
                  isAnimating={isAnimating && isLastTextPart}
                >
                  {part.text}
                </Streamdown>
              </div>
            </div>
          );
        }

        if (part.type === "reasoning") {
          if (!part.text) return null;
          return (
            <div key={index} className="flex justify-start">
              <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line opacity-70">
                <div className="flex items-center gap-2 mb-1">
                  <BrainIcon size={14} className="text-kumo-inactive" />
                  <Text size="xs" variant="secondary" bold>
                    Thinking
                  </Text>
                </div>
                <div className="whitespace-pre-wrap text-xs text-kumo-subtle italic">
                  {part.text}
                </div>
              </Surface>
            </div>
          );
        }

        if (isSearchPart(part)) {
          return (
            <div key={part.toolCallId} className="flex justify-start">
              <SearchChip part={part} onSelect={onSelectSearch} />
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

// ── Research panel ─────────────────────────────────────────────────

type SearchView = "results" | "model" | "raw";

function isSearchView(value: string): value is SearchView {
  return value === "results" || value === "model" || value === "raw";
}

function ResultItem({
  item,
  position
}: {
  item: WebSearchResult;
  position: number;
}) {
  const href = safeHref(item.url);
  const date = formatDate(item.lastModifiedDate);
  return (
    <li className="flex gap-2">
      <span className="w-4 shrink-0 pt-0.5 text-right text-xs tabular-nums text-kumo-inactive">
        {position}
      </span>
      <div className="min-w-0">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-start gap-1 text-sm font-medium text-kumo-link hover:underline"
          >
            <span className="line-clamp-2">{item.title}</span>
            <ArrowSquareOutIcon
              size={12}
              className="mt-1 shrink-0 opacity-0 group-hover:opacity-100"
            />
          </a>
        ) : (
          <span className="line-clamp-2 text-sm font-medium text-kumo-default">
            {item.title}
          </span>
        )}
        <div className="text-xs text-kumo-inactive">
          {hostname(item.url)}
          {date && ` · ${date}`}
        </div>
        {item.description && (
          <p className="mt-1 line-clamp-3 text-xs text-kumo-subtle">
            {item.description}
          </p>
        )}
      </div>
    </li>
  );
}

function SearchOutput({ output }: { output: WebSearchToolOutput }) {
  const [view, setView] = useState<SearchView>("results");
  // The same rendering the tool's `toModelOutput` gives the model.
  const modelText = useMemo(
    () =>
      renderWebSearchResults(output, {
        maxDescriptionChars: MAX_DESCRIPTION_CHARS
      }),
    [output]
  );
  const rawText = useMemo(() => JSON.stringify(output, null, 2), [output]);

  return (
    <div className="mt-2 space-y-2">
      <div className="text-xs text-kumo-inactive">
        {output.items.length} result{output.items.length === 1 ? "" : "s"}
        {output.provider && ` · ${output.provider}`}
        {` · ${output.metadata.latencyMs} ms`}
      </div>
      <Tabs
        variant="underline"
        size="sm"
        value={view}
        onValueChange={(value) => {
          if (isSearchView(value)) setView(value);
        }}
        tabs={[
          { value: "results", label: "Results" },
          { value: "model", label: `Model saw · ${formatSize(modelText)}` },
          { value: "raw", label: `You got · ${formatSize(rawText)}` }
        ]}
      />
      {view === "results" &&
        (output.items.length === 0 ? (
          <Text size="xs" variant="secondary">
            No results.
          </Text>
        ) : (
          <ol className="space-y-3">
            {output.items.map((item, index) => (
              <ResultItem key={item.url} item={item} position={index + 1} />
            ))}
          </ol>
        ))}
      {view !== "results" && (
        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-kumo-elevated p-2 font-mono text-xs text-kumo-subtle">
          {view === "model" ? modelText : rawText}
        </pre>
      )}
    </div>
  );
}

function SearchCard({
  part,
  selected
}: {
  part: SearchPart;
  selected: boolean;
}) {
  return (
    <Surface
      id={searchElementId(part.toolCallId)}
      className={`scroll-mt-4 rounded-xl p-3 ring ${
        selected ? "ring-2 ring-kumo-brand" : "ring-kumo-line"
      }`}
    >
      <div className="flex items-start gap-2">
        <MagnifyingGlassIcon
          size={16}
          className="mt-0.5 shrink-0 text-kumo-accent"
        />
        <span className="min-w-0 flex-1 text-sm font-medium text-kumo-default">
          {part.input?.query ?? "…"}
        </span>
        {part.state === "output-error" && (
          <Badge variant="destructive">Failed</Badge>
        )}
        {part.input?.limit !== undefined && (
          <Badge variant="secondary">limit {part.input.limit}</Badge>
        )}
      </div>
      {isSearching(part) && (
        <div className="mt-2 flex items-center gap-2 text-xs text-kumo-subtle">
          <Loader size="sm" aria-label="Searching" /> Searching…
        </div>
      )}
      {part.state === "output-error" && (
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-kumo-danger-tint p-2 font-mono text-xs text-kumo-danger">
          {part.errorText}
        </pre>
      )}
      {part.state === "output-available" && (
        <SearchOutput output={part.output} />
      )}
    </Surface>
  );
}

function ResearchPanel({
  searches,
  selectedId,
  onClose
}: {
  searches: SearchPart[];
  selectedId: string | null;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Follow new searches as they start.
  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [searches.length]);

  // Bring a search into view when it's picked from the transcript.
  useEffect(() => {
    if (!selectedId) return;
    document
      .getElementById(searchElementId(selectedId))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedId]);

  return (
    <>
      <div className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
        <div className="flex items-center gap-2">
          <GlobeHemisphereWestIcon size={16} className="text-kumo-accent" />
          <Text size="sm" bold>
            Research
          </Text>
          {searches.length > 0 && (
            <Badge variant="secondary">{searches.length}</Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          aria-label="Close research panel"
          icon={<XIcon size={14} />}
          onClick={onClose}
          className="lg:hidden"
        />
      </div>
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {searches.length === 0 ? (
          <Empty
            size="sm"
            icon={<MagnifyingGlassIcon size={24} />}
            title="No searches yet"
            description="Searches the agent runs show up here, with what the model read and what your code got."
          />
        ) : (
          searches.map((part) => (
            <SearchCard
              key={part.toolCallId}
              part={part}
              selected={part.toolCallId === selectedId}
            />
          ))
        )}
      </div>
    </>
  );
}

// ── App ────────────────────────────────────────────────────────────

function ResearchChat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [selectedSearchId, setSelectedSearchId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "ResearchAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const { messages, sendMessage, clearHistory, stop, isStreaming } =
    useAgentChat<unknown, ResearchMessage>({
      agent,
      experimental_throttle: 100
    });

  const searches = useMemo(
    () => messages.flatMap((message) => message.parts.filter(isSearchPart)),
    [messages]
  );

  const isConnected = connectionStatus === "connected";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      setInput("");
      sendMessage({ role: "user", parts: [{ type: "text", text: trimmed }] });
    },
    [isStreaming, sendMessage]
  );

  const selectSearch = useCallback((toolCallId: string) => {
    setSelectedSearchId(toolCallId);
    setPanelOpen(true);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Web Research
            </h1>
            <span className="hidden sm:inline-flex">
              <Badge variant="secondary">
                <MagnifyingGlassIcon size={12} weight="bold" className="mr-1" />
                web_search
              </Badge>
            </span>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="secondary"
              icon={<GlobeHemisphereWestIcon size={16} />}
              aria-label="Toggle research panel"
              onClick={() => setPanelOpen((open) => !open)}
              className="lg:hidden"
            >
              <span className="hidden sm:inline">Research</span>
              {searches.length > 0 && ` ${searches.length}`}
            </Button>
            <Button
              variant="secondary"
              aria-label="Clear history"
              icon={<TrashIcon size={16} />}
              onClick={() => {
                clearHistory();
                setSelectedSearchId(null);
              }}
            >
              <span className="hidden sm:inline">Clear</span>
            </Button>
          </div>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
              <Explainer />

              {messages.length === 0 && (
                <Empty
                  icon={<GlobeHemisphereWestIcon size={32} />}
                  title="Ask about anything current"
                  description="The agent searches the web, reads the results, and answers with numbered citations."
                  contents={
                    <div className="flex flex-wrap justify-center gap-2">
                      {SUGGESTIONS.map((suggestion) => (
                        <Button
                          key={suggestion}
                          variant="secondary"
                          size="sm"
                          disabled={!isConnected}
                          onClick={() => send(suggestion)}
                        >
                          {suggestion}
                        </Button>
                      ))}
                    </div>
                  }
                />
              )}

              {messages.map((message, index) => {
                if (message.role === "user") {
                  return (
                    <div key={message.id} className="flex justify-end">
                      <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                        {getMessageText(message)}
                      </div>
                    </div>
                  );
                }
                return (
                  <AssistantMessage
                    key={message.id}
                    message={message}
                    isAnimating={isStreaming && index === messages.length - 1}
                    onSelectSearch={selectSearch}
                  />
                );
              })}

              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="border-t border-kumo-line bg-kumo-base">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="max-w-3xl mx-auto px-5 py-4"
            >
              <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
                <InputArea
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  placeholder="Ask a question about anything current…"
                  aria-label="Question"
                  disabled={!isConnected || isStreaming}
                  rows={2}
                  className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
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
        </main>

        <aside
          aria-label="Research"
          className={`${
            panelOpen ? "flex" : "hidden"
          } absolute inset-0 z-10 flex-col bg-kumo-base lg:static lg:flex lg:w-[28rem] lg:shrink-0 lg:border-l lg:border-kumo-line`}
        >
          <ResearchPanel
            searches={searches}
            selectedId={selectedSearchId}
            onClose={() => setPanelOpen(false)}
          />
        </aside>
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <ResearchChat />
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
