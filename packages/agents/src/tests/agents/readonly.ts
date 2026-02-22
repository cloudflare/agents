import {
  Agent,
  callable,
  getCurrentAgent,
  type Connection
} from "../../index.ts";
import type { ConnectionContext } from "../../index.ts";

// Test Agent for readonly connections feature
export class TestReadonlyAgent extends Agent<
  Record<string, unknown>,
  { count: number }
> {
  initialState = { count: 0 };
  static options = { hibernate: true };

  // Track state update attempts for testing
  stateUpdateAttempts: Array<{
    source: string;
    count: number;
    allowed: boolean;
  }> = [];

  shouldConnectionBeReadonly(
    _connection: Connection,
    ctx: ConnectionContext
  ): boolean {
    // Check query parameter to determine readonly status
    const url = new URL(ctx.request.url);
    return url.searchParams.get("readonly") === "true";
  }

  onStateUpdate(state: { count: number }, source: Connection | "server"): void {
    this.stateUpdateAttempts.push({
      source: source === "server" ? "server" : source.id,
      count: state.count,
      allowed: true
    });
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
  async checkReadonly(connectionId: string) {
    const conn = Array.from(this.getConnections()).find(
      (c) => c.id === connectionId
    );
    return conn ? this.isConnectionReadonly(conn) : null;
  }

  @callable()
  async setReadonly(connectionId: string, readonly: boolean) {
    const conn = Array.from(this.getConnections()).find(
      (c) => c.id === connectionId
    );
    if (conn) {
      this.setConnectionReadonly(conn, readonly);
      return { success: true, readonly };
    }
    return { success: false };
  }

  @callable()
  async getStateUpdateAttempts() {
    return this.stateUpdateAttempts;
  }

  /** Returns the calling connection's ID so the client can pass it to other RPCs. */
  @callable()
  async getMyConnectionId() {
    const { connection } = getCurrentAgent();
    return connection ? connection.id : null;
  }

  /**
   * Returns connection.state (user-visible) and readonly status for the given connection.
   * Used to verify that the wrapping hides _cf_readonly from user code.
   */
  @callable()
  async getConnectionUserState(connectionId: string) {
    const conn = Array.from(this.getConnections()).find(
      (c) => c.id === connectionId
    );
    if (!conn) return null;
    return { state: conn.state, isReadonly: this.isConnectionReadonly(conn) };
  }

  /**
   * Calls connection.setState(newState) (value form) and returns the resulting
   * user-visible state + readonly status. Tests that the wrapping preserves _cf_readonly.
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
    return { state: conn.state, isReadonly: this.isConnectionReadonly(conn) };
  }

  /**
   * Calls connection.setState(prev => ({ ...prev, ...updates })) (callback form)
   * and returns the result. Tests the callback branch of the wrapping.
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
    return { state: conn.state, isReadonly: this.isConnectionReadonly(conn) };
  }
}
