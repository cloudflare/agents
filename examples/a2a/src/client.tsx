import "./styles.css";
import { createRoot } from "react-dom/client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentCard,
  Message,
  Task,
  TaskStatusUpdateEvent
} from "@a2a-js/sdk";
import {
  Button,
  Badge,
  Empty,
  InputArea,
  Surface,
  Text,
  PoweredByCloudflare
} from "@cloudflare/kumo";
import {
  InfoIcon,
  PaperPlaneRightIcon,
  RobotIcon,
  SpinnerIcon,
  MoonIcon,
  SunIcon
} from "@phosphor-icons/react";

// -- Lightweight A2A client using fetch (no SDK bundling needed) --

type A2AEvent = Message | Task | TaskStatusUpdateEvent;

async function fetchAgentCard(baseUrl: string): Promise<AgentCard> {
  const res = await fetch(`${baseUrl}/.well-known/agent-card.json`);
  if (!res.ok) throw new Error(`Failed to fetch agent card: ${res.status}`);
  return res.json();
}

async function sendMessage(
  url: string,
  message: Message
): Promise<Message | Task> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: { message }
    })
  });
  const json = (await res.json()) as {
    error?: { message: string };
    result: Message | Task;
  };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function* streamMessage(
  url: string,
  message: Message
): AsyncGenerator<A2AEvent, void, undefined> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/stream",
      params: { message }
    })
  });

  if (!res.ok) throw new Error(`Stream request failed: ${res.status}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop()!;

    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (line.startsWith("data: ")) {
          const data = JSON.parse(line.slice(6));
          if (data.result) yield data.result as A2AEvent;
        }
      }
    }
  }
}

// -- UI types --

interface ChatEntry {
  id: string;
  role: "user" | "agent";
  text: string;
  taskId?: string;
  status?: string;
}

// -- Components --

function getTextFromMessage(msg: Message): string {
  return msg.parts
    .filter((p) => p.kind === "text")
    .map((p) => (p as { kind: "text"; text: string }).text)
    .join("");
}

function StatusBadge({ state }: { state: string }) {
  const variant =
    state === "completed"
      ? "primary"
      : state === "failed" || state === "canceled"
        ? "destructive"
        : "secondary";

  return <Badge variant={variant}>{state}</Badge>;
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
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function Chat() {
  const [agentCard, setAgentCard] = useState<AgentCard | null>(null);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const contextIdRef = useRef<string>(crypto.randomUUID());

  // Discover agent on mount
  useEffect(() => {
    fetchAgentCard(window.location.origin)
      .then(setAgentCard)
      .catch((err) => setError(`Agent discovery failed: ${err.message}`));
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading || !agentCard) return;

    setInput("");
    setError(null);

    const userEntry: ChatEntry = {
      id: crypto.randomUUID(),
      role: "user",
      text
    };
    setMessages((prev) => [...prev, userEntry]);
    setIsLoading(true);

    const userMessage: Message = {
      contextId: contextIdRef.current,
      kind: "message",
      messageId: crypto.randomUUID(),
      parts: [{ kind: "text", text }],
      role: "user"
    };

    try {
      if (agentCard.capabilities.streaming) {
        // Use streaming
        let agentText = "";
        let taskStatus = "";
        let taskId = "";
        const agentEntryId = crypto.randomUUID();

        // Add placeholder
        setMessages((prev) => [
          ...prev,
          { id: agentEntryId, role: "agent", text: "", status: "working" }
        ]);

        for await (const event of streamMessage(agentCard.url, userMessage)) {
          if (event.kind === "message" && (event as Message).role === "agent") {
            agentText = getTextFromMessage(event as Message);
            taskId = (event as Message).taskId || taskId;
          } else if (event.kind === "status-update") {
            const update = event as TaskStatusUpdateEvent;
            taskStatus = update.status.state;
            taskId = update.taskId || taskId;
            if (update.status.message) {
              agentText = getTextFromMessage(update.status.message);
            }
          } else if (event.kind === "task") {
            taskId = (event as Task).id;
            taskStatus = (event as Task).status.state;
          }

          setMessages((prev) =>
            prev.map((m) =>
              m.id === agentEntryId
                ? {
                    ...m,
                    text: agentText,
                    status: taskStatus,
                    taskId
                  }
                : m
            )
          );
        }
      } else {
        // Non-streaming fallback
        const result = await sendMessage(agentCard.url, userMessage);
        let agentText = "";
        let taskId = "";
        let status = "";

        if (result.kind === "message") {
          agentText = getTextFromMessage(result);
        } else if (result.kind === "task") {
          const task = result as Task;
          taskId = task.id;
          status = task.status.state;
          if (task.status.message) {
            agentText = getTextFromMessage(task.status.message);
          }
        }

        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "agent",
            text: agentText,
            taskId,
            status
          }
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, agentCard]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <RobotIcon size={24} weight="bold" className="text-kumo-accent" />
            <h1 className="text-lg font-semibold text-kumo-default">
              {agentCard?.name || "A2A Agent"}
            </h1>
            <Badge variant="secondary">A2A Protocol</Badge>
          </div>
          <ModeToggle />
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {/* Explainer */}
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  Agent-to-Agent (A2A) Protocol
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    This demo exposes a Cloudflare Agent as an A2A-compliant
                    server. The browser acts as an A2A client, discovering the
                    agent via its Agent Card and communicating over JSON-RPC
                    with SSE streaming. Any A2A client can connect at{" "}
                    <code className="font-mono text-kumo-accent">
                      /.well-known/agent-card.json
                    </code>
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {/* Agent card info */}
          {agentCard && (
            <Surface className="p-3 rounded-xl ring ring-kumo-line">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="primary">v{agentCard.protocolVersion}</Badge>
                {agentCard.capabilities.streaming && (
                  <Badge variant="secondary">Streaming</Badge>
                )}
                {agentCard.skills?.map((skill) => (
                  <Badge key={skill.id} variant="secondary">
                    {skill.name}
                  </Badge>
                ))}
                <span className="text-xs text-kumo-subtle ml-auto font-mono">
                  {agentCard.url}
                </span>
              </div>
            </Surface>
          )}

          {messages.length === 0 && (
            <Empty
              icon={<RobotIcon size={32} />}
              title="Start a conversation"
              description='This AI agent communicates via the A2A protocol. Try "Explain A2A in simple terms" or "Write a haiku about cloud computing"'
            />
          )}

          {messages.map((entry) => {
            if (entry.role === "user") {
              return (
                <div key={entry.id} className="flex justify-end">
                  <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                    {entry.text}
                  </div>
                </div>
              );
            }

            return (
              <div key={entry.id} className="flex justify-start">
                <div className="max-w-[85%] space-y-2">
                  <div className="px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                    {entry.text ? (
                      <div className="whitespace-pre-wrap">
                        {entry.text}
                        {isLoading && entry.status === "working" && (
                          <span className="inline-block w-0.5 h-[1em] bg-kumo-brand ml-0.5 align-text-bottom animate-blink-cursor" />
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <SpinnerIcon
                          size={14}
                          className="animate-spin text-kumo-subtle"
                        />
                        <span className="text-sm text-kumo-subtle">
                          Thinking...
                        </span>
                      </div>
                    )}
                  </div>
                  {entry.status && (
                    <div className="flex items-center gap-2 px-1">
                      <StatusBadge state={entry.status} />
                      {entry.taskId && (
                        <span className="text-[10px] font-mono text-kumo-inactive truncate max-w-48">
                          {entry.taskId}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {error && (
            <Surface className="p-3 rounded-xl ring ring-red-300">
              <Text size="xs" variant="secondary">
                {error}
              </Text>
            </Surface>
          )}

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
                agentCard
                  ? "Send a message via A2A protocol..."
                  : "Discovering agent..."
              }
              disabled={!agentCard || isLoading}
              rows={2}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
            />
            <Button
              type="submit"
              variant="primary"
              shape="square"
              aria-label="Send message"
              disabled={!input.trim() || !agentCard || isLoading}
              icon={
                isLoading ? (
                  <SpinnerIcon size={18} className="animate-spin" />
                ) : (
                  <PaperPlaneRightIcon size={18} />
                )
              }
              className="mb-0.5"
            />
          </div>
        </form>
        <div className="flex justify-center pb-3">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}

const root = document.getElementById("root")!;
createRoot(root).render(<App />);
