import "./styles.css";
import {
  Badge,
  Button,
  Empty,
  Input,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Switch,
  Tabs,
  Text
} from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  EnvelopeSimpleIcon,
  MoonIcon,
  PaperPlaneTiltIcon,
  ShieldCheckIcon,
  SunIcon,
  TrayIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import { useAgent } from "agents/react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  EmailRecord,
  EmailServiceAgent,
  EmailServiceState
} from "./server";

type TabKey = "inbox" | "outbox";

interface ExampleConfig {
  mailboxAddress: string;
  mailboxId: string;
}

interface SimulateResponse {
  success?: boolean;
  error?: string;
  routedTo?: string;
}

function isExampleConfig(value: unknown): value is ExampleConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "mailboxAddress" in value &&
    typeof value.mailboxAddress === "string" &&
    "mailboxId" in value &&
    typeof value.mailboxId === "string"
  );
}

function isSimulateResponse(value: unknown): value is SimulateResponse {
  return typeof value === "object" && value !== null;
}

function ConnectionIndicator({ readyState }: { readyState: number }) {
  const status =
    readyState === WebSocket.OPEN
      ? {
          dot: "bg-green-500",
          label: "Connected",
          text: "text-kumo-success"
        }
      : readyState === WebSocket.CONNECTING
        ? {
            dot: "bg-yellow-500",
            label: "Connecting...",
            text: "text-kumo-warning"
          }
        : {
            dot: "bg-red-500",
            label: "Disconnected",
            text: "text-kumo-danger"
          };

  return (
    <output aria-live="polite" className="flex items-center gap-2 text-left">
      <span className={`size-2 rounded-full ${status.dot}`} />
      <span className={`text-xs ${status.text}`}>{status.label}</span>
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
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function EmailCard({
  record,
  selected,
  onSelect
}: {
  record: EmailRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full border-b border-kumo-fill px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-kumo-tint ${
        selected ? "bg-kumo-control" : ""
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="truncate text-sm font-medium text-kumo-default">
          {record.direction === "inbound" ? record.from : record.to}
        </span>
        <span className="shrink-0 text-xs text-kumo-inactive">
          {new Date(record.timestamp).toLocaleTimeString()}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="truncate text-sm text-kumo-subtle">
          {record.subject}
        </span>
        {record.secureReply && <Badge variant="primary">Secure</Badge>}
        {record.simulated && <Badge variant="secondary">Simulated</Badge>}
      </div>
    </button>
  );
}

function DetailPanel({
  record,
  mailboxAddress
}: {
  record: EmailRecord | null;
  mailboxAddress: string;
}) {
  if (!record) {
    return (
      <Surface className="rounded-xl ring ring-kumo-line p-6">
        <Empty title="Select a message" size="sm" />
      </Surface>
    );
  }

  const methodLabel =
    record.method === "email-service"
      ? "Email Service binding"
      : "replyToEmail";
  const body = record.text || record.html || "(No content)";

  return (
    <Surface className="rounded-xl ring ring-kumo-line p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Text variant="heading3">{record.subject}</Text>
        <Badge
          variant={record.method === "email-service" ? "secondary" : "primary"}
        >
          {methodLabel}
        </Badge>
        {record.secureReply && <Badge variant="primary">Verified reply</Badge>}
        {record.simulated && (
          <Badge variant="secondary">Local simulation</Badge>
        )}
      </div>

      <div className="mt-3 space-y-1 text-xs text-kumo-subtle">
        <div>From: {record.from}</div>
        <div>To: {record.to}</div>
        <div>Mailbox: {mailboxAddress}</div>
        <div>Date: {new Date(record.timestamp).toLocaleString()}</div>
        {record.messageId && (
          <div className="truncate">Message ID: {record.messageId}</div>
        )}
      </div>

      <div className="mt-4 rounded-xl bg-kumo-elevated p-4 text-sm whitespace-pre-wrap text-kumo-default">
        {body}
      </div>

      {Object.keys(record.headers).length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-kumo-subtle">
            Headers ({Object.keys(record.headers).length})
          </summary>
          <div className="mt-2 max-h-48 overflow-y-auto rounded-xl bg-kumo-elevated p-3 font-mono text-xs text-kumo-default">
            {Object.entries(record.headers).map(([key, value]) => (
              <div key={key} className="truncate">
                <span className="text-kumo-subtle">{key}:</span> {value}
              </div>
            ))}
          </div>
        </details>
      )}
    </Surface>
  );
}

function App() {
  const [config, setConfig] = useState<ExampleConfig>({
    mailboxAddress: "mailbox-7f3a@example.com",
    mailboxId: "mailbox-7f3a"
  });
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("inbox");
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [composeTo, setComposeTo] = useState("recipient@example.com");
  const [composeSubject, setComposeSubject] = useState(
    "Welcome to our support desk"
  );
  const [composeBody, setComposeBody] = useState(
    "Thanks for trying the Email Service agent example. Reply to this message and route the mailbox to the Worker to continue the thread."
  );
  const [simulateFrom, setSimulateFrom] = useState("customer@example.com");
  const [simulateSubject, setSimulateSubject] = useState(
    "Question about my invoice"
  );
  const [simulateBody, setSimulateBody] = useState(
    "Can you confirm whether my annual plan renews next month?"
  );
  const [sending, setSending] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const response = await fetch("/api/example-config");
      if (!response.ok || cancelled) {
        return;
      }

      const nextConfig = await response.json();
      if (!cancelled && isExampleConfig(nextConfig)) {
        setConfig(nextConfig);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const agent = useAgent<EmailServiceAgent, EmailServiceState>({
    agent: "email-service-agent",
    name: config.mailboxId
  });

  const state =
    agent.state ??
    ({
      inbox: [],
      outbox: [],
      totalReceived: 0,
      totalSent: 0,
      autoReplyEnabled: true
    } satisfies EmailServiceState);

  const isConnected = agent.readyState === WebSocket.OPEN;
  const records = activeTab === "inbox" ? state.inbox : state.outbox;
  const selectedRecord =
    records.find((record) => record.id === selectedRecordId) ?? null;

  async function handleSendEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setStatusMessage(null);

    try {
      const result = await agent.call("sendTransactionalEmail", [
        {
          to: composeTo,
          subject: composeSubject,
          body: composeBody
        }
      ]);

      if (result.ok) {
        setStatusMessage(
          `Email accepted by Email Service: ${result.messageId}`
        );
      } else {
        setStatusMessage(result.error);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  async function handleSimulateInbound(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();
    setSimulating(true);
    setStatusMessage(null);

    try {
      const response = await fetch("/api/simulate-email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: simulateFrom,
          subject: simulateSubject,
          body: simulateBody
        })
      });

      const payload = await response.json();
      const result = isSimulateResponse(payload) ? payload : {};

      if (!response.ok) {
        setStatusMessage(result.error || "Failed to simulate inbound email.");
        return;
      }

      setActiveTab("inbox");
      setStatusMessage(`Simulated email routed to ${result.routedTo}.`);
    } finally {
      setSimulating(false);
    }
  }

  async function handleToggleAutoReply() {
    setToggling(true);
    setStatusMessage(null);

    try {
      const enabled = await agent.call("toggleAutoReply");
      setStatusMessage(
        enabled
          ? "Automatic replies are enabled."
          : "Automatic replies are disabled."
      );
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setToggling(false);
    }
  }

  async function handleClearActivity() {
    setClearing(true);
    setStatusMessage(null);

    try {
      await agent.call("clearActivity");
      setSelectedRecordId(null);
      setStatusMessage("Inbox and outbox cleared.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="min-h-screen bg-kumo-base text-kumo-default">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Text variant="heading1">Email Service Agent</Text>
            <span className="mt-2 block max-w-3xl text-sm text-kumo-subtle">
              A full-stack example that sends transactional email with the new
              Email Service binding, receives routed mail inside an agent, and
              keeps the mailbox state synced to a React UI.
            </span>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator readyState={agent.readyState} />
            <ModeToggle />
          </div>
        </header>

        <main className="flex-1 space-y-6">
          <Surface className="rounded-2xl ring ring-kumo-line p-5">
            <div className="flex gap-3">
              <ShieldCheckIcon
                size={20}
                weight="bold"
                className="mt-0.5 shrink-0 text-kumo-accent"
              />
              <div>
                <Text size="sm" bold>
                  One Worker, both directions
                </Text>
                <span className="mt-1 block text-sm text-kumo-subtle">
                  Outbound email goes through `this.sendEmail()`. Inbound email
                  goes through `routeAgentEmail()`, gets parsed with
                  `postal-mime`, and can optionally use signed replies with
                  `replyToEmail()`.
                </span>
              </div>
            </div>
          </Surface>

          {statusMessage && (
            <Surface className="rounded-2xl ring ring-kumo-line p-4">
              <div className="flex items-start gap-3">
                {statusMessage.toLowerCase().includes("failed") ||
                statusMessage.toLowerCase().includes("error") ? (
                  <WarningCircleIcon
                    size={18}
                    className="mt-0.5 shrink-0 text-kumo-danger"
                  />
                ) : (
                  <CheckCircleIcon
                    size={18}
                    className="mt-0.5 shrink-0 text-kumo-success"
                  />
                )}
                <span className="text-sm text-kumo-default">
                  {statusMessage}
                </span>
              </div>
            </Surface>
          )}

          {state.lastError && state.lastError !== statusMessage && (
            <Surface className="rounded-2xl ring ring-kumo-line p-4">
              <div className="flex items-start gap-3 text-kumo-danger">
                <WarningCircleIcon size={18} className="mt-0.5 shrink-0" />
                <span className="text-sm">{state.lastError}</span>
              </div>
            </Surface>
          )}

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.05fr_0.95fr]">
            <div className="space-y-6">
              <Surface className="rounded-2xl ring ring-kumo-line p-5">
                <div className="mb-4 flex items-center gap-2">
                  <PaperPlaneTiltIcon size={18} />
                  <Text variant="heading3">Send outbound email</Text>
                </div>

                <form className="space-y-4" onSubmit={handleSendEmail}>
                  <div>
                    <span className="mb-1 block text-xs text-kumo-subtle">
                      To
                    </span>
                    <Input
                      value={composeTo}
                      onChange={(event) => setComposeTo(event.target.value)}
                      placeholder="recipient@example.com"
                      type="email"
                    />
                  </div>
                  <div>
                    <span className="mb-1 block text-xs text-kumo-subtle">
                      Subject
                    </span>
                    <Input
                      value={composeSubject}
                      onChange={(event) =>
                        setComposeSubject(event.target.value)
                      }
                      placeholder="Welcome to our support desk"
                    />
                  </div>
                  <div>
                    <span className="mb-1 block text-xs text-kumo-subtle">
                      Body
                    </span>
                    <InputArea
                      value={composeBody}
                      onValueChange={setComposeBody}
                      rows={6}
                      className="!min-h-32"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={!isConnected || sending}
                    >
                      {sending ? "Sending..." : "Send with Email Service"}
                    </Button>
                    <span className="text-xs text-kumo-subtle">
                      Sends from <code>{config.mailboxAddress}</code>
                    </span>
                  </div>
                </form>
              </Surface>

              <Surface className="rounded-2xl ring ring-kumo-line p-5">
                <div className="mb-4 flex items-center gap-2">
                  <EnvelopeSimpleIcon size={18} />
                  <Text variant="heading3">Simulate inbound email</Text>
                </div>

                <form className="space-y-4" onSubmit={handleSimulateInbound}>
                  <div>
                    <span className="mb-1 block text-xs text-kumo-subtle">
                      From
                    </span>
                    <Input
                      value={simulateFrom}
                      onChange={(event) => setSimulateFrom(event.target.value)}
                      placeholder="customer@example.com"
                      type="email"
                    />
                  </div>
                  <div>
                    <span className="mb-1 block text-xs text-kumo-subtle">
                      Subject
                    </span>
                    <Input
                      value={simulateSubject}
                      onChange={(event) =>
                        setSimulateSubject(event.target.value)
                      }
                      placeholder="Question about my invoice"
                    />
                  </div>
                  <div>
                    <span className="mb-1 block text-xs text-kumo-subtle">
                      Body
                    </span>
                    <InputArea
                      value={simulateBody}
                      onValueChange={setSimulateBody}
                      rows={5}
                      className="!min-h-28"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="submit"
                      variant="secondary"
                      disabled={simulating}
                    >
                      {simulating ? "Routing..." : "Route simulated email"}
                    </Button>
                    <span className="text-xs text-kumo-subtle">
                      Uses the same resolver chain as a real routed email.
                    </span>
                  </div>
                </form>
              </Surface>

              <Surface className="rounded-2xl ring ring-kumo-line p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <Text variant="heading3">Mailbox settings</Text>
                  <Switch
                    label="Auto-reply"
                    checked={state.autoReplyEnabled}
                    disabled={!isConnected || toggling}
                    onCheckedChange={handleToggleAutoReply}
                  />
                </div>

                <div className="space-y-3 text-sm text-kumo-subtle">
                  <p>
                    Configure <code>EMAIL_FROM</code> in `wrangler.jsonc` to a
                    verified sender address. The example uses that same address
                    as the routed mailbox.
                  </p>
                  <p>
                    Optional: add <code>EMAIL_SECRET</code> with `wrangler
                    secret put EMAIL_SECRET` if you want `replyToEmail()` to
                    sign follow-up replies.
                  </p>
                  <p>
                    When you deploy the Worker, route{" "}
                    <code>{config.mailboxAddress}</code>
                    to it from Cloudflare Email Service.
                  </p>
                </div>
              </Surface>
            </div>

            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-2">
                <Surface className="rounded-2xl ring ring-kumo-line p-4">
                  <span className="text-xs text-kumo-subtle">Mailbox</span>
                  <div className="mt-1 text-sm font-medium text-kumo-default">
                    {config.mailboxAddress}
                  </div>
                </Surface>
                <Surface className="rounded-2xl ring ring-kumo-line p-4">
                  <span className="text-xs text-kumo-subtle">Instance</span>
                  <div className="mt-1 text-sm font-medium text-kumo-default">
                    {config.mailboxId}
                  </div>
                </Surface>
                <Surface className="rounded-2xl ring ring-kumo-line p-4">
                  <span className="text-xs text-kumo-subtle">Received</span>
                  <div className="mt-1 text-2xl font-semibold text-kumo-default">
                    {state.totalReceived}
                  </div>
                </Surface>
                <Surface className="rounded-2xl ring ring-kumo-line p-4">
                  <span className="text-xs text-kumo-subtle">Sent</span>
                  <div className="mt-1 text-2xl font-semibold text-kumo-default">
                    {state.totalSent}
                  </div>
                </Surface>
              </div>

              <Surface className="overflow-hidden rounded-2xl ring ring-kumo-line">
                <Tabs
                  variant="segmented"
                  value={activeTab}
                  onValueChange={(value) => {
                    setActiveTab(value as TabKey);
                    setSelectedRecordId(null);
                  }}
                  tabs={[
                    {
                      value: "inbox",
                      label: (
                        <span className="flex items-center gap-2">
                          <TrayIcon size={16} /> Inbox ({state.inbox.length})
                        </span>
                      )
                    },
                    {
                      value: "outbox",
                      label: (
                        <span className="flex items-center gap-2">
                          <PaperPlaneTiltIcon size={16} /> Outbox (
                          {state.outbox.length})
                        </span>
                      )
                    }
                  ]}
                  className="m-2"
                />

                <div className="max-h-80 overflow-y-auto border-t border-kumo-line">
                  {records.length > 0 ? (
                    records
                      .slice()
                      .reverse()
                      .map((record) => (
                        <EmailCard
                          key={record.id}
                          record={record}
                          selected={selectedRecordId === record.id}
                          onSelect={() => setSelectedRecordId(record.id)}
                        />
                      ))
                  ) : (
                    <div className="py-10">
                      <Empty
                        title={
                          activeTab === "inbox"
                            ? "No inbound email yet"
                            : "No outbound email yet"
                        }
                        size="sm"
                      />
                    </div>
                  )}
                </div>

                {(state.inbox.length > 0 || state.outbox.length > 0) && (
                  <div className="border-t border-kumo-line p-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!isConnected || clearing}
                      onClick={handleClearActivity}
                      icon={<ArrowClockwiseIcon size={16} />}
                    >
                      {clearing ? "Clearing..." : "Clear activity"}
                    </Button>
                  </div>
                )}
              </Surface>

              <DetailPanel
                record={selectedRecord}
                mailboxAddress={config.mailboxAddress}
              />
            </div>
          </div>
        </main>

        <footer className="mt-8 flex justify-center py-4">
          <PoweredByCloudflare />
        </footer>
      </div>
    </div>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(<App />);
