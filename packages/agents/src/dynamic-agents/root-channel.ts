import { RpcTarget } from "cloudflare:workers";
import type { LifecycleRouteAddress } from "../lifecycle/capability";
import type { LifecycleRouteEnvelope } from "../lifecycle/durable-object-lifecycle";
import type { AgentPathStep } from "../sub-routing";
import type { RootFacetRpcSurface } from "./types";

/**
 * The newest instance per Durable Object id in this isolate, held weakly:
 * an evicted instance is not kept alive by it. Dead entries are swept as
 * the map grows, so it stays about as big as the live instances.
 */
const liveRoots = new Map<string, WeakRef<object>>();
let sweepAt = 64;

/** @internal Record `root` as its object's live instance in this isolate. */
export function markLiveRoot(id: string, root: object): void {
  liveRoots.set(id, new WeakRef(root));
  if (liveRoots.size < sweepAt) return;
  for (const [key, ref] of liveRoots) {
    if (ref.deref() === undefined) liveRoots.delete(key);
  }
  sweepAt = Math.max(64, liveRoots.size * 2);
}

const STALE_ROOT_CHANNEL =
  "The root instance behind this channel was replaced.";

/**
 * @internal A channel whose root instance was replaced refused the call,
 * before running any of it. The message is the mark: an error's class does
 * not survive the call.
 */
export function isStaleRootChannelError(error: unknown): boolean {
  return error instanceof Error && error.message === STALE_ROOT_CHANNEL;
}

/**
 * The root's side of the calls its facets make to it, handed down at facet
 * init. A facet that calls this instead of a stub of its root does not loop
 * back into the runtime: measured, calls from more than about 14 new facets
 * in one invocation through a root stub fail with "Subrequest depth limit
 * exceeded", and through this all succeed.
 *
 * @internal
 */
export class RootFacetChannel extends RpcTarget implements RootFacetRpcSurface {
  readonly #root: RootFacetRpcSurface;
  readonly #run: <T>(body: () => Promise<T>) => Promise<T>;

  /**
   * `run` puts each call in the root's own invocation scope: a call through
   * this keeps the calling facet's async context, which a stub call does not.
   */
  constructor(
    root: RootFacetRpcSurface,
    id: string,
    run: <T>(body: () => Promise<T>) => Promise<T>
  ) {
    super();
    this.#root = root;
    // A facet can outlive the root instance that handed it this channel (an
    // eviction that keeps the isolate): its calls must reach the new one.
    this.#run = (body) => {
      if (liveRoots.get(id)?.deref() !== root) {
        return Promise.reject(new Error(STALE_ROOT_CHANNEL));
      }
      return run(body);
    };
  }

  _cf_routeLifecycle(
    target: LifecycleRouteAddress | undefined,
    envelope: LifecycleRouteEnvelope
  ): Promise<unknown> {
    return this.#run(() => this.#root._cf_routeLifecycle(target, envelope));
  }

  _cf_cleanupFacetPrefix(ownerPath: ReadonlyArray<AgentPathStep>) {
    return this.#run(() => this.#root._cf_cleanupFacetPrefix(ownerPath));
  }

  _cf_destroyDescendantFacet(targetPath: ReadonlyArray<AgentPathStep>) {
    return this.#run(() => this.#root._cf_destroyDescendantFacet(targetPath));
  }

  _cf_broadcastToSubAgent(
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ) {
    return this.#run(() =>
      this.#root._cf_broadcastToSubAgent(ownerPath, message, without)
    );
  }

  _cf_subAgentConnectionMetas(ownerPath: ReadonlyArray<AgentPathStep>) {
    return this.#run(() => this.#root._cf_subAgentConnectionMetas(ownerPath));
  }

  _cf_sendToSubAgentConnection(
    connectionId: string,
    message: string | ArrayBuffer | ArrayBufferView
  ) {
    return this.#run(() =>
      this.#root._cf_sendToSubAgentConnection(connectionId, message)
    );
  }

  _cf_sendManyToSubAgentConnection(
    connectionId: string,
    messages: ReadonlyArray<string | ArrayBuffer | ArrayBufferView>
  ) {
    return this.#run(() =>
      this.#root._cf_sendManyToSubAgentConnection(connectionId, messages)
    );
  }

  _cf_closeSubAgentConnection(
    connectionId: string,
    code?: number,
    reason?: string
  ) {
    return this.#run(() =>
      this.#root._cf_closeSubAgentConnection(connectionId, code, reason)
    );
  }

  _cf_setSubAgentConnectionState(connectionId: string, state: unknown) {
    return this.#run(() =>
      this.#root._cf_setSubAgentConnectionState(connectionId, state)
    );
  }

  _cf_setSubAgentConnectionFlag(
    connectionId: string,
    key: string,
    value: unknown
  ) {
    return this.#run(() =>
      this.#root._cf_setSubAgentConnectionFlag(connectionId, key, value)
    );
  }

  _cf_closeSubAgentConnectionsForPrefix(
    prefix: ReadonlyArray<AgentPathStep>,
    code: number,
    reason: string
  ) {
    return this.#run(() =>
      this.#root._cf_closeSubAgentConnectionsForPrefix(prefix, code, reason)
    );
  }
}
