import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkAgentToolParent } from "./agents";

type NestedStub = {
  runNestedMiddleForTest(runId: string): Promise<{
    middleStatus: string;
    middleError?: string;
    parentEventRunIds: string[];
    grandchildRuns: Array<{ runId: string; status: string }>;
  }>;
};

async function freshParent(): Promise<NestedStub> {
  return getAgentByName(
    env.ThinkAgentToolParent as unknown as DurableObjectNamespace<ThinkAgentToolParent>,
    `nested-${crypto.randomUUID()}`
  ) as unknown as Promise<NestedStub>;
}

describe("nested agent-tools (grandparent → middle → grandchild)", () => {
  it("runs a 3-level chain to completion at every level", async () => {
    const parent = await freshParent();
    const middleRunId = "nested-middle-1";

    const result = await parent.runNestedMiddleForTest(middleRunId);

    // The middle (run as the grandparent's agent-tool child) completed.
    expect(result.middleStatus).toBe("completed");
    expect(result.middleError).toBeUndefined();

    // The middle, acting as a parent, owns a completed grandchild run.
    expect(result.grandchildRuns).toEqual([
      { runId: `${middleRunId}-grandchild`, status: "completed" }
    ]);
  });

  it("does not bridge grandchild observation up to the grandparent", async () => {
    const parent = await freshParent();
    const middleRunId = "nested-middle-2";

    const result = await parent.runNestedMiddleForTest(middleRunId);

    // The grandparent observes the middle's run via agent-tool events...
    expect(result.parentEventRunIds).toContain(middleRunId);
    // ...but NOT the grandchild's: nested runs are visible only to their
    // immediate parent's clients.
    expect(result.parentEventRunIds).not.toContain(`${middleRunId}-grandchild`);
  });
});
