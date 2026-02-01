import { Agent, callable, getAgentByName } from "agents";
import type { RoomAgent } from "./room-agent";

export interface RoomInfo {
  roomId: string;
  memberCount: number;
  createdAt: string;
}

export interface LobbyState {
  rooms: Record<string, RoomInfo>;
}

export class LobbyAgent extends Agent<Env, LobbyState> {
  initialState: LobbyState = {
    rooms: {}
  };

  @callable({ description: "Create a new room" })
  async createRoom(roomId: string): Promise<RoomInfo> {
    // Initialize the room agent
    const room = await getAgentByName<Env, RoomAgent>(
      this.env.RoomAgent,
      roomId
    );
    await room.initRoom(roomId);

    // Track the room
    const roomInfo: RoomInfo = {
      roomId,
      memberCount: 0,
      createdAt: new Date().toISOString()
    };

    this.setState({
      rooms: {
        ...this.state.rooms,
        [roomId]: roomInfo
      }
    });

    // Broadcast room list update
    this.broadcast(
      JSON.stringify({
        type: "room_created",
        room: roomInfo
      })
    );

    return roomInfo;
  }

  @callable({ description: "List all rooms" })
  listRooms(): RoomInfo[] {
    return Object.values(this.state.rooms);
  }

  @callable({ description: "Get a specific room's info" })
  getRoom(roomId: string): RoomInfo | null {
    return this.state.rooms[roomId] || null;
  }

  // Called by RoomAgent when member count changes (DO RPC, not @callable for external clients)
  updateRoomCount(roomId: string, memberCount: number): void {
    if (this.state.rooms[roomId]) {
      const updatedRoom = {
        ...this.state.rooms[roomId],
        memberCount
      };

      this.setState({
        rooms: {
          ...this.state.rooms,
          [roomId]: updatedRoom
        }
      });

      // Broadcast room update
      this.broadcast(
        JSON.stringify({
          type: "room_updated",
          room: updatedRoom
        })
      );
    }
  }

  @callable({ description: "Delete a room" })
  deleteRoom(roomId: string): boolean {
    if (this.state.rooms[roomId]) {
      const { [roomId]: _, ...remainingRooms } = this.state.rooms;
      this.setState({ rooms: remainingRooms });

      // Broadcast room deletion
      this.broadcast(
        JSON.stringify({
          type: "room_deleted",
          roomId
        })
      );

      return true;
    }
    return false;
  }

  @callable({ description: "Get total users across all rooms" })
  getTotalUsers(): number {
    return Object.values(this.state.rooms).reduce(
      (sum, room) => sum + room.memberCount,
      0
    );
  }
}
