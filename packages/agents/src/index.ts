import type { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { agentContext, type AgentEmail } from "./context";
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
import { MCPConnectionState } from "./mcp/client-connection";
import { DurableObjectOAuthClientProvider } from "./mcp/do-oauth-client-provider";
import type { TransportType } from "./mcp/types";
import { genericObservability, type Observability } from "./observability";
import { DisposableStore } from "./core/events";
import { MessageType } from "./ai-types";
import {
  TaskTracker,
  TasksAccessor,
  createTaskContext,
  taskMethodOriginals,
  getTaskMethodKey,
  type Task,
  type TaskContext,
  type TaskHandle,
  type TaskOptions,
  type TaskFilter,
  type TaskEvent,
  type TaskStatus,
  type TaskExecutionPayload,
  type TaskObservabilityEvent
} from "./task";

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

// Import callable decorator and metadata from shared module
import {
  callable as callableDecorator,
  unstable_callable as unstableCallableDecorator,
  callableMetadata,
  type CallableMetadata
} from "./callable";

// Re-export for public API
export {
  callableDecorator as callable,
  unstableCallableDecorator as unstable_callable,
  callableMetadata,
  type CallableMetadata
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
  instructions: string | null;
  capabilities: ServerCapabilities | null;
};
const STATE_ROW_ID = "cf_state_row_id";
const STATE_WAS_CHANGED = "cf_state_was_changed";

const DEFAULT_STATE = {} as unknown;

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
  private _destroyed = false;

  private _ParentClass: typeof Agent<Env, State> =
    Object.getPrototypeOf(this).constructor;

  readonly mcp: MCPClientManager;

  /**
   * Task tracker for tracking async work lifecycle
   * @internal
   */
  private _taskTracker!: TaskTracker;

  /**
   * Tasks accessor for managing tracked tasks
   *
   * @example
   * ```typescript
   * // Get a task
   * const task = this.tasks.get(taskId);
   *
   * // List running tasks
   * const running = this.tasks.list({ status: 'running' });
   *
   * // Cancel a task
   * this.tasks.cancel(taskId);
   * ```
   */
  readonly tasks!: TasksAccessor;

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
        type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron')),
        time INTEGER,
        delayInSeconds INTEGER,
        cron TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `;

    // Initialize MCPClientManager AFTER tables are created
    this.mcp = new MCPClientManager(this._ParentClass.name, "0.0.1", {
      storage: this.ctx.storage
    });

    // Initialize TaskTracker for tracking async work lifecycle
    // - Execution is handled by the queue system
    // - Real-time sync is handled by the state system
    this._taskTracker = new TaskTracker(
      this.sql.bind(this),
      // Sync task updates to state for automatic broadcast to clients
      (taskId: string, task: Task | null) => {
        this._syncTaskToState(taskId, task);
      }
    );
    (this as { tasks: TasksAccessor }).tasks = new TasksAccessor(
      this._taskTracker
    );

    // Set workflow cancel callback for TasksAccessor
    this.tasks.setWorkflowCancelCallback((taskId) =>
      this._cancelWorkflow(taskId)
    );

    // Set observability callback for task lifecycle events
    this._taskTracker.setObservabilityCallback(
      (event: TaskObservabilityEvent) => {
        this.observability?.emit(
          {
            displayMessage: this._formatTaskObservabilityMessage(event),
            id: nanoid(),
            payload: {
              taskId: event.taskId,
              method: event.method,
              ...event.data
            },
            timestamp: event.timestamp,
            type: event.type
          },
          this.ctx
        );
      }
    );

    // Clear any stale queue items from previous runs to prevent task spirals
    this.sql`DELETE FROM cf_agents_queues WHERE callback = '_executeTask'`;

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

          // Handle workflow update callbacks
          const url = new URL(request.url);
          if (
            url.pathname === "/_workflow-update" &&
            request.method === "POST"
          ) {
            try {
              const json = await request.json();

              // Comprehensive validation of workflow update payload
              const validationError = this._validateWorkflowUpdate(json);
              if (validationError) {
                console.error(
                  "[Agent] Invalid workflow update:",
                  validationError
                );
                return new Response(validationError, { status: 400 });
              }

              const update = json as {
                taskId: string;
                event?: { type: string; data?: unknown };
                progress?: number;
                status?: "completed" | "failed";
                result?: unknown;
                error?: string;
              };

              this._handleWorkflowUpdate(update);
              return new Response("ok", { status: 200 });
            } catch (error) {
              console.error("[Agent] Failed to handle workflow update:", error);
              return new Response("error", { status: 500 });
            }
          }

          // Handle durable task execution from DurableTaskWorkflow
          if (
            url.pathname === "/_execute-durable-task" &&
            request.method === "POST"
          ) {
            try {
              const json = (await request.json()) as {
                taskId: string;
                methodName: string;
                input: unknown;
              };

              const { taskId, methodName, input } = json;

              if (!taskId || !methodName) {
                return new Response("Missing taskId or methodName", {
                  status: 400
                });
              }

              const result = await this._executeDurableTaskMethod(
                taskId,
                methodName,
                input
              );

              return new Response(JSON.stringify(result), {
                status: 200,
                headers: { "Content-Type": "application/json" }
              });
            } catch (error) {
              console.error("[Agent] Failed to execute durable task:", error);
              return new Response(
                JSON.stringify({
                  error: error instanceof Error ? error.message : String(error)
                }),
                { status: 500, headers: { "Content-Type": "application/json" } }
              );
            }
          }

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
        async () => {
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

  // ============================================================================
  // Task System
  // ============================================================================

  /**
   * Run a method as a tracked task with lifecycle management.
   *
   * Tasks provide:
   * - Automatic status tracking (pending → running → completed/failed/aborted)
   * - Progress events via ctx.emit()
   * - Abort handling via ctx.signal
   * - Timeout support
   * - Retry support
   * - Persistence across agent restarts
   *
   * @param methodName Name of the method to run as a task
   * @param input Input payload to pass to the method
   * @param options Task options (timeout, retries, custom ID)
   * @returns TaskHandle with the task ID and status
   *
   * @example
   * ```typescript
   * class MyAgent extends Agent<Env> {
   *   async createTask(input: string) {
   *     // Start a task - returns immediately with task handle
   *     const task = await this.task("processData", { input }, {
   *       timeout: "5m",
   *       retries: 2
   *     });
   *     return { taskId: task.id };
   *   }
   *
   *   // The task method receives input and context
   *   async processData(input: { input: string }, ctx: TaskContext) {
   *     ctx.emit("starting", { step: 1 });
   *
   *     // Check for abort
   *     if (ctx.signal.aborted) throw new Error("Aborted");
   *
   *     ctx.setProgress(50);
   *     const result = await this.doWork(input.input);
   *
   *     return { result };
   *   }
   * }
   * ```
   */
  async task<TInput, TResult = unknown>(
    methodName: keyof this & string,
    input: TInput,
    options: TaskOptions = {}
  ): Promise<TaskHandle<TResult>> {
    // Route to durable or simple task based on options
    if (options.durable) {
      return this._runDurableTask<TInput, TResult>(methodName, input, options);
    }
    return this._runTask<TInput, TResult>(methodName, input, options);
  }

  /**
   * Run a simple (non-durable) task in the Durable Object.
   * Called by the @task() decorator for non-durable tasks.
   * @internal
   */
  async _runTask<TInput, TResult = unknown>(
    methodName: string,
    input: TInput,
    options: TaskOptions = {}
  ): Promise<TaskHandle<TResult>> {
    // Validate method exists
    const method = this[methodName as keyof this];
    if (typeof method !== "function") {
      throw new Error(`Method ${methodName} does not exist on this agent`);
    }

    // 1. Create task record for tracking
    const task = this._taskTracker.create(methodName, input, options);

    // 2. Queue execution using the existing queue system
    const payload: TaskExecutionPayload = {
      taskId: task.id,
      methodName,
      input,
      timeoutMs: task.timeoutMs,
      retries: options.retries
    };

    const queueId = await this.queue("_executeTask" as keyof this, payload);

    // Link task to queue item
    this._taskTracker.linkToQueue(task.id, queueId);

    // 3. Return handle immediately (task runs in background)
    return this._taskTracker.getHandle<TResult>(task.id)!;
  }

  /**
   * Run a durable task backed by Cloudflare Workflows.
   * Called by the @task({ durable: true }) decorator.
   *
   * This dispatches to a generated workflow that will call back into the agent
   * to execute the actual task method with durable step/sleep/waitForEvent support.
   * @internal
   */
  async _runDurableTask<TInput, TResult = unknown>(
    methodName: string,
    input: TInput,
    options: TaskOptions = {}
  ): Promise<TaskHandle<TResult>> {
    // 1. Create task record with durable flag
    const task = this._taskTracker.create(methodName, input, {
      ...options,
      durable: true
    });

    // 2. Get the workflow binding for durable tasks
    // Convention: DURABLE_TASKS_WORKFLOW binding should be configured
    const workflowBinding = "DURABLE_TASKS_WORKFLOW";
    const workflowNS = (this.env as Record<string, unknown>)[workflowBinding];

    if (
      !workflowNS ||
      typeof (workflowNS as { create?: unknown }).create !== "function"
    ) {
      // Fallback: run as simple task if workflow not configured
      console.warn(
        `[Agent] ${workflowBinding} not found. Running durable task as simple task. ` +
          "Configure the DURABLE_TASKS_WORKFLOW binding for true durability."
      );
      this._taskTracker.fail(task.id, "Durable workflow not configured");
      throw new Error(
        `Durable tasks require ${workflowBinding} binding. ` +
          "Add it to your wrangler.jsonc or use @task() without durable: true."
      );
    }

    // 3. Dispatch workflow with task tracking info
    const agentBinding = camelCaseToKebabCase(this._ParentClass.name);
    const instance = await (
      workflowNS as {
        create: (opts: { params: unknown }) => Promise<{ id: string }>;
      }
    ).create({
      params: {
        _taskId: task.id,
        _agentBinding: agentBinding,
        _agentName: (this as unknown as { name: string }).name || "default",
        _methodName: methodName,
        _input: input,
        _timeout: options.timeout,
        _retry: options.retry
      }
    });

    // 4. Link task to workflow instance
    this._taskTracker.linkToWorkflow(task.id, instance.id, workflowBinding);
    this._taskTracker.addEvent(task.id, "workflow-started", {
      instanceId: instance.id,
      methodName,
      durable: true
    });

    // 5. Return handle immediately
    return this._taskTracker.getHandle<TResult>(task.id)!;
  }

  /**
   * Start a Cloudflare Workflow and track it as a task.
   *
   * The workflow will receive a WorkflowTaskContext with emit() and setProgress()
   * methods that sync updates back to this Agent for real-time client notifications.
   *
   * @param workflowBinding - The workflow binding name (e.g., "ANALYSIS_WORKFLOW")
   * @param input - Input parameters for the workflow
   * @returns TaskHandle for tracking the workflow
   *
   * @example
   * ```typescript
   * class MyAgent extends Agent<Env> {
   *   @callable()
   *   async startLongAnalysis(input: { repoUrl: string }) {
   *     return this.workflow("ANALYSIS_WORKFLOW", input);
   *   }
   * }
   * ```
   */
  async workflow<TInput extends Record<string, unknown>, TResult = unknown>(
    workflowBinding: string,
    input: TInput
  ): Promise<TaskHandle<TResult>> {
    // 1. Create task record
    const task = this._taskTracker.create("_workflow", input, {});

    // 2. Get workflow binding
    const workflowNS = (this.env as Record<string, unknown>)[workflowBinding];
    if (
      !workflowNS ||
      typeof (workflowNS as { create?: unknown }).create !== "function"
    ) {
      this._taskTracker.fail(
        task.id,
        `Workflow binding ${workflowBinding} not found`
      );
      throw new Error(`Workflow binding ${workflowBinding} not found`);
    }

    // 3. Dispatch workflow with task tracking info
    // Use kebab-case for binding name to match wrangler.jsonc convention
    const agentBinding = camelCaseToKebabCase(this._ParentClass.name);
    const instance = await (
      workflowNS as {
        create: (opts: { params: unknown }) => Promise<{ id: string }>;
      }
    ).create({
      params: {
        ...input,
        _taskId: task.id,
        _agentBinding: agentBinding,
        _agentName: (this as unknown as { name: string }).name || "default"
      }
    });

    // 4. Store workflow instance ID for cancellation support
    this._taskTracker.linkToWorkflow(task.id, instance.id, workflowBinding);
    this._taskTracker.addEvent(task.id, "workflow-started", {
      instanceId: instance.id,
      binding: workflowBinding
    });

    // 5. Return handle
    return this._taskTracker.getHandle<TResult>(task.id)!;
  }

  /**
   * Cancel a workflow task by terminating its workflow instance.
   * Returns { success, reason } to indicate outcome.
   * @internal
   */
  async _cancelWorkflow(
    taskId: string
  ): Promise<{ success: boolean; reason?: string }> {
    const workflowInfo = this._taskTracker.getWorkflowInfo(taskId);
    if (!workflowInfo) {
      return { success: false, reason: "not_a_workflow" };
    }

    const workflowNS = (this.env as Record<string, unknown>)[
      workflowInfo.binding
    ] as {
      get: (id: string) => Promise<{
        terminate: () => Promise<void>;
        status: () => Promise<{ status: string }>;
      }>;
    } | null;

    if (!workflowNS?.get) {
      console.error(
        `[Agent] Workflow binding ${workflowInfo.binding} not found`
      );
      return { success: false, reason: "binding_not_found" };
    }

    try {
      const instance = await workflowNS.get(workflowInfo.instanceId);

      // Check status first to provide better feedback
      try {
        const { status } = await instance.status();
        if (["complete", "errored", "terminated"].includes(status)) {
          return { success: false, reason: `already_${status}` };
        }
      } catch {
        // Status check failed, try to terminate anyway
      }

      await instance.terminate();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[Agent] Failed to terminate workflow ${workflowInfo.instanceId}:`,
        message
      );
      return { success: false, reason: message };
    }
  }

  /**
   * Format task observability message for display
   * @internal
   */
  private _formatTaskObservabilityMessage(
    event: TaskObservabilityEvent
  ): string {
    const method = event.method ? ` (${event.method})` : "";
    switch (event.type) {
      case "task:created":
        return `Task ${event.taskId}${method} created`;
      case "task:started":
        return `Task ${event.taskId}${method} started`;
      case "task:progress":
        return `Task ${event.taskId} progress: ${event.data?.progress}%`;
      case "task:completed":
        return `Task ${event.taskId}${method} completed`;
      case "task:failed":
        return `Task ${event.taskId}${method} failed: ${event.data?.error}`;
      case "task:aborted":
        return `Task ${event.taskId}${method} aborted: ${event.data?.reason}`;
      case "task:event":
        return `Task ${event.taskId} event: ${event.data?.eventType}`;
      default:
        return `Task ${event.taskId} ${event.type}`;
    }
  }

  /**
   * Validate workflow update payload
   * @internal
   * @returns Error message if validation fails, null if valid
   */
  private _validateWorkflowUpdate(json: unknown): string | null {
    if (!json || typeof json !== "object") {
      return "payload must be an object";
    }

    const payload = json as Record<string, unknown>;

    // Required field: taskId
    if (typeof payload.taskId !== "string" || !payload.taskId) {
      return "missing or invalid taskId";
    }

    // Optional field: event (must be object with type string if present)
    if (payload.event !== undefined) {
      if (typeof payload.event !== "object" || payload.event === null) {
        return "event must be an object";
      }
      const event = payload.event as Record<string, unknown>;
      if (typeof event.type !== "string") {
        return "event.type must be a string";
      }
    }

    // Optional field: progress (must be number 0-100 if present)
    if (payload.progress !== undefined) {
      if (
        typeof payload.progress !== "number" ||
        payload.progress < 0 ||
        payload.progress > 100
      ) {
        return "progress must be a number between 0 and 100";
      }
    }

    // Optional field: status (must be "completed" or "failed" if present)
    if (payload.status !== undefined) {
      if (payload.status !== "completed" && payload.status !== "failed") {
        return 'status must be "completed" or "failed"';
      }
    }

    // Optional field: error (must be string if present)
    if (payload.error !== undefined && typeof payload.error !== "string") {
      return "error must be a string";
    }

    return null;
  }

  /**
   * Handle workflow update callbacks
   * @internal
   */
  private _handleWorkflowUpdate(update: {
    taskId: string;
    event?: { type: string; data?: unknown };
    progress?: number;
    status?: "completed" | "failed";
    result?: unknown;
    error?: string;
  }): void {
    const { taskId, event, progress, status, result, error } = update;

    if (event) {
      this._taskTracker.addEvent(taskId, event.type, event.data);
    }
    if (progress !== undefined) {
      this._taskTracker.setProgress(taskId, progress);
    }
    if (status === "completed") {
      this._taskTracker.complete(taskId, result);
    }
    if (status === "failed") {
      this._taskTracker.fail(taskId, error || "Workflow failed");
    }
  }

  /**
   * Execute a durable task method (called by DurableTaskWorkflow via HTTP)
   * @internal
   */
  private async _executeDurableTaskMethod(
    taskId: string,
    methodName: string,
    input: unknown
  ): Promise<unknown> {
    // Validate method exists
    const methodOrWrapper = this[methodName as keyof this];
    if (typeof methodOrWrapper !== "function") {
      throw new Error(`Method ${methodName} does not exist on this agent`);
    }

    // Get the original method implementation (before @task() wrapper)
    const className = this.constructor.name;
    const taskKey = getTaskMethodKey(className, methodName);
    const originalMethod = taskMethodOriginals.get(taskKey);
    const method = originalMethod || methodOrWrapper;

    // Mark task as running if not already
    const existingTask = this._taskTracker.get(taskId);
    if (existingTask && existingTask.status === "pending") {
      this._taskTracker.markRunning(taskId);
    }

    // Note: When called from DurableTaskWorkflow, the entire execution is
    // wrapped in a workflow step.do(), providing retry semantics. Individual
    // ctx.step() calls execute inline within this outer step. For fine-grained
    // checkpointing, use AgentWorkflow directly.
    const ctx = createTaskContext(taskId, this._taskTracker);
    return (method as Function).call(this, input, ctx);
  }

  /**
   * Internal method called by queue to execute a task
   * @internal
   */
  async _executeTask(
    payload: TaskExecutionPayload,
    _queueItem: QueueItem<string>
  ): Promise<void> {
    const { taskId, methodName, input, retries = 0 } = payload;

    // Check if task was already aborted before execution
    const existingTask = this._taskTracker.get(taskId);
    if (!existingTask || existingTask.status === "aborted") {
      return;
    }

    // Mark task as running and get abort controller
    const controller = this._taskTracker.markRunning(taskId);

    // Create task context
    const ctx = createTaskContext(taskId, this._taskTracker);

    // Get the method to execute
    // If method was decorated with @task(), get the original implementation
    const methodOrWrapper = this[methodName as keyof this];
    if (typeof methodOrWrapper !== "function") {
      this._taskTracker.fail(taskId, `Method ${methodName} not found`);
      return;
    }

    // Check if this is a @task() decorated method - use original implementation
    const className = this.constructor.name;
    const taskKey = getTaskMethodKey(className, methodName);
    const originalMethod = taskMethodOriginals.get(taskKey);
    const method = originalMethod || methodOrWrapper;

    // Safety check: if original is same as wrapper, we'd loop forever
    if (originalMethod && originalMethod === methodOrWrapper) {
      this._taskTracker.fail(taskId, "Internal error: task method loop");
      return;
    }

    // Execute with retries
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      // Check for abort or timeout (deadline-based, no setTimeout accumulation)
      if (controller.signal.aborted || this._taskTracker.checkTimeout(taskId)) {
        return;
      }

      try {
        const result = await (method as Function).call(this, input, ctx);
        // Final timeout check before completing
        if (!this._taskTracker.checkTimeout(taskId)) {
          this._taskTracker.complete(taskId, result);
        }
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < retries && !controller.signal.aborted) {
          // Check timeout before retry
          if (this._taskTracker.checkTimeout(taskId)) {
            return;
          }
          // Add retry event
          this._taskTracker.addEvent(taskId, "retry", {
            attempt: attempt + 1,
            maxRetries: retries,
            error: lastError.message
          });

          // Exponential backoff with deadline checking
          // Note: For durable retries, use this.workflow() with Cloudflare Workflows
          // which has built-in retry support via step.do({ retries: {...} })
          const backoffMs = Math.min(1000 * 2 ** attempt, 30000);
          const checkInterval = 1000; // Check deadline every second during backoff
          let waited = 0;
          while (waited < backoffMs) {
            if (
              controller.signal.aborted ||
              this._taskTracker.checkTimeout(taskId)
            ) {
              return;
            }
            const waitTime = Math.min(checkInterval, backoffMs - waited);
            await new Promise((r) => setTimeout(r, waitTime));
            waited += waitTime;
          }
        }
      }
    }

    // All retries exhausted - verify task is still in running state before failing
    // This prevents race condition where timeout could mark task as aborted
    // between the checkTimeout() call and the fail() call
    if (!controller.signal.aborted) {
      const task = this._taskTracker.get(taskId);
      if (task?.status === "running") {
        this._taskTracker.fail(taskId, lastError?.message || "Unknown error");
      }
    }
  }

  /**
   * Track last broadcast per task to rate-limit progress updates
   * @internal
   */
  private _lastTaskBroadcast = new Map<
    string,
    { time: number; status: string; broadcastCount: number }
  >();

  /**
   * Pending final state broadcasts to guarantee delivery
   * Maps taskId -> task state for deferred final broadcast
   * @internal
   */
  private _pendingFinalBroadcasts = new Map<string, Task>();

  /**
   * Clean up stale broadcast cache entries.
   * Removes entries for tasks that no longer exist or are in final states.
   * Called automatically when cache grows large, or can be called manually.
   * @internal
   */
  private _cleanupBroadcastCaches(): void {
    const now = Date.now();
    const staleThresholdMs = 60000; // 1 minute

    for (const [taskId, entry] of this._lastTaskBroadcast) {
      // Remove if entry is stale (no updates for 1 minute)
      if (now - entry.time > staleThresholdMs) {
        this._lastTaskBroadcast.delete(taskId);
        this._pendingFinalBroadcasts.delete(taskId);
        continue;
      }

      // Remove if task no longer exists or is in final state
      const task = this._taskTracker?.get(taskId);
      if (!task || ["completed", "failed", "aborted"].includes(task.status)) {
        this._lastTaskBroadcast.delete(taskId);
        this._pendingFinalBroadcasts.delete(taskId);
      }
    }
  }

  /**
   * Broadcast task update to all connected clients.
   *
   * Rate limiting strategy (single-threaded DO, no race conditions):
   * - Status changes: ALWAYS broadcast immediately
   * - Final states (completed/failed/aborted): ALWAYS broadcast + schedule deferred guarantee
   * - Progress updates: Rate-limited to every 500ms to prevent flooding
   *
   * Final state guarantee: If a final state is reached, we broadcast immediately
   * and also schedule a deferred broadcast to ensure clients receive the final
   * state even if the immediate broadcast was missed (e.g., due to WebSocket issues).
   */
  private _syncTaskToState(taskId: string, task: Task | null): void {
    // Periodic cleanup when cache grows large (prevents unbounded growth)
    if (this._lastTaskBroadcast.size > 100) {
      this._cleanupBroadcastCaches();
    }
    // Task deleted - always broadcast
    if (!task) {
      this._lastTaskBroadcast.delete(taskId);
      this._pendingFinalBroadcasts.delete(taskId);
      this.broadcast(
        JSON.stringify({ type: "CF_AGENT_TASK_UPDATE", taskId, task: null })
      );
      return;
    }

    const now = Date.now();
    const last = this._lastTaskBroadcast.get(taskId);
    const statusChanged = !last || last.status !== task.status;
    const isFinalState = ["completed", "failed", "aborted"].includes(
      task.status
    );
    const timeSinceLast = last ? now - last.time : Number.POSITIVE_INFINITY;

    // Always broadcast: status changes, final states, or 500ms since last
    if (statusChanged || isFinalState || timeSinceLast >= 500) {
      const broadcastCount = (last?.broadcastCount || 0) + 1;
      this._lastTaskBroadcast.set(taskId, {
        time: now,
        status: task.status,
        broadcastCount
      });

      this.broadcast(
        JSON.stringify({ type: "CF_AGENT_TASK_UPDATE", taskId, task })
      );

      // For final states, schedule a deferred rebroadcast to guarantee delivery
      // This ensures the final state is sent even if rapid updates caused issues
      if (isFinalState) {
        this._pendingFinalBroadcasts.set(taskId, task);
        // Use queueMicrotask for deferred execution after current sync cycle
        queueMicrotask(() => {
          const pendingTask = this._pendingFinalBroadcasts.get(taskId);
          if (pendingTask) {
            // Broadcast the final state one more time to guarantee delivery
            this.broadcast(
              JSON.stringify({
                type: "CF_AGENT_TASK_UPDATE",
                taskId,
                task: pendingTask
              })
            );
            this._pendingFinalBroadcasts.delete(taskId);
            this._lastTaskBroadcast.delete(taskId);
          }
        });
      }
    }
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
   * Uses SQL JSON extraction for efficient filtering when possible
   * @param key Key to filter by (supports nested paths like "data.userId")
   * @param value Value to filter by
   * @returns Array of matching QueueItem objects
   */
  async getQueues(key: string, value: string): Promise<QueueItem<string>[]> {
    // Use SQL JSON extraction for single-level keys (more efficient)
    // SQLite's json_extract uses $ path syntax
    if (!key.includes(".")) {
      try {
        const result = this.ctx.storage.sql
          .exec(
            "SELECT * FROM cf_agents_queues WHERE json_extract(payload, ?) = ?",
            `$.${key}`,
            value
          )
          .toArray() as QueueItem<string>[];

        return result.map((row) => ({
          ...row,
          payload: JSON.parse(row.payload)
        }));
      } catch {
        // Fall back to JS filtering if SQL approach fails
      }
    }

    // Fallback: fetch all and filter in JS (for nested keys or if SQL fails)
    const result = this.sql<QueueItem<string>>`
      SELECT * FROM cf_agents_queues
    `;
    return result
      .filter((row) => {
        try {
          const payload = JSON.parse(row.payload);
          // Support nested keys with dot notation
          const keys = key.split(".");
          let val = payload;
          for (const k of keys) {
            if (val === null || val === undefined) return false;
            val = val[k];
          }
          return val === value;
        } catch {
          return false;
        }
      })
      .map((row) => ({
        ...row,
        payload: JSON.parse(row.payload)
      }));
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
          if (this._destroyed) return;
          // Update next execution time for cron schedules
          const nextExecutionTime = getNextCronTime(row.cron);
          const nextTimestamp = Math.floor(nextExecutionTime.getTime() / 1000);

          this.sql`
          UPDATE cf_agents_schedules SET time = ${nextTimestamp} WHERE id = ${row.id}
        `;
        } else {
          if (this._destroyed) return;
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
   * Get all methods marked as callable on this Agent
   * @returns A map of method names to their metadata
   */
  private _isCallable(method: string): boolean {
    return callableMetadata.has(this[method as keyof this] as Function);
  }

  /**
   * Connect to a new MCP Server
   *
   * @param serverName Name of the MCP server
   * @param url MCP Server SSE URL
   * @param callbackHost Base host for the agent, used for the redirect URI. If not provided, will be derived from the current request.
   * @param agentsPrefix agents routing prefix if not using `agents`
   * @param options MCP client and transport options
   * @returns Server id and state - either "authenticating" with authUrl, or "ready"
   * @throws If connection or discovery fails
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

    // Register server (also saves to storage)
    await this.mcp.registerServer(id, {
      url,
      name: serverName,
      callbackUrl,
      client: options?.client,
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
 * ExecutionContext with optional exports (ctx.exports API)
 * @see https://developers.cloudflare.com/changelog/2025-09-26-ctx-exports/
 */
export type ExecutionContextWithExports = ExecutionContext & {
  exports?: Record<string, unknown>;
};

/**
 * Route a request to the appropriate Agent
 * @param request Request to route
 * @param env Environment containing Agent bindings
 * @param options Routing options (can include ctx for ctx.exports support)
 * @returns Response from the Agent or undefined if no route matched
 *
 * @example
 * ```typescript
 * // With ctx.exports (recommended - auto bindings)
 * export default {
 *   async fetch(request, env, ctx) {
 *     return routeAgentRequest(request, env, { ctx });
 *   }
 * }
 *
 * // Without ctx.exports (manual bindings)
 * export default {
 *   async fetch(request, env) {
 *     return routeAgentRequest(request, env);
 *   }
 * }
 * ```
 */
export async function routeAgentRequest<Env>(
  request: Request,
  env: Env,
  options?: AgentOptions<Env> & { ctx?: ExecutionContextWithExports }
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

  // Merge ctx.exports with env if available (ctx.exports takes precedence)
  // This allows automatic bindings via enable_ctx_exports compatibility flag
  const mergedEnv = options?.ctx?.exports
    ? { ...env, ...options.ctx.exports }
    : env;

  let response = await routePartykitRequest(
    request,
    mergedEnv as Record<string, unknown>,
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

// AgentEmail is re-exported from ./context
export type { AgentEmail } from "./context";

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

// Re-export task decorator and types for convenience
export { task } from "./task";
export type { TaskObservabilityEvent, TaskObservabilityCallback } from "./task";
export type {
  Task,
  TaskContext,
  TaskHandle,
  TaskOptions,
  TaskFilter,
  TaskEvent,
  TaskStatus
};

// Re-export workflow types for durable task execution
export {
  AgentWorkflow,
  CloudflareWorkflowAdapter,
  DurableTaskWorkflow
} from "./workflow";
export type {
  WorkflowTaskContext,
  WorkflowUpdate,
  WorkflowAdapter,
  DurableTaskWorkflowPayload
} from "./workflow";
