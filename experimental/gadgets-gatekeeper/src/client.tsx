/**
 * Gatekeeper Example — Client
 *
 * Split-panel layout:
 *   Left:  AI chat (talk to the agent, ask it to query/modify the database)
 *   Right: Approval queue + customer data (see pending actions, approve/reject/revert)
 *
 * The chat and the approval queue are connected through the Agent's state sync.
 * When the agent proposes an action, it appears in the queue in real-time.
 * When a human approves/rejects, the database updates and the state syncs back.
 *
 * This demonstrates the Gatekeeper pattern's key UX property: the human always
 * has a clear view of what the agent wants to do, and full control over whether
 * it happens.
 */

import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import {
  PaperPlaneRightIcon,
  TrashIcon,
  CheckCircleIcon,
  XCircleIcon,
  GearIcon,
  ShieldCheckIcon,
  ClockIcon,
  ArrowCounterClockwiseIcon,
  DatabaseIcon,
  EyeIcon,
  WarningIcon,
  MagnifyingGlassIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import type { GatekeeperState, ActionEntry, CustomerRecord } from "./server";

// ─── Helpers ───────────────────────────────────────────────────────────────

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr + "Z").getTime()) / 1000
  );
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ─── Action Queue Panel ────────────────────────────────────────────────────

/**
 * The approval queue UI. This is the human's view into the Gatekeeper.
 *
 * Each pending action shows:
 * - What it does (title + description)
 * - The exact SQL that will run (full transparency)
 * - Approve / Reject buttons
 *
 * Approved actions show a Revert button if the action is revertable.
 * The entire history serves as an audit log.
 */
function ActionQueue({
  actions,
  onApprove,
  onReject,
  onRevert
}: {
  actions: ActionEntry[];
  onApprove: (id: number) => void;
  onReject: (id: number) => void;
  onRevert: (id: number) => void;
}) {
  const pending = actions.filter((a) => a.state === "pending");
  const resolved = actions.filter((a) => a.state !== "pending");

  return (
    <div className="space-y-4">
      {/* Pending actions — these need human attention */}
      {pending.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <WarningIcon size={16} className="text-kumo-warning" />
            <Text size="sm" bold>
              Pending Approval ({pending.length})
            </Text>
          </div>
          <div className="space-y-3">
            {pending.map((action) => (
              <Surface
                key={action.id}
                className="p-4 rounded-xl ring-2 ring-kumo-warning"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <Text size="sm" bold>
                    {action.title}
                  </Text>
                  <Badge variant="outline">Pending</Badge>
                </div>
                <p className="text-xs text-kumo-secondary mb-2">
                  {action.description}
                </p>
                <div className="bg-kumo-elevated rounded-lg p-2 mb-3 font-mono">
                  <p className="text-xs text-kumo-secondary">{action.sql}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<CheckCircleIcon size={14} />}
                    onClick={() => onApprove(action.id)}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<XCircleIcon size={14} />}
                    onClick={() => onReject(action.id)}
                  >
                    Reject
                  </Button>
                </div>
              </Surface>
            ))}
          </div>
        </div>
      )}

      {/* Resolved actions — the audit log */}
      {resolved.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <ClockIcon size={16} className="text-kumo-inactive" />
            <Text size="sm" bold>
              History
            </Text>
          </div>
          <div className="space-y-2">
            {resolved.map((action) => (
              <Surface key={action.id} className="p-3 rounded-lg">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {action.type === "observation" ? (
                      <EyeIcon
                        size={14}
                        className="text-kumo-inactive shrink-0"
                      />
                    ) : (
                      <DatabaseIcon
                        size={14}
                        className="text-kumo-inactive shrink-0"
                      />
                    )}
                    <Text size="xs">{action.title}</Text>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {action.state === "approved" && (
                      <Badge variant="primary">Approved</Badge>
                    )}
                    {action.state === "rejected" && (
                      <Badge variant="destructive">Rejected</Badge>
                    )}
                    {action.state === "reverted" && (
                      <Badge variant="secondary">Reverted</Badge>
                    )}
                  </div>
                </div>

                {/* Show revert button for approved, revertable actions */}
                {action.state === "approved" &&
                  action.canRevert &&
                  action.type === "action" && (
                    <div className="mt-2 flex justify-end">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<ArrowCounterClockwiseIcon size={14} />}
                        onClick={() => onRevert(action.id)}
                      >
                        Revert
                      </Button>
                    </div>
                  )}

                {action.resolvedAt && (
                  <p className="text-xs text-kumo-secondary mt-1">
                    {timeAgo(action.resolvedAt)}
                  </p>
                )}
              </Surface>
            ))}
          </div>
        </div>
      )}

      {actions.length === 0 && (
        <Empty
          icon={<ShieldCheckIcon size={32} />}
          title="No actions yet"
          description="Ask the agent to modify the database — actions will appear here for approval"
        />
      )}
    </div>
  );
}

// ─── Customer Table ────────────────────────────────────────────────────────

/**
 * Shows the current state of the customer database.
 * Updates in real-time as actions are approved/reverted.
 */
function CustomerTable({ customers }: { customers: CustomerRecord[] }) {
  if (customers.length === 0) {
    return (
      <Empty
        icon={<DatabaseIcon size={32} />}
        title="No customers"
        description="The database is empty"
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-kumo-line">
            <th className="text-left py-2 px-2 font-medium text-kumo-secondary">
              Name
            </th>
            <th className="text-left py-2 px-2 font-medium text-kumo-secondary">
              Email
            </th>
            <th className="text-left py-2 px-2 font-medium text-kumo-secondary">
              Tier
            </th>
            <th className="text-left py-2 px-2 font-medium text-kumo-secondary">
              Region
            </th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id} className="border-b border-kumo-line/50">
              <td className="py-2 px-2">{c.name}</td>
              <td className="py-2 px-2 text-kumo-secondary">{c.email}</td>
              <td className="py-2 px-2">
                <Badge variant={c.tier === "Gold" ? "primary" : "secondary"}>
                  {c.tier}
                </Badge>
              </td>
              <td className="py-2 px-2 text-kumo-secondary">{c.region}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Chat Panel ────────────────────────────────────────────────────────────

function ChatPanel() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [gatekeeperState, setGatekeeperState] =
    useState<GatekeeperState | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<GatekeeperState>({
    agent: "GatekeeperAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback(
      (state: GatekeeperState) => setGatekeeperState(state),
      []
    )
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  // Approval queue actions — call the agent's @callable methods via RPC
  const handleApprove = useCallback(
    (id: number) => agent.call("approveAction", [id]),
    [agent]
  );
  const handleReject = useCallback(
    (id: number) => agent.call("rejectAction", [id]),
    [agent]
  );
  const handleRevert = useCallback(
    (id: number) => agent.call("revertAction", [id]),
    [agent]
  );

  // Active tab for the right panel
  const [rightTab, setRightTab] = useState<"queue" | "data">("queue");
  const pendingCount =
    gatekeeperState?.actions.filter((a) => a.state === "pending").length ?? 0;

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* ── Left Panel: Chat ─────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0 border-r border-kumo-line">
        {/* Header */}
        <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Text size="lg" bold>
                Gatekeeper
              </Text>
              <Badge variant="secondary">
                <ShieldCheckIcon size={12} weight="bold" className="mr-1" />
                Approval Queue
              </Badge>
            </div>
            <div className="flex items-center gap-3">
              <ConnectionIndicator status={connectionStatus} />
              <ModeToggle />
              <Button
                variant="secondary"
                icon={<TrashIcon size={16} />}
                onClick={clearHistory}
              >
                Clear
              </Button>
            </div>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-5 py-6 space-y-5">
            {messages.length === 0 && (
              <Empty
                icon={<MagnifyingGlassIcon size={32} />}
                title="Talk to the database agent"
                description={`Try: "Show me all Gold tier customers" or "Upgrade all East region customers to Gold"`}
              />
            )}

            {messages.map((message, index) => {
              const isUser = message.role === "user";
              const isLastAssistant =
                message.role === "assistant" && index === messages.length - 1;

              return (
                <div key={message.id} className="space-y-2">
                  {isUser ? (
                    <div className="flex justify-end">
                      <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                        {getMessageText(message)}
                      </div>
                    </div>
                  ) : (
                    getMessageText(message) && (
                      <div className="flex justify-start">
                        <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed overflow-hidden">
                          <Streamdown
                            className="sd-theme px-4 py-2.5"
                            controls={false}
                            isAnimating={isLastAssistant && isStreaming}
                          >
                            {getMessageText(message)}
                          </Streamdown>
                        </div>
                      </div>
                    )
                  )}

                  {/* Tool call indicators */}
                  {message.parts
                    .filter((part) => isToolUIPart(part))
                    .map((part) => {
                      if (!isToolUIPart(part)) return null;
                      const toolName = getToolName(part);

                      if (part.state === "output-available") {
                        return (
                          <div
                            key={part.toolCallId}
                            className="flex justify-start"
                          >
                            <Surface className="max-w-[85%] px-3 py-2 rounded-lg ring ring-kumo-line">
                              <div className="flex items-center gap-2">
                                {toolName === "queryDatabase" ? (
                                  <EyeIcon
                                    size={14}
                                    className="text-kumo-positive"
                                  />
                                ) : (
                                  <ShieldCheckIcon
                                    size={14}
                                    className="text-kumo-warning"
                                  />
                                )}
                                <Text size="xs" variant="secondary">
                                  {toolName === "queryDatabase"
                                    ? "Query executed (auto-approved)"
                                    : "Action queued for approval"}
                                </Text>
                              </div>
                            </Surface>
                          </div>
                        );
                      }

                      if (
                        part.state === "input-available" ||
                        part.state === "input-streaming"
                      ) {
                        return (
                          <div
                            key={part.toolCallId}
                            className="flex justify-start"
                          >
                            <Surface className="max-w-[85%] px-3 py-2 rounded-lg ring ring-kumo-line">
                              <div className="flex items-center gap-2">
                                <GearIcon
                                  size={14}
                                  className="text-kumo-inactive animate-spin"
                                />
                                <Text size="xs" variant="secondary">
                                  Running {toolName}...
                                </Text>
                              </div>
                            </Surface>
                          </div>
                        );
                      }

                      return null;
                    })}
                </div>
              );
            })}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <div className="border-t border-kumo-line bg-kumo-base">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="max-w-2xl mx-auto px-5 py-4"
          >
            <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
              <InputArea
                value={input}
                onValueChange={setInput}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder='Try: "Show me customers in the West region"'
                disabled={!isConnected || isStreaming}
                rows={2}
                className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
              />
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={!input.trim() || !isConnected || isStreaming}
                icon={<PaperPlaneRightIcon size={18} />}
                loading={isStreaming}
                className="mb-0.5"
              />
            </div>
          </form>
          <div className="flex justify-center pb-3">
            <PoweredByAgents />
          </div>
        </div>
      </div>

      {/* ── Right Panel: Approval Queue + Data ───────────────────── */}
      <div className="w-[420px] flex flex-col bg-kumo-base shrink-0">
        {/* Tab bar */}
        <div className="flex border-b border-kumo-line">
          <button
            onClick={() => setRightTab("queue")}
            className={`flex-1 py-3 px-4 text-sm font-medium transition-colors relative ${
              rightTab === "queue"
                ? "text-kumo-default"
                : "text-kumo-secondary hover:text-kumo-default"
            }`}
          >
            <span className="flex items-center justify-center gap-2">
              <ShieldCheckIcon size={16} />
              Actions
              {pendingCount > 0 && (
                <Badge variant="destructive">{pendingCount}</Badge>
              )}
            </span>
            {rightTab === "queue" && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-kumo-brand" />
            )}
          </button>
          <button
            onClick={() => setRightTab("data")}
            className={`flex-1 py-3 px-4 text-sm font-medium transition-colors relative ${
              rightTab === "data"
                ? "text-kumo-default"
                : "text-kumo-secondary hover:text-kumo-default"
            }`}
          >
            <span className="flex items-center justify-center gap-2">
              <DatabaseIcon size={16} />
              Customers
              {gatekeeperState && (
                <Badge variant="secondary">
                  {gatekeeperState.customers.length}
                </Badge>
              )}
            </span>
            {rightTab === "data" && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-kumo-brand" />
            )}
          </button>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-4">
          {rightTab === "queue" && gatekeeperState && (
            <ActionQueue
              actions={gatekeeperState.actions}
              onApprove={handleApprove}
              onReject={handleReject}
              onRevert={handleRevert}
            />
          )}
          {rightTab === "data" && gatekeeperState && (
            <CustomerTable customers={gatekeeperState.customers} />
          )}
          {!gatekeeperState && (
            <div className="flex items-center justify-center h-32">
              <Text variant="secondary">Connecting...</Text>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── App Root ──────────────────────────────────────────────────────────────

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <ChatPanel />
    </Suspense>
  );
}
