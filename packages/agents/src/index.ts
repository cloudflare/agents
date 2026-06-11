import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
  type AgentEmail
} from "./internal_context";
export { __DO_NOT_USE_WILL_BREAK__agentContext } from "./internal_context";
import { parseSubAgentPath as _parseSubAgentPath } from "./sub-routing";
export {
  routeSubAgentRequest,
  getSubAgentByName,
  parseSubAgentPath,
  SUB_PREFIX
} from "./sub-routing";
export type { SubAgentPathMatch } from "./sub-routing";

import type {
  Prompt,
  Resource,
  ServerCapabilities,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import { nanoid } from "nanoid";
import { EmailMessage } from "cloudflare:email";
import { RpcTarget } from "cloudflare:workers";
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
export { camelCaseToKebabCase } from "./utils";
import { type RetryOptions, tryN, validateRetryOptions } from "./retries";
import { MCPClientManager } from "./mcp/client";
import type {
  WorkflowCallback,
  RunWorkflowOptions,
  WorkflowEventPayload,
  WorkflowInfo,
  WorkflowQueryCriteria,
  WorkflowPage
} from "./workflow-types";
import { MCPConnectionState } from "./mcp/client-connection";
import {
  DurableObjectOAuthClientProvider,
  type AgentMcpOAuthProvider
} from "./mcp/do-oauth-client-provider";
import type { TransportType } from "./mcp/types";
import {
  genericObservability,
  type Observability,
  type ObservabilityEvent
} from "./observability";
import { DisposableStore, toDisposable } from "./core/events";
import type { Disposable } from "./core/events";
import type {
  FiberContext,
  StartFiberOptions,
  FiberInspection,
  StartFiberResult,
  FiberRecoveryResult,
  ListFibersOptions,
  DeleteFibersOptions,
  FiberRecoveryContext,
  FiberRecoveryHandler,
  HostMigration,
  HostEvent,
  TimerHandler,
  KvHost,
  DiagnosticBundle,
  AgentHost
} from "./core/host";
import { StorageKv } from "./core/kv";
import { AgentQueue } from "./capabilities/queue";
import { AgentEmailCapability } from "./capabilities/email";
import { AgentWorkflows } from "./capabilities/workflows";
import { AgentScheduler, scheduleOwnerPathKey } from "./capabilities/scheduler";
import type {
  AgentPathStep,
  ScheduleStorageRow
} from "./capabilities/scheduler";
import { AgentMcpServers } from "./capabilities/mcp-servers";
import {
  AgentTools,
  DEFAULT_AGENT_TOOL_REATTACH_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_AGENT_TOOL_REATTACH_MAX_WINDOW_MS
} from "./capabilities/agent-tools";
import type {
  AgentToolRunStorageRow,
  DeferredAgentToolFinish
} from "./capabilities/agent-tools";
import { AgentFibers } from "./capabilities/fibers";
import type { InternalFiberOptions } from "./capabilities/fibers";
import {
  AgentSubAgents,
  logicalNameFromPathV2Identity,
  CF_SUB_AGENT_OUTER_URL_KEY,
  CF_SUB_AGENT_TAGS_KEY,
  SUB_AGENT_OUTER_URL_HEADER
} from "./capabilities/sub-agents";
import type {
  FacetCapableCtx,
  RootFacetRpcSurface,
  SubAgentConnectionBridge,
  SubAgentConnectionMeta,
  StoredSubAgentConnection
} from "./capabilities/sub-agents";
import {
  AgentSyncedState,
  computeStatePersistenceHookMode,
  DEFAULT_STATE
} from "./capabilities/state";
import type { StatePersistenceHookMode } from "./capabilities/state";
import { MessageType } from "./types";
import type { McpAgent } from "./mcp";
import type {
  AgentToolChildAdapter,
  AgentToolInterruptedReason,
  AgentToolLifecycleResult,
  AgentToolRunInfo,
  AgentToolRunStatus,
  AgentToolStoredChunk,
  ChatCapableAgentClass,
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
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolRunState,
  AgentToolRunStatus,
  AgentToolStoredChunk,
  AgentToolTerminalStatus,
  ChatCapableAgentClass,
  RunAgentToolOptions,
  RunAgentToolResult
} from "./agent-tool-types";

export type {
  Connection,
  ConnectionContext,
  RoutingRetryOptions,
  WSMessage
} from "partyserver";
export { MessageType } from "./types";

/**
 * Structural type for Cloudflare's `send_email` binding.
 * Accepts both raw MIME messages and structured builder objects.
 */
export type EmailSendBinding = {
  send(
    message:
      | EmailMessage
      | {
          from: string | { email: string; name?: string };
          to: string | string[];
          subject: string;
          replyTo?: string | { email: string; name?: string };
          cc?: string | string[];
          bcc?: string | string[];
          headers?: Record<string, string>;
          text?: string;
          html?: string;
        }
  ): Promise<EmailSendResult>;
};

/**
 * Options for Agent.sendEmail()
 */
export type SendEmailOptions = {
  binding: EmailSendBinding;
  to: string | string[];
  from: string | { email: string; name?: string };
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string | { email: string; name?: string };
  cc?: string | string[];
  bcc?: string | string[];
  inReplyTo?: string;
  headers?: Record<string, string>;
  secret?: string;
};

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

// ── Sub-agent (facet) types ──────────────────────────────────────────
// The internal facet plumbing types (`FacetCapableCtx`,
// `SubAgentConnectionMeta`, the connection bridge classes, and the
// `RootFacetRpcSurface` RPC contract) live in capabilities/sub-agents.ts
// with the rest of the sub-agents capability and are imported above.

/**
 * Constructor type for a sub-agent class.
 * Used by {@link Agent.subAgent} to reference the child class
 * via `ctx.exports`.
 *
 * The class name (`cls.name`) must match the export name in the
 * worker entry point — re-exports under a different name
 * (e.g. `export { Foo as Bar }`) are not supported.
 */
export type SubAgentClass<T extends Agent = Agent> = {
  new (ctx: DurableObjectState, env: never): T;
};

/**
 * Wraps `T` in a `Promise` unless it already is one.
 */
type Promisify<T> = T extends Promise<unknown> ? T : Promise<T>;

/**
 * A typed RPC stub for a sub-agent. Exposes all public instance methods
 * as callable RPC methods with Promise-wrapped return types.
 *
 * Methods inherited from `Agent` / `Server` / `DurableObject` internals
 * are excluded — only user-defined methods on the subclass are exposed.
 */
export type SubAgentStub<T extends Agent> = {
  [K in keyof T as K extends keyof Agent
    ? never
    : T[K] extends (...args: never[]) => unknown
      ? K
      : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promisify<R>
    : never;
};

/**
 * Decorator that marks a method as callable by clients
 * @param metadata Optional metadata about the callable method
 */
export function callable(metadata: CallableMetadata = {}) {
  return function callableDecorator<This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    _context: ClassMethodDecoratorContext
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
  retry?: RetryOptions;
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
  /** Retry options for callback execution */
  retry?: RetryOptions;
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

type FacetRunStorageRow = {
  owner_path: string;
  owner_path_key: string;
  run_id: string;
  created_at: number;
};

export type ScheduleCriteria = {
  id?: string;
  type?: "scheduled" | "delayed" | "cron" | "interval";
  timeRange?: { start?: Date; end?: Date };
};

// The `RootFacetRpcSurface` RPC contract (root-side alarm/schedule/
// teardown/WebSocket-bridge delegation for facets) lives in
// capabilities/sub-agents.ts and is imported above.

// Fiber types live in core/host.ts (the Layer-0 host capability seam —
// see design/rfc-modular-architecture.md) and are re-exported here so the
// public `agents` API is unchanged. The host capability interfaces are
// exported alongside them: they are the narrow seams framework modules
// (and customer harnesses) are written against.
export type {
  FiberContext,
  FiberStatus,
  StartFiberOptions,
  FiberInspection,
  StartFiberResult,
  FiberRecoveryResult,
  ListFibersOptions,
  DeleteFibersOptions,
  FiberRecoveryContext,
  FiberRecoveryHandler,
  InterruptionReason,
  SqlValue,
  HostMigration,
  HostEvent,
  TimerHandler,
  HostConnectionInfo,
  DiagnosticBundle,
  SqlHost,
  KvHost,
  TimerHost,
  LifetimeHost,
  FiberHost,
  EventHost,
  ConnectionHost,
  DiagnosticsHost,
  AgentHost
} from "./core/host";

// The fiber ledger row shape (`FiberLedgerRow`), the fiber ALS context,
// and `InternalFiberOptions` live in capabilities/fibers.ts with the
// rest of the fibers capability.

export type { TransportType } from "./mcp/types";
export type { RetryOptions } from "./retries";
export { normalizeServerId, MCP_SERVER_ID_MAX_LENGTH } from "./mcp/client";
export {
  DurableObjectOAuthClientProvider,
  type AgentMcpOAuthProvider,
  /** @deprecated Use {@link AgentMcpOAuthProvider} instead. */
  type AgentsOAuthProvider
} from "./mcp/do-oauth-client-provider";

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
  client?: ConstructorParameters<typeof Client>[1];
  /** Transport options */
  transport?: {
    /** Custom headers for authentication (e.g., bearer tokens, CF Access) */
    headers?: HeadersInit;
    /** Transport type: "sse", "streamable-http", or "auto" (default) */
    type?: TransportType;
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
// The runFiber-recovery backoff constants (`FIBER_RECOVERY_*`) live in
// capabilities/fibers.ts with the recovery-alarm candidate computation.
// The agent-tool re-attach defaults (`DEFAULT_AGENT_TOOL_REATTACH_*`) live in
// capabilities/agent-tools.ts and are imported above — they are still
// referenced by `DEFAULT_AGENT_STATIC_OPTIONS` below.
// The sub-agent identity versioning constants and helpers
// (`SUB_AGENT_IDENTITY_*`, `pathV2IdentityName`,
// `logicalNameFromPathV2Identity`) live in capabilities/sub-agents.ts.

/**
 * Schema version for the Agent's internal SQLite tables.
 * Bump this when adding new tables, columns, or migrations.
 * The constructor stores this as a row in cf_agents_state and checks it
 * on wake to skip DDL on established DOs.
 */
const CURRENT_SCHEMA_VERSION = 9;

const SCHEMA_VERSION_ROW_ID = "cf_schema_version";
// Legacy key — no longer written, but read for backward compatibility with
// DOs that were created before the single-row state optimization.
// (The user-facing state row id lives in capabilities/state.ts, which owns
// the single-row state record; this file only touches the schema-version
// and legacy-cleanup rows in `_ensureSchema`.)
const STATE_WAS_CHANGED = "cf_state_was_changed";

/**
 * Validate that a stored `parentPath` has the expected shape. Used
 * when restoring from DO storage to guard against corrupted data.
 */
function isValidParentPath(
  value: unknown
): value is Array<{ className: string; name: string }> {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      entry != null &&
      typeof entry === "object" &&
      typeof (entry as { className?: unknown }).className === "string" &&
      typeof (entry as { name?: unknown }).name === "string"
  );
}

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

// `CF_SUB_AGENT_OUTER_URL_KEY`, `CF_SUB_AGENT_TAGS_KEY`, and
// `SUB_AGENT_OUTER_URL_HEADER` live in capabilities/sub-agents.ts and
// are imported above (they are also registered in `CF_INTERNAL_KEYS`).

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
  /** Whether the Agent should hibernate when inactive */
  hibernate: true,
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
  agentToolReattachMaxWindowMs: DEFAULT_AGENT_TOOL_REATTACH_MAX_WINDOW_MS
};

/**
 * Fully resolved agent options — all fields are defined with concrete values.
 */
interface ResolvedAgentOptions {
  hibernate: boolean;
  sendIdentityOnConnect: boolean;
  hungScheduleTimeoutSeconds: number;
  keepAliveIntervalMs: number;
  retry: Required<RetryOptions>;
  fiberRecoveryHookTimeoutMs: number;
  fiberRecoveryScanDeadlineMs: number;
  fiberRecoveryMaxAgeMs: number;
  agentToolReattachNoProgressTimeoutMs: number;
  agentToolReattachMaxWindowMs: number;
}

/**
 * Configuration options for the Agent.
 * Override in subclasses via `static options`.
 * All fields are optional - defaults are applied at runtime.
 * Note: `hibernate` defaults to `true` if not specified.
 */
export interface AgentStaticOptions {
  hibernate?: boolean;
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
}

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
    return agentContext.run(
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
 * The duck-typed slice of an Agent the email capability needs. The email
 * unit tests `Reflect.apply` the prototype methods onto plain objects
 * shaped like this, so the capability is resolved through a module-level
 * factory keyed on `this` rather than an instance field.
 */
type EmailDuck = {
  _ParentClass: { name: string };
  name: string;
  _emit: (
    type: ObservabilityEvent["type"],
    payload: Record<string, unknown>
  ) => void;
  _tryCatch: <T>(fn: () => T | Promise<T>) => Promise<T>;
};

const _emailCapabilities = new WeakMap<object, AgentEmailCapability>();
function _emailCapabilityFor(agent: EmailDuck): AgentEmailCapability {
  let capability = _emailCapabilities.get(agent);
  if (!capability) {
    capability = new AgentEmailCapability({
      agent,
      agentClassName: () => agent._ParentClass.name,
      agentInstanceName: () => agent.name,
      emit: (type, payload) => agent._emit(type, payload),
      tryCatch: agent._tryCatch.bind(agent)
    });
    _emailCapabilities.set(agent, capability);
  }
  return capability;
}

/**
 * Base class for creating Agent implementations
 * @template Env Environment type containing bindings
 * @template State State type to store within the Agent
 */
export class Agent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
>
  extends Server<Env, Props>
  implements AgentHost
{
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
  private _persistenceHookMode: StatePersistenceHookMode = "none";

  /** True when this agent runs as a facet (sub-agent) inside a parent. */
  private _isFacet = false;

  private _protocolBroadcastExcludeIds = new Set<string>();

  // The in-memory sub-agent bridge state (the current connection bridge
  // and the virtual connection map) lives on the `AgentSubAgents`
  // capability instance (capabilities/sub-agents.ts), created once via
  // the cached `_subAgents` getter below. The
  // `_cf_virtualSubAgentConnections` getter re-exposes the map because
  // tests introspect it on the agent instance.

  /** @internal */
  private get _cf_virtualSubAgentConnections(): Map<
    string,
    StoredSubAgentConnection
  > {
    return this._subAgents._cf_virtualSubAgentConnections;
  }

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
  private _parentPath: ReadonlyArray<{ className: string; name: string }> = [];

  /** True while user's onStart() is executing. Used to warn about non-idempotent schedule() calls. */
  private _insideOnStart = false;

  /** Tracks callbacks already warned about during this onStart() to avoid log spam. */
  private _warnedScheduleInOnStart = new Set<string>();

  /** Warn-once guard: `chatRecovery` reassigned during onStart() (too late for wake recovery). */
  private _warnedChatRecoveryInOnStart = false;

  /**
   * Number of active keepAlive() callers. When > 0, `_scheduleNextAlarm()`
   * caps the next alarm at `keepAliveIntervalMs` so the DO stays alive.
   * Purely in-memory — lost on eviction, which is correct because the
   * in-memory work keepAlive was protecting is also lost.
   * @internal
   */
  _keepAliveRefs = 0;

  /**
   * In-memory tokens for keepAlive leases acquired by facets and held
   * on the root alarm owner. Lost on eviction, like `_keepAliveRefs`,
   * because the in-memory work those leases were protecting is also gone.
   * @internal
   */
  private _facetKeepAliveTokens = new Set<string>();

  // The in-memory fiber bookkeeping (active fiber set, managed-fiber
  // abort controllers / executions / terminal waiters, recovery re-entrancy
  // flag, and the no-progress backoff streak) lives on the `AgentFibers`
  // capability instance (capabilities/fibers.ts), created once via the
  // cached `_fibers` getter below.

  private _ParentClass: typeof Agent<Env, State> =
    Object.getPrototypeOf(this).constructor;

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
   * Marker that exists only on real instances — field initializers never
   * run for bare prototypes. The `state` getter checks it so prototype
   * walks that read property values (e.g. `getCallableMethods` doing
   * `prototype[name]`) keep the pre-capability behavior of returning
   * `undefined` instead of lazily creating the synced-state capability
   * and touching SQL without a Durable Object context.
   */
  private _instanceFieldsInitialized = true;

  /**
   * Current state of the Agent
   */
  get state(): State {
    if (!this._instanceFieldsInitialized) {
      // Invoked with `this` = a prototype, not an instance (see field doc).
      return undefined as State;
    }
    return this._syncedState.state;
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
      hibernate:
        ctor.options?.hibernate ?? DEFAULT_AGENT_STATIC_OPTIONS.hibernate,
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
        DEFAULT_AGENT_STATIC_OPTIONS.agentToolReattachMaxWindowMs
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

  // ── Host capabilities (Layer 0 — see src/core/host.ts) ──────────────────
  //
  // The Agent class is the SQL-backed polyfill implementation of the
  // AgentHost capability interfaces. Framework modules and customer
  // harnesses are written against those interfaces, never against the
  // backing tables.

  /**
   * Durable key-value access ({@link KvHost}), backed by Durable Object
   * storage.
   */
  readonly kv: KvHost = new StorageKv(this.ctx.storage);

  private _hostMigrationsTableReady = false;
  private readonly _hostTimerHandlers: Array<{
    prefix: string;
    handler: TimerHandler;
  }> = [];
  private readonly _fiberRecoveryHandlers = new Map<
    string,
    FiberRecoveryHandler
  >();
  private readonly _hostInspectors = new Map<string, () => Promise<unknown>>();

  /**
   * Apply a module's namespaced, idempotent schema migrations. Each
   * migration runs exactly once per agent; applied ids are recorded in a
   * ledger table. Modules own their tables — no module touches another
   * module's tables.
   */
  registerMigrations(namespace: string, migrations: HostMigration[]): void {
    if (!namespace || namespace.trim() === "") {
      throw new Error("registerMigrations: namespace must not be blank");
    }
    this._ensureHostMigrationsTable();
    for (const migration of migrations) {
      const applied = this.sql<{ one: number }>`
        SELECT 1 as one FROM cf_agents_host_migrations
        WHERE namespace = ${namespace} AND id = ${migration.id}
        LIMIT 1
      `;
      if (applied.length > 0) continue;
      migration.apply(this.sql.bind(this));
      this.sql`
        INSERT INTO cf_agents_host_migrations (namespace, id, applied_at)
        VALUES (${namespace}, ${migration.id}, ${Date.now()})
      `;
    }
  }

  private _ensureHostMigrationsTable(): void {
    if (this._hostMigrationsTableReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_host_migrations (
        namespace TEXT NOT NULL,
        id TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, id)
      )
    `;
    this._hostMigrationsTableReady = true;
  }

  /**
   * Set (or replace) a named durable timer ({@link TimerHost}). The
   * polyfill multiplexes named timers over the single physical alarm.
   * `at` is epoch milliseconds.
   */
  async setTimer(key: string, at: number, payload?: unknown): Promise<void> {
    if (!key || key.trim() === "") {
      throw new Error("setTimer: key must not be blank");
    }
    const payloadJson = payload === undefined ? null : JSON.stringify(payload);
    this.sql`
      INSERT INTO cf_agents_host_timers (key, fire_at, payload)
      VALUES (${key}, ${at}, ${payloadJson})
      ON CONFLICT(key) DO UPDATE
      SET fire_at = excluded.fire_at, payload = excluded.payload
    `;
    await this._scheduleNextAlarm();
  }

  /** Cancel a named durable timer. No-op if the key is unknown. */
  async cancelTimer(key: string): Promise<void> {
    this.sql`DELETE FROM cf_agents_host_timers WHERE key = ${key}`;
    await this._scheduleNextAlarm();
  }

  /**
   * Register a handler for named timers under a key prefix (e.g.
   * "chat-recovery:"). A due timer fires the handler owning the longest
   * matching prefix. Handlers must be idempotent: a timer can fire more
   * than once across restarts (the row is only deleted after the handler
   * settles), and a handler error does NOT retry the timer.
   */
  onTimer(prefix: string, handler: TimerHandler): Disposable {
    if (!prefix || prefix.trim() === "") {
      throw new Error("onTimer: prefix must not be blank");
    }
    const entry = { prefix, handler };
    this._hostTimerHandlers.push(entry);
    return toDisposable(() => {
      const index = this._hostTimerHandlers.indexOf(entry);
      if (index >= 0) this._hostTimerHandlers.splice(index, 1);
    });
  }

  private _matchHostTimerHandler(key: string): TimerHandler | undefined {
    let best: { prefix: string; handler: TimerHandler } | undefined;
    for (const entry of this._hostTimerHandlers) {
      if (!key.startsWith(entry.prefix)) continue;
      if (!best || entry.prefix.length > best.prefix.length) best = entry;
    }
    return best?.handler;
  }

  /** @internal Fire all due named timers. Called from `alarm()`. */
  private async _fireDueHostTimers(): Promise<void> {
    const due = this.sql<{
      key: string;
      fire_at: number;
      payload: string | null;
    }>`
      SELECT key, fire_at, payload FROM cf_agents_host_timers
      WHERE fire_at <= ${Date.now()}
      ORDER BY fire_at ASC
    `;
    for (const row of due) {
      if (this._destroyed) return;
      const handler = this._matchHostTimerHandler(row.key);
      if (!handler) {
        // Per the host lifecycle contract handlers register during module
        // init, which has completed by the time alarm() fires — so an
        // unmatched key means the owning module no longer exists in this
        // code version. Drop the row instead of hot-looping the alarm.
        console.warn(
          `[Agent] No onTimer handler matches durable timer "${row.key}"; dropping it.`
        );
        this.emitEvent({ type: "timer:unhandled", payload: { key: row.key } });
        this.sql`
          DELETE FROM cf_agents_host_timers
          WHERE key = ${row.key} AND fire_at = ${row.fire_at}
        `;
        continue;
      }
      let payload: unknown;
      try {
        payload = row.payload === null ? undefined : JSON.parse(row.payload);
      } catch {
        payload = undefined;
      }
      try {
        await handler(row.key, payload);
        this.emitEvent({ type: "timer:fired", payload: { key: row.key } });
      } catch (e) {
        console.error(`[Agent] onTimer handler for "${row.key}" threw:`, e);
        this.emitEvent({
          type: "timer:error",
          payload: {
            key: row.key,
            error: e instanceof Error ? e.message : String(e)
          }
        });
      } finally {
        // Guarded delete: if the handler re-armed the same key the
        // fire_at no longer matches and the new timer survives. If the
        // isolate dies before this line the row survives and the timer
        // re-fires after restart (at-least-once).
        this.sql`
          DELETE FROM cf_agents_host_timers
          WHERE key = ${row.key} AND fire_at = ${row.fire_at}
        `;
      }
    }
  }

  /**
   * Register a fiber recovery handler for a fiber-name namespace
   * ({@link FiberHost}). An interrupted fiber routes to the handler
   * owning the longest matching prefix of its name; registered handlers
   * take precedence over internal framework recovery, and names with no
   * matching handler fall through to `onFiberRecovered`. Handlers are
   * subject to the `fiberRecoveryHookTimeoutMs` option.
   */
  onRecovery(namespace: string, handler: FiberRecoveryHandler): Disposable {
    if (!namespace || namespace.trim() === "") {
      throw new Error("onRecovery: namespace must not be blank");
    }
    if (this._fiberRecoveryHandlers.has(namespace)) {
      throw new Error(
        `onRecovery: a handler is already registered for namespace "${namespace}"`
      );
    }
    this._fiberRecoveryHandlers.set(namespace, handler);
    return toDisposable(() => this._fiberRecoveryHandlers.delete(namespace));
  }

  private _matchFiberRecoveryHandler(
    name: string
  ): FiberRecoveryHandler | undefined {
    let bestNamespace: string | undefined;
    for (const namespace of this._fiberRecoveryHandlers.keys()) {
      if (!name.startsWith(namespace)) continue;
      if (
        bestNamespace === undefined ||
        namespace.length > bestNamespace.length
      ) {
        bestNamespace = namespace;
      }
    }
    return bestNamespace === undefined
      ? undefined
      : this._fiberRecoveryHandlers.get(bestNamespace);
  }

  /**
   * Emit an observability event ({@link EventHost}). Unlike the typed
   * internal `_emit`, this accepts free-form event types so modules can
   * define their own namespaced events.
   */
  emitEvent(event: HostEvent): void {
    this.observability?.emit({
      type: event.type,
      agent: this._ParentClass.name,
      name: this.name,
      payload: event.payload ?? {},
      timestamp: Date.now()
    } as ObservabilityEvent);
  }

  /**
   * Register a read-only diagnostics inspector for a namespace
   * ({@link DiagnosticsHost}). Its return value appears in
   * `diagnostics().views[namespace]`.
   */
  registerInspector(namespace: string, fn: () => Promise<unknown>): Disposable {
    if (!namespace || namespace.trim() === "") {
      throw new Error("registerInspector: namespace must not be blank");
    }
    if (this._hostInspectors.has(namespace)) {
      throw new Error(
        `registerInspector: an inspector is already registered for namespace "${namespace}"`
      );
    }
    this._hostInspectors.set(namespace, fn);
    return toDisposable(() => this._hostInspectors.delete(namespace));
  }

  /**
   * Produce a read-only diagnostic bundle: host-level views (pending
   * timers, fiber ledger) plus every registered inspector's view.
   * Scrubbed by default — pass `{ scrub: false }` to include payloads
   * and snapshots.
   */
  async diagnostics(opts?: { scrub?: boolean }): Promise<DiagnosticBundle> {
    const scrub = opts?.scrub ?? true;
    const views: Record<string, unknown> = {};

    const timers = this.sql<{
      key: string;
      fire_at: number;
      payload: string | null;
    }>`
      SELECT key, fire_at, payload FROM cf_agents_host_timers
      ORDER BY fire_at ASC
    `;
    views["host:timers"] = timers.map((timer) => ({
      key: timer.key,
      fireAt: timer.fire_at,
      ...(scrub ? {} : { payload: timer.payload })
    }));

    const fibers = await this.listFibers();
    views["host:fibers"] = fibers.map((fiber) =>
      scrub
        ? {
            fiberId: fiber.fiberId,
            name: fiber.name,
            status: fiber.status,
            createdAt: fiber.createdAt,
            startedAt: fiber.startedAt,
            settledAt: fiber.settledAt
          }
        : fiber
    );

    for (const [namespace, inspect] of this._hostInspectors) {
      try {
        views[namespace] = await inspect();
      } catch (e) {
        views[namespace] = {
          error: e instanceof Error ? e.message : String(e)
        };
      }
    }

    return { generatedAt: Date.now(), views };
  }

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
          created_at INTEGER DEFAULT (unixepoch()),
          execution_started_at INTEGER,
          retry_options TEXT,
          owner_path TEXT,
          owner_path_key TEXT
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
      addColumnIfNotExists(
        "ALTER TABLE cf_agents_schedules ADD COLUMN retry_options TEXT"
      );
      addColumnIfNotExists(
        "ALTER TABLE cf_agents_schedules ADD COLUMN owner_path TEXT"
      );
      addColumnIfNotExists(
        "ALTER TABLE cf_agents_schedules ADD COLUMN owner_path_key TEXT"
      );
      addColumnIfNotExists(
        "ALTER TABLE cf_agents_queues ADD COLUMN retry_options TEXT"
      );

      // Migration: Update CHECK constraint on type column to include 'interval'.
      // SQLite doesn't support ALTER TABLE to modify constraints, so we recreate
      // the table when the old constraint is detected.
      {
        const rows = this.ctx.storage.sql
          .exec(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='cf_agents_schedules'"
          )
          .toArray();
        if (rows.length > 0) {
          const ddl = String(rows[0].sql);
          if (!ddl.includes("'interval'")) {
            // Drop any leftover temp table from a previous partial migration
            this.ctx.storage.sql.exec(
              "DROP TABLE IF EXISTS cf_agents_schedules_new"
            );
            this.ctx.storage.sql.exec(`
              CREATE TABLE cf_agents_schedules_new (
                id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
                callback TEXT,
                payload TEXT,
                type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
                time INTEGER,
                delayInSeconds INTEGER,
                cron TEXT,
                intervalSeconds INTEGER,
                running INTEGER DEFAULT 0,
                created_at INTEGER DEFAULT (unixepoch()),
                execution_started_at INTEGER,
                retry_options TEXT,
                owner_path TEXT,
                owner_path_key TEXT
              )
            `);
            this.ctx.storage.sql.exec(`
              INSERT INTO cf_agents_schedules_new
                (id, callback, payload, type, time, delayInSeconds, cron,
                 intervalSeconds, running, created_at, execution_started_at, retry_options,
                 owner_path, owner_path_key)
              SELECT id, callback, payload, type, time, delayInSeconds, cron,
                     intervalSeconds, running, created_at, execution_started_at, retry_options,
                     owner_path, owner_path_key
              FROM cf_agents_schedules
            `);
            this.ctx.storage.sql.exec("DROP TABLE cf_agents_schedules");
            this.ctx.storage.sql.exec(
              "ALTER TABLE cf_agents_schedules_new RENAME TO cf_agents_schedules"
            );
          }
        }
      }

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

      // v2: keepAlive no longer uses schedule rows. Remove any orphaned
      // heartbeat schedules left over from the previous implementation.
      if (schemaVersion < 2) {
        this.ctx.storage.sql.exec(
          "DELETE FROM cf_agents_schedules WHERE callback = '_cf_keepAliveHeartbeat'"
        );
      }

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

      this.sql`
        CREATE TABLE IF NOT EXISTS cf_agent_tool_runs (
          run_id TEXT PRIMARY KEY,
          parent_tool_call_id TEXT,
          agent_type TEXT NOT NULL,
          input_preview TEXT,
          input_redacted INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          summary TEXT,
          output_json TEXT,
          error_message TEXT,
          interrupted_reason TEXT,
          child_still_running INTEGER,
          display_metadata TEXT,
          display_order INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER NOT NULL,
          completed_at INTEGER
        )
      `;

      this.sql`
        CREATE INDEX IF NOT EXISTS idx_agent_tool_runs_parent_tool_call_id
        ON cf_agent_tool_runs(parent_tool_call_id, display_order)
      `;

      addColumnIfNotExists(
        "ALTER TABLE cf_agent_tool_runs ADD COLUMN output_json TEXT"
      );
      // #1630 follow-up: persist the typed interrupted cause so it survives a
      // reconnect replay (otherwise live clients see `reason`/`childStillRunning`
      // but reconnecting clients replay them as `undefined`).
      addColumnIfNotExists(
        "ALTER TABLE cf_agent_tool_runs ADD COLUMN interrupted_reason TEXT"
      );
      addColumnIfNotExists(
        "ALTER TABLE cf_agent_tool_runs ADD COLUMN child_still_running INTEGER"
      );

      // Mark schema as up-to-date
      this.sql`
        INSERT OR REPLACE INTO cf_agents_state (id, state)
        VALUES (${SCHEMA_VERSION_ROW_ID}, ${String(CURRENT_SCHEMA_VERSION)})
      `;
    }
  }

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    if (!wrappedClasses.has(this.constructor)) {
      // Auto-wrap custom methods with agent context
      this._autoWrapCustomMethods();
      wrappedClasses.add(this.constructor);
    }

    this._ensureSchema();

    // TimerHost polyfill table — managed through the namespaced host
    // migration ledger rather than the legacy versioned schema, so it
    // doubles as the first consumer of registerMigrations().
    this.registerMigrations("cf:host:timers", [
      {
        id: "001-create-timers-table",
        apply: (sql) => {
          sql`
            CREATE TABLE IF NOT EXISTS cf_agents_host_timers (
              key TEXT PRIMARY KEY NOT NULL,
              fire_at INTEGER NOT NULL,
              payload TEXT
            )
          `;
        }
      }
    ]);

    // Initialize MCPClientManager AFTER tables are created
    this.mcp = new MCPClientManager(this._ParentClass.name, "0.0.1", {
      storage: this.ctx.storage,
      createAuthProvider: (callbackUrl) =>
        this.createMcpOAuthProvider(callbackUrl)
    });

    // Broadcast server state whenever MCP state changes (register, connect, OAuth, remove, etc.)
    this._disposables.add(
      this.mcp.onServerStateChanged(async () => {
        this._mcpServers.broadcast();
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
    this._persistenceHookMode = computeStatePersistenceHookMode(
      this,
      Agent.prototype
    );

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = (request: Request) => {
      return agentContext.run(
        { agent: this, connection: undefined, request, email: undefined },
        async () => {
          // Handle MCP OAuth callback if this is one
          const oauthResponse =
            await this._mcpServers.handleOAuthCallback(request);
          if (oauthResponse) {
            return oauthResponse;
          }

          return this._tryCatch(() => _onRequest(request));
        }
      );
    };

    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (await this._cf_forwardSubAgentWebSocketMessage(connection, message)) {
        return;
      }
      this._ensureConnectionWrapped(connection);
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

              const metadata = callableMetadata.get(methodFn as Function);

              // For streaming methods, pass a StreamingResponse object
              if (metadata?.streaming) {
                const stream = new StreamingResponse(connection, id);

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
      if (
        await this._cf_forwardSubAgentWebSocketConnect(
          connection,
          ctx.request,
          {
            gate: false
          }
        )
      ) {
        return;
      }
      // TODO: This is a hack to ensure the state is sent after the connection is established
      // must fix this
      return agentContext.run(
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
          await this._replayAgentToolRuns(connection);
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
      if (
        await this._cf_forwardSubAgentWebSocketClose(
          connection,
          code,
          reason,
          wasClean
        )
      ) {
        return;
      }
      return agentContext.run(
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
    this.onStart = async (props?: Props) => {
      return agentContext.run(
        {
          agent: this,
          connection: undefined,
          request: undefined,
          email: undefined
        },
        async () => {
          // Hydrate _isFacet from persistent storage so the flag
          // survives hibernation (the DO constructor resets it to false).
          const isFacet =
            await this.ctx.storage.get<boolean>("cf_agents_is_facet");
          if (isFacet) this._isFacet = true;

          const storedFacetName = await this.ctx.storage.get<string>(
            "cf_agents_facet_name"
          );
          if (typeof storedFacetName === "string") {
            this._facetName = storedFacetName;
          }

          const storedParentPath = await this.ctx.storage.get<
            Array<{ className: string; name: string }>
          >("cf_agents_parent_path");
          if (isValidParentPath(storedParentPath)) {
            this._parentPath = storedParentPath;
          }
          try {
            await this._cf_hydrateSubAgentConnectionsFromRoot();
          } catch (error) {
            console.warn(
              "[Agent] Unable to hydrate sub-agent WebSocket connections:",
              error
            );
          }

          await this._tryCatch(async () => {
            await this.mcp.restoreConnectionsFromStorage(this.name);
            await this._restoreRpcMcpServers();
            this._mcpServers.broadcast();

            this._checkOrphanedWorkflows();
            await this._checkRunFibers();
            const startupAgentToolRunIds = this._agentToolRunRecoveryRunIds();

            // Chat recovery (above, in `_checkRunFibers`) evaluates its budgets
            // — and may seal an interrupted turn, firing `onExhausted` — BEFORE
            // the user's onStart runs. So a `chatRecovery` config produced
            // inside onStart is applied too late for the recovery that matters.
            // Snapshot the reference (subclasses like Think / AIChatAgent expose
            // `chatRecovery`; plain Agents leave it undefined) so we can warn if
            // onStart swaps in a custom config object below.
            const chatRecoveryBefore = (this as { chatRecovery?: unknown })
              .chatRecovery;

            this._insideOnStart = true;
            this._warnedScheduleInOnStart.clear();
            let result: Awaited<ReturnType<typeof _onStart>>;
            try {
              result = await _onStart(props);
            } finally {
              this._insideOnStart = false;
            }

            const chatRecoveryAfter = (this as { chatRecovery?: unknown })
              .chatRecovery;
            // Warn when onStart swaps in a recovery config that would have
            // mattered: a custom config object OR `chatRecovery = true`
            // (enabling recovery / its defaults too late). Setting `false`
            // (disabling) is intentionally NOT warned — recovery already ran
            // with the pre-onStart value, so disabling here is a benign no-op
            // for the wake that just happened, not the silent-misconfig bug.
            const chatRecoveryAfterMatters =
              (typeof chatRecoveryAfter === "object" &&
                chatRecoveryAfter !== null) ||
              chatRecoveryAfter === true;
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

            this._scheduleAgentToolRunRecovery({
              runIds: startupAgentToolRunIds
            });
            return result;
          });
        }
      );
    };
  }

  /**
   * Check for workflows referencing unknown bindings and warn with migration suggestion.
   */
  private _checkOrphanedWorkflows(): void {
    this._workflows.checkOrphaned();
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

  // ── Synced state (delegates to capabilities/state.ts) ────────────────────

  private _syncedStateCap?: AgentSyncedState<State>;
  private get _syncedState(): AgentSyncedState<State> {
    this._syncedStateCap ??= new AgentSyncedState<State>({
      agent: this,
      sql: this.sql.bind(this),
      broadcastProtocol: (msg, excludeIds) =>
        this._broadcastProtocol(msg, excludeIds),
      emitStateUpdate: () => this._emit("state:update"),
      hookMode: () => this._persistenceHookMode,
      waitUntil: (promise) => this.ctx.waitUntil(promise)
    });
    return this._syncedStateCap;
  }

  private _setStateInternal(
    nextState: State,
    source: Connection | "server" = "server"
  ): void {
    this._syncedState.setStateInternal(nextState, source);
  }

  /**
   * Update the Agent's state
   * @param state New state to set
   * @throws Error if called from a readonly connection context
   */
  setState(state: State): void {
    this._syncedState.setState(state);
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

    // Determine whether `state` is an accessor (getter) or a data property.
    // partyserver always defines `state` as a getter via Object.defineProperties,
    // but we handle the data-property case to stay robust for hibernate: false
    // and any future connection implementations.
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
   * Called when the Agent receives an email via routeAgentEmail()
   * Override this method to handle incoming emails
   * @param payload Internal wire format — plain data + RpcTarget bridge
   */
  // ── Email (delegates to capabilities/email.ts) ──────────────────────────

  _onEmail(payload: {
    from: string;
    to: string;
    headers: Headers;
    rawSize: number;
    _secureRouted?: boolean;
    _bridge: EmailBridge;
  }) {
    // nb: we use this roundabout way of getting to onEmail
    // because of https://github.com/cloudflare/workerd/issues/4499
    return _emailCapabilityFor(this as unknown as EmailDuck).dispatchInbound(
      payload
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
  replyToEmail(
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
    return _emailCapabilityFor(this as unknown as EmailDuck).reply(
      email,
      options
    );
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
  sendEmail(options: SendEmailOptions): Promise<EmailSendResult> {
    return _emailCapabilityFor(this as unknown as EmailDuck).send(options);
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
        /* oxlint-disable @typescript-eslint/no-explicit-any -- dynamic method wrapping requires any */
        const wrappedFunction = withAgentContext(
          this[methodName as keyof this] as (...args: any[]) => any
        ) as any;
        /* oxlint-enable @typescript-eslint/no-explicit-any */

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
  // ── Task queue (delegates to capabilities/queue.ts) ──────────────────────

  private _queueCap?: AgentQueue;
  private get _queue(): AgentQueue {
    this._queueCap ??= new AgentQueue({
      agent: this,
      sql: this.sql.bind(this),
      emit: (type, payload) => this._emit(type, payload),
      retryDefaults: () => this._resolvedOptions.retry,
      onError: (e) => this.onError(e)
    });
    return this._queueCap;
  }

  /**
   * Queue a task to be executed in the future
   * @param callback Name of the method to call
   * @param payload Payload to pass to the callback
   * @param options Options for the queued task
   * @param options.retry Retry options for the callback execution
   * @returns The ID of the queued task
   */
  queue<T = unknown>(
    callback: keyof this,
    payload: T,
    options?: { retry?: RetryOptions }
  ): Promise<string> {
    // Return the capability's promise directly (no extra async layer):
    // callers that `await queue()` then synchronously inspect the queue
    // race against the background flush, and extra microtask ticks here
    // change which side wins.
    return this._queue.enqueue(callback as string, payload, options);
  }

  /**
   * Dequeue a task by ID
   * @param id ID of the task to dequeue
   */
  dequeue(id: string) {
    this._queue.dequeue(id);
  }

  /**
   * Dequeue all tasks
   */
  dequeueAll() {
    this._queue.dequeueAll();
  }

  /**
   * Dequeue all tasks by callback
   * @param callback Name of the callback to dequeue
   */
  dequeueAllByCallback(callback: string) {
    this._queue.dequeueAllByCallback(callback);
  }

  /**
   * Get a queued task by ID
   * @param id ID of the task to get
   * @returns The task or undefined if not found
   */
  getQueue(id: string): QueueItem<string> | undefined {
    return this._queue.get(id);
  }

  /**
   * Get all queues by key and value
   * @param key Key to filter by
   * @param value Value to filter by
   * @returns Array of matching QueueItem objects
   */
  getQueues(key: string, value: string): QueueItem<string>[] {
    return this._queue.getAll(key, value);
  }

  private _facetRunRowsForPrefix(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): FacetRunStorageRow[] {
    const rows = this.sql<FacetRunStorageRow>`
      SELECT owner_path, owner_path_key, run_id, created_at
      FROM cf_agents_facet_runs
    `;
    return rows.filter((row) => {
      try {
        const rowOwnerPath = JSON.parse(row.owner_path) as AgentPathStep[];
        return this._isSameAgentPathPrefix(ownerPath, rowOwnerPath);
      } catch {
        return false;
      }
    });
  }

  private _deleteFacetRunRowsForPrefix(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): void {
    for (const row of this._facetRunRowsForPrefix(ownerPath)) {
      this.sql`
        DELETE FROM cf_agents_facet_runs
        WHERE owner_path_key = ${row.owner_path_key}
          AND run_id = ${row.run_id}
      `;
    }
  }

  private async _rootAlarmOwner(): Promise<RootFacetRpcSurface> {
    const root = this._parentPath[0];
    if (!root) {
      throw new Error("Facet scheduler delegation requires a root parent.");
    }

    const ctx = this.ctx as unknown as Partial<FacetCapableCtx>;
    const binding = ctx.exports?.[root.className] as
      | DurableObjectNamespace
      | undefined;
    if (!binding) {
      throw new Error(
        `Unable to resolve root scheduler "${root.className}" for sub-agent schedule delegation.`
      );
    }

    return (await getServerByName<Cloudflare.Env, Agent>(
      binding as unknown as DurableObjectNamespace<Agent>,
      root.name
    )) as unknown as RootFacetRpcSurface;
  }

  private _validateScheduleCallback(
    when: Date | string | number,
    callback: keyof this,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): asserts callback is Extract<keyof this, string> {
    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }

    if (typeof this[callback] !== "function") {
      throw new Error(`this.${callback} is not a function`);
    }

    if (options?.retry) {
      validateRetryOptions(options.retry, this._resolvedOptions.retry);
    }

    if (
      this._insideOnStart &&
      options?.idempotent === undefined &&
      typeof when !== "string" &&
      !this._warnedScheduleInOnStart.has(callback)
    ) {
      this._warnedScheduleInOnStart.add(callback);
      console.warn(
        `schedule("${callback}") called inside onStart() without { idempotent: true }. ` +
          `This creates a new row on every Durable Object restart, which can cause ` +
          `duplicate executions. Pass { idempotent: true } to deduplicate, or use ` +
          `scheduleEvery() for recurring tasks.`
      );
    }
  }

  // ── Scheduling (delegates to capabilities/scheduler.ts) ──────────────────

  private _schedulerCap?: AgentScheduler;
  private get _scheduler(): AgentScheduler {
    this._schedulerCap ??= new AgentScheduler({
      agent: this,
      sql: this.sql.bind(this),
      rawSql: (query, ...params) => this.ctx.storage.sql.exec(query, ...params),
      emit: (type, payload) => this._emit(type, payload),
      retryDefaults: () => this._resolvedOptions.retry,
      hungScheduleTimeoutSeconds: () =>
        this._resolvedOptions.hungScheduleTimeoutSeconds,
      validateScheduleCallback: (when, callback, options) =>
        this._validateScheduleCallback(when, callback as keyof this, options),
      isFacet: () => this._isFacet,
      selfPath: () => this.selfPath,
      rootAlarmOwner: () => this._rootAlarmOwner(),
      isSameAgentPathPrefix: (prefix, path) =>
        this._isSameAgentPathPrefix(prefix, path),
      dispatchFacetCallback: (ownerPath, row) =>
        this._cf_dispatchScheduledCallback(ownerPath, row),
      scheduleNextAlarm: () => this._scheduleNextAlarm(),
      isDestroyed: () => this._destroyed,
      onError: (e) => this.onError(e)
    });
    return this._schedulerCap;
  }

  /**
   * Insert a schedule row owned by a descendant facet. Called via RPC
   * from the facet's `schedule()`. Returns `{ schedule, created }`
   * so the originating facet can suppress `schedule:create` on
   * idempotent dedup. This method does not emit observability
   * events itself.
   * @internal
   */
  _cf_scheduleForFacet<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep>,
    when: Date | string | number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    return this._scheduler.insertForOwner(
      ownerPath,
      when,
      callback,
      payload,
      options
    );
  }

  /**
   * Insert an interval schedule row owned by a descendant facet.
   * Called via RPC from the facet's `scheduleEvery()`. Returns
   * `{ schedule, created }` so the originating facet can suppress
   * `schedule:create` on idempotent dedup. This method does not
   * emit observability events itself.
   * @internal
   */
  _cf_scheduleEveryForFacet<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep>,
    intervalSeconds: number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; _idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    return this._scheduler.insertIntervalForOwner(
      ownerPath,
      intervalSeconds,
      callback,
      payload,
      options
    );
  }

  /**
   * Cancel a schedule row owned by a descendant facet, scoped by
   * `owner_path_key` so siblings can't reach each other's rows.
   * Returns the canceled row's callback name so the originating
   * facet can emit `schedule:cancel`. This method does not emit
   * observability events itself.
   * @internal
   */
  _cf_cancelScheduleForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>,
    id: string
  ): Promise<{ ok: boolean; callback?: string }> {
    return this._scheduler.cancelForFacet(ownerPath, id);
  }

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
    this._scheduler.cancelOwnerPrefix(ownerPath);
    this._deleteFacetRunRowsForPrefix(ownerPath);
    await this._scheduleNextAlarm();
  }

  /**
   * Read a single schedule row owned by a descendant facet.
   * @internal
   */
  async _cf_getScheduleForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>,
    id: string
  ): Promise<Schedule<unknown> | undefined> {
    return this._scheduler.getForOwner(ownerPath, id);
  }

  /**
   * List schedule rows owned by a descendant facet, scoped by
   * `owner_path_key` so siblings remain isolated from each other.
   * @internal
   */
  async _cf_listSchedulesForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>,
    criteria: ScheduleCriteria = {}
  ): Promise<Schedule<unknown>[]> {
    return this._scheduler.listForOwner(ownerPath, criteria);
  }

  /**
   * Acquire a root-owned keepAlive ref on behalf of a descendant facet.
   * Facets share the root isolate but cannot set their own physical
   * alarm, so this lets facet work use the root alarm heartbeat.
   * @internal
   */
  async _cf_acquireFacetKeepAlive(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<string> {
    const ownerPathKey = scheduleOwnerPathKey(ownerPath);
    const token = `${ownerPathKey ?? "unknown"}:${nanoid(9)}`;
    this._facetKeepAliveTokens.add(token);
    this._keepAliveRefs++;
    if (this._keepAliveRefs === 1) {
      await this._scheduleNextAlarm();
    }
    return token;
  }

  /**
   * Release a root-owned keepAlive ref previously acquired for a facet.
   * Idempotent so disposer calls can safely race or run twice.
   * @internal
   */
  async _cf_releaseFacetKeepAlive(token: string): Promise<void> {
    if (!this._facetKeepAliveTokens.delete(token)) return;
    this._keepAliveRefs = Math.max(0, this._keepAliveRefs - 1);
    await this._scheduleNextAlarm();
  }

  /**
   * Register a facet's durable run row in the root-side index so root
   * alarm housekeeping can dispatch recovery checks into idle facets.
   * The facet remains authoritative for snapshots and recovery hooks.
   * @internal
   */
  async _cf_registerFacetRun(
    ownerPath: ReadonlyArray<AgentPathStep>,
    runId: string
  ): Promise<void> {
    const ownerPathJson = JSON.stringify(ownerPath);
    const ownerPathKey = scheduleOwnerPathKey(ownerPath);
    if (!ownerPathKey) {
      throw new Error("_cf_registerFacetRun requires a non-empty owner path.");
    }
    this.sql`
      INSERT OR REPLACE INTO cf_agents_facet_runs
        (owner_path, owner_path_key, run_id, created_at)
      VALUES
        (${ownerPathJson}, ${ownerPathKey}, ${runId}, ${Date.now()})
    `;
    await this._scheduleNextAlarm();
  }

  /**
   * Remove a completed facet fiber from the root-side index.
   * @internal
   */
  async _cf_unregisterFacetRun(
    ownerPath: ReadonlyArray<AgentPathStep>,
    runId: string
  ): Promise<void> {
    const ownerPathKey = scheduleOwnerPathKey(ownerPath);
    this.sql`
      DELETE FROM cf_agents_facet_runs
      WHERE owner_path_key IS ${ownerPathKey}
        AND run_id = ${runId}
    `;
    await this._scheduleNextAlarm();
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
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<Schedule<T>> {
    return this._scheduler.schedule<T>(
      when,
      callback as string,
      payload,
      options
    );
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
    return this._scheduler.scheduleEvery<T>(
      intervalSeconds,
      callback as string,
      payload,
      options
    );
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
    return this._scheduler.getSchedule<T>(id);
  }

  /**
   * Get a scheduled task by ID.
   *
   * Unlike the deprecated synchronous {@link getSchedule}, this works inside
   * sub-agents by delegating to the top-level parent that owns the alarm.
   *
   * @template T Type of the payload data
   * @param id ID of the scheduled task
   * @returns The Schedule object or undefined if not found
   */
  getScheduleById(id: string): Promise<Schedule<unknown> | undefined> {
    return this._scheduler.getScheduleById(id);
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
    return this._scheduler.getSchedules<T>(criteria);
  }

  /**
   * List scheduled tasks matching the given criteria.
   *
   * Unlike the deprecated synchronous {@link getSchedules}, this works inside
   * sub-agents by delegating to the top-level parent that owns the alarm.
   *
   * @template T Type of the payload data
   * @param criteria Criteria to filter schedules
   * @returns Array of matching Schedule objects
   */
  listSchedules(criteria: ScheduleCriteria = {}): Promise<Schedule<unknown>[]> {
    return this._scheduler.listSchedules(criteria);
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
    return this._scheduler.cancelSchedule(id);
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
      await this._scheduleNextAlarm();
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
          this._scheduleNextAlarm().catch((e) => {
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

  // ── Fibers (delegates to capabilities/fibers.ts) ──────────────────────────

  private _fibersCap?: AgentFibers;
  private get _fibers(): AgentFibers {
    this._fibersCap ??= new AgentFibers({
      agent: this,
      sql: this.sql.bind(this),
      emit: (type, payload) => this._emit(type, payload),
      fiberRecoveryHookTimeoutMs: () =>
        this._resolvedOptions.fiberRecoveryHookTimeoutMs,
      fiberRecoveryScanDeadlineMs: () =>
        this._resolvedOptions.fiberRecoveryScanDeadlineMs,
      fiberRecoveryMaxAgeMs: () => this._resolvedOptions.fiberRecoveryMaxAgeMs,
      keepAliveIntervalMs: () => this._resolvedOptions.keepAliveIntervalMs,
      matchRecoveryHandler: (name) => this._matchFiberRecoveryHandler(name),
      isFacet: () => this._isFacet,
      selfPath: () => this.selfPath,
      rootAlarmOwner: () => this._rootAlarmOwner()
    });
    return this._fibersCap;
  }

  /**
   * Consecutive runFiber-recovery scans that made NO forward progress
   * while work was still pending. Owned by the fibers capability; kept
   * readable here because tests introspect it.
   * @internal
   */
  private get _recoveryNoProgressScans(): number {
    return this._fibers._recoveryNoProgressScans;
  }

  inspectFiber(fiberId: string): Promise<FiberInspection | null> {
    return this._fibers.inspectFiber(fiberId);
  }

  inspectFiberByKey(idempotencyKey: string): Promise<FiberInspection | null> {
    return this._fibers.inspectFiberByKey(idempotencyKey);
  }

  listFibers(options?: ListFibersOptions): Promise<FiberInspection[]> {
    return this._fibers.listFibers(options);
  }

  cancelFiber(fiberId: string, reason?: string): Promise<boolean> {
    return this._fibers.cancelFiber(fiberId, reason);
  }

  cancelFiberByKey(idempotencyKey: string, reason?: string): Promise<boolean> {
    return this._fibers.cancelFiberByKey(idempotencyKey, reason);
  }

  resolveFiber(fiberId: string, result: FiberRecoveryResult): Promise<boolean> {
    return this._fibers.resolveFiber(fiberId, result);
  }

  deleteFibers(options?: DeleteFibersOptions): Promise<number> {
    return this._fibers.deleteFibers(options);
  }

  // ── Fibers: durable execution ───────────────────────────────────────

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
  runFiber<T>(name: string, fn: (ctx: FiberContext) => Promise<T>): Promise<T> {
    return this._fibers.runFiber(name, fn);
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
  protected _runFiberWithStashWrapper<T>(
    name: string,
    fn: (ctx: FiberContext) => Promise<T>,
    options: Pick<InternalFiberOptions, "initialSnapshot" | "wrapStash">
  ): Promise<T> {
    return this._fibers._runFiberWithStashWrapper(name, fn, options);
  }

  startFiber(
    name: string,
    fn: (ctx: FiberContext) => Promise<void>,
    options?: StartFiberOptions
  ): Promise<StartFiberResult> {
    return this._fibers.startFiber(name, fn, options);
  }

  /**
   * Checkpoint data for the currently executing fiber.
   * Uses AsyncLocalStorage to identify the correct fiber,
   * so it works correctly even with concurrent fibers.
   *
   * Throws if called outside a `runFiber` callback.
   */
  stash(data: unknown): void {
    return this._fibers.stash(data);
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
  private _checkRunFibers(): Promise<void> {
    return this._fibers._checkRunFibers();
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
  private async _checkFacetRunFibers(): Promise<void> {
    // Only the root owns the physical alarm and facet-run index.
    if (this._parentPath.length > 0) return;

    const rows = this.sql<FacetRunStorageRow>`
      SELECT owner_path, owner_path_key, run_id, created_at
      FROM cf_agents_facet_runs
      ORDER BY created_at ASC
    `;
    const firstRowByOwner = new Map<string, FacetRunStorageRow>();
    for (const row of rows) {
      if (!firstRowByOwner.has(row.owner_path_key)) {
        firstRowByOwner.set(row.owner_path_key, row);
      }
    }

    for (const row of firstRowByOwner.values()) {
      let ownerPath: AgentPathStep[];
      try {
        ownerPath = JSON.parse(row.owner_path) as AgentPathStep[];
      } catch (e) {
        console.warn(
          `[Agent] Corrupted facet fiber owner path for ${row.owner_path_key}; pruning stale lease.`,
          e
        );
        this.sql`
          DELETE FROM cf_agents_facet_runs
          WHERE owner_path_key = ${row.owner_path_key}
        `;
        continue;
      }

      try {
        const remaining = await this._cf_checkRunFibersForFacet(ownerPath);
        if (remaining === 0) {
          this.sql`
            DELETE FROM cf_agents_facet_runs
            WHERE owner_path_key = ${row.owner_path_key}
          `;
        }
      } catch (e) {
        // Keep the lease so a transient failure (e.g. facet init error)
        // gets retried on the next root heartbeat.
        console.error(
          `[Agent] Facet fiber recovery check failed for ${row.owner_path_key}:`,
          e
        );
      }
    }
  }

  /**
   * Dispatch a runFiber recovery check into the facet identified by
   * `ownerPath`. Returns the number of remaining local `cf_agents_runs`
   * rows on the target facet after recovery.
   * @internal
   */
  async _cf_checkRunFibersForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<number> {
    const selfPath = this.selfPath;
    if (!this._isSameAgentPathPrefix(selfPath, ownerPath)) {
      throw new Error(
        `Facet fiber owner path does not descend from ${JSON.stringify(selfPath)}.`
      );
    }

    if (selfPath.length === ownerPath.length) {
      await this._checkRunFibers();
      const rows = this.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM cf_agents_runs
      `;
      return rows[0]?.count ?? 0;
    }

    const next = ownerPath[selfPath.length];
    if (!this.hasSubAgent(next.className, next.name)) {
      // The facet was deleted or its registry was cleared. The root
      // should prune the root-side lease; there is no remaining child
      // storage to recover through the public registry path.
      return 0;
    }

    const stub = await this._cf_resolveSubAgent(next.className, next.name);
    const handle = stub as unknown as {
      _cf_checkRunFibersForFacet(
        ownerPath: ReadonlyArray<AgentPathStep>
      ): Promise<number>;
    };
    return handle._cf_checkRunFibersForFacet(ownerPath);
  }

  /**
   * Dispatch a scheduled callback into the facet identified by
   * `ownerPath`. Walks one step at a time: if `ownerPath` matches
   * `selfPath`, executes the callback locally; otherwise resolves
   * the next descendant facet and recurses through its own RPC.
   *
   * Called by the root's `alarm()` (which owns the physical alarm
   * for facet-owned schedules) and by intermediate facets while
   * walking down the chain.
   * @internal
   */
  async _cf_dispatchScheduledCallback(
    ownerPath: ReadonlyArray<AgentPathStep>,
    row: ScheduleStorageRow
  ): Promise<boolean> {
    const selfPath = this.selfPath;
    if (!this._isSameAgentPathPrefix(selfPath, ownerPath)) {
      throw new Error(
        `Schedule owner path does not descend from ${JSON.stringify(selfPath)}.`
      );
    }

    if (selfPath.length === ownerPath.length) {
      await this._scheduler.executeCallback(row);
      return true;
    }

    const next = ownerPath[selfPath.length];
    if (!this.hasSubAgent(next.className, next.name)) {
      // The target facet was deleted or its registry entry was lost. Since
      // this schedule can no longer be dispatched through the public registry,
      // prune root-side bookkeeping for the stale sub-tree instead of
      // repeatedly re-arming the same impossible alarm.
      const stalePath = ownerPath.slice(0, selfPath.length + 1);
      if (this._isFacet) {
        const root = await this._rootAlarmOwner();
        await root._cf_cleanupFacetPrefix(stalePath);
      } else {
        await this._cf_cleanupFacetPrefix(stalePath);
      }
      return false;
    }

    const stub = await this._cf_resolveSubAgent(next.className, next.name);
    const handle = stub as unknown as {
      _cf_dispatchScheduledCallback(
        ownerPath: ReadonlyArray<AgentPathStep>,
        row: ScheduleStorageRow
      ): Promise<boolean>;
    };
    return handle._cf_dispatchScheduledCallback(ownerPath, row);
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
    return this._subAgents.destroyDescendantFacet(targetPath);
  }

  private async _scheduleNextAlarm() {
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const hungCutoffSeconds =
      nowSeconds - this._resolvedOptions.hungScheduleTimeoutSeconds;

    // Earliest schedule row that is safe to execute now (overdue rows
    // included) and the earliest re-check time for a still-running
    // interval that has not crossed the hung timeout yet — both owned
    // by the scheduler capability.
    let nextTimeMs: number | null = this._scheduler.nextScheduleTimeMs(
      nowMs,
      hungCutoffSeconds
    );

    const recoveryTimeMs =
      this._scheduler.nextHungIntervalRecheckMs(hungCutoffSeconds);
    if (recoveryTimeMs !== null) {
      nextTimeMs =
        nextTimeMs === null
          ? recoveryTimeMs
          : Math.min(nextTimeMs, recoveryTimeMs);
    }

    if (this._keepAliveRefs > 0) {
      const keepAliveMs = nowMs + this._resolvedOptions.keepAliveIntervalMs;
      nextTimeMs =
        nextTimeMs === null ? keepAliveMs : Math.min(nextTimeMs, keepAliveMs);
    }

    // Candidate wake-up for runFiber recovery — pending-work detection and
    // the no-progress exponential backoff are owned by the fibers capability
    // (see AgentFibers.nextRecoveryTimeMs).
    const fiberRecoveryMs = this._fibers.nextRecoveryTimeMs(nowMs);
    if (fiberRecoveryMs !== null) {
      nextTimeMs =
        nextTimeMs === null
          ? fiberRecoveryMs
          : Math.min(nextTimeMs, fiberRecoveryMs);
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

    // Named durable timers (TimerHost) join the single-alarm arbitration.
    const nextHostTimer = this.sql<{ fire_at: number }>`
      SELECT fire_at FROM cf_agents_host_timers ORDER BY fire_at ASC LIMIT 1
    `;
    if (nextHostTimer.length > 0) {
      const timerMs = Math.max(nextHostTimer[0].fire_at, nowMs + 1);
      nextTimeMs =
        nextTimeMs === null ? timerMs : Math.min(nextTimeMs, timerMs);
    }

    if (nextTimeMs !== null) {
      await this.ctx.storage.setAlarm(nextTimeMs);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /**
   * Override PartyServer's onAlarm hook as a no-op.
   * Agent handles alarm logic directly in the alarm() method override,
   * but super.alarm() calls onAlarm() after #ensureInitialized(),
   * so we suppress the default "Implement onAlarm" warning.
   */
  onAlarm(): void {}

  /**
   * Method called when an alarm fires.
   * Executes any scheduled tasks that are due.
   *
   * Calls super.alarm() first to ensure PartyServer's #ensureInitialized()
   * runs, which resolves this.name from ctx.id.name (including for
   * facets, which are spawned with an explicit id so they have their
   * own ctx.id.name; pre-2026-03-15 alarms fall back to the legacy
   * __ps_name storage record) and calls onStart() if needed.
   *
   * @remarks
   * To schedule a task, please use the `this.schedule` method instead.
   * See {@link https://developers.cloudflare.com/agents/api-reference/schedule-tasks/}
   */
  async alarm() {
    // Ensure PartyServer initialization (name resolution, onStart) runs
    // before processing any scheduled tasks.
    await super.alarm();

    // Execute any due schedule rows (scheduler capability owns the loop).
    await this._scheduler.fireDueSchedules();
    if (this._destroyed) return;

    // Fire due named timers (TimerHost). Handlers registered during
    // module init have run by now — super.alarm() above guarantees
    // initialization completed first.
    await this._fireDueHostTimers();
    if (this._destroyed) return;

    await this._onAlarmHousekeeping();

    // Schedule the next alarm
    await this._scheduleNextAlarm();
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
   * After a WebSocket upgrade completes, subsequent frames route
   * directly to the child — the parent is only on the path for the
   * initial request.
   *
   * @experimental The API surface may change before stabilizing.
   */
  override async fetch(request: Request): Promise<Response> {
    const ctx = this.ctx as unknown as Partial<FacetCapableCtx>;
    const match = _parseSubAgentPath(request.url, {
      knownClasses: ctx.exports ? Object.keys(ctx.exports) : undefined
    });

    if (!match) {
      return super.fetch(request);
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
      return super.fetch(new Request(forwardReq, { headers: acceptHeaders }));
    }

    return this._cf_forwardToFacet(forwardReq, match);
  }

  override broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    if (this._isFacet) {
      void this._cf_broadcastToParentSubAgent(msg, without);
      return;
    }

    for (const connection of super.getConnections()) {
      if (without?.includes(connection.id)) continue;
      if (this._cf_connectionHasSubAgentTarget(connection)) continue;
      connection.send(msg);
    }
  }

  override getConnection<TState = unknown>(
    id: string
  ): Connection<TState> | undefined {
    if (this._isFacet) {
      // Do NOT fall through to `super.getConnection()` on a facet — it resolves
      // to the host/root DO's hibernatable sockets and reading them from the
      // facet's I/O context throws a cross-DO Native I/O error. See issue #1677.
      return this._subAgents.getFacetConnection<TState>(id);
    }

    const connection = super.getConnection<TState>(id);
    if (!connection || this._cf_connectionHasSubAgentTarget(connection)) {
      return undefined;
    }
    return connection;
  }

  override *getConnections<TState = unknown>(
    tag?: string
  ): Iterable<Connection<TState>> {
    if (this._isFacet) {
      // A facet's client connections are all virtual — they are real
      // WebSockets owned by the ROOT DO and bridged in. We must NOT fall
      // through to `super.getConnections()` here: on a facet that resolves to
      // the host/root DO's hibernatable sockets, and reading their attachments
      // from the facet's I/O context throws
      // "Cannot perform I/O on behalf of a different Durable Object (Native)".
      // See issue #1677.
      yield* this._subAgents.getFacetConnections<TState>(tag);
      return;
    }

    for (const connection of super.getConnections<TState>(tag)) {
      if (this._cf_connectionHasSubAgentTarget(connection)) continue;
      yield connection;
    }
  }

  private _cf_broadcastToParentSubAgent(
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): Promise<void> {
    return this._subAgents.broadcastToParentSubAgent(message, without);
  }

  /** @internal RPC endpoint — dispatched by name on facet/root stubs. */
  _cf_broadcastToSubAgent(
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): Promise<void> {
    return this._subAgents.broadcastToSubAgent(ownerPath, message, without);
  }

  /** @internal RPC endpoint — dispatched by name on facet/root stubs. */
  _cf_subAgentConnectionMetas(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<SubAgentConnectionMeta[]> {
    return this._subAgents.subAgentConnectionMetas(ownerPath);
  }

  /** @internal RPC endpoint — dispatched by name on facet/root stubs. */
  _cf_sendToSubAgentConnection(
    connectionId: string,
    message: string | ArrayBuffer | ArrayBufferView
  ): Promise<void> {
    return this._subAgents.sendToSubAgentConnection(connectionId, message);
  }

  /** @internal RPC endpoint — dispatched by name on facet/root stubs. */
  _cf_closeSubAgentConnection(
    connectionId: string,
    code?: number,
    reason?: string
  ): Promise<void> {
    return this._subAgents.closeSubAgentConnection(connectionId, code, reason);
  }

  /** @internal RPC endpoint — dispatched by name on facet/root stubs. */
  _cf_setSubAgentConnectionState(
    connectionId: string,
    state: unknown
  ): Promise<unknown> {
    return this._subAgents.setSubAgentConnectionState(connectionId, state);
  }

  private _cf_connectionHasSubAgentTarget(connection: Connection): boolean {
    return this._subAgents.connectionHasSubAgentTarget(connection);
  }

  protected _cf_connectionTargetsSubAgent(connection: Connection): boolean {
    return this._subAgents.connectionTargetsSubAgent(connection);
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
    return this._subAgents.requestTargetsSubAgent(request);
  }

  private _cf_forwardSubAgentWebSocketConnect(
    connection: Connection,
    request: Request,
    options: { gate: boolean }
  ): Promise<boolean> {
    return this._subAgents.forwardSubAgentWebSocketConnect(
      connection,
      request,
      options
    );
  }

  private _cf_forwardSubAgentWebSocketMessage(
    connection: Connection,
    message: WSMessage
  ): Promise<boolean> {
    return this._subAgents.forwardSubAgentWebSocketMessage(connection, message);
  }

  private _cf_forwardSubAgentWebSocketClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<boolean> {
    return this._subAgents.forwardSubAgentWebSocketClose(
      connection,
      code,
      reason,
      wasClean
    );
  }

  /** @internal RPC endpoint — dispatched by name on facet/root stubs. */
  _cf_handleSubAgentWebSocketConnect(
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void> {
    return this._subAgents.handleSubAgentWebSocketConnect(bridge, meta);
  }

  /** @internal RPC endpoint — dispatched by name on facet/root stubs. */
  _cf_handleSubAgentWebSocketMessage(
    message: WSMessage,
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void> {
    return this._subAgents.handleSubAgentWebSocketMessage(
      message,
      bridge,
      meta
    );
  }

  /** @internal RPC endpoint — dispatched by name on facet/root stubs. */
  _cf_handleSubAgentWebSocketClose(
    code: number,
    reason: string,
    wasClean: boolean,
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void> {
    return this._subAgents.handleSubAgentWebSocketClose(
      code,
      reason,
      wasClean,
      bridge,
      meta
    );
  }

  protected _cf_hydrateSubAgentConnectionsFromRoot(): Promise<void> {
    return this._subAgents.hydrateSubAgentConnectionsFromRoot();
  }

  private _cf_getRawConnectionState(connection: Connection): unknown {
    this._ensureConnectionWrapped(connection);
    return this._rawStateAccessors.get(connection)?.getRaw() ?? null;
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
   *     if (!this.hasSubAgent(className, name)) {
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
    return this._subAgents.forwardToFacet(req, match);
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
    return this._subAgents.invokeSubAgent(className, name, method, args);
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
    return this._subAgents.invokeSubAgentPath(path, method, args);
  }

  // ── Sub-agents (delegates to capabilities/sub-agents.ts) ────────────────

  private _subAgentsCap?: AgentSubAgents;
  private get _subAgents(): AgentSubAgents {
    this._subAgentsCap ??= new AgentSubAgents({
      agent: this,
      sql: this.sql.bind(this),
      rawSql: (query) => void this.ctx.storage.sql.exec(query),
      facetCtx: () => this.ctx as unknown as Partial<FacetCapableCtx>,
      ctxId: () => this.ctx.id,
      storagePut: (key, value) => this.ctx.storage.put(key, value),
      env: () => this.env as Record<string, unknown>,
      isFacet: () => this._isFacet,
      parentPath: () => this._parentPath,
      selfPath: () => this.selfPath,
      routedName: () => super.name,
      agentClassName: () => this._ParentClass.name,
      constructorName: () => (this.constructor as { name: string }).name,
      setFacetIdentity: (name, parentPath) => {
        this._isFacet = true;
        this._facetName = name;
        this._parentPath = parentPath;
      },
      ensureInitialized: () => this.__unsafe_ensureInitialized(),
      rootAlarmOwner: () => this._rootAlarmOwner(),
      cleanupFacetPrefix: (ownerPath) => this._cf_cleanupFacetPrefix(ownerPath),
      isSameAgentPathPrefix: (prefix, path) =>
        this._isSameAgentPathPrefix(prefix, path),
      runOutsideRequestContext: (fn) =>
        agentContext.run(
          {
            agent: this,
            connection: undefined,
            request: undefined,
            email: undefined
          },
          fn
        ),
      rawGetConnection: (id) => super.getConnection(id),
      rawGetConnections: () => super.getConnections(),
      ensureConnectionWrapped: (connection) =>
        this._ensureConnectionWrapped(connection),
      getRawConnectionState: (connection) =>
        this._cf_getRawConnectionState(connection),
      setConnectionNoProtocol: (connection) =>
        this._setConnectionNoProtocol(connection)
    });
    return this._subAgentsCap;
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
    return this._subAgents.initAsFacet(name, parentPath, identityName);
  }

  override get name(): string {
    return (
      this._facetName ?? logicalNameFromPathV2Identity(super.name) ?? super.name
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
  get parentPath(): ReadonlyArray<{ className: string; name: string }> {
    return this._parentPath;
  }

  /**
   * Ancestor chain + self, root-first. Convenient for logging.
   *
   * @experimental The API surface may change before stabilizing.
   */
  get selfPath(): ReadonlyArray<{ className: string; name: string }> {
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
  parentAgent<T extends Agent>(
    cls: SubAgentClass<T>
  ): Promise<DurableObjectStub<T>> {
    return this._subAgents.parentAgent(cls);
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
   */
  subAgent<T extends Agent>(
    cls: SubAgentClass<T>,
    name: string
  ): Promise<SubAgentStub<T>> {
    return this._subAgents.subAgent(cls, name);
  }

  /** Maximum number of non-terminal agent-tool runs this parent may own at once. */
  maxConcurrentAgentTools = Infinity;

  async onAgentToolStart(_run: AgentToolRunInfo): Promise<void> {}

  async onAgentToolFinish(
    _run: AgentToolRunInfo,
    _result: AgentToolLifecycleResult
  ): Promise<void> {}

  // ── Agent tools (delegates to capabilities/agent-tools.ts) ───────────────

  private _agentToolsCap?: AgentTools;
  private get _agentTools(): AgentTools {
    this._agentToolsCap ??= new AgentTools({
      agent: this,
      sql: this.sql.bind(this),
      emit: (type, payload) => this._emit(type, payload),
      reattachNoProgressTimeoutMs: () =>
        this._resolvedOptions.agentToolReattachNoProgressTimeoutMs,
      reattachMaxWindowMs: () =>
        this._resolvedOptions.agentToolReattachMaxWindowMs,
      resolveSubAgent: (className, name) =>
        this._cf_resolveSubAgent(className, name),
      ctxExports: () =>
        (this.ctx as unknown as Partial<FacetCapableCtx>).exports,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      onError: (e) => this.onError(e)
    });
    return this._agentToolsCap;
  }

  runAgentTool<Input = unknown, Output = unknown>(
    cls: ChatCapableAgentClass,
    options: RunAgentToolOptions<Input>
  ): Promise<RunAgentToolResult<Output>> {
    return this._agentTools.runAgentTool(cls, options);
  }

  hasAgentToolRun<T extends Agent>(
    cls: SubAgentClass<T>,
    runId: string
  ): boolean;
  hasAgentToolRun(agentType: string, runId: string): boolean;
  hasAgentToolRun(classOrName: SubAgentClass | string, runId: string): boolean {
    return this._agentTools.hasAgentToolRun(classOrName, runId);
  }

  clearAgentToolRuns(options?: {
    olderThan?: number;
    status?: AgentToolRunStatus[];
  }): Promise<void> {
    return this._agentTools.clearAgentToolRuns(options);
  }

  private _readAgentToolRun(runId: string): AgentToolRunStorageRow | null {
    return this._agentTools._readAgentToolRun(runId);
  }

  private _resultFromAgentToolRow<Output>(
    row: AgentToolRunStorageRow
  ): RunAgentToolResult<Output> {
    return this._agentTools._resultFromAgentToolRow<Output>(row);
  }

  private _runDeferredAgentToolFinishHooks(
    hooks: DeferredAgentToolFinish[]
  ): Promise<void> {
    return this._agentTools._runDeferredAgentToolFinishHooks(hooks);
  }

  private _updateAgentToolTerminal<Output>(
    runId: string,
    result: RunAgentToolResult<Output>,
    completedAt?: number
  ): void {
    this._agentTools._updateAgentToolTerminal(runId, result, completedAt);
  }

  private _broadcastAgentToolStoredChunksFromAdapter(
    adapter: AgentToolChildAdapter,
    row: Pick<AgentToolRunStorageRow, "run_id" | "parent_tool_call_id">,
    sequence: number,
    replay?: true,
    connection?: Connection,
    timeoutMs?: number
  ): Promise<number> {
    return this._agentTools._broadcastAgentToolStoredChunksFromAdapter(
      adapter,
      row,
      sequence,
      replay,
      connection,
      timeoutMs
    );
  }

  private _forwardAgentToolStream(
    stream: ReadableStream<AgentToolStoredChunk>,
    parentToolCallId: string | undefined,
    runId: string,
    sequence: number,
    signal?: AbortSignal,
    idleTimeoutMs?: number
  ): Promise<{ next: number; ended: "done" | "idle" | "aborted" }> {
    return this._agentTools._forwardAgentToolStream(
      stream,
      parentToolCallId,
      runId,
      sequence,
      signal,
      idleTimeoutMs
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

  private _reattachAgentToolRunToTerminal<Output>(
    adapter: AgentToolChildAdapter<unknown, Output>,
    row: Pick<
      AgentToolRunStorageRow,
      "run_id" | "agent_type" | "parent_tool_call_id"
    >,
    sequence: number,
    noProgressTimeoutMs?: number,
    maxWindowMs?: number
  ): Promise<{
    sequence: number;
    result?: RunAgentToolResult<Output>;
    completedAt?: number;
    reason?: AgentToolInterruptedReason;
  }> {
    return this._agentTools._reattachAgentToolRunToTerminal(
      adapter,
      row,
      sequence,
      noProgressTimeoutMs,
      maxWindowMs
    );
  }

  private _replayAgentToolRuns(connection: Connection): Promise<void> {
    return this._agentTools._replayAgentToolRuns(connection);
  }

  private _reconcileAgentToolRuns(options?: {
    deferFinishHooks?: boolean;
    childInspectionTimeoutMs?: number;
    totalRecoveryTimeoutMs?: number;
    reattachTimeoutMs?: number;
    reattachMaxWindowMs?: number;
    runIds?: readonly string[];
  }): Promise<DeferredAgentToolFinish[]> {
    return this._agentTools._reconcileAgentToolRuns(options);
  }

  private _scheduleAgentToolRunRecovery(options?: {
    childInspectionTimeoutMs?: number;
    totalRecoveryTimeoutMs?: number;
    reattachTimeoutMs?: number;
    reattachMaxWindowMs?: number;
    runIds?: readonly string[];
  }): Promise<void> {
    return this._agentTools._scheduleAgentToolRunRecovery(options);
  }

  private _agentToolRunRecoveryRunIds(): string[] {
    return this._agentTools._agentToolRunRecoveryRunIds();
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
    return this._subAgents.resolveSubAgent(className, name);
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
   */
  abortSubAgent(cls: SubAgentClass, name: string, reason?: unknown): void {
    this._subAgents.abortSubAgent(cls, name, reason);
  }

  /**
   * Delete a sub-agent: abort it if running, then permanently wipe its
   * storage. Transitively deletes the child's own children.
   *
   * @experimental The API surface may change before stabilizing.
   *
   * @param cls The Agent subclass used when creating the child
   * @param name Name of the child to delete
   */
  deleteSubAgent(cls: SubAgentClass, name: string): Promise<void> {
    return this._subAgents.deleteSubAgent(cls, name);
  }

  // The sub-agent registry internals (`_ensureSubAgentRegistry`,
  // `_recordSubAgent`, `_subAgentRegistryRow`, `_cf_subAgentIdentity`,
  // `_forgetSubAgent`) live on the sub-agents capability
  // (capabilities/sub-agents.ts), which owns the `cf_agents_sub_agents`
  // table.

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
   */
  hasSubAgent<T extends Agent>(cls: SubAgentClass<T>, name: string): boolean;
  hasSubAgent(className: string, name: string): boolean;
  hasSubAgent(classOrName: SubAgentClass | string, name: string): boolean {
    return this._subAgents.hasSubAgent(classOrName, name);
  }

  /**
   * List known sub-agents, optionally filtered by class. Reflects
   * the registry rows written by {@link subAgent} and removed by
   * {@link deleteSubAgent}.
   *
   * @experimental The API surface may change before stabilizing.
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
    return this._subAgents.listSubAgents(classOrName);
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

    this._dropInternalTablesForDestroy();

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

    this._emit("destroy");
  }

  /** @internal Drop every internal Agents SDK table during top-level destroy. */
  protected _dropInternalTablesForDestroy(): void {
    this.sql`DROP TABLE IF EXISTS cf_agents_host_migrations`;
    this.sql`DROP TABLE IF EXISTS cf_agents_host_timers`;
    this.sql`DROP TABLE IF EXISTS cf_agents_mcp_servers`;
    this.sql`DROP TABLE IF EXISTS cf_agents_state`;
    this.sql`DROP TABLE IF EXISTS cf_agents_schedules`;
    this.sql`DROP TABLE IF EXISTS cf_agents_queues`;
    this.sql`DROP TABLE IF EXISTS cf_agents_workflows`;
    this.sql`DROP TABLE IF EXISTS cf_agents_sub_agents`;
    this.sql`DROP TABLE IF EXISTS cf_agents_runs`;
    this.sql`DROP TABLE IF EXISTS cf_agents_fibers`;
    this.sql`DROP TABLE IF EXISTS cf_agents_facet_runs`;
    this.sql`DROP TABLE IF EXISTS cf_agent_tool_runs`;
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

  // ── Workflows (delegates to capabilities/workflows.ts) ────────────────────

  private _workflowsCap?: AgentWorkflows;
  private get _workflows(): AgentWorkflows {
    this._workflowsCap ??= new AgentWorkflows({
      agent: this,
      sql: this.sql.bind(this),
      rawSql: (query, ...params) => this.ctx.storage.sql.exec(query, ...params),
      emit: (type, payload) => this._emit(type, payload),
      env: () => this.env as Record<string, unknown>,
      agentInstanceName: () => this.name,
      agentClassName: () => this._ParentClass.name,
      ensureInitialized: () => this.__unsafe_ensureInitialized()
    });
    return this._workflowsCap;
  }

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
  runWorkflow<P = unknown>(
    workflowName: WorkflowName<Env>,
    params: P,
    options?: RunWorkflowOptions
  ): Promise<string> {
    return this._workflows.run(workflowName, params, options);
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
  sendWorkflowEvent(
    workflowName: WorkflowName<Env>,
    workflowId: string,
    event: WorkflowEventPayload
  ): Promise<void> {
    return this._workflows.sendEvent(workflowName, workflowId, event);
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
  approveWorkflow(
    workflowId: string,
    data?: { reason?: string; metadata?: Record<string, unknown> }
  ): Promise<void> {
    return this._workflows.approve(workflowId, data);
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
  rejectWorkflow(
    workflowId: string,
    data?: { reason?: string }
  ): Promise<void> {
    return this._workflows.reject(workflowId, data);
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
  terminateWorkflow(workflowId: string): Promise<void> {
    return this._workflows.terminate(workflowId);
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
  pauseWorkflow(workflowId: string): Promise<void> {
    return this._workflows.pause(workflowId);
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
  resumeWorkflow(workflowId: string): Promise<void> {
    return this._workflows.resume(workflowId);
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
  restartWorkflow(
    workflowId: string,
    options: { resetTracking?: boolean } = {}
  ): Promise<void> {
    return this._workflows.restart(workflowId, options);
  }

  /**
   * Get the status of a workflow and update the tracking record.
   *
   * @param workflowName - Name of the workflow binding in env (e.g., 'MY_WORKFLOW')
   * @param workflowId - ID of the workflow instance
   * @returns The workflow status
   */
  getWorkflowStatus(
    workflowName: WorkflowName<Env>,
    workflowId: string
  ): Promise<InstanceStatus> {
    return this._workflows.getStatus(workflowName, workflowId);
  }

  /**
   * Get a tracked workflow by ID.
   *
   * @param workflowId - Workflow instance ID
   * @returns Workflow info or undefined if not found
   */
  getWorkflow(workflowId: string): WorkflowInfo | undefined {
    return this._workflows.get(workflowId);
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
    return this._workflows.getPage(criteria);
  }

  /**
   * Delete a workflow tracking record.
   *
   * @param workflowId - ID of the workflow to delete
   * @returns true if a record was deleted, false if not found
   */
  deleteWorkflow(workflowId: string): boolean {
    return this._workflows.delete(workflowId);
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
    return this._workflows.deleteMany(criteria);
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
    return this._workflows.migrateBinding(oldName, newName);
  }

  private _restoreRpcMcpServers(): Promise<void> {
    return this._mcpServers.restoreRpcServers();
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
  onWorkflowCallback(callback: WorkflowCallback): Promise<void> {
    return this._workflows.handleCallback(callback);
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
  _workflow_handleCallback(callback: WorkflowCallback): Promise<void> {
    return this._workflows.rpcHandleCallback(callback);
  }

  /**
   * Broadcast a message to all connected clients via RPC.
   * @internal - Called by AgentWorkflow, do not call directly
   */
  _workflow_broadcast(message: unknown): Promise<void> {
    return this._workflows.rpcBroadcast(message);
  }

  /**
   * Update agent state via RPC.
   * @internal - Called by AgentWorkflow, do not call directly
   */
  _workflow_updateState(
    action: "set" | "merge" | "reset",
    state?: unknown
  ): Promise<void> {
    return this._workflows.rpcUpdateState(action, state);
  }

  // ── MCP servers (delegates to capabilities/mcp-servers.ts) ───────────────

  private _mcpServersCap?: AgentMcpServers;
  private get _mcpServers(): AgentMcpServers {
    this._mcpServersCap ??= new AgentMcpServers({
      mcp: this.mcp,
      env: () => this.env as Record<string, unknown>,
      agentInstanceName: () => this.name,
      agentClassName: () => this._ParentClass.name,
      sendIdentityOnConnect: () => this._resolvedOptions.sendIdentityOnConnect,
      createOAuthProvider: (callbackUrl) =>
        this.createMcpOAuthProvider(callbackUrl),
      broadcastProtocol: (msg) => this._broadcastProtocol(msg)
    });
    return this._mcpServersCap;
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
  addMcpServer<T extends McpAgent>(
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
  addMcpServer(
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

  addMcpServer<T extends McpAgent>(
    serverName: string,
    urlOrBinding: string | DurableObjectNamespace<T>,
    callbackHostOrOptions?:
      | string
      | AddMcpServerOptions
      | AddRpcMcpServerOptions,
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
    return this._mcpServers.add(
      serverName,
      urlOrBinding,
      callbackHostOrOptions,
      agentsPrefix,
      options
    );
  }

  removeMcpServer(id: string): Promise<void> {
    return this._mcpServers.remove(id);
  }

  getMcpServers(): MCPServersState {
    return this._mcpServers.getServers();
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
export type AgentOptions<Env> = PartyServerOptions<Env>;

export type AgentGetOptions<
  Env,
  Props extends Record<string, unknown> = Record<string, unknown>
> = Pick<
  PartyServerOptions<Env, Props>,
  "jurisdiction" | "locationHint" | "props" | "routingRetry"
>;

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
  // oxlint-disable-next-line typescript/no-explicit-any
  return routePartykitRequest(request, env as any, {
    prefix: "agents",
    ...(options as PartyServerOptions<Record<string, unknown>>)
  });
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
  options?: AgentGetOptions<Env, Props>
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
