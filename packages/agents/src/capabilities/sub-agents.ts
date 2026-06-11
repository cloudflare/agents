/**
 * Sub-agents / facets capability (Layer 1). Owns the sub-agent registry
 * (`cf_agents_sub_agents`), facet resolution and bootstrap
 * (`subAgent` / `_cf_resolveSubAgent` / `_cf_initAsFacet`), cross-facet
 * RPC invocation (`_cf_invokeSubAgent` / `_cf_invokeSubAgentPath` /
 * `parentAgent`), recursive facet teardown
 * (`deleteSubAgent` / `_cf_destroyDescendantFacet`), and the parent↔facet
 * WebSocket bridge (virtual connections, broadcast routing, hibernation
 * re-hydration).
 *
 * The `_cf_*` members form a CROSS-DO RPC PROTOCOL: parents call them on
 * children and vice versa via facet stubs / `ctx.exports`, dispatched by
 * method name. Every moved `_cf_*` method therefore keeps a thin
 * delegator with the exact same name on `Agent` (see index.ts).
 *
 * The capability talks to the agent only through the narrow
 * {@link SubAgentsHost} slice. Calls to *public or overridable* agent
 * members (`hasSubAgent`, `onBeforeSubAgent`, the wrapped
 * `onConnect`/`onMessage`/`onClose`, `shouldConnectionBeReadonly`,
 * `shouldSendProtocolMessages`, `getConnectionTags`,
 * `setConnectionReadonly`, the `_unsafe_*ConnectionFlag` helpers, and the
 * `name` getter) are re-dispatched through the agent instance so subclass
 * overrides keep working exactly as before.
 *
 * Genuinely shared infrastructure stays on the agent and is reached via
 * the host slice: the physical alarm and facet keepAlive leases
 * (`_rootAlarmOwner`, `_cf_acquireFacetKeepAlive`,
 * `_cf_registerFacetRun`, …), root-side facet fiber recovery
 * (`_checkFacetRunFibers` / `_cf_checkRunFibersForFacet`), the
 * scheduler's facet RPC surface (`_cf_scheduleForFacet`,
 * `_cf_cleanupFacetPrefix`, `_cf_dispatchScheduledCallback`, …), and the
 * raw PartyServer connection primitives (`super.getConnection(s)`,
 * `_ensureConnectionWrapped`, the raw connection-state accessors).
 */

import { RpcTarget, exports as workerExports } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { camelCaseToKebabCase, isInternalJsStubProp } from "../utils";
import {
  SUB_PREFIX,
  parseSubAgentPath as _parseSubAgentPath
} from "../sub-routing";
import type { SqlHost } from "../core/host";
import type { AgentPathStep } from "./scheduler";
import type { RetryOptions } from "../retries";
import type {
  Agent,
  Schedule,
  ScheduleCriteria,
  SubAgentClass,
  SubAgentStub
} from "../index";

const SUB_AGENT_IDENTITY_VERSION_LEGACY = "legacy";
const SUB_AGENT_IDENTITY_VERSION_PATH_V2 = "path-v2";
const SUB_AGENT_IDENTITY_PATH_V2_PREFIX = "cf-agents:v2:";

type SubAgentIdentityVersion =
  | typeof SUB_AGENT_IDENTITY_VERSION_LEGACY
  | typeof SUB_AGENT_IDENTITY_VERSION_PATH_V2;

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function pathV2IdentityName(logicalName: string, digest: string): string {
  return `${SUB_AGENT_IDENTITY_PATH_V2_PREFIX}${encodeURIComponent(logicalName)}:${digest}`;
}

export function logicalNameFromPathV2Identity(
  identityName: string
): string | null {
  if (!identityName.startsWith(SUB_AGENT_IDENTITY_PATH_V2_PREFIX)) {
    return null;
  }
  const rest = identityName.slice(SUB_AGENT_IDENTITY_PATH_V2_PREFIX.length);
  const separator = rest.lastIndexOf(":");
  if (separator === -1) return null;

  try {
    return decodeURIComponent(rest.slice(0, separator));
  } catch {
    return null;
  }
}

/**
 * Internal key used to remember the outer `/sub/...` URL for a
 * WebSocket accepted by the parent on behalf of a child facet.
 * Hibernated events then wake the parent, which forwards frames to
 * the child over serializable RPC while keeping native WebSocket I/O
 * parent-owned.
 */
export const CF_SUB_AGENT_OUTER_URL_KEY = "_cf_subAgentOuterUrl";
export const CF_SUB_AGENT_TAGS_KEY = "_cf_subAgentTags";

export const SUB_AGENT_OUTER_URL_HEADER = "x-cf-agents-subagent-url";

/**
 * Internal narrowing of `DurableObjectState` to the parts the facet
 * bootstrap path uses. We only need this because `ctx.exports` in the
 * real types (`Cloudflare.Exports`) is keyed by the *consumer's*
 * worker MainModule, which is invisible from inside this library —
 * so we widen it to a generic Record indexed by class name.
 *
 * @internal
 */
export interface FacetCapableCtx {
  facets: DurableObjectFacets;
  /**
   * Worker exports keyed by class export name. For facet creation, the
   * runtime only needs the exported Durable Object class. Top-level
   * Durable Object bindings may also expose namespace helpers here, but
   * facet-only classes do not need to.
   */
  exports: Record<
    string,
    | (DurableObjectClass & Partial<Pick<DurableObjectNamespace, "idFromName">>)
    | undefined
  >;
}

type SubAgentPathInvokeEndpoint = {
  _cf_invokeSubAgentPath(
    path: ReadonlyArray<{ className: string; name: string }>,
    method: string,
    args: unknown[]
  ): Promise<unknown>;
};

export type SubAgentConnectionMeta = {
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

export type StoredSubAgentConnection = {
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

export class SubAgentConnectionBridge
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
 * Internal RPC surface exposed by the root agent for facets to
 * delegate alarm-owning operations (schedules + facet teardown).
 * @internal
 */
export type RootFacetRpcSurface = {
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
 * The agent surface the capability re-dispatches through so subclass
 * overrides are honored.
 */
interface SubAgentsAgentSurface {
  /** Public `name` getter (facet-aware). */
  name: string;
  /** Public, user-overridable registry gate. */
  hasSubAgent(className: string, name: string): boolean;
  /** Public, user-overridable parent-side middleware hook. */
  onBeforeSubAgent(
    request: Request,
    child: { className: string; name: string }
  ): Promise<Request | Response | void>;
  /** The constructor-wrapped connection lifecycle handlers. */
  onConnect(
    connection: Connection,
    ctx: ConnectionContext
  ): void | Promise<void>;
  onMessage(connection: Connection, message: WSMessage): void | Promise<void>;
  onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): void | Promise<void>;
  shouldConnectionBeReadonly(
    connection: Connection,
    ctx: ConnectionContext
  ): boolean;
  setConnectionReadonly(connection: Connection, readonly?: boolean): void;
  shouldSendProtocolMessages(
    connection: Connection,
    ctx: ConnectionContext
  ): boolean;
  getConnectionTags(
    connection: Connection,
    ctx: ConnectionContext
  ): string[] | Promise<string[]>;
  _unsafe_getConnectionFlag(connection: Connection, key: string): unknown;
  _unsafe_setConnectionFlag(
    connection: Connection,
    key: string,
    value: unknown
  ): void;
}

/** The slice of the agent the sub-agents capability needs. */
export interface SubAgentsHost {
  /**
   * The agent instance — public methods and lifecycle hooks are
   * re-dispatched through it so subclass overrides are honored.
   */
  agent: object;
  sql: SqlHost["sql"];
  /** `ctx.storage.sql.exec` — additive registry column migrations. */
  rawSql(query: string): void;
  /**
   * `this.ctx` narrowed to the facet bootstrap surface
   * (`ctx.facets` / `ctx.exports`).
   */
  facetCtx(): Partial<FacetCapableCtx>;
  /** `this.ctx.id` — root-identity check during connection hydration. */
  ctxId(): DurableObjectId;
  /** `this.ctx.storage.put` — persists the facet identity keys. */
  storagePut(key: string, value: unknown): Promise<void>;
  /** The agent's `env` — top-level namespace lookup for `parentAgent`. */
  env(): Record<string, unknown>;
  /** Whether this agent runs as a facet (sub-agent) inside a parent. */
  isFacet(): boolean;
  /** `_parentPath` on the agent (ancestor chain, root-first). */
  parentPath(): ReadonlyArray<AgentPathStep>;
  /** The agent's own facet path (ancestor chain + self). */
  selfPath(): ReadonlyArray<AgentPathStep>;
  /** PartyServer's routed identity (`super.name` on the agent). */
  routedName(): string;
  /** `this._ParentClass.name` on the agent. */
  agentClassName(): string;
  /** `(this.constructor as { name: string }).name` on the agent. */
  constructorName(): string;
  /**
   * Set `_isFacet` / `_facetName` / `_parentPath` during the facet
   * bootstrap handshake (`_cf_initAsFacet`).
   */
  setFacetIdentity(
    name: string,
    parentPath: ReadonlyArray<AgentPathStep>
  ): void;
  /** PartyServer's `__unsafe_ensureInitialized` — fires `onStart`. */
  ensureInitialized(): Promise<void>;
  /** `_rootAlarmOwner` on the agent (alarm infra stays on the agent). */
  rootAlarmOwner(): Promise<RootFacetRpcSurface>;
  /** `_cf_cleanupFacetPrefix` on the agent (scheduler territory). */
  cleanupFacetPrefix(ownerPath: ReadonlyArray<AgentPathStep>): Promise<void>;
  /** `_isSameAgentPathPrefix` on the agent (shared path helper). */
  isSameAgentPathPrefix(
    prefix: ReadonlyArray<AgentPathStep>,
    path: ReadonlyArray<AgentPathStep>
  ): boolean;
  /**
   * Run `fn` with native request/connection context handles cleared so
   * workerd never sees parent-owned I/O attached to child bootstrap.
   */
  runOutsideRequestContext<T>(fn: () => Promise<T>): Promise<T>;
  /** `super.getConnection` on the agent — raw PartyServer connection. */
  rawGetConnection(id: string): Connection | undefined;
  /** `super.getConnections` on the agent — raw PartyServer connections. */
  rawGetConnections(): Iterable<Connection>;
  /** `_ensureConnectionWrapped` on the agent. */
  ensureConnectionWrapped(connection: Connection): void;
  /** `_cf_getRawConnectionState` on the agent. */
  getRawConnectionState(connection: Connection): unknown;
  /** `_setConnectionNoProtocol` on the agent. */
  setConnectionNoProtocol(connection: Connection): void;
}

export class AgentSubAgents {
  private readonly _host: SubAgentsHost;

  /**
   * Bridge for the sub-agent connection currently being serviced (set
   * while a forwarded WebSocket event runs inside the facet).
   */
  private _cf_currentSubAgentBridge?: SubAgentConnectionBridgeLike;
  /**
   * Virtual client connections of a facet — real WebSockets owned by
   * the ROOT DO and bridged in. Exposed for the agent's test-only
   * `_cf_virtualSubAgentConnections` getter.
   */
  readonly _cf_virtualSubAgentConnections = new Map<
    string,
    StoredSubAgentConnection
  >();

  /** @internal */
  private _subAgentRegistryReady = false;

  constructor(host: SubAgentsHost) {
    this._host = host;
  }

  private get _agent(): SubAgentsAgentSurface {
    return this._host.agent as SubAgentsAgentSurface;
  }

  // ── Sub-agent broadcast + virtual connections (facet side) ──────────

  async broadcastToParentSubAgent(
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): Promise<void> {
    if (this._cf_currentSubAgentBridge) {
      this._cf_currentSubAgentBridge.broadcast(
        this._host.selfPath(),
        message,
        without
      );
      return;
    }
    const root = await this._host.rootAlarmOwner();
    await root._cf_broadcastToSubAgent(this._host.selfPath(), message, without);
  }

  async broadcastToSubAgent(
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): Promise<void> {
    if (this._host.isFacet() && this._cf_currentSubAgentBridge) {
      this._cf_currentSubAgentBridge.broadcast(ownerPath, message, without);
      return;
    }

    for (const connection of this._host.rawGetConnections()) {
      if (without?.includes(connection.id)) continue;
      const targetPath = this._subAgentTargetPath(connection);
      if (!targetPath) continue;
      if (!this._isSameAgentPath(targetPath, ownerPath)) continue;
      connection.send(message);
    }
  }

  async subAgentConnectionMetas(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<SubAgentConnectionMeta[]> {
    const metas: SubAgentConnectionMeta[] = [];
    for (const connection of this._host.rawGetConnections()) {
      const meta = this._subAgentConnectionMetaForPath(connection, ownerPath);
      if (meta) metas.push(meta);
    }
    return metas;
  }

  async sendToSubAgentConnection(
    connectionId: string,
    message: string | ArrayBuffer | ArrayBufferView
  ): Promise<void> {
    const connection = this._host.rawGetConnection(connectionId);
    if (!connection || !this.connectionHasSubAgentTarget(connection)) {
      return;
    }
    connection.send(message);
  }

  async closeSubAgentConnection(
    connectionId: string,
    code?: number,
    reason?: string
  ): Promise<void> {
    const connection = this._host.rawGetConnection(connectionId);
    if (!connection || !this.connectionHasSubAgentTarget(connection)) {
      return;
    }
    connection.close(code, reason);
  }

  async setSubAgentConnectionState(
    connectionId: string,
    state: unknown
  ): Promise<unknown> {
    const connection = this._host.rawGetConnection(connectionId);
    if (!connection || !this.connectionHasSubAgentTarget(connection)) {
      return null;
    }
    this._host.ensureConnectionWrapped(connection);
    connection.setState(state);
    return this._getForwardedSubAgentState(connection);
  }

  private _subAgentConnectionMetaForPath(
    connection: Connection,
    ownerPath: ReadonlyArray<AgentPathStep>
  ): SubAgentConnectionMeta | null {
    this._host.ensureConnectionWrapped(connection);
    const outerUri = this._agent._unsafe_getConnectionFlag(
      connection,
      CF_SUB_AGENT_OUTER_URL_KEY
    );
    if (typeof outerUri !== "string") return null;

    const target = this._subAgentPathFromOuterUri(outerUri, ownerPath);
    if (!target) return null;

    const raw = this._host.getRawConnectionState(connection);
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
      state: this._getForwardedSubAgentState(connection)
    };
  }

  private _subAgentTargetPath(
    connection: Connection
  ): ReadonlyArray<AgentPathStep> | null {
    this._host.ensureConnectionWrapped(connection);
    const outerUri = this._agent._unsafe_getConnectionFlag(
      connection,
      CF_SUB_AGENT_OUTER_URL_KEY
    );
    if (typeof outerUri !== "string") return null;

    return this._subAgentPathFromOuterUri(outerUri)?.path ?? null;
  }

  private _subAgentPathFromOuterUri(
    outerUri: string,
    stopAt?: ReadonlyArray<AgentPathStep>
  ): { path: ReadonlyArray<AgentPathStep>; uri: string } | null {
    const ctx = this._host.facetCtx();
    const knownClasses = ctx.exports ? Object.keys(ctx.exports) : undefined;
    const path: AgentPathStep[] = [...this._host.selfPath()];
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

    if (path.length === this._host.selfPath().length) return null;
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

  connectionHasSubAgentTarget(connection: Connection): boolean {
    this._host.ensureConnectionWrapped(connection);
    return (
      typeof this._agent._unsafe_getConnectionFlag(
        connection,
        CF_SUB_AGENT_OUTER_URL_KEY
      ) === "string"
    );
  }

  connectionTargetsSubAgent(connection: Connection): boolean {
    if (!connection.uri) return false;
    const ctx = this._host.facetCtx();
    return (
      _parseSubAgentPath(connection.uri, {
        knownClasses: ctx.exports ? Object.keys(ctx.exports) : undefined
      }) !== null
    );
  }

  requestTargetsSubAgent(request: Request): boolean {
    const ctx = this._host.facetCtx();
    return (
      _parseSubAgentPath(request.url, {
        knownClasses: ctx.exports ? Object.keys(ctx.exports) : undefined
      }) !== null
    );
  }

  async forwardSubAgentWebSocketConnect(
    connection: Connection,
    request: Request,
    options: { gate: boolean }
  ): Promise<boolean> {
    const routed = await this._resolveSubAgentConnection(
      connection,
      request,
      options
    );
    if (!routed) return false;

    await routed.child._cf_handleSubAgentWebSocketConnect(
      this._createSubAgentConnectionBridge(connection),
      routed.meta
    );
    return true;
  }

  private _createSubAgentConnectionBridge(
    connection: Connection
  ): SubAgentConnectionBridge {
    return new SubAgentConnectionBridge(
      connection,
      (ownerPath, message, without) => {
        void this.broadcastToSubAgent(ownerPath, message, without);
      }
    );
  }

  async forwardSubAgentWebSocketMessage(
    connection: Connection,
    message: WSMessage
  ): Promise<boolean> {
    const routed = await this._resolveSubAgentConnection(connection);
    if (!routed) return false;

    await routed.child._cf_handleSubAgentWebSocketMessage(
      message,
      this._createSubAgentConnectionBridge(connection),
      routed.meta
    );
    return true;
  }

  async forwardSubAgentWebSocketClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<boolean> {
    const routed = await this._resolveSubAgentConnection(connection);
    if (!routed) return false;

    await routed.child._cf_handleSubAgentWebSocketClose(
      code,
      reason,
      wasClean,
      this._createSubAgentConnectionBridge(connection),
      routed.meta
    );
    return true;
  }

  private async _resolveSubAgentConnection(
    connection: Connection,
    request?: Request,
    options: { gate: boolean } = { gate: false }
  ): Promise<{
    child: SubAgentWebSocketEndpoint;
    meta: SubAgentConnectionMeta;
  } | null> {
    this._host.ensureConnectionWrapped(connection);
    const outerUri = this._agent._unsafe_getConnectionFlag(
      connection,
      CF_SUB_AGENT_OUTER_URL_KEY
    );
    const uri = typeof outerUri === "string" ? outerUri : connection.uri;
    if (!uri) return null;

    const ctx = this._host.facetCtx();
    let match = _parseSubAgentPath(uri, {
      knownClasses: ctx.exports ? Object.keys(ctx.exports) : undefined
    });
    if (!match) return null;
    if (
      this._host.agentClassName() === match.childClass &&
      this._agent.name === match.childName
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
      const decision = await this._agent.onBeforeSubAgent(request, {
        className: match.childClass,
        name: match.childName
      });
      if (decision instanceof Response) {
        connection.close(1008, "Sub-agent connection rejected");
        return null;
      }
      forwardReq = decision instanceof Request ? decision : request;
    }

    const child = (await this.resolveSubAgent(
      match.childClass,
      match.childName
    )) as SubAgentWebSocketEndpoint;

    const childUri = new URL(forwardReq?.url ?? uri);
    childUri.pathname = match.remainingPath;
    const raw = this._host.getRawConnectionState(connection);
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
        state: this._getForwardedSubAgentState(connection),
        requestHeaders: forwardReq ? [...forwardReq.headers] : undefined
      }
    };
  }

  async handleSubAgentWebSocketConnect(
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void> {
    await this._runWithSubAgentBridge(bridge, async () => {
      const connection = this._createSubAgentBridgeConnection(bridge, meta);
      const request = new Request(meta.uri ?? "http://placeholder/", {
        headers: meta.requestHeaders
      });
      if (
        await this.forwardSubAgentWebSocketConnect(connection, request, {
          gate: true
        })
      ) {
        return;
      }

      if (this._agent.shouldConnectionBeReadonly(connection, { request })) {
        this._agent.setConnectionReadonly(connection, true);
      }
      if (!this._agent.shouldSendProtocolMessages(connection, { request })) {
        this._host.setConnectionNoProtocol(connection);
      }

      const childTags = await this._agent.getConnectionTags(connection, {
        request
      });
      (connection as unknown as { tags: string[] }).tags = [
        connection.id,
        ...childTags.filter((tag) => tag !== connection.id)
      ];
      this._storeVirtualSubAgentConnection(bridge, connection);
      await this._agent.onConnect(connection, { request });
      this._storeVirtualSubAgentConnection(bridge, connection);
    });
  }

  async handleSubAgentWebSocketMessage(
    message: WSMessage,
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void> {
    const connection = this._createSubAgentBridgeConnection(bridge, meta);
    this._storeVirtualSubAgentConnection(bridge, connection);
    await this._runWithSubAgentBridge(bridge, () =>
      this._agent.onMessage(connection, message)
    );
  }

  async handleSubAgentWebSocketClose(
    code: number,
    reason: string,
    wasClean: boolean,
    bridge: SubAgentConnectionBridge,
    meta: SubAgentConnectionMeta
  ): Promise<void> {
    const connection = this._createSubAgentBridgeConnection(bridge, meta);
    this._storeVirtualSubAgentConnection(bridge, connection);
    await this._runWithSubAgentBridge(bridge, () =>
      this._agent.onClose(connection, code, reason, wasClean)
    );
    this._cf_virtualSubAgentConnections.delete(meta.id);
  }

  private async _runWithSubAgentBridge<T>(
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

  /**
   * Facet-side `getConnection(id)` — resolves a virtual (bridged)
   * connection by id. Never falls through to the root's hibernatable
   * sockets (see issue #1677).
   */
  getFacetConnection<TState = unknown>(
    id: string
  ): Connection<TState> | undefined {
    const stored = this._cf_virtualSubAgentConnections.get(id);
    if (stored) {
      return this._createSubAgentBridgeConnection(
        stored.bridge,
        stored.meta
      ) as Connection<TState>;
    }
    return undefined;
  }

  /**
   * Facet-side `getConnections(tag?)` — iterates the virtual (bridged)
   * connections. Never falls through to the root's hibernatable sockets
   * (see issue #1677).
   */
  *getFacetConnections<TState = unknown>(
    tag?: string
  ): Generator<Connection<TState>> {
    for (const stored of this._cf_virtualSubAgentConnections.values()) {
      if (!tag || stored.meta.tags.includes(tag)) {
        yield this._createSubAgentBridgeConnection(
          stored.bridge,
          stored.meta
        ) as Connection<TState>;
      }
    }
  }

  private _createSubAgentBridgeConnection(
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
      server: this._agent.name,
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
    this._host.ensureConnectionWrapped(connection);
    return connection;
  }

  private _storeVirtualSubAgentConnection(
    bridge: SubAgentConnectionBridgeLike,
    connection: Connection
  ): void {
    this._agent._unsafe_setConnectionFlag(connection, CF_SUB_AGENT_TAGS_KEY, [
      ...connection.tags
    ]);
    const stored = this._cf_virtualSubAgentConnections.get(connection.id);
    this._cf_virtualSubAgentConnections.set(connection.id, {
      bridge,
      meta: {
        id: connection.id,
        uri: connection.uri,
        tags: [...connection.tags],
        state: this._host.getRawConnectionState(connection)
      },
      connection: stored?.connection ?? connection
    });
  }

  async hydrateSubAgentConnectionsFromRoot(): Promise<void> {
    if (!this._host.isFacet() || this._host.parentPath().length === 0) return;

    if (this._rootResolvesToSelf()) {
      // The root stub would resolve back to this blocked Durable Object
      // during startup. The facet view cannot see root-owned hibernated
      // sockets locally, so preserve liveness and skip best-effort hydration.
      return;
    }

    const root = await this._host.rootAlarmOwner();
    const metas = await root._cf_subAgentConnectionMetas(this._host.selfPath());
    for (const meta of metas) {
      this._cf_virtualSubAgentConnections.set(meta.id, {
        bridge: new RootSubAgentConnectionBridge(root, meta.id),
        meta
      });
    }
  }

  private _rootResolvesToSelf(): boolean {
    const root = this._host.parentPath()[0];
    if (!root) return false;

    const ctx = this._host.facetCtx();
    const binding = ctx.exports?.[root.className] as
      | DurableObjectNamespace
      | undefined;
    if (!binding?.idFromName) return false;

    return binding.idFromName(root.name).equals(this._host.ctxId());
  }

  private _getForwardedSubAgentState(connection: Connection): unknown {
    const raw = this._host.getRawConnectionState(connection);
    if (raw == null || typeof raw !== "object") return raw;
    const { [CF_SUB_AGENT_OUTER_URL_KEY]: _, ...rest } = raw as Record<
      string,
      unknown
    >;
    return Object.keys(rest).length > 0 ? rest : null;
  }

  // ── Sub-agent routing (external addressability for facets) ──────────

  /**
   * Resolve the facet Fetcher for the match and forward the
   * request to it with `/sub/{class}/{name}` stripped.
   */
  async forwardToFacet(
    req: Request,
    match: {
      childClass: string;
      childName: string;
      remainingPath: string;
    }
  ): Promise<Response> {
    let fetcher: { fetch(r: Request): Promise<Response> };
    try {
      fetcher = (await this.resolveSubAgent(
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
   */
  async invokeSubAgent(
    className: string,
    name: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const stub = await this.resolveSubAgent(className, name);
    return await this._invokeStubMethod(stub, className, method, args);
  }

  /**
   * Bridge method used by `parentAgent()` when the requested parent is
   * itself a facet (and therefore has no top-level env namespace).
   * The root receives the full root-first target path, then each hop
   * delegates to the next facet using that facet's own `ctx.facets`.
   */
  async invokeSubAgentPath(
    path: ReadonlyArray<{ className: string; name: string }>,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const [self, next, ...rest] = path;
    if (!self) {
      throw new Error(`Sub-agent path invocation requires a non-empty path.`);
    }

    const ownClassName = this._host.constructorName();
    if (self.className !== ownClassName || self.name !== this._agent.name) {
      throw new Error(
        `Sub-agent path invocation reached ${ownClassName}("${this._agent.name}") ` +
          `but expected ${self.className}("${self.name}").`
      );
    }

    if (!next) {
      return await this._invokeStubMethod(
        this._host.agent,
        this._host.constructorName(),
        method,
        args
      );
    }

    const child = await this.resolveSubAgent(next.className, next.name);
    if (rest.length === 0) {
      return await this._invokeStubMethod(child, next.className, method, args);
    }

    const bridge = child as SubAgentPathInvokeEndpoint;
    return await bridge._cf_invokeSubAgentPath([next, ...rest], method, args);
  }

  private async _invokeStubMethod(
    stub: unknown,
    className: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
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

  // ── Sub-agent (facet) management ─────────────────────────────────────

  /**
   * Initialize this agent as a facet in a single RPC (see
   * `Agent#_cf_initAsFacet` for the full contract).
   */
  async initAsFacet(
    name: string,
    parentPath: ReadonlyArray<{ className: string; name: string }>,
    identityName: string
  ): Promise<void> {
    const routedName = this._host.routedName();
    if (routedName !== identityName) {
      throw new Error(
        `Facet bootstrap mismatch: expected routed identity "${identityName}" but got "${routedName}". ` +
          `This usually means the parent passed the wrong id to ctx.facets.get(). ` +
          `See _cf_resolveSubAgent.`
      );
    }

    this._host.setFacetIdentity(name, parentPath);
    // Persist the agent-specific facet keys in parallel.
    await Promise.all([
      this._host.storagePut("cf_agents_is_facet", true),
      this._host.storagePut("cf_agents_facet_name", name),
      this._host.storagePut("cf_agents_parent_path", parentPath)
    ]);
    // Fire onStart() now since this RPC bypasses Server.fetch(), which is the
    // entry point that normally triggers it. Protocol broadcasts during this
    // bootstrap window are safe: on a facet `getConnections()` returns only
    // virtual sub-agent connections and `broadcast()` routes to the parent
    // bridge, so neither touches the parent's own WebSocket handles (#1679).
    await this._host.ensureInitialized();
  }

  /**
   * Resolve a typed parent stub for this facet's **immediate** parent
   * agent (see `Agent#parentAgent` for the public contract).
   */
  async parentAgent<T extends Agent>(
    cls: SubAgentClass<T>
  ): Promise<DurableObjectStub<T>> {
    // `_parentPath` is root-first, so the *direct* parent is the
    // last entry. Destructuring with `[parent] = ...` would grab the
    // root ancestor instead — wrong for any chain deeper than one
    // level and silently routes to the wrong DO if the root and the
    // direct parent happen to be the same class.
    const parentPath = this._host.parentPath();
    const parent = parentPath[parentPath.length - 1];
    if (!parent) {
      throw new Error(
        `parentAgent(): ${this._host.constructorName()} is not a facet — ` +
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
    if (parentPath.length > 1) {
      return await this._parentAgentFacetProxy<T>(cls.name, parentPath);
    }

    const binding = this._getTopLevelNamespaceByClassName<T>(cls.name);
    if (!binding) {
      throw new Error(
        `parentAgent(${cls.name}): no top-level namespace for "${cls.name}" ` +
          `was found in env or worker exports. Make sure the parent class is ` +
          `exported under that class name and registered as a Durable Object binding.`
      );
    }
    return await getServerByName<Cloudflare.Env, T>(binding, parent.name);
  }

  private _getTopLevelNamespaceByClassName<T extends Agent>(
    className: string
  ): DurableObjectNamespace<T> | undefined {
    // Prefer explicit env bindings; fall back to worker exports so
    // custom binding names still work when the class is exported under
    // its constructor name.
    return (
      this._asDurableObjectNamespace<T>(this._host.env()[className]) ??
      this._asDurableObjectNamespace<T>(
        (workerExports as Record<string, unknown>)[className]
      )
    );
  }

  private _asDurableObjectNamespace<T extends Agent>(
    candidate: unknown
  ): DurableObjectNamespace<T> | undefined {
    const binding = candidate as DurableObjectNamespace<T> | undefined;
    return binding?.idFromName ? binding : undefined;
  }

  private async _parentAgentFacetProxy<T extends Agent>(
    className: string,
    parentPath: ReadonlyArray<{ className: string; name: string }>
  ): Promise<DurableObjectStub<T>> {
    const [root] = parentPath;
    if (!root) {
      throw new Error(`parentAgent(${className}): parent path is empty.`);
    }

    const rootBinding = this._getTopLevelNamespaceByClassName<Agent>(
      root.className
    );
    if (!rootBinding) {
      throw new Error(
        `parentAgent(${className}): direct parent is a facet, but no ` +
          `top-level root namespace "${root.className}" was found in env ` +
          `or worker exports to bridge the call.`
      );
    }

    const rootStubPromise = getServerByName<Cloudflare.Env, Agent>(
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
              if (owner._isWebSocketUpgradeRequest(input, init)) {
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

  private _isWebSocketUpgradeRequest(
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
   * Get or create a named sub-agent (see `Agent#subAgent` for the
   * public contract).
   */
  async subAgent<T extends Agent>(
    cls: SubAgentClass<T>,
    name: string
  ): Promise<SubAgentStub<T>> {
    return (await this.resolveSubAgent(cls.name, name)) as SubAgentStub<T>;
  }

  /**
   * Shared facet resolution — takes a CamelCase class name string
   * (matching `ctx.exports`) rather than a class reference. Both
   * `subAgent(cls, name)` and `_cf_invokeSubAgent(className, ...)`
   * funnel through here so registry bookkeeping and the
   * `_cf_initAsFacet` handshake are consistent.
   */
  async resolveSubAgent(className: string, name: string): Promise<unknown> {
    const ctx = this._host.facetCtx();
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

    // Derive the child's ancestor chain: our own `parentPath` +
    // `{ class: this.constructor.name, name: this.name }`. Inductive
    // across recursive nesting.
    const childParentPath = this._host.selfPath();
    const childPath = [...childParentPath, { className, name }];

    // For nested facets, the immediate parent is itself facet-only
    // and is not expected to expose namespace helpers. Use the root
    // supervisor namespace instead; path-v2 identities are scoped to
    // the full logical path while legacy rows continue using bare names.
    const rootClassName =
      this._host.parentPath()[0]?.className ?? this._host.constructorName();
    const rootNs = ctx.exports[rootClassName];
    if (!rootNs?.idFromName) {
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
      const looksMinified = /^_*[a-z][a-z0-9]{0,2}$/.test(rootClassName);
      const minificationHint = looksMinified
        ? ` The class name "${rootClassName}" looks minified — make sure your bundler preserves class names (e.g. esbuild's \`keepNames: true\`).`
        : "";
      throw new Error(
        `Sub-agent bootstrap requires the root agent class "${rootClassName}" to be available as a Durable Object namespace, but ctx.exports["${rootClassName}"] is missing or doesn't expose idFromName.${minificationHint} Make sure the root agent class is exported under that class name and registered in your wrangler.jsonc durable_objects.bindings.`
      );
    }
    const identity = await this._subAgentIdentity(className, name, childPath);
    const facetId = rootNs.idFromName(identity.name);
    const stub = ctx.facets.get(facetKey, () => ({
      class: Cls as DurableObjectClass,
      id: facetId
    }));

    // Record before initialization so a successfully-initialized facet is
    // not left without identity metadata if the parent is interrupted after
    // the child RPC returns. Roll back only rows this call created.
    this._recordSubAgent(className, name, identity);

    // Initialize the child as a facet via a single RPC that runs
    // inside the child's isolate. Avoids the cross-DO I/O error that
    // the previous `stub.fetch(req)` path triggered by handing a
    // parent-owned Request across the isolate boundary.
    //
    // The parent may be inside a WebSocket/message request context here.
    // Clear native context handles before the child facet RPC so workerd
    // never sees parent-owned I/O attached to child initialization.
    try {
      await this._host.runOutsideRequestContext(async () => {
        await (
          stub as unknown as {
            _cf_initAsFacet(
              name: string,
              parentPath: ReadonlyArray<{ className: string; name: string }>,
              identityName: string
            ): Promise<void>;
          }
        )._cf_initAsFacet(name, childParentPath, identity.name);
      });
    } catch (error) {
      if (!identity.existing) {
        this._forgetSubAgent(className, name);
      }
      throw error;
    }

    return stub;
  }

  /**
   * Forcefully abort a running sub-agent (see `Agent#abortSubAgent`
   * for the public contract).
   */
  abortSubAgent(cls: SubAgentClass, name: string, reason?: unknown): void {
    const ctx = this._host.facetCtx();
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
   * storage (see `Agent#deleteSubAgent` for the public contract).
   */
  async deleteSubAgent(cls: SubAgentClass, name: string): Promise<void> {
    const ctx = this._host.facetCtx();
    if (!ctx.facets) {
      throw new Error(
        "deleteSubAgent() is not supported in this runtime — " +
          "`ctx.facets` is unavailable. " +
          "Update to the latest `compatibility_date` in your wrangler.jsonc."
      );
    }
    const facetKey = `${cls.name}\0${name}`;
    const childPath = [...this._host.selfPath(), { className: cls.name, name }];
    if (this._host.isFacet()) {
      const root = await this._host.rootAlarmOwner();
      await root._cf_cleanupFacetPrefix(childPath);
    } else {
      await this._host.cleanupFacetPrefix(childPath);
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

  /**
   * Recursively destroy a descendant facet identified by
   * `targetPath` (see `Agent#_cf_destroyDescendantFacet`).
   */
  async destroyDescendantFacet(
    targetPath: ReadonlyArray<AgentPathStep>
  ): Promise<void> {
    const selfPath = this._host.selfPath();

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
    if (!this._host.isSameAgentPathPrefix(selfPath, targetPath)) {
      throw new Error(
        "_cf_destroyDescendantFacet: target path does not descend from this agent."
      );
    }

    // The root owns every schedule row; cancel the target's prefix
    // upfront so we don't have to make an extra round trip back from
    // each intermediate hop.
    if (this._host.parentPath().length === 0) {
      await this._host.cleanupFacetPrefix(targetPath);
    }

    if (selfPath.length === targetPath.length - 1) {
      // We are the immediate parent of the target — perform the local
      // facet teardown the same way `deleteSubAgent` does.
      const target = targetPath[targetPath.length - 1];
      const ctx = this._host.facetCtx();
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
    if (!this._agent.hasSubAgent(next.className, next.name)) {
      // Already gone — schedules are cleared, nothing more to do.
      return;
    }
    const stub = await this.resolveSubAgent(next.className, next.name);
    const handle = stub as unknown as {
      _cf_destroyDescendantFacet(
        targetPath: ReadonlyArray<AgentPathStep>
      ): Promise<void>;
    };
    await handle._cf_destroyDescendantFacet(targetPath);
  }

  // ── Sub-agent registry (backs `hasSubAgent` / `listSubAgents`) ───────

  private _addColumnIfNotExists(sql: string): void {
    try {
      this._host.rawSql(sql);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!message.toLowerCase().includes("duplicate column")) {
        throw e;
      }
    }
  }

  private _ensureSubAgentRegistry(): void {
    if (this._subAgentRegistryReady) return;
    // This registry is lazy because older agents may never create sub-agents.
    // Keep its additive column migrations here instead of the global schema
    // gate so first sub-agent access upgrades legacy registry tables in place.
    this._host.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_sub_agents (
        class TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        identity_version TEXT,
        identity_name TEXT,
        PRIMARY KEY (class, name)
      )
    `;
    this._addColumnIfNotExists(
      "ALTER TABLE cf_agents_sub_agents ADD COLUMN identity_version TEXT"
    );
    this._addColumnIfNotExists(
      "ALTER TABLE cf_agents_sub_agents ADD COLUMN identity_name TEXT"
    );
    this._subAgentRegistryReady = true;
  }

  private _recordSubAgent(
    className: string,
    name: string,
    identity: { version: SubAgentIdentityVersion; name: string }
  ): void {
    this._ensureSubAgentRegistry();
    this._host.sql`
      INSERT OR IGNORE INTO cf_agents_sub_agents
        (class, name, created_at, identity_version, identity_name)
      VALUES
        (${className}, ${name}, ${Date.now()}, ${identity.version}, ${identity.name})
    `;
  }

  private _subAgentRegistryRow(
    className: string,
    name: string
  ): {
    identity_version: string | null;
    identity_name: string | null;
  } | null {
    this._ensureSubAgentRegistry();
    const rows = this._host.sql<{
      identity_version: string | null;
      identity_name: string | null;
    }>`
      SELECT identity_version, identity_name
      FROM cf_agents_sub_agents
      WHERE class = ${className} AND name = ${name}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async _subAgentIdentity(
    className: string,
    name: string,
    childPath: ReadonlyArray<AgentPathStep>
  ): Promise<{
    version: SubAgentIdentityVersion;
    name: string;
    existing: boolean;
  }> {
    const row = this._subAgentRegistryRow(className, name);
    if (row) {
      if (
        row.identity_version === SUB_AGENT_IDENTITY_VERSION_PATH_V2 &&
        typeof row.identity_name === "string"
      ) {
        return {
          version: SUB_AGENT_IDENTITY_VERSION_PATH_V2,
          name: row.identity_name,
          existing: true
        };
      }
      return {
        version: SUB_AGENT_IDENTITY_VERSION_LEGACY,
        name,
        existing: true
      };
    }

    // Do not probe the legacy bare-name facet here. `ctx.facets.get()` is
    // create-on-access, so probing would create or wake legacy storage as a
    // side effect and could reintroduce old id collisions. Existing registry
    // rows remain the compatibility signal; new rows use path-v2.
    const digest = await sha256Hex(JSON.stringify(childPath));
    return {
      version: SUB_AGENT_IDENTITY_VERSION_PATH_V2,
      name: pathV2IdentityName(name, digest),
      existing: false
    };
  }

  private _forgetSubAgent(className: string, name: string): void {
    this._ensureSubAgentRegistry();
    this._host.sql`
      DELETE FROM cf_agents_sub_agents
      WHERE class = ${className} AND name = ${name}
    `;
  }

  /**
   * Whether this agent has previously spawned (and not deleted) a
   * sub-agent of the given class and name (see `Agent#hasSubAgent`).
   */
  hasSubAgent(classOrName: SubAgentClass | string, name: string): boolean {
    const className =
      typeof classOrName === "string" ? classOrName : classOrName.name;
    this._ensureSubAgentRegistry();
    const rows = this._host.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agents_sub_agents
      WHERE class = ${className} AND name = ${name}
    `;
    return (rows[0]?.n ?? 0) > 0;
  }

  /**
   * List known sub-agents, optionally filtered by class (see
   * `Agent#listSubAgents`).
   */
  listSubAgents(
    classOrName?: SubAgentClass | string
  ): Array<{ className: string; name: string; createdAt: number }> {
    const className =
      typeof classOrName === "string" ? classOrName : classOrName?.name;
    this._ensureSubAgentRegistry();
    const rows = className
      ? this._host.sql<{ class: string; name: string; created_at: number }>`
          SELECT class, name, created_at FROM cf_agents_sub_agents
          WHERE class = ${className}
          ORDER BY created_at ASC
        `
      : this._host.sql<{ class: string; name: string; created_at: number }>`
          SELECT class, name, created_at FROM cf_agents_sub_agents
          ORDER BY created_at ASC
        `;
    return rows.map((r) => ({
      className: r.class,
      name: r.name,
      createdAt: r.created_at
    }));
  }
}
