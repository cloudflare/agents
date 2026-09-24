import type { Static, TSchema } from "typebox";
import { durableToolRunId } from "../driver";
import type { DurableToolOwner, DurableToolStartResult } from "../driver";
import type {
  PiContext,
  PiTool,
  PiToolInvocation,
  PiToolResult
} from "./types";

export interface PiDurableToolRuns<Input, Result> {
  start(
    runId: string,
    owner: DurableToolOwner,
    input: Input
  ): Promise<DurableToolStartResult<Input, Result>>;
  wait(runId: string, signal?: AbortSignal): Promise<Result>;
}

type PiDurableToolOptions<
  ToolContext extends object | undefined,
  Parameters extends TSchema,
  Details
> = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Parameters;
  readonly runs: PiDurableToolRuns<Static<Parameters>, PiToolResult<Details>>;
  readonly scope: (
    context: PiContext,
    invocation: PiToolInvocation
  ) => string | Promise<string>;
  readonly driverId?: string;
  readonly cancellation?: "with-parent" | "detached";
};

type PiBackgroundToolOptions<
  ToolContext extends object | undefined,
  Parameters extends TSchema,
  RunResult
> = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Parameters;
  readonly runs: PiDurableToolRuns<Static<Parameters>, RunResult>;
  readonly scope: (
    context: PiContext,
    invocation: PiToolInvocation
  ) => string | Promise<string>;
  readonly driverId?: string;
  readonly cancellation?: "with-parent" | "detached";
};

function owner(
  driverId: string,
  scope: string,
  operationId: string,
  toolCallId: string,
  mode: DurableToolOwner["mode"],
  cancellation: DurableToolOwner["cancellation"]
): DurableToolOwner {
  return {
    driverId,
    scope,
    operationId,
    toolCallId,
    mode,
    cancellation
  };
}

function invocationRunId(
  toolOwner: DurableToolOwner,
  invocationId: string
): string {
  return `${durableToolRunId(toolOwner)}:${invocationId.length}:${invocationId}`;
}

export function createPiDurableTool<
  ToolContext extends object | undefined = undefined,
  Parameters extends TSchema = TSchema,
  Details = unknown
>(
  options: PiDurableToolOptions<ToolContext, Parameters, Details>
): PiTool<ToolContext, Parameters, Details> {
  return {
    name: options.name,
    label: options.label,
    description: options.description,
    parameters: options.parameters,
    replay: "safe",
    async execute(
      toolCallId,
      input,
      _onUpdate,
      _toolContext,
      invocation,
      context
    ) {
      const toolOwner = owner(
        options.driverId ?? "pi",
        await options.scope(context, invocation),
        invocation.operationId,
        toolCallId,
        "foreground",
        options.cancellation ?? "with-parent"
      );
      const runId = invocationRunId(toolOwner, invocation.invocationId);
      await options.runs.start(runId, toolOwner, input);
      return options.runs.wait(runId, context.abortSignal);
    }
  };
}

export function createPiBackgroundTool<
  ToolContext extends object | undefined = undefined,
  Parameters extends TSchema = TSchema,
  RunResult = unknown
>(
  options: PiBackgroundToolOptions<ToolContext, Parameters, RunResult>
): PiTool<ToolContext, Parameters, { readonly runId: string }> {
  return {
    name: options.name,
    label: options.label,
    description: options.description,
    parameters: options.parameters,
    replay: "safe",
    async execute(
      toolCallId,
      input,
      _onUpdate,
      _toolContext,
      invocation,
      context
    ) {
      const toolOwner = owner(
        options.driverId ?? "pi",
        await options.scope(context, invocation),
        invocation.operationId,
        toolCallId,
        "background",
        options.cancellation ?? "detached"
      );
      const runId = invocationRunId(toolOwner, invocation.invocationId);
      await options.runs.start(runId, toolOwner, input);
      return {
        content: [{ type: "text", text: `Background tool started: ${runId}` }],
        details: { runId }
      };
    }
  };
}
