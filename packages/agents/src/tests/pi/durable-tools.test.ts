import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type {
  DurableToolOwner,
  DurableToolRun,
  DurableToolStartResult
} from "../../driver";
import {
  createPiBackgroundTool,
  createPiDurableTool
} from "../../pi/durable-tools";
import type { PiContext, PiToolInvocation, PiToolResult } from "../../pi/types";

const parameters = Type.Object({ value: Type.Number() });
type Input = { value: number };
type Result = PiToolResult<{ value: number }>;

class Runs {
  starts: Array<{ runId: string; owner: DurableToolOwner; input: Input }> = [];
  waits: string[] = [];

  async start(
    runId: string,
    owner: DurableToolOwner,
    input: Input
  ): Promise<DurableToolStartResult<Input, Result>> {
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
      } satisfies DurableToolRun<Input, Result>
    };
  }

  async wait(runId: string): Promise<Result> {
    this.waits.push(runId);
    return {
      content: [{ type: "text", text: "complete" }],
      details: { value: 6 }
    };
  }
}

const invocation: PiToolInvocation = {
  invocationId: "invocation",
  operationId: "operation",
  turnId: "turn",
  getMemo: async () => undefined,
  setMemo: async () => {}
};

const context: PiContext = {
  abortSignal: undefined,
  value: () => undefined,
  toString: () => "test"
};

describe("Pi durable tools", () => {
  it("re-enters one foreground run with a stable invocation identifier", async () => {
    const runs = new Runs();
    const tool = createPiDurableTool({
      name: "multiply",
      label: "Multiply",
      description: "Multiply a number",
      parameters,
      runs,
      scope: () => "main"
    });

    const first = await tool.execute(
      "call",
      { value: 3 },
      () => {},
      undefined,
      invocation,
      context
    );
    const second = await tool.execute(
      "call",
      { value: 3 },
      () => {},
      undefined,
      invocation,
      context
    );

    expect(first).toEqual(second);
    expect(runs.starts).toHaveLength(2);
    expect(runs.starts[0].runId).toBe(runs.starts[1].runId);
    expect(runs.starts[0].owner).toEqual({
      driverId: "pi",
      scope: "main",
      operationId: "operation",
      toolCallId: "call",
      mode: "foreground",
      cancellation: "with-parent"
    });
    expect(runs.waits).toEqual([runs.starts[0].runId, runs.starts[0].runId]);
    expect(tool.replay).toBe("safe");
  });

  it("returns a handle immediately for a detached background run", async () => {
    const runs = new Runs();
    const tool = createPiBackgroundTool({
      name: "report",
      label: "Report",
      description: "Build a report",
      parameters,
      runs,
      scope: () => "research",
      cancellation: "detached"
    });

    const result = await tool.execute(
      "call",
      { value: 4 },
      () => {},
      undefined,
      invocation,
      context
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `Background tool started: ${runs.starts[0].runId}`
        }
      ],
      details: { runId: runs.starts[0].runId }
    });
    expect(runs.starts[0].owner).toMatchObject({
      mode: "background",
      cancellation: "detached"
    });
    expect(runs.waits).toEqual([]);
  });
});
