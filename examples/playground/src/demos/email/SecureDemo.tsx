import { useAgent } from "agents/react";
import { useState } from "react";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus, LocalDevBanner } from "../../components";
import { useLogs } from "../../hooks";
import type {
  SecureEmailAgent,
  SecureEmailState,
  ParsedEmail,
  SentReply
} from "./secure-email-agent";
import { Mail, Shield, Send, Inbox, Lock, CheckCircle } from "lucide-react";

type TabType = "inbox" | "outbox";

export function SecureDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [activeTab, setActiveTab] = useState<TabType>("inbox");
  const [selectedEmail, setSelectedEmail] = useState<ParsedEmail | null>(null);
  const [selectedReply, setSelectedReply] = useState<SentReply | null>(null);

  // Local state synced from agent
  const [state, setState] = useState<SecureEmailState>({
    inbox: [],
    outbox: [],
    totalReceived: 0,
    totalReplies: 0,
    autoReplyEnabled: true
  });

  const agent = useAgent<SecureEmailAgent, SecureEmailState>({
    agent: "secure-email-agent",
    name: "demo",
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
    >
      <LocalDevBanner />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-4">
        {/* Left Panel - Info & Settings */}
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
                  Received
                </div>
                <div className="text-2xl font-semibold">
                  {state.totalReceived}
                </div>
              </div>
              <div className="p-3 bg-neutral-50 dark:bg-neutral-800 rounded">
                <div className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400 text-xs mb-1">
                  <Send className="w-3 h-3" />
                  Replies
                </div>
                <div className="text-2xl font-semibold">
                  {state.totalReplies}
                </div>
              </div>
            </div>
          </div>

          <div className="card p-4">
            <h3 className="font-semibold mb-3">Settings</h3>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={state.autoReplyEnabled}
                onChange={handleToggleAutoReply}
                className="w-4 h-4"
              />
              <span className="text-sm">Auto-reply with signed headers</span>
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
              When enabled, incoming emails receive a signed reply that can be
              securely routed back.
            </p>
          </div>

          <div className="card p-4 bg-neutral-50 dark:bg-neutral-800">
            <div className="flex items-center gap-2 mb-3">
              <Shield className="w-4 h-4" />
              <h3 className="font-semibold">How Secure Replies Work</h3>
            </div>
            <ol className="text-sm text-neutral-600 dark:text-neutral-300 space-y-2">
              <li>
                <strong>1.</strong> Email arrives at{" "}
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
                  secure+demo@domain
                </code>
              </li>
              <li>
                <strong>2.</strong> Agent sends reply with signed headers:
                <ul className="mt-1 ml-4 text-xs space-y-0.5">
                  <li>
                    <code>X-Agent-Name</code>
                  </li>
                  <li>
                    <code>X-Agent-ID</code>
                  </li>
                  <li>
                    <code>X-Agent-Sig</code> (HMAC)
                  </li>
                  <li>
                    <code>X-Agent-Sig-Ts</code>
                  </li>
                </ul>
              </li>
              <li>
                <strong>3.</strong> When user replies, signature is verified
              </li>
              <li>
                <strong>4.</strong> Valid replies route back to same agent
                instance
              </li>
            </ol>
          </div>

          <div className="card p-4">
            <h3 className="font-semibold mb-2 text-sm">Production Setup</h3>
            <div className="text-xs text-neutral-600 dark:text-neutral-400 space-y-1">
              <div>Set a secure secret:</div>
              <code className="block bg-neutral-100 dark:bg-neutral-700 px-2 py-1 rounded mt-1">
                wrangler secret put EMAIL_SECRET
              </code>
            </div>
          </div>
        </div>

        {/* Center Panel - Mailboxes */}
        <div className="space-y-6">
          <div className="card overflow-hidden">
            {/* Tabs */}
            <div className="flex border-b border-neutral-200 dark:border-neutral-700">
              <button
                type="button"
                onClick={() => {
                  setActiveTab("inbox");
                  setSelectedEmail(null);
                  setSelectedReply(null);
                }}
                className={`flex-1 px-4 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  activeTab === "inbox"
                    ? "bg-neutral-100 dark:bg-neutral-800 border-b-2 border-black dark:border-white"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-800"
                }`}
              >
                <Inbox className="w-4 h-4" />
                Inbox ({state.inbox.length})
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab("outbox");
                  setSelectedEmail(null);
                  setSelectedReply(null);
                }}
                className={`flex-1 px-4 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  activeTab === "outbox"
                    ? "bg-neutral-100 dark:bg-neutral-800 border-b-2 border-black dark:border-white"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-800"
                }`}
              >
                <Send className="w-4 h-4" />
                Outbox ({state.outbox.length})
              </button>
            </div>

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
                      className={`w-full text-left p-3 border-b border-neutral-100 dark:border-neutral-700 last:border-0 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors ${
                        selectedEmail?.id === email.id
                          ? "bg-neutral-100 dark:bg-neutral-800"
                          : ""
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          {email.isSecureReply && (
                            <Lock className="w-3 h-3 text-green-500" />
                          )}
                          <span className="text-sm font-medium truncate">
                            {email.from}
                          </span>
                        </div>
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
                    No emails received
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
                    className={`w-full text-left p-3 border-b border-neutral-100 dark:border-neutral-700 last:border-0 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors ${
                      selectedReply?.id === reply.id
                        ? "bg-neutral-100 dark:bg-neutral-800"
                        : ""
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        {reply.signed && (
                          <CheckCircle className="w-3 h-3 text-green-500" />
                        )}
                        <span className="text-sm font-medium truncate">
                          {reply.to}
                        </span>
                      </div>
                      <span className="text-xs text-neutral-400">
                        {new Date(reply.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-sm text-neutral-600 dark:text-neutral-400 truncate">
                      {reply.subject}
                    </p>
                  </button>
                ))
              ) : (
                <div className="p-8 text-center text-neutral-400 text-sm">
                  <Send className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  No replies sent
                </div>
              )}
            </div>

            {/* Clear button */}
            {(state.inbox.length > 0 || state.outbox.length > 0) && (
              <div className="p-2 border-t border-neutral-200 dark:border-neutral-700">
                <button
                  type="button"
                  onClick={handleClearEmails}
                  className="text-xs text-red-600 hover:text-red-800"
                >
                  Clear all emails
                </button>
              </div>
            )}
          </div>

          {/* Email Detail */}
          {selectedEmail && (
            <div className="card p-4">
              <div className="mb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {selectedEmail.isSecureReply && (
                      <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 text-xs rounded flex items-center gap-1">
                        <Lock className="w-3 h-3" />
                        Secure Reply
                      </span>
                    )}
                    <h3 className="font-semibold">{selectedEmail.subject}</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedEmail(null)}
                    className="text-neutral-400 hover:text-neutral-600"
                  >
                    ×
                  </button>
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  <div>From: {selectedEmail.from}</div>
                  <div>To: {selectedEmail.to}</div>
                  <div>
                    Date: {new Date(selectedEmail.timestamp).toLocaleString()}
                  </div>
                </div>
              </div>
              <div className="bg-neutral-50 dark:bg-neutral-900 rounded p-3 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto">
                {selectedEmail.text || selectedEmail.html || "(No content)"}
              </div>
            </div>
          )}

          {/* Reply Detail */}
          {selectedReply && (
            <div className="card p-4">
              <div className="mb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {selectedReply.signed && (
                      <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 text-xs rounded flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" />
                        Signed
                      </span>
                    )}
                    <h3 className="font-semibold">{selectedReply.subject}</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedReply(null)}
                    className="text-neutral-400 hover:text-neutral-600"
                  >
                    ×
                  </button>
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  <div>To: {selectedReply.to}</div>
                  <div>
                    Date: {new Date(selectedReply.timestamp).toLocaleString()}
                  </div>
                </div>
              </div>
              <div className="bg-neutral-50 dark:bg-neutral-900 rounded p-3 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto">
                {selectedReply.body}
              </div>
              {selectedReply.signed && (
                <div className="mt-3 p-2 bg-green-50 dark:bg-green-900/30 rounded text-xs text-green-700 dark:text-green-300">
                  This reply includes signed X-Agent-* headers for secure
                  routing.
                </div>
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
