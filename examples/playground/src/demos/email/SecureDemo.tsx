import { useAgent } from "agents/react";
import { useState } from "react";
import {
  ShieldIcon,
  PaperPlaneTiltIcon,
  TrayIcon,
  LockIcon,
  CheckCircleIcon
} from "@phosphor-icons/react";
import {
  Button,
  Surface,
  Badge,
  Switch,
  Tabs,
  Empty,
  Text
} from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus, LocalDevBanner } from "../../components";
import { useLogs, useUserId } from "../../hooks";
import type {
  SecureEmailAgent,
  SecureEmailState,
  ParsedEmail,
  SentReply
} from "./secure-email-agent";

type TabType = "inbox" | "outbox";

export function SecureDemo() {
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const [activeTab, setActiveTab] = useState<TabType>("inbox");
  const [selectedEmail, setSelectedEmail] = useState<ParsedEmail | null>(null);
  const [selectedReply, setSelectedReply] = useState<SentReply | null>(null);

  const [state, setState] = useState<SecureEmailState>({
    inbox: [],
    outbox: [],
    totalReceived: 0,
    totalReplies: 0,
    autoReplyEnabled: true
  });

  const agent = useAgent<SecureEmailAgent, SecureEmailState>({
    agent: "secure-email-agent",
    name: `email-secure-${userId}`,
    onStateUpdate: (newState) => {
      if (newState) {
        setState(newState);
        addLog("in", "state_update", {
          inbox: newState.inbox.length,
          outbox: newState.outbox.length
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

  const handleToggleAutoReply = async () => {
    addLog("out", "toggleAutoReply");
    try {
      await agent.call("toggleAutoReply");
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleClearEmails = async () => {
    addLog("out", "clearEmails");
    try {
      await agent.call("clearEmails");
      setSelectedEmail(null);
      setSelectedReply(null);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <DemoWrapper
      title="Secure Email Replies"
      description="Receive emails and send signed replies. Replies include cryptographic headers for secure routing back to this agent."
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
        {/* Left Panel - Info & Settings */}
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
                  Received
                </div>
                <div className="text-2xl font-semibold text-kumo-default">
                  {state.totalReceived}
                </div>
              </div>
              <div className="p-3 bg-kumo-elevated rounded">
                <div className="flex items-center gap-2 text-kumo-subtle text-xs mb-1">
                  <PaperPlaneTiltIcon size={12} />
                  Replies
                </div>
                <div className="text-2xl font-semibold text-kumo-default">
                  {state.totalReplies}
                </div>
              </div>
            </div>
          </Surface>

          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-3">
              <Text variant="heading3">Settings</Text>
            </div>
            <Switch
              label="Auto-reply with signed headers"
              checked={state.autoReplyEnabled}
              onCheckedChange={handleToggleAutoReply}
            />
            <p className="text-xs text-kumo-subtle mt-2">
              When enabled, incoming emails receive a signed reply that can be
              securely routed back.
            </p>
          </Surface>

          <Surface className="p-4 rounded-lg bg-kumo-elevated">
            <div className="flex items-center gap-2 mb-3">
              <ShieldIcon size={16} />
              <Text variant="heading3">How Secure Replies Work</Text>
            </div>
            <ol className="text-sm text-kumo-subtle space-y-2">
              <li>
                <strong className="text-kumo-default">1.</strong> Email arrives
                at{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  secure+demo@domain
                </code>
              </li>
              <li>
                <strong className="text-kumo-default">2.</strong> Agent sends
                reply with signed headers:
                <ul className="mt-1 ml-4 text-xs space-y-0.5">
                  <li>
                    <code className="text-kumo-default">X-Agent-Name</code>
                  </li>
                  <li>
                    <code className="text-kumo-default">X-Agent-ID</code>
                  </li>
                  <li>
                    <code className="text-kumo-default">X-Agent-Sig</code>{" "}
                    (HMAC)
                  </li>
                  <li>
                    <code className="text-kumo-default">X-Agent-Sig-Ts</code>
                  </li>
                </ul>
              </li>
              <li>
                <strong className="text-kumo-default">3.</strong> When user
                replies, signature is verified
              </li>
              <li>
                <strong className="text-kumo-default">4.</strong> Valid replies
                route back to same agent instance
              </li>
            </ol>
          </Surface>

          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-2">
              <Text bold size="sm">
                Production Setup
              </Text>
            </div>
            <div className="text-xs text-kumo-subtle space-y-1">
              <div>Set a secure secret:</div>
              <code className="block bg-kumo-control px-2 py-1 rounded mt-1 text-kumo-default">
                wrangler secret put EMAIL_SECRET
              </code>
            </div>
          </Surface>
        </div>

        {/* Center Panel - Mailboxes */}
        <div className="space-y-6">
          <Surface className="overflow-hidden rounded-lg ring ring-kumo-line">
            {/* Tabs */}
            <Tabs
              variant="segmented"
              value={activeTab}
              onValueChange={(value) => {
                setActiveTab(value as TabType);
                setSelectedEmail(null);
                setSelectedReply(null);
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

            {/* Email List */}
            <div className="max-h-64 overflow-y-auto">
              {activeTab === "inbox" ? (
                state.inbox.length > 0 ? (
                  [...state.inbox].reverse().map((email) => (
                    <button
                      key={email.id}
                      type="button"
                      onClick={() => {
                        setSelectedEmail(email);
                        setSelectedReply(null);
                      }}
                      className={`w-full text-left p-3 border-b border-kumo-fill last:border-0 hover:bg-kumo-tint transition-colors ${
                        selectedEmail?.id === email.id ? "bg-kumo-control" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          {email.isSecureReply && (
                            <LockIcon size={12} className="text-kumo-success" />
                          )}
                          <span className="text-sm font-medium truncate text-kumo-default">
                            {email.from}
                          </span>
                        </div>
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
                    <Empty title="No emails received" size="sm" />
                  </div>
                )
              ) : state.outbox.length > 0 ? (
                [...state.outbox].reverse().map((reply) => (
                  <button
                    key={reply.id}
                    type="button"
                    onClick={() => {
                      setSelectedReply(reply);
                      setSelectedEmail(null);
                    }}
                    className={`w-full text-left p-3 border-b border-kumo-fill last:border-0 hover:bg-kumo-tint transition-colors ${
                      selectedReply?.id === reply.id ? "bg-kumo-control" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        {reply.signed && (
                          <CheckCircleIcon
                            size={12}
                            className="text-kumo-success"
                          />
                        )}
                        <span className="text-sm font-medium truncate text-kumo-default">
                          {reply.to}
                        </span>
                      </div>
                      <span className="text-xs text-kumo-inactive">
                        {new Date(reply.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-sm text-kumo-subtle truncate">
                      {reply.subject}
                    </p>
                  </button>
                ))
              ) : (
                <div className="py-8">
                  <Empty title="No replies sent" size="sm" />
                </div>
              )}
            </div>

            {/* Clear button */}
            {(state.inbox.length > 0 || state.outbox.length > 0) && (
              <div className="p-2 border-t border-kumo-line">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleClearEmails}
                  className="text-kumo-danger"
                >
                  Clear all emails
                </Button>
              </div>
            )}
          </Surface>

          {/* Email Detail */}
          {selectedEmail && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {selectedEmail.isSecureReply && (
                      <Badge variant="primary">
                        <span className="flex items-center gap-1">
                          <LockIcon size={12} />
                          Secure Reply
                        </span>
                      </Badge>
                    )}
                    <Text variant="heading3">{selectedEmail.subject}</Text>
                  </div>
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
                <div className="text-xs text-kumo-subtle mt-1">
                  <div>From: {selectedEmail.from}</div>
                  <div>To: {selectedEmail.to}</div>
                  <div>
                    Date: {new Date(selectedEmail.timestamp).toLocaleString()}
                  </div>
                </div>
              </div>
              <div className="bg-kumo-recessed rounded p-3 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto text-kumo-default">
                {selectedEmail.text || selectedEmail.html || "(No content)"}
              </div>
            </Surface>
          )}

          {/* Reply Detail */}
          {selectedReply && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {selectedReply.signed && (
                      <Badge variant="primary">
                        <span className="flex items-center gap-1">
                          <CheckCircleIcon size={12} />
                          Signed
                        </span>
                      </Badge>
                    )}
                    <Text variant="heading3">{selectedReply.subject}</Text>
                  </div>
                  <Button
                    variant="ghost"
                    shape="square"
                    size="xs"
                    aria-label="Close reply"
                    onClick={() => setSelectedReply(null)}
                  >
                    ×
                  </Button>
                </div>
                <div className="text-xs text-kumo-subtle mt-1">
                  <div>To: {selectedReply.to}</div>
                  <div>
                    Date: {new Date(selectedReply.timestamp).toLocaleString()}
                  </div>
                </div>
              </div>
              <div className="bg-kumo-recessed rounded p-3 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto text-kumo-default">
                {selectedReply.body}
              </div>
              {selectedReply.signed && (
                <div className="mt-3 p-2 bg-green-500/10 rounded text-xs text-kumo-success">
                  This reply includes signed X-Agent-* headers for secure
                  routing.
                </div>
              )}
            </Surface>
          )}
        </div>

        {/* Right Panel - Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="500px" />
        </div>
      </div>
    </DemoWrapper>
  );
}
