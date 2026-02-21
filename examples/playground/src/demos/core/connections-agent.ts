import { callable, type Connection, type ConnectionContext } from "agents";
import { PlaygroundAgent as Agent } from "../../shared/playground-agent";

export interface ConnectionsAgentState {
  messages: Array<{ message: string; timestamp: number }>;
}

export class ConnectionsAgent extends Agent<Env, ConnectionsAgentState> {
  initialState: ConnectionsAgentState = {
    messages: []
  };

  onConnect(connection: Connection, ctx: ConnectionContext) {
    super.onConnect(connection, ctx);
    this.broadcast(
      JSON.stringify({
        type: "connection_count",
        count: [...this.getConnections()].length
      })
    );
    console.log(`Client connected: ${connection.id}`);
  }

  onClose(connection: Connection) {
    super.onClose(connection);
    this.broadcast(
      JSON.stringify({
        type: "connection_count",
        count: [...this.getConnections()].length
      })
    );
    console.log(`Client disconnected: ${connection.id}`);
  }

  @callable({ description: "Get connection count" })
  getConnectionCount(): number {
    return [...this.getConnections()].length;
  }

  @callable({ description: "Broadcast a message to all clients" })
  broadcastMessage(message: string): void {
    const newMessage = { message, timestamp: Date.now() };
    this.setState({
      ...this.state,
      messages: [...this.state.messages.slice(-9), newMessage]
    });
    this.broadcast(
      JSON.stringify({
        type: "broadcast",
        ...newMessage
      })
    );
  }
}
