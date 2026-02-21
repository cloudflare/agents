import { useAgent } from "agents/react";
import { useState } from "react";
import {
  EnvelopeIcon,
  TrayIcon,
  ClockIcon,
  HashIcon
} from "@phosphor-icons/react";
import { Button, Surface, Empty, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  LogPanel,
  ConnectionStatus,
  LocalDevBanner,
  CodeExplanation,
  type CodeSection
} from "../../components";
import { useLogs, useUserId } from "../../hooks";
import type {
  ReceiveEmailAgent,
  ReceiveEmailState,
  ParsedEmail
} from "./receive-email-agent";

const codeSections: CodeSection[] = [
  {
    title: "Handle incoming emails",
    description:
      "Override the onEmail method to process incoming messages. The agent receives a parsed AgentEmail object with from, to, and a getRaw() method for full MIME parsing with postal-mime.",
    code: `import { Agent } from "agents";
import type { AgentEmail } from "agents/email";
import PostalMime from "postal-mime";

class ReceiveEmailAgent extends Agent<Env> {
  async onEmail(email: AgentEmail) {
    const raw = await email.getRaw();
    const parsed = await PostalMime.parse(raw);

    this.setState({
      ...this.state,
      emails: [...this.state.emails, {
        id: crypto.randomUUID(),
        from: parsed.from?.address || email.from,
        to: email.to,
        subject: parsed.subject || "(No Subject)",
        text: parsed.text,
        timestamp: new Date().toISOString(),
      }],
    });

    this.broadcast(JSON.stringify({ type: "new_email" }));
  }
}`
  },
  {
    title: "Route emails with routeAgentEmail",
    description:
      "Use routeAgentEmail in your Worker's email handler with createAddressBasedEmailResolver. Plus-addressing (user+id@domain) automatically maps to the right agent and instance — no manual parsing needed.",
    code: `import { routeAgentEmail } from "agents";
import { createAddressBasedEmailResolver } from "agents/email";

export default {
  async email(message: ForwardableEmailMessage, env: Env) {
    // "receive+demo@example.com" routes to
    // ReceiveEmailAgent with agentId "demo"
    const resolver = createAddressBasedEmailResolver(
      "ReceiveEmailAgent"
    );

    await routeAgentEmail(message, env, {
      resolver,
      onNoRoute: async (email) => {
        console.warn("No route for:", email.to);
      },
    });
  },
};`
  }
];

export function ReceiveDemo() {
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const [selectedEmail, setSelectedEmail] = useState<ParsedEmail | null>(null);

  const [state, setState] = useState<ReceiveEmailState>({
    emails: [],
    totalReceived: 0
  });

  const agent = useAgent<ReceiveEmailAgent, ReceiveEmailState>({
    agent: "receive-email-agent",
    name: `email-receive-${userId}`,
    onStateUpdate: (newState) => {
      if (newState) {
        setState(newState);
        addLog("in", "state_update", {
          emails: newState.emails.length,
          total: newState.totalReceived
        });
      }
    },
    onOpen: () => addLog("info", "connected"),
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error"),
    onMessage: (message) => {
      try {
        const data = JSON.parse(message.data as string);
        if (data.type) {
          addLog("in", data.type, data);
        }
      } catch {
        // ignore
      }
    }
  });

  return (
    <DemoWrapper
      title="Receive Emails"
      description={
        <>
          Agents can receive real emails via Cloudflare Email Routing. Override
          the{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            onEmail
          </code>{" "}
          method to process incoming messages — parse them, store them in state,
          and notify connected clients. Use plus-addressing (e.g.{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            receive+id@domain
          </code>
          ) to route emails to specific agent instances.
        </>
      }
      statusIndicator={
        <ConnectionStatus
          status={
            agent.readyState === WebSocket.OPEN ? "connected" : "connecting"
          }
        />
      }
    >
      <LocalDevBanner />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-4">
        {/* Left Panel - Info & Stats */}
        <div className="space-y-6">
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="text-xs text-kumo-subtle">
              Instance:{" "}
              <code className="bg-kumo-control px-1 rounded text-kumo-default">
                demo
              </code>
            </div>
          </Surface>

          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Stats</Text>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-kumo-elevated rounded">
                <div className="flex items-center gap-2 text-kumo-subtle text-xs mb-1">
                  <TrayIcon size={12} />
                  Inbox
                </div>
                <div className="text-2xl font-semibold text-kumo-default">
                  {state.emails.length}
                </div>
              </div>
              <div className="p-3 bg-kumo-elevated rounded">
                <div className="flex items-center gap-2 text-kumo-subtle text-xs mb-1">
                  <HashIcon size={12} />
                  Total
                </div>
                <div className="text-2xl font-semibold text-kumo-default">
                  {state.totalReceived}
                </div>
              </div>
            </div>
            {state.lastReceivedAt && (
              <div className="mt-3 text-xs text-kumo-subtle flex items-center gap-1">
                <ClockIcon size={12} />
                Last: {new Date(state.lastReceivedAt).toLocaleString()}
              </div>
            )}
          </Surface>

          <Surface className="p-4 rounded-lg bg-kumo-elevated">
            <div className="mb-3">
              <Text variant="heading3">Setup Instructions</Text>
            </div>
            <ol className="text-sm text-kumo-subtle space-y-2">
              <li>
                <strong className="text-kumo-default">1.</strong> Deploy this
                playground to Cloudflare
              </li>
              <li>
                <strong className="text-kumo-default">2.</strong> Go to
                Cloudflare Dashboard → Email → Email Routing
              </li>
              <li>
                <strong className="text-kumo-default">3.</strong> Add a
                catch-all or specific rule routing to this Worker
              </li>
              <li>
                <strong className="text-kumo-default">4.</strong> Send email to:{" "}
                <code className="bg-kumo-control px-1 rounded text-xs text-kumo-default">
                  receive+demo@yourdomain.com
                </code>
              </li>
            </ol>
          </Surface>

          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-2">
              <Text bold size="sm">
                Address Format
              </Text>
            </div>
            <div className="text-xs text-kumo-subtle space-y-1">
              <div>
                <code className="bg-kumo-control px-1 rounded text-kumo-default">
                  receive+id@domain
                </code>
              </div>
              <div>Routes to ReceiveEmailAgent with instance "id"</div>
            </div>
          </Surface>
        </div>

        {/* Center Panel - Inbox */}
        <div className="space-y-6">
          <Surface className="overflow-hidden rounded-lg ring ring-kumo-line">
            <div className="px-4 py-3 border-b border-kumo-line flex items-center gap-2">
              <EnvelopeIcon size={16} />
              <Text variant="heading3">Inbox</Text>
              <span className="text-xs text-kumo-subtle">
                ({state.emails.length})
              </span>
            </div>

            <div className="max-h-80 overflow-y-auto">
              {state.emails.length > 0 ? (
                [...state.emails].reverse().map((email) => (
                  <button
                    key={email.id}
                    type="button"
                    onClick={() => setSelectedEmail(email)}
                    className={`w-full text-left p-3 border-b border-kumo-fill last:border-0 hover:bg-kumo-tint transition-colors ${
                      selectedEmail?.id === email.id ? "bg-kumo-control" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium truncate text-kumo-default">
                        {email.from}
                      </span>
                      <span className="text-xs text-kumo-inactive">
                        {new Date(email.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-sm text-kumo-subtle truncate">
                      {email.subject}
                    </p>
                  </button>
                ))
              ) : (
                <div className="py-8">
                  <Empty title="No emails received yet" size="sm" />
                  <p className="text-xs text-kumo-inactive text-center mt-1">
                    Send an email to see it appear here
                  </p>
                </div>
              )}
            </div>
          </Surface>

          {/* Email Detail */}
          {selectedEmail && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-3">
                <div className="flex items-center justify-between">
                  <Text variant="heading3">{selectedEmail.subject}</Text>
                  <Button
                    variant="ghost"
                    shape="square"
                    size="xs"
                    aria-label="Close email"
                    onClick={() => setSelectedEmail(null)}
                  >
                    ×
                  </Button>
                </div>
                <div className="text-xs text-kumo-subtle mt-1 space-y-0.5">
                  <div>From: {selectedEmail.from}</div>
                  <div>To: {selectedEmail.to}</div>
                  <div>
                    Date: {new Date(selectedEmail.timestamp).toLocaleString()}
                  </div>
                  {selectedEmail.messageId && (
                    <div className="truncate">
                      ID: {selectedEmail.messageId}
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-kumo-recessed rounded p-3 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto text-kumo-default">
                {selectedEmail.text || selectedEmail.html || "(No content)"}
              </div>

              {selectedEmail.headers &&
                Object.keys(selectedEmail.headers).length > 0 && (
                  <details className="mt-3">
                    <summary className="text-xs text-kumo-subtle cursor-pointer">
                      Headers ({Object.keys(selectedEmail.headers).length})
                    </summary>
                    <div className="mt-2 text-xs font-mono bg-kumo-recessed rounded p-2 max-h-32 overflow-y-auto text-kumo-default">
                      {Object.entries(selectedEmail.headers).map(
                        ([key, value]) => (
                          <div key={key} className="truncate">
                            <span className="text-kumo-subtle">{key}:</span>{" "}
                            {value}
                          </div>
                        )
                      )}
                    </div>
                  </details>
                )}
            </Surface>
          )}
        </div>

        {/* Right Panel - Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="500px" />
        </div>
      </div>

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
