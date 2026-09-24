import { durableToolRunId } from "../driver";
import type { DurableToolOwner, DurableToolStartResult } from "../driver";

export interface OpenCodeBackgroundToolRuns<Input, Result> {
  start(
    runId: string,
    owner: DurableToolOwner,
    input: Input
  ): Promise<DurableToolStartResult<Input, Result>>;
}

export type OpenCodeBackgroundToolOptions<Input, Result> = {
  readonly runs: OpenCodeBackgroundToolRuns<Input, Result>;
  readonly input: Input;
  readonly driverId?: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly toolCallId: string;
  readonly cancellation?: "with-parent" | "detached";
};

export type OpenCodeBackgroundToolHandle = {
  readonly content: string;
  readonly metadata: { readonly runId: string };
};

export async function startOpenCodeBackgroundTool<Input, Result>(
  options: OpenCodeBackgroundToolOptions<Input, Result>
): Promise<OpenCodeBackgroundToolHandle> {
  const owner: DurableToolOwner = {
    driverId: options.driverId ?? "opencode",
    scope: options.sessionId,
    operationId: options.operationId,
    toolCallId: options.toolCallId,
    mode: "background",
    cancellation: options.cancellation ?? "detached"
  };
  const runId = durableToolRunId(owner);
  await options.runs.start(runId, owner, options.input);
  return {
    content: `Background tool started: ${runId}`,
    metadata: { runId }
  };
}
