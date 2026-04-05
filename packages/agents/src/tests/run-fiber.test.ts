import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import type { FiberRecoveryContext } from "..";

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

      // Fire-and-forget a slow fiber (runs for 500ms)
      await agent.fireAndForget("keepalive-test");
      await agent.waitFor(100);

      const refs = (await agent.getKeepAliveRefCount()) as unknown as number;
      expect(refs).toBeGreaterThanOrEqual(1);

      // Wait for it to complete
      await agent.waitFor(600);

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

      // Simulate an interrupted fiber by inserting a row directly
      await agent.insertInterruptedFiber("fiber-1", "research");
      await agent.triggerRecoveryCheck();

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
      expect(recovered.length).toBe(1);
      expect(recovered[0].id).toBe("fiber-1");
      expect(recovered[0].name).toBe("research");
      expect(recovered[0].snapshot).toBeNull();
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
});
