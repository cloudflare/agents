import {
  asSchema,
  tool,
  type FlexibleSchema,
  type InferSchema,
  type Tool
} from "ai";
import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "./internal_context";
import type {
  ChatCapableAgentClass,
  RunAgentToolOptions,
  RunAgentToolResult,
  AgentToolDisplayMetadata,
  AgentToolFailure
} from "./agent-tool-types";

type ParseSchema<Output = unknown> = {
  parse(value: unknown): Output;
};

type AgentToolOutputSchema<Output> =
  | FlexibleSchema<Output>
  | ParseSchema<Output>;

type AgentToolFactoryOptions<Output = unknown, Input = unknown> = {
  description: string;
  inputSchema: FlexibleSchema<Input>;
  outputSchema?: AgentToolOutputSchema<Output>;
  displayName?: string;
  icon?: string;
  display?: AgentToolDisplayMetadata;
};

// Capture the concrete schema type so the overload below can derive its input
// with InferSchema. AgentToolFactoryOptions remains available for callers that
// explicitly supply agentTool<Input, Output>() type arguments.
type InferredAgentToolFactoryOptions<
  InputSchema extends FlexibleSchema,
  Output
> = Omit<AgentToolFactoryOptions<Output>, "inputSchema"> & {
  inputSchema: InputSchema;
};

type ToolExecutionOptions = {
  toolCallId?: string;
  abortSignal?: AbortSignal;
};

type AgentToolRunner = {
  runAgentTool<Input, Output>(
    cls: ChatCapableAgentClass,
    options: RunAgentToolOptions<Input>
  ): Promise<RunAgentToolResult<Output>>;
};

/**
 * Preserve the existing Zod-style `.parse()` output-schema contract while
 * extending validation to the other formats supported by AI SDK FlexibleSchema.
 */
async function validateOutput<Output>(
  schema: AgentToolOutputSchema<Output>,
  value: unknown
): Promise<Output> {
  if (
    typeof schema === "object" &&
    schema !== null &&
    "parse" in schema &&
    typeof schema.parse === "function"
  ) {
    return schema.parse(value);
  }

  const validate = asSchema(schema as FlexibleSchema<Output>).validate;
  if (!validate) {
    throw new Error("agentTool outputSchema must provide runtime validation");
  }

  const result = await validate(value);
  if (!result.success) throw result.error;
  return result.value;
}

function currentAgentToolRunner(): AgentToolRunner {
  const agent = agentContext.getStore()?.agent;
  if (
    agent === null ||
    typeof agent !== "object" ||
    typeof (agent as { runAgentTool?: unknown }).runAgentTool !== "function"
  ) {
    throw new Error(
      "agentTool() can only run inside an Agent turn. Use it from getTools() on an Agent subclass."
    );
  }
  return agent as AgentToolRunner;
}

function failure(
  status: AgentToolFailure["status"],
  error: string,
  retryable: boolean,
  extra?: Pick<AgentToolFailure, "reason" | "childStillRunning">
): AgentToolFailure {
  return {
    ok: false,
    status,
    error,
    retryable,
    ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra?.childStillRunning !== undefined
      ? { childStillRunning: extra.childStillRunning }
      : {})
  };
}

/**
 * Create an AI SDK tool that dispatches a chat-capable sub-agent through
 * `Agent.runAgentTool`.
 */
export function agentTool<InputSchema extends FlexibleSchema, Output = unknown>(
  cls: ChatCapableAgentClass,
  options: InferredAgentToolFactoryOptions<InputSchema, Output>
): Tool<InferSchema<InputSchema>, string | Output | AgentToolFailure>;
// Preserve existing callers that explicitly provide agentTool<Input, Output>().
export function agentTool<Input = unknown, Output = unknown>(
  cls: ChatCapableAgentClass,
  options: AgentToolFactoryOptions<Output, Input>
): Tool<Input, string | Output | AgentToolFailure>;
export function agentTool<Input = unknown, Output = unknown>(
  cls: ChatCapableAgentClass,
  options: AgentToolFactoryOptions<Output, Input>
): Tool<Input, string | Output | AgentToolFailure> {
  const createTool = tool as unknown as <I, O>(config: {
    description: string;
    inputSchema: unknown;
    execute: (input: I, options?: ToolExecutionOptions) => Promise<O>;
  }) => Tool<I, O>;

  return createTool<Input, string | Output | AgentToolFailure>({
    description: options.description,
    inputSchema: options.inputSchema,
    execute: async (input: Input, executeOptions?: ToolExecutionOptions) => {
      const display: AgentToolDisplayMetadata | undefined =
        options.displayName || options.icon || options.display
          ? {
              ...options.display,
              ...(options.displayName ? { name: options.displayName } : {}),
              ...(options.icon ? { icon: options.icon } : {})
            }
          : undefined;

      // Derive a STABLE runId from the tool call id (#1630). A tool call's id is
      // preserved in the transcript, so when a parent turn is re-run by chat
      // recovery after a deploy / eviction, the same `agentTool()` call resolves
      // to the same runId — turning the re-issue into a duplicate that
      // `runAgentTool` re-attaches to the still-running child, instead of a
      // fresh `nanoid` that spawns a brand-new child and re-runs already-
      // completed work ("the agent went all the way back"). Falls back to a
      // fresh id only when there is no tool call id (rare; preserves prior
      // behavior).
      const runId = executeOptions?.toolCallId
        ? `agent-tool:${executeOptions.toolCallId}`
        : undefined;

      const result = await currentAgentToolRunner().runAgentTool<Input, Output>(
        cls,
        {
          input,
          runId,
          parentToolCallId: executeOptions?.toolCallId,
          signal: executeOptions?.abortSignal,
          display
        }
      );

      if (result.status === "completed") {
        if (options.outputSchema) {
          if (result.output === undefined) {
            return failure(
              "error",
              "agent tool completed without structured output required by outputSchema",
              false
            );
          }
          return validateOutput(options.outputSchema, result.output);
        }
        return result.summary ?? "";
      }

      if (result.status === "aborted") {
        // Intentional cancellation (parent/user stopped the run) — not retryable.
        return failure(
          "aborted",
          result.error ?? "agent tool run was cancelled",
          false
        );
      }
      if (result.status === "interrupted") {
        // The child was reset/superseded by a deploy or parent recovery before
        // it reached a logical outcome. Re-dispatching the run can succeed, so
        // surface it as retryable rather than a terminal failure the parent
        // would report to the user as final. `retryable` is intentionally COARSE
        // (always true for `interrupted`); callers that want to distinguish a
        // self-healing child from an exhausted one branch on `reason` /
        // `childStillRunning` instead.
        return failure(
          "interrupted",
          result.error ??
            "agent tool run was interrupted before it finished; it can be retried",
          true,
          { reason: result.reason, childStillRunning: result.childStillRunning }
        );
      }
      return failure("error", result.error ?? "agent tool run failed", false);
    }
  });
}

export type { AgentToolFactoryOptions };
export type {
  AgentToolChildAdapter,
  AgentToolDisplayMetadata,
  AgentToolEvent,
  AgentToolEventMessage,
  AgentToolEventState,
  AgentToolFailure,
  AgentToolInterruptedReason,
  AgentToolLifecycleResult,
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolRunPart,
  AgentToolRunState,
  AgentToolRunStatus,
  AgentToolStoredChunk,
  AgentToolTerminalStatus,
  ChatCapableAgentClass,
  DetachedAgentToolConfig,
  DetachedRunAgentToolResult,
  RunAgentToolOptions,
  RunAgentToolResult
} from "./agent-tool-types";
