import { describe, expect, it } from "vitest";
import type {
  DurableToolOwner,
  DurableToolRun,
  DurableToolStartResult
} from "../../driver";
import { startOpenCodeBackgroundTool } from "../../opencode/durable-tools";

class Runs {
  starts: Array<{
    runId: string;
    owner: DurableToolOwner;
    input: { value: number };
  }> = [];

  async start(
    runId: string,
    owner: DurableToolOwner,
    input: { value: number }
  ): Promise<DurableToolStartResult<{ value: number }, unknown>> {
    this.starts.push({ runId, owner, input });
    return {
      accepted: true,
      run: {
        runId,
        coordinatorId: "tools",
        owner,
        input,
        status: "pending",
        result: null,
        error: null,
        createdAt: 1,
        updatedAt: 1
      } satisfies DurableToolRun<{ value: number }, unknown>
    };
  }
}

describe("startOpenCodeBackgroundTool", () => {
  it("returns a stable detached handle for the native tool call", async () => {
    const runs = new Runs();

    const first = await startOpenCodeBackgroundTool({
      runs,
      input: { value: 3 },
      driverId: "opencode",
      sessionId: "session",
      operationId: "operation",
      toolCallId: "call",
      cancellation: "detached"
    });
    const second = await startOpenCodeBackgroundTool({
      runs,
      input: { value: 3 },
      driverId: "opencode",
      sessionId: "session",
      operationId: "operation",
      toolCallId: "call",
      cancellation: "detached"
    });

    expect(first).toEqual(second);
    expect(first).toEqual({
      content: `Background tool started: ${runs.starts[0].runId}`,
      metadata: { runId: runs.starts[0].runId }
    });
    expect(runs.starts[0].owner).toEqual({
      driverId: "opencode",
      scope: "session",
      operationId: "operation",
      toolCallId: "call",
      mode: "background",
      cancellation: "detached"
    });
  });
});
