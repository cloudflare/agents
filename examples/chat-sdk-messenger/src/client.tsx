import "./styles.css";

import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import {
  ArrowClockwiseIcon,
  ChatsIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  ProhibitIcon,
  SunIcon,
  TrashIcon
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { UIMessage } from "ai";
import type {
  AdminConversation,
  AdminReplyJob,
  AdminSetupInfo,
  TelegramWebhookSetupResult
} from "./index";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

const TERMINAL_REPLY_STATUSES = new Set([
  "completed",
  "aborted",
  "interrupted",
  "error"
]);

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

function formatTime(value?: number) {
  return value ? new Date(value).toLocaleString() : "-";
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > 8_000
      ? `${json.slice(0, 8_000)}\n... truncated`
      : json;
  } catch {
    return String(value);
  }
}

function partRecord(part: UIMessage["parts"][number]): Record<string, unknown> {
  return part as unknown as Record<string, unknown>;
}

function partLabel(part: UIMessage["parts"][number]): string {
  const { type } = part;
  if (type === "text") {
    return "Text";
  }
  if (type.includes("reasoning")) {
    return "Reasoning trace";
  }
  if (type.startsWith("tool-")) {
    return `Tool ${type.slice("tool-".length)}`;
  }
  if (type.includes("tool")) {
    return "Tool event";
  }
  return type;
}

function MessageParts({ message }: { message: UIMessage }) {
  if (message.parts.length === 0) {
    return <div className="text-sm text-kumo-subtle">(empty message)</div>;
  }

  return (
    <div className="space-y-2 text-sm">
      {message.parts.map((part, index) => {
        const record = partRecord(part);
        const text = typeof record.text === "string" ? record.text : undefined;
        if (part.type === "text" && text !== undefined) {
          return (
            <div key={index} className="whitespace-pre-wrap">
              {text || "(empty text)"}
            </div>
          );
        }

        return (
          <details
            key={index}
            className="rounded-md border border-kumo-line bg-kumo-surface p-2"
          >
            <summary className="cursor-pointer text-xs font-medium uppercase text-kumo-subtle">
              {partLabel(part)}
            </summary>
            {text && (
              <div className="mt-2 whitespace-pre-wrap text-sm">{text}</div>
            )}
            <pre className="mt-2 max-h-80 overflow-auto rounded bg-kumo-base p-2 text-xs">
              {safeJson(part)}
            </pre>
          </details>
        );
      })}
    </div>
  );
}

function replyStatusBadge(job: AdminReplyJob) {
  return <Badge>{job.status}</Badge>;
}

function LocalhostTunnelModal() {
  const [dismissed, setDismissed] = useState(false);
  const isLocalhost =
    window.location.protocol !== "https:" &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1");

  if (!isLocalhost || dismissed) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <Surface className="max-w-lg rounded-2xl p-6 shadow-2xl ring ring-kumo-line">
        <div className="flex gap-3">
          <InfoIcon
            size={24}
            weight="bold"
            className="mt-0.5 shrink-0 text-kumo-accent"
          />
          <div>
            <Text size="lg" bold>
              Open the tunnel URL
            </Text>
            <span className="mt-3 block">
              <Text size="sm" variant="secondary">
                This example starts a Quick Tunnel for Telegram webhooks. Check
                the terminal where `npm start` is running, copy the printed
                `trycloudflare.com` URL, and open that HTTPS page instead.
              </Text>
            </span>
            <span className="mt-3 block">
              <Text size="sm" variant="secondary">
                Telegram cannot use `localhost` as a webhook URL, so the setup
                button only works from the tunnel or deployed Worker URL.
              </Text>
            </span>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button onClick={() => window.location.reload()}>
                I opened the tunnel URL
              </Button>
              <Button variant="secondary" onClick={() => setDismissed(true)}>
                Continue locally
              </Button>
            </div>
          </div>
        </div>
      </Surface>
    </div>
  );
}

function SetupCard({ setup }: { setup: AdminSetupInfo | null }) {
  const [isSettingWebhook, setIsSettingWebhook] = useState(false);
  const [webhookResult, setWebhookResult] = useState<string | null>(null);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const webhookUrl = setup
    ? `${window.location.origin}${setup.webhookPath}`
    : `${window.location.origin}/webhooks/telegram`;
  const isHttpsOrigin = window.location.protocol === "https:";

  async function setTelegramWebhook() {
    setIsSettingWebhook(true);
    setWebhookResult(null);
    setWebhookError(null);
    try {
      const response = await fetch("/setup/telegram-webhook", {
        method: "POST"
      });
      const result = (await response.json()) as
        | TelegramWebhookSetupResult
        | { ok: false; error?: string };

      if (!response.ok || !result.ok) {
        throw new Error(
          "error" in result && result.error
            ? result.error
            : "Failed to set Telegram webhook."
        );
      }

      setWebhookResult(
        result.alreadyConfigured
          ? "Telegram already points at this tunnel."
          : result.description
      );
    } catch (error) {
      setWebhookError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSettingWebhook(false);
    }
  }

  return (
    <Surface className="rounded-xl p-4 ring ring-kumo-line">
      <div className="flex gap-3">
        <InfoIcon
          size={20}
          weight="bold"
          className="mt-0.5 shrink-0 text-kumo-accent"
        />
        <div className="min-w-0 flex-1">
          <Text size="sm" bold>
            Messenger setup
          </Text>
          <span className="mt-1 block">
            <Text size="xs" variant="secondary">
              Telegram is the current adapter, but this dashboard is organized
              around Chat SDK threads, Think conversations, and managed reply
              jobs.
            </Text>
          </span>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-kumo-subtle">Bot token</dt>
              <dd>{setup?.telegramConfigured ? "configured" : "missing"}</dd>
            </div>
            <div>
              <dt className="text-kumo-subtle">Bot username</dt>
              <dd>{setup?.telegramUserName ?? "-"}</dd>
            </div>
            <div>
              <dt className="text-kumo-subtle">Webhook path</dt>
              <dd>{setup?.webhookPath ?? "/webhooks/telegram"}</dd>
            </div>
          </dl>
          <div className="mt-3 rounded-lg bg-kumo-surface p-3 text-xs">
            <div className="text-kumo-subtle">Webhook URL</div>
            <div className="mt-1 break-all">{webhookUrl}</div>
          </div>
          {!isHttpsOrigin && (
            <span className="mt-2 block">
              <Text size="xs" variant="secondary">
                Telegram requires an HTTPS webhook. Start `npm start`, open the
                printed `trycloudflare.com` URL, then click this button there.
              </Text>
            </span>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              disabled={
                !setup?.telegramConfigured || !isHttpsOrigin || isSettingWebhook
              }
              onClick={() => void setTelegramWebhook()}
            >
              {isSettingWebhook ? "Setting webhook..." : "Set webhook here"}
            </Button>
            {webhookResult && (
              <span className="text-xs text-green-600">{webhookResult}</span>
            )}
            {webhookError && (
              <Text size="xs" variant="error">
                {webhookError}
              </Text>
            )}
          </div>
        </div>
      </div>
    </Surface>
  );
}

function ConversationList({
  conversations,
  selected,
  onSelect
}: {
  conversations: AdminConversation[];
  selected: AdminConversation | null;
  onSelect: (conversation: AdminConversation) => void;
}) {
  return (
    <Surface className="rounded-xl p-4 ring ring-kumo-line">
      <div className="mb-3 flex items-center gap-2">
        <ChatsIcon size={18} />
        <Text size="sm" bold>
          Conversations
        </Text>
      </div>
      <div className="space-y-2">
        {conversations.length === 0 ? (
          <Text size="sm" variant="secondary">
            No AI-routed messenger conversations yet. DM the bot or mention it
            in a group to create one.
          </Text>
        ) : (
          conversations.map((conversation) => {
            const active = selected?.threadId === conversation.threadId;
            return (
              <button
                key={conversation.threadId}
                className={`w-full rounded-lg border p-3 text-left ${
                  active
                    ? "border-kumo-accent bg-kumo-surface"
                    : "border-kumo-line"
                }`}
                type="button"
                onClick={() => onSelect(conversation)}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium">
                    {conversation.title}
                  </span>
                  <Badge>{conversation.provider}</Badge>
                </span>
                <span className="mt-1 block truncate text-xs text-kumo-subtle">
                  {conversation.lastMessagePreview || conversation.threadId}
                </span>
                <span className="mt-2 block text-xs text-kumo-subtle">
                  {formatTime(conversation.lastMessageAt)}
                </span>
              </button>
            );
          })
        )}
      </div>
    </Surface>
  );
}

function ReplyJobs({
  jobs,
  onCancel
}: {
  jobs: AdminReplyJob[];
  onCancel: (fiberId: string) => Promise<void>;
}) {
  return (
    <Surface className="rounded-xl p-4 ring ring-kumo-line">
      <div className="mb-3 flex items-center justify-between gap-3">
        <Text size="sm" bold>
          Managed reply jobs
        </Text>
        <Badge>{jobs.length}</Badge>
      </div>
      <div className="space-y-2">
        {jobs.length === 0 ? (
          <Text size="sm" variant="secondary">
            No retained AI reply jobs for this conversation yet.
          </Text>
        ) : (
          jobs.map((job) => {
            const terminal = TERMINAL_REPLY_STATUSES.has(job.status);
            return (
              <div
                key={job.fiberId}
                className="rounded-lg border border-kumo-line p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {replyStatusBadge(job)}
                      <span className="truncate text-xs">{job.fiberId}</span>
                    </div>
                    <p className="mt-1 text-xs text-kumo-subtle">
                      Created {formatTime(job.createdAt)} · Settled{" "}
                      {formatTime(job.settledAt)}
                    </p>
                  </div>
                  {!terminal && (
                    <Button
                      variant="secondary"
                      onClick={() => void onCancel(job.fiberId)}
                      icon={<ProhibitIcon size={16} />}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
                {job.error && (
                  <p className="mt-2 text-xs text-kumo-danger">{job.error}</p>
                )}
              </div>
            );
          })
        )}
      </div>
    </Surface>
  );
}

function ThinkPane({
  conversation,
  onReset
}: {
  conversation: AdminConversation;
  onReset: () => Promise<void>;
}) {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const agent = useAgent({
    agent: "ChatIngressAgent",
    name: "default",
    sub: [
      {
        agent: "ConversationAgent",
        name: conversation.conversationName
      }
    ],
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(() => setConnectionStatus("disconnected"), [])
  });
  const { messages, sendMessage, status, isStreaming, stop, clearHistory } =
    useAgentChat({
      agent,
      experimental_throttle: 100,
      getInitialMessages: null
    });

  async function submit() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    await sendMessage({ text });
  }

  async function reset() {
    clearHistory();
    await onReset();
  }

  return (
    <Surface className="rounded-xl p-4 ring ring-kumo-line">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Text size="lg" bold>
            Think conversation
          </Text>
          <span className="mt-1 block">
            <Text size="xs" variant="secondary">
              Internal admin-only chat for `{conversation.conversationName}`.
              Messages sent here do not post to the messenger thread.
            </Text>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ConnectionIndicator status={connectionStatus} />
          {isStreaming && (
            <Button variant="secondary" onClick={() => stop()}>
              Stop
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => void reset()}
            icon={<TrashIcon size={16} />}
          >
            Reset
          </Button>
        </div>
      </div>

      <div className="min-h-80 space-y-3 rounded-lg border border-kumo-line bg-kumo-surface p-3">
        {messages.length === 0 ? (
          <Text size="sm" variant="secondary">
            No Think messages yet. Messenger-routed AI replies and internal
            admin prompts will appear here.
          </Text>
        ) : (
          messages.map((message) => {
            const text = messageText(message);
            return (
              <div
                key={message.id}
                className={`rounded-lg p-3 ${
                  message.role === "user" ? "bg-kumo-base" : "bg-kumo-line/30"
                }`}
              >
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs uppercase text-kumo-subtle">
                  <span>{message.role}</span>
                  <span className="normal-case">
                    id: {message.id.slice(0, 12)}
                  </span>
                  <span className="normal-case">{text.length} chars</span>
                </div>
                <MessageParts message={message} />
              </div>
            );
          })
        )}
      </div>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          aria-label="Internal Think message"
          className="min-w-0 flex-1 rounded-lg border border-kumo-line bg-kumo-surface px-3 py-2 text-sm outline-none"
          disabled={status === "submitted" || status === "streaming"}
          placeholder="Send an internal admin prompt to Think..."
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
        />
        <Button
          disabled={!input.trim() || status === "submitted"}
          type="submit"
          icon={<PaperPlaneRightIcon size={16} />}
        >
          Send internally
        </Button>
      </form>
    </Surface>
  );
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [setup, setSetup] = useState<AdminSetupInfo | null>(null);
  const [conversations, setConversations] = useState<AdminConversation[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [replyJobs, setReplyJobs] = useState<AdminReplyJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  const parent = useAgent({
    agent: "ChatIngressAgent",
    name: "default",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(() => setConnectionStatus("disconnected"), [])
  });

  const selectedConversation = useMemo(
    () =>
      conversations.find(
        (conversation) => conversation.threadId === selectedThreadId
      ) ??
      conversations[0] ??
      null,
    [conversations, selectedThreadId]
  );

  const refresh = useCallback(async () => {
    try {
      const [nextSetup, nextConversations] = await Promise.all([
        parent.call("getSetupInfo", []) as Promise<AdminSetupInfo>,
        parent.call("listConversations", []) as Promise<AdminConversation[]>
      ]);
      setSetup(nextSetup);
      setConversations(nextConversations);
      const selected = selectedThreadId ?? nextConversations[0]?.threadId;
      setSelectedThreadId(selected ?? null);
      const nextJobs = selected
        ? ((await parent.call("listReplyJobs", [selected])) as AdminReplyJob[])
        : [];
      setReplyJobs(nextJobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [parent, selectedThreadId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function resetSelectedConversation() {
    if (!selectedConversation) return;
    await parent.call("resetConversationByThread", [
      selectedConversation.threadId
    ]);
    await refresh();
  }

  async function cancelReplyJob(fiberId: string) {
    await parent.call("cancelReplyJob", [fiberId]);
    await refresh();
  }

  return (
    <main className="min-h-screen bg-kumo-base text-kumo-default">
      <LocalhostTunnelModal />
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-6 py-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <Text size="lg" bold>
              Chat SDK Messenger Admin
            </Text>
            <span className="mt-1 block">
              <Text size="sm" variant="secondary">
                Inspect Chat SDK threads, Think conversations, and managed AI
                reply jobs for the messenger example.
              </Text>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <Button
              variant="ghost"
              onClick={() => void refresh()}
              icon={<ArrowClockwiseIcon size={16} />}
            >
              Refresh
            </Button>
            <ModeToggle />
          </div>
        </header>

        <SetupCard setup={setup} />

        {error && (
          <Text size="sm" variant="error">
            {error}
          </Text>
        )}

        <section className="grid gap-4 lg:grid-cols-[22rem_1fr]">
          <div className="space-y-4">
            <ConversationList
              conversations={conversations}
              selected={selectedConversation}
              onSelect={(conversation) => {
                setSelectedThreadId(conversation.threadId);
              }}
            />
            <ReplyJobs jobs={replyJobs} onCancel={cancelReplyJob} />
          </div>

          {selectedConversation ? (
            <ThinkPane
              key={selectedConversation.conversationName}
              conversation={selectedConversation}
              onReset={resetSelectedConversation}
            />
          ) : (
            <Surface className="rounded-xl p-4 ring ring-kumo-line">
              <Text size="sm" variant="secondary">
                Select a conversation after the bot receives an AI-routed
                message.
              </Text>
            </Surface>
          )}
        </section>

        <footer className="mt-auto flex justify-center">
          <PoweredByCloudflare />
        </footer>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(<App />);
