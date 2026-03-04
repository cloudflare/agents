import { Server } from "partyserver";

// ── Internal facet access types ─────────────────────────────────────
// These mirror the experimental workerd `ctx.facets` API without
// depending on the "experimental" compat flag at the type level.

/** @internal */
export interface FacetCapableCtx {
  facets: {
    get(
      name: string,
      getStartupOptions: () =>
        | { id?: DurableObjectId | string; class: DurableObjectClass }
        | Promise<{
            id?: DurableObjectId | string;
            class: DurableObjectClass;
          }>
    ): Fetcher;
    abort(name: string, reason: unknown): void;
    delete(name: string): void;
  };
  exports: Record<string, DurableObjectClass>;
}

// ── Public types ────────────────────────────────────────────────────

/**
 * Constructor type for a SubAgent subclass.
 * Used by {@link SubAgent.subAgent} to reference the child class
 * via `ctx.exports`.
 *
 * The class name (`cls.name`) must match the export name in the
 * worker entry point — re-exports under a different name
 * (e.g. `export { Foo as Bar }`) are not supported.
 */
export type SubAgentClass<T extends SubAgent = SubAgent> = {
  new (ctx: DurableObjectState, env: never): T;
};

/**
 * Wraps `T` in a `Promise` unless it already is one.
 */
type Promisify<T> = T extends Promise<unknown> ? T : Promise<T>;

/**
 * Server / DurableObject internals excluded from the RPC stub.
 * This is a blocklist — if `Server` or `SubAgent` gains new methods
 * they must be added here to stay hidden from the stub type.
 */
type SubAgentInternals =
  | "fetch"
  | "alarm"
  | "webSocketMessage"
  | "webSocketClose"
  | "webSocketError"
  | "sql"
  | "broadcast"
  | "getConnection"
  | "getConnections"
  | "getConnectionTags"
  | "setName"
  | "onStart"
  | "onConnect"
  | "onMessage"
  | "onClose"
  | "onError"
  | "onRequest"
  | "onException"
  | "onAlarm"
  | "subAgent"
  | "abortSubAgent"
  | "deleteSubAgent";

/**
 * A typed RPC stub for a SubAgent. Exposes all public instance methods
 * as callable RPC methods with Promise-wrapped return types.
 *
 * Methods inherited from `Server` / `DurableObject` internals are
 * excluded — only user-defined methods on the SubAgent subclass are
 * exposed.
 */
export type SubAgentStub<T extends SubAgent> = {
  [K in keyof T as K extends SubAgentInternals
    ? never
    : T[K] extends (...args: never[]) => unknown
      ? K
      : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promisify<R>
    : never;
};

// ── SubAgent class ──────────────────────────────────────────────────

/**
 * Base class for sub-agents — child Durable Objects that run as facets
 * of a parent Agent (or another SubAgent) on the same machine, each
 * with their own isolated SQLite storage.
 *
 * Extends partyserver's `Server`, so inherits:
 * - `this.sql` tagged-template SQL helper
 * - `this.name` identity
 * - WebSocket hibernation + `onConnect`/`onMessage`/`onClose`
 * - `broadcast()`, `getConnection()`, `getConnections()`
 *
 * SubAgents do **not** need wrangler.jsonc entries — they are
 * referenced via `ctx.exports` and instantiated through the
 * experimental facets API.
 *
 * @experimental Requires the `"experimental"` compatibility flag.
 *
 * @example
 * ```typescript
 * import { SubAgent } from "agents/experimental/subagent";
 *
 * export class SearchAgent extends SubAgent {
 *   async search(query: string): Promise<Result[]> {
 *     const cached = this.sql`SELECT * FROM cache WHERE q = ${query}`;
 *     if (cached.length) return cached;
 *     // ... fetch, cache, return
 *   }
 * }
 * ```
 */
export class SubAgent<
  Env extends Cloudflare.Env = Cloudflare.Env
> extends Server<Env> {
  /**
   * Get or create a named child sub-agent — a facet with its own
   * isolated SQLite storage running on the same machine.
   *
   * The first call for a given name triggers the child's `onStart()`.
   * Subsequent calls with the same name return the existing instance
   * (the set-name fetch is a no-op if already initialized).
   *
   * @experimental Requires the `"experimental"` compatibility flag.
   *
   * @param cls The SubAgent subclass (must be exported from the worker)
   * @param name Unique name for this child instance
   * @returns A typed RPC stub for calling methods on the child
   *
   * @example
   * ```typescript
   * const searcher = await this.subAgent(SearchAgent, "main-search");
   * const results = await searcher.search("cloudflare agents");
   * ```
   */
  async subAgent<T extends SubAgent>(
    cls: SubAgentClass<T>,
    name: string
  ): Promise<SubAgentStub<T>> {
    _validateSubAgentExport(this.ctx, cls);
    return _getSubAgent(this.ctx, cls, name);
  }

  /**
   * Forcefully abort a running child sub-agent. The child stops
   * executing immediately and will be restarted on next
   * {@link subAgent} call. Pending RPC calls receive the reason
   * as an error. Transitively aborts the child's own children.
   *
   * @experimental Requires the `"experimental"` compatibility flag.
   *
   * @param name Name of the child to abort
   * @param reason Error thrown to pending/future RPC callers
   */
  abortSubAgent(name: string, reason?: unknown): void {
    _abortSubAgent(this.ctx, name, reason);
  }

  /**
   * Delete a child sub-agent: abort it if running, then permanently
   * wipe its storage. Transitively deletes the child's own children.
   *
   * @experimental Requires the `"experimental"` compatibility flag.
   *
   * @param name Name of the child to delete
   */
  deleteSubAgent(name: string): void {
    _deleteSubAgent(this.ctx, name);
  }
}

// ── withSubAgents mixin ─────────────────────────────────────────────

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor constraint
type Constructor<T = object> = new (...args: any[]) => T;

/**
 * Mixin that adds sub-agent management methods to an Agent (or
 * AIChatAgent, McpAgent, etc.) without shipping them in the base
 * `Agent` class.
 *
 * @experimental Requires the `"experimental"` compatibility flag.
 *
 * @example
 * ```typescript
 * import { Agent } from "agents";
 * import { withSubAgents, SubAgent } from "agents/experimental/subagent";
 *
 * export class SearchAgent extends SubAgent {
 *   async search(query: string) { ... }
 * }
 *
 * const SubAgentParent = withSubAgents(Agent);
 *
 * export class MyAgent extends SubAgentParent<Env> {
 *   async doStuff() {
 *     const searcher = await this.subAgent(SearchAgent, "main");
 *     await searcher.search("hello");
 *   }
 * }
 * ```
 */
export function withSubAgents<TBase extends Constructor>(Base: TBase) {
  class WithSubAgents extends Base {
    /**
     * Get or create a named sub-agent — a child Durable Object with its
     * own isolated SQLite storage, running alongside this Agent on the
     * same machine. The child class must extend `SubAgent` and be exported
     * from the worker entry point.
     *
     * @experimental Requires the `"experimental"` compatibility flag.
     *
     * @param cls The SubAgent subclass (must be exported from the worker)
     * @param name Unique name for this child instance
     * @returns A typed RPC stub for calling methods on the child
     */
    async subAgent<T extends SubAgent>(
      cls: SubAgentClass<T>,
      name: string
    ): Promise<SubAgentStub<T>> {
      const { ctx } = this as unknown as { ctx: DurableObjectState };
      _validateSubAgentExport(ctx, cls);
      return _getSubAgent(ctx, cls, name);
    }

    /**
     * Forcefully abort a running sub-agent. The child stops executing
     * immediately and will be restarted on next {@link subAgent} call.
     * Pending RPC calls receive the reason as an error.
     * Transitively aborts the child's own children.
     *
     * @experimental Requires the `"experimental"` compatibility flag.
     *
     * @param name Name of the child to abort
     * @param reason Error thrown to pending/future RPC callers
     */
    abortSubAgent(name: string, reason?: unknown): void {
      const { ctx } = this as unknown as { ctx: DurableObjectState };
      _abortSubAgent(ctx, name, reason);
    }

    /**
     * Delete a sub-agent: abort it if running, then permanently wipe its
     * storage. Transitively deletes the child's own children.
     *
     * @experimental Requires the `"experimental"` compatibility flag.
     *
     * @param name Name of the child to delete
     */
    deleteSubAgent(name: string): void {
      const { ctx } = this as unknown as { ctx: DurableObjectState };
      _deleteSubAgent(ctx, name);
    }
  }
  return WithSubAgents;
}

// ── Shared helpers (used by both SubAgent and withSubAgents mixin) ───

/**
 * Synchronous validation that the SubAgent class exists in worker exports.
 * Call this before `_getSubAgent` so the error is thrown synchronously
 * in the caller’s scope (not as a rejected promise from an async function).
 * This avoids unhandled-rejection noise in the workerd runtime.
 * @internal
 */
export function _validateSubAgentExport(
  ctx: DurableObjectState,
  cls: SubAgentClass
): void {
  const { exports } = ctx as unknown as FacetCapableCtx;
  if (!exports[cls.name]) {
    throw new Error(
      `SubAgent class "${cls.name}" not found in worker exports. ` +
        `Make sure the class is exported from your worker entry point ` +
        `and that the export name matches the class name.`
    );
  }
}

/** @internal */
export async function _getSubAgent<T extends SubAgent>(
  ctx: DurableObjectState,
  cls: SubAgentClass<T>,
  name: string
): Promise<SubAgentStub<T>> {
  const { facets, exports } = ctx as unknown as FacetCapableCtx;
  const stub = facets.get(name, () => ({
    class: exports[cls.name] as DurableObjectClass
  }));

  // Trigger Server initialization (setName → onStart) via fetch,
  // same pattern as getAgentByName / getServerByName.
  const req = new Request(
    "http://dummy-example.cloudflare.com/cdn-cgi/partyserver/set-name/"
  );
  req.headers.set("x-partykit-room", name);
  await stub.fetch(req).then((res) => res.text());

  return stub as unknown as SubAgentStub<T>;
}

/** @internal */
export function _abortSubAgent(
  ctx: DurableObjectState,
  name: string,
  reason?: unknown
): void {
  (ctx as unknown as FacetCapableCtx).facets.abort(name, reason);
}

/** @internal */
export function _deleteSubAgent(ctx: DurableObjectState, name: string): void {
  (ctx as unknown as FacetCapableCtx).facets.delete(name);
}
