/**
 * Sub-Agents Example — Client
 *
 * Chat on the left. Right panel shows the most recent analysis round:
 * three perspective cards (Technical, Business, Skeptic) and the synthesis.
 * Each card updates as its facet completes, showing parallel execution.
 */

import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart } from "ai";
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
  UsersThreeIcon,
  LightbulbIcon,
  ChartBarIcon,
  WarningCircleIcon,
  ArrowsInIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import type {
  SubagentState,
  AnalysisRound,
  PerspectiveId
  // PERSPECTIVES
} from "./server";

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

// ─── Perspective Card ──────────────────────────────────────────────────────

const perspectiveConfig: Record<
  PerspectiveId,
  { icon: React.ReactNode; color: string }
> = {
  technical: {
    icon: <GearIcon size={16} />,
    color: "text-kumo-brand"
  },
  business: {
    icon: <ChartBarIcon size={16} />,
    color: "text-kumo-positive"
  },
  skeptic: {
    icon: <WarningCircleIcon size={16} />,
    color: "text-kumo-warning"
  }
};

function PerspectiveCard({
  perspectiveId,
  name,
  analysis
}: {
  perspectiveId: PerspectiveId;
  name: string;
  analysis: string | null;
}) {
  const config =
    perspectiveConfig[perspectiveId] ?? perspectiveConfig.technical;

  return (
    <Surface className="rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-kumo-line">
        <span className={config.color}>{config.icon}</span>
        <Text size="xs" bold>
          {name}
        </Text>
        {analysis ? (
          <Badge variant="primary">Done</Badge>
        ) : (
          <Badge variant="outline">Thinking...</Badge>
        )}
      </div>
      <div className="px-3 py-2">
        {analysis ? (
          <Streamdown className="sd-theme text-sm" controls={false}>
            {analysis}
          </Streamdown>
        ) : (
          <div className="flex items-center gap-2 py-4 justify-center">
            <GearIcon size={14} className="text-kumo-inactive animate-spin" />
            <Text size="xs" variant="secondary">
              Analyzing...
            </Text>
          </div>
        )}
      </div>
    </Surface>
  );
}

// ─── Analysis Panel ────────────────────────────────────────────────────────

function AnalysisPanel({ analyses }: { analyses: AnalysisRound[] }) {
  if (analyses.length === 0) {
    return (
      <Empty
        icon={<UsersThreeIcon size={32} />}
        title="No analyses yet"
        description='Ask a question — e.g. "Should we rewrite our backend in Rust?"'
      />
    );
  }

  const latest = analyses[0];

  return (
    <div className="space-y-3">
      {/* Question */}
      <div className="px-1">
        <Text size="xs" variant="secondary" bold>
          Question
        </Text>
        <Text size="sm" bold>
          {latest.question}
        </Text>
      </div>

      {/* Three perspective cards */}
      {(["technical", "business", "skeptic"] as PerspectiveId[]).map((pid) => {
        const result = latest.perspectives.find((p) => p.perspectiveId === pid);
        const names: Record<PerspectiveId, string> = {
          technical: "Technical Expert",
          business: "Business Analyst",
          skeptic: "Devil's Advocate"
        };
        return (
          <PerspectiveCard
            key={pid}
            perspectiveId={pid}
            name={names[pid]}
            analysis={result?.analysis ?? null}
          />
        );
      })}

      {/* Synthesis */}
      {latest.synthesis && (
        <Surface className="rounded-lg overflow-hidden ring-2 ring-kumo-brand">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-kumo-line">
            <ArrowsInIcon size={16} className="text-kumo-brand" />
            <Text size="xs" bold>
              Synthesis
            </Text>
            <Badge variant="primary">Combined</Badge>
          </div>
          <div className="px-3 py-2">
            <Streamdown className="sd-theme text-sm" controls={false}>
              {latest.synthesis}
            </Streamdown>
          </div>
        </Surface>
      )}

      {/* History */}
      {analyses.length > 1 && (
        <div className="pt-2">
          <Text size="xs" variant="secondary" bold>
            Previous ({analyses.length - 1})
          </Text>
          <div className="space-y-1 mt-1">
            {analyses.slice(1).map((round) => (
              <Surface key={round.id} className="px-3 py-2 rounded-lg">
                <Text size="xs">{round.question}</Text>
                <Text size="xs" variant="secondary">
                  {round.perspectives.length} perspectives
                  {round.synthesis ? " + synthesis" : ""}
                </Text>
              </Surface>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────

function ChatPanel() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [agentState, setAgentState] = useState<SubagentState | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<SubagentState>({
    agent: "CoordinatorAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback(
      (state: SubagentState) => setAgentState(state),
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

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* Left: Chat */}
      <div className="flex flex-col flex-1 min-w-0 border-r border-kumo-line">
        <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Text size="lg" bold>
                Sub-Agents
              </Text>
              <Badge variant="secondary">
                <UsersThreeIcon size={12} weight="bold" className="mr-1" />
                Multi-Perspective
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
                icon={<LightbulbIcon size={32} />}
                title="Ask a question for multi-perspective analysis"
                description={`Try: "Should we migrate to microservices?" or "Is AI going to replace software engineers?"`}
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

                      if (part.state === "output-available") {
                        return (
                          <div
                            key={part.toolCallId}
                            className="flex justify-start"
                          >
                            <Surface className="max-w-[85%] px-3 py-2 rounded-lg ring ring-kumo-line">
                              <div className="flex items-center gap-2">
                                <UsersThreeIcon
                                  size={14}
                                  className="text-kumo-brand"
                                />
                                <Text size="xs" variant="secondary">
                                  3 perspectives analyzed + synthesis complete
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
                                  Analyzing from 3 perspectives...
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
                placeholder='Try: "Should we build or buy our auth system?"'
                disabled={!isConnected || isStreaming}
                rows={2}
                className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none!"
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

      {/* Right: Analysis panels */}
      <div className="w-[440px] flex flex-col bg-kumo-base shrink-0">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-kumo-line">
          <UsersThreeIcon size={16} />
          <Text size="sm" bold>
            Perspectives
          </Text>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {agentState ? (
            <AnalysisPanel analyses={agentState.analyses} />
          ) : (
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
