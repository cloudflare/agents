/**
 * Ported from ORIGINAL Think:
 * - packages/think/src/tests/max-concurrent-agent-tools.test.ts
 * - last original change: f6a8bc4a
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `agents` import to `./compat.js`.
 * - Re-pointed original fixture type import to `./fixtures/index.js`.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "./compat.js";
import type { ThinkAgentToolParent } from "./fixtures/index.js";

type ConcurrencyStub = {
  setMaxConcurrentAgentToolsForTest(limit: number): Promise<void>;
  runConcurrentThinkChildrenForTest(
    count: number
  ): Promise<Array<{ runId: string; status: string; error?: string }>>;
  seedParentAgentToolRunForTest(runId: string, status: string): Promise<void>;
  runSingleThinkChildForTest(): Promise<{ status: string; error?: string }>;
};

async function freshParent(): Promise<ConcurrencyStub> {
  return getAgentByName(
    env.ThinkAgentToolParent as unknown as DurableObjectNamespace<ThinkAgentToolParent>,
    `max-concurrent-${crypto.randomUUID()}`
  ) as unknown as Promise<ConcurrencyStub>;
}

describe("maxConcurrentAgentTools", () => {
  it("rejects over-cap runs fail-fast with a clear error (no queue)", async () => {
    const parent = await freshParent();
    await parent.setMaxConcurrentAgentToolsForTest(2);

    const results = await parent.runConcurrentThinkChildrenForTest(3);

    const errored = results.filter((r) => r.status === "error");
    const completed = results.filter((r) => r.status === "completed");
    expect(errored).toHaveLength(1);
    expect(completed).toHaveLength(2);
    expect(errored[0]?.error).toContain("maxConcurrentAgentTools (2) exceeded");
  });

  it("allows the rejected slot to be reused once a run settles", async () => {
    const parent = await freshParent();
    await parent.setMaxConcurrentAgentToolsForTest(2);

    const first = await parent.runConcurrentThinkChildrenForTest(3);
    expect(first.filter((r) => r.status === "error")).toHaveLength(1);

    const second = await parent.runConcurrentThinkChildrenForTest(2);
    expect(second.every((r) => r.status === "completed")).toBe(true);
  });

  it("allows unlimited concurrency by default (Infinity)", async () => {
    const parent = await freshParent();
    const results = await parent.runConcurrentThinkChildrenForTest(4);
    expect(results.every((r) => r.status === "completed")).toBe(true);
  });

  it("does not count soft-terminal `interrupted` runs toward the cap", async () => {
    const parent = await freshParent();
    await parent.setMaxConcurrentAgentToolsForTest(1);

    await parent.seedParentAgentToolRunForTest(
      "prior-interrupted",
      "interrupted"
    );

    const result = await parent.runSingleThinkChildForTest();
    expect(result.status).toBe("completed");
  });

  it("DOES count an in-flight `running` run toward the cap", async () => {
    const parent = await freshParent();
    await parent.setMaxConcurrentAgentToolsForTest(1);

    await parent.seedParentAgentToolRunForTest("live-running", "running");

    const result = await parent.runSingleThinkChildForTest();
    expect(result.status).toBe("error");
    expect(result.error).toContain("maxConcurrentAgentTools (1) exceeded");
  });
});
