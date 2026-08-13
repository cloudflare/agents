/**
 * Minimal implementation of the composable-rebuild contracts: the Engine over
 * a SqlDatabase seam, the runtime host, the default step harness and loop,
 * and reference module implementations. See README.md.
 */

export type * from "./contract";

export { createEngine } from "./engine/engine";
export { since, between, latest, window } from "./engine/query";
export { ensureSchema } from "./engine/schema";
export { createToolRuntime, TOOLS_RECONCILER } from "./tools/runtime";
export type {
  ApprovalRequestedPayload,
  ApprovalVerdictPayload,
  ToolSettlementPayload
} from "./tools/runtime";
export { stepHarness } from "./harness/step-harness";
export { defaultLoop } from "./harness/default-loop";
export { windowAssembler } from "./context/window-assembler";
export { defaultAdmission } from "./admission/default";
export { localChannel } from "./channels/local";
export type { LocalChannel } from "./channels/local";
export { MockLanguageModel, mockText, mockToolCall, mockOutput } from "./models/mock";
export { WorkersAiLanguageModel } from "./models/workers-ai";
export type { AiBinding } from "./models/workers-ai";
export { startAgent } from "./runtime/host";
export type { Agent, StartAgentOptions } from "./runtime/host";
export { systemClock } from "./substrate";
export type { Clock, SqlDatabase, SqlRow } from "./substrate";
export * from "./ids";
