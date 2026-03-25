/**
 * Chat Rooms — Client
 *
 * Left sidebar: room list with create/delete/clear.
 * Main area: chat for the active room.
 *
 * Data sources:
 *   - Room list: from Agent state sync (useAgent onStateUpdate)
 *   - Chat messages & streaming: useChat with custom AgentChatTransport
 *   - Room CRUD: via agent.call() RPC
 *
 * The AgentChatTransport bridges the AI SDK's useChat hook with the Agent
 * WebSocket connection: sendMessages() triggers the server-side RPC, then
 * pipes WS stream-event messages into a ReadableStream<UIMessageChunk>
 * that useChat consumes and renders.
 */

import {
  Suspense,
  useCallback,
  useState,
  useEffect,
  useRef,
  useMemo
} from "react";
import { useAgent } from "agents/react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage, UIMessageChunk, ChatTransport } from "ai";
import { Button, Badge, InputArea, Empty, Text } from "@cloudflare/kumo";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import {
  PaperPlaneRightIcon,
  PlusIcon,
  ChatCircleIcon,
  BroomIcon,
  HashIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import type { RoomsState, RoomInfo, ChatMessage } from "./server";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Convert server-side ChatMessage[] to UIMessage[] for useChat */
function chatToUIMessages(msgs: ChatMessage[]): UIMessage[] {
  return msgs.map((m) => ({
    id: m.id,
    role: m.role,
    parts: [{ type: "text" as const, text: m.content }]
  }));
}

/** Extract concatenated text from a UIMessage's text parts */
function getMessageText(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

// ─── Custom Transport ─────────────────────────────────────────────────────

/** Minimal interface for the agent socket used by the transport */
interface AgentSocket {
  addEventListener(
    type: "message",
    handler: (event: MessageEvent) => void,
    options?: { signal?: AbortSignal }
  ): void;
  removeEventListener(
    type: "message",
    handler: (event: MessageEvent) => void
  ): void;
  call(method: string, args?: unknown[]): Promise<unknown>;
  send(data: string): void;
}

/**
 * Bridges useChat with the Agent WebSocket connection.
 *
 * Features:
 * - Request ID correlation: each request gets a unique ID, only matching
 *   WS messages are processed
 * - Cancel: sends { type: "cancel", requestId } to stop server-side streaming
 * - Completion guard: close/error/abort are idempotent
 * - Signal-based cleanup: uses AbortController signal on addEventListener
 * - Stream resumption: reconnectToStream sends resume-request, server replays
 *   buffered chunks
 */
class AgentChatTransport implements ChatTransport<UIMessage> {
  #agent: AgentSocket;
  #activeRequestIds = new Set<string>();
  #currentFinish: (() => void) | null = null;

  constructor(agent: AgentSocket) {
    this.#agent = agent;
  }

  /**
   * Silently close the client-side stream without cancelling the server.
   * The server keeps generating; when the user switches back, switchRoom
   * will fetch the completed messages.
   */
  detach() {
    this.#currentFinish?.();
    this.#currentFinish = null;
  }

  async sendMessages({
    messages,
    abortSignal
  }: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const lastMessage = messages[messages.length - 1];
    const text = getMessageText(lastMessage);
    const requestId = crypto.randomUUID().slice(0, 8);

    let completed = false;
    const abortController = new AbortController();
    let streamController!: ReadableStreamDefaultController<UIMessageChunk>;

    // Single cleanup helper — every terminal path goes through here once
    const finish = (action: () => void) => {
      if (completed) return;
      completed = true;
      this.#currentFinish = null;
      try {
        action();
      } catch {
        /* stream may already be closed */
      }
      this.#activeRequestIds.delete(requestId);
      abortController.abort();
    };

    // Expose a detach-friendly finish that closes the stream gracefully
    this.#currentFinish = () => finish(() => streamController.close());

    // Abort handler: notify server, then terminate stream
    const onAbort = () => {
      if (completed) return;
      try {
        this.#agent.send(JSON.stringify({ type: "cancel", requestId }));
      } catch {
        /* ignore send failures */
      }
      finish(() =>
        streamController.error(
          Object.assign(new Error("Aborted"), { name: "AbortError" })
        )
      );
    };

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        onAbort();
      }
    });

    // Listen for stream events filtered by requestId
    this.#agent.addEventListener(
      "message",
      (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.requestId !== requestId) return;
          if (msg.type === "stream-event") {
            const chunk: UIMessageChunk = JSON.parse(msg.event);
            streamController.enqueue(chunk);
          } else if (msg.type === "stream-done") {
            finish(() => streamController.close());
          }
        } catch {
          /* ignore parse errors */
        }
      },
      { signal: abortController.signal }
    );

    // Handle abort from caller
    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
      if (abortSignal.aborted) onAbort();
    }

    // Track this request
    this.#activeRequestIds.add(requestId);

    // Fire-and-forget RPC — response comes via WS events
    this.#agent.call("sendMessage", [text, requestId]).catch((error: Error) => {
      finish(() => streamController.error(error));
    });

    return stream;
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return new Promise<ReadableStream<UIMessageChunk> | null>((resolve) => {
      let resolved = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const done = (value: ReadableStream<UIMessageChunk> | null) => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        this.#agent.removeEventListener("message", handler);
        resolve(value);
      };

      const handler = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "stream-resuming") {
            done(this.#createResumeStream(msg.requestId));
          }
        } catch {
          /* ignore */
        }
      };

      this.#agent.addEventListener("message", handler);

      try {
        this.#agent.send(JSON.stringify({ type: "resume-request" }));
      } catch {
        /* WebSocket may not be open yet */
      }

      // Short timeout: server responds immediately if there's an active stream
      timeout = setTimeout(() => done(null), 500);
    });
  }

  /** Create a ReadableStream that receives resumed stream chunks. */
  #createResumeStream(requestId: string): ReadableStream<UIMessageChunk> {
    const abortController = new AbortController();
    let completed = false;

    const finish = (action: () => void) => {
      if (completed) return;
      completed = true;
      try {
        action();
      } catch {
        /* stream may already be closed */
      }
      this.#activeRequestIds.delete(requestId);
      abortController.abort();
    };

    this.#activeRequestIds.add(requestId);

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        this.#agent.addEventListener(
          "message",
          (event: MessageEvent) => {
            if (typeof event.data !== "string") return;
            try {
              const msg = JSON.parse(event.data);
              if (msg.requestId !== requestId) return;
              if (msg.type === "stream-event") {
                const chunk: UIMessageChunk = JSON.parse(msg.event);
                controller.enqueue(chunk);
              } else if (msg.type === "stream-done") {
                finish(() => controller.close());
              }
            } catch {
              /* ignore */
            }
          },
          { signal: abortController.signal }
        );
      },
      cancel() {
        finish(() => {});
      }
    });
  }
}

// ─── Room Sidebar ──────────────────────────────────────────────────────────

function RoomSidebar({
  rooms,
  activeRoomId,
  onSwitch,
  onCreate,
  onDelete,
  onClear
}: {
  rooms: RoomInfo[];
  activeRoomId: string | null;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onClear: (id: string) => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-kumo-line flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ChatCircleIcon size={18} className="text-kumo-brand" />
          <Text size="sm" bold>
            Rooms
          </Text>
          <Badge variant="secondary">{rooms.length}</Badge>
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<PlusIcon size={14} />}
          onClick={onCreate}
        >
          New
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {rooms.length === 0 && (
          <div className="px-2 py-8 text-center">
            <Text size="xs" variant="secondary">
              No rooms yet. Create one to start chatting.
            </Text>
          </div>
        )}

        {rooms.map((room) => {
          const isActive = room.id === activeRoomId;
          return (
            <div
              key={room.id}
              // oxlint-disable-next-line prefer-tag-over-role
              role="button"
              tabIndex={0}
              className={`group rounded-lg px-3 py-2 cursor-pointer transition-colors w-full text-left ${
                isActive
                  ? "bg-kumo-tint ring-1 ring-kumo-ring"
                  : "hover:bg-kumo-tint/50"
              }`}
              onClick={() => onSwitch(room.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSwitch(room.id);
                }
              }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <HashIcon
                    size={14}
                    className={
                      isActive ? "text-kumo-brand" : "text-kumo-inactive"
                    }
                  />
                  <Text size="sm" bold>
                    {room.name}
                  </Text>
                </div>
                {room.messageCount > 0 && (
                  <Badge variant="secondary">{room.messageCount}</Badge>
                )}
              </div>

              <div
                className={`flex items-center gap-1 mt-1.5 ${
                  isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                } transition-opacity`}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClear(room.id);
                  }}
                >
                  Clear
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(room.id);
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Messages ──────────────────────────────────────────────────────────────

function Messages({
  messages,
  status
}: {
  messages: UIMessage[];
  status: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const isBusy = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isBusy]);

  if (messages.length === 0 && !isBusy) {
    return (
      <Empty
        icon={<ChatCircleIcon size={32} />}
        title="Empty room"
        description="Type a message below to start the conversation"
      />
    );
  }

  return (
    <div className="space-y-4">
      {messages.map((msg) => (
        <div key={msg.id}>
          {msg.role === "user" ? (
            <div className="flex justify-end">
              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                {getMessageText(msg)}
              </div>
            </div>
          ) : (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed overflow-hidden">
                {msg.parts.map((part, i) => {
                  if (part.type === "reasoning") {
                    return (
                      <details
                        key={i}
                        className="px-4 py-2 border-b border-kumo-line"
                        open={"state" in part && part.state === "streaming"}
                      >
                        <summary className="cursor-pointer text-xs text-kumo-inactive select-none">
                          Reasoning
                        </summary>
                        <div className="mt-1 text-xs text-kumo-secondary italic whitespace-pre-wrap">
                          {part.text}
                        </div>
                      </details>
                    );
                  }
                  if ("toolName" in part && "toolCallId" in part) {
                    const tp = part as unknown as {
                      toolName: string;
                      toolCallId: string;
                      state: string;
                      input: unknown;
                      output?: unknown;
                    };
                    return (
                      <div
                        key={i}
                        className="px-4 py-2.5 border-b border-kumo-line"
                      >
                        <div className="flex items-center gap-2">
                          <Text size="xs" bold>
                            {tp.toolName}
                          </Text>
                          <Badge variant="secondary">{tp.state}</Badge>
                        </div>
                        {tp.input != null &&
                          Object.keys(tp.input as Record<string, unknown>)
                            .length > 0 && (
                            <pre className="mt-1 text-xs text-kumo-secondary overflow-auto">
                              {JSON.stringify(tp.input, null, 2)}
                            </pre>
                          )}
                        {tp.state === "output-available" &&
                          tp.output != null && (
                            <pre className="mt-1 text-xs text-kumo-brand overflow-auto">
                              {JSON.stringify(tp.output, null, 2)}
                            </pre>
                          )}
                      </div>
                    );
                  }
                  if (part.type === "text") {
                    return (
                      <Streamdown
                        key={i}
                        className="sd-theme px-4 py-2.5"
                        plugins={{ code }}
                        controls={false}
                        isAnimating={
                          "state" in part && part.state === "streaming"
                        }
                      >
                        {part.text}
                      </Streamdown>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          )}
        </div>
      ))}

      {status === "submitted" && (
        <div className="flex justify-start">
          <div className="px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-kumo-brand rounded-full animate-pulse" />
              <Text size="xs" variant="secondary">
                Thinking...
              </Text>
            </div>
          </div>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [input, setInput] = useState("");

  // Ref bridges useAgent's onMessage → useChat's setMessages
  // (useChat is declared after useAgent, so we use a ref to avoid ordering issues)
  const setChatMessagesRef = useRef<((messages: UIMessage[]) => void) | null>(
    null
  );

  const handleServerMessage = useCallback((event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "messages") {
        setActiveRoomId(msg.roomId);
        setChatMessagesRef.current?.(chatToUIMessages(msg.messages));
      }
      // stream-start, stream-event, stream-done are handled by the transport
    } catch {
      /* ignore parse errors */
    }
  }, []);

  const agent = useAgent<RoomsState>({
    agent: "OverseerAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback(
      (state: RoomsState) => setRooms(state.rooms),
      []
    ),
    onMessage: handleServerMessage
  });

  const transport = useMemo(() => new AgentChatTransport(agent), [agent]);

  const {
    messages,
    setMessages: setChatMessages,
    sendMessage,
    resumeStream,
    status
  } = useChat({ transport });

  // Keep the ref in sync so onMessage can call setChatMessages
  setChatMessagesRef.current = setChatMessages;

  const isConnected = connectionStatus === "connected";
  const isBusy = status === "submitted" || status === "streaming";

  const handleCreate = useCallback(async () => {
    const name = `Room ${(rooms.length ?? 0) + 1}`;
    await agent.call("createRoom", [name]);
  }, [agent, rooms]);

  const handleDelete = useCallback(
    async (id: string) => {
      transport.detach();
      await agent.call("deleteRoom", [id]);
      if (activeRoomId === id) {
        setActiveRoomId(null);
        setChatMessages([]);
      }
    },
    [agent, activeRoomId, setChatMessages, transport]
  );

  const handleClear = useCallback(
    async (id: string) => agent.call("clearRoom", [id]),
    [agent]
  );

  const handleSwitch = useCallback(
    async (id: string) => {
      transport.detach();
      await agent.call("switchRoom", [id]);
      // If the target room has an active stream, resume it.
      // The server filters by the connection's active room.
      resumeStream();
    },
    [agent, transport, resumeStream]
  );

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isBusy || !activeRoomId) return;
    setInput("");
    sendMessage({ text });
  }, [input, isBusy, activeRoomId, sendMessage]);

  const activeRoom = rooms.find((r) => r.id === activeRoomId);

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* Left: Room sidebar */}
      <div className="w-[260px] bg-kumo-base border-r border-kumo-line shrink-0">
        <RoomSidebar
          rooms={rooms}
          activeRoomId={activeRoomId}
          onSwitch={handleSwitch}
          onCreate={handleCreate}
          onDelete={handleDelete}
          onClear={handleClear}
        />
      </div>

      {/* Main: Chat */}
      <div className="flex flex-col flex-1 min-w-0">
        <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {activeRoom ? (
                <>
                  <HashIcon size={20} className="text-kumo-brand" />
                  <Text size="lg" bold>
                    {activeRoom.name}
                  </Text>
                  <Badge variant="secondary">
                    {activeRoom.messageCount} messages
                  </Badge>
                </>
              ) : (
                <Text size="lg" bold variant="secondary">
                  No room selected
                </Text>
              )}
            </div>
            <div className="flex items-center gap-3">
              <ConnectionIndicator status={connectionStatus} />
              <ModeToggle />
              {activeRoom && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<BroomIcon size={14} />}
                  onClick={() => handleClear(activeRoom.id)}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-6">
            {activeRoomId ? (
              <Messages messages={messages} status={status} />
            ) : (
              <Empty
                icon={<ChatCircleIcon size={32} />}
                title="Create a room to start"
                description='Click "New" in the sidebar to create your first chat room'
              />
            )}
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
                  activeRoomId ? "Type a message..." : "Create a room first..."
                }
                disabled={!isConnected || isBusy || !activeRoomId}
                rows={2}
                className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
              />
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={
                  !input.trim() || !isConnected || isBusy || !activeRoomId
                }
                icon={<PaperPlaneRightIcon size={18} />}
                loading={isBusy}
                className="mb-0.5"
              />
            </div>
          </form>
          <div className="flex justify-center pb-3">
            <PoweredByAgents />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AppRoot() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <App />
    </Suspense>
  );
}
