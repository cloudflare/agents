import {
  callable,
  getAgentByName,
  type Connection,
  type ConnectionContext
} from "agents";
import { PlaygroundAgent as Agent } from "../../shared/playground-agent";
import type { LobbyAgent } from "./lobby-agent";

export interface RoomMember {
  userId: string;
  joinedAt: string;
}

export interface ChatMessage {
  id: string;
  userId: string;
  text: string;
  timestamp: string;
}

export interface RoomState {
  roomId: string;
  members: Record<string, RoomMember>;
  messages: ChatMessage[];
  createdAt: string;
}

export class RoomAgent extends Agent<Env, RoomState> {
  initialState: RoomState = {
    roomId: "",
    members: {},
    messages: [],
    createdAt: ""
  };

  // Track WebSocket connections to user IDs
  private connectionToUser: Map<string, string> = new Map();

  onConnect(connection: Connection, ctx: ConnectionContext) {
    super.onConnect(connection, ctx);
    console.log(`Connection to room: ${connection.id}`);
  }

  onClose(connection: Connection) {
    super.onClose(connection);
    // Auto-leave when connection closes
    const odesc = this.connectionToUser.get(connection.id);
    if (odesc) {
      this.leaveInternal(odesc);
      this.connectionToUser.delete(connection.id);
    }
  }

  @callable({ description: "Initialize the room" })
  async initRoom(roomId: string): Promise<RoomState> {
    if (!this.state.roomId) {
      this.setState({
        ...this.state,
        roomId,
        createdAt: new Date().toISOString()
      });
    }
    return this.state;
  }

  @callable({ description: "Join the room" })
  async join(userId: string): Promise<RoomState> {
    if (!this.state.members[userId]) {
      const newMembers = {
        ...this.state.members,
        [userId]: {
          userId,
          joinedAt: new Date().toISOString()
        }
      };
      this.setState({ ...this.state, members: newMembers });

      // Notify lobby of member count change
      await this.notifyLobby();

      // Broadcast join event
      this.broadcast(
        JSON.stringify({
          type: "member_joined",
          userId,
          memberCount: Object.keys(newMembers).length
        })
      );
    }
    return this.state;
  }

  @callable({ description: "Leave the room" })
  async leave(userId: string): Promise<RoomState> {
    return this.leaveInternal(userId);
  }

  private async leaveInternal(userId: string): Promise<RoomState> {
    if (this.state.members[userId]) {
      const { [userId]: _, ...remainingMembers } = this.state.members;
      this.setState({ ...this.state, members: remainingMembers });

      // Notify lobby of member count change
      await this.notifyLobby();

      // Broadcast leave event
      this.broadcast(
        JSON.stringify({
          type: "member_left",
          userId,
          memberCount: Object.keys(remainingMembers).length
        })
      );
    }
    return this.state;
  }

  @callable({ description: "Send a message to the room" })
  sendMessage(userId: string, text: string): ChatMessage {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      userId,
      text,
      timestamp: new Date().toISOString()
    };

    // Keep last 100 messages
    const messages = [...this.state.messages, message].slice(-100);
    this.setState({ ...this.state, messages });

    // Broadcast the message
    this.broadcast(
      JSON.stringify({
        type: "chat_message",
        message
      })
    );

    return message;
  }

  @callable({ description: "Get room members" })
  getMembers(): string[] {
    return Object.keys(this.state.members);
  }

  @callable({ description: "Get recent messages" })
  getMessages(limit = 50): ChatMessage[] {
    return this.state.messages.slice(-limit);
  }

  @callable({ description: "Get member count" })
  getMemberCount(): number {
    return Object.keys(this.state.members).length;
  }

  private async notifyLobby() {
    try {
      const lobby = await getAgentByName<Env, LobbyAgent>(
        this.env.LobbyAgent,
        "main"
      );
      await lobby.updateRoomCount(
        this.state.roomId,
        Object.keys(this.state.members).length
      );
    } catch (e) {
      console.error("Failed to notify lobby:", e);
    }
  }
}
