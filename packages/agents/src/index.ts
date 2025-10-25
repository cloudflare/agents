import type { env } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";

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
import { camelCaseToKebabCase } from "./client";
import { MCPClientManager, type MCPClientOAuthResult } from "./mcp/client";
import { MCPClientConnection } from "./mcp/client-connection";
import type { MCPConnectionState } from "./mcp/client-connection";
import { DurableObjectOAuthClientProvider } from "./mcp/do-oauth-client-provider";
import type { TransportType } from "./mcp/types";
import { genericObservability, type Observability } from "./observability";
import { DisposableStore } from "./core/events";
import { MessageType } from "./ai-types";

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

const callableMetadata = new Map<Function, CallableMetadata>();

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
  callable(metadata);
};

export type QueueItem<T = string> = {
  id: string;
  payload: T;
  callback: keyof Agent<unknown>;
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
  state: MCPConnectionState;
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
  agent: Agent<unknown, unknown>;
  connection: Connection | undefined;
  request: Request | undefined;
  email: AgentEmail | undefined;
}>();

export function getCurrentAgent<
  T extends Agent<unknown, unknown> = Agent<unknown, unknown>
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
): (this: Agent<unknown, unknown>, ...args: Parameters<T>) => ReturnType<T> {
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
 * Base class for creating Agent implementations
 * @template Env Environment type containing bindings
 * @template State State type to store within the Agent
 */
export class Agent<
  Env = typeof env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Server<Env, Props> {
  private _state = DEFAULT_STATE as State;
  private _disposables = new DisposableStore();
  private _mcpStateRestored = false;

  private _ParentClass: typeof Agent<Env, State> =
    Object.getPrototypeOf(this).constructor;

  readonly mcp: MCPClientManager = new MCPClientManager(
    this._ParentClass.name,
    "0.0.1"
  );

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
    hibernate: true // default to hibernate
  };

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
      console.error(`failed to execute sql query: ${query}`, e);
      throw this.onError(e);
    }
  }
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    if (!wrappedClasses.has(this.constructor)) {
      // Auto-wrap custom methods with agent context
      this._autoWrapCustomMethods();
      wrappedClasses.add(this.constructor);
    }

    // Broadcast server state after background connects (for OAuth servers)
    this._disposables.add(
      this.mcp.onConnected(async () => {
        this.broadcastMcpServers();
      })
    );

    // Emit MCP observability events
    this._disposables.add(
      this.mcp.onObservabilityEvent((event) => {
        this.observability?.emit(event);
      })
    );

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
        { agent: this, connection: undefined, request, email: undefined },
        async () => {
          await this._ensureMcpStateRestored();

          if (this.mcp.isCallbackRequest(request)) {
            const result = await this.mcp.handleCallbackRequest(request);
            this.broadcastMcpServers();

            if (result.authSuccess) {
              this.mcp
                .establishConnection(result.serverId)
                .catch((error) => {
                  console.error("Background connection failed:", error);
                })
                .finally(() => {
                  this.broadcastMcpServers();
                });
            }

            return this.handleOAuthCallbackResponse(result, request);
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
        () => {
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
            await this._ensureMcpStateRestored();
            this.broadcastMcpServers();
            return _onStart(props);
          });
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
        type: MessageType.CF_AGENT_STATE
      }),
      source !== "server" ? [source.id] : []
    );
    return this._tryCatch(() => {
      const { connection, request, email } = agentContext.getStore() || {};
      return agentContext.run(
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
    }
  ): Promise<void> {
    return this._tryCatch(async () => {
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
        payload: JSON.parse(row.payload as string) as T
      })) as Schedule<T>[];

    return result;
  }

  /**
   * Cancel a scheduled task
   * @param id ID of the task to cancel
   * @returns true if the task was cancelled, false otherwise
   */
  async cancelSchedule(id: string): Promise<boolean> {
    const schedule = await this.getSchedule(id);
    if (schedule) {
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
    }
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

    if (result && Array.isArray(result)) {
      for (const row of result) {
        const callback = this[row.callback as keyof Agent<Env>];
        if (!callback) {
          console.error(`callback ${row.callback} not found`);
          continue;
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
    this.sql`DROP TABLE IF EXISTS cf_agents_queues`;

    // delete all alarms
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this._disposables.dispose();
    await this.mcp.dispose?.();
    this.ctx.abort("destroyed"); // enforce that the agent is evicted

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
   * Get all methods marked as callable on this Agent
   * @returns A map of method names to their metadata
   */
  private _isCallable(method: string): boolean {
    return callableMetadata.has(this[method as keyof this] as Function);
  }

  private async _ensureMcpStateRestored() {
    if (this._mcpStateRestored) {
      return;
    }

    this._mcpStateRestored = true;

    const servers = this.sql<MCPServerRow>`
        SELECT id, name, server_url, client_id, auth_url, callback_url, server_options
        FROM cf_agents_mcp_servers
      `;

    if (!servers || !Array.isArray(servers) || servers.length === 0) {
      return;
    }

    for (const server of servers) {
      if (server.callback_url) {
        this.mcp.registerCallbackUrl(`${server.callback_url}/${server.id}`);
      }
    }

    for (const server of servers) {
      const needsOAuth = !!server.auth_url;

      if (needsOAuth) {
        const authProvider = new DurableObjectOAuthClientProvider(
          this.ctx.storage,
          this.name,
          server.callback_url
        );
        authProvider.serverId = server.id;
        if (server.client_id) {
          authProvider.clientId = server.client_id;
        }

        const parsedOptions = server.server_options
          ? JSON.parse(server.server_options)
          : undefined;

        const conn = new MCPClientConnection(
          new URL(server.server_url),
          {
            name: this.name,
            version: "1.0.0"
          },
          {
            client: parsedOptions?.client ?? {},
            transport: {
              ...(parsedOptions?.transport ?? {}),
              type: parsedOptions?.transport?.type ?? ("auto" as TransportType),
              authProvider
            }
          }
        );

        conn.connectionState = "authenticating";
        this.mcp.mcpConnections[server.id] = conn;
      } else {
        const parsedOptions = server.server_options
          ? JSON.parse(server.server_options)
          : undefined;

        this._connectToMcpServerInternal(
          server.name,
          server.server_url,
          server.callback_url,
          parsedOptions,
          {
            id: server.id,
            oauthClientId: server.client_id ?? undefined
          }
        ).catch((error) => {
          console.error(`Error restoring ${server.id}:`, error);
        });
      }
    }
  }

  /**
   * Connect to a new MCP Server
   *
   * @param serverName Name of the MCP server
   * @param url MCP Server SSE URL
   * @param callbackHost Base host for the agent, used for the redirect URI. If not provided, will be derived from the current request.
   * @param agentsPrefix agents routing prefix if not using `agents`
   * @param options MCP client and transport options
   * @returns authUrl
   */
  async addMcpServer(
    serverName: string,
    url: string,
    callbackHost?: string,
    agentsPrefix = "agents",
    options?: {
      client?: ConstructorParameters<typeof Client>[1];
      transport?: {
        headers?: HeadersInit;
        type?: TransportType;
      };
    }
  ): Promise<{ id: string; authUrl: string | undefined }> {
    // If callbackHost is not provided, derive it from the current request
    let resolvedCallbackHost = callbackHost;
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

    const callbackUrl = `${resolvedCallbackHost}/${agentsPrefix}/${camelCaseToKebabCase(this._ParentClass.name)}/${this.name}/callback`;

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

    this.broadcastMcpServers();

    return result;
  }

  private async _connectToMcpServerInternal(
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
        type?: TransportType;
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

    // Use the transport type specified in options, or default to "auto"
    const transportType: TransportType = options?.transport?.type ?? "auto";

    // allows passing through transport headers if necessary
    // this handles some non-standard bearer auth setups (i.e. MCP server behind CF access instead of OAuth)
    let headerTransportOpts: SSEClientTransportOptions = {};
    if (options?.transport?.headers) {
      headerTransportOpts = {
        eventSourceInit: {
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              headers: options?.transport?.headers
            })
        },
        requestInit: {
          headers: options?.transport?.headers
        }
      };
    }

    const { id, authUrl, clientId } = await this.mcp.connect(url, {
      client: options?.client,
      reconnect,
      transport: {
        ...headerTransportOpts,
        authProvider,
        type: transportType
      }
    });

    return {
      authUrl,
      clientId,
      id
    };
  }

  async removeMcpServer(id: string) {
    this.mcp.closeConnection(id);
    this.mcp.unregisterCallbackUrl(id);
    this.sql`
      DELETE FROM cf_agents_mcp_servers WHERE id = ${id};
    `;
    this.broadcastMcpServers();
  }

  getMcpServers(): MCPServersState {
    const mcpState: MCPServersState = {
      prompts: this.mcp.listPrompts(),
      resources: this.mcp.listResources(),
      servers: {},
      tools: this.mcp.listTools()
    };

    const servers = this.sql<MCPServerRow>`
      SELECT id, name, server_url, client_id, auth_url, callback_url, server_options FROM cf_agents_mcp_servers;
    `;

    if (servers && Array.isArray(servers) && servers.length > 0) {
      for (const server of servers) {
        const serverConn = this.mcp.mcpConnections[server.id];
        mcpState.servers[server.id] = {
          auth_url: server.auth_url,
          capabilities: serverConn?.serverCapabilities ?? null,
          instructions: serverConn?.instructions ?? null,
          name: server.name,
          server_url: server.server_url,
          // mark as "authenticating" because the server isn't automatically connected, so it's pending authenticating
          state: serverConn?.connectionState ?? "authenticating"
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

    // Use redirect URLs if configured
    if (config?.successRedirect && result.authSuccess) {
      return Response.redirect(config.successRedirect);
    }

    if (config?.errorRedirect && !result.authSuccess) {
      return Response.redirect(
        `${config.errorRedirect}?error=${encodeURIComponent(result.authError || "Unknown error")}`
      );
    }

    // Default behavior - redirect to base URL
    const baseUrl = new URL(request.url).origin;
    return Response.redirect(baseUrl);
  }
}

// A set of classes that have been wrapped with agent context
const wrappedClasses = new Set<typeof Agent.prototype.constructor>();

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
    response = new Response(response.body, {
      headers: {
        ...response.headers,
        ...corsHeaders
      }
    });
  }
  return response;
}

export type EmailResolver<Env> = (
  email: ForwardableEmailMessage,
  env: Env
) => Promise<{
  agentName: string;
  agentId: string;
} | null>;

/**
 * Create a resolver that uses the message-id header to determine the agent to route the email to
 * @returns A function that resolves the agent to route the email to
 */
export function createHeaderBasedEmailResolver<Env>(): EmailResolver<Env> {
  return async (email: ForwardableEmailMessage, _env: Env) => {
    const messageId = email.headers.get("message-id");
    if (messageId) {
      const messageIdMatch = messageId.match(/<([^@]+)@([^>]+)>/);
      if (messageIdMatch) {
        const [, agentId, domain] = messageIdMatch;
        const agentName = domain.split(".")[0];
        return { agentName, agentId };
      }
    }

    const references = email.headers.get("references");
    if (references) {
      const referencesMatch = references.match(
        /<([A-Za-z0-9+/]{43}=)@([^>]+)>/
      );
      if (referencesMatch) {
        const [, base64Id, domain] = referencesMatch;
        const agentId = Buffer.from(base64Id, "base64").toString("hex");
        const agentName = domain.split(".")[0];
        return { agentName, agentId };
      }
    }

    const agentName = email.headers.get("x-agent-name");
    const agentId = email.headers.get("x-agent-id");
    if (agentName && agentId) {
      return { agentName, agentId };
    }

    return null;
  };
}

/**
 * Create a resolver that uses the email address to determine the agent to route the email to
 * @param defaultAgentName The default agent name to use if the email address does not contain a sub-address
 * @returns A function that resolves the agent to route the email to
 */
export function createAddressBasedEmailResolver<Env>(
  defaultAgentName: string
): EmailResolver<Env> {
  return async (email: ForwardableEmailMessage, _env: Env) => {
    const emailMatch = email.to.match(/^([^+@]+)(?:\+([^@]+))?@(.+)$/);
    if (!emailMatch) {
      return null;
    }

    const [, localPart, subAddress] = emailMatch;

    if (subAddress) {
      return {
        agentName: localPart,
        agentId: subAddress
      };
    }

    // Option 2: Use defaultAgentName namespace, localPart as agentId
    // Common for catch-all email routing to a single EmailAgent namespace
    return {
      agentName: defaultAgentName,
      agentId: localPart
    };
  };
}

/**
 * Create a resolver that uses the agentName and agentId to determine the agent to route the email to
 * @param agentName The name of the agent to route the email to
 * @param agentId The id of the agent to route the email to
 * @returns A function that resolves the agent to route the email to
 */
export function createCatchAllEmailResolver<Env>(
  agentName: string,
  agentId: string
): EmailResolver<Env> {
  return async () => ({ agentName, agentId });
}

export type EmailRoutingOptions<Env> = AgentOptions<Env> & {
  resolver: EmailResolver<Env>;
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
export async function routeAgentEmail<Env>(
  email: ForwardableEmailMessage,
  env: Env,
  options: EmailRoutingOptions<Env>
): Promise<void> {
  const routingInfo = await options.resolver(email, env);

  if (!routingInfo) {
    console.warn("No routing information found for email, dropping message");
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
    namespace as unknown as AgentNamespace<Agent<Env>>,
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
    reply: (options: { from: string; to: string; raw: string }) => {
      return email.reply(
        new EmailMessage(options.from, options.to, options.raw)
      );
    },
    from: email.from,
    to: email.to
  };

  await agent._onEmail(serialisableEmail);
}

export type AgentEmail = {
  from: string;
  to: string;
  getRaw: () => Promise<Uint8Array>;
  headers: Headers;
  rawSize: number;
  setReject: (reason: string) => void;
  forward: (rcptTo: string, headers?: Headers) => Promise<void>;
  reply: (options: { from: string; to: string; raw: string }) => Promise<void>;
};

export type EmailSendOptions = {
  to: string;
  subject: string;
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
  includeRoutingHeaders?: boolean;
  agentName?: string;
  agentId?: string;
  domain?: string;
};

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
  Env,
  T extends Agent<Env>,
  Props extends Record<string, unknown> = Record<string, unknown>
>(
  namespace: AgentNamespace<T>,
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
      type: MessageType.RPC
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
      type: MessageType.RPC
    };
    this._connection.send(JSON.stringify(response));
  }
}
