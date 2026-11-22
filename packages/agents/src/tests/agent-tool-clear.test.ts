import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";

describe("clearing agent-tool runs: shared childName", () => {
  it("clearing one run leaves a child that another run shares", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `shared-child-${crypto.randomUUID()}`
    );
    const childName = `shared-${crypto.randomUUID()}`;
    await parent.runSharedChildForTest({ runId: "old", childName });
    await new Promise((r) => setTimeout(r, 20));
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    await parent.runSharedChildForTest({ runId: "new", childName });

    await parent.clearAgentToolRunsForTest({ olderThan: cutoff });

    const child = await getAgentByName(env.TestAgentToolStubChild, childName);
    // "new" is still retained by the parent and lives on this child.
    expect(await child.destroyPendingForTest()).toBeNull();
  });
});

describe("clearing agent-tool runs: a facet-era run", () => {
  it("deletes the facet child it retained", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `facet-clear-${crypto.randomUUID()}`
    );
    expect(await parent.clearFacetEraRunForTest("old-facet-run")).toBe(false);
  });
});

describe("clearing agent-tool runs: the child's own runs and open work", () => {
  it("asks a child it destroys to clear its own runs first", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `clear-nested-${crypto.randomUUID()}`
    );
    expect(await parent.clearAsksChildToClearForTest("nested-run")).toBe(true);
  });

  it("cancels an interrupted run whose child is still working", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `clear-interrupted-${crypto.randomUUID()}`
    );
    expect(
      await parent.clearCancelsInterruptedRunForTest("interrupted-run")
    ).toBe("aborted");
  });
});
