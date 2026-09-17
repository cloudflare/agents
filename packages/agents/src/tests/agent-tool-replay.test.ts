import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";

/**
 * #1630 follow-up regression: the typed interrupted cause (`reason` /
 * `childStillRunning`) must be PERSISTED, so a client that reconnects and
 * replays a stored `interrupted` run sees the same fields a live client saw.
 * Before the fix the columns did not exist, so replay reconstructed the
 * terminal result with `reason`/`childStillRunning` as `undefined`, silently
 * regressing any UI told (by our docs) to branch on them instead of `error`.
 */
describe("agent-tool interrupted cause survives reconnect replay (#1630)", () => {
  it("persists + replays reason/childStillRunning for a soft no-progress interrupt", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `replay-no-progress-${crypto.randomUUID()}`
    );

    await agent.sealInterruptedRunForTest("run-np", "no-progress");

    // Round-trip through the stored row (the mechanism the bug regressed).
    expect(await agent.readPersistedRunRowForTest("run-np")).toMatchObject({
      status: "interrupted",
      reason: "no-progress",
      childStillRunning: 1
    });

    // The exact wire frames a reconnecting client receives on replay.
    const events = await agent.captureReplayTerminalEventsForTest();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "interrupted",
      runId: "run-np",
      reason: "no-progress",
      childStillRunning: true
    });
  });

  it("persists + replays a torn-down window-exceeded interrupt (childStillRunning false)", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `replay-window-exceeded-${crypto.randomUUID()}`
    );

    await agent.sealInterruptedRunForTest("run-we", "window-exceeded");

    expect(await agent.readPersistedRunRowForTest("run-we")).toMatchObject({
      status: "interrupted",
      reason: "window-exceeded",
      childStillRunning: 0
    });

    const events = await agent.captureReplayTerminalEventsForTest();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "interrupted",
      runId: "run-we",
      reason: "window-exceeded",
      childStillRunning: false
    });
  });

  it("persists + replays a reason without childStillRunning (the reconcile path)", async () => {
    // inspect-* / recovery-deadline seals set `reason` but never
    // `childStillRunning` (the parent never learned the child's state), so the
    // two NULL branches must clear independently.
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `replay-reason-only-${crypto.randomUUID()}`
    );

    await agent.sealInterruptedRunForTest("run-deadline", "inspect-failed");

    expect(
      await agent.readPersistedRunRowForTest("run-deadline")
    ).toMatchObject({
      status: "interrupted",
      reason: "inspect-failed",
      childStillRunning: null
    });

    const events = await agent.captureReplayTerminalEventsForTest();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "interrupted",
      runId: "run-deadline",
      reason: "inspect-failed"
    });
    expect(events[0]).not.toHaveProperty("childStillRunning");
  });

  it("replays a legacy interrupted row (no persisted cause) without crashing", async () => {
    // Rows stranded before the migration have both columns NULL; replay must
    // reconstruct a bare `interrupted` event (falling back to the error prose)
    // rather than fabricate a reason/childStillRunning.
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `replay-legacy-${crypto.randomUUID()}`
    );

    await agent.seedLegacyInterruptedRunForTest("run-legacy");

    expect(await agent.readPersistedRunRowForTest("run-legacy")).toMatchObject({
      status: "interrupted",
      reason: null,
      childStillRunning: null
    });

    const events = await agent.captureReplayTerminalEventsForTest();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "interrupted",
      runId: "run-legacy"
    });
    expect(events[0]).not.toHaveProperty("reason");
    expect(events[0]).not.toHaveProperty("childStillRunning");
  });

  it("clears the persisted cause when a soft interrupt is later repaired to completed", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `replay-repaired-${crypto.randomUUID()}`
    );

    // Soft interrupt first (child left running), then a re-issue whose
    // re-attach collects the child's real terminal result.
    await agent.sealInterruptedRunForTest("run-fix", "no-progress");
    const repaired = await agent.repairRunViaReissueForTest(
      "run-fix",
      "child finished after re-attach"
    );
    expect(repaired).toMatchObject({
      runId: "run-fix",
      status: "completed",
      summary: "child finished after re-attach"
    });

    expect(await agent.readPersistedRunRowForTest("run-fix")).toMatchObject({
      status: "completed",
      summary: "child finished after re-attach",
      // The stale interrupted cause must NOT leak onto the repaired terminal.
      reason: null,
      childStillRunning: null
    });

    const events = await agent.captureReplayTerminalEventsForTest();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "finished", runId: "run-fix" });
    expect(events[0]).not.toHaveProperty("reason");
    expect(events[0]).not.toHaveProperty("childStillRunning");
  });
});
