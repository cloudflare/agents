/**
 * The AI SDK `streamText` call of a Think turn, built from what the turn has
 * already assembled (model, prompt, messages, tools, the merged `TurnConfig`)
 * and the agent's per-step hooks.
 *
 * Nothing here is durable. A built invocation runs once; its stream result
 * keeps a finalizer that drains an abandoned stream so its trace span ends.
 */

import * as aiSdk from "ai";
import type {
  LanguageModel,
  ModelMessage,
  PrepareStepFunction,
  PrepareStepResult,
  TextStreamPart,
  ToolSet,
  TypedToolCall
} from "ai";
import {
  hasToolCall,
  jsonSchema,
  // `stepCountIs` exists in both AI SDK v6 and v7 (v7 keeps it as an alias of
  // `isStepCount`). Using it keeps Think compatible with both majors.
  stepCountIs,
  streamText,
  tool
} from "ai";
import { wrapAISDK } from "agents/observability/ai";
import type {
  ChunkContext,
  PrepareStepContext,
  StepConfig,
  StepContext,
  StreamableResult,
  ThinkModel,
  ThinkWorkflowPromptContext,
  ToolCallResultContext,
  TurnConfig
} from "../turn-types";
import {
  THINK_FINAL_ANSWER_TOOL_NAME,
  thinkFinalAnswerInstruction
} from "./structured-output";
import {
  turnTelemetryV6,
  turnTelemetryV7,
  type TelemetryIdentity
} from "./telemetry";

/**
 * Callback type for the AI SDK tool-execution-finished hook, derived from
 * `streamText`'s options so it resolves under both AI SDK v6 and v7 (the
 * exported `OnToolExecutionEndCallback` type is v7-only).
 */
type ToolCallFinishCallback = NonNullable<
  Parameters<typeof streamText>[0]["experimental_onToolCallFinish"]
>;

const agentsAISDKInvocationBounded = Symbol.for(
  "cloudflare.agents.ai-sdk.invocation-bounded"
);
const usesAISDKV7Telemetry = "registerTelemetry" in aiSdk;

/** The text a stream error reaches the client as. */
export function streamErrorToString(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Normalizes the AI SDK tool-execution-finished event across major versions.
 *
 * Think registers a single `experimental_onToolCallFinish` callback, which is
 * the native option in AI SDK v6 and a supported alias for `onToolExecutionEnd`
 * in AI SDK v7 (resolved internally — see `ai`'s `streamText`). The two majors
 * hand the callback different event shapes:
 *
 * - v6: `{ toolCall, messages, success, output, error, durationMs, stepNumber }`
 * - v7: `{ toolCall, messages, toolExecutionMs, toolOutput: { type, output|error } }`
 *   (no `stepNumber`)
 *
 * This collapses both into one shape so the rest of Think stays version-agnostic.
 */
function normalizeToolFinishEvent(event: unknown): {
  toolCall: TypedToolCall<ToolSet>;
  messages: ModelMessage[];
  toolExecutionMs: number;
  stepNumber: number | undefined;
  success: boolean;
  output: unknown;
  error: unknown;
} {
  const e = event as {
    toolCall: TypedToolCall<ToolSet>;
    messages: ModelMessage[];
    // v7
    toolExecutionMs?: number;
    toolOutput?: { type: string; output?: unknown; error?: unknown };
    // v6
    durationMs?: number;
    success?: boolean;
    output?: unknown;
    error?: unknown;
    stepNumber?: number;
  };
  const toolExecutionMs = e.toolExecutionMs ?? e.durationMs ?? 0;
  if (e.toolOutput) {
    const success = e.toolOutput.type === "tool-result";
    return {
      toolCall: e.toolCall,
      messages: e.messages,
      toolExecutionMs,
      // v7 does not provide a step number on this event.
      stepNumber: undefined,
      success,
      output: success ? e.toolOutput.output : undefined,
      error: success ? undefined : e.toolOutput.error
    };
  }
  const success = e.success ?? false;
  return {
    toolCall: e.toolCall,
    messages: e.messages,
    toolExecutionMs,
    stepNumber: e.stepNumber,
    success,
    output: success ? e.output : undefined,
    error: success ? undefined : e.error
  };
}

async function* readableStreamToAsyncIterable<T>(
  stream: ReadableStream<T>
): AsyncIterable<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

// Drains the underlying model stream when a drain loop exits early (in-stream
// error break, stall abort, user abort). The AI SDK tees its base stream, so
// an abandoned tee branch would otherwise leave the tracing wrapper's
// operation span open forever. One registration is associated with both the
// stable pre-transform result and any wrapper returned by the test seam.
type InferenceStreamFinalizer = {
  started: boolean;
  run: () => Promise<void>;
};
const inferenceStreamFinalizers = new WeakMap<
  object,
  InferenceStreamFinalizer
>();

/**
 * Finalizes the traced inference stream after a drain loop exits: drains the
 * abandoned tee branch so the operation span closes even on early exits.
 * Idempotent (the finalizer is removed before it runs); the drain is handed
 * to `waitUntil` so it survives turn completion without blocking it.
 */
export function drainInferenceStream(
  result: object,
  waitUntil: (promise: Promise<void>) => void
): void {
  const finalizer = inferenceStreamFinalizers.get(result);
  inferenceStreamFinalizers.delete(result);
  if (!finalizer || finalizer.started) {
    return;
  }

  finalizer.started = true;
  // Invoke exactly once: start the drain, then try to extend its lifetime.
  // A missing/throwing waitUntil must not start a second tee consumer.
  const completion = finalizer.run();
  try {
    waitUntil(completion);
  } catch {
    // waitUntil unavailable (tests, exotic contexts): the drain is already
    // running; nothing further to attach it to.
  }
}

/** The agent hooks an invocation calls while the model runs. */
export interface InferenceHooks {
  /**
   * Proactive context guard, run before `beforeStep`. Returns recompacted
   * messages for the upcoming step, or `undefined` to leave them.
   */
  compactBeforeStep(
    event: PrepareStepContext
  ): Promise<ModelMessage[] | undefined>;
  beforeStep(
    event: PrepareStepContext
  ): StepConfig | void | Promise<StepConfig | void>;
  onChunk(event: ChunkContext): Promise<void>;
  onStepEnd(event: StepContext): Promise<void>;
  /**
   * A tool call finished. `ctx` is what `afterToolCall` receives; `event` is
   * the normalized outcome for extension observers.
   */
  afterToolCall(
    ctx: ToolCallResultContext,
    event: {
      toolCall: TypedToolCall<ToolSet>;
      stepNumber: number | undefined;
      durationMs: number;
      success: boolean;
      output?: unknown;
      error?: unknown;
    }
  ): Promise<void>;
  /** Request id of the running turn, if any. */
  requestId(): string | undefined;
  resolveModel(model: ThinkModel): LanguageModel;
  /** Test seam: wrap the stream result. */
  transformResult(result: StreamableResult): StreamableResult;
}

/** Everything a turn decided before calling the model. */
export interface InferenceInvocationInput {
  /** The merged config from `beforeTurn` and extensions. */
  readonly config: TurnConfig;
  readonly model: LanguageModel;
  readonly system: string;
  readonly messages: ModelMessage[];
  /** The turn's tools, already wrapped for `beforeToolCall`. */
  readonly tools: ToolSet;
  readonly maxSteps: number;
  readonly sendReasoning: boolean;
  readonly continuation: boolean;
  readonly messageMetadata?: TurnConfig["messageMetadata"];
  readonly workflowPrompt?: ThinkWorkflowPromptContext;
  readonly signal?: AbortSignal;
  readonly telemetry: TelemetryIdentity;
  /** Whether the turn runs for a socket chat request. */
  readonly invocationBounded: boolean;
  readonly storeMessages: boolean;
  readonly storeTools: boolean;
  readonly hooks: InferenceHooks;
}

/**
 * Build the turn's `streamText` call. The returned function starts the
 * model stream; call it once.
 */
export function createInferenceInvocation(
  input: InferenceInvocationInput
): () => StreamableResult {
  const { config, hooks } = input;
  // Workflow `step.prompt` turns produce their structured result by calling
  // the synthetic `final_answer` tool (see THINK_FINAL_ANSWER_TOOL_NAME) —
  // NOT via the AI SDK `output`/`response_format` path, which some providers
  // reject when streaming. We pre-build the JSON Schema once here.
  const structuredOutputSchema = input.workflowPrompt?.output
    ? jsonSchema(input.workflowPrompt.output.schema as never)
    : undefined;
  const wantsStructuredOutput = structuredOutputSchema !== undefined;

  const finalTools: ToolSet = input.tools;
  // For a structured workflow turn, expose a final-answer tool alongside the
  // agent's real tools. The agent loops with its tools and terminates by
  // calling this one; its arguments are captured as the structured result.
  // Guard against a clash with a user tool of the same name by suffixing.
  let finalAnswerToolName = THINK_FINAL_ANSWER_TOOL_NAME;
  if (structuredOutputSchema) {
    let suffix = 1;
    while (finalAnswerToolName in finalTools) {
      finalAnswerToolName = `${THINK_FINAL_ANSWER_TOOL_NAME}_${suffix++}`;
    }
    finalTools[finalAnswerToolName] = tool({
      description:
        "Provide your final answer. The arguments MUST match the required " +
        "schema. Calling this tool ends the task — call it exactly once when " +
        "you have everything you need.",
      inputSchema: structuredOutputSchema,
      execute: async () => "Final answer recorded."
    });
  }

  const finalMaxSteps = input.maxSteps;
  const metadataWriter = input.messageMetadata;
  const continuation = input.continuation;
  const finalMessageMetadata =
    metadataWriter &&
    ((options: { part: TextStreamPart<ToolSet> }) =>
      metadataWriter({ ...options, continuation }));
  // `output` (AI SDK structured-output / `response_format`) is reserved for
  // the opt-in chat `TurnConfig.output` API. Workflow prompts use the
  // `final_answer` tool instead (see `wantsStructuredOutput`).
  const finalOutput = config.output;
  // On a structured workflow turn, append the instruction telling the model to
  // finish by calling `final_answer`. `filter(Boolean)` drops an absent system
  // prompt so we never stringify `undefined` into the prompt.
  const turnSystem = wantsStructuredOutput
    ? [input.system, thinkFinalAnswerInstruction(finalAnswerToolName)]
        .filter(Boolean)
        .join("\n\n")
    : input.system;
  // Structured turns must not end with a plain-text answer that skips
  // `final_answer` (some models, e.g. Workers AI llama, otherwise just reply
  // in text and stop). Force tool use: when the agent has real tools, require
  // *a* tool each step so it can do work and then call `final_answer`; with no
  // real tools, pin the choice directly to `final_answer`. A caller-provided
  // `toolChoice` still wins.
  const structuredHasRealTools =
    wantsStructuredOutput &&
    Object.keys(finalTools).some((name) => name !== finalAnswerToolName);
  const finalToolChoice = wantsStructuredOutput
    ? (config.toolChoice ??
      (structuredHasRealTools
        ? "required"
        : { type: "tool" as const, toolName: finalAnswerToolName }))
    : config.toolChoice;
  const finalStopWhen = [
    stepCountIs(finalMaxSteps),
    // Stop as soon as the model calls `final_answer` so the structured turn
    // terminates at the answer instead of continuing to stream more steps.
    ...(wantsStructuredOutput ? [hasToolCall(finalAnswerToolName)] : []),
    ...(Array.isArray(config.stopWhen)
      ? config.stopWhen
      : config.stopWhen
        ? [config.stopWhen]
        : [])
  ];

  const turnTelemetry = config.telemetry ?? config.experimental_telemetry;
  const streamTextOptions = {
    model: input.model,
    // `system` is accepted by both AI SDK v6 and v7 (v7 also accepts the
    // renamed `instructions`, but v6 does not). Use `system` for cross-major
    // compatibility.
    system: turnSystem,
    messages: input.messages,
    tools: finalTools,
    // Keep the synthetic final-answer tool callable even when a caller
    // restricts `activeTools` — otherwise a structured turn could never call
    // it and would fail to produce output.
    activeTools:
      wantsStructuredOutput && config.activeTools
        ? [...config.activeTools, finalAnswerToolName]
        : config.activeTools,
    toolChoice: finalToolChoice,
    maxOutputTokens: config.maxOutputTokens,
    temperature: config.temperature,
    topP: config.topP,
    topK: config.topK,
    presencePenalty: config.presencePenalty,
    frequencyPenalty: config.frequencyPenalty,
    stopSequences: config.stopSequences,
    seed: config.seed,
    maxRetries: config.maxRetries,
    timeout: config.timeout,
    headers: config.headers,
    stopWhen: finalStopWhen,
    providerOptions: config.providerOptions as
      | Parameters<typeof streamText>[0]["providerOptions"]
      | undefined,
    experimental_telemetry: usesAISDKV7Telemetry
      ? undefined
      : turnTelemetryV6(turnTelemetry, input.telemetry),
    // Forward the per-turn stream transform(s) from TurnConfig so callers
    // can inspect/rewrite the stream (e.g. emit `source` parts derived from
    // tool results) without owning the stream pipeline themselves.
    experimental_transform: config.experimental_transform,
    // `experimental_repairToolCall` is the common option name across AI SDK
    // v6 and v7. TurnConfig exposes the stable v7 name while this boundary
    // keeps both supported majors working.
    experimental_repairToolCall: config.repairToolCall,
    // Forward the per-turn structured-output spec from TurnConfig so
    // callers can use AI SDK `Output.object({ schema })` / `Output.text()`
    // on the terminal turn without dropping tools at model construction.
    output: finalOutput,
    abortSignal: input.signal,
    // Forward the AI SDK's `prepareStep` callback unchanged so subclasses
    // can make per-step decisions from the previous steps, current
    // messages, model, and experimental context.
    //
    // Subclass-only by design: extension dispatch is intentionally not
    // wired here. The prepareStep event includes a live `LanguageModel`
    // instance which is not JSON-serializable, and a returned override
    // can include the same — there's no useful "snapshot, override"
    // contract we could give to sandboxed extensions. If we expose
    // observation-only later it should go through a separate,
    // serialized event surface.
    //
    // `beforeStep` returning `void`/`undefined`/`null` is normalized to
    // `{}` so the AI SDK falls back to top-level settings (it accepts
    // `undefined` per docs but the typed return is non-null).
    prepareStep: (async (event) => {
      // Proactive context guard (Layer 1) runs first so `beforeStep` sees the
      // recompacted messages and can still override them if it wants to.
      const guarded = await hooks.compactBeforeStep(event);
      const result = await hooks.beforeStep(
        guarded ? { ...event, messages: guarded } : event
      );
      const base = result == null ? {} : result;
      // Only apply the guard's recompacted messages when the subclass didn't
      // set its own `messages` override for this step.
      const baseMessages = (base as { messages?: unknown }).messages;
      const withMessages =
        guarded && baseMessages === undefined
          ? { ...base, messages: guarded }
          : base;
      // Safety net for structured workflow turns: on the final permitted step,
      // force the model to call `final_answer` so the turn always terminates
      // with a schema-shaped result instead of running out of steps. Respect a
      // `toolChoice` the subclass already set for this step.
      const stepResult =
        wantsStructuredOutput &&
        event.stepNumber >= finalMaxSteps - 1 &&
        (withMessages as { toolChoice?: unknown }).toolChoice === undefined
          ? {
              ...withMessages,
              toolChoice: {
                type: "tool" as const,
                toolName: finalAnswerToolName
              },
              activeTools: [finalAnswerToolName]
            }
          : withMessages;
      // `beforeStep` may return a string `model` (StepConfig widens it to
      // ThinkModel); the AI SDK needs a concrete LanguageModel, so resolve it.
      const stepModel = (stepResult as { model?: ThinkModel }).model;
      if (typeof stepModel === "string") {
        return {
          ...stepResult,
          model: hooks.resolveModel(stepModel)
        } as PrepareStepResult<ToolSet>;
      }
      return stepResult as PrepareStepResult<ToolSet>;
    }) satisfies PrepareStepFunction<ToolSet>,
    // Pass the AI SDK's chunk event through unchanged — gives users access to
    // the discriminated `TextStreamPart` chunk with all provider metadata.
    onChunk: (event) => hooks.onChunk(event),
    // `onStepFinish` is the step callback name in both AI SDK v6 and v7 (v7
    // also accepts the renamed `onStepEnd`, but v6 does not). Use the shared
    // name; it still dispatches to Think's `onStepEnd` hook with the full
    // StepResult (reasoning, sources, files, providerMetadata, usage).
    onStepFinish: (event) => hooks.onStepEnd(event),
    // `beforeToolCall` is dispatched from the wrapped `execute` so the
    // returned `ToolCallDecision` can actually intercept the call.
    // `afterToolCall` is wired through the AI SDK's
    // `experimental_onToolCallFinish` callback so we get accurate execution
    // time and the discriminated `success`/`error` outcome — including
    // failures that propagate out of `execute`.
    //
    // We register `experimental_onToolCallFinish` (rather than the v7-only
    // `onToolExecutionEnd`) because it is the native option in AI SDK v6 and
    // a supported alias in v7 — `ai` resolves it to `onToolExecutionEnd`
    // internally and fires it exactly once. `normalizeToolFinishEvent`
    // reconciles the differing event shapes between the two majors.
    experimental_onToolCallFinish: (async (event) => {
      // The synthetic final-answer tool is internal plumbing for structured
      // workflow turns — do not surface it to user `afterToolCall` hooks or
      // extensions.
      const e = normalizeToolFinishEvent(event);
      if (e.toolCall.toolName === finalAnswerToolName) return;
      const { success, output, error } = e;
      const requestId = hooks.requestId();
      const base = {
        ...e.toolCall,
        stepNumber: e.stepNumber,
        messages: e.messages,
        toolExecutionMs: e.toolExecutionMs,
        durationMs: e.toolExecutionMs,
        ...(requestId !== undefined && { requestId })
      };
      const ctx = (success
        ? {
            ...base,
            toolOutput: { type: "tool-result" as const, output },
            success: true as const,
            output
          }
        : {
            ...base,
            toolOutput: { type: "tool-error" as const, error },
            success: false as const,
            error
          }) as unknown as ToolCallResultContext;
      await hooks.afterToolCall(ctx, {
        toolCall: e.toolCall,
        stepNumber: e.stepNumber,
        durationMs: e.toolExecutionMs,
        success,
        output,
        error
      });
    }) as ToolCallFinishCallback
  } satisfies Parameters<typeof streamText>[0];

  const crossMajorOptions = streamTextOptions as unknown as Record<
    PropertyKey,
    unknown
  >;
  if (usesAISDKV7Telemetry) {
    const { options, runtimeContext } = turnTelemetryV7(
      turnTelemetry,
      input.telemetry
    );
    delete crossMajorOptions.experimental_telemetry;
    crossMajorOptions.telemetry = options;
    crossMajorOptions.runtimeContext = runtimeContext;
  }
  if (input.invocationBounded) {
    crossMajorOptions[agentsAISDKInvocationBounded] = true;
  }

  const inferenceStreamText = wrapAISDK(aiSdk, {
    storeMessages: input.storeMessages,
    storeTools: input.storeTools
  }).streamText;

  return () => {
    const result = inferenceStreamText(streamTextOptions);

    const outputPromise = wantsStructuredOutput
      ? // Structured workflow result = the `final_answer` tool call's INPUT
        // (its arguments), captured after the stream finishes. Take the last
        // call in case the model emitted more than one. `result.toolCalls` is a
        // `PromiseLike`, so wrap it to get a real `Promise` (for `.catch` below).
        Promise.resolve(result.toolCalls).then((calls) => {
          const finalCalls = calls.filter(
            (call) => call.toolName === finalAnswerToolName
          );
          const last = finalCalls[finalCalls.length - 1];
          if (!last) {
            throw new Error(
              `Model ended the turn without calling the ${finalAnswerToolName} tool`
            );
          }
          return last.input;
        })
      : finalOutput
        ? // `result.output` is a getter that builds a new promise per read.
          Promise.resolve(result.output)
        : undefined;
    if (outputPromise) {
      // Attach a rejection observer immediately. The stream consumer will
      // still await this promise when it captures output, but aborted streams
      // can reject before the consumer reaches that point.
      void outputPromise.catch(() => {});
    }

    const streamResult = {
      toUIMessageStream: (options) => {
        const sendReasoning = options?.sendReasoning ?? input.sendReasoning;
        const onError = options?.onError ?? streamErrorToString;
        // Use the result's own `toUIMessageStream()` method rather than the
        // standalone `toUIMessageStream({ stream })` helper: the method exists
        // in both AI SDK v6 and v7 (deprecated in v7 but functional), whereas
        // the standalone helper and the `result.stream` property it needs are
        // v7-only.
        const uiStream = (
          result as {
            toUIMessageStream: (o: {
              sendReasoning?: boolean;
              onError?: (error: unknown) => string;
              messageMetadata?: (options: {
                part: TextStreamPart<ToolSet>;
              }) => Record<string, unknown> | undefined;
            }) => ReadableStream;
          }
        ).toUIMessageStream({
          sendReasoning,
          onError,
          messageMetadata: finalMessageMetadata
        });
        return readableStreamToAsyncIterable(uiStream);
      },
      output: outputPromise
    } satisfies StreamableResult;

    const finalizer: InferenceStreamFinalizer = {
      started: false,
      run: () =>
        // consumeStream never rejects (onError swallows) and is a no-op when
        // the stream already ran to completion.
        Promise.resolve(result.consumeStream({ onError: () => {} }))
    };
    inferenceStreamFinalizers.set(streamResult, finalizer);

    const finalized = hooks.transformResult(streamResult);
    if (finalized !== streamResult) {
      inferenceStreamFinalizers.set(finalized, finalizer);
    }
    return finalized;
  };
}
