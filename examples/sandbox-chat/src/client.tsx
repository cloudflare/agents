import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import {
  Button,
  Badge,
  InputArea,
  Surface,
  Text,
  PoweredByCloudflare
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  InfoIcon,
  TerminalIcon,
  GlobeIcon,
  CaretRightIcon,
  CaretLeftIcon
} from "@phosphor-icons/react";

import { FileBrowser, type FileBrowserHandle } from "./client/file-browser";
import { ChatMessages } from "./client/chat-messages";
import { TerminalPanel } from "./client/terminal-panel";
import { PreviewPanel } from "./client/preview-panel";
import {
  ConnectionIndicator,
  type ConnectionStatus
} from "./client/connection-indicator";
import { ModeToggle } from "./client/mode-toggle";
import { ResizeHandle } from "./client/resize-handle";

/** Type for agent.call() — avoids double-casting useAgent's return type. */
type AgentCallFn = (method: string, args: unknown[]) => Promise<unknown>;

// ── Session management ──────────────────────────────────────────────

const STORAGE_KEY = "sandbox-chat-session-id";

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return "default";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}

function newSessionId(): string {
  const id = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}

// ── Main chat component ─────────────────────────────────────────────

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(224);
  const [terminalWidth, setTerminalWidth] = useState(384);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"terminal" | "preview">("terminal");

  const onSidebarResize = useCallback(
    (delta: number) =>
      setSidebarWidth((w) => Math.max(160, Math.min(480, w + delta))),
    []
  );

  const onTerminalResize = useCallback(
    (delta: number) =>
      setTerminalWidth((w) => Math.max(240, Math.min(720, w - delta))),
    []
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileBrowserRef = useRef<FileBrowserHandle>(null);
  const [sessionId, setSessionId] = useState(getOrCreateSessionId);
  const handleAgentMessage = useCallback((ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    try {
      const msg = JSON.parse(ev.data) as Record<string, unknown>;
      if (msg.type === "file-change" && typeof msg.path === "string") {
        fileBrowserRef.current?.notifyChange(msg.path as string);
      }
      if (msg.type === "preview-url" && typeof msg.url === "string") {
        setPreviewUrl(msg.url as string);
        setRightTab("preview");
      }
    } catch {
      // ignore
    }
  }, []);

  const agent = useAgent({
    agent: "SandboxChatAgent",
    name: sessionId,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onMessage: handleAgentMessage
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";
  const prevStreamingRef = useRef(false);

  // Recover preview URL on reconnect
  useEffect(() => {
    if (!isConnected) return;
    (agent.call as AgentCallFn)("getPreviewUrl", [])
      .then((result) => {
        const data = result as { url: string; port: number } | null;
        if (data?.url) {
          setPreviewUrl(data.url);
        }
      })
      .catch(() => {
        /* ignore */
      });
  }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      fileBrowserRef.current?.refresh();
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

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
    <div className="flex h-screen bg-kumo-elevated">
      {/* Left sidebar — File Browser */}
      <div
        style={{ width: sidebarWidth }}
        className="bg-kumo-base flex flex-col shrink-0"
      >
        <FileBrowser
          ref={fileBrowserRef}
          agent={{ call: agent.call as AgentCallFn }}
          isConnected={isConnected}
        />
      </div>

      <ResizeHandle onResize={onSidebarResize} />

      {/* Centre — chat */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="px-5 py-3 bg-kumo-base border-b border-kumo-line">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-kumo-default">
                Sandbox Chat
              </h1>
              <Badge variant="secondary">
                <TerminalIcon size={12} weight="bold" className="mr-1" />
                AI + Container
              </Badge>
            </div>
            <div className="flex items-center gap-3">
              <ConnectionIndicator status={connectionStatus} />
              <ModeToggle />
              <Button
                variant="ghost"
                shape="square"
                aria-label="Toggle right panel"
                icon={
                  terminalOpen ? (
                    <CaretRightIcon size={16} />
                  ) : (
                    <CaretLeftIcon size={16} />
                  )
                }
                onClick={() => setTerminalOpen((v) => !v)}
              />
              <Button
                variant="secondary"
                icon={<TrashIcon size={16} />}
                onClick={() => {
                  clearHistory();
                  setSessionId(newSessionId());
                  setPreviewUrl(null);
                  setRightTab("terminal");
                }}
              >
                New Session
              </Button>
            </div>
          </div>
        </header>

        {/* Explainer */}
        <div className="px-5 pt-4">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  Sandbox Chat
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    An AI assistant backed by an isolated Linux container. Ask
                    it to create files, write code, run shell commands, use git,
                    or explore the sandbox filesystem. Files persist across
                    conversations via R2 backups.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>
        </div>

        {/* Messages */}
        <ChatMessages
          messages={messages}
          isStreaming={isStreaming}
          messagesEndRef={messagesEndRef}
        />

        {/* Input */}
        <div className="border-t border-kumo-line bg-kumo-base">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
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
                    send();
                  }
                }}
                placeholder='Try: "Create a Node.js project with tests" or "Run ls -la /workspace"'
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
      </div>

      {/* Right panel — Terminal / Preview */}
      {terminalOpen && (
        <>
          <ResizeHandle onResize={onTerminalResize} />
          <div
            style={{ width: terminalWidth }}
            className="flex flex-col shrink-0"
          >
            {/* Tab bar */}
            <div className="flex items-center px-3 border-b border-kumo-line bg-kumo-base shrink-0">
              <button
                type="button"
                onClick={() => setRightTab("terminal")}
                className={`px-3 py-3 text-xs font-medium flex items-center gap-1.5 border-b-2 transition-colors ${
                  rightTab === "terminal"
                    ? "border-kumo-accent text-kumo-default"
                    : "border-transparent text-kumo-subtle hover:text-kumo-default"
                }`}
              >
                <TerminalIcon size={13} />
                Terminal
              </button>
              <button
                type="button"
                onClick={() => setRightTab("preview")}
                className={`px-3 py-3 text-xs font-medium flex items-center gap-1.5 border-b-2 transition-colors ${
                  rightTab === "preview"
                    ? "border-kumo-accent text-kumo-default"
                    : "border-transparent text-kumo-subtle hover:text-kumo-default"
                }`}
              >
                <GlobeIcon size={13} />
                Preview
                {previewUrl && (
                  <span className="size-1.5 rounded-full bg-green-500" />
                )}
              </button>
            </div>
            {/* Panels — both mounted, toggle visibility via CSS */}
            <div
              className="flex-1 overflow-hidden"
              style={{
                display: rightTab === "terminal" ? "flex" : "none",
                flexDirection: "column"
              }}
            >
              <TerminalPanel agentName={sessionId} isConnected={isConnected} />
            </div>
            <div
              className="flex-1 overflow-hidden"
              style={{
                display: rightTab === "preview" ? "flex" : "none",
                flexDirection: "column"
              }}
            >
              <PreviewPanel url={previewUrl} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
