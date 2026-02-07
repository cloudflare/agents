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
import { LogPanel, ConnectionStatus, LocalDevBanner } from "../../components";
import { useLogs } from "../../hooks";
import type {
  ReceiveEmailAgent,
  ReceiveEmailState,
  ParsedEmail
} from "./receive-email-agent";

export function ReceiveDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [selectedEmail, setSelectedEmail] = useState<ParsedEmail | null>(null);

  const [state, setState] = useState<ReceiveEmailState>({
    emails: [],
    totalReceived: 0
  });

  const agent = useAgent<ReceiveEmailAgent, ReceiveEmailState>({
    agent: "receive-email-agent",
    name: "demo",
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
      description="Receive real emails via Cloudflare Email Routing. Emails sent to this agent are stored and displayed."
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
    </DemoWrapper>
  );
}
