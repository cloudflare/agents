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

  /**
   * Simulate a post-hibernation scenario: clear the in-memory
   * _rawStateAccessors cache and restore the original state getter,
   * then check isConnectionProtocolEnabled.
   *
   * After hibernation, the WeakMap is empty AND the connection objects
   * are brand new (not wrapped), so `connection.state` returns the raw
   * serialized attachment including internal flags. We simulate this by
   * clearing the accessor cache and restoring the original `state` getter
   * that reads from the WebSocket attachment.
   */
  @callable()
  async checkProtocolEnabledAfterCacheClear(connectionId: string) {
    const conn = Array.from(this.getConnections()).find(
      (c) => c.id === connectionId
    );
    if (!conn) return null;

    // Delete the cached accessors to simulate post-hibernation state
    // where the in-memory WeakMap has been cleared.
    // biome-ignore lint: accessing private field for testing
    (
      this as unknown as { _rawStateAccessors: WeakMap<Connection, unknown> }
    )._rawStateAccessors.delete(conn);

    // Restore the original `state` getter to simulate a fresh connection
    // after hibernation wake. After hibernation, createLazyConnection
    // defines `state` as a getter reading from deserializeAttachment()
    // (which includes internal flags). Our _ensureConnectionWrapped
    // overrides this with a filtering getter that hides them.
    // Restore the raw getter to match post-hibernation behavior.
    Object.defineProperty(conn, "state", {
      configurable: true,
      get() {
        return conn.deserializeAttachment();
      }
    });

    return this.isConnectionProtocolEnabled(conn);
  }
}
