/**
 * Dynamic agents: child Durable Objects spawned, supervised, and addressed
 * by a parent Lifecycle Object.
 *
 * @experimental Every export here may change before stabilizing.
 */
export { DynamicAgents } from "./dynamic-agents";
export type {
  DynamicAgentClass,
  DynamicAgentConnectionMeta,
  DynamicAgentHost,
  DynamicAgentRef,
  DynamicAgentsOptions,
  DynamicAgentStub
} from "./types";
export {
  SUB_PREFIX,
  parseSubAgentPath,
  type AgentPathStep,
  type SubAgentPathMatch
} from "../sub-routing";
