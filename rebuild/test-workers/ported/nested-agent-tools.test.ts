/**
 * Ported from ORIGINAL Think:
 * - packages/think/src/tests/nested-agent-tools.test.ts
 * - last original change: f6a8bc4a
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `agents` import to `./compat.js`.
 * - Re-pointed original fixture type import to `./fixtures/index.js`.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "./compat.js";
import type {
  ThinkAgentToolParent,
  ThinkNestedMiddleAgent
} from "./fixtures/index.js";

type NestedStub = {
  runNestedMiddleForTest(runId: string): Promise<{
    middleStatus: string;
    middleError?: string;
    parentEventRunIds: string[];
    grandchildRuns: Array<{ runId: string; status: string }>;
  }>;
};

type MiddleStub = {
  setMaxConcurrentAgentToolsForTest(limit: number): Promise<void>;
  runConcurrentGrandchildrenForTest(
    count: number
  ): Promise<Array<{ runId: string; status: string; error?: string }>>;
};

async function freshParent(): Promise<NestedStub> {
  return getAgentByName(
    env.ThinkAgentToolParent as unknown as DurableObjectNamespace<ThinkAgentToolParent>,
    `nested-${crypto.randomUUID()}`
  ) as unknown as Promise<NestedStub>;
}

async function freshMiddle(): Promise<MiddleStub> {
  return getAgentByName(
    env.ThinkNestedMiddleAgent as unknown as DurableObjectNamespace<ThinkNestedMiddleAgent>,
    `nested-middle-${crypto.randomUUID()}`
  ) as unknown as Promise<MiddleStub>;
}

describe("nested agent-tools (grandparent → middle → grandchild)", () => {
  it("runs a 3-level chain to completion at every level", async () => {
    const parent = await freshParent();
    const middleRunId = "nested-middle-1";

    const result = await parent.runNestedMiddleForTest(middleRunId);

    expect(result.middleStatus).toBe("completed");
    expect(result.middleError).toBeUndefined();

    expect(result.grandchildRuns).toEqual([
      { runId: `${middleRunId}-grandchild`, status: "completed" }
    ]);
  });

  it("does not bridge grandchild observation up to the grandparent", async () => {
    const parent = await freshParent();
    const middleRunId = "nested-middle-2";

    const result = await parent.runNestedMiddleForTest(middleRunId);

    expect(result.parentEventRunIds).toContain(middleRunId);
    expect(result.parentEventRunIds).not.toContain(`${middleRunId}-grandchild`);
  });

  it("enforces each nesting level's own maxConcurrentAgentTools independently", async () => {
    const middle = await freshMiddle();
    await middle.setMaxConcurrentAgentToolsForTest(1);

    const results = await middle.runConcurrentGrandchildrenForTest(2);
    expect(results.filter((r) => r.status === "completed")).toHaveLength(1);
    const errored = results.filter((r) => r.status === "error");
    expect(errored).toHaveLength(1);
    expect(errored[0]?.error).toContain("maxConcurrentAgentTools (1) exceeded");
  });
});
