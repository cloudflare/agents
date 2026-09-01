import type { LifecycleRouteEnvelope } from "../lifecycle/durable-object-lifecycle";
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
  };
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
  readonly _isFacet: boolean;
  readonly _parentPath: AgentPathStep[];
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
}
