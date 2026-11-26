import { hasTable } from "./lifecycle/schema";
import {
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
  type AgentEmail
} from "./internal_context";
export { __DO_NOT_USE_WILL_BREAK__agentContext } from "./internal_context";
/**
 * @internal — This is an internal implementation detail shared with the Think
 * package so it can declare a turn's invocation boundary. Importing or relying
 * on this symbol **will** break your code in a future release.
 */
export { withInvocationScope as __DO_NOT_USE_WILL_BREAK__withInvocationScope } from "./observability/tracing/tracer";
import {
  parseSubAgentPath as _parseSubAgentPath,
  type AgentPathStep
} from "./sub-routing";
export {
  buildAgentPath,
  buildAgentUrl,
  routeSubAgentRequest,
  getSubAgentByName,
  parseSubAgentPath,
  SUB_PREFIX
} from "./sub-routing";
export type {
  AgentPathStep,
  BuildAgentPathOptions,
  SubAgentPathMatch
} from "./sub-routing";
import {
  DynamicAgentConnectionBridge as SubAgentConnectionBridge,
  dynamicAgentRpcReplyContext as subAgentRpcReplyContext
} from "./dynamic-agents/bridges";
import {
  CF_SUB_AGENT_OUTER_URL_KEY,
  CF_SUB_AGENT_TAGS_KEY,
  CF_SUB_AGENT_ACCEPTED_AT_KEY,
  SUB_AGENT_OUTER_URL_HEADER,
  rejectSubAgentWebSocket
} from "./dynamic-agents/dynamic-agents";
import { logicalNameFromPathV2Identity } from "./dynamic-agents/identity";
import { DynamicAgentsInternal } from "./dynamic-agents/dynamic-agents";
import { DynamicAgents as DynamicAgentsApi } from "./dynamic-agents/api";
import type { DynamicAgentHostPort } from "./dynamic-agents/host";
import type {
  FacetCapableCtx,
  RootFacetRpcSurface,
  DynamicAgentClass as SubAgentClass,
  DynamicAgentConnectionMeta as SubAgentConnectionMeta,
  DynamicAgentPathInvokeEndpoint as SubAgentPathInvokeEndpoint,
  DynamicAgentStub as SubAgentStub
} from "./dynamic-agents/types";
export type {
  DynamicAgentClass,
  DynamicAgentStub,
  DynamicAgentClass as SubAgentClass,
  DynamicAgentStub as SubAgentStub
} from "./dynamic-agents/types";
import type { SendEmailOptions } from "./email";
import { sendAgentEmail } from "./email-send";
import {
  agentEmailFromPayload,
  replyToAgentEmail,
  type AgentEmailPayload,
  type ReplyToEmailOptions
} from "./email-agent";
export type { EmailSendBinding, SendEmailOptions } from "./email";

import { DurableObject, exports as workerExports } from "cloudflare:workers";
import {
  type LifecycleJobContext,
  type MemoryLimitContext,
  type Connection,
  type ConnectionContext,
  Lifecycle,
  setLifecycleEventSink,
  setLifecycleHostInvoker,
  setLifecycleRouteTransport,
  type LifecycleRouteEnvelope,
  type WSMessage
} from "./lifecycle/durable-object-lifecycle";
import { abortWithoutAlarmRetry } from "./lifecycle/abort";
import type { InternalHostMessage } from "./browser/internal-hosts";
import { browserCapabilityId } from "./browser/capability-id";
import type { LifecycleRouteAddress } from "./lifecycle/capability";
import {
  getCurrentAgent as getCurrentLifecycleAgent,
  type CurrentAgentContext
} from "./lifecycle/current-agent";
import { getAgentByName } from "./agent-routing";
import { WebSockets } from "./websockets";
import {
  applyEventLogFrame,
  setEventLogConnections
} from "./websockets/websockets";
import {
  ensureConnectionWrapped,
  getConnectionFlag,
  isConnectionProtocolEnabled as connectionProtocolEnabled,
  isConnectionReadonly as connectionReadonly,
  registerInternalConnectionKeys,
  setConnectionFlag,
  setConnectionReadonly as markConnectionReadonly
} from "./websockets/connection-flags";
export {
  getAgentByName,
  routeAgentRequest,
  type AgentGetOptions,
  type AgentOptions,
  type RoutingRetryOptions
} from "./agent-routing";
import { camelCaseToKebabCase, isInternalJsStubProp } from "./utils";
export { camelCaseToKebabCase } from "./utils";
import { SqlError } from "./sql-error";
import { type RetryOptions, tryN, validateRetryOptions } from "./retries";
export {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isDurableObjectStorageReset,
  isPlatformTransientError
} from "./retries";
import { MCPClientManager } from "./mcp/client";
import type {
  WorkflowCallback,
  RunWorkflowOptions,
  WorkflowEventPayload,
  WorkflowInfo,
  WorkflowQueryCriteria,
  WorkflowPage
} from "./workflow-types";
import { MCPConnectionState } from "./mcp/client/connection";
import {
  DurableObjectOAuthClientProvider,
  type AgentMcpOAuthProvider
} from "./mcp/client/do-oauth-client-provider";
import {
  genericObservability,
  type Observability,
  type ObservabilityEvent
} from "./observability/emitter";
import { agentSpanAttributes } from "./observability/agent-span-attributes";
import { tracer } from "./observability/tracing/cloudflare";
import {
  writeSpanAttributes,
  type TraceAttributes
} from "./observability/tracing/tracer";
import { DisposableStore } from "./core/events";
import { MessageType } from "./types";
import type { McpRpcAgent } from "./mcp/rpc";
import { ensureMcpServerTable } from "./mcp/client/storage";
import {
  addMcpServer,
  mcpServersState,
  reconnectMcpServer,
  type AddMcpServerOptions,
  type AddMcpServerResult,
  type AddRpcMcpServerOptions,
  type MCPServersState
} from "./mcp/client/agent-servers";
import { Scheduler, setSchedulerCallbackResolver } from "./schedules/scheduler";
import { KeepAlive } from "./lifecycle/keep-alive";
import { DeferredDestroy } from "./lifecycle/deferred-destroy";
import { Queue, setQueueCallbackResolver } from "./queue/queue";
import {
  runInInvocation,
  stateHookMode,
  wrapCustomMethods
} from "./agent-invocation";
import {
  resolveAgentOptions,
  type AgentStaticOptions,
  type ResolvedAgentOptions
} from "./agent-options";
export {
  DEFAULT_AGENT_STATIC_OPTIONS,
  type AgentStaticOptions
} from "./agent-options";
import { Workflows } from "./workflow-tracking/workflows";
import {
  FIBER_TASK,
  MANAGED_FIBER_TASK,
  cancelFiber,
  createFiberTaskDefinition,
  deleteFibers,
  fiberByKey,
  importLegacyFibers,
  inspectFiber,
  listFibers,
  resolveFiber,
  runFiber,
  stashCurrentFiber,
  startFiber,
  withFiberStash,
  type FiberHost
} from "./fiber-runs";
import type {
  DeleteFibersOptions,
  FiberContext,
  FiberInspection,
  FiberRecoveryContext,
  FiberRecoveryResult,
  FiberStashContext,
  InternalFiberOptions,
  ListFibersOptions,
  StartFiberOptions,
  StartFiberResult
} from "./fiber-types";
import type { QueueItem } from "./queue/types";
export type { QueueItem } from "./queue/types";
import { AgentToolParent } from "./agent-tool-parent";

import { Tasks, setTaskDefinitionResolver } from "./tasks/tasks";
import type { TaskCallbacks, TaskHandlers } from "./tasks/types";
import type {
  Schedule,
  ScheduleCriteria,
  ScheduleOptions
} from "./schedules/types";
export type {
  Schedule,
  ScheduleCriteria,
  ScheduleOptions
} from "./schedules/types";
import { State } from "./state";
export {
  AGENT_TOOL_PROGRESS_PART,
  AGENT_TOOL_MILESTONE_PART
} from "./agent-tool-types";

import type {
  AgentToolLifecycleResult,
  AgentToolMilestone,
  AgentToolProgress,
  AgentToolProgressSnapshot,
  AgentToolRunInfo,
  AgentToolRunStatus,
  ChatCapableAgentClass,
  DetachedAgentToolConfig,
  DetachedRunAgentToolResult,
  RunAgentToolOptions,
  RunAgentToolResult
} from "./agent-tool-types";

export type {
  AgentToolChildAdapter,
  AgentToolDisplayMetadata,
  AgentToolEvent,
  AgentToolEventDelivery,
  AgentToolEventMessage,
  AgentToolEventState,
  AgentToolFailure,
  AgentToolInterruptedReason,
  AgentToolLifecycleResult,
  AgentToolMilestone,
  AgentToolProgress,
  AgentToolProgressSnapshot,
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolRunPart,
  AgentToolRunState,
  AgentToolRunStatus,
  AgentToolStoredChunk,
  AgentToolTerminalStatus,
  ChatCapableAgentClass,
  DetachedAgentToolConfig,
  DetachedRunAgentToolResult,
  RunAgentToolOptions,
  RunAgentToolResult
} from "./agent-tool-types";

export type {
  Connection,
  ConnectionContext,
  WSMessage
} from "./lifecycle/durable-object-lifecycle";
export { MessageType } from "./types";
import { dispatchCallableRpc, isRPCRequest } from "./callable-rpc";
export {
  StreamingResponse,
  type RPCRequest,
  type RPCResponse
} from "./callable-rpc";

/**
 * State update message from client
 */
export type StateUpdateMessage = {
  type: MessageType.CF_AGENT_STATE;
  state: unknown;
};

/**
 * Type guard for state update messages
 */
export {
  callable,
  unstable_callable,
  type CallableMetadata
} from "./callable-decorator";
import {
  decoratedMethods,
  isCallableMethod,
  type CallableMetadata
} from "./callable-decorator";

export { SqlError } from "./sql-error";

export type {
  DeleteFibersOptions,
  FiberContext,
  FiberInspection,
  FiberRecoveryContext,
  FiberRecoveryResult,
  FiberStatus,
  ListFibersOptions,
  StartFiberOptions,
  StartFiberResult
} from "./fiber-types";

export type { TransportType } from "./mcp/types";
export type { RetryOptions } from "./retries";
export {
  normalizeServerId,
  MCP_SERVER_ID_MAX_LENGTH,
  type MCPAITool,
  type MCPAIToolSet
} from "./mcp/client";
export {
  DurableObjectOAuthClientProvider,
  type AgentMcpOAuthProvider,
  /** @deprecated Use {@link AgentMcpOAuthProvider} instead. */
  type AgentsOAuthProvider
} from "./mcp/client/do-oauth-client-provider";

/**
 * MCP Server state update message from server -> Client
 */
export type MCPServerMessage = {
  type: MessageType.CF_AGENT_MCP_SERVERS;
  mcp: MCPServersState;
};

export type {
  AddMcpServerOptions,
  AddRpcMcpServerOptions,
  MCPServer,
  MCPServersState
} from "./mcp/client/agent-servers";

/**
 * Schema version for the Agent's internal SQLite tables.
 * Bump this when adding new tables, columns, or migrations.
 * The constructor keeps it in the Lifecycle's one schema record, beside every
 * capability's version, and checks it on wake to skip DDL on established DOs.
 */
const CURRENT_SCHEMA_VERSION = 15;

/** The version the constructor's DDL brings the tables to. */
const TABLES_SCHEMA_VERSION = 14;
/**
 * The host version after the tables: fiber rows from a release before
 * fibers ran on Tasks have been carried forward (at start, after the
 * constructor's DDL, because the import awaits Tasks).
 */
const FIBERS_IMPORTED_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

/** The key it had before the one record: folded in once, then deleted. */
const SCHEMA_VERSION_KEY = "cf_agents:schema_version";

// Before the State capability owned `cf_agents_state`, Agent kept its schema
// version as a row in that table. Read once for DOs created under that layout,
// then moved to the KV key so the table has a single owner.
const LEGACY_SCHEMA_VERSION_ROW_ID = "cf_schema_version";

// Sentinel for "no initial state provided" on the Agent's overridable
// `initialState` field. The State capability owns state storage; this only
// distinguishes an unset initialState when the `state` getter seeds it.
const DEFAULT_STATE = {} as unknown;

/**
 * Internal key used to store voice call state in connection state.
 * Used by the voice mixin to track whether a connection is in an active call.
 */
const CF_VOICE_IN_CALL_KEY = "_cf_voiceInCall";

// Agent's own per-connection flags ride the WebSockets capability's
// connection-state namespace: hidden from `connection.state`, preserved
// across user `setState`, and carried through hibernation.
registerInternalConnectionKeys(
  CF_VOICE_IN_CALL_KEY,
  CF_SUB_AGENT_OUTER_URL_KEY,
  CF_SUB_AGENT_TAGS_KEY,
  CF_SUB_AGENT_ACCEPTED_AT_KEY
);

/**
 * Tracks which agent constructors have already emitted the
 * sendIdentityOnConnect deprecation warning, so it fires at most once per class.
 */
const _sendIdentityWarnedClasses = new WeakSet<Function>();

// `isDurableObjectCodeUpdateReset` / `isPlatformTransientError` live in
// ./retries and remain re-exported from the package root so higher layers
// classify platform failures with the same matcher instead of drifting copies.

/** Compatibility alias for the lifecycle-owned current Agent accessor. */
export const getCurrentAgent = getCurrentLifecycleAgent as <
  T extends DurableObject = Agent<Cloudflare.Env>
>() => CurrentAgentContext<T, AgentEmail>;

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
 * How long after an alarm handler returns a destroy inside it aborts the
 * instance. Measured on a deployment: the handler sets an alarm (the job
 * driver's 30 s fallback), and the destroy deletes it. An abort inside the
 * handler (4 of 4, also with a `storage.sync()` first, 3 of 3), or right
 * after the handler returned (1 of 1, and 3 of 3 with a sync first), still
 * had that alarm run 30 s later and construct the object again. An abort
 * 500 ms after the handler returned did not (4 of 4), nor 2 s (1 of 1).
 */
const ABORT_AFTER_ALARM_MS = 500;

/**
 * Base class for creating Agent implementations
 * @template Env Environment type containing bindings
 * @template TState State type to store within the Agent
 */
export class Agent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  TState = unknown,
  Props extends object = object
> extends DurableObject<Env> {
  /**
   * Runtime lifecycle and reusable durable capabilities for this Agent.
   */
  readonly lifecycle = Lifecycle.install<Env, Props>(this, {
    maxAlarmMemoryLimitStrikes: this._resolvedOptions.maxAlarmMemoryLimitStrikes
  });

  /**
   * WebSocket connection subsystem. Constructed as a field initializer
   * so it exists before the constructor installs it; the handler arrows
   * defer to `this.*`, so they always hit the framework-wrapped hooks.
   * Those wrappers still open their own invocation scope even though
   * the capability's dispatch already entered one via the host invoker
   * — the inner wrap is kept because the wrapped hooks are also invoked
   * from paths that do not pass through the capability (facet bridging,
   * direct calls).
   */
  /**
   * Durable state: the `cf_agents_state` row, lazy load, validated persistence.
   * `initialState` stays on Agent (a subclass field, initialized after this
   * one) and is seeded by the `state` getter. Typed `<unknown>` rather than
   * `<TState>` because `TState` appears in both `get()` and `set()` positions,
   * which would make `Agent`'s own `TState` parameter invariant and break
   * `Subclass -> Agent<Env, unknown>` assignability; the typed boundary is
   * re-established in `state` / `setState`.
   */
  readonly _state: State<unknown> = new State<unknown>({
    validateStateChange: (nextState, source) =>
      this.validateStateChange(nextState as TState, source),
    onChanged: (nextState, source) =>
      this._handleStateChanged(nextState as TState, source)
  });

  private readonly _webSockets = new WebSockets({
    handlers: {
      onConnect: (connection, ctx) => this.onConnect(connection, ctx),
      onMessage: (connection, message) => this.onMessage(connection, message),
      onClose: (connection, code, reason, wasClean) =>
        this.onClose(connection, code, reason, wasClean),
      onError: (connection, error) => this.onError(connection, error)
    },
    // Agent answers its own rpc frames in onMessage (facet bridging,
    // StreamingResponse). It also drives the connect sequence itself —
    // `sendIdentity`/`sendState` after deciding whether the connection
    // belongs to a facet — so the capability provides the protocol but
    // does not run it: `protocol: false`.
    protocol: false,
    state: this._state,
    getConnectionTags: (connection, ctx) =>
      this.getConnectionTags(connection, ctx)
  });

  /** Run user initialization after lifecycle components have started. */
  onStart(_props?: Props): void | Promise<void> {}

  /** Handle an HTTP request not claimed by a lifecycle component. */
  onRequest(_request: Request): Response | Promise<Response> {
    return new Response("Not implemented", { status: 404 });
  }

  /**
   * Choose the response for a request or WebSocket upgrade whose handling
   * threw, including a failed `onStart`. The error is already logged.
   *
   * Return a `Response` to send it, or nothing to send the default, which
   * never carries the error: `500 Internal Server Error`, or for an upgrade a
   * socket that closes with 1011. For an upgrade, return either an HTTP
   * error response or a `101` response with your own `WebSocketPair`.
   *
   * Errors from `onStart`, `onRequest`, and `onConnect` pass through
   * `onError` first. If `onError` throws, `error` is what it threw;
   * otherwise it is the original error. Avoid sending an error's message or
   * stack to callers you do not trust. If this hook throws, the default is
   * sent. Whether it returns nothing or throws, an original thrown value
   * that is not an `Error` is rethrown instead.
   */
  onFetchError(
    _request: Request,
    _error: unknown
  ): Response | void | Promise<Response | void> {}

  /** Handle a newly accepted hibernating WebSocket connection. */
  onConnect(
    _connection: Connection,
    _context: ConnectionContext
  ): void | Promise<void> {}

  /** Handle a message from a hibernating WebSocket connection. */
  onMessage(
    _connection: Connection,
    _message: WSMessage
  ): void | Promise<void> {}

  /** Handle a hibernating WebSocket connection closing. */
  onClose(
    _connection: Connection,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): void | Promise<void> {}

  /** Return tags persisted with a hibernating WebSocket connection. */
  getConnectionTags(
    _connection: Connection,
    _context: ConnectionContext
  ): string[] | Promise<string[]> {
    return [];
  }

  /** @internal Ensure lifecycle startup before a native RPC implementation. */
  async __unsafe_ensureInitialized(props?: Props): Promise<void> {
    await this.lifecycle.start(props);
  }

  private _disposables = new DisposableStore();
  private _destroyed = false;

  /**
   * Stores raw state accessors for wrapped connections.
   * Used by internal flag methods (readonly, no-protocol) to read/write
   * _cf_-prefixed keys without going through the user-facing state/setState.
   */

  /**
   * Cached persistence-hook dispatch mode, computed once in the constructor.
   * - "new"  → call onStateChanged
   * - "old"  → call onStateUpdate (deprecated)
   * - "none" → neither hook is overridden, skip entirely
   */
  private _persistenceHookMode: "new" | "old" | "none" = "none";

  /** True when this agent runs as a facet (sub-agent) inside a parent. */
  private _isFacet = false;

  private _protocolBroadcastExcludeIds = new Set<string>();

  /**
   * User-facing facet name. For legacy facets this is the same as
   * `ctx.id.name`; path-scoped facets use an internal routing id and
   * keep the logical name here instead.
   * @internal
   */
  private _facetName?: string;

  /**
   * Ancestor chain, root-first. Empty for top-level DOs; populated at
   * facet init time from the parent's own `selfPath`. Exposed publicly
   * via the `parentPath` getter.
   * @internal
   */
  private _parentPath: ReadonlyArray<AgentPathStep> = [];

  /** Warn-once guard: `chatRecovery` reassigned during onStart() (too late for wake recovery). */
  private _warnedChatRecoveryInOnStart = false;

  /** @internal Holds behind keepAlive(); see {@link KeepAlive}. */
  readonly _keepAlive: KeepAlive;

  /** @internal The durable destroy marker and its alarm (#1625). */
  private readonly _deferredDestroy = new DeferredDestroy();

  /** @internal The extracted dynamic-agent (facet) machinery. */
  private _dynamicAgentsInstance: DynamicAgentsInternal | undefined;

  /** @internal */
  private get _dynamicAgents(): DynamicAgentsInternal {
    this._dynamicAgentsInstance ??= new DynamicAgentsInternal(
      this as unknown as DynamicAgentHostPort
    );
    return this._dynamicAgentsInstance;
  }

  /** @internal */
  private _dynamicAgentsApi: DynamicAgentsApi | undefined;

  /**
   * The dynamic-agents capability: facet-backed child agents that run
   * in their own isolate with their own SQLite database, colocated
   * with — and supervised by — this agent.
   *
   * Use dynamic agents for code whose class or lifecycle this agent
   * owns: dynamically-loaded or AI-generated code, per-run tool
   * agents, sandboxed components. For independent peers (for example
   * one Durable Object per chat), use `getAgentByName` instead.
   *
   * ```ts
   * const child = await this.dynamicAgents.get(Researcher, id);
   * await child.doWork();
   * this.dynamicAgents.abort(Researcher, id, reason);
   * await this.dynamicAgents.delete(Researcher, id);
   * ```
   *
   * @experimental The API surface may change before stabilizing.
   */
  get dynamicAgents(): DynamicAgentsApi {
    this._dynamicAgentsApi ??= new DynamicAgentsApi(this._dynamicAgents);
    return this._dynamicAgentsApi;
  }

  /** @internal The parent side of agent tools. */
  private readonly _agentTools: AgentToolParent;

  private _ParentClass: typeof Agent<Env, TState> =
    Object.getPrototypeOf(this).constructor;

  /**
   * Durable scheduling capability installed into this Agent's Lifecycle.
   * Agent's schedule()/scheduleEvery()/getScheduleById()/listSchedules()/
   * cancelSchedule() methods delegate to it.
   */
  readonly scheduler: Scheduler;

  /**
   * Durable background-work capability installed into this Agent's
   * Lifecycle. Agent's queue()/dequeue()/dequeueAll()/dequeueAllByCallback()/
   * getQueue()/getQueues() methods are its surface.
   */
  private readonly _queue: Queue;

  /**
   * Durable replayable execution capability installed into this Agent's
   * Lifecycle. Declare definitions on the overridable
   * {@link taskDefinitions} property and start runs with
   * `this.tasks.run(name, input, options)`.
   *
   * @experimental The API surface may change before stabilizing.
   */
  readonly tasks: Tasks;

  /**
   * Named Task definitions for this Agent, resolved lazily on every
   * dispatch. Declare as a field so the map is rebuilt on every Durable
   * Object wake — that is what lets in-flight runs resolve their persisted
   * definition names after a restart:
   *
   * ```ts
   * readonly taskDefinitions = {
   *   "build-report@v1": async (input: ReportInput, step: TaskStep) => {
   *     // ...
   *   }
   * } satisfies TaskHandlers;
   * ```
   *
   * @experimental The API surface may change before stabilizing.
   */
  declare readonly taskDefinitions?: TaskHandlers;

  readonly mcp: MCPClientManager;

  /** Workflow instances this Agent started; `runWorkflow()` and friends delegate to it. */
  private readonly _workflows: Workflows;

  /**
   * Initial state for the Agent
   * Override to provide default state values
   */
  initialState: TState = DEFAULT_STATE as TState;

  /**
   * Stable key for Workers AI session affinity (prefix-cache optimization).
   *
   * Uses the Durable Object ID, which is globally unique across all agent
   * classes and stable for the lifetime of the instance. Pass this value as
   * the `sessionAffinity` option when creating a Workers AI model so that
   * requests from the same agent instance are routed to the same backend
   * replica, improving KV-prefix-cache hit rates across conversation turns.
   *
   * @example
   * ```typescript
   * const workersai = createWorkersAI({ binding: this.env.AI });
   * const model = workersai("@cf/deepseek-ai/deepseek-v4.1-flash-1017", {
   *   sessionAffinity: this.sessionAffinity,
   * });
   * ```
   */
  get sessionAffinity(): string {
    return this.ctx.id.toString();
  }

  /**
   * Current state of the Agent.
   *
   * Delegates to the State capability, which owns lazy load and the
   * in-memory cache; Agent seeds `initialState` on first access.
   */
  get state(): TState {
    const stored = this._state.get();
    // `undefined` is not JSON-representable, so it uniquely means "no row":
    // nothing stored yet, or a corrupt row the capability just cleared.
    if (stored !== undefined) return stored as TState;
    if (this.initialState === DEFAULT_STATE) return undefined as TState;
    // First access with nothing stored: seed the initial state. Goes through
    // set() so it persists, broadcasts, and runs the notification hook.
    this._state.set(this.initialState, "server");
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
  static options: AgentStaticOptions = {};

  /**
   * Resolved options (merges defaults with subclass overrides).
   * Cached after first access — static options never change during the
   * lifetime of a Durable Object instance.
   */
  private _cachedOptions?: ResolvedAgentOptions;
  private get _resolvedOptions(): ResolvedAgentOptions {
    this._cachedOptions ??= resolveAgentOptions(
      (this.constructor as typeof Agent).options
    );
    return this._cachedOptions;
  }

  /**
   * The observability implementation to use for the Agent
   */
  observability?: Observability = genericObservability;

  /**
   * Emit an observability event with auto-generated timestamp.
   * @internal
   */
  protected _emit(
    type: ObservabilityEvent["type"],
    payload: Record<string, unknown> = {}
  ): void {
    this.observability?.emit({
      type,
      agent: this._ParentClass.name,
      name: this.name,
      payload,
      timestamp: Date.now()
    } as ObservabilityEvent);
  }

  /**
   * Run SDK work under a stable parent for platform child spans.
   * @internal For the chat hosts built on `Agent`.
   */
  protected _withAgentSpan<T>(
    operation: string,
    storagePhase: string,
    attributes: TraceAttributes,
    run: (update: (attributes: TraceAttributes) => void) => Promise<T>
  ): Promise<T>;
  protected _withAgentSpan<T>(
    operation: string,
    storagePhase: string,
    attributes: TraceAttributes,
    run: (update: (attributes: TraceAttributes) => void) => T
  ): T;
  protected _withAgentSpan<T>(
    operation: string,
    storagePhase: string,
    attributes: TraceAttributes,
    run: (update: (attributes: TraceAttributes) => void) => T | Promise<T>
  ): T | Promise<T> {
    // The instance name is not always readable during construction: facets
    // restore it after construction and unnamed DOs receive it later.
    let agentId: string | undefined;
    try {
      agentId = this.name;
    } catch {
      agentId = undefined;
    }

    return tracer.withSpan(
      operation,
      {
        ...agentSpanAttributes({
          agentClassName: this._ParentClass.name,
          sessionId: this.ctx.id.toString(),
          sessionName: agentId
        }),
        "cloudflare.agents.operation.name": operation,
        "cloudflare.agents.storage.grouped": true,
        "cloudflare.agents.storage.system": "durable_object",
        "cloudflare.agents.storage.phase": storagePhase,
        ...attributes
      },
      (span) =>
        run((finishAttributes) => writeSpanAttributes(span, finishAttributes)),
      agentContext.getStore()?.connection === undefined
        ? undefined
        : { boundToInvocation: true }
    );
  }

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
      throw new SqlError(query, e);
    }
  }
  private _schemaInitialization:
    | {
        previousVersion: number;
        currentVersion: number;
        migrated: boolean;
      }
    | undefined;

  /**
   * Create all internal tables and run migrations if needed.
   * Called by the constructor on every wake. Idempotent — skips DDL when
   * the stored schema version is TABLES_SCHEMA_VERSION or later.
   *
   * Protected so that test agents can re-run the real migration path
   * after manipulating DB state (since ctx.abort() is unavailable in
   * local dev and the constructor only runs once per DO instance).
   */
  protected _ensureSchema(): void {
    // Schema version gating: skip all DDL on established DOs whose schema
    // is already up-to-date. `cf_agents_state` belongs to the State
    // capability (state/index.ts), which creates and migrates it itself.
    const schemaVersion = this.lifecycle.hostSchema.migrateSync({
      version: TABLES_SCHEMA_VERSION,
      legacyKey: SCHEMA_VERSION_KEY,
      legacyVersion: () => this._takeLegacySchemaVersionRow(),
      steps: { [TABLES_SCHEMA_VERSION]: () => this._createAgentTables() }
    });

    this._schemaInitialization = {
      previousVersion: schemaVersion,
      currentVersion: CURRENT_SCHEMA_VERSION,
      migrated: schemaVersion < CURRENT_SCHEMA_VERSION
    };
  }

  /** Every version's DDL; each statement is idempotent. */
  private _createAgentTables(): void {
    ensureMcpServerTable(this.ctx.storage);

    // Queue and schedule schema and migrations are owned by the Queue and
    // Scheduler capabilities. Agent-tool runs are Task runs; the released
    // `cf_agent_tool_runs` table is read once and dropped
    // (`_carryForwardAgentToolRuns`).
  }

  /**
   * A DO created before the State capability owned `cf_agents_state` kept
   * Agent's schema version as a row in that table: read it once and delete
   * the row, so the table is left with a single owner.
   */
  private _takeLegacySchemaVersionRow(): number | undefined {
    if (!hasTable(this.ctx.storage.sql, "cf_agents_state")) return undefined;

    const rows = this.ctx.storage.sql
      .exec(
        "SELECT state FROM cf_agents_state WHERE id = ?",
        LEGACY_SCHEMA_VERSION_ROW_ID
      )
      .toArray() as { state: string | null }[];
    if (rows.length === 0) return undefined;

    const version = Number(rows[0].state) || 0;
    this.ctx.storage.sql.exec(
      "DELETE FROM cf_agents_state WHERE id = ?",
      LEGACY_SCHEMA_VERSION_ROW_ID
    );
    return version;
  }

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    const routeHost = this;
    setLifecycleRouteTransport(this.lifecycle, {
      get source() {
        return routeHost._lifecycleRouteAddress();
      },
      toRoot: (envelope) => this._routeLifecycleToRoot(envelope),
      to: (target, envelope) => this._routeLifecycleToTarget(target, envelope)
    });
    setLifecycleEventSink(this.lifecycle, (event) => {
      const payload =
        event.payload !== null &&
        typeof event.payload === "object" &&
        !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : { value: event.payload };
      // Lifecycle events are open-ended; Agent's installed capabilities emit
      // event names represented by the observability union.
      this._emit(event.type as ObservabilityEvent["type"], payload);
    });

    // Capability-run user callbacks (scheduled callbacks today, future
    // capability callbacks tomorrow) enter through Agent's invocation
    // boundary so they get the same tracing span scope as every other Agent
    // entry point.
    // Connection-scoped callbacks (e.g. from a WebSockets capability)
    // carry their live connection/request in the scope.
    setLifecycleHostInvoker(this.lifecycle, (run, scope) =>
      runInInvocation(
        {
          agent: this,
          connection: scope?.connection,
          request: scope?.request,
          email: undefined
        },
        run
      )
    );

    this.scheduler = new Scheduler({
      retry: this._resolvedOptions.retry,
      hungScheduleTimeoutSeconds:
        this._resolvedOptions.hungScheduleTimeoutSeconds,
      onError: (error: unknown) =>
        runInInvocation(
          {
            agent: this,
            connection: undefined,
            request: undefined,
            email: undefined
          },
          () => this.onError(error)
        )
    });

    // Agent's historical name-based scheduling API: names outside the
    // (empty) registered map resolve to methods on this Agent. The resolved
    // handler still runs inside the Lifecycle host boundary, so it gets the
    // tracing invocation scope installed above.
    setSchedulerCallbackResolver(this.scheduler, (name) => {
      const method = this[name as keyof this];
      if (typeof method !== "function") return undefined;
      return (payload, schedule) =>
        (
          method as (payload: unknown, schedule: Schedule<unknown>) => unknown
        ).call(this, payload, schedule);
    });

    this._keepAlive = new KeepAlive({
      intervalMs: this._resolvedOptions.keepAliveIntervalMs
    });

    this._queue = new Queue({
      retry: this._resolvedOptions.retry,
      onError: (error: unknown) =>
        runInInvocation(
          {
            agent: this,
            connection: undefined,
            request: undefined,
            email: undefined
          },
          () => this.onError(error)
        )
    });

    // Agent's historical name-based queue API: names resolve to methods on
    // this Agent, run inside the Lifecycle host boundary.
    setQueueCallbackResolver(this._queue, (name) => {
      const method = this[name as keyof this];
      if (typeof method !== "function") return undefined;
      return (payload, item) =>
        (
          method as (payload: unknown, item: QueueItem<unknown>) => unknown
        ).call(this, payload, item);
    });

    this.tasks = new Tasks({
      onError: (error) => this.onError(error)
    });

    // Framework-internal reserved (`__cf`-prefixed) definitions — chat
    // turns, chat recovery, messenger replies — register eagerly through
    // `this.tasks.register()` from each host subclass's own constructor
    // (AIChatAgent, Think), which runs after `this.tasks` exists here.
    // What remains for Agent to bridge is only the end user's own
    // overridable `taskDefinitions` field, which cannot be read yet: a
    // further-downstream subclass's field initializer runs only after
    // every constructor body up this chain (this one included) returns.
    // The resolver stays lazy for exactly that reason; nothing else needs
    // it any more.
    setTaskDefinitionResolver(
      this.tasks,
      (name) =>
        this.taskDefinitions?.[name] as TaskCallbacks[string] | undefined
    );

    this._workflows = new Workflows({
      env: this.env,
      owner: () =>
        this._isFacet
          ? { kind: "facet", name: this.name, path: this.selfPath }
          : {
              kind: "agent",
              className: this._ParentClass.name,
              name: this.name
            }
    });

    const fiberHost: FiberHost = {
      tasks: this.tasks,
      sync: () => this.ctx.storage.sync(),
      emit: (type, payload) =>
        this._emit(type as ObservabilityEvent["type"], payload),
      handleInternalRecovery: (ctx) => this._handleInternalFiberRecovery(ctx),
      // A chat host (AIChatAgent, Think, released versions included) names
      // its legacy turn fibers `${CHAT_FIBER_NAME}:<id>` and recovers them
      // with its own durable budget. Nothing else is exempt.
      ownsRecoveryBudget: (name) => {
        const chatFiber = (this.constructor as { CHAT_FIBER_NAME?: unknown })
          .CHAT_FIBER_NAME;
        return (
          typeof chatFiber === "string" && name.startsWith(`${chatFiber}:`)
        );
      },
      onRecovered: (ctx) => this.onFiberRecovered(ctx),
      heartbeatMs: this._resolvedOptions.keepAliveIntervalMs,
      recoveryHookTimeoutMs: this._resolvedOptions.fiberRecoveryHookTimeoutMs,
      maxAgeMs: this._resolvedOptions.fiberRecoveryMaxAgeMs
    };
    const claimMs = this._resolvedOptions.keepAliveIntervalMs;
    this.tasks.register(
      FIBER_TASK,
      createFiberTaskDefinition(fiberHost, false),
      { claimMs }
    );
    this.tasks.register(
      MANAGED_FIBER_TASK,
      createFiberTaskDefinition(fiberHost, true),
      { claimMs, keepCheckpoint: true }
    );
    this._agentTools = new AgentToolParent({
      ctx: this.ctx,
      tasks: this.tasks,
      options: () => this._resolvedOptions,
      maxConcurrentAgentTools: () => this.maxConcurrentAgentTools,
      className: this.constructor.name,
      isFacet: () => this._isFacet,
      method: (name) => {
        const value = (this as unknown as Record<string, unknown>)[name];
        return typeof value === "function"
          ? (value as (...args: never[]) => unknown).bind(this)
          : undefined;
      },
      resolveChild: (agentType, runId) =>
        this._cf_resolveSubAgent(agentType, runId),
      emit: (type, payload) => this._emit(type, payload),
      broadcast: (message, without) => this.broadcast(message, without),
      onError: (error) => this.onError(error),
      subAgent: (cls, name) => this.subAgent(cls, name),
      deleteSubAgent: (cls, name) => this.deleteSubAgent(cls, name),
      listSchedules: (criteria) => this.listSchedules(criteria),
      cancelSchedule: (id) => this.cancelSchedule(id),
      onAgentToolStart: (run) => this.onAgentToolStart(run),
      onAgentToolFinish: (run, result) => this.onAgentToolFinish(run, result),
      onProgress: (run, progress) => this.onProgress(run, progress),
      runDetachedDelivery: (invoke, options) =>
        this._runDetachedDelivery(invoke, options),
      deliverDetachedMilestone: (run, milestone, mode) =>
        this._deliverDetachedMilestone(run, milestone, mode),
      onAgentToolStreamProgress: () => this._onAgentToolStreamProgress()
    });
    this._agentTools.registerTasks(claimMs);

    this.mcp = this._withAgentSpan(
      "agent_initialization",
      "initialization",
      {},
      (update) => {
        if (!wrappedClasses.has(this.constructor)) {
          // Auto-wrap custom methods with agent context
          wrapCustomMethods(this, Agent.prototype, (name) =>
            isCallableMethod(this[name as keyof this] as Function)
          );
          wrappedClasses.add(this.constructor);
        }

        this._withAgentSpan(
          "initialize_agent_storage",
          "initialization",
          {},
          (updateStorage) => {
            this._ensureSchema();
            const schemaAttributes = {
              "cloudflare.agents.schema.version.previous":
                this._schemaInitialization?.previousVersion,
              "cloudflare.agents.schema.version.current":
                this._schemaInitialization?.currentVersion,
              "cloudflare.agents.schema.migrated":
                this._schemaInitialization?.migrated
            };
            updateStorage(schemaAttributes);
            update(schemaAttributes);
          }
        );

        // Initialize MCPClientManager AFTER tables are created.
        return new MCPClientManager(this._ParentClass.name, "0.0.1", {
          env: this.env,
          createAuthProvider: (callbackUrl) =>
            this.createMcpOAuthProvider(callbackUrl)
        });
      }
    );

    // Event logs fan out to the connections that end at this Agent: on a
    // facet, the sockets the root bridges in, without those a facet only
    // forwards to a sub-agent of its own.
    setEventLogConnections(this._webSockets, () =>
      [...this.getConnections()].filter(
        (connection) => !this._dynamicAgents.connectionRoutesToChild(connection)
      )
    );
    // Agent's WebSocket connections ride the WebSockets capability —
    // Lifecycle itself no longer models connections. The handlers call
    // through `this.*` so they always hit the framework-wrapped hooks.
    this.lifecycle
      .use(this.scheduler)
      .use(this._keepAlive)
      .use(this._deferredDestroy)
      .use(this._queue)
      .use(this.mcp)
      .use(this._state)
      .use(this._webSockets)
      .use(this.tasks)
      .use(this._workflows)
      // Registered for capability identity/services; its hot paths are
      // wired directly (see the DynamicAgentsInternal class doc).
      .use(this._dynamicAgents);

    // MCP starts before Agent restores facet routing state. Defer its initial
    // publication until broadcasts can be routed to the correct owner.
    let mcpBroadcastReady = false;
    this._disposables.add(
      this.mcp.onServerStateChanged(() => {
        if (mcpBroadcastReady) this.broadcastMcpServers();
      })
    );

    // Emit MCP observability events
    this._disposables.add(
      this.mcp.onObservabilityEvent((event) => {
        this.observability?.emit({
          ...event,
          agent: this._ParentClass.name,
          name: this.name
        });
      })
    );
    // Which state hook to call, decided once per instance. Throws if a
    // class overrides both onStateChanged and onStateUpdate.
    this._persistenceHookMode = stateHookMode(this, Agent.prototype);

    const _onAlarm = this.onAlarm.bind(this);
    this.onAlarm = async () => {
      if (this._destroyed) return;
      await _onAlarm();
    };

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = (request: Request) => {
      return runInInvocation(
        { agent: this, connection: undefined, request, email: undefined },
        () => this._tryCatch(() => _onRequest(request))
      );
    };

    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      const replyBridge = subAgentRpcReplyContext.getStore()?.bridge;
      // Lifecycle establishes the root socket context before entering this
      // wrapper. Do not carry root-owned native I/O into the facet RPC.
      if (
        await agentContext.exit(() =>
          this._cf_forwardSubAgentWebSocketMessage(
            connection,
            message,
            replyBridge
          )
        )
      ) {
        return;
      }
      ensureConnectionWrapped(connection);
      return runInInvocation(
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

          // State and event-log frames: the capability answers them, and
          // Agent applies them here, after the facet forward above, so a
          // frame for a sub-agent reaches the sub-agent's own capability.
          if (
            this._webSockets.applyStateFrame(connection, parsed) ||
            applyEventLogFrame(this._webSockets, connection, parsed)
          ) {
            return;
          }

          if (isRPCRequest(parsed)) {
            await dispatchCallableRpc(this, connection, parsed, {
              replyBridge,
              emit: (type, payload) => this._emit(type, payload)
            });
            return;
          }

          return this._tryCatch(() => _onMessage(connection, message));
        }
      );
    };

    const _onConnect = this.onConnect.bind(this);
    this.onConnect = async (connection: Connection, ctx: ConnectionContext) => {
      ensureConnectionWrapped(connection);
      const subAgentOuterUrl = ctx.request.headers.get(
        SUB_AGENT_OUTER_URL_HEADER
      );
      if (subAgentOuterUrl) {
        this._unsafe_setConnectionFlag(
          connection,
          CF_SUB_AGENT_OUTER_URL_KEY,
          subAgentOuterUrl
        );
      }
      // Lifecycle establishes the root socket/request context before entering
      // this wrapper. Do not carry root-owned native I/O into the facet RPC.
      if (
        await agentContext.exit(() =>
          this._cf_forwardSubAgentWebSocketConnect(connection, ctx.request, {
            gate: false
          })
        )
      ) {
        return;
      }
      // TODO: This is a hack to ensure the state is sent after the connection is established
      // must fix this
      return runInInvocation(
        { agent: this, connection, request: ctx.request, email: undefined },
        async () => {
          // Check if connection should be readonly before sending any messages
          // so that the flag is set before the client can respond
          if (this.shouldConnectionBeReadonly(connection, ctx)) {
            this.setConnectionReadonly(connection, true);
          }

          // Check if protocol messages should be suppressed for this
          // connection. When disabled, no identity/state/MCP text frames
          // are sent — useful for binary-only clients (e.g. MQTT devices).
          if (this.shouldSendProtocolMessages(connection, ctx)) {
            const wasExcludedFromStateInitBroadcast =
              this._protocolBroadcastExcludeIds.has(connection.id);
            let currentState: TState | undefined;
            this._protocolBroadcastExcludeIds.add(connection.id);
            try {
              currentState = this.state;
            } finally {
              if (!wasExcludedFromStateInitBroadcast) {
                this._protocolBroadcastExcludeIds.delete(connection.id);
              }
            }

            // Send agent identity first so client knows which instance it's connected to
            // Can be disabled via static options for security-sensitive instance names
            if (this._resolvedOptions.sendIdentityOnConnect) {
              const ctor = this.constructor as typeof Agent;
              if (
                ctor.options?.sendIdentityOnConnect === undefined &&
                !_sendIdentityWarnedClasses.has(ctor) &&
                // Facets are always addressed via `/sub/{class}/{name}`
                // in the OUTER client URL, even though the request the
                // facet itself receives has that segment stripped by
                // `_cf_forwardToFacet`. The sendIdentityOnConnect
                // concern (name only reachable via identity push) does
                // not apply — skip the warning entirely for facets.
                !this._isFacet
              ) {
                // Only warn when using custom routing — with default routing
                // the name is already visible in the URL path (/agents/{class}/{name})
                // so sendIdentityOnConnect leaks no additional information.
                const urlPath = new URL(ctx.request.url).pathname;
                if (!urlPath.includes(this.name)) {
                  _sendIdentityWarnedClasses.add(ctor);
                  console.warn(
                    `[Agent] ${ctor.name}: sending instance name "${this.name}" to clients ` +
                      `via sendIdentityOnConnect (the name is not visible in the URL with ` +
                      `custom routing). If this name is sensitive, add ` +
                      `\`static options = { sendIdentityOnConnect: false }\` to opt out. ` +
                      `Set it to true to silence this message.`
                  );
                }
              }
              // Agent's public identity: the logical name (a facet's routed
              // name is an internal encoding of it) and the exported class.
              this._webSockets.sendConnectFrames(connection, {
                name: this.name,
                agent: camelCaseToKebabCase(this._ParentClass.name)
              });
            } else if (currentState !== undefined) {
              this._webSockets.sendState(connection);
            }

            connection.send(
              JSON.stringify({
                mcp: this.getMcpServers(),
                type: MessageType.CF_AGENT_MCP_SERVERS
              })
            );
          } else {
            this._webSockets.setProtocolEnabled(connection, false);
          }

          this._emit("connect", { connectionId: connection.id });
          await this._agentTools._replayAgentToolRuns(connection);
          return this._tryCatch(() => _onConnect(connection, ctx));
        }
      );
    };

    const _onClose = this.onClose.bind(this);
    this.onClose = async (
      connection: Connection,
      code: number,
      reason: string,
      wasClean: boolean
    ) => {
      // Lifecycle establishes the root socket context before entering this
      // wrapper. Do not carry root-owned native I/O into the facet RPC.
      if (
        await agentContext.exit(() =>
          this._cf_forwardSubAgentWebSocketClose(
            connection,
            code,
            reason,
            wasClean
          )
        )
      ) {
        return;
      }
      return runInInvocation(
        { agent: this, connection, request: undefined, email: undefined },
        () => {
          this._emit("disconnect", {
            connectionId: connection.id,
            code,
            reason
          });
          return _onClose(connection, code, reason, wasClean);
        }
      );
    };

    const _onStart = this.onStart.bind(this);
    const startAgent = async (
      props: Props | undefined,
      update: (attributes: TraceAttributes) => void
    ) => {
      return runInInvocation(
        {
          agent: this,
          connection: undefined,
          request: undefined,
          email: undefined
        },
        async () => {
          await this._restoreAgentFacetContext();

          await this._tryCatch(async () => {
            mcpBroadcastReady = true;
            this.broadcastMcpServers();

            const openAgentToolRuns = await this._withAgentSpan(
              "recover_agent_work",
              "startup",
              {},
              async () => {
                await this._recoverFibers();
                await this._agentTools._carryForwardAgentToolRuns();
                // Interrupted Task runs (chat turns and awaited agent-tool
                // runs included) recover via the Lifecycle job queue: their
                // mirror jobs are overdue and re-fire on the post-startup
                // alarm derivation.
                return this._agentTools._activeAgentToolRunCount();
              }
            );
            update({
              "cloudflare.agents.start.facet": this._isFacet,
              "cloudflare.agents.recovery.agent_tools.count": openAgentToolRuns
            });

            // Chat recovery (above, in fiber recovery) evaluates its budgets
            // — and may seal an interrupted turn, firing `onExhausted` — BEFORE
            // the user's onStart runs. So a `chatRecovery` config produced
            // inside onStart is applied too late for the recovery that matters.
            // Snapshot the reference (subclasses like Think / AIChatAgent expose
            // `chatRecovery`; plain Agents leave it undefined) so we can warn if
            // onStart swaps in a custom config object below.
            const chatRecoveryBefore = (this as { chatRecovery?: unknown })
              .chatRecovery;

            const result = await this._withAgentSpan(
              "run_user_on_start",
              "startup",
              {},
              () => _onStart(props)
            );

            const chatRecoveryAfter = (this as { chatRecovery?: unknown })
              .chatRecovery;
            // Warn when onStart swaps in any recognized recovery config. A
            // custom config is applied too late for this wake, while a legacy
            // `false` value no longer disables durable recovery.
            const chatRecoveryAfterMatters =
              typeof chatRecoveryAfter === "boolean" ||
              (typeof chatRecoveryAfter === "object" &&
                chatRecoveryAfter !== null);
            if (
              !this._warnedChatRecoveryInOnStart &&
              chatRecoveryBefore !== chatRecoveryAfter &&
              chatRecoveryAfterMatters
            ) {
              this._warnedChatRecoveryInOnStart = true;
              console.warn(
                "[Agent] `chatRecovery` was assigned during onStart(). Chat " +
                  "recovery evaluates its budgets (and may seal an interrupted " +
                  "turn, firing onExhausted) on wake BEFORE onStart() runs, so a " +
                  "config set here is applied too late and the built-in defaults " +
                  "are used for the recovery that matters. Assign `chatRecovery` " +
                  "as a class field or in the constructor instead."
              );
            }

            await this._dropFacetHostJobs();
            return result;
          });
        }
      );
    };
    this.onStart = (props?: Props) =>
      this._withAgentSpan("agent_start", "startup", {}, (update) =>
        startAgent(props, update)
      );
  }

  private async _restoreAgentFacetContext(): Promise<void> {
    await this._withAgentSpan("restore_agent_state", "startup", {}, () =>
      this._dynamicAgents.restoreFacetContext()
    );
  }

  /**
   * Broadcast a protocol message only to connections that have protocol
   * messages enabled. Connections where shouldSendProtocolMessages returned
   * false are excluded automatically.
   * @param msg The JSON-encoded protocol message
   * @param excludeIds Additional connection IDs to exclude (e.g. the source)
   */
  private _broadcastProtocol(msg: string, excludeIds: string[] = []) {
    const exclude = [...excludeIds, ...this._protocolBroadcastExcludeIds];
    for (const conn of this.getConnections()) {
      if (!this.isConnectionProtocolEnabled(conn)) {
        exclude.push(conn.id);
      }
    }
    this.broadcast(msg, exclude);
  }

  /**
   * React to a persisted state change from the State capability.
   *
   * Reproduces the pre-migration steps 3-4: broadcast the new state to
   * protocol-enabled connections (excluding the originating connection) and
   * run the notification hook off the invocation tail.
   */
  private _handleStateChanged(
    nextState: TState,
    source: Connection | "server"
  ): void {
    // Broadcast state to protocol-enabled connections, excluding the source
    this._broadcastProtocol(
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
          await runInInvocation(
            { agent: this, connection, request, email },
            async () => {
              this._emit("state:update");
              await this._callStatePersistenceHook(nextState, source);
            },
            // Runs past the handler that set the state, on waitUntil's own
            // extension of the invocation.
            { detached: true }
          );
        } catch (e) {
          // onStateChanged/onStateUpdate errors should not affect state or broadcasts
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
   * @throws Error if called from a readonly connection context
   */
  setState(state: TState): void {
    // Check if the current context has a readonly connection
    const store = agentContext.getStore();
    if (store?.connection && this.isConnectionReadonly(store.connection)) {
      throw new Error("Connection is readonly");
    }
    this._state.set(state, "server");
  }

  /**
   * Mark a connection as readonly or readwrite
   * @param connection The connection to mark
   * @param readonly Whether the connection should be readonly (default: true)
   */
  setConnectionReadonly(connection: Connection, readonly = true) {
    markConnectionReadonly(connection, readonly);
  }

  /**
   * Check if a connection is marked as readonly.
   *
   * Safe to call after hibernation — re-wraps the connection if the
   * in-memory accessor cache was cleared.
   * @param connection The connection to check
   * @returns True if the connection is readonly
   */
  isConnectionReadonly(connection: Connection): boolean {
    return connectionReadonly(connection);
  }

  /**
   * ⚠️ INTERNAL — DO NOT USE IN APPLICATION CODE. ⚠️
   *
   * Read an internal `_cf_`-prefixed flag from the raw connection state,
   * bypassing the user-facing state wrapper that strips internal keys.
   *
   * This exists for framework mixins (e.g. voice) that need to persist
   * flags in the connection attachment across hibernation. Application
   * code should use `connection.state` and `connection.setState()` instead.
   *
   * @internal
   */
  _unsafe_getConnectionFlag(connection: Connection, key: string): unknown {
    return getConnectionFlag(connection, key);
  }

  /**
   * ⚠️ INTERNAL — DO NOT USE IN APPLICATION CODE. ⚠️
   *
   * Write an internal `_cf_`-prefixed flag to the raw connection state,
   * bypassing the user-facing state wrapper. The key must be registered
   * with `registerInternalConnectionKeys` so it is preserved across user
   * `setState` calls and hidden from `connection.state`.
   *
   * @internal
   */
  _unsafe_setConnectionFlag(
    connection: Connection,
    key: string,
    value: unknown
  ): void {
    setConnectionFlag(connection, key, value);
  }

  /**
   * Override this method to determine if a connection should be readonly on connect
   * @param _connection The connection that is being established
   * @param _ctx Connection context
   * @returns True if the connection should be readonly
   */
  shouldConnectionBeReadonly(
    _connection: Connection,
    _ctx: ConnectionContext
  ): boolean {
    return false;
  }

  /**
   * Override this method to control whether protocol messages are sent to a
   * connection. Protocol messages include identity (CF_AGENT_IDENTITY), state
   * sync (CF_AGENT_STATE), and MCP server lists (CF_AGENT_MCP_SERVERS).
   *
   * When this returns `false` for a connection, that connection will not
   * receive any protocol text frames — neither on connect nor via broadcasts.
   * This is useful for binary-only clients (e.g. MQTT devices) that cannot
   * handle JSON text frames.
   *
   * The connection can still send and receive regular messages, use RPC, and
   * participate in all non-protocol communication.
   *
   * @param _connection The connection that is being established
   * @param _ctx Connection context (includes the upgrade request)
   * @returns True if protocol messages should be sent (default), false to suppress them
   */
  shouldSendProtocolMessages(
    _connection: Connection,
    _ctx: ConnectionContext
  ): boolean {
    return true;
  }

  /**
   * Check if a connection has protocol messages enabled.
   * Protocol messages include identity, state sync, and MCP server lists.
   *
   * Safe to call after hibernation — re-wraps the connection if the
   * in-memory accessor cache was cleared.
   * @param connection The connection to check
   * @returns True if the connection receives protocol messages
   */
  isConnectionProtocolEnabled(connection: Connection): boolean {
    return connectionProtocolEnabled(connection);
  }

  /**
   * Called before the Agent's state is persisted and broadcast.
   * Override to validate or reject an update by throwing an error.
   *
   * IMPORTANT: This hook must be synchronous.
   */
  // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
  validateStateChange(_nextState: TState, _source: Connection | "server") {
    // override this to validate state updates
  }

  /**
   * Called after the Agent's state has been persisted and broadcast to all clients.
   * This is a notification hook — errors here are routed to onError and do not
   * affect state persistence or client broadcasts.
   *
   * @param state Updated state
   * @param source Source of the state update ("server" or a client connection)
   */
  // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
  onStateChanged(_state: TState | undefined, _source: Connection | "server") {
    // override this to handle state updates after persist + broadcast
  }

  /**
   * @deprecated Renamed to `onStateChanged` — the behavior is identical.
   * `onStateUpdate` will be removed in the next major version.
   *
   * Called after the Agent's state has been persisted and broadcast to all clients.
   * This is a server-side notification hook. For the client-side state callback,
   * see the `onStateUpdate` option in `useAgent` / `AgentClient`.
   *
   * @param state Updated state
   * @param source Source of the state update ("server" or a client connection)
   */
  // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
  onStateUpdate(_state: TState | undefined, _source: Connection | "server") {
    // override this to handle state updates (deprecated — use onStateChanged)
  }

  /**
   * Dispatch to the appropriate persistence hook based on the mode
   * cached in the constructor. No prototype walks at call time.
   */
  private async _callStatePersistenceHook(
    state: TState | undefined,
    source: Connection | "server"
  ): Promise<void> {
    switch (this._persistenceHookMode) {
      case "new":
        await this.onStateChanged(state, source);
        break;
      case "old":
        await this.onStateUpdate(state, source);
        break;
      // "none": neither hook overridden — skip
    }
  }

  /**
   * Called when the Agent receives an email via routeAgentEmail()
   * Override this method to handle incoming emails
   * @param payload Internal wire format — plain data + RpcTarget bridge
   */
  async _onEmail(payload: AgentEmailPayload) {
    const email = agentEmailFromPayload(payload);
    return runInInvocation(
      { agent: this, connection: undefined, request: undefined, email },
      async () => {
        this._emit("email:receive", {
          from: email.from,
          to: email.to,
          subject: email.headers.get("subject") ?? undefined
        });
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
   */
  async replyToEmail(
    email: AgentEmail,
    options: ReplyToEmailOptions
  ): Promise<void> {
    return this._tryCatch(async () => {
      const subject = await replyToAgentEmail(email, options, {
        agentName: camelCaseToKebabCase(this._ParentClass.name),
        agentId: this.name
      });
      // A reply: the agent (email.to) is now the sender.
      this._emit("email:reply", { from: email.to, to: email.from, subject });
    });
  }

  /**
   * Send an outbound email via an Email Service binding.
   *
   * Automatically injects agent routing headers (X-Agent-Name, X-Agent-ID).
   * When `secret` is provided, signs headers with HMAC-SHA256 so that replies
   * can be routed back to this agent instance via createSecureReplyEmailResolver.
   *
   * @param options.binding The send_email binding (e.g. this.env.EMAIL)
   * @param options.to Recipient address(es)
   * @param options.from Sender address or {email, name} object
   * @param options.subject Email subject line
   * @param options.text Plain text body (at least one of text/html required)
   * @param options.html HTML body (at least one of text/html required)
   * @param options.replyTo Reply-to address
   * @param options.cc CC recipient(s)
   * @param options.bcc BCC recipient(s)
   * @param options.inReplyTo Message-ID of the email this is replying to (for threading)
   * @param options.headers Additional custom headers
   * @param options.secret Secret for signing agent routing headers
   * @returns The messageId from Email Service
   */
  async sendEmail(options: SendEmailOptions): Promise<EmailSendResult> {
    return this._tryCatch(async () => {
      const result = await sendAgentEmail(options, {
        agentName: camelCaseToKebabCase(this._ParentClass.name),
        agentId: this.name
      });

      const fromAddr =
        typeof options.from === "string" ? options.from : options.from.email;
      this._emit("email:send", {
        from: fromAddr,
        to: options.to,
        subject: options.subject
      });

      return result;
    });
  }

  private async _tryCatch<T>(fn: () => T | Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      // `onError` observes the error and may replace it by throwing. If it
      // returns, the original error continues to the caller.
      await this.onError(e);
      throw e;
    }
  }

  onError(connection: Connection, error: unknown): void | Promise<void>;
  onError(error: unknown): void | Promise<void>;
  onError(connectionOrError: Connection | unknown, error?: unknown) {
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
   * Retry an async operation with exponential backoff and jitter.
   * Retries on all errors by default. Use `shouldRetry` to bail early on non-retryable errors.
   *
   * @param fn The async function to retry. Receives the current attempt number (1-indexed).
   * @param options Retry configuration.
   * @param options.maxAttempts Maximum number of attempts (including the first). Falls back to static options, then 3.
   * @param options.baseDelayMs Base delay in ms for exponential backoff. Falls back to static options, then 100.
   * @param options.maxDelayMs Maximum delay cap in ms. Falls back to static options, then 3000.
   * @param options.shouldRetry Predicate called with the error and next attempt number. Return false to stop retrying immediately. Default: retry all errors.
   * @returns The result of fn on success.
   * @throws The last error if all attempts fail or shouldRetry returns false.
   */
  async retry<T>(
    fn: (attempt: number) => Promise<T>,
    options?: RetryOptions & {
      /** Return false to stop retrying a specific error. Receives the error and the next attempt number. Default: retry all errors. */
      shouldRetry?: (err: unknown, nextAttempt: number) => boolean;
    }
  ): Promise<T> {
    const defaults = this._resolvedOptions.retry;
    if (options) {
      validateRetryOptions(options, defaults);
    }
    return tryN(options?.maxAttempts ?? defaults.maxAttempts, fn, {
      baseDelayMs: options?.baseDelayMs ?? defaults.baseDelayMs,
      maxDelayMs: options?.maxDelayMs ?? defaults.maxDelayMs,
      shouldRetry: options?.shouldRetry
    });
  }

  /**
   * Queue a task to run in the background.
   *
   * The item is durable: it runs from the Lifecycle alarm event loop after
   * this call returns, in push order, one at a time, with retries per
   * `options.retry`, and survives the Durable Object leaving memory.
   * @param callback Name of the method to call
   * @param payload Payload to pass to the callback
   * @param options Options for the queued task
   * @param options.retry Retry options for the callback execution
   * @param options.id Stable id; a push with an existing id replaces that item
   * @returns The ID of the queued task
   */
  async queue<T = unknown>(
    callback: keyof this,
    payload: T,
    options?: { retry?: RetryOptions; id?: string }
  ): Promise<string> {
    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }
    if (typeof this[callback] !== "function") {
      throw new Error(`this.${callback} is not a function`);
    }
    const item = await this._queue.push(callback, payload, options);
    return item.id;
  }

  /**
   * Dequeue a task by ID
   * @param id ID of the task to dequeue
   */
  dequeue(id: string): Promise<boolean> {
    return this._queue.cancel(id);
  }

  /**
   * Dequeue all tasks
   */
  dequeueAll(): Promise<number> {
    return this._queue.cancelAll();
  }

  /**
   * Dequeue all tasks by callback
   * @param callback Name of the callback to dequeue
   */
  dequeueAllByCallback(callback: string): Promise<number> {
    return this._queue.cancelAll(callback);
  }

  /**
   * Get a queued task by ID
   * @param id ID of the task to get
   * @returns The task or undefined if not found
   */
  getQueue<T = unknown>(id: string): Promise<QueueItem<T> | undefined> {
    return this._queue.get<T>(id);
  }

  /**
   * Get all queued tasks whose payload has `key` equal to `value`
   * @param key Key to filter by
   * @param value Value to filter by
   * @returns Array of matching QueueItem objects
   */
  async getQueues<T = unknown>(
    key: string,
    value: string
  ): Promise<QueueItem<T>[]> {
    const items = await this._queue.list<T>();
    return items.filter(
      (item) =>
        typeof item.payload === "object" &&
        item.payload !== null &&
        (item.payload as Record<string, unknown>)[key] === value
    );
  }

  private _lifecycleRouteAddress(): LifecycleRouteAddress | undefined {
    return this._dynamicAgents.lifecycleRouteAddress();
  }

  private _routeLifecycleToRoot(
    envelope: LifecycleRouteEnvelope
  ): Promise<unknown> {
    return this._dynamicAgents.routeLifecycleToRoot(envelope);
  }

  private _routeLifecycleToTarget(
    target: LifecycleRouteAddress,
    envelope: LifecycleRouteEnvelope
  ): Promise<unknown> {
    return this._dynamicAgents.routeLifecycleToTarget(target, envelope);
  }

  /**
   * Serves a browser's request to one of its internal hostnames. Browser
   * Run's `InternalHostRouter` calls this over RPC; it passes the message to
   * the `Browser` it names, which runs the host's `fetch`. Built in, so an
   * Agent needs nothing extra for internal hostnames. Not `@callable`, so
   * clients can't reach it.
   */
  async fetchInternalHost(message: InternalHostMessage): Promise<Response> {
    await this.__unsafe_ensureInitialized();
    // Routed by capability id rather than through the Browser itself, so
    // Agent doesn't bundle the browser code.
    return (await this.lifecycle.route({
      capability: browserCapabilityId(message.browser),
      source: undefined,
      payload: message
    })) as Response;
  }

  /** Single native-RPC aperture for routed Lifecycle capabilities. */
  async _cf_routeLifecycle(
    target: LifecycleRouteAddress | undefined,
    envelope: LifecycleRouteEnvelope
  ): Promise<unknown> {
    await this.__unsafe_ensureInitialized();
    return this._dynamicAgents.routeLifecycle(target, envelope);
  }

  // ── Scheduling (delegates to agents/schedules) ─────────────────────────

  /**
   * Clean root-owned bookkeeping for a sub-tree of facets. This
   * bulk-cancels schedules whose `owner_path` starts with the given
   * prefix and deletes root-side facet fiber recovery leases for the
   * same sub-tree. Used by `deleteSubAgent` and recursive facet
   * destroy. Emits `schedule:cancel` on this agent (the alarm-owning
   * root) for each schedule row removed — the facets being torn down
   * may not be alive to receive the events themselves.
   * @internal
   */
  async _cf_cleanupFacetPrefix(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<void> {
    await this.__unsafe_ensureInitialized();
    await this._dynamicAgents.cleanupPrefix(ownerPath);
  }

  /**
   * Schedule a task to be executed in the future
   *
   * Cron schedules are **idempotent by default** — calling `schedule("0 * * * *", "tick")`
   * multiple times with the same callback, cron expression, and payload returns
   * the existing schedule instead of creating a duplicate. Set `idempotent: false`
   * to override this.
   *
   * For delayed and scheduled (Date) types, set `idempotent: true` to opt in
   * to the same dedup behavior (matched on callback + payload). This is useful
   * when calling `schedule()` in `onStart()` to avoid accumulating duplicate
   * rows across Durable Object restarts.
   *
   * @template T Type of the payload data
   * @param when When to execute the task (Date, seconds delay, or cron expression)
   * @param callback Name of the method to call
   * @param payload Data to pass to the callback
   * @param options Options for the scheduled task
   * @param options.retry Retry options for the callback execution
   * @param options.idempotent Dedup by callback+payload. Defaults to `true` for cron, `false` otherwise.
   * @returns Schedule object representing the scheduled task
   */
  schedule<T = string>(
    when: Date | string | number,
    callback: keyof this,
    payload?: T,
    options?: ScheduleOptions
  ): Promise<Schedule<T>> {
    // SAFETY: Agent's historical generic promises Schedule<T>; the untyped
    // scheduler default carries Schedule<unknown> for name-based calls.
    return this.scheduler.set(
      when,
      callback as string,
      payload,
      options
    ) as Promise<Schedule<T>>;
  }

  /**
   * Schedule a task to run repeatedly at a fixed interval.
   *
   * This method is **idempotent** — calling it multiple times with the same
   * `callback`, `intervalSeconds`, and `payload` returns the existing schedule
   * instead of creating a duplicate. A different interval or payload is
   * treated as a distinct schedule and creates a new row.
   *
   * This makes it safe to call in `onStart()`, which runs on every Durable
   * Object wake:
   *
   * ```ts
   * async onStart() {
   *   // Only one schedule is created, no matter how many times the DO wakes
   *   await this.scheduleEvery(30, "tick");
   * }
   * ```
   *
   * @template T Type of the payload data
   * @param intervalSeconds Number of seconds between executions
   * @param callback Name of the method to call
   * @param payload Data to pass to the callback
   * @param options Options for the scheduled task
   * @param options.retry Retry options for the callback execution
   * @returns Schedule object representing the scheduled task
   */
  scheduleEvery<T = string>(
    intervalSeconds: number,
    callback: keyof this,
    payload?: T,
    options?: { retry?: RetryOptions; _idempotent?: boolean }
  ): Promise<Schedule<T>> {
    // SAFETY: Agent's historical generic promises Schedule<T>; the untyped
    // scheduler default carries Schedule<unknown> for name-based calls.
    return this.scheduler.every(intervalSeconds, callback as string, payload, {
      retry: options?.retry,
      idempotent: options?._idempotent
    }) as Promise<Schedule<T>>;
  }

  /**
   * Get a scheduled task by ID
   * @template T Type of the payload data
   * @param id ID of the scheduled task
   * @returns The Schedule object or undefined if not found
   * @deprecated Use {@link getScheduleById}.
   */
  getSchedule<T = string>(id: string): Schedule<T> | undefined {
    return this.scheduler.__DO_NOT_USE_WILL_REMOVE__getSchedule<T>(id);
  }

  /**
   * Get a scheduled task by ID.
   *
   *
   * @param id ID of the scheduled task
   * @returns The Schedule object or undefined if not found
   */
  getScheduleById(id: string): Promise<Schedule<unknown> | undefined> {
    return this.scheduler.get(id);
  }

  /**
   * Get scheduled tasks matching the given criteria
   * @template T Type of the payload data
   * @param criteria Criteria to filter schedules
   * @returns Array of matching Schedule objects
   * @deprecated Use {@link listSchedules}.
   */
  getSchedules<T = string>(criteria: ScheduleCriteria = {}): Schedule<T>[] {
    return this.scheduler.__DO_NOT_USE_WILL_REMOVE__getSchedules<T>(criteria);
  }

  /**
   * List scheduled tasks matching the given criteria.
   *
   *
   * @param criteria Criteria to filter schedules
   * @returns Array of matching Schedule objects
   */
  listSchedules(criteria: ScheduleCriteria = {}): Promise<Schedule<unknown>[]> {
    return this.scheduler.list(criteria);
  }

  /**
   * Cancel a scheduled task.
   *
   * Schedules are isolated by owner: a top-level agent's
   * `cancelSchedule(id)` only matches its own schedules, and a
   * sub-agent's `cancelSchedule(id)` only matches schedules it
   * created. To clear every schedule under a sub-agent (and its
   * descendants), call `parent.deleteSubAgent(Cls, name)` from the
   * parent — that bulk-cleans root-owned bookkeeping via
   * {@link _cf_cleanupFacetPrefix}.
   *
   * @param id ID of the task to cancel
   * @returns true if the task was cancelled, false if the task was not found
   */
  cancelSchedule(id: string): Promise<boolean> {
    return this.scheduler.cancel(id);
  }

  /**
   * Keep the Durable Object alive via alarm heartbeats.
   * Returns a disposer function that stops the heartbeat when called.
   *
   * Use this when you have long-running work and need to prevent the
   * DO from going idle (eviction after ~70-140s of inactivity).
   * The heartbeat fires every `keepAliveIntervalMs` (default 30s) via the
   * alarm system, without creating schedule rows or emitting observability
   * events. Configure via `static options = { keepAliveIntervalMs: 5000 }`.
   *
   * In facets, delegates the physical heartbeat to the root parent
   * because facets do not have independent alarm slots.
   *
   * @example
   * ```ts
   * const dispose = await this.keepAlive();
   * try {
   *   // ... long-running work ...
   * } finally {
   *   dispose();
   * }
   * ```
   */
  keepAlive(): Promise<() => void> {
    return this._keepAlive.acquire();
  }

  /**
   * Run an async function while keeping the Durable Object alive.
   * The heartbeat is automatically stopped when the function completes
   * (whether it succeeds or throws).
   *
   * This is the recommended way to use keepAlive — it guarantees cleanup
   * so you cannot forget to dispose the heartbeat.
   *
   * @example
   * ```ts
   * const result = await this.keepAliveWhile(async () => {
   *   const data = await longRunningComputation();
   *   return data;
   * });
   * ```
   */
  async keepAliveWhile<T>(fn: () => Promise<T>): Promise<T> {
    // Through keepAlive(), so a subclass override sees every hold.
    const release = await this.keepAlive();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // ── Fibers (one-step Task runs, ./fiber-runs) ─────────────────────

  /**
   * Run a function as a durable fiber and return its result. The fiber is
   * recorded before it runs, checkpoints with `ctx.stash()` or
   * `this.stash()`, and after an eviction its last checkpoint goes to
   * `onFiberRecovered`. The function itself never runs again.
   */
  runFiber<T>(name: string, fn: (ctx: FiberContext) => Promise<T>): Promise<T> {
    return runFiber(this.tasks, name, fn);
  }

  /**
   * Run a fiber whose framework recovery data wraps the user's checkpoints.
   * Released `@cloudflare/ai-chat` and `@cloudflare/think` versions call it
   * for sub-agent turns, and they accept newer `agents` releases, so it
   * stays while those versions are in range.
   * @internal
   */
  protected _runFiberWithStashWrapper<T>(
    name: string,
    fn: (ctx: FiberContext) => Promise<T>,
    options: Pick<InternalFiberOptions, "initialSnapshot" | "wrapStash">
  ): Promise<T> {
    return runFiber(this.tasks, name, fn, options);
  }

  /**
   * Accept a managed fiber: deduplicated by `fiberId` or `idempotencyKey`,
   * kept in a ledger you inspect, cancel, resolve and delete.
   */
  startFiber(
    name: string,
    fn: (ctx: FiberContext) => Promise<void>,
    options?: StartFiberOptions
  ): Promise<StartFiberResult> {
    return startFiber(this.tasks, name, fn, options);
  }

  async inspectFiber(fiberId: string): Promise<FiberInspection | null> {
    return inspectFiber(this.tasks, this.tasks.peek(fiberId));
  }

  async inspectFiberByKey(
    idempotencyKey: string
  ): Promise<FiberInspection | null> {
    return inspectFiber(this.tasks, fiberByKey(this.tasks, idempotencyKey));
  }

  async listFibers(options?: ListFibersOptions): Promise<FiberInspection[]> {
    return listFibers(this.tasks, options);
  }

  async cancelFiber(fiberId: string, reason?: string): Promise<boolean> {
    return cancelFiber(this.tasks, this.tasks.peek(fiberId), reason);
  }

  async cancelFiberByKey(
    idempotencyKey: string,
    reason?: string
  ): Promise<boolean> {
    return cancelFiber(
      this.tasks,
      fiberByKey(this.tasks, idempotencyKey),
      reason
    );
  }

  async resolveFiber(
    fiberId: string,
    result: FiberRecoveryResult
  ): Promise<boolean> {
    return resolveFiber(this.tasks, fiberId, result);
  }

  async deleteFibers(options?: DeleteFibersOptions): Promise<number> {
    return deleteFibers(this.tasks, options);
  }

  /**
   * Carry fiber rows from older releases forward, then recover the fibers a
   * dead isolate left, before onStart runs.
   */
  private async _recoverFibers(): Promise<void> {
    // Recorded once as the host's next version, so a later start reads no
    // table list. Only a release from before the record has these tables.
    await this.lifecycle.hostSchema.migrate({
      version: FIBERS_IMPORTED_SCHEMA_VERSION,
      legacyKey: SCHEMA_VERSION_KEY,
      steps: {
        [FIBERS_IMPORTED_SCHEMA_VERSION]: () =>
          importLegacyFibers(
            this.tasks,
            this.ctx.storage,
            this._isFacet,
            this.lifecycle
          )
      }
    });
    const scanMs = this._resolvedOptions.fiberRecoveryScanDeadlineMs;
    const startedAt = Date.now();
    const deadline = scanMs > 0 ? startedAt + scanMs : undefined;
    // What the deadline leaves runs from its own wake, after startup.
    const left =
      (await this.tasks.runDue(FIBER_TASK, deadline)) ??
      (await this.tasks.runDue(MANAGED_FIBER_TASK, deadline));
    if (left !== undefined) {
      this._emit("fiber:recovery:skipped", {
        fiberId: left,
        fiberName: this.tasks.inputOf<{ name: string }>(left)?.name,
        reason: "scan_deadline_exceeded",
        elapsedMs: Date.now() - startedAt
      });
    }
  }

  /**
   * Checkpoint data for the fiber running in the current async context.
   * Throws if called outside a fiber.
   */
  stash(data: unknown): void {
    stashCurrentFiber(data);
  }

  /**
   * Run `fn` as the current fiber so `this.stash()` works for turns
   * running on the `tasks` capability.
   * @internal
   */
  protected _withFiberStash<T>(
    context: FiberStashContext,
    fn: () => Promise<T>
  ): Promise<T> {
    return withFiberStash(context, fn);
  }

  /**
   * Called when an interrupted fiber is detected after restart.
   * Override to implement recovery (re-invoke work, notify clients, etc.).
   *
   * Internal framework fibers are filtered by `_handleInternalFiberRecovery`
   * before this hook runs — users only see their own fibers.
   *
   * Default: logs a warning.
   */
  async onFiberRecovered(
    // oxlint-disable-next-line @typescript-eslint/no-unused-vars -- overridable hook
    _ctx: FiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    console.warn(
      `[Agent] Fiber "${_ctx.name}" (${_ctx.id}) was interrupted. ` +
        "Override onFiberRecovered to handle recovery."
    );
  }

  /**
   * Override point for subclasses to handle internal (framework) fibers
   * before the user's recovery hook fires. Return `true` if handled.
   * @internal
   */
  protected async _handleInternalFiberRecovery(
    // oxlint-disable-next-line @typescript-eslint/no-unused-vars -- override point
    _ctx: FiberRecoveryContext
  ): Promise<boolean> {
    return false;
  }

  private _isSameAgentPathPrefix(
    prefix: ReadonlyArray<AgentPathStep>,
    path: ReadonlyArray<AgentPathStep>
  ): boolean {
    if (prefix.length > path.length) return false;
    return prefix.every(
      (step, index) =>
        step.className === path[index].className &&
        step.name === path[index].name
    );
  }

  /**
   * Invoke an RPC method on this Agent or a descendant facet identified
   * by a root-first path. Used by AgentWorkflow to route callbacks and
   * `this.agent` calls back to the exact sub-agent that started a workflow.
   * @internal
   */
  _cf_invokeAgentPath(
    targetPath: ReadonlyArray<AgentPathStep>,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    return this._dynamicAgents.invokeAgentPath(targetPath, method, args);
  }

  /**
   * Recursively destroy a descendant facet identified by
   * `targetPath`. Walks down from `selfPath` until reaching the
   * target's immediate parent, where it cancels the target's
   * parent-owned schedules (and any descendants), removes the
   * target from the registry, and calls `ctx.facets.delete` to
   * wipe the target's storage.
   *
   * Called by a facet's own `destroy()` (via the root) so that
   * `this.destroy()` inside a sub-agent results in the same
   * cleanup as `parent.deleteSubAgent(Cls, name)` from the parent.
   * @internal
   */
  async _cf_destroyDescendantFacet(
    targetPath: ReadonlyArray<AgentPathStep>
  ): Promise<void> {
    await this.__unsafe_ensureInitialized();
    await this._dynamicAgents.destroyDescendant(targetPath);
  }

  /**
   * Agent pushes no host jobs, but earlier releases could leave some in a
   * facet's queue (#2299). A facet has no alarm, so they would only fail
   * every re-arm: drop them. On the root they complete when they fire.
   */
  private async _dropFacetHostJobs(): Promise<void> {
    if (!this._isFacet) return;
    const work = this.lifecycle.jobs;
    for (const job of work.list()) await work.cancel(job.id);
  }

  /** Lifecycle alarm callback; user alarm work runs in its override. */
  onAlarm(): void {}

  /**
   * Agent pushes no host jobs. The `destroy`, `keepAlive` and `housekeeping`
   * jobs of earlier releases complete when they fire.
   * @internal
   */
  onJob({ job }: LifecycleJobContext): void {
    if (!["destroy", "keepAlive", "housekeeping"].includes(job.fn)) {
      console.warn(`Unknown Agent host job fn ${JSON.stringify(job.fn)}`);
    }
  }

  /**
   * Apply host policy after the alarm memory-limit breaker records a strike.
   *
   * New chat hosts override this hook directly. The sealed-only fallback keeps
   * `agents` 0.23 compatible with already-published chat packages whose peer
   * ranges accept it but which implement only the former
   * `_cf_sealMemoryLimitedRecovery` template method. Queue membership remains
   * job-row policy; this invokes terminalization only and can be removed once
   * old chat releases no longer accept the current `agents` range.
   *
   * @internal
   */
  protected async onAlarmMemoryLimit(
    context: MemoryLimitContext
  ): Promise<void> {
    if (!context.sealed) return;
    const legacySeal = (
      this as unknown as {
        _cf_sealMemoryLimitedRecovery?: () => void | Promise<void>;
      }
    )._cf_sealMemoryLimitedRecovery;
    await legacySeal?.call(this);
  }

  /**
   * Run Lifecycle's alarm event loop after the pending-destroy preamble.
   *
   * The alarm memory-limit circuit breaker (#1825) lives inside
   * `Lifecycle.alarm()`; capabilities and hosts opt into extra domain
   * policy via their `onMemoryLimit` / `onAlarmMemoryLimit` hooks and the
   * `recoveryLoop` schedule option.
   *
   * @remarks Use `this.schedule()` for named Agent callbacks. Reusable durable
   * work belongs in a capability that pushes jobs and implements `onJob()`.
   */
  async alarm() {
    // A pending destroy (#1625) pre-empts everything — including lifecycle
    // startup, which would re-initialize user state on a
    // condemned agent. This is both the landing point for the deferred
    // teardown scheduled by `_cf_scheduleDestroy` (which arms an immediate
    // alarm precisely so teardown runs here, with this invocation's full
    // execution budget) and the convergence point for a destroy that a
    // previous invocation started but couldn't finish.
    this._alarmDepth++;
    try {
      if ((await this._deferredDestroy.pendingAt()) !== null) {
        await this.destroy();
        return;
      }

      await this.lifecycle.alarm();
    } finally {
      this._alarmDepth--;
      const reason = this._abortAfterAlarm;
      if (this._alarmDepth === 0 && reason !== undefined) {
        this._abortAfterAlarm = undefined;
        setTimeout(
          () => abortWithoutAlarmRetry(this.ctx, reason),
          ABORT_AFTER_ALARM_MS
        );
      }
    }
  }

  /** Alarm invocations in progress on this instance. */
  private _alarmDepth = 0;
  /** Set by a destroy inside an alarm: abort once the alarm has returned. */
  private _abortAfterAlarm: string | undefined;

  // ── Sub-agent routing (external addressability for facets) ──────────────

  /**
   * Intercept incoming HTTP/WS requests whose URL contains a
   * `/sub/{child-class}/{child-name}` marker and forward them to
   * the facet. The `onBeforeSubAgent` hook fires first (authorize,
   * mutate, or short-circuit). If the hook doesn't return a
   * Response, the framework resolves the facet and hands the
   * request off.
   *
   * The parent owns an upgraded WebSocket for its lifetime. Subsequent
   * frames wake the root parent, which forwards them to the child over
   * RPC and routes replies back to the native socket.
   *
   * @experimental The API surface may change before stabilizing.
   */
  async fetch(request: Request): Promise<Response> {
    const ctx = this.ctx as unknown as Partial<FacetCapableCtx>;
    const match = _parseSubAgentPath(request.url, {
      knownClasses: ctx.exports ? Object.keys(ctx.exports) : undefined
    });

    if (!match) {
      return this.lifecycle.fetch(request);
    }

    // Hook runs in the parent's isolate before any facet work.
    const decision = await this.onBeforeSubAgent(request, {
      className: match.childClass,
      name: match.childName
    });
    const isWebSocketUpgrade =
      request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (decision instanceof Response) {
      return isWebSocketUpgrade && !decision.webSocket
        ? rejectSubAgentWebSocket(decision)
        : decision;
    }
    const forwardReq = decision instanceof Request ? decision : request;

    if (isWebSocketUpgrade) {
      const acceptHeaders = new Headers(forwardReq.headers);
      const routedUrl = new URL(forwardReq.url);
      routedUrl.pathname = new URL(request.url).pathname;
      acceptHeaders.set(SUB_AGENT_OUTER_URL_HEADER, routedUrl.toString());
      return this.lifecycle.fetch(
        new Request(forwardReq, { headers: acceptHeaders })
      );
    }

    return this._cf_forwardToFacet(forwardReq, match);
  }

  broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    if (this._isFacet) {
      void this._dynamicAgents.broadcastToParent(msg, without);
      return;
    }

    for (const connection of this._webSockets.getConnections()) {
      if (without?.includes(connection.id)) continue;
      if (this._dynamicAgents.connectionHasChildTarget(connection)) continue;
      connection.send(msg);
    }
  }

  getConnection<TState = unknown>(id: string): Connection<TState> | undefined {
    if (this._isFacet) {
      // Do not read lifecycle-owned root connections from a facet — that
      // resolves to the host/root DO's hibernatable sockets and reading them
      // from the facet's I/O context throws a cross-DO Native I/O error. See
      // issue #1677. Only virtual (bridged) connections are visible here.
      return this._dynamicAgents.getVirtualConnection(id) as
        | Connection<TState>
        | undefined;
    }

    const connection = this._webSockets.getConnection<TState>(id);
    if (
      !connection ||
      this._dynamicAgents.connectionHasChildTarget(connection)
    ) {
      return undefined;
    }
    return connection;
  }

  *getConnections<TState = unknown>(
    tag?: string
  ): Iterable<Connection<TState>> {
    if (this._isFacet) {
      // A facet's client connections are all virtual — they are real
      // WebSockets owned by the ROOT DO and bridged in. We must NOT fall
      // through to `this._webSockets.getConnections()` here: on a facet that resolves to
      // the host/root DO's hibernatable sockets, and reading their attachments
      // from the facet's I/O context throws
      // "Cannot perform I/O on behalf of a different Durable Object (Native)".
      // See issue #1677.
      yield* this._dynamicAgents.getVirtualConnections(tag) as Iterable<
        Connection<TState>
      >;
      return;
    }

    for (const connection of this._webSockets.getConnections<TState>(tag)) {
      if (this._dynamicAgents.connectionHasChildTarget(connection)) continue;
      yield connection;
    }
  }

  async _cf_broadcastToSubAgent(
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): Promise<number | void> {
    await this.__unsafe_ensureInitialized();
    return this._dynamicAgents.broadcastToPath(ownerPath, message, without);
  }

  async _cf_subAgentConnectionMetas(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<SubAgentConnectionMeta[]> {
    await this.__unsafe_ensureInitialized();
    return this._dynamicAgents.connectionMetas(ownerPath);
  }

  async _cf_sendToSubAgentConnection(
    connectionId: string,
    message: string | ArrayBuffer | ArrayBufferView,
    ownerPath?: ReadonlyArray<AgentPathStep>
  ): Promise<void> {
    await this.__unsafe_ensureInitialized();
    await this._dynamicAgents.sendToConnection(
      connectionId,
      message,
      ownerPath
    );
  }

  async _cf_sendManyToSubAgentConnection(
    connectionId: string,
    messages: ReadonlyArray<string | ArrayBuffer | ArrayBufferView>,
    ownerPath?: ReadonlyArray<AgentPathStep>
  ): Promise<void> {
    await this.__unsafe_ensureInitialized();
    await this._dynamicAgents.sendManyToConnection(
      connectionId,
      messages,
      ownerPath
    );
  }

  async _cf_closeSubAgentConnection(
    connectionId: string,
    code?: number,
    reason?: string,
    ownerPath?: ReadonlyArray<AgentPathStep>
  ): Promise<void> {
    await this.__unsafe_ensureInitialized();
    await this._dynamicAgents.closeConnection(
      connectionId,
      code,
      reason,
      ownerPath
    );
  }

  async _cf_closeSubAgentConnectionsForPrefix(
    prefix: ReadonlyArray<AgentPathStep>,
    code: number,
    reason: string
  ): Promise<void> {
    await this.__unsafe_ensureInitialized();
    this._dynamicAgents.closeConnectionsForPrefix(prefix, code, reason);
  }

  async _cf_setSubAgentConnectionState(
    connectionId: string,
    state: unknown,
    ownerPath?: ReadonlyArray<AgentPathStep>
  ): Promise<unknown> {
    await this.__unsafe_ensureInitialized();
    return this._dynamicAgents.setConnectionState(
      connectionId,
      state,
      ownerPath
    );
  }

  async _cf_setSubAgentConnectionFlag(
    connectionId: string,
    key: string,
    value: unknown,
    ownerPath?: ReadonlyArray<AgentPathStep>
  ): Promise<void> {
    await this.__unsafe_ensureInitialized();
    this._dynamicAgents.setConnectionFlag(connectionId, key, value, ownerPath);
  }

  protected _cf_connectionTargetsSubAgent(connection: Connection): boolean {
    return this._dynamicAgents.connectionRoutesToChild(connection);
  }

  /**
   * Returns true when the current request is addressed to a child facet of
   * this agent rather than to this agent itself.
   *
   * Chat-style subclasses wrap `onConnect` before the base Agent forwarding
   * wrapper runs, so they need a request-level check to avoid sending their
   * own protocol frames on sockets that are about to be forwarded to a child.
   */
  protected _cf_requestTargetsSubAgent(request: Request): boolean {
    return this._dynamicAgents.requestTargetsChild(request);
  }

  private _cf_forwardSubAgentWebSocketConnect(
    connection: Connection,
    request: Request,
    options: { gate: boolean }
  ): Promise<boolean> {
    return this._dynamicAgents.forwardWebSocketConnect(
      connection,
      request,
      options
    );
  }

  private _cf_forwardSubAgentWebSocketMessage(
    connection: Connection,
    message: WSMessage,
    replyBridge?: SubAgentConnectionBridge
  ): Promise<boolean> {
    return this._dynamicAgents.forwardWebSocketMessage(
      connection,
      message,
      replyBridge
    );
  }

  private _cf_forwardSubAgentWebSocketClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<boolean> {
    return this._dynamicAgents.forwardWebSocketClose(
      connection,
      code,
      reason,
      wasClean
    );
  }

  _cf_handleSubAgentWebSocketConnect(
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void> {
    return this._dynamicAgents.handleWebSocketConnect(bridge, meta);
  }

  _cf_handleSubAgentWebSocketMessage(
    message: WSMessage,
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta,
    replyBridge: SubAgentConnectionBridge = bridge
  ): Promise<void> {
    return this._dynamicAgents.handleWebSocketMessage(
      message,
      bridge,
      meta,
      replyBridge
    );
  }

  _cf_handleSubAgentWebSocketClose(
    code: number,
    reason: string,
    wasClean: boolean,
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void> {
    return this._dynamicAgents.handleWebSocketClose(
      code,
      reason,
      wasClean,
      bridge,
      meta
    );
  }

  protected _cf_hydrateSubAgentConnectionsFromRoot(): Promise<void> {
    return this._dynamicAgents.hydrateConnectionsFromRoot();
  }

  /**
   * Parent-side middleware hook. Fires before a request is
   * forwarded into a facet sub-agent. Mirrors `onBeforeConnect` /
   * `onBeforeRequest`.
   *
   *   - return `void` (default) → forward the original request
   *   - return `Request`        → forward this (modified) request
   *   - return `Response`       → return this response to the
   *                               client; do not wake the child
   *
   * Default implementation: return void (permissive).
   *
   * The hook receives the **original** request with its URL intact —
   * including the `/sub/{class}/{name}` segment. The routing
   * decision for which facet to wake is fixed at parse time, so if
   * you return a modified `Request`, its headers, body, method, and
   * query string flow through to the child, but the **pathname**
   * the child sees is always the tail after `/sub/{class}/{name}`.
   * Customize via headers/body rather than URL-rewriting.
   *
   * WebSocket upgrade requests flow through this hook the same way as
   * plain HTTP. If you return a mutated `Request`, make sure it still
   * carries the original `Upgrade: websocket` and `Sec-WebSocket-*`
   * headers — the simplest safe recipe is to clone the incoming
   * request's headers (via `new Headers(req.headers)`) and only add
   * or replace entries, rather than constructing a fresh `Headers`
   * object from scratch.
   *
   * @experimental The API surface may change before stabilizing.
   *
   * @example
   * ```ts
   * class Inbox extends Agent {
   *   override async onBeforeSubAgent(req, { className, name }) {
   *     // Strict registry gate
   *     if (!this.dynamicAgents.has(className, name)) {
   *       return new Response("Not found", { status: 404 });
   *     }
   *   }
   * }
   * ```
   */
  async onBeforeSubAgent(
    // oxlint-disable-next-line eslint(no-unused-vars) -- subclass override
    _request: Request,
    // oxlint-disable-next-line eslint(no-unused-vars) -- subclass override
    _child: { className: string; name: string }
  ): Promise<Request | Response | void> {
    return undefined;
  }

  /**
   * Resolve the facet Fetcher for the match and forward the
   * request to it with `/sub/{class}/{name}` stripped.
   *
   * @internal
   */
  private _cf_forwardToFacet(
    req: Request,
    match: {
      childClass: string;
      childName: string;
      remainingPath: string;
    }
  ): Promise<Response> {
    return this._dynamicAgents.forward(req, match);
  }

  /**
   * Bridge method used by `getSubAgentByName`. Resolves the facet
   * on each call (idempotent via `subAgent`) and dispatches one
   * RPC method. Stateless — no cached references.
   *
   * @internal
   */
  _cf_invokeSubAgent(
    className: string,
    name: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    return this._dynamicAgents.invoke(className, name, method, args);
  }

  /**
   * Bridge method used by `parentAgent()` when the requested parent is
   * itself a facet (and therefore has no top-level env namespace).
   * The root receives the full root-first target path, then each hop
   * delegates to the next facet using that facet's own `ctx.facets`.
   *
   * @internal
   */
  _cf_invokeSubAgentPath(
    path: ReadonlyArray<{ className: string; name: string }>,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    return this._dynamicAgents.invokePath(path, method, args);
  }

  // ── Sub-agent (facet) management ────────────────────────────────────────

  /**
   * Initialize this agent as a facet in a single RPC.
   *
   * Runs entirely inside the child's isolate, so every storage write
   * and `onStart()` I/O is owned by the child DO. This replaces the
   * previous "construct a Request in the parent DO and `stub.fetch()`
   * it on the child" handshake, whose native I/O was tied to the
   * parent and triggered "Cannot perform I/O on behalf of a different
   * Durable Object" on the child.
   *
   * We set `_isFacet` eagerly (before `__unsafe_ensureInitialized`
   * runs `onStart()`) so any code that legitimately branches on it
   * — e.g. skipping parent-owned alarms in schedule guards — sees
   * the flag during the first `onStart()` run. Protocol broadcasts are
   * suppressed only during this bootstrap window; afterward, facets can
   * broadcast to their own WebSocket clients reached via sub-agent
   * routing.
   *
   * The facet's logical name is persisted separately from its routing id.
   * Legacy facets used the logical name directly as `ctx.id.name`; newer
   * facets can use path-scoped routing ids while preserving `this.name`.
   *
   * @internal Called by {@link subAgent}.
   */
  _cf_initAsFacet(
    name: string,
    parentPath: ReadonlyArray<{ className: string; name: string }> = [],
    identityName = name,
    rootChannel?: RootFacetRpcSurface,
    rootJurisdiction?: string
  ): Promise<void> {
    return this._dynamicAgents.init(
      name,
      parentPath,
      identityName,
      rootChannel,
      rootJurisdiction
    );
  }

  get name(): string {
    const routedName = this.lifecycle.name;
    return (
      this._facetName ?? logicalNameFromPathV2Identity(routedName) ?? routedName
    );
  }

  /**
   * Ancestor chain for this agent, root-first. Empty for top-level
   * DOs. Populated at facet init time; survives hibernation.
   *
   * @example
   * ```ts
   * class Chat extends Agent {
   *   onStart() {
   *     console.log("chat started under:", this.parentPath);
   *     // → [{ className: "Tenant", name: "acme" }, { className: "Inbox", name: "alice" }]
   *   }
   * }
   * ```
   *
   * @experimental The API surface may change before stabilizing.
   */
  get parentPath(): ReadonlyArray<AgentPathStep> {
    return this._parentPath;
  }

  /**
   * Ancestor chain + self, root-first. Convenient for logging.
   *
   * @experimental The API surface may change before stabilizing.
   */
  get selfPath(): ReadonlyArray<AgentPathStep> {
    return [
      ...this._parentPath,
      {
        className: (this.constructor as { name: string }).name,
        name: this.name
      }
    ];
  }

  /**
   * Resolve a typed parent stub for this facet's **immediate** parent
   * agent.
   *
   * Symmetric with `subAgent(Cls, name)`: while `subAgent` opens a
   * stub from parent to child, `parentAgent` opens one from child
   * to parent. Pass the direct parent's class reference — the
   * framework verifies it matches the last entry of
   * `this.parentPath` at runtime. If the parent is a top-level
   * Durable Object, the framework returns the normal namespace stub.
   * If the parent is itself a facet, the framework returns a bridge
   * proxy that routes method calls through the root/supervisor and
   * then down the recorded facet path.
   *
   * `this.parentPath` is root-first, so the direct parent is the
   * **last** entry: `this.parentPath.at(-1)`. For grandparents and
   * further ancestors, iterate `this.parentPath` and use
   * `getAgentByName(env.X, this.parentPath[i].name)` directly.
   *
   * For top-level parents, the framework first checks `env[Cls.name]`,
   * then falls back to the Worker `exports` object. This supports
   * custom binding names as long as the parent class is exported under
   * its class name.
   *
   * Facet-parent stubs route normal HTTP `.fetch()` calls through the
   * same root bridge as RPC methods. WebSocket upgrade requests are
   * not supported yet because WebSocket handles cannot be serialized
   * over RPC.
   *
   * @experimental The API surface may change before stabilizing.
   *
   * @throws If this agent is not a facet (no parent).
   * @throws If `Cls.name` doesn't match the recorded direct-parent
   *         class (guards against accidentally reaching the wrong
   *         DO, especially in nested Root → Mid → Leaf chains).
   * @throws If no namespace is found for a top-level parent, or no
   *         root namespace is available for a facet parent bridge.
   *
   * @example
   * ```ts
   * class Chat extends AIChatAgent<Env> {
   *   async onChatMessage(...) {
   *     const inbox = await this.parentAgent(Inbox);
   *     const memory = await inbox.getSharedMemory("facts");
   *     // ...
   *   }
   * }
   * ```
   */
  async parentAgent<T extends Agent>(
    cls: SubAgentClass<T>
  ): Promise<DurableObjectStub<T>> {
    // `_parentPath` is root-first, so the *direct* parent is the
    // last entry. Destructuring with `[parent] = ...` would grab the
    // root ancestor instead — wrong for any chain deeper than one
    // level and silently routes to the wrong DO if the root and the
    // direct parent happen to be the same class.
    const parent = this._parentPath[this._parentPath.length - 1];
    if (!parent) {
      throw new Error(
        `parentAgent(): ${this.constructor.name} is not a facet — ` +
          `only sub-agents (spawned via \`subAgent()\`) have a parent.`
      );
    }
    if (cls.name !== parent.className) {
      throw new Error(
        `parentAgent(${cls.name}): this facet's recorded parent class ` +
          `is "${parent.className}", not "${cls.name}". Pass the class ` +
          `whose constructor actually spawned this facet.`
      );
    }
    if (this._parentPath.length > 1) {
      return await this._cf_parentAgentFacetProxy<T>(
        cls.name,
        this._parentPath
      );
    }

    const binding = this._cf_getTopLevelNamespaceByClassName<T>(cls.name);
    if (!binding) {
      throw new Error(
        `parentAgent(${cls.name}): no top-level namespace for "${cls.name}" ` +
          `was found in env or worker exports. Make sure the parent class is ` +
          `exported under that class name and registered as a Durable Object binding.`
      );
    }
    return await getAgentByName<Cloudflare.Env, T>(
      binding,
      parent.name,
      this._cf_rootJurisdictionOptions()
    );
  }

  /**
   * The root's jurisdiction, for a lookup of the root (#2470).
   *
   * @internal Also read by Think's extension host bridge.
   */
  _cf_rootJurisdictionOptions():
    | { jurisdiction: DurableObjectJurisdiction }
    | undefined {
    const jurisdiction = this._dynamicAgents.rootJurisdiction;
    return jurisdiction
      ? { jurisdiction: jurisdiction as DurableObjectJurisdiction }
      : undefined;
  }

  private _cf_getTopLevelNamespaceByClassName<T extends Agent>(
    className: string
  ): DurableObjectNamespace<T> | undefined {
    // Prefer explicit env bindings; fall back to worker exports so
    // custom binding names still work when the class is exported under
    // its constructor name.
    return (
      this._cf_asDurableObjectNamespace<T>(
        (this.env as Record<string, unknown>)[className]
      ) ??
      this._cf_asDurableObjectNamespace<T>(
        (workerExports as Record<string, unknown>)[className]
      )
    );
  }

  private _cf_asDurableObjectNamespace<T extends Agent>(
    candidate: unknown
  ): DurableObjectNamespace<T> | undefined {
    const binding = candidate as DurableObjectNamespace<T> | undefined;
    return binding?.idFromName ? binding : undefined;
  }

  private async _cf_parentAgentFacetProxy<T extends Agent>(
    className: string,
    parentPath: ReadonlyArray<{ className: string; name: string }>
  ): Promise<DurableObjectStub<T>> {
    const [root] = parentPath;
    if (!root) {
      throw new Error(`parentAgent(${className}): parent path is empty.`);
    }

    const rootBinding = this._cf_getTopLevelNamespaceByClassName<Agent>(
      root.className
    );
    if (!rootBinding) {
      throw new Error(
        `parentAgent(${className}): direct parent is a facet, but no ` +
          `top-level root namespace "${root.className}" was found in env ` +
          `or worker exports to bridge the call.`
      );
    }

    const rootStubPromise = getAgentByName<Cloudflare.Env, Agent>(
      rootBinding,
      root.name,
      this._cf_rootJurisdictionOptions()
    );
    const targetPath = parentPath.map((step) => ({ ...step }));
    const invokeBridge = async (method: string, args: unknown[]) => {
      const rootStub = await rootStubPromise;
      const bridge = rootStub as unknown as SubAgentPathInvokeEndpoint;
      return await bridge._cf_invokeSubAgentPath(targetPath, method, args);
    };
    const owner = this;
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (isInternalJsStubProp(prop)) return undefined;
          if (typeof prop !== "string") return undefined;
          if (prop === "fetch") {
            return async (input: RequestInfo | URL, init?: RequestInit) => {
              if (owner._cf_isWebSocketUpgradeRequest(input, init)) {
                throw new Error(
                  `parentAgent(${className}).fetch() does not support WebSocket upgrade requests yet. ` +
                    `Use externally routed sub-agent URLs for WebSocket connections.`
                );
              }

              return await invokeBridge(prop, [input, init]);
            };
          }
          return async (...args: unknown[]) => {
            return await invokeBridge(prop, args);
          };
        }
      }
    ) as DurableObjectStub<T>;
  }

  private _cf_isWebSocketUpgradeRequest(
    input: RequestInfo | URL,
    init?: RequestInit
  ): boolean {
    const initHeaders = init?.headers ? new Headers(init.headers) : undefined;
    const requestHeaders =
      input instanceof Request ? new Headers(input.headers) : undefined;
    return (
      initHeaders?.get("Upgrade")?.toLowerCase() === "websocket" ||
      requestHeaders?.get("Upgrade")?.toLowerCase() === "websocket"
    );
  }

  /**
   * Get or create a named sub-agent — a child Durable Object (facet)
   * with its own isolated SQLite storage running on the same machine.
   *
   * The child class must extend `Agent` and be exported from the worker
   * entry point. The first call for a given name triggers the child's
   * `onStart()`. Subsequent calls return the existing instance.
   *
   * @experimental The API surface may change before stabilizing.
   *
   * @param cls The Agent subclass (must be exported from the worker)
   * @param name Unique name for this child instance
   * @returns A typed RPC stub for calling methods on the child
   *
   * @example
   * ```typescript
   * const searcher = await this.subAgent(SearchAgent, "main-search");
   * const results = await searcher.search("cloudflare agents");
   * ```
   *
   * @deprecated Use {@link Agent.dynamicAgents | this.dynamicAgents.get()} instead.
   */
  async subAgent<T extends Agent>(
    cls: SubAgentClass<T>,
    name: string
  ): Promise<SubAgentStub<T>> {
    return this.dynamicAgents.get(cls, name);
  }

  /** Maximum number of non-terminal agent-tool runs this parent may own at once. */
  maxConcurrentAgentTools = Infinity;

  async onAgentToolStart(_run: AgentToolRunInfo): Promise<void> {}

  async onAgentToolFinish(
    _run: AgentToolRunInfo,
    _result: AgentToolLifecycleResult
  ): Promise<void> {}

  /**
   * Parent hook fired (best-effort) whenever a child agent-tool run emits a
   * `reportProgress` signal that is forwarded through this parent's tail. Use it
   * to meter / steer / surface progress server-side. Fires for both awaited and
   * detached runs; it is NOT durable — after eviction a detached run's latest
   * snapshot is read from `inspectAgentToolRun().progress` on reconcile instead.
   */
  async onProgress(
    _run: AgentToolRunInfo,
    _progress: AgentToolProgressSnapshot
  ): Promise<void> {}

  /**
   * Emit an ephemeral progress signal from a sub-agent that is currently running
   * as an agent tool. Rides the child's active turn stream as a transient
   * `data-agent-progress` part (re-broadcast to the parent's clients + surfaced
   * in `useAgentToolEvents`) and persists a latest-wins snapshot for recovery /
   * inspection. A no-op (with a dev warning) on the base `Agent`, which has no
   * streaming turn — overridden by chat hosts (`@cloudflare/think`,
   * `AIChatAgent`). See `design/rfc-detached-agent-tools.md`.
   */
  async reportProgress<T = unknown>(
    _progress: AgentToolProgress<T>,
    _options?: { persist?: boolean }
  ): Promise<void> {
    console.warn(
      "[agents] reportProgress() is only supported on chat agents (@cloudflare/think, AIChatAgent) running as an agent tool; ignoring on base Agent."
    );
  }

  /**
   * Run a detached terminal delivery (the `onAgentToolFinish` + per-run
   * `onFinish` callbacks) in an appropriate execution context. The base `Agent`
   * has no turn queue, so it only establishes `agentContext` — a handler that
   * calls `runAgentTool` / `setState` therefore works regardless of where the
   * delivery fired from.
   *
   * Chat-layer subclasses (`@cloudflare/think`, `@cloudflare/ai-chat`) override
   * this to additionally serialize delivery against their turn queue when
   * `serialize` is set: a fast-path push or backbone tick can land mid-turn, and
   * a state-mutating `onFinish` running concurrently with an active LLM turn is a
   * data race. The fast path and backbone never run synchronously inside a turn
   * (they fire from `waitUntil` / a scheduled alarm), so enqueuing them on the
   * turn queue is deadlock-free. An explicit `cancelAgentTool` runs with
   * `serialize` unset because it may be called from inside the very turn that
   * triggers it, where enqueuing would self-deadlock.
   */
  protected async _runDetachedDelivery(
    invoke: () => Promise<void>,
    _options?: { serialize?: boolean }
  ): Promise<void> {
    if (agentContext.getStore()?.agent) {
      await invoke();
      return;
    }
    await runInInvocation(
      {
        agent: this,
        connection: undefined,
        request: undefined,
        email: undefined
      },
      invoke,
      { detached: true }
    );
  }

  /**
   * Hook invoked by `_forwardAgentToolStream` after a child produces output that
   * was forwarded to the parent's connections. Forwarding a sub-agent's stream
   * is genuine forward progress for the *parent* turn (the parent is
   * orchestrating the child), so chat-recovery subclasses (Think / AIChatAgent)
   * override this to advance their recovery progress marker.
   *
   * Without it, a parent whose turn merely `await`s a sub-agent banks zero
   * progress of its own, so under deploy churn the parent's no-progress recovery
   * window exhausts and abandons the turn as `interrupted` — even though the
   * child is healthily streaming and ultimately completes (observed in the
   * `deploy-churn --mode subagent` harness: `attempt 6/6, stable_timeout,
   * progress: 1`).
   *
   * Called ONLY after at least one chunk was actually forwarded — never merely
   * because a child is attached — so a silent / hung child still lets the parent
   * exhaust on its own timer. The base Agent has no recovery budget, so this is
   * a no-op; subclasses should throttle the (durable) bump since this can be
   * called repeatedly while a child streams.
   */
  protected async _onAgentToolStreamProgress(): Promise<void> {}

  /**
   * Overridable seam for the `detached: { onMilestones }` convenience. The base
   * `Agent` has no chat surface, so this is a no-op; chat hosts
   * (`@cloudflare/think`, `AIChatAgent`) override it to submit an idempotent
   * synthetic message keyed on `(runId, milestone.name)`. Called from both the
   * warm tail and the backbone reconcile, so it MUST be idempotent.
   */
  protected async _deliverDetachedMilestone(
    _run: AgentToolRunInfo,
    _milestone: AgentToolMilestone,
    _mode: "react" | "narrate"
  ): Promise<void> {}

  async runAgentTool<Input = unknown>(
    cls: ChatCapableAgentClass,
    options: RunAgentToolOptions<Input> & {
      detached: true | DetachedAgentToolConfig;
    }
  ): Promise<DetachedRunAgentToolResult>;
  async runAgentTool<Input = unknown, Output = unknown>(
    cls: ChatCapableAgentClass,
    options: RunAgentToolOptions<Input>
  ): Promise<RunAgentToolResult<Output>>;
  async runAgentTool<Input = unknown, Output = unknown>(
    cls: ChatCapableAgentClass,
    options: RunAgentToolOptions<Input>
  ): Promise<RunAgentToolResult<Output> | DetachedRunAgentToolResult> {
    return this._agentTools.runAgentTool<Input, Output>(cls, options);
  }

  /**
   * Cancel an agent-tool run by id. Idempotent: cancelling an already-terminal
   * run is a no-op. Detached runs deliver through the guarded ledger so a wired
   * `onFinish` fires once with `status: "aborted"`; awaited runs leave terminal
   * observation to the awaiting/recovery path, avoiding duplicate finish hooks.
   */
  async cancelAgentTool(runId: string, reason?: unknown): Promise<void> {
    return this._agentTools.cancelAgentTool(runId, reason);
  }

  hasAgentToolRun<T extends Agent>(
    cls: SubAgentClass<T>,
    runId: string
  ): boolean;
  hasAgentToolRun(agentType: string, runId: string): boolean;
  hasAgentToolRun(classOrName: SubAgentClass | string, runId: string): boolean {
    return this._agentTools.hasAgentToolRun(classOrName, runId);
  }

  async clearAgentToolRuns(options?: {
    olderThan?: number;
    status?: AgentToolRunStatus[];
  }): Promise<void> {
    return this._agentTools.clearAgentToolRuns(options);
  }

  /**
   * Shared facet resolution — takes a CamelCase class name string
   * (matching `ctx.exports`) rather than a class reference. Both
   * `subAgent(cls, name)` and `_cf_invokeSubAgent(className, ...)`
   * funnel through here so registry bookkeeping and the
   * `_cf_initAsFacet` handshake are consistent.
   *
   * @internal
   */
  private _cf_resolveSubAgent(
    className: string,
    name: string
  ): Promise<unknown> {
    return this._dynamicAgents.resolve(className, name);
  }

  /**
   * Run `body` in a fresh invocation scope with no native request/
   * connection context attached, so a child-facet RPC never sees
   * parent-owned I/O handles.
   * @internal
   */
  private _runFacetInitInvocation<T>(body: () => Promise<T>): Promise<T> {
    return runInInvocation(
      {
        agent: this,
        connection: undefined,
        request: undefined,
        email: undefined
      },
      body
    );
  }

  /**
   * Forcefully abort a running sub-agent. The child stops executing
   * immediately and will be restarted on next {@link subAgent} call.
   * Pending RPC calls receive the reason as an error.
   * Transitively aborts the child's own children.
   *
   * @experimental The API surface may change before stabilizing.
   *
   * @param cls The Agent subclass used when creating the child
   * @param name Name of the child to abort
   * @param reason Error thrown to pending/future RPC callers
   *
   * @deprecated Use {@link Agent.dynamicAgents | this.dynamicAgents.abort()} instead.
   */
  abortSubAgent(cls: SubAgentClass, name: string, reason?: unknown): void {
    this.dynamicAgents.abort(cls, name, reason);
  }

  /**
   * Delete a sub-agent: abort it if running, then permanently wipe its
   * storage. Transitively deletes the child's own children.
   *
   * @experimental The API surface may change before stabilizing.
   *
   * @param cls The Agent subclass used when creating the child
   * @param name Name of the child to delete
   *
   * @deprecated Use {@link Agent.dynamicAgents | this.dynamicAgents.delete()} instead.
   */
  deleteSubAgent(cls: SubAgentClass, name: string): Promise<void> {
    return this.dynamicAgents.delete(cls, name);
  }

  // ── Sub-agent registry (backs `hasSubAgent` / `listSubAgents`) ──────────

  /**
   * Whether this agent has previously spawned (and not deleted) a
   * sub-agent of the given class and name. Backed by an
   * auto-maintained SQLite registry in the parent's storage.
   *
   * Intended for strict-registry access patterns in
   * `onBeforeSubAgent` or similar gating logic.
   *
   * @experimental The API surface may change before stabilizing.
   *
   * @example
   * ```ts
   * async onBeforeSubAgent(req, { className, name }) {
   *   if (!this.hasSubAgent(className, name)) {
   *     return new Response("Not found", { status: 404 });
   *   }
   * }
   * ```
   *
   * @deprecated Use {@link Agent.dynamicAgents | this.dynamicAgents.has()} instead.
   */
  hasSubAgent<T extends Agent>(cls: SubAgentClass<T>, name: string): boolean;
  hasSubAgent(className: string, name: string): boolean;
  hasSubAgent(classOrName: SubAgentClass | string, name: string): boolean {
    return typeof classOrName === "string"
      ? this.dynamicAgents.has(classOrName, name)
      : this.dynamicAgents.has(classOrName, name);
  }

  /**
   * List known sub-agents, optionally filtered by class. Reflects
   * the registry rows written by {@link subAgent} and removed by
   * {@link deleteSubAgent}.
   *
   * @experimental The API surface may change before stabilizing.
   *
   * @deprecated Use {@link Agent.dynamicAgents | this.dynamicAgents.list()} instead.
   */
  listSubAgents<T extends Agent>(
    cls: SubAgentClass<T>
  ): Array<{ className: string; name: string; createdAt: number }>;
  listSubAgents(
    className?: string
  ): Array<{ className: string; name: string; createdAt: number }>;
  listSubAgents(
    classOrName?: SubAgentClass | string
  ): Array<{ className: string; name: string; createdAt: number }> {
    if (typeof classOrName === "string" || classOrName === undefined) {
      return this.dynamicAgents.list(classOrName);
    }
    return this.dynamicAgents.list(classOrName);
  }

  /**
   * Destroy the Agent, removing all state and scheduled tasks.
   *
   * On a top-level agent: drops every table, clears the alarm, and
   * aborts the isolate.
   *
   * On a sub-agent (facet): delegates teardown to the immediate
   * parent so the parent-owned schedule rows for this sub-agent
   * (and any of its descendants) are cancelled, the parent's
   * `cf_agents_sub_agents` registry entry is cleared, and
   * `ctx.facets.delete` wipes the facet's own storage. The
   * `ctx.facets.delete` call aborts this isolate, so this method
   * may not return cleanly when invoked from inside the facet —
   * callers should treat it as fire-and-forget.
   */
  async destroy() {
    if (this._isFacet) {
      this._emit("destroy");
      const root = this._dynamicAgents.rootStub();
      // The chain: root → … → direct-parent runs ctx.facets.delete
      // on this facet, which aborts this isolate. The await may
      // throw an abort error or never resolve depending on timing —
      // either is acceptable, the cleanup has already been applied.
      await root._cf_destroyDescendantFacet(this.selfPath);
      return;
    }

    // Record the teardown FIRST, so one cut short (#1625) is finished by the
    // next alarm; `deleteAll()` below removes the record.
    await this._deferredDestroy.begin();
    await this.lifecycle.disableAlarms();

    await this.lifecycle.dispose();
    this._disposables.dispose();
    await this.ctx.storage.deleteAll();

    this._destroyed = true;

    // `ctx.abort` throws an uncatchable error, so we yield to the event loop
    // to avoid capturing it and let handlers finish cleaning up. When this
    // destroy landed via the alarm preamble, suppressing the alarm retry
    // stops the platform re-running the alarm on a fresh instance whose
    // constructor would recreate the just-deleted schema.
    //
    // Inside an alarm the abort waits until shortly after the alarm handler
    // returns (#2605): see ABORT_AFTER_ALARM_MS.
    if (this._alarmDepth > 0) {
      this._abortAfterAlarm = "destroyed";
    } else {
      setTimeout(() => {
        abortWithoutAlarmRetry(this.ctx, "destroyed");
      }, 0);
    }

    this._emit("destroy");
  }

  /**
   * @internal Defer this agent's destruction to its own alarm invocation
   * instead of running it inline (#1625).
   *
   * `destroy()` is a multi-step I/O sequence (drop tables, delete alarm,
   * delete all storage, dispose connections). Running it on the `waitUntil`
   * of a request whose client has already disconnected — the MCP
   * Streamable-HTTP session-DELETE path — gives it little to no
   * post-invocation grace, so the runtime routinely cancels it mid-flight.
   * This method instead performs two fast storage writes (a durable
   * "condemned" marker and an immediate alarm) that the caller can await
   * before responding; the alarm then fires as a fresh invocation with its
   * own full execution budget and runs `destroy()` there. If even that
   * invocation is interrupted, the marker survives and the next wake
   * finishes teardown — see the `alarm()` preamble.
   *
   * Unlike `destroy()`, this method does not abort the isolate, so RPC
   * callers don't need to swallow an abort error.
   */
  async _cf_scheduleDestroy(): Promise<void> {
    // Hydrate facet state before deciding. `_isFacet` (and the `_parentPath`
    // /`selfPath` the facet teardown path needs) is only populated by `onStart`
    // /facet bootstrap, and `destroy()` below branches on the in-memory
    // `_isFacet`. Without this, an RPC landing before init would see it as
    // `false`, fall through to `destroy()`'s top-level path, and write the
    // destroy marker on a facet — which the `alarm()` preamble
    // guards forbid (only top-level agents write it; facet teardown is
    // root-coordinated via `ctx.facets.delete`). Mirrors the other internal
    // RPC entrypoints (`_workflow_*`). We must NOT push this into `destroy()`
    // itself: the `alarm()` preamble calls `destroy()` precisely to avoid
    // running `onStart` on a condemned agent.
    await this.__unsafe_ensureInitialized();
    if (this._isFacet) {
      // Facet teardown is coordinated by the root (`ctx.facets.delete` wipes
      // the facet's storage in one step), so there is nothing to defer.
      await this.destroy();
      return;
    }
    await this._deferredDestroy.schedule();
  }

  /**
   * Get all methods marked as callable on this Agent
   * @returns A map of method names to their metadata
   */
  getCallableMethods(): Map<string, CallableMetadata> {
    return new Map(decoratedMethods(this));
  }

  // ==========================================
  // Workflows (the `Workflows` capability, ./workflow-tracking)
  // ==========================================

  /**
   * Start a workflow instance and track it in this Agent's database.
   * Callbacks (`this.agent` RPC, progress, completion, errors, state
   * updates) route back to this Agent, or this sub-agent, by name. Pass
   * `agentBinding` when the binding name does not match the class name; on
   * a sub-agent it is the root Agent's binding.
   *
   * @returns The workflow instance ID
   */
  runWorkflow<P = unknown>(
    workflowName: WorkflowName<Env>,
    params: P,
    options?: RunWorkflowOptions
  ): Promise<string> {
    return this._workflows.run(workflowName, params, options);
  }

  /** Send an event a running workflow waits for with `step.waitForEvent()`. */
  sendWorkflowEvent(
    workflowName: WorkflowName<Env>,
    workflowId: string,
    event: WorkflowEventPayload
  ): Promise<void> {
    return this._workflows.sendEvent(workflowName, workflowId, event);
  }

  /** Approve a tracked workflow waiting in `waitForApproval()`. */
  approveWorkflow(
    workflowId: string,
    data?: { reason?: string; metadata?: Record<string, unknown> }
  ): Promise<void> {
    return this._workflows.approve(workflowId, data);
  }

  /** Reject a tracked workflow waiting in `waitForApproval()`; it throws there. */
  rejectWorkflow(
    workflowId: string,
    data?: { reason?: string }
  ): Promise<void> {
    return this._workflows.reject(workflowId, data);
  }

  /** Stop a tracked workflow now; its status becomes `terminated`. */
  terminateWorkflow(workflowId: string): Promise<void> {
    return this._workflows.terminate(workflowId);
  }

  /** Pause a tracked running workflow. */
  pauseWorkflow(workflowId: string): Promise<void> {
    return this._workflows.pause(workflowId);
  }

  /** Resume a tracked paused workflow. */
  resumeWorkflow(workflowId: string): Promise<void> {
    return this._workflows.resume(workflowId);
  }

  /**
   * Re-run a tracked workflow from the start with the same ID.
   * `resetTracking` (default true) resets its record's timestamps and error.
   */
  restartWorkflow(
    workflowId: string,
    options: { resetTracking?: boolean } = {}
  ): Promise<void> {
    return this._workflows.restart(workflowId, options);
  }

  /** Read a workflow's status from the service and update its record. */
  getWorkflowStatus(
    workflowName: WorkflowName<Env>,
    workflowId: string
  ): Promise<InstanceStatus> {
    return this._workflows.status(workflowName, workflowId);
  }

  /** A tracked workflow's record, or undefined. */
  getWorkflow(workflowId: string): WorkflowInfo | undefined {
    return this._workflows.get(workflowId);
  }

  /** Query tracked workflows, with a cursor for the next page. */
  getWorkflows(criteria: WorkflowQueryCriteria = {}): WorkflowPage {
    return this._workflows.list(criteria);
  }

  /** Delete a workflow's record. False when there was none. */
  deleteWorkflow(workflowId: string): boolean {
    return this._workflows.delete(workflowId);
  }

  /** Delete the workflow records matching the criteria; returns how many. */
  deleteWorkflows(
    criteria: Omit<WorkflowQueryCriteria, "limit" | "orderBy"> & {
      createdBefore?: Date;
    } = {}
  ): number {
    return this._workflows.deleteMany(criteria);
  }

  /**
   * Point workflow records at a renamed binding, for example from
   * `onStart()` after renaming it in the Wrangler config.
   */
  migrateWorkflowBinding(oldName: string, newName: string): number {
    return this._workflows.migrateBinding(oldName, newName);
  }

  // ==========================================
  // Workflow Lifecycle Callbacks
  // ==========================================

  /**
   * Handle a callback from a workflow.
   * Invoked via the internal `_workflow_handleCallback` RPC whenever an
   * {@link AgentWorkflow} reports progress, completion, an error, or a custom
   * event back to its originating Agent (or sub-agent facet).
   * Override this to handle all callback types in one place.
   *
   * @param callback - The callback payload
   */
  async onWorkflowCallback(callback: WorkflowCallback): Promise<void> {
    this._workflows.record(callback);
    switch (callback.type) {
      case "progress":
        return this.onWorkflowProgress(
          callback.workflowName,
          callback.workflowId,
          callback.progress
        );
      case "complete":
        return this.onWorkflowComplete(
          callback.workflowName,
          callback.workflowId,
          callback.result
        );
      case "error":
        return this.onWorkflowError(
          callback.workflowName,
          callback.workflowId,
          callback.error
        );
      case "event":
        return this.onWorkflowEvent(
          callback.workflowName,
          callback.workflowId,
          callback.event
        );
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
    // oxlint-disable-next-line no-unused-vars
    workflowName: string,
    // oxlint-disable-next-line no-unused-vars
    workflowId: string,
    // oxlint-disable-next-line no-unused-vars
    progress: unknown
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
    // oxlint-disable-next-line no-unused-vars
    workflowName: string,
    // oxlint-disable-next-line no-unused-vars
    workflowId: string,
    // oxlint-disable-next-line no-unused-vars
    result?: unknown
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
    workflowName: string,
    workflowId: string,
    error: string
  ): Promise<void> {
    console.error(
      `Workflow error [${workflowName}/${workflowId}]: ${error}\n` +
        "Override onWorkflowError() in your Agent to handle workflow errors."
    );
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
    // oxlint-disable-next-line no-unused-vars
    workflowName: string,
    // oxlint-disable-next-line no-unused-vars
    workflowId: string,
    // oxlint-disable-next-line no-unused-vars
    event: unknown
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
    await this.__unsafe_ensureInitialized();
    await this.onWorkflowCallback(callback);
  }

  /**
   * Broadcast a message to all connected clients via RPC.
   * @internal - Called by AgentWorkflow, do not call directly
   */
  async _workflow_broadcast(message: unknown): Promise<void> {
    await this.__unsafe_ensureInitialized();
    this.broadcast(JSON.stringify(message));
  }

  /**
   * Update agent state via RPC.
   * @internal - Called by AgentWorkflow, do not call directly
   */
  async _workflow_updateState(
    action: "set" | "merge" | "reset",
    state?: unknown
  ): Promise<void> {
    await this.__unsafe_ensureInitialized();
    if (action === "set") {
      this.setState(state as TState);
    } else if (action === "merge") {
      const currentState = this.state ?? ({} as TState);
      this.setState({
        ...currentState,
        ...(state as Record<string, unknown>)
      } as TState);
    } else if (action === "reset") {
      this.setState(this.initialState);
    }
  }

  /**
   * Connect to a new MCP Server via RPC (Durable Object binding)
   *
   * The binding name and props are persisted to storage so the connection
   * is automatically restored after Durable Object hibernation.
   *
   * @example
   * await this.addMcpServer("counter", env.MY_MCP);
   * await this.addMcpServer("counter", env.MY_MCP, { props: { userId: "123" } });
   */
  async addMcpServer<T extends McpRpcAgent>(
    serverName: string,
    binding: DurableObjectNamespace<T>,
    options?: AddRpcMcpServerOptions
  ): Promise<{ id: string; state: typeof MCPConnectionState.READY }>;

  /**
   * Connect to a new MCP Server via HTTP (SSE or Streamable HTTP)
   *
   * @example
   * await this.addMcpServer("github", "https://mcp.github.com");
   * await this.addMcpServer("github", "https://mcp.github.com", { transport: { type: "sse" } });
   * await this.addMcpServer("github", url, callbackHost, agentsPrefix, options); // legacy
   */
  async addMcpServer(
    serverName: string,
    url: string,
    callbackHostOrOptions?: string | AddMcpServerOptions,
    agentsPrefix?: string,
    options?: Pick<AddMcpServerOptions, "client" | "transport">
  ): Promise<
    | {
        id: string;
        state: typeof MCPConnectionState.AUTHENTICATING;
        authUrl: string;
      }
    | { id: string; state: typeof MCPConnectionState.READY }
  >;

  async addMcpServer<T extends McpRpcAgent>(
    serverName: string,
    urlOrBinding: string | DurableObjectNamespace<T>,
    callbackHostOrOptions?:
      | string
      | AddMcpServerOptions
      | AddRpcMcpServerOptions,
    agentsPrefix?: string,
    options?: Pick<AddMcpServerOptions, "client" | "transport">
  ): Promise<AddMcpServerResult> {
    return addMcpServer(
      {
        manager: this.mcp,
        env: this.env,
        // Read only where it is used: a cold native call on an agent whose
        // stored name is not loaded yet can still register a server.
        agentName: () => this.name,
        agentClassName: this._ParentClass.name,
        sendIdentityOnConnect: this._resolvedOptions.sendIdentityOnConnect,
        createAuthProvider: (callbackUrl) =>
          this.createMcpOAuthProvider(callbackUrl)
      },
      serverName,
      urlOrBinding,
      callbackHostOrOptions,
      agentsPrefix,
      options
    );
  }

  /**
   * Try an MCP server again, for example from a "Reconnect" button: forgets
   * why it failed (unreachable, authorization refused, step-up limit
   * reached) and its pending link, then connects now with the quick
   * attempts. The only way to retry a failed server or get a new link;
   * `addMcpServer()` for a registered server reports its state as is.
   *
   * @returns The same result as `addMcpServer()`: `ready`, or
   * `authenticating` with a new `authUrl`. Throws when the attempt fails.
   */
  reconnectMcpServer(id: string): Promise<AddMcpServerResult> {
    return reconnectMcpServer(this.mcp, id);
  }

  async removeMcpServer(id: string) {
    await this.mcp.removeServer(id);
  }

  getMcpServers(): MCPServersState {
    return mcpServersState(this.mcp);
  }

  /**
   * Create the OAuth provider used when connecting to MCP servers that require authentication.
   *
   * Override this method in a subclass to supply a custom OAuth provider implementation,
   * for example to use pre-registered client credentials, mTLS-based authentication,
   * or any other OAuth flow beyond dynamic client registration.
   *
   * @example
   * // Custom OAuth provider
   * class MyAgent extends Agent {
   *   createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
   *     return new MyCustomOAuthProvider(
   *       this.ctx.storage,
   *       this.name,
   *       callbackUrl
   *     );
   *   }
   * }
   *
   * @param callbackUrl The OAuth callback URL for the authorization flow
   * @returns An {@link AgentMcpOAuthProvider} instance used by {@link addMcpServer}
   */
  createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
    return new DurableObjectOAuthClientProvider(
      this.ctx.storage,
      this.name,
      callbackUrl
    );
  }

  private broadcastMcpServers() {
    this._broadcastProtocol(
      JSON.stringify({
        mcp: this.getMcpServers(),
        type: MessageType.CF_AGENT_MCP_SERVERS
      })
    );
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

// Email routing - deprecated resolver kept in root for upgrade discoverability
// Other email utilities moved to agents/email subpath
export { createHeaderBasedEmailResolver } from "./email";

export { routeAgentEmail, type EmailRoutingOptions } from "./email-agent";
