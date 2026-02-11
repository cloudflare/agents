import {
  Agent,
  callable,
  getCurrentAgent,
  type Connection
} from "../../index.ts";
import type { ConnectionContext } from "../../index.ts";

/**
 * Test Agent for the shouldSendProtocolMessages / isConnectionProtocolEnabled feature.
 *
 * Connections with `?protocol=false` in the query string will not receive
 * protocol text frames (identity, state sync, MCP servers).
 */
export class TestProtocolMessagesAgent extends Agent<
  Record<string, unknown>,
  { count: number }
> {
  initialState = { count: 0 };
  static options = { hibernate: true };

  shouldSendProtocolMessages(
    _connection: Connection,
    ctx: ConnectionContext
  ): boolean {
    const url = new URL(ctx.request.url);
    return url.searchParams.get("protocol") !== "false";
  }

  @callable()
  async incrementCount() {
    this.setState({ count: this.state.count + 1 });
    return this.state.count;
  }

  @callable()
  async getState() {
    return this.state;
  }

  /** Returns the calling connection's ID. */
  @callable()
  async getMyConnectionId() {
    const { connection } = getCurrentAgent();
    return connection ? connection.id : null;
  }

  /** Check protocol status of a connection by ID. */
  @callable()
  async checkProtocolEnabled(connectionId: string) {
    const conn = Array.from(this.getConnections()).find(
      (c) => c.id === connectionId
    );
    return conn ? this.isConnectionProtocolEnabled(conn) : null;
  }
}
