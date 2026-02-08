import { useAgent } from "agents/react";
import { nanoid } from "nanoid";
import { useState, useEffect, useRef } from "react";
import { Button, Input, Surface, Empty, Badge, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs } from "../../hooks";
import type { LobbyAgent, LobbyState, RoomInfo } from "./lobby-agent";
import type { RoomAgent, RoomState, ChatMessage } from "./room-agent";

export function ChatRoomsDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [username, setUsername] = useState(() => `user-${nanoid(4)}`);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [currentRoom, setCurrentRoom] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const lobby = useAgent<LobbyAgent, LobbyState>({
    agent: "lobby-agent",
    name: "main",
    onOpen: () => {
      addLog("info", "lobby_connected");
      refreshRooms();
    },
    onClose: () => addLog("info", "lobby_disconnected"),
    onError: () => addLog("error", "error", "Lobby connection error"),
    onMessage: (message) => {
      try {
        const data = JSON.parse(message.data as string);
        if (
          data.type === "room_created" ||
          data.type === "room_updated" ||
          data.type === "room_deleted"
        ) {
          refreshRooms();
        }
      } catch {
        // ignore
      }
    }
  });

  const room = useAgent<RoomAgent, RoomState>({
    agent: "room-agent",
    name: currentRoom || "unused",
    enabled: !!currentRoom,
    onOpen: async () => {
      if (currentRoom) {
        addLog("info", "room_connected", currentRoom);
        await joinRoom();
      }
    },
    onClose: () => {
      if (currentRoom) {
        addLog("info", "room_disconnected");
      }
    },
    onError: () => addLog("error", "error", "Room connection error"),
    onMessage: (message) => {
      try {
        const data = JSON.parse(message.data as string);
        handleRoomEvent(data);
      } catch {
        // ignore
      }
    }
  });

  const handleRoomEvent = (data: {
    type: string;
    userId?: string;
    message?: ChatMessage;
    memberCount?: number;
  }) => {
    if (data.type === "member_joined") {
      addLog("in", "member_joined", data.userId);
      refreshMembers();
    } else if (data.type === "member_left") {
      addLog("in", "member_left", data.userId);
      refreshMembers();
    } else if (data.type === "chat_message" && data.message) {
      addLog("in", "chat_message", data.message);
      setMessages((prev) => [...prev, data.message as ChatMessage]);
    }
  };

  const refreshRooms = async () => {
    try {
      const result = await lobby.call("listRooms");
      setRooms(result);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const refreshMembers = async () => {
    if (!currentRoom) return;
    try {
      const result = await room.call("getMembers");
      setMembers(result);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const joinRoom = async () => {
    try {
      await room.call("join", [username]);
      const msgs = await room.call("getMessages", [50]);
      setMessages(msgs);
      await refreshMembers();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleCreateRoom = async () => {
    const roomId = newRoomName.trim() || `room-${nanoid(4)}`;
    addLog("out", "call", `createRoom("${roomId}")`);
    try {
      await lobby.call("createRoom", [roomId]);
      setNewRoomName("");
      await refreshRooms();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleJoinRoom = async (roomId: string) => {
    if (currentRoom) {
      try {
        await room.call("leave", [username]);
      } catch {
        // ignore
      }
    }
    setCurrentRoom(roomId);
    setMessages([]);
    setMembers([]);
    addLog("out", "join_room", roomId);
  };

  const handleLeaveRoom = async () => {
    if (currentRoom) {
      try {
        await room.call("leave", [username]);
      } catch {
        // ignore
      }
      setCurrentRoom(null);
      setMessages([]);
      setMembers([]);
      addLog("out", "leave_room");
    }
  };

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !currentRoom) return;
    addLog("out", "send", newMessage);
    try {
      await room.call("sendMessage", [username, newMessage]);
      setNewMessage("");
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (lobby.readyState === WebSocket.OPEN) {
      refreshRooms();
    }
  }, [lobby.readyState]);

  return (
    <DemoWrapper
      title="Chat Rooms"
      description="Multi-agent chat with a Lobby managing multiple Room agents. Users can create and join rooms."
      statusIndicator={
        <ConnectionStatus
          status={
            lobby.readyState === WebSocket.OPEN ? "connected" : "connecting"
          }
        />
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Lobby & Room List */}
        <div className="space-y-6">
          {/* Username */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <Input
              label="Your Username"
              type="text"
              value={username}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setUsername(e.target.value)
              }
              className="w-full"
              placeholder="Enter username"
            />
          </Surface>

          {/* Lobby Connection */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            {/* Create Room */}
            <div className="flex gap-2 mb-4">
              <Input
                aria-label="Room name"
                type="text"
                value={newRoomName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setNewRoomName(e.target.value)
                }
                className="flex-1"
                placeholder="Room name (optional)"
              />
              <Button variant="primary" onClick={handleCreateRoom}>
                Create
              </Button>
            </div>

            {/* Room List */}
            <div className="space-y-2">
              {rooms.length > 0 ? (
                rooms.map((r) => (
                  <button
                    key={r.roomId}
                    type="button"
                    onClick={() => handleJoinRoom(r.roomId)}
                    className={`w-full text-left px-3 py-2 rounded border transition-colors ${
                      currentRoom === r.roomId
                        ? "border-kumo-brand bg-kumo-elevated"
                        : "border-kumo-line hover:border-kumo-interact"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-kumo-default">
                        {r.roomId}
                      </span>
                      <span className="text-xs text-kumo-subtle">
                        {r.memberCount} online
                      </span>
                    </div>
                  </button>
                ))
              ) : (
                <Empty title="No rooms yet. Create one!" size="sm" />
              )}
            </div>
          </Surface>

          {/* How it Works */}
          <Surface className="p-4 rounded-lg bg-kumo-elevated">
            <div className="mb-2">
              <Text variant="heading3">How it Works</Text>
            </div>
            <ul className="text-sm text-kumo-subtle space-y-1">
              <li>
                •{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  LobbyAgent
                </code>{" "}
                tracks all rooms
              </li>
              <li>
                • Each room is a{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  RoomAgent
                </code>{" "}
                instance
              </li>
              <li>• Rooms notify Lobby of member changes</li>
              <li>• Messages are broadcast to room members</li>
            </ul>
          </Surface>
        </div>

        {/* Chat Area */}
        <div className="lg:col-span-1 space-y-6">
          <Surface className="p-4 h-[500px] flex flex-col rounded-lg ring ring-kumo-line">
            {currentRoom ? (
              <>
                {/* Room Header */}
                <div className="flex items-center justify-between mb-4 pb-3 border-b border-kumo-line">
                  <div>
                    <Text variant="heading3">{currentRoom}</Text>
                    <span className="text-xs text-kumo-subtle">
                      {members.length} members
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleLeaveRoom}
                  >
                    Leave
                  </Button>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto space-y-2 mb-4">
                  {messages.length > 0 ? (
                    messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`p-2 rounded ${
                          msg.userId === username
                            ? "bg-kumo-contrast text-kumo-inverse ml-8"
                            : "bg-kumo-control text-kumo-default mr-8"
                        }`}
                      >
                        <div className="text-xs opacity-70 mb-1">
                          {msg.userId}
                        </div>
                        <div className="text-sm">{msg.text}</div>
                      </div>
                    ))
                  ) : (
                    <Empty title="No messages yet" size="sm" />
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <div className="flex gap-2">
                  <Input
                    aria-label="Chat message"
                    type="text"
                    value={newMessage}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setNewMessage(e.target.value)
                    }
                    onKeyDown={(e: React.KeyboardEvent) =>
                      e.key === "Enter" && handleSendMessage()
                    }
                    className="flex-1"
                    placeholder="Type a message..."
                  />
                  <Button variant="primary" onClick={handleSendMessage}>
                    Send
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-kumo-inactive">
                Select a room to start chatting
              </div>
            )}
          </Surface>

          {/* Members */}
          {currentRoom && members.length > 0 && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-2">
                <Text variant="heading3">Members</Text>
              </div>
              <div className="flex flex-wrap gap-2">
                {members.map((member) => (
                  <Badge
                    key={member}
                    variant={member === username ? "primary" : "outline"}
                  >
                    {member}
                  </Badge>
                ))}
              </div>
            </Surface>
          )}
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="600px" />
        </div>
      </div>
    </DemoWrapper>
  );
}
