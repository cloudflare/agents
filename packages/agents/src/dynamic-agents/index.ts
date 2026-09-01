/**
 * Dynamic agents — facet-backed child agents, colocated with and
 * supervised by their parent Agent. Reached at runtime via
 * `this.dynamicAgents` on an Agent.
 *
 * Everything exported from this barrel is **@experimental** and may
 * change without a major version bump.
 */

export { DynamicAgents } from "./api";
export type { DynamicAgentClass, DynamicAgentStub } from "./types";
