import "./styles.css";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";
import { isToolUIPart, getToolName } from "ai";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { Streamdown } from "streamdown";
import { code as codePlugin } from "@streamdown/code";
import type { BrowserLiveView, BrowserLiveViewTarget } from "agents/browser";
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
  ArrowSquareOutIcon,
  BrainIcon,
  CaretDownIcon,
  GearIcon,
  GlobeIcon,
  InfoIcon,
  MonitorIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  StopIcon,
  SunIcon,
  TrashIcon
} from "@phosphor-icons/react";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Detect a base64 screenshot (`{ data, format }`) in a tool's output. */
function getScreenshotSrc(outer: unknown): string | null {
  const output =
    isRecord(outer) && isRecord(outer.result) ? outer.result : outer;
  if (!isRecord(output) || typeof output.data !== "string") return null;
  const format = output.format;
  const mime =
    format === "jpeg" || format === "jpg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${output.data}`;
}

function formatOutput(output: unknown, screenshotSrc: string | null): string {
  if (typeof output === "string") return output;
  if (screenshotSrc && isRecord(output)) {
    const omit = "[base64 image omitted]";
    const redacted = isRecord(output.result)
      ? { ...output, result: { ...output.result, data: omit } }
      : { ...output, data: omit };
    return JSON.stringify(redacted, null, 2);
  }
  return JSON.stringify(output, null, 2);
}

/** A small labeled, scrollable code/JSON block used for tool input & output. */
function ToolBlock({
  label,
  children,
  tone = "default"
}: {
  label: string;
  children: string;
  tone?: "default" | "error";
}) {
  return (
    <div className="mt-2">
      <Text size="xs" variant="secondary">
        {label}
      </Text>
      <pre
        className={`mt-1 max-h-52 overflow-auto rounded-lg p-2 font-mono text-xs whitespace-pre-wrap ${
          tone === "error"
            ? "bg-red-50 text-red-600 dark:bg-red-950/20 dark:text-red-400"
            : "bg-kumo-elevated text-kumo-subtle"
        }`}
      >
        {children}
      </pre>
    </div>
  );
}

function ToolPart({
  part,
  isStreaming
}: {
  part: ToolUIPart | DynamicToolUIPart;
  isStreaming: boolean;
}) {
  const toolName = getToolName(part);
  const toolInput = part.input as Record<string, unknown> | undefined;
  const toolOutput = (part as { output?: unknown }).output;
  const errorText = (part as { errorText?: string }).errorText;
  const screenshotSrc = getScreenshotSrc(toolOutput);
  // The `execute` tool's input is TypeScript source; render it as code. Every
  // other tool gets its full input object rendered as JSON.
  const code =
    isRecord(toolInput) && typeof toolInput.code === "string"
      ? toolInput.code
      : null;
  const hasInputJson =
    !code && isRecord(toolInput) && Object.keys(toolInput).length > 0;
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";

  return (
    <Surface className="max-w-[85%] overflow-hidden rounded-xl px-4 py-2.5 ring ring-kumo-line">
      <div className="flex items-center gap-2">
        <GearIcon
          size={14}
          className={`text-kumo-inactive ${isRunning ? "animate-spin" : ""}`}
        />
        <Text size="xs" variant="secondary" bold>
          {isRunning ? `Running ${toolName}...` : toolName}
        </Text>
        {part.state === "output-available" && (
          <Badge variant="secondary">Done</Badge>
        )}
        {part.state === "output-error" && (
          <Badge variant="destructive">Error</Badge>
        )}
      </div>
      {code != null && <ToolBlock label="Input">{code}</ToolBlock>}
      {hasInputJson && (
        <ToolBlock label="Input">
          {JSON.stringify(toolInput, null, 2)}
        </ToolBlock>
      )}
      {errorText && (
        <ToolBlock label="Error" tone="error">
          {errorText}
        </ToolBlock>
      )}
      {toolOutput != null && !isStreaming && (
        <div className="mt-2">
          {screenshotSrc && (
            <img
              src={screenshotSrc}
              alt="Browser screenshot"
              className="mb-2 block max-h-72 w-full rounded-md object-contain"
            />
          )}
          <ToolBlock label="Output">
            {formatOutput(toolOutput, screenshotSrc)}
          </ToolBlock>
        </div>
      )}
    </Surface>
  );
}

/**
 * The model's reasoning trace for a turn. Collapsible (open while it streams in
 * so you can watch it think, collapsible afterward to keep the transcript tidy).
 */
function ReasoningPart({
  text,
  streaming
}: {
  text: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(true);
  if (!text) return null;
  return (
    <Surface className="max-w-[85%] overflow-hidden rounded-xl px-4 py-2.5 ring ring-kumo-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <BrainIcon
          size={14}
          className={`text-kumo-inactive ${streaming ? "animate-pulse" : ""}`}
        />
        <Text size="xs" variant="secondary" bold>
          {streaming ? "Thinking..." : "Reasoning"}
        </Text>
        <CaretDownIcon
          size={12}
          className={`ml-auto text-kumo-inactive transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
      </button>
      {open && (
        <p className="mt-2 leading-relaxed whitespace-pre-wrap text-sm text-kumo-subtle italic">
          {text}
        </p>
      )}
    </Surface>
  );
}

// A Browser Run session always carries an initial `about:blank` tab and may
// have chrome:// internals. Show only the real pages the agent opened.
function visibleTargets(
  liveView: BrowserLiveView | null
): BrowserLiveViewTarget[] {
  return (liveView?.targets ?? []).filter((target) => {
    if (target.type && target.type !== "page") return false;
    const page = target.pageUrl ?? "";
    if (!page || page === "about:blank") return false;
    if (page.startsWith("chrome://") || page.startsWith("devtools://"))
      return false;
    return true;
  });
}

function tabLabel(target: BrowserLiveViewTarget): string {
  const title = target.title?.trim();
  if (title) return title;
  if (target.pageUrl) {
    try {
      return new URL(target.pageUrl).hostname || target.pageUrl;
    } catch {
      return target.pageUrl;
    }
  }
  return "New tab";
}

function LiveBrowserPanel({
  targets,
  selectedTargetId,
  embeddedSrc,
  onSelect,
  busy,
  error,
  onRefresh,
  onReset
}: {
  targets: BrowserLiveViewTarget[];
  selectedTargetId: string | null;
  embeddedSrc: string | null;
  onSelect: (target: BrowserLiveViewTarget) => void;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onReset: () => void;
}) {
  const selected =
    targets.find((target) => target.targetId === selectedTargetId) ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-kumo-line px-4 py-3">
        <div className="flex items-center gap-2">
          <MonitorIcon size={16} className="text-kumo-accent" />
          <Text size="sm" bold>
            Live browser
          </Text>
          {targets.length > 0 && (
            <Badge variant="secondary">
              {targets.length} tab{targets.length === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            aria-label="Refresh tab list"
            disabled={busy}
            onClick={onRefresh}
            icon={<ArrowClockwiseIcon size={14} />}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label="Reset browser session"
            disabled={busy}
            onClick={onReset}
            icon={<TrashIcon size={14} />}
          >
            Reset
          </Button>
        </div>
      </div>

      {error && (
        <p className="border-b border-kumo-line px-4 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {targets.length === 0 ? (
        <div className="flex-1 overflow-y-auto p-4">
          <Empty
            icon={<GlobeIcon size={28} />}
            title="No browser session yet"
            description="Ask the agent to open a page (for example: 'open example.com'). The tab shows up here, live."
          />
        </div>
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Open browser tabs"
            className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-kumo-line bg-kumo-elevated px-2 py-1.5"
          >
            {targets.map((target) => {
              const active = target.targetId === selectedTargetId;
              return (
                <button
                  key={target.targetId}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={target.pageUrl ?? tabLabel(target)}
                  onClick={() => onSelect(target)}
                  className={`flex max-w-48 shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                    active
                      ? "bg-kumo-base text-kumo-default ring ring-kumo-line"
                      : "text-kumo-subtle hover:bg-kumo-base/60"
                  }`}
                >
                  <GlobeIcon size={12} className="shrink-0" />
                  <span className="truncate">{tabLabel(target)}</span>
                </button>
              );
            })}
          </div>

          {selected && (
            <div className="flex items-center justify-between gap-2 border-b border-kumo-line px-3 py-1.5">
              <span className="truncate font-mono text-xs text-kumo-subtle">
                {selected.pageUrl ?? selected.targetId}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  shape="square"
                  aria-label="Reload embedded tab"
                  onClick={() => onSelect(selected)}
                  icon={<ArrowClockwiseIcon size={13} />}
                />
                <a
                  href={selected.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open in a new browser tab"
                  className="inline-flex items-center gap-1 rounded-lg border border-kumo-line px-2 py-1 text-xs text-kumo-default hover:bg-kumo-elevated"
                >
                  <ArrowSquareOutIcon size={13} />
                  Open
                </a>
              </div>
            </div>
          )}

          {/* The embedded Live View ships its own back/forward/refresh + URL
              bar, so we just host the selected tab here. */}
          <div className="min-h-0 flex-1 bg-white">
            {embeddedSrc && (
              <iframe
                key={selectedTargetId ?? embeddedSrc}
                title="Live browser session"
                src={embeddedSrc}
                className="h-full w-full"
                allow="clipboard-read; clipboard-write"
              />
            )}
          </div>

          <div className="border-t border-kumo-line px-4 py-2">
            <Text size="xs" variant="secondary">
              Type directly in the embedded view to complete logins or CAPTCHAs.
              If a page blocks embedding, use Open. When you are done, tell the
              agent to continue.
            </Text>
          </div>
        </>
      )}
    </div>
  );
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "LiveViewAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (event: Event) => console.error("Agent connection error", event),
      []
    )
  });

  const { messages, sendMessage, clearHistory, stop, isStreaming } =
    useAgentChat({ agent, experimental_throttle: 100 });

  const isConnected = connectionStatus === "connected";

  // Live View state lives here, where the untyped `agent.call` is in scope.
  const [liveView, setLiveView] = useState<BrowserLiveView | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  // `embeddedSrc` is captured only when the selection changes, so the periodic
  // refresh (which re-mints Live View URLs) never reloads the iframe out from
  // under a human mid-task.
  const [embeddedSrc, setEmbeddedSrc] = useState<string | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  const targets = visibleTargets(liveView);

  const selectTab = useCallback((target: BrowserLiveViewTarget) => {
    setSelectedTargetId(target.targetId);
    setEmbeddedSrc(target.url);
  }, []);

  const refreshLiveView = useCallback(async () => {
    setLiveBusy(true);
    setLiveError(null);
    try {
      const result = (await agent.call(
        "liveView",
        []
      )) as BrowserLiveView | null;
      setLiveView(result);
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setLiveBusy(false);
    }
  }, [agent]);

  const resetBrowser = useCallback(async () => {
    setLiveBusy(true);
    setLiveError(null);
    try {
      await agent.call("closeBrowser", []);
      setLiveView(null);
      setSelectedTargetId(null);
      setEmbeddedSrc(null);
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setLiveBusy(false);
    }
  }, [agent]);

  // Refresh the tab list when a turn finishes (the model may have opened a
  // page) and on a light interval — without touching the embedded iframe, so a
  // human mid-task is never interrupted by a reload.
  useEffect(() => {
    if (isConnected && !isStreaming) void refreshLiveView();
  }, [isConnected, isStreaming, refreshLiveView]);

  useEffect(() => {
    if (!isConnected) return;
    const id = setInterval(() => void refreshLiveView(), 12_000);
    return () => clearInterval(id);
  }, [isConnected, refreshLiveView]);

  // Keep a tab embedded: hold the current selection while it exists, otherwise
  // auto-embed the first available tab (and capture its src once).
  useEffect(() => {
    const current = targets.find((t) => t.targetId === selectedTargetId);
    if (current) {
      if (!embeddedSrc) setEmbeddedSrc(current.url);
      return;
    }
    const next = targets[0] ?? null;
    setSelectedTargetId(next?.targetId ?? null);
    setEmbeddedSrc(next?.url ?? null);
  }, [targets, selectedTargetId, embeddedSrc]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="flex h-screen flex-col bg-kumo-elevated text-kumo-default">
      <header className="border-b border-kumo-line bg-kumo-base px-5 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">Browser Live View</h1>
            <Badge variant="secondary">
              <GlobeIcon size={12} weight="bold" className="mr-1" />
              Human in the loop
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[1fr_26rem]">
        {/* Chat column */}
        <div className="flex min-h-0 flex-col border-kumo-line lg:border-r">
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-2xl space-y-5 px-5 py-6">
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
                        The agent drives a real browser over CDP. When a step
                        needs you (login, CAPTCHA, sensitive input), it hands
                        off via a Live View URL — open the Live browser panel,
                        complete the step, then tell the agent to continue. The
                        session persists across turns.
                      </Text>
                    </span>
                  </div>
                </div>
              </Surface>

              {messages.length === 0 && (
                <Empty
                  icon={<GlobeIcon size={32} />}
                  title="Start a conversation"
                  description="Try: 'Open example.com and tell me the page title', or 'Go to a login page and let me sign in.'"
                />
              )}

              {messages.map((message, index) => {
                if (message.role === "user") {
                  return (
                    <div key={message.id} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 leading-relaxed text-kumo-inverse">
                        {message.parts
                          .filter((p) => p.type === "text")
                          .map((p) => (p as { text: string }).text)
                          .join("")}
                      </div>
                    </div>
                  );
                }

                const isLastAssistant = index === messages.length - 1;

                return (
                  <div key={message.id} className="space-y-2">
                    {message.parts.map((part, i) => {
                      if (part.type === "reasoning") {
                        return (
                          <div key={i} className="flex justify-start">
                            <ReasoningPart
                              text={part.text}
                              streaming={
                                isStreaming && part.state === "streaming"
                              }
                            />
                          </div>
                        );
                      }
                      if (part.type === "text") {
                        if (
                          part.text.length === 0 &&
                          part.state !== "streaming"
                        )
                          return null;
                        const isLastTextPart = message.parts
                          .slice(i + 1)
                          .every((p) => p.type !== "text");
                        return (
                          <div key={i} className="flex justify-start">
                            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base px-4 py-2.5 leading-relaxed">
                              <Streamdown
                                className="sd-theme min-h-[1.25em]"
                                plugins={{ code: codePlugin }}
                                controls={false}
                                isAnimating={
                                  isLastAssistant &&
                                  isLastTextPart &&
                                  isStreaming
                                }
                              >
                                {part.text}
                              </Streamdown>
                            </div>
                          </div>
                        );
                      }
                      if (!isToolUIPart(part)) return null;
                      return (
                        <div
                          key={part.toolCallId}
                          className="flex justify-start"
                        >
                          <ToolPart part={part} isStreaming={isStreaming} />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="border-t border-kumo-line bg-kumo-base">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
              className="mx-auto max-w-2xl px-5 py-4"
            >
              <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring">
                <InputArea
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder="Try: open example.com and read the heading"
                  disabled={!isConnected || isStreaming}
                  rows={2}
                  className="flex-1 !bg-transparent !shadow-none !ring-0 !outline-none focus:!ring-0"
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
        </div>

        {/* Live browser column */}
        <div className="hidden min-h-0 bg-kumo-base lg:block">
          <LiveBrowserPanel
            targets={targets}
            selectedTargetId={selectedTargetId}
            embeddedSrc={embeddedSrc}
            onSelect={selectTab}
            busy={liveBusy}
            error={liveError}
            onRefresh={() => void refreshLiveView()}
            onReset={() => void resetBrowser()}
          />
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <Suspense
    fallback={
      <div className="flex h-screen items-center justify-center text-kumo-inactive">
        Loading...
      </div>
    }
  >
    <App />
  </Suspense>
);
