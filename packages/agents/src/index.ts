import { AsyncLocalStorage } from "node:async_hooks";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
  type AgentEmail
} from "./internal_context";
export { __DO_NOT_USE_WILL_BREAK__agentContext } from "./internal_context";
import {
  SUB_PREFIX,
  parseSubAgentPath as _parseSubAgentPath
} from "./sub-routing";
export {
  routeSubAgentRequest,
  getSubAgentByName,
  parseSubAgentPath,
  SUB_PREFIX
} from "./sub-routing";
export type { SubAgentPathMatch } from "./sub-routing";
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
import {
  type RetryOptions,
  tryN,
  isErrorRetryable,
  validateRetryOptions
} from "./retries";
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
import { DisposableStore } from "./core/events";
import { MessageType } from "./types";
import { RPC_DO_PREFIX } from "./mcp/rpc";
import type { McpAgent } from "./mcp";
import type {
  AgentToolChildAdapter,
  AgentToolDisplayMetadata,
  AgentToolEvent,
  AgentToolEventMessage,
  AgentToolLifecycleResult,
  AgentToolRunInfo,
  AgentToolRunInspection,
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

/**
 * Internal narrowing of `DurableObjectState` to the parts the facet
 * bootstrap path uses. We only need this because `ctx.exports` in the
 * real types (`Cloudflare.Exports`) is keyed by the *consumer's*
 * worker MainModule, which is invisible from inside this library —
 * so we widen it to a generic Record indexed by class name.
 *
 * @internal
 */
interface FacetCapableCtx {
  facets: DurableObjectFacets;
  /**
   * Worker exports keyed by class export name. workerd's runtime
   * contract: any class registered via `migrations.new_sqlite_classes`
   * (or `migrations.new_classes`) — including facet-only classes
   * that have NO entry in `durable_objects.bindings` — is exposed
   * here as BOTH a `DurableObjectClass` (usable as
   * `FacetStartupOptions.class`) AND a `DurableObjectNamespace`
   * (usable for `idFromName`/`getByName`). The intersection is what
   * makes `ctx.exports[OuterSubAgent].idFromName(...)` work from
   * inside a nested facet bootstrap, even though `OuterSubAgent`
   * isn't bound. Runtime lookups can still return `undefined` for
   * unregistered class names; callers must null-check.
   */
  exports: Record<
    string,
    (DurableObjectClass & DurableObjectNamespace) | undefined
  >;
}

type SubAgentConnectionMeta = {
  id: string;
  uri: string | null;
  tags: string[];
  state: unknown;
  requestHeaders?: [string, string][];
};

type SubAgentConnectionBridgeLike = {
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  setState(state: unknown): unknown;
  broadcast(
    ownerPath: ReadonlyArray<{ className: string; name: string }>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void;
};

type StoredSubAgentConnection = {
  bridge: SubAgentConnectionBridgeLike;
  meta: SubAgentConnectionMeta;
  connection?: Connection;
};

type SubAgentWebSocketEndpoint = {
  _cf_handleSubAgentWebSocketConnect(
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void>;
  _cf_handleSubAgentWebSocketMessage(
    message: WSMessage,
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void>;
  _cf_handleSubAgentWebSocketClose(
    code: number,
    reason: string,
    wasClean: boolean,
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void>;
};

class SubAgentConnectionBridge
  extends RpcTarget
  implements SubAgentConnectionBridgeLike
{
  #connection: Connection;
  #broadcast?: (
    ownerPath: ReadonlyArray<{ className: string; name: string }>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ) => void;

  constructor(
    connection: Connection,
    broadcast?: (
      ownerPath: ReadonlyArray<{ className: string; name: string }>,
      message: string | ArrayBuffer | ArrayBufferView,
      without?: string[]
    ) => void
  ) {
    super();
    this.#connection = connection;
    this.#broadcast = broadcast;
  }

  send(message: string | ArrayBuffer | ArrayBufferView): void {
    this.#connection.send(message);
  }

  close(code?: number, reason?: string): void {
    this.#connection.close(code, reason);
  }

  setState(state: unknown): unknown {
    return this.#connection.setState(state);
  }

  broadcast(
    ownerPath: ReadonlyArray<{ className: string; name: string }>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    this.#broadcast?.(ownerPath, message, without);
  }
}

class RootSubAgentConnectionBridge implements SubAgentConnectionBridgeLike {
  #root: RootFacetRpcSurface;
  #connectionId: string;

  constructor(root: RootFacetRpcSurface, connectionId: string) {
    this.#root = root;
    this.#connectionId = connectionId;
  }

  send(message: string | ArrayBuffer | ArrayBufferView): void {
    void this.#root._cf_sendToSubAgentConnection(this.#connectionId, message);
  }

  close(code?: number, reason?: string): void {
    void this.#root._cf_closeSubAgentConnection(
      this.#connectionId,
      code,
      reason
    );
  }

  setState(state: unknown): unknown {
    void this.#root._cf_setSubAgentConnectionState(this.#connectionId, state);
    return state;
  }

  broadcast(
    ownerPath: ReadonlyArray<{ className: string; name: string }>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    void this.#root._cf_broadcastToSubAgent(ownerPath, message, without);
  }
}

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

type AgentPathStep = { className: string; name: string };

type ScheduleStorageRow = {
  id: string;
  callback: string;
  payload: string;
  type: "scheduled" | "delayed" | "cron" | "interval";
  time: number;
  delayInSeconds?: number;
  cron?: string;
  intervalSeconds?: number;
  retry?: RetryOptions;
  running?: number;
  execution_started_at?: number | null;
  retry_options?: string | null;
  owner_path?: string | null;
  owner_path_key?: string | null;
};

type FacetRunStorageRow = {
  owner_path: string;
  owner_path_key: string;
  run_id: string;
  created_at: number;
};

type AgentToolRunStorageRow = {
  run_id: string;
  parent_tool_call_id: string | null;
  agent_type: string;
  input_preview: string | null;
  status: AgentToolRunStatus;
  summary: string | null;
  output_json: string | null;
  error_message: string | null;
  display_metadata: string | null;
  display_order: number;
  started_at: number;
  completed_at: number | null;
};

type DeferredAgentToolFinish = () => Promise<void>;

export type ScheduleCriteria = {
  id?: string;
  type?: "scheduled" | "delayed" | "cron" | "interval";
  timeRange?: { start?: Date; end?: Date };
};

/**
 * Internal RPC surface exposed by the root agent for facets to
 * delegate alarm-owning operations (schedules + facet teardown).
 * @internal
 */
type RootFacetRpcSurface = {
  _cf_scheduleForFacet<T>(
    ownerPath: ReadonlyArray<AgentPathStep>,
    when: Date | string | number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }>;
  _cf_cancelScheduleForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>,
    id: string
  ): Promise<{ ok: boolean; callback?: string }>;
  _cf_scheduleEveryForFacet<T>(
    ownerPath: ReadonlyArray<AgentPathStep>,
    intervalSeconds: number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; _idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }>;
  _cf_cleanupFacetPrefix(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<void>;
  _cf_getScheduleForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>,
    id: string
  ): Promise<Schedule<unknown> | undefined>;
  _cf_listSchedulesForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>,
    criteria?: ScheduleCriteria
  ): Promise<Schedule<unknown>[]>;
  _cf_destroyDescendantFacet(
    targetPath: ReadonlyArray<AgentPathStep>
  ): Promise<void>;
  _cf_acquireFacetKeepAlive(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<string>;
  _cf_releaseFacetKeepAlive(token: string): Promise<void>;
  _cf_registerFacetRun(
    ownerPath: ReadonlyArray<AgentPathStep>,
    runId: string
  ): Promise<void>;
  _cf_unregisterFacetRun(
    ownerPath: ReadonlyArray<AgentPathStep>,
    runId: string
  ): Promise<void>;
  _cf_broadcastToSubAgent(
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): Promise<void>;
  _cf_subAgentConnectionMetas(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<SubAgentConnectionMeta[]>;
  _cf_sendToSubAgentConnection(
    connectionId: string,
    message: string | ArrayBuffer | ArrayBufferView
  ): Promise<void>;
  _cf_closeSubAgentConnection(
    connectionId: string,
    code?: number,
    reason?: string
  ): Promise<void>;
  _cf_setSubAgentConnectionState(
    connectionId: string,
    state: unknown
  ): Promise<unknown>;
};

/**
 * Context passed to the `runFiber` callback. Provides checkpoint
 * and identity for durable execution.
 */
export type FiberContext = {
  /** Unique identifier for this fiber execution. */
  id: string;
  /** Checkpoint data during execution. Synchronous SQLite write. */
  stash(data: unknown): void;
  /** Last checkpoint data (null on first run, populated on recovery re-invocation). */
  snapshot: unknown | null;
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
  /** Last checkpoint data from `stash()`, or null if never stashed. */
  snapshot: unknown | null;
  /**
   * Epoch milliseconds when the fiber row was inserted (when `runFiber`
   * started). Use `Date.now() - createdAt` to gate stale recoveries.
   */
  createdAt: number;
  [key: string]: unknown;
};

const _fiberALS = new AsyncLocalStorage<{
  id: string;
  stash: (data: unknown) => void;
}>();

function getNextCronTime(cron: string) {
  const interval = parseCronExpression(cron);
  return interval.getNextDate();
}

export type { TransportType } from "./mcp/types";
export type { RetryOptions } from "./retries";
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
  /** Props to pass to the McpAgent instance */
  props?: Record<string, unknown>;
};

const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 30_000;

/**
 * Schema version for the Agent's internal SQLite tables.
 * Bump this when adding new tables, columns, or migrations.
 * The constructor stores this as a row in cf_agents_state and checks it
 * on wake to skip DDL on established DOs.
 */
const CURRENT_SCHEMA_VERSION = 7;

const SCHEMA_VERSION_ROW_ID = "cf_schema_version";
const STATE_ROW_ID = "cf_state_row_id";
// Legacy key — no longer written, but read for backward compatibility with
// DOs that were created before the single-row state optimization.
const STATE_WAS_CHANGED = "cf_state_was_changed";

const DEFAULT_STATE = {} as unknown;

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

/**
 * Internal key used to remember the outer `/sub/...` URL for a
 * WebSocket accepted by the parent on behalf of a child facet.
 * Hibernated events then wake the parent, which forwards frames to
 * the child over serializable RPC while keeping native WebSocket I/O
 * parent-owned.
 */
const CF_SUB_AGENT_OUTER_URL_KEY = "_cf_subAgentOuterUrl";
const CF_SUB_AGENT_TAGS_KEY = "_cf_subAgentTags";

const SUB_AGENT_OUTER_URL_HEADER = "x-cf-agents-subagent-url";

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
  } satisfies Required<RetryOptions>
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
 * `tryN`. This is the shared retry-execution path used by both queue
 * flush and schedule alarm handlers.
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

  /**
   * True only while the internal facet bootstrap RPC runs startup.
   * Startup may happen while the parent is handling a WebSocket
   * message, so protocol broadcasts must not touch any ambient
   * parent-owned WebSocket handles during this window.
   */
  private _suppressProtocolBroadcasts = false;
  private _protocolBroadcastExcludeIds = new Set<string>();
  private _cf_currentSubAgentBridge?: SubAgentConnectionBridgeLike;
  private _cf_virtualSubAgentConnections = new Map<
    string,
    StoredSubAgentConnection
  >();

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

  /** @internal In-memory set of fiber IDs running in this process. */
  private _runFiberActiveFibers = new Set<string>();
  /** @internal Prevents re-entrant recovery from overlapping alarm ticks. */
  private _runFiberRecoveryInProgress = false;

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
      }
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

    // Initialize MCPClientManager AFTER tables are created
    this.mcp = new MCPClientManager(this._ParentClass.name, "0.0.1", {
      storage: this.ctx.storage,
      createAuthProvider: (callbackUrl) =>
        this.createMcpOAuthProvider(callbackUrl)
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

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = (request: Request) => {
      return agentContext.run(
        { agent: this, connection: undefined, request, email: undefined },
        async () => {
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
            this.broadcastMcpServers();

            this._checkOrphanedWorkflows();
            await this._checkRunFibers();
            const recoveredAgentToolFinishes =
              await this._reconcileAgentToolRuns({
                deferFinishHooks: true
              });

            this._insideOnStart = true;
            this._warnedScheduleInOnStart.clear();
            let result: Awaited<ReturnType<typeof _onStart>>;
            try {
              result = await _onStart(props);
            } finally {
              this._insideOnStart = false;
            }
            // Recovered finish hooks run only after successful user startup.
            // If onStart fails, durable recovery state is already finalized,
            // but user hook side effects may depend on startup-initialized mirrors.
            await this._runDeferredAgentToolFinishHooks(
              recoveredAgentToolFinishes
            );
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
    if (this._suppressProtocolBroadcasts) return;

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
          await agentContext.run(
            { agent: this, connection, request, email },
            async () => {
              this._emit("state:update");
              await this._callStatePersistenceHook(nextState, source);
            }
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

    return agentContext.run(
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
      if (!options.binding) {
        throw new Error(
          "binding is required. Pass your send_email binding, " +
            "e.g. this.sendEmail({ binding: this.env.EMAIL, ... })."
        );
      }

      const agentName = camelCaseToKebabCase(this._ParentClass.name);
      const agentId = this.name;

      const headers: Record<string, string> = {
        ...options.headers,
        "X-Agent-Name": agentName,
        "X-Agent-ID": agentId
      };

      if (options.inReplyTo) {
        headers["In-Reply-To"] = options.inReplyTo;
      }

      if (typeof options.secret === "string") {
        const signedHeaders = await signAgentHeaders(
          options.secret,
          agentName,
          agentId
        );
        headers["X-Agent-Sig"] = signedHeaders["X-Agent-Sig"];
        headers["X-Agent-Sig-Ts"] = signedHeaders["X-Agent-Sig-Ts"];
      }

      const result = await options.binding.send({
        from: options.from,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
        replyTo: options.replyTo,
        cc: options.cc,
        bcc: options.bcc,
        headers
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
          await agentContext.run(
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
            }
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

  private _scheduleOwnerPathKey(
    path: ReadonlyArray<AgentPathStep> | null
  ): string | null {
    if (!path) return null;
    return path
      .map(
        (step) =>
          `${encodeURIComponent(step.className)}:${encodeURIComponent(step.name)}`
      )
      .join("/");
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
      binding as DurableObjectNamespace<Agent>,
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

  /**
   * Insert (or, for idempotent calls, return the existing row for) a
   * schedule owned by either this top-level agent (`ownerPath === null`)
   * or a descendant facet. Returns `{ schedule, created }` — `created`
   * is `false` when an idempotent insert deduplicates onto an existing
   * row, so callers can suppress the `schedule:create` event in that
   * case to match historic semantics.
   * @internal
   */
  private async _insertScheduleForOwner<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep> | null,
    when: Date | string | number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    const ownerPathJson = ownerPath ? JSON.stringify(ownerPath) : null;
    const ownerPathKey = this._scheduleOwnerPathKey(ownerPath);
    const retryJson = options?.retry ? JSON.stringify(options.retry) : null;
    const payloadJson = JSON.stringify(payload);

    if (when instanceof Date) {
      const timestamp = Math.floor(when.getTime() / 1000);

      if (options?.idempotent) {
        const existing = this.sql<ScheduleStorageRow>`
          SELECT * FROM cf_agents_schedules
          WHERE type = 'scheduled'
            AND callback = ${callback}
            AND payload IS ${payloadJson}
            AND owner_path_key IS ${ownerPathKey}
          LIMIT 1
        `;

        if (existing.length > 0) {
          const row = existing[0];
          await this._scheduleNextAlarm();
          return {
            schedule: {
              callback: row.callback,
              id: row.id,
              payload: JSON.parse(row.payload) as T,
              retry: parseRetryOptions(
                row as unknown as Record<string, unknown>
              ),
              time: row.time,
              type: "scheduled"
            },
            created: false
          };
        }
      }

      const id = nanoid(9);
      this.sql`
        INSERT OR REPLACE INTO cf_agents_schedules
          (id, callback, payload, type, time, retry_options, owner_path, owner_path_key)
        VALUES
          (${id}, ${callback}, ${payloadJson}, 'scheduled', ${timestamp}, ${retryJson}, ${ownerPathJson}, ${ownerPathKey})
      `;

      await this._scheduleNextAlarm();
      return {
        schedule: {
          callback,
          id,
          payload: payload as T,
          retry: options?.retry,
          time: timestamp,
          type: "scheduled"
        },
        created: true
      };
    }

    if (typeof when === "number") {
      const timestamp = Math.floor((Date.now() + when * 1000) / 1000);

      if (options?.idempotent) {
        const existing = this.sql<ScheduleStorageRow>`
          SELECT * FROM cf_agents_schedules
          WHERE type = 'delayed'
            AND callback = ${callback}
            AND payload IS ${payloadJson}
            AND owner_path_key IS ${ownerPathKey}
          LIMIT 1
        `;

        if (existing.length > 0) {
          const row = existing[0];
          await this._scheduleNextAlarm();
          return {
            schedule: {
              callback: row.callback,
              delayInSeconds: row.delayInSeconds ?? 0,
              id: row.id,
              payload: JSON.parse(row.payload) as T,
              retry: parseRetryOptions(
                row as unknown as Record<string, unknown>
              ),
              time: row.time,
              type: "delayed"
            },
            created: false
          };
        }
      }

      const id = nanoid(9);
      this.sql`
        INSERT OR REPLACE INTO cf_agents_schedules
          (id, callback, payload, type, delayInSeconds, time, retry_options, owner_path, owner_path_key)
        VALUES
          (${id}, ${callback}, ${payloadJson}, 'delayed', ${when}, ${timestamp}, ${retryJson}, ${ownerPathJson}, ${ownerPathKey})
      `;

      await this._scheduleNextAlarm();
      return {
        schedule: {
          callback,
          delayInSeconds: when,
          id,
          payload: payload as T,
          retry: options?.retry,
          time: timestamp,
          type: "delayed"
        },
        created: true
      };
    }

    if (typeof when === "string") {
      const timestamp = Math.floor(getNextCronTime(when).getTime() / 1000);
      const idempotent = options?.idempotent !== false;

      if (idempotent) {
        const existing = this.sql<ScheduleStorageRow>`
          SELECT * FROM cf_agents_schedules
          WHERE type = 'cron'
            AND callback = ${callback}
            AND cron = ${when}
            AND payload IS ${payloadJson}
            AND owner_path_key IS ${ownerPathKey}
          LIMIT 1
        `;

        if (existing.length > 0) {
          const row = existing[0];
          await this._scheduleNextAlarm();
          return {
            schedule: {
              callback: row.callback,
              cron: row.cron ?? when,
              id: row.id,
              payload: JSON.parse(row.payload) as T,
              retry: parseRetryOptions(
                row as unknown as Record<string, unknown>
              ),
              time: row.time,
              type: "cron"
            },
            created: false
          };
        }
      }

      const id = nanoid(9);
      this.sql`
        INSERT OR REPLACE INTO cf_agents_schedules
          (id, callback, payload, type, cron, time, retry_options, owner_path, owner_path_key)
        VALUES
          (${id}, ${callback}, ${payloadJson}, 'cron', ${when}, ${timestamp}, ${retryJson}, ${ownerPathJson}, ${ownerPathKey})
      `;

      await this._scheduleNextAlarm();
      return {
        schedule: {
          callback,
          cron: when,
          id,
          payload: payload as T,
          retry: options?.retry,
          time: timestamp,
          type: "cron"
        },
        created: true
      };
    }

    throw new Error(
      `Invalid schedule type: ${JSON.stringify(when)}(${typeof when}) trying to schedule ${callback}`
    );
  }

  /**
   * Insert a schedule row owned by a descendant facet. Called via RPC
   * from the facet's `schedule()`. Returns `{ schedule, created }`
   * so the originating facet can suppress `schedule:create` on
   * idempotent dedup. This method does not emit observability
   * events itself.
   * @internal
   */
  async _cf_scheduleForFacet<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep>,
    when: Date | string | number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    return this._insertScheduleForOwner(
      ownerPath,
      when,
      callback,
      payload,
      options
    );
  }

  /**
   * Insert (or, for idempotent calls, return the existing row for) an
   * interval schedule. Mirrors {@link _insertScheduleForOwner} —
   * returns `{ schedule, created }` so callers can suppress
   * `schedule:create` on dedup.
   * @internal
   */
  private async _insertIntervalScheduleForOwner<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep> | null,
    intervalSeconds: number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; _idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    const ownerPathJson = ownerPath ? JSON.stringify(ownerPath) : null;
    const ownerPathKey = this._scheduleOwnerPathKey(ownerPath);
    const idempotent = options?._idempotent !== false;
    const payloadJson = JSON.stringify(payload);

    if (idempotent) {
      const existing = this.sql<ScheduleStorageRow>`
        SELECT * FROM cf_agents_schedules
        WHERE type = 'interval'
          AND callback = ${callback}
          AND intervalSeconds = ${intervalSeconds}
          AND payload IS ${payloadJson}
          AND owner_path_key IS ${ownerPathKey}
        LIMIT 1
      `;

      if (existing.length > 0) {
        const row = existing[0];
        await this._scheduleNextAlarm();
        return {
          schedule: {
            callback: row.callback,
            id: row.id,
            intervalSeconds: row.intervalSeconds ?? intervalSeconds,
            payload: JSON.parse(row.payload) as T,
            retry: parseRetryOptions(row as unknown as Record<string, unknown>),
            time: row.time,
            type: "interval"
          },
          created: false
        };
      }
    }

    const id = nanoid(9);
    const timestamp = Math.floor((Date.now() + intervalSeconds * 1000) / 1000);
    const retryJson = options?.retry ? JSON.stringify(options.retry) : null;

    this.sql`
      INSERT OR REPLACE INTO cf_agents_schedules
        (id, callback, payload, type, intervalSeconds, time, running, retry_options, owner_path, owner_path_key)
      VALUES
        (${id}, ${callback}, ${payloadJson}, 'interval', ${intervalSeconds}, ${timestamp}, 0, ${retryJson}, ${ownerPathJson}, ${ownerPathKey})
    `;

    await this._scheduleNextAlarm();
    return {
      schedule: {
        callback,
        id,
        intervalSeconds,
        payload: payload as T,
        retry: options?.retry,
        time: timestamp,
        type: "interval"
      },
      created: true
    };
  }

  /**
   * Insert an interval schedule row owned by a descendant facet.
   * Called via RPC from the facet's `scheduleEvery()`. Returns
   * `{ schedule, created }` so the originating facet can suppress
   * `schedule:create` on idempotent dedup. This method does not
   * emit observability events itself.
   * @internal
   */
  async _cf_scheduleEveryForFacet<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep>,
    intervalSeconds: number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; _idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    return this._insertIntervalScheduleForOwner(
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
  async _cf_cancelScheduleForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>,
    id: string
  ): Promise<{ ok: boolean; callback?: string }> {
    const ownerPathKey = this._scheduleOwnerPathKey(ownerPath);
    const result = this.sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules
      WHERE id = ${id} AND owner_path_key IS ${ownerPathKey}
    `;
    if (result.length === 0) return { ok: false };

    const callback = result[0].callback;
    this.sql`
      DELETE FROM cf_agents_schedules
      WHERE id = ${id} AND owner_path_key IS ${ownerPathKey}
    `;
    await this._scheduleNextAlarm();
    return { ok: true, callback };
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
    const rows = this.sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules
      WHERE owner_path IS NOT NULL
    `;
    const rowsToDelete = rows.filter((row) => {
      if (!row.owner_path) return false;
      try {
        const rowOwnerPath = JSON.parse(row.owner_path) as AgentPathStep[];
        return this._isSameAgentPathPrefix(ownerPath, rowOwnerPath);
      } catch {
        return false;
      }
    });

    for (const row of rowsToDelete) {
      this._emit("schedule:cancel", {
        callback: row.callback,
        id: row.id
      });
      this.sql`DELETE FROM cf_agents_schedules WHERE id = ${row.id}`;
    }

    this._deleteFacetRunRowsForPrefix(ownerPath);
    await this._scheduleNextAlarm();
  }

  private _scheduleRowToSchedule<T>(row: ScheduleStorageRow): Schedule<T> {
    const base = {
      callback: row.callback,
      id: row.id,
      payload: JSON.parse(row.payload) as T,
      retry: parseRetryOptions(row as unknown as Record<string, unknown>)
    };

    switch (row.type) {
      case "scheduled":
        return {
          ...base,
          time: row.time,
          type: "scheduled"
        };
      case "delayed":
        return {
          ...base,
          delayInSeconds: row.delayInSeconds ?? 0,
          time: row.time,
          type: "delayed"
        };
      case "cron":
        return {
          ...base,
          cron: row.cron ?? "",
          time: row.time,
          type: "cron"
        };
      case "interval":
        return {
          ...base,
          intervalSeconds: row.intervalSeconds ?? 0,
          time: row.time,
          type: "interval"
        };
    }
  }

  private _getScheduleForOwner<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep> | null,
    id: string
  ): Schedule<T> | undefined {
    const ownerPathKey = this._scheduleOwnerPathKey(ownerPath);
    const result = this.sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules
      WHERE id = ${id} AND owner_path_key IS ${ownerPathKey}
    `;
    if (!result || result.length === 0) {
      return undefined;
    }
    return this._scheduleRowToSchedule<T>(result[0]);
  }

  private _listSchedulesForOwner<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep> | null,
    criteria: ScheduleCriteria = {}
  ): Schedule<T>[] {
    const ownerPathKey = this._scheduleOwnerPathKey(ownerPath);
    let query = "SELECT * FROM cf_agents_schedules WHERE owner_path_key IS ?";
    const params: Array<string | number | null> = [ownerPathKey];

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

    return this.ctx.storage.sql
      .exec(query, ...params)
      .toArray()
      .map((row) =>
        this._scheduleRowToSchedule<T>(row as unknown as ScheduleStorageRow)
      );
  }

  /**
   * Read a single schedule row owned by a descendant facet.
   * @internal
   */
  async _cf_getScheduleForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>,
    id: string
  ): Promise<Schedule<unknown> | undefined> {
    return this._getScheduleForOwner(ownerPath, id);
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
    return this._listSchedulesForOwner(ownerPath, criteria);
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
    const ownerPathKey = this._scheduleOwnerPathKey(ownerPath);
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
    const ownerPathKey = this._scheduleOwnerPathKey(ownerPath);
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
    const ownerPathKey = this._scheduleOwnerPathKey(ownerPath);
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
  async schedule<T = string>(
    when: Date | string | number,
    callback: keyof this,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<Schedule<T>> {
    this._validateScheduleCallback(when, callback, options);

    const result = this._isFacet
      ? await (
          await this._rootAlarmOwner()
        )._cf_scheduleForFacet<T>(
          this.selfPath,
          when,
          callback,
          payload,
          options
        )
      : await this._insertScheduleForOwner(
          null,
          when,
          callback,
          payload,
          options
        );

    if (result.created) {
      this._emit("schedule:create", {
        callback: result.schedule.callback,
        id: result.schedule.id
      });
    }
    return result.schedule;
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
  async scheduleEvery<T = string>(
    intervalSeconds: number,
    callback: keyof this,
    payload?: T,
    options?: { retry?: RetryOptions; _idempotent?: boolean }
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

    if (options?.retry) {
      validateRetryOptions(options.retry, this._resolvedOptions.retry);
    }

    const result = this._isFacet
      ? await (
          await this._rootAlarmOwner()
        )._cf_scheduleEveryForFacet<T>(
          this.selfPath,
          intervalSeconds,
          callback,
          payload,
          options
        )
      : await this._insertIntervalScheduleForOwner(
          null,
          intervalSeconds,
          callback,
          payload,
          options
        );

    if (result.created) {
      this._emit("schedule:create", {
        callback: result.schedule.callback,
        id: result.schedule.id
      });
    }
    return result.schedule;
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
    if (this._isFacet) {
      throw new Error(
        "getSchedule() is synchronous and cannot read parent-owned sub-agent schedules. " +
          "Use await this.getScheduleById(id) instead."
      );
    }
    return this._getScheduleForOwner(null, id);
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
  async getScheduleById(id: string): Promise<Schedule<unknown> | undefined> {
    if (this._isFacet) {
      const root = await this._rootAlarmOwner();
      return root._cf_getScheduleForFacet(this.selfPath, id);
    }
    return this._getScheduleForOwner(null, id);
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
    if (this._isFacet) {
      throw new Error(
        "getSchedules() is synchronous and cannot read parent-owned sub-agent schedules. " +
          "Use await this.listSchedules(criteria) instead."
      );
    }

    return this._listSchedulesForOwner(null, criteria);
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
  async listSchedules(
    criteria: ScheduleCriteria = {}
  ): Promise<Schedule<unknown>[]> {
    if (this._isFacet) {
      const root = await this._rootAlarmOwner();
      return root._cf_listSchedulesForFacet(this.selfPath, criteria);
    }
    return this._listSchedulesForOwner(null, criteria);
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
  async cancelSchedule(id: string): Promise<boolean> {
    if (this._isFacet) {
      const root = await this._rootAlarmOwner();
      const result = await root._cf_cancelScheduleForFacet(this.selfPath, id);
      if (result.ok && result.callback) {
        this._emit("schedule:cancel", { callback: result.callback, id });
      }
      return result.ok;
    }
    const schedule = this._getScheduleForOwner(null, id);
    if (!schedule) {
      return false;
    }

    this._emit("schedule:cancel", {
      callback: schedule.callback,
      id: schedule.id
    });

    this.sql`DELETE FROM cf_agents_schedules WHERE id = ${id}`;

    await this._scheduleNextAlarm();
    return true;
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
  async runFiber<T>(
    name: string,
    fn: (ctx: FiberContext) => Promise<T>
  ): Promise<T> {
    const id = nanoid();
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, NULL, ${Date.now()})
    `;
    this._runFiberActiveFibers.add(id);

    let root: RootFacetRpcSurface | undefined;
    let registeredFacetRun = false;
    let dispose: () => void = () => {};
    try {
      if (this._isFacet) {
        root = await this._rootAlarmOwner();
        await root._cf_registerFacetRun(this.selfPath, id);
        registeredFacetRun = true;
      }

      dispose = await this.keepAlive();
      const stash = (data: unknown) => {
        this.sql`
          UPDATE cf_agents_runs SET snapshot = ${JSON.stringify(data)}
          WHERE id = ${id}
        `;
      };

      return await _fiberALS.run({ id, stash }, () =>
        fn({ id, stash, snapshot: null })
      );
    } finally {
      this._runFiberActiveFibers.delete(id);
      this.sql`DELETE FROM cf_agents_runs WHERE id = ${id}`;
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
  ): Promise<void> {
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

    try {
      const rows = this.sql<{
        id: string;
        name: string;
        snapshot: string | null;
        created_at: number;
      }>`SELECT id, name, snapshot, created_at FROM cf_agents_runs`;

      for (const row of rows) {
        if (this._runFiberActiveFibers.has(row.id)) continue;

        let snapshot: unknown = null;
        if (row.snapshot) {
          try {
            snapshot = JSON.parse(row.snapshot);
          } catch {
            console.warn(
              `[Agent] Corrupted snapshot for fiber ${row.id}, treating as null`
            );
          }
        }

        const ctx: FiberRecoveryContext = {
          id: row.id,
          name: row.name,
          snapshot,
          createdAt: row.created_at
        };

        try {
          const handled = await this._handleInternalFiberRecovery(ctx);
          if (!handled) {
            await this.onFiberRecovered(ctx);
          }
        } catch (e) {
          console.error(
            `[Agent] Fiber recovery failed for "${ctx.name}" (${ctx.id}):`,
            e
          );
        }

        this.sql`DELETE FROM cf_agents_runs WHERE id = ${row.id}`;
      }
    } finally {
      this._runFiberRecoveryInProgress = false;
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
      await this._executeScheduleCallback(row);
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
  async _cf_destroyDescendantFacet(
    targetPath: ReadonlyArray<AgentPathStep>
  ): Promise<void> {
    const selfPath = this.selfPath;

    if (targetPath.length === 0) {
      throw new Error(
        "_cf_destroyDescendantFacet: target path must not be empty."
      );
    }
    if (selfPath.length >= targetPath.length) {
      throw new Error(
        "_cf_destroyDescendantFacet: target must be a strict descendant."
      );
    }
    if (!this._isSameAgentPathPrefix(selfPath, targetPath)) {
      throw new Error(
        "_cf_destroyDescendantFacet: target path does not descend from this agent."
      );
    }

    // The root owns every schedule row; cancel the target's prefix
    // upfront so we don't have to make an extra round trip back from
    // each intermediate hop.
    if (this._parentPath.length === 0) {
      await this._cf_cleanupFacetPrefix(targetPath);
    }

    if (selfPath.length === targetPath.length - 1) {
      // We are the immediate parent of the target — perform the local
      // facet teardown the same way `deleteSubAgent` does.
      const target = targetPath[targetPath.length - 1];
      const ctx = this.ctx as unknown as Partial<FacetCapableCtx>;
      if (!ctx.facets) {
        throw new Error(
          "destroy() (delegated from facet) is not supported in this runtime — " +
            "`ctx.facets` is unavailable. " +
            "Update to the latest `compatibility_date` in your wrangler.jsonc."
        );
      }
      try {
        ctx.facets.delete(`${target.className}\0${target.name}`);
      } catch {
        // no-op — facet wasn't registered (already deleted / never spawned)
      }
      this._forgetSubAgent(target.className, target.name);
      return;
    }

    // Recurse one step deeper.
    const next = targetPath[selfPath.length];
    if (!this.hasSubAgent(next.className, next.name)) {
      // Already gone — schedules are cleared, nothing more to do.
      return;
    }
    const stub = await this._cf_resolveSubAgent(next.className, next.name);
    const handle = stub as unknown as {
      _cf_destroyDescendantFacet(
        targetPath: ReadonlyArray<AgentPathStep>
      ): Promise<void>;
    };
    await handle._cf_destroyDescendantFacet(targetPath);
  }

  private async _executeScheduleCallback(
    row: ScheduleStorageRow
  ): Promise<void> {
    const callback = this[row.callback as keyof Agent<Env>];
    if (!callback) {
      console.error(`callback ${row.callback} not found`);
      return;
    }

    await agentContext.run(
      {
        agent: this,
        connection: undefined,
        request: undefined,
        email: undefined
      },
      async () => {
        const retryOpts = parseRetryOptions(
          row as unknown as Record<string, unknown>
        );
        const { maxAttempts, baseDelayMs, maxDelayMs } = resolveRetryConfig(
          retryOpts,
          this._resolvedOptions.retry
        );

        let parsedPayload: unknown;
        try {
          parsedPayload = JSON.parse(row.payload as string);
        } catch (e) {
          console.error(
            `Failed to parse payload for schedule "${row.id}" (callback "${row.callback}")`,
            e
          );
          this._emit("schedule:error", {
            callback: row.callback,
            id: row.id,
            error: e instanceof Error ? e.message : String(e),
            attempts: 0
          });
          return;
        }

        try {
          this._emit("schedule:execute", {
            callback: row.callback,
            id: row.id
          });

          await tryN(
            maxAttempts,
            async (attempt) => {
              if (attempt > 1) {
                this._emit("schedule:retry", {
                  callback: row.callback,
                  id: row.id,
                  attempt,
                  maxAttempts
                });
              }
              await (
                callback as (
                  payload: unknown,
                  schedule: Schedule<unknown>
                ) => Promise<void>
              ).bind(this)(parsedPayload, row as unknown as Schedule<unknown>);
            },
            { baseDelayMs, maxDelayMs }
          );
        } catch (e) {
          console.error(
            `error executing callback "${row.callback}" after ${maxAttempts} attempts`,
            e
          );
          this._emit("schedule:error", {
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
        }
      }
    );
  }

  private async _scheduleNextAlarm() {
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const hungCutoffSeconds =
      nowSeconds - this._resolvedOptions.hungScheduleTimeoutSeconds;

    // Find the earliest schedule row that is safe to execute now, even if it
    // is already overdue. Overdue schedules can happen after a DO restart
    // because the SQLite row survives but the in-memory alarm does not.
    const readySchedules = this.sql<{
      time: number;
    }>`
      SELECT time FROM cf_agents_schedules
      WHERE type != 'interval'
        OR running = 0
        OR coalesce(execution_started_at, 0) <= ${hungCutoffSeconds}
      ORDER BY time ASC
      LIMIT 1
    `;

    // Running interval schedules that are not hung yet still need a future
    // alarm so the runtime can re-check them once they cross the hung timeout.
    const recoveringIntervals = this.sql<{
      execution_started_at: number | null;
    }>`
      SELECT execution_started_at FROM cf_agents_schedules
      WHERE type = 'interval'
        AND running = 1
        AND coalesce(execution_started_at, 0) > ${hungCutoffSeconds}
      ORDER BY execution_started_at ASC
      LIMIT 1
    `;

    let nextTimeMs: number | null = null;
    if (readySchedules.length > 0 && "time" in readySchedules[0]) {
      nextTimeMs = Math.max(
        (readySchedules[0].time as number) * 1000,
        nowMs + 1
      );
    }

    if (
      recoveringIntervals.length > 0 &&
      recoveringIntervals[0].execution_started_at !== null
    ) {
      const recoveryTimeMs =
        (recoveringIntervals[0].execution_started_at +
          this._resolvedOptions.hungScheduleTimeoutSeconds) *
        1000;
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

    const now = Math.floor(Date.now() / 1000);

    // Get all schedules that should be executed now
    const result = this.sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules WHERE time <= ${now}
    `;

    if (result && Array.isArray(result)) {
      // Warn when many stale one-shot rows share the same callback — this
      // usually means schedule() was called repeatedly (e.g. in onStart)
      // without idempotent:true and rows accumulated across restarts.
      const DUPLICATE_SCHEDULE_THRESHOLD = 10;
      const oneShotCounts = new Map<string, number>();
      for (const row of result) {
        if (row.type === "delayed" || row.type === "scheduled") {
          oneShotCounts.set(
            row.callback,
            (oneShotCounts.get(row.callback) ?? 0) + 1
          );
        }
      }
      for (const [cb, count] of oneShotCounts) {
        if (count >= DUPLICATE_SCHEDULE_THRESHOLD) {
          try {
            console.warn(
              `Processing ${count} stale "${cb}" schedules in a single alarm cycle. ` +
                `This usually means schedule() is being called repeatedly without ` +
                `the idempotent option. Consider using scheduleEvery() for recurring ` +
                `tasks or passing { idempotent: true } to schedule().`
            );
            this._emit("schedule:duplicate_warning", {
              callback: cb,
              count,
              type: "one-shot"
            });
          } catch {
            // Warning emission is non-critical — never block row processing.
          }
        }
      }

      for (const row of result as ScheduleStorageRow[]) {
        let executed = false;

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

        if (row.owner_path) {
          try {
            const ownerPath = JSON.parse(row.owner_path) as AgentPathStep[];
            executed = await this._cf_dispatchScheduledCallback(ownerPath, row);
          } catch (e) {
            console.error(
              `error dispatching scheduled callback "${row.callback}"`,
              e
            );
            this._emit("schedule:error", {
              callback: row.callback,
              id: row.id,
              error: e instanceof Error ? e.message : String(e),
              attempts: 0
            });
            try {
              await this.onError(e);
            } catch {
              // swallow onError errors
            }
            // Reset the in-flight flag for interval rows so the row
            // doesn't stay stuck in `running=1` when dispatch fails
            // (e.g. the facet's registry entry is missing). The next
            // alarm cycle will retry.
            if (row.type === "interval") {
              this.sql`
                UPDATE cf_agents_schedules SET running = 0 WHERE id = ${row.id}
              `;
            }
            continue;
          }
        } else {
          await this._executeScheduleCallback(row);
          executed = true;
        }

        if (this._destroyed) return;
        if (!executed) continue;

        if (row.type === "cron") {
          // Update next execution time for cron schedules
          const nextExecutionTime = getNextCronTime(row.cron ?? "");
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
      const stored = this._cf_virtualSubAgentConnections.get(id);
      if (stored) {
        return this._cf_createSubAgentBridgeConnection(
          stored.bridge,
          stored.meta
        ) as Connection<TState>;
      }
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
      for (const stored of this._cf_virtualSubAgentConnections.values()) {
        if (!tag || stored.meta.tags.includes(tag)) {
          yield this._cf_createSubAgentBridgeConnection(
            stored.bridge,
            stored.meta
          ) as Connection<TState>;
        }
      }
    }

    for (const connection of super.getConnections<TState>(tag)) {
      if (this._cf_connectionHasSubAgentTarget(connection)) continue;
      yield connection;
    }
  }

  private async _cf_broadcastToParentSubAgent(
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): Promise<void> {
    if (this._cf_currentSubAgentBridge) {
      this._cf_currentSubAgentBridge.broadcast(this.selfPath, message, without);
      return;
    }
    const root = await this._rootAlarmOwner();
    await root._cf_broadcastToSubAgent(this.selfPath, message, without);
  }

  async _cf_broadcastToSubAgent(
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): Promise<void> {
    if (this._isFacet && this._cf_currentSubAgentBridge) {
      this._cf_currentSubAgentBridge.broadcast(ownerPath, message, without);
      return;
    }

    for (const connection of super.getConnections()) {
      if (without?.includes(connection.id)) continue;
      const targetPath = this._cf_subAgentTargetPath(connection);
      if (!targetPath) continue;
      if (!this._isSameAgentPath(targetPath, ownerPath)) continue;
      connection.send(message);
    }
  }

  async _cf_subAgentConnectionMetas(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<SubAgentConnectionMeta[]> {
    const metas: SubAgentConnectionMeta[] = [];
    for (const connection of super.getConnections()) {
      const meta = this._cf_subAgentConnectionMetaForPath(
        connection,
        ownerPath
      );
      if (meta) metas.push(meta);
    }
    return metas;
  }

  async _cf_sendToSubAgentConnection(
    connectionId: string,
    message: string | ArrayBuffer | ArrayBufferView
  ): Promise<void> {
    const connection = super.getConnection(connectionId);
    if (!connection || !this._cf_connectionHasSubAgentTarget(connection)) {
      return;
    }
    connection.send(message);
  }

  async _cf_closeSubAgentConnection(
    connectionId: string,
    code?: number,
    reason?: string
  ): Promise<void> {
    const connection = super.getConnection(connectionId);
    if (!connection || !this._cf_connectionHasSubAgentTarget(connection)) {
      return;
    }
    connection.close(code, reason);
  }

  async _cf_setSubAgentConnectionState(
    connectionId: string,
    state: unknown
  ): Promise<unknown> {
    const connection = super.getConnection(connectionId);
    if (!connection || !this._cf_connectionHasSubAgentTarget(connection)) {
      return null;
    }
    this._ensureConnectionWrapped(connection);
    connection.setState(state);
    return this._cf_getForwardedSubAgentState(connection);
  }

  private _cf_subAgentConnectionMetaForPath(
    connection: Connection,
    ownerPath: ReadonlyArray<AgentPathStep>
  ): SubAgentConnectionMeta | null {
    this._ensureConnectionWrapped(connection);
    const outerUri = this._unsafe_getConnectionFlag(
      connection,
      CF_SUB_AGENT_OUTER_URL_KEY
    );
    if (typeof outerUri !== "string") return null;

    const target = this._cf_subAgentPathFromOuterUri(outerUri, ownerPath);
    if (!target) return null;

    const raw = this._cf_getRawConnectionState(connection);
    const rawTags =
      raw != null && typeof raw === "object"
        ? (raw as Record<string, unknown>)[CF_SUB_AGENT_TAGS_KEY]
        : undefined;
    const tags = Array.isArray(rawTags)
      ? rawTags.filter((tag): tag is string => typeof tag === "string")
      : [...connection.tags];
    return {
      id: connection.id,
      uri: target.uri,
      tags,
      state: this._cf_getForwardedSubAgentState(connection)
    };
  }

  private _cf_subAgentTargetPath(
    connection: Connection
  ): ReadonlyArray<AgentPathStep> | null {
    this._ensureConnectionWrapped(connection);
    const outerUri = this._unsafe_getConnectionFlag(
      connection,
      CF_SUB_AGENT_OUTER_URL_KEY
    );
    if (typeof outerUri !== "string") return null;

    return this._cf_subAgentPathFromOuterUri(outerUri)?.path ?? null;
  }

  private _cf_subAgentPathFromOuterUri(
    outerUri: string,
    stopAt?: ReadonlyArray<AgentPathStep>
  ): { path: ReadonlyArray<AgentPathStep>; uri: string } | null {
    const ctx = this.ctx as unknown as Partial<FacetCapableCtx>;
    const knownClasses = ctx.exports ? Object.keys(ctx.exports) : undefined;
    const path: AgentPathStep[] = [...this.selfPath];
    let currentUrl = outerUri;

    while (true) {
      const match = _parseSubAgentPath(currentUrl, { knownClasses });
      if (!match) break;
      path.push({ className: match.childClass, name: match.childName });
      const rewritten = new URL(currentUrl);
      rewritten.pathname = match.remainingPath;
      currentUrl = rewritten.toString();
      if (stopAt && this._isSameAgentPath(path, stopAt)) {
        return { path, uri: currentUrl };
      }
    }

    if (path.length === this.selfPath.length) return null;
    if (stopAt) return null;
    return { path, uri: currentUrl };
  }

  private _isSameAgentPath(
    a: ReadonlyArray<AgentPathStep>,
    b: ReadonlyArray<AgentPathStep>
  ): boolean {
    if (a.length !== b.length) return false;
    return a.every(
      (step, index) =>
        step.className === b[index]?.className && step.name === b[index]?.name
    );
  }

  private _cf_connectionHasSubAgentTarget(connection: Connection): boolean {
    this._ensureConnectionWrapped(connection);
    return (
      typeof this._unsafe_getConnectionFlag(
        connection,
        CF_SUB_AGENT_OUTER_URL_KEY
      ) === "string"
    );
  }

  protected _cf_connectionTargetsSubAgent(connection: Connection): boolean {
    if (!connection.uri) return false;
    const ctx = this.ctx as unknown as Partial<FacetCapableCtx>;
    return (
      _parseSubAgentPath(connection.uri, {
        knownClasses: ctx.exports ? Object.keys(ctx.exports) : undefined
      }) !== null
    );
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
    const ctx = this.ctx as unknown as Partial<FacetCapableCtx>;
    return (
      _parseSubAgentPath(request.url, {
        knownClasses: ctx.exports ? Object.keys(ctx.exports) : undefined
      }) !== null
    );
  }

  private async _cf_forwardSubAgentWebSocketConnect(
    connection: Connection,
    request: Request,
    options: { gate: boolean }
  ): Promise<boolean> {
    const routed = await this._cf_resolveSubAgentConnection(
      connection,
      request,
      options
    );
    if (!routed) return false;

    await routed.child._cf_handleSubAgentWebSocketConnect(
      this._cf_createSubAgentConnectionBridge(connection),
      routed.meta
    );
    return true;
  }

  private _cf_createSubAgentConnectionBridge(
    connection: Connection
  ): SubAgentConnectionBridge {
    return new SubAgentConnectionBridge(
      connection,
      (ownerPath, message, without) => {
        void this._cf_broadcastToSubAgent(ownerPath, message, without);
      }
    );
  }

  private async _cf_forwardSubAgentWebSocketMessage(
    connection: Connection,
    message: WSMessage
  ): Promise<boolean> {
    const routed = await this._cf_resolveSubAgentConnection(connection);
    if (!routed) return false;

    await routed.child._cf_handleSubAgentWebSocketMessage(
      message,
      this._cf_createSubAgentConnectionBridge(connection),
      routed.meta
    );
    return true;
  }

  private async _cf_forwardSubAgentWebSocketClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<boolean> {
    const routed = await this._cf_resolveSubAgentConnection(connection);
    if (!routed) return false;

    await routed.child._cf_handleSubAgentWebSocketClose(
      code,
      reason,
      wasClean,
      this._cf_createSubAgentConnectionBridge(connection),
      routed.meta
    );
    return true;
  }

  private async _cf_resolveSubAgentConnection(
    connection: Connection,
    request?: Request,
    options: { gate: boolean } = { gate: false }
  ): Promise<{
    child: SubAgentWebSocketEndpoint;
    meta: SubAgentConnectionMeta;
  } | null> {
    this._ensureConnectionWrapped(connection);
    const outerUri = this._unsafe_getConnectionFlag(
      connection,
      CF_SUB_AGENT_OUTER_URL_KEY
    );
    const uri = typeof outerUri === "string" ? outerUri : connection.uri;
    if (!uri) return null;

    const ctx = this.ctx as unknown as Partial<FacetCapableCtx>;
    let match = _parseSubAgentPath(uri, {
      knownClasses: ctx.exports ? Object.keys(ctx.exports) : undefined
    });
    if (!match) return null;
    if (
      this._ParentClass.name === match.childClass &&
      this.name === match.childName
    ) {
      const tailUri = new URL(uri);
      tailUri.pathname = match.remainingPath;
      match = _parseSubAgentPath(tailUri.toString(), {
        knownClasses: ctx.exports ? Object.keys(ctx.exports) : undefined
      });
      if (!match) return null;
    }

    let forwardReq = request;
    if (request && options.gate) {
      const decision = await this.onBeforeSubAgent(request, {
        className: match.childClass,
        name: match.childName
      });
      if (decision instanceof Response) {
        connection.close(1008, "Sub-agent connection rejected");
        return null;
      }
      forwardReq = decision instanceof Request ? decision : request;
    }

    const child = (await this._cf_resolveSubAgent(
      match.childClass,
      match.childName
    )) as SubAgentWebSocketEndpoint;

    const childUri = new URL(forwardReq?.url ?? uri);
    childUri.pathname = match.remainingPath;
    const raw = this._cf_getRawConnectionState(connection);
    const rawTags =
      raw != null && typeof raw === "object"
        ? (raw as Record<string, unknown>)[CF_SUB_AGENT_TAGS_KEY]
        : undefined;
    const tags = Array.isArray(rawTags)
      ? rawTags.filter((tag): tag is string => typeof tag === "string")
      : [...connection.tags];

    return {
      child,
      meta: {
        id: connection.id,
        uri: childUri.toString(),
        tags,
        state: this._cf_getForwardedSubAgentState(connection),
        requestHeaders: forwardReq ? [...forwardReq.headers] : undefined
      }
    };
  }

  async _cf_handleSubAgentWebSocketConnect(
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void> {
    await this._cf_runWithSubAgentBridge(bridge, async () => {
      const connection = this._cf_createSubAgentBridgeConnection(bridge, meta);
      const request = new Request(meta.uri ?? "http://placeholder/", {
        headers: meta.requestHeaders
      });
      if (
        await this._cf_forwardSubAgentWebSocketConnect(connection, request, {
          gate: true
        })
      ) {
        return;
      }

      if (this.shouldConnectionBeReadonly(connection, { request })) {
        this.setConnectionReadonly(connection, true);
      }
      if (!this.shouldSendProtocolMessages(connection, { request })) {
        this._setConnectionNoProtocol(connection);
      }

      const childTags = await this.getConnectionTags(connection, { request });
      (connection as unknown as { tags: string[] }).tags = [
        connection.id,
        ...childTags.filter((tag) => tag !== connection.id)
      ];
      this._cf_storeVirtualSubAgentConnection(bridge, connection);
      await this.onConnect(connection, { request });
      this._cf_storeVirtualSubAgentConnection(bridge, connection);
    });
  }

  async _cf_handleSubAgentWebSocketMessage(
    message: WSMessage,
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void> {
    const connection = this._cf_createSubAgentBridgeConnection(bridge, meta);
    this._cf_storeVirtualSubAgentConnection(bridge, connection);
    await this._cf_runWithSubAgentBridge(bridge, () =>
      this.onMessage(connection, message)
    );
  }

  async _cf_handleSubAgentWebSocketClose(
    code: number,
    reason: string,
    wasClean: boolean,
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void> {
    const connection = this._cf_createSubAgentBridgeConnection(bridge, meta);
    this._cf_storeVirtualSubAgentConnection(bridge, connection);
    await this._cf_runWithSubAgentBridge(bridge, () =>
      this.onClose(connection, code, reason, wasClean)
    );
    this._cf_virtualSubAgentConnections.delete(meta.id);
  }

  private async _cf_runWithSubAgentBridge<T>(
    bridge: SubAgentConnectionBridgeLike,
    fn: () => Promise<T> | T
  ): Promise<T> {
    const previous = this._cf_currentSubAgentBridge;
    this._cf_currentSubAgentBridge = bridge;
    try {
      return await fn();
    } finally {
      this._cf_currentSubAgentBridge = previous;
    }
  }

  private _cf_createSubAgentBridgeConnection(
    bridge: SubAgentConnectionBridgeLike,
    meta: SubAgentConnectionMeta
  ): Connection {
    let stored = this._cf_virtualSubAgentConnections.get(meta.id);
    if (stored) {
      stored.bridge = bridge;
      stored.meta = meta;
      if (stored.connection) {
        (
          stored.connection as unknown as {
            uri: string | null;
            tags: string[];
          }
        ).uri = meta.uri;
        (
          stored.connection as unknown as {
            uri: string | null;
            tags: string[];
          }
        ).tags = meta.tags;
        return stored.connection;
      }
    } else {
      stored = { bridge, meta };
      this._cf_virtualSubAgentConnections.set(meta.id, stored);
    }

    const getStored = () =>
      this._cf_virtualSubAgentConnections.get(meta.id) ?? stored;
    const updateStoredState = (nextState: unknown) => {
      const current = this._cf_virtualSubAgentConnections.get(meta.id);
      if (current) {
        current.meta = { ...current.meta, state: nextState };
      }
    };

    const connection = {
      id: meta.id,
      uri: meta.uri,
      tags: meta.tags,
      server: this.name,
      get state() {
        return getStored().meta.state;
      },
      setState(next: unknown | ((prev: unknown) => unknown)) {
        const currentState = getStored().meta.state;
        const state = typeof next === "function" ? next(currentState) : next;
        updateStoredState(state);
        void getStored().bridge.setState(state);
        return state;
      },
      send(message: string | ArrayBuffer | ArrayBufferView) {
        void getStored().bridge.send(message);
      },
      close(code?: number, reason?: string) {
        void getStored().bridge.close(code, reason);
      },
      addEventListener() {},
      removeEventListener() {}
    } as unknown as Connection;

    stored.connection = connection;
    this._ensureConnectionWrapped(connection);
    return connection;
  }

  private _cf_storeVirtualSubAgentConnection(
    bridge: SubAgentConnectionBridgeLike,
    connection: Connection
  ): void {
    this._unsafe_setConnectionFlag(connection, CF_SUB_AGENT_TAGS_KEY, [
      ...connection.tags
    ]);
    const stored = this._cf_virtualSubAgentConnections.get(connection.id);
    this._cf_virtualSubAgentConnections.set(connection.id, {
      bridge,
      meta: {
        id: connection.id,
        uri: connection.uri,
        tags: [...connection.tags],
        state: this._cf_getRawConnectionState(connection)
      },
      connection: stored?.connection ?? connection
    });
  }

  protected async _cf_hydrateSubAgentConnectionsFromRoot(): Promise<void> {
    if (!this._isFacet || this._parentPath.length === 0) return;

    const root = await this._rootAlarmOwner();
    const metas = await root._cf_subAgentConnectionMetas(this.selfPath);
    for (const meta of metas) {
      this._cf_virtualSubAgentConnections.set(meta.id, {
        bridge: new RootSubAgentConnectionBridge(root, meta.id),
        meta
      });
    }
  }

  private _cf_getRawConnectionState(connection: Connection): unknown {
    this._ensureConnectionWrapped(connection);
    return this._rawStateAccessors.get(connection)?.getRaw() ?? null;
  }

  private _cf_getForwardedSubAgentState(connection: Connection): unknown {
    const raw = this._cf_getRawConnectionState(connection);
    if (raw == null || typeof raw !== "object") return raw;
    const { [CF_SUB_AGENT_OUTER_URL_KEY]: _, ...rest } = raw as Record<
      string,
      unknown
    >;
    return Object.keys(rest).length > 0 ? rest : null;
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
  private async _cf_forwardToFacet(
    req: Request,
    match: {
      childClass: string;
      childName: string;
      remainingPath: string;
    }
  ): Promise<Response> {
    let fetcher: { fetch(r: Request): Promise<Response> };
    try {
      fetcher = (await this._cf_resolveSubAgent(
        match.childClass,
        match.childName
      )) as { fetch(r: Request): Promise<Response> };
    } catch (err) {
      // Keep the wire response terse: don't leak the parent's view of
      // exports or internal error text over HTTP. The full error is
      // still available to developers via worker logs / `console.error`.
      const message = err instanceof Error ? err.message : String(err);
      console.error("[agents] sub-agent route failed:", message);
      if (/null character/i.test(message) || /reserved/i.test(message)) {
        return new Response("Bad Request", { status: 400 });
      }
      return new Response("Not Found", { status: 404 });
    }

    // Rewrite the URL to strip the /sub/{class}/{name} prefix. The
    // child's own fetch then processes either its own request (if
    // no further /sub/... remains) or recurses into its own child.
    const rewritten = new URL(req.url);
    rewritten.pathname = match.remainingPath;
    const forwardedHeaders = new Headers(req.headers);
    const forwardedInit: RequestInit = {
      method: req.method,
      headers: forwardedHeaders
    };
    if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      forwardedHeaders.set(SUB_AGENT_OUTER_URL_HEADER, req.url);
    }
    if (req.body && req.method !== "GET" && req.method !== "HEAD") {
      forwardedInit.body = await req.arrayBuffer();
    }
    const forwarded = new Request(rewritten, forwardedInit);
    return fetcher.fetch(forwarded);
  }

  /**
   * Bridge method used by `getSubAgentByName`. Resolves the facet
   * on each call (idempotent via `subAgent`) and dispatches one
   * RPC method. Stateless — no cached references.
   *
   * @internal
   */
  async _cf_invokeSubAgent(
    className: string,
    name: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const stub = await this._cf_resolveSubAgent(className, name);
    // Must call `handle[method](...)` in one expression — extracting
    // via `const fn = handle[method]; fn.apply(handle, args)` breaks
    // the workerd RpcProperty binding. (Confirmed by the spike.)
    const handle = stub as unknown as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    if (typeof handle[method] !== "function") {
      throw new Error(`Method "${method}" not found on ${className}.`);
    }
    return await handle[method](...args);
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
   * The facet's name (and `this.name` getter) is handled entirely by
   * partyserver via `ctx.id.name`, which is populated because the
   * parent passed an explicit `id: parentNs.idFromName(name)` to
   * `ctx.facets.get()` — see {@link _cf_resolveSubAgent}. No
   * `setName()` call or `__ps_name` storage write is needed; the
   * facet's name survives cold wake automatically because the
   * factory re-runs and `idFromName` is deterministic.
   *
   * @internal Called by {@link subAgent}.
   */
  async _cf_initAsFacet(
    name: string,
    parentPath: ReadonlyArray<{ className: string; name: string }> = []
  ): Promise<void> {
    // Defense in depth: the parent is supposed to construct the
    // facet with `id: parentNs.idFromName(name)` via
    // `_cf_resolveSubAgent`, which makes `this.name` resolve to
    // `name` automatically through partyserver's `ctx.id.name`. If
    // it didn't (e.g. someone bypassed `_cf_resolveSubAgent`, or
    // the parent's id construction has a bug), `this.name` would
    // silently report the parent's name instead of the facet's
    // name. Fail loud instead of letting a misconfigured facet
    // operate with the wrong identity.
    if (this.name !== name) {
      throw new Error(
        `Facet bootstrap mismatch: expected this.name === "${name}" but got "${this.name}". ` +
          `This usually means the parent passed the wrong (or no) id to ctx.facets.get(). ` +
          `See _cf_resolveSubAgent.`
      );
    }
    this._isFacet = true;
    this._parentPath = parentPath;
    // Persist the agent-specific facet keys in parallel.
    await Promise.all([
      this.ctx.storage.put("cf_agents_is_facet", true),
      this.ctx.storage.put("cf_agents_parent_path", parentPath)
    ]);
    // Fire onStart() now since this RPC bypasses Server.fetch(),
    // which is the entry point that normally triggers it. Suppress
    // protocol broadcasts only during startup so bootstrap cannot touch
    // parent-owned WebSocket handles if the parent is inside onMessage().
    this._suppressProtocolBroadcasts = true;
    try {
      await this.__unsafe_ensureInitialized();
    } finally {
      this._suppressProtocolBroadcasts = false;
    }
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
   * Resolve a typed RPC stub for this facet's **immediate** parent
   * agent.
   *
   * Symmetric with `subAgent(Cls, name)`: while `subAgent` opens a
   * stub from parent to child, `parentAgent` opens one from child
   * to parent. Pass the direct parent's class reference — the
   * framework verifies it matches the last entry of
   * `this.parentPath` at runtime, then looks up `env[Cls.name]` to
   * find the namespace binding.
   *
   * `this.parentPath` is root-first, so the direct parent is the
   * **last** entry: `this.parentPath.at(-1)`. For grandparents and
   * further ancestors, iterate `this.parentPath` and use
   * `getAgentByName(env.X, this.parentPath[i].name)` directly.
   *
   * Assumes the standard "binding name matches class name" convention.
   * If your `wrangler.jsonc` binds the parent under a different name
   * (e.g. `{ class_name: "Inbox", name: "MY_INBOX" }`), call
   * `getAgentByName(env.MY_INBOX, this.parentPath.at(-1)!.name)`
   * directly instead.
   *
   * @experimental The API surface may change before stabilizing.
   *
   * @throws If this agent is not a facet (no parent).
   * @throws If `Cls.name` doesn't match the recorded direct-parent
   *         class (guards against accidentally reaching the wrong
   *         DO, especially in nested Root → Mid → Leaf chains).
   * @throws If no env binding named `Cls.name` is found.
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
    const binding = (this.env as Record<string, unknown>)[cls.name] as
      | DurableObjectNamespace<T>
      | undefined;
    if (!binding) {
      throw new Error(
        `parentAgent(${cls.name}): no top-level binding "${cls.name}" ` +
          `found in env. If the parent is bound under a different name ` +
          `(e.g. "MY_${cls.name.toUpperCase()}"), use ` +
          `\`getAgentByName(env.MY_${cls.name.toUpperCase()}, this.parentPath.at(-1)!.name)\` directly.`
      );
    }
    return await getServerByName<Cloudflare.Env, T>(binding, parent.name);
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
  async subAgent<T extends Agent>(
    cls: SubAgentClass<T>,
    name: string
  ): Promise<SubAgentStub<T>> {
    return (await this._cf_resolveSubAgent(cls.name, name)) as SubAgentStub<T>;
  }

  /** Maximum number of non-terminal agent-tool runs this parent may own at once. */
  maxConcurrentAgentTools = Infinity;

  async onAgentToolStart(_run: AgentToolRunInfo): Promise<void> {}

  async onAgentToolFinish(
    _run: AgentToolRunInfo,
    _result: AgentToolLifecycleResult
  ): Promise<void> {}

  async runAgentTool<Input = unknown, Output = unknown>(
    cls: ChatCapableAgentClass,
    options: RunAgentToolOptions<Input>
  ): Promise<RunAgentToolResult<Output>> {
    const runId = options.runId ?? nanoid(12);
    const agentType = cls.name;
    const existing = this._readAgentToolRun(runId);
    if (existing) {
      if (this._isAgentToolTerminal(existing.status)) {
        if (existing.status === "completed" && existing.output_json == null) {
          try {
            const child = await this.subAgent(
              cls as SubAgentClass<Agent>,
              runId
            );
            const adapter = this._asAgentToolChildAdapter<Input, Output>(child);
            const inspection = await adapter.inspectAgentToolRun(runId);
            if (inspection?.status === "completed") {
              const result = this._terminalResultFromInspection<Output>(
                agentType,
                inspection
              );
              this._updateAgentToolTerminal(
                runId,
                result,
                inspection.completedAt
              );
              return result;
            }
          } catch {
            // Fall back to the retained parent row.
          }
        }
        return this._resultFromAgentToolRow<Output>(existing);
      }
      return await this._replayAndInterruptAgentToolRun<Output>(
        existing,
        "Agent tool run was still running, but live-tail reattachment is not supported in this runtime."
      );
    }

    const displayOrder = options.displayOrder ?? 0;
    const inputPreview =
      options.inputPreview ?? this._defaultAgentToolPreview(options.input);
    const displayJson =
      options.display !== undefined ? JSON.stringify(options.display) : null;
    const inputPreviewJson =
      inputPreview !== undefined ? JSON.stringify(inputPreview) : null;
    const startedAt = Date.now();

    if (this._activeAgentToolRunCount() >= this.maxConcurrentAgentTools) {
      const error = `maxConcurrentAgentTools (${this.maxConcurrentAgentTools}) exceeded`;
      this.sql`
        INSERT INTO cf_agent_tool_runs (
          run_id, parent_tool_call_id, agent_type, input_preview,
          input_redacted, status, error_message, display_metadata,
          display_order, started_at, completed_at
        ) VALUES (
          ${runId}, ${options.parentToolCallId ?? null}, ${agentType},
          ${inputPreviewJson}, 1, 'error', ${error}, ${displayJson},
          ${displayOrder}, ${startedAt}, ${Date.now()}
        )
      `;
      this._broadcastAgentToolEvent(options.parentToolCallId, 0, {
        kind: "started",
        runId,
        agentType,
        inputPreview,
        order: displayOrder,
        display: options.display
      });
      this._broadcastAgentToolEvent(options.parentToolCallId, 1, {
        kind: "error",
        runId,
        error
      });
      return { runId, agentType, status: "error", error };
    }

    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, input_preview,
        input_redacted, status, display_metadata, display_order, started_at
      ) VALUES (
        ${runId}, ${options.parentToolCallId ?? null}, ${agentType},
        ${inputPreviewJson}, 1, 'starting', ${displayJson}, ${displayOrder},
        ${startedAt}
      )
    `;

    const runInfo: AgentToolRunInfo = {
      runId,
      parentToolCallId: options.parentToolCallId,
      agentType,
      inputPreview,
      status: "starting",
      display: options.display,
      displayOrder,
      startedAt
    };
    await this.onAgentToolStart(runInfo);
    this._broadcastAgentToolEvent(options.parentToolCallId, 0, {
      kind: "started",
      runId,
      agentType,
      inputPreview,
      order: displayOrder,
      display: options.display
    });

    const child = await this.subAgent(cls as SubAgentClass<Agent>, runId);
    const adapter = this._asAgentToolChildAdapter<Input, Output>(child);
    const childStart = await adapter.startAgentToolRun(options.input, {
      runId
    });
    this._markAgentToolRunning(runId);
    let sequence = 1;
    let parentAbortListener: (() => void) | undefined;
    if (options.signal) {
      if (options.signal.aborted) {
        await adapter.cancelAgentToolRun(runId, options.signal.reason);
        const reason =
          options.signal.reason instanceof Error
            ? options.signal.reason.message
            : String(options.signal.reason ?? "cancelled");
        const result: RunAgentToolResult<Output> = {
          runId,
          agentType,
          status: "aborted",
          error: reason
        };
        await this._finishAgentToolRun(runInfo, result, { sequence });
        return result;
      } else {
        parentAbortListener = () => {
          void adapter.cancelAgentToolRun(runId, options.signal?.reason);
        };
        options.signal.addEventListener("abort", parentAbortListener, {
          once: true
        });
      }
    }

    try {
      if (adapter.tailAgentToolRun) {
        const stream = await adapter.tailAgentToolRun(runId, {
          afterSequence: -1
        });
        sequence = await this._forwardAgentToolStream(
          stream,
          options.parentToolCallId,
          runId,
          sequence,
          options.signal
        );
      } else {
        const chunks = await adapter.getAgentToolChunks(runId);
        sequence = this._broadcastAgentToolChunks(
          options.parentToolCallId,
          runId,
          chunks,
          sequence
        );
      }

      if (options.signal?.aborted) {
        await adapter.cancelAgentToolRun(runId, options.signal.reason);
        const reason =
          options.signal.reason instanceof Error
            ? options.signal.reason.message
            : String(options.signal.reason ?? "cancelled");
        const result: RunAgentToolResult<Output> = {
          runId,
          agentType,
          status: "aborted",
          error: reason
        };
        await this._finishAgentToolRun(runInfo, result, { sequence });
        return result;
      }

      const inspection =
        (await adapter.inspectAgentToolRun(runId)) ?? childStart;
      const result = this._terminalResultFromInspection<Output>(
        agentType,
        inspection
      );
      await this._finishAgentToolRun(runInfo, result, {
        sequence,
        completedAt: inspection.completedAt
      });
      return result;
    } catch (error) {
      if (options.signal?.aborted) {
        await adapter.cancelAgentToolRun(runId, options.signal.reason);
        const reason =
          options.signal.reason instanceof Error
            ? options.signal.reason.message
            : String(options.signal.reason ?? "cancelled");
        const result: RunAgentToolResult<Output> = {
          runId,
          agentType,
          status: "aborted",
          error: reason
        };
        await this._finishAgentToolRun(runInfo, result, { sequence });
        return result;
      }
      const message = error instanceof Error ? error.message : String(error);
      const result: RunAgentToolResult<Output> = {
        runId,
        agentType,
        status: "error",
        error: message
      };
      await this._finishAgentToolRun(runInfo, result, { sequence });
      return result;
    } finally {
      if (parentAbortListener && options.signal) {
        options.signal.removeEventListener("abort", parentAbortListener);
      }
    }
  }

  hasAgentToolRun<T extends Agent>(
    cls: SubAgentClass<T>,
    runId: string
  ): boolean;
  hasAgentToolRun(agentType: string, runId: string): boolean;
  hasAgentToolRun(classOrName: SubAgentClass | string, runId: string): boolean {
    const agentType =
      typeof classOrName === "string" ? classOrName : classOrName.name;
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agent_tool_runs
      WHERE run_id = ${runId} AND agent_type = ${agentType}
    `;
    return (rows[0]?.n ?? 0) > 0;
  }

  async clearAgentToolRuns(options?: {
    olderThan?: number;
    status?: AgentToolRunStatus[];
  }): Promise<void> {
    const rows = this.sql<{
      run_id: string;
      agent_type: string;
      status: string;
    }>`
      SELECT run_id, agent_type, status FROM cf_agent_tool_runs
      ORDER BY started_at ASC
    `;
    const statusFilter = options?.status
      ? new Set<string>(options.status)
      : null;
    const retained = rows.filter((row) => {
      if (statusFilter && !statusFilter.has(row.status)) return false;
      if (options?.olderThan !== undefined) {
        const full = this._readAgentToolRun(row.run_id);
        if (!full || full.started_at >= options.olderThan) return false;
      }
      return true;
    });

    for (const row of retained) {
      try {
        const cls = this._agentToolClassByName(row.agent_type);
        if (row.status === "starting" || row.status === "running") {
          const child = await this.subAgent(cls, row.run_id);
          const adapter = this._asAgentToolChildAdapter(child);
          await adapter.cancelAgentToolRun(
            row.run_id,
            "clearing agent tool run"
          );
        }
        await this.deleteSubAgent(cls, row.run_id);
      } catch {
        // Cleanup is intentionally idempotent.
      }
      this.sql`
        DELETE FROM cf_agent_tool_runs WHERE run_id = ${row.run_id}
      `;
    }
  }

  private _isAgentToolTerminal(status: string): boolean {
    return (
      status === "completed" ||
      status === "error" ||
      status === "aborted" ||
      status === "interrupted"
    );
  }

  private _activeAgentToolRunCount(): number {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agent_tool_runs
      WHERE status IN ('starting', 'running')
    `;
    return rows[0]?.n ?? 0;
  }

  private _defaultAgentToolPreview(input: unknown): unknown {
    if (typeof input === "string") return input.slice(0, 500);
    if (input === null || input === undefined) return input;
    try {
      const json = JSON.stringify(input);
      return json.length > 500 ? `${json.slice(0, 497)}...` : json;
    } catch {
      return String(input).slice(0, 500);
    }
  }

  private _readAgentToolRun(runId: string): AgentToolRunStorageRow | null {
    const rows = this.sql<AgentToolRunStorageRow>`
      SELECT run_id, parent_tool_call_id, agent_type, input_preview, status,
             summary, output_json, error_message, display_metadata, display_order,
             started_at, completed_at
      FROM cf_agent_tool_runs
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private _resultFromAgentToolRow<Output>(
    row: AgentToolRunStorageRow
  ): RunAgentToolResult<Output> {
    const output = this._parseAgentToolJson(row.output_json) as
      | Output
      | undefined;
    return {
      runId: row.run_id,
      agentType: row.agent_type,
      status: row.status as RunAgentToolResult<Output>["status"],
      ...(output !== undefined ? { output } : {}),
      ...(row.summary !== null ? { summary: row.summary } : {}),
      ...(row.error_message !== null ? { error: row.error_message } : {})
    };
  }

  private _agentToolRunInfoFromRow(
    row: AgentToolRunStorageRow,
    status: AgentToolRunStatus = row.status,
    completedAt = row.completed_at ?? undefined
  ): AgentToolRunInfo {
    return {
      runId: row.run_id,
      parentToolCallId: row.parent_tool_call_id ?? undefined,
      agentType: row.agent_type,
      inputPreview: this._parseAgentToolJson(row.input_preview),
      status,
      display: this._parseAgentToolJson(row.display_metadata) as
        | AgentToolDisplayMetadata
        | undefined,
      displayOrder: row.display_order,
      startedAt: row.started_at,
      completedAt
    };
  }

  private _terminalResultFromInspection<Output>(
    agentType: string,
    inspection: AgentToolRunInspection<Output>
  ): RunAgentToolResult<Output> {
    if (inspection.status === "completed") {
      return {
        runId: inspection.runId,
        agentType,
        status: "completed",
        output: inspection.output,
        summary: inspection.summary
      };
    }
    if (inspection.status === "aborted") {
      return {
        runId: inspection.runId,
        agentType,
        status: "aborted",
        error: inspection.error
      };
    }
    return {
      runId: inspection.runId,
      agentType,
      status: "error",
      error: inspection.error ?? "Agent tool run failed"
    };
  }

  private async _finishAgentToolRun<Output>(
    run: AgentToolRunInfo,
    result: RunAgentToolResult<Output>,
    options?: {
      sequence?: number;
      completedAt?: number;
      deferFinishHook?: boolean;
    }
  ): Promise<DeferredAgentToolFinish | undefined> {
    const completedAt = options?.completedAt ?? Date.now();
    this._updateAgentToolTerminal(run.runId, result, completedAt);
    if (options?.sequence !== undefined) {
      this._broadcastAgentToolTerminal(
        run.parentToolCallId,
        options.sequence,
        result
      );
    }
    const finish = () =>
      this.onAgentToolFinish(
        { ...run, status: result.status, completedAt },
        result
      );
    if (options?.deferFinishHook) return finish;
    await finish();
    return undefined;
  }

  private async _runDeferredAgentToolFinishHooks(
    hooks: DeferredAgentToolFinish[]
  ): Promise<void> {
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        try {
          await this.onError(error);
        } catch {
          // Recovery hooks are best-effort; one failed mirror write should not
          // prevent the agent from starting or other recovered runs finalizing.
        }
      }
    }
  }

  private _updateAgentToolTerminal<Output>(
    runId: string,
    result: RunAgentToolResult<Output>,
    completedAt = Date.now()
  ): void {
    this.sql`
      UPDATE cf_agent_tool_runs
      SET status = ${result.status},
          summary = ${result.summary ?? null},
          output_json = ${this._stringifyAgentToolOutput(result.output)},
          error_message = ${result.error ?? null},
          completed_at = ${completedAt}
      WHERE run_id = ${runId}
        AND status NOT IN ('completed', 'error', 'aborted', 'interrupted')
    `;
    if (result.status === "completed" && result.output !== undefined) {
      this.sql`
        UPDATE cf_agent_tool_runs
        SET output_json = COALESCE(output_json, ${this._stringifyAgentToolOutput(result.output)}),
            summary = COALESCE(summary, ${result.summary ?? null})
        WHERE run_id = ${runId} AND status = 'completed'
      `;
    }
  }

  private _markAgentToolRunning(runId: string): void {
    this.sql`
      UPDATE cf_agent_tool_runs
      SET status = 'running'
      WHERE run_id = ${runId} AND status = 'starting'
    `;
  }

  private _parseAgentToolJson(value: string | null): unknown {
    if (value === null) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private _stringifyAgentToolOutput(output: unknown): string | null {
    if (output === undefined) return null;
    const json = JSON.stringify(output);
    return json === undefined ? null : json;
  }

  private _broadcastAgentToolEvent(
    parentToolCallId: string | undefined,
    sequence: number,
    event: AgentToolEvent,
    replay?: true,
    connection?: Connection
  ): void {
    const message: AgentToolEventMessage = {
      type: "agent-tool-event",
      parentToolCallId,
      sequence,
      event,
      ...(replay ? { replay } : {})
    };
    const body = JSON.stringify(message);
    if (connection) {
      connection.send(body);
    } else {
      this.broadcast(body);
    }
  }

  private _broadcastAgentToolChunks(
    parentToolCallId: string | undefined,
    runId: string,
    chunks: AgentToolStoredChunk[],
    sequence: number,
    replay?: true,
    connection?: Connection
  ): number {
    let next = sequence;
    for (const chunk of chunks) {
      this._broadcastAgentToolEvent(
        parentToolCallId,
        next++,
        { kind: "chunk", runId, body: chunk.body },
        replay,
        connection
      );
    }
    return next;
  }

  private async _broadcastAgentToolStoredChunks(
    row: Pick<
      AgentToolRunStorageRow,
      "run_id" | "agent_type" | "parent_tool_call_id"
    >,
    sequence: number,
    replay?: true,
    connection?: Connection
  ): Promise<number> {
    const child = await this._cf_resolveSubAgent(row.agent_type, row.run_id);
    const adapter = this._asAgentToolChildAdapter(child);
    const chunks = await adapter.getAgentToolChunks(row.run_id);
    return this._broadcastAgentToolChunks(
      row.parent_tool_call_id ?? undefined,
      row.run_id,
      chunks,
      sequence,
      replay,
      connection
    );
  }

  private async _forwardAgentToolStream(
    stream: ReadableStream<AgentToolStoredChunk>,
    parentToolCallId: string | undefined,
    runId: string,
    sequence: number,
    signal?: AbortSignal
  ): Promise<number> {
    let next = sequence;
    if (signal?.aborted) return next;
    const reader = (
      stream as ReadableStream<AgentToolStoredChunk | Uint8Array>
    ).getReader();
    const decoder = new TextDecoder();
    let bufferedBytes = "";
    let abortListener: (() => void) | undefined;
    if (signal) {
      abortListener = () => {
        // runAgentTool() also calls cancelAgentToolRun(), whose adapter should
        // close the tail stream. Avoid reader.cancel(reason) here because DO RPC
        // can surface cancellation reasons as unhandled stream rejections.
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
    try {
      const forwardChunk = (chunk: AgentToolStoredChunk) => {
        this._broadcastAgentToolEvent(parentToolCallId, next++, {
          kind: "chunk",
          runId,
          body: chunk.body
        });
      };
      const forwardLine = (line: string) => {
        try {
          const chunk = JSON.parse(line) as Partial<AgentToolStoredChunk>;
          if (typeof chunk.body === "string") {
            forwardChunk(chunk as AgentToolStoredChunk);
          }
        } catch {
          // Skip malformed stream frames; the child remains authoritative for
          // final run status and durable chunk replay.
        }
      };
      const flushBufferedBytes = (final = false) => {
        while (true) {
          const newline = bufferedBytes.indexOf("\n");
          if (newline === -1) break;
          const line = bufferedBytes.slice(0, newline).trim();
          bufferedBytes = bufferedBytes.slice(newline + 1);
          if (line.length > 0) {
            forwardLine(line);
          }
        }
        if (final && bufferedBytes.trim().length > 0) {
          forwardLine(bufferedBytes);
          bufferedBytes = "";
        }
      };
      while (true) {
        let readResult: ReadableStreamReadResult<
          AgentToolStoredChunk | Uint8Array
        >;
        try {
          readResult = await reader.read();
        } catch (error) {
          if (signal?.aborted) break;
          throw error;
        }
        const { done, value } = readResult;
        if (done) {
          bufferedBytes += decoder.decode();
          flushBufferedBytes(true);
          break;
        }
        if (value instanceof Uint8Array) {
          bufferedBytes += decoder.decode(value, { stream: true });
          flushBufferedBytes();
        } else {
          forwardChunk(value);
        }
      }
    } finally {
      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }
      reader.releaseLock();
    }
    return next;
  }

  private _broadcastAgentToolTerminal<Output>(
    parentToolCallId: string | undefined,
    sequence: number,
    result: RunAgentToolResult<Output>,
    replay?: true,
    connection?: Connection
  ): void {
    if (result.status === "completed") {
      this._broadcastAgentToolEvent(
        parentToolCallId,
        sequence,
        {
          kind: "finished",
          runId: result.runId,
          summary: result.summary ?? ""
        },
        replay,
        connection
      );
    } else if (result.status === "aborted") {
      this._broadcastAgentToolEvent(
        parentToolCallId,
        sequence,
        { kind: "aborted", runId: result.runId, reason: result.error },
        replay,
        connection
      );
    } else if (result.status === "interrupted") {
      this._broadcastAgentToolEvent(
        parentToolCallId,
        sequence,
        {
          kind: "interrupted",
          runId: result.runId,
          error: result.error ?? "Agent tool run was interrupted"
        },
        replay,
        connection
      );
    } else {
      this._broadcastAgentToolEvent(
        parentToolCallId,
        sequence,
        {
          kind: "error",
          runId: result.runId,
          error: result.error ?? "Agent tool run failed"
        },
        replay,
        connection
      );
    }
  }

  private _asAgentToolChildAdapter<Input = unknown, Output = unknown>(
    child: unknown
  ): AgentToolChildAdapter<Input, Output> {
    const candidate = child as Partial<AgentToolChildAdapter<Input, Output>>;
    if (
      typeof candidate.startAgentToolRun !== "function" ||
      typeof candidate.cancelAgentToolRun !== "function" ||
      typeof candidate.inspectAgentToolRun !== "function" ||
      typeof candidate.getAgentToolChunks !== "function"
    ) {
      throw new Error(
        "Agent tool child must implement the framework agent-tool adapter. Use a @cloudflare/think Think subclass or an AIChatAgent subclass."
      );
    }
    return candidate as AgentToolChildAdapter<Input, Output>;
  }

  private _agentToolClassByName(className: string): SubAgentClass<Agent> {
    const ctx = this.ctx as unknown as Partial<FacetCapableCtx>;
    const cls = ctx.exports?.[className];
    if (!cls) {
      throw new Error(`Agent tool class "${className}" is not exported.`);
    }
    return cls as unknown as SubAgentClass<Agent>;
  }

  private async _replayAndInterruptAgentToolRun<Output>(
    row: AgentToolRunStorageRow,
    message: string
  ): Promise<RunAgentToolResult<Output>> {
    let sequence = 1;
    try {
      sequence = await this._broadcastAgentToolStoredChunks(row, sequence);
    } catch {
      // Interruption is still the honest parent state if replay fails.
    }
    const result: RunAgentToolResult<Output> = {
      runId: row.run_id,
      agentType: row.agent_type,
      status: "interrupted",
      error: message
    };
    await this._finishAgentToolRun(this._agentToolRunInfoFromRow(row), result, {
      sequence
    });
    return result;
  }

  private async _replayAgentToolRuns(connection: Connection): Promise<void> {
    const rows = this.sql<{
      run_id: string;
      parent_tool_call_id: string | null;
      agent_type: string;
      input_preview: string | null;
      status: AgentToolRunStatus;
      summary: string | null;
      output_json: string | null;
      error_message: string | null;
      display_metadata: string | null;
      display_order: number;
    }>`
      SELECT run_id, parent_tool_call_id, agent_type, input_preview, status,
             summary, output_json, error_message, display_metadata, display_order
      FROM cf_agent_tool_runs
      ORDER BY started_at ASC
    `;

    for (const row of rows) {
      const parentToolCallId = row.parent_tool_call_id ?? undefined;
      let sequence = 0;
      this._broadcastAgentToolEvent(
        parentToolCallId,
        sequence++,
        {
          kind: "started",
          runId: row.run_id,
          agentType: row.agent_type,
          inputPreview: this._parseAgentToolJson(row.input_preview),
          order: row.display_order,
          display: this._parseAgentToolJson(row.display_metadata) as
            | AgentToolDisplayMetadata
            | undefined
        },
        true,
        connection
      );

      try {
        sequence = await this._broadcastAgentToolStoredChunks(
          row,
          sequence,
          true,
          connection
        );
      } catch {
        // Keep replay best-effort per run.
      }

      if (this._isAgentToolTerminal(row.status)) {
        this._broadcastAgentToolTerminal(
          parentToolCallId,
          sequence,
          {
            runId: row.run_id,
            agentType: row.agent_type,
            status: row.status as RunAgentToolResult["status"],
            output: this._parseAgentToolJson(row.output_json),
            summary: row.summary ?? undefined,
            error: row.error_message ?? undefined
          },
          true,
          connection
        );
      }
    }
  }

  private async _reconcileAgentToolRuns(options?: {
    deferFinishHooks?: boolean;
  }): Promise<DeferredAgentToolFinish[]> {
    const deferredFinishes: DeferredAgentToolFinish[] = [];
    const rows = this.sql<AgentToolRunStorageRow>`
      SELECT run_id, parent_tool_call_id, agent_type, input_preview, status,
             summary, output_json, error_message, display_metadata, display_order,
             started_at, completed_at
      FROM cf_agent_tool_runs
      WHERE status IN ('starting', 'running')
      ORDER BY started_at ASC
    `;
    for (const row of rows) {
      let sequence = 1;
      let completedAt: number | undefined;
      let result: RunAgentToolResult;
      try {
        const child = await this._cf_resolveSubAgent(
          row.agent_type,
          row.run_id
        );
        const adapter = this._asAgentToolChildAdapter(child);
        const inspection = await adapter.inspectAgentToolRun(row.run_id);
        try {
          sequence = await this._broadcastAgentToolStoredChunks(row, sequence);
        } catch {
          // Terminal reconciliation should still complete if chunk replay fails.
        }
        if (
          !inspection ||
          inspection.status === "running" ||
          inspection.status === "starting"
        ) {
          result = {
            runId: row.run_id,
            agentType: row.agent_type,
            status: "interrupted",
            error:
              "Agent tool run was still running, but live-tail reattachment is not supported in this runtime."
          };
        } else {
          result = this._terminalResultFromInspection(
            row.agent_type,
            inspection
          );
          completedAt = inspection.completedAt;
        }
      } catch {
        result = {
          runId: row.run_id,
          agentType: row.agent_type,
          status: "interrupted",
          error: "Agent tool run could not be inspected during parent recovery."
        };
      }
      const deferredFinish = await this._finishAgentToolRun(
        this._agentToolRunInfoFromRow(row),
        result,
        {
          sequence,
          completedAt,
          deferFinishHook: options?.deferFinishHooks
        }
      );
      if (deferredFinish) {
        deferredFinishes.push(deferredFinish);
      }
    }
    return deferredFinishes;
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
  private async _cf_resolveSubAgent(
    className: string,
    name: string
  ): Promise<unknown> {
    const ctx = this.ctx as unknown as Partial<FacetCapableCtx>;
    if (!ctx.facets || !ctx.exports) {
      throw new Error(
        "subAgent() is not supported in this runtime — " +
          "`ctx.facets` / `ctx.exports` are unavailable. " +
          "Update to the latest `compatibility_date` in your wrangler.jsonc."
      );
    }
    if (camelCaseToKebabCase(className) === SUB_PREFIX) {
      // Any class whose kebab-cased name equals the `sub` URL
      // separator would make `/agents/.../sub/sub/...` ambiguous.
      // `Sub`, `SUB`, and `Sub_` all kebab-case to `"sub"` — catch
      // them uniformly rather than listing each spelling.
      throw new Error(
        `Sub-agent class name "${className}" kebab-cases to "${SUB_PREFIX}", ` +
          `which collides with the reserved URL separator — rename the ` +
          `class (e.g. "SubThing" or "Subtask").`
      );
    }
    const Cls = ctx.exports[className];
    if (!Cls) {
      throw new Error(
        `Sub-agent class "${className}" not found in worker exports. ` +
          `Make sure the class is exported from your worker entry point ` +
          `and that the export name matches the class name.`
      );
    }
    if (name.includes("\0")) {
      // Null char is reserved for the facet composite key delimiter —
      // letting it through would corrupt the `${class}\0${name}` key.
      throw new Error(
        `Sub-agent name contains null character (\\0), which is reserved.`
      );
    }
    // Composite key: class name + NUL + facet name, so two different
    // classes can share the same user-facing name.
    const facetKey = `${className}\0${name}`;
    // Pass an explicit `id` in FacetStartupOptions so the facet has
    // its own `ctx.id.name === name` (not the parent's name).
    // Without this, facets inherit the parent DO's `ctx.id` and
    // `this.name` on the facet would silently return the parent's
    // name. See:
    // https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/
    //
    // The id is constructed from the parent's own bound namespace,
    // which is always present in `ctx.exports` because the parent
    // Agent class is bound as a DO. Any bound DurableObjectNamespace
    // would work — the id is opaque + a name; nothing routes
    // through the namespace at runtime for facets. We use the
    // parent's because it's guaranteed available without extra
    // env-binding lookups.
    const parentClassName = (this.constructor as { name: string }).name;
    const parentNs = ctx.exports[parentClassName];
    if (!parentNs?.idFromName) {
      // Minification is the most common cause of this error in
      // production builds: aggressive bundlers rewrite class
      // identifiers to short ids, so `this.constructor.name`
      // becomes something like `_a` and the ctx.exports lookup
      // misses. Detect that case and append a hint, otherwise
      // the message is mysterious.
      //
      // Heuristic: optional leading underscore(s), then 1–3
      // lowercase letters/digits starting with a letter (e.g.
      // `_a`, `_ab`, `_a1`, `__a`). Real class names like
      // `MyAgent` or `_UnboundParent` start with an uppercase
      // letter and won't match.
      const looksMinified = /^_*[a-z][a-z0-9]{0,2}$/.test(parentClassName);
      const minificationHint = looksMinified
        ? ` The class name "${parentClassName}" looks minified — make sure your bundler preserves class names (e.g. esbuild's \`keepNames: true\`).`
        : "";
      throw new Error(
        `Sub-agent bootstrap requires the parent class "${parentClassName}" to be bound as a Durable Object namespace, but ctx.exports["${parentClassName}"] is missing or doesn't expose idFromName.${minificationHint} Make sure the parent agent class is registered in your wrangler.jsonc durable_objects.bindings under its class name.`
      );
    }
    const facetId = parentNs.idFromName(name);
    const stub = ctx.facets.get(facetKey, () => ({
      class: Cls as DurableObjectClass,
      id: facetId
    }));

    // Derive the child's ancestor chain: our own `parentPath` +
    // `{ class: this.constructor.name, name: this.name }`. Inductive
    // across recursive nesting.
    const childParentPath = this.selfPath;

    // Initialize the child as a facet via a single RPC that runs
    // inside the child's isolate. Avoids the cross-DO I/O error that
    // the previous `stub.fetch(req)` path triggered by handing a
    // parent-owned Request across the isolate boundary.
    //
    // The parent may be inside a WebSocket/message request context here.
    // Clear native context handles before the child facet RPC so workerd
    // never sees parent-owned I/O attached to child initialization.
    await agentContext.run(
      {
        agent: this,
        connection: undefined,
        request: undefined,
        email: undefined
      },
      async () => {
        await (
          stub as unknown as {
            _cf_initAsFacet(
              name: string,
              parentPath: ReadonlyArray<{ className: string; name: string }>
            ): Promise<void>;
          }
        )._cf_initAsFacet(name, childParentPath);
      }
    );

    // Record in the parent's sub-agent registry so `hasSubAgent` /
    // `listSubAgents` reflect the spawn. Idempotent.
    this._recordSubAgent(className, name);

    return stub;
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
    const ctx = this.ctx as unknown as Partial<FacetCapableCtx>;
    if (!ctx.facets) {
      throw new Error(
        "abortSubAgent() is not supported in this runtime — " +
          "`ctx.facets` is unavailable. " +
          "Update to the latest `compatibility_date` in your wrangler.jsonc."
      );
    }
    const facetKey = `${cls.name}\0${name}`;
    ctx.facets.abort(facetKey, reason);
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
  async deleteSubAgent(cls: SubAgentClass, name: string): Promise<void> {
    const ctx = this.ctx as unknown as Partial<FacetCapableCtx>;
    if (!ctx.facets) {
      throw new Error(
        "deleteSubAgent() is not supported in this runtime — " +
          "`ctx.facets` is unavailable. " +
          "Update to the latest `compatibility_date` in your wrangler.jsonc."
      );
    }
    const facetKey = `${cls.name}\0${name}`;
    const childPath = [...this.selfPath, { className: cls.name, name }];
    if (this._isFacet) {
      const root = await this._rootAlarmOwner();
      await root._cf_cleanupFacetPrefix(childPath);
    } else {
      await this._cf_cleanupFacetPrefix(childPath);
    }

    // Idempotent: make `ctx.facets.delete` tolerant of missing keys.
    // workerd throws an opaque "internal error" when the key isn't
    // registered; swallow that so double-delete and
    // delete-never-spawned both succeed silently. The registry DELETE
    // is already idempotent.
    try {
      ctx.facets.delete(facetKey);
    } catch {
      // no-op — facet wasn't registered (already deleted / never spawned)
    }
    this._forgetSubAgent(cls.name, name);
  }

  // ── Sub-agent registry (backs `hasSubAgent` / `listSubAgents`) ──────────

  /** @internal */
  private _subAgentRegistryReady = false;

  /** @internal */
  private _ensureSubAgentRegistry(): void {
    if (this._subAgentRegistryReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_sub_agents (
        class TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (class, name)
      )
    `;
    this._subAgentRegistryReady = true;
  }

  /** @internal */
  private _recordSubAgent(className: string, name: string): void {
    this._ensureSubAgentRegistry();
    this.sql`
      INSERT OR IGNORE INTO cf_agents_sub_agents (class, name, created_at)
      VALUES (${className}, ${name}, ${Date.now()})
    `;
  }

  /** @internal */
  private _forgetSubAgent(className: string, name: string): void {
    this._ensureSubAgentRegistry();
    this.sql`
      DELETE FROM cf_agents_sub_agents
      WHERE class = ${className} AND name = ${name}
    `;
  }

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
    const className =
      typeof classOrName === "string" ? classOrName : classOrName.name;
    this._ensureSubAgentRegistry();
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agents_sub_agents
      WHERE class = ${className} AND name = ${name}
    `;
    return (rows[0]?.n ?? 0) > 0;
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
    const className =
      typeof classOrName === "string" ? classOrName : classOrName?.name;
    this._ensureSubAgentRegistry();
    const rows = className
      ? this.sql<{ class: string; name: string; created_at: number }>`
          SELECT class, name, created_at FROM cf_agents_sub_agents
          WHERE class = ${className}
          ORDER BY created_at ASC
        `
      : this.sql<{ class: string; name: string; created_at: number }>`
          SELECT class, name, created_at FROM cf_agents_sub_agents
          ORDER BY created_at ASC
        `;
    return rows.map((r) => ({
      className: r.class,
      name: r.name,
      createdAt: r.created_at
    }));
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
    this.sql`DROP TABLE IF EXISTS cf_agents_mcp_servers`;
    this.sql`DROP TABLE IF EXISTS cf_agents_state`;
    this.sql`DROP TABLE IF EXISTS cf_agents_schedules`;
    this.sql`DROP TABLE IF EXISTS cf_agents_queues`;
    this.sql`DROP TABLE IF EXISTS cf_agents_workflows`;
    this.sql`DROP TABLE IF EXISTS cf_agents_sub_agents`;
    this.sql`DROP TABLE IF EXISTS cf_agents_runs`;
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

  private async _restoreRpcMcpServers(): Promise<void> {
    const rpcServers = this.mcp.getRpcServersFromStorage();
    for (const server of rpcServers) {
      if (this.mcp.mcpConnections[server.id]) {
        continue;
      }

      const opts: { bindingName: string; props?: Record<string, unknown> } =
        server.server_options ? JSON.parse(server.server_options) : {};

      const namespace = (this.env as Record<string, unknown>)[
        opts.bindingName
      ] as DurableObjectNamespace<McpAgent> | undefined;
      if (!namespace) {
        console.warn(
          `[Agent] Cannot restore RPC MCP server "${server.name}": binding "${opts.bindingName}" not found in env`
        );
        continue;
      }

      const normalizedName = server.server_url.replace(RPC_DO_PREFIX, "");

      try {
        await this.mcp.connect(`${RPC_DO_PREFIX}${normalizedName}`, {
          reconnect: { id: server.id },
          transport: {
            type: "rpc" as TransportType,
            namespace,
            name: normalizedName,
            props: opts.props
          }
        });

        const conn = this.mcp.mcpConnections[server.id];
        if (conn && conn.connectionState === MCPConnectionState.CONNECTED) {
          await this.mcp.discoverIfConnected(server.id);
        }
      } catch (error) {
        console.error(
          `[Agent] Error restoring RPC MCP server "${server.name}":`,
          error
        );
      }
    }
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
    const isHttpTransport = typeof urlOrBinding === "string";
    const normalizedUrl = isHttpTransport
      ? new URL(urlOrBinding).href
      : undefined;
    const existingServer = this.mcp
      .listServers()
      .find(
        (s) =>
          s.name === serverName &&
          (!isHttpTransport || new URL(s.server_url).href === normalizedUrl)
      );
    if (existingServer && this.mcp.mcpConnections[existingServer.id]) {
      const conn = this.mcp.mcpConnections[existingServer.id];
      if (
        conn.connectionState === MCPConnectionState.AUTHENTICATING &&
        conn.options.transport.authProvider?.authUrl
      ) {
        return {
          id: existingServer.id,
          state: MCPConnectionState.AUTHENTICATING,
          authUrl: conn.options.transport.authProvider.authUrl
        };
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

      const reconnectId = existingServer?.id;
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
      | {
          client?: ConstructorParameters<typeof Client>[1];
          transport?: {
            headers?: HeadersInit;
            type?: TransportType;
          };
          retry?: RetryOptions;
        }
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

    const id = nanoid(8);

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
        type: transportType
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
    // (establishConnection handles retries internally using per-server retry config)
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
