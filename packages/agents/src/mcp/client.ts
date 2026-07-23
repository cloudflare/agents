import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolRequest,
  CallToolResultSchema,
  ClientCapabilities,
  CompatibilityCallToolResultSchema,
  ElicitRequest,
  ElicitResult,
  GetPromptRequest,
  Prompt,
  ReadResourceRequest,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import { type RetryOptions, tryN } from "../retries";
import { z } from "zod";
import { nanoid } from "nanoid";
import { Emitter, type Event, DisposableStore } from "../core/events";
import type { MCPObservabilityEvent } from "../observability/mcp";
import {
  elicitationCapabilitiesFromHandlers,
  MCPClientConnection,
  MCPConnectionState,
  type MCPDiscoveryResult,
  type MCPElicitationHandlers,
  type MCPTransportOptions
} from "./client-connection";
import { toErrorMessage } from "./errors";
import { camelCaseToKebabCase } from "../utils";
import { RPC_DO_PREFIX } from "./rpc";
import type { TransportType } from "./types";
import type { MCPServerRow } from "./client-storage";
import type { AgentMcpOAuthProvider } from "./do-oauth-client-provider";
import type {
  AgentDestroyContext,
  AgentLifecycle,
  AgentRequestContext,
  AgentStartContext,
  AgentTurnContext,
  AgentTurnContribution
} from "../agent/lifecycle";
import {
  getMCPClientManagerHost,
  type MCPClientManagerHost
} from "./client-host";
import type { Agent } from "../index";
import type { McpAgent } from ".";

export type MCPAITool = {
  description?: string;
  title?: string;
  execute: (
    args: Record<string, unknown>,
    options?: unknown
  ) => Promise<unknown>;
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
};

/**
 * Structural tool set returned by {@link MCPClientManager.getAITools}.
 * Compatible with the AI SDK without importing its types into the core
 * `agents` declaration graph.
 */
export type MCPAIToolSet = Record<string, MCPAITool>;

export type MCPServer = {
  name: string;
  server_url: string;
  auth_url: string | null;
  state: MCPConnectionState;
  /** May contain untrusted content from external OAuth providers. Escape appropriately for your output context. */
  error: string | null;
  instructions: string | null;
  capabilities: ServerCapabilities | null;
};

export type MCPServersState = {
  servers: Record<string, MCPServer>;
  tools: (Tool & { serverId: string })[];
  prompts: (Prompt & { serverId: string })[];
  resources: (Resource & { serverId: string })[];
};

/** Maximum length for error strings exposed to clients. */
const MAX_ERROR_STRING_LENGTH = 500;
const CONTROL_CHAR_RE = new RegExp(
  // oxlint-disable-next-line no-control-regex -- intentionally matching control characters
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]",
  "g"
);

function sanitizeErrorString(error: string | null): string | null {
  if (error === null) return null;
  let sanitized = error.replace(CONTROL_CHAR_RE, "");
  if (sanitized.length > MAX_ERROR_STRING_LENGTH) {
    sanitized = `${sanitized.substring(0, MAX_ERROR_STRING_LENGTH)}...`;
  }
  return sanitized;
}
type MCPAIConvertedSchemas = {
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
};

type MCPAISchemaSource = {
  tool: Tool;
  inputSchema: Tool["inputSchema"] | undefined;
  outputSchema: Tool["outputSchema"] | undefined;
};

type MCPAISchemaCacheSlot = MCPAISchemaSource &
  (
    | { status: "converted"; converted: MCPAIConvertedSchemas }
    | { status: "failed"; error: string }
  );

type MCPAISchemaCacheEntry = {
  catalog: Tool[];
  converted: Array<MCPAISchemaCacheSlot | undefined>;
};

/** Maximum length of a normalized MCP server id. */
export const MCP_SERVER_ID_MAX_LENGTH = 64;

/**
 * Normalize a caller-supplied MCP server id into a stable, storage- and
 * tool-name-safe form.
 *
 * The id is surfaced in several places where the character set matters:
 *  - as the primary key in the `cf_agents_mcp_servers` SQLite table
 *  - embedded in AI SDK tool names as `` `tool_${id.replace(/-/g, "")}_${tool}` ``
 *    (tool names must match `/^[A-Za-z0-9_]+$/`)
 *  - as a key on the `mcpConnections` map and OAuth provider storage
 *
 * Rules:
 *  1. Lowercase.
 *  2. Replace any run of disallowed characters with a single `-`.
 *  3. Collapse repeated `-` and trim leading/trailing `-`/`_`.
 *  4. Prefix with `id-` if the result is empty or doesn't start with a letter.
 *  5. Truncate to {@link MCP_SERVER_ID_MAX_LENGTH} characters.
 *
 * @example
 * normalizeServerId("my-supplied-id");  // "my-supplied-id"
 * normalizeServerId("GitHub MCP!");     // "github-mcp"
 * normalizeServerId("42-things");       // "id-42-things"
 */
export function normalizeServerId(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError(
      `normalizeServerId: expected string, got ${typeof input}`
    );
  }

  let id = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");

  if (id.length === 0 || !/^[a-z]/.test(id)) {
    id = `id-${id}`.replace(/-+$/g, "");
  }

  if (id.length > MCP_SERVER_ID_MAX_LENGTH) {
    id = id.slice(0, MCP_SERVER_ID_MAX_LENGTH).replace(/-+$/g, "");
  }

  return id;
}

/**
 * Blocked hostname patterns for SSRF protection.
 * Prevents MCP client from connecting to internal/private network addresses
 * while allowing loopback hosts for local development.
 */
const BLOCKED_HOSTNAMES = new Set([
  "0.0.0.0",
  "[::]",
  "metadata.google.internal"
]);

/**
 * Check whether four IPv4 octets belong to a private/reserved range.
 * Blocks RFC 1918, link-local, cloud metadata, and unspecified addresses.
 */
function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  return false;
}

/**
 * fe80::/10 — IPv6 link-local (RFC 4291 §2.5.6).
 *
 * The /10 boundary fixes the first 10 bits (1111111010), which means valid
 * first hextets range from fe80 through febf. Only hex digits 8, 9, a, b
 * have high two bits "10" — anything else (e.g. fe7f, fec0) is out of range.
 * The fourth hex digit is unconstrained by the /10 boundary.
 *
 * Historical bug: `startsWith("fe80")` only matched the narrower fe80::/16
 * prefix and let fe81::/feab::/febf:: slip through. See issue #1325.
 */
const IPV6_LINK_LOCAL = /^fe[89ab][0-9a-f]/;

/**
 * Check whether a bracket-stripped, lowercased IPv6 address belongs to a
 * private/reserved range. Also unwraps IPv4-mapped IPv6 (::ffff:...) and
 * delegates to isPrivateIPv4 for those.
 *
 * Loopback (::1) and unspecified (::) are NOT blocked here:
 *   - ::1 is intentionally allowed (parallel to 127.x.x.x for local dev)
 *   - :: (== [::]) is blocked via BLOCKED_HOSTNAMES at the hostname level
 */
function isPrivateIPv6(addr: string): boolean {
  // fc00::/7 — unique local addresses (fc00:: through fdff::).
  // /7 fixes first 7 bits "1111110", so the 8-bit prefix is either
  // fc (11111100) or fd (11111101). No other first hextets qualify.
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true;

  // fe80::/10 — link-local addresses (fe80:: through febf:...).
  if (IPV6_LINK_LOCAL.test(addr)) return true;

  // IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:XXYY:ZZWW).
  // The WHATWG URL parser does NOT canonicalize hex-form tails to dotted
  // form — [::ffff:a00:1] stays as "::ffff:a00:1" and will only be caught
  // by the hex branch. Both forms must therefore be handled here.
  if (addr.startsWith("::ffff:")) {
    const mapped = addr.slice(7);
    const dotParts = mapped.split(".");
    if (dotParts.length === 4 && dotParts.every((p) => /^\d{1,3}$/.test(p))) {
      if (isPrivateIPv4(dotParts.map(Number))) return true;
    } else {
      const hexParts = mapped.split(":");
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0], 16);
        const lo = parseInt(hexParts[1], 16);
        if (
          isPrivateIPv4([
            (hi >> 8) & 0xff,
            hi & 0xff,
            (lo >> 8) & 0xff,
            lo & 0xff
          ])
        )
          return true;
      }
    }
  }

  return false;
}

/**
 * Check whether a hostname looks like a private/internal IP address.
 * Blocks RFC 1918, link-local, unique-local, unspecified,
 * and cloud metadata endpoints. Also detects IPv4-mapped IPv6 addresses.
 */
function isBlockedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true; // Malformed URLs are blocked
  }

  const hostname = parsed.hostname;

  if (BLOCKED_HOSTNAMES.has(hostname)) return true;

  // IPv4 checks
  const ipv4Parts = hostname.split(".");
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\d{1,3}$/.test(p))) {
    if (isPrivateIPv4(ipv4Parts.map(Number))) return true;
  }

  // IPv6 private range checks.
  // URL parser keeps brackets: hostname for [fc00::1] is "[fc00::1]".
  // The parser also lowercases/canonicalizes the address, but we
  // lowercase again defensively in case this helper is ever called with
  // a non-parser-produced hostname.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    if (isPrivateIPv6(hostname.slice(1, -1).toLowerCase())) return true;
  }

  return false;
}

/**
 * Options that can be stored in the server_options column
 * This is what gets JSON.stringify'd and stored in the database
 */
export type MCPServerOptions = {
  client?: ConstructorParameters<typeof Client>[1];
  transport?: {
    headers?: HeadersInit;
    type?: TransportType;
    sessionId?: string;
  };
  /** Retry options for connection and reconnection attempts */
  retry?: RetryOptions;
  /**
   * Client capabilities advertised from configured handlers (currently the
   * elicitation modes). Handlers are functions and cannot be persisted, so
   * this records what they advertised for restores after hibernation.
   */
  capabilities?: ClientCapabilities;
};

/**
 * Result of an OAuth callback request
 */
export type MCPOAuthCallbackResult =
  | { serverId: string; authSuccess: true; authError?: undefined }
  | { serverId?: string; authSuccess: false; authError: string };

/**
 * Options for registering an MCP server
 */
export type RegisterServerOptions = {
  url: string;
  name: string;
  callbackUrl?: string;
  client?: ConstructorParameters<typeof Client>[1];
  transport?: MCPTransportOptions;
  authUrl?: string;
  clientId?: string;
  /** Retry options for connection and reconnection attempts */
  retry?: RetryOptions;
};

/**
 * Result of attempting to connect to an MCP server.
 * Discriminated union ensures error is present only on failure.
 */
export type MCPConnectionResult =
  | {
      state: typeof MCPConnectionState.FAILED;
      error: string;
    }
  | {
      state: typeof MCPConnectionState.AUTHENTICATING;
      authUrl: string;
      clientId?: string;
    }
  | {
      state: typeof MCPConnectionState.CONNECTED;
    };

/** Converts a resolved connection failure into a retry signal. */
class ConnectRetryError extends Error {
  constructor(readonly result: MCPConnectionResult) {
    super("MCP connection attempt failed");
  }
}

/**
 * Result of discovering server capabilities.
 * success indicates whether discovery completed successfully.
 * state is the current connection state at time of return.
 * error is present when success is false.
 */
export type MCPDiscoverResult = {
  success: boolean;
  state: MCPConnectionState;
  error?: string;
};

export type MCPClientOAuthCallbackConfig = {
  successRedirect?: string;
  errorRedirect?: string;
  customHandler?: (result: MCPClientOAuthResult) => Response;
};

export type MCPClientOAuthResult =
  | { serverId: string; authSuccess: true; authError?: undefined }
  | {
      serverId?: string;
      authSuccess: false;
      /** May contain untrusted content from external OAuth providers. Escape appropriately for your output context. */
      authError: string;
    };

/** Options for an Agent-owned MCP client manager. */
export type MCPClientElicitationHandler = (
  request: ElicitRequest,
  serverId: string
) => Promise<ElicitResult>;

export type MCPClientElicitationHandlers = {
  form?: MCPClientElicitationHandler;
  url?: MCPClientElicitationHandler;
};

export type MCPClientManagerOptions = {
  name: string;
  version: string;
};

/** Options for adding an HTTP MCP server. */
export type AddMcpServerOptions = {
  id?: string;
  callbackHost?: string;
  callbackPath?: string;
  agentsPrefix?: string;
  client?: ConstructorParameters<typeof Client>[1];
  transport?: {
    headers?: HeadersInit;
    type?: TransportType;
  };
  retry?: RetryOptions;
};

/** Options for adding an MCP server backed by a Durable Object binding. */
export type AddRpcMcpServerOptions = {
  id?: string;
  props?: Record<string, unknown>;
};

/**
 * Filter options for scoping tools, prompts, resources, and resource templates
 * to a subset of connected MCP servers. All specified criteria are AND'd together.
 */
export type MCPServerFilter = {
  /** Include only connections matching this server ID (or IDs). */
  serverId?: string | string[];
  /** Include only connections whose stored name matches (or is in) this value. */
  serverName?: string | string[];
  /** Include only connections currently in this state (or states). */
  state?: MCPConnectionState | MCPConnectionState[];
};

/**
 * Utility class that aggregates multiple MCP clients into one
 */
export class MCPClientManager implements AgentLifecycle {
  public mcpConnections: Record<string, MCPClientConnection> = {};
  /** Cache only the current catalog so old schema graphs are not retained. */
  private readonly _aiToolSchemas = new WeakMap<
    MCPClientConnection,
    MCPAISchemaCacheEntry
  >();
  private _didWarnAboutUnstableGetAITools = false;
  private _oauthCallbackConfig?: MCPClientOAuthCallbackConfig;
  private _connectionDisposables = new Map<string, DisposableStore>();
  private _hostDisposables?: DisposableStore;
  private readonly _storage: DurableObjectStorage;
  private readonly _name: string;
  private readonly _version: string;
  private readonly _host: MCPClientManagerHost;
  private _isRestored = false;
  private _pendingConnections = new Map<string, Promise<void>>();
  private _elicitationHandlers?: MCPClientElicitationHandlers;

  /** @internal Protected for testing purposes. */
  protected readonly _onObservabilityEvent =
    new Emitter<MCPObservabilityEvent>();
  public readonly onObservabilityEvent: Event<MCPObservabilityEvent> =
    this._onObservabilityEvent.event;

  private readonly _onServerStateChanged = new Emitter<void>();
  /**
   * Event that fires whenever any MCP server state changes (registered, connected, removed, etc.)
   * This is useful for broadcasting server state to clients.
   */
  public readonly onServerStateChanged: Event<void> =
    this._onServerStateChanged.event;

  /** Construct an Agent lifecycle component. */
  constructor(owner: Agent, options: MCPClientManagerOptions) {
    const host = getMCPClientManagerHost(owner);
    if (!host) {
      throw new Error("MCPClientManager owner is not an Agent lifecycle host");
    }
    this._host = host;
    this._name = options.name;
    this._version = options.version;
    this._storage = host.storage;
    this.ensureSchema();
  }

  async onStart(_context: AgentStartContext): Promise<void> {
    const host = this._host;
    this.ensureSchema();

    // State-publication and observability subscriptions attach here rather
    // than in the constructor. This relies on the Agent awaiting onStart
    // before serving traffic (partyserver semantics): MCP state cannot
    // change between construction and onStart, so no events are missed.

    this._hostDisposables?.dispose();
    this._hostDisposables = new DisposableStore();
    this._hostDisposables.add(
      this.onServerStateChanged(() => {
        host.publishState(this.getMcpServers());
      })
    );
    this._hostDisposables.add(
      this.onObservabilityEvent((event) => {
        host.emitObservability(event);
      })
    );

    await this.restoreConnectionsFromStorage();
    await this.restoreRpcServers();
    host.publishState(this.getMcpServers());
  }

  async onRequest(context: AgentRequestContext): Promise<Response | undefined> {
    if (!this.isCallbackRequest(context.request)) return undefined;

    const host = this._host;
    const result = await this.handleCallbackRequest(context.request);
    if (result.authSuccess) {
      this.establishConnection(result.serverId).catch((error) => {
        console.error(
          "[Agent handleMcpOAuthCallback] Connection establishment failed:",
          error
        );
      });
    }
    host.publishState(this.getMcpServers());
    return this.oauthCallbackResponse(result, context.request);
  }

  async onTurn(context: AgentTurnContext): Promise<AgentTurnContribution> {
    if (context.readiness) {
      await this.waitForConnections(context.readiness);
    }
    return context.includeTools === false ? {} : { tools: this.getAITools() };
  }

  async onDestroy(_context: AgentDestroyContext): Promise<void> {
    this._hostDisposables?.dispose();
    this._hostDisposables = undefined;
    await this.dispose();
    this.sql("DROP TABLE IF EXISTS cf_agents_mcp_servers");
  }

  private oauthCallbackResponse(
    result: MCPClientOAuthResult,
    request: Request
  ): Response {
    const config = this.getOAuthCallbackConfig();
    if (config?.customHandler) return config.customHandler(result);

    const baseOrigin = new URL(request.url).origin;
    if (config?.successRedirect && result.authSuccess) {
      try {
        return Response.redirect(
          new URL(config.successRedirect, baseOrigin).href
        );
      } catch (error) {
        console.error(
          "Invalid successRedirect URL:",
          config.successRedirect,
          error
        );
        return Response.redirect(baseOrigin);
      }
    }

    if (config?.errorRedirect && !result.authSuccess) {
      try {
        const errorUrl = `${config.errorRedirect}?error=${encodeURIComponent(
          result.authError || "Unknown error"
        )}`;
        return Response.redirect(new URL(errorUrl, baseOrigin).href);
      } catch (error) {
        console.error(
          "Invalid errorRedirect URL:",
          config.errorRedirect,
          error
        );
        return Response.redirect(baseOrigin);
      }
    }

    return Response.redirect(baseOrigin);
  }

  private async restoreRpcServers(): Promise<void> {
    const host = this._host;
    const rpcServers = this.getRpcServersFromStorage();
    for (const server of rpcServers) {
      if (this.mcpConnections[server.id]) continue;

      const options: { bindingName: string; props?: Record<string, unknown> } =
        server.server_options ? JSON.parse(server.server_options) : {};
      const namespace = host.getEnv()[options.bindingName] as
        | DurableObjectNamespace
        | undefined;
      if (!namespace) {
        console.warn(
          `[Agent] Cannot restore RPC MCP server "${server.name}": binding "${options.bindingName}" not found in env`
        );
        continue;
      }

      const normalizedName = server.server_url.replace(RPC_DO_PREFIX, "");
      try {
        await this.connect(`${RPC_DO_PREFIX}${normalizedName}`, {
          reconnect: { id: server.id },
          transport: {
            type: "rpc",
            namespace,
            name: normalizedName,
            props: options.props
          } as MCPTransportOptions
        });
        const connection = this.mcpConnections[server.id];
        if (connection?.connectionState === MCPConnectionState.CONNECTED) {
          await this.discoverIfConnected(server.id);
        }
      } catch (error) {
        console.error(
          `[Agent] Error restoring RPC MCP server "${server.name}":`,
          error
        );
      }
    }
  }

  private ensureSchema(): void {
    this.sql(`
          CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            server_url TEXT NOT NULL,
            callback_url TEXT NOT NULL,
            client_id TEXT,
            auth_url TEXT,
            server_options TEXT
          )
        `);
  }

  /**
   * Scope the manager-level elicitation handler to a single connection.
   * Returns undefined when no handler is configured so the connection keeps
   * its default throwing behavior.
   */
  private scopedElicitationHandlers(
    serverId: string
  ): MCPElicitationHandlers | undefined {
    const handlers = this._elicitationHandlers;
    if (!handlers) return undefined;

    const form = handlers.form;
    const url = handlers.url;
    return {
      form: form ? (request) => form(request, serverId) : undefined,
      url: url ? (request) => url(request, serverId) : undefined
    };
  }

  // SQL helper - runs a query and returns results as array
  private sql<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    return [...this._storage.sql.exec<T>(query, ...bindings)];
  }

  // Storage operations
  private saveServerToStorage(server: MCPServerRow): void {
    this.sql(
      `INSERT OR REPLACE INTO cf_agents_mcp_servers (
        id, name, server_url, client_id, auth_url, callback_url, server_options
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      server.id,
      server.name,
      server.server_url,
      server.client_id ?? null,
      server.auth_url ?? null,
      server.callback_url,
      server.server_options ?? null
    );
  }

  private removeServerFromStorage(serverId: string): void {
    this.sql("DELETE FROM cf_agents_mcp_servers WHERE id = ?", serverId);
  }

  /**
   * Rename a server's id, in-place, across every place the id is used as a
   * key. Used to JIT-migrate servers that were originally registered under an
   * auto-generated nanoid to a caller-supplied stable id (see
   * `Agent.addMcpServer`'s `{ id }` option).
   *
   * Migrates:
   *  - the `cf_agents_mcp_servers` row (primary key)
   *  - the in-memory `mcpConnections` map key
   *  - the connection disposables map key
   *  - the attached `authProvider.serverId`, if any
   *  - OAuth-related storage keys under `/{clientName}/{oldId}/...`
   *
   * Safe to call when no OAuth keys exist (RPC / bearer-token HTTP servers).
   * If `oldId === newId` this is a no-op. If a row already exists under
   * `newId`, throws — the caller is expected to have verified uniqueness.
   *
   * @internal Exposed for `Agent.addMcpServer` JIT-migration.
   */
  async migrateServerId(
    oldId: string,
    newId: string,
    clientName: string
  ): Promise<void> {
    if (oldId === newId) return;

    // Restore work closes over oldId. Drain it before renaming, including
    // replacement work registered while an earlier task settles.
    while (true) {
      const pending = this._pendingConnections.get(oldId);
      if (!pending) break;
      await pending.catch(() => {});
    }

    const existing = this.sql<MCPServerRow>(
      "SELECT id FROM cf_agents_mcp_servers WHERE id = ?",
      oldId
    );
    if (existing.length === 0) {
      // Nothing in storage to rename; just rename the in-memory connection if any.
      this._renameInMemoryConnection(oldId, newId);
      return;
    }

    const collision = this.sql<MCPServerRow>(
      "SELECT id FROM cf_agents_mcp_servers WHERE id = ?",
      newId
    );
    if (collision.length > 0) {
      throw new Error(
        `Cannot migrate MCP server id "${oldId}" → "${newId}": new id is already in use.`
      );
    }

    // 1. Storage: rename the SQL row.
    this.sql(
      "UPDATE cf_agents_mcp_servers SET id = ? WHERE id = ?",
      newId,
      oldId
    );

    // 2. OAuth-related storage keys. The DurableObjectOAuthClientProvider
    //    keys everything under `/{clientName}/{serverId}/...`. Other servers
    //    won't have any keys with this prefix, so the list will be empty and
    //    this is a no-op for them.
    const oldPrefix = `/${clientName}/${oldId}/`;
    const newPrefix = `/${clientName}/${newId}/`;
    try {
      const keys = await this._storage.list({ prefix: oldPrefix });
      if (keys.size > 0) {
        const writes: Record<string, unknown> = {};
        const deletes: string[] = [];
        for (const [oldKey, value] of keys) {
          const newKey = newPrefix + oldKey.slice(oldPrefix.length);
          writes[newKey] = value;
          deletes.push(oldKey);
        }
        await this._storage.put(writes);
        await this._storage.delete(deletes);
      }
    } catch (error) {
      // Best-effort: storage rename failures shouldn't break the SQL-level
      // rename that already succeeded. Log and continue.
      console.warn(
        `[MCPClientManager] OAuth key migration ${oldPrefix} → ${newPrefix} failed:`,
        error
      );
    }

    // 3. In-memory connection + disposables + authProvider.
    this._renameInMemoryConnection(oldId, newId);

    this._onServerStateChanged.fire();
  }

  private _renameInMemoryConnection(oldId: string, newId: string): void {
    if (oldId === newId) return;

    const conn = this.mcpConnections[oldId];
    if (conn) {
      this.mcpConnections[newId] = conn;
      delete this.mcpConnections[oldId];
      const authProvider = conn.options.transport.authProvider;
      if (authProvider) {
        authProvider.serverId = newId;
      }
      // The elicitation handler closes over the server id it was created
      // with — rescope it so elicitation requests report the new id. With no
      // handlers there is nothing to rescope, and configuring would wipe the
      // connection's restored capability seed.
      const scoped = this.scopedElicitationHandlers(newId);
      if (scoped) {
        conn.configureElicitationHandlers(scoped);
      }
    }

    const disposables = this._connectionDisposables.get(oldId);
    if (disposables) {
      this._connectionDisposables.set(newId, disposables);
      this._connectionDisposables.delete(oldId);
    }
  }

  private getServersFromStorage(): MCPServerRow[] {
    return this.sql<MCPServerRow>(
      "SELECT id, name, server_url, client_id, auth_url, callback_url, server_options FROM cf_agents_mcp_servers"
    );
  }

  private filterConnections(
    filter?: MCPServerFilter
  ): Record<string, MCPClientConnection> {
    if (!filter) return this.mcpConnections;

    const serverIds = filter.serverId
      ? Array.isArray(filter.serverId)
        ? filter.serverId
        : [filter.serverId]
      : undefined;

    const serverNames = filter.serverName
      ? Array.isArray(filter.serverName)
        ? filter.serverName
        : [filter.serverName]
      : undefined;

    const states = filter.state
      ? Array.isArray(filter.state)
        ? filter.state
        : [filter.state]
      : undefined;

    let nameMatchedIds: Set<string> | undefined;
    if (serverNames) {
      const servers = this.getServersFromStorage();
      nameMatchedIds = new Set(
        servers.filter((s) => serverNames.includes(s.name)).map((s) => s.id)
      );
    }

    return Object.fromEntries(
      Object.entries(this.mcpConnections).filter(([id, conn]) => {
        if (serverIds && !serverIds.includes(id)) return false;
        if (nameMatchedIds && !nameMatchedIds.has(id)) return false;
        if (states && !states.includes(conn.connectionState)) return false;
        return true;
      })
    );
  }

  /**
   * Get the parsed server_options for a stored server, if any.
   */
  private getStoredServerOptions(
    serverId: string
  ): MCPServerOptions | undefined {
    const rows = this.sql<MCPServerRow>(
      "SELECT server_options FROM cf_agents_mcp_servers WHERE id = ?",
      serverId
    );
    if (!rows.length || !rows[0].server_options) return undefined;
    return JSON.parse(rows[0].server_options);
  }

  /**
   * Clear the capabilities persisted on a stored server row. Called once a
   * seeded connection's handshake completes (see `createConnection`): the
   * stamp is valid for one successful restore — sessions that configure
   * handlers re-stamp every row, so a deploy that stops configuring them
   * stops advertising stale modes after its first connected wake instead of
   * forever, while wakes that never handshake don't burn the stamp.
   */
  private clearStoredCapabilities(serverId: string): void {
    const rows = this.sql<MCPServerRow>(
      "SELECT id, name, server_url, client_id, auth_url, callback_url, server_options FROM cf_agents_mcp_servers WHERE id = ?",
      serverId
    );
    const row = rows[0];
    if (!row?.server_options) return;
    const options: MCPServerOptions = JSON.parse(row.server_options);
    if (!options.capabilities) return;
    options.capabilities = undefined;
    this.saveServerToStorage({
      ...row,
      server_options: JSON.stringify(options)
    });
  }

  /**
   * Get the retry options for a server from stored server_options
   */
  private getServerRetryOptions(serverId: string): RetryOptions | undefined {
    return this.getStoredServerOptions(serverId)?.retry;
  }

  private clearServerAuthUrl(serverId: string): void {
    this.sql(
      "UPDATE cf_agents_mcp_servers SET auth_url = NULL WHERE id = ?",
      serverId
    );
  }

  private updateStoredSessionId(id: string, sessionId?: string): void {
    const servers = this.getServersFromStorage();
    const serverRow = servers.find((server) => server.id === id);
    if (!serverRow) {
      return;
    }

    const parsedOptions: MCPServerOptions = serverRow.server_options
      ? JSON.parse(serverRow.server_options)
      : {};

    const currentSessionId = parsedOptions.transport?.sessionId;
    if (currentSessionId === sessionId) {
      return;
    }

    const nextTransport = {
      ...(parsedOptions.transport ?? {}),
      ...(sessionId ? { sessionId } : {})
    };

    if (!sessionId) {
      delete nextTransport.sessionId;
    }

    this.saveServerToStorage({
      ...serverRow,
      server_options: JSON.stringify({
        ...parsedOptions,
        transport: nextTransport
      })
    });
  }

  private failConnection(
    serverId: string,
    error: string
  ): MCPOAuthCallbackResult {
    this.clearServerAuthUrl(serverId);
    if (this.mcpConnections[serverId]) {
      this.mcpConnections[serverId].connectionState = MCPConnectionState.FAILED;
      this.mcpConnections[serverId].connectionError = error;
    }
    this._onServerStateChanged.fire();
    return { serverId, authSuccess: false, authError: error };
  }

  private isAuthAcceptedConnection(conn: MCPClientConnection): boolean {
    return (
      conn.connectionState === MCPConnectionState.READY ||
      conn.connectionState === MCPConnectionState.CONNECTED ||
      conn.connectionState === MCPConnectionState.CONNECTING ||
      conn.connectionState === MCPConnectionState.DISCOVERING
    );
  }

  private oauthCallbackSuccess(
    serverId: string,
    conn: MCPClientConnection
  ): MCPOAuthCallbackResult {
    this.clearServerAuthUrl(serverId);
    conn.connectionError = null;
    return { serverId, authSuccess: true };
  }

  private async runWithCodeVerifierState<T>(
    authProvider: AgentMcpOAuthProvider,
    state: string,
    callback: () => Promise<T>
  ): Promise<T> {
    if (authProvider.runWithCodeVerifierState) {
      return authProvider.runWithCodeVerifierState(state, callback);
    }
    return callback();
  }

  private async hasRedeemableOAuthState(
    serverId: string,
    authProvider: AgentMcpOAuthProvider,
    state: string
  ): Promise<boolean> {
    authProvider.serverId = serverId;
    try {
      return (await authProvider.checkState(state)).valid;
    } catch {
      return false;
    }
  }

  private ignoreUnverifiedCallback(
    serverId: string,
    error: string
  ): MCPOAuthCallbackResult {
    console.warn(
      `[MCPClientManager] Ignoring OAuth callback with unverified state for server "${serverId}": ${error}`
    );
    return { serverId, authSuccess: false, authError: error };
  }

  private async consumeStaleOAuthState(
    serverId: string,
    authProvider: AgentMcpOAuthProvider,
    state: string
  ): Promise<void> {
    try {
      const stateValidation = await authProvider.checkState(state);
      if (!stateValidation.valid) {
        console.warn(
          `[MCPClientManager] Ignoring stale OAuth callback with invalid state for server "${serverId}": ${stateValidation.error ?? "Invalid state"}`
        );
        return;
      }
      await authProvider.consumeState(state);
    } catch (cleanupError) {
      console.warn(
        `[MCPClientManager] Failed to clean up stale OAuth callback state for server "${serverId}":`,
        cleanupError
      );
    }
  }

  private async completeAuthorizationAndCleanupVerifier(
    serverId: string,
    conn: MCPClientConnection,
    authProvider: AgentMcpOAuthProvider,
    state: string,
    code: string
  ): Promise<void> {
    await this.runWithCodeVerifierState(authProvider, state, async () => {
      let completeError: unknown;
      let cleanupError: unknown;

      try {
        await conn.completeAuthorization(code, { alreadyAccepted: true });
      } catch (error) {
        completeError = error;
      }

      try {
        await authProvider.deleteCodeVerifier();
      } catch (deleteError) {
        cleanupError = deleteError;
      }

      if (completeError) {
        if (cleanupError) {
          console.warn(
            `[MCPClientManager] Failed to clean up OAuth code verifier for server "${serverId}":`,
            cleanupError
          );
        }
        throw completeError;
      }

      if (cleanupError) {
        throw cleanupError;
      }
    });
  }

  /**
   * Get saved RPC servers from storage (servers with rpc:// URLs).
   * These are restored separately by the Agent class since they need env bindings.
   */
  getRpcServersFromStorage(): MCPServerRow[] {
    return this.getServersFromStorage().filter((s) =>
      s.server_url.startsWith(RPC_DO_PREFIX)
    );
  }

  /**
   * Save an RPC server to storage for hibernation recovery.
   * The bindingName is stored in server_options so the Agent can look up
   * the namespace from env during restore.
   */
  saveRpcServerToStorage(
    id: string,
    name: string,
    normalizedName: string,
    bindingName: string,
    props?: Record<string, unknown>
  ): void {
    this.saveServerToStorage({
      id,
      name,
      server_url: `${RPC_DO_PREFIX}${normalizedName}`,
      client_id: null,
      auth_url: null,
      callback_url: "",
      server_options: JSON.stringify({
        bindingName,
        props,
        capabilities: this.advertisedHandlerCapabilities()
      })
    });
  }

  /**
   * Restore MCP server connections from storage
   * This method is called on Agent initialization to restore previously connected servers.
   * RPC servers (rpc:// URLs) are skipped here -- they are restored by the Agent class
   * which has access to env bindings.
   *
   */
  async restoreConnectionsFromStorage(): Promise<void> {
    if (this._isRestored) {
      return;
    }

    const servers = this.getServersFromStorage();

    if (!servers || servers.length === 0) {
      this._isRestored = true;
      return;
    }

    for (const server of servers) {
      if (server.server_url.startsWith(RPC_DO_PREFIX)) {
        continue;
      }

      const existingConn = this.mcpConnections[server.id];

      // Skip if connection already exists and is in a good state
      if (existingConn) {
        if (existingConn.connectionState === MCPConnectionState.READY) {
          console.warn(
            `[MCPClientManager] Server ${server.id} already has a ready connection. Skipping recreation.`
          );
          continue;
        }

        // Don't interrupt in-flight OAuth or connections
        if (
          existingConn.connectionState === MCPConnectionState.AUTHENTICATING ||
          existingConn.connectionState === MCPConnectionState.CONNECTING ||
          existingConn.connectionState === MCPConnectionState.DISCOVERING
        ) {
          // Let the existing flow complete
          continue;
        }

        // If failed, clean up the old connection before recreating
        if (existingConn.connectionState === MCPConnectionState.FAILED) {
          try {
            await existingConn.close();
          } catch (error) {
            console.warn(
              `[MCPClientManager] Error closing failed connection ${server.id}:`,
              error
            );
          } finally {
            this.cleanupClosedConnection(server.id);
          }
        }
      }

      const parsedOptions: MCPServerOptions | null = server.server_options
        ? JSON.parse(server.server_options)
        : null;
      // A caller-supplied jsonSchemaValidator is a live instance that can't
      // survive JSON serialization; drop whatever degraded value an older row
      // may hold so the connection falls back to the Worker-safe default.
      if (parsedOptions?.client) {
        delete parsedOptions.client.jsonSchemaValidator;
      }

      let authProvider: AgentMcpOAuthProvider | undefined;
      if (server.callback_url) {
        authProvider = this._host.createAuthProvider(server.callback_url);
        authProvider.serverId = server.id;
        if (server.client_id) {
          authProvider.clientId = server.client_id;
        }
      }

      // Create the in-memory connection object (no need to save to storage - we just read from it!)
      const conn = this.createConnection(server.id, server.server_url, {
        client: parsedOptions?.client ?? {},
        transport: {
          ...(parsedOptions?.transport ?? {}),
          type: parsedOptions?.transport?.type ?? ("auto" as TransportType),
          authProvider
        }
      });

      // If auth_url exists, OAuth flow is in progress - set state and wait for callback
      if (server.auth_url) {
        conn.connectionState = MCPConnectionState.AUTHENTICATING;
        continue;
      }

      // Start connection in background (don't await) to avoid blocking the DO
      this._trackConnection(
        server.id,
        this._restoreServer(server.id, parsedOptions?.retry)
      );
    }

    this._isRestored = true;
  }

  /**
   * Track a pending connection promise for a server.
   * The promise is removed from the map when it settles.
   */
  private _trackConnection(serverId: string, promise: Promise<void>): void {
    const tracked = promise.finally(() => {
      // Only delete if it's still the same promise (not replaced by a newer one)
      if (this._pendingConnections.get(serverId) === tracked) {
        this._pendingConnections.delete(serverId);
      }
    });
    this._pendingConnections.set(serverId, tracked);
  }

  /**
   * Wait for all in-flight connection and discovery operations to settle.
   * This is useful when you need MCP tools to be available before proceeding,
   * e.g. before calling getAITools() after the agent wakes from hibernation.
   *
   * Returns once every pending connection has either connected and discovered,
   * failed, or timed out. Never rejects.
   *
   * @param options.timeout - Maximum time in milliseconds to wait.
   *   `0` returns immediately without waiting.
   *   `undefined` (default) waits indefinitely.
   */
  async waitForConnections(options?: { timeout?: number }): Promise<void> {
    if (this._pendingConnections.size === 0) {
      return;
    }
    if (options?.timeout != null && options.timeout <= 0) {
      return;
    }
    const settled = Promise.allSettled(this._pendingConnections.values());
    if (options?.timeout != null && options.timeout > 0) {
      let timerId: ReturnType<typeof setTimeout>;
      const timer = new Promise<void>((resolve) => {
        timerId = setTimeout(resolve, options.timeout);
      });
      await Promise.race([settled, timer]);
      clearTimeout(timerId!);
    } else {
      await settled;
    }
  }

  private async _connectWithRetry(
    serverId: string,
    retry?: RetryOptions
  ): Promise<MCPConnectionResult> {
    const maxAttempts = retry?.maxAttempts ?? 3;
    const baseDelayMs = retry?.baseDelayMs ?? 500;
    const maxDelayMs = retry?.maxDelayMs ?? 5000;

    try {
      return await tryN(
        maxAttempts,
        async () => {
          const result = await this.connectToServer(serverId);
          if (result.state === MCPConnectionState.FAILED) {
            throw new ConnectRetryError(result);
          }
          return result;
        },
        { baseDelayMs, maxDelayMs }
      );
    } catch (error) {
      if (error instanceof ConnectRetryError) {
        return error.result;
      }
      throw error;
    }
  }

  /**
   * Internal method to restore a single server connection and discovery
   */
  private async _restoreServer(
    serverId: string,
    retry?: RetryOptions
  ): Promise<void> {
    // Always try to connect - the connection logic will determine if OAuth is needed
    // If stored OAuth tokens are valid, connection will succeed automatically
    // If tokens are missing/invalid, connection will fail with Unauthorized
    // and state will be set to "authenticating"
    const connectResult = await this._connectWithRetry(serverId, retry).catch(
      (error) => {
        console.error(`Error connecting to ${serverId}:`, error);
        return null;
      }
    );

    if (connectResult?.state === MCPConnectionState.CONNECTED) {
      const discoverResult = await this.discoverIfConnected(serverId);
      if (discoverResult && !discoverResult.success) {
        console.error(`Error discovering ${serverId}:`, discoverResult.error);
      }
    }
  }

  /**
   * Connect to and register an MCP server
   *
   * @deprecated This method is maintained for backward compatibility.
   * For new code, use registerServer() and connectToServer() separately.
   *
   * @param url Server URL
   * @param options Connection options
   * @returns Object with server ID, auth URL (if OAuth), and client ID (if OAuth)
   */
  async connect(
    url: string,
    options: {
      // Allows you to reconnect to a server (in the case of an auth reconnect)
      reconnect?: {
        // server id
        id: string;
        oauthClientId?: string;
        oauthCode?: string;
      };
      // we're overriding authProvider here because we want to be able to access the auth URL
      transport?: MCPTransportOptions;
      client?: ConstructorParameters<typeof Client>[1];
    } = {}
  ): Promise<{
    id: string;
    authUrl?: string;
    clientId?: string;
  }> {
    const id = options.reconnect?.id ?? nanoid(8);

    if (options.transport?.authProvider) {
      options.transport.authProvider.serverId = id;
      // reconnect with auth
      if (options.reconnect?.oauthClientId) {
        options.transport.authProvider.clientId =
          options.reconnect?.oauthClientId;
      }
    }

    if (isBlockedUrl(url)) {
      throw new Error(
        `Blocked URL: ${url} — MCP client connections to private/internal addresses are not allowed`
      );
    }

    // During OAuth reconnect, reuse existing connection to preserve state;
    // otherwise drop any existing connection and rebuild it.
    if (!options.reconnect?.oauthCode || !this.mcpConnections[id]) {
      const replaced = this.mcpConnections[id];
      if (replaced) {
        delete this.mcpConnections[id];
        // Once removed from the map, nothing else can close this transport.
        await replaced.close().catch(() => {});
        this.updateStoredSessionId(id, undefined);
      }
      this.createConnection(id, url, {
        client: options.client,
        transport: options.transport ?? {}
      });
    }

    // Initialize connection first. this will try connect
    await this.mcpConnections[id].init();

    // Handle OAuth completion if we have a reconnect code
    if (options.reconnect?.oauthCode) {
      try {
        const authProvider =
          this.mcpConnections[id].options.transport.authProvider;
        let completeError: unknown;
        try {
          await this.mcpConnections[id].completeAuthorization(
            options.reconnect.oauthCode
          );
        } catch (error) {
          completeError = error;
        }

        try {
          await authProvider?.deleteCodeVerifier();
        } catch (cleanupError) {
          console.warn(
            `[MCPClientManager] Failed to clean up OAuth code verifier for server "${id}":`,
            cleanupError
          );
        }

        if (completeError) {
          throw completeError;
        }

        // Reinitialize connection
        await this.mcpConnections[id].init();
      } catch (error) {
        this._onObservabilityEvent.fire({
          type: "mcp:client:connect",
          payload: {
            url: url,
            transport: options.transport?.type ?? "auto",
            state: this.mcpConnections[id].connectionState,
            error: toErrorMessage(error)
          },
          timestamp: Date.now()
        });
        // Re-throw to signal failure to the caller
        throw error;
      }
    }

    // If connection is in authenticating state, return auth URL for OAuth flow
    const authUrl = options.transport?.authProvider?.authUrl;
    if (
      this.mcpConnections[id].connectionState ===
        MCPConnectionState.AUTHENTICATING &&
      authUrl &&
      options.transport?.authProvider?.redirectUrl
    ) {
      return {
        authUrl,
        clientId: options.transport?.authProvider?.clientId,
        id
      };
    }

    // If connection is connected, discover capabilities
    const discoverResult = await this.discoverIfConnected(id);
    if (discoverResult && !discoverResult.success) {
      throw new Error(
        `Failed to discover server capabilities: ${discoverResult.error}`
      );
    }

    return {
      id
    };
  }

  /**
   * Create an in-memory connection object and set up observability
   * Does NOT save to storage - use registerServer() for that
   * @returns The connection object (existing or newly created)
   */
  private createConnection(
    id: string,
    url: string,
    options: {
      client?: ConstructorParameters<typeof Client>[1];
      transport: MCPTransportOptions;
    }
  ): MCPClientConnection {
    // Return existing connection if already exists
    if (this.mcpConnections[id]) {
      return this.mcpConnections[id];
    }

    const normalizedTransport = {
      ...options.transport,
      type: options.transport?.type ?? ("auto" as TransportType)
    };

    // Stored servers re-advertise the capabilities persisted on their row
    // (see MCPServerOptions.capabilities); fresh registrations have no row
    // yet and rely on the handlers below. The stamp is read without
    // clearing so a wake that never handshakes (OAuth still pending, isolate
    // death before connect) doesn't burn it — it is consumed at first use,
    // once a seeded handshake completes.
    const capabilitySeed = this.getStoredServerOptions(id)?.capabilities;

    this.mcpConnections[id] = new MCPClientConnection(
      new URL(url),
      {
        name: this._name,
        version: this._version
      },
      {
        client: options.client ?? {},
        transport: normalizedTransport,
        elicitationHandlers: this.scopedElicitationHandlers(id),
        capabilitySeed
      }
    );

    // Pipe connection-level observability events to the manager-level emitter
    const store = new DisposableStore();
    const existing = this._connectionDisposables.get(id);
    if (existing) existing.dispose();
    this._connectionDisposables.set(id, store);
    store.add(
      this.mcpConnections[id].onObservabilityEvent((event) => {
        this._onObservabilityEvent.fire(event);
      })
    );

    if (capabilitySeed) {
      const conn = this.mcpConnections[id];
      // Every handshake reports its success through this event, so it marks
      // the seed's first use. The burn only targets deploys that stopped
      // configuring handlers: a session with handlers configured owns the
      // row stamps (each configure call re-stamps them, and re-registering
      // a server writes a fresh one), and configureElicitationHandlers
      // drops the in-memory seed on live connections — either way a fresh
      // stamp meant for the next wake is never wiped here.
      const seedClear = conn.onObservabilityEvent((event) => {
        if (
          event.type !== "mcp:client:connect" ||
          event.payload.state !== MCPConnectionState.CONNECTED
        ) {
          return;
        }
        seedClear.dispose();
        if (this._elicitationHandlers || !conn.options.capabilitySeed) return;
        // migrateServerId may have renamed the row while the handshake was
        // in flight — clear under the connection's current id.
        const currentId = Object.keys(this.mcpConnections).find(
          (key) => this.mcpConnections[key] === conn
        );
        if (currentId) {
          this.clearStoredCapabilities(currentId);
        }
      });
      store.add(seedClear);
    }

    return this.mcpConnections[id];
  }

  /**
   * Register an MCP server connection without connecting
   * Creates the connection object, sets up observability, and saves to storage
   *
   * @param id Server ID
   * @param options Registration options including URL, name, callback URL, and connection config
   * @returns Server ID
   */
  async registerServer(
    id: string,
    options: RegisterServerOptions
  ): Promise<string> {
    if (isBlockedUrl(options.url)) {
      throw new Error(
        `Blocked URL: ${options.url} — MCP client connections to private/internal addresses are not allowed`
      );
    }

    // Create the in-memory connection
    this.createConnection(id, options.url, {
      client: options.client,
      transport: {
        ...options.transport,
        type: options.transport?.type ?? ("auto" as TransportType)
      }
    });

    // Save to storage, excluding live instances that can't survive JSON
    // serialization: authProvider is recreated during restore, and
    // jsonSchemaValidator falls back to the Worker-safe default.
    const { authProvider: _, ...transportWithoutAuth } =
      options.transport ?? {};
    const { jsonSchemaValidator: _validator, ...serializableClient } =
      options.client ?? {};
    this.saveServerToStorage({
      id,
      name: options.name,
      server_url: options.url,
      callback_url: options.callbackUrl ?? "",
      client_id: options.clientId ?? null,
      auth_url: options.authUrl ?? null,
      server_options: JSON.stringify({
        client: serializableClient,
        transport: transportWithoutAuth,
        retry: options.retry,
        capabilities: this.advertisedHandlerCapabilities()
      })
    });

    this._onServerStateChanged.fire();

    return id;
  }

  /**
   * Connect to an already registered MCP server and initialize the connection.
   *
   * For OAuth servers, returns `{ state: "authenticating", authUrl, clientId? }`.
   * The user must complete the OAuth flow via the authUrl, which triggers a
   * callback handled by `handleCallbackRequest()`.
   *
   * For non-OAuth servers, establishes the transport connection and returns
   * `{ state: "connected" }`. Call `discoverIfConnected()` afterwards to
   * discover capabilities and transition to "ready" state.
   *
   * @param id Server ID (must be registered first via registerServer())
   * @returns Connection result with current state and OAuth info (if applicable)
   */
  async connectToServer(id: string): Promise<MCPConnectionResult> {
    const conn = this.mcpConnections[id];
    if (!conn) {
      throw new Error(
        `Server ${id} is not registered. Call registerServer() first.`
      );
    }

    const error = await conn.init();
    this.updateStoredSessionId(id, conn.sessionId);
    this._onServerStateChanged.fire();

    switch (conn.connectionState) {
      case MCPConnectionState.FAILED:
        return {
          state: conn.connectionState,
          error: error ?? "Unknown connection error"
        };

      case MCPConnectionState.AUTHENTICATING: {
        const authUrl = conn.options.transport.authProvider?.authUrl;
        const redirectUrl = conn.options.transport.authProvider?.redirectUrl;

        if (!authUrl || !redirectUrl) {
          return {
            state: MCPConnectionState.FAILED,
            error: `OAuth configuration incomplete: missing ${!authUrl ? "authUrl" : "redirectUrl"}`
          };
        }

        const clientId = conn.options.transport.authProvider?.clientId;

        // Update storage with auth URL and client ID
        const servers = this.getServersFromStorage();
        const serverRow = servers.find((s) => s.id === id);
        if (serverRow) {
          this.saveServerToStorage({
            ...serverRow,
            auth_url: authUrl,
            client_id: clientId ?? null
          });
          // Broadcast again so clients receive the auth_url
          this._onServerStateChanged.fire();
        }

        this._onObservabilityEvent.fire({
          type: "mcp:client:authorize",
          payload: { serverId: id, authUrl, clientId },
          timestamp: Date.now()
        });

        return {
          state: conn.connectionState,
          authUrl,
          clientId
        };
      }

      case MCPConnectionState.CONNECTED:
        return { state: conn.connectionState };

      default:
        return {
          state: MCPConnectionState.FAILED,
          error: `Unexpected connection state after init: ${conn.connectionState}`
        };
    }
  }

  private extractServerIdFromState(state: string | null): string | null {
    if (!state) return null;
    const parts = state.split(".");
    return parts.length === 2 ? parts[1] : null;
  }

  isCallbackRequest(req: Request): boolean {
    if (req.method !== "GET") {
      return false;
    }

    const url = new URL(req.url);
    const state = url.searchParams.get("state");
    const serverId = this.extractServerIdFromState(state);
    if (!serverId) {
      return false;
    }

    // Match by server ID AND verify the request origin + pathname matches the registered callback URL.
    // This prevents unrelated GET requests with a `state` param from being intercepted.
    const servers = this.getServersFromStorage();
    return servers.some((server) => {
      if (server.id !== serverId) return false;
      try {
        const storedUrl = new URL(server.callback_url);
        return (
          storedUrl.origin === url.origin && storedUrl.pathname === url.pathname
        );
      } catch {
        return false;
      }
    });
  }

  private validateCallbackRequest(
    req: Request
  ):
    | { valid: true; serverId: string; code: string; state: string }
    | { valid: false; serverId?: string; state?: string; error: string } {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    // Early validation - return errors because we can't identify the connection
    if (!state) {
      return {
        valid: false,
        error: "Unauthorized: no state provided"
      };
    }

    const serverId = this.extractServerIdFromState(state);
    if (!serverId) {
      return {
        valid: false,
        error:
          "No serverId found in state parameter. Expected format: {nonce}.{serverId}"
      };
    }

    if (error) {
      return {
        serverId: serverId,
        state: state,
        valid: false,
        error: errorDescription || error
      };
    }

    if (!code) {
      return {
        serverId: serverId,
        state: state,
        valid: false,
        error: "Unauthorized: no code provided"
      };
    }

    const servers = this.getServersFromStorage();
    const serverExists = servers.some((server) => server.id === serverId);
    if (!serverExists) {
      return {
        serverId: serverId,
        valid: false,
        error: `No server found with id "${serverId}". Was the request matched with \`isCallbackRequest()\`?`
      };
    }

    if (this.mcpConnections[serverId] === undefined) {
      return {
        serverId: serverId,
        valid: false,
        error: `No connection found for serverId "${serverId}".`
      };
    }

    return {
      valid: true,
      serverId,
      code: code,
      state: state
    };
  }

  async handleCallbackRequest(req: Request): Promise<MCPOAuthCallbackResult> {
    const validation = this.validateCallbackRequest(req);

    if (!validation.valid) {
      const conn = validation.serverId
        ? this.mcpConnections[validation.serverId]
        : undefined;
      if (validation.serverId && conn) {
        if (this.isAuthAcceptedConnection(conn)) {
          const authProvider = conn.options.transport.authProvider;
          if (validation.state && authProvider) {
            authProvider.serverId = validation.serverId;
            await this.consumeStaleOAuthState(
              validation.serverId,
              authProvider,
              validation.state
            );
          }
          return this.oauthCallbackSuccess(validation.serverId, conn);
        }
        // Only a callback carrying a genuine state nonce may fail the
        // connection; a stray or invalid callback must not alter the
        // connection state machine.
        const authProvider = conn.options.transport.authProvider;
        if (
          validation.state &&
          authProvider &&
          !(await this.hasRedeemableOAuthState(
            validation.serverId,
            authProvider,
            validation.state
          ))
        ) {
          return this.ignoreUnverifiedCallback(
            validation.serverId,
            validation.error
          );
        }
        return this.failConnection(validation.serverId, validation.error);
      }

      return {
        serverId: validation.serverId,
        authSuccess: false,
        authError: validation.error
      };
    }

    const { serverId, code, state } = validation;
    const conn = this.mcpConnections[serverId]; // We have a valid connection - all errors from here should fail the connection

    try {
      if (!conn.options.transport.authProvider) {
        throw new Error(
          "Trying to finalize authentication for a server connection without an authProvider"
        );
      }

      const authProvider = conn.options.transport.authProvider;
      authProvider.serverId = serverId;

      // Two-phase state validation: check first (non-destructive), consume later
      // This prevents DoS attacks where attacker consumes valid state before legitimate callback
      const stateValidation = await authProvider.checkState(state);
      if (!stateValidation.valid) {
        if (this.isAuthAcceptedConnection(conn)) {
          await this.consumeStaleOAuthState(serverId, authProvider, state);
          return this.oauthCallbackSuccess(serverId, conn);
        }
        // Same rule as the invalid branch above: a callback whose nonce
        // cannot be verified must not alter the connection state machine.
        return this.ignoreUnverifiedCallback(
          serverId,
          stateValidation.error || "Invalid state"
        );
      }

      // A stale popup can complete after another callback already exchanged tokens.
      // Treat it as success, but consume its state so it cannot be replayed.
      if (this.isAuthAcceptedConnection(conn)) {
        await this.consumeStaleOAuthState(serverId, authProvider, state);
        return this.oauthCallbackSuccess(serverId, conn);
      }

      if (
        conn.connectionState !== MCPConnectionState.AUTHENTICATING &&
        conn.connectionState !== MCPConnectionState.FAILED
      ) {
        throw new Error(
          `Failed to authenticate from "${conn.connectionState}" state`
        );
      }

      // A genuine callback can recover a flow that previously entered FAILED.
      conn.connectionState = MCPConnectionState.CONNECTING;
      await authProvider.consumeState(state);
      await this.completeAuthorizationAndCleanupVerifier(
        serverId,
        conn,
        authProvider,
        state,
        code
      );
      this.updateStoredSessionId(serverId, conn.sessionId);
      const result = this.oauthCallbackSuccess(serverId, conn);
      this._onServerStateChanged.fire();

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.failConnection(serverId, message);
    }
  }

  /**
   * Discover server capabilities if connection is in CONNECTED or READY state.
   * Transitions to DISCOVERING then READY (or CONNECTED on error).
   * Can be called to refresh server capabilities (e.g., from a UI refresh button).
   *
   * If called while a previous discovery is in-flight for the same server,
   * the previous discovery will be aborted.
   *
   * @param serverId The server ID to discover
   * @param options Optional configuration
   * @param options.timeoutMs Timeout in milliseconds (default: 30000)
   * @returns Result with current state and optional error, or undefined if connection not found
   */
  async discoverIfConnected(
    serverId: string,
    options: { timeoutMs?: number } = {}
  ): Promise<MCPDiscoverResult | undefined> {
    const conn = this.mcpConnections[serverId];
    if (!conn) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:discover",
        payload: {},
        timestamp: Date.now()
      });
      return undefined;
    }

    // Delegate to connection's discover method which handles cancellation and timeout
    const result = await conn.discover(options);
    if (!result.success && result.reason === "stale-session") {
      return this._recoverStaleSession(conn, serverId, options);
    }
    this._onServerStateChanged.fire();

    return this._toDiscoverResult(conn, result);
  }

  private _toDiscoverResult(
    conn: MCPClientConnection,
    result: MCPDiscoveryResult
  ): MCPDiscoverResult {
    return result.success
      ? { success: true, state: conn.connectionState }
      : { success: false, error: result.error, state: conn.connectionState };
  }

  private async _recoverStaleSession(
    conn: MCPClientConnection,
    serverId: string,
    options: { timeoutMs?: number }
  ): Promise<MCPDiscoverResult> {
    conn.clearResumedSession();
    this.updateStoredSessionId(serverId, undefined);

    let connectResult: MCPConnectionResult;
    try {
      connectResult = await this.connectToServer(serverId);
    } catch (error) {
      return {
        success: false,
        error: toErrorMessage(error),
        state: conn.connectionState
      };
    }

    if (connectResult.state !== MCPConnectionState.CONNECTED) {
      return {
        success: false,
        error:
          connectResult.state === MCPConnectionState.FAILED
            ? connectResult.error
            : `Connection in ${connectResult.state} state after session re-initialization`,
        state: conn.connectionState
      };
    }

    const result = await conn.discover(options);
    this._onServerStateChanged.fire();

    return this._toDiscoverResult(conn, result);
  }

  /**
   * Establish connection in the background after OAuth completion.
   * This method connects to the server and discovers its capabilities.
   * The connection is automatically tracked so that `waitForConnections()`
   * will include it.
   * @param serverId The server ID to establish connection for
   */
  async establishConnection(serverId: string): Promise<void> {
    const promise = this._doEstablishConnection(serverId);
    this._trackConnection(serverId, promise);
    return promise;
  }

  private async _doEstablishConnection(serverId: string): Promise<void> {
    const conn = this.mcpConnections[serverId];
    if (!conn) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:preconnect",
        payload: { serverId },
        timestamp: Date.now()
      });
      return;
    }

    // Skip if already discovering or ready - prevents duplicate work
    if (
      conn.connectionState === MCPConnectionState.DISCOVERING ||
      conn.connectionState === MCPConnectionState.READY
    ) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:connect",
        payload: {
          url: conn.url.toString(),
          transport: conn.options.transport.type || "unknown",
          state: conn.connectionState
        },
        timestamp: Date.now()
      });
      return;
    }

    const retry = this.getServerRetryOptions(serverId);
    const connectResult = await this._connectWithRetry(serverId, retry);
    this._onServerStateChanged.fire();

    if (connectResult.state === MCPConnectionState.CONNECTED) {
      await this.discoverIfConnected(serverId);
    }

    this._onObservabilityEvent.fire({
      type: "mcp:client:connect",
      payload: {
        url: conn.url.toString(),
        transport: conn.options.transport.type || "unknown",
        state: conn.connectionState
      },
      timestamp: Date.now()
    });
  }

  /**
   * Configure OAuth callback handling
   * @param config OAuth callback configuration
   */
  configureOAuthCallback(config: MCPClientOAuthCallbackConfig): void {
    this._oauthCallbackConfig = config;
  }

  /**
   * Configure handling for server-initiated `elicitation/create` requests.
   *
   * The handler is held in memory only and applied to every MCP connection
   * created or restored by this manager. Call this before registering
   * connections when you want the initial MCP handshake to advertise
   * handler-driven form- and url-mode elicitation. Existing active connections
   * keep their negotiated capabilities until they reconnect.
   *
   * The advertised modes are persisted with each stored server, so
   * connections restored after hibernation re-advertise them at the handshake
   * even when this is called later in the wake-up (e.g. from onStart) — the
   * handlers attach to the live connections as soon as this runs.
   *
   * Pass undefined to clear the handler.
   *
   * @param handlers Elicitation handlers keyed by mode, each scoped with the server id that sent the request
   */
  configureElicitationHandlers(handlers?: MCPClientElicitationHandlers): void {
    this._elicitationHandlers =
      handlers && (handlers.form || handlers.url) ? handlers : undefined;
    this.persistAdvertisedCapabilities();
    for (const [id, connection] of Object.entries(this.mcpConnections)) {
      connection.configureElicitationHandlers(
        this.scopedElicitationHandlers(id)
      );
    }
  }

  /** Client capabilities advertised from the currently configured handlers. */
  private advertisedHandlerCapabilities(): ClientCapabilities | undefined {
    const elicitation = elicitationCapabilitiesFromHandlers(
      this._elicitationHandlers
    );
    return elicitation ? { elicitation } : undefined;
  }

  /**
   * Record the handler-derived capabilities on every stored server row so a
   * restore after hibernation re-advertises them before the handlers
   * themselves are reconfigured.
   */
  private persistAdvertisedCapabilities(): void {
    const capabilities = this.advertisedHandlerCapabilities();
    for (const server of this.getServersFromStorage()) {
      const options: MCPServerOptions = server.server_options
        ? JSON.parse(server.server_options)
        : {};
      if (
        JSON.stringify(options.capabilities) === JSON.stringify(capabilities)
      ) {
        continue;
      }
      options.capabilities = capabilities;
      this.saveServerToStorage({
        ...server,
        server_options: JSON.stringify(options)
      });
    }
  }

  /**
   * Get the current OAuth callback configuration
   * @returns The current OAuth callback configuration
   */
  getOAuthCallbackConfig(): MCPClientOAuthCallbackConfig | undefined {
    return this._oauthCallbackConfig;
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of tools
   */
  listTools(filter?: MCPServerFilter): NamespacedData["tools"] {
    return getNamespacedData(this.filterConnections(filter), "tools");
  }

  /**
   * Convert connected MCP tools for the AI SDK. Converted schemas are reused
   * while a live connection retains the same catalog array and schema-source
   * identities; tool records and execute closures are rebuilt on every call.
   *
   * @param filter - Optional filter to scope results to specific servers
   * @returns a set of tools that you can use with the AI SDK
   */
  getAITools(filter?: MCPServerFilter): MCPAIToolSet {
    const connections = this.filterConnections(filter);
    const entries: [string, MCPAITool][] = [];

    for (const [serverId, conn] of Object.entries(connections)) {
      if (
        conn.connectionState !== MCPConnectionState.READY &&
        conn.connectionState !== MCPConnectionState.AUTHENTICATING
      ) {
        console.warn(
          `[getAITools] WARNING: Reading tools from connection ${serverId} in state "${conn.connectionState}". Tools may not be loaded yet.`
        );
      }

      const catalog = conn.tools;
      let cache = this._aiToolSchemas.get(conn);
      if (!cache || cache.catalog !== catalog) {
        cache = { catalog, converted: [] };
        this._aiToolSchemas.set(conn, cache);
      }

      for (const [index, tool] of catalog.entries()) {
        const toolName = tool.name;
        try {
          const sourceInputSchema = tool.inputSchema;
          const sourceOutputSchema = tool.outputSchema;
          let slot = cache.converted[index];
          if (
            !slot ||
            slot.tool !== tool ||
            slot.inputSchema !== sourceInputSchema ||
            slot.outputSchema !== sourceOutputSchema
          ) {
            try {
              slot = {
                status: "converted",
                tool,
                inputSchema: sourceInputSchema,
                outputSchema: sourceOutputSchema,
                converted: {
                  inputSchema: sourceInputSchema
                    ? z.fromJSONSchema(
                        sourceInputSchema as Parameters<
                          typeof z.fromJSONSchema
                        >[0]
                      )
                    : z.fromJSONSchema({ type: "object" }),
                  outputSchema: sourceOutputSchema
                    ? z.fromJSONSchema(
                        sourceOutputSchema as Parameters<
                          typeof z.fromJSONSchema
                        >[0]
                      )
                    : undefined
                }
              };
            } catch (error) {
              const errorText = String(error);
              cache.converted[index] = {
                status: "failed",
                tool,
                inputSchema: sourceInputSchema,
                outputSchema: sourceOutputSchema,
                error: errorText
              };
              console.warn(
                `[getAITools] Skipping tool "${toolName}" from "${serverId}": ${errorText}`
              );
              continue;
            }
            cache.converted[index] = slot;
          }

          if (slot.status === "failed") continue;

          const toolKey = `tool_${serverId.replace(/-/g, "")}_${toolName}`;
          const title = tool.title ?? tool.annotations?.title;
          const description = tool.description;
          entries.push([
            toolKey,
            {
              description,
              title,
              execute: async (args) => {
                const result = await this.callTool({
                  arguments: args,
                  name: toolName,
                  serverId
                });
                if (result.isError) {
                  const content = result.content as
                    | Array<{ type: string; text?: string }>
                    | undefined;
                  const textContent = content?.[0];
                  const message =
                    textContent?.type === "text" && textContent.text
                      ? textContent.text
                      : "Tool call failed";
                  throw new Error(message);
                }
                return result;
              },
              inputSchema: slot.converted.inputSchema,
              outputSchema: slot.converted.outputSchema
            }
          ]);
        } catch (error) {
          console.warn(
            `[getAITools] Skipping tool "${toolName}" from "${serverId}": ${error}`
          );
        }
      }

      // Release removed slots when a public catalog array is spliced in place.
      cache.converted.length = catalog.length;
    }

    return Object.fromEntries(entries);
  }

  /**
   * @deprecated this has been renamed to getAITools(), and unstable_getAITools will be removed in the next major version
   * @param filter - Optional filter to scope results to specific servers
   * @returns a set of tools that you can use with the AI SDK
   */
  unstable_getAITools(filter?: MCPServerFilter): MCPAIToolSet {
    if (!this._didWarnAboutUnstableGetAITools) {
      this._didWarnAboutUnstableGetAITools = true;
      console.warn(
        "unstable_getAITools is deprecated, use getAITools instead. unstable_getAITools will be removed in the next major version."
      );
    }
    return this.getAITools(filter);
  }

  /**
   * Closes all active in-memory connections to MCP servers.
   *
   * Note: This only closes the transport connections - it does NOT remove
   * servers from storage. Servers will still be listed and their callback
   * URLs will still match incoming OAuth requests.
   *
   * Use removeServer() instead if you want to fully clean up a server
   * (closes connection AND removes from storage).
   */
  private cleanupClosedConnection(id: string): void {
    this.updateStoredSessionId(id, undefined);

    const store = this._connectionDisposables.get(id);
    if (store) store.dispose();
    this._connectionDisposables.delete(id);

    delete this.mcpConnections[id];
  }

  async closeAllConnections() {
    const ids = Object.keys(this.mcpConnections);

    // Clear all pending connection tracking
    this._pendingConnections.clear();

    // Cancel all in-flight discoveries
    for (const id of ids) {
      this.mcpConnections[id].cancelDiscovery();
    }

    const results = await Promise.allSettled(
      ids.map(async (id) => {
        try {
          await this.mcpConnections[id].close();
        } finally {
          this.cleanupClosedConnection(id);
        }
      })
    );

    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Failed to close one or more MCP connections"
      );
    }
  }

  /**
   * Closes a connection to an MCP server
   * @param id The id of the connection to close
   */
  async closeConnection(id: string) {
    const connection = this.mcpConnections[id];
    if (!connection) {
      throw new Error(`Connection with id "${id}" does not exist.`);
    }

    // Cancel any in-flight discovery
    connection.cancelDiscovery();

    // Remove from pending so waitForConnections() doesn't block on a closed server
    this._pendingConnections.delete(id);

    try {
      await connection.close();
    } finally {
      this.cleanupClosedConnection(id);
    }
  }

  async addMcpServer<T extends McpAgent>(
    serverName: string,
    binding: DurableObjectNamespace<T>,
    options?: AddRpcMcpServerOptions
  ): Promise<{ id: string; state: typeof MCPConnectionState.READY }>;
  async addMcpServer(
    serverName: string,
    url: string,
    callbackHostOrOptions?: string | AddMcpServerOptions,
    agentsPrefix?: string,
    options?: {
      client?: ConstructorParameters<typeof Client>[1];
      transport?: { headers?: HeadersInit; type?: TransportType };
    }
  ): Promise<
    | {
        id: string;
        state: typeof MCPConnectionState.AUTHENTICATING;
        authUrl: string;
      }
    | { id: string; state: typeof MCPConnectionState.READY }
  >;
  async addMcpServer<T extends McpAgent>(
    serverName: string,
    urlOrBinding: string | DurableObjectNamespace<T>,
    callbackHostOrOptions?:
      | string
      | AddMcpServerOptions
      | AddRpcMcpServerOptions,
    agentsPrefix?: string,
    legacyOptions?: {
      client?: ConstructorParameters<typeof Client>[1];
      transport?: { headers?: HeadersInit; type?: TransportType };
    }
  ): Promise<
    | {
        id: string;
        state: typeof MCPConnectionState.AUTHENTICATING;
        authUrl: string;
      }
    | {
        id: string;
        state: typeof MCPConnectionState.READY;
        authUrl?: undefined;
      }
  > {
    const host = this._host;
    const isHttpTransport = typeof urlOrBinding === "string";
    const normalizedUrl = isHttpTransport
      ? new URL(urlOrBinding).href
      : undefined;

    let requestedId: string | undefined;
    if (
      typeof callbackHostOrOptions === "object" &&
      callbackHostOrOptions !== null &&
      typeof callbackHostOrOptions.id === "string"
    ) {
      requestedId = normalizeServerId(callbackHostOrOptions.id);
    }

    const allServers = this.listServers();
    const existingServer = allServers.find(
      (server) =>
        server.name === serverName &&
        (!isHttpTransport || new URL(server.server_url).href === normalizedUrl)
    );

    if (requestedId) {
      const idConflict = allServers.find((server) => {
        if (server.id !== requestedId) return false;
        if (server.name !== serverName) return true;
        return (
          isHttpTransport && new URL(server.server_url).href !== normalizedUrl
        );
      });
      if (idConflict) {
        throw new Error(
          `MCP server id "${requestedId}" is already in use by server "${idConflict.name}" (${idConflict.server_url}). ` +
            "Stable ids must be unique per (name, url)."
        );
      }

      if (existingServer && existingServer.id !== requestedId) {
        await this.migrateServerId(
          existingServer.id,
          requestedId,
          host.getAgentInstanceName()
        );
        existingServer.id = requestedId;
      }
    }

    if (existingServer && this.mcpConnections[existingServer.id]) {
      const connection = this.mcpConnections[existingServer.id];
      if (connection.connectionState === MCPConnectionState.AUTHENTICATING) {
        const authProvider = connection.options.transport.authProvider;
        const authUrl =
          (await this._redeemableAuthUrl(
            existingServer.id,
            authProvider?.authUrl,
            authProvider
          )) ??
          (await this._redeemableAuthUrl(
            existingServer.id,
            existingServer.auth_url,
            authProvider
          ));
        if (authUrl) {
          return {
            id: existingServer.id,
            state: MCPConnectionState.AUTHENTICATING,
            authUrl
          };
        }

        const reconnectResult = await this.connectToServer(existingServer.id);
        if (reconnectResult.state === MCPConnectionState.AUTHENTICATING) {
          if (!reconnectResult.authUrl) {
            throw new Error("OAuth configuration incomplete: missing authUrl");
          }
          return {
            id: existingServer.id,
            state: reconnectResult.state,
            authUrl: reconnectResult.authUrl
          };
        }
        if (reconnectResult.state === MCPConnectionState.CONNECTED) {
          const discoverResult = await this.discoverIfConnected(
            existingServer.id
          );
          if (!discoverResult?.success) {
            throw new Error(
              `Failed to discover MCP server capabilities: ${discoverResult?.error ?? "connection not found"}`
            );
          }
          return {
            id: existingServer.id,
            state: MCPConnectionState.READY
          };
        }
        throw new Error(
          `Failed to connect to MCP server at ${normalizedUrl}: ${reconnectResult.error}`
        );
      }
      if (connection.connectionState === MCPConnectionState.FAILED) {
        throw new Error(
          `MCP server "${serverName}" is in failed state: ${connection.connectionError}`
        );
      }
      return { id: existingServer.id, state: MCPConnectionState.READY };
    }

    if (typeof urlOrBinding !== "string") {
      const rpcOptions = callbackHostOrOptions as
        | AddRpcMcpServerOptions
        | undefined;
      const normalizedName = serverName.toLowerCase().replace(/\s+/g, "-");
      const reconnectId = requestedId ?? existingServer?.id;
      const { id } = await this.connect(`${RPC_DO_PREFIX}${normalizedName}`, {
        reconnect: reconnectId ? { id: reconnectId } : undefined,
        transport: {
          type: "rpc",
          namespace:
            urlOrBinding as unknown as DurableObjectNamespace<McpAgent>,
          name: normalizedName,
          props: rpcOptions?.props
        }
      });

      const connection = this.mcpConnections[id];
      if (connection?.connectionState === MCPConnectionState.CONNECTED) {
        const discovery = await this.discoverIfConnected(id);
        if (discovery && !discovery.success) {
          throw new Error(
            `Failed to discover MCP server capabilities: ${discovery.error}`
          );
        }
      } else if (connection?.connectionState === MCPConnectionState.FAILED) {
        throw new Error(
          `Failed to connect to MCP server "${serverName}" via RPC: ${connection.connectionError}`
        );
      }

      const bindingName = this.findBindingNameForNamespace(urlOrBinding);
      if (bindingName) {
        this.saveRpcServerToStorage(
          id,
          serverName,
          normalizedName,
          bindingName,
          rpcOptions?.props
        );
      }
      return { id, state: MCPConnectionState.READY };
    }

    const httpOptions = callbackHostOrOptions as
      | string
      | AddMcpServerOptions
      | undefined;
    let callbackHost: string | undefined;
    let callbackPath: string | undefined;
    let resolvedAgentsPrefix: string;
    let options:
      | {
          client?: ConstructorParameters<typeof Client>[1];
          transport?: { headers?: HeadersInit; type?: TransportType };
          retry?: RetryOptions;
        }
      | undefined;

    if (typeof httpOptions === "object" && httpOptions !== null) {
      callbackHost = httpOptions.callbackHost;
      callbackPath = httpOptions.callbackPath;
      resolvedAgentsPrefix = httpOptions.agentsPrefix ?? "agents";
      options = {
        client: httpOptions.client,
        transport: httpOptions.transport,
        retry: httpOptions.retry
      };
    } else {
      callbackHost = httpOptions;
      resolvedAgentsPrefix = agentsPrefix ?? "agents";
      options = legacyOptions;
    }

    if (!host.getSendIdentityOnConnect() && callbackHost && !callbackPath) {
      throw new Error(
        "callbackPath is required in addMcpServer options when sendIdentityOnConnect is false — " +
          "the default callback URL would expose the instance name. " +
          "Provide a callbackPath and route the callback request to this agent via getAgentByName."
      );
    }

    if (!callbackHost) {
      const context = host.getRequestContext();
      const contextUrl = context.request?.url ?? context.connectionUri;
      if (contextUrl) {
        const url = new URL(contextUrl);
        callbackHost = `${url.protocol}//${url.host}`;
      }
    }

    let callbackUrl: string | undefined;
    if (callbackHost) {
      const normalizedHost = callbackHost.replace(/\/$/, "");
      callbackUrl = callbackPath
        ? `${normalizedHost}/${callbackPath.replace(/^\//, "")}`
        : `${normalizedHost}/${resolvedAgentsPrefix}/${camelCaseToKebabCase(host.getAgentClassName())}/${host.getAgentInstanceName()}/callback`;
    }

    const id = requestedId ?? existingServer?.id ?? nanoid(8);
    let authProvider: AgentMcpOAuthProvider | undefined;
    if (callbackUrl) {
      authProvider = this._host.createAuthProvider(callbackUrl);
      authProvider.serverId = id;
    }

    const transportType: TransportType = options?.transport?.type ?? "auto";
    let headerTransportOptions: SSEClientTransportOptions = {};
    if (options?.transport?.headers) {
      const headers = options.transport.headers;
      headerTransportOptions = {
        eventSourceInit: {
          fetch: (url, init) => fetch(url, { ...init, headers })
        },
        requestInit: { headers }
      };
    }

    await this.registerServer(id, {
      url: normalizedUrl as string,
      name: serverName,
      callbackUrl,
      client: options?.client,
      transport: {
        ...headerTransportOptions,
        authProvider,
        type: transportType
      },
      retry: options?.retry
    });

    const result = await this.connectToServer(id);
    if (result.state === MCPConnectionState.FAILED) {
      throw new Error(
        `Failed to connect to MCP server at ${normalizedUrl}: ${result.error}`
      );
    }
    if (result.state === MCPConnectionState.AUTHENTICATING) {
      if (!callbackUrl) {
        throw new Error(
          "This MCP server requires OAuth authentication. " +
            "Provide callbackHost in addMcpServer options to enable the OAuth flow."
        );
      }
      return { id, state: result.state, authUrl: result.authUrl };
    }

    const discovery = await this.discoverIfConnected(id);
    if (discovery && !discovery.success) {
      throw new Error(
        `Failed to discover MCP server capabilities: ${discovery.error}`
      );
    }
    return { id, state: MCPConnectionState.READY };
  }

  private findBindingNameForNamespace(
    namespace: DurableObjectNamespace
  ): string | undefined {
    const env = this._host.getEnv();
    for (const [name, value] of Object.entries(env)) {
      if (value === namespace) return name;
    }
    return undefined;
  }

  /**
   * Remove an MCP server - closes connection if active and removes from storage.
   */
  async removeServer(serverId: string): Promise<void> {
    if (this.mcpConnections[serverId]) {
      try {
        await this.closeConnection(serverId);
      } catch (_e) {
        // Ignore errors when closing
      }
    }
    this.removeServerFromStorage(serverId);
    this._onServerStateChanged.fire();
  }

  /**
   * List all MCP servers from storage
   */
  listServers(): MCPServerRow[] {
    return this.getServersFromStorage();
  }

  /** Snapshot registered servers and discovered capabilities for Agent clients. */
  getMcpServers(): MCPServersState {
    const state: MCPServersState = {
      prompts: this.listPrompts(),
      resources: this.listResources(),
      servers: {},
      tools: this.listTools()
    };

    for (const server of this.listServers()) {
      const connection = this.mcpConnections[server.id];
      const defaultState: "authenticating" | "not-connected" =
        !connection && server.auth_url ? "authenticating" : "not-connected";
      state.servers[server.id] = {
        auth_url: server.auth_url,
        capabilities: connection?.serverCapabilities ?? null,
        error: sanitizeErrorString(connection?.connectionError ?? null),
        instructions: connection?.instructions ?? null,
        name: server.name,
        server_url: server.server_url,
        state: connection?.connectionState ?? defaultState
      };
    }

    return state;
  }

  /**
   * Validate that a persisted OAuth authorization URL is still redeemable —
   * i.e. its `state` parameter is still valid — before handing it back to a
   * caller. Stale URLs would send the user through a flow whose callback the
   * provider rejects.
   */
  private async _redeemableAuthUrl(
    serverId: string,
    authUrl: string | null | undefined,
    authProvider: AgentMcpOAuthProvider | undefined
  ): Promise<string | undefined> {
    if (!this._isAbsoluteHttpUrl(authUrl) || !authProvider) return;
    const state = new URL(authUrl).searchParams.get("state");
    if (!state) return authUrl;

    authProvider.serverId = serverId;
    try {
      return (await authProvider.checkState(state)).valid ? authUrl : undefined;
    } catch {
      return undefined;
    }
  }

  private _isAbsoluteHttpUrl(
    value: string | null | undefined
  ): value is string {
    if (!value) return false;
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  /**
   * Dispose the manager and all resources.
   */
  async dispose(): Promise<void> {
    try {
      await this.closeAllConnections();
    } finally {
      // Dispose manager-level emitters
      this._onServerStateChanged.dispose();
      this._onObservabilityEvent.dispose();
    }
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of prompts
   */
  listPrompts(filter?: MCPServerFilter): NamespacedData["prompts"] {
    return getNamespacedData(this.filterConnections(filter), "prompts");
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of resources
   */
  listResources(filter?: MCPServerFilter): NamespacedData["resources"] {
    return getNamespacedData(this.filterConnections(filter), "resources");
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of resource templates
   */
  listResourceTemplates(
    filter?: MCPServerFilter
  ): NamespacedData["resourceTemplates"] {
    return getNamespacedData(
      this.filterConnections(filter),
      "resourceTemplates"
    );
  }

  /**
   * Namespaced version of callTool
   */
  async callTool(
    params: CallToolRequest["params"] & { serverId: string },
    resultSchema?:
      | typeof CallToolResultSchema
      | typeof CompatibilityCallToolResultSchema,
    options?: RequestOptions
  ) {
    const { serverId, ...mcpParams } = params;
    const unqualifiedName = mcpParams.name.replace(`${serverId}.`, "");
    return this.mcpConnections[serverId].client.callTool(
      {
        ...mcpParams,
        name: unqualifiedName
      },
      resultSchema,
      options
    );
  }

  /**
   * Namespaced version of readResource
   */
  readResource(
    params: ReadResourceRequest["params"] & { serverId: string },
    options: RequestOptions
  ) {
    return this.mcpConnections[params.serverId].client.readResource(
      params,
      options
    );
  }

  /**
   * Namespaced version of getPrompt
   */
  getPrompt(
    params: GetPromptRequest["params"] & { serverId: string },
    options: RequestOptions
  ) {
    return this.mcpConnections[params.serverId].client.getPrompt(
      params,
      options
    );
  }
}

type NamespacedData = {
  tools: (Tool & { serverId: string })[];
  prompts: (Prompt & { serverId: string })[];
  resources: (Resource & { serverId: string })[];
  resourceTemplates: (ResourceTemplate & { serverId: string })[];
};

export function getNamespacedData<T extends keyof NamespacedData>(
  mcpClients: Record<string, MCPClientConnection>,
  type: T
): NamespacedData[T] {
  const sets = Object.entries(mcpClients).map(([name, conn]) => {
    return { data: conn[type], name };
  });

  const namespacedData = sets.flatMap(({ name: serverId, data }) => {
    return data.map((item) => {
      return {
        ...item,
        // we add a serverId so we can easily pull it out and send the tool call to the right server
        serverId
      };
    });
  });

  return namespacedData as NamespacedData[T]; // Type assertion needed due to TS limitations with conditional return types
}
