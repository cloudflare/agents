import { Suspense, useCallback, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart } from "ai";
import { renderWebFetchPage } from "agents/webfetch";
import { renderWebSearchResults } from "agents/websearch";
import { Button, PoweredByCloudflare, Tabs } from "@cloudflare/kumo";
import {
  GlobeHemisphereWestIcon,
  MoonIcon,
  NotePencilIcon,
  SunIcon,
  WarningCircleIcon
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
  useColorMode
} from "./chat-ui";
import type { ToolCallState } from "./chat-ui";
import { CorpusTab } from "./corpus-tab";
import {
  CloseSidebarButton,
  SidebarBody,
  SidebarSection,
  WithSidebar
} from "./layout";
import { SettingsPanel } from "./settings";
import {
  DEFAULT_SETTINGS,
  MODEL,
  type LabMessage,
  type LabSettings
} from "./shared";
import { statusText, UrlLab, type CallAgent } from "./url-lab";

type ConnectionStatus = "connecting" | "connected" | "disconnected";
type Tab = "chat" | "lab" | "corpus";

function isTab(value: string): value is Tab {
  return value === "chat" || value === "lab" || value === "corpus";
}

const SUGGESTIONS = [
  {
    title: "Search, then read",
    prompt:
      "What does Cloudflare's Markdown for Agents do? Read the announcement and summarize it."
  },
  {
    title: "Read a URL",
    prompt: "Summarize https://github.com/cloudflare/agents"
  },
  {
    title: "A PDF",
    prompt:
      "Read https://arxiv.org/pdf/1706.03762 and explain the key idea in three sentences."
  },
  {
    title: "Page through something long",
    prompt:
      "In RFC 9110 (https://www.rfc-editor.org/rfc/rfc9110.txt), what does it say about the 421 status code?"
  }
];

// ── Chat ────────────────────────────────────────────────────────────

type Part = LabMessage["parts"][number];
type SearchPart = Extract<Part, { type: "tool-web_search" }>;
type FetchPart = Extract<Part, { type: "tool-web_fetch" }>;

function toolState(part: SearchPart | FetchPart): ToolCallState {
  if (part.state === "output-available") return "done";
  if (part.state === "output-error") return "error";
  return "running";
}

function searchLabel(part: SearchPart, state: ToolCallState): string {
  const query = part.input?.query ? `“${part.input.query}”` : "the web";
  if (state === "running") return `Searching for ${query}…`;
  if (state === "error") return `Search failed for ${query}`;
  if (part.state !== "output-available") return `Searched for ${query}`;
  const count = part.output.items.length;
  return `Searched for ${query} · ${count} result${count === 1 ? "" : "s"}`;
}

function shortUrl(url: string | undefined): string {
  if (!url) return "a page";
  return url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80);
}

function fetchLabel(part: FetchPart, state: ToolCallState): string {
  const url = shortUrl(part.input?.url);
  const offset = part.input?.offset ? ` from ${part.input.offset}` : "";
  if (state === "running") return `Reading ${url}${offset}…`;
  if (state === "error") return `Couldn't read ${url}`;
  if (part.state !== "output-available") return `Read ${url}`;
  const { status, via, totalChars } = part.output;
  return `Read ${url}${offset} · ${statusText(status)} · ${via} · ${totalChars.toLocaleString()} chars`;
}

function getMessageText(message: LabMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function visibleParts(message: LabMessage) {
  return message.parts.filter(
    (part) =>
      ((part.type === "text" || part.type === "reasoning") &&
        part.text.trim()) ||
      isToolUIPart(part)
  );
}

/** True while a turn is running but nothing new is on screen. */
function isWaitingForModel(messages: LabMessage[]): boolean {
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
  message: LabMessage;
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
        if (part.type === "tool-web_search" || part.type === "tool-web_fetch") {
          const state = toolState(part);
          let output: string | undefined;
          if (part.state === "output-available") {
            // The same text each tool's `toModelOutput` gave the model:
            // the stored output holds just the window the model read.
            output =
              part.type === "tool-web_search"
                ? renderWebSearchResults(part.output)
                : renderWebFetchPage(part.output);
          }
          return (
            <ToolCall
              key={part.toolCallId}
              label={
                part.type === "tool-web_search"
                  ? searchLabel(part, state)
                  : fetchLabel(part, state)
              }
              state={state}
              input={
                part.input == null
                  ? undefined
                  : JSON.stringify(part.input, null, 2)
              }
              output={output}
              error={part.state === "output-error" ? part.errorText : undefined}
            />
          );
        }
        return null;
      })}
    </AssistantMessage>
  );
}

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

function ChatSidebar({
  settings,
  disabled,
  onSettingsChange,
  onClose
}: {
  settings: LabSettings;
  disabled: boolean;
  onSettingsChange: (settings: LabSettings) => void;
  onClose?: () => void;
}) {
  // Render the format dropdown inside the panel, so it stacks above the
  // panel when it's a drawer over the chat.
  const [popupContainer, setPopupContainer] = useState<HTMLElement | null>(
    null
  );
  return (
    <SidebarBody containerRef={setPopupContainer}>
      <SidebarSection
        title="About this demo"
        action={<CloseSidebarButton onClose={onClose} />}
      >
        <p className="text-sm leading-relaxed text-kumo-default">
          An <code>AIChatAgent</code> with two tools: <code>web_search</code>{" "}
          finds pages, <code>web_fetch</code> from{" "}
          <code>agents/webfetch/ai-sdk</code> reads them as Markdown, JSON, or
          text. Open a tool row to see exactly what the model read.
        </p>
        <p className="text-sm leading-relaxed text-kumo-subtle">
          Use <strong>URL Lab</strong> to inspect one fetch without a model, and{" "}
          <strong>Corpus</strong> to check ~50 URLs against expectations.
        </p>
      </SidebarSection>
      <SidebarSection title="Fetch settings">
        <SettingsPanel
          settings={settings}
          disabled={disabled}
          onChange={onSettingsChange}
          popupContainer={popupContainer}
        />
      </SidebarSection>
    </SidebarBody>
  );
}

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 py-12">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl bg-kumo-tint text-kumo-brand">
          <GlobeHemisphereWestIcon size={20} weight="duotone" />
        </div>
        <h2 className="text-xl font-semibold text-kumo-default">
          Ask about a page, or anything on the web
        </h2>
        <p className="max-w-md text-sm text-kumo-subtle">
          The agent searches, reads the pages it finds, and answers with
          numbered citations.
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

function ChatTab({
  agent,
  settings,
  connected,
  onSettingsChange
}: {
  agent: ReturnType<typeof useAgent<LabSettings>>;
  settings: LabSettings;
  connected: boolean;
  onSettingsChange: (settings: LabSettings) => void;
}) {
  const [input, setInput] = useState("");

  const { messages, sendMessage, clearHistory, stop, isStreaming, error } =
    useAgentChat<unknown, LabMessage>({ agent, experimental_throttle: 100 });

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

  return (
    <WithSidebar
      label="settings"
      sidebar={({ onClose }) => (
        <ChatSidebar
          settings={settings}
          disabled={!connected}
          onSettingsChange={onSettingsChange}
          onClose={onClose}
        />
      )}
      toolbar={
        <Button
          size="sm"
          variant="ghost"
          icon={<NotePencilIcon size={14} />}
          disabled={messages.length === 0}
          onClick={clearHistory}
        >
          New chat
        </Button>
      }
    >
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
      <div className="relative mx-auto w-full max-w-3xl px-4 pt-1 pb-4 sm:px-6">
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={() => send(input)}
          onStop={stop}
          busy={isStreaming}
          disabled={!connected}
          placeholder="Ask a question or paste a URL…"
        />
      </div>
    </WithSidebar>
  );
}

// ── App ─────────────────────────────────────────────────────────────

function Lab() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [tab, setTab] = useState<Tab>("chat");
  const [mode, toggleMode] = useColorMode();

  const agent = useAgent<LabSettings>({
    agent: "WebFetchLabAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const connected = connectionStatus === "connected";
  const settings = agent.state ?? DEFAULT_SETTINGS;
  const call: CallAgent = agent.call;

  return (
    <div className="flex h-full flex-col bg-kumo-base">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-kumo-line px-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="text-sm font-semibold whitespace-nowrap text-kumo-default">
              Web Fetch Lab
            </h1>
            <span
              className="hidden truncate text-sm text-kumo-subtle xl:inline"
              title={`Workers AI model: ${MODEL}`}
            >
              web_fetch · {MODEL.replace(/^@cf\//, "")}
            </span>
          </div>
          <Tabs
            variant="segmented"
            size="sm"
            value={tab}
            onValueChange={(value) => {
              if (isTab(value)) setTab(value);
            }}
            tabs={[
              { value: "chat", label: "Chat" },
              { value: "lab", label: "URL Lab" },
              { value: "corpus", label: "Corpus" }
            ]}
          />
        </div>
        <div className="flex items-center gap-1">
          <ConnectionDot status={connectionStatus} />
          <div className="mx-2 h-4 w-px bg-kumo-line" />
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
        </div>
      </header>

      {/* Keep every tab mounted, so a chat reply or corpus run keeps going
          while you look at another tab. */}
      <div
        className={tab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
      >
        <div className="min-h-0 flex-1">
          <ChatTab
            agent={agent}
            settings={settings}
            connected={connected}
            onSettingsChange={agent.setState}
          />
        </div>
      </div>
      <div className={tab === "lab" ? "min-h-0 flex-1" : "hidden"}>
        <UrlLab
          call={call}
          settings={settings}
          disabled={!connected}
          onSettingsChange={agent.setState}
        />
      </div>
      <div className={tab === "corpus" ? "min-h-0 flex-1" : "hidden"}>
        <CorpusTab call={call} disabled={!connected} />
      </div>

      <footer className="flex shrink-0 justify-center border-t border-kumo-line px-5 py-2 opacity-70 transition-opacity hover:opacity-100">
        <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
      </footer>
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
      <Lab />
    </Suspense>
  );
}
