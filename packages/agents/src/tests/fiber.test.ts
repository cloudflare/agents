import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName } from "..";
import type { FiberState } from "../experimental/forever";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

type CompletedFiberInfo = {
  id: string;
  methodName: string;
  result: unknown;
};

type RecoveredFiberInfo = {
  id: string;
  methodName: string;
  snapshot: unknown;
  retryCount: number;
};

describe("fiber operations", () => {
  // ── keepAlive ──────────────────────────────────────────────────────

  describe("keepAlive", () => {
    it("should increment and decrement the keep-alive counter", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "keepalive-counter"
      );

      expect((await agent.getKeepAliveCount()) as unknown as number).toBe(0);

      await agent.startKeepAlive();
      expect((await agent.getKeepAliveCount()) as unknown as number).toBe(1);

      await agent.stopKeepAlive();
      expect((await agent.getKeepAliveCount()) as unknown as number).toBe(0);
    });

    it("should handle multiple keepAlive callers", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "keepalive-multiple"
      );

      await agent.startKeepAlive();
      await agent.startKeepAlive();
      // startKeepAlive stores only the latest disposer, but count tracks both
      expect((await agent.getKeepAliveCount()) as unknown as number).toBe(2);

      await agent.stopKeepAlive();
      // Only the latest disposer gets called
      expect((await agent.getKeepAliveCount()) as unknown as number).toBe(1);
    });
  });

  // ── spawnFiber + basic execution ───────────────────────────────────

  describe("spawnFiber", () => {
    it("should spawn a fiber and execute the method", async () => {
      const agent = await getAgentByName(env.TestFiberAgent, "spawn-basic");

      const fiberId = (await agent.spawn("simpleWork", {
        value: "hello"
      })) as unknown as string;
      expect(fiberId).toBeDefined();
      expect(typeof fiberId).toBe("string");

      // Wait for execution
      await agent.waitFor(200);

      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toContain("executed:hello");

      const fiber = (await agent.getFiberState(
        fiberId
      )) as unknown as FiberState;
      expect(fiber).toBeDefined();
      expect(fiber.status).toBe("completed");
      expect(fiber.result).toEqual({ result: "hello" });
      expect(fiber.completedAt).toBeDefined();
    });

    it("should fire onFiberComplete when the fiber finishes", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "spawn-complete-hook"
      );

      const fiberId = (await agent.spawn("simpleWork", {
        value: "test"
      })) as unknown as string;
      await agent.waitFor(200);

      const completed =
        (await agent.getCompletedFibers()) as unknown as CompletedFiberInfo[];
      expect(completed.length).toBe(1);
      expect(completed[0].id).toBe(fiberId);
      expect(completed[0].methodName).toBe("simpleWork");
      expect(completed[0].result).toEqual({ result: "test" });
    });

    it("should support spawning with no payload", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "spawn-no-payload"
      );

      // failingWork accepts _payload: unknown, so null is fine
      const fiberId = (await agent.spawn("failingWork", undefined, {
        maxRetries: 0
      })) as unknown as string;
      await agent.waitFor(200);

      const fiber = (await agent.getFiberState(
        fiberId
      )) as unknown as FiberState;
      expect(fiber).toBeDefined();
      // Will be failed since failingWork throws and maxRetries is 0
      expect(fiber.status).toBe("failed");
    });

    it("should track the fiber in SQLite immediately", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "spawn-immediate-tracking"
      );

      // Spawn a slow fiber so we can check state before it completes
      const fiberId = (await agent.spawn("slowWork", {
        durationMs: 500
      })) as unknown as string;

      // Fiber should exist in SQLite right away
      const fiber = (await agent.getFiberState(
        fiberId
      )) as unknown as FiberState;
      expect(fiber).toBeDefined();
      expect(fiber.status).toBe("running");
      expect(fiber.retryCount).toBe(0);

      // Wait for it to complete
      await agent.waitFor(700);

      const completedFiber = (await agent.getFiberState(
        fiberId
      )) as unknown as FiberState;
      expect(completedFiber.status).toBe("completed");
    });
  });

  // ── stashFiber ─────────────────────────────────────────────────────

  describe("stashFiber", () => {
    it("should persist checkpoint data to SQLite", async () => {
      const agent = await getAgentByName(env.TestFiberAgent, "stash-basic");

      const fiberId = (await agent.spawn("checkpointingWork", {
        steps: ["a", "b", "c"]
      })) as unknown as string;
      await agent.waitFor(200);

      const fiber = (await agent.getFiberState(
        fiberId
      )) as unknown as FiberState;
      expect(fiber.status).toBe("completed");
      expect(fiber.snapshot).toEqual({
        completedSteps: ["a", "b", "c"],
        currentStep: "c"
      });

      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toEqual(["step:a", "step:b", "step:c"]);
    });

    it("should overwrite previous snapshot (not merge)", async () => {
      const agent = await getAgentByName(env.TestFiberAgent, "stash-overwrite");

      const fiberId = (await agent.spawn("checkpointingWork", {
        steps: ["first", "second"]
      })) as unknown as string;
      await agent.waitFor(200);

      const fiber = (await agent.getFiberState(
        fiberId
      )) as unknown as FiberState;
      // The last stash should be the final state, not a merge
      expect(fiber.snapshot).toEqual({
        completedSteps: ["first", "second"],
        currentStep: "second"
      });
    });
  });

  // ── cancelFiber ────────────────────────────────────────────────────

  describe("cancelFiber", () => {
    it("should cancel a running fiber", async () => {
      const agent = await getAgentByName(env.TestFiberAgent, "cancel-running");

      const fiberId = (await agent.spawn("slowWork", {
        durationMs: 5000
      })) as unknown as string;

      // Cancel immediately
      const cancelled = (await agent.cancel(fiberId)) as unknown as boolean;
      expect(cancelled).toBe(true);

      const fiber = (await agent.getFiberState(
        fiberId
      )) as unknown as FiberState;
      expect(fiber.status).toBe("cancelled");
    });

    it("should return false for non-existent fiber", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "cancel-nonexistent"
      );

      const cancelled = (await agent.cancel(
        "nonexistent-id"
      )) as unknown as boolean;
      expect(cancelled).toBe(false);
    });

    it("should return false for already completed fiber", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "cancel-completed"
      );

      const fiberId = (await agent.spawn("simpleWork", {
        value: "done"
      })) as unknown as string;
      await agent.waitFor(200);

      const cancelled = (await agent.cancel(fiberId)) as unknown as boolean;
      expect(cancelled).toBe(false);
    });
  });

  // ── Error handling and retries ─────────────────────────────────────

  describe("error handling", () => {
    it("should retry on error up to maxRetries", async () => {
      const agent = await getAgentByName(env.TestFiberAgent, "error-retry");

      const fiberId = (await agent.spawn(
        "failingWork",
        {},
        {
          maxRetries: 2
        }
      )) as unknown as string;
      await agent.waitFor(500);

      const fiber = (await agent.getFiberState(
        fiberId
      )) as unknown as FiberState;
      expect(fiber.status).toBe("failed");
      expect(fiber.error).toBe("Intentional fiber error");
      // retry_count should be maxRetries + 1 (initial + retries all failed)
      expect(fiber.retryCount).toBe(3);
    });

    it("should mark as failed with maxRetries=0 after first error", async () => {
      const agent = await getAgentByName(env.TestFiberAgent, "error-no-retry");

      const fiberId = (await agent.spawn(
        "failingWork",
        {},
        {
          maxRetries: 0
        }
      )) as unknown as string;
      await agent.waitFor(200);

      const fiber = (await agent.getFiberState(
        fiberId
      )) as unknown as FiberState;
      expect(fiber.status).toBe("failed");
      expect(fiber.retryCount).toBe(1);
    });

    it("should succeed after retry if error is transient", async () => {
      const agent = await getAgentByName(env.TestFiberAgent, "error-transient");

      await agent.resetFailCount();
      const fiberId = (await agent.spawn("failOnceThenSucceed", {
        value: "recovered"
      })) as unknown as string;
      await agent.waitFor(500);

      const fiber = (await agent.getFiberState(
        fiberId
      )) as unknown as FiberState;
      expect(fiber.status).toBe("completed");
      expect(fiber.result).toEqual({ result: "recovered" });
      // One retry was needed
      expect(fiber.retryCount).toBe(1);

      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toContain("fail-once");
      expect(log).toContain("succeed:recovered");
    });
  });

  // ── Concurrent fibers ──────────────────────────────────────────────

  describe("concurrent fibers", () => {
    it("should run multiple fibers concurrently", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "concurrent-basic"
      );

      const id1 = (await agent.spawn("simpleWork", {
        value: "one"
      })) as unknown as string;
      const id2 = (await agent.spawn("simpleWork", {
        value: "two"
      })) as unknown as string;
      const id3 = (await agent.spawn("simpleWork", {
        value: "three"
      })) as unknown as string;

      await agent.waitFor(300);

      const f1 = (await agent.getFiberState(id1)) as unknown as FiberState;
      const f2 = (await agent.getFiberState(id2)) as unknown as FiberState;
      const f3 = (await agent.getFiberState(id3)) as unknown as FiberState;

      expect(f1.status).toBe("completed");
      expect(f2.status).toBe("completed");
      expect(f3.status).toBe("completed");

      const log = (await agent.getExecutionLog()) as unknown as string[];
      expect(log).toContain("executed:one");
      expect(log).toContain("executed:two");
      expect(log).toContain("executed:three");
    });

    it("should complete all concurrent fibers independently", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "concurrent-keepalive"
      );

      // Spawn two slow fibers
      const id1 = (await agent.spawn("slowWork", {
        durationMs: 300
      })) as unknown as string;
      const id2 = (await agent.spawn("slowWork", {
        durationMs: 300
      })) as unknown as string;

      // Wait for both to complete
      await agent.waitFor(500);

      const f1 = (await agent.getFiberState(id1)) as unknown as FiberState;
      const f2 = (await agent.getFiberState(id2)) as unknown as FiberState;
      expect(f1.status).toBe("completed");
      expect(f2.status).toBe("completed");

      // Both should have completed independently
      const completed =
        (await agent.getCompletedFibers()) as unknown as CompletedFiberInfo[];
      expect(completed.length).toBe(2);
    });
  });

  // ── Eviction recovery (simulated) ──────────────────────────────────

  describe("eviction recovery", () => {
    it("should detect and recover an interrupted fiber", async () => {
      const agent = await getAgentByName(env.TestFiberAgent, "recovery-basic");

      // Spawn a slow fiber
      const fiberId = (await agent.spawn("slowWork", {
        durationMs: 5000
      })) as unknown as string;

      // Simulate eviction: remove from active set (keeps 'running' in SQLite)
      await agent.simulateEviction(fiberId);

      // Trigger alarm — this should detect the interrupted fiber
      await agent.triggerAlarm();

      // Give recovery time to execute
      await agent.waitFor(200);

      // onFiberRecovered should have been called
      const recovered =
        (await agent.getRecoveredFibers()) as unknown as RecoveredFiberInfo[];
      expect(recovered.length).toBe(1);
      expect(recovered[0].id).toBe(fiberId);
      expect(recovered[0].methodName).toBe("slowWork");
      expect(recovered[0].retryCount).toBe(1);
    });

    it("should preserve snapshot data through simulated eviction", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "recovery-snapshot"
      );

      // Spawn a checkpointing fiber and let it complete so it has a snapshot
      const fiberId = (await agent.spawn("checkpointingWork", {
        steps: ["a", "b", "c"]
      })) as unknown as string;
      await agent.waitFor(200);

      const completedFiber = (await agent.getFiberState(
        fiberId
      )) as unknown as FiberState;
      expect(completedFiber.status).toBe("completed");
      expect(completedFiber.snapshot).toEqual({
        completedSteps: ["a", "b", "c"],
        currentStep: "c"
      });

      // Now manually simulate what eviction mid-execution looks like:
      // Set the fiber back to 'running' in SQLite (keeping the snapshot),
      // and remove from active set. This is exactly the state left behind
      // when a fiber with checkpoints is interrupted by eviction.
      await agent.simulateEviction(fiberId);
      await agent.setFiberStatusForTest(fiberId, "running");

      // Trigger alarm — recovery should see the snapshot
      await agent.triggerAlarm();
      await agent.waitFor(200);

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as RecoveredFiberInfo[];
      const recoveredFiber = recovered.find(
        (r: RecoveredFiberInfo) => r.id === fiberId
      );
      expect(recoveredFiber).toBeDefined();
      // Snapshot should be preserved from the checkpoints
      expect(recoveredFiber!.snapshot).toEqual({
        completedSteps: ["a", "b", "c"],
        currentStep: "c"
      });
    });

    it("should increment retryCount on each recovery", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "recovery-retry-count"
      );

      const fiberId = (await agent.spawn("slowWork", {
        durationMs: 10000
      })) as unknown as string;

      // First eviction
      await agent.simulateEviction(fiberId);
      await agent.triggerAlarm();
      await agent.waitFor(100);

      let fiber = (await agent.getFiberState(fiberId)) as unknown as FiberState;
      // After first recovery, retryCount should be 1
      expect(fiber.retryCount).toBeGreaterThanOrEqual(1);

      // Second eviction
      await agent.simulateEviction(fiberId);
      await agent.triggerAlarm();
      await agent.waitFor(100);

      fiber = (await agent.getFiberState(fiberId)) as unknown as FiberState;
      expect(fiber.retryCount).toBeGreaterThanOrEqual(2);
    });

    it("should mark fiber as failed after max retries exceeded", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "recovery-max-retries"
      );

      const fiberId = (await agent.spawn(
        "slowWork",
        { durationMs: 10000 },
        { maxRetries: 1 }
      )) as unknown as string;

      // First eviction — should recover (retryCount goes to 1, maxRetries is 1)
      await agent.simulateEviction(fiberId);
      await agent.triggerAlarm();
      await agent.waitFor(100);

      let fiber = (await agent.getFiberState(fiberId)) as unknown as FiberState;
      // Should still be recoverable (retryCount 1 <= maxRetries 1)
      expect(fiber.status).not.toBe("failed");

      // Second eviction — should exceed max retries (retryCount would be 2 > 1)
      await agent.simulateEviction(fiberId);
      await agent.triggerAlarm();
      await agent.waitFor(100);

      fiber = (await agent.getFiberState(fiberId)) as unknown as FiberState;
      expect(fiber.status).toBe("failed");
      expect(fiber.error).toBe("max retries exceeded (eviction recovery)");
    });

    it("should recover multiple interrupted fibers in order", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "recovery-multiple"
      );

      const id1 = (await agent.spawn("slowWork", {
        durationMs: 10000
      })) as unknown as string;
      await agent.waitFor(50);
      const id2 = (await agent.spawn("slowWork", {
        durationMs: 10000
      })) as unknown as string;

      // Simulate eviction for both
      await agent.simulateEviction(id1);
      await agent.simulateEviction(id2);

      await agent.triggerAlarm();
      await agent.waitFor(200);

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as RecoveredFiberInfo[];
      expect(recovered.length).toBe(2);
      // Should be oldest-first (id1 before id2)
      expect(recovered[0].id).toBe(id1);
      expect(recovered[1].id).toBe(id2);
    });
  });

  // ── getFiber ───────────────────────────────────────────────────────

  describe("getFiber", () => {
    it("should return null for non-existent fiber", async () => {
      const agent = await getAgentByName(env.TestFiberAgent, "getfiber-null");

      const fiber = await agent.getFiberState("nonexistent");
      expect(fiber).toBeNull();
    });

    it("should return parsed fiber state", async () => {
      const agent = await getAgentByName(env.TestFiberAgent, "getfiber-parsed");

      const fiberId = (await agent.spawn("simpleWork", {
        value: "test"
      })) as unknown as string;
      await agent.waitFor(200);

      const fiber = (await agent.getFiberState(
        fiberId
      )) as unknown as FiberState;
      expect(fiber).toBeDefined();
      expect(fiber.id).toBe(fiberId);
      expect(fiber.callback).toBe("simpleWork");
      expect(fiber.payload).toEqual({ value: "test" });
      expect(fiber.status).toBe("completed");
      expect(fiber.retryCount).toBe(0);
      expect(fiber.maxRetries).toBe(3);
      expect(fiber.createdAt).toBeDefined();
      expect(typeof fiber.createdAt).toBe("number");
    });
  });

  // ── Heartbeat schedule lifecycle ───────────────────────────────────

  describe("heartbeat schedules", () => {
    it("should create a heartbeat schedule when a fiber is spawned", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "heartbeat-create"
      );

      // No heartbeat schedules before spawning
      const before =
        (await agent.getHeartbeatScheduleCount()) as unknown as number;
      expect(before).toBe(0);

      // Spawn a slow fiber
      await agent.spawn("slowWork", { durationMs: 500 });

      // Should have a heartbeat schedule now
      await agent.waitFor(100);
      const during =
        (await agent.getHeartbeatScheduleCount()) as unknown as number;
      expect(during).toBeGreaterThanOrEqual(1);

      // Wait for fiber to complete — heartbeat should be cleaned up
      await agent.waitFor(600);
      const after =
        (await agent.getHeartbeatScheduleCount()) as unknown as number;
      expect(after).toBe(0);
    });

    it("should clean up orphaned heartbeat schedules on recovery", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "heartbeat-orphan-cleanup"
      );

      // Spawn a slow fiber — this creates a heartbeat schedule
      const fiberId = (await agent.spawn("slowWork", {
        durationMs: 10000
      })) as unknown as string;
      await agent.waitFor(100);

      // Verify heartbeat exists
      const beforeEviction =
        (await agent.getHeartbeatScheduleCount()) as unknown as number;
      expect(beforeEviction).toBeGreaterThanOrEqual(1);

      // Simulate eviction — heartbeat schedule persists in SQLite (orphaned)
      await agent.simulateEviction(fiberId);

      // Trigger alarm → recovery → cleans up orphaned heartbeats → creates new ones
      await agent.triggerAlarm();
      await agent.waitFor(200);

      // The orphaned heartbeat was cleaned up, and recovery created a new one
      // for the restarted fiber. There should be exactly 1 (not 2+).
      const afterRecovery =
        (await agent.getHeartbeatScheduleCount()) as unknown as number;
      expect(afterRecovery).toBe(1);
    });
  });

  // ── Fiber cleanup ──────────────────────────────────────────────────

  describe("fiber cleanup", () => {
    it("should clean up old completed fibers on next spawn", async () => {
      const agent = await getAgentByName(
        env.TestFiberAgent,
        "cleanup-completed"
      );

      // Spawn and complete a fiber
      const oldId = (await agent.spawn("simpleWork", {
        value: "old"
      })) as unknown as string;
      await agent.waitFor(200);

      const oldFiber = (await agent.getFiberState(
        oldId
      )) as unknown as FiberState;
      expect(oldFiber.status).toBe("completed");

      // Backdate the completed_at and updated_at to 25 hours ago
      const oldTime = Date.now() - 25 * 60 * 60 * 1000;
      await agent.setFiberTimestampsForTest(oldId, oldTime, oldTime);

      // Reset the cleanup timer so the next spawn triggers cleanup
      await agent.resetCleanupTimerForTest();

      // Spawn another fiber — this triggers cleanup
      const newId = (await agent.spawn("simpleWork", {
        value: "new"
      })) as unknown as string;
      await agent.waitFor(200);

      // The old fiber should have been cleaned up
      const cleanedUp = await agent.getFiberState(oldId);
      expect(cleanedUp).toBeNull();

      // The new fiber should still exist
      const newFiber = (await agent.getFiberState(
        newId
      )) as unknown as FiberState;
      expect(newFiber.status).toBe("completed");
    });

    it("should not clean up recent completed fibers", async () => {
      const agent = await getAgentByName(env.TestFiberAgent, "cleanup-recent");

      // Spawn and complete a fiber
      const recentId = (await agent.spawn("simpleWork", {
        value: "recent"
      })) as unknown as string;
      await agent.waitFor(200);

      // Spawn another fiber — triggers cleanup but recent fiber should survive
      await agent.spawn("simpleWork", { value: "trigger" });
      await agent.waitFor(200);

      // Recent fiber should still exist (completed less than 24h ago)
      const recentFiber = (await agent.getFiberState(
        recentId
      )) as unknown as FiberState;
      expect(recentFiber).toBeDefined();
      expect(recentFiber.status).toBe("completed");
    });

    it("should clean up old failed fibers after 7 days", async () => {
      const agent = await getAgentByName(env.TestFiberAgent, "cleanup-failed");

      // Spawn a fiber that fails
      const failedId = (await agent.spawn(
        "failingWork",
        {},
        { maxRetries: 0 }
      )) as unknown as string;
      await agent.waitFor(200);

      const failedFiber = (await agent.getFiberState(
        failedId
      )) as unknown as FiberState;
      expect(failedFiber.status).toBe("failed");

      // Backdate to 8 days ago
      const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
      await agent.setFiberTimestampsForTest(failedId, oldTime, oldTime);

      // Reset cleanup timer and spawn to trigger cleanup
      await agent.resetCleanupTimerForTest();
      await agent.spawn("simpleWork", { value: "trigger" });
      await agent.waitFor(200);

      // Old failed fiber should be cleaned up
      const cleanedUp = await agent.getFiberState(failedId);
      expect(cleanedUp).toBeNull();
    });
  });
});
