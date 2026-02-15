/**
 * Chat Rooms — Client
 *
 * Left sidebar: room list with create/delete/clear.
 * Main area: chat for the active room.
 *
 * Everything is driven by the Agent's state — rooms, messages, thinking
 * indicator. The client calls agent.call() for all actions.
 */

import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
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
import type { RoomsState, RoomInfo, ChatMessage } from "./server";

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
            <button
              key={room.id}
              type="button"
              className={`group rounded-lg px-3 py-2 cursor-pointer transition-colors w-full text-left ${
                isActive
                  ? "bg-kumo-tint ring-1 ring-kumo-ring"
                  : "hover:bg-kumo-tint/50"
              }`}
              onClick={() => onSwitch(room.id)}
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
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Messages ──────────────────────────────────────────────────────────────

function Messages({
  messages,
  isThinking,
  streamingText
}: {
  messages: ChatMessage[];
  isThinking: boolean;
  streamingText: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isThinking, streamingText]);

  if (messages.length === 0 && !isThinking && !streamingText) {
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
                {msg.content}
              </div>
            </div>
          ) : (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed overflow-hidden">
                <Streamdown className="sd-theme px-4 py-2.5" controls={false}>
                  {msg.content}
                </Streamdown>
              </div>
            </div>
          )}
        </div>
      ))}

      {isThinking && !streamingText && (
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

      {streamingText && (
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed overflow-hidden">
            <Streamdown
              className="sd-theme px-4 py-2.5"
              controls={false}
              isAnimating={true}
            >
              {streamingText}
            </Streamdown>
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
  const [roomsState, setRoomsState] = useState<RoomsState | null>(null);
  const [input, setInput] = useState("");

  const agent = useAgent<RoomsState>({
    agent: "OverseerAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback((state: RoomsState) => setRoomsState(state), [])
  });

  const isConnected = connectionStatus === "connected";
  const isThinking = roomsState?.isThinking ?? false;

  const handleCreate = useCallback(async () => {
    const name = `Room ${(roomsState?.rooms.length ?? 0) + 1}`;
    await agent.call("createRoom", [name]);
  }, [agent, roomsState]);

  const handleDelete = useCallback(
    async (id: string) => agent.call("deleteRoom", [id]),
    [agent]
  );

  const handleClear = useCallback(
    async (id: string) => agent.call("clearRoom", [id]),
    [agent]
  );

  const handleSwitch = useCallback(
    async (id: string) => agent.call("switchRoom", [id]),
    [agent]
  );

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isThinking || !roomsState?.activeRoomId) return;
    setInput("");
    agent.call("sendMessage", [text]);
  }, [input, isThinking, roomsState, agent]);

  const activeRoom = roomsState?.rooms.find(
    (r) => r.id === roomsState.activeRoomId
  );

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* Left: Room sidebar */}
      <div className="w-[260px] bg-kumo-base border-r border-kumo-line shrink-0">
        {roomsState ? (
          <RoomSidebar
            rooms={roomsState.rooms}
            activeRoomId={roomsState.activeRoomId}
            onSwitch={handleSwitch}
            onCreate={handleCreate}
            onDelete={handleDelete}
            onClear={handleClear}
          />
        ) : (
          <div className="flex items-center justify-center h-32">
            <Text variant="secondary">Connecting...</Text>
          </div>
        )}
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
            {roomsState?.activeRoomId ? (
              <Messages
                messages={roomsState.activeRoomMessages}
                isThinking={isThinking}
                streamingText={roomsState.streamingText}
              />
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
                  roomsState?.activeRoomId
                    ? "Type a message..."
                    : "Create a room first..."
                }
                disabled={
                  !isConnected || isThinking || !roomsState?.activeRoomId
                }
                rows={2}
                className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
              />
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={
                  !input.trim() ||
                  !isConnected ||
                  isThinking ||
                  !roomsState?.activeRoomId
                }
                icon={<PaperPlaneRightIcon size={18} />}
                loading={isThinking}
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
