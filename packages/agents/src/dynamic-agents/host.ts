import type {
  Connection,
  LifecycleRouteEnvelope,
  WSMessage
} from "../lifecycle/durable-object-lifecycle";
import type { LifecycleRouteAddress } from "../lifecycle/capability";
import type { AgentPathStep } from "../sub-routing";

/**
 * The Agent internals the dynamic-agents (facet) machinery reaches
 * into. Agent implements this structurally and passes itself at
 * construction — the interface exists to make the coupling explicit
 * and reviewable, and is the seam a later capability refactor would
 * shrink.
 *
 * Members named `_cf_*` are cross-facet RPC entry points that must
 * stay on the Agent prototype; the module calls back into them when
 * traversal continues on another agent instance.
 *
 * @internal
 */
export interface DynamicAgentHostPort {
  readonly ctx: DurableObjectState;
  readonly lifecycle: {
    route(envelope: LifecycleRouteEnvelope): Promise<unknown>;
    readonly name: string;
  };
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
  /** Facet identity — written by `initAsFacet` and startup restore. */
  _isFacet: boolean;
  _facetName?: string;
  _parentPath: ReadonlyArray<AgentPathStep>;
  readonly name: string;
  readonly _ParentClass: { readonly name: string };
  readonly selfPath: AgentPathStep[];
  _keepAliveRefs: number;
  _isSameAgentPathPrefix(
    prefix: ReadonlyArray<AgentPathStep>,
    path: ReadonlyArray<AgentPathStep>
  ): boolean;
  hasSubAgent(className: string, name: string): boolean;
  _cf_resolveSubAgent(className: string, name: string): Promise<unknown>;
  _cf_cleanupFacetPrefix(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<void>;
  _cf_routeLifecycle(
    target: LifecycleRouteAddress | undefined,
    envelope: LifecycleRouteEnvelope
  ): Promise<unknown>;
  _syncHostJobs(): Promise<void>;
  readonly scheduler: {
    __DO_NOT_USE_WILL_BREAK__cleanupRoutePrefix(prefix: string): Promise<void>;
  };
  /** Local (non-facet-index) durable fiber recovery pass. */
  _checkRunFibers(): Promise<void>;
  /** Overridable RPC entry points — call via the host so subclass overrides intercept. */
  _cf_broadcastToSubAgent(
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): Promise<void>;
  _cf_checkRunFibersForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<number>;
  /** Ensure constructor-time async initialization has completed. */
  __unsafe_ensureInitialized(): Promise<void>;
  /**
   * Run `body` in a fresh invocation scope with no native request/
   * connection context attached, so a child-facet RPC never sees
   * parent-owned I/O handles.
   */
  _runFacetInitInvocation<T>(body: () => Promise<T>): Promise<T>;

  // ── WebSocket forwarding surface ─────────────────────────────────────
  readonly _webSockets: {
    getConnection<TState = unknown>(id: string): Connection<TState> | undefined;
    getConnections<TState = unknown>(
      tag?: string
    ): Iterable<Connection<TState>>;
  };
  _ensureConnectionWrapped(connection: Connection): void;
  _unsafe_getConnectionFlag(connection: Connection, key: string): unknown;
  _unsafe_setConnectionFlag(
    connection: Connection,
    key: string,
    value: unknown
  ): void;
  readonly _rawStateAccessors: {
    get(connection: Connection): { getRaw(): unknown } | undefined;
  };
  shouldConnectionBeReadonly(
    connection: Connection,
    context: { request: Request }
  ): boolean;
  setConnectionReadonly(connection: Connection, readonly: boolean): void;
  shouldSendProtocolMessages(
    connection: Connection,
    context: { request: Request }
  ): boolean;
  _setConnectionNoProtocol(connection: Connection): void;
  getConnectionTags(
    connection: Connection,
    context: { request: Request }
  ): Promise<string[]> | string[];
  onConnect(
    connection: Connection,
    context: { request: Request }
  ): unknown | Promise<unknown>;
  onMessage(
    connection: Connection,
    message: WSMessage
  ): unknown | Promise<unknown>;
  onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): unknown | Promise<unknown>;
  onBeforeSubAgent(
    request: Request,
    child: { className: string; name: string }
  ): Promise<Request | Response | void>;
}
