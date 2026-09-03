import type { Agent } from "../index";
import { applyRpcOptions, type AgentRpcOptions } from "../agent-stub";
import type { DynamicAgentsInternal } from "./dynamic-agents";
import type { DynamicAgentClass, DynamicAgentStub } from "./types";

/**
 * The public dynamic-agents capability surface, reached via
 * `this.dynamicAgents` on an Agent.
 *
 * A dynamic agent is a facet-backed child: it runs in its own isolate
 * with its own SQLite database, colocated with — and supervised by —
 * its parent Agent. Use dynamic agents for code whose class or
 * lifecycle the parent owns (dynamically-loaded/generated code,
 * per-run tool agents, sandboxed components). For independent peers
 * such as one-DO-per-chat, use `getAgentByName` instead.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class DynamicAgents {
  #internal: DynamicAgentsInternal;

  /** @internal Constructed by Agent; do not instantiate directly. */
  constructor(internal: DynamicAgentsInternal) {
    this.#internal = internal;
  }

  /**
   * Get (creating or waking if needed) the dynamic agent of the given
   * class and name, as a typed RPC stub. Idempotent — repeated calls
   * with the same class and name return the same child.
   *
   * @experimental
   */
  async get<T extends Agent>(
    cls: DynamicAgentClass<T>,
    name: string,
    options?: AgentRpcOptions
  ): Promise<DynamicAgentStub<T>> {
    const stub = (await this.#internal.resolve(
      cls.name,
      name
    )) as DurableObjectStub<T>;
    // Facet stubs are ordinary Fetchers on the same JS RPC path as namespace
    // stubs, so `rpc: "contextual"` gives the child `getCurrentAgent().caller`
    // the same way.
    return applyRpcOptions(stub, name, options) as DynamicAgentStub<T>;
  }

  /**
   * Forcefully abort a running dynamic agent. The child stops
   * executing immediately and restarts on the next {@link get} call;
   * its storage is preserved. Transitively aborts the child's own
   * children. Pending RPC calls receive the reason as an error.
   *
   * @experimental
   */
  abort(cls: DynamicAgentClass, name: string, reason?: unknown): void {
    this.#internal.abort(cls.name, name, reason);
  }

  /**
   * Delete a dynamic agent: abort it if running, then permanently wipe
   * its storage. Transitively deletes the child's own children.
   *
   * @experimental
   */
  delete(cls: DynamicAgentClass, name: string): Promise<void> {
    return this.#internal.delete(cls.name, name);
  }

  /**
   * Whether this agent has previously spawned (and not deleted) a
   * dynamic agent of the given class and name. Backed by an
   * auto-maintained SQLite registry in the parent's storage.
   *
   * @experimental
   */
  has<T extends Agent>(cls: DynamicAgentClass<T>, name: string): boolean;
  has(className: string, name: string): boolean;
  has(classOrName: DynamicAgentClass | string, name: string): boolean {
    const className =
      typeof classOrName === "string" ? classOrName : classOrName.name;
    return this.#internal.registry.has(className, name);
  }

  /**
   * List known dynamic agents, optionally filtered by class. Reflects
   * the registry rows written by {@link get} and removed by
   * {@link delete}.
   *
   * @experimental
   */
  list<T extends Agent>(
    cls: DynamicAgentClass<T>
  ): Array<{ className: string; name: string; createdAt: number }>;
  list(
    className?: string
  ): Array<{ className: string; name: string; createdAt: number }>;
  list(
    classOrName?: DynamicAgentClass | string
  ): Array<{ className: string; name: string; createdAt: number }> {
    const className =
      typeof classOrName === "string" ? classOrName : classOrName?.name;
    return this.#internal.registry.list(className);
  }
}
