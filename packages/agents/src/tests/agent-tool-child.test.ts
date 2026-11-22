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
    // Not a run of this parent: the parent's own `onRequest` answers.
    expect(missing).toEqual({
      status: 200,
      body: "parent /agents/x/y/agent-tool-runs/no-such-run/hello"
    });
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

  it("hands a WebSocket upgrade to the child, which owns the socket", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `child-ws-${crypto.randomUUID()}`
    );
    await parent.runDeterministicAgentToolForTest({
      runId: "ws-run",
      chunkBodies: []
    });
    const first = JSON.parse(
      await parent.connectRunChildForTest(
        "agents/test-agent-tool-replay-agent/x/agent-tool-runs/ws-run"
      )
    ) as { type: string; agent?: string };
    // The child's identity frame: the socket is the child's, not the parent's.
    expect(first).toMatchObject({
      type: "cf_agent_identity",
      agent: "test-agent-tool-stub-child"
    });
  });

  it("drills in under a parent whose own name is the route segment", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      "agent-tool-runs"
    );
    const runId = `named-parent-${crypto.randomUUID()}`;
    await parent.runDeterministicAgentToolForTest({ runId, chunkBodies: [] });
    const routed = await parent.fetchPathForTest(
      `agents/test-agent-tool-replay-agent/agent-tool-runs/agent-tool-runs/${runId}/hello`
    );
    expect(routed.status).toBe(200);
    expect(routed.body.split(" ")[2]).toBe("/hello");
  });

  it("leaves the parent's own paths under a name that is the route segment", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      "agent-tool-runs"
    );
    const own = await parent.fetchPathForTest(
      "agents/test-agent-tool-replay-agent/agent-tool-runs/settings"
    );
    expect(own).toEqual({
      status: 200,
      body: "parent /agents/test-agent-tool-replay-agent/agent-tool-runs/settings"
    });
  });

  it("refuses a drill-in to a facet-era run instead of opening the parent", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `facet-era-drill-${crypto.randomUUID()}`
    );
    await parent.seedFinishedFacetEraRunForTest("old-finished");
    const socket = await parent.connectRunChildForTest(
      "agents/test-agent-tool-replay-agent/x/agent-tool-runs/old-finished"
    );
    expect(socket).toBe("no socket (404)");
    const http = await parent.fetchPathForTest(
      "agents/test-agent-tool-replay-agent/x/agent-tool-runs/old-finished/hello"
    );
    expect(http.status).toBe(404);
  });

  it("reaches a live run past a facet-era run of the same segment", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      "agent-tool-runs"
    );
    // A run id equal to the parent's name, from when children were facets.
    await parent.seedFinishedFacetEraRunForTest("agent-tool-runs");
    const runId = `live-${crypto.randomUUID()}`;
    await parent.runDeterministicAgentToolForTest({ runId, chunkBodies: [] });
    const routed = await parent.fetchPathForTest(
      `agents/test-agent-tool-replay-agent/agent-tool-runs/agent-tool-runs/${runId}/hello`
    );
    expect(routed.status).toBe(200);
    expect(routed.body.split(" ")[2]).toBe("/hello");
  });

  it("says a refused run never started, not that it is from an earlier version", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `refused-${crypto.randomUUID()}`
    );
    const result = await parent.runRefusedForTest("refused-run");
    expect(result).toMatchObject({ status: "error" });
    const routed = await parent.fetchPathForTest(
      "agents/test-agent-tool-replay-agent/x/agent-tool-runs/refused-run/hello"
    );
    expect(routed).toEqual({
      status: 404,
      body: "This agent tool run never started, so it has no child"
    });
  });

  it("answers 404 for a run without a child, whatever its child path names", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `unavailable-${crypto.randomUUID()}`
    );
    await parent.seedFinishedFacetEraRunForTest("old-run");
    const live = `live-${crypto.randomUUID()}`;
    await parent.runDeterministicAgentToolForTest({
      runId: live,
      chunkBodies: []
    });
    const routed = await parent.fetchPathForTest(
      `agents/test-agent-tool-replay-agent/x/agent-tool-runs/old-run/agent-tool-runs/${live}/hello`
    );
    expect(routed.status).toBe(404);
  });

  it("names a run an earlier version refused as never started", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `old-refused-${crypto.randomUUID()}`
    );
    await parent.seedOldRefusedRunForTest("old-refused");
    const routed = await parent.fetchPathForTest(
      "agents/test-agent-tool-replay-agent/x/agent-tool-runs/old-refused/hello"
    );
    expect(routed).toEqual({
      status: 404,
      body: "This agent tool run never started, so it has no child"
    });
  });

  it("ends a facet-era run that is only interrupted at startup", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `facet-era-interrupted-${crypto.randomUUID()}`
    );
    expect(
      await parent.recoverOnlyInterruptedFacetEraRunForTest("old-interrupted")
    ).toBe("error");
  });

  it("delivers a facet-era run's onFinish again after it failed", async () => {
    const parent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `facet-era-redeliver-${crypto.randomUUID()}`
    );
    await parent.redeliverFacetEraFinishForTest("old-redeliver");
    const log = await parent.getDetachedDeliveryLog();
    expect(
      log.filter(
        (entry) =>
          entry.runId === "old-redeliver" && entry.hook === "onDetachedDone"
      )
    ).toEqual([
      { hook: "onDetachedDone", runId: "old-redeliver", status: "error" }
    ]);
  });
});
