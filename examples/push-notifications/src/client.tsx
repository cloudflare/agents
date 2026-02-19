import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import { ThemeProvider } from "@cloudflare/agents-ui/hooks";
import { Badge, Button, Empty, Input, Surface, Text } from "@cloudflare/kumo";
import {
  BellRingingIcon,
  BellSlashIcon,
  CheckCircleIcon,
  ClockIcon,
  PaperPlaneRightIcon,
  TrashIcon,
  WarningCircleIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReminderAgent, ReminderAgentState } from "./server";
import "./styles.css";

function base64urlToUint8Array(base64url: string): Uint8Array {
  const padded = base64url + "=".repeat((4 - (base64url.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type PushState =
  | "loading"
  | "unsupported"
  | "denied"
  | "unsubscribed"
  | "subscribed";

function App() {
  const [pushState, setPushState] = useState<PushState>("loading");
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [agentState, setAgentState] = useState<ReminderAgentState>({
    subscriptions: [],
    reminders: []
  });
  const [message, setMessage] = useState("");
  const [delayMinutes, setDelayMinutes] = useState("1");
  const [status, setStatus] = useState<string | null>(null);

  const agent = useAgent<ReminderAgent, ReminderAgentState>({
    agent: "reminder-agent",
    name: "user-reminders",
    onOpen: () => setConnectionStatus("connected"),
    onClose: () => setConnectionStatus("disconnected"),
    onStateUpdate: (newState) => {
      if (newState) setAgentState(newState);
    },
    onMessage: (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === "reminder_sent") {
          setStatus("Reminder delivered!");
          setTimeout(() => setStatus(null), 3000);
        }
      } catch {
        // not our message
      }
    }
  });

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setPushState("denied");
      return;
    }

    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        setPushState(sub ? "subscribed" : "unsubscribed");
      })
      .catch(() => setPushState("unsupported"));
  }, []);

  const subscribeToPush = useCallback(async () => {
    try {
      const permission = await Notification.requestPermission();
      if (permission === "denied") {
        setPushState("denied");
        return;
      }

      const vapidPublicKey = await agent.call("getVapidPublicKey");
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64urlToUint8Array(vapidPublicKey)
          .buffer as ArrayBuffer
      });

      const subJson = subscription.toJSON();
      await agent.call("subscribe", [
        {
          endpoint: subJson.endpoint!,
          expirationTime: subJson.expirationTime ?? null,
          keys: subJson.keys as { p256dh: string; auth: string }
        }
      ]);

      setPushState("subscribed");
      setStatus("Subscribed to push notifications!");
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      console.error("Subscribe failed:", err);
      setStatus(`Failed to subscribe: ${err}`);
    }
  }, [agent]);

  const unsubscribeFromPush = useCallback(async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      if (subscription) {
        await agent.call("unsubscribe", [subscription.endpoint]);
        await subscription.unsubscribe();
      }
      setPushState("unsubscribed");
      setStatus("Unsubscribed from push notifications");
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      console.error("Unsubscribe failed:", err);
    }
  }, [agent]);

  const createReminder = useCallback(async () => {
    if (!message.trim()) return;
    try {
      const delaySeconds = Math.max(5, Number(delayMinutes) * 60);
      await agent.call("createReminder", [message, delaySeconds]);
      setMessage("");
      setStatus(`Reminder set for ${delayMinutes} minute(s) from now`);
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      console.error("Create reminder failed:", err);
      setStatus(`Failed: ${err}`);
    }
  }, [agent, message, delayMinutes]);

  const cancelReminder = useCallback(
    async (id: string) => {
      try {
        await agent.call("cancelReminder", [id]);
      } catch (err) {
        console.error("Cancel failed:", err);
      }
    },
    [agent]
  );

  const sendTest = useCallback(async () => {
    try {
      const result = await agent.call("sendTestNotification");
      setStatus(
        `Test sent! (${result.sent} delivered, ${result.failed} failed)`
      );
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      console.error("Test notification failed:", err);
      setStatus(`Failed: ${err}`);
    }
  }, [agent]);

  const pendingReminders = agentState.reminders.filter((r) => !r.sent);
  const sentReminders = agentState.reminders.filter((r) => r.sent).slice(-5);

  return (
    <div className="flex flex-col min-h-full">
      <header className="flex items-center justify-between px-6 py-4 border-b border-kumo-line">
        <div className="flex items-center gap-3">
          <BellRingingIcon size={24} weight="duotone" />
          <Text variant="heading3">Push Notification Reminders</Text>
        </div>
        <div className="flex items-center gap-3">
          <ConnectionIndicator status={connectionStatus} />
          <ModeToggle />
        </div>
      </header>

      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-6 space-y-4">
        {status && (
          <Surface className="px-4 py-2 rounded-lg ring ring-kumo-accent-line text-center">
            <span className="text-sm text-kumo-accent-default">{status}</span>
          </Surface>
        )}

        <Surface className="p-5 rounded-lg ring ring-kumo-line">
          <div className="mb-1">
            <Text variant="heading3">1. Enable Push Notifications</Text>
          </div>
          <p className="text-sm text-kumo-subtle mb-4">
            Your browser needs permission to show notifications. The agent
            stores your subscription and uses it to push to you later.
          </p>

          {pushState === "loading" && (
            <p className="text-sm text-kumo-inactive">
              Checking browser support...
            </p>
          )}

          {pushState === "unsupported" && (
            <div className="flex items-center gap-2 text-kumo-danger">
              <WarningCircleIcon size={18} />
              <Text variant="body">
                Push notifications are not supported in this browser.
              </Text>
            </div>
          )}

          {pushState === "denied" && (
            <div className="flex items-center gap-2 text-kumo-danger">
              <XCircleIcon size={18} />
              <Text variant="body">
                Notification permission was denied. Reset it in your browser
                settings.
              </Text>
            </div>
          )}

          {pushState === "unsubscribed" && (
            <Button variant="primary" onClick={subscribeToPush}>
              <BellRingingIcon size={16} />
              Enable Push Notifications
            </Button>
          )}

          {pushState === "subscribed" && (
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant="primary">
                <CheckCircleIcon size={14} weight="bold" />
                Subscribed
              </Badge>
              <Button variant="ghost" size="sm" onClick={sendTest}>
                <PaperPlaneRightIcon size={14} />
                Send Test
              </Button>
              <Button variant="ghost" size="sm" onClick={unsubscribeFromPush}>
                <BellSlashIcon size={14} />
                Unsubscribe
              </Button>
            </div>
          )}
        </Surface>

        <Surface
          className={`p-5 rounded-lg ring ring-kumo-line ${pushState !== "subscribed" ? "opacity-50 pointer-events-none" : ""}`}
        >
          <div className="mb-1">
            <Text variant="heading3">2. Create a Reminder</Text>
          </div>
          <p className="text-sm text-kumo-subtle mb-4">
            The agent schedules an alarm. When it fires, it sends a push
            notification — no open tab needed.
          </p>

          <div className="space-y-3">
            <Input
              aria-label="Reminder message"
              type="text"
              value={message}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setMessage(e.target.value)
              }
              className="w-full"
              placeholder="What should you be reminded about?"
              disabled={pushState !== "subscribed"}
              onKeyDown={(e: React.KeyboardEvent) =>
                e.key === "Enter" && createReminder()
              }
            />
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm text-kumo-subtle whitespace-nowrap">
                Remind me in
              </span>
              <select
                value={delayMinutes}
                onChange={(e) => setDelayMinutes(e.target.value)}
                className="rounded-md border border-kumo-line bg-kumo-base text-kumo-default text-sm px-3 py-1.5 outline-none focus:border-kumo-accent-line"
                disabled={pushState !== "subscribed"}
              >
                <option value="0.1">6 seconds (test)</option>
                <option value="1">1 minute</option>
                <option value="5">5 minutes</option>
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
              </select>
              <Button
                variant="primary"
                onClick={createReminder}
                disabled={pushState !== "subscribed" || !message.trim()}
              >
                Set Reminder
              </Button>
            </div>
          </div>
        </Surface>

        <Surface className="p-5 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">
              Pending Reminders ({pendingReminders.length})
            </Text>
          </div>
          {pendingReminders.length === 0 ? (
            <Empty
              icon={<ClockIcon size={32} weight="duotone" />}
              title="No pending reminders"
              description="Create a reminder above to get started"
              size="sm"
            />
          ) : (
            <div className="space-y-2">
              {pendingReminders.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between py-2 px-3 bg-kumo-elevated rounded text-sm"
                >
                  <div>
                    <div className="font-medium text-kumo-default">
                      {r.message}
                    </div>
                    <div className="text-xs text-kumo-subtle">
                      {new Date(r.scheduledAt).toLocaleTimeString()}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => cancelReminder(r.id)}
                    className="text-kumo-danger"
                  >
                    <TrashIcon size={14} />
                    Cancel
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Surface>

        {sentReminders.length > 0 && (
          <Surface className="p-5 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Recently Sent</Text>
            </div>
            <div className="space-y-2">
              {sentReminders.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between py-2 px-3 bg-kumo-elevated rounded text-sm opacity-60"
                >
                  <span className="text-kumo-default">{r.message}</span>
                  <Badge variant="secondary">Sent</Badge>
                </div>
              ))}
            </div>
          </Surface>
        )}
      </main>

      <footer className="flex justify-center py-4 border-t border-kumo-line">
        <PoweredByAgents />
      </footer>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
