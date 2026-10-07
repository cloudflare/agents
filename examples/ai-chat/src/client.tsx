import { Suspense, useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import type { MCPServersState } from "agents";
import { Badge, Button, PoweredByCloudflare, cn } from "@cloudflare/kumo";
import {
  CloudSunIcon,
  MoonIcon,
  NotePencilIcon,
  PlusIcon,
  SidebarSimpleIcon,
  SignInIcon,
  SunIcon,
  TrashIcon,
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
  ToolApproval,
  ToolCall,
  UserMessage,
  useColorMode,
  useMediaQuery
} from "./chat-ui";
import type { ToolCallState } from "./chat-ui";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

const SUGGESTIONS = [
  {
    title: "Check the weather",
    prompt: "What's the weather like in Lisbon and in Tokyo right now?"
  },
  {
    title: "Ask for approval",
    prompt: "What is 5000 * 3000?"
  },
  {
    title: "Run a tool in this page",
    prompt: "What time is it where I am?"
  },
  {
    title: "Browse the web",
    prompt: "Take a screenshot of https://example.com"
  }
];

/** The tools defined in server.ts, described for the sidebar. */
const BUILT_IN_TOOLS = [
  { name: "getWeather", where: "Server", detail: "Runs on the agent." },
  {
    name: "getUserTimezone",
    where: "Browser",
    detail: "No execute — answered by onToolCall in this page."
  },
  {
    name: "calculate",
    where: "Approval",
    detail: "Asks you first when a number is over 1000."
  },
  {
    name: "browser_execute",
    where: "Server",
    detail: "Drives a headless browser with Browser Run."
  }
];

// ── Tool rendering ──────────────────────────────────────────────────

const TOOL_LABELS: Partial<
  Record<string, (input: Record<string, unknown>) => string>
> = {
  getWeather: (input) =>
    input.city ? `Checked the weather in ${input.city}` : "Checked weather",
  getUserTimezone: () => "Read your timezone from the browser",
  calculate: (input) =>
    input.a != null
      ? `Calculated ${input.a} ${input.operator} ${input.b}`
      : "Calculated",
  browser_execute: () => "Ran a browser script"
};

const RUNNING_LABELS: Record<string, string> = {
  getWeather: "Checking the weather…",
  getUserTimezone: "Reading your timezone…",
  calculate: "Calculating…",
  browser_execute: "Running a browser script…"
};

function toolLabel(name: string, input: unknown, state: ToolCallState) {
  if (state === "running") return RUNNING_LABELS[name] ?? `Running ${name}…`;
  if (state === "denied") return `Denied ${name}`;
  const label = TOOL_LABELS[name];
  return label && isRecord(input) ? label(input) : name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The sandbox script chooses these fields, so only render media types and
// payloads we know are safe to inline.
const SCREENSHOT_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"];
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function getScreenshotPreview(outer: unknown): { src: string } | null {
  // browser_execute wraps the sandbox return value: { status, result, ... }
  const output =
    isRecord(outer) && isRecord(outer.result) ? outer.result : outer;
  if (
    !isRecord(output) ||
    output.type !== "browser_screenshot" ||
    typeof output.mediaType !== "string" ||
    !SCREENSHOT_MEDIA_TYPES.includes(output.mediaType) ||
    typeof output.data !== "string" ||
    !BASE64_PATTERN.test(output.data)
  ) {
    return null;
  }

  return { src: `data:${output.mediaType};base64,${output.data}` };
}

// Any large `data` string is an inline payload (a screenshot or another
// binary blob) and is kept out of the transcript. The tool output also carries
// codemode's `calls` log, so the whole object is walked, not just its root.
const INLINE_DATA_REDACTION_THRESHOLD = 1024;
const MAX_REDACTION_DEPTH = 20;

function redactInlineData(value: unknown, key?: string, depth = 0): unknown {
  if (typeof value === "string") {
    return key === "data" && value.length > INLINE_DATA_REDACTION_THRESHOLD
      ? `[inline data omitted: ${value.length} chars]`
      : value;
  }
  if (depth >= MAX_REDACTION_DEPTH || !isRecord(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactInlineData(entry, key, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      redactInlineData(entry, entryKey, depth + 1)
    ])
  );
}

function formatPayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.code === "string") return value.code;
  return JSON.stringify(redactInlineData(value), null, 2);
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

function MessageParts({
  message,
  streaming,
  onApproval
}: {
  message: UIMessage;
  streaming: boolean;
  onApproval: (id: string, approved: boolean) => void;
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

        if (!isToolUIPart(part)) return null;
        const name = getToolName(part);

        if (part.state === "approval-requested") {
          const approvalId = part.approval.id;
          return (
            <ToolApproval
              key={part.toolCallId}
              title={`Allow ${name}?`}
              onApprove={() => onApproval(approvalId, true)}
              onReject={() => onApproval(approvalId, false)}
            >
              {formatPayload(part.input)}
            </ToolApproval>
          );
        }

        const state: ToolCallState =
          part.state === "output-available"
            ? "done"
            : part.state === "output-error"
              ? "error"
              : part.state === "output-denied"
                ? "denied"
                : "running";
        const output = part.state === "output-available" ? part.output : null;
        const screenshot =
          name === "browser_execute" ? getScreenshotPreview(output) : null;

        return (
          <ToolCall
            key={part.toolCallId}
            label={toolLabel(name, part.input, state)}
            state={state}
            input={part.input == null ? undefined : formatPayload(part.input)}
            output={output == null ? undefined : formatPayload(output)}
            error={part.state === "output-error" ? part.errorText : undefined}
          >
            {screenshot && (
              <img
                src={screenshot.src}
                alt="Browser screenshot captured by browser_execute"
                className="max-h-80 w-full rounded-lg object-contain ring-1 ring-kumo-line"
              />
            )}
          </ToolCall>
        );
      })}
    </AssistantMessage>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────

function SidebarSection({
  title,
  action,
  children
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium tracking-wide text-kumo-subtle uppercase">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function McpServers({
  state,
  onAdd,
  onRemove
}: {
  state: MCPServersState;
  onAdd: (name: string, url: string) => Promise<void>;
  onRemove: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const servers = Object.entries(state.servers);

  async function add() {
    if (!name.trim() || !url.trim()) return;
    setAdding(true);
    try {
      await onAdd(name.trim(), url.trim());
      setName("");
      setUrl("");
    } finally {
      setAdding(false);
    }
  }

  const inputClass =
    "w-full rounded-lg bg-kumo-control px-3 py-1.5 text-sm text-kumo-default ring-1 ring-kumo-line outline-none placeholder:text-kumo-placeholder focus:ring-kumo-brand/60";

  return (
    <div className="flex flex-col gap-3">
      {servers.map(([id, server]) => (
        <div key={id} className="flex items-start gap-2 text-sm">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-kumo-default">
                {server.name}
              </span>
              <Badge
                variant={
                  server.state === "ready"
                    ? "primary"
                    : server.state === "failed"
                      ? "destructive"
                      : "secondary"
                }
              >
                {server.state}
              </Badge>
            </div>
            <div className="truncate font-mono text-xs text-kumo-subtle">
              {server.server_url}
            </div>
            {server.state === "failed" && server.error && (
              <div className="mt-0.5 text-xs text-kumo-danger">
                {server.error}
              </div>
            )}
          </div>
          {server.state === "authenticating" && server.auth_url && (
            <Button
              size="sm"
              variant="primary"
              icon={<SignInIcon size={12} />}
              onClick={() =>
                window.open(
                  server.auth_url as string,
                  "oauth",
                  "width=600,height=800"
                )
              }
            >
              Auth
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            aria-label={`Remove ${server.name}`}
            icon={<TrashIcon size={12} />}
            onClick={() => onRemove(id)}
          />
        </div>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
        className="flex flex-col gap-2"
      >
        <input
          aria-label="Server name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name"
          className={inputClass}
        />
        <input
          aria-label="Server URL"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://mcp.example.com/mcp"
          className={cn(inputClass, "font-mono text-xs")}
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          icon={<PlusIcon size={12} />}
          disabled={adding || !name.trim() || !url.trim()}
          className="self-start"
        >
          {adding ? "Adding…" : "Add server"}
        </Button>
      </form>
      {state.tools.length > 0 && (
        <p className="text-xs text-kumo-subtle">
          {state.tools.length} tool{state.tools.length === 1 ? "" : "s"} from
          MCP servers are available to the model.
        </p>
      )}
    </div>
  );
}

function Sidebar({
  mcpState,
  onAddServer,
  onRemoveServer,
  onClose
}: {
  mcpState: MCPServersState;
  onAddServer: (name: string, url: string) => Promise<void>;
  onRemoveServer: (id: string) => void;
  onClose?: () => void;
}) {
  return (
    <div className="flex h-full flex-col bg-kumo-elevated">
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
            A <code>AIChatAgent</code> streams replies from Workers AI with{" "}
            <code>streamText</code>. The model can call tools that run on the
            agent, in this page, or only after you allow them.
          </p>
        </SidebarSection>

        <SidebarSection title="Tools">
          <ul className="flex flex-col gap-3">
            {BUILT_IN_TOOLS.map((tool) => (
              <li key={tool.name} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-kumo-default">
                    {tool.name}
                  </span>
                  <span className="text-[11px] text-kumo-subtle">
                    {tool.where}
                  </span>
                </div>
                <span className="text-xs leading-relaxed text-kumo-subtle">
                  {tool.detail}
                </span>
              </li>
            ))}
          </ul>
        </SidebarSection>

        <SidebarSection title="MCP servers">
          <McpServers
            state={mcpState}
            onAdd={onAddServer}
            onRemove={onRemoveServer}
          />
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
          <CloudSunIcon size={20} weight="duotone" />
        </div>
        <h2 className="text-xl font-semibold text-kumo-default">
          What can I help with?
        </h2>
        <p className="max-w-md text-sm text-kumo-subtle">
          Try a prompt that uses a tool, or ask your own question.
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
  const [mcpState, setMcpState] = useState<MCPServersState>({
    prompts: [],
    resources: [],
    servers: {},
    tools: []
  });
  const [mode, toggleMode] = useColorMode();
  const isWide = useMediaQuery("(min-width: 1024px)");
  const [panelOpen, setPanelOpen] = useState(isWide);

  // Open the panel when the window grows wide, close it when it shrinks, so
  // it never covers the chat by surprise.
  useEffect(() => setPanelOpen(isWide), [isWide]);

  const agent = useAgent({
    agent: "ChatAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onMcpUpdate: useCallback((state: MCPServersState) => {
      setMcpState(state);
    }, [])
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    isStreaming
  } = useAgentChat({
    agent,
    experimental_throttle: 100,
    // Custom data sent with every request (available in options.body on server)
    body: {
      clientVersion: "1.0.0"
    },
    // Handle client-side tools (tools without server execute function)
    onToolCall: async ({ toolCall, addToolOutput }) => {
      if (toolCall.toolName === "getUserTimezone") {
        addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            localTime: new Date().toLocaleTimeString()
          }
        });
      }
    }
  });

  const isConnected = connectionStatus === "connected";
  const userMessageCount = messages.filter((m) => m.role === "user").length;
  const lastMessage = messages[messages.length - 1];
  const waitingForReply = isStreaming && lastMessage?.role === "user";

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      setInput("");
      sendMessage({ role: "user", parts: [{ type: "text", text: trimmed }] });
    },
    [isStreaming, sendMessage]
  );

  const addServer = useCallback(
    async (name: string, url: string) => {
      try {
        await agent.call("addServer", [name, url]);
      } catch (error) {
        console.error("Failed to add MCP server:", error);
      }
    },
    [agent]
  );

  const removeServer = useCallback(
    (id: string) => {
      agent.call("removeServer", [id]).catch((error: unknown) => {
        console.error("Failed to remove MCP server:", error);
      });
    },
    [agent]
  );

  const sidebar = (
    <Sidebar
      mcpState={mcpState}
      onAddServer={addServer}
      onRemoveServer={removeServer}
      onClose={isWide ? undefined : () => setPanelOpen(false)}
    />
  );

  return (
    <div className="flex h-full flex-col bg-kumo-base">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-kumo-line px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="text-sm font-semibold text-kumo-default">AI Chat</h1>
          <span className="hidden truncate text-sm text-kumo-subtle sm:inline">
            @cloudflare/ai-chat · Workers AI
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
                ) : (
                  <MessageParts
                    key={message.id}
                    message={message}
                    streaming={isStreaming && index === messages.length - 1}
                    onApproval={(id, approved) =>
                      addToolApprovalResponse({ id, approved })
                    }
                  />
                )
              )
            )}
            {waitingForReply && <Pending />}
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
              placeholder="Ask about the weather, or anything else…"
            />
            <p className="mt-2 hidden text-center text-xs text-kumo-inactive sm:block">
              Enter to send · Shift+Enter for a new line
            </p>
          </div>
        </main>

        {/* Wide screens: a column beside the chat. */}
        {isWide && panelOpen && (
          <aside className="w-80 shrink-0 border-l border-kumo-line">
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
          <aside className="relative w-[min(20rem,85vw)] shadow-xl">
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
