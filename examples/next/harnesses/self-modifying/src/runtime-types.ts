import type { JsonObject, JsonValue } from "./json";

/** One durable conversation message supplied to the editable harness. */
export type HarnessMessage = {
  readonly role: "user" | "assistant";
  readonly content: string;
};

/** Model-visible tool definition selected by the editable harness. */
export type HarnessToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
};

/** One tool request returned by the host model adapter. */
export type HarnessToolCall = {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
};

/** Model input selected by editable code before trusted tools are added. */
export type HarnessInferenceRequest = {
  readonly round: number;
  readonly system: string;
  readonly messages: readonly HarnessMessage[];
  readonly customTools: readonly HarnessToolDefinition[];
};

/** Complete input passed from the trusted host to its model adapter. */
export type HarnessModelRequest = {
  readonly round: number;
  readonly system: string;
  readonly messages: readonly HarnessMessage[];
  readonly tools: readonly HarnessToolDefinition[];
};

/** Model output returned to the editable harness. */
export type HarnessInferenceResult = {
  readonly text: string;
  readonly finishReason: string;
  readonly toolCalls: readonly HarnessToolCall[];
};

/** Invocation pinned to one activated source revision. */
export type HarnessTurnInput = {
  readonly turnId: string;
  readonly prompt: string;
  readonly revisionId: number;
  readonly history: readonly HarnessMessage[];
};

/** Terminal value returned by the editable harness. */
export type HarnessTurnResult = {
  readonly output: string;
  readonly rounds: number;
  readonly isolateRun: number;
  readonly metadata?: JsonObject;
};

/** Narrow authority passed from the Durable Object into one turn isolate. */
export interface HarnessHost {
  infer(request: HarnessInferenceRequest): Promise<HarnessInferenceResult>;
  callTool(callId: string, name: string, input: JsonValue): Promise<JsonValue>;
  note(key: string, text: string): Promise<void>;
}

/** Contract the editable `/harness/src/index.ts` default export implements. */
export interface EditableHarness {
  readonly manifest: {
    readonly name: string;
    readonly version: string;
  };
  runTurn(
    input: HarnessTurnInput,
    host: HarnessHost
  ): Promise<HarnessTurnResult>;
}
