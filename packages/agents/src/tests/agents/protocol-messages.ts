import {
  Agent,
  callable,
  getCurrentAgent,
  type Connection
} from "../../index.ts";
import type { ConnectionContext } from "../../index.ts";

/**
 * Test Agent for the shouldSendProtocolMessages / isConnectionProtocolEnabled
 * feature.
 *
 * Connections with `?protocol=false` in the query string will not receive
 * protocol text frames (identity, state sync, MCP servers).
 * Connections with `?readonly=true` are also marked readonly.
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

  shouldConnectionBeReadonly(
    _connection: Connection,
    ctx: ConnectionContext
  ): boolean {
    const url = new URL(ctx.request.url);
    return url.searchParams.get("readonly") === "true";
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

  @callable()
  async getMyConnectionId() {
    const { connection } = getCurrentAgent();
    return connection ? connection.id : null;
  }

  @callable()
  async checkProtocolEnabled(connectionId: string) {
    const conn = Array.from(this.getConnections()).find(
      (c) => c.id === connectionId
    );
    return conn ? this.isConnectionProtocolEnabled(conn) : null;
  }

  @callable()
  async checkReadonly(connectionId: string) {
    const conn = Array.from(this.getConnections()).find(
      (c) => c.id === connectionId
    );
    return conn ? this.isConnectionReadonly(conn) : null;
  }

  /** Returns connection.state (user-visible) for the given connection. */
  @callable()
  async getConnectionUserState(connectionId: string) {
    const conn = Array.from(this.getConnections()).find(
      (c) => c.id === connectionId
    );
    if (!conn) return null;
    return {
      state: conn.state,
      isProtocolEnabled: this.isConnectionProtocolEnabled(conn),
      isReadonly: this.isConnectionReadonly(conn)
    };
  }

  /**
   * Calls connection.setState(newState) on the given connection and returns
   * the resulting user-visible state + flags. Tests that the wrapping
   * preserves internal flags across setState calls.
   */
  @callable()
  async setConnectionUserState(
    connectionId: string,
    newState: Record<string, unknown>
  ) {
    const conn = Array.from(this.getConnections()).find(
      (c) => c.id === connectionId
    );
    if (!conn) return null;
    conn.setState(newState);
    return {
      state: conn.state,
      isProtocolEnabled: this.isConnectionProtocolEnabled(conn),
      isReadonly: this.isConnectionReadonly(conn)
    };
  }

  /**
   * Calls connection.setState(prev => ({ ...prev, ...updates })) (callback
   * form) and returns the result. Tests the callback branch of the wrapping.
   */
  @callable()
  async setConnectionUserStateCallback(
    connectionId: string,
    updates: Record<string, unknown>
  ) {
    const conn = Array.from(this.getConnections()).find(
      (c) => c.id === connectionId
    );
    if (!conn) return null;
    conn.setState((prev: Record<string, unknown> | null) => ({
      ...(prev ?? {}),
      ...updates
    }));
    return {
      state: conn.state,
      isProtocolEnabled: this.isConnectionProtocolEnabled(conn),
      isReadonly: this.isConnectionReadonly(conn)
    };
  }
}
