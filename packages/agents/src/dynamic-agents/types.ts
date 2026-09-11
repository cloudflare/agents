import type { DurableObject } from "cloudflare:workers";
import type { Agent } from "../index";
import type { LifecycleObject, LifecycleRouteEnvelope } from "../lifecycle";
import type { WSMessage } from "../lifecycle";
import type { AgentPathStep } from "../sub-routing";

/** One child identity: the class it runs and the name the parent gave it. */
export type DynamicAgentRef = {
  readonly className: string;
  readonly name: string;
};

/**
 * What a host must expose for dynamic agents: its Lifecycle, and the one
 * native-RPC aperture routed capabilities travel through.
 *
 * ```ts
 * _cf_lifecycle(envelope: LifecycleRouteEnvelope) {
 *   return this.lifecycle.route(envelope);
 * }
 * ```
 */
export type DynamicAgentHost = LifecycleObject & {
  _cf_lifecycle(envelope: LifecycleRouteEnvelope): Promise<unknown>;
};

/**
 * Policy for the DynamicAgents capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type DynamicAgentsOptions = {
  /**
   * Gate every `/sub/` request or WebSocket upgrade before it reaches a
   * child. Runs in host context. Return nothing to allow, a `Request` to
   * forward instead, or a `Response` to reject.
   */
  readonly onBeforeChild?: (
    request: Request,
    child: DynamicAgentRef
  ) =>
    | Request
    | Response
    | undefined
    | void
    | Promise<Request | Response | undefined | void>;
  /**
   * On an object holding leases (see `holdLease`): recover its leased
   * work and report how many leases it still holds. Runs in host context
   * when the root sweeps. Default: every lease counts as released.
   */
  readonly checkLeases?: () => number | Promise<number>;
  /**
   * Heartbeat interval for root-held keep-alive tokens and lease sweeps.
   * Default: 30 seconds.
   */
  readonly keepAliveIntervalMs?: number;
};

/** A connection as the socket's owner describes it to a child. */
export type DynamicAgentConnectionMeta = {
  id: string;
  uri: string | null;
  tags: string[];
  state: unknown;
  requestHeaders?: [string, string][];
};

/** Operations a child performs on a root-owned connection. */
export type DynamicAgentConnectionBridgeLike = {
  send(message: WSMessage): void | Promise<void>;
  close(code?: number, reason?: string): void | Promise<void>;
  setState(state: unknown): unknown | Promise<unknown>;
  setTags(tags: readonly string[]): void | Promise<void>;
  broadcast(
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: WSMessage,
    without?: string[]
  ): void | Promise<void>;
};

export type DynamicAgentConnectionOperationName =
  | "send"
  | "setState"
  | "setTags"
  | "close";

export type DynamicAgentBridgeInvocationContext = {
  bridge?: DynamicAgentConnectionBridgeLike;
  connectionId: string;
};

/**
 * Constructor type for a dynamic agent (facet-backed child) class. The
 * class name (`cls.name`) must match the export name in the worker entry
 * point — re-exports under a different name (`export { Foo as Bar }`) are
 * not supported.
 */
export type DynamicAgentClass<T extends DurableObject = DurableObject> = {
  new (ctx: DurableObjectState, env: never): T;
};

/** Wraps `T` in a `Promise` unless it already is one. */
type Promisify<T> = T extends Promise<unknown> ? T : Promise<T>;

/**
 * Members a child stub never exposes: the framework surface of `Agent`
 * for Agent children, and the Durable Object, Lifecycle, and aperture
 * members of any other host.
 */
type DynamicAgentStubExcluded<T> = [T] extends [Agent]
  ? keyof Agent
  : keyof DurableObject | "lifecycle" | "_cf_lifecycle";

/**
 * A typed RPC stub for a dynamic agent: the child's own public methods,
 * Promise-wrapped.
 */
export type DynamicAgentStub<T extends DurableObject> = {
  [K in keyof T as K extends DynamicAgentStubExcluded<T>
    ? never
    : T[K] extends (...args: never[]) => unknown
      ? K
      : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promisify<R>
    : never;
};

/** One row of the root-side lease index (`cf_agents_facet_runs`). */
export type FacetRunStorageRow = {
  owner_path: string;
  owner_path_key: string;
  run_id: string;
  created_at: number;
};
