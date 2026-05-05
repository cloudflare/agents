import { tool, type Tool } from "ai";
import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "./internal_context";
import type {
  ChatCapableAgentClass,
  RunAgentToolOptions,
  RunAgentToolResult,
  AgentToolDisplayMetadata
} from "./agent-tool-types";

type SchemaLike<T = unknown> = {
  parse(value: unknown): T;
};

type AgentToolFactoryOptions<Output = unknown> = {
  description: string;
  inputSchema: unknown;
  outputSchema?: SchemaLike<Output>;
  displayName?: string;
  icon?: string;
  display?: AgentToolDisplayMetadata;
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

function failure(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * Create an AI SDK tool that dispatches a chat-capable sub-agent through
 * `Agent.runAgentTool`.
 */
export function agentTool<Input = unknown, Output = unknown>(
  cls: ChatCapableAgentClass,
  options: AgentToolFactoryOptions<Output>
): Tool<Input, string | Output | { ok: false; error: string }> {
  const createTool = tool as unknown as <I, O>(config: {
    description: string;
    inputSchema: unknown;
    execute: (input: I, options?: ToolExecutionOptions) => Promise<O>;
  }) => Tool<I, O>;

  return createTool<Input, string | Output | { ok: false; error: string }>({
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

      const result = await currentAgentToolRunner().runAgentTool<Input, Output>(
        cls,
        {
          input,
          parentToolCallId: executeOptions?.toolCallId,
          signal: executeOptions?.abortSignal,
          display
        }
      );

      if (result.status === "completed") {
        if (options.outputSchema) {
          if (result.output === undefined) {
            return failure(
              "agent tool completed without structured output required by outputSchema"
            );
          }
          return options.outputSchema.parse(result.output);
        }
        return result.summary ?? "";
      }

      if (result.status === "aborted") {
        return failure("agent tool run was cancelled");
      }
      if (result.status === "interrupted") {
        return failure("agent tool run was interrupted; no recoverable output");
      }
      return failure(result.error ?? "agent tool run failed");
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
  AgentToolLifecycleResult,
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolRunState,
  AgentToolRunStatus,
  AgentToolStoredChunk,
  AgentToolTerminalStatus,
  ChatCapableAgentClass,
  RunAgentToolOptions,
  RunAgentToolResult
} from "./agent-tool-types";
