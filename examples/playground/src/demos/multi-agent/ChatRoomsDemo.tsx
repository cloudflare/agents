import { useAgent } from "agents/react";
import { nanoid } from "nanoid";
import { useState, useEffect, useRef } from "react";
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

  // Lobby connection for room list
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

  // Room connection (only when in a room)
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
      // Leave current room first
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

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Refresh rooms on lobby connect
  useEffect(() => {
    if (lobby.readyState === WebSocket.OPEN) {
      refreshRooms();
    }
  }, [lobby.readyState]);

  return (
    <DemoWrapper
      title="Chat Rooms"
      description="Multi-agent chat with a Lobby managing multiple Room agents. Users can create and join rooms."
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Lobby & Room List */}
        <div className="space-y-6">
          {/* Username */}
          <div className="card p-4">
            <label
              htmlFor="username-input"
              className="text-xs text-neutral-500 dark:text-neutral-400 block mb-1"
            >
              Your Username
            </label>
            <input
              id="username-input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="input w-full"
              placeholder="Enter username"
            />
          </div>

          {/* Lobby Connection */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Lobby</h3>
              <ConnectionStatus
                status={
                  lobby.readyState === WebSocket.OPEN
                    ? "connected"
                    : "connecting"
                }
              />
            </div>

            {/* Create Room */}
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
                className="input flex-1"
                placeholder="Room name (optional)"
              />
              <button
                type="button"
                onClick={handleCreateRoom}
                className="btn btn-primary"
              >
                Create
              </button>
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
                        ? "border-black dark:border-white bg-neutral-100 dark:bg-neutral-800"
                        : "border-neutral-200 dark:border-neutral-700 hover:border-neutral-400 dark:hover:border-neutral-500"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{r.roomId}</span>
                      <span className="text-xs text-neutral-500 dark:text-neutral-400">
                        {r.memberCount} online
                      </span>
                    </div>
                  </button>
                ))
              ) : (
                <p className="text-sm text-neutral-400 text-center py-4">
                  No rooms yet. Create one!
                </p>
              )}
            </div>
          </div>

          {/* How it Works */}
          <div className="card p-4 bg-neutral-50 dark:bg-neutral-800">
            <h3 className="font-semibold mb-2">How it Works</h3>
            <ul className="text-sm text-neutral-600 dark:text-neutral-300 space-y-1">
              <li>
                •{" "}
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
                  LobbyAgent
                </code>{" "}
                tracks all rooms
              </li>
              <li>
                • Each room is a{" "}
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
                  RoomAgent
                </code>{" "}
                instance
              </li>
              <li>• Rooms notify Lobby of member changes</li>
              <li>• Messages are broadcast to room members</li>
            </ul>
          </div>
        </div>

        {/* Chat Area */}
        <div className="lg:col-span-1 space-y-6">
          <div className="card p-4 h-[500px] flex flex-col">
            {currentRoom ? (
              <>
                {/* Room Header */}
                <div className="flex items-center justify-between mb-4 pb-3 border-b border-neutral-200 dark:border-neutral-700">
                  <div>
                    <h3 className="font-semibold">{currentRoom}</h3>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      {members.length} members
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleLeaveRoom}
                    className="btn btn-secondary text-sm"
                  >
                    Leave
                  </button>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto space-y-2 mb-4">
                  {messages.length > 0 ? (
                    messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`p-2 rounded ${
                          msg.userId === username
                            ? "bg-black dark:bg-white text-white dark:text-black ml-8"
                            : "bg-neutral-100 dark:bg-neutral-800 mr-8"
                        }`}
                      >
                        <div className="text-xs opacity-70 mb-1">
                          {msg.userId}
                        </div>
                        <div className="text-sm">{msg.text}</div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-neutral-400 text-center py-8">
                      No messages yet
                    </p>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
                    className="input flex-1"
                    placeholder="Type a message..."
                  />
                  <button
                    type="button"
                    onClick={handleSendMessage}
                    className="btn btn-primary"
                  >
                    Send
                  </button>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-neutral-400">
                Select a room to start chatting
              </div>
            )}
          </div>

          {/* Members */}
          {currentRoom && members.length > 0 && (
            <div className="card p-4">
              <h3 className="font-semibold mb-2">Members</h3>
              <div className="flex flex-wrap gap-2">
                {members.map((member) => (
                  <span
                    key={member}
                    className={`text-xs px-2 py-1 rounded ${
                      member === username
                        ? "bg-black dark:bg-white text-white dark:text-black"
                        : "bg-neutral-100 dark:bg-neutral-800"
                    }`}
                  >
                    {member}
                  </span>
                ))}
              </div>
            </div>
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
