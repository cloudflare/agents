/**
 * How a turn's tools consult `beforeToolCall` before they run. Each tool's
 * `execute` is wrapped; the hook's `ToolCallDecision` can let the call run
 * (optionally with new input), block it, or substitute its output.
 */

import type { ModelMessage, ToolSet, TypedToolCall } from "ai";
import type { ToolCallContext, ToolCallDecision } from "./turn-types";

/**
 * The subset of the AI SDK's `ToolExecuteOptions` that Think's
 * tool wrapper reads when resolving a `beforeToolCall` decision.
 */
type ToolDecisionOptions = {
  toolCallId: string;
  messages: ModelMessage[];
  abortSignal?: AbortSignal;
  context?: unknown;
  experimental_context?: unknown; // v6 alias kept for local wrappers if present
};

/**
 * What the wrapped tools call on their agent.
 *
 * @internal
 */
export interface ToolDecisionHooks {
  beforeToolCall(
    ctx: ToolCallContext
  ): ToolCallDecision | void | Promise<ToolCallDecision | void>;
  /** Tell extensions the call is about to run, with the input it runs with. */
  observeStart(event: {
    toolCall: TypedToolCall<ToolSet>;
    stepNumber: number | undefined;
  }): Promise<void>;
  requestId(): string | undefined;
  /**
   * For an action that requires approval: the tool output to return instead
   * of running, when `input` differs from what the human approved. Return
   * `undefined` to run.
   */
  rejectChangedApprovedInput(toolCallId: string, input: unknown): unknown;
}

type ResolvedToolCallDecision =
  | { execute: true; finalInput: unknown }
  | { execute: false; output: unknown };

/**
 * Wrap each tool's `execute` function so the agent's `beforeToolCall`
 * hook is consulted before the tool runs. The hook can return a
 * `ToolCallDecision` to:
 *
 * - `allow` (default if `void` is returned) — run the original
 *   `execute`, optionally with a substituted `input`.
 * - `block` — skip `execute` and return `reason` (or a default string)
 *   as the tool result. The model sees this as the tool's output.
 * - `substitute` — skip `execute` and return `output` directly. The
 *   model sees this as the tool's output.
 *
 * The wrapped `execute` also dispatches the `beforeToolCall`
 * observation snapshot to subscribed extensions. `afterToolCall` is
 * still wired through the AI SDK's `experimental_onToolCallFinish`
 * callback so we get accurate `durationMs` and proper success/error
 * discrimination — `block` and `substitute` outcomes show up as
 * `success: true` with the substituted output; uncaught throws from
 * the original `execute` show up as `success: false` with the error.
 *
 * Tools without an `execute` (output-schema-only tools, client tools
 * routed via `needsApproval`) are left untouched.
 *
 * **Streaming tools (AsyncIterable):** the AI SDK supports tools whose
 * `execute` returns `AsyncIterable<output>` to emit preliminary
 * results before a final value. The canonical form is an async
 * generator (`async function* execute(...)`), where calling `execute`
 * synchronously returns a direct `AsyncIterable`. For that form Think
 * preserves preliminary streaming: the wrapper is itself an async
 * generator that `await`s `beforeToolCall` and then yields every
 * chunk through unchanged. Non-streaming tools keep a scalar wrapper
 * so they never emit a synthetic `preliminary` tool-result chunk.
 *
 * The non-canonical `async function execute(...) { return makeIter(); }`
 * form returns a `Promise<AsyncIterable>`, which does not stream even
 * in the raw AI SDK (it would surface the iterator object as the final
 * output). Think collapses it to the last yielded value instead. If
 * you need preliminary streaming, use an `async function*` `execute`.
 *
 * @internal
 */
export function wrapToolsWithDecision(
  tools: ToolSet,
  hooks: ToolDecisionHooks
): ToolSet {
  const wrapped: ToolSet = {};
  for (const [toolName, originalTool] of Object.entries(tools)) {
    const t = originalTool as Record<string, unknown>;
    const originalExecute = t.execute as
      | ((input: unknown, options: unknown) => unknown | Promise<unknown>)
      | undefined;
    if (typeof originalExecute !== "function") {
      wrapped[toolName] = originalTool;
      continue;
    }

    const isDynamic = t.type === "dynamic";
    const metadata = t.metadata as Record<string, unknown> | undefined;
    const isApprovalConfiguredAction =
      metadata?.cfThinkAction === true &&
      metadata.cfThinkActionApprovalConfigured === true;

    // Canonical AI SDK streaming tools use an async generator `execute`
    // (`async function* execute(...)`). Detect that form so we can keep
    // preliminary streaming flowing through `beforeToolCall`. Everything
    // else routes through the scalar wrapper so non-streaming tools never
    // emit a synthetic `preliminary` tool-result.
    const isStreamingExecute =
      (originalExecute as { constructor?: { name?: string } }).constructor
        ?.name === "AsyncGeneratorFunction";

    const wrappedExecute = isStreamingExecute
      ? (input: unknown, options: ToolDecisionOptions) =>
          // Returning the generator synchronously (via the sync arrow)
          // keeps it a *direct* AsyncIterable so the AI SDK streams the
          // preliminary parts instead of awaiting a Promise<AsyncIterable>.
          (async function* () {
            const resolved = await resolveToolCallDecision(
              hooks,
              toolName,
              input,
              options,
              isDynamic,
              isApprovalConfiguredAction
            );
            if (!resolved.execute) {
              // Block/substitute is a scalar outcome, but this wrapper had
              // to commit to an AsyncIterable shape synchronously (before the
              // async decision was known) so the execute path can stream.
              // The AI SDK's `executeTool` turns every yielded value into a
              // `preliminary` tool-result plus a `final`, so this single
              // yield surfaces one synthetic `preliminary` chunk to observers
              // (e.g. onChunk) that the scalar wrapper never emits. The
              // model-visible final output is identical and correct, and this
              // matches how any streaming tool that emits a single value
              // already behaves — so we accept it rather than regress
              // streaming preservation for the (rare) block/substitute case.
              yield resolved.output;
              return;
            }
            const result = await originalExecute(resolved.finalInput, options);
            if (
              result != null &&
              typeof result === "object" &&
              Symbol.asyncIterator in (result as object)
            ) {
              // Stream the original tool's preliminary outputs through
              // unchanged — the AI SDK emits each as a `preliminary`
              // tool-result and the last as the final value.
              yield* result as AsyncIterable<unknown>;
            } else {
              yield result;
            }
          })()
      : async (
          input: unknown,
          options: ToolDecisionOptions
        ): Promise<unknown> => {
          const resolved = await resolveToolCallDecision(
            hooks,
            toolName,
            input,
            options,
            isDynamic,
            isApprovalConfiguredAction
          );
          if (!resolved.execute) return resolved.output;
          // Await before inspecting so we detect a direct AsyncIterable
          // return even from a non-async-generator `execute` (e.g. a
          // plain function that returns a generator). Such non-canonical
          // streaming shapes are collapsed to their last yielded value.
          const result = await originalExecute(resolved.finalInput, options);
          if (
            result != null &&
            typeof result === "object" &&
            Symbol.asyncIterator in (result as object)
          ) {
            let last: unknown;
            for await (const part of result as AsyncIterable<unknown>) {
              last = part;
            }
            return last;
          }
          return result;
        };

    wrapped[toolName] = {
      ...(originalTool as object),
      execute: wrappedExecute
    } as ToolSet[string];
  }
  return wrapped;
}

/**
 * Shared `beforeToolCall` resolution for both the scalar and streaming
 * tool wrappers (see {@link wrapToolsWithDecision}). Builds the
 * `ToolCallContext`, consults the subclass `beforeToolCall` hook,
 * dispatches the extension observation snapshot, and resolves the
 * returned `ToolCallDecision` into either "run `execute` with this
 * input" or "short-circuit with this output".
 */
async function resolveToolCallDecision(
  hooks: ToolDecisionHooks,
  toolName: string,
  input: unknown,
  options: ToolDecisionOptions,
  isDynamic: boolean,
  isApprovalConfiguredAction: boolean
): Promise<ResolvedToolCallDecision> {
  // Build the discriminated `TypedToolCall`-shaped context.
  const toolCallBase = {
    type: "tool-call" as const,
    toolCallId: options.toolCallId,
    toolName,
    input,
    ...(isDynamic ? { dynamic: true as const } : {})
  };

  const requestId = hooks.requestId();
  const ctx = {
    ...toolCallBase,
    stepNumber: undefined,
    messages: options.messages,
    abortSignal: options.abortSignal,
    ...(requestId !== undefined && { requestId })
  } as ToolCallContext;

  // Subclass decision first.
  const decision = await hooks.beforeToolCall(ctx);

  // Extension observation dispatch — runs after the subclass so
  // extensions see whatever effect the subclass had on the decision
  // shape (input substitution shows up in the snapshot).
  const dispatchInput =
    decision && decision.action === "allow" && decision.input
      ? decision.input
      : input;
  await hooks.observeStart({
    toolCall: {
      ...toolCallBase,
      input: dispatchInput
    } as TypedToolCall<ToolSet>,
    stepNumber: undefined
  });

  // Resolve the decision.
  if (!decision || decision.action === "allow") {
    const finalInput = decision?.input ?? input;
    const rejected = isApprovalConfiguredAction
      ? hooks.rejectChangedApprovedInput(options.toolCallId, finalInput)
      : undefined;
    if (rejected !== undefined) {
      return { execute: false, output: rejected };
    }
    return { execute: true, finalInput };
  }
  if (decision.action === "block") {
    return {
      execute: false,
      output:
        decision.reason ?? `Tool "${toolName}" was blocked by beforeToolCall.`
    };
  }
  // substitute
  return { execute: false, output: decision.output };
}
