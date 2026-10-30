import { nanoid } from "nanoid";
import type { McpClientOptions } from "../types";
import { MCPConnectionState, type MCPTransportOptions } from "./connection";
import type { McpClientContext } from "./context";
import { toErrorMessage } from "./errors";
import type { ConnectionEntryPoints, ServerController } from "./servers";
import { assertAllowedUrl } from "./servers";

/** Options for the deprecated `MCPClientManager.connect()`. */
export type LegacyConnectOptions = {
  /** Reconnect an existing server id, optionally completing OAuth with a code. */
  reconnect?: {
    id: string;
    oauthClientId?: string;
    oauthCode?: string;
  };
  /** Transport options, including the OAuth provider whose auth URL is read. */
  transport?: MCPTransportOptions;
  /** MCP SDK client options. */
  client?: McpClientOptions;
};

/**
 * The deprecated `MCPClientManager.connect()`: create (or, with an OAuth
 * code, reuse) a connection, connect it, and discover it. Kept apart from
 * the server controller because nothing else works this way: it neither
 * saves the server nor schedules reconnects.
 */
export function legacyConnect(
  ctx: McpClientContext,
  servers: ServerController,
  entry: ConnectionEntryPoints,
  url: string,
  options: LegacyConnectOptions
): Promise<{ id: string; authUrl?: string; clientId?: string }> {
  const id = options.reconnect?.id ?? nanoid(8);
  return ctx.lanes.run(id, async () => {
    const provider = options.transport?.authProvider;
    if (provider) {
      provider.serverId = id;
      if (options.reconnect?.oauthClientId) {
        provider.clientId = options.reconnect.oauthClientId;
      }
    }
    assertAllowedUrl(url);

    // An OAuth reconnect keeps the connection to preserve its state;
    // otherwise drop any existing one and build it again.
    if (!options.reconnect?.oauthCode || !ctx.connections[id]) {
      const replaced = ctx.connections[id];
      if (replaced) {
        delete ctx.connections[id];
        // Out of the map, nothing else can close this transport.
        await replaced.close().catch(() => {});
        ctx.store.setSession(id);
      }
      servers.createConnection(id, url, {
        client: options.client,
        transport: options.transport ?? {}
      });
    }

    await ctx.connections[id].init();

    if (options.reconnect?.oauthCode) {
      try {
        await completeAuthorization(ctx, id, options.reconnect.oauthCode);
        await ctx.connections[id].init();
      } catch (error) {
        ctx.observability.fire({
          type: "mcp:client:connect",
          payload: {
            url,
            transport: options.transport?.type ?? "auto",
            state: ctx.connections[id].connectionState,
            error: toErrorMessage(error)
          },
          timestamp: Date.now()
        });
        throw error;
      }
    }

    const authUrl = provider?.authUrl;
    if (
      ctx.connections[id].connectionState ===
        MCPConnectionState.AUTHENTICATING &&
      authUrl &&
      provider?.redirectUrl
    ) {
      return { authUrl, clientId: provider.clientId, id };
    }

    const discovered = await entry.discoverIfConnected(id);
    if (discovered && !discovered.success) {
      throw new Error(
        `Failed to discover server capabilities: ${discovered.error}`
      );
    }
    return { id };
  });
}

/** Exchange the code, always cleaning up the code verifier afterwards. */
async function completeAuthorization(
  ctx: McpClientContext,
  id: string,
  code: string
): Promise<void> {
  const conn = ctx.connections[id];
  let completeError: unknown;
  try {
    await conn.completeAuthorization(code);
  } catch (error) {
    completeError = error;
  }
  try {
    await conn.options.transport.authProvider?.deleteCodeVerifier();
  } catch (cleanupError) {
    console.warn(
      `[MCPClientManager] Failed to clean up OAuth code verifier for server "${id}":`,
      cleanupError
    );
  }
  if (completeError) throw completeError;
}
