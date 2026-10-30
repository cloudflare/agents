import { MCPConnectionState, type MCPClientConnection } from "./connection";
import type { McpClientContext } from "./context";
import type { StoredServerFailure } from "./server-store";

/**
 * The transitions every controller shares: a server stops with a recorded
 * reason, a server reaches ready, and a connection's resumable session is
 * saved with its row.
 */
export class ServerStatus {
  constructor(private readonly ctx: McpClientContext) {}

  /**
   * Mark a server failed and record why, so later wakes show the same
   * failure instead of trying again. Clears its pending link. Only an
   * explicit reconnect clears the failure.
   */
  stop(
    serverId: string,
    reason: StoredServerFailure["reason"],
    message: string
  ): void {
    this.ctx.store.clearAuthUrl(serverId);
    this.ctx.store.setFailure(serverId, { reason, message, at: Date.now() });
    const conn = this.ctx.connections[serverId];
    if (conn) {
      conn.connectionState = MCPConnectionState.FAILED;
      conn.connectionError = message;
    }
    this.ctx.stateChanged();
  }

  /** A server reached ready: forget its failure. */
  ready(serverId: string): void {
    this.ctx.store.clearFailure(serverId);
    const conn = this.ctx.connections[serverId];
    if (conn) conn.connectionError = null;
  }

  /** Save the connection's resumable session with its row, or clear it. */
  saveSession(serverId: string, conn: MCPClientConnection): void {
    const { sessionId, protocolVersion, discoverResult } = conn;
    this.ctx.store.setSession(
      serverId,
      sessionId && protocolVersion
        ? { id: sessionId, protocolVersion, discoverResult }
        : undefined
    );
  }
}
