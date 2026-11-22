import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";

/**
 * The child of an agent-tool run is an ordinary Durable Object of its
 * class, under a name the parent mints with the run row.
 */
describe("agent-tool run child", () => {
  it("is an ordinary Durable Object reached through the parent's route", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `child-route-${crypto.randomUUID()}`
    );
    const result = await parent.runDeterministicAgentToolForTest({
      runId: "routed-run",
      chunkBodies: [JSON.stringify({ type: "text-start", id: "t" })],
      summary: "done"
    });
    expect(result).toMatchObject({ status: "completed" });

    const routed = await parent.fetchRunChildForTest(
      "agent-tool-runs/routed-run/hello"
    );
    expect(routed.status).toBe(200);
    const [, childName, path] = routed.body.split(" ");
    expect(path).toBe("/hello");
    // The name is minted, not the run id, so only the parent reaches it.
    expect(childName).not.toBe("routed-run");
    expect(childName).toMatch(/^[0-9a-f-]{36}$/);

    // The same child, reached directly by its name.
    const direct = await getAgentByName(env.TestAgentToolStubChild, childName);
    const inspection = await direct.inspectAgentToolRun("routed-run");
    expect(inspection).toMatchObject({ status: "completed" });

    const missing = await parent.fetchRunChildForTest(
      "agent-tool-runs/no-such-run/hello"
    );
    expect(missing.status).toBe(404);
  });

  it("ends open runs from when the child was a facet with an error the parent sees", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `facet-era-${crypto.randomUUID()}`
    );
    const { rows, events } = await parent.recoverFacetEraRunsForTest({
      awaited: "a-awaited",
      detached: "b-detached"
    });

    expect(rows.map((row) => row.status)).toEqual(["error", "error"]);
    for (const row of rows) {
      expect(row.error).toContain("earlier version");
    }
    expect(
      events
        .filter((message) => message.event.kind === "error")
        .map((message) => message.event.runId)
        .sort()
    ).toEqual(["a-awaited", "b-detached"]);

    const log = await parent.getDetachedDeliveryLog();
    expect(log).toEqual(
      expect.arrayContaining([
        { hook: "onAgentToolFinish", runId: "a-awaited", status: "error" },
        { hook: "onAgentToolFinish", runId: "b-detached", status: "error" },
        { hook: "onDetachedDone", runId: "b-detached", status: "error" }
      ])
    );
  });

  it("returns an error when a facet-era run id is run again", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `facet-era-reissue-${crypto.randomUUID()}`
    );
    const result = await parent.reissueFacetEraRunForTest("old-run");
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("earlier version")
    });
  });

  it("adds the child name column to a run table from schema version 14", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `schema-14-${crypto.randomUUID()}`
    );
    expect(await parent.migrateRunTableFromVersion14ForTest()).toBe(true);
  });

  it("destroys a minted child with its last run, and never a named one", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `clear-children-${crypto.randomUUID()}`
    );
    await parent.runDeterministicAgentToolForTest({
      runId: "minted-run",
      chunkBodies: []
    });
    const routed = await parent.fetchRunChildForTest(
      "agent-tool-runs/minted-run/"
    );
    const mintedName = routed.body.split(" ")[1];
    const namedChild = `named-${crypto.randomUUID()}`;
    await parent.runSharedChildForTest({
      runId: "named-run",
      childName: namedChild
    });

    await parent.clearAgentToolRunsForTest({ olderThan: Date.now() + 1 });

    const minted = await getAgentByName(env.TestAgentToolStubChild, mintedName);
    expect(await minted.destroyPendingForTest()).not.toBeNull();
    const named = await getAgentByName(env.TestAgentToolStubChild, namedChild);
    expect(await named.destroyPendingForTest()).toBeNull();
  });
});
