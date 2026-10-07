import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart } from "ai";
import {
  MAX_WEB_SEARCH_LIMIT,
  renderWebSearchResults,
  type WebSearchProvider,
  type WebSearchResult,
  type WebSearchToolOutput
} from "agents/websearch";
import {
  Badge,
  Button,
  PoweredByCloudflare,
  Select,
  Tabs
} from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  GlobeHemisphereWestIcon,
  MoonIcon,
  NotePencilIcon,
  SidebarSimpleIcon,
  SunIcon,
  WarningCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import {
  AssistantMessage,
  ChatFeed,
  Composer,
  ConnectionDot,
  Markdown,
  Pending,
  Reasoning,
  ToolCall,
  UserMessage,
  useColorMode,
  useMediaQuery
} from "./chat-ui";
import type { ToolCallState } from "./chat-ui";
import {
  DEFAULT_SETTINGS,
  MAX_DESCRIPTION_CHARS,
  MODEL,
  PROVIDERS,
  type ResearchMessage,
  type ResearchSettings
} from "./shared";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

type SearchPart = Extract<
  ResearchMessage["parts"][number],
  { type: "tool-web_search" }
>;

const SUGGESTIONS = [
  {
    title: "Something that just happened",
    prompt: "Who won the most recent Formula 1 Grand Prix?"
  },
  {
    title: "Recent releases",
    prompt: "What's new in the Cloudflare Agents SDK this month?"
  },
  {
    title: "Compare with sources",
    prompt: "Compare Exa, Linkup, and Ceramic as search APIs for agents."
  },
  {
    title: "Search more than once",
    prompt:
      "What are people saying about Cloudflare's Web Search API, and how is it priced?"
  }
];

// ── Search helpers ──────────────────────────────────────────────────

function isSearchPart(
  part: ResearchMessage["parts"][number]
): part is SearchPart {
  return part.type === "tool-web_search";
}

function isSearching(part: SearchPart): boolean {
  return part.state === "input-streaming" || part.state === "input-available";
}

/** The same text the tool's `toModelOutput` gives the model. */
function modelView(output: WebSearchToolOutput): string {
  return renderWebSearchResults(output, {
    maxDescriptionChars: MAX_DESCRIPTION_CHARS
  });
}

function searchLabel(part: SearchPart, state: ToolCallState): string {
  const query = part.input?.query ? `“${part.input.query}”` : "the web";
  if (state === "running") return `Searching for ${query}…`;
  if (state === "error") return `Search failed for ${query}`;
  if (part.state !== "output-available") return `Searched for ${query}`;
  const count = part.output.items.length;
  return `Searched for ${query} · ${count} result${count === 1 ? "" : "s"}`;
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

// ── Messages ────────────────────────────────────────────────────────

function getMessageText(message: ResearchMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** Parts that render something: non-empty text or reasoning, and tool calls. */
function visibleParts(message: ResearchMessage) {
  return message.parts.filter(
    (part) =>
      ((part.type === "text" || part.type === "reasoning") &&
        part.text.trim()) ||
      isToolUIPart(part)
  );
}

/**
 * True while a turn is running but nothing new is on screen: right after
 * sending, or after a search finishes and the model is deciding what's next.
 */
function isWaitingForModel(messages: ResearchMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role === "user") return true;
  const visible = visibleParts(last);
  const lastPart = visible[visible.length - 1];
  return (
    !lastPart ||
    (isToolUIPart(lastPart) && lastPart.state === "output-available")
  );
}

function MessageParts({
  message,
  streaming
}: {
  message: ResearchMessage;
  streaming: boolean;
}) {
  const lastTextIndex = message.parts.reduce(
    (last, part, index) => (part.type === "text" ? index : last),
    -1
  );

  return (
    <AssistantMessage>
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          if (!part.text) return null;
          return (
            <Markdown
              key={index}
              text={part.text}
              streaming={streaming && index === lastTextIndex}
            />
          );
        }

        if (part.type === "reasoning") {
          return (
            <Reasoning
              key={index}
              text={part.text}
              streaming={part.state === "streaming"}
            />
          );
        }

        if (isSearchPart(part)) {
          const state: ToolCallState =
            part.state === "output-available"
              ? "done"
              : part.state === "output-error"
                ? "error"
                : "running";
          return (
            <ToolCall
              key={part.toolCallId}
              label={searchLabel(part, state)}
              state={state}
              input={
                part.input == null
                  ? undefined
                  : JSON.stringify(part.input, null, 2)
              }
              output={
                part.state === "output-available"
                  ? modelView(part.output)
                  : undefined
              }
              error={part.state === "output-error" ? part.errorText : undefined}
            />
          );
        }

        return null;
      })}
    </AssistantMessage>
  );
}

/** A failed turn, e.g. the model call erroring. Search failures show inline. */
function TurnError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 text-sm text-kumo-danger"
    >
      <WarningCircleIcon size={16} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────

function SidebarSection({
  title,
  action,
  children
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xs font-medium tracking-wide text-kumo-subtle uppercase">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function isProvider(value: unknown): value is WebSearchProvider {
  return PROVIDERS.some((provider) => provider === value);
}

/** The host-side search options, stored in the agent's state. */
function SearchSettings({
  settings,
  disabled,
  onChange,
  popupContainer
}: {
  settings: ResearchSettings;
  disabled: boolean;
  onChange: (settings: ResearchSettings) => void;
  popupContainer: HTMLElement | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span id="provider-label" className="text-sm text-kumo-default">
          Provider
        </span>
        <Select
          size="sm"
          aria-labelledby="provider-label"
          className="w-32"
          disabled={disabled}
          container={popupContainer}
          value={settings.provider}
          items={PROVIDERS.map((provider) => ({
            value: provider,
            label: provider
          }))}
          onValueChange={(value) => {
            if (isProvider(value)) onChange({ ...settings, provider: value });
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="limit-input" className="text-sm text-kumo-default">
          Max results
        </label>
        <div className="flex items-center gap-2">
          <input
            id="limit-input"
            type="range"
            min={1}
            max={MAX_WEB_SEARCH_LIMIT}
            step={1}
            value={settings.limit}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...settings, limit: Number(event.target.value) })
            }
            className="w-28 accent-kumo-brand"
          />
          <span className="w-5 text-right text-sm text-kumo-default tabular-nums">
            {settings.limit}
          </span>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-kumo-subtle">
        Applies from your next message. The model can ask for fewer results,
        never more.
      </p>
    </div>
  );
}

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
      <span className="w-4 shrink-0 pt-0.5 text-right text-xs text-kumo-inactive tabular-nums">
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
  const modelText = useMemo(() => modelView(output), [output]);
  const rawText = useMemo(() => JSON.stringify(output, null, 2), [output]);

  return (
    <div className="flex flex-col gap-2">
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
          <p className="text-xs text-kumo-subtle">No results.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {output.items.map((item, index) => (
              <ResultItem key={item.url} item={item} position={index + 1} />
            ))}
          </ol>
        ))}
      {view !== "results" && (
        <pre className="max-h-96 overflow-auto rounded-lg bg-kumo-recessed p-3 font-mono text-xs break-words whitespace-pre-wrap text-kumo-subtle">
          {view === "model" ? modelText : rawText}
        </pre>
      )}
    </div>
  );
}

/** One search: what was asked, then the results three ways. */
function SearchCard({ part }: { part: SearchPart }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-kumo-base p-3 ring-1 ring-kumo-line">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-sm font-medium text-kumo-default">
          {part.input?.query ?? "…"}
        </span>
        {part.state === "output-error" && (
          <Badge variant="destructive">Failed</Badge>
        )}
      </div>
      <div className="text-xs text-kumo-inactive">
        {isSearching(part)
          ? "Searching…"
          : part.state === "output-available"
            ? [
                `${part.output.items.length} result${part.output.items.length === 1 ? "" : "s"}`,
                part.output.provider,
                `${part.output.metadata.latencyMs} ms`
              ]
                .filter(Boolean)
                .join(" · ")
            : null}
        {part.input?.limit !== undefined &&
          ` · model asked for ${part.input.limit}`}
      </div>
      {part.state === "output-error" && (
        <pre className="rounded-lg bg-kumo-recessed p-3 font-mono text-xs whitespace-pre-wrap text-kumo-danger">
          {part.errorText}
        </pre>
      )}
      {part.state === "output-available" && (
        <SearchOutput output={part.output} />
      )}
    </div>
  );
}

function Sidebar({
  settings,
  settingsDisabled,
  onSettingsChange,
  searches,
  onClose
}: {
  settings: ResearchSettings;
  settingsDisabled: boolean;
  onSettingsChange: (settings: ResearchSettings) => void;
  searches: SearchPart[];
  onClose?: () => void;
}) {
  // Render the provider dropdown inside the panel, so it stacks above the
  // panel when it's a drawer over the chat.
  const [popupContainer, setPopupContainer] = useState<HTMLElement | null>(
    null
  );

  return (
    <div
      ref={setPopupContainer}
      className="flex h-full flex-col bg-kumo-elevated"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto p-5">
        <SidebarSection
          title="About this demo"
          action={
            onClose && (
              <Button
                size="sm"
                variant="ghost"
                shape="square"
                aria-label="Close panel"
                icon={<XIcon size={14} />}
                onClick={onClose}
              />
            )
          }
        >
          <p className="text-sm leading-relaxed text-kumo-default">
            An <code>AIChatAgent</code> answers from the live web with the{" "}
            <code>web_search</code> tool from <code>agents/websearch</code>,
            citing what it finds. Searches run through your account's AI Gateway
            and are billed there.
          </p>
        </SidebarSection>

        <SidebarSection title="Search settings">
          <SearchSettings
            settings={settings}
            disabled={settingsDisabled}
            onChange={onSettingsChange}
            popupContainer={popupContainer}
          />
        </SidebarSection>

        <SidebarSection
          title={
            <>
              Searches
              {searches.length > 0 && (
                <span className="text-kumo-inactive">{searches.length}</span>
              )}
            </>
          }
        >
          {searches.length === 0 ? (
            <p className="text-sm leading-relaxed text-kumo-subtle">
              Each search shows up here with its results, the trimmed text the
              model read, and the full response your code got.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {searches.map((part) => (
                <SearchCard key={part.toolCallId} part={part} />
              ))}
            </div>
          )}
        </SidebarSection>
      </div>
      <div className="flex justify-center border-t border-kumo-line px-5 py-3 opacity-70 transition-opacity hover:opacity-100">
        <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
      </div>
    </div>
  );
}

// ── App ─────────────────────────────────────────────────────────────

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 py-12">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl bg-kumo-tint text-kumo-brand">
          <GlobeHemisphereWestIcon size={20} weight="duotone" />
        </div>
        <h2 className="text-xl font-semibold text-kumo-default">
          What do you want to look up?
        </h2>
        <p className="max-w-md text-sm text-kumo-subtle">
          The agent searches the web and answers with numbered citations.
        </p>
      </div>
      <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion.title}
            type="button"
            onClick={() => onPick(suggestion.prompt)}
            className="flex flex-col gap-1 rounded-xl bg-kumo-base p-3 text-left ring-1 ring-kumo-line transition-colors hover:bg-kumo-tint"
          >
            <span className="text-sm font-medium text-kumo-default">
              {suggestion.title}
            </span>
            <span className="line-clamp-2 text-xs text-kumo-subtle">
              {suggestion.prompt}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [mode, toggleMode] = useColorMode();
  const isWide = useMediaQuery("(min-width: 1024px)");
  const [panelOpen, setPanelOpen] = useState(isWide);

  // Open the panel when the window grows wide, close it when it shrinks, so
  // it never covers the chat by surprise.
  useEffect(() => setPanelOpen(isWide), [isWide]);

  const agent = useAgent<ResearchSettings>({
    agent: "ResearchAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const { messages, sendMessage, clearHistory, stop, isStreaming, error } =
    useAgentChat<unknown, ResearchMessage>({
      agent,
      experimental_throttle: 100
    });

  const searches = useMemo(
    () => messages.flatMap((message) => message.parts.filter(isSearchPart)),
    [messages]
  );

  const isConnected = connectionStatus === "connected";
  const settings = agent.state ?? DEFAULT_SETTINGS;
  const userMessageCount = messages.filter((m) => m.role === "user").length;
  const waitingForReply = isStreaming && isWaitingForModel(messages);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      setInput("");
      sendMessage({ role: "user", parts: [{ type: "text", text: trimmed }] });
    },
    [isStreaming, sendMessage]
  );

  const sidebar = (
    <Sidebar
      settings={settings}
      settingsDisabled={!isConnected}
      onSettingsChange={agent.setState}
      searches={searches}
      onClose={isWide ? undefined : () => setPanelOpen(false)}
    />
  );

  return (
    <div className="flex h-full flex-col bg-kumo-base">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-kumo-line px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="text-sm font-semibold text-kumo-default">
            Web Research
          </h1>
          <span
            className="hidden truncate text-sm text-kumo-subtle sm:inline"
            title={`Workers AI model: ${MODEL}`}
          >
            web_search · {MODEL.replace(/^@cf\//, "")}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <ConnectionDot status={connectionStatus} />
          <div className="mx-2 h-4 w-px bg-kumo-line" />
          <Button
            size="sm"
            variant="ghost"
            icon={<NotePencilIcon size={14} />}
            disabled={messages.length === 0}
            onClick={clearHistory}
          >
            New chat
          </Button>
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            aria-label="Toggle theme"
            icon={
              mode === "light" ? <MoonIcon size={14} /> : <SunIcon size={14} />
            }
            onClick={toggleMode}
          />
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            aria-label={panelOpen ? "Hide panel" : "Show panel"}
            aria-expanded={panelOpen}
            icon={<SidebarSimpleIcon size={14} className="-scale-x-100" />}
            onClick={() => setPanelOpen((open) => !open)}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <ChatFeed userMessageCount={userMessageCount}>
            {messages.length === 0 ? (
              <EmptyState onPick={send} />
            ) : (
              messages.map((message, index) =>
                message.role === "user" ? (
                  <UserMessage key={message.id}>
                    {getMessageText(message)}
                  </UserMessage>
                ) : visibleParts(message).length === 0 ? null : (
                  <MessageParts
                    key={message.id}
                    message={message}
                    streaming={isStreaming && index === messages.length - 1}
                  />
                )
              )
            )}
            {waitingForReply && <Pending />}
            {error && !isStreaming && <TurnError message={error.message} />}
          </ChatFeed>
          {/* `relative` keeps the composer's ring above the feed's fade. */}
          <div className="relative mx-auto w-full max-w-3xl px-4 pt-1 pb-4 sm:px-6">
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={() => send(input)}
              onStop={stop}
              busy={isStreaming}
              disabled={!isConnected}
              placeholder="Ask about anything current…"
            />
            <p className="mt-2 hidden text-center text-xs text-kumo-inactive sm:block">
              Enter to send · Shift+Enter for a new line
            </p>
          </div>
        </main>

        {/* Wide screens: a column beside the chat. Wider than a plain chat
            sidebar, since it holds the search results. */}
        {isWide && panelOpen && (
          <aside
            aria-label="Research"
            className="w-96 shrink-0 border-l border-kumo-line"
          >
            {sidebar}
          </aside>
        )}
      </div>

      {/* Narrow screens: the same panel as a drawer over the chat. */}
      {!isWide && panelOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button
            type="button"
            aria-label="Close panel"
            className="absolute inset-0 bg-black/30"
            onClick={() => setPanelOpen(false)}
          />
          <aside
            aria-label="Research"
            className="relative w-[min(24rem,90vw)] shadow-xl"
          >
            {sidebar}
          </aside>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-kumo-inactive">
          Loading…
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
