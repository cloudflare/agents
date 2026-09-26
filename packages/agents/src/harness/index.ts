/**
 * Transport-neutral lifecycle contracts for StateMachine-backed agent harnesses.
 *
 * @experimental The whole surface may change before stabilizing.
 */
export { StateMachineHarness } from "./state-machine-harness";
export { createHarnessEffectRuntime } from "./runtime";
export type {
  HarnessRuntime,
  HarnessRuntimeInspection,
  HarnessRuntimeInvocation
} from "./runtime";
export type { StateMachineHarnessOptions } from "./state-machine-harness";
export type {
  AgentHarness,
  HarnessNotifyOptions,
  HarnessReceipt,
  HarnessStartOptions,
  HarnessStreams
} from "./types";
