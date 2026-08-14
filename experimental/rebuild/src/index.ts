/**
 * Minimal implementation of the composable-rebuild contracts: the Engine over
 * a SqlDatabase seam, the runtime host, the default step harness and loop,
 * and reference module implementations. See README.md.
 */

export type * from "./contract.js";

export { createEngine } from "./engine/engine.js";
export { since, between, latest, window } from "./engine/query.js";
export { ensureSchema } from "./engine/schema.js";
export { createToolRuntime, TOOLS_RECONCILER } from "./tools/runtime.js";
export type {
  ApprovalRequestedPayload,
  ApprovalVerdictPayload,
  ToolSettlementPayload
} from "./tools/runtime.js";
export { stepHarness } from "./harness/step-harness.js";
export { defaultLoop } from "./harness/default-loop.js";
export { windowAssembler } from "./context/window-assembler.js";
export { defaultAdmission } from "./admission/default.js";
export { localChannel } from "./channels/local.js";
export type { LocalChannel } from "./channels/local.js";
export {
  MockLanguageModel,
  mockText,
  mockToolCall,
  mockOutput
} from "./models/mock.js";
export { WorkersAiLanguageModel } from "./models/workers-ai.js";
export type { AiBinding } from "./models/workers-ai.js";
export { startAgent } from "./runtime/host.js";
export type { Agent, StartAgentOptions } from "./runtime/host.js";
export { systemClock } from "./substrate.js";
export type { Clock, SqlDatabase, SqlRow } from "./substrate.js";
export * from "./ids.js";
