import { AsyncLocalStorage } from "node:async_hooks";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";

import type {
  Prompt,
  Resource,
  ServerCapabilities,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { parseCronExpression } from "cron-schedule";
import { nanoid } from "nanoid";
import {
  type Connection,
  type ConnectionContext,
  getServerByName,
  type PartyServerOptions,
  routePartykitRequest,
  Server,
  type WSMessage,
} from "partyserver";
import { camelCaseToKebabCase } from "./client";
import { MCPClientManager } from "./mcp/client";
// import type { MCPClientConnection } from "./mcp/client-connection";
import { DurableObjectOAuthClientProvider } from "./mcp/do-oauth-client-provider";

export type { Connection, ConnectionContext, WSMessage } from "partyserver";

/**
 * RPC request message from client
 */
export type RPCRequest = {
  type: "rpc";
  id: string;
  method: string;
  args: unknown[];
};

/**
 * State update message from client
 */
export type StateUpdateMessage = {
  type: "cf_agent_state";
  state: unknown;
};

/**
 * RPC response message to client
 */
export type RPCResponse = {
  type: "rpc";
  id: string;
} & (
  | {
      success: true;
      result: unknown;
      done?: false;
    }
  | {
      success: true;
      result: unknown;
      done: true;
    }
  | {
      success: false;
      error: string;
    }
);

/**
 * Type guard for RPC request messages
 */
function isRPCRequest(msg: unknown): msg is RPCRequest {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    msg.type === "rpc" &&
    "id" in msg &&
    typeof msg.id === "string" &&
    "method" in msg &&
    typeof msg.method === "string" &&
    "args" in msg &&
    Array.isArray((msg as RPCRequest).args)
  );
}

/**
 * Type guard for state update messages
 */
function isStateUpdateMessage(msg: unknown): msg is StateUpdateMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    msg.type === "cf_agent_state" &&
    "state" in msg
  );
}

/**
 * Metadata for a callable method
 */
export type CallableMetadata = {
  /** Optional description of what the method does */
  description?: string;
  /** Whether the method supports streaming responses */
  streaming?: boolean;
};

const callableMetadata = new Map<Function, CallableMetadata>();

/**
 * Decorator that marks a method as callable by clients
 * @param metadata Optional metadata about the callable method
 */
export function unstable_callable(metadata: CallableMetadata = {}) {
  return function callableDecorator<This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    // biome-ignore lint/correctness/noUnusedFunctionParameters: later
    context: ClassMethodDecoratorContext
  ) {
    if (!callableMetadata.has(target)) {
      callableMetadata.set(target, metadata);
    }

    return target;
  };
}

/**
 * Represents a scheduled task within an Agent
 * @template T Type of the payload data
 */
export type Schedule<T = string> = {
  /** Unique identifier for the schedule */
  id: string;
  /** Name of the method to be called */
  callback: string;
  /** Data to be passed to the callback */
  payload: T;
} & (
  | {
      /** Type of schedule for one-time execution at a specific time */
      type: "scheduled";
      /** Timestamp when the task should execute */
      time: number;
    }
  | {
      /** Type of schedule for delayed execution */
      type: "delayed";
      /** Timestamp when the task should execute */
      time: number;
      /** Number of seconds to delay execution */
      delayInSeconds: number;
    }
  | {
      /** Type of schedule for recurring execution based on cron expression */
      type: "cron";
      /** Timestamp for the next execution */
      time: number;
      /** Cron expression defining the schedule */
      cron: string;
    }
);

function getNextCronTime(cron: string) {
  const interval = parseCronExpression(cron);
  return interval.getNextDate();
}

/**
 * MCP Server state update message from server -> Client
 */
export type MCPServerMessage = {
  type: "cf_agent_mcp_servers";
  mcp: MCPServersState;
};

export type MCPServersState = {
  servers: {
    [id: string]: MCPServer;
  };
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
};

export type MCPServer = {
  name: string;
  server_url: string;
  auth_url: string | null;
  // This state is specifically about the temporary process of getting a token (if needed).
  // Scope outside of that can't be relied upon because when the DO sleeps, there's no way
  // to communicate a change to a non-ready state.
  state: "authenticating" | "connecting" | "ready" | "discovering" | "failed";
  instructions: string | null;
  capabilities: ServerCapabilities | null;
};

/**
 * MCP Server data stored in DO SQL for resuming MCP Server connections
 */
type MCPServerRow = {
  id: string;
  name: string;
  server_url: string;
  client_id: string | null;
  auth_url: string | null;
  callback_url: string;
  server_options: string;
};

const STATE_ROW_ID = "cf_state_row_id";
const STATE_WAS_CHANGED = "cf_state_was_changed";

const DEFAULT_STATE = {} as unknown;

const agentContext = new AsyncLocalStorage<{
  agent: Agent<unknown>;
  connection: Connection | undefined;
  request: Request | undefined;
}>();

export function getCurrentAgent<
  T extends Agent<unknown, unknown> = Agent<unknown, unknown>,
>(): {
  agent: T | undefined;
  connection: Connection | undefined;
  request: Request<unknown, CfProperties<unknown>> | undefined;
} {
  const store = agentContext.getStore() as
    | {
        agent: T;
        connection: Connection | undefined;
        request: Request<unknown, CfProperties<unknown>> | undefined;
      }
    | undefined;
  if (!store) {
    return {
      agent: undefined,
      connection: undefined,
      request: undefined,
    };
  }
  return store;
}

/**
 * Base class for creating Agent implementations
 * @template Env Environment type containing bindings
 * @template State State type to store within the Agent
 */
export class Agent<Env, State = unknown> extends Server<Env> {
  private _state = DEFAULT_STATE as State;

  private _ParentClass: typeof Agent<Env, State> =
    Object.getPrototypeOf(this).constructor;

  mcp: MCPClientManager = new MCPClientManager(this._ParentClass.name, "0.0.1");

  /**
   * Initial state for the Agent
   * Override to provide default state values
   */
  initialState: State = DEFAULT_STATE as State;

  /**
   * Current state of the Agent
   */
  get state(): State {
    if (this._state !== DEFAULT_STATE) {
      // state was previously set, and populated internal state
      return this._state;
    }
    // looks like this is the first time the state is being accessed
    // check if the state was set in a previous life
    const wasChanged = this.sql<{ state: "true" | undefined }>`
        SELECT state FROM cf_agents_state WHERE id = ${STATE_WAS_CHANGED}
      `;

    // ok, let's pick up the actual state from the db
    const result = this.sql<{ state: State | undefined }>`
      SELECT state FROM cf_agents_state WHERE id = ${STATE_ROW_ID}
    `;

    if (
      wasChanged[0]?.state === "true" ||
      // we do this check for people who updated their code before we shipped wasChanged
      result[0]?.state
    ) {
      const state = result[0]?.state as string; // could be null?

      this._state = JSON.parse(state);
      return this._state;
    }

    // ok, this is the first time the state is being accessed
    // and the state was not set in a previous life
    // so we need to set the initial state (if provided)
    if (this.initialState === DEFAULT_STATE) {
      // no initial state provided, so we return undefined
      return undefined as State;
    }
    // initial state provided, so we set the state,
    // update db and return the initial state
    this.setState(this.initialState);
    return this.initialState;
  }

  /**
   * Agent configuration options
   */
  static options = {
    /** Whether the Agent should hibernate when inactive */
    hibernate: true, // default to hibernate
  };

  /**
   * Execute SQL queries against the Agent's database
   * @template T Type of the returned rows
   * @param strings SQL query template strings
   * @param values Values to be inserted into the query
   * @returns Array of query results
   */
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) {
    let query = "";
    try {
      // Construct the SQL query with placeholders
      query = strings.reduce(
        (acc, str, i) => acc + str + (i < values.length ? "?" : ""),
        ""
      );

      // Execute the SQL query with the provided values
      return [...this.ctx.storage.sql.exec(query, ...values)] as T[];
    } catch (e) {
      console.error(`failed to execute sql query: ${query}`, e);
      throw this.onError(e);
    }
  }
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_state (
        id TEXT PRIMARY KEY NOT NULL,
        state TEXT
      )
    `;

    void this.ctx.blockConcurrencyWhile(async () => {
      return this._tryCatch(async () => {
        // Create alarms table if it doesn't exist
        this.sql`
        CREATE TABLE IF NOT EXISTS cf_agents_schedules (
          id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
          callback TEXT,
          payload TEXT,
          type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron')),
          time INTEGER,
          delayInSeconds INTEGER,
          cron TEXT,
          created_at INTEGER DEFAULT (unixepoch())
        )
      `;

        // execute any pending alarms and schedule the next alarm
        await this.alarm();
      });
    });

    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        client_id TEXT,
        auth_url TEXT,
        server_options TEXT
      )
    `;

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = (request: Request) => {
      return agentContext.run(
        { agent: this, connection: undefined, request },
        async () => {
          if (this.mcp.isCallbackRequest(request)) {
            await this.mcp.handleCallbackRequest(request);

            // after the MCP connection handshake, we can send updated mcp state
            this.broadcast(
              JSON.stringify({
                mcp: this.getMcpServers(),
                type: "cf_agent_mcp_servers",
              })
            );

            // We probably should let the user configure this response/redirect, but this is fine for now.
            return new Response("<script>window.close();</script>", {
              headers: { "content-type": "text/html" },
              status: 200,
            });
          }

          return this._tryCatch(() => _onRequest(request));
        }
      );
    };

    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      return agentContext.run(
        { agent: this, connection, request: undefined },
        async () => {
          if (typeof message !== "string") {
            return this._tryCatch(() => _onMessage(connection, message));
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(message);
          } catch (_e) {
            // silently fail and let the onMessage handler handle it
            return this._tryCatch(() => _onMessage(connection, message));
          }

          if (isStateUpdateMessage(parsed)) {
            this._setStateInternal(parsed.state as State, connection);
            return;
          }

          if (isRPCRequest(parsed)) {
            try {
              const { id, method, args } = parsed;

              // Check if method exists and is callable
              const methodFn = this[method as keyof this];
              if (typeof methodFn !== "function") {
                throw new Error(`Method ${method} does not exist`);
              }

              if (!this._isCallable(method)) {
                throw new Error(`Method ${method} is not callable`);
              }

              const metadata = callableMetadata.get(methodFn as Function);

              // For streaming methods, pass a StreamingResponse object
              if (metadata?.streaming) {
                const stream = new StreamingResponse(connection, id);
                await methodFn.apply(this, [stream, ...args]);
                return;
              }

              // For regular methods, execute and send response
              const result = await methodFn.apply(this, args);
              const response: RPCResponse = {
                done: true,
                id,
                result,
                success: true,
                type: "rpc",
              };
              connection.send(JSON.stringify(response));
            } catch (e) {
              // Send error response
              const response: RPCResponse = {
                error:
                  e instanceof Error ? e.message : "Unknown error occurred",
                id: parsed.id,
                success: false,
                type: "rpc",
              };
              connection.send(JSON.stringify(response));
              console.error("RPC error:", e);
            }
            return;
          }

          return this._tryCatch(() => _onMessage(connection, message));
        }
      );
    };

    const _onConnect = this.onConnect.bind(this);
    this.onConnect = (connection: Connection, ctx: ConnectionContext) => {
      // TODO: This is a hack to ensure the state is sent after the connection is established
      // must fix this
      return agentContext.run(
        { agent: this, connection, request: ctx.request },
        async () => {
          setTimeout(() => {
            if (this.state) {
              connection.send(
                JSON.stringify({
                  state: this.state,
                  type: "cf_agent_state",
                })
              );
            }

            connection.send(
              JSON.stringify({
                mcp: this.getMcpServers(),
                type: "cf_agent_mcp_servers",
              })
            );

            return this._tryCatch(() => _onConnect(connection, ctx));
          }, 20);
        }
      );
    };

    const _onStart = this.onStart.bind(this);
    this.onStart = async () => {
      return agentContext.run(
        { agent: this, connection: undefined, request: undefined },
        async () => {
          const servers = this.sql<MCPServerRow>`
            SELECT id, name, server_url, client_id, auth_url, callback_url, server_options FROM cf_agents_mcp_servers;
          `;

          // from DO storage, reconnect to all servers not currently in the oauth flow using our saved auth information
          Promise.allSettled(
            servers.map((server) => {
              return this._connectToMcpServerInternal(
                server.name,
                server.server_url,
                server.callback_url,
                server.server_options
                  ? JSON.parse(server.server_options)
                  : undefined,
                {
                  id: server.id,
                  oauthClientId: server.client_id ?? undefined,
                }
              );
            })
          ).then((_results) => {
            this.broadcast(
              JSON.stringify({
                type: "cf_agent_mcp_servers",
                mcp: this.getMcpServers(),
              })
            );
          });
          await this._tryCatch(() => _onStart());
        }
      );
    };
  }

  private _setStateInternal(
    state: State,
    source: Connection | "server" = "server"
  ) {
    this._state = state;
    this.sql`
    INSERT OR REPLACE INTO cf_agents_state (id, state)
    VALUES (${STATE_ROW_ID}, ${JSON.stringify(state)})
  `;
    this.sql`
    INSERT OR REPLACE INTO cf_agents_state (id, state)
    VALUES (${STATE_WAS_CHANGED}, ${JSON.stringify(true)})
  `;
    this.broadcast(
      JSON.stringify({
        state: state,
        type: "cf_agent_state",
      }),
      source !== "server" ? [source.id] : []
    );
    return this._tryCatch(() => {
      const { connection, request } = agentContext.getStore() || {};
      return agentContext.run(
        { agent: this, connection, request },
        async () => {
          return this.onStateUpdate(state, source);
        }
      );
    });
  }

  /**
   * Update the Agent's state
   * @param state New state to set
   */
  setState(state: State) {
    this._setStateInternal(state, "server");
  }

  /**
   * Called when the Agent's state is updated
   * @param state Updated state
   * @param source Source of the state update ("server" or a client connection)
   */
  // biome-ignore lint/correctness/noUnusedFunctionParameters: overridden later
  onStateUpdate(state: State | undefined, source: Connection | "server") {
    // override this to handle state updates
  }

  /**
   * Called when the Agent receives an email
   * @param email Email message to process
   */
  // biome-ignore lint/correctness/noUnusedFunctionParameters: overridden later
  onEmail(email: ForwardableEmailMessage) {
    return agentContext.run(
      { agent: this, connection: undefined, request: undefined },
      async () => {
        console.error("onEmail not implemented");
      }
    );
  }

  private async _tryCatch<T>(fn: () => T | Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      throw this.onError(e);
    }
  }

  override onError(
    connection: Connection,
    error: unknown
  ): void | Promise<void>;
  override onError(error: unknown): void | Promise<void>;
  override onError(connectionOrError: Connection | unknown, error?: unknown) {
    let theError: unknown;
    if (connectionOrError && error) {
      theError = error;
      // this is a websocket connection error
      console.error(
        "Error on websocket connection:",
        (connectionOrError as Connection).id,
        theError
      );
      console.error(
        "Override onError(connection, error) to handle websocket connection errors"
      );
    } else {
      theError = connectionOrError;
      // this is a server error
      console.error("Error on server:", theError);
      console.error("Override onError(error) to handle server errors");
    }
    throw theError;
  }

  /**
   * Render content (not implemented in base class)
   */
  render() {
    throw new Error("Not implemented");
  }

  /**
   * Schedule a task to be executed in the future
   * @template T Type of the payload data
   * @param when When to execute the task (Date, seconds delay, or cron expression)
   * @param callback Name of the method to call
   * @param payload Data to pass to the callback
   * @returns Schedule object representing the scheduled task
   */
  async schedule<T = string>(
    when: Date | string | number,
    callback: keyof this,
    payload?: T
  ): Promise<Schedule<T>> {
    const id = nanoid(9);

    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }

    if (typeof this[callback] !== "function") {
      throw new Error(`this.${callback} is not a function`);
    }

    if (when instanceof Date) {
      const timestamp = Math.floor(when.getTime() / 1000);
      this.sql`
        INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(
          payload
        )}, 'scheduled', ${timestamp})
      `;

      await this._scheduleNextAlarm();

      return {
        callback: callback,
        id,
        payload: payload as T,
        time: timestamp,
        type: "scheduled",
      };
    }
    if (typeof when === "number") {
      const time = new Date(Date.now() + when * 1000);
      const timestamp = Math.floor(time.getTime() / 1000);

      this.sql`
        INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, delayInSeconds, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(
          payload
        )}, 'delayed', ${when}, ${timestamp})
      `;

      await this._scheduleNextAlarm();

      return {
        callback: callback,
        delayInSeconds: when,
        id,
        payload: payload as T,
        time: timestamp,
        type: "delayed",
      };
    }
    if (typeof when === "string") {
      const nextExecutionTime = getNextCronTime(when);
      const timestamp = Math.floor(nextExecutionTime.getTime() / 1000);

      this.sql`
        INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, cron, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(
          payload
        )}, 'cron', ${when}, ${timestamp})
      `;

      await this._scheduleNextAlarm();

      return {
        callback: callback,
        cron: when,
        id,
        payload: payload as T,
        time: timestamp,
        type: "cron",
      };
    }
    throw new Error("Invalid schedule type");
  }

  /**
   * Get a scheduled task by ID
   * @template T Type of the payload data
   * @param id ID of the scheduled task
   * @returns The Schedule object or undefined if not found
   */
  async getSchedule<T = string>(id: string): Promise<Schedule<T> | undefined> {
    const result = this.sql<Schedule<string>>`
      SELECT * FROM cf_agents_schedules WHERE id = ${id}
    `;
    if (!result) {
      console.error(`schedule ${id} not found`);
      return undefined;
    }

    return { ...result[0], payload: JSON.parse(result[0].payload) as T };
  }

  /**
   * Get scheduled tasks matching the given criteria
   * @template T Type of the payload data
   * @param criteria Criteria to filter schedules
   * @returns Array of matching Schedule objects
   */
  getSchedules<T = string>(
    criteria: {
      id?: string;
      type?: "scheduled" | "delayed" | "cron";
      timeRange?: { start?: Date; end?: Date };
    } = {}
  ): Schedule<T>[] {
    let query = "SELECT * FROM cf_agents_schedules WHERE 1=1";
    const params = [];

    if (criteria.id) {
      query += " AND id = ?";
      params.push(criteria.id);
    }

    if (criteria.type) {
      query += " AND type = ?";
      params.push(criteria.type);
    }

    if (criteria.timeRange) {
      query += " AND time >= ? AND time <= ?";
      const start = criteria.timeRange.start || new Date(0);
      const end = criteria.timeRange.end || new Date(999999999999999);
      params.push(
        Math.floor(start.getTime() / 1000),
        Math.floor(end.getTime() / 1000)
      );
    }

    const result = this.ctx.storage.sql
      .exec(query, ...params)
      .toArray()
      .map((row) => ({
        ...row,
        payload: JSON.parse(row.payload as string) as T,
      })) as Schedule<T>[];

    return result;
  }

  /**
   * Cancel a scheduled task
   * @param id ID of the task to cancel
   * @returns true if the task was cancelled, false otherwise
   */
  async cancelSchedule(id: string): Promise<boolean> {
    this.sql`DELETE FROM cf_agents_schedules WHERE id = ${id}`;

    await this._scheduleNextAlarm();
    return true;
  }

  private async _scheduleNextAlarm() {
    // Find the next schedule that needs to be executed
    const result = this.sql`
      SELECT time FROM cf_agents_schedules 
      WHERE time > ${Math.floor(Date.now() / 1000)}
      ORDER BY time ASC 
      LIMIT 1
    `;
    if (!result) return;

    if (result.length > 0 && "time" in result[0]) {
      const nextTime = (result[0].time as number) * 1000;
      await this.ctx.storage.setAlarm(nextTime);
    }
  }

  /**
   * Method called when an alarm fires.
   * Executes any scheduled tasks that are due.
   *
   * @remarks
   * To schedule a task, please use the `this.schedule` method instead.
   * See {@link https://developers.cloudflare.com/agents/api-reference/schedule-tasks/}
   */
  public readonly alarm = async () => {
    const now = Math.floor(Date.now() / 1000);

    // Get all schedules that should be executed now
    const result = this.sql<Schedule<string>>`
      SELECT * FROM cf_agents_schedules WHERE time <= ${now}
    `;

    for (const row of result || []) {
      const callback = this[row.callback as keyof Agent<Env>];
      if (!callback) {
        console.error(`callback ${row.callback} not found`);
        continue;
      }
      await agentContext.run(
        { agent: this, connection: undefined, request: undefined },
        async () => {
          try {
            await (
              callback as (
                payload: unknown,
                schedule: Schedule<unknown>
              ) => Promise<void>
            ).bind(this)(JSON.parse(row.payload as string), row);
          } catch (e) {
            console.error(`error executing callback "${row.callback}"`, e);
          }
        }
      );
      if (row.type === "cron") {
        // Update next execution time for cron schedules
        const nextExecutionTime = getNextCronTime(row.cron);
        const nextTimestamp = Math.floor(nextExecutionTime.getTime() / 1000);

        this.sql`
          UPDATE cf_agents_schedules SET time = ${nextTimestamp} WHERE id = ${row.id}
        `;
      } else {
        // Delete one-time schedules after execution
        this.sql`
          DELETE FROM cf_agents_schedules WHERE id = ${row.id}
        `;
      }
    }

    // Schedule the next alarm
    await this._scheduleNextAlarm();
  };

  /**
   * Destroy the Agent, removing all state and scheduled tasks
   */
  async destroy() {
    // drop all tables
    this.sql`DROP TABLE IF EXISTS cf_agents_state`;
    this.sql`DROP TABLE IF EXISTS cf_agents_schedules`;
    this.sql`DROP TABLE IF EXISTS cf_agents_mcp_servers`;

    // delete all alarms
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ctx.abort("destroyed"); // enforce that the agent is evicted
  }

  /**
   * Get all methods marked as callable on this Agent
   * @returns A map of method names to their metadata
   */
  private _isCallable(method: string): boolean {
    return callableMetadata.has(this[method as keyof this] as Function);
  }

  /**
   * Connect to a new MCP Server
   *
   * @param url MCP Server SSE URL
   * @param callbackHost Base host for the agent, used for the redirect URI.
   * @param agentsPrefix agents routing prefix if not using `agents`
   * @param options MCP client and transport (header) options
   * @returns authUrl
   */
  async addMcpServer(
    serverName: string,
    url: string,
    callbackHost: string,
    agentsPrefix = "agents",
    options?: {
      client?: ConstructorParameters<typeof Client>[1];
      transport?: {
        headers: HeadersInit;
      };
    }
  ): Promise<{ id: string; authUrl: string | undefined }> {
    const callbackUrl = `${callbackHost}/${agentsPrefix}/${camelCaseToKebabCase(this._ParentClass.name)}/${this.name}/callback`;

    const result = await this._connectToMcpServerInternal(
      serverName,
      url,
      callbackUrl,
      options
    );
    this.sql`
        INSERT
        OR REPLACE INTO cf_agents_mcp_servers (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (
        ${result.id},
        ${serverName},
        ${url},
        ${result.clientId ?? null},
        ${result.authUrl ?? null},
        ${callbackUrl},
        ${options ? JSON.stringify(options) : null}
        );
    `;

    this.broadcast(
      JSON.stringify({
        mcp: this.getMcpServers(),
        type: "cf_agent_mcp_servers",
      })
    );

    return result;
  }

  async _connectToMcpServerInternal(
    _serverName: string,
    url: string,
    callbackUrl: string,
    // it's important that any options here are serializable because we put them into our sqlite DB for reconnection purposes
    options?: {
      client?: ConstructorParameters<typeof Client>[1];
      /**
       * We don't expose the normal set of transport options because:
       * 1) we can't serialize things like the auth provider or a fetch function into the DB for reconnection purposes
       * 2) We probably want these options to be agnostic to the transport type (SSE vs Streamable)
       *
       * This has the limitation that you can't override fetch, but I think headers should handle nearly all cases needed (i.e. non-standard bearer auth).
       */
      transport?: {
        headers?: HeadersInit;
      };
    },
    reconnect?: {
      id: string;
      oauthClientId?: string;
    }
  ): Promise<{
    id: string;
    authUrl: string | undefined;
    clientId: string | undefined;
  }> {
    const authProvider = new DurableObjectOAuthClientProvider(
      this.ctx.storage,
      this.name,
      callbackUrl
    );

    if (reconnect) {
      authProvider.serverId = reconnect.id;
      if (reconnect.oauthClientId) {
        authProvider.clientId = reconnect.oauthClientId;
      }
    }

    // allows passing through transport headers if necessary
    // this handles some non-standard bearer auth setups (i.e. MCP server behind CF access instead of OAuth)
    let headerTransportOpts: SSEClientTransportOptions = {};
    if (options?.transport?.headers) {
      headerTransportOpts = {
        eventSourceInit: {
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              headers: options?.transport?.headers,
            }),
        },
        requestInit: {
          headers: options?.transport?.headers,
        },
      };
    }

    const { id, authUrl, clientId } = await this.mcp.connect(url, {
      client: options?.client,
      reconnect,
      transport: {
        ...headerTransportOpts,
        authProvider,
      },
    });

    return {
      authUrl,
      clientId,
      id,
    };
  }

  async removeMcpServer(id: string) {
    this.mcp.closeConnection(id);
    this.sql`
      DELETE FROM cf_agents_mcp_servers WHERE id = ${id};
    `;
    this.broadcast(
      JSON.stringify({
        mcp: this.getMcpServers(),
        type: "cf_agent_mcp_servers",
      })
    );
  }

  getMcpServers(): MCPServersState {
    const mcpState: MCPServersState = {
      prompts: this.mcp.listPrompts(),
      resources: this.mcp.listResources(),
      servers: {},
      tools: this.mcp.listTools(),
    };

    const servers = this.sql<MCPServerRow>`
      SELECT id, name, server_url, client_id, auth_url, callback_url, server_options FROM cf_agents_mcp_servers;
    `;

    for (const server of servers) {
      const serverConn = this.mcp.mcpConnections[server.id];
      mcpState.servers[server.id] = {
        auth_url: server.auth_url,
        capabilities: serverConn?.serverCapabilities ?? null,
        instructions: serverConn?.instructions ?? null,
        name: server.name,
        server_url: server.server_url,
        // mark as "authenticating" because the server isn't automatically connected, so it's pending authenticating
        state: serverConn?.connectionState ?? "authenticating",
      };
    }

    return mcpState;
  }
}

/**
 * Namespace for creating Agent instances
 * @template Agentic Type of the Agent class
 */
export type AgentNamespace<Agentic extends Agent<unknown>> =
  DurableObjectNamespace<Agentic>;

/**
 * Agent's durable context
 */
export type AgentContext = DurableObjectState;

/**
 * Configuration options for Agent routing
 */
export type AgentOptions<Env> = PartyServerOptions<Env> & {
  /**
   * Whether to enable CORS for the Agent
   */
  cors?: boolean | HeadersInit | undefined;
};

/**
 * Route a request to the appropriate Agent
 * @param request Request to route
 * @param env Environment containing Agent bindings
 * @param options Routing options
 * @returns Response from the Agent or undefined if no route matched
 */
export async function routeAgentRequest<Env>(
  request: Request,
  env: Env,
  options?: AgentOptions<Env>
) {
  const corsHeaders =
    options?.cors === true
      ? {
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Max-Age": "86400",
        }
      : options?.cors;

  if (request.method === "OPTIONS") {
    if (corsHeaders) {
      return new Response(null, {
        headers: corsHeaders,
      });
    }
    console.warn(
      "Received an OPTIONS request, but cors was not enabled. Pass `cors: true` or `cors: { ...custom cors headers }` to routeAgentRequest to enable CORS."
    );
  }

  let response = await routePartykitRequest(
    request,
    env as Record<string, unknown>,
    {
      prefix: "agents",
      ...(options as PartyServerOptions<Record<string, unknown>>),
    }
  );

  if (
    response &&
    corsHeaders &&
    request.headers.get("upgrade")?.toLowerCase() !== "websocket" &&
    request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
  ) {
    response = new Response(response.body, {
      headers: {
        ...response.headers,
        ...corsHeaders,
      },
    });
  }
  return response;
}

/**
 * Route an email to the appropriate Agent
 * @param email Email message to route
 * @param env Environment containing Agent bindings
 * @param options Routing options
 */
export async function routeAgentEmail<Env>(
  _email: ForwardableEmailMessage,
  _env: Env,
  _options?: AgentOptions<Env>
): Promise<void> {}

/**
 * Get or create an Agent by name
 * @template Env Environment type containing bindings
 * @template T Type of the Agent class
 * @param namespace Agent namespace
 * @param name Name of the Agent instance
 * @param options Options for Agent creation
 * @returns Promise resolving to an Agent instance stub
 */
export async function getAgentByName<Env, T extends Agent<Env>>(
  namespace: AgentNamespace<T>,
  name: string,
  options?: {
    jurisdiction?: DurableObjectJurisdiction;
    locationHint?: DurableObjectLocationHint;
  }
) {
  return getServerByName<Env, T>(namespace, name, options);
}

/**
 * A wrapper for streaming responses in callable methods
 */
export class StreamingResponse {
  private _connection: Connection;
  private _id: string;
  private _closed = false;

  constructor(connection: Connection, id: string) {
    this._connection = connection;
    this._id = id;
  }

  /**
   * Send a chunk of data to the client
   * @param chunk The data to send
   */
  send(chunk: unknown) {
    if (this._closed) {
      throw new Error("StreamingResponse is already closed");
    }
    const response: RPCResponse = {
      done: false,
      id: this._id,
      result: chunk,
      success: true,
      type: "rpc",
    };
    this._connection.send(JSON.stringify(response));
  }

  /**
   * End the stream and send the final chunk (if any)
   * @param finalChunk Optional final chunk of data to send
   */
  end(finalChunk?: unknown) {
    if (this._closed) {
      throw new Error("StreamingResponse is already closed");
    }
    this._closed = true;
    const response: RPCResponse = {
      done: true,
      id: this._id,
      result: finalChunk,
      success: true,
      type: "rpc",
    };
    this._connection.send(JSON.stringify(response));
  }
}
