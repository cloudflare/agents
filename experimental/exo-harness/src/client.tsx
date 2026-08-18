import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
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
  BrainIcon,
  FolderIcon,
  InfoIcon,
  PaperPlaneRightIcon,
  ScrollIcon,
  StackIcon,
  StopIcon,
  TrashIcon
} from "@phosphor-icons/react";
import { INITIAL_STATE, type ExoState } from "./kernel/types";
import { AssistantMessage, getMessageText } from "./ui/chat-message";
import {
  ConnectionIndicator,
  ModeToggle,
  shortSha,
  type AgentCaller,
  type ConnectionStatus
} from "./ui/bits";
import { SelfTab } from "./ui/self-tab";
import { JournalTab } from "./ui/journal-tab";
import { WorkspaceTab } from "./ui/workspace-tab";
import { ContextTab } from "./ui/context-tab";
import "./styles.css";

type Tab = "self" | "context" | "journal" | "workspace";

// Which self to open: /?agent=<name>. Forked agents link here; the default
// is the one shared long-lived agent.
const AGENT_NAME =
  new URLSearchParams(window.location.search).get("agent")?.trim() || "main";

const TABS: { id: Tab; label: string; icon: typeof BrainIcon }[] = [
  { id: "self", label: "Self", icon: BrainIcon },
  { id: "context", label: "Context", icon: StackIcon },
  { id: "journal", label: "Journal", icon: ScrollIcon },
  { id: "workspace", label: "Workspace", icon: FolderIcon }
];

const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 960;
const PANEL_DEFAULT_WIDTH = 440;
const PANEL_WIDTH_KEY = "exo-panel-width";

function clampPanelWidth(width: number): number {
  const max = Math.min(PANEL_MAX_WIDTH, window.innerWidth - 420);
  return Math.min(
    Math.max(width, PANEL_MIN_WIDTH),
    Math.max(max, PANEL_MIN_WIDTH)
  );
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [exoState, setExoState] = useState<ExoState>(INITIAL_STATE);
  const [tab, setTab] = useState<Tab>("self");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const bootedRef = useRef(false);

  // Resizable glass-skull panel: drag the divider (or use arrow keys on it).
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0
      ? clampPanelWidth(stored)
      : PANEL_DEFAULT_WIDTH;
  });
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
  }, [panelWidth]);

  const agent = useAgent<ExoState>({
    agent: "ExoKernel",
    // A persistent self per name; fork_self spawns siblings under new names.
    name: AGENT_NAME,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onStateUpdate: useCallback((state: ExoState) => setExoState(state), [])
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";

  // Trigger genesis (seed harness + v1 commit) on first connect.
  useEffect(() => {
    if (!isConnected || bootedRef.current) return;
    bootedRef.current = true;
    void agent
      .call("boot")
      .then((state) => setExoState(state as ExoState))
      .catch(() => {
        bootedRef.current = false;
      });
  }, [isConnected, agent]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  const caller = agent as unknown as AgentCaller;

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-3 bg-kumo-base border-b border-kumo-line shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrainIcon size={20} className="text-kumo-accent" />
            <h1 className="text-lg font-semibold text-kumo-default">
              Exo Harness
            </h1>
            <Badge variant="secondary">{AGENT_NAME}</Badge>
            <Badge variant="primary">
              v{exoState.activeVersion}
              {exoState.activeSha ? ` · ${shortSha(exoState.activeSha)}` : ""}
            </Badge>
            <Badge variant="secondary">self-modifying</Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear chat
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Chat pane */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="px-5 pt-4 shrink-0">
            <Surface className="p-4 rounded-xl ring ring-kumo-line">
              <div className="flex gap-3">
                <InfoIcon
                  size={20}
                  weight="bold"
                  className="text-kumo-accent shrink-0 mt-0.5"
                />
                <div>
                  <Text size="sm" bold>
                    A self-modifying agent, with its skull open
                  </Text>
                  <span className="mt-1 block">
                    <Text size="xs" variant="secondary">
                      The agent's identity, model policy, and tools are files it
                      can rewrite (left: talk to it; right: watch its source,
                      versions, and append-only journal change live). Try:
                      "rewrite your identity to be a laconic pirate, then
                      activate" — or break it and watch the kernel roll it back.
                    </Text>
                  </span>
                </div>
              </div>
            </Surface>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
              {messages.length === 0 && (
                <Empty
                  icon={<BrainIcon size={32} />}
                  title="Talk to your agent"
                  description="It can read and rewrite its own harness — every change is versioned and journaled."
                />
              )}
              {messages.map((message, index) =>
                message.role === "user" ? (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed whitespace-pre-wrap break-words">
                      {getMessageText(message)}
                    </div>
                  </div>
                ) : (
                  <AssistantMessage
                    key={message.id}
                    message={message}
                    isLastAssistant={index === messages.length - 1}
                    isStreaming={isStreaming}
                  />
                )
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="px-5 pb-3 shrink-0">
            <form
              className="max-w-3xl mx-auto"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
                <InputArea
                  value={input}
                  onValueChange={(value: string) => setInput(value)}
                  onKeyDown={(event: React.KeyboardEvent) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      send();
                    }
                  }}
                  placeholder={
                    isConnected ? "Message your agent…" : "Connecting…"
                  }
                  disabled={!isConnected}
                  rows={2}
                  className="flex-1 !resize-none !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
                />
                {isStreaming ? (
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop"
                    onClick={() => stop()}
                    icon={<StopIcon size={16} weight="fill" />}
                    className="mb-0.5"
                  />
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    aria-label="Send"
                    disabled={!input.trim() || !isConnected}
                    icon={<PaperPlaneRightIcon size={16} />}
                    className="mb-0.5"
                  />
                )}
              </div>
              <div className="mt-2 flex justify-center">
                <PoweredByCloudflare />
              </div>
            </form>
          </div>
        </div>

        {/* Divider: drag (or arrow keys) to resize the glass skull */}
        <button
          type="button"
          aria-label="Resize side panel (drag, or use arrow keys)"
          onPointerDown={(event) => {
            dragRef.current = { startX: event.clientX, startWidth: panelWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!dragRef.current) return;
            const delta = dragRef.current.startX - event.clientX;
            setPanelWidth(clampPanelWidth(dragRef.current.startWidth + delta));
          }}
          onPointerUp={(event) => {
            dragRef.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              setPanelWidth((width) => clampPanelWidth(width + 32));
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              setPanelWidth((width) => clampPanelWidth(width - 32));
            }
          }}
          className="self-stretch w-1.5 p-0 m-0 border-0 shrink-0 cursor-col-resize bg-kumo-elevated hover:bg-kumo-accent/40 focus-visible:bg-kumo-accent/60 focus-visible:outline-none transition-colors touch-none"
        />

        {/* Glass skull */}
        <div
          style={{ width: panelWidth }}
          className="border-l border-kumo-line bg-kumo-base flex flex-col shrink-0 min-h-0"
        >
          <div className="px-2 pt-2 flex gap-1 border-b border-kumo-line shrink-0">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`px-3 py-2 flex items-center gap-1.5 text-xs font-medium rounded-t-md cursor-pointer ${
                  tab === id
                    ? "text-kumo-default bg-kumo-elevated border border-b-0 border-kumo-line"
                    : "text-kumo-inactive hover:text-kumo-default"
                }`}
              >
                <Icon size={14} />
                {label}
                {id === "journal" && exoState.journalTail.length > 0 && (
                  <Badge variant="secondary">
                    {exoState.journalTail[exoState.journalTail.length - 1].id}
                  </Badge>
                )}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0">
            {tab === "self" && (
              <SelfTab
                agent={caller}
                state={exoState}
                isConnected={isConnected}
              />
            )}
            {tab === "context" && (
              <ContextTab
                agent={caller}
                state={exoState}
                isConnected={isConnected}
              />
            )}
            {tab === "journal" && <JournalTab state={exoState} />}
            {tab === "workspace" && (
              <WorkspaceTab
                agent={caller}
                state={exoState}
                isConnected={isConnected}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
