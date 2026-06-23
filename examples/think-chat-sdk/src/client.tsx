import "./styles.css";

import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";
import {
  ChatCircleTextIcon,
  InfoIcon,
  MoonIcon,
  SunIcon,
  TrashIcon
} from "@phosphor-icons/react";
import { Button, PoweredByCloudflare, Surface, Text } from "@cloudflare/kumo";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import type { UIMessage } from "ai";
import type { SetupInfo, TelegramWebhookSetupResult } from "./index";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

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

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function SetupCard({ setup }: { setup: SetupInfo | null }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TelegramWebhookSetupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const webhookUrl = setup
    ? `${window.location.origin}${setup.webhookPath}`
    : `${window.location.origin}/messengers/telegram/webhook`;
  const isHttpsOrigin = window.location.protocol === "https:";

  async function setupWebhook() {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const response = await fetch("/setup/telegram-webhook", {
        method: "POST"
      });
      const body = (await response.json()) as TelegramWebhookSetupResult;
      if (!response.ok) {
        throw new Error(safeJson(body.result));
      }
      setResult(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Surface className="rounded-xl p-4 ring ring-kumo-line">
      <div className="space-y-4">
        <div>
          <Text size="sm" bold>
            Telegram webhook
          </Text>
          <span className="mt-1 block">
            <Text size="xs" variant="secondary">
              Register Telegram to send messages to the Think-managed messenger
              route.
            </Text>
          </span>
        </div>
        <code className="block overflow-auto rounded-lg bg-kumo-base p-3 text-xs text-kumo-subtle">
          {webhookUrl}
        </code>
        {!isHttpsOrigin && (
          <Text size="xs" variant="secondary">
            Telegram requires HTTPS. When running locally, use the Vite
            Cloudflare tunnel URL printed in the terminal.
          </Text>
        )}
        <Button onClick={setupWebhook} disabled={busy || !isHttpsOrigin}>
          {busy ? "Registering..." : "Register webhook"}
        </Button>
        {result && (
          <pre className="max-h-48 overflow-auto rounded-lg bg-kumo-base p-3 text-xs">
            {safeJson(result)}
          </pre>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Surface>
  );
}

function ConversationList({ messages }: { messages: UIMessage[] }) {
  if (messages.length === 0) {
    return (
      <Surface className="rounded-xl p-8 text-center ring ring-kumo-line">
        <ChatCircleTextIcon
          size={32}
          weight="bold"
          className="mx-auto text-kumo-subtle"
        />
        <span className="mt-3 block">
          <Text size="sm" variant="secondary">
            No messages yet. Send the bot a Telegram DM or mention it in a
            thread; new turns will appear here over the Agent websocket.
          </Text>
        </span>
      </Surface>
    );
  }

  return (
    <div className="space-y-3">
      {messages.map((message) => (
        <Surface
          key={message.id}
          className="rounded-xl p-4 ring ring-kumo-line"
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <Text size="sm" bold>
              {message.role}
            </Text>
            <code className="truncate text-xs text-kumo-subtle">
              {message.id}
            </code>
          </div>
          <div className="whitespace-pre-wrap text-sm">
            {messageText(message) || "(no text content)"}
          </div>
          {message.metadata !== undefined && (
            <details className="mt-3 rounded-lg border border-kumo-line bg-kumo-base p-3">
              <summary className="cursor-pointer text-xs font-medium uppercase text-kumo-subtle">
                Metadata
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto text-xs">
                {safeJson(message.metadata)}
              </pre>
            </details>
          )}
        </Surface>
      ))}
    </div>
  );
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agent = useAgent({
    agent: "SupportAgent",
    name: setup?.agentName ?? "default",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback((event: Event) => {
      console.error("Agent connection error", event);
      setConnectionStatus("disconnected");
    }, [])
  });
  const { messages, clearHistory } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  useEffect(() => {
    fetch("/setup/info")
      .then((response) => response.json())
      .then((body: unknown) => setSetup(body as SetupInfo))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err))
      );
  }, []);

  return (
    <main className="min-h-screen bg-kumo-base text-kumo-default">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <Text size="lg" bold>
              Think Chat SDK Messenger
            </Text>
            <span className="mt-1 block">
              <Text size="sm" variant="secondary">
                Inspect the default Think conversation receiving Telegram
                messages through `getMessengers()`.
              </Text>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
          </div>
        </header>

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
                  Think owns the Chat SDK webhook, verification, per-thread
                  routing, streamed delivery, and recovery snapshots. This page
                  only connects to the root agent so you can inspect the
                  resulting Think message history.
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        <section className="grid gap-4 lg:grid-cols-[22rem_1fr]">
          <div className="space-y-4">
            <SetupCard setup={setup} />
            <Surface className="rounded-xl p-4 ring ring-kumo-line">
              <div className="space-y-4">
                <div>
                  <Text size="sm" bold>
                    Conversation
                  </Text>
                  <span className="mt-1 block">
                    <Text size="xs" variant="secondary">
                      {messages.length} message
                      {messages.length === 1 ? "" : "s"} in the default agent.
                    </Text>
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={clearHistory}
                    disabled={messages.length === 0}
                    icon={<TrashIcon size={16} />}
                  >
                    Clear
                  </Button>
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
              </div>
            </Surface>
          </div>

          <ConversationList messages={messages} />
        </section>

        <footer className="mt-auto flex justify-center py-4">
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
