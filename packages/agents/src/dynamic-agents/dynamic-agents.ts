import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";
import type {
  Connection,
  LifecycleRouteEnvelope,
  WSMessage
} from "../lifecycle/durable-object-lifecycle";
import {
  LifecycleCapability,
  type LifecycleRouteAddress
} from "../lifecycle/capability";
import {
  SUB_PREFIX,
  parseSubAgentPath,
  type AgentPathStep
} from "../sub-routing";
import { getAgentByName } from "../agent-routing";
import { camelCaseToKebabCase, isInternalJsStubProp } from "../utils";
import type { Agent } from "../index";
import { agentPathKey, isValidParentPath } from "./identity";
import { DynamicAgentRegistry } from "./registry";
import {
  DynamicAgentConnectionBridge,
  RootDynamicAgentConnectionBridge,
  dynamicAgentRpcReplyContext,
  type DynamicAgentRpcReplyInvocationContext
} from "./bridges";
import type { DynamicAgentHostPort } from "./host";
import type {
  DynamicAgentBridgeInvocationContext,
  DynamicAgentConnectionBridgeLike,
  DynamicAgentConnectionMeta,
  DynamicAgentConnectionOperationName,
  DynamicAgentPathInvokeEndpoint,
  DynamicAgentWebSocketEndpoint,
  FacetCapableCtx,
  FacetRunStorageRow,
  RootFacetRpcSurface,
  StoredDynamicAgentConnection
} from "./types";

/**
 * Internal key used to remember the outer `/sub/...` URL for a
 * WebSocket accepted by the parent on behalf of a child facet.
 * Hibernated events then wake the parent, which forwards frames to
 * the child over serializable RPC while keeping native WebSocket I/O
 * parent-owned.
 *
 * Storage-frozen — never rename.
 */
export const CF_SUB_AGENT_OUTER_URL_KEY = "_cf_subAgentOuterUrl";
export const CF_SUB_AGENT_TAGS_KEY = "_cf_subAgentTags";

/** Wire-frozen internal header carrying the outer URL on WS upgrades. */
export const SUB_AGENT_OUTER_URL_HEADER = "x-cf-agents-subagent-url";

/**
 * The facet-backed dynamic-agent machinery, extracted from the Agent
 * class. One instance per Agent, installed as a Lifecycle capability
 * (`capabilityId: "dynamic-agents"`); the host port documents exactly
 * which Agent internals it touches.
 *
 * The capability claims no runner hooks — four integration points are
 * deliberately wired directly through the Agent composition root
 * instead, because the runner's dispatch contract cannot express them:
 * the `/sub/` upgrade path rewrites the request and *continues* into
 * `lifecycle.fetch` (onRequest can only claim), forwarded WS frames run
 * inside the host's onMessage wrapper *after* the WebSockets capability
 * has claimed the wake, this module *implements* the lifecycle route
 * transport rather than consuming it, and facet-context restore has
 * load-bearing startup ordering inside the host's startup span.
 *
 * Nothing here renames any wire- or storage-visible identifier: the
 * `cf_agents_facet_runs` table, `_cf_*` RPC method names, and route
 * key formats are frozen.
 *
 * @internal
 */
export class DynamicAgentsInternal extends LifecycleCapability {
  #host: DynamicAgentHostPort;

  /** The parent-side registry of spawned dynamic agents. */
  readonly registry: DynamicAgentRegistry;

  /**
   * Root-owned keepAlive tokens held on behalf of descendant facets.
   * Facets cannot arm a physical alarm, so their keepAlive refs ride
   * on the root's heartbeat.
   */
  #facetKeepAliveTokens = new Set<string>();

  /** Per-frame bridge context while a forwarded WS event runs in a facet. */
  #bridgeContext = new AsyncLocalStorage<DynamicAgentBridgeInvocationContext>();

  /**
   * Facet-side virtual connections: real WebSockets owned by the ROOT
   * DO, mirrored here as `Connection`-shaped objects whose operations
   * route back through the live frame bridge or the root over RPC.
   */
  #virtualConnections = new Map<string, StoredDynamicAgentConnection>();

  /** Per-connection operation queues (send/setState/close ordering). */
  #connectionOperationTails = new Map<string, Promise<void>>();

  /** One-way barrier so facet broadcasts wait for older queued operations. */
  #broadcastOperationTail?: Promise<void>;

  constructor(host: DynamicAgentHostPort) {
    super("dynamic-agents");
    this.#host = host;
    this.registry = new DynamicAgentRegistry({
      sql: host.sql.bind(host),
      execRawSql: (sql) => void host.ctx.storage.sql.exec(sql)
    });
  }

  runRowsForPrefix(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): FacetRunStorageRow[] {
    const rows = this.#host.sql<FacetRunStorageRow>`
      SELECT owner_path, owner_path_key, run_id, created_at
      FROM cf_agents_facet_runs
    `;
    return rows.filter((row) => {
      try {
        const rowOwnerPath = JSON.parse(row.owner_path) as AgentPathStep[];
        return this.#host._isSameAgentPathPrefix(ownerPath, rowOwnerPath);
      } catch {
        return false;
      }
    });
  }

  deleteRunRowsForPrefix(ownerPath: ReadonlyArray<AgentPathStep>): void {
    for (const row of this.runRowsForPrefix(ownerPath)) {
      this.#host.sql`
        DELETE FROM cf_agents_facet_runs
        WHERE owner_path_key = ${row.owner_path_key}
          AND run_id = ${row.run_id}
      `;
    }
  }

  lifecycleRouteAddress(): LifecycleRouteAddress | undefined {
    if (!this.#host._isFacet) return undefined;
    const key = agentPathKey(this.#host.selfPath);
    return key ? { key, data: JSON.stringify(this.#host.selfPath) } : undefined;
  }

  async routeLifecycleToRoot(
    envelope: LifecycleRouteEnvelope
  ): Promise<unknown> {
    if (!this.#host._isFacet) return this.#host.lifecycle.route(envelope);
    return (await this.rootAlarmOwner())._cf_routeLifecycle(
      undefined,
      envelope
    );
  }

  async routeLifecycleToTarget(
    target: LifecycleRouteAddress,
    envelope: LifecycleRouteEnvelope
  ): Promise<unknown> {
    let targetPath: AgentPathStep[];
    try {
      targetPath = JSON.parse(target.data) as AgentPathStep[];
    } catch {
      throw new Error("Lifecycle route target is not a valid Agent path");
    }

    const selfPath = this.#host.selfPath;
    if (!this.#host._isSameAgentPathPrefix(selfPath, targetPath)) {
      throw new Error(
        `Lifecycle route does not descend from ${JSON.stringify(selfPath)}.`
      );
    }
    if (selfPath.length === targetPath.length) {
      return this.#host.lifecycle.route(envelope);
    }

    const next = targetPath[selfPath.length];
    if (!this.#host.hasSubAgent(next.className, next.name)) {
      const stalePath = targetPath.slice(0, selfPath.length + 1);
      if (this.#host._isFacet) {
        await (await this.rootAlarmOwner())._cf_cleanupFacetPrefix(stalePath);
      } else {
        await this.#host._cf_cleanupFacetPrefix(stalePath);
      }
      return false;
    }

    const child = await this.#host._cf_resolveSubAgent(
      next.className,
      next.name
    );
    return (
      child as unknown as {
        _cf_routeLifecycle(
          target: LifecycleRouteAddress,
          envelope: LifecycleRouteEnvelope
        ): Promise<unknown>;
      }
    )._cf_routeLifecycle(target, envelope);
  }

  /** Body of the single native-RPC aperture for routed Lifecycle capabilities. */
  routeLifecycle(
    target: LifecycleRouteAddress | undefined,
    envelope: LifecycleRouteEnvelope
  ): Promise<unknown> {
    return target
      ? this.routeLifecycleToTarget(target, envelope)
      : this.#host.lifecycle.route(envelope);
  }

  async rootAlarmOwner(): Promise<RootFacetRpcSurface> {
    const root = this.#host._parentPath[0];
    if (!root) {
      throw new Error("Facet routing requires a root parent.");
    }

    const ctx = this.#host.ctx as unknown as Partial<FacetCapableCtx>;
    const binding = ctx.exports?.[root.className] as
      | DurableObjectNamespace
      | undefined;
    if (!binding) {
      throw new Error(
        `Unable to resolve root "${root.className}" for facet routing.`
      );
    }

    return (await getAgentByName<Cloudflare.Env, Agent>(
      binding as unknown as DurableObjectNamespace<Agent>,
      root.name
    )) as unknown as RootFacetRpcSurface;
  }

  rootResolvesToSelf(): boolean {
    const root = this.#host._parentPath[0];
    if (!root) return false;

    const ctx = this.#host.ctx as unknown as Partial<FacetCapableCtx>;
    const binding = ctx.exports?.[root.className] as
      | DurableObjectNamespace
      | undefined;
    if (!binding?.idFromName) return false;

    return binding.idFromName(root.name).equals(this.#host.ctx.id);
  }

  /**
   * Clean root-owned bookkeeping for a sub-tree of facets: bulk-cancel
   * schedules and routed Task wake mirrors under the owner-path prefix,
   * and delete root-side facet fiber recovery leases for the same sub-tree.
   */
  async cleanupPrefix(ownerPath: ReadonlyArray<AgentPathStep>): Promise<void> {
    const prefix = agentPathKey(ownerPath);
    if (prefix) {
      await this.#host.scheduler.__DO_NOT_USE_WILL_BREAK__cleanupRoutePrefix(
        prefix
      );
      await this.#host.tasks.__DO_NOT_USE_WILL_BREAK__cleanupRoutePrefix(
        prefix
      );
    }
    this.deleteRunRowsForPrefix(ownerPath);
    await this.#host._syncHostJobs();
  }

  /**
   * Acquire a root-owned keepAlive ref on behalf of a descendant facet.
   */
  async acquireKeepAlive(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<string> {
    const ownerPathKey = agentPathKey(ownerPath);
    const token = `${ownerPathKey ?? "unknown"}:${nanoid(9)}`;
    this.#facetKeepAliveTokens.add(token);
    this.#host._keepAliveRefs++;
    if (this.#host._keepAliveRefs === 1) {
      await this.#host._syncHostJobs();
    }
    return token;
  }

  /**
   * Release a root-owned keepAlive ref previously acquired for a facet.
   * Idempotent so disposer calls can safely race or run twice.
   */
  async releaseKeepAlive(token: string): Promise<void> {
    if (!this.#facetKeepAliveTokens.delete(token)) return;
    this.#host._keepAliveRefs = Math.max(0, this.#host._keepAliveRefs - 1);
    await this.#host._syncHostJobs();
  }

  /**
   * Register a facet's durable run row in the root-side index so root
   * alarm housekeeping can dispatch recovery checks into idle facets.
   */
  async registerRun(
    ownerPath: ReadonlyArray<AgentPathStep>,
    runId: string
  ): Promise<void> {
    const ownerPathJson = JSON.stringify(ownerPath);
    const ownerPathKey = agentPathKey(ownerPath);
    if (!ownerPathKey) {
      throw new Error("_cf_registerFacetRun requires a non-empty owner path.");
    }
    this.#host.sql`
      INSERT OR REPLACE INTO cf_agents_facet_runs
        (owner_path, owner_path_key, run_id, created_at)
      VALUES
        (${ownerPathJson}, ${ownerPathKey}, ${runId}, ${Date.now()})
    `;
    await this.#host._syncHostJobs();
  }

  /**
   * Root-side scan for durable fibers owned by descendant facets.
   * `cf_agents_facet_runs` is only an index; actual snapshots and
   * recovery hooks live in each facet's own `cf_agents_runs` table.
   */
  async checkRunFibers(): Promise<void> {
    // Only the root owns the physical alarm and facet-run index.
    if (this.#host._parentPath.length > 0) return;

    const rows = this.#host.sql<FacetRunStorageRow>`
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
        this.#host.sql`
          DELETE FROM cf_agents_facet_runs
          WHERE owner_path_key = ${row.owner_path_key}
        `;
        continue;
      }

      try {
        // Dispatch through the host so subclass overrides of the
        // `_cf_checkRunFibersForFacet` RPC entry point keep intercepting.
        const remaining =
          await this.#host._cf_checkRunFibersForFacet(ownerPath);
        if (remaining === 0) {
          this.#host.sql`
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
   */
  async checkRunFibersAtPath(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<number> {
    const selfPath = this.#host.selfPath;
    if (!this.#host._isSameAgentPathPrefix(selfPath, ownerPath)) {
      throw new Error(
        `Facet fiber owner path does not descend from ${JSON.stringify(selfPath)}.`
      );
    }

    if (selfPath.length === ownerPath.length) {
      await this.#host._checkRunFibers();
      const rows = this.#host.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM cf_agents_runs
      `;
      return rows[0]?.count ?? 0;
    }

    const next = ownerPath[selfPath.length];
    if (!this.#host.hasSubAgent(next.className, next.name)) {
      // The facet was deleted or its registry was cleared. The root
      // should prune the root-side lease; there is no remaining child
      // storage to recover through the public registry path.
      return 0;
    }

    const stub = await this.resolve(next.className, next.name);
    const handle = stub as unknown as {
      _cf_checkRunFibersForFacet(
        ownerPath: ReadonlyArray<AgentPathStep>
      ): Promise<number>;
    };
    return handle._cf_checkRunFibersForFacet(ownerPath);
  }

  /**
   * Invoke an RPC method on the host Agent or a descendant facet
   * identified by a root-first path. Used by AgentWorkflow to route
   * callbacks and `this.agent` calls back to the exact sub-agent that
   * started a workflow.
   */
  async invokeAgentPath(
    targetPath: ReadonlyArray<AgentPathStep>,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    await this.#host.__unsafe_ensureInitialized();

    const selfPath = this.#host.selfPath;
    if (!this.#host._isSameAgentPathPrefix(selfPath, targetPath)) {
      throw new Error(
        `Workflow origin path does not descend from ${JSON.stringify(selfPath)}.`
      );
    }

    if (selfPath.length === targetPath.length) {
      // Match real DO-stub RPC semantics: refuse JS-internal probes
      // (`constructor`, `toString`, symbol keys, thenable checks, …) and
      // anything inherited from `Object.prototype` so a facet-origin workflow
      // cannot reach a method surface a top-level workflow's stub would deny.
      // The framework's own `_workflow_*` / `_cf_*` RPC methods and any
      // user-defined Agent methods live on the subclass prototype, not
      // `Object.prototype`, so they remain callable.
      const target = this.#host as unknown as Record<string, unknown>;
      const fn = target[method];
      if (
        isInternalJsStubProp(method) ||
        method in Object.prototype ||
        typeof fn !== "function"
      ) {
        throw new Error(
          `Workflow origin method "${method}" is not callable on ${
            (this.#host as unknown as { constructor: { name: string } })
              .constructor.name
          }.`
        );
      }
      return await (fn as (...methodArgs: unknown[]) => unknown).apply(
        this.#host,
        args
      );
    }

    const next = targetPath[selfPath.length];
    if (!this.#host.hasSubAgent(next.className, next.name)) {
      throw new Error(
        `Workflow origin sub-agent ${next.className} "${next.name}" no longer exists.`
      );
    }

    const stub = await this.resolve(next.className, next.name);
    const handle = stub as unknown as {
      _cf_invokeAgentPath(
        path: ReadonlyArray<AgentPathStep>,
        method: string,
        args: unknown[]
      ): Promise<unknown>;
    };
    return await handle._cf_invokeAgentPath(targetPath, method, args);
  }

  /**
   * Recursively destroy a descendant facet identified by `targetPath`.
   * Walks down from `selfPath` until reaching the target's immediate
   * parent, where it cancels the target's parent-owned schedules (and
   * any descendants), removes the target from the registry, and calls
   * `ctx.facets.delete` to wipe the target's storage.
   */
  async destroyDescendant(
    targetPath: ReadonlyArray<AgentPathStep>
  ): Promise<void> {
    const selfPath = this.#host.selfPath;

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
    if (!this.#host._isSameAgentPathPrefix(selfPath, targetPath)) {
      throw new Error(
        "_cf_destroyDescendantFacet: target path does not descend from this agent."
      );
    }

    // The root owns every schedule row; cancel the target's prefix
    // upfront so we don't have to make an extra round trip back from
    // each intermediate hop.
    if (this.#host._parentPath.length === 0) {
      await this.#host._cf_cleanupFacetPrefix(targetPath);
    }

    if (selfPath.length === targetPath.length - 1) {
      // We are the immediate parent of the target — perform the local
      // facet teardown the same way `delete` does.
      const target = targetPath[targetPath.length - 1];
      const ctx = this.#host.ctx as unknown as Partial<FacetCapableCtx>;
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
      this.registry.forget(target.className, target.name);
      return;
    }

    // Recurse one step deeper.
    const next = targetPath[selfPath.length];
    if (!this.#host.hasSubAgent(next.className, next.name)) {
      // Already gone — schedules are cleared, nothing more to do.
      return;
    }
    const stub = await this.resolve(next.className, next.name);
    const handle = stub as unknown as {
      _cf_destroyDescendantFacet(
        targetPath: ReadonlyArray<AgentPathStep>
      ): Promise<void>;
    };
    await handle._cf_destroyDescendantFacet(targetPath);
  }

  /**
   * Shared facet resolution — takes a CamelCase class name string
   * (matching `ctx.exports`) rather than a class reference. Both
   * `subAgent(cls, name)` and `_cf_invokeSubAgent(className, ...)`
   * funnel through here so registry bookkeeping and the
   * `_cf_initAsFacet` handshake are consistent.
   */
  async resolve(className: string, name: string): Promise<unknown> {
    const ctx = this.#host.ctx as unknown as Partial<FacetCapableCtx>;
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
    const childParentPath = this.#host.selfPath;
    const childPath = [...childParentPath, { className, name }];

    // For nested facets, the immediate parent is itself facet-only
    // and is not expected to expose namespace helpers. Use the root
    // supervisor namespace instead; path-v2 identities are scoped to
    // the full logical path while legacy rows continue using bare names.
    const rootClassName =
      this.#host._parentPath[0]?.className ??
      (this.#host as unknown as { constructor: { name: string } }).constructor
        .name;
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
    const identity = await this.registry.identity(className, name, childPath);
    const facetId = rootNs.idFromName(identity.name);
    const stub = ctx.facets.get(facetKey, () => ({
      class: Cls as DurableObjectClass,
      id: facetId
    }));

    // Record before initialization so a successfully-initialized facet is
    // not left without identity metadata if the parent is interrupted after
    // the child RPC returns. Roll back only rows this call created.
    //
    // A facet may start a workflow from onStart(); workflow callbacks route
    // through the parent registry and must be able to find this in-flight
    // child, so recording before the init RPC is also what lets those
    // callbacks resolve.
    this.registry.record(className, name, identity);

    // Initialize the child as a facet via a single RPC that runs
    // inside the child's isolate. Avoids the cross-DO I/O error that
    // the previous `stub.fetch(req)` path triggered by handing a
    // parent-owned Request across the isolate boundary.
    //
    // The parent may be inside a WebSocket/message request context here.
    // Clear native context handles before the child facet RPC so workerd
    // never sees parent-owned I/O attached to child initialization.
    try {
      await this.#host._runFacetInitInvocation(async () => {
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
        this.registry.forget(className, name);
      }
      throw error;
    }

    return stub;
  }

  /**
   * Forcefully abort a running facet. Transitively aborts the child's
   * own children; storage is preserved.
   */
  abort(className: string, name: string, reason?: unknown): void {
    const ctx = this.#host.ctx as unknown as Partial<FacetCapableCtx>;
    if (!ctx.facets) {
      throw new Error(
        "abort() is not supported in this runtime — " +
          "`ctx.facets` is unavailable. " +
          "Update to the latest `compatibility_date` in your wrangler.jsonc."
      );
    }
    const facetKey = `${className}\0${name}`;
    ctx.facets.abort(facetKey, reason);
  }

  /**
   * Delete a facet: abort it if running, then permanently wipe its
   * storage. Transitively deletes the child's own children.
   */
  async delete(className: string, name: string): Promise<void> {
    const ctx = this.#host.ctx as unknown as Partial<FacetCapableCtx>;
    if (!ctx.facets) {
      throw new Error(
        "delete() is not supported in this runtime — " +
          "`ctx.facets` is unavailable. " +
          "Update to the latest `compatibility_date` in your wrangler.jsonc."
      );
    }
    const facetKey = `${className}\0${name}`;
    const childPath = [...this.#host.selfPath, { className, name }];
    if (this.#host._isFacet) {
      const root = await this.rootAlarmOwner();
      await root._cf_cleanupFacetPrefix(childPath);
    } else {
      await this.#host._cf_cleanupFacetPrefix(childPath);
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
    this.registry.forget(className, name);
  }

  // ── WebSocket forwarding + virtual connections ────────────────────────

  /** Drop all facet-side virtual connections (test/rehydration hook). */
  clearVirtualConnections(): void {
    this.#virtualConnections.clear();
  }

  /** Facet-side lookup of a virtual connection by id. */
  getVirtualConnection(id: string): Connection | undefined {
    const stored = this.#virtualConnections.get(id);
    if (!stored) return undefined;
    return this.createBridgeConnection(stored.meta);
  }

  /** Facet-side iteration over virtual connections, optionally by tag. */
  *getVirtualConnections(tag?: string): Iterable<Connection> {
    for (const stored of this.#virtualConnections.values()) {
      if (!tag || stored.meta.tags.includes(tag)) {
        yield this.createBridgeConnection(stored.meta);
      }
    }
  }

  activeBridge(
    connectionId?: string
  ): DynamicAgentConnectionBridgeLike | undefined {
    const context = this.#bridgeContext.getStore();
    if (connectionId !== undefined && context?.connectionId !== connectionId) {
      return undefined;
    }
    return context?.bridge;
  }

  /**
   * Route a virtual sub-agent connection operation through its live frame
   * bridge, or through the durable root Agent after that frame completes.
   * All operations share one per-connection queue. Facet broadcasts wait for
   * older queued operations; failures do not block later work.
   */
  routeConnectionOperation(
    connectionId: string,
    operationName: DynamicAgentConnectionOperationName,
    operation: (bridge: DynamicAgentConnectionBridgeLike) => unknown
  ): void {
    const activeBridge = this.activeBridge(connectionId);
    const previousConnectionOperation =
      this.#connectionOperationTails.get(connectionId);
    let pending: Promise<void>;
    if (activeBridge && !previousConnectionOperation) {
      try {
        pending = Promise.resolve(operation(activeBridge)).then(() => {});
      } catch (error) {
        pending = Promise.reject(error);
      }
    } else {
      pending = (previousConnectionOperation ?? Promise.resolve()).then(
        async () => {
          const root = await this.rootAlarmOwner();
          await operation(
            new RootDynamicAgentConnectionBridge(root, connectionId)
          );
        }
      );
    }
    const completion = pending.catch((error: unknown) => {
      this.#reportConnectionOperationFailure(
        connectionId,
        operationName,
        error
      );
    });

    this.#connectionOperationTails.set(connectionId, completion);
    this.#host.ctx.waitUntil(completion);
    void completion.then(() => {
      if (this.#connectionOperationTails.get(connectionId) === completion) {
        this.#connectionOperationTails.delete(connectionId);
      }
    });
  }

  /**
   * Route a facet broadcast after every older connection operation.
   *
   * This barrier is intentionally one-way: facet startup can broadcast before
   * a child connection has finished initializing its tags and protocol flags.
   * Making those later connection operations wait would let the next frame
   * observe stale root-owned metadata.
   */
  async routeBroadcast(
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[],
    upstreamBridge?: DynamicAgentConnectionBridgeLike
  ): Promise<void> {
    const activeBridge = upstreamBridge ?? this.activeBridge();
    const previousOperations = new Set([
      ...(this.#broadcastOperationTail ? [this.#broadcastOperationTail] : []),
      ...this.#connectionOperationTails.values()
    ]);
    let pending: Promise<void>;
    if (activeBridge && previousOperations.size === 0) {
      try {
        pending = Promise.resolve(
          activeBridge.broadcast(ownerPath, message, without)
        );
      } catch (error) {
        pending = Promise.reject(error);
      }
    } else {
      pending = Promise.all(previousOperations).then(async () => {
        const root = await this.rootAlarmOwner();
        await root._cf_broadcastToSubAgent(ownerPath, message, without);
      });
    }
    const completion = pending.catch((error: unknown) => {
      console.error("[Agent] Sub-agent broadcast operation failed:", {
        operation: "broadcast",
        error
      });
    });

    this.#broadcastOperationTail = completion;
    this.#host.ctx.waitUntil(completion);
    void completion.then(() => {
      if (this.#broadcastOperationTail === completion) {
        this.#broadcastOperationTail = undefined;
      }
    });
    await completion;
  }

  #reportConnectionOperationFailure(
    connectionId: string,
    operation: DynamicAgentConnectionOperationName,
    error: unknown
  ): void {
    console.error("[Agent] Sub-agent connection operation failed:", {
      connectionId,
      operation,
      error
    });
  }

  async broadcastToParent(
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): Promise<void> {
    await this.routeBroadcast(this.#host.selfPath, message, without);
  }

  async broadcastToPath(
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): Promise<void> {
    if (this.#host._isFacet) {
      await this.routeBroadcast(ownerPath, message, without);
      return;
    }

    for (const connection of this.#host._webSockets.getConnections()) {
      if (without?.includes(connection.id)) continue;
      const targetPath = this.connectionTargetPath(connection);
      if (!targetPath) continue;
      if (!this.isSameAgentPath(targetPath, ownerPath)) continue;
      connection.send(message);
    }
  }

  async connectionMetas(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<DynamicAgentConnectionMeta[]> {
    const metas: DynamicAgentConnectionMeta[] = [];
    for (const connection of this.#host._webSockets.getConnections()) {
      const meta = this.#connectionMetaForPath(connection, ownerPath);
      if (meta) metas.push(meta);
    }
    return metas;
  }

  async sendToConnection(
    connectionId: string,
    message: string | ArrayBuffer | ArrayBufferView
  ): Promise<void> {
    const connection = this.#host._webSockets.getConnection(connectionId);
    if (!connection || !this.connectionHasChildTarget(connection)) {
      return;
    }
    connection.send(message);
  }

  async closeConnection(
    connectionId: string,
    code?: number,
    reason?: string
  ): Promise<void> {
    const connection = this.#host._webSockets.getConnection(connectionId);
    if (!connection || !this.connectionHasChildTarget(connection)) {
      return;
    }
    connection.close(code, reason);
  }

  async setConnectionState(
    connectionId: string,
    state: unknown
  ): Promise<unknown> {
    const connection = this.#host._webSockets.getConnection(connectionId);
    if (!connection || !this.connectionHasChildTarget(connection)) {
      return null;
    }
    this.#host._ensureConnectionWrapped(connection);
    connection.setState(state);
    return this.getForwardedState(connection);
  }

  #connectionMetaForPath(
    connection: Connection,
    ownerPath: ReadonlyArray<AgentPathStep>
  ): DynamicAgentConnectionMeta | null {
    this.#host._ensureConnectionWrapped(connection);
    const outerUri = this.#host._unsafe_getConnectionFlag(
      connection,
      CF_SUB_AGENT_OUTER_URL_KEY
    );
    if (typeof outerUri !== "string") return null;

    const target = this.#pathFromOuterUri(outerUri, ownerPath);
    if (!target) return null;

    const raw = this.getRawConnectionState(connection);
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
      state: this.getForwardedState(connection)
    };
  }

  connectionTargetPath(
    connection: Connection
  ): ReadonlyArray<AgentPathStep> | null {
    this.#host._ensureConnectionWrapped(connection);
    const outerUri = this.#host._unsafe_getConnectionFlag(
      connection,
      CF_SUB_AGENT_OUTER_URL_KEY
    );
    if (typeof outerUri !== "string") return null;

    return this.#pathFromOuterUri(outerUri)?.path ?? null;
  }

  #pathFromOuterUri(
    outerUri: string,
    stopAt?: ReadonlyArray<AgentPathStep>
  ): { path: ReadonlyArray<AgentPathStep>; uri: string } | null {
    const ctx = this.#host.ctx as unknown as Partial<FacetCapableCtx>;
    const knownClasses = ctx.exports ? Object.keys(ctx.exports) : undefined;
    const path: AgentPathStep[] = [...this.#host.selfPath];
    let currentUrl = outerUri;

    while (true) {
      const match = parseSubAgentPath(currentUrl, { knownClasses });
      if (!match) break;
      path.push({ className: match.childClass, name: match.childName });
      const rewritten = new URL(currentUrl);
      rewritten.pathname = match.remainingPath;
      currentUrl = rewritten.toString();
      if (stopAt && this.isSameAgentPath(path, stopAt)) {
        return { path, uri: currentUrl };
      }
    }

    if (path.length === this.#host.selfPath.length) return null;
    if (stopAt) return null;
    return { path, uri: currentUrl };
  }

  isSameAgentPath(
    a: ReadonlyArray<AgentPathStep>,
    b: ReadonlyArray<AgentPathStep>
  ): boolean {
    if (a.length !== b.length) return false;
    return a.every(
      (step, index) =>
        step.className === b[index]?.className && step.name === b[index]?.name
    );
  }

  connectionHasChildTarget(connection: Connection): boolean {
    this.#host._ensureConnectionWrapped(connection);
    return (
      typeof this.#host._unsafe_getConnectionFlag(
        connection,
        CF_SUB_AGENT_OUTER_URL_KEY
      ) === "string"
    );
  }

  connectionTargetsChild(connection: Connection): boolean {
    if (!connection.uri) return false;
    const ctx = this.#host.ctx as unknown as Partial<FacetCapableCtx>;
    return (
      parseSubAgentPath(connection.uri, {
        knownClasses: ctx.exports ? Object.keys(ctx.exports) : undefined
      }) !== null
    );
  }

  requestTargetsChild(request: Request): boolean {
    const ctx = this.#host.ctx as unknown as Partial<FacetCapableCtx>;
    return (
      parseSubAgentPath(request.url, {
        knownClasses: ctx.exports ? Object.keys(ctx.exports) : undefined
      }) !== null
    );
  }

  async forwardWebSocketConnect(
    connection: Connection,
    request: Request,
    options: { gate: boolean }
  ): Promise<boolean> {
    const routed = await this.#resolveConnection(connection, request, options);
    if (!routed) return false;

    await routed.child._cf_handleSubAgentWebSocketConnect(
      this.#createConnectionBridge(connection),
      routed.meta
    );
    return true;
  }

  #createConnectionBridge(
    connection: Connection
  ): DynamicAgentConnectionBridge {
    // A child-to-parent RPC callback starts a fresh async context. Capture the
    // upstream bridge explicitly while this forwarding frame is still active.
    const upstreamBroadcastBridge = this.#host._isFacet
      ? this.activeBridge(connection.id)
      : undefined;

    return new DynamicAgentConnectionBridge(
      connection,
      (ownerPath, message, without) => {
        if (upstreamBroadcastBridge) {
          return this.routeBroadcast(
            ownerPath,
            message,
            without,
            upstreamBroadcastBridge
          );
        }
        // Dispatch through the host so subclass overrides of the
        // `_cf_broadcastToSubAgent` RPC entry point keep intercepting.
        return this.#host._cf_broadcastToSubAgent(ownerPath, message, without);
      }
    );
  }

  async forwardWebSocketMessage(
    connection: Connection,
    message: WSMessage,
    replyBridge?: DynamicAgentConnectionBridge
  ): Promise<boolean> {
    const routed = await this.#resolveConnection(connection);
    if (!routed) return false;

    const bridge = this.#createConnectionBridge(connection);
    await routed.child._cf_handleSubAgentWebSocketMessage(
      message,
      bridge,
      routed.meta,
      replyBridge ?? bridge
    );
    return true;
  }

  async forwardWebSocketClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<boolean> {
    const routed = await this.#resolveConnection(connection);
    if (!routed) return false;

    await routed.child._cf_handleSubAgentWebSocketClose(
      code,
      reason,
      wasClean,
      this.#createConnectionBridge(connection),
      routed.meta
    );
    return true;
  }

  async #resolveConnection(
    connection: Connection,
    request?: Request,
    options: { gate: boolean } = { gate: false }
  ): Promise<{
    child: DynamicAgentWebSocketEndpoint;
    meta: DynamicAgentConnectionMeta;
  } | null> {
    this.#host._ensureConnectionWrapped(connection);
    const outerUri = this.#host._unsafe_getConnectionFlag(
      connection,
      CF_SUB_AGENT_OUTER_URL_KEY
    );
    const uri = typeof outerUri === "string" ? outerUri : connection.uri;
    if (!uri) return null;

    const ctx = this.#host.ctx as unknown as Partial<FacetCapableCtx>;
    let match = parseSubAgentPath(uri, {
      knownClasses: ctx.exports ? Object.keys(ctx.exports) : undefined
    });
    if (!match) return null;
    if (
      this.#host._ParentClass.name === match.childClass &&
      this.#host.name === match.childName
    ) {
      const tailUri = new URL(uri);
      tailUri.pathname = match.remainingPath;
      match = parseSubAgentPath(tailUri.toString(), {
        knownClasses: ctx.exports ? Object.keys(ctx.exports) : undefined
      });
      if (!match) return null;
    }

    let forwardReq = request;
    if (request && options.gate) {
      const decision = await this.#host.onBeforeSubAgent(request, {
        className: match.childClass,
        name: match.childName
      });
      if (decision instanceof Response) {
        connection.close(1008, "Sub-agent connection rejected");
        return null;
      }
      forwardReq = decision instanceof Request ? decision : request;
    }

    const child = (await this.resolve(
      match.childClass,
      match.childName
    )) as DynamicAgentWebSocketEndpoint;

    const childUri = new URL(forwardReq?.url ?? uri);
    childUri.pathname = match.remainingPath;
    const raw = this.getRawConnectionState(connection);
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
        state: this.getForwardedState(connection),
        requestHeaders: forwardReq ? [...forwardReq.headers] : undefined
      }
    };
  }

  async handleWebSocketConnect(
    bridge: DynamicAgentConnectionBridge,
    meta: DynamicAgentConnectionMeta
  ): Promise<void> {
    await this.runWithBridge(bridge, meta.id, async () => {
      const connection = this.createBridgeConnection(meta);
      const request = new Request(meta.uri ?? "http://placeholder/", {
        headers: meta.requestHeaders
      });
      if (
        await this.forwardWebSocketConnect(connection, request, {
          gate: true
        })
      ) {
        return;
      }

      if (this.#host.shouldConnectionBeReadonly(connection, { request })) {
        this.#host.setConnectionReadonly(connection, true);
      }
      if (!this.#host.shouldSendProtocolMessages(connection, { request })) {
        this.#host._setConnectionNoProtocol(connection);
      }

      const childTags = await this.#host.getConnectionTags(connection, {
        request
      });
      (connection as unknown as { tags: string[] }).tags = [
        connection.id,
        ...childTags.filter((tag) => tag !== connection.id)
      ];
      this.storeVirtualConnection(connection);
      await this.#host.onConnect(connection, { request });
      this.storeVirtualConnection(connection);
    });
  }

  async handleWebSocketMessage(
    message: WSMessage,
    bridge: DynamicAgentConnectionBridge,
    meta: DynamicAgentConnectionMeta,
    replyBridge: DynamicAgentConnectionBridge = bridge
  ): Promise<void> {
    const connection = this.createBridgeConnection(meta);
    this.storeVirtualConnection(connection);
    const replyContext: DynamicAgentRpcReplyInvocationContext = {
      bridge: replyBridge
    };
    try {
      await dynamicAgentRpcReplyContext.run(replyContext, () =>
        this.runWithBridge(bridge, meta.id, () =>
          this.#host.onMessage(connection, message)
        )
      );
    } finally {
      replyContext.bridge = undefined;
    }
  }

  async handleWebSocketClose(
    code: number,
    reason: string,
    wasClean: boolean,
    bridge: DynamicAgentConnectionBridge,
    meta: DynamicAgentConnectionMeta
  ): Promise<void> {
    const connection = this.createBridgeConnection(meta);
    this.storeVirtualConnection(connection);
    await this.runWithBridge(bridge, meta.id, () =>
      this.#host.onClose(connection, code, reason, wasClean)
    );
    this.#virtualConnections.delete(meta.id);
  }

  async runWithBridge<T>(
    bridge: DynamicAgentConnectionBridgeLike,
    connectionId: string,
    fn: () => Promise<T> | T
  ): Promise<T> {
    const context: DynamicAgentBridgeInvocationContext = {
      bridge,
      connectionId
    };
    try {
      return await this.#bridgeContext.run(context, fn);
    } finally {
      // Detached work inherits this context, but a forwarded RPC bridge is only
      // valid until its originating connect, message, or close call completes.
      context.bridge = undefined;
    }
  }

  createBridgeConnection(meta: DynamicAgentConnectionMeta): Connection {
    let stored = this.#virtualConnections.get(meta.id);
    if (stored) {
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
      stored = { meta };
      this.#virtualConnections.set(meta.id, stored);
    }

    const owner = this;
    const getStored = () => this.#virtualConnections.get(meta.id) ?? stored;
    const updateStoredState = (nextState: unknown) => {
      const current = this.#virtualConnections.get(meta.id);
      if (current) {
        current.meta = { ...current.meta, state: nextState };
      }
    };

    const connection = {
      id: meta.id,
      uri: meta.uri,
      tags: meta.tags,
      get state() {
        return getStored().meta.state;
      },
      setState(next: unknown | ((prev: unknown) => unknown)) {
        const currentState = getStored().meta.state;
        const state = typeof next === "function" ? next(currentState) : next;
        updateStoredState(state);
        owner.routeConnectionOperation(meta.id, "setState", (bridge) =>
          bridge.setState(state)
        );
        return state;
      },
      send(message: string | ArrayBuffer | ArrayBufferView) {
        owner.routeConnectionOperation(meta.id, "send", (bridge) =>
          bridge.send(message)
        );
      },
      close(code?: number, reason?: string) {
        owner.routeConnectionOperation(meta.id, "close", (bridge) =>
          bridge.close(code, reason)
        );
      },
      addEventListener() {},
      removeEventListener() {}
    } as unknown as Connection;

    stored.connection = connection;
    this.#host._ensureConnectionWrapped(connection);
    return connection;
  }

  storeVirtualConnection(connection: Connection): void {
    this.#host._unsafe_setConnectionFlag(connection, CF_SUB_AGENT_TAGS_KEY, [
      ...connection.tags
    ]);
    const stored = this.#virtualConnections.get(connection.id);
    this.#virtualConnections.set(connection.id, {
      meta: {
        id: connection.id,
        uri: connection.uri,
        tags: [...connection.tags],
        state: this.getRawConnectionState(connection)
      },
      connection: stored?.connection ?? connection
    });
  }

  /**
   * Restore the facet identity persisted by `init` (wake after
   * hibernation), then best-effort hydrate the virtual connections
   * from the root's WebSocket state.
   */
  async restoreFacetContext(): Promise<void> {
    const isFacet =
      await this.#host.ctx.storage.get<boolean>("cf_agents_is_facet");
    if (isFacet) this.#host._isFacet = true;

    const storedFacetName = await this.#host.ctx.storage.get<string>(
      "cf_agents_facet_name"
    );
    if (typeof storedFacetName === "string") {
      this.#host._facetName = storedFacetName;
    }

    const storedParentPath = await this.#host.ctx.storage.get<
      Array<{ className: string; name: string }>
    >("cf_agents_parent_path");
    if (isValidParentPath(storedParentPath)) {
      this.#host._parentPath = storedParentPath;
    }

    try {
      await this.hydrateConnectionsFromRoot();
    } catch (error) {
      console.warn(
        "[Agent] Unable to hydrate sub-agent WebSocket connections:",
        error
      );
    }
  }

  async hydrateConnectionsFromRoot(): Promise<void> {
    if (!this.#host._isFacet || this.#host._parentPath.length === 0) return;

    if (this.rootResolvesToSelf()) {
      // The root stub would resolve back to this blocked Durable Object
      // during startup. The facet view cannot see root-owned hibernated
      // sockets locally, so preserve liveness and skip best-effort hydration.
      return;
    }

    const root = await this.rootAlarmOwner();
    const metas = await root._cf_subAgentConnectionMetas(this.#host.selfPath);
    for (const meta of metas) {
      this.#virtualConnections.set(meta.id, { meta });
    }
  }

  getRawConnectionState(connection: Connection): unknown {
    this.#host._ensureConnectionWrapped(connection);
    return this.#host._rawStateAccessors.get(connection)?.getRaw() ?? null;
  }

  getForwardedState(connection: Connection): unknown {
    const raw = this.getRawConnectionState(connection);
    if (raw == null || typeof raw !== "object") return raw;
    const { [CF_SUB_AGENT_OUTER_URL_KEY]: _, ...rest } = raw as Record<
      string,
      unknown
    >;
    return Object.keys(rest).length > 0 ? rest : null;
  }

  /**
   * Resolve the facet Fetcher for the match and forward the request to
   * it with `/sub/{class}/{name}` stripped.
   */
  async forward(
    req: Request,
    match: {
      childClass: string;
      childName: string;
      remainingPath: string;
    }
  ): Promise<Response> {
    let fetcher: { fetch(r: Request): Promise<Response> };
    try {
      fetcher = (await this.resolve(match.childClass, match.childName)) as {
        fetch(r: Request): Promise<Response>;
      };
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
    // Hand the body through as a stream. Reading it here (e.g.
    // `await req.arrayBuffer()`) materialises the entire body in the
    // parent DO's isolate, ahead of any application-level intake limit,
    // and re-materialises it once per `/sub/` hop — see #2015.
    if (req.body && req.method !== "GET" && req.method !== "HEAD") {
      forwardedInit.body = req.body;
    }
    const forwarded = new Request(rewritten, forwardedInit);
    return fetcher.fetch(forwarded);
  }

  /**
   * Bridge used by `getSubAgentByName`: resolve the facet and dispatch
   * one RPC method. Stateless — no cached references.
   */
  async invoke(
    className: string,
    name: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const stub = await this.resolve(className, name);
    return await this.invokeStubMethod(stub, className, method, args);
  }

  /**
   * Bridge used by `parentAgent()` when the requested parent is itself
   * a facet (and therefore has no top-level env namespace). The root
   * receives the full root-first target path, then each hop delegates
   * to the next facet using that facet's own `ctx.facets`.
   */
  async invokePath(
    path: ReadonlyArray<{ className: string; name: string }>,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const [self, next, ...rest] = path;
    if (!self) {
      throw new Error(`Sub-agent path invocation requires a non-empty path.`);
    }

    const ownClassName = (
      this.#host as unknown as { constructor: { name: string } }
    ).constructor.name;
    if (self.className !== ownClassName || self.name !== this.#host.name) {
      throw new Error(
        `Sub-agent path invocation reached ${ownClassName}("${this.#host.name}") ` +
          `but expected ${self.className}("${self.name}").`
      );
    }

    if (!next) {
      return await this.invokeStubMethod(
        this.#host,
        ownClassName,
        method,
        args
      );
    }

    const child = await this.resolve(next.className, next.name);
    if (rest.length === 0) {
      return await this.invokeStubMethod(child, next.className, method, args);
    }

    const bridge = child as DynamicAgentPathInvokeEndpoint;
    return await bridge._cf_invokeSubAgentPath([next, ...rest], method, args);
  }

  async invokeStubMethod(
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

  /**
   * Initialize the host agent as a facet in a single RPC. Runs entirely
   * inside the child's isolate, so every storage write and `onStart()`
   * I/O is owned by the child DO.
   */
  async init(
    name: string,
    parentPath: ReadonlyArray<{ className: string; name: string }> = [],
    identityName = name
  ): Promise<void> {
    const routedName = this.#host.lifecycle.name;
    if (routedName !== identityName) {
      throw new Error(
        `Facet bootstrap mismatch: expected routed identity "${identityName}" but got "${routedName}". ` +
          `This usually means the parent passed the wrong id to ctx.facets.get(). ` +
          `See _cf_resolveSubAgent.`
      );
    }

    this.#host._isFacet = true;
    this.#host._facetName = name;
    this.#host._parentPath = parentPath as AgentPathStep[];
    // Persist the agent-specific facet keys in parallel.
    await Promise.all([
      this.#host.ctx.storage.put("cf_agents_is_facet", true),
      this.#host.ctx.storage.put("cf_agents_facet_name", name),
      this.#host.ctx.storage.put("cf_agents_parent_path", parentPath)
    ]);
    // Fire onStart() now since native RPC bypasses lifecycle fetch, which is the
    // entry point that normally triggers it. Protocol broadcasts during this
    // bootstrap window are safe: on a facet `getConnections()` returns only
    // virtual sub-agent connections and `broadcast()` routes to the parent
    // bridge, so neither touches the parent's own WebSocket handles (#1679).
    await this.#host.__unsafe_ensureInitialized();
  }

  /** Remove a completed facet fiber from the root-side index. */
  async unregisterRun(
    ownerPath: ReadonlyArray<AgentPathStep>,
    runId: string
  ): Promise<void> {
    const ownerPathKey = agentPathKey(ownerPath);
    this.#host.sql`
      DELETE FROM cf_agents_facet_runs
      WHERE owner_path_key IS ${ownerPathKey}
        AND run_id = ${runId}
    `;
    await this.#host._syncHostJobs();
  }
}
