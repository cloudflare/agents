import type {
  AgentHarnessTool,
  AgentHarnessToolInvocation,
  AgentToolResult
} from "@earendil-works/pi-agent-core";
import type { ExtensionRunner } from "../../../vendor/pi-coding-agent-src/core/extensions/runner.ts";
import type { ToolInfo } from "../../../vendor/pi-coding-agent-src/core/extensions/types.ts";
import { wrapRegisteredTool } from "../../../vendor/pi-coding-agent-src/core/extensions/wrapper.ts";
import { createSyntheticSourceInfo } from "../../../vendor/pi-coding-agent-src/core/source-info.ts";
import type { ExtensionLaneStates } from "./state";

/** What the tool adapter needs to place a call on the lane that made it. */
export type ExtensionToolDeps = {
  readonly states: ExtensionLaneStates;
  /**
   * The lane one tool invocation belongs to.
   *
   * `AgentHarnessToolInvocation` carries no lane, so only the harness can
   * answer this — it knows which lane owns the invocation's operation. When
   * the harness supplies no resolver, or the resolver cannot place a
   * recovered invocation, the call runs on the default lane.
   */
  readonly laneForInvocation?: (
    invocation: AgentHarnessToolInvocation
  ) => string | undefined;
};

/**
 * Adapt every tool the loaded extensions registered into harness tools.
 *
 * Two shapes have to meet. Pi's `AgentTool` takes
 * `(toolCallId, params, signal, onUpdate)` and closes over the runner's
 * context; the harness calls
 * `(toolCallId, params, onUpdate, toolContext, invocation, context)` and
 * carries cancellation on the invocation context instead of a parameter. The
 * vendored `wrapRegisteredTool` supplies the extension context and the
 * `addedToolNames` bookkeeping for tools that widen the active set, so the
 * adapter here only re-orders arguments and forwards the context's signal.
 *
 * Every extension tool is `replay: "never"`. Extension code is arbitrary and
 * process-local: after an eviction the harness cannot know whether a call's
 * effects happened, and re-running one would repeat them.
 */
export function adaptExtensionTools(
  runner: ExtensionRunner,
  deps: ExtensionToolDeps
): AgentHarnessTool<object | undefined>[] {
  return runner.getAllRegisteredTools().map((registered) => {
    const tool = wrapRegisteredTool(registered, runner);
    return {
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      replay: "never",
      ...(tool.constrainedSampling === undefined
        ? {}
        : { constrainedSampling: tool.constrainedSampling }),
      ...(tool.prepareArguments === undefined
        ? {}
        : { prepareArguments: tool.prepareArguments }),
      ...(tool.executionMode === undefined
        ? {}
        : { executionMode: tool.executionMode }),
      execute: async (
        toolCallId,
        parameters,
        onUpdate,
        _toolContext,
        invocation,
        context
      ): Promise<AgentToolResult<unknown>> => {
        // A tool body calls the same synchronous `pi.*` and `ctx.ui`
        // surfaces a hook does, and they resolve against the current lane.
        // After an eviction the call is recovered with no hook having run
        // for it, so the lane comes from the invocation rather than from
        // whatever ran last.
        const lane =
          deps.laneForInvocation?.(invocation) ?? deps.states.defaultLane;
        // The call's own cancellation is what `ctx.signal` has to hand a
        // tool body: aborting the operation has to reach the extension code
        // that is running inside it.
        return deps.states.withLane(
          lane,
          async (state) => {
            const result = await tool.execute(
              toolCallId,
              parameters,
              context.abortSignal,
              (partial) => {
                onUpdate(partial);
              }
            );
            // A tool body's `pi.*` calls return the moment they are queued
            // on the lane's write chain, so a tool that appended an entry and
            // returned has not necessarily written one. The harness settles
            // the call on this result: without the drain the operation can
            // complete, a client can read the transcript back, and the
            // isolate can be evicted, all before the write lands.
            //
            // Draining changes only when a write lands, never whether the
            // tool succeeded. `ExtensionLaneState.enqueue` already absorbs a
            // failed write and reports it as a `handler_error` on the lane,
            // so a tool that produced a result keeps it even if one of its
            // writes failed — the failure is visible to the client, not
            // folded into the model's tool result.
            await state.drain();
            return result;
          },
          { signal: context.abortSignal }
        );
      }
    } satisfies AgentHarnessTool<object | undefined>;
  });
}

/**
 * Describe the tools currently offered to the model in the shape `pi.getAllTools()`
 * returns. Harness tools carry no source metadata, so each one is attributed
 * to the harness itself.
 */
export function describeTools(
  tools: readonly AgentHarnessTool<object | undefined>[]
): ToolInfo[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    sourceInfo: createSyntheticSourceInfo(`<tool:${tool.name}>`, {
      source: "harness"
    })
  }));
}
