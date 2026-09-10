import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Prompt,
  Resource,
  ServerCapabilities,
  SSEClientTransportOptions,
  Tool
} from "@modelcontextprotocol/client";
import {
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
  type AgentContextStore,
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
  isClosedWebSocketSendError,
  registerFacetStreamingDelivery,
  sendFacetRpcResponseIfOpen,
  sendFacetStreamingResponse,
  DynamicAgentConnectionBridge as SubAgentConnectionBridge,
  dynamicAgentRpcReplyContext as subAgentRpcReplyContext,
  waitForFacetStreamingResponseDeliveries
} from "./dynamic-agents/bridges";
import {
  CF_SUB_AGENT_OUTER_URL_KEY,
  CF_SUB_AGENT_TAGS_KEY,
  SUB_AGENT_OUTER_URL_HEADER
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
import { signAgentHeaders, type SendEmailOptions } from "./email";
import { sendAgentEmail } from "./email-send";
export type { EmailSendBinding, SendEmailOptions } from "./email";
import { nanoid } from "nanoid";
import { EmailMessage } from "cloudflare:email";
import {
  DurableObject,
  RpcTarget,
  exports as workerExports
} from "cloudflare:workers";
import {
  type LifecycleJobContext,
  type MemoryLimitContext,
  type Connection,
  type ConnectionContext,
  Lifecycle,
  type LifecycleJobOutcome,
  setLifecycleEventSink,
  setLifecycleHostInvoker,
  setLifecycleRouteTransport,
  type LifecycleRouteEnvelope,
  type WSMessage
} from "./lifecycle/durable-object-lifecycle";
import { abortWithoutAlarmRetry } from "./lifecycle/abort";
import type { LifecycleRouteAddress } from "./lifecycle/capability";
import {
  getCurrentAgent as getCurrentLifecycleAgent,
  type CurrentAgentContext
} from "./lifecycle/current-agent";
import { getAgentByName, type AgentOptions } from "./agent-routing";
import { callablesFromDecorated, WebSockets } from "./websockets";
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
import {
  type RetryOptions,
  tryN,
  isErrorRetryable,
  validateRetryOptions
} from "./retries";
export {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isDurableObjectStorageReset,
  isPlatformTransientError
} from "./retries";
import { MCPClientManager, normalizeServerId } from "./mcp/client";
import type {
  WorkflowCallback,
  WorkflowTrackingRow,
  WorkflowStatus,
  RunWorkflowOptions,
  WorkflowEventPayload,
  WorkflowInfo,
  WorkflowQueryCriteria,
  WorkflowPage,
  AgentWorkflowOrigin
} from "./workflow-types";
import { MCPConnectionState } from "./mcp/client/connection";
import {
  DurableObjectOAuthClientProvider,
  type AgentMcpOAuthProvider
} from "./mcp/client/do-oauth-client-provider";
import type { McpClientOptions, TransportType } from "./mcp/types";
import {
  genericObservability,
  type Observability,
  type ObservabilityEvent
} from "./observability";
import { agentSpanAttributes } from "./observability/agent-span-attributes";
import { tracer } from "./observability/tracing/cloudflare";
import {
  withInvocationScope,
  writeSpanAttributes,
  type InvocationScopeOptions,
  type TraceAttributes
} from "./observability/tracing/tracer";
import { DisposableStore } from "./core/events";
import { MessageType } from "./types";
import { RPC_DO_PREFIX } from "./mcp/rpc";
import { ensureMcpServerTable } from "./mcp/client/storage";
import type { McpAgent } from "./mcp";
import { Scheduler, setSchedulerCallbackResolver } from "./schedules/scheduler";
import { AgentTools } from "./agent-tools/agent-tools";
import { setAgentToolsHost } from "./agent-tools/host";
import {
  DEFAULT_AGENT_TOOL_REATTACH_MAX_WINDOW_MS,
  DEFAULT_AGENT_TOOL_REATTACH_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_DETACHED_MAX_BUDGET_MS,
  DEFAULT_DETACHED_NO_PROGRESS_BUDGET_MS
} from "./agent-tools/options";
export {
  AgentTools,
  AgentToolsChild,
  type AgentToolsChildHost,
  type ChildTurnOutcome,
  defaultDetachedCompletionText,
  defaultDetachedMilestoneText,
  getAgentToolsHost,
  setAgentToolsChildHost,
  setAgentToolsHost,
  type AgentToolsHost,
  type AgentToolsOptions
} from "./agent-tools/index";
import {
  Tasks,
  setTaskDefinitionResolver,
  setTaskRoutedMemoryLimitHandler
} from "./tasks/tasks";
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
 * Enters an agent invocation: the context every handler reads, plus the span
 * scope that stops invocation-bounded spans from outliving it. Scopes do not
 * nest, so the outermost live entry point owns the boundary — pass
 * `detached` for work that deliberately runs on past its caller.
 */
function runInInvocation<T>(
  store: AgentContextStore,
  body: () => T,
  options?: InvocationScopeOptions
): T {
  return agentContext.run(store, () => withInvocationScope(body, options));
}

function sendRpcResponseIfOpen(
  connection: Connection,
  response: RPCResponse
): boolean {
  try {
    connection.send(JSON.stringify(response));
    return true;
  } catch (error) {
    if (isClosedWebSocketSendError(error)) return false;
    throw error;
  }
}

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

export {
  callable,
  unstable_callable,
  type CallableMetadata
} from "./callable-decorator";
import {
  copyCallableMetadata,
  decoratedMethods,
  getCallableMetadata,
  isCallableMethod,
  type CallableMetadata
} from "./callable-decorator";

export { SqlError } from "./sql-error";

export type QueueItem<T = string> = {
  id: string;
  payload: T;
  callback: keyof Agent<Cloudflare.Env>;
  created_at: number;
  retry?: RetryOptions;
};

/**
 * Context passed to the `runFiber` callback. Provides checkpoint
 * and identity for durable execution.
 */
export type FiberContext = {
  /** Unique identifier for this fiber execution. */
  id: string;
  /** Cooperative cancellation signal for managed fiber callers. */
  signal: AbortSignal;
  /** Checkpoint data during execution. Synchronous SQLite write. */
  stash(data: unknown): void;
  /** Currently null during execution; recovered snapshots are passed to onFiberRecovered(). */
  snapshot: unknown | null;
};

export type FiberStatus =
  | "pending"
  | "running"
  | "completed"
  | "aborted"
  | "interrupted"
  | "error";

export type StartFiberOptions = {
  fiberId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  waitForCompletion?: boolean;
};

export type FiberInspection = {
  fiberId: string;
  name: string;
  idempotencyKey?: string;
  status: FiberStatus;
  snapshot?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  settledAt?: number;
};

export type StartFiberResult = FiberInspection & {
  accepted: boolean;
};

export type FiberRecoveryResult =
  | {
      status: "completed";
      snapshot?: unknown;
      metadata?: Record<string, unknown>;
    }
  | {
      status: "error";
      error?: unknown;
      snapshot?: unknown;
    }
  | {
      status: "aborted";
      reason?: string;
      snapshot?: unknown;
    }
  | {
      status: "interrupted";
      reason?: string;
      snapshot?: unknown;
    };

export type ListFibersOptions = {
  status?: FiberStatus | FiberStatus[];
  name?: string;
  limit?: number;
};

export type DeleteFibersOptions = {
  status?: FiberStatus | FiberStatus[];
  settledBefore?: Date;
  limit?: number;
};

type FiberLedgerRow = {
  fiber_id: string;
  idempotency_key: string | null;
  name: string;
  status: FiberStatus;
  snapshot: string | null;
  metadata_json: string | null;
  error_message: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
};

/**
 * Context passed to the `onFiberRecovered` hook when an interrupted
 * fiber is detected after DO restart.
 */
export type FiberRecoveryContext = {
  /** Fiber ID. */
  id: string;
  /** Name passed to `runFiber`. */
  name: string;
  /** Status for managed fibers recovered through the retained ledger. */
  status?: FiberStatus;
  /** Idempotency key for managed fibers, if one was supplied. */
  idempotencyKey?: string;
  /** Metadata for managed fibers, if one was supplied. */
  metadata?: Record<string, unknown> | null;
  /** Last checkpoint data from `stash()`, or null if never stashed. */
  snapshot: unknown | null;
  /**
   * Epoch milliseconds when the fiber row was inserted (when `runFiber`
   * started). Use `Date.now() - createdAt` to gate stale recoveries.
   */
  createdAt: number;
  /** Why this recovery hook is running. */
  recoveryReason: "interrupted";
  [key: string]: unknown;
};

const _fiberALS = new AsyncLocalStorage<{
  id: string;
  signal: AbortSignal;
  stash: (data: unknown) => void;
}>();

type InternalFiberOptions = {
  signal?: AbortSignal;
  managed?: boolean;
  initialSnapshot?: unknown;
  wrapStash?: (data: unknown) => unknown;
  beforeRunCleanup?: (
    outcome: { ok: true } | { ok: false; error: unknown }
  ) => void;
};

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
  /** May contain untrusted content from external OAuth providers. Escape appropriately for your output context. */
  error: string | null;
  instructions: string | null;
  capabilities: ServerCapabilities | null;
};

/**
 * Options for adding an MCP server
 */
export type AddMcpServerOptions = {
  /**
   * Optional caller-supplied stable server id. When provided, this id is used
   * for storage, restore, and tool-name namespacing instead of a generated
   * `nanoid`. The value is normalized via {@link normalizeServerId} — for
   * connector-style integrations this lets `addMcpServer` keep producing
   * keys like `tool_github_create_pull_request`.
   *
   * Throws if an existing server already uses the same (normalized) id but a
   * different name or url.
   */
  id?: string;
  /** OAuth callback host (auto-derived from request if omitted) */
  callbackHost?: string;
  /**
   * Custom callback URL path — bypasses the default `/agents/{class}/{name}/callback` construction.
   * Required when `sendIdentityOnConnect` is `false` to prevent leaking the instance name.
   * When set, the callback URL becomes `{callbackHost}/{callbackPath}`.
   * The developer must route this path to the agent instance via `getAgentByName`.
   * Should be a plain path (e.g., `/mcp-callback`) — do not include query strings or fragments.
   */
  callbackPath?: string;
  /** Agents routing prefix (default: "agents") */
  agentsPrefix?: string;
  /** MCP client options */
  client?: McpClientOptions;
  /** Transport options */
  transport?: {
    /** Custom headers for authentication (e.g., bearer tokens, CF Access) */
    headers?: HeadersInit;
    /** Transport type: "sse", "streamable-http", or "auto" (default) */
    type?: TransportType;
    /**
     * Compatibility escape hatch for a trusted legacy authorization server
     * whose RFC 8414 issuer does not match its metadata discovery URL.
     * Security-weakening; leave false unless the server is explicitly known.
     */
    skipIssuerMetadataValidation?: boolean;
  };
  /** Retry options for connection and reconnection attempts */
  retry?: RetryOptions;
};

/**
 * Options for adding an MCP server via RPC (Durable Object binding)
 */
export type AddRpcMcpServerOptions = {
  /**
   * Optional caller-supplied stable server id. When provided, this id is used
   * for storage, restore, and tool-name namespacing instead of a generated
   * `nanoid`. The value is normalized via {@link normalizeServerId}.
   *
   * Throws if an existing server already uses the same (normalized) id but a
   * different name or url.
   */
  id?: string;
  /** Props to pass to the McpAgent instance */
  props?: Record<string, unknown>;
};

const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 30_000;
// Durable marker that this agent is condemned: written before teardown begins
// (and by `_cf_scheduleDestroy`, which defers teardown to an alarm invocation
// with its own execution budget, #1625). The final `deleteAll()` in `destroy()`
// removes it, so "marker present" always means an unfinished teardown that the
// next wake must complete instead of resuming normal work.
//
// Scope: the marker is only consulted on alarm-driven paths (`alarm()` and
// `_syncHostJobs()`). It deliberately does NOT gate request entrypoints
// (`onRequest`/`onMessage`/RPC) — a request that lands between scheduling and
// the teardown alarm runs normally and `_ensureSchema()` recreates tables. For
// the MCP session-DELETE use case this is benign: the session id is unique and
// is never addressed again after DELETE, so no further request reaches a
// condemned session DO before its teardown alarm fires.
const DESTROY_PENDING_KEY = "cf_agents_destroy_pending";

// Stable ids for Agent-owned host jobs in the Lifecycle job queue.
const HOST_JOB_KEEP_ALIVE_ID = "cf:keep-alive";
const HOST_JOB_HOUSEKEEPING_ID = "cf:housekeeping";
const HOST_JOB_DESTROY_ID = "cf:destroy";
// Delay before the deferred-teardown alarm fires (#1625). `_cf_scheduleDestroy`
// is awaited by an HTTP handler (the MCP session-DELETE) that then returns its
// response. The teardown alarm runs `destroy()`, which ends in
// `ctx.abort("destroyed")` — and an immediate (`Date.now()`) alarm fires and
// aborts the isolate fast enough to race the still-in-flight RPC response,
// surfacing to the caller as a 500 instead of the intended 204 (observed
// against a real deployment; the local test runtime does not exhibit it). A
// small delay lets the response flush before the abort. Teardown latency of a
// second is irrelevant for an already-abandoned session.
const DESTROY_ALARM_DELAY_MS = 1_000;
// Ceiling for the exponential backoff applied to the runFiber-recovery
// follow-up alarm. A scan that makes NO forward progress (every pending orphan
// row's recovery hook threw) but still has work pending backs off so a poison
// fiber — or a `fiberRecoveryMaxAgeMs: 0` "retain forever" row whose hook keeps
// throwing — does not wake the DO every `keepAliveIntervalMs` indefinitely (the
// perpetual-heartbeat hazard #1707 guards against). A scan that DID make
// progress (recovered ≥1 row, including a scan-deadline yield that drained
// some) resets the backoff so legitimate multi-pass draining stays prompt.
const FIBER_RECOVERY_MAX_BACKOFF_MS = 5 * 60_000;
// Cap the doubling exponent so `base * 2 ** n` never overflows before the
// `FIBER_RECOVERY_MAX_BACKOFF_MS` clamp applies.
const FIBER_RECOVERY_BACKOFF_MAX_EXP = 20;

/**
 * Schema version for the Agent's internal SQLite tables.
 * Bump this when adding new tables, columns, or migrations.
 * The constructor stores this as a row in cf_agents_state and checks it
 * on wake to skip DDL on established DOs.
 */
const CURRENT_SCHEMA_VERSION = 11;

const SCHEMA_VERSION_ROW_ID = "cf_schema_version";
const STATE_ROW_ID = "cf_state_row_id";
// Legacy key — no longer written, but read for backward compatibility with
// DOs that were created before the single-row state optimization.
const STATE_WAS_CHANGED = "cf_state_was_changed";

const DEFAULT_STATE = {} as unknown;

/**
 * Internal key used to store the readonly flag in connection state.
 * Prefixed with _cf_ to avoid collision with user state keys.
 */
const CF_READONLY_KEY = "_cf_readonly";

/**
 * Internal key used to store the no-protocol flag in connection state.
 * When set, protocol messages (identity, state sync, MCP servers) are not
 * sent to this connection — neither on connect nor via broadcasts.
 */
const CF_NO_PROTOCOL_KEY = "_cf_no_protocol";

/**
 * Internal key used to store voice call state in connection state.
 * Used by the voice mixin to track whether a connection is in an active call.
 */
const CF_VOICE_IN_CALL_KEY = "_cf_voiceInCall";

/**
 * The set of all internal keys stored in connection state that must be
 * hidden from user code and preserved across setState calls.
 */
const CF_INTERNAL_KEYS: ReadonlySet<string> = new Set([
  CF_READONLY_KEY,
  CF_NO_PROTOCOL_KEY,
  CF_VOICE_IN_CALL_KEY,
  CF_SUB_AGENT_OUTER_URL_KEY,
  CF_SUB_AGENT_TAGS_KEY
]);

/** Check if a raw connection state object contains any internal keys. */
function rawHasInternalKeys(raw: Record<string, unknown>): boolean {
  for (const key of Object.keys(raw)) {
    if (CF_INTERNAL_KEYS.has(key)) return true;
  }
  return false;
}

/** Return a copy of `raw` with all internal keys removed, or null if no user keys remain. */
function stripInternalKeys(
  raw: Record<string, unknown>
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  let hasUserKeys = false;
  for (const key of Object.keys(raw)) {
    if (!CF_INTERNAL_KEYS.has(key)) {
      result[key] = raw[key];
      hasUserKeys = true;
    }
  }
  return hasUserKeys ? result : null;
}

/** Return a copy containing only the internal keys present in `raw`. */
function extractInternalFlags(
  raw: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (CF_INTERNAL_KEYS.has(key)) {
      result[key] = raw[key];
    }
  }
  return result;
}

/** Max length for error strings broadcast to clients. */
const MAX_ERROR_STRING_LENGTH = 500;

/**
 * Sanitize an error string before broadcasting to clients.
 * MCP error strings may contain untrusted content from external OAuth
 * providers — truncate and strip control characters to limit XSS risk.
 */
// Regex to match C0 control characters (except \t, \n, \r) and DEL.
const CONTROL_CHAR_RE = new RegExp(
  // oxlint-disable-next-line no-control-regex -- intentionally matching control chars for sanitization
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]",
  "g"
);

function sanitizeErrorString(error: string | null): string | null {
  if (error === null) return null;
  // Strip control characters (keep printable ASCII + common unicode)
  let sanitized = error.replace(CONTROL_CHAR_RE, "");
  if (sanitized.length > MAX_ERROR_STRING_LENGTH) {
    sanitized = sanitized.substring(0, MAX_ERROR_STRING_LENGTH) + "...";
  }
  return sanitized;
}

/**
 * Tracks which agent constructors have already emitted the onStateUpdate
 * deprecation warning, so it fires at most once per class.
 */
const _onStateUpdateWarnedClasses = new WeakSet<Function>();

/**
 * Tracks which agent constructors have already emitted the
 * sendIdentityOnConnect deprecation warning, so it fires at most once per class.
 */
const _sendIdentityWarnedClasses = new WeakSet<Function>();

/**
 * Default options for Agent configuration.
 * Child classes can override specific options without spreading.
 */
export const DEFAULT_AGENT_STATIC_OPTIONS = {
  /** Whether to send identity (name, agent) to clients on connect */
  sendIdentityOnConnect: true,
  /**
   * Timeout in seconds before a running interval schedule is considered "hung"
   * and force-reset. Increase this if you have callbacks that legitimately
   * take longer than 30 seconds.
   */
  hungScheduleTimeoutSeconds: 30,
  /**
   * Interval in milliseconds for keepAlive() alarm heartbeats.
   * Lower values mean faster recovery after eviction but more frequent alarms.
   */
  keepAliveIntervalMs: DEFAULT_KEEP_ALIVE_INTERVAL_MS,
  /** Default retry options for schedule(), queue(), and this.retry() */
  retry: {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 3000
  } satisfies Required<RetryOptions>,
  /** Timeout for internal framework fiber recovery hooks. */
  fiberRecoveryHookTimeoutMs: 10_000,
  /** Soft deadline for one interrupted-fiber recovery scan. */
  fiberRecoveryScanDeadlineMs: 10_000,
  /**
   * Maximum age of an unmanaged interrupted-fiber row before recovery gives
   * up. Bounds repeated retries of a `onFiberRecovered()` hook that keeps
   * throwing so a poison row cannot re-trigger forever across boots.
   */
  fiberRecoveryMaxAgeMs: 24 * 60 * 60 * 1000,
  /**
   * No-progress budget (ms) for re-attaching to a still-running agent-tool
   * child after a deploy / parent recovery (#1630). Bounds how long the parent
   * waits with NO forward progress from the child; it resets on every forwarded
   * chunk, so a child that keeps streaming is never abandoned mid-flight. Only a
   * genuinely silent/hung child seals `interrupted` after a full window. Raise
   * for children with long quiet stretches between outputs.
   */
  agentToolReattachNoProgressTimeoutMs:
    DEFAULT_AGENT_TOOL_REATTACH_NO_PROGRESS_TIMEOUT_MS,
  /**
   * Optional hard wall-clock ceiling (ms) on a single agent-tool re-attach
   * (#1630). Caps the total wait even as the no-progress budget re-arms across
   * stream-closes. Defaults to `Infinity` (no implicit cap), mirroring
   * chat-recovery's `maxRecoveryWork` (#1672): a healthy, still-advancing child
   * is followed for as long as it makes progress — a hung child is bounded by
   * the no-progress budget, and a content-runaway by the child's own
   * `maxRecoveryWork` / `shouldKeepRecovering`. Set a finite value to impose a
   * wall-clock cap (which also tears the child down on `window-exceeded`).
   */
  agentToolReattachMaxWindowMs: DEFAULT_AGENT_TOOL_REATTACH_MAX_WINDOW_MS,
  detachedMaxBudgetMs: DEFAULT_DETACHED_MAX_BUDGET_MS,
  detachedNoProgressBudgetMs: DEFAULT_DETACHED_NO_PROGRESS_BUDGET_MS,
  /**
   * Caps on the agent-tool timeline replayed to one reconnecting client.
   * Uncapped by default: every retained run, with every stored chunk.
   */
  agentToolReplayOnConnect: {
    maxRuns: Number.POSITIVE_INFINITY,
    maxChunksPerRun: Number.POSITIVE_INFINITY
  },
  /**
   * Consecutive alarm invocations that may end in a Durable Object memory-limit
   * reset (the isolate exceeded its 128 MB limit) before the alarm-boundary
   * circuit breaker stops the platform's auto-retry loop and seals the looping
   * work (#1825). A small budget tolerates a genuinely transient memory spike;
   * a deterministic OOM (the work's footprint, not the platform, is the cause)
   * is bounded here regardless of whether the in-DO recovery budgets could run.
   */
  maxAlarmMemoryLimitStrikes: 3
};

/**
 * Fully resolved agent options — all fields are defined with concrete values.
 */
interface ResolvedAgentOptions {
  sendIdentityOnConnect: boolean;
  hungScheduleTimeoutSeconds: number;
  keepAliveIntervalMs: number;
  retry: Required<RetryOptions>;
  fiberRecoveryHookTimeoutMs: number;
  fiberRecoveryScanDeadlineMs: number;
  fiberRecoveryMaxAgeMs: number;
  agentToolReattachNoProgressTimeoutMs: number;
  agentToolReattachMaxWindowMs: number;
  detachedMaxBudgetMs: number;
  detachedNoProgressBudgetMs: number;
  agentToolReplayOnConnect: {
    maxRuns: number;
    maxChunksPerRun: number;
  };
  maxAlarmMemoryLimitStrikes: number;
}

/**
 * Configuration options for the Agent.
 * Override in subclasses via `static options`.
 * All fields are optional - defaults are applied at runtime.
 */
export interface AgentStaticOptions {
  sendIdentityOnConnect?: boolean;
  hungScheduleTimeoutSeconds?: number;
  /**
   * Interval in milliseconds for keepAlive() alarm heartbeats.
   * Default: 30000 (30 seconds). Lower values mean faster recovery
   * after eviction but more frequent alarms.
   */
  keepAliveIntervalMs?: number;
  /** Default retry options for schedule(), queue(), and this.retry(). */
  retry?: RetryOptions;
  /**
   * Timeout in milliseconds for internal framework fiber recovery hooks.
   * User-defined `onFiberRecovered()` hooks are not timed out by default.
   */
  fiberRecoveryHookTimeoutMs?: number;
  /** Soft deadline in milliseconds for one interrupted-fiber recovery scan. */
  fiberRecoveryScanDeadlineMs?: number;
  /**
   * Maximum age in milliseconds of an unmanaged interrupted-fiber row before
   * recovery stops retrying a repeatedly-throwing `onFiberRecovered()` hook
   * and discards the row (emitting `fiber:recovery:skipped` with reason
   * `max_age_exceeded`). Defaults to 24h.
   *
   * Set to `0` to retain rows indefinitely. NOTE: with `0`, a hook that keeps
   * throwing is retried forever — the recovery alarm backs off exponentially
   * (capped at 5 minutes) so it is not a busy-loop, but the Durable Object
   * stays warm (never idle-evicts) for as long as the un-recoverable row
   * exists. Prefer a finite age unless you intend to inspect/clear such rows
   * yourself.
   */
  fiberRecoveryMaxAgeMs?: number;
  /**
   * No-progress budget in milliseconds for re-attaching to a still-running
   * agent-tool child after a deploy / parent recovery (#1630). Resets on every
   * forwarded chunk, so a steadily-streaming child is never abandoned; only a
   * genuinely silent child seals `interrupted` after a full window.
   * Default: 120000 (2 minutes). Set to `0` to skip waiting (collect only an
   * already-terminal child). Set to `Infinity` to never seal on no-progress —
   * a silent-but-alive child is then followed until its stream closes (or the
   * `agentToolReattachMaxWindowMs` ceiling fires), mirroring that knob's
   * "Infinity = off" convention.
   */
  agentToolReattachNoProgressTimeoutMs?: number;
  /**
   * Optional hard wall-clock ceiling in milliseconds on a single agent-tool
   * re-attach (#1630). Caps the total wait even as the no-progress budget
   * re-arms across stream-closes. Default: `Infinity` (no implicit cap),
   * mirroring chat-recovery's `maxRecoveryWork` (#1672) — a healthy,
   * still-advancing child is followed for as long as it makes progress, exactly
   * as on the live (never-evicted) path. Set a finite value to impose a
   * wall-clock cap (which also tears the child down on `window-exceeded`); `0`
   * also disables the ceiling.
   */
  agentToolReattachMaxWindowMs?: number;
  /**
   * Absolute safety ceiling in milliseconds for a DETACHED ("background")
   * agent-tool run dispatched via `runAgentTool(cls, { detached: ... })`
   * (rfc-detached-agent-tools). A detached run has no awaiting parent turn, so
   * on expiry the parent gives up watching — delivers the completion hook with
   * `interrupted` / `budget-exceeded` and tears the child down — rather than
   * holding a concurrency slot + live facet forever. Unlike the re-attach
   * window this defaults to a FINITE value (24h) precisely because an abandoned
   * detached run has no observer to notice the leak. Override per-run via
   * `detached: { maxBudgetMs }`.
   */
  detachedMaxBudgetMs?: number;
  /**
   * Resetting no-progress window in milliseconds for a DETACHED agent-tool run
   * (rfc-detached-agent-tools §progress). Once the child has emitted at least
   * one `reportProgress` signal, the parent gives up if the run then goes
   * silent for this long; the window resets on every subsequent signal. A child
   * that never reports progress is bounded only by `detachedMaxBudgetMs` — we
   * never give up on a run merely for taking a long time, only for going silent
   * after it began reporting. Default: 1h. Set `0`/`Infinity` to disable (rely
   * on the absolute ceiling only). Override per-run via
   * `detached: { noProgressBudgetMs }`.
   */
  detachedNoProgressBudgetMs?: number;
  /**
   * Caps on the agent-tool timeline replayed to one client when it (re)connects.
   * Both default to `Infinity`: every retained run is replayed with every stored
   * chunk. A parent that accumulates many runs, or runs with long child
   * transcripts, can bound the reconnect burst here.
   *
   * - `maxRuns`: replay only the newest N runs by start time. A run that is cut
   *   sends no frames at all — it is simply not part of the replayed timeline.
   * - `maxChunksPerRun`: replay only the LAST N stored chunks of each run (the
   *   tail is what a reconnecting client needs to render current state). Dropped
   *   chunks still advance the frame sequence, so the frames that are sent carry
   *   the same sequence numbers an uncapped replay would use and the client hook
   *   dedupes live-vs-replay exactly as before.
   *
   * Retention is unaffected: capping the replay never deletes a run. Use
   * `clearAgentToolRuns()` for that.
   */
  agentToolReplayOnConnect?: {
    maxRuns?: number;
    maxChunksPerRun?: number;
  };
  /**
   * Consecutive alarm invocations that may end in a Durable Object memory-limit
   * reset (the isolate exceeded its 128 MB limit) before the alarm-boundary
   * circuit breaker stops the platform's auto-retry loop and seals the looping
   * recovery work (#1825). Default: 3. Set to `0` to seal on the first such
   * reset. This is the universal backstop for the case where the in-DO recovery
   * budgets (`chatRecovery.maxOomRetries` / `maxRecoveryWork`) can't engage
   * because the OOM bypasses them — e.g. it is thrown before the budget code
   * runs, or its own writes also OOM. The boundary handler runs at the outermost
   * alarm frame, after the heavy turn has unwound and GC has reclaimed its
   * footprint, so its small seal/purge writes can land where mid-turn writes
   * could not.
   */
  maxAlarmMemoryLimitStrikes?: number;
}

/**
 * Parse the raw `retry_options` TEXT column from a SQLite row into a
 * typed `RetryOptions` object, or `undefined` if not set.
 */
function parseRetryOptions(
  row: Record<string, unknown>
): RetryOptions | undefined {
  const raw = row.retry_options;
  if (typeof raw !== "string") return undefined;
  return JSON.parse(raw) as RetryOptions;
}

/**
 * Resolve per-task retry options against class-level defaults and call
 * `tryN`. This is the retry-execution path for queue flush; Scheduler owns
 * its own copy for schedule callbacks.
 */
function resolveRetryConfig(
  taskRetry: RetryOptions | undefined,
  defaults: Required<RetryOptions>
): { maxAttempts: number; baseDelayMs: number; maxDelayMs: number } {
  return {
    maxAttempts: taskRetry?.maxAttempts ?? defaults.maxAttempts,
    baseDelayMs: taskRetry?.baseDelayMs ?? defaults.baseDelayMs,
    maxDelayMs: taskRetry?.maxDelayMs ?? defaults.maxDelayMs
  };
}

// `isDurableObjectCodeUpdateReset` / `isPlatformTransientError` live in
// ./retries and remain re-exported from the package root so higher layers
// classify platform failures with the same matcher instead of drifting copies.

/** Compatibility alias for the lifecycle-owned current Agent accessor. */
export const getCurrentAgent = getCurrentLifecycleAgent as <
  T extends DurableObject = Agent<Cloudflare.Env>
>() => CurrentAgentContext<T, AgentEmail>;

/**
 * Restore Agent context when a public method is entered outside a Lifecycle
 * hook, notably through native Durable Object RPC or cross-Agent re-entry.
 * Lifecycle already owns context for its capability and semantic user hooks.
 */

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- generic callable constraint
function withAgentContext<T extends (...args: any[]) => any>(
  method: T
): (
  this: Agent<Cloudflare.Env, unknown>,
  ...args: Parameters<T>
) => ReturnType<T> {
  return function (...args: Parameters<T>): ReturnType<T> {
    const { agent } = getCurrentAgent();

    if (agent === this) {
      // already wrapped, so we can just call the method
      return method.apply(this, args);
    }
    // Crossing to a different Agent must not carry native I/O handles
    // from the previous request/WebSocket/email turn into the new DO.
    return runInInvocation(
      {
        agent: this,
        connection: undefined,
        request: undefined,
        email: undefined
      },
      () => {
        return method.apply(this, args);
      }
    );
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
> extends DurableObject<Env> {
  /**
   * Runtime lifecycle and reusable durable capabilities for this Agent.
   *
   * @experimental The API surface may change before stabilizing.
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
  private readonly _webSockets = new WebSockets({
    handlers: {
      onConnect: (connection, ctx) => this.onConnect(connection, ctx),
      onMessage: (connection, message) => this.onMessage(connection, message),
      onClose: (connection, code, reason, wasClean) =>
        this.onClose(connection, code, reason, wasClean),
      onError: (connection, error) => this.onError(connection, error)
    },
    // Agent's callable interface comes from its existing public
    // surface — @callable()-decorated methods — served here over the
    // Cap'n Web endpoint and, natively, over the legacy JSON RPC
    // protocol: one interface on every wire, no new Agent members.
    // Capability hosts pass an RpcTarget directly instead.
    callables: callablesFromDecorated(this),
    getConnectionTags: (connection, ctx) =>
      this.getConnectionTags(connection, ctx)
  });

  /** Run user initialization after lifecycle components have started. */
  onStart(_props?: Props): void | Promise<void> {}

  /** Handle an HTTP request not claimed by a lifecycle component. */
  onRequest(_request: Request): Response | Promise<Response> {
    return new Response("Not implemented", { status: 404 });
  }

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

  private _state = DEFAULT_STATE as State;
  private _disposables = new DisposableStore();
  private _destroyed = false;

  /**
   * Stores raw state accessors for wrapped connections.
   * Used by internal flag methods (readonly, no-protocol) to read/write
   * _cf_-prefixed keys without going through the user-facing state/setState.
   */
  private _rawStateAccessors = new WeakMap<
    Connection,
    {
      getRaw: () => Record<string, unknown> | null;
      setRaw: (state: unknown) => unknown;
    }
  >();

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

  /**
   * Number of active keepAlive() callers. When > 0, `_syncHostJobs()`
   * caps the next alarm at `keepAliveIntervalMs` so the DO stays alive.
   * Purely in-memory — lost on eviction, which is correct because the
   * in-memory work keepAlive was protecting is also lost.
   * @internal
   */
  _keepAliveRefs = 0;

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

  /** @internal In-memory set of fiber IDs running in this process. */
  private _runFiberActiveFibers = new Set<string>();
  /** @internal In-memory abort controllers for managed running fibers. */
  private _managedFiberAbortControllers = new Map<string, AbortController>();
  /** @internal In-memory executions for callers that want to await accepted work. */
  private _managedFiberExecutions = new Map<string, Promise<void>>();
  /** @internal In-memory waiters for managed fibers reaching terminal ledger state. */
  private _managedFiberTerminalWaiters = new Map<string, Set<() => void>>();
  /** @internal Prevents re-entrant recovery from overlapping alarm ticks. */
  private _runFiberRecoveryInProgress = false;
  /**
   * @internal Consecutive runFiber-recovery scans that made NO forward progress
   * while work was still pending. Drives the exponential backoff of the
   * recovery follow-up alarm so a repeatedly-throwing recovery hook does not
   * busy-loop the DO. Reset to 0 whenever a scan recovers anything.
   */
  private _recoveryNoProgressScans = 0;

  private _ParentClass: typeof Agent<Env, State> =
    Object.getPrototypeOf(this).constructor;

  /**
   * Durable scheduling capability installed into this Agent's Lifecycle.
   *
   * @experimental The API surface may change before stabilizing. Agent's
   * schedule()/scheduleEvery()/getScheduleById()/listSchedules()/
   * cancelSchedule() methods are the stable surface.
   */
  readonly scheduler: Scheduler;

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
   * Parent-side agent-tool capability installed into this Agent's Lifecycle.
   * Owns run dispatch, live forwarding, reconnect replay, recovery, and the
   * detached-run delivery ledger.
   *
   * @experimental The API surface may change before stabilizing. Agent's
   * runAgentTool()/cancelAgentTool()/hasAgentToolRun()/clearAgentToolRuns()
   * methods are the stable surface.
   */
  readonly agentTools: AgentTools;

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

  /**
   * Initial state for the Agent
   * Override to provide default state values
   */
  initialState: State = DEFAULT_STATE as State;

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
   * const model = workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
   *   sessionAffinity: this.sessionAffinity,
   * });
   * ```
   */
  get sessionAffinity(): string {
    return this.ctx.id.toString();
  }

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
    const result = this.sql<{ state: State | undefined }>`
      SELECT state FROM cf_agents_state WHERE id = ${STATE_ROW_ID}
    `;

    // Row existence is the signal that state was previously set.
    // This handles all values including falsy ones (null, 0, false, "").
    if (result.length > 0) {
      const state = result[0].state as string;

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
          this._setStateInternal(this.initialState);
        } else {
          // No initialState defined - clear corrupted data to prevent infinite retry loop
          this.sql`DELETE FROM cf_agents_state WHERE id = ${STATE_ROW_ID}`;
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
    this._setStateInternal(this.initialState);
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
    if (this._cachedOptions) return this._cachedOptions;
    const ctor = this.constructor as typeof Agent;
    const userRetry = ctor.options?.retry;
    this._cachedOptions = {
      sendIdentityOnConnect:
        ctor.options?.sendIdentityOnConnect ??
        DEFAULT_AGENT_STATIC_OPTIONS.sendIdentityOnConnect,
      hungScheduleTimeoutSeconds:
        ctor.options?.hungScheduleTimeoutSeconds ??
        DEFAULT_AGENT_STATIC_OPTIONS.hungScheduleTimeoutSeconds,
      keepAliveIntervalMs:
        ctor.options?.keepAliveIntervalMs ??
        DEFAULT_AGENT_STATIC_OPTIONS.keepAliveIntervalMs,
      retry: {
        maxAttempts:
          userRetry?.maxAttempts ??
          DEFAULT_AGENT_STATIC_OPTIONS.retry.maxAttempts,
        baseDelayMs:
          userRetry?.baseDelayMs ??
          DEFAULT_AGENT_STATIC_OPTIONS.retry.baseDelayMs,
        maxDelayMs:
          userRetry?.maxDelayMs ?? DEFAULT_AGENT_STATIC_OPTIONS.retry.maxDelayMs
      },
      fiberRecoveryHookTimeoutMs:
        ctor.options?.fiberRecoveryHookTimeoutMs ??
        DEFAULT_AGENT_STATIC_OPTIONS.fiberRecoveryHookTimeoutMs,
      fiberRecoveryScanDeadlineMs:
        ctor.options?.fiberRecoveryScanDeadlineMs ??
        DEFAULT_AGENT_STATIC_OPTIONS.fiberRecoveryScanDeadlineMs,
      fiberRecoveryMaxAgeMs:
        ctor.options?.fiberRecoveryMaxAgeMs ??
        DEFAULT_AGENT_STATIC_OPTIONS.fiberRecoveryMaxAgeMs,
      agentToolReattachNoProgressTimeoutMs:
        ctor.options?.agentToolReattachNoProgressTimeoutMs ??
        DEFAULT_AGENT_STATIC_OPTIONS.agentToolReattachNoProgressTimeoutMs,
      agentToolReattachMaxWindowMs:
        ctor.options?.agentToolReattachMaxWindowMs ??
        DEFAULT_AGENT_STATIC_OPTIONS.agentToolReattachMaxWindowMs,
      detachedMaxBudgetMs:
        ctor.options?.detachedMaxBudgetMs ??
        DEFAULT_AGENT_STATIC_OPTIONS.detachedMaxBudgetMs,
      detachedNoProgressBudgetMs:
        ctor.options?.detachedNoProgressBudgetMs ??
        DEFAULT_AGENT_STATIC_OPTIONS.detachedNoProgressBudgetMs,
      agentToolReplayOnConnect: {
        maxRuns:
          ctor.options?.agentToolReplayOnConnect?.maxRuns ??
          DEFAULT_AGENT_STATIC_OPTIONS.agentToolReplayOnConnect.maxRuns,
        maxChunksPerRun:
          ctor.options?.agentToolReplayOnConnect?.maxChunksPerRun ??
          DEFAULT_AGENT_STATIC_OPTIONS.agentToolReplayOnConnect.maxChunksPerRun
      },
      maxAlarmMemoryLimitStrikes:
        ctor.options?.maxAlarmMemoryLimitStrikes ??
        DEFAULT_AGENT_STATIC_OPTIONS.maxAlarmMemoryLimitStrikes
    };
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

  /** Run SDK work under a stable parent for platform child spans. */
  private _withAgentSpan<T>(
    operation: string,
    storagePhase: string,
    attributes: TraceAttributes,
    run: (update: (attributes: TraceAttributes) => void) => Promise<T>
  ): Promise<T>;
  private _withAgentSpan<T>(
    operation: string,
    storagePhase: string,
    attributes: TraceAttributes,
    run: (update: (attributes: TraceAttributes) => void) => T
  ): T;
  private _withAgentSpan<T>(
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
   * the stored schema version matches CURRENT_SCHEMA_VERSION.
   *
   * Protected so that test agents can re-run the real migration path
   * after manipulating DB state (since ctx.abort() is unavailable in
   * local dev and the constructor only runs once per DO instance).
   */
  protected _ensureSchema(): void {
    // Schema version gating: skip all DDL on established DOs whose schema
    // is already up-to-date. We always create cf_agents_state first (cheap
    // idempotent DDL) and store the version as a row inside it.
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_state (
        id TEXT PRIMARY KEY NOT NULL,
        state TEXT
      )
    `;

    const versionRow = this.sql<{ state: string | null }>`
      SELECT state FROM cf_agents_state WHERE id = ${SCHEMA_VERSION_ROW_ID}
    `;
    const schemaVersion =
      versionRow.length > 0 ? Number(versionRow[0].state) : 0;

    if (schemaVersion < CURRENT_SCHEMA_VERSION) {
      ensureMcpServerTable(this.ctx.storage);

      this.sql`
        CREATE TABLE IF NOT EXISTS cf_agents_queues (
          id TEXT PRIMARY KEY NOT NULL,
          payload TEXT,
          callback TEXT,
          created_at INTEGER DEFAULT (unixepoch())
        )
      `;

      // Migration: add queue retry options for existing agents.
      // Schedule schema and migrations are owned by Scheduler.
      const addColumnIfNotExists = (sql: string) => {
        try {
          this.ctx.storage.sql.exec(sql);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (!message.toLowerCase().includes("duplicate column")) {
            throw error;
          }
        }
      };

      addColumnIfNotExists(
        "ALTER TABLE cf_agents_queues ADD COLUMN retry_options TEXT"
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

      // Clean up legacy STATE_WAS_CHANGED rows from the single-row state optimization
      this.ctx.storage.sql.exec(
        "DELETE FROM cf_agents_state WHERE id = ?",
        STATE_WAS_CHANGED
      );

      // v3: durable fibers table for runFiber
      this.sql`
        CREATE TABLE IF NOT EXISTS cf_agents_runs (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          snapshot TEXT,
          created_at INTEGER NOT NULL
        )
      `;

      // v5: root-side index of descendant facet fibers. The fiber's
      // authoritative row stays in the facet's own cf_agents_runs table;
      // this table only lets the root alarm owner know which facets need
      // recovery checks while they are idle.
      this.sql`
        CREATE TABLE IF NOT EXISTS cf_agents_facet_runs (
          owner_path TEXT NOT NULL,
          owner_path_key TEXT NOT NULL,
          run_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (owner_path_key, run_id)
        )
      `;

      this.sql`
        CREATE INDEX IF NOT EXISTS idx_facet_runs_owner_path_key
        ON cf_agents_facet_runs(owner_path_key)
      `;

      // v8: managed fiber job ledger for idempotent acceptance,
      // inspection, cancellation, and terminal cleanup.
      this.sql`
        CREATE TABLE IF NOT EXISTS cf_agents_fibers (
          fiber_id TEXT PRIMARY KEY,
          idempotency_key TEXT UNIQUE,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          snapshot TEXT,
          metadata_json TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER
        )
      `;

      this.sql`
        CREATE INDEX IF NOT EXISTS idx_fibers_status_created
        ON cf_agents_fibers(status, created_at, fiber_id)
      `;

      this.sql`
        CREATE INDEX IF NOT EXISTS idx_fibers_name_status_created
        ON cf_agents_fibers(name, status, created_at, fiber_id)
      `;

      this.sql`
        CREATE INDEX IF NOT EXISTS idx_fibers_status_completed
        ON cf_agents_fibers(status, completed_at, created_at)
      `;

      // Mark schema as up-to-date
      this.sql`
        INSERT OR REPLACE INTO cf_agents_state (id, state)
        VALUES (${SCHEMA_VERSION_ROW_ID}, ${String(CURRENT_SCHEMA_VERSION)})
      `;
    }

    this._schemaInitialization = {
      previousVersion: schemaVersion,
      currentVersion: CURRENT_SCHEMA_VERSION,
      migrated: schemaVersion < CURRENT_SCHEMA_VERSION
    };
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

    this.tasks = new Tasks({
      onError: (error) => this.onError(error)
    });

    this.agentTools = new AgentTools({
      reattachNoProgressTimeoutMs:
        this._resolvedOptions.agentToolReattachNoProgressTimeoutMs,
      reattachMaxWindowMs: this._resolvedOptions.agentToolReattachMaxWindowMs,
      detachedMaxBudgetMs: this._resolvedOptions.detachedMaxBudgetMs,
      detachedNoProgressBudgetMs:
        this._resolvedOptions.detachedNoProgressBudgetMs,
      replayOnConnect: this._resolvedOptions.agentToolReplayOnConnect
    });

    // Host bindings for the agent-tool engine. Every entry delegates to a
    // method on `this`, so a subclass override (Think / AIChatAgent replace
    // the delivery and progress seams) stays in effect.
    setAgentToolsHost(this.agentTools, {
      maxConcurrent: () => this.maxConcurrentAgentTools,
      maxConcurrentDetached: () => this.maxConcurrentDetachedAgentTools,
      resolveChild: (agentType, runId) =>
        this._cf_resolveSubAgent(agentType, runId),
      deleteChild: (agentType, runId) =>
        this.deleteSubAgent(this._agentToolClassByName(agentType), runId),
      broadcast: (frame) => this.broadcast(frame),
      onAgentToolStart: (run) => this.onAgentToolStart(run),
      onAgentToolFinish: (run, result) => this.onAgentToolFinish(run, result),
      onProgress: (run, progress) => this.onProgress(run, progress),
      onError: async (error) => {
        await this.onError(error);
      },
      resolveCallback: (name) => {
        const method = (this as unknown as Record<string, unknown>)[name];
        if (typeof method !== "function") return undefined;
        // SAFETY: the durable callback contract is name-based (a method name
        // persisted on the run row), so its parameter types cannot be known
        // here; the capability calls it with the documented run/result pair.
        return (method as (...args: never[]) => unknown).bind(this);
      },
      runDetachedDelivery: (invoke, options) =>
        this._runDetachedDelivery(invoke, options),
      onStreamProgress: () => this._onAgentToolStreamProgress(),
      deliverDetachedMilestone: (run, milestone, mode) =>
        this._deliverDetachedMilestone(run, milestone, mode),
      waitUntil: (work) => this.ctx.waitUntil(work)
    });

    // Twin bridge for a routed Task run: the physical alarm lives on the
    // root, but the run's storage and this hook live on the owning dynamic
    // agent, whose own Lifecycle never observes the root's alarm directly.
    setTaskRoutedMemoryLimitHandler(this.tasks, (context) => {
      const hook = (
        this as unknown as {
          onAlarmMemoryLimit?: (value: typeof context) => void | Promise<void>;
        }
      ).onAlarmMemoryLimit;
      return hook?.call(this, context);
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

    this.mcp = this._withAgentSpan(
      "agent_initialization",
      "initialization",
      {},
      (update) => {
        if (!wrappedClasses.has(this.constructor)) {
          // Auto-wrap custom methods with agent context
          this._autoWrapCustomMethods();
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

    // Agent's WebSocket connections ride the WebSockets capability —
    // Lifecycle itself no longer models connections. The handlers call
    // through `this.*` so they always hit the framework-wrapped hooks.
    this.lifecycle
      .use(this.scheduler)
      .use(this.mcp)
      .use(this._webSockets, { fallback: true })
      .use(this.tasks)
      .use(this.agentTools)
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
    // Compute persistence-hook dispatch mode once.
    // Throws immediately if both hooks are overridden on the same class.
    {
      const proto = Object.getPrototypeOf(this);
      const hasOwnNew = Object.prototype.hasOwnProperty.call(
        proto,
        "onStateChanged"
      );
      const hasOwnOld = Object.prototype.hasOwnProperty.call(
        proto,
        "onStateUpdate"
      );

      if (hasOwnNew && hasOwnOld) {
        throw new Error(
          `[Agent] Cannot override both onStateChanged and onStateUpdate. ` +
            `Remove onStateUpdate — it has been renamed to onStateChanged.`
        );
      }

      if (hasOwnOld) {
        const ctor = this.constructor;
        if (!_onStateUpdateWarnedClasses.has(ctor)) {
          _onStateUpdateWarnedClasses.add(ctor);
          console.warn(
            `[Agent] onStateUpdate is deprecated. Rename to onStateChanged — the behavior is identical.`
          );
        }
      }

      const base = Agent.prototype;
      if (proto.onStateChanged !== base.onStateChanged) {
        this._persistenceHookMode = "new";
      } else if (proto.onStateUpdate !== base.onStateUpdate) {
        this._persistenceHookMode = "old";
      }
      // default "none" already set in field initializer
    }

    const _onAlarm = this.onAlarm.bind(this);
    this.onAlarm = async () => {
      if (this._destroyed) return;
      await _onAlarm();
      if (this._destroyed) return;
      await this._onAlarmHousekeeping();
      // Housekeeping scans change fiber/facet/keep-alive state; refresh the
      // host jobs that guarantee their wakes before Lifecycle re-arms.
      if (this._destroyed) return;
      await this._syncHostJobs();
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
      this._ensureConnectionWrapped(connection);
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

          if (isStateUpdateMessage(parsed)) {
            // Check if connection is readonly
            if (this.isConnectionReadonly(connection)) {
              // Send error response back to the connection
              connection.send(
                JSON.stringify({
                  type: MessageType.CF_AGENT_STATE_ERROR,
                  error: "Connection is readonly"
                })
              );
              return;
            }
            try {
              this._setStateInternal(parsed.state as State, connection);
            } catch (e) {
              // validateStateChange (or another sync error) rejected the update.
              // Log the full error server-side, send a generic message to the client.
              console.error("[Agent] State update rejected:", e);
              connection.send(
                JSON.stringify({
                  type: MessageType.CF_AGENT_STATE_ERROR,
                  error: "State update rejected"
                })
              );
            }
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

              const metadata = getCallableMetadata(methodFn as Function);

              // For streaming methods, pass a StreamingResponse object
              if (metadata?.streaming) {
                const stream = new StreamingResponse(connection, id);
                if (replyBridge) {
                  registerFacetStreamingDelivery(stream, replyBridge);
                }

                this._emit("rpc", { method, streaming: true });

                try {
                  await methodFn.apply(this, [stream, ...args]);
                } catch (err) {
                  console.error(`Error in streaming method "${method}":`, err);
                  this._emit("rpc:error", {
                    method,
                    error: err instanceof Error ? err.message : String(err)
                  });
                  // Auto-close stream with error if method throws before closing
                  if (!stream.isClosed) {
                    stream.error(
                      err instanceof Error ? err.message : String(err)
                    );
                  }
                }
                await waitForFacetStreamingResponseDeliveries(stream);
                return;
              }

              // For regular methods, execute and send response
              const result = await methodFn.apply(this, args);

              this._emit("rpc", { method, streaming: metadata?.streaming });

              const response: RPCResponse = {
                done: true,
                id,
                result,
                success: true,
                type: MessageType.RPC
              };
              if (replyBridge) {
                await sendFacetRpcResponseIfOpen(replyBridge, response)
                  .completion;
              } else {
                sendRpcResponseIfOpen(connection, response);
              }
            } catch (e) {
              const response: RPCResponse = {
                error:
                  e instanceof Error ? e.message : "Unknown error occurred",
                id: parsed.id,
                success: false,
                type: MessageType.RPC
              };
              if (replyBridge) {
                await sendFacetRpcResponseIfOpen(replyBridge, response)
                  .completion;
              } else {
                sendRpcResponseIfOpen(connection, response);
              }

              console.error("RPC error:", e);
              this._emit("rpc:error", {
                method: parsed.method,
                error: e instanceof Error ? e.message : String(e)
              });
            }
            return;
          }

          return this._tryCatch(() => _onMessage(connection, message));
        }
      );
    };

    const _onConnect = this.onConnect.bind(this);
    this.onConnect = async (connection: Connection, ctx: ConnectionContext) => {
      this._ensureConnectionWrapped(connection);
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
              connection.send(
                JSON.stringify({
                  name: this.name,
                  agent: camelCaseToKebabCase(this._ParentClass.name),
                  type: MessageType.CF_AGENT_IDENTITY
                })
              );
            }

            const wasExcludedFromStateInitBroadcast =
              this._protocolBroadcastExcludeIds.has(connection.id);
            let currentState: State | undefined;
            this._protocolBroadcastExcludeIds.add(connection.id);
            try {
              currentState = this.state;
            } finally {
              if (!wasExcludedFromStateInitBroadcast) {
                this._protocolBroadcastExcludeIds.delete(connection.id);
              }
            }

            if (currentState !== undefined) {
              connection.send(
                JSON.stringify({
                  state: currentState,
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
          } else {
            this._setConnectionNoProtocol(connection);
          }

          this._emit("connect", { connectionId: connection.id });
          await this.agentTools.replayToConnection(connection);
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

            const startupAgentToolRunIds = await this._withAgentSpan(
              "recover_agent_work",
              "startup",
              {},
              async () => {
                this._checkOrphanedWorkflows();
                await this._checkRunFibers();
                // Interrupted Task runs (including chat turns) recover via
                // the Lifecycle job queue: their mirror jobs are overdue and
                // re-fire on the post-startup alarm derivation.
                return this.agentTools.recoveryRunIds();
              }
            );
            update({
              "cloudflare.agents.start.facet": this._isFacet,
              "cloudflare.agents.recovery.agent_tools.count":
                startupAgentToolRunIds.length
            });

            // Chat recovery (above, in `_checkRunFibers`) evaluates its budgets
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

            this.agentTools.scheduleStartupRecovery({
              runIds: startupAgentToolRunIds
            });

            // Push-based host jobs replace the pull-based alarm contribution:
            // re-sync them on every wake so orphaned fiber/facet recovery
            // state left by a dead process re-arms its housekeeping wake.
            await this._syncHostJobs();
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

  private _setStateInternal(
    nextState: State,
    source: Connection | "server" = "server"
  ): void {
    // Validation/gating hook (sync only)
    this.validateStateChange(nextState, source);

    // Persist state — row existence in cf_agents_state is the signal that
    // state was set (no separate wasChanged flag needed).
    this._state = nextState;
    this.sql`
      INSERT OR REPLACE INTO cf_agents_state (id, state)
      VALUES (${STATE_ROW_ID}, ${JSON.stringify(nextState)})
    `;

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
  setState(state: State): void {
    // Check if the current context has a readonly connection
    const store = agentContext.getStore();
    if (store?.connection && this.isConnectionReadonly(store.connection)) {
      throw new Error("Connection is readonly");
    }
    this._setStateInternal(state, "server");
  }

  /**
   * Wraps connection.state and connection.setState so that internal
   * _cf_-prefixed flags (readonly, no-protocol) are hidden from user code
   * and cannot be accidentally overwritten.
   *
   * Idempotent — safe to call multiple times on the same connection.
   * After hibernation, the _rawStateAccessors WeakMap is empty but the
   * connection's state getter still reads from the persisted WebSocket
   * attachment. Calling this method re-captures the raw getter so that
   * predicate methods (isConnectionReadonly, isConnectionProtocolEnabled)
   * work correctly post-hibernation.
   */
  private _ensureConnectionWrapped(connection: Connection) {
    if (this._rawStateAccessors.has(connection)) return;

    // Hibernating lifecycle connections expose attachment-backed state as a
    // configurable accessor. Virtual facet connections use a data property,
    // so retain both projections below.
    const descriptor = Object.getOwnPropertyDescriptor(connection, "state");

    let getRaw: () => Record<string, unknown> | null;
    let setRaw: (state: unknown) => unknown;

    if (descriptor?.get) {
      // Accessor property — bind the original getter directly.
      // The getter reads from the serialized WebSocket attachment, so it
      // always returns the latest value even after setState updates it.
      getRaw = descriptor.get.bind(connection) as () => Record<
        string,
        unknown
      > | null;
      setRaw = connection.setState.bind(connection);
    } else {
      // Data property — track raw state in a closure variable.
      // Reading `connection.state` after our override would call our filtered
      // getter (circular), so we snapshot the value here and keep it in sync.
      let rawState = (connection.state ?? null) as Record<
        string,
        unknown
      > | null;
      getRaw = () => rawState;
      setRaw = (state: unknown) => {
        rawState = state as Record<string, unknown> | null;
        return rawState;
      };
    }

    this._rawStateAccessors.set(connection, { getRaw, setRaw });

    // Override state getter to hide all internal _cf_ flags from user code
    Object.defineProperty(connection, "state", {
      configurable: true,
      enumerable: true,
      get() {
        const raw = getRaw();
        if (raw != null && typeof raw === "object" && rawHasInternalKeys(raw)) {
          return stripInternalKeys(raw);
        }
        return raw;
      }
    });

    // Override setState to preserve internal flags when user sets state
    Object.defineProperty(connection, "setState", {
      configurable: true,
      writable: true,
      value(stateOrFn: unknown | ((prev: unknown) => unknown)) {
        const raw = getRaw();
        const flags =
          raw != null && typeof raw === "object"
            ? extractInternalFlags(raw as Record<string, unknown>)
            : {};
        const hasFlags = Object.keys(flags).length > 0;

        let newUserState: unknown;
        if (typeof stateOrFn === "function") {
          // Pass only the user-visible state (without internal flags) to the callback
          const userVisible = hasFlags
            ? stripInternalKeys(raw as Record<string, unknown>)
            : raw;
          newUserState = (stateOrFn as (prev: unknown) => unknown)(userVisible);
        } else {
          newUserState = stateOrFn;
        }

        // Merge back internal flags if any were set
        if (hasFlags) {
          if (newUserState != null && typeof newUserState === "object") {
            return setRaw({
              ...(newUserState as Record<string, unknown>),
              ...flags
            });
          }
          // User set null — store just the flags
          return setRaw(flags);
        }
        return setRaw(newUserState);
      }
    });
  }

  /**
   * Mark a connection as readonly or readwrite
   * @param connection The connection to mark
   * @param readonly Whether the connection should be readonly (default: true)
   */
  setConnectionReadonly(connection: Connection, readonly = true) {
    this._ensureConnectionWrapped(connection);
    const accessors = this._rawStateAccessors.get(connection)!;
    const raw = (accessors.getRaw() as Record<string, unknown> | null) ?? {};
    if (readonly) {
      accessors.setRaw({ ...raw, [CF_READONLY_KEY]: true });
    } else {
      // Remove the key entirely instead of storing false — avoids dead keys
      // accumulating in the connection attachment.
      const { [CF_READONLY_KEY]: _, ...rest } = raw;
      accessors.setRaw(Object.keys(rest).length > 0 ? rest : null);
    }
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
    this._ensureConnectionWrapped(connection);
    const raw = this._rawStateAccessors.get(connection)!.getRaw() as Record<
      string,
      unknown
    > | null;
    return !!raw?.[CF_READONLY_KEY];
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
    this._ensureConnectionWrapped(connection);
    const raw = this._rawStateAccessors.get(connection)!.getRaw() as Record<
      string,
      unknown
    > | null;
    return raw?.[key];
  }

  /**
   * ⚠️ INTERNAL — DO NOT USE IN APPLICATION CODE. ⚠️
   *
   * Write an internal `_cf_`-prefixed flag to the raw connection state,
   * bypassing the user-facing state wrapper. The key must be registered
   * in `CF_INTERNAL_KEYS` so it is preserved across user `setState` calls
   * and hidden from `connection.state`.
   *
   * @internal
   */
  _unsafe_setConnectionFlag(
    connection: Connection,
    key: string,
    value: unknown
  ): void {
    this._ensureConnectionWrapped(connection);
    const accessors = this._rawStateAccessors.get(connection)!;
    const raw = (accessors.getRaw() as Record<string, unknown> | null) ?? {};
    if (value === undefined) {
      const { [key]: _, ...rest } = raw;
      accessors.setRaw(Object.keys(rest).length > 0 ? rest : null);
    } else {
      accessors.setRaw({ ...raw, [key]: value });
    }
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
    this._ensureConnectionWrapped(connection);
    const raw = this._rawStateAccessors.get(connection)!.getRaw() as Record<
      string,
      unknown
    > | null;
    return !raw?.[CF_NO_PROTOCOL_KEY];
  }

  /**
   * Mark a connection as having protocol messages disabled.
   * Called internally when shouldSendProtocolMessages returns false.
   */
  private _setConnectionNoProtocol(connection: Connection) {
    this._ensureConnectionWrapped(connection);
    const accessors = this._rawStateAccessors.get(connection)!;
    const raw = (accessors.getRaw() as Record<string, unknown> | null) ?? {};
    accessors.setRaw({ ...raw, [CF_NO_PROTOCOL_KEY]: true });
  }

  /**
   * Called before the Agent's state is persisted and broadcast.
   * Override to validate or reject an update by throwing an error.
   *
   * IMPORTANT: This hook must be synchronous.
   */
  // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
  validateStateChange(_nextState: State, _source: Connection | "server") {
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
  onStateChanged(_state: State | undefined, _source: Connection | "server") {
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
  onStateUpdate(_state: State | undefined, _source: Connection | "server") {
    // override this to handle state updates (deprecated — use onStateChanged)
  }

  /**
   * Dispatch to the appropriate persistence hook based on the mode
   * cached in the constructor. No prototype walks at call time.
   */
  private async _callStatePersistenceHook(
    state: State | undefined,
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
  async _onEmail(payload: {
    from: string;
    to: string;
    headers: Headers;
    rawSize: number;
    _secureRouted?: boolean;
    _bridge: EmailBridge;
  }) {
    // nb: we use this roundabout way of getting to onEmail
    // because of https://github.com/cloudflare/workerd/issues/4499

    // Reconstruct the AgentEmail interface from the payload so the
    // user's onEmail handler sees the same API as before
    const email: AgentEmail = {
      from: payload.from,
      to: payload.to,
      headers: payload.headers,
      rawSize: payload.rawSize,
      _secureRouted: payload._secureRouted,
      getRaw: () => payload._bridge.getRaw(),
      setReject: (reason: string) => payload._bridge.setReject(reason),
      forward: (rcptTo: string, headers?: Headers) =>
        payload._bridge.forward(rcptTo, headers),
      reply: (options: { from: string; to: string; raw: string }) =>
        payload._bridge.reply(options)
    };

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

      // Emit after the send succeeds — from/to are swapped because
      // this is a reply: the agent (email.to) is now the sender.
      const rawSubject = email.headers.get("subject");
      this._emit("email:reply", {
        from: email.to,
        to: email.from,
        subject:
          options.subject ?? (rawSubject ? `Re: ${rawSubject}` : undefined)
      });
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
      throw this.onError(e);
    }
  }

  /**
   * Wrap public subclass methods that may be entered outside Lifecycle, such as
   * native Durable Object RPC. Lifecycle hooks already have Agent context.
   */
  private _autoWrapCustomMethods() {
    // Agent.prototype traversal also covers the DurableObject base class.
    const basePrototypes = [Agent.prototype];
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
        /* oxlint-disable @typescript-eslint/no-explicit-any -- dynamic method wrapping requires any */
        const wrappedFunction = withAgentContext(
          this[methodName as keyof this] as (...args: any[]) => any
        ) as any;
        /* oxlint-enable @typescript-eslint/no-explicit-any */

        // if the method is callable, copy the metadata from the original method
        if (this._isCallable(methodName)) {
          copyCallableMetadata(
            this[methodName as keyof this] as Function,
            wrappedFunction
          );
        }

        // set the wrapped function on the prototype
        this.constructor.prototype[methodName as keyof this] = wrappedFunction;
      }

      proto = Object.getPrototypeOf(proto);
      depth++;
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
   * Queue a task to be executed in the future
   * @param callback Name of the method to call
   * @param payload Payload to pass to the callback
   * @param options Options for the queued task
   * @param options.retry Retry options for the callback execution
   * @returns The ID of the queued task
   */
  async queue<T = unknown>(
    callback: keyof this,
    payload: T,
    options?: { retry?: RetryOptions }
  ): Promise<string> {
    const id = nanoid(9);
    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }

    if (typeof this[callback] !== "function") {
      throw new Error(`this.${callback} is not a function`);
    }

    if (options?.retry) {
      validateRetryOptions(options.retry, this._resolvedOptions.retry);
    }

    const retryJson = options?.retry ? JSON.stringify(options.retry) : null;

    this.sql`
      INSERT OR REPLACE INTO cf_agents_queues (id, payload, callback, retry_options)
      VALUES (${id}, ${JSON.stringify(payload)}, ${callback}, ${retryJson})
    `;

    this._emit("queue:create", { callback: callback as string, id });

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
    try {
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
            await this.dequeue(row.id);
            continue;
          }
          const { connection, request, email } = agentContext.getStore() || {};
          await runInInvocation(
            {
              agent: this,
              connection,
              request,
              email
            },
            async () => {
              const retryOpts = parseRetryOptions(
                row as unknown as Record<string, unknown>
              );
              const { maxAttempts, baseDelayMs, maxDelayMs } =
                resolveRetryConfig(retryOpts, this._resolvedOptions.retry);
              const parsedPayload = JSON.parse(row.payload as string);
              try {
                await tryN(
                  maxAttempts,
                  async (attempt) => {
                    if (attempt > 1) {
                      this._emit("queue:retry", {
                        callback: row.callback,
                        id: row.id,
                        attempt,
                        maxAttempts
                      });
                    }
                    await (
                      callback as (
                        payload: unknown,
                        queueItem: QueueItem<string>
                      ) => Promise<void>
                    ).bind(this)(parsedPayload, row);
                  },
                  { baseDelayMs, maxDelayMs }
                );
              } catch (e) {
                console.error(
                  `queue callback "${row.callback}" failed after ${maxAttempts} attempts`,
                  e
                );
                this._emit("queue:error", {
                  callback: row.callback,
                  id: row.id,
                  error: e instanceof Error ? e.message : String(e),
                  attempts: maxAttempts
                });
                try {
                  await this.onError(e);
                } catch {
                  // swallow onError errors
                }
              } finally {
                this.dequeue(row.id);
              }
            },
            // The drain loop is started with `void` and routinely outlives the
            // handler that enqueued the item.
            { detached: true }
          );
        }
      }
    } finally {
      this._flushingQueue = false;
    }
  }

  /**
   * Dequeue a task by ID
   * @param id ID of the task to dequeue
   */
  dequeue(id: string) {
    this.sql`DELETE FROM cf_agents_queues WHERE id = ${id}`;
  }

  /**
   * Dequeue all tasks
   */
  dequeueAll() {
    this.sql`DELETE FROM cf_agents_queues`;
  }

  /**
   * Dequeue all tasks by callback
   * @param callback Name of the callback to dequeue
   */
  dequeueAllByCallback(callback: string) {
    this.sql`DELETE FROM cf_agents_queues WHERE callback = ${callback}`;
  }

  /**
   * Get a queued task by ID
   * @param id ID of the task to get
   * @returns The task or undefined if not found
   */
  getQueue(id: string): QueueItem<string> | undefined {
    const result = this.sql<QueueItem<string>>`
      SELECT * FROM cf_agents_queues WHERE id = ${id}
    `;
    if (!result || result.length === 0) return undefined;
    const row = result[0];
    return {
      ...row,
      payload: JSON.parse(row.payload as unknown as string),
      retry: parseRetryOptions(row as unknown as Record<string, unknown>)
    };
  }

  /**
   * Get all queues by key and value
   * @param key Key to filter by
   * @param value Value to filter by
   * @returns Array of matching QueueItem objects
   */
  getQueues(key: string, value: string): QueueItem<string>[] {
    const result = this.sql<QueueItem<string>>`
      SELECT * FROM cf_agents_queues
    `;
    return result
      .filter(
        (row) => JSON.parse(row.payload as unknown as string)[key] === value
      )
      .map((row) => ({
        ...row,
        payload: JSON.parse(row.payload as unknown as string),
        retry: parseRetryOptions(row as unknown as Record<string, unknown>)
      }));
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

  /** Single native-RPC aperture for routed Lifecycle capabilities. */
  _cf_routeLifecycle(
    target: LifecycleRouteAddress | undefined,
    envelope: LifecycleRouteEnvelope
  ): Promise<unknown> {
    return this._dynamicAgents.routeLifecycle(target, envelope);
  }

  private _rootAlarmOwner(): Promise<RootFacetRpcSurface> {
    return this._dynamicAgents.rootAlarmOwner();
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
    await this._dynamicAgents.cleanupPrefix(ownerPath);
  }

  /**
   * Acquire a root-owned keepAlive ref on behalf of a descendant facet.
   * Facets run in separate colocated isolates but cannot set their own
   * physical alarm, so this lets facet work use the root alarm heartbeat.
   * @internal
   */
  _cf_acquireFacetKeepAlive(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<string> {
    return this._dynamicAgents.acquireKeepAlive(ownerPath);
  }

  /**
   * Release a root-owned keepAlive ref previously acquired for a facet.
   * Idempotent so disposer calls can safely race or run twice.
   * @internal
   */
  _cf_releaseFacetKeepAlive(token: string): Promise<void> {
    return this._dynamicAgents.releaseKeepAlive(token);
  }

  /**
   * Register a facet's durable run row in the root-side index so root
   * alarm housekeeping can dispatch recovery checks into idle facets.
   * The facet remains authoritative for snapshots and recovery hooks.
   * @internal
   */
  _cf_registerFacetRun(
    ownerPath: ReadonlyArray<AgentPathStep>,
    runId: string
  ): Promise<void> {
    return this._dynamicAgents.registerRun(ownerPath, runId);
  }

  /**
   * Remove a completed facet fiber from the root-side index.
   * @internal
   */
  _cf_unregisterFacetRun(
    ownerPath: ReadonlyArray<AgentPathStep>,
    runId: string
  ): Promise<void> {
    return this._dynamicAgents.unregisterRun(ownerPath, runId);
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
   * @deprecated Use {@link getScheduleById}. This synchronous API cannot cross
   * Durable Object boundaries and throws inside sub-agents.
   */
  getSchedule<T = string>(id: string): Schedule<T> | undefined {
    return this.scheduler.__DO_NOT_USE_WILL_REMOVE__getSchedule<T>(id);
  }

  /**
   * Get a scheduled task by ID.
   *
   * Unlike the deprecated synchronous {@link getSchedule}, this works inside
   * sub-agents by delegating to the top-level parent that owns the alarm.
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
   * @deprecated Use {@link listSchedules}. This synchronous API cannot cross
   * Durable Object boundaries and throws inside sub-agents.
   */
  getSchedules<T = string>(criteria: ScheduleCriteria = {}): Schedule<T>[] {
    return this.scheduler.__DO_NOT_USE_WILL_REMOVE__getSchedules<T>(criteria);
  }

  /**
   * List scheduled tasks matching the given criteria.
   *
   * Unlike the deprecated synchronous {@link getSchedules}, this works inside
   * sub-agents by delegating to the top-level parent that owns the alarm.
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
  async keepAlive(): Promise<() => void> {
    if (this._isFacet) {
      const root = await this._rootAlarmOwner();
      const token = await root._cf_acquireFacetKeepAlive(this.selfPath);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        const release = root._cf_releaseFacetKeepAlive(token).catch((e) => {
          console.error("[Agent] Failed to release facet keepAlive:", e);
        });
        this.ctx.waitUntil(release);
      };
    }

    this._keepAliveRefs++;

    if (this._keepAliveRefs === 1) {
      await this._syncHostJobs();
    }

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this._keepAliveRefs = Math.max(0, this._keepAliveRefs - 1);
      // When the last lease is released, recompute the alarm from persistent
      // state so a short-lived keepAlive does not leave a stale
      // `now + keepAliveIntervalMs` heartbeat armed. The dispose contract is
      // synchronous, so fire-and-forget the async reschedule via waitUntil
      // (mirrors `_cf_releaseFacetKeepAlive`).
      if (this._keepAliveRefs === 0) {
        this.ctx.waitUntil(
          this._syncHostJobs().catch((e) => {
            console.error(
              "[Agent] Failed to reschedule alarm after keepAlive dispose:",
              e
            );
          })
        );
      }
    };
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
    const dispose = await this.keepAlive();
    try {
      return await fn();
    } finally {
      dispose();
    }
  }

  // ── Managed fibers: idempotent durable jobs ────────────────────────

  private _isTerminalFiberStatus(status: FiberStatus): boolean {
    return (
      status === "completed" ||
      status === "aborted" ||
      status === "interrupted" ||
      status === "error"
    );
  }

  private _notifyManagedFiberTerminal(fiberId: string): void {
    const row = this._readFiber(fiberId);
    if (row && !this._isTerminalFiberStatus(row.status)) {
      return;
    }

    const waiters = this._managedFiberTerminalWaiters.get(fiberId);
    if (!waiters) {
      return;
    }

    this._managedFiberTerminalWaiters.delete(fiberId);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private _waitForManagedFiberTerminal(fiberId: string): Promise<void> {
    const row = this._readFiber(fiberId);
    if (!row || this._isTerminalFiberStatus(row.status)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let waiters = this._managedFiberTerminalWaiters.get(fiberId);
      if (!waiters) {
        waiters = new Set();
        this._managedFiberTerminalWaiters.set(fiberId, waiters);
      }
      waiters.add(resolve);
    });
  }

  private _normalizeFiberStatusFilter(
    status?: FiberStatus | FiberStatus[]
  ): Set<FiberStatus> | null {
    if (!status) return null;
    return new Set(Array.isArray(status) ? status : [status]);
  }

  private _parseFiberJsonObject(
    value: string | null
  ): Record<string, unknown> | null {
    if (value === null) return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid metadata should not prevent inspection.
    }
    return null;
  }

  private _parseFiberSnapshot(value: string | null): unknown | undefined {
    if (value === null) return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }

  private _fiberErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private _stringifyFiberSnapshot(snapshot: unknown): string | null {
    return snapshot === undefined ? null : JSON.stringify(snapshot);
  }

  private _fiberRecoveryErrorMessage(
    result: FiberRecoveryResult
  ): string | null {
    if (result.status === "error") {
      return result.error === undefined
        ? null
        : this._fiberErrorMessage(result.error);
    }
    if (result.status === "aborted" || result.status === "interrupted") {
      return result.reason ?? null;
    }
    return null;
  }

  private _applyManagedFiberRecoveryResult(
    fiberId: string,
    result: FiberRecoveryResult
  ): void {
    const completedAt = Date.now();
    const snapshot = this._stringifyFiberSnapshot(result.snapshot);
    const errorMessage = this._fiberRecoveryErrorMessage(result);
    const metadata =
      result.status === "completed" && result.metadata !== undefined
        ? JSON.stringify(result.metadata)
        : undefined;

    if (metadata !== undefined) {
      this.sql`
        UPDATE cf_agents_fibers
        SET status = ${result.status},
            snapshot = COALESCE(${snapshot}, snapshot),
            metadata_json = ${metadata},
            error_message = ${errorMessage},
            completed_at = ${completedAt}
        WHERE fiber_id = ${fiberId}
          AND status = 'interrupted'
      `;
      this._notifyManagedFiberTerminal(fiberId);
      return;
    }

    this.sql`
      UPDATE cf_agents_fibers
      SET status = ${result.status},
          snapshot = COALESCE(${snapshot}, snapshot),
          error_message = ${errorMessage},
          completed_at = ${completedAt}
      WHERE fiber_id = ${fiberId}
        AND status = 'interrupted'
    `;
    this._notifyManagedFiberTerminal(fiberId);
  }

  private _settleManagedFiberExecution(
    fiberId: string,
    outcome: { ok: true } | { ok: false; error: unknown },
    signal: AbortSignal
  ): void {
    const completedAt = Date.now();
    if (outcome.ok) {
      this.sql`
        UPDATE cf_agents_fibers
        SET status = 'completed', completed_at = ${completedAt}
        WHERE fiber_id = ${fiberId} AND status = 'running'
      `;
      this._notifyManagedFiberTerminal(fiberId);
      return;
    }

    const message = this._fiberErrorMessage(outcome.error);
    const status: FiberStatus = signal.aborted ? "aborted" : "error";
    this.sql`
      UPDATE cf_agents_fibers
      SET status = ${status},
          error_message = ${message},
          completed_at = ${completedAt}
      WHERE fiber_id = ${fiberId} AND status = 'running'
    `;
    this._notifyManagedFiberTerminal(fiberId);
  }

  private _parseFiberRecoverySnapshot(
    fiberId: string,
    snapshotText: string | null
  ): unknown | null {
    if (!snapshotText) return null;
    try {
      return JSON.parse(snapshotText) as unknown;
    } catch {
      console.warn(
        `[Agent] Corrupted snapshot for fiber ${fiberId}, treating as null`
      );
      return null;
    }
  }

  private _fiberRecoveryPayload(
    ctx: FiberRecoveryContext,
    managedRow: FiberLedgerRow | null,
    startedAt?: number
  ): Record<string, unknown> {
    return {
      fiberId: ctx.id,
      fiberName: ctx.name,
      managed: managedRow !== null,
      recoveryReason: ctx.recoveryReason,
      elapsedMs: startedAt === undefined ? undefined : Date.now() - startedAt
    };
  }

  private async _withFiberRecoveryTimeout<T>(
    ctx: FiberRecoveryContext,
    operation: () => Promise<T>
  ): Promise<T> {
    const timeoutMs = this._resolvedOptions.fiberRecoveryHookTimeoutMs;
    if (timeoutMs <= 0) return operation();

    // Note: this bounds how long we WAIT for the operation, but does not
    // cancel it — `operation` keeps running after the timeout rejects. It is
    // applied to internal framework recovery only, which is idempotent and
    // safe to abandon mid-flight.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Fiber recovery hook timed out after ${timeoutMs}ms for "${ctx.name}" (${ctx.id})`
              )
            );
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private _recordFiberRecoveryFailure(
    ctx: FiberRecoveryContext,
    managedRow: FiberLedgerRow | null,
    error: unknown,
    startedAt: number,
    reason = "handler_error"
  ): void {
    const errorMessage = this._fiberErrorMessage(error);
    const completedAt = Date.now();
    if (managedRow) {
      this.sql`
        UPDATE cf_agents_fibers
        SET status = 'error',
            error_message = ${errorMessage},
            completed_at = ${completedAt}
        WHERE fiber_id = ${ctx.id}
          AND status = 'interrupted'
      `;
      this._notifyManagedFiberTerminal(ctx.id);
    }
    this._emit("fiber:recovery:failed", {
      ...this._fiberRecoveryPayload(ctx, managedRow, startedAt),
      error: errorMessage,
      reason
    });
  }

  private async _runFiberRecoveryHook(
    ctx: FiberRecoveryContext,
    managedRow: FiberLedgerRow | null
  ): Promise<boolean> {
    const startedAt = Date.now();
    this._emit(
      "fiber:recovery:attempt",
      this._fiberRecoveryPayload(ctx, managedRow)
    );
    try {
      const handled = await this._withFiberRecoveryTimeout(ctx, () =>
        this._handleInternalFiberRecovery(ctx)
      );
      if (!handled) {
        const recoveryResult = await this.onFiberRecovered(ctx);
        if (managedRow && recoveryResult) {
          this._applyManagedFiberRecoveryResult(ctx.id, recoveryResult);
        }
      }
      this._emit("fiber:recovery:handled", {
        ...this._fiberRecoveryPayload(ctx, managedRow, startedAt),
        status: handled ? "internal" : managedRow ? "managed" : "user"
      });
      return true;
    } catch (e) {
      this._recordFiberRecoveryFailure(ctx, managedRow, e, startedAt);
      console.error(
        `[Agent] Fiber recovery failed for "${ctx.name}" (${ctx.id}):`,
        e
      );
      return false;
    }
  }

  private _fiberInspectionFromRow(row: FiberLedgerRow): FiberInspection {
    const snapshot = this._parseFiberSnapshot(row.snapshot);
    const inspection: FiberInspection = {
      fiberId: row.fiber_id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at
    };

    if (row.idempotency_key !== null) {
      inspection.idempotencyKey = row.idempotency_key;
    }
    if (snapshot !== undefined) {
      inspection.snapshot = snapshot;
    }
    if (row.error_message !== null) {
      inspection.error = row.error_message;
    }
    const metadata = this._parseFiberJsonObject(row.metadata_json);
    if (metadata !== null) {
      inspection.metadata = metadata;
    }
    if (row.started_at !== null) {
      inspection.startedAt = row.started_at;
    }
    if (row.completed_at !== null) {
      inspection.settledAt = row.completed_at;
    }

    return inspection;
  }

  private async _waitForManagedFiber(
    fiberId: string
  ): Promise<FiberInspection | null> {
    const row = this._readFiber(fiberId);
    if (!row || this._isTerminalFiberStatus(row.status)) {
      return row ? this._fiberInspectionFromRow(row) : null;
    }

    if (this._managedFiberExecutions.has(fiberId)) {
      await this._waitForManagedFiberTerminal(fiberId);
      return this.inspectFiber(fiberId);
    }

    await this._checkRunFibers();
    await this._waitForManagedFiberTerminal(fiberId);
    return this.inspectFiber(fiberId);
  }

  private _readFiber(fiberId: string): FiberLedgerRow | null {
    const rows = this.sql<FiberLedgerRow>`
      SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
             error_message, created_at, started_at, completed_at
      FROM cf_agents_fibers
      WHERE fiber_id = ${fiberId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private _readFiberByKey(idempotencyKey: string): FiberLedgerRow | null {
    const rows = this.sql<FiberLedgerRow>`
      SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
             error_message, created_at, started_at, completed_at
      FROM cf_agents_fibers
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private _listFiberRows(options?: ListFibersOptions): FiberLedgerRow[] {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
    const statuses = this._normalizeFiberStatusFilter(options?.status);
    if (statuses) {
      return [...statuses]
        .flatMap((status) =>
          this._listFiberRowsByStatus(status, limit, options?.name)
        )
        .sort((a, b) =>
          b.created_at === a.created_at
            ? b.fiber_id.localeCompare(a.fiber_id)
            : b.created_at - a.created_at
        )
        .slice(0, limit);
    }

    if (options?.name) {
      return this.sql<FiberLedgerRow>`
        SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
               error_message, created_at, started_at, completed_at
        FROM cf_agents_fibers
        WHERE name = ${options.name}
        ORDER BY created_at DESC, fiber_id DESC
        LIMIT ${limit}
      `;
    }

    return this.sql<FiberLedgerRow>`
      SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
             error_message, created_at, started_at, completed_at
      FROM cf_agents_fibers
      ORDER BY created_at DESC, fiber_id DESC
      LIMIT ${limit}
    `;
  }

  private _listFiberRowsByStatus(
    status: FiberStatus,
    limit: number,
    name?: string
  ): FiberLedgerRow[] {
    if (name) {
      return this.sql<FiberLedgerRow>`
        SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
               error_message, created_at, started_at, completed_at
        FROM cf_agents_fibers
        WHERE status = ${status} AND name = ${name}
        ORDER BY created_at DESC, fiber_id DESC
        LIMIT ${limit}
      `;
    }

    return this.sql<FiberLedgerRow>`
      SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
             error_message, created_at, started_at, completed_at
      FROM cf_agents_fibers
      WHERE status = ${status}
      ORDER BY created_at DESC, fiber_id DESC
      LIMIT ${limit}
    `;
  }

  async inspectFiber(fiberId: string): Promise<FiberInspection | null> {
    const row = this._readFiber(fiberId);
    return row ? this._fiberInspectionFromRow(row) : null;
  }

  async inspectFiberByKey(
    idempotencyKey: string
  ): Promise<FiberInspection | null> {
    const row = this._readFiberByKey(idempotencyKey);
    return row ? this._fiberInspectionFromRow(row) : null;
  }

  async listFibers(options?: ListFibersOptions): Promise<FiberInspection[]> {
    return this._listFiberRows(options).map((row) =>
      this._fiberInspectionFromRow(row)
    );
  }

  async cancelFiber(fiberId: string, reason?: string): Promise<boolean> {
    const row = this._readFiber(fiberId);
    if (!row || this._isTerminalFiberStatus(row.status)) {
      return false;
    }

    const now = Date.now();
    this.sql`
      UPDATE cf_agents_fibers
      SET status = 'aborted',
          error_message = ${reason ?? null},
          completed_at = ${now}
      WHERE fiber_id = ${fiberId}
        AND status IN ('pending', 'running')
    `;
    this._managedFiberAbortControllers.get(fiberId)?.abort(reason);
    this._notifyManagedFiberTerminal(fiberId);
    return true;
  }

  async cancelFiberByKey(
    idempotencyKey: string,
    reason?: string
  ): Promise<boolean> {
    const row = this._readFiberByKey(idempotencyKey);
    return row ? this.cancelFiber(row.fiber_id, reason) : false;
  }

  async resolveFiber(
    fiberId: string,
    result: FiberRecoveryResult
  ): Promise<boolean> {
    const row = this._readFiber(fiberId);
    if (!row || row.status !== "interrupted") {
      return false;
    }

    this._applyManagedFiberRecoveryResult(fiberId, result);
    return true;
  }

  async deleteFibers(options?: DeleteFibersOptions): Promise<number> {
    const statuses =
      this._normalizeFiberStatusFilter(options?.status) ??
      new Set<FiberStatus>(["completed", "aborted", "error"]);
    const terminalStatuses = [...statuses].filter((status) =>
      this._isTerminalFiberStatus(status)
    );
    if (terminalStatuses.length === 0) {
      return 0;
    }

    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const settledBefore = options?.settledBefore?.getTime();
    const rows = terminalStatuses
      .flatMap((status) =>
        this._listTerminalFiberRowsForDelete(status, limit, settledBefore)
      )
      .sort((a, b) =>
        a.completed_at === b.completed_at
          ? a.created_at - b.created_at
          : (a.completed_at ?? 0) - (b.completed_at ?? 0)
      )
      .slice(0, limit);

    for (const row of rows) {
      this.sql`
        DELETE FROM cf_agents_fibers
        WHERE fiber_id = ${row.fiber_id}
          AND status IN ('completed', 'aborted', 'interrupted', 'error')
      `;
    }

    return rows.length;
  }

  private _listTerminalFiberRowsForDelete(
    status: FiberStatus,
    limit: number,
    settledBefore?: number
  ): FiberLedgerRow[] {
    if (settledBefore !== undefined) {
      return this.sql<FiberLedgerRow>`
        SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
               error_message, created_at, started_at, completed_at
        FROM cf_agents_fibers
        WHERE status = ${status}
          AND completed_at IS NOT NULL
          AND completed_at < ${settledBefore}
        ORDER BY completed_at ASC, created_at ASC
        LIMIT ${limit}
      `;
    }

    return this.sql<FiberLedgerRow>`
      SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
             error_message, created_at, started_at, completed_at
      FROM cf_agents_fibers
      WHERE status = ${status}
      ORDER BY completed_at ASC, created_at ASC
      LIMIT ${limit}
    `;
  }

  // ── Legacy fibers: durable execution (see agents/tasks for the new engine) ──

  /**
   * Run a function as a durable fiber. The fiber is registered in SQLite
   * before execution, checkpointable during execution via `ctx.stash()`,
   * and recoverable after eviction via `onFiberRecovered`.
   *
   * - Row created in `cf_agents_runs` at start, deleted on completion
   * - `keepAlive()` held for the duration — prevents idle eviction
   * - Inline (await result) or fire-and-forget (`void this.runFiber(...)`)
   *
   * @param name Informational name for debugging and recovery filtering
   * @param fn Async function to execute. Receives a FiberContext with stash/snapshot.
   * @returns The return value of fn
   */
  async runFiber<T>(
    name: string,
    fn: (ctx: FiberContext) => Promise<T>
  ): Promise<T> {
    return this._runFiberInternal(nanoid(), name, fn);
  }

  /**
   * Internal framework entry point for fibers that need to compose their own
   * recovery metadata with user checkpoint data while preserving the public
   * `this.stash()` behavior.
   *
   * This deliberately stays protected/internal rather than becoming a public
   * `runFiber()` option until the durable execution API needs this generality.
   * @internal
   */
  protected async _runFiberWithStashWrapper<T>(
    name: string,
    fn: (ctx: FiberContext) => Promise<T>,
    options: Pick<InternalFiberOptions, "initialSnapshot" | "wrapStash">
  ): Promise<T> {
    return this._runFiberInternal(nanoid(), name, fn, options);
  }

  async startFiber(
    name: string,
    fn: (ctx: FiberContext) => Promise<void>,
    options?: StartFiberOptions
  ): Promise<StartFiberResult> {
    const fiberId = options?.fiberId ?? nanoid();
    const idempotencyKey = options?.idempotencyKey;
    if (options?.fiberId !== undefined && options.fiberId.trim() === "") {
      throw new Error("fiberId must not be blank");
    }
    if (
      options?.idempotencyKey !== undefined &&
      options.idempotencyKey.trim() === ""
    ) {
      throw new Error("idempotencyKey must not be blank");
    }
    const existingById = this._readFiber(fiberId);
    const existingByKey = idempotencyKey
      ? this._readFiberByKey(idempotencyKey)
      : null;

    if (
      existingById &&
      existingByKey &&
      existingById.fiber_id !== existingByKey.fiber_id
    ) {
      throw new Error("fiberId and idempotencyKey refer to different fibers");
    }
    if (
      existingByKey &&
      options?.fiberId &&
      existingByKey.fiber_id !== fiberId
    ) {
      throw new Error("fiberId and idempotencyKey refer to different fibers");
    }

    const existing = existingById ?? existingByKey;
    if (existing) {
      if (
        options?.waitForCompletion &&
        !this._isTerminalFiberStatus(existing.status)
      ) {
        const waited = await this._waitForManagedFiber(existing.fiber_id);
        if (waited) {
          return {
            ...waited,
            accepted: false
          };
        }
        throw new Error(`Fiber ${existing.fiber_id} no longer exists`);
      }
      return {
        ...this._fiberInspectionFromRow(existing),
        accepted: false
      };
    }

    const now = Date.now();
    this.sql`
      INSERT INTO cf_agents_fibers
        (fiber_id, idempotency_key, name, status, snapshot, metadata_json,
         error_message, created_at, started_at, completed_at)
      VALUES
        (${fiberId}, ${idempotencyKey ?? null}, ${name}, 'pending', NULL,
         ${options?.metadata ? JSON.stringify(options.metadata) : null}, NULL,
         ${now}, NULL, NULL)
    `;

    const row = this._readFiber(fiberId);
    if (!row) {
      throw new Error(`Failed to create fiber ${fiberId}`);
    }

    const execution = this._executeManagedFiber(fiberId, name, fn)
      .catch((error) => {
        console.error(
          `[Agent] Managed fiber "${name}" (${fiberId}) failed:`,
          error
        );
      })
      .finally(() => {
        if (this._managedFiberExecutions.get(fiberId) === execution) {
          this._managedFiberExecutions.delete(fiberId);
        }
      });
    this._managedFiberExecutions.set(fiberId, execution);

    if (options?.waitForCompletion) {
      const completed = await this._waitForManagedFiber(fiberId);
      if (!completed) {
        throw new Error(`Fiber ${fiberId} no longer exists`);
      }
      return {
        ...completed,
        accepted: true
      };
    }

    return {
      ...this._fiberInspectionFromRow(row),
      accepted: true
    };
  }

  private async _executeManagedFiber(
    fiberId: string,
    name: string,
    fn: (ctx: FiberContext) => Promise<void>
  ): Promise<void> {
    const row = this._readFiber(fiberId);
    if (!row || row.status !== "pending") {
      return;
    }

    const controller = new AbortController();
    this._managedFiberAbortControllers.set(fiberId, controller);
    const now = Date.now();
    this.sql`
      UPDATE cf_agents_fibers
      SET status = 'running', started_at = ${now}
      WHERE fiber_id = ${fiberId} AND status = 'pending'
    `;

    const updated = this._readFiber(fiberId);
    if (!updated || updated.status !== "running") {
      this._managedFiberAbortControllers.delete(fiberId);
      return;
    }

    let settled = false;
    try {
      await this._runFiberInternal(fiberId, name, fn, {
        signal: controller.signal,
        managed: true,
        beforeRunCleanup: (outcome) => {
          settled = true;
          this._settleManagedFiberExecution(
            fiberId,
            outcome,
            controller.signal
          );
        }
      });
    } catch (error) {
      if (!settled) {
        this._settleManagedFiberExecution(
          fiberId,
          { ok: false, error },
          controller.signal
        );
      }
    } finally {
      this._managedFiberAbortControllers.delete(fiberId);
    }
  }

  private async _runFiberInternal<T>(
    id: string,
    name: string,
    fn: (ctx: FiberContext) => Promise<T>,
    options?: InternalFiberOptions
  ): Promise<T> {
    const signal = options?.signal ?? new AbortController().signal;
    this._withAgentSpan(
      "initialize_fiber",
      "fiber",
      {
        "cloudflare.agents.fiber.id": id,
        "cloudflare.agents.fiber.name": name
      },
      () => {
        this.sql`
          INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
          VALUES (${id}, ${name}, NULL, ${Date.now()})
        `;
      }
    );
    const startedAt = Date.now();
    this._emit("fiber:run:started", {
      fiberId: id,
      fiberName: name,
      managed: options?.managed === true
    });
    this._runFiberActiveFibers.add(id);

    const writeSnapshot = (data: unknown) => {
      const snapshot = JSON.stringify(data);
      this._withAgentSpan(
        "persist_fiber_snapshot",
        "fiber",
        {
          "cloudflare.agents.fiber.id": id,
          "cloudflare.agents.fiber.name": name
        },
        () => {
          this.sql`
            UPDATE cf_agents_runs SET snapshot = ${snapshot}
            WHERE id = ${id}
          `;
          if (options?.managed) {
            this.sql`
              UPDATE cf_agents_fibers SET snapshot = ${snapshot}
              WHERE fiber_id = ${id}
            `;
          }
        }
      );
    };

    let root: RootFacetRpcSurface | undefined;
    let registeredFacetRun = false;
    let dispose: () => void = () => {};
    try {
      if ("initialSnapshot" in (options ?? {})) {
        writeSnapshot(options?.initialSnapshot);
      }

      if (this._isFacet) {
        root = await this._rootAlarmOwner();
        await root._cf_registerFacetRun(this.selfPath, id);
        registeredFacetRun = true;
      }

      dispose = await this.keepAlive();
      const stash = (data: unknown) => {
        writeSnapshot(options?.wrapStash ? options.wrapStash(data) : data);
      };

      try {
        const result = await _fiberALS.run({ id, signal, stash }, () =>
          fn({ id, signal, stash, snapshot: null })
        );
        options?.beforeRunCleanup?.({ ok: true });
        this._emit("fiber:run:completed", {
          fiberId: id,
          fiberName: name,
          managed: options?.managed === true,
          elapsedMs: Date.now() - startedAt
        });
        return result;
      } catch (error) {
        options?.beforeRunCleanup?.({ ok: false, error });
        this._emit("fiber:run:failed", {
          fiberId: id,
          fiberName: name,
          managed: options?.managed === true,
          error: this._fiberErrorMessage(error),
          elapsedMs: Date.now() - startedAt
        });
        throw error;
      }
    } finally {
      this._runFiberActiveFibers.delete(id);
      this._withAgentSpan(
        "finalize_fiber",
        "fiber",
        {
          "cloudflare.agents.fiber.id": id,
          "cloudflare.agents.fiber.name": name
        },
        () => {
          this.sql`DELETE FROM cf_agents_runs WHERE id = ${id}`;
        }
      );
      dispose();
      if (root && registeredFacetRun) {
        try {
          await root._cf_unregisterFacetRun(this.selfPath, id);
        } catch (e) {
          // Leave the root-side lease behind if cleanup fails; root
          // housekeeping will re-enter the facet and prune stale rows
          // once it observes that this fiber row no longer exists.
          console.error("[Agent] Failed to unregister facet fiber:", e);
        }
      }
    }
  }

  /**
   * Checkpoint data for the currently executing fiber.
   * Uses AsyncLocalStorage to identify the correct fiber,
   * so it works correctly even with concurrent fibers.
   *
   * Throws if called outside a `runFiber` callback.
   */
  stash(data: unknown): void {
    const ctx = _fiberALS.getStore();
    if (!ctx) {
      throw new Error("stash() called outside a fiber");
    }
    ctx.stash(data);
  }

  /**
   * Run `fn` inside the fiber stash context so `this.stash()` keeps working
   * for turns executing on the `tasks` capability exactly as it does inside
   * legacy `runFiber()` closures.
   * @internal
   */
  protected _withFiberStash<T>(
    context: {
      id: string;
      signal: AbortSignal;
      stash: (data: unknown) => void;
    },
    fn: () => Promise<T>
  ): Promise<T> {
    return _fiberALS.run(context, fn);
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

  /** @internal Detect fibers left by a dead process (runFiber system). */
  private async _checkRunFibers(): Promise<void> {
    if (this._runFiberRecoveryInProgress) return;
    this._runFiberRecoveryInProgress = true;
    const scanStartedAt = Date.now();
    const scanDeadlineMs = this._resolvedOptions.fiberRecoveryScanDeadlineMs;
    const fiberRecoveryMaxAgeMs = this._resolvedOptions.fiberRecoveryMaxAgeMs;
    // Forward progress this scan = at least one fiber was resolved (orphan row
    // deleted via recovery/age-out/managed-terminal, or a ledger-only managed
    // fiber finalized). Drives the recovery-alarm backoff in `_syncHostJobs`.
    let madeProgress = false;

    try {
      const rows = this.sql<{
        id: string;
        name: string;
        snapshot: string | null;
        created_at: number;
      }>`SELECT id, name, snapshot, created_at FROM cf_agents_runs`;

      for (const row of rows) {
        if (scanDeadlineMs > 0 && Date.now() - scanStartedAt > scanDeadlineMs) {
          this._emit("fiber:recovery:skipped", {
            fiberId: row.id,
            fiberName: row.name,
            reason: "scan_deadline_exceeded",
            elapsedMs: Date.now() - scanStartedAt
          });
          break;
        }
        if (this._runFiberActiveFibers.has(row.id)) continue;

        const snapshot = this._parseFiberRecoverySnapshot(row.id, row.snapshot);
        const ctx: FiberRecoveryContext = {
          id: row.id,
          name: row.name,
          snapshot,
          createdAt: row.created_at,
          recoveryReason: "interrupted"
        };

        const managedRow = this._readFiber(row.id);
        this._emit("fiber:recovery:detected", {
          ...this._fiberRecoveryPayload(ctx, managedRow),
          elapsedMs: Date.now() - row.created_at
        });
        this._emit("fiber:run:interrupted", {
          fiberId: row.id,
          fiberName: row.name,
          managed: managedRow !== null,
          recoveryReason: "interrupted",
          elapsedMs: Date.now() - row.created_at
        });
        if (managedRow) {
          if (this._isTerminalFiberStatus(managedRow.status)) {
            this.sql`DELETE FROM cf_agents_runs WHERE id = ${row.id}`;
            madeProgress = true;
            this._notifyManagedFiberTerminal(row.id);
            continue;
          }

          const completedAt = Date.now();
          this.sql`
            UPDATE cf_agents_fibers
            SET status = 'interrupted',
                snapshot = ${row.snapshot},
                completed_at = ${completedAt}
            WHERE fiber_id = ${row.id}
              AND status IN ('pending', 'running')
          `;
          ctx.idempotencyKey = managedRow.idempotency_key ?? undefined;
          ctx.metadata = this._parseFiberJsonObject(managedRow.metadata_json);
          ctx.status = "interrupted";
        }

        const recovered = await this._runFiberRecoveryHook(ctx, managedRow);
        // Managed rows are always cleaned up (their ledger row records the
        // terminal status). Unmanaged rows are retained when recovery fails so
        // a later scan can retry — but only until they exceed the max age, at
        // which point a repeatedly-throwing hook would otherwise loop forever.
        const tooOld =
          fiberRecoveryMaxAgeMs > 0 &&
          Date.now() - row.created_at > fiberRecoveryMaxAgeMs;
        if (recovered || managedRow || tooOld) {
          if (!recovered && !managedRow && tooOld) {
            this._emit("fiber:recovery:skipped", {
              fiberId: row.id,
              fiberName: row.name,
              reason: "max_age_exceeded",
              elapsedMs: Date.now() - row.created_at
            });
          }
          this.sql`DELETE FROM cf_agents_runs WHERE id = ${row.id}`;
          madeProgress = true;
        }
        if (managedRow) {
          this._notifyManagedFiberTerminal(row.id);
        }
      }

      const ledgerOnlyRows = this.sql<FiberLedgerRow>`
        SELECT f.fiber_id, f.idempotency_key, f.name, f.status, f.snapshot,
               f.metadata_json, f.error_message, f.created_at, f.started_at,
               f.completed_at
        FROM cf_agents_fibers f
        LEFT JOIN cf_agents_runs r ON r.id = f.fiber_id
        WHERE f.status IN ('pending', 'running')
          AND r.id IS NULL
      `;

      for (const row of ledgerOnlyRows) {
        if (scanDeadlineMs > 0 && Date.now() - scanStartedAt > scanDeadlineMs) {
          this._emit("fiber:recovery:skipped", {
            fiberId: row.fiber_id,
            fiberName: row.name,
            reason: "scan_deadline_exceeded",
            elapsedMs: Date.now() - scanStartedAt,
            managed: true
          });
          break;
        }
        if (this._runFiberActiveFibers.has(row.fiber_id)) continue;

        const snapshot = this._parseFiberRecoverySnapshot(
          row.fiber_id,
          row.snapshot
        );
        const completedAt = Date.now();
        this.sql`
          UPDATE cf_agents_fibers
          SET status = 'interrupted',
              completed_at = ${completedAt}
          WHERE fiber_id = ${row.fiber_id}
            AND status IN ('pending', 'running')
        `;

        const ctx: FiberRecoveryContext = {
          id: row.fiber_id,
          name: row.name,
          snapshot,
          createdAt: row.created_at,
          idempotencyKey: row.idempotency_key ?? undefined,
          metadata: this._parseFiberJsonObject(row.metadata_json),
          status: "interrupted",
          recoveryReason: "interrupted"
        };
        this._emit("fiber:recovery:detected", {
          ...this._fiberRecoveryPayload(ctx, row),
          elapsedMs: Date.now() - row.created_at
        });
        this._emit("fiber:run:interrupted", {
          fiberId: row.fiber_id,
          fiberName: row.name,
          managed: true,
          recoveryReason: "interrupted",
          elapsedMs: Date.now() - row.created_at
        });

        await this._runFiberRecoveryHook(ctx, row);
        // A ledger-only fiber is finalized this pass regardless of hook outcome
        // (its ledger row is marked terminal and waiters are notified), so it
        // will not be pending next scan — that is forward progress.
        madeProgress = true;
        this._notifyManagedFiberTerminal(row.fiber_id);
      }
    } finally {
      this._runFiberRecoveryInProgress = false;
      // Update the recovery-alarm backoff streak: reset on any forward progress,
      // otherwise grow it only while work is still pending (a repeatedly-failing
      // poison hook). `_syncHostJobs` reads this to space out retries.
      if (madeProgress) {
        this._recoveryNoProgressScans = 0;
      } else {
        this._recoveryNoProgressScans = this._hasPendingFiberRecovery()
          ? this._recoveryNoProgressScans + 1
          : 0;
      }
    }
  }

  /** @internal */
  async _onAlarmHousekeeping(): Promise<void> {
    await this._checkRunFibers();
    await this._checkFacetRunFibers();
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
   * Root-side scan for durable fibers owned by descendant facets.
   * `cf_agents_facet_runs` is only an index; actual snapshots and
   * recovery hooks live in each facet's own `cf_agents_runs` table.
   * @internal
   */
  private _checkFacetRunFibers(): Promise<void> {
    return this._dynamicAgents.checkRunFibers();
  }

  /**
   * Dispatch a runFiber recovery check into the facet identified by
   * `ownerPath`. Returns the number of remaining local `cf_agents_runs`
   * rows on the target facet after recovery.
   * @internal
   */
  _cf_checkRunFibersForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<number> {
    return this._dynamicAgents.checkRunFibersAtPath(ownerPath);
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
  _cf_destroyDescendantFacet(
    targetPath: ReadonlyArray<AgentPathStep>
  ): Promise<void> {
    return this._dynamicAgents.destroyDescendant(targetPath);
  }

  /**
   * Whether any runFiber recovery work is still outstanding: orphaned
   * `cf_agents_runs` rows left by a dead process (excluding fibers currently
   * executing in memory, which already hold a keepAlive ref) or managed
   * ledger fibers stuck in a non-terminal state with no live run row.
   *
   * Used by `_syncHostJobs` to arm a follow-up alarm so multi-pass
   * recovery (e.g. after a scan-deadline yield, or while retrying a throwing
   * recovery hook) resumes instead of starving.
   * @internal
   */
  private _hasPendingFiberRecovery(): boolean {
    const runRows = this.sql<{ id: string }>`
      SELECT id FROM cf_agents_runs
    `;
    for (const row of runRows) {
      if (!this._runFiberActiveFibers.has(row.id)) return true;
    }

    const ledgerOnly = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count
      FROM cf_agents_fibers f
      LEFT JOIN cf_agents_runs r ON r.id = f.fiber_id
      WHERE f.status IN ('pending', 'running')
        AND r.id IS NULL
    `;
    return (ledgerOnly[0]?.count ?? 0) > 0;
  }

  /**
   * Synchronize Agent-owned host jobs with current durable state.
   *
   * Replaces the old pull-based `getNextAlarm()` contribution: keep-alive
   * refs hold a `cf:keep-alive` job, and fiber-recovery / facet-run state
   * holds a `cf:housekeeping` job. Every state change that used to trigger
   * an alarm recalculation now re-pushes or cancels these jobs; queue
   * mutations re-arm the physical alarm automatically.
   * @internal
   */
  private async _syncHostJobs(): Promise<void> {
    if (this._destroyed) return;
    await this._withAgentSpan("schedule_agent_alarm", "alarm", {}, async () => {
      const work = this.lifecycle.jobs;
      const nowMs = Date.now();

      // A pending destroy (#1625) must keep its wake armed and exclusive
      // through any re-sync — including markers written by a pre-job-queue
      // release — so a keepAlive-holding agent cannot delay its own
      // condemnation. The durable marker stays authoritative; the job is
      // re-derived from it.
      const pendingDestroy = await this._pendingDestroyAlarm();
      if (pendingDestroy !== null) {
        await work.push({
          id: HOST_JOB_DESTROY_ID,
          fn: "destroy",
          time: pendingDestroy,
          exclusive: true
        });
        return;
      }
      if (work.get(HOST_JOB_DESTROY_ID)) {
        await work.cancel(HOST_JOB_DESTROY_ID);
      }

      if (this._keepAliveRefs > 0) {
        await work.push({
          id: HOST_JOB_KEEP_ALIVE_ID,
          fn: "keepAlive",
          time: nowMs + this._resolvedOptions.keepAliveIntervalMs
        });
      } else if (work.get(HOST_JOB_KEEP_ALIVE_ID)) {
        await work.cancel(HOST_JOB_KEEP_ALIVE_ID);
      }

      const housekeepingAt = this._nextHousekeepingWakeMs(nowMs);
      if (housekeepingAt !== null) {
        await work.push({
          id: HOST_JOB_HOUSEKEEPING_ID,
          fn: "housekeeping",
          time: housekeepingAt
        });
      } else if (work.get(HOST_JOB_HOUSEKEEPING_ID)) {
        await work.cancel(HOST_JOB_HOUSEKEEPING_ID);
      }
    });
  }

  /**
   * The next wake fiber-recovery or facet-run housekeeping needs, or `null`
   * when neither has pending durable state.
   */
  private _nextHousekeepingWakeMs(nowMs: number): number | null {
    let nextTimeMs: number | null = null;

    if (this._hasPendingFiberRecovery()) {
      const base = this._resolvedOptions.keepAliveIntervalMs;
      const exp = Math.min(
        this._recoveryNoProgressScans,
        FIBER_RECOVERY_BACKOFF_MAX_EXP
      );
      const recoveryDelayMs = Math.min(
        FIBER_RECOVERY_MAX_BACKOFF_MS,
        base * 2 ** exp
      );
      nextTimeMs = nowMs + recoveryDelayMs;
    }

    const facetRuns = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_facet_runs
    `;
    if ((facetRuns[0]?.count ?? 0) > 0) {
      const facetRecoveryMs = nowMs + this._resolvedOptions.keepAliveIntervalMs;
      nextTimeMs =
        nextTimeMs === null
          ? facetRecoveryMs
          : Math.min(nextTimeMs, facetRecoveryMs);
    }

    return nextTimeMs;
  }

  /** Lifecycle alarm callback; Agent housekeeping runs after user alarm work. */
  onAlarm(): void {}

  /**
   * Drive one Agent-owned host job from the Lifecycle queue.
   * @internal Dispatched by Lifecycle's alarm event loop; extensions add
   * job fns through {@link _onHostJob}.
   */
  onJob(
    context: LifecycleJobContext
  ): LifecycleJobOutcome | void | Promise<LifecycleJobOutcome | void> {
    return this._onHostJob(context.job.fn, context);
  }

  /**
   * @internal Dispatch one host job fn. Agent extensions (Think) override
   * this to add fns and delegate unknown ones to `super`.
   */
  protected _onHostJob(
    fn: string,
    _context: LifecycleJobContext
  ): LifecycleJobOutcome | void | Promise<LifecycleJobOutcome | void> {
    switch (fn) {
      case "keepAlive":
        // This job's only purpose is guaranteeing wakes while refs are
        // held; housekeeping itself runs on every alarm via the onAlarm
        // wrapper.
        return this._keepAliveRefs > 0
          ? {
              rescheduleAt:
                Date.now() + this._resolvedOptions.keepAliveIntervalMs
            }
          : undefined;
      case "housekeeping": {
        const next = this._nextHousekeepingWakeMs(Date.now());
        return next === null ? undefined : { rescheduleAt: next };
      }
      case "destroy":
        // The alarm preamble consumes pending destroys before the event
        // loop runs; a surviving job is stale.
        return undefined;
      default:
        console.warn(`Unknown Agent host job fn ${JSON.stringify(fn)}`);
        return undefined;
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
    if (await this._hasPendingDestroy()) {
      await this.destroy();
      return;
    }

    await this.lifecycle.alarm();
  }

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
    if (decision instanceof Response) return decision;
    const forwardReq = decision instanceof Request ? decision : request;

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
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
  ): Promise<void> {
    await this._dynamicAgents.broadcastToPath(ownerPath, message, without);
  }

  _cf_subAgentConnectionMetas(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<SubAgentConnectionMeta[]> {
    return this._dynamicAgents.connectionMetas(ownerPath);
  }

  _cf_sendToSubAgentConnection(
    connectionId: string,
    message: string | ArrayBuffer | ArrayBufferView
  ): Promise<void> {
    return this._dynamicAgents.sendToConnection(connectionId, message);
  }

  _cf_closeSubAgentConnection(
    connectionId: string,
    code?: number,
    reason?: string
  ): Promise<void> {
    return this._dynamicAgents.closeConnection(connectionId, code, reason);
  }

  _cf_setSubAgentConnectionState(
    connectionId: string,
    state: unknown
  ): Promise<unknown> {
    return this._dynamicAgents.setConnectionState(connectionId, state);
  }

  protected _cf_connectionTargetsSubAgent(connection: Connection): boolean {
    return this._dynamicAgents.connectionTargetsChild(connection);
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
    identityName = name
  ): Promise<void> {
    return this._dynamicAgents.init(name, parentPath, identityName);
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
    return await getAgentByName<Cloudflare.Env, T>(binding, parent.name);
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
      root.name
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

  /**
   * Maximum number of non-terminal agent-tool runs this parent may own at
   * once. Read live by the agent-tools capability, so a subclass may reassign
   * it at any time.
   */
  maxConcurrentAgentTools = Infinity;

  /**
   * Maximum number of non-terminal DETACHED ("background") agent-tool runs this
   * parent may own at once, within the {@link Agent.maxConcurrentAgentTools}
   * total. Read live by the agent-tools capability, so a subclass may reassign
   * it at any time.
   *
   * A detached run holds its slot for its whole life and has no awaiting turn to
   * notice it piling up, so this bounds background work without also capping the
   * foreground runs that share the total budget. A detached dispatch that would
   * exceed it fails exactly like the total cap does: a synchronous `error`
   * result, no child spawned.
   */
  maxConcurrentDetachedAgentTools = Infinity;

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
   * Run a child agent as a tool of this one, streaming its output to this
   * agent's connected clients. See {@link AgentTools.run}.
   */
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
    return this.agentTools.run<Input, Output>(cls, options);
  }

  /**
   * Cancel an agent-tool run by id. Idempotent: cancelling an already-terminal
   * run is a no-op. See {@link AgentTools.cancel}.
   */
  async cancelAgentTool(runId: string, reason?: unknown): Promise<void> {
    return this.agentTools.cancel(runId, reason);
  }

  /** Whether this agent recorded a run with the given class/name and id. */
  hasAgentToolRun<T extends Agent>(
    cls: SubAgentClass<T>,
    runId: string
  ): boolean;
  hasAgentToolRun(agentType: string, runId: string): boolean;
  hasAgentToolRun(classOrName: SubAgentClass | string, runId: string): boolean {
    return this.agentTools.has(
      typeof classOrName === "string" ? classOrName : classOrName.name,
      runId
    );
  }

  /**
   * Delete recorded agent-tool runs and their child agents.
   * See {@link AgentTools.clear}.
   */
  async clearAgentToolRuns(options?: {
    olderThan?: number;
    status?: AgentToolRunStatus[];
  }): Promise<void> {
    return this.agentTools.clear(options);
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
   * (they fire from `waitUntil` / a queue job), so enqueuing them on the
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
   * Hook invoked by the agent-tools stream forwarder after a child produces
   * output that was forwarded to the parent's connections. Forwarding a
   * sub-agent's stream is genuine forward progress for the *parent* turn (the
   * parent is orchestrating the child), so chat-recovery subclasses (Think /
   * AIChatAgent) override this to advance their recovery progress marker.
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

  /**
   * Resolve an exported Agent class by its CamelCase name, for the
   * name-keyed paths (agent-tool run rows persist the class name, not a
   * reference).
   * @internal
   */
  private _agentToolClassByName(className: string): SubAgentClass<Agent> {
    const ctx = this.ctx as unknown as Partial<FacetCapableCtx>;
    const cls = ctx.exports?.[className];
    if (!cls) {
      throw new Error(`Agent tool class "${className}" is not exported.`);
    }
    // SAFETY: `ctx.exports` is the worker's export map typed as unknown
    // constructors; the framework requires agent-tool children to be exported
    // Agent subclasses, and the child adapter shape is validated at use.
    return cls as unknown as SubAgentClass<Agent>;
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
      const root = await this._rootAlarmOwner();
      // The chain: root → … → direct-parent runs ctx.facets.delete
      // on this facet, which aborts this isolate. The await may
      // throw an abort error or never resolve depending on timing —
      // either is acceptable, the cleanup has already been applied.
      await root._cf_destroyDescendantFacet(this.selfPath);
      return;
    }

    // Persist the teardown decision FIRST, so a destroy that gets cut short
    // (e.g. the runtime cancelling a request-scoped `waitUntil` it was riding
    // on, #1625) is finished by the next wake — see the `alarm()` preamble —
    // instead of leaving a half-deleted agent whose tables get silently
    // recreated by the constructor. The marker is removed by the
    // `deleteAll()` below, which is also why it is a KV record rather than a
    // SQL row: it must outlive live-resource disposal.
    await this.ctx.storage.put(DESTROY_PENDING_KEY, true);
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
    setTimeout(() => {
      abortWithoutAlarmRetry(this.ctx, "destroyed");
    }, 0);

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
    // destroy marker on a facet — which the `alarm()`/`_syncHostJobs()`
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
    // Future, not immediate: see DESTROY_ALARM_DELAY_MS — an immediate alarm
    // aborts the isolate fast enough to race this RPC's response back to the
    // DELETE handler, turning the intended 204 into a 500.
    const destroyAt = Date.now() + DESTROY_ALARM_DELAY_MS;
    await this.ctx.storage.put(DESTROY_PENDING_KEY, destroyAt);
    // The exclusive job arms the wake; the durable marker above remains the
    // authority the alarm preamble consumes before Lifecycle startup.
    await this.lifecycle.jobs.push({
      id: HOST_JOB_DESTROY_ID,
      fn: "destroy",
      time: destroyAt,
      exclusive: true
    });
  }

  /**
   * Whether a (deferred or interrupted) destroy is pending. Reads the
   * durable marker directly — the in-memory `_isFacet` flag may not be
   * hydrated yet at the call sites, but facets never write the marker.
   */
  private async _pendingDestroyAlarm(): Promise<number | null> {
    const pending = await this.ctx.storage.get<boolean | number>(
      DESTROY_PENDING_KEY
    );
    if (typeof pending === "number") return pending;
    return pending === true ? Date.now() : null;
  }

  private async _hasPendingDestroy(): Promise<boolean> {
    return (await this._pendingDestroyAlarm()) !== null;
  }

  /**
   * Check if a method is callable
   * @param method The method name to check
   * @returns True if the method is marked as callable
   */
  private _isCallable(method: string): boolean {
    return isCallableMethod(this[method as keyof this] as Function);
  }

  /**
   * Get all methods marked as callable on this Agent
   * @returns A map of method names to their metadata
   */
  getCallableMethods(): Map<string, CallableMetadata> {
    return new Map(decoratedMethods(this));
  }

  // ==========================================
  // Workflow Integration Methods
  // ==========================================

  /**
   * Start a workflow and track it in this Agent's database.
   * Automatically injects agent identity into the workflow params.
   *
   * The originating Agent identity is persisted in the workflow params so
   * callbacks (`this.agent` RPC, progress/completion/error, state updates)
   * route back to the exact Agent or sub-agent facet that started the run.
   * Note the following constraints:
   *
   * - **Resolution is by name.** Callbacks re-resolve the originating Agent via
   *   `getAgentByName(...)`. Agents addressed by a raw Durable Object id
   *   (`idFromString`/`get(id)`) rather than by name will not receive
   *   callbacks on the same instance.
   * - **Sub-agent runs are facet-local.** A workflow started from a sub-agent
   *   is tracked in that facet's own storage; the parent's `getWorkflows()` /
   *   `getWorkflowById()` do not see it. Aggregate across facets yourself if
   *   you need a combined view.
   * - **Class names must survive bundling.** The originating path is keyed by
   *   `constructor.name`. Ensure your bundler preserves class names
   *   (e.g. esbuild `keepNames: true`) so callbacks can be routed.
   *
   * @template P - Type of params to pass to the workflow
   * @param workflowName - Name of the workflow binding in env (e.g., 'MY_WORKFLOW')
   * @param params - Params to pass to the workflow
   * @param options - Optional workflow options. For sub-agents, pass
   *   `agentBinding` as the **root** Agent's Durable Object binding name, not a
   *   child binding.
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

    // Find the binding name for the top-level Agent namespace. Facets
    // are resolved later from this root binding plus their selfPath.
    const agentOrigin = this._workflowOrigin(options);
    if (!agentOrigin) {
      throw new Error(
        "Could not detect Agent binding name from class name. " +
          "Pass it explicitly via options.agentBinding"
      );
    }

    // Workflows instance IDs must start with [a-zA-Z0-9_].
    const workflowId = options?.id ?? `wf_${nanoid()}`;

    // Inject agent identity and workflow name into params
    const augmentedParams = {
      ...params,
      __agentName: this.name,
      __agentBinding:
        agentOrigin.kind === "agent"
          ? agentOrigin.binding
          : agentOrigin.rootBinding,
      __workflowName: workflowName,
      __agentOrigin: agentOrigin
    };

    // Create the workflow instance
    const instance = await workflow.create({
      id: workflowId,
      params: augmentedParams,
      retention: options?.retention
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

    this._emit("workflow:start", { workflowId: instance.id, workflowName });

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
    await tryN(3, async () => instance.sendEvent(event), {
      shouldRetry: isErrorRetryable,
      baseDelayMs: 200,
      maxDelayMs: 3000
    });

    this._emit("workflow:event", { workflowId, eventType: event.type });
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

    this._emit("workflow:approved", { workflowId, reason: data?.reason });
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

    this._emit("workflow:rejected", { workflowId, reason: data?.reason });
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
    await tryN(3, async () => instance.terminate(), {
      shouldRetry: isErrorRetryable,
      baseDelayMs: 200,
      maxDelayMs: 3000
    });

    // Update tracking table with new status
    const status = await instance.status();
    this._updateWorkflowTracking(workflowId, status);

    this._emit("workflow:terminated", {
      workflowId,
      workflowName: workflowInfo.workflowName
    });
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
    await tryN(3, async () => instance.pause(), {
      shouldRetry: isErrorRetryable,
      baseDelayMs: 200,
      maxDelayMs: 3000
    });

    const status = await instance.status();
    this._updateWorkflowTracking(workflowId, status);

    this._emit("workflow:paused", {
      workflowId,
      workflowName: workflowInfo.workflowName
    });
  }

  /**
   * Resume a paused workflow.
   *
   * @param workflowId - ID of the workflow to resume (must be tracked via runWorkflow)
   * @throws Error if workflow not found in tracking table
   * @throws Error if workflow binding not found in environment
   * @throws Error if workflow is not paused (from Cloudflare)
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
    await tryN(3, async () => instance.resume(), {
      shouldRetry: isErrorRetryable,
      baseDelayMs: 200,
      maxDelayMs: 3000
    });

    const status = await instance.status();
    this._updateWorkflowTracking(workflowId, status);

    this._emit("workflow:resumed", {
      workflowId,
      workflowName: workflowInfo.workflowName
    });
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
    await tryN(3, async () => instance.restart(), {
      shouldRetry: isErrorRetryable,
      baseDelayMs: 200,
      maxDelayMs: 3000
    });

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

    this._emit("workflow:restarted", {
      workflowId,
      workflowName: workflowInfo.workflowName
    });
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

  private _workflowOrigin(
    options: RunWorkflowOptions | undefined
  ): AgentWorkflowOrigin | undefined {
    if (this._isFacet) {
      const root = this._parentPath[0];
      const rootBindingName =
        options?.agentBinding ??
        (root ? this._findAgentBindingNameForClass(root.className) : undefined);

      if (!rootBindingName) return undefined;

      return {
        kind: "facet",
        version: 1,
        rootBinding: rootBindingName,
        path: this.selfPath.map((step) => ({ ...step }))
      };
    }

    const agentBindingName =
      options?.agentBinding ??
      this._findAgentBindingNameForClass(this._ParentClass.name);
    if (!agentBindingName) return undefined;

    return {
      kind: "agent",
      version: 1,
      binding: agentBindingName,
      name: this.name
    };
  }

  private _findAgentBindingNameForClass(className: string): string | undefined {
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

  private _findBindingNameForNamespace(
    namespace: DurableObjectNamespace<McpAgent>
  ): string | undefined {
    for (const [key, value] of Object.entries(
      this.env as Record<string, unknown>
    )) {
      if (value === namespace) {
        return key;
      }
    }
    return undefined;
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
   * Connect to a new MCP Server via RPC (Durable Object binding)
   *
   * The binding name and props are persisted to storage so the connection
   * is automatically restored after Durable Object hibernation.
   *
   * @example
   * await this.addMcpServer("counter", env.MY_MCP);
   * await this.addMcpServer("counter", env.MY_MCP, { props: { userId: "123" } });
   */
  async addMcpServer<T extends McpAgent>(
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

  async addMcpServer<T extends McpAgent>(
    serverName: string,
    urlOrBinding: string | DurableObjectNamespace<T>,
    callbackHostOrOptions?:
      | string
      | AddMcpServerOptions
      | AddRpcMcpServerOptions,
    agentsPrefix?: string,
    options?: Pick<AddMcpServerOptions, "client" | "transport">
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
    const isHttpTransport = typeof urlOrBinding === "string";
    const normalizedUrl = isHttpTransport
      ? new URL(urlOrBinding).href
      : undefined;

    // Extract and normalize a caller-supplied stable id, if any. The same
    // option field is accepted on both the HTTP and RPC option shapes.
    let requestedId: string | undefined;
    if (
      typeof callbackHostOrOptions === "object" &&
      callbackHostOrOptions !== null &&
      typeof (callbackHostOrOptions as { id?: unknown }).id === "string"
    ) {
      const rawId = (callbackHostOrOptions as { id: string }).id;
      requestedId = normalizeServerId(rawId);
    }

    const allServers = this.mcp.listServers();

    const existingServer = allServers.find(
      (s) =>
        s.name === serverName &&
        (!isHttpTransport || new URL(s.server_url).href === normalizedUrl)
    );

    if (requestedId) {
      // Collision check 1: a caller-supplied id may only re-resolve to an
      // existing server when the (name, url) also matches. Otherwise storage
      // (INSERT OR REPLACE on id) would silently overwrite the existing row.
      const idConflict = allServers.find((s) => {
        if (s.id !== requestedId) return false;
        if (s.name !== serverName) return true;
        if (isHttpTransport) {
          return new URL(s.server_url).href !== normalizedUrl;
        }
        return false;
      });
      if (idConflict) {
        throw new Error(
          `MCP server id "${requestedId}" is already in use by server "${idConflict.name}" (${idConflict.server_url}). ` +
            `Stable ids must be unique per (name, url).`
        );
      }

      // JIT-migrate: the same (name, url) is already registered under a
      // different id (typically an auto-generated nanoid from a previous
      // call that didn't supply `id`). This is the natural upgrade path —
      // a user adds `{ id: "github" }` to an existing `addMcpServer` call.
      // Rename the existing row + connection + OAuth keys to the new id in
      // place so the caller's contract ("the id I get back is the id I
      // asked for") holds and no stale storage rows are left behind.
      if (existingServer && existingServer.id !== requestedId) {
        await this.mcp.migrateServerId(
          existingServer.id,
          requestedId,
          this.name
        );
        existingServer.id = requestedId;
      }
    }

    if (existingServer && this.mcp.mcpConnections[existingServer.id]) {
      const conn = this.mcp.mcpConnections[existingServer.id];
      if (conn.connectionState === MCPConnectionState.AUTHENTICATING) {
        const authProvider = conn.options.transport.authProvider;
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

        const reconnectResult = await this.mcp.connectToServer(
          existingServer.id
        );
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
          const discoverResult = await this.mcp.discoverIfConnected(
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
      if (conn.connectionState === MCPConnectionState.FAILED) {
        throw new Error(
          `MCP server "${serverName}" is in failed state: ${conn.connectionError}`
        );
      }
      return { id: existingServer.id, state: MCPConnectionState.READY };
    }

    // RPC transport path: second argument is a DurableObjectNamespace
    if (typeof urlOrBinding !== "string") {
      const rpcOpts = callbackHostOrOptions as
        | AddRpcMcpServerOptions
        | undefined;

      const normalizedName = serverName.toLowerCase().replace(/\s+/g, "-");

      // Prefer the caller-supplied stable id, falling back to the existing
      // server's id (for restore-through-addMcpServer), then to a generated id.
      const reconnectId = requestedId ?? existingServer?.id;
      const { id } = await this.mcp.connect(
        `${RPC_DO_PREFIX}${normalizedName}`,
        {
          reconnect: reconnectId ? { id: reconnectId } : undefined,
          transport: {
            type: "rpc" as TransportType,
            namespace:
              urlOrBinding as unknown as DurableObjectNamespace<McpAgent>,
            name: normalizedName,
            props: rpcOpts?.props
          }
        }
      );

      const conn = this.mcp.mcpConnections[id];
      if (conn && conn.connectionState === MCPConnectionState.CONNECTED) {
        const discoverResult = await this.mcp.discoverIfConnected(id);
        if (discoverResult && !discoverResult.success) {
          throw new Error(
            `Failed to discover MCP server capabilities: ${discoverResult.error}`
          );
        }
      } else if (conn && conn.connectionState === MCPConnectionState.FAILED) {
        throw new Error(
          `Failed to connect to MCP server "${serverName}" via RPC: ${conn.connectionError}`
        );
      }

      const bindingName = this._findBindingNameForNamespace(
        urlOrBinding as unknown as DurableObjectNamespace<McpAgent>
      );
      if (bindingName) {
        this.mcp.saveRpcServerToStorage(
          id,
          serverName,
          normalizedName,
          bindingName,
          rpcOpts?.props
        );
      }

      return { id, state: MCPConnectionState.READY };
    }

    // HTTP transport path
    const httpOptions = callbackHostOrOptions as
      | string
      | AddMcpServerOptions
      | undefined;

    let resolvedCallbackHost: string | undefined;
    let resolvedAgentsPrefix: string;
    let resolvedOptions:
      | Pick<AddMcpServerOptions, "client" | "transport" | "retry">
      | undefined;

    let resolvedCallbackPath: string | undefined;

    if (typeof httpOptions === "object" && httpOptions !== null) {
      resolvedCallbackHost = httpOptions.callbackHost;
      resolvedCallbackPath = httpOptions.callbackPath;
      resolvedAgentsPrefix = httpOptions.agentsPrefix ?? "agents";
      resolvedOptions = {
        client: httpOptions.client,
        transport: httpOptions.transport,
        retry: httpOptions.retry
      };
    } else {
      resolvedCallbackHost = httpOptions;
      resolvedAgentsPrefix = agentsPrefix ?? "agents";
      resolvedOptions = options;
    }

    // Enforce callbackPath when sendIdentityOnConnect is false and callbackHost is provided
    if (
      !this._resolvedOptions.sendIdentityOnConnect &&
      resolvedCallbackHost &&
      !resolvedCallbackPath
    ) {
      throw new Error(
        "callbackPath is required in addMcpServer options when sendIdentityOnConnect is false — " +
          "the default callback URL would expose the instance name. " +
          "Provide a callbackPath and route the callback request to this agent via getAgentByName."
      );
    }

    // Try to derive callbackHost from the current request or connection URI
    if (!resolvedCallbackHost) {
      const { request, connection } = getCurrentAgent();
      if (request) {
        const requestUrl = new URL(request.url);
        resolvedCallbackHost = `${requestUrl.protocol}//${requestUrl.host}`;
      } else if (connection?.uri) {
        const connectionUrl = new URL(connection.uri);
        resolvedCallbackHost = `${connectionUrl.protocol}//${connectionUrl.host}`;
      }
    }

    // Build the callback URL if we have a host (needed for OAuth, optional for non-OAuth servers)
    let callbackUrl: string | undefined;
    if (resolvedCallbackHost) {
      const normalizedHost = resolvedCallbackHost.replace(/\/$/, "");
      callbackUrl = resolvedCallbackPath
        ? `${normalizedHost}/${resolvedCallbackPath.replace(/^\//, "")}`
        : `${normalizedHost}/${resolvedAgentsPrefix}/${camelCaseToKebabCase(this._ParentClass.name)}/${this.name}/callback`;
    }

    const id = requestedId ?? existingServer?.id ?? nanoid(8);

    // Only create authProvider if we have a callbackUrl (needed for OAuth servers)
    let authProvider:
      | ReturnType<typeof this.createMcpOAuthProvider>
      | undefined;
    if (callbackUrl) {
      authProvider = this.createMcpOAuthProvider(callbackUrl);
      authProvider.serverId = id;
    }

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
      url: normalizedUrl!,
      name: serverName,
      callbackUrl,
      client: resolvedOptions?.client,
      transport: {
        ...headerTransportOpts,
        authProvider,
        type: transportType,
        skipIssuerMetadataValidation:
          resolvedOptions?.transport?.skipIssuerMetadataValidation
      },
      retry: resolvedOptions?.retry
    });

    const result = await this.mcp.connectToServer(id);

    if (result.state === MCPConnectionState.FAILED) {
      // Server stays in storage so user can retry via connectToServer(id)
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
          error: sanitizeErrorString(serverConn?.connectionError ?? null),
          instructions: serverConn?.instructions ?? null,
          name: server.name,
          server_url: server.server_url,
          state: serverConn?.connectionState ?? defaultState
        };
      }
    }

    return mcpState;
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

// RpcTarget bridge for email callbacks. Consolidates the email event's
// mutation methods (setReject, forward, reply) into a single disposable
// RPC target instead of anonymous closures. This allows the runtime to
// tear down the bidirectional RPC session when _onEmail returns,
// rather than keeping the DO pinned for the caller's entire context
// lifetime (~100-120s for CF Email Routing handlers).
class EmailBridge extends RpcTarget {
  #email: ForwardableEmailMessage;

  constructor(email: ForwardableEmailMessage) {
    super();
    this.#email = email;
  }

  async getRaw(): Promise<Uint8Array> {
    const reader = this.#email.raw.getReader();
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
  }

  setReject(reason: string) {
    this.#email.setReject(reason);
  }

  forward(rcptTo: string, headers?: Headers): Promise<EmailSendResult> {
    return this.#email.forward(rcptTo, headers);
  }

  reply(options: {
    from: string;
    to: string;
    raw: string;
  }): Promise<EmailSendResult> {
    return this.#email.reply(
      new EmailMessage(options.from, options.to, options.raw)
    );
  }

  [Symbol.dispose]() {
    // Intentionally empty — the runtime calls this when the last
    // stub is disposed, signaling that the RPC target is no longer
    // needed and the bidirectional connection can be torn down.
  }
}

// Cache the agent namespace map for email routing
// This maps original names, kebab-case, and lowercase versions to namespaces
const agentMapCache = new WeakMap<
  Record<string, unknown>,
  { map: Record<string, unknown>; originalNames: string[] }
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

  // Build a map that includes original names, kebab-case, and lowercase versions
  if (!agentMapCache.has(env as Record<string, unknown>)) {
    const map: Record<string, unknown> = {};
    const originalNames: string[] = [];
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (
        value &&
        typeof value === "object" &&
        "idFromName" in value &&
        typeof value.idFromName === "function"
      ) {
        // Add the original name, kebab-case version, and lowercase version
        map[key] = value;
        map[camelCaseToKebabCase(key)] = value;
        map[key.toLowerCase()] = value;
        originalNames.push(key);
      }
    }
    agentMapCache.set(env as Record<string, unknown>, {
      map,
      originalNames
    });
  }

  const cached = agentMapCache.get(env as Record<string, unknown>)!;
  const namespace = cached.map[routingInfo.agentName];

  if (!namespace) {
    // Provide helpful error message listing available agents
    const availableAgents = cached.originalNames.join(", ");
    throw new Error(
      `Agent namespace '${routingInfo.agentName}' not found in environment. Available agents: ${availableAgents}`
    );
  }

  const agent = await getAgentByName(
    namespace as unknown as DurableObjectNamespace<Agent<Env>>,
    routingInfo.agentId
  );

  // Use an RpcTarget bridge instead of bare closures so the runtime
  // can cleanly tear down the bidirectional session after _onEmail returns
  const bridge = new EmailBridge(email);

  await agent._onEmail({
    from: email.from,
    to: email.to,
    headers: email.headers,
    rawSize: email.rawSize,
    _secureRouted: routingInfo._secureRouted,
    _bridge: bridge
  });
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

  private _send(response: RPCResponse): boolean {
    const facetSent = sendFacetStreamingResponse(this, response);
    if (facetSent !== null) return facetSent;
    return sendRpcResponseIfOpen(this._connection, response);
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
    return this._send(response);
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
    return this._send(response);
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
    return this._send(response);
  }
}
