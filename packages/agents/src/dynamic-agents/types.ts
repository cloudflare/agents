import type {
  Connection,
  WSMessage,
  LifecycleRouteEnvelope
} from "../lifecycle/durable-object-lifecycle";
import type { LifecycleRouteAddress } from "../lifecycle/capability";
import type { AgentPathStep } from "../sub-routing";
import type { Agent } from "../index";
import type { DynamicAgentConnectionBridge } from "./bridges";

// ── Dynamic-agent (facet) types ──────────────────────────────────────

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

export type DynamicAgentPathInvokeEndpoint = {
  _cf_invokeSubAgentPath(
    path: ReadonlyArray<{ className: string; name: string }>,
    method: string,
    args: unknown[]
  ): Promise<unknown>;
};

export type DynamicAgentConnectionMeta = {
  id: string;
  uri: string | null;
  tags: string[];
  state: unknown;
  requestHeaders?: [string, string][];
};

export type DynamicAgentConnectionBridgeLike = {
  send(message: string | ArrayBuffer | ArrayBufferView): void | Promise<void>;
  close(code?: number, reason?: string): void | Promise<void>;
  setState(state: unknown): unknown | Promise<unknown>;
  broadcast(
    ownerPath: ReadonlyArray<{ className: string; name: string }>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void | Promise<void>;
};

export type DynamicAgentConnectionOperationName = "send" | "setState" | "close";

export type StoredDynamicAgentConnection = {
  meta: DynamicAgentConnectionMeta;
  connection?: Connection;
};

export type DynamicAgentBridgeInvocationContext = {
  bridge?: DynamicAgentConnectionBridgeLike;
  connectionId: string;
};

export type DynamicAgentWebSocketEndpoint = {
  _cf_handleSubAgentWebSocketConnect(
    bridge: DynamicAgentConnectionBridge,
    meta: DynamicAgentConnectionMeta
  ): Promise<void>;
  _cf_handleSubAgentWebSocketMessage(
    message: WSMessage,
    bridge: DynamicAgentConnectionBridge,
    meta: DynamicAgentConnectionMeta,
    replyBridge?: DynamicAgentConnectionBridge
  ): Promise<void>;
  _cf_handleSubAgentWebSocketClose(
    code: number,
    reason: string,
    wasClean: boolean,
    bridge: DynamicAgentConnectionBridge,
    meta: DynamicAgentConnectionMeta
  ): Promise<void>;
};

/**
 * Constructor type for a dynamic agent (facet-backed child) class.
 * Used by {@link Agent.dynamicAgents} to reference the child class
 * via `ctx.exports`.
 *
 * The class name (`cls.name`) must match the export name in the
 * worker entry point — re-exports under a different name
 * (e.g. `export { Foo as Bar }`) are not supported.
 */
export type DynamicAgentClass<T extends Agent = Agent> = {
  new (ctx: DurableObjectState, env: never): T;
};

/**
 * Wraps `T` in a `Promise` unless it already is one.
 */
type Promisify<T> = T extends Promise<unknown> ? T : Promise<T>;

/**
 * A typed RPC stub for a dynamic agent. Exposes all public instance
 * methods as callable RPC methods with Promise-wrapped return types.
 *
 * Methods owned by `Agent`, its lifecycle, or `DurableObject` internals
 * are excluded — only user-defined methods on the subclass are exposed.
 */
export type DynamicAgentStub<T extends Agent> = {
  [K in keyof T as K extends keyof Agent
    ? never
    : T[K] extends (...args: never[]) => unknown
      ? K
      : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promisify<R>
    : never;
};

export type FacetRunStorageRow = {
  owner_path: string;
  owner_path_key: string;
  run_id: string;
  created_at: number;
};

/**
 * Internal RPC surface exposed by the root agent for facets to
 * delegate alarm-owning operations (schedules + facet teardown).
 * @internal
 */
export type RootFacetRpcSurface = {
  _cf_routeLifecycle(
    target: LifecycleRouteAddress | undefined,
    envelope: LifecycleRouteEnvelope
  ): Promise<unknown>;
  _cf_cleanupFacetPrefix(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<void>;
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
  ): Promise<DynamicAgentConnectionMeta[]>;
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
