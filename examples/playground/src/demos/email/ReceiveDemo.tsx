import { useAgent } from "agents/react";
import { useState } from "react";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus, LocalDevBanner } from "../../components";
import { useLogs } from "../../hooks";
import type {
  ReceiveEmailAgent,
  ReceiveEmailState,
  ParsedEmail
} from "./receive-email-agent";
import { Mail, Inbox, Clock, Hash } from "lucide-react";

export function ReceiveDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [selectedEmail, setSelectedEmail] = useState<ParsedEmail | null>(null);

  // Local state synced from agent
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
    >
      <LocalDevBanner />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-4">
        {/* Left Panel - Info & Stats */}
        <div className="space-y-6">
          <div className="card p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Connection</h3>
              <ConnectionStatus
                status={
                  agent.readyState === WebSocket.OPEN
                    ? "connected"
                    : "connecting"
                }
              />
            </div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              Instance:{" "}
              <code className="bg-neutral-100 dark:bg-neutral-800 px-1 rounded">
                demo
              </code>
            </div>
          </div>

          <div className="card p-4">
            <h3 className="font-semibold mb-4">Stats</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-neutral-50 dark:bg-neutral-800 rounded">
                <div className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400 text-xs mb-1">
                  <Inbox className="w-3 h-3" />
                  Inbox
                </div>
                <div className="text-2xl font-semibold">
                  {state.emails.length}
                </div>
              </div>
              <div className="p-3 bg-neutral-50 dark:bg-neutral-800 rounded">
                <div className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400 text-xs mb-1">
                  <Hash className="w-3 h-3" />
                  Total
                </div>
                <div className="text-2xl font-semibold">
                  {state.totalReceived}
                </div>
              </div>
            </div>
            {state.lastReceivedAt && (
              <div className="mt-3 text-xs text-neutral-500 dark:text-neutral-400 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Last: {new Date(state.lastReceivedAt).toLocaleString()}
              </div>
            )}
          </div>

          <div className="card p-4 bg-neutral-50 dark:bg-neutral-800">
            <h3 className="font-semibold mb-3">Setup Instructions</h3>
            <ol className="text-sm text-neutral-600 dark:text-neutral-300 space-y-2">
              <li>
                <strong>1.</strong> Deploy this playground to Cloudflare
              </li>
              <li>
                <strong>2.</strong> Go to Cloudflare Dashboard → Email → Email
                Routing
              </li>
              <li>
                <strong>3.</strong> Add a catch-all or specific rule routing to
                this Worker
              </li>
              <li>
                <strong>4.</strong> Send email to:{" "}
                <code className="bg-neutral-200 dark:bg-neutral-700 px-1 rounded text-xs">
                  receive+demo@yourdomain.com
                </code>
              </li>
            </ol>
          </div>

          <div className="card p-4">
            <h3 className="font-semibold mb-2 text-sm">Address Format</h3>
            <div className="text-xs text-neutral-600 dark:text-neutral-400 space-y-1">
              <div>
                <code className="bg-neutral-100 dark:bg-neutral-700 px-1 rounded">
                  receive+id@domain
                </code>
              </div>
              <div className="text-neutral-500">
                Routes to ReceiveEmailAgent with instance "id"
              </div>
            </div>
          </div>
        </div>

        {/* Center Panel - Inbox */}
        <div className="space-y-6">
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-700 flex items-center gap-2">
              <Mail className="w-4 h-4" />
              <h3 className="font-semibold">Inbox</h3>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
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
                    className={`w-full text-left p-3 border-b border-neutral-100 dark:border-neutral-700 last:border-0 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors ${
                      selectedEmail?.id === email.id
                        ? "bg-neutral-100 dark:bg-neutral-800"
                        : ""
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium truncate">
                        {email.from}
                      </span>
                      <span className="text-xs text-neutral-400">
                        {new Date(email.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-sm text-neutral-600 dark:text-neutral-400 truncate">
                      {email.subject}
                    </p>
                  </button>
                ))
              ) : (
                <div className="p-8 text-center text-neutral-400 text-sm">
                  <Mail className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  No emails received yet
                  <p className="text-xs mt-1">
                    Send an email to see it appear here
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Email Detail */}
          {selectedEmail && (
            <div className="card p-4">
              <div className="mb-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{selectedEmail.subject}</h3>
                  <button
                    type="button"
                    onClick={() => setSelectedEmail(null)}
                    className="text-neutral-400 hover:text-neutral-600"
                  >
                    ×
                  </button>
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 space-y-0.5">
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

              <div className="bg-neutral-50 dark:bg-neutral-900 rounded p-3 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto">
                {selectedEmail.text || selectedEmail.html || "(No content)"}
              </div>

              {selectedEmail.headers &&
                Object.keys(selectedEmail.headers).length > 0 && (
                  <details className="mt-3">
                    <summary className="text-xs text-neutral-500 cursor-pointer">
                      Headers ({Object.keys(selectedEmail.headers).length})
                    </summary>
                    <div className="mt-2 text-xs font-mono bg-neutral-50 dark:bg-neutral-900 rounded p-2 max-h-32 overflow-y-auto">
                      {Object.entries(selectedEmail.headers).map(
                        ([key, value]) => (
                          <div key={key} className="truncate">
                            <span className="text-neutral-500">{key}:</span>{" "}
                            {value}
                          </div>
                        )
                      )}
                    </div>
                  </details>
                )}
            </div>
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
