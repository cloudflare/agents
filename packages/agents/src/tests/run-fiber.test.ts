import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import { subscribe, type ObservabilityEvent } from "../observability";
import type { FiberInspection, FiberRecoveryContext } from "..";
import type { TestRunFiberAgent } from "./agents/run-fiber";

async function waitForFiberStatus(
  agent: {
    inspectManagedFiber(fiberId: string): Promise<FiberInspection | null>;
  },
  fiberId: string,
  status: FiberInspection["status"]
): Promise<FiberInspection> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const inspection = await agent.inspectManagedFiber(fiberId);
    if (inspection?.status === status) {
      return inspection;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const latest = await agent.inspectManagedFiber(fiberId);
  throw new Error(
    `Timed out waiting for fiber ${fiberId} to become ${status}; latest=${latest?.status}`
  );
}

async function freshManagedAgent(name: string): Promise<TestRunFiberAgent> {
  return (await getAgentByName(
    env.TestRunFiberAgent,
    name
  )) as unknown as TestRunFiberAgent;
}

describe("runFiber", () => {
  // ── Basic execution ───────────────────────────────────────────

  describe("execution", () => {
    it("should run a fiber and return the result", async () => {
      const agent = await getAgentByName(env.TestRunFiberAgent, "run-basic");

      const result = (await agent.runSimple("hello")) as unknown as string;
      expect(result).toBe("hello");

      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toContain("executed:hello");
    });

    it("should delete the fiber row on completion", async () => {
      const agent = await getAgentByName(env.TestRunFiberAgent, "run-cleanup");

      await agent.runSimple("cleanup-test");

      const count = (await agent.getRunningFiberCount()) as unknown as number;
      expect(count).toBe(0);
    });

    it("should delete the fiber row on error", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "run-error-cleanup"
      );

      try {
        await agent.runFailing();
      } catch {
        // expected
      }

      const count = (await agent.getRunningFiberCount()) as unknown as number;
      expect(count).toBe(0);
    });

    it("should hold a keepAlive ref during execution", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "run-keepalive"
      );

      // Hold a fiber open via an explicit release signal — avoids racing
      // the assertion against a wall-clock setTimeout in CI.
      await agent.holdFiber("keepalive-test");

      const refs = (await agent.getKeepAliveRefCount()) as unknown as number;
      expect(refs).toBeGreaterThanOrEqual(1);

      // Release the fiber and let the runFiber finally block run dispose().
      await agent.releaseFiber();
      await agent.waitFor(50);

      const refsAfter =
        (await agent.getKeepAliveRefCount()) as unknown as number;
      expect(refsAfter).toBe(0);
    });
  });

  // ── Checkpointing ─────────────────────────────────────────────

  describe("stash", () => {
    it("should checkpoint via ctx.stash()", async () => {
      const agent = await getAgentByName(env.TestRunFiberAgent, "stash-ctx");

      const result = (await agent.runWithCheckpoint([
        "a",
        "b",
        "c"
      ])) as unknown as string[];
      expect(result).toEqual(["a", "b", "c"]);

      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toEqual(["step:a", "step:b", "step:c"]);
    });

    it("should checkpoint via this.stash()", async () => {
      const agent = await getAgentByName(env.TestRunFiberAgent, "stash-this");

      const result = (await agent.runWithThisStash(
        "this-test"
      )) as unknown as string;
      expect(result).toBe("this-test");
    });

    it("should route this.stash() to the correct fiber via ALS with concurrent fibers", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "stash-concurrent-this"
      );

      await agent.runConcurrentWithThisStash();

      await new Promise((r) => setTimeout(r, 300));

      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toContain("this-a-done");
      expect(log).toContain("this-b-done");

      const count = (await agent.getRunningFiberCount()) as unknown as number;
      expect(count).toBe(0);
    });

    it("should apply internal stash wrappers to initial and user checkpoints", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "stash-internal-wrapper"
      );

      const result = (await agent.runWithInternalStashWrapper()) as unknown as {
        initialSnapshot: unknown;
        stashedSnapshot: unknown;
      };

      expect(result.initialSnapshot).toEqual({
        __testFiberSnapshot: { requestId: "initial" },
        user: null
      });
      expect(result.stashedSnapshot).toEqual({
        __testFiberSnapshot: { requestId: "wrapped" },
        user: { user: "checkpoint" }
      });
    });

    it("should not leak an internal stash wrapper into concurrent plain fibers", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "stash-wrapper-concurrent"
      );

      const result =
        (await agent.runWrappedAndPlainConcurrentStash()) as unknown as {
          wrappedSnapshot: unknown;
          plainSnapshot: unknown;
        };

      expect(result.wrappedSnapshot).toEqual({
        __testFiberSnapshot: { requestId: "wrapped" },
        user: { task: "wrapped" }
      });
      expect(result.plainSnapshot).toEqual({ task: "plain" });
    });

    it("should clean up fiber rows when a fiber fails after writing an internal initial snapshot", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "stash-wrapper-initial-then-throw"
      );

      const result =
        (await agent.runWithInitialSnapshotThenThrow()) as unknown as {
          threw: boolean;
          runningFiberCount: number;
        };

      expect(result.threw).toBe(true);
      expect(result.runningFiberCount).toBe(0);

      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toContain("initial-then-throw");
    });

    it("should throw when this.stash() is called outside a fiber", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "stash-outside"
      );

      const error = (await agent.stashOutsideFiber()) as unknown as string;
      expect(error).toBe("stash() called outside a fiber");
    });
  });

  // ── Recovery ──────────────────────────────────────────────────

  describe("recovery", () => {
    it("should detect an interrupted fiber and call onFiberRecovered", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "recovery-basic"
      );

      const before = Date.now();
      // Simulate an interrupted fiber by inserting a row directly
      await agent.insertInterruptedFiber("fiber-1", "research");
      await agent.triggerRecoveryCheck();

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
      expect(recovered.length).toBe(1);
      expect(recovered[0].id).toBe("fiber-1");
      expect(recovered[0].name).toBe("research");
      expect(recovered[0].snapshot).toBeNull();
      expect(recovered[0].recoveryReason).toBe("interrupted");
      expect(typeof recovered[0].createdAt).toBe("number");
      expect(recovered[0].createdAt).toBeGreaterThanOrEqual(before);
      expect(recovered[0].createdAt).toBeLessThanOrEqual(Date.now());
    });

    it("should pass snapshot data to recovery", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "recovery-snapshot"
      );

      await agent.insertInterruptedFiber("fiber-2", "work", {
        step: 3,
        topic: "AI"
      });
      await agent.triggerRecoveryCheck();

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
      expect(recovered.length).toBe(1);
      expect(recovered[0].snapshot).toEqual({ step: 3, topic: "AI" });
    });

    it("should delete the row after recovery", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "recovery-cleanup"
      );

      await agent.insertInterruptedFiber("fiber-3", "cleanup-test");
      await agent.triggerRecoveryCheck();

      const count = (await agent.getRunningFiberCount()) as unknown as number;
      expect(count).toBe(0);
    });

    it("should not recover fibers that are actively running", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "recovery-active"
      );

      // Start a slow fiber (runs for 500ms, creates a row and adds to active set)
      await agent.fireAndForget("active-test");
      await agent.waitFor(100);

      // Trigger recovery — should not recover the active fiber
      await agent.triggerRecoveryCheck();

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
      expect(recovered.length).toBe(0);

      // Wait for the fiber to complete
      await agent.waitFor(600);
    });

    it("should recover multiple interrupted fibers", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "recovery-multiple"
      );

      await agent.insertInterruptedFiber("fiber-a", "task-a", {
        type: "a"
      });
      await agent.insertInterruptedFiber("fiber-b", "task-b", {
        type: "b"
      });
      await agent.triggerRecoveryCheck();

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
      expect(recovered.length).toBe(2);
    });

    it("should not trigger recovery again after rows are cleaned up", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "recovery-once"
      );

      await agent.insertInterruptedFiber("fiber-once", "once");
      await agent.triggerRecoveryCheck();
      await agent.triggerRecoveryCheck();

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
      expect(recovered.length).toBe(1);
    });

    it("retains a fresh unmanaged row when onFiberRecovered throws (retryable)", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "recovery-retain-throw"
      );

      await agent.insertInterruptedFiber(
        "fiber-throw-fresh",
        "unmanaged-recovery-throws"
      );
      await agent.triggerRecoveryCheck();

      // Failed recovery on a fresh unmanaged row is retained so a later scan
      // can retry it.
      const count = (await agent.getRunningFiberCount()) as unknown as number;
      expect(count).toBe(1);
    });

    it("evicts an aged unmanaged row whose recovery keeps throwing", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "recovery-evict-aged"
      );

      const skipped: Array<{ fiberId: string; reason: string }> = [];
      const unsubscribe = subscribe("fiber", (event) => {
        if (event.type === "fiber:recovery:skipped") {
          skipped.push({
            fiberId: event.payload.fiberId,
            reason: event.payload.reason
          });
        }
      });

      try {
        // Older than the 24h default max age.
        await agent.insertAgedInterruptedFiber(
          "fiber-throw-aged",
          "unmanaged-recovery-throws",
          25 * 60 * 60 * 1000
        );
        await agent.triggerRecoveryCheck();
      } finally {
        unsubscribe();
      }

      const count = (await agent.getRunningFiberCount()) as unknown as number;
      expect(count).toBe(0);
      expect(
        skipped.some(
          (s) =>
            s.fiberId === "fiber-throw-aged" && s.reason === "max_age_exceeded"
        )
      ).toBe(true);
    });
  });

  // ── Recovery follow-up alarm (re-arm + backoff) ───────────────
  //
  // Fast, deterministic coverage of the alarm-scheduling behavior that backs
  // multi-pass fiber recovery. These drive `_checkRunFibers` + `_scheduleNextAlarm`
  // directly (no process kill / timers) and inspect the physical alarm, so the
  // starvation re-arm and the exponential backoff are guarded on every PR rather
  // than only by the nightly e2e suite.

  describe("recovery follow-up alarm", () => {
    it("arms a follow-up alarm while a retained recovery row is pending", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "recovery-alarm-rearm"
      );

      // No keepAlive lease, no schedules, no facet runs: the ONLY reason to arm
      // an alarm here is the pending (retained) recovery row. Before the
      // starvation fix `_scheduleNextAlarm` left this null and the orphan
      // starved.
      await agent.insertInterruptedFiber(
        "poison-1",
        "unmanaged-recovery-throws"
      );
      const alarm = await agent.simulateAlarmCycle();

      // Hook threw → row retained, and a follow-up alarm is armed for the retry.
      expect((await agent.getRunningFiberCount()) as unknown as number).toBe(1);
      expect(alarm).not.toBeNull();
      expect((alarm as number) - Date.now()).toBeGreaterThan(0);
    });

    it("backs off exponentially across consecutive no-progress scans", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "recovery-alarm-backoff"
      );

      await agent.insertInterruptedFiber(
        "poison-2",
        "unmanaged-recovery-throws"
      );

      const deltas: number[] = [];
      for (let i = 0; i < 4; i++) {
        const alarm = await agent.simulateAlarmCycle();
        expect(alarm).not.toBeNull();
        deltas.push((alarm as number) - Date.now());
      }

      // Each no-progress cycle roughly doubles the wait (2s base → ~4s, 8s, 16s,
      // 32s), proving the alarm is NOT a flat keepAliveIntervalMs heartbeat.
      expect(deltas[1]).toBeGreaterThan(deltas[0]);
      expect(deltas[2]).toBeGreaterThan(deltas[1]);
      expect(deltas[3]).toBeGreaterThan(deltas[2]);

      // Still retained (never recovered, never aged out within the test) and the
      // streak reflects the four no-progress scans.
      expect((await agent.getRunningFiberCount()) as unknown as number).toBe(1);
      expect(
        (await agent.getRecoveryNoProgressScans()) as unknown as number
      ).toBe(4);
    });

    it("resets the backoff when a scan makes forward progress", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "recovery-alarm-reset"
      );

      // Accrue backoff with a poison row.
      await agent.insertInterruptedFiber(
        "poison-3",
        "unmanaged-recovery-throws"
      );
      await agent.simulateAlarmCycle();
      const beforeAlarm = await agent.simulateAlarmCycle();
      const beforeDelta = (beforeAlarm as number) - Date.now();
      expect(
        (await agent.getRecoveryNoProgressScans()) as unknown as number
      ).toBeGreaterThan(0);

      // A recoverable row that succeeds is forward progress → streak resets, so
      // the next armed wait drops back toward the base interval (the poison row
      // remains pending, so an alarm is still armed — just not backed off).
      await agent.insertInterruptedFiber("good-1", "research");
      const afterAlarm = await agent.simulateAlarmCycle();
      const afterDelta = (afterAlarm as number) - Date.now();

      expect(
        (await agent.getRecoveryNoProgressScans()) as unknown as number
      ).toBe(0);
      expect(afterDelta).toBeLessThan(beforeDelta);
    });

    it("arms no follow-up alarm once recovery has fully drained", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "recovery-alarm-drained"
      );

      // A single recoverable orphan: the scan recovers and deletes it, leaving
      // nothing pending — so no recovery alarm is armed and the DO can idle.
      await agent.insertInterruptedFiber("good-2", "research");
      const alarm = await agent.simulateAlarmCycle();

      expect((await agent.getRunningFiberCount()) as unknown as number).toBe(0);
      expect(alarm).toBeNull();
      expect(
        (await agent.getRecoveryNoProgressScans()) as unknown as number
      ).toBe(0);
    });
  });

  // ── Concurrent fibers ─────────────────────────────────────────

  describe("concurrency", () => {
    it("should run multiple fire-and-forget fibers concurrently", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "concurrent-run"
      );

      await agent.runConcurrent();
      await agent.waitFor(200);

      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toContain("a-done");
      expect(log).toContain("b-done");

      // Both rows should be cleaned up
      const count = (await agent.getRunningFiberCount()) as unknown as number;
      expect(count).toBe(0);
    });
  });

  // ── Error handling ────────────────────────────────────────────

  describe("errors", () => {
    it("should propagate errors to the caller", async () => {
      const agent = await getAgentByName(
        env.TestRunFiberAgent,
        "error-propagate"
      );

      const result = (await agent.runFailing()) as unknown as string;
      expect(result).toBe("error:Intentional error");
    });
  });

  describe("managed fibers", () => {
    it("should accept and complete a managed fiber", async () => {
      const agent = await freshManagedAgent("managed-basic");

      const result = await agent.startManaged("hello", {
        idempotencyKey: "managed-basic"
      });

      expect(result.accepted).toBe(true);
      expect(result.status).toBe("pending");

      const completed = await waitForFiberStatus(
        agent,
        result.fiberId,
        "completed"
      );
      expect(completed.idempotencyKey).toBe("managed-basic");
      expect(completed.metadata).toEqual({ value: "hello" });
      expect(completed.snapshot).toEqual({ value: "hello" });

      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toEqual(["managed:hello"]);
    });

    it("should dedupe managed fibers by idempotency key", async () => {
      const agent = await freshManagedAgent("managed-key");

      const first = await agent.startManaged("first", {
        idempotencyKey: "same-key"
      });
      const second = await agent.startManaged("second", {
        idempotencyKey: "same-key"
      });

      expect(first.accepted).toBe(true);
      expect(second.accepted).toBe(false);
      expect(second.fiberId).toBe(first.fiberId);

      await waitForFiberStatus(agent, first.fiberId, "completed");
      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toEqual(["managed:first"]);
    });

    it("should dedupe managed fibers by explicit fiber id", async () => {
      const agent = await freshManagedAgent("managed-id");

      const first = await agent.startManaged("first", {
        fiberId: "explicit-fiber"
      });
      const second = await agent.startManaged("second", {
        fiberId: "explicit-fiber"
      });

      expect(first.accepted).toBe(true);
      expect(second.accepted).toBe(false);
      expect(second.fiberId).toBe("explicit-fiber");
      await waitForFiberStatus(agent, first.fiberId, "completed");
    });

    it("should reject blank managed fiber identifiers", async () => {
      const agent = await freshManagedAgent("managed-blank-ids");

      await expect(
        agent.startManagedForError("blank-key", {
          idempotencyKey: ""
        })
      ).resolves.toBe("idempotencyKey must not be blank");
      await expect(
        agent.startManagedForError("blank-fiber", {
          fiberId: "  "
        })
      ).resolves.toBe("fiberId must not be blank");
    });

    it("should mark managed fiber errors", async () => {
      const agent = await freshManagedAgent("managed-error");

      const result = await agent.startManagedFailing("managed-error");
      const failed = await waitForFiberStatus(agent, result.fiberId, "error");

      expect(failed.error).toBe("Managed failure");
      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toEqual(["managed-failing"]);
    });

    it("should mark setup failures before the callback as errors", async () => {
      const agent = await freshManagedAgent("managed-setup-failure");

      const result = await agent.startManagedWithRunCollision(
        "managed-collides-with-run"
      );
      const failed = await waitForFiberStatus(agent, result.fiberId, "error");

      expect(failed.error).toContain("UNIQUE constraint failed");
      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).not.toContain("should-not-run");
    });

    it("should wait for newly accepted managed fibers when requested", async () => {
      const agent = await freshManagedAgent("managed-wait-complete");

      const result = await agent.startManagedAndWait("wait", "wait-key");

      expect(result.accepted).toBe(true);
      expect(result.status).toBe("completed");
      await expect(
        agent.inspectManagedFiber(result.fiberId)
      ).resolves.toMatchObject({
        status: "completed",
        snapshot: { value: "wait" }
      });
    });

    it("should join active duplicate managed fibers when waiting", async () => {
      const agent = await freshManagedAgent("managed-wait-join");

      const first = agent.holdManagedAndWait("held", "join-key");
      let active = await agent.inspectManagedFiberByKey("join-key");
      for (
        let attempt = 0;
        attempt < 20 && active?.status !== "running";
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        active = await agent.inspectManagedFiberByKey("join-key");
      }
      expect(active?.status).toBe("running");
      const second = agent.startManagedAndWait("duplicate", "join-key");

      await agent.releaseWaitedManagedFiber();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toMatchObject({
        accepted: true,
        status: "completed"
      });
      expect(secondResult).toMatchObject({
        accepted: false,
        status: "completed",
        fiberId: firstResult.fiberId
      });
      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toEqual(["managed-wait-held:held"]);
    });

    it("should resolve waiters when a managed fiber is cancelled", async () => {
      const agent = await freshManagedAgent("managed-wait-cancel");

      const wait = agent.holdManagedIgnoringCancelAndWait(
        "ignore",
        "ignore-cancel-key"
      );
      let active = await agent.inspectManagedFiberByKey("ignore-cancel-key");
      for (
        let attempt = 0;
        attempt < 20 && active?.status !== "running";
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        active = await agent.inspectManagedFiberByKey("ignore-cancel-key");
      }
      expect(active?.status).toBe("running");
      if (!active) {
        throw new Error("managed fiber was not accepted");
      }

      await expect(
        agent.cancelManagedFiber(active.fiberId, "stop")
      ).resolves.toBe(true);
      await expect(
        Promise.race([
          wait,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("wait did not resolve")), 500)
          )
        ])
      ).resolves.toMatchObject({
        accepted: true,
        status: "aborted",
        fiberId: active.fiberId
      });

      await agent.releaseIgnoredCancelManagedFiber();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(
        agent.inspectManagedFiber(active.fiberId)
      ).resolves.toMatchObject({
        status: "aborted",
        error: "stop"
      });
      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toEqual([
        "managed-wait-ignore-cancel:ignore",
        "managed-wait-ignore-cancel-done:ignore"
      ]);
    });

    it("should return terminal error status when waiting fails", async () => {
      const agent = await freshManagedAgent("managed-wait-error");

      const result = await agent.startManagedFailingAndWait("wait-error-key");

      expect(result).toMatchObject({
        accepted: true,
        status: "error",
        error: "Managed wait failure"
      });
    });

    it("should cancel running managed fibers cooperatively", async () => {
      const agent = await freshManagedAgent("managed-cancel");

      const fiberId = await agent.holdManaged("cancel-me", "cancel-key");
      await waitForFiberStatus(agent, fiberId, "running");

      await expect(agent.cancelManagedFiber(fiberId, "stop")).resolves.toBe(
        true
      );
      const aborted = await waitForFiberStatus(agent, fiberId, "aborted");
      expect(aborted.error).toBe("stop");

      await new Promise((resolve) => setTimeout(resolve, 50));
      const stillAborted = await agent.inspectManagedFiber(fiberId);
      expect(stillAborted?.status).toBe("aborted");
    });

    it("should inspect, list, and delete terminal managed fibers", async () => {
      const agent = await freshManagedAgent("managed-list");

      const result = await agent.startManaged("list", {
        idempotencyKey: "list-key"
      });
      await waitForFiberStatus(agent, result.fiberId, "completed");

      await expect(
        agent.inspectManagedFiberByKey("list-key")
      ).resolves.toMatchObject({
        fiberId: result.fiberId,
        status: "completed"
      });

      const listed = await agent.listManagedFibers({
        status: "completed",
        name: "managed"
      });
      expect(listed.some((fiber) => fiber.fiberId === result.fiberId)).toBe(
        true
      );

      await expect(agent.deleteManagedFibers()).resolves.toBeGreaterThanOrEqual(
        1
      );
      await expect(
        agent.inspectManagedFiber(result.fiberId)
      ).resolves.toBeNull();
    });

    it("should preserve interrupted fibers during default cleanup", async () => {
      const agent = await freshManagedAgent("managed-delete-default");

      const completed = await agent.startManaged("delete-completed", {
        idempotencyKey: "delete-completed-key"
      });
      await waitForFiberStatus(agent, completed.fiberId, "completed");
      await agent.insertInterruptedManagedFiber(
        "delete-interrupted",
        "managed",
        { step: 1 }
      );
      await agent.triggerRecoveryCheck();
      await expect(
        agent.inspectManagedFiber("delete-interrupted")
      ).resolves.toMatchObject({
        status: "interrupted"
      });

      await expect(agent.deleteManagedFibers()).resolves.toBe(1);
      await expect(
        agent.inspectManagedFiber(completed.fiberId)
      ).resolves.toBeNull();
      await expect(
        agent.inspectManagedFiber("delete-interrupted")
      ).resolves.toMatchObject({
        status: "interrupted"
      });

      await expect(agent.deleteInterruptedManagedFibers()).resolves.toBe(1);
      await expect(
        agent.inspectManagedFiber("delete-interrupted")
      ).resolves.toBeNull();
    });

    it("should mark interrupted managed fibers during recovery", async () => {
      const agent = await freshManagedAgent("managed-recovery");

      await agent.insertInterruptedManagedFiber(
        "managed-interrupted",
        "managed",
        {
          step: 1
        }
      );
      await agent.triggerRecoveryCheck();

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
      expect(recovered).toHaveLength(1);
      expect(recovered[0].id).toBe("managed-interrupted");
      expect(recovered[0].idempotencyKey).toBe("key:managed-interrupted");
      expect(recovered[0].metadata).toEqual({ inserted: true });
      expect(recovered[0].status).toBe("interrupted");

      const inspection = await agent.inspectManagedFiber("managed-interrupted");
      expect(inspection).toMatchObject({
        status: "interrupted",
        snapshot: { step: 1 }
      });
    });

    it("should recover pending managed ledger rows without run rows", async () => {
      const agent = await freshManagedAgent("managed-ledger-pending");

      await agent.insertManagedLedgerOnlyFiber(
        "managed-ledger-pending",
        "managed",
        "pending",
        { step: "pending" }
      );
      await agent.triggerRecoveryCheck();

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        id: "managed-ledger-pending",
        status: "interrupted",
        idempotencyKey: "key:managed-ledger-pending",
        metadata: { ledgerOnly: true },
        snapshot: { step: "pending" }
      });
      await expect(
        agent.inspectManagedFiber("managed-ledger-pending")
      ).resolves.toMatchObject({
        status: "interrupted",
        snapshot: { step: "pending" }
      });
    });

    it("should recover running managed ledger rows without run rows", async () => {
      const agent = await freshManagedAgent("managed-ledger-running");

      await agent.insertManagedLedgerOnlyFiber(
        "managed-ledger-running",
        "managed-recovery-complete",
        "running",
        { step: "running" }
      );
      await agent.triggerRecoveryCheck();

      await expect(
        agent.inspectManagedFiber("managed-ledger-running")
      ).resolves.toMatchObject({
        status: "completed",
        snapshot: { recovered: true }
      });
    });

    it("should wait for terminal status when recovery is already running", async () => {
      const agent = await freshManagedAgent("managed-wait-recovery-running");

      await agent.insertInterruptedManagedFiber(
        "managed-recovery-blocker",
        "managed-recovery-block",
        { step: "block" }
      );
      await agent.insertManagedLedgerOnlyFiber(
        "managed-waiting-recovery",
        "managed-recovery-complete",
        "running",
        { step: "waiting" }
      );

      const recovery = agent.triggerRecoveryCheck();
      for (let attempt = 0; attempt < 20; attempt++) {
        const recovered = await agent.getRecoveredFibers();
        if (
          recovered.some((fiber) => fiber.id === "managed-recovery-blocker")
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const waitResult = agent.startManagedAndWait(
        "duplicate",
        "key:managed-waiting-recovery"
      );
      const earlyResult = await Promise.race([
        waitResult.then((result) => result.status),
        new Promise<"still-waiting">((resolve) =>
          setTimeout(() => resolve("still-waiting"), 50)
        )
      ]);
      expect(earlyResult).toBe("still-waiting");

      await agent.releaseBlockedRecovery();
      await recovery;

      await expect(waitResult).resolves.toMatchObject({
        accepted: false,
        status: "completed",
        fiberId: "managed-waiting-recovery"
      });
    });

    it("should not recover terminal managed fibers with stale run rows", async () => {
      const agent = await freshManagedAgent("managed-terminal-recovery");

      await agent.insertAbortedManagedFiberWithRun(
        "managed-aborted",
        "managed",
        {
          step: 1
        }
      );
      await agent.triggerRecoveryCheck();

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
      expect(recovered).toHaveLength(0);
      await expect(
        agent.inspectManagedFiber("managed-aborted")
      ).resolves.toMatchObject({
        status: "aborted",
        error: "cancelled",
        snapshot: { step: 1 }
      });
      await expect(agent.getRunningFiberCount()).resolves.toBe(0);
    });

    it("should apply successful managed recovery outcomes", async () => {
      const agent = await freshManagedAgent("managed-recovery-complete");

      await agent.insertInterruptedManagedFiber(
        "managed-complete",
        "managed-recovery-complete",
        { step: 1 }
      );
      await agent.triggerRecoveryCheck();

      await expect(
        agent.inspectManagedFiber("managed-complete")
      ).resolves.toMatchObject({
        status: "completed",
        snapshot: { recovered: true },
        metadata: { recovered: true }
      });
    });

    it("should resolve interrupted managed fibers outside recovery", async () => {
      const agent = await freshManagedAgent("managed-resolve");

      await agent.insertInterruptedManagedFiber("managed-resolve", "managed", {
        step: 1
      });
      await agent.triggerRecoveryCheck();

      await expect(agent.resolveManagedFiber("managed-resolve")).resolves.toBe(
        true
      );
      await expect(
        agent.inspectManagedFiber("managed-resolve")
      ).resolves.toMatchObject({
        status: "completed",
        snapshot: { resolved: true }
      });
    });

    it("should mark managed fibers as errors when recovery throws", async () => {
      const agent = await freshManagedAgent("managed-recovery-throws");

      await agent.insertInterruptedManagedFiber(
        "managed-throws",
        "managed-recovery-throws",
        { step: 1 }
      );
      await agent.triggerRecoveryCheck();

      await expect(
        agent.inspectManagedFiber("managed-throws")
      ).resolves.toMatchObject({
        status: "error",
        error: "Recovery failed",
        snapshot: { step: 1 }
      });
    });

    it("should emit fiber recovery events when recovery fails", async () => {
      const events: ObservabilityEvent[] = [];
      const unsubscribe = subscribe("fiber", (event) => events.push(event));
      const agent = await freshManagedAgent("managed-recovery-events");

      await agent.insertInterruptedManagedFiber(
        "managed-events",
        "managed-recovery-throws",
        { step: 1 }
      );
      await agent.triggerRecoveryCheck();
      unsubscribe();

      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "fiber:recovery:detected",
          "fiber:recovery:attempt",
          "fiber:recovery:failed"
        ])
      );
      const failed = events.find(
        (event) => event.type === "fiber:recovery:failed"
      );
      expect(failed).toMatchObject({
        payload: {
          fiberId: "managed-events",
          fiberName: "managed-recovery-throws",
          error: "Recovery failed",
          reason: "handler_error"
        }
      });
    });
  });
});
