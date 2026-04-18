import "./styles.css";
import { createRoot } from "react-dom/client";
import { useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import {
  Surface,
  Text,
  Button,
  Badge,
  Empty,
  PoweredByCloudflare
} from "@cloudflare/kumo";
import {
  Info as InfoIcon,
  ChatCircleDots,
  ArrowsClockwise,
  Sun,
  Moon
} from "@phosphor-icons/react";

interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  author: string;
  platform: string;
  timestamp: number;
}

interface Stats {
  totalMessages: number;
  channels: string[];
  messageCount: number;
  lastActivity: number;
  platforms: string[];
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => document.documentElement.getAttribute("data-mode") ?? "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
    >
      {mode === "light" ? <Moon size={16} /> : <Sun size={16} />}
    </Button>
  );
}

function ConnectionIndicator({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={`h-2 w-2 rounded-full ${connected ? "bg-kumo-success" : "bg-kumo-danger"}`}
      />
      <Text size="xs" variant="secondary">
        {connected ? "Connected" : "Disconnected"}
      </Text>
    </div>
  );
}

const PLATFORM_LABELS: Record<string, string> = {
  slack: "Slack",
  telegram: "Telegram",
  all: "Bot",
  web: "Web"
};

function PlatformBadge({ platform }: { platform: string }) {
  return <Badge>{PLATFORM_LABELS[platform] ?? platform}</Badge>;
}

function App() {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [connected, setConnected] = useState(false);

  const agent = useAgent({
    agent: "sync-bot",
    name: "default",
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
    onStateUpdate: () => {
      refreshRef.current();
    }
  });

  const refresh = async () => {
    if (!agent) return;
    try {
      const [msgs, st] = await Promise.all([
        agent.call("getRecentMessages", [50]) as Promise<StoredMessage[]>,
        agent.call("getStats", []) as Promise<Stats>
      ]);
      setMessages(msgs);
      setStats(st);
    } catch {
      // Agent may not be ready yet
    }
  };

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (connected) refresh();
  }, [connected]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-kumo-line px-6 py-3">
        <div className="flex items-center gap-3">
          <ChatCircleDots
            size={24}
            weight="bold"
            className="text-kumo-accent"
          />
          <Text size="lg" bold>
            SyncBot
          </Text>
          {stats && stats.platforms.length > 0 && (
            <div className="flex gap-1">
              {stats.platforms.map((p) => (
                <PlatformBadge key={p} platform={p} />
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <ConnectionIndicator connected={connected} />
          <Button size="sm" variant="ghost" onClick={refresh}>
            <ArrowsClockwise size={16} />
          </Button>
          <ModeToggle />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {/* Info card */}
          <Surface className="rounded-xl p-4 ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="mt-0.5 shrink-0 text-kumo-accent"
              />
              <div>
                <Text size="sm" bold>
                  Cross-Platform AI Agent
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    One agent, one conversation, multiple platforms. Messages
                    from Slack and Telegram are unified into a single
                    conversation history. The agent responds on every connected
                    platform simultaneously.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {/* Stats */}
          {stats && (
            <div className="grid grid-cols-3 gap-3">
              <Surface className="rounded-lg p-3 text-center ring ring-kumo-line">
                <Text size="xs" variant="secondary">
                  Messages
                </Text>
                <div className="mt-1">
                  <Text size="lg" bold>
                    {stats.totalMessages}
                  </Text>
                </div>
              </Surface>
              <Surface className="rounded-lg p-3 text-center ring ring-kumo-line">
                <Text size="xs" variant="secondary">
                  Platforms
                </Text>
                <div className="mt-1">
                  <Text size="lg" bold>
                    {stats.platforms.length}
                  </Text>
                </div>
              </Surface>
              <Surface className="rounded-lg p-3 text-center ring ring-kumo-line">
                <Text size="xs" variant="secondary">
                  Last Active
                </Text>
                <div className="mt-1">
                  <Text size="sm" bold>
                    {stats.lastActivity
                      ? formatTime(stats.lastActivity)
                      : "Never"}
                  </Text>
                </div>
              </Surface>
            </div>
          )}

          {/* Messages */}
          <Surface className="rounded-xl ring ring-kumo-line">
            <div className="border-b border-kumo-line px-4 py-3">
              <Text size="sm" bold>
                Unified Conversation
              </Text>
            </div>
            <div className="p-4">
              {messages.length === 0 ? (
                <Empty
                  icon={<ChatCircleDots size={32} />}
                  title="No messages yet"
                  description="Message the bot on Slack or Telegram to start"
                />
              ) : (
                <div className="space-y-3">
                  {messages.map((msg, i) => (
                    <div
                      key={i}
                      className={`flex gap-3 ${msg.role === "assistant" ? "pl-4" : ""}`}
                    >
                      <div
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                          msg.role === "user"
                            ? "bg-kumo-subtle text-kumo-accent"
                            : "bg-kumo-subtle text-kumo-default"
                        }`}
                      >
                        {msg.role === "user" ? "U" : "B"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Text size="xs" bold>
                            {msg.author}
                          </Text>
                          <Text size="xs" variant="secondary">
                            {formatTime(msg.timestamp)}
                          </Text>
                          <PlatformBadge platform={msg.platform} />
                        </div>
                        <div className="mt-0.5">
                          <Text size="sm">
                            {msg.content.length > 300
                              ? msg.content.slice(0, 300) + "..."
                              : msg.content}
                          </Text>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Surface>
        </div>
      </div>

      {/* Footer */}
      <div className="flex justify-center border-t border-kumo-line p-4">
        <PoweredByCloudflare />
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

createRoot(document.getElementById("root")!).render(<App />);
