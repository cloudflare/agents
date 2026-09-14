import { Agent } from "agents";
import type { Connection, WSMessage } from "agents";
import { Think } from "../../think";

/** Routes real WebSocket connections to a Think sub-agent. */
export class ConnectionStateParent extends Agent {}

/** Reports connection state through the application's public hooks. */
export class ConnectionStateThink extends Think {
  /** Set application state after Think's initial connection frames. */
  override onConnect(connection: Connection): void {
    connection.setState({ userId: "user-123" });
    connection.send(
      JSON.stringify({
        type: "connected",
        connectionId: connection.id,
        state: connection.state
      })
    );
  }

  /** Echo the state observed while handling the actual client message. */
  override onMessage(connection: Connection, message: WSMessage): void {
    connection.send(
      JSON.stringify({
        type: "message",
        connectionId: connection.id,
        message,
        state: connection.state
      })
    );
  }
}
