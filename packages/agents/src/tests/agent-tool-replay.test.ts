import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import type { AgentToolEventMessage } from "../agent-tool-types";
import {
  agentToolEventDedupeKey,
  applyAgentToolEvent,
  createAgentToolEventState
} from "../chat/agent-tools";

const textStart = JSON.stringify({ type: "text-start", id: "t" });
const textDelta = (delta: string) =>
  JSON.stringify({ type: "text-delta", id: "t", delta });

/** Reduce frames the way `useAgentToolEvents` does, deduping replay vs live. */
function reduceClient(frames: AgentToolEventMessage[]) {
  const seen = new Set<string>();
  let state = createAgentToolEventState();
  for (const frame of frames) {
    const key = agentToolEventDedupeKey(frame);
    if (seen.has(key)) continue;
    seen.add(key);
    state = applyAgentToolEvent(state, frame);
  }
  return state;
}

function runText(
  state: ReturnType<typeof createAgentToolEventState>,
  runId: string
): string {
  return (state.runsById[runId]?.parts ?? [])
    .map((part) => ("text" in part ? String(part.text) : ""))
    .join("");
}

describe("agent-tool live/replay sequencing", () => {
  it("replay after a mid-stream milestone neither duplicates nor drops text (#2364)", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `replay-milestone-${crypto.randomUUID()}`
    );
    const runId = "run-milestone";
    const { live, replay } = await agent.captureLiveAndReplayForTest({
      runId,
      chunkBodies: [textStart, textDelta("A"), textDelta("B"), textDelta("C")],
      milestones: [{ beforeChunk: 2, name: "halfway" }]
    });

    // The client disconnects right after B, so it misses C live.
    const cut = live.findIndex(
      (frame) =>
        frame.event.kind === "chunk" && frame.event.body === textDelta("B")
    );
    expect(cut).toBeGreaterThan(0);
    const state = reduceClient([...live.slice(0, cut + 1), ...replay]);

    expect(runText(state, runId)).toBe("ABC");
    expect(state.runsById[runId]?.milestones).toHaveLength(1);
    expect(state.runsById[runId]?.status).toBe("completed");
  });

  it("recovery re-attach numbers new chunks after the ones clients already saw", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `reattach-sequence-${crypto.randomUUID()}`
    );
    const runId = "run-reattach";
    const { seen, recovery } = await agent.captureRecoveryReattachForTest({
      runId,
      storedChunkBodies: [textStart, textDelta("A")],
      pendingChunkBodies: [textDelta("B")]
    });

    const state = reduceClient([...seen, ...recovery]);
    expect(runText(state, runId)).toBe("AB");
    expect(state.runsById[runId]?.status).toBe("completed");
  });
});

describe("agent-tool connect-time replay", () => {
  it("reads milestones without asking the child to reconcile its run", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `replay-read-only-${crypto.randomUUID()}`
    );
    const { kinds, inspectReconcile } = await agent.captureConnectReplayForTest(
      { runId: "run-read-only", chunkBodies: [textStart] }
    );

    expect(kinds).toEqual(["started", "chunk", "chunk", "finished"]);
    expect(inspectReconcile).toEqual([false]);
  });

  it(
    "bounds replay when a child's inspection stalls",
    { timeout: 20_000 },
    async () => {
      const agent = await getAgentByName(
        env.TestAgentToolReplayAgent,
        `replay-stalled-inspect-${crypto.randomUUID()}`
      );
      const { elapsedMs, kinds } = await agent.captureConnectReplayForTest({
        runId: "run-stalled",
        chunkBodies: [textStart],
        inspectDelayMs: 8_000
      });

      expect(elapsedMs).toBeLessThan(5_000);
      expect(kinds).toEqual(["started", "chunk", "finished"]);
    }
  );
});

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

    await agent.seedInterruptedRunForTest("run-np", "no-progress", true);

    // Round-trip through the stored row (the mechanism the bug regressed).
    const persisted = await agent.readPersistedResultForTest("run-np");
    expect(persisted).toMatchObject({
      runId: "run-np",
      status: "interrupted",
      reason: "no-progress",
      childStillRunning: true
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

    await agent.seedInterruptedRunForTest("run-we", "window-exceeded", false);

    const persisted = await agent.readPersistedResultForTest("run-we");
    expect(persisted).toMatchObject({
      runId: "run-we",
      status: "interrupted",
      reason: "window-exceeded",
      childStillRunning: false
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
    // recovery-deadline / inspect-* / not-tailable seals set `reason` but never
    // `childStillRunning`, so the two NULL branches must clear independently.
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `replay-reason-only-${crypto.randomUUID()}`
    );

    await agent.seedInterruptedRunForTest("run-deadline", "recovery-deadline");

    const persisted = await agent.readPersistedResultForTest("run-deadline");
    expect(persisted).toMatchObject({
      runId: "run-deadline",
      status: "interrupted",
      reason: "recovery-deadline"
    });
    expect(persisted).not.toHaveProperty("childStillRunning");

    const events = await agent.captureReplayTerminalEventsForTest();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "interrupted",
      runId: "run-deadline",
      reason: "recovery-deadline"
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

    await agent.seedInterruptedRunForTest("run-legacy");

    const persisted = await agent.readPersistedResultForTest("run-legacy");
    expect(persisted).toMatchObject({
      runId: "run-legacy",
      status: "interrupted"
    });
    expect(persisted).not.toHaveProperty("reason");
    expect(persisted).not.toHaveProperty("childStillRunning");

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

    // Soft interrupt first (child left running), then a re-attach collects it.
    await agent.seedInterruptedRunForTest("run-fix", "no-progress", true);
    await agent.completeRunForTest("run-fix", "child finished after re-attach");

    const persisted = await agent.readPersistedResultForTest("run-fix");
    expect(persisted).toMatchObject({
      runId: "run-fix",
      status: "completed",
      summary: "child finished after re-attach"
    });
    // The stale interrupted cause must NOT leak onto the repaired terminal.
    expect(persisted).not.toHaveProperty("reason");
    expect(persisted).not.toHaveProperty("childStillRunning");

    const events = await agent.captureReplayTerminalEventsForTest();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "finished", runId: "run-fix" });
    expect(events[0]).not.toHaveProperty("reason");
    expect(events[0]).not.toHaveProperty("childStillRunning");
  });
});
