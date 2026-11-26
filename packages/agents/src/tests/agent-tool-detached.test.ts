import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";

async function parent(label: string) {
  return getAgentByName(
    env.TestAgentToolReplayAgent,
    `${label}-${crypto.randomUUID()}`
  );
}

type Log = Awaited<
  ReturnType<Awaited<ReturnType<typeof parent>>["getDetachedDeliveryLog"]>
>;

function statuses(log: Log, runId: string, hook = "onDetachedDone") {
  return log
    .filter((entry) => entry.runId === runId && entry.hook === hook)
    .map((entry) => entry.status);
}

describe("detached agent-tool runs on Tasks", () => {
  it("delivers a child's terminal once: the global hook and onFinish", async () => {
    const agent = await parent("detached-once");
    expect(
      await agent.startDetachedForTest("run-once", {
        chunkBodies: [],
        summary: "done"
      })
    ).toEqual({ status: "running" });
    // `runAgentTool` never delivers itself; the run's next check does.
    expect(await agent.checkDetachedForTest("run-once")).toEqual({
      status: "completed"
    });
    const log = await agent.getDetachedDeliveryLog();
    expect(statuses(log, "run-once")).toEqual(["completed"]);
    expect(statuses(log, "run-once", "onAgentToolFinish")).toEqual([
      "completed"
    ]);
  });

  it("re-dispatching the same run id starts nothing and delivers once", async () => {
    const agent = await parent("detached-redispatch");
    await agent.startDetachedForTest("run-again", {
      chunkBodies: [],
      staysRunning: true
    });
    expect(
      await agent.startDetachedForTest("run-again", {
        chunkBodies: [],
        summary: "must not run"
      })
    ).toEqual({ status: "running" });
    await agent.finishChildForTest("run-again", "completes");
    expect((await agent.checkDetachedForTest("run-again")).status).toBe(
      "completed"
    );
    expect(statuses(await agent.getDetachedDeliveryLog(), "run-again")).toEqual(
      ["completed"]
    );
  });

  it("waits for a running child, checking on the backbone's cadence", async () => {
    const agent = await parent("detached-cadence");
    await agent.startDetachedForTest("run-wait", {
      chunkBodies: [],
      staysRunning: true
    });
    const waits: number[] = [];
    for (let check = 0; check < 5; check++) {
      const state = await agent.checkDetachedForTest("run-wait");
      expect(state).toMatchObject({ status: "pending", waitReason: "park" });
      waits.push(Math.round((state.nextInMs ?? 0) / 1000));
    }
    // Escalates and caps at the slow end (5, 15, 30, 120 s).
    expect(waits.every((wait, i) => i === 0 || wait >= waits[i - 1])).toBe(
      true
    );
    expect(waits.at(-1)).toBe(120);
    expect(await agent.getDetachedDeliveryLog()).toEqual([]);
  });

  it("gives up past its budget, tears the child down, and delivers the give-up once (#2768)", async () => {
    const agent = await parent("detached-give-up");
    await agent.startDetachedForTest(
      "run-budget",
      { chunkBodies: [], staysRunning: true },
      { maxBudgetMs: 1 }
    );
    expect((await agent.checkDetachedForTest("run-budget")).status).toBe(
      "completed"
    );
    // The child's abort from the give-up's own cancel is not a second finish.
    await agent.checkDetachedForTest("run-budget");
    const log = await agent.getDetachedDeliveryLog();
    expect(
      log.filter(
        (entry) =>
          entry.runId === "run-budget" && entry.hook === "onDetachedDone"
      )
    ).toEqual([
      {
        hook: "onDetachedDone",
        runId: "run-budget",
        status: "interrupted",
        reason: "budget-exceeded"
      }
    ]);
    expect(statuses(log, "run-budget", "onAgentToolFinish")).toEqual([
      "interrupted"
    ]);
  });

  it("delivers a give-up AND a later real completion when the teardown is unconfirmed (#1752)", async () => {
    const agent = await parent("detached-two-slots");
    await agent.startDetachedForTest(
      "run-late",
      { chunkBodies: [], staysRunning: true, cancelFails: true },
      { maxBudgetMs: 1 }
    );
    expect(await agent.checkDetachedForTest("run-late")).toMatchObject({
      status: "pending",
      waitReason: "park"
    });
    await agent.finishChildForTest("run-late", "completes");
    expect((await agent.checkDetachedForTest("run-late")).status).toBe(
      "completed"
    );
    expect(statuses(await agent.getDetachedDeliveryLog(), "run-late")).toEqual([
      "interrupted",
      "completed"
    ]);
  });

  it("replays an unconfirmed give-up to a reconnecting client while it follows the child", async () => {
    const agent = await parent("detached-gave-up-replay");
    await agent.startDetachedForTest(
      "run-gave-up-replay",
      { chunkBodies: [], staysRunning: true, cancelFails: true },
      { maxBudgetMs: 1 }
    );
    expect(
      await agent.checkDetachedForTest("run-gave-up-replay")
    ).toMatchObject({ status: "pending", waitReason: "park" });
    const replay = await agent.captureReplayTerminalEventsForTest();
    expect(
      replay.filter(
        (event) => "runId" in event && event.runId === "run-gave-up-replay"
      )
    ).toEqual([
      expect.objectContaining({
        kind: "interrupted",
        reason: "budget-exceeded"
      })
    ]);
  });

  it("settles an unconfirmed give-up once a later check reads the give-up's own abort (#2769)", async () => {
    const agent = await parent("detached-unconfirmed");
    await agent.startDetachedForTest(
      "run-unconfirmed",
      { chunkBodies: [], staysRunning: true, cancelFails: true },
      { maxBudgetMs: 1 }
    );
    await agent.checkDetachedForTest("run-unconfirmed");
    // The cancel had landed after all: the child is aborted with the
    // give-up's reason.
    await agent.abortChildWithGiveUpReasonForTest("run-unconfirmed");
    expect((await agent.checkDetachedForTest("run-unconfirmed")).status).toBe(
      "completed"
    );
    expect(
      statuses(await agent.getDetachedDeliveryLog(), "run-unconfirmed")
    ).toEqual(["interrupted"]);
  });

  it("delivers the real result when the child finishes before the give-up's cancel lands (#2768)", async () => {
    const agent = await parent("detached-race");
    await agent.startDetachedForTest("run-race", {
      chunkBodies: [],
      staysRunning: true,
      summary: "real result"
    });
    await agent.checkWithChildBeforeCancelForTest("run-race", "completes");
    await agent.detachedStateForTest("run-race");
    expect(statuses(await agent.getDetachedDeliveryLog(), "run-race")).toEqual([
      "completed"
    ]);
  });

  it("delivers the child's own abort when it is stopped before the give-up's cancel lands (#2769)", async () => {
    const agent = await parent("detached-stopped");
    await agent.startDetachedForTest("run-stopped", {
      chunkBodies: [],
      staysRunning: true
    });
    await agent.checkWithChildBeforeCancelForTest("run-stopped", "is stopped");
    await agent.detachedStateForTest("run-stopped");
    expect(
      statuses(await agent.getDetachedDeliveryLog(), "run-stopped")
    ).toEqual(["aborted"]);
  });

  it("delivers a milestone only the post-cancel inspection reports (#2768)", async () => {
    const agent = await parent("detached-milestone");
    await agent.startDetachedForTest(
      "run-ms",
      { chunkBodies: [], staysRunning: true },
      { onMilestones: ["sources-gathered"] }
    );
    await agent.checkWithChildBeforeCancelForTest(
      "run-ms",
      "milestone and completes"
    );
    await agent.detachedStateForTest("run-ms");
    expect(await agent.getDetachedMilestonesForTest("run-ms")).toEqual([
      "sources-gathered"
    ]);
    expect(statuses(await agent.getDetachedDeliveryLog(), "run-ms")).toEqual([
      "completed"
    ]);
  });

  it("gives up on a child that never signals once its no-progress window passes (#2467)", async () => {
    const agent = await parent("detached-no-progress");
    await agent.startDetachedForTest(
      "run-silent",
      { chunkBodies: [], staysRunning: true },
      { noProgressBudgetMs: 1 }
    );
    expect((await agent.checkDetachedForTest("run-silent")).status).toBe(
      "completed"
    );
    const log = await agent.getDetachedDeliveryLog();
    expect(
      log.find(
        (entry) =>
          entry.runId === "run-silent" && entry.hook === "onDetachedDone"
      )
    ).toMatchObject({ status: "interrupted", reason: "no-progress" });
  });

  it("does not give up on a child within its no-progress window", async () => {
    const agent = await parent("detached-within-window");
    await agent.startDetachedForTest(
      "run-patient",
      { chunkBodies: [], staysRunning: true },
      { noProgressBudgetMs: 60_000 }
    );
    expect(await agent.checkDetachedForTest("run-patient")).toMatchObject({
      status: "pending",
      waitReason: "park"
    });
    expect(await agent.getDetachedDeliveryLog()).toEqual([]);
  });

  it("checks first at its no-progress deadline when that comes before the cadence", async () => {
    const agent = await parent("detached-short-window");
    await agent.startDetachedForTest(
      "run-short",
      { chunkBodies: [], staysRunning: true, tailHangs: true },
      { noProgressBudgetMs: 1_000 }
    );
    const first = await agent.detachedStateForTest("run-short");
    expect(first).toMatchObject({ status: "pending", waitReason: "park" });
    expect(first.nextInMs).toBeLessThanOrEqual(1_000);
  });

  it("keeps to the cadence with the no-progress window off (0)", async () => {
    const agent = await parent("detached-window-off");
    await agent.startDetachedForTest(
      "run-window-off",
      { chunkBodies: [], staysRunning: true },
      { noProgressBudgetMs: 0 }
    );
    const state = await agent.checkDetachedForTest("run-window-off");
    expect(state).toMatchObject({ status: "pending", waitReason: "park" });
    expect(state.nextInMs).toBeGreaterThan(1_000);
    expect(await agent.getDetachedDeliveryLog()).toEqual([]);
  });

  it("keeps to the cadence after a give-up whose teardown is unconfirmed", async () => {
    const agent = await parent("detached-gave-up-cadence");
    await agent.startDetachedForTest(
      "run-gave-up",
      { chunkBodies: [], staysRunning: true, cancelFails: true },
      { maxBudgetMs: 1 }
    );
    const state = await agent.checkDetachedForTest("run-gave-up");
    expect(state).toMatchObject({ status: "pending", waitReason: "park" });
    expect(state.nextInMs).toBeGreaterThan(1_000);
  });

  it("settles a run whose output is too large for a Task value, delivering once", async () => {
    const agent = await parent("detached-large-output");
    await agent.startDetachedForTest("run-large", {
      chunkBodies: [],
      summary: "large",
      output: "x".repeat(1_200_000)
    });
    expect((await agent.checkDetachedForTest("run-large")).status).toBe(
      "completed"
    );
    const log = await agent.getDetachedDeliveryLog();
    expect(statuses(log, "run-large")).toEqual(["completed"]);
    expect(statuses(log, "run-large", "onAgentToolFinish")).toEqual([
      "completed"
    ]);
  });

  it("delivers a finish again after its callback failed once", async () => {
    const agent = await parent("detached-finish-retry");
    await agent.startDetachedForTest(
      "run-retry",
      { chunkBodies: [], summary: "done" },
      { onFinish: "onDetachedFailsOnce" }
    );
    // The check's delivery failed: the run waits to deliver again.
    expect(await agent.checkDetachedForTest("run-retry")).toMatchObject({
      status: "pending",
      waitReason: "park"
    });
    expect((await agent.checkDetachedForTest("run-retry")).status).toBe(
      "completed"
    );
    expect(statuses(await agent.getDetachedDeliveryLog(), "run-retry")).toEqual(
      ["completed"]
    );
  });

  it("gives up again after a give-up callback failed, not delivering the abort it caused (#2769)", async () => {
    const agent = await parent("detached-give-up-retry");
    await agent.startDetachedForTest(
      "run-give-up-retry",
      { chunkBodies: [], staysRunning: true },
      { maxBudgetMs: 1, onFinish: "onDetachedFailsOnce" }
    );
    // The first check gave up and its callback failed: it waits to give up
    // again, instead of delivering the abort its cancel caused.
    expect(await agent.checkDetachedForTest("run-give-up-retry")).toMatchObject(
      { status: "pending", waitReason: "park" }
    );
    expect((await agent.checkDetachedForTest("run-give-up-retry")).status).toBe(
      "completed"
    );
    expect(
      statuses(await agent.getDetachedDeliveryLog(), "run-give-up-retry")
    ).toEqual(["interrupted"]);
  });

  it("ends a cancelled detached run aborted and delivers it once, with its terminal frame", async () => {
    const agent = await parent("detached-cancel");
    await agent.startDetachedForTest("run-cancel", {
      chunkBodies: [],
      staysRunning: true
    });
    const frames = await agent.captureTerminalBroadcastsForTest(
      "run-cancel",
      "cancel"
    );
    expect(frames).toEqual([
      expect.objectContaining({ kind: "aborted", runId: "run-cancel" })
    ]);
    expect(
      statuses(await agent.getDetachedDeliveryLog(), "run-cancel")
    ).toEqual(["aborted"]);
  });

  it("broadcasts a terminal frame when a detached run is given up", async () => {
    const agent = await parent("detached-give-up-frame");
    await agent.startDetachedForTest("run-frame", {
      chunkBodies: [],
      staysRunning: true
    });
    await agent.expireDetachedBudgetForTest("run-frame");
    const frames = await agent.captureTerminalBroadcastsForTest(
      "run-frame",
      "check"
    );
    expect(frames).toEqual([
      expect.objectContaining({ kind: "interrupted", runId: "run-frame" })
    ]);
  });

  it("hands the notify source to the delivery", async () => {
    const agent = await parent("detached-notify-source");
    await agent.startDetachedForTest(
      "run-notify",
      { chunkBodies: [], summary: "done" },
      { notify: { source: "tray" } }
    );
    await agent.checkDetachedForTest("run-notify");
    expect(await agent.getDeliveredNotifySourcesForTest("run-notify")).toEqual([
      "tray"
    ]);
  });

  it("never waits on a chat lane from a run's report: a check delivers serialized, a report only unserialized", async () => {
    const agent = await parent("detached-delivery-context");
    await agent.watchDetachedReportsForTest();
    await agent.startDetachedForTest("run-checked", {
      chunkBodies: [],
      summary: "done"
    });
    await agent.checkDetachedForTest("run-checked");
    await agent.startDetachedForTest("run-cancelled", {
      chunkBodies: [],
      staysRunning: true
    });
    await agent.cancelRunForTest("run-cancelled");
    await agent.detachedStateForTest("run-cancelled");
    // A report can run inside a job with no dispatch budget: what it
    // delivers must not wait behind the chat lane.
    expect(await agent.getDetachedDeliveryContextsForTest()).toEqual([
      { serialize: true, inReport: false },
      { serialize: false, inReport: true }
    ]);
  });

  it("does not deliver to a detached onFinish when an awaited run is cancelled", async () => {
    const agent = await parent("detached-awaited-cancel");
    await agent.runDeterministicAgentToolForTest({
      runId: "run-awaited",
      chunkBodies: []
    });
    await agent.cancelRunForTest("run-awaited");
    expect(
      statuses(await agent.getDetachedDeliveryLog(), "run-awaited")
    ).toEqual([]);
  });
});

describe("detached agent-tool runs a released version left", () => {
  it("delivers the outcome a released version recorded but had not delivered, with its child gone", async () => {
    const agent = await parent("detached-owed-no-child");
    await agent.carryForwardReleasedOwedWithoutChildForTest(
      "released-owed-gone"
    );
    expect(
      (await agent.checkDetachedForTest("released-owed-gone")).status
    ).toBe("completed");
    expect(
      statuses(await agent.getDetachedDeliveryLog(), "released-owed-gone")
    ).toEqual(["completed"]);
  });

  it("in a facet carries the rows and empties the table instead of dropping it", async () => {
    const agent = await parent("facet-carry");
    expect(
      await agent.carryForwardReleasedInFacetForTest("facet-carry-child")
    ).toEqual({ tableRows: 0, status: "completed" });
  });

  it("carries every ledger state into task runs, drops the table, and cancels the backbone's schedule", async () => {
    const agent = await parent("detached-carry");
    await agent.seedReleasedDetachedRowsForTest();
    const {
      statuses: carried,
      tableLeft,
      legacySchedules
    } = await agent.carryForwardReleasedDetachedForTest();
    expect(carried).toEqual({
      "released-delivered": "completed",
      "released-owed": "running",
      "released-open": "running",
      "released-torn-down": "completed",
      "released-may-run": "running"
    });
    expect(tableLeft).toBe(false);
    expect(legacySchedules).toBe(0);

    // What is owed is delivered once; what went out is not sent again.
    for (const runId of [
      "released-owed",
      "released-open",
      "released-may-run"
    ]) {
      await agent.checkDetachedForTest(runId);
    }
    const log = await agent.getDetachedDeliveryLog();
    expect(statuses(log, "released-delivered")).toEqual([]);
    expect(statuses(log, "released-torn-down")).toEqual([]);
    expect(statuses(log, "released-owed")).toEqual(["completed"]);
    expect(statuses(log, "released-open")).toEqual(["completed"]);
    // Its give-up went out before the upgrade: it waits for the child.
    expect(statuses(log, "released-may-run")).toEqual([]);
  });
});
