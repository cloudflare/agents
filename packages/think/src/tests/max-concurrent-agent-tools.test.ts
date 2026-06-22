import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkAgentToolParent } from "./agents";

type ConcurrencyStub = {
  setMaxConcurrentAgentToolsForTest(limit: number): Promise<void>;
  runConcurrentThinkChildrenForTest(
    count: number
  ): Promise<Array<{ runId: string; status: string; error?: string }>>;
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
    // Exactly one launch exceeds the cap of 2 in-flight runs.
    expect(errored).toHaveLength(1);
    expect(completed).toHaveLength(2);
    expect(errored[0]?.error).toContain("maxConcurrentAgentTools (2) exceeded");
  });

  it("allows the rejected slot to be reused once a run settles", async () => {
    const parent = await freshParent();
    await parent.setMaxConcurrentAgentToolsForTest(2);

    // First batch fills + overflows the cap (1 reject).
    const first = await parent.runConcurrentThinkChildrenForTest(3);
    expect(first.filter((r) => r.status === "error")).toHaveLength(1);

    // After the first batch settles, the cap is free again — a fresh batch of 2
    // runs both complete (no stale "still running" rows holding the slots).
    const second = await parent.runConcurrentThinkChildrenForTest(2);
    expect(second.every((r) => r.status === "completed")).toBe(true);
  });

  it("allows unlimited concurrency by default (Infinity)", async () => {
    const parent = await freshParent();
    const results = await parent.runConcurrentThinkChildrenForTest(4);
    expect(results.every((r) => r.status === "completed")).toBe(true);
  });
});
