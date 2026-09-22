/**
 * Transport-neutral lifecycle contracts for StateMachine-backed agent harnesses.
 *
 * @experimental The whole surface may change before stabilizing.
 */
export { StateMachineHarness } from "./state-machine-harness";
export type { StateMachineHarnessOptions } from "./state-machine-harness";
export type {
  AgentHarness,
  HarnessReceipt,
  HarnessSendOptions,
  HarnessStreams,
  HarnessSubmitOptions
} from "./types";
