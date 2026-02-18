import { Suspense, useCallback, useRef, useState, useEffect } from "react";
import { useAgent } from "agents/react";
import { Button, InputArea, Empty, Text } from "@cloudflare/kumo";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import {
  PaperPlaneRightIcon,
  BrainIcon,
  CodeIcon,
  TrashIcon,
  PlusIcon,
  ChatCircleIcon
} from "@phosphor-icons/react";
import {
  MessageType,
  type ThinkMessage,
  type ThreadInfo,
  type ServerMessage
} from "./shared";

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getThreadIdFromHash(): string | null {
  const hash = window.location.hash.slice(1);
  return hash || null;
}

function setHash(threadId: string | null) {
  if (threadId) {
    window.history.replaceState(null, "", `#${threadId}`);
  } else {
    window.history.replaceState(null, "", window.location.pathname);
  }
}

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ThinkMessage[]>([]);
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    getThreadIdFromHash
  );
  const pendingSelectRef = useRef(false);
  const initialLoadRef = useRef(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pendingHashLoadRef = useRef<string | null>(getThreadIdFromHash());

  const agent = useAgent({
    agent: "ThinkAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onMessage: useCallback((event: MessageEvent) => {
      const data = JSON.parse(event.data) as ServerMessage<ThinkMessage>;

      switch (data.type) {
        case MessageType.THREADS:
          setThreads(data.threads);
          if (pendingSelectRef.current && data.threads.length > 0) {
            pendingSelectRef.current = false;
            const newest = data.threads[0];
            setActiveThreadId(newest.id);
            setHash(newest.id);
            setMessages([]);
          }
          if (initialLoadRef.current) {
            initialLoadRef.current = false;
            const hashId = pendingHashLoadRef.current;
            pendingHashLoadRef.current = null;
            if (
              hashId &&
              data.threads.some((t: ThreadInfo) => t.id === hashId)
            ) {
              setActiveThreadId(hashId);
            }
          }
          break;
        case MessageType.SYNC:
          setActiveThreadId((current) => {
            if (data.threadId === current) {
              setMessages(data.messages);
            }
            return current;
          });
          break;
        case MessageType.CLEAR:
          setActiveThreadId((current) => {
            if (data.threadId === current) {
              setMessages([]);
            }
            return current;
          });
          break;
      }
    }, []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const isConnected = connectionStatus === "connected";

  useEffect(() => {
    if (!isConnected) return;
    const hashId = getThreadIdFromHash();
    if (hashId && activeThreadId === hashId && messages.length === 0) {
      agent.send(
        JSON.stringify({
          type: MessageType.GET_MESSAGES,
          threadId: hashId
        })
      );
    }
  }, [isConnected, activeThreadId, agent, messages.length]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const onHashChange = () => {
      const id = getThreadIdFromHash();
      if (id && id !== activeThreadId) {
        setActiveThreadId(id);
        setMessages([]);
        agent.send(
          JSON.stringify({
            type: MessageType.GET_MESSAGES,
            threadId: id
          })
        );
      } else if (!id) {
        setActiveThreadId(null);
        setMessages([]);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [agent, activeThreadId]);

  const createThread = useCallback(() => {
    pendingSelectRef.current = true;
    agent.send(
      JSON.stringify({
        type: MessageType.CREATE_THREAD,
        name: `Thread ${threads.length + 1}`
      })
    );
  }, [agent, threads.length]);

  const selectThread = useCallback(
    (threadId: string) => {
      setActiveThreadId(threadId);
      setHash(threadId);
      setMessages([]);
      agent.send(
        JSON.stringify({
          type: MessageType.GET_MESSAGES,
          threadId
        })
      );
    },
    [agent]
  );

  const deleteThread = useCallback(
    (threadId: string) => {
      agent.send(
        JSON.stringify({
          type: MessageType.DELETE_THREAD,
          threadId
        })
      );
      if (activeThreadId === threadId) {
        setActiveThreadId(null);
        setHash(null);
        setMessages([]);
      }
    },
    [agent, activeThreadId]
  );

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || !activeThreadId) return;
    setInput("");

    const message: ThinkMessage = {
      id: genId(),
      role: "user",
      content: text,
      createdAt: Date.now()
    };

    setMessages((prev) => [...prev, message]);

    agent.send(
      JSON.stringify({
        type: MessageType.ADD,
        threadId: activeThreadId,
        message
      })
    );
  }, [input, agent, activeThreadId]);

  const clearHistory = useCallback(() => {
    if (!activeThreadId) return;
    setMessages([]);
    agent.send(
      JSON.stringify({
        type: MessageType.CLEAR_REQUEST,
        threadId: activeThreadId
      })
    );
  }, [agent, activeThreadId]);

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* Sidebar */}
      <div className="flex w-64 flex-col border-r border-kumo-line bg-kumo-base">
        <div className="flex items-center justify-between border-b border-kumo-line px-4 py-4">
          <div className="flex items-center gap-2">
            <BrainIcon size={20} className="text-kumo-brand" weight="duotone" />
            <Text size="sm" bold>
              Threads
            </Text>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<PlusIcon size={14} />}
            onClick={createThread}
            disabled={!isConnected}
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {threads.length === 0 && (
            <div className="px-2 py-4">
              <Text size="xs" variant="secondary">
                No threads yet. Create one to get started.
              </Text>
            </div>
          )}

          {threads.map((thread) => (
            <div
              key={thread.id}
              role="button"
              tabIndex={0}
              className={`group mb-1 flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${
                activeThreadId === thread.id
                  ? "bg-kumo-elevated"
                  : "hover:bg-kumo-elevated/50"
              }`}
              onClick={() => selectThread(thread.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectThread(thread.id);
                }
              }}
            >
              <div className="flex items-center gap-2 overflow-hidden">
                <ChatCircleIcon
                  size={14}
                  className="shrink-0 text-kumo-inactive"
                />
                <Text size="sm">{thread.name}</Text>
              </div>
              <button
                type="button"
                className="ml-2 hidden shrink-0 text-kumo-inactive hover:text-kumo-danger group-hover:block"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteThread(thread.id);
                }}
              >
                <TrashIcon size={12} />
              </button>
            </div>
          ))}
        </div>

        <div className="border-t border-kumo-line p-3">
          <div className="flex items-center justify-between">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
          </div>
        </div>
      </div>

      {/* Main area */}
      <div className="flex flex-1 flex-col">
        {activeThreadId ? (
          <>
            <header className="flex items-center justify-between border-b border-kumo-line bg-kumo-base px-5 py-3">
              <Text size="sm" bold>
                {threads.find((t) => t.id === activeThreadId)?.name ??
                  activeThreadId}
              </Text>
              <Button
                variant="secondary"
                size="sm"
                icon={<TrashIcon size={14} />}
                onClick={clearHistory}
              >
                Clear
              </Button>
            </header>

            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
                {messages.length === 0 && (
                  <Empty
                    icon={<CodeIcon size={32} />}
                    title="Start coding"
                    description="Send a message to begin."
                  />
                )}

                {messages.map((message) => {
                  const isUser = message.role === "user";
                  return (
                    <div key={message.id} className="space-y-2">
                      {isUser ? (
                        <div className="flex justify-end">
                          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 leading-relaxed text-kumo-inverse">
                            {message.content}
                          </div>
                        </div>
                      ) : (
                        <div className="flex justify-start">
                          <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base px-4 py-2.5 leading-relaxed text-kumo-default">
                            <div className="whitespace-pre-wrap">
                              {message.content}
                            </div>
                          </div>
                        </div>
                      )}
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
                className="mx-auto max-w-3xl px-5 py-4"
              >
                <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
                  <InputArea
                    value={input}
                    onValueChange={setInput}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder="Describe what you want to build..."
                    disabled={!isConnected}
                    rows={2}
                    className="flex-1 bg-transparent! shadow-none! outline-none! ring-0! focus:ring-0!"
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    aria-label="Send message"
                    disabled={!input.trim() || !isConnected}
                    icon={<PaperPlaneRightIcon size={18} />}
                    className="mb-0.5"
                  />
                </div>
              </form>
              <div className="flex justify-center pb-3">
                <PoweredByAgents />
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center">
            <Empty
              icon={<BrainIcon size={40} weight="duotone" />}
              title="Think — Coding Agent"
              description="Create or select a thread to start a conversation."
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
