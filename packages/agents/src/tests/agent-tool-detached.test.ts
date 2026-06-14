import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";

/**
 * Detached ("background") agent-tool delivery ledger (#1752).
 *
 * These exercise the two-slot claim+lease delivery funnel directly (via the
 * test agent's internals helpers) — the crux of the reporter's production
 * incidents:
 *  - delivery is exactly-once on the happy path (a fast-path push racing a
 *    backbone tick must fire the hook once), and
 *  - give-up and finish are INDEPENDENT slots, so a premature budget give-up
 *    can never dedupe a child's real late completion away.
 *
 * They also confirm the ledger's guarded CAS (`UPDATE ... RETURNING`) works on
 * the Workers SQLite runtime.
 */
describe("detached agent-tool delivery (#1752)", () => {
  it("fires onFinish (and the global hook) exactly once on terminal", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `detached-once-${crypto.randomUUID()}`
    );

    agent.seedDetachedRunForTest("run-once");
    await agent.deliverFinishForTest("run-once", "completed", "done");
    // A second delivery (e.g. the durable backbone after the warm fast path
    // already delivered) must be a no-op — the slot is already delivered.
    await agent.deliverFinishForTest("run-once", "completed", "done again");

    const log = await agent.getDetachedDeliveryLog();
    const forRun = log.filter((e) => e.runId === "run-once");
    expect(forRun).toEqual([
      { hook: "onAgentToolFinish", runId: "run-once", status: "completed" },
      { hook: "onDetachedDone", runId: "run-once", status: "completed" }
    ]);
    expect(await agent.readRunStatusForTest("run-once")).toBe("completed");
  });

  it("dedupes concurrent deliveries to a single fire (the fast-path vs backbone race)", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `detached-race-${crypto.randomUUID()}`
    );

    agent.seedDetachedRunForTest("run-race");
    await Promise.all([
      agent.deliverFinishForTest("run-race", "completed", "a"),
      agent.deliverFinishForTest("run-race", "completed", "b")
    ]);

    const onDone = (await agent.getDetachedDeliveryLog()).filter(
      (e) => e.runId === "run-race" && e.hook === "onDetachedDone"
    );
    expect(onDone).toHaveLength(1);
  });

  it("delivers a give-up AND a later real completion (two independent slots)", async () => {
    // The exact #1752 incident: a premature give-up must not consume the
    // success delivery's slot. `interrupted` is soft, so a child that completes
    // after the give-up still repairs the row and re-fires onFinish.
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `detached-giveup-${crypto.randomUUID()}`
    );

    agent.seedDetachedRunForTest("run-giveup");
    await agent.deliverGiveUpForTest("run-giveup");
    expect(await agent.readRunStatusForTest("run-giveup")).toBe("interrupted");

    // The child actually finished after we gave up — the finish slot is still
    // open, so the real result is delivered and the row is repaired.
    await agent.deliverFinishForTest("run-giveup", "completed", "late finish");
    expect(await agent.readRunStatusForTest("run-giveup")).toBe("completed");

    const forRun = (await agent.getDetachedDeliveryLog()).filter(
      (e) => e.runId === "run-giveup" && e.hook === "onDetachedDone"
    );
    expect(forRun).toEqual([
      {
        hook: "onDetachedDone",
        runId: "run-giveup",
        status: "interrupted",
        reason: "budget-exceeded"
      },
      { hook: "onDetachedDone", runId: "run-giveup", status: "completed" }
    ]);
  });

  it("does not re-deliver a give-up twice", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `detached-giveup-dedupe-${crypto.randomUUID()}`
    );

    agent.seedDetachedRunForTest("run-gd");
    await agent.deliverGiveUpForTest("run-gd");
    await agent.deliverGiveUpForTest("run-gd");

    const giveUps = (await agent.getDetachedDeliveryLog()).filter(
      (e) => e.runId === "run-gd" && e.hook === "onDetachedDone"
    );
    expect(giveUps).toHaveLength(1);
  });
});
