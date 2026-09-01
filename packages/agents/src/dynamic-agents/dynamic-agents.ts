import { nanoid } from "nanoid";
import type { LifecycleRouteEnvelope } from "../lifecycle/durable-object-lifecycle";
import type { LifecycleRouteAddress } from "../lifecycle/capability";
import type { AgentPathStep } from "../sub-routing";
import { getAgentByName } from "../agent-routing";
import type { Agent } from "../index";
import { agentPathKey } from "./identity";
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

  /**
   * Root-owned keepAlive tokens held on behalf of descendant facets.
   * Facets cannot arm a physical alarm, so their keepAlive refs ride
   * on the root's heartbeat.
   */
  #facetKeepAliveTokens = new Set<string>();

  constructor(host: DynamicAgentHostPort) {
    this.#host = host;
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
