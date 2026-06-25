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

  it("gives up a silent detached run once its no-progress window elapses (reason: no-progress)", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `detached-no-progress-${crypto.randomUUID()}`
    );

    // Reported progress 5s ago, a 1s no-progress budget, and NO absolute
    // ceiling: the only thing that can trip a give-up is the silence.
    agent.seedDetachedRunWithStaleProgressForTest(
      "run-silent",
      1000,
      Date.now() - 5000
    );
    await agent.detachedReconcileTickForTest();

    expect(await agent.readRunStatusForTest("run-silent")).toBe("interrupted");
    const forRun = (await agent.getDetachedDeliveryLog()).filter(
      (e) => e.runId === "run-silent" && e.hook === "onDetachedDone"
    );
    expect(forRun).toEqual([
      {
        hook: "onDetachedDone",
        runId: "run-silent",
        status: "interrupted",
        reason: "no-progress"
      }
    ]);
  });

  it("does not give up a detached run that is still within its no-progress window", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `detached-progress-fresh-${crypto.randomUUID()}`
    );

    // Reported progress just now with a generous 1h budget: still healthy.
    agent.seedDetachedRunWithStaleProgressForTest(
      "run-fresh",
      60 * 60 * 1000,
      Date.now()
    );
    await agent.detachedReconcileTickForTest();

    expect(await agent.readRunStatusForTest("run-fresh")).toBe("running");
    const forRun = (await agent.getDetachedDeliveryLog()).filter(
      (e) => e.runId === "run-fresh"
    );
    expect(forRun).toEqual([]);
  });

  it("retries finish delivery after a callback failure and lease expiry", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `detached-callback-retry-${crypto.randomUUID()}`
    );

    agent.seedDetachedRunForTest(
      "run-callback-retry",
      undefined,
      undefined,
      "onDetachedFailsOnce"
    );

    await expect(
      agent.deliverFinishCatchingForTest(
        "run-callback-retry",
        "completed",
        "done"
      )
    ).resolves.toBe("detached callback failed once");
    expect(await agent.getDetachedDeliveryLog()).toEqual([
      {
        hook: "onAgentToolFinish",
        runId: "run-callback-retry",
        status: "completed"
      }
    ]);

    // The failed claim is still leased, so an immediate duplicate delivery
    // should not double-fire. Once the lease expires, the backbone may reclaim
    // and retry the callback.
    await agent.deliverFinishForTest("run-callback-retry", "completed", "done");
    expect(await agent.getDetachedDeliveryLog()).toHaveLength(1);

    agent.expireDetachedFinishClaimForTest("run-callback-retry");
    await agent.deliverFinishForTest("run-callback-retry", "completed", "done");

    expect(await agent.getDetachedDeliveryLog()).toEqual([
      {
        hook: "onAgentToolFinish",
        runId: "run-callback-retry",
        status: "completed"
      },
      {
        hook: "onAgentToolFinish",
        runId: "run-callback-retry",
        status: "completed"
      },
      {
        hook: "onDetachedDone",
        runId: "run-callback-retry",
        status: "completed"
      }
    ]);
  });

  it("escalates the detached backbone cadence and caps at the slow end", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `detached-cadence-${crypto.randomUUID()}`
    );

    agent.seedDetachedRunForTest("run-cadence");
    await agent.detachedReconcileTickForTest(0);
    expect(await agent.detachedBackboneSchedulesForTest()).toEqual([
      { delayInSeconds: 15, payload: { cadenceIndex: 1 } }
    ]);

    const capped = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `detached-cadence-cap-${crypto.randomUUID()}`
    );
    capped.seedDetachedRunForTest("run-cadence-cap");
    await capped.detachedReconcileTickForTest(2);
    expect(await capped.detachedBackboneSchedulesForTest()).toEqual([
      { delayInSeconds: 120, payload: { cadenceIndex: 3 } }
    ]);
  });

  it("does not deliver through the detached ledger when cancelling an awaited run", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `awaited-cancel-${crypto.randomUUID()}`
    );

    agent.seedAwaitedRunForTest("run-awaited-cancel");
    await agent.cancelRunForTest("run-awaited-cancel");

    expect(await agent.readRunStatusForTest("run-awaited-cancel")).toBe(
      "running"
    );
    expect(await agent.getDetachedDeliveryLog()).toEqual([]);
  });

  it("persists a caller-controlled notify source for durable completion", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `detached-notify-source-${crypto.randomUUID()}`
    );

    agent.seedDetachedRunForTest(
      "run-notify-source",
      undefined,
      "app-background-task"
    );

    expect(await agent.readRunNotifySourceForTest("run-notify-source")).toBe(
      "app-background-task"
    );
  });

  it("broadcasts a terminal frame when a detached run is cancelled", async () => {
    // Regression: cancel delivers through the ledger without a tail sequence, so
    // the terminal `agent-tool-event` was previously dropped and the
    // background-runs tray never flipped to "cancelled" live.
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `detached-cancel-broadcast-${crypto.randomUUID()}`
    );

    agent.seedDetachedRunForTest("run-cancel-broadcast");
    const events = await agent.captureDeliveryTerminalBroadcastsForTest(
      "cancel",
      "run-cancel-broadcast"
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("aborted");
    expect(events[0].runId).toBe("run-cancel-broadcast");
  });

  it("broadcasts a terminal frame when a detached run is given up", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `detached-giveup-broadcast-${crypto.randomUUID()}`
    );

    agent.seedDetachedRunForTest("run-giveup-broadcast");
    const events = await agent.captureDeliveryTerminalBroadcastsForTest(
      "giveUp",
      "run-giveup-broadcast"
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("interrupted");
    expect(events[0].runId).toBe("run-giveup-broadcast");
  });

  it("collapses a concurrent backbone-arm fan-out to a single schedule", async () => {
    const agent = await getAgentByName(
      env.TestAgentToolReplayAgent,
      `detached-arm-race-${crypto.randomUUID()}`
    );

    agent.seedDetachedRunForTest("run-arm-race");
    const schedules = await agent.armDetachedBackboneConcurrentlyForTest(5);

    expect(schedules).toEqual([
      { delayInSeconds: 5, payload: { cadenceIndex: 0 } }
    ]);
  });
});
