import type {
  ClientCapabilities,
  DiscoverResult
} from "@modelcontextprotocol/client";
import {
  decodeMcpServerOptions,
  encodeMcpServerOptions,
  withMcpSession,
  type MCPServerRow,
  type PersistedMcpServerOptions
} from "./storage";
import { RPC_DO_PREFIX } from "../rpc";

const SERVER_COLUMNS =
  "id, name, server_url, client_id, auth_url, callback_url, server_options";

/** Outcome of renaming a stored server. */
export type ServerRenameResult = "renamed" | "missing" | "collision";

/** A resumable MCP session persisted with its server. */
export type StoredMcpSession = {
  readonly id: string;
  readonly protocolVersion: string;
  readonly discoverResult?: DiscoverResult;
};

/**
 * The durable MCP server catalog: one `cf_agents_mcp_servers` row per
 * registered server. Every SQL statement the client manager runs lives here,
 * and `server_options` is read and written only through the storage codec.
 * The table itself is created by `ensureMcpServerTable` during startup.
 */
export class McpServerStore {
  /**
   * @param storage - The Durable Object storage holding the catalog table.
   */
  constructor(private readonly storage: DurableObjectStorage) {}

  #exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    return [...this.storage.sql.exec<T>(query, ...bindings)];
  }

  /** Every stored server, in table order. */
  list(): MCPServerRow[] {
    return this.#exec<MCPServerRow>(
      `SELECT ${SERVER_COLUMNS} FROM cf_agents_mcp_servers`
    );
  }

  /** Stored servers reached over Durable Object RPC (`rpc://` URLs). */
  listRpc(): MCPServerRow[] {
    return this.list().filter((server) =>
      server.server_url.startsWith(RPC_DO_PREFIX)
    );
  }

  /** One stored server, or undefined when it is not registered. */
  get(id: string): MCPServerRow | undefined {
    return this.#exec<MCPServerRow>(
      `SELECT ${SERVER_COLUMNS} FROM cf_agents_mcp_servers WHERE id = ?`,
      id
    )[0];
  }

  /** Insert or replace one server row. */
  save(server: MCPServerRow): void {
    this.#exec(
      `INSERT OR REPLACE INTO cf_agents_mcp_servers (${SERVER_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      server.id,
      server.name,
      server.server_url,
      server.client_id ?? null,
      server.auth_url ?? null,
      server.callback_url,
      server.server_options ?? null
    );
  }

  /** Delete one server row. */
  remove(id: string): void {
    this.#exec("DELETE FROM cf_agents_mcp_servers WHERE id = ?", id);
  }

  /** Move a row to a new primary key, refusing to overwrite another row. */
  rename(oldId: string, newId: string): ServerRenameResult {
    if (!this.get(oldId)) return "missing";
    if (this.get(newId)) return "collision";
    this.#exec(
      "UPDATE cf_agents_mcp_servers SET id = ? WHERE id = ?",
      newId,
      oldId
    );
    return "renamed";
  }

  /** The decoded `server_options` of one server. */
  options(id: string): PersistedMcpServerOptions | undefined {
    const row = this.get(id);
    if (!row?.server_options) return undefined;
    return decodeMcpServerOptions(row.server_options);
  }

  /** Record the authorization URL and OAuth client id a flow is waiting on. */
  setAuthContinuation(
    id: string,
    authUrl: string,
    clientId: string | undefined
  ): void {
    const row = this.get(id);
    if (!row) return;
    this.save({ ...row, auth_url: authUrl, client_id: clientId ?? null });
  }

  /** Forget the authorization URL of one server. */
  clearAuthUrl(id: string): void {
    this.#exec(
      "UPDATE cf_agents_mcp_servers SET auth_url = NULL WHERE id = ?",
      id
    );
  }

  /** Persist, or with no session clear, the resumable session of a server. */
  setSession(id: string, session?: StoredMcpSession): void {
    const row = this.get(id);
    if (!row) return;
    const options = decodeMcpServerOptions(row.server_options);
    this.save({
      ...row,
      server_options: encodeMcpServerOptions(withMcpSession(options, session))
    });
  }

  /**
   * Clear the capabilities persisted on one server. The stamp is valid for
   * one successful restore: sessions that configure elicitation handlers
   * re-stamp every row, so a deploy that stops configuring them stops
   * advertising stale modes after its first connected wake.
   */
  clearCapabilities(id: string): void {
    const row = this.get(id);
    if (!row?.server_options) return;
    const options = decodeMcpServerOptions(row.server_options);
    if (!options.capabilities) return;
    options.capabilities = undefined;
    this.save({ ...row, server_options: encodeMcpServerOptions(options) });
  }

  /** Stamp the handler-derived capabilities on every stored server. */
  stampCapabilities(capabilities: ClientCapabilities | undefined): void {
    for (const row of this.list()) {
      const options = decodeMcpServerOptions(row.server_options);
      if (
        JSON.stringify(options.capabilities) === JSON.stringify(capabilities)
      ) {
        continue;
      }
      options.capabilities = capabilities;
      this.save({ ...row, server_options: encodeMcpServerOptions(options) });
    }
  }
}
