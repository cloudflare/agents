import { useState, useEffect, useRef, useCallback } from "react";
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
  TrashIcon,
  ArrowsClockwiseIcon,
  ChatCircleDotsIcon,
  CaretRightIcon,
  CheckCircleIcon,
  StackIcon,
  PaperPlaneRightIcon
} from "@phosphor-icons/react";
import { useAgent } from "agents/react";
import type { ChatAgent } from "./server";
import type { UIMessage } from "ai";

// Tool parts come as "dynamic-tool" with input/output fields
type ToolPart = Extract<UIMessage["parts"][number], { type: string }> & {
  toolCallId: string;
  toolName: string;
  state: string;
  input?: Record<string, unknown>;
  output?: unknown;
};

function isToolPart(part: UIMessage["parts"][number]): part is ToolPart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function ToolCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const done = part.state === "output-available";
  const label = [part.input?.action, part.input?.label]
    .filter(Boolean)
    .join(" ");

  return (
    <Surface className="rounded-xl ring ring-kumo-line overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-kumo-elevated transition-colors"
        onClick={() => setOpen(!open)}
      >
        <CaretRightIcon
          size={12}
          className={`text-kumo-secondary transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Text size="xs" bold>
          {part.toolName}
        </Text>
        {label && (
          <span className="font-mono text-xs text-kumo-secondary truncate">
            {label}
          </span>
        )}
        {done && (
          <CheckCircleIcon
            size={14}
            className="text-green-500 ml-auto shrink-0"
          />
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-kumo-line space-y-2 pt-2">
          {part.input && (
            <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(part.input, null, 2)}
            </pre>
          )}
          {part.output != null && (
            <pre className="font-mono text-xs text-green-600 dark:text-green-400 bg-green-500/5 border border-green-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {typeof part.output === "string"
                ? part.output
                : JSON.stringify(part.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </Surface>
  );
}

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasFetched = useRef(false);

  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    name: "default",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => {
      setConnectionStatus("disconnected");
      hasFetched.current = false;
    }, [])
  });

  // Load messages once on connect
  if (connectionStatus === "connected" && !hasFetched.current) {
    hasFetched.current = true;
    agent
      .call<UIMessage[]>("getMessages")
      .then(setMessages)
      .catch(console.error);
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    setIsLoading(true);
    const userMsg: UIMessage = {
      id: `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text }]
    };
    setMessages((prev) => [...prev, userMsg]);
    try {
      const msg = await agent.call<UIMessage>("chat", [text, userMsg.id]);
      setMessages((prev) => [...prev, msg]);
    } catch (err) {
      console.error("Failed to send:", err);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, agent]);

  const isConnected = connectionStatus === "connected";

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Session Memory
            </h1>
            <Badge variant="secondary">{messages.length} msgs</Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="secondary"
              icon={<ArrowsClockwiseIcon size={16} />}
              onClick={async () => {
                setIsCompacting(true);
                try {
                  await agent.call("compact");
                  setMessages(await agent.call<UIMessage[]>("getMessages"));
                } catch (err) {
                  console.error("Compact failed:", err);
                } finally {
                  setIsCompacting(false);
                }
              }}
              disabled={isCompacting || isLoading || messages.length < 4}
              loading={isCompacting}
            >
              Compact
            </Button>
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={async () => {
                try {
                  await agent.call("clearMessages");
                  setMessages([]);
                } catch (err) {
                  console.error("Clear failed:", err);
                }
              }}
              disabled={messages.length === 0}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && !isLoading && (
            <Empty
              icon={<ChatCircleDotsIcon size={32} />}
              title="Start a conversation"
              description="Messages persist in SQLite. The agent saves facts to memory and manages todos via tools. Try compacting after a few exchanges."
            />
          )}

          {messages.map((message) => {
            if (message.role === "user") {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse text-sm leading-relaxed">
                    {message.parts
                      .filter((p) => p.type === "text")
                      .map((p) => (p.type === "text" ? p.text : ""))
                      .join("")}
                  </div>
                </div>
              );
            }

            const isCompaction = message.id.startsWith("compaction_");
            return (
              <div key={message.id} className="space-y-2">
                {isCompaction && (
                  <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 font-semibold">
                    <StackIcon size={12} weight="bold" /> Compacted Summary
                  </div>
                )}
                {message.parts.map((part, i) => {
                  if (part.type === "text" && part.text?.trim()) {
                    return (
                      <div key={i} className="flex justify-start">
                        <Surface
                          className={`max-w-[80%] rounded-2xl rounded-bl-md ring ${isCompaction ? "ring-amber-200 dark:ring-amber-800 bg-amber-50 dark:bg-amber-950/30" : "ring-kumo-line"}`}
                        >
                          <div className="px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                            {part.text}
                          </div>
                        </Surface>
                      </div>
                    );
                  }
                  if (isToolPart(part)) {
                    return (
                      <div key={part.toolCallId ?? i} className="max-w-[80%]">
                        <ToolCard part={part} />
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            );
          })}

          {isLoading && (
            <div className="flex justify-start">
              <div className="px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base">
                <span className="inline-block w-2 h-2 bg-kumo-brand rounded-full mr-1 animate-pulse" />
                <span
                  className="inline-block w-2 h-2 bg-kumo-brand rounded-full mr-1 animate-pulse"
                  style={{ animationDelay: "150ms" }}
                />
                <span
                  className="inline-block w-2 h-2 bg-kumo-brand rounded-full animate-pulse"
                  style={{ animationDelay: "300ms" }}
                />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
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
              placeholder={
                isConnected
                  ? "Ask me anything... I'll remember important facts."
                  : "Connecting..."
              }
              disabled={!isConnected || isLoading}
              rows={2}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!input.trim() || !isConnected || isLoading}
              icon={<PaperPlaneRightIcon size={18} />}
              className="mb-0.5"
            />
          </div>
        </form>
        <div className="flex justify-center pb-3">
          <PoweredByAgents />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return <Chat />;
}
