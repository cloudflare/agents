/**
 * Sandbox Example — Client
 *
 * Split layout: chat on the left, execution log + customer data on the right.
 * The agent writes code that runs in a sandboxed isolate — the execution log
 * shows the code and its captured console output.
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
  GearIcon,
  CodeIcon,
  DatabaseIcon,
  TerminalIcon,
  PlayIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import type { SandboxState, ExecutionRecord, CustomerRecord } from "./server";

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

// ─── Execution Log ─────────────────────────────────────────────────────────

function ExecutionLog({ executions }: { executions: ExecutionRecord[] }) {
  if (executions.length === 0) {
    return (
      <Empty
        icon={<TerminalIcon size={32} />}
        title="No executions yet"
        description='Ask the agent to write code — e.g. "List all Gold tier customers"'
      />
    );
  }

  return (
    <div className="space-y-3">
      {executions.map((exec) => (
        <Surface key={exec.id} className="rounded-lg overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-kumo-line">
            <CodeIcon size={14} className="text-kumo-brand" />
            <Text size="xs" bold>
              Code
            </Text>
            {exec.error ? (
              <Badge variant="destructive">Error</Badge>
            ) : (
              <Badge variant="primary">OK</Badge>
            )}
            <span className="ml-auto text-xs text-kumo-secondary">
              {exec.timestamp}
            </span>
          </div>

          {/* Code */}
          <pre className="px-3 py-2 text-xs font-mono bg-kumo-elevated overflow-x-auto whitespace-pre-wrap border-b border-kumo-line">
            {exec.code.length > 500
              ? exec.code.slice(0, 500) + "\n// ... truncated"
              : exec.code}
          </pre>

          {/* Output */}
          <div className="px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <TerminalIcon size={12} className="text-kumo-inactive" />
              <Text size="xs" variant="secondary" bold>
                Output
              </Text>
            </div>
            <pre className="text-xs font-mono whitespace-pre-wrap text-kumo-default">
              {exec.output || "(no output)"}
            </pre>
          </div>
        </Surface>
      ))}
    </div>
  );
}

// ─── Customer Table ────────────────────────────────────────────────────────

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

// ─── Main ──────────────────────────────────────────────────────────────────

function ChatPanel() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [sandboxState, setSandboxState] = useState<SandboxState | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<SandboxState>({
    agent: "SandboxAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback(
      (state: SandboxState) => setSandboxState(state),
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

  const [rightTab, setRightTab] = useState<"executions" | "data">("executions");

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* Left: Chat */}
      <div className="flex flex-col flex-1 min-w-0 border-r border-kumo-line">
        <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Text size="lg" bold>
                Sandbox
              </Text>
              <Badge variant="secondary">
                <PlayIcon size={12} weight="bold" className="mr-1" />
                Dynamic Code Execution
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

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-5 py-6 space-y-5">
            {messages.length === 0 && (
              <Empty
                icon={<CodeIcon size={32} />}
                title="Talk to the sandbox agent"
                description={`Try: "Write code to count customers by tier" or "Find customers whose email contains 'example'"`}
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
                                {toolName === "executeCode" ? (
                                  <PlayIcon
                                    size={14}
                                    className="text-kumo-brand"
                                  />
                                ) : (
                                  <DatabaseIcon
                                    size={14}
                                    className="text-kumo-positive"
                                  />
                                )}
                                <Text size="xs" variant="secondary">
                                  {toolName === "executeCode"
                                    ? "Code executed in sandbox"
                                    : "Query executed"}
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
                                  {toolName === "executeCode"
                                    ? "Running code in sandbox..."
                                    : `Running ${toolName}...`}
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
                placeholder='Try: "Write code to count customers by region"'
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

      {/* Right: Execution Log + Data */}
      <div className="w-[420px] flex flex-col bg-kumo-base shrink-0">
        <div className="flex border-b border-kumo-line">
          <button
            onClick={() => setRightTab("executions")}
            className={`flex-1 py-3 px-4 text-sm font-medium transition-colors relative ${
              rightTab === "executions"
                ? "text-kumo-default"
                : "text-kumo-secondary hover:text-kumo-default"
            }`}
          >
            <span className="flex items-center justify-center gap-2">
              <TerminalIcon size={16} />
              Executions
              {sandboxState && sandboxState.executions.length > 0 && (
                <Badge variant="secondary">
                  {sandboxState.executions.length}
                </Badge>
              )}
            </span>
            {rightTab === "executions" && (
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
              {sandboxState && (
                <Badge variant="secondary">
                  {sandboxState.customers.length}
                </Badge>
              )}
            </span>
            {rightTab === "data" && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-kumo-brand" />
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {rightTab === "executions" && sandboxState && (
            <ExecutionLog executions={sandboxState.executions} />
          )}
          {rightTab === "data" && sandboxState && (
            <CustomerTable customers={sandboxState.customers} />
          )}
          {!sandboxState && (
            <div className="flex items-center justify-center h-32">
              <Text variant="secondary">Connecting...</Text>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
