import { nanoid } from "nanoid";
import type { LifecycleRouteEnvelope } from "../lifecycle/durable-object-lifecycle";
import type { LifecycleRouteAddress } from "../lifecycle/capability";
import { SUB_PREFIX, type AgentPathStep } from "../sub-routing";
import { getAgentByName } from "../agent-routing";
import { camelCaseToKebabCase, isInternalJsStubProp } from "../utils";
import type { Agent } from "../index";
import { agentPathKey } from "./identity";
import { DynamicAgentRegistry } from "./registry";
import type { DynamicAgentHostPort } from "./host";
import type {
  FacetCapableCtx,
  FacetRunStorageRow,
  RootFacetRpcSurface
} from "./types";

/**
 * The facet-backed dynamic-agent machinery, extracted from the Agent
 * class. One instance per Agent; the host port documents exactly which
 * Agent internals it touches.
 *
 * Nothing here renames any wire- or storage-visible identifier: the
 * `cf_agents_facet_runs` table, `_cf_*` RPC method names, and route
 * key formats are frozen.
 *
 * @internal
 */
export class DynamicAgents {
  #host: DynamicAgentHostPort;

  /** The parent-side registry of spawned dynamic agents. */
  readonly registry: DynamicAgentRegistry;

  /**
   * Root-owned keepAlive tokens held on behalf of descendant facets.
   * Facets cannot arm a physical alarm, so their keepAlive refs ride
   * on the root's heartbeat.
   */
  #facetKeepAliveTokens = new Set<string>();

  constructor(host: DynamicAgentHostPort) {
    this.#host = host;
    this.registry = new DynamicAgentRegistry({
      sql: host.sql.bind(host),
      execRawSql: (sql) => void host.ctx.storage.sql.exec(sql)
    });
  }

  facetRunRowsForPrefix(
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

  deleteFacetRunRowsForPrefix(ownerPath: ReadonlyArray<AgentPathStep>): void {
    for (const row of this.facetRunRowsForPrefix(ownerPath)) {
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
   * schedules under the owner-path prefix and delete root-side facet
   * fiber recovery leases for the same sub-tree.
   */
  async cleanupFacetPrefix(
    ownerPath: ReadonlyArray<AgentPathStep>
  ): Promise<void> {
    const prefix = agentPathKey(ownerPath);
    if (prefix) {
      await this.#host.scheduler.__DO_NOT_USE_WILL_BREAK__cleanupRoutePrefix(
        prefix
      );
    }
    this.deleteFacetRunRowsForPrefix(ownerPath);
    await this.#host._syncHostJobs();
  }

  /**
   * Acquire a root-owned keepAlive ref on behalf of a descendant facet.
   */
  async acquireFacetKeepAlive(
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
  async releaseFacetKeepAlive(token: string): Promise<void> {
    if (!this.#facetKeepAliveTokens.delete(token)) return;
    this.#host._keepAliveRefs = Math.max(0, this.#host._keepAliveRefs - 1);
    await this.#host._syncHostJobs();
  }

  /**
   * Register a facet's durable run row in the root-side index so root
   * alarm housekeeping can dispatch recovery checks into idle facets.
   */
  async registerFacetRun(
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
  async checkFacetRunFibers(): Promise<void> {
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
        const remaining = await this.checkRunFibersForFacet(ownerPath);
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
  async checkRunFibersForFacet(
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

    const stub = await this.resolveSubAgent(next.className, next.name);
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

    const stub = await this.resolveSubAgent(next.className, next.name);
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
  async destroyDescendantFacet(
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
      // facet teardown the same way `deleteSubAgent` does.
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
    const stub = await this.resolveSubAgent(next.className, next.name);
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
  async resolveSubAgent(className: string, name: string): Promise<unknown> {
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
  abortSubAgent(className: string, name: string, reason?: unknown): void {
    const ctx = this.#host.ctx as unknown as Partial<FacetCapableCtx>;
    if (!ctx.facets) {
      throw new Error(
        "abortSubAgent() is not supported in this runtime — " +
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
  async deleteSubAgent(className: string, name: string): Promise<void> {
    const ctx = this.#host.ctx as unknown as Partial<FacetCapableCtx>;
    if (!ctx.facets) {
      throw new Error(
        "deleteSubAgent() is not supported in this runtime — " +
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

  /** Remove a completed facet fiber from the root-side index. */
  async unregisterFacetRun(
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
