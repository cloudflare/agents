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
type ServerRenameResult = "renamed" | "missing" | "collision";

/**
 * Why a server stopped trying to connect on its own. Stored with the server
 * so a later wake shows the same failure instead of trying again; only an
 * explicit reconnect clears it.
 */
export type StoredServerFailure = {
  /**
   * `connect-failed`: connecting failed after its quick attempts.
   * `authorization-failed`: authorization was refused or denied.
   * `authorization-exhausted`: the server kept asking for the same
   * authorization past the step-up limit.
   */
  readonly reason:
    | "connect-failed"
    | "authorization-failed"
    | "authorization-exhausted";
  /** Human-readable message, shown as the connection error. */
  readonly message: string;
  /** When the failure was recorded, in epoch milliseconds. */
  readonly at: number;
};

/** A resumable MCP session persisted with its server. */
type StoredMcpSession = {
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

  #statusColumnsReady = false;

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

  /**
   * Insert one server row, or update every catalog column of an existing
   * one. A recorded failure is kept; registration clears it explicitly.
   */
  save(server: MCPServerRow): void {
    this.#exec(
      `INSERT INTO cf_agents_mcp_servers (${SERVER_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         server_url = excluded.server_url,
         client_id = excluded.client_id,
         auth_url = excluded.auth_url,
         callback_url = excluded.callback_url,
         server_options = excluded.server_options`,
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

  /**
   * Record the authorization URL and OAuth client id a flow is waiting on,
   * and whether it is a step-up on a grant the server already holds.
   */
  setAuthContinuation(
    id: string,
    authUrl: string,
    clientId: string | undefined,
    stepUp: boolean
  ): void {
    const row = this.get(id);
    if (!row) return;
    this.save({ ...row, auth_url: authUrl, client_id: clientId ?? null });
    this.#ensureStatusColumns();
    this.#exec(
      "UPDATE cf_agents_mcp_servers SET pending_step_up = ? WHERE id = ?",
      stepUp ? 1 : null,
      id
    );
  }

  /** Whether the flow a server waits on is a step-up on its current grant. */
  isPendingStepUp(id: string): boolean {
    this.#ensureStatusColumns();
    return (
      this.#exec<{ pending_step_up: number | null }>(
        "SELECT pending_step_up FROM cf_agents_mcp_servers WHERE id = ?",
        id
      )[0]?.pending_step_up === 1
    );
  }

  /** Forget the authorization URL of one server. */
  clearAuthUrl(id: string): void {
    this.#ensureStatusColumns();
    this.#exec(
      "UPDATE cf_agents_mcp_servers SET auth_url = NULL, pending_step_up = NULL WHERE id = ?",
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

  /** The failure recorded for one server, if it stopped trying. */
  failure(id: string): StoredServerFailure | undefined {
    this.#ensureStatusColumns();
    const value = this.#exec<{ failure: string | null }>(
      "SELECT failure FROM cf_agents_mcp_servers WHERE id = ?",
      id
    )[0]?.failure;
    if (!value) return undefined;
    try {
      return JSON.parse(value) as StoredServerFailure;
    } catch {
      return undefined;
    }
  }

  /** Record that one server stopped trying, and why. */
  setFailure(id: string, failure: StoredServerFailure): void {
    this.#ensureStatusColumns();
    this.#exec(
      "UPDATE cf_agents_mcp_servers SET failure = ? WHERE id = ?",
      JSON.stringify(failure),
      id
    );
  }

  /** Forget a recorded failure, so the server may connect again. */
  clearFailure(id: string): void {
    this.#ensureStatusColumns();
    this.#exec(
      "UPDATE cf_agents_mcp_servers SET failure = NULL WHERE id = ? AND failure IS NOT NULL",
      id
    );
  }

  /** Authorization rounds recorded for one server, as stored JSON. */
  authorizationRounds(id: string): unknown {
    this.#ensureStatusColumns();
    const value = this.#exec<{ authorization_rounds: string | null }>(
      "SELECT authorization_rounds FROM cf_agents_mcp_servers WHERE id = ?",
      id
    )[0]?.authorization_rounds;
    if (!value) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  /** Record, or with no value forget, the authorization rounds of a server. */
  setAuthorizationRounds(id: string, rounds: object | undefined): void {
    this.#ensureStatusColumns();
    this.#exec(
      "UPDATE cf_agents_mcp_servers SET authorization_rounds = ? WHERE id = ?",
      rounds === undefined ? null : JSON.stringify(rounds),
      id
    );
  }

  /**
   * Add the status columns (`failure`, `authorization_rounds`,
   * `pending_step_up`) on first use.
   * They are owned here rather than in `ensureMcpServerTable`, so the
   * catalog's base DDL (and the Agent schema snapshot built from it) stays
   * unchanged and objects that never use them never alter the table.
   */
  #ensureStatusColumns(): void {
    if (this.#statusColumnsReady) return;
    const present = new Set(
      this.#exec<{ name: string }>(
        "SELECT name FROM pragma_table_info('cf_agents_mcp_servers')"
      ).map((column) => column.name)
    );
    for (const [column, type] of [
      ["failure", "TEXT"],
      ["authorization_rounds", "TEXT"],
      ["pending_step_up", "INTEGER"]
    ] as const) {
      if (!present.has(column)) {
        this.#exec(
          `ALTER TABLE cf_agents_mcp_servers ADD COLUMN ${column} ${type}`
        );
      }
    }
    this.#statusColumnsReady = true;
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
