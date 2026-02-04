import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { agentContext, type AgentEmail } from "./internal_context";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import { signAgentHeaders } from "./email";

import type {
  Prompt,
  Resource,
  ServerCapabilities,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import { parseCronExpression } from "cron-schedule";
import { nanoid } from "nanoid";
import { EmailMessage } from "cloudflare:email";
import {
  type Connection,
  type ConnectionContext,
  type PartyServerOptions,
  Server,
  type WSMessage,
  getServerByName,
  routePartykitRequest
} from "partyserver";
import { camelCaseToKebabCase } from "./utils";
import { MCPClientManager, type MCPClientOAuthResult } from "./mcp/client";
import type {
  WorkflowCallback,
  WorkflowTrackingRow,
  WorkflowStatus,
  RunWorkflowOptions,
  WorkflowEventPayload,
  WorkflowInfo,
  WorkflowQueryCriteria,
  WorkflowPage
} from "./workflow-types";
import { MCPConnectionState } from "./mcp/client-connection";
import { DurableObjectOAuthClientProvider } from "./mcp/do-oauth-client-provider";
import type { TransportType } from "./mcp/types";
import { genericObservability, type Observability } from "./observability";
import { DisposableStore } from "./core/events";
import { MessageType } from "./types";

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
  type: MessageType.CF_AGENT_STATE;
  state: unknown;
};

/**
 * RPC response message to client
 */
export type RPCResponse = {
  type: MessageType.RPC;
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
    msg.type === MessageType.RPC &&
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
    msg.type === MessageType.CF_AGENT_STATE &&
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

const callableMetadata = new WeakMap<Function, CallableMetadata>();

/**
 * Error class for SQL execution failures, containing the query that failed
 */
export class SqlError extends Error {
  /** The SQL query that failed */
  readonly query: string;

  constructor(query: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`SQL query failed: ${message}`, { cause });
    this.name = "SqlError";
    this.query = query;
  }
}

/**
 * Decorator that marks a method as callable by clients
 * @param metadata Optional metadata about the callable method
 */
export function callable(metadata: CallableMetadata = {}) {
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

let didWarnAboutUnstableCallable = false;

/**
 * Decorator that marks a method as callable by clients
 * @deprecated this has been renamed to callable, and unstable_callable will be removed in the next major version
 * @param metadata Optional metadata about the callable method
 */
export const unstable_callable = (metadata: CallableMetadata = {}) => {
  if (!didWarnAboutUnstableCallable) {
    didWarnAboutUnstableCallable = true;
    console.warn(
      "unstable_callable is deprecated, use callable instead. unstable_callable will be removed in the next major version."
    );
  }
  return callable(metadata);
};

export type QueueItem<T = string> = {
  id: string;
  payload: T;
  callback: keyof Agent<Cloudflare.Env>;
  created_at: number;
};

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
  | {
      /** Type of schedule for recurring execution at fixed intervals */
      type: "interval";
      /** Timestamp for the next execution */
      time: number;
      /** Number of seconds between executions */
      intervalSeconds: number;
    }
);

function getNextCronTime(cron: string) {
  const interval = parseCronExpression(cron);
  return interval.getNextDate();
}

export type { TransportType } from "./mcp/types";

/**
 * MCP Server state update message from server -> Client
 */
export type MCPServerMessage = {
  type: MessageType.CF_AGENT_MCP_SERVERS;
  mcp: MCPServersState;
};

export type MCPServersState = {
  servers: {
    [id: string]: MCPServer;
  };
  tools: (Tool & { serverId: string })[];
  prompts: (Prompt & { serverId: string })[];
  resources: (Resource & { serverId: string })[];
};

export type MCPServer = {
  name: string;
  server_url: string;
  auth_url: string | null;
  // This state is specifically about the temporary process of getting a token (if needed).
  // Scope outside of that can't be relied upon because when the DO sleeps, there's no way
  // to communicate a change to a non-ready state.
  state: MCPConnectionState;
  error: string | null;
  instructions: string | null;
  capabilities: ServerCapabilities | null;
};

/**
 * Options for adding an MCP server
 */
export type AddMcpServerOptions = {
  /** OAuth callback host (auto-derived from request if omitted) */
  callbackHost?: string;
  /** Agents routing prefix (default: "agents") */
  agentsPrefix?: string;
  /** MCP client options */
  client?: ConstructorParameters<typeof Client>[1];
  /** Transport options */
  transport?: {
    /** Custom headers for authentication (e.g., bearer tokens, CF Access) */
    headers?: HeadersInit;
    /** Transport type: "sse", "streamable-http", or "auto" (default) */
    type?: TransportType;
  };
};

const STATE_ROW_ID = "cf_state_row_id";
const STATE_WAS_CHANGED = "cf_state_was_changed";

const DEFAULT_STATE = {} as unknown;

/**
 * Default options for Agent configuration.
 * Child classes can override specific options without spreading.
 */
export const DEFAULT_AGENT_STATIC_OPTIONS = {
  /** Whether the Agent should hibernate when inactive */
  hibernate: true,
  /** Whether to send identity (name, agent) to clients on connect */
  sendIdentityOnConnect: true,
  /**
   * Timeout in seconds before a running interval schedule is considered "hung"
   * and force-reset. Increase this if you have callbacks that legitimately
   * take longer than 30 seconds.
   */
  hungScheduleTimeoutSeconds: 30
};

type ResolvedAgentOptions = typeof DEFAULT_AGENT_STATIC_OPTIONS;

/**
 * Configuration options for the Agent.
 * Override in subclasses via `static options`.
 * All fields are optional - defaults are applied at runtime.
 * Note: `hibernate` defaults to `true` if not specified.
 */
export type AgentStaticOptions = Partial<ResolvedAgentOptions>;

export function getCurrentAgent<
  T extends Agent<Cloudflare.Env> = Agent<Cloudflare.Env>
>(): {
  agent: T | undefined;
  connection: Connection | undefined;
  request: Request | undefined;
  email: AgentEmail | undefined;
} {
  const store = agentContext.getStore() as
    | {
        agent: T;
        connection: Connection | undefined;
        request: Request | undefined;
        email: AgentEmail | undefined;
      }
    | undefined;
  if (!store) {
    return {
      agent: undefined,
      connection: undefined,
      request: undefined,
      email: undefined
    };
  }
  return store;
}

/**
 * Wraps a method to run within the agent context, ensuring getCurrentAgent() works properly
 * @param agent The agent instance
 * @param method The method to wrap
 * @returns A wrapped method that runs within the agent context
 */

// biome-ignore lint/suspicious/noExplicitAny: I can't typescript
function withAgentContext<T extends (...args: any[]) => any>(
  method: T
): (
  this: Agent<Cloudflare.Env, unknown>,
  ...args: Parameters<T>
) => ReturnType<T> {
  return function (...args: Parameters<T>): ReturnType<T> {
    const { connection, request, email, agent } = getCurrentAgent();

    if (agent === this) {
      // already wrapped, so we can just call the method
      return method.apply(this, args);
    }
    // not wrapped, so we need to wrap it
    return agentContext.run({ agent: this, connection, request, email }, () => {
      return method.apply(this, args);
    });
  };
}

/**
 * Extract string keys from Env where the value is a Workflow binding.
 */
type WorkflowBinding<E> = {
  [K in keyof E & string]: E[K] extends Workflow ? K : never;
}[keyof E & string];

/**
 * Type for workflow name parameter.
 * When Env has typed Workflow bindings, provides autocomplete for those keys.
 * Also accepts any string for dynamic use cases and compatibility.
 * The `string & {}` trick preserves autocomplete while allowing any string.
 */
type WorkflowName<E> = WorkflowBinding<E> | (string & {});

/**
 * Base class for creating Agent implementations
 * @template Env Environment type containing bindings
 * @template State State type to store within the Agent
 */
export class Agent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Server<Env, Props> {
  private _state = DEFAULT_STATE as State;
  private _disposables = new DisposableStore();
  private _destroyed = false;

  private _ParentClass: typeof Agent<Env, State> =
    Object.getPrototypeOf(this).constructor;

  readonly mcp: MCPClientManager;

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

      try {
        this._state = JSON.parse(state);
      } catch (e) {
        console.error(
          "Failed to parse stored state, falling back to initialState:",
          e
        );
        if (this.initialState !== DEFAULT_STATE) {
          this._state = this.initialState;
          // Persist the fixed state to prevent future parse errors
          this.setState(this.initialState);
        } else {
          // No initialState defined - clear corrupted data to prevent infinite retry loop
          this.sql`DELETE FROM cf_agents_state WHERE id = ${STATE_ROW_ID}`;
          this.sql`DELETE FROM cf_agents_state WHERE id = ${STATE_WAS_CHANGED}`;
          return undefined as State;
        }
      }
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
   * Agent configuration options.
   * Override in subclasses - only specify what you want to change.
   * @example
   * class SecureAgent extends Agent {
   *   static options = { sendIdentityOnConnect: false };
   * }
   */
  static options: AgentStaticOptions = { hibernate: true };

  /**
   * Resolved options (merges defaults with subclass overrides)
   */
  private get _resolvedOptions(): ResolvedAgentOptions {
    const ctor = this.constructor as typeof Agent;
    return {
      hibernate:
        ctor.options?.hibernate ?? DEFAULT_AGENT_STATIC_OPTIONS.hibernate,
      sendIdentityOnConnect:
        ctor.options?.sendIdentityOnConnect ??
        DEFAULT_AGENT_STATIC_OPTIONS.sendIdentityOnConnect,
      hungScheduleTimeoutSeconds:
        ctor.options?.hungScheduleTimeoutSeconds ??
        DEFAULT_AGENT_STATIC_OPTIONS.hungScheduleTimeoutSeconds
    };
  }

  /**
   * The observability implementation to use for the Agent
   */
  observability?: Observability = genericObservability;

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
      throw this.onError(new SqlError(query, e));
    }
  }
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    if (!wrappedClasses.has(this.constructor)) {
      // Auto-wrap custom methods with agent context
      this._autoWrapCustomMethods();
      wrappedClasses.add(this.constructor);
    }

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

    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_state (
        id TEXT PRIMARY KEY NOT NULL,
        state TEXT
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_queues (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT,
        callback TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_schedules (
        id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
        callback TEXT,
        payload TEXT,
        type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
        time INTEGER,
        delayInSeconds INTEGER,
        cron TEXT,
        intervalSeconds INTEGER,
        running INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `;

    // Migration: Add columns for interval scheduling (for existing agents)
    // Use raw exec to avoid error logging through onError for expected failures
    const addColumnIfNotExists = (sql: string) => {
      try {
        this.ctx.storage.sql.exec(sql);
      } catch (e) {
        // Only ignore "duplicate column" errors, re-throw unexpected errors
        const message = e instanceof Error ? e.message : String(e);
        if (!message.toLowerCase().includes("duplicate column")) {
          throw e;
        }
      }
    };

    addColumnIfNotExists(
      "ALTER TABLE cf_agents_schedules ADD COLUMN intervalSeconds INTEGER"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agents_schedules ADD COLUMN running INTEGER DEFAULT 0"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agents_schedules ADD COLUMN execution_started_at INTEGER"
    );

    // Workflow tracking table for Agent-Workflow integration
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_workflows (
        id TEXT PRIMARY KEY NOT NULL,
        workflow_id TEXT NOT NULL UNIQUE,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'queued', 'running', 'paused', 'errored',
          'terminated', 'complete', 'waiting',
          'waitingForPause', 'unknown'
        )),
        metadata TEXT,
        error_name TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER
      )
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_workflows_status ON cf_agents_workflows(status)
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_workflows_name ON cf_agents_workflows(workflow_name)
    `;

    // Initialize MCPClientManager AFTER tables are created
    this.mcp = new MCPClientManager(this._ParentClass.name, "0.0.1", {
      storage: this.ctx.storage
    });

    // Broadcast server state whenever MCP state changes (register, connect, OAuth, remove, etc.)
    this._disposables.add(
      this.mcp.onServerStateChanged(async () => {
        this.broadcastMcpServers();
      })
    );

    // Emit MCP observability events
    this._disposables.add(
      this.mcp.onObservabilityEvent((event) => {
        this.observability?.emit(event);
      })
    );

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = (request: Request) => {
      return agentContext.run(
        { agent: this, connection: undefined, request, email: undefined },
        async () => {
          // TODO: make zod/ai sdk more performant and remove this
          // Late initialization of jsonSchemaFn (needed for getAITools)
          await this.mcp.ensureJsonSchema();

          // Handle MCP OAuth callback if this is one
          const oauthResponse = await this.handleMcpOAuthCallback(request);
          if (oauthResponse) {
            return oauthResponse;
          }

          return this._tryCatch(() => _onRequest(request));
        }
      );
    };

    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      return agentContext.run(
        { agent: this, connection, request: undefined, email: undefined },
        async () => {
          // TODO: make zod/ai sdk more performant and remove this
          // Late initialization of jsonSchemaFn (needed for getAITools)
          await this.mcp.ensureJsonSchema();
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

                this.observability?.emit(
                  {
                    displayMessage: `RPC streaming call to ${method}`,
                    id: nanoid(),
                    payload: {
                      method,
                      streaming: true
                    },
                    timestamp: Date.now(),
                    type: "rpc"
                  },
                  this.ctx
                );

                try {
                  await methodFn.apply(this, [stream, ...args]);
                } catch (err) {
                  // Log error server-side for observability
                  console.error(`Error in streaming method "${method}":`, err);
                  // Auto-close stream with error if method throws before closing
                  if (!stream.isClosed) {
                    stream.error(
                      err instanceof Error ? err.message : String(err)
                    );
                  }
                }
                return;
              }

              // For regular methods, execute and send response
              const result = await methodFn.apply(this, args);

              this.observability?.emit(
                {
                  displayMessage: `RPC call to ${method}`,
                  id: nanoid(),
                  payload: {
                    method,
                    streaming: metadata?.streaming
                  },
                  timestamp: Date.now(),
                  type: "rpc"
                },
                this.ctx
              );

              const response: RPCResponse = {
                done: true,
                id,
                result,
                success: true,
                type: MessageType.RPC
              };
              connection.send(JSON.stringify(response));
            } catch (e) {
              // Send error response
              const response: RPCResponse = {
                error:
                  e instanceof Error ? e.message : "Unknown error occurred",
                id: parsed.id,
                success: false,
                type: MessageType.RPC
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
        { agent: this, connection, request: ctx.request, email: undefined },
        async () => {
          // Send agent identity first so client knows which instance it's connected to
          // Can be disabled via static options for security-sensitive instance names
          if (this._resolvedOptions.sendIdentityOnConnect) {
            connection.send(
              JSON.stringify({
                name: this.name,
                agent: camelCaseToKebabCase(this._ParentClass.name),
                type: MessageType.CF_AGENT_IDENTITY
              })
            );
          }

          if (this.state) {
            connection.send(
              JSON.stringify({
                state: this.state,
                type: MessageType.CF_AGENT_STATE
              })
            );
          }

          connection.send(
            JSON.stringify({
              mcp: this.getMcpServers(),
              type: MessageType.CF_AGENT_MCP_SERVERS
            })
          );

          this.observability?.emit(
            {
              displayMessage: "Connection established",
              id: nanoid(),
              payload: {
                connectionId: connection.id
              },
              timestamp: Date.now(),
              type: "connect"
            },
            this.ctx
          );
          return this._tryCatch(() => _onConnect(connection, ctx));
        }
      );
    };

    const _onStart = this.onStart.bind(this);
    this.onStart = async (props?: Props) => {
      return agentContext.run(
        {
          agent: this,
          connection: undefined,
          request: undefined,
          email: undefined
        },
        async () => {
          await this._tryCatch(async () => {
            await this.mcp.restoreConnectionsFromStorage(this.name);
            this.broadcastMcpServers();

            // Check for orphaned workflows (tracked but binding no longer exists)
            this._checkOrphanedWorkflows();

            return _onStart(props);
          });
        }
      );
    };
  }

  /**
   * Check for workflows referencing unknown bindings and warn with migration suggestion.
   */
  private _checkOrphanedWorkflows(): void {
    // Get distinct workflow names with counts by active/completed status
    const distinctNames = this.sql<{
      workflow_name: string;
      total: number;
      active: number;
      completed: number;
    }>`
      SELECT 
        workflow_name,
        COUNT(*) as total,
        SUM(CASE WHEN status NOT IN ('complete', 'errored', 'terminated') THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status IN ('complete', 'errored', 'terminated') THEN 1 ELSE 0 END) as completed
      FROM cf_agents_workflows 
      GROUP BY workflow_name
    `;

    const orphaned = distinctNames.filter(
      (row) => !this._findWorkflowBindingByName(row.workflow_name)
    );

    if (orphaned.length > 0) {
      const currentBindings = this._getWorkflowBindingNames();
      for (const {
        workflow_name: oldName,
        total,
        active,
        completed
      } of orphaned) {
        const suggestion =
          currentBindings.length === 1
            ? `this.migrateWorkflowBinding('${oldName}', '${currentBindings[0]}')`
            : `this.migrateWorkflowBinding('${oldName}', '<NEW_BINDING_NAME>')`;
        const breakdown =
          active > 0 && completed > 0
            ? ` (${active} active, ${completed} completed)`
            : active > 0
              ? ` (${active} active)`
              : ` (${completed} completed)`;
        console.warn(
          `[Agent] Found ${total} workflow(s) referencing unknown binding '${oldName}'${breakdown}. ` +
            `If you renamed the binding, call: ${suggestion}`
        );
      }
    }
  }

  private _setStateInternal(
    nextState: State,
    source: Connection | "server" = "server"
  ): void {
    // Validation/gating hook (sync only)
    this.validateStateChange(nextState, source);

    // Persist state
    this._state = nextState;
    this.sql`
      INSERT OR REPLACE INTO cf_agents_state (id, state)
      VALUES (${STATE_ROW_ID}, ${JSON.stringify(nextState)})
    `;
    this.sql`
      INSERT OR REPLACE INTO cf_agents_state (id, state)
      VALUES (${STATE_WAS_CHANGED}, ${JSON.stringify(true)})
    `;

    // Broadcast state to connected clients immediately
    this.broadcast(
      JSON.stringify({
        state: nextState,
        type: MessageType.CF_AGENT_STATE
      }),
      source !== "server" ? [source.id] : []
    );

    // Notification hook (non-gating). Run after broadcast and do not block.
    // Use waitUntil for reliability after the handler returns.
    const { connection, request, email } = agentContext.getStore() || {};
    this.ctx.waitUntil(
      (async () => {
        try {
          await agentContext.run(
            { agent: this, connection, request, email },
            async () => {
              this.observability?.emit(
                {
                  displayMessage: "State updated",
                  id: nanoid(),
                  payload: {},
                  timestamp: Date.now(),
                  type: "state:update"
                },
                this.ctx
              );
              await this.onStateUpdate(nextState, source);
            }
          );
        } catch (e) {
          // onStateUpdate errors should not affect state or broadcasts
          try {
            await this.onError(e);
          } catch {
            // swallow
          }
        }
      })()
    );
  }

  /**
   * Update the Agent's state
   * @param state New state to set
   */
  setState(state: State): void {
    this._setStateInternal(state, "server");
  }

  /**
   * Called before the Agent's state is persisted and broadcast.
   * Override to validate or reject an update by throwing an error.
   *
   * IMPORTANT: This hook must be synchronous.
   */
  // biome-ignore lint/correctness/noUnusedFunctionParameters: overridden later
  validateStateChange(nextState: State, source: Connection | "server") {
    // override this to validate state updates
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
   * Called when the Agent receives an email via routeAgentEmail()
   * Override this method to handle incoming emails
   * @param email Email message to process
   */
  async _onEmail(email: AgentEmail) {
    // nb: we use this roundabout way of getting to onEmail
    // because of https://github.com/cloudflare/workerd/issues/4499
    return agentContext.run(
      { agent: this, connection: undefined, request: undefined, email: email },
      async () => {
        if ("onEmail" in this && typeof this.onEmail === "function") {
          return this._tryCatch(() =>
            (this.onEmail as (email: AgentEmail) => Promise<void>)(email)
          );
        } else {
          console.log("Received email from:", email.from, "to:", email.to);
          console.log("Subject:", email.headers.get("subject"));
          console.log(
            "Implement onEmail(email: AgentEmail): Promise<void> in your agent to process emails"
          );
        }
      }
    );
  }

  /**
   * Reply to an email
   * @param email The email to reply to
   * @param options Options for the reply
   * @param options.secret Secret for signing agent headers (enables secure reply routing).
   *   Required if the email was routed via createSecureReplyEmailResolver.
   *   Pass explicit `null` to opt-out of signing (not recommended for secure routing).
   * @returns void
   */
  async replyToEmail(
    email: AgentEmail,
    options: {
      fromName: string;
      subject?: string | undefined;
      body: string;
      contentType?: string;
      headers?: Record<string, string>;
      secret?: string | null;
    }
  ): Promise<void> {
    return this._tryCatch(async () => {
      // Enforce signing for emails routed via createSecureReplyEmailResolver
      if (email._secureRouted && options.secret === undefined) {
        throw new Error(
          "This email was routed via createSecureReplyEmailResolver. " +
            "You must pass a secret to replyToEmail() to sign replies, " +
            "or pass explicit null to opt-out (not recommended)."
        );
      }

      const agentName = camelCaseToKebabCase(this._ParentClass.name);
      const agentId = this.name;

      const { createMimeMessage } = await import("mimetext");
      const msg = createMimeMessage();
      msg.setSender({ addr: email.to, name: options.fromName });
      msg.setRecipient(email.from);
      msg.setSubject(
        options.subject || `Re: ${email.headers.get("subject")}` || "No subject"
      );
      msg.addMessage({
        contentType: options.contentType || "text/plain",
        data: options.body
      });

      const domain = email.from.split("@")[1];
      const messageId = `<${agentId}@${domain}>`;
      msg.setHeader("In-Reply-To", email.headers.get("Message-ID")!);
      msg.setHeader("Message-ID", messageId);
      msg.setHeader("X-Agent-Name", agentName);
      msg.setHeader("X-Agent-ID", agentId);

      // Sign headers if secret is provided (enables secure reply routing)
      if (typeof options.secret === "string") {
        const signedHeaders = await signAgentHeaders(
          options.secret,
          agentName,
          agentId
        );
        msg.setHeader("X-Agent-Sig", signedHeaders["X-Agent-Sig"]);
        msg.setHeader("X-Agent-Sig-Ts", signedHeaders["X-Agent-Sig-Ts"]);
      }

      if (options.headers) {
        for (const [key, value] of Object.entries(options.headers)) {
          msg.setHeader(key, value);
        }
      }
      await email.reply({
        from: email.to,
        raw: msg.asRaw(),
        to: email.from
      });
    });
  }

  private async _tryCatch<T>(fn: () => T | Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      throw this.onError(e);
    }
  }

  /**
   * Automatically wrap custom methods with agent context
   * This ensures getCurrentAgent() works in all custom methods without decorators
   */
  private _autoWrapCustomMethods() {
    // Collect all methods from base prototypes (Agent and Server)
    const basePrototypes = [Agent.prototype, Server.prototype];
    const baseMethods = new Set<string>();
    for (const baseProto of basePrototypes) {
      let proto = baseProto;
      while (proto && proto !== Object.prototype) {
        const methodNames = Object.getOwnPropertyNames(proto);
        for (const methodName of methodNames) {
          baseMethods.add(methodName);
        }
        proto = Object.getPrototypeOf(proto);
      }
    }
    // Get all methods from the current instance's prototype chain
    let proto = Object.getPrototypeOf(this);
    let depth = 0;
    while (proto && proto !== Object.prototype && depth < 10) {
      const methodNames = Object.getOwnPropertyNames(proto);
      for (const methodName of methodNames) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, methodName);

        // Skip if it's a private method, a base method, a getter, or not a function,
        if (
          baseMethods.has(methodName) ||
          methodName.startsWith("_") ||
          !descriptor ||
          !!descriptor.get ||
          typeof descriptor.value !== "function"
        ) {
          continue;
        }

        // Now, methodName is confirmed to be a custom method/function
        // Wrap the custom method with context
        const wrappedFunction = withAgentContext(
          // biome-ignore lint/suspicious/noExplicitAny: I can't typescript
          this[methodName as keyof this] as (...args: any[]) => any
          // biome-ignore lint/suspicious/noExplicitAny: I can't typescript
        ) as any;

        // if the method is callable, copy the metadata from the original method
        if (this._isCallable(methodName)) {
          callableMetadata.set(
            wrappedFunction,
            callableMetadata.get(this[methodName as keyof this] as Function)!
          );
        }

        // set the wrapped function on the prototype
        this.constructor.prototype[methodName as keyof this] = wrappedFunction;
      }

      proto = Object.getPrototypeOf(proto);
      depth++;
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
   * Queue a task to be executed in the future
   * @param payload Payload to pass to the callback
   * @param callback Name of the method to call
   * @returns The ID of the queued task
   */
  async queue<T = unknown>(callback: keyof this, payload: T): Promise<string> {
    const id = nanoid(9);
    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }

    if (typeof this[callback] !== "function") {
      throw new Error(`this.${callback} is not a function`);
    }

    this.sql`
      INSERT OR REPLACE INTO cf_agents_queues (id, payload, callback)
      VALUES (${id}, ${JSON.stringify(payload)}, ${callback})
    `;

    void this._flushQueue().catch((e) => {
      console.error("Error flushing queue:", e);
    });

    return id;
  }

  private _flushingQueue = false;

  private async _flushQueue() {
    if (this._flushingQueue) {
      return;
    }
    this._flushingQueue = true;
    while (true) {
      const result = this.sql<QueueItem<string>>`
      SELECT * FROM cf_agents_queues
      ORDER BY created_at ASC
    `;

      if (!result || result.length === 0) {
        break;
      }

      for (const row of result || []) {
        const callback = this[row.callback as keyof Agent<Env>];
        if (!callback) {
          console.error(`callback ${row.callback} not found`);
          continue;
        }
        const { connection, request, email } = agentContext.getStore() || {};
        await agentContext.run(
          {
            agent: this,
            connection,
            request,
            email
          },
          async () => {
            // TODO: add retries and backoff
            await (
              callback as (
                payload: unknown,
                queueItem: QueueItem<string>
              ) => Promise<void>
            ).bind(this)(JSON.parse(row.payload as string), row);
            await this.dequeue(row.id);
          }
        );
      }
    }
    this._flushingQueue = false;
  }

  /**
   * Dequeue a task by ID
   * @param id ID of the task to dequeue
   */
  async dequeue(id: string) {
    this.sql`DELETE FROM cf_agents_queues WHERE id = ${id}`;
  }

  /**
   * Dequeue all tasks
   */
  async dequeueAll() {
    this.sql`DELETE FROM cf_agents_queues`;
  }

  /**
   * Dequeue all tasks by callback
   * @param callback Name of the callback to dequeue
   */
  async dequeueAllByCallback(callback: string) {
    this.sql`DELETE FROM cf_agents_queues WHERE callback = ${callback}`;
  }

  /**
   * Get a queued task by ID
   * @param id ID of the task to get
   * @returns The task or undefined if not found
   */
  async getQueue(id: string): Promise<QueueItem<string> | undefined> {
    const result = this.sql<QueueItem<string>>`
      SELECT * FROM cf_agents_queues WHERE id = ${id}
    `;
    return result
      ? { ...result[0], payload: JSON.parse(result[0].payload) }
      : undefined;
  }

  /**
   * Get all queues by key and value
   * @param key Key to filter by
   * @param value Value to filter by
   * @returns Array of matching QueueItem objects
   */
  async getQueues(key: string, value: string): Promise<QueueItem<string>[]> {
    const result = this.sql<QueueItem<string>>`
      SELECT * FROM cf_agents_queues
    `;
    return result.filter((row) => JSON.parse(row.payload)[key] === value);
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

    const emitScheduleCreate = (schedule: Schedule<T>) =>
      this.observability?.emit(
        {
          displayMessage: `Schedule ${schedule.id} created`,
          id: nanoid(),
          payload: {
            callback: callback as string,
            id: id
          },
          timestamp: Date.now(),
          type: "schedule:create"
        },
        this.ctx
      );

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

      const schedule: Schedule<T> = {
        callback: callback,
        id,
        payload: payload as T,
        time: timestamp,
        type: "scheduled"
      };

      emitScheduleCreate(schedule);

      return schedule;
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

      const schedule: Schedule<T> = {
        callback: callback,
        delayInSeconds: when,
        id,
        payload: payload as T,
        time: timestamp,
        type: "delayed"
      };

      emitScheduleCreate(schedule);

      return schedule;
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

      const schedule: Schedule<T> = {
        callback: callback,
        cron: when,
        id,
        payload: payload as T,
        time: timestamp,
        type: "cron"
      };

      emitScheduleCreate(schedule);

      return schedule;
    }
    throw new Error(
      `Invalid schedule type: ${JSON.stringify(when)}(${typeof when}) trying to schedule ${callback}`
    );
  }

  /**
   * Schedule a task to run repeatedly at a fixed interval
   * @template T Type of the payload data
   * @param intervalSeconds Number of seconds between executions
   * @param callback Name of the method to call
   * @param payload Data to pass to the callback
   * @returns Schedule object representing the scheduled task
   */
  async scheduleEvery<T = string>(
    intervalSeconds: number,
    callback: keyof this,
    payload?: T
  ): Promise<Schedule<T>> {
    // DO alarms have a max schedule time of 30 days
    const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60; // 30 days in seconds

    if (typeof intervalSeconds !== "number" || intervalSeconds <= 0) {
      throw new Error("intervalSeconds must be a positive number");
    }

    if (intervalSeconds > MAX_INTERVAL_SECONDS) {
      throw new Error(
        `intervalSeconds cannot exceed ${MAX_INTERVAL_SECONDS} seconds (30 days)`
      );
    }

    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }

    if (typeof this[callback] !== "function") {
      throw new Error(`this.${callback} is not a function`);
    }

    const id = nanoid(9);
    const time = new Date(Date.now() + intervalSeconds * 1000);
    const timestamp = Math.floor(time.getTime() / 1000);

    this.sql`
      INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, intervalSeconds, time, running)
      VALUES (${id}, ${callback}, ${JSON.stringify(payload)}, 'interval', ${intervalSeconds}, ${timestamp}, 0)
    `;

    await this._scheduleNextAlarm();

    const schedule: Schedule<T> = {
      callback: callback,
      id,
      intervalSeconds,
      payload: payload as T,
      time: timestamp,
      type: "interval"
    };

    this.observability?.emit(
      {
        displayMessage: `Schedule ${schedule.id} created`,
        id: nanoid(),
        payload: {
          callback: callback as string,
          id: id
        },
        timestamp: Date.now(),
        type: "schedule:create"
      },
      this.ctx
    );

    return schedule;
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
    if (!result || result.length === 0) {
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
      type?: "scheduled" | "delayed" | "cron" | "interval";
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
        payload: JSON.parse(row.payload as string) as T
      })) as Schedule<T>[];

    return result;
  }

  /**
   * Cancel a scheduled task
   * @param id ID of the task to cancel
   * @returns true if the task was cancelled, false if the task was not found
   */
  async cancelSchedule(id: string): Promise<boolean> {
    const schedule = await this.getSchedule(id);
    if (!schedule) {
      return false;
    }

    this.observability?.emit(
      {
        displayMessage: `Schedule ${id} cancelled`,
        id: nanoid(),
        payload: {
          callback: schedule.callback,
          id: schedule.id
        },
        timestamp: Date.now(),
        type: "schedule:cancel"
      },
      this.ctx
    );

    this.sql`DELETE FROM cf_agents_schedules WHERE id = ${id}`;

    await this._scheduleNextAlarm();
    return true;
  }

  private async _scheduleNextAlarm() {
    // Find the next schedule that needs to be executed
    const result = this.sql`
      SELECT time FROM cf_agents_schedules
      WHERE time >= ${Math.floor(Date.now() / 1000)}
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
    const result = this.sql<
      Schedule<string> & { running?: number; intervalSeconds?: number }
    >`
      SELECT * FROM cf_agents_schedules WHERE time <= ${now}
    `;

    if (result && Array.isArray(result)) {
      for (const row of result) {
        const callback = this[row.callback as keyof Agent<Env>];
        if (!callback) {
          console.error(`callback ${row.callback} not found`);
          continue;
        }

        // Overlap prevention for interval schedules with hung callback detection
        if (row.type === "interval" && row.running === 1) {
          const executionStartedAt =
            (row as { execution_started_at?: number }).execution_started_at ??
            0;
          const hungTimeoutSeconds =
            this._resolvedOptions.hungScheduleTimeoutSeconds;
          const elapsedSeconds = now - executionStartedAt;

          if (elapsedSeconds < hungTimeoutSeconds) {
            console.warn(
              `Skipping interval schedule ${row.id}: previous execution still running`
            );
            continue;
          }
          // Previous execution appears hung, force reset and re-execute
          console.warn(
            `Forcing reset of hung interval schedule ${row.id} (started ${elapsedSeconds}s ago)`
          );
        }

        // Mark interval as running before execution
        if (row.type === "interval") {
          this
            .sql`UPDATE cf_agents_schedules SET running = 1, execution_started_at = ${now} WHERE id = ${row.id}`;
        }

        await agentContext.run(
          {
            agent: this,
            connection: undefined,
            request: undefined,
            email: undefined
          },
          async () => {
            try {
              this.observability?.emit(
                {
                  displayMessage: `Schedule ${row.id} executed`,
                  id: nanoid(),
                  payload: {
                    callback: row.callback,
                    id: row.id
                  },
                  timestamp: Date.now(),
                  type: "schedule:execute"
                },
                this.ctx
              );

              await (
                callback as (
                  payload: unknown,
                  schedule: Schedule<unknown>
                ) => Promise<void>
              ).bind(this)(JSON.parse(row.payload as string), row);
            } catch (e) {
              console.error(`error executing callback "${row.callback}"`, e);
              // Route schedule errors through onError for consistency
              try {
                await this.onError(e);
              } catch {
                // swallow onError errors
              }
            }
          }
        );

        if (this._destroyed) return;

        if (row.type === "cron") {
          // Update next execution time for cron schedules
          const nextExecutionTime = getNextCronTime(row.cron);
          const nextTimestamp = Math.floor(nextExecutionTime.getTime() / 1000);

          this.sql`
            UPDATE cf_agents_schedules SET time = ${nextTimestamp} WHERE id = ${row.id}
          `;
        } else if (row.type === "interval") {
          // Reset running flag and schedule next interval execution
          const nextTimestamp =
            Math.floor(Date.now() / 1000) + (row.intervalSeconds ?? 0);

          this.sql`
            UPDATE cf_agents_schedules SET running = 0, time = ${nextTimestamp} WHERE id = ${row.id}
          `;
        } else {
          // Delete one-time schedules after execution
          this.sql`
            DELETE FROM cf_agents_schedules WHERE id = ${row.id}
          `;
        }
      }
    }
    if (this._destroyed) return;

    // Schedule the next alarm
    await this._scheduleNextAlarm();
  };

  /**
   * Destroy the Agent, removing all state and scheduled tasks
   */
  async destroy() {
    // drop all tables
    this.sql`DROP TABLE IF EXISTS cf_agents_mcp_servers`;
    this.sql`DROP TABLE IF EXISTS cf_agents_state`;
    this.sql`DROP TABLE IF EXISTS cf_agents_schedules`;
    this.sql`DROP TABLE IF EXISTS cf_agents_queues`;
    this.sql`DROP TABLE IF EXISTS cf_agents_workflows`;

    // delete all alarms
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();

    this._disposables.dispose();
    await this.mcp.dispose();

    this._destroyed = true;

    // `ctx.abort` throws an uncatchable error, so we yield to the event loop
    // to avoid capturing it and let handlers finish cleaning up
    setTimeout(() => {
      this.ctx.abort("destroyed");
    }, 0);

    this.observability?.emit(
      {
        displayMessage: "Agent destroyed",
        id: nanoid(),
        payload: {},
        timestamp: Date.now(),
        type: "destroy"
      },
      this.ctx
    );
  }

  /**
   * Check if a method is callable
   * @param method The method name to check
   * @returns True if the method is marked as callable
   */
  private _isCallable(method: string): boolean {
    return callableMetadata.has(this[method as keyof this] as Function);
  }

  /**
   * Get all methods marked as callable on this Agent
   * @returns A map of method names to their metadata
   */
  getCallableMethods(): Map<string, CallableMetadata> {
    const result = new Map<string, CallableMetadata>();

    // Walk the entire prototype chain to find callable methods from parent classes
    let prototype = Object.getPrototypeOf(this);
    while (prototype && prototype !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(prototype)) {
        if (name === "constructor") continue;
        // Don't override child class methods (first one wins)
        if (result.has(name)) continue;

        try {
          const fn = prototype[name];
          if (typeof fn === "function") {
            const meta = callableMetadata.get(fn as Function);
            if (meta) {
              result.set(name, meta);
            }
          }
        } catch (e) {
          // Skip properties that can't be accessed (e.g., private members with #)
          // These throw TypeError when accessed
          if (!(e instanceof TypeError)) {
            throw e;
          }
        }
      }
      prototype = Object.getPrototypeOf(prototype);
    }

    return result;
  }

  // ==========================================
  // Workflow Integration Methods
  // ==========================================

  /**
   * Start a workflow and track it in this Agent's database.
   * Automatically injects agent identity into the workflow params.
   *
   * @template P - Type of params to pass to the workflow
   * @param workflowName - Name of the workflow binding in env (e.g., 'MY_WORKFLOW')
   * @param params - Params to pass to the workflow
   * @param options - Optional workflow options
   * @returns The workflow instance ID
   *
   * @example
   * ```typescript
   * const workflowId = await this.runWorkflow(
   *   'MY_WORKFLOW',
   *   { taskId: '123', data: 'process this' }
   * );
   * ```
   */
  async runWorkflow<P = unknown>(
    workflowName: WorkflowName<Env>,
    params: P,
    options?: RunWorkflowOptions
  ): Promise<string> {
    // Look up the workflow binding by name
    const workflow = this._findWorkflowBindingByName(workflowName);
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowName}' not found in environment`
      );
    }

    // Find the binding name for this Agent's namespace
    const agentBindingName =
      options?.agentBinding ?? this._findAgentBindingName();
    if (!agentBindingName) {
      throw new Error(
        "Could not detect Agent binding name from class name. " +
          "Pass it explicitly via options.agentBinding"
      );
    }

    // Generate workflow ID if not provided
    const workflowId = options?.id ?? nanoid();

    // Inject agent identity and workflow name into params
    const augmentedParams = {
      ...params,
      __agentName: this.name,
      __agentBinding: agentBindingName,
      __workflowName: workflowName
    };

    // Create the workflow instance
    const instance = await workflow.create({
      id: workflowId,
      params: augmentedParams
    });

    // Track the workflow in our database
    const id = nanoid();
    const metadataJson = options?.metadata
      ? JSON.stringify(options.metadata)
      : null;
    try {
      this.sql`
        INSERT INTO cf_agents_workflows (id, workflow_id, workflow_name, status, metadata)
        VALUES (${id}, ${instance.id}, ${workflowName}, 'queued', ${metadataJson})
      `;
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.includes("UNIQUE constraint failed")
      ) {
        throw new Error(
          `Workflow with ID "${workflowId}" is already being tracked`
        );
      }
      throw e;
    }

    this.observability?.emit(
      {
        displayMessage: `Workflow ${instance.id} started`,
        id: nanoid(),
        payload: {
          workflowId: instance.id,
          workflowName: workflowName
        },
        timestamp: Date.now(),
        type: "workflow:start"
      },
      this.ctx
    );

    return instance.id;
  }

  /**
   * Send an event to a running workflow.
   * The workflow can wait for this event using step.waitForEvent().
   *
   * @param workflowName - Name of the workflow binding in env (e.g., 'MY_WORKFLOW')
   * @param workflowId - ID of the workflow instance
   * @param event - Event to send
   *
   * @example
   * ```typescript
   * await this.sendWorkflowEvent(
   *   'MY_WORKFLOW',
   *   workflowId,
   *   { type: 'approval', payload: { approved: true } }
   * );
   * ```
   */
  async sendWorkflowEvent(
    workflowName: WorkflowName<Env>,
    workflowId: string,
    event: WorkflowEventPayload
  ): Promise<void> {
    const workflow = this._findWorkflowBindingByName(workflowName);
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowName}' not found in environment`
      );
    }

    const instance = await workflow.get(workflowId);
    await instance.sendEvent(event);

    this.observability?.emit(
      {
        displayMessage: `Event sent to workflow ${workflowId}`,
        id: nanoid(),
        payload: {
          workflowId,
          eventType: event.type
        },
        timestamp: Date.now(),
        type: "workflow:event"
      },
      this.ctx
    );
  }

  /**
   * Approve a waiting workflow.
   * Sends an approval event to the workflow that can be received by waitForApproval().
   *
   * @param workflowId - ID of the workflow to approve
   * @param data - Optional approval data (reason, metadata)
   *
   * @example
   * ```typescript
   * await this.approveWorkflow(workflowId, {
   *   reason: 'Approved by admin',
   *   metadata: { approvedBy: userId }
   * });
   * ```
   */
  async approveWorkflow(
    workflowId: string,
    data?: { reason?: string; metadata?: Record<string, unknown> }
  ): Promise<void> {
    const workflowInfo = this.getWorkflow(workflowId);
    if (!workflowInfo) {
      throw new Error(`Workflow ${workflowId} not found in tracking table`);
    }

    await this.sendWorkflowEvent(
      workflowInfo.workflowName as WorkflowName<Env>,
      workflowId,
      {
        type: "approval",
        payload: {
          approved: true,
          reason: data?.reason,
          metadata: data?.metadata
        }
      }
    );

    this.observability?.emit(
      {
        displayMessage: `Workflow ${workflowId} approved`,
        id: nanoid(),
        payload: { workflowId, reason: data?.reason },
        timestamp: Date.now(),
        type: "workflow:approved"
      },
      this.ctx
    );
  }

  /**
   * Reject a waiting workflow.
   * Sends a rejection event to the workflow that will cause waitForApproval() to throw.
   *
   * @param workflowId - ID of the workflow to reject
   * @param data - Optional rejection data (reason)
   *
   * @example
   * ```typescript
   * await this.rejectWorkflow(workflowId, {
   *   reason: 'Request denied by admin'
   * });
   * ```
   */
  async rejectWorkflow(
    workflowId: string,
    data?: { reason?: string }
  ): Promise<void> {
    const workflowInfo = this.getWorkflow(workflowId);
    if (!workflowInfo) {
      throw new Error(`Workflow ${workflowId} not found in tracking table`);
    }

    await this.sendWorkflowEvent(
      workflowInfo.workflowName as WorkflowName<Env>,
      workflowId,
      {
        type: "approval",
        payload: {
          approved: false,
          reason: data?.reason
        }
      }
    );

    this.observability?.emit(
      {
        displayMessage: `Workflow ${workflowId} rejected`,
        id: nanoid(),
        payload: { workflowId, reason: data?.reason },
        timestamp: Date.now(),
        type: "workflow:rejected"
      },
      this.ctx
    );
  }

  /**
   * Terminate a running workflow.
   * This immediately stops the workflow and sets its status to "terminated".
   *
   * @param workflowId - ID of the workflow to terminate (must be tracked via runWorkflow)
   * @throws Error if workflow not found in tracking table
   * @throws Error if workflow binding not found in environment
   * @throws Error if workflow is already completed/errored/terminated (from Cloudflare)
   *
   * @note `terminate()` is not yet supported in local development (wrangler dev).
   * It will throw an error locally but works when deployed to Cloudflare.
   *
   * @example
   * ```typescript
   * await this.terminateWorkflow(workflowId);
   * ```
   */
  async terminateWorkflow(workflowId: string): Promise<void> {
    const workflowInfo = this.getWorkflow(workflowId);
    if (!workflowInfo) {
      throw new Error(`Workflow ${workflowId} not found in tracking table`);
    }

    const workflow = this._findWorkflowBindingByName(
      workflowInfo.workflowName as WorkflowName<Env>
    );
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowInfo.workflowName}' not found in environment`
      );
    }

    const instance = await workflow.get(workflowId);
    try {
      await instance.terminate();
    } catch (err) {
      if (err instanceof Error && err.message.includes("Not implemented")) {
        throw new Error(
          "terminateWorkflow() is not supported in local development. " +
            "Deploy to Cloudflare to use this feature. " +
            "Follow https://github.com/cloudflare/agents/issues/823 for details and updates."
        );
      }
      throw err;
    }

    // Update tracking table with new status
    const status = await instance.status();
    this._updateWorkflowTracking(workflowId, status);

    this.observability?.emit(
      {
        displayMessage: `Workflow ${workflowId} terminated`,
        id: nanoid(),
        payload: { workflowId, workflowName: workflowInfo.workflowName },
        timestamp: Date.now(),
        type: "workflow:terminated"
      },
      this.ctx
    );
  }

  /**
   * Pause a running workflow.
   * The workflow can be resumed later with resumeWorkflow().
   *
   * @param workflowId - ID of the workflow to pause (must be tracked via runWorkflow)
   * @throws Error if workflow not found in tracking table
   * @throws Error if workflow binding not found in environment
   * @throws Error if workflow is not running (from Cloudflare)
   *
   * @note `pause()` is not yet supported in local development (wrangler dev).
   * It will throw an error locally but works when deployed to Cloudflare.
   *
   * @example
   * ```typescript
   * await this.pauseWorkflow(workflowId);
   * ```
   */
  async pauseWorkflow(workflowId: string): Promise<void> {
    const workflowInfo = this.getWorkflow(workflowId);
    if (!workflowInfo) {
      throw new Error(`Workflow ${workflowId} not found in tracking table`);
    }

    const workflow = this._findWorkflowBindingByName(
      workflowInfo.workflowName as WorkflowName<Env>
    );
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowInfo.workflowName}' not found in environment`
      );
    }

    const instance = await workflow.get(workflowId);
    try {
      await instance.pause();
    } catch (err) {
      if (err instanceof Error && err.message.includes("Not implemented")) {
        throw new Error(
          "pauseWorkflow() is not supported in local development. " +
            "Deploy to Cloudflare to use this feature. " +
            "Follow https://github.com/cloudflare/agents/issues/823 for details and updates."
        );
      }
      throw err;
    }

    const status = await instance.status();
    this._updateWorkflowTracking(workflowId, status);

    this.observability?.emit(
      {
        displayMessage: `Workflow ${workflowId} paused`,
        id: nanoid(),
        payload: { workflowId, workflowName: workflowInfo.workflowName },
        timestamp: Date.now(),
        type: "workflow:paused"
      },
      this.ctx
    );
  }

  /**
   * Resume a paused workflow.
   *
   * @param workflowId - ID of the workflow to resume (must be tracked via runWorkflow)
   * @throws Error if workflow not found in tracking table
   * @throws Error if workflow binding not found in environment
   * @throws Error if workflow is not paused (from Cloudflare)
   *
   * @note `resume()` is not yet supported in local development (wrangler dev).
   * It will throw an error locally but works when deployed to Cloudflare.
   *
   * @example
   * ```typescript
   * await this.resumeWorkflow(workflowId);
   * ```
   */
  async resumeWorkflow(workflowId: string): Promise<void> {
    const workflowInfo = this.getWorkflow(workflowId);
    if (!workflowInfo) {
      throw new Error(`Workflow ${workflowId} not found in tracking table`);
    }

    const workflow = this._findWorkflowBindingByName(
      workflowInfo.workflowName as WorkflowName<Env>
    );
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowInfo.workflowName}' not found in environment`
      );
    }

    const instance = await workflow.get(workflowId);
    try {
      await instance.resume();
    } catch (err) {
      if (err instanceof Error && err.message.includes("Not implemented")) {
        throw new Error(
          "resumeWorkflow() is not supported in local development. " +
            "Deploy to Cloudflare to use this feature. " +
            "Follow https://github.com/cloudflare/agents/issues/823 for details and updates."
        );
      }
      throw err;
    }

    const status = await instance.status();
    this._updateWorkflowTracking(workflowId, status);

    this.observability?.emit(
      {
        displayMessage: `Workflow ${workflowId} resumed`,
        id: nanoid(),
        payload: { workflowId, workflowName: workflowInfo.workflowName },
        timestamp: Date.now(),
        type: "workflow:resumed"
      },
      this.ctx
    );
  }

  /**
   * Restart a workflow instance.
   * This re-runs the workflow from the beginning with the same ID.
   *
   * @param workflowId - ID of the workflow to restart (must be tracked via runWorkflow)
   * @param options - Optional settings
   * @param options.resetTracking - If true (default), resets created_at and clears error fields.
   *                                If false, preserves original timestamps.
   * @throws Error if workflow not found in tracking table
   * @throws Error if workflow binding not found in environment
   *
   * @note `restart()` is not yet supported in local development (wrangler dev).
   * It will throw an error locally but works when deployed to Cloudflare.
   *
   * @example
   * ```typescript
   * // Reset tracking (default)
   * await this.restartWorkflow(workflowId);
   *
   * // Preserve original timestamps
   * await this.restartWorkflow(workflowId, { resetTracking: false });
   * ```
   */
  async restartWorkflow(
    workflowId: string,
    options: { resetTracking?: boolean } = {}
  ): Promise<void> {
    const { resetTracking = true } = options;

    const workflowInfo = this.getWorkflow(workflowId);
    if (!workflowInfo) {
      throw new Error(`Workflow ${workflowId} not found in tracking table`);
    }

    const workflow = this._findWorkflowBindingByName(
      workflowInfo.workflowName as WorkflowName<Env>
    );
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowInfo.workflowName}' not found in environment`
      );
    }

    const instance = await workflow.get(workflowId);
    try {
      await instance.restart();
    } catch (err) {
      if (err instanceof Error && err.message.includes("Not implemented")) {
        throw new Error(
          "restartWorkflow() is not supported in local development. " +
            "Deploy to Cloudflare to use this feature. " +
            "Follow https://github.com/cloudflare/agents/issues/823 for details and updates."
        );
      }
      throw err;
    }

    if (resetTracking) {
      // Reset tracking fields for fresh start
      const now = Math.floor(Date.now() / 1000);
      this.sql`
        UPDATE cf_agents_workflows
        SET status = 'queued',
            created_at = ${now},
            updated_at = ${now},
            completed_at = NULL,
            error_name = NULL,
            error_message = NULL
        WHERE workflow_id = ${workflowId}
      `;
    } else {
      // Just update status from Cloudflare
      const status = await instance.status();
      this._updateWorkflowTracking(workflowId, status);
    }

    this.observability?.emit(
      {
        displayMessage: `Workflow ${workflowId} restarted`,
        id: nanoid(),
        payload: { workflowId, workflowName: workflowInfo.workflowName },
        timestamp: Date.now(),
        type: "workflow:restarted"
      },
      this.ctx
    );
  }

  /**
   * Find a workflow binding by its name.
   */
  private _findWorkflowBindingByName(
    workflowName: string
  ): Workflow | undefined {
    const binding = (this.env as Record<string, unknown>)[workflowName];
    if (
      binding &&
      typeof binding === "object" &&
      "create" in binding &&
      "get" in binding
    ) {
      return binding as Workflow;
    }
    return undefined;
  }

  /**
   * Get all workflow binding names from the environment.
   */
  private _getWorkflowBindingNames(): string[] {
    const names: string[] = [];
    for (const [key, value] of Object.entries(
      this.env as Record<string, unknown>
    )) {
      if (
        value &&
        typeof value === "object" &&
        "create" in value &&
        "get" in value
      ) {
        names.push(key);
      }
    }
    return names;
  }

  /**
   * Get the status of a workflow and update the tracking record.
   *
   * @param workflowName - Name of the workflow binding in env (e.g., 'MY_WORKFLOW')
   * @param workflowId - ID of the workflow instance
   * @returns The workflow status
   */
  async getWorkflowStatus(
    workflowName: WorkflowName<Env>,
    workflowId: string
  ): Promise<InstanceStatus> {
    const workflow = this._findWorkflowBindingByName(workflowName);
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowName}' not found in environment`
      );
    }

    const instance = await workflow.get(workflowId);
    const status = await instance.status();

    // Update the tracking record
    this._updateWorkflowTracking(workflowId, status);

    return status;
  }

  /**
   * Get a tracked workflow by ID.
   *
   * @param workflowId - Workflow instance ID
   * @returns Workflow info or undefined if not found
   */
  getWorkflow(workflowId: string): WorkflowInfo | undefined {
    const rows = this.sql<WorkflowTrackingRow>`
      SELECT * FROM cf_agents_workflows WHERE workflow_id = ${workflowId}
    `;

    if (!rows || rows.length === 0) {
      return undefined;
    }

    return this._rowToWorkflowInfo(rows[0]);
  }

  /**
   * Query tracked workflows with cursor-based pagination.
   *
   * @param criteria - Query criteria including optional cursor for pagination
   * @returns WorkflowPage with workflows, total count, and next cursor
   *
   * @example
   * ```typescript
   * // First page
   * const page1 = this.getWorkflows({ status: 'running', limit: 20 });
   *
   * // Next page
   * if (page1.nextCursor) {
   *   const page2 = this.getWorkflows({
   *     status: 'running',
   *     limit: 20,
   *     cursor: page1.nextCursor
   *   });
   * }
   * ```
   */
  getWorkflows(criteria: WorkflowQueryCriteria = {}): WorkflowPage {
    const limit = Math.min(criteria.limit ?? 50, 100);
    const isAsc = criteria.orderBy === "asc";

    // Get total count (ignores cursor and limit)
    const total = this._countWorkflows(criteria);

    // Build base query
    let query = "SELECT * FROM cf_agents_workflows WHERE 1=1";
    const params: (string | number | boolean)[] = [];

    if (criteria.status) {
      const statuses = Array.isArray(criteria.status)
        ? criteria.status
        : [criteria.status];
      const placeholders = statuses.map(() => "?").join(", ");
      query += ` AND status IN (${placeholders})`;
      params.push(...statuses);
    }

    if (criteria.workflowName) {
      query += " AND workflow_name = ?";
      params.push(criteria.workflowName);
    }

    if (criteria.metadata) {
      for (const [key, value] of Object.entries(criteria.metadata)) {
        query += ` AND json_extract(metadata, '$.' || ?) = ?`;
        params.push(key, value);
      }
    }

    // Apply cursor for keyset pagination
    if (criteria.cursor) {
      const cursor = this._decodeCursor(criteria.cursor);
      if (isAsc) {
        // ASC: get items after cursor
        query +=
          " AND (created_at > ? OR (created_at = ? AND workflow_id > ?))";
      } else {
        // DESC: get items before cursor
        query +=
          " AND (created_at < ? OR (created_at = ? AND workflow_id < ?))";
      }
      params.push(cursor.createdAt, cursor.createdAt, cursor.workflowId);
    }

    // Order by created_at and workflow_id for consistent keyset pagination
    query += ` ORDER BY created_at ${isAsc ? "ASC" : "DESC"}, workflow_id ${isAsc ? "ASC" : "DESC"}`;

    // Fetch limit + 1 to detect if there are more pages
    query += " LIMIT ?";
    params.push(limit + 1);

    const rows = this.ctx.storage.sql
      .exec(query, ...params)
      .toArray() as WorkflowTrackingRow[];

    const hasMore = rows.length > limit;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;
    const workflows = resultRows.map((row) => this._rowToWorkflowInfo(row));

    // Build next cursor from last item
    const nextCursor =
      hasMore && workflows.length > 0
        ? this._encodeCursor(workflows[workflows.length - 1])
        : null;

    return { workflows, total, nextCursor };
  }

  /**
   * Count workflows matching criteria (for pagination total).
   */
  private _countWorkflows(
    criteria: Omit<WorkflowQueryCriteria, "limit" | "cursor" | "orderBy"> & {
      createdBefore?: Date;
    }
  ): number {
    let query = "SELECT COUNT(*) as count FROM cf_agents_workflows WHERE 1=1";
    const params: (string | number | boolean)[] = [];

    if (criteria.status) {
      const statuses = Array.isArray(criteria.status)
        ? criteria.status
        : [criteria.status];
      const placeholders = statuses.map(() => "?").join(", ");
      query += ` AND status IN (${placeholders})`;
      params.push(...statuses);
    }

    if (criteria.workflowName) {
      query += " AND workflow_name = ?";
      params.push(criteria.workflowName);
    }

    if (criteria.metadata) {
      for (const [key, value] of Object.entries(criteria.metadata)) {
        query += ` AND json_extract(metadata, '$.' || ?) = ?`;
        params.push(key, value);
      }
    }

    if (criteria.createdBefore) {
      query += " AND created_at < ?";
      params.push(Math.floor(criteria.createdBefore.getTime() / 1000));
    }

    const result = this.ctx.storage.sql.exec(query, ...params).toArray() as {
      count: number;
    }[];

    return result[0]?.count ?? 0;
  }

  /**
   * Encode a cursor from workflow info for pagination.
   * Stores createdAt as Unix timestamp in seconds (matching DB storage).
   */
  private _encodeCursor(workflow: WorkflowInfo): string {
    return btoa(
      JSON.stringify({
        c: Math.floor(workflow.createdAt.getTime() / 1000),
        i: workflow.workflowId
      })
    );
  }

  /**
   * Decode a pagination cursor.
   * Returns createdAt as Unix timestamp in seconds (matching DB storage).
   */
  private _decodeCursor(cursor: string): {
    createdAt: number;
    workflowId: string;
  } {
    try {
      const data = JSON.parse(atob(cursor));
      if (typeof data.c !== "number" || typeof data.i !== "string") {
        throw new Error("Invalid cursor structure");
      }
      return { createdAt: data.c, workflowId: data.i };
    } catch {
      throw new Error(
        "Invalid pagination cursor. The cursor may be malformed or corrupted."
      );
    }
  }

  /**
   * Delete a workflow tracking record.
   *
   * @param workflowId - ID of the workflow to delete
   * @returns true if a record was deleted, false if not found
   */
  deleteWorkflow(workflowId: string): boolean {
    // First check if workflow exists
    const existing = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_workflows WHERE workflow_id = ${workflowId}
    `;
    if (!existing[0] || existing[0].count === 0) {
      return false;
    }
    this.sql`DELETE FROM cf_agents_workflows WHERE workflow_id = ${workflowId}`;
    return true;
  }

  /**
   * Delete workflow tracking records matching criteria.
   * Useful for cleaning up old completed/errored workflows.
   *
   * @param criteria - Criteria for which workflows to delete
   * @returns Number of records matching criteria (expected deleted count)
   *
   * @example
   * ```typescript
   * // Delete all completed workflows created more than 7 days ago
   * const deleted = this.deleteWorkflows({
   *   status: 'complete',
   *   createdBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
   * });
   *
   * // Delete all errored and terminated workflows
   * const deleted = this.deleteWorkflows({
   *   status: ['errored', 'terminated']
   * });
   * ```
   */
  deleteWorkflows(
    criteria: Omit<WorkflowQueryCriteria, "limit" | "orderBy"> & {
      createdBefore?: Date;
    } = {}
  ): number {
    let query = "DELETE FROM cf_agents_workflows WHERE 1=1";
    const params: (string | number | boolean)[] = [];

    if (criteria.status) {
      const statuses = Array.isArray(criteria.status)
        ? criteria.status
        : [criteria.status];
      const placeholders = statuses.map(() => "?").join(", ");
      query += ` AND status IN (${placeholders})`;
      params.push(...statuses);
    }

    if (criteria.workflowName) {
      query += " AND workflow_name = ?";
      params.push(criteria.workflowName);
    }

    if (criteria.metadata) {
      for (const [key, value] of Object.entries(criteria.metadata)) {
        query += ` AND json_extract(metadata, '$.' || ?) = ?`;
        params.push(key, value);
      }
    }

    if (criteria.createdBefore) {
      query += " AND created_at < ?";
      params.push(Math.floor(criteria.createdBefore.getTime() / 1000));
    }

    const cursor = this.ctx.storage.sql.exec(query, ...params);
    return cursor.rowsWritten;
  }

  /**
   * Migrate workflow tracking records from an old binding name to a new one.
   * Use this after renaming a workflow binding in wrangler.toml.
   *
   * @param oldName - Previous workflow binding name
   * @param newName - New workflow binding name
   * @returns Number of records migrated
   *
   * @example
   * ```typescript
   * // After renaming OLD_WORKFLOW to NEW_WORKFLOW in wrangler.toml
   * async onStart() {
   *   const migrated = this.migrateWorkflowBinding('OLD_WORKFLOW', 'NEW_WORKFLOW');
   * }
   * ```
   */
  migrateWorkflowBinding(oldName: string, newName: string): number {
    // Validate new binding exists
    if (!this._findWorkflowBindingByName(newName)) {
      throw new Error(`Workflow binding '${newName}' not found in environment`);
    }

    const result = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_workflows WHERE workflow_name = ${oldName}
    `;
    const count = result[0]?.count ?? 0;

    if (count > 0) {
      this
        .sql`UPDATE cf_agents_workflows SET workflow_name = ${newName} WHERE workflow_name = ${oldName}`;
      console.log(
        `[Agent] Migrated ${count} workflow(s) from '${oldName}' to '${newName}'`
      );
    }

    return count;
  }

  /**
   * Update workflow tracking record from InstanceStatus
   */
  private _updateWorkflowTracking(
    workflowId: string,
    status: InstanceStatus
  ): void {
    const statusName = status.status;
    const now = Math.floor(Date.now() / 1000);

    // Determine if workflow is complete
    const completedStatuses: WorkflowStatus[] = [
      "complete",
      "errored",
      "terminated"
    ];
    const completedAt = completedStatuses.includes(statusName) ? now : null;

    // Extract error info if present
    const errorName = status.error?.name ?? null;
    const errorMessage = status.error?.message ?? null;

    this.sql`
      UPDATE cf_agents_workflows
      SET status = ${statusName},
          error_name = ${errorName},
          error_message = ${errorMessage},
          updated_at = ${now},
          completed_at = ${completedAt}
      WHERE workflow_id = ${workflowId}
    `;
  }

  /**
   * Convert a database row to WorkflowInfo
   */
  private _rowToWorkflowInfo(row: WorkflowTrackingRow): WorkflowInfo {
    return {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      status: row.status,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      error: row.error_name
        ? { name: row.error_name, message: row.error_message ?? "" }
        : null,
      createdAt: new Date(row.created_at * 1000),
      updatedAt: new Date(row.updated_at * 1000),
      completedAt: row.completed_at ? new Date(row.completed_at * 1000) : null
    };
  }

  /**
   * Find the binding name for this Agent's namespace by matching class name.
   * Returns undefined if no match found - use options.agentBinding as fallback.
   */
  private _findAgentBindingName(): string | undefined {
    const className = this._ParentClass.name;
    for (const [key, value] of Object.entries(
      this.env as Record<string, unknown>
    )) {
      if (
        value &&
        typeof value === "object" &&
        "idFromName" in value &&
        typeof value.idFromName === "function"
      ) {
        // Check if this namespace's binding name matches our class name
        if (
          key === className ||
          camelCaseToKebabCase(key) === camelCaseToKebabCase(className)
        ) {
          return key;
        }
      }
    }
    return undefined;
  }

  // ==========================================
  // Workflow Lifecycle Callbacks
  // ==========================================

  /**
   * Handle a callback from a workflow.
   * Called when the Agent receives a callback at /_workflow/callback.
   * Override this to handle all callback types in one place.
   *
   * @param callback - The callback payload
   */
  async onWorkflowCallback(callback: WorkflowCallback): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    switch (callback.type) {
      case "progress":
        // Update tracking status to "running" when receiving progress
        // Only transition from queued/waiting to avoid overwriting terminal states
        this.sql`
          UPDATE cf_agents_workflows
          SET status = 'running', updated_at = ${now}
          WHERE workflow_id = ${callback.workflowId} AND status IN ('queued', 'waiting')
        `;
        await this.onWorkflowProgress(
          callback.workflowName,
          callback.workflowId,
          callback.progress
        );
        break;
      case "complete":
        // Update tracking status to "complete"
        // Don't overwrite if already terminated/paused (race condition protection)
        this.sql`
          UPDATE cf_agents_workflows
          SET status = 'complete', updated_at = ${now}, completed_at = ${now}
          WHERE workflow_id = ${callback.workflowId}
            AND status NOT IN ('terminated', 'paused')
        `;
        await this.onWorkflowComplete(
          callback.workflowName,
          callback.workflowId,
          callback.result
        );
        break;
      case "error":
        // Update tracking status to "errored"
        // Don't overwrite if already terminated/paused (race condition protection)
        this.sql`
          UPDATE cf_agents_workflows
          SET status = 'errored', updated_at = ${now}, completed_at = ${now},
              error_name = 'WorkflowError', error_message = ${callback.error}
          WHERE workflow_id = ${callback.workflowId}
            AND status NOT IN ('terminated', 'paused')
        `;
        await this.onWorkflowError(
          callback.workflowName,
          callback.workflowId,
          callback.error
        );
        break;
      case "event":
        // No status change for events - they can occur at any stage
        await this.onWorkflowEvent(
          callback.workflowName,
          callback.workflowId,
          callback.event
        );
        break;
    }
  }

  /**
   * Called when a workflow reports progress.
   * Override to handle progress updates.
   *
   * @param workflowName - Workflow binding name
   * @param workflowId - ID of the workflow
   * @param progress - Typed progress data (default: DefaultProgress)
   */
  async onWorkflowProgress(
    _workflowName: string,
    _workflowId: string,
    _progress: unknown
  ): Promise<void> {
    // Override to handle progress updates
  }

  /**
   * Called when a workflow completes successfully.
   * Override to handle completion.
   *
   * @param workflowName - Workflow binding name
   * @param workflowId - ID of the workflow
   * @param result - Optional result data
   */
  async onWorkflowComplete(
    _workflowName: string,
    _workflowId: string,
    _result?: unknown
  ): Promise<void> {
    // Override to handle completion
  }

  /**
   * Called when a workflow encounters an error.
   * Override to handle errors.
   *
   * @param workflowName - Workflow binding name
   * @param workflowId - ID of the workflow
   * @param error - Error message
   */
  async onWorkflowError(
    _workflowName: string,
    _workflowId: string,
    _error: string
  ): Promise<void> {
    // Override to handle errors
  }

  /**
   * Called when a workflow sends a custom event.
   * Override to handle custom events.
   *
   * @param workflowName - Workflow binding name
   * @param workflowId - ID of the workflow
   * @param event - Custom event payload
   */
  async onWorkflowEvent(
    _workflowName: string,
    _workflowId: string,
    _event: unknown
  ): Promise<void> {
    // Override to handle custom events
  }

  // ============================================================
  // Internal RPC methods for AgentWorkflow communication
  // These are called via DO RPC, not exposed via HTTP
  // ============================================================

  /**
   * Handle a workflow callback via RPC.
   * @internal - Called by AgentWorkflow, do not call directly
   */
  async _workflow_handleCallback(callback: WorkflowCallback): Promise<void> {
    await this.onWorkflowCallback(callback);
  }

  /**
   * Broadcast a message to all connected clients via RPC.
   * @internal - Called by AgentWorkflow, do not call directly
   */
  _workflow_broadcast(message: unknown): void {
    this.broadcast(JSON.stringify(message));
  }

  /**
   * Update agent state via RPC.
   * @internal - Called by AgentWorkflow, do not call directly
   */
  _workflow_updateState(
    action: "set" | "merge" | "reset",
    state?: unknown
  ): void {
    if (action === "set") {
      this.setState(state as State);
    } else if (action === "merge") {
      const currentState = this.state ?? ({} as State);
      this.setState({
        ...currentState,
        ...(state as Record<string, unknown>)
      } as State);
    } else if (action === "reset") {
      this.setState(this.initialState);
    }
  }

  /**
   * Connect to a new MCP Server
   *
   * @example
   * // Simple usage
   * await this.addMcpServer("github", "https://mcp.github.com");
   *
   * @example
   * // With options (preferred for custom headers, transport, etc.)
   * await this.addMcpServer("github", "https://mcp.github.com", {
   *   transport: { headers: { "Authorization": "Bearer ..." } }
   * });
   *
   * @example
   * // Legacy 5-parameter signature (still supported)
   * await this.addMcpServer("github", url, callbackHost, agentsPrefix, options);
   *
   * @param serverName Name of the MCP server
   * @param url MCP Server URL
   * @param callbackHostOrOptions Options object, or callback host string (legacy)
   * @param agentsPrefix agents routing prefix if not using `agents` (legacy)
   * @param options MCP client and transport options (legacy)
   * @returns Server id and state - either "authenticating" with authUrl, or "ready"
   * @throws If connection or discovery fails
   */
  async addMcpServer(
    serverName: string,
    url: string,
    callbackHostOrOptions?: string | AddMcpServerOptions,
    agentsPrefix?: string,
    options?: {
      client?: ConstructorParameters<typeof Client>[1];
      transport?: {
        headers?: HeadersInit;
        type?: TransportType;
      };
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
    // Normalize arguments - support both new options API and legacy positional API
    let resolvedCallbackHost: string | undefined;
    let resolvedAgentsPrefix: string;
    let resolvedOptions:
      | {
          client?: ConstructorParameters<typeof Client>[1];
          transport?: {
            headers?: HeadersInit;
            type?: TransportType;
          };
        }
      | undefined;

    if (
      typeof callbackHostOrOptions === "object" &&
      callbackHostOrOptions !== null
    ) {
      // New API: options object as third parameter
      resolvedCallbackHost = callbackHostOrOptions.callbackHost;
      resolvedAgentsPrefix = callbackHostOrOptions.agentsPrefix ?? "agents";
      resolvedOptions = {
        client: callbackHostOrOptions.client,
        transport: callbackHostOrOptions.transport
      };
    } else {
      // Legacy API: positional parameters
      resolvedCallbackHost = callbackHostOrOptions;
      resolvedAgentsPrefix = agentsPrefix ?? "agents";
      resolvedOptions = options;
    }

    // If callbackHost is not provided, derive it from the current request
    if (!resolvedCallbackHost) {
      const { request } = getCurrentAgent();
      if (!request) {
        throw new Error(
          "callbackHost is required when not called within a request context"
        );
      }

      // Extract the origin from the request
      const requestUrl = new URL(request.url);
      resolvedCallbackHost = `${requestUrl.protocol}//${requestUrl.host}`;
    }

    const callbackUrl = `${resolvedCallbackHost}/${resolvedAgentsPrefix}/${camelCaseToKebabCase(this._ParentClass.name)}/${this.name}/callback`;

    // TODO: make zod/ai sdk more performant and remove this
    // Late initialization of jsonSchemaFn (needed for getAITools)
    await this.mcp.ensureJsonSchema();

    const id = nanoid(8);

    const authProvider = new DurableObjectOAuthClientProvider(
      this.ctx.storage,
      this.name,
      callbackUrl
    );
    authProvider.serverId = id;

    // Use the transport type specified in options, or default to "auto"
    const transportType: TransportType =
      resolvedOptions?.transport?.type ?? "auto";

    // allows passing through transport headers if necessary
    // this handles some non-standard bearer auth setups (i.e. MCP server behind CF access instead of OAuth)
    let headerTransportOpts: SSEClientTransportOptions = {};
    if (resolvedOptions?.transport?.headers) {
      headerTransportOpts = {
        eventSourceInit: {
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              headers: resolvedOptions?.transport?.headers
            })
        },
        requestInit: {
          headers: resolvedOptions?.transport?.headers
        }
      };
    }

    // Register server (also saves to storage)
    await this.mcp.registerServer(id, {
      url,
      name: serverName,
      callbackUrl,
      client: resolvedOptions?.client,
      transport: {
        ...headerTransportOpts,
        authProvider,
        type: transportType
      }
    });

    const result = await this.mcp.connectToServer(id);

    if (result.state === MCPConnectionState.FAILED) {
      // Server stays in storage so user can retry via connectToServer(id)
      throw new Error(
        `Failed to connect to MCP server at ${url}: ${result.error}`
      );
    }

    if (result.state === MCPConnectionState.AUTHENTICATING) {
      return { id, state: result.state, authUrl: result.authUrl };
    }

    // State is CONNECTED - discover capabilities
    const discoverResult = await this.mcp.discoverIfConnected(id);

    if (discoverResult && !discoverResult.success) {
      // Server stays in storage - connection is still valid, user can retry discovery
      throw new Error(
        `Failed to discover MCP server capabilities: ${discoverResult.error}`
      );
    }

    return { id, state: MCPConnectionState.READY };
  }

  async removeMcpServer(id: string) {
    await this.mcp.removeServer(id);
  }

  getMcpServers(): MCPServersState {
    const mcpState: MCPServersState = {
      prompts: this.mcp.listPrompts(),
      resources: this.mcp.listResources(),
      servers: {},
      tools: this.mcp.listTools()
    };

    const servers = this.mcp.listServers();

    if (servers && Array.isArray(servers) && servers.length > 0) {
      for (const server of servers) {
        const serverConn = this.mcp.mcpConnections[server.id];

        // Determine the default state when no connection exists
        let defaultState: "authenticating" | "not-connected" = "not-connected";
        if (!serverConn && server.auth_url) {
          // If there's an auth_url but no connection, it's waiting for OAuth
          defaultState = "authenticating";
        }

        mcpState.servers[server.id] = {
          auth_url: server.auth_url,
          capabilities: serverConn?.serverCapabilities ?? null,
          error: serverConn?.connectionError ?? null,
          instructions: serverConn?.instructions ?? null,
          name: server.name,
          server_url: server.server_url,
          state: serverConn?.connectionState ?? defaultState
        };
      }
    }

    return mcpState;
  }

  private broadcastMcpServers() {
    this.broadcast(
      JSON.stringify({
        mcp: this.getMcpServers(),
        type: MessageType.CF_AGENT_MCP_SERVERS
      })
    );
  }

  /**
   * Handle MCP OAuth callback request if it's an OAuth callback.
   *
   * This method encapsulates the entire OAuth callback flow:
   * 1. Checks if the request is an MCP OAuth callback
   * 2. Processes the OAuth code exchange
   * 3. Establishes the connection if successful
   * 4. Broadcasts MCP server state updates
   * 5. Returns the appropriate HTTP response
   *
   * @param request The incoming HTTP request
   * @returns Response if this was an OAuth callback, null otherwise
   */
  private async handleMcpOAuthCallback(
    request: Request
  ): Promise<Response | null> {
    // Check if this is an OAuth callback request
    const isCallback = this.mcp.isCallbackRequest(request);
    if (!isCallback) {
      return null;
    }

    // Handle the OAuth callback (exchanges code for token, clears OAuth credentials from storage)
    // This fires onServerStateChanged event which triggers broadcast
    const result = await this.mcp.handleCallbackRequest(request);

    // If auth was successful, establish the connection in the background
    if (result.authSuccess) {
      this.mcp.establishConnection(result.serverId).catch((error) => {
        console.error(
          "[Agent handleMcpOAuthCallback] Connection establishment failed:",
          error
        );
      });
    }

    this.broadcastMcpServers();

    // Return the HTTP response for the OAuth callback
    return this.handleOAuthCallbackResponse(result, request);
  }

  /**
   * Handle OAuth callback response using MCPClientManager configuration
   * @param result OAuth callback result
   * @param request The original request (needed for base URL)
   * @returns Response for the OAuth callback
   */
  private handleOAuthCallbackResponse(
    result: MCPClientOAuthResult,
    request: Request
  ): Response {
    const config = this.mcp.getOAuthCallbackConfig();

    // Use custom handler if configured
    if (config?.customHandler) {
      return config.customHandler(result);
    }

    const baseOrigin = new URL(request.url).origin;

    // Redirect to success URL if configured
    if (config?.successRedirect && result.authSuccess) {
      try {
        return Response.redirect(
          new URL(config.successRedirect, baseOrigin).href
        );
      } catch (e) {
        console.error(
          "Invalid successRedirect URL:",
          config.successRedirect,
          e
        );
        return Response.redirect(baseOrigin);
      }
    }

    // Redirect to error URL if configured
    if (config?.errorRedirect && !result.authSuccess) {
      try {
        const errorUrl = `${config.errorRedirect}?error=${encodeURIComponent(
          result.authError || "Unknown error"
        )}`;
        return Response.redirect(new URL(errorUrl, baseOrigin).href);
      } catch (e) {
        console.error("Invalid errorRedirect URL:", config.errorRedirect, e);
        return Response.redirect(baseOrigin);
      }
    }

    // Default: redirect to base URL
    return Response.redirect(baseOrigin);
  }
}

// A set of classes that have been wrapped with agent context
const wrappedClasses = new Set<typeof Agent.prototype.constructor>();

/**
 * Namespace for creating Agent instances
 * @template Agentic Type of the Agent class
 * @deprecated Use DurableObjectNamespace instead
 */
export type AgentNamespace<Agentic extends Agent<Cloudflare.Env>> =
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
          "Access-Control-Max-Age": "86400"
        }
      : options?.cors;

  if (request.method === "OPTIONS") {
    if (corsHeaders) {
      return new Response(null, {
        headers: corsHeaders
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
      ...(options as PartyServerOptions<Record<string, unknown>>)
    }
  );

  if (
    response &&
    corsHeaders &&
    request.headers.get("upgrade")?.toLowerCase() !== "websocket" &&
    request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
  ) {
    const newHeaders = new Headers(response.headers);

    // Add CORS headers
    for (const [key, value] of Object.entries(corsHeaders)) {
      newHeaders.set(key, value);
    }

    response = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }
  return response;
}

// Email routing - deprecated resolver kept in root for upgrade discoverability
// Other email utilities moved to agents/email subpath
export { createHeaderBasedEmailResolver } from "./email";

import type { EmailResolver } from "./email";

export type EmailRoutingOptions<Env> = AgentOptions<Env> & {
  resolver: EmailResolver<Env>;
  /**
   * Callback invoked when no routing information is found for an email.
   * Use this to reject the email or perform custom handling.
   * If not provided, a warning is logged and the email is dropped.
   */
  onNoRoute?: (email: ForwardableEmailMessage) => void | Promise<void>;
};

// Cache the agent namespace map for email routing
// This maps both kebab-case and original names to namespaces
const agentMapCache = new WeakMap<
  Record<string, unknown>,
  Record<string, unknown>
>();

/**
 * Route an email to the appropriate Agent
 * @param email The email to route
 * @param env The environment containing the Agent bindings
 * @param options The options for routing the email
 * @returns A promise that resolves when the email has been routed
 */
export async function routeAgentEmail<
  Env extends Cloudflare.Env = Cloudflare.Env
>(
  email: ForwardableEmailMessage,
  env: Env,
  options: EmailRoutingOptions<Env>
): Promise<void> {
  const routingInfo = await options.resolver(email, env);

  if (!routingInfo) {
    if (options.onNoRoute) {
      await options.onNoRoute(email);
    } else {
      console.warn("No routing information found for email, dropping message");
    }
    return;
  }

  // Build a map that includes both original names and kebab-case versions
  if (!agentMapCache.has(env as Record<string, unknown>)) {
    const map: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (
        value &&
        typeof value === "object" &&
        "idFromName" in value &&
        typeof value.idFromName === "function"
      ) {
        // Add both the original name and kebab-case version
        map[key] = value;
        map[camelCaseToKebabCase(key)] = value;
      }
    }
    agentMapCache.set(env as Record<string, unknown>, map);
  }

  const agentMap = agentMapCache.get(env as Record<string, unknown>)!;
  const namespace = agentMap[routingInfo.agentName];

  if (!namespace) {
    // Provide helpful error message listing available agents
    const availableAgents = Object.keys(agentMap)
      .filter((key) => !key.includes("-")) // Show only original names, not kebab-case duplicates
      .join(", ");
    throw new Error(
      `Agent namespace '${routingInfo.agentName}' not found in environment. Available agents: ${availableAgents}`
    );
  }

  const agent = await getAgentByName(
    namespace as unknown as DurableObjectNamespace<Agent<Env>>,
    routingInfo.agentId
  );

  // let's make a serialisable version of the email
  const serialisableEmail: AgentEmail = {
    getRaw: async () => {
      const reader = email.raw.getReader();
      const chunks: Uint8Array[] = [];

      let done = false;
      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          chunks.push(value);
        }
      }

      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      return combined;
    },
    headers: email.headers,
    rawSize: email.rawSize,
    setReject: (reason: string) => {
      email.setReject(reason);
    },
    forward: (rcptTo: string, headers?: Headers) => {
      return email.forward(rcptTo, headers);
    },
    reply: (replyOptions: { from: string; to: string; raw: string }) => {
      return email.reply(
        new EmailMessage(replyOptions.from, replyOptions.to, replyOptions.raw)
      );
    },
    from: email.from,
    to: email.to,
    _secureRouted: routingInfo._secureRouted
  };

  await agent._onEmail(serialisableEmail);
}

/**
 * Get or create an Agent by name
 * @template Env Environment type containing bindings
 * @template T Type of the Agent class
 * @param namespace Agent namespace
 * @param name Name of the Agent instance
 * @param options Options for Agent creation
 * @returns Promise resolving to an Agent instance stub
 */
export async function getAgentByName<
  Env extends Cloudflare.Env = Cloudflare.Env,
  T extends Agent<Env> = Agent<Env>,
  Props extends Record<string, unknown> = Record<string, unknown>
>(
  namespace: DurableObjectNamespace<T>,
  name: string,
  options?: {
    jurisdiction?: DurableObjectJurisdiction;
    locationHint?: DurableObjectLocationHint;
    props?: Props;
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
   * Whether the stream has been closed (via end() or error())
   */
  get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Send a chunk of data to the client
   * @param chunk The data to send
   * @returns false if stream is already closed (no-op), true if sent
   */
  send(chunk: unknown): boolean {
    if (this._closed) {
      console.warn(
        "StreamingResponse.send() called after stream was closed - data not sent"
      );
      return false;
    }
    const response: RPCResponse = {
      done: false,
      id: this._id,
      result: chunk,
      success: true,
      type: MessageType.RPC
    };
    this._connection.send(JSON.stringify(response));
    return true;
  }

  /**
   * End the stream and send the final chunk (if any)
   * @param finalChunk Optional final chunk of data to send
   * @returns false if stream is already closed (no-op), true if sent
   */
  end(finalChunk?: unknown): boolean {
    if (this._closed) {
      return false;
    }
    this._closed = true;
    const response: RPCResponse = {
      done: true,
      id: this._id,
      result: finalChunk,
      success: true,
      type: MessageType.RPC
    };
    this._connection.send(JSON.stringify(response));
    return true;
  }

  /**
   * Send an error to the client and close the stream
   * @param message Error message to send
   * @returns false if stream is already closed (no-op), true if sent
   */
  error(message: string): boolean {
    if (this._closed) {
      return false;
    }
    this._closed = true;
    const response: RPCResponse = {
      error: message,
      id: this._id,
      success: false,
      type: MessageType.RPC
    };
    this._connection.send(JSON.stringify(response));
    return true;
  }
}
