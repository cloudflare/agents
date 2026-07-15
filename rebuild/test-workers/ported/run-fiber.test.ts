/**
 * Ported from ORIGINAL Agents:
 * - packages/agents/src/tests/run-fiber.test.ts
 * - last original change: 0f47d61c
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `agents` imports to `./compat.js` and hosted the fixture as a
 *   `Think` subclass because rebuild Cloudflare fixtures require `hostAgent`.
 * - Re-authored raw SQL checks against the rebuild's public fiber API and
 *   test-only store seams in `p13-fibers-agents.ts`.
 * - Kept original-only MCP ordering, explicit caller-supplied fiber ids, and
 *   private alarm-scheduling checks as `quarry`/`blocked` rows with native
 *   citations where the rebuild already has domain-level coverage.
 * - Preserved intentionally failing assertions for real recovery gaps:
 *   ledger-only managed rows and stale terminal run rows.
 */
// @ts-nocheck
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "./compat.js";
import type { TestRunFiberAgent } from "./fixtures/index.js";

type FiberInspection = {
  fiberId: string;
  name: string;
  status: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown> | null;
  snapshot: unknown | null;
  error?: string;
};

type FiberRecoveryContext = {
  fiberId: string;
  id?: string;
  name: string;
  status?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown> | null;
  snapshot: unknown | null;
  recoveryReason: "interrupted";
  createdAt: number;
};

async function freshAgent(
  name = crypto.randomUUID()
): Promise<DurableObjectStub<TestRunFiberAgent>> {
  return getAgentByName(
    env.TestRunFiberAgent as DurableObjectNamespace<TestRunFiberAgent>,
    name
  );
}

async function waitForFiberStatus(
  agent: DurableObjectStub<TestRunFiberAgent>,
  fiberId: string,
  status: string
): Promise<FiberInspection> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const inspection = await agent.inspectManagedFiber(fiberId);
    if (inspection?.status === status) return inspection;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const latest = await agent.inspectManagedFiber(fiberId);
  throw new Error(
    `Timed out waiting for fiber ${fiberId} to become ${status}; latest=${latest?.status}`
  );
}

describe("runFiber (ported)", () => {
  describe("execution", () => {
    it("should run a fiber and return the result", async () => {
      // plain pass: public runFiber returns the closure value.
      const agent = await freshAgent("run-basic");
      await expect(agent.runSimple("hello")).resolves.toBe("hello");
      await expect(agent.getExecutionLog()).resolves.toContain(
        "executed:hello"
      );
    });

    it("should delete the fiber row on completion", async () => {
      // plain pass: transient run rows are deleted after completion.
      const agent = await freshAgent("run-cleanup");
      await agent.runSimple("cleanup-test");
      await expect(agent.getRunningFiberCount()).resolves.toBe(0);
    });

    it("should delete the fiber row on error", async () => {
      // plain pass: transient run rows are deleted after failures too.
      const agent = await freshAgent("run-error-cleanup");
      await agent.runFailing();
      await expect(agent.getRunningFiberCount()).resolves.toBe(0);
    });

    it("should hold a keepAlive ref during execution", async () => {
      // native agent.test.ts "keepAlive()/release is idempotent and ref-counted"
      // covers the service primitive; this port observes it through runFiber.
      const agent = await freshAgent("run-keepalive");
      await agent.holdFiber("keepalive-test");
      await expect(agent.getKeepAliveRefCount()).resolves.toBeGreaterThanOrEqual(
        1
      );
      await agent.releaseFiber();
      await agent.waitFor(50);
      await expect(agent.getKeepAliveRefCount()).resolves.toBe(0);
    });
  });

  describe("stash", () => {
    it("should checkpoint via ctx.stash()", async () => {
      // plain pass: ctx.stash writes the active fiber snapshot.
      const agent = await freshAgent("stash-ctx");
      await expect(agent.runWithCheckpoint(["a", "b", "c"])).resolves.toEqual([
        "a",
        "b",
        "c"
      ]);
      await expect(agent.getExecutionLog()).resolves.toEqual([
        "step:a",
        "step:b",
        "step:c"
      ]);
    });

    it("should checkpoint via this.stash()", async () => {
      // plain pass: ambient AsyncLocalStorage routes this.stash to the fiber.
      const agent = await freshAgent("stash-this");
      await expect(agent.runWithThisStash("this-test")).resolves.toBe(
        "this-test"
      );
    });

    it("should route this.stash() to the correct fiber via ALS with concurrent fibers", async () => {
      // plain pass: native fibers.test.ts "concurrent fibers ambient-stash into
      // their own rows" covers the same observable routing at service level.
      const agent = await freshAgent("stash-concurrent-this");
      await agent.runConcurrentWithThisStash();
      await agent.waitFor(300);
      const log = await agent.getExecutionLog();
      expect(log).toContain("this-a-done");
      expect(log).toContain("this-b-done");
      await expect(agent.getRunningFiberCount()).resolves.toBe(0);
    });

    it("should apply internal stash wrappers to initial and user checkpoints", async () => {
      // plain pass: fixture-local wrapper, but persisted snapshots still
      // round-trip through real stash()/run-row storage.
      const agent = await freshAgent("stash-internal-wrapper");
      await expect(agent.runWithInternalStashWrapper()).resolves.toEqual({
        initialSnapshot: {
          __testFiberSnapshot: { requestId: "initial" },
          user: null
        },
        stashedSnapshot: {
          __testFiberSnapshot: { requestId: "wrapped" },
          user: { user: "checkpoint" }
        }
      });
    });

    it("should not leak an internal stash wrapper into concurrent plain fibers", async () => {
      // plain pass: fixture-local wrapper is AsyncLocalStorage-scoped.
      const agent = await freshAgent("stash-wrapper-concurrent");
      await expect(agent.runWrappedAndPlainConcurrentStash()).resolves.toEqual({
        wrappedSnapshot: {
          __testFiberSnapshot: { requestId: "wrapped" },
          user: { task: "wrapped" }
        },
        plainSnapshot: { task: "plain" }
      });
    });

    it("should clean up fiber rows when a fiber fails after writing an internal initial snapshot", async () => {
      // plain pass: failure cleanup still goes through the real runFiber path.
      const agent = await freshAgent("stash-wrapper-initial-then-throw");
      await expect(agent.runWithInitialSnapshotThenThrow()).resolves.toEqual({
        threw: true,
        runningFiberCount: 0
      });
      await expect(agent.getExecutionLog()).resolves.toContain(
        "initial-then-throw"
      );
    });

    it("should throw when this.stash() is called outside a fiber", async () => {
      // divergence: rebuild says "outside of a fiber"; original omitted "of".
      const agent = await freshAgent("stash-outside");
      await expect(agent.stashOutsideFiber()).resolves.toBe(
        "stash() called outside of a fiber"
      );
    });
  });

  describe("recovery", () => {
    it.skip("restores MCP connections before fiber recovery runs", () => {
      // blocked ISSUE-003/022: rebuild has no MCP connection manager surface
      // equivalent to the original `this.mcp.mcpConnections` wake ordering.
    });

    it("should detect an interrupted fiber and call onFiberRecovered", async () => {
      // plain pass: seeded orphan run row drives checkInterrupted().
      const agent = await freshAgent("recovery-basic");
      const before = Date.now();
      await agent.insertInterruptedFiber("fiber-1", "research");
      await agent.triggerRecoveryCheck();
      const recovered = (await agent.getRecoveredFibers()) as FiberRecoveryContext[];
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        fiberId: "fiber-1",
        name: "research",
        snapshot: null,
        recoveryReason: "interrupted"
      });
      expect(recovered[0].createdAt).toBeGreaterThanOrEqual(before);
      expect(recovered[0].createdAt).toBeLessThanOrEqual(Date.now());
    });

    it("should pass snapshot data to recovery", async () => {
      // plain pass: snapshot passthrough matches native fibers.test.ts
      // "marks orphaned managed rows interrupted and calls onRecovered with the snapshot".
      const agent = await freshAgent("recovery-snapshot");
      await agent.insertInterruptedFiber("fiber-2", "work", {
        step: 3,
        topic: "AI"
      });
      await agent.triggerRecoveryCheck();
      const recovered = await agent.getRecoveredFibers();
      expect(recovered[0].snapshot).toEqual({ step: 3, topic: "AI" });
    });

    it("should delete the row after recovery", async () => {
      // plain pass: unmanaged orphan rows are dropped after the hook returns.
      const agent = await freshAgent("recovery-cleanup");
      await agent.insertInterruptedFiber("fiber-3", "cleanup-test");
      await agent.triggerRecoveryCheck();
      await expect(agent.getRunningFiberCount()).resolves.toBe(0);
    });

    it("should not recover fibers that are actively running", async () => {
      // native fibers.test.ts "live executions in this process are not treated
      // as orphans" covers the service-level exclusion.
      const agent = await freshAgent("recovery-active");
      await agent.fireAndForget("active-test");
      await agent.waitFor(100);
      await agent.triggerRecoveryCheck();
      await expect(agent.getRecoveredFibers()).resolves.toHaveLength(0);
      await agent.waitFor(600);
    });

    it("should recover multiple interrupted fibers", async () => {
      // plain pass: all orphan run rows are scanned.
      const agent = await freshAgent("recovery-multiple");
      await agent.insertInterruptedFiber("fiber-a", "task-a", { type: "a" });
      await agent.insertInterruptedFiber("fiber-b", "task-b", { type: "b" });
      await agent.triggerRecoveryCheck();
      await expect(agent.getRecoveredFibers()).resolves.toHaveLength(2);
    });

    it("should not trigger recovery again after rows are cleaned up", async () => {
      // plain pass: second scan has no run rows.
      const agent = await freshAgent("recovery-once");
      await agent.insertInterruptedFiber("fiber-once", "once");
      await agent.triggerRecoveryCheck();
      await agent.triggerRecoveryCheck();
      await expect(agent.getRecoveredFibers()).resolves.toHaveLength(1);
    });

    it("retains a fresh unmanaged row when onFiberRecovered throws (retryable)", async () => {
      // native fibers.test.ts "a throwing hook keeps the row and retries via a
      // scheduler backoff" covers the retry schedule; this checks retention.
      const agent = await freshAgent("recovery-retain-throw");
      await agent.insertInterruptedFiber(
        "fiber-throw-fresh",
        "unmanaged-recovery-throws"
      );
      await agent.triggerRecoveryCheck();
      await expect(agent.getRunningFiberCount()).resolves.toBe(1);
    });

    it("evicts an aged unmanaged row whose recovery keeps throwing", async () => {
      // native fibers.test.ts "rows older than recoveryMaxAgeMs are discarded
      // with fiber:recovery:skipped" covers the aged-row eviction.
      const agent = await freshAgent("recovery-evict-aged");
      await agent.insertAgedInterruptedFiber(
        "fiber-throw-aged",
        "unmanaged-recovery-throws",
        25 * 60 * 60 * 1000
      );
      await agent.triggerRecoveryCheck();
      await expect(agent.getRunningFiberCount()).resolves.toBe(0);
      await expect(agent.getRecoveryEventTypes()).resolves.toContain(
        "fiber:recovery:skipped"
      );
    });
  });

  describe("recovery follow-up alarm", () => {
    it.skip("arms a follow-up alarm while a retained recovery row is pending", () => {
      // quarry / native fibers.test.ts: "a throwing hook keeps the row and
      // retries via a scheduler backoff" covers the observable behavior.
    });

    it.skip("backs off exponentially across consecutive no-progress scans", () => {
      // quarry / native fibers.test.ts: "backoff doubles per attempt and caps
      // at 5 minutes" covers the backoff math without original private alarms.
    });

    it.skip("resets the backoff when a scan makes forward progress", () => {
      // quarry: original asserted private `_recoveryNoProgressScans` and
      // physical alarm timing; rebuild exposes scheduler behavior natively.
    });

    it.skip("arms no follow-up alarm once recovery has fully drained", () => {
      // quarry / native fibers.test.ts: "a hook result settles the managed row
      // and deletes the run row" verifies the drained scan cancels retry work.
    });
  });

  describe("concurrency", () => {
    it("should run multiple fire-and-forget fibers concurrently", async () => {
      // plain pass: two background runFiber calls settle independently.
      const agent = await freshAgent("concurrent-run");
      await agent.runConcurrent();
      await agent.waitFor(200);
      const log = await agent.getExecutionLog();
      expect(log).toContain("a-done");
      expect(log).toContain("b-done");
      await expect(agent.getRunningFiberCount()).resolves.toBe(0);
    });
  });

  describe("errors", () => {
    it("should propagate errors to the caller", async () => {
      // plain pass: runFiber rethrows and the fixture reports the message.
      const agent = await freshAgent("error-propagate");
      await expect(agent.runFailing()).resolves.toBe("error:Intentional error");
    });
  });

  describe("managed fibers", () => {
    it("should accept and complete a managed fiber", async () => {
      // divergence: rebuild returns `running` immediately, not original
      // `pending`, because the ledger is advanced before startFiber returns.
      const agent = await freshAgent("managed-basic");
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
      await expect(agent.getExecutionLog()).resolves.toEqual([
        "managed:hello"
      ]);
    });

    it("should dedupe managed fibers by idempotency key", async () => {
      // plain pass: native fibers.test.ts "duplicate start with the same
      // idempotency key returns the retained status without re-running".
      const agent = await freshAgent("managed-key");
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
      await expect(agent.getExecutionLog()).resolves.toEqual([
        "managed:first"
      ]);
    });

    it.skip("should dedupe managed fibers by explicit fiber id", () => {
      // missing-feature: rebuild startFiber has no caller-supplied `fiberId`
      // option, only internally minted ids plus idempotencyKey dedupe.
    });

    it("should reject blank managed fiber identifiers", async () => {
      // divergence / missing-feature: rebuild validates neither blank
      // idempotencyKey nor the absent explicit fiberId option.
      const agent = await freshAgent("managed-blank-ids");
      await expect(
        agent.startManagedForError("blank-key", { idempotencyKey: "" })
      ).resolves.toBe("idempotencyKey must not be blank");
    });

    it("should mark managed fiber errors", async () => {
      // plain pass: closure throw settles retained ledger as error.
      const agent = await freshAgent("managed-error");
      const result = await agent.startManagedFailing("managed-error");
      const failed = await waitForFiberStatus(agent, result.fiberId, "error");
      expect(failed.error).toBe("Managed failure");
      await expect(agent.getExecutionLog()).resolves.toEqual([
        "managed-failing"
      ]);
    });

    it.skip("should mark setup failures before the callback as errors", () => {
      // quarry: depends on original raw SQL UNIQUE constraint surfacing from
      // explicit fiber-id collisions in `cf_agents_runs`.
    });

    it("should wait for newly accepted managed fibers when requested", async () => {
      // plain pass: waitForCompletion returns terminal status.
      const agent = await freshAgent("managed-wait-complete");
      const result = await agent.startManagedAndWait("wait", "wait-key");
      expect(result).toMatchObject({ accepted: true, status: "completed" });
      await expect(agent.inspectManagedFiber(result.fiberId)).resolves.toMatchObject(
        { status: "completed", snapshot: { value: "wait" } }
      );
    });

    it("should join active duplicate managed fibers when waiting", async () => {
      // native fibers.test.ts "a concurrent duplicate with waitForCompletion
      // joins the in-flight run" covers the service primitive.
      const agent = await freshAgent("managed-wait-join");
      const first = agent.holdManagedAndWait("held", "join-key");
      let active = await agent.inspectManagedFiberByKey("join-key");
      for (let attempt = 0; attempt < 20 && active?.status !== "running"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        active = await agent.inspectManagedFiberByKey("join-key");
      }
      expect(active?.status).toBe("running");
      const second = agent.startManagedAndWait("duplicate", "join-key");
      await agent.releaseWaitedManagedFiber();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toMatchObject({ accepted: true, status: "completed" });
      expect(secondResult).toMatchObject({
        accepted: false,
        status: "completed",
        fiberId: firstResult.fiberId
      });
      await expect(agent.getExecutionLog()).resolves.toEqual([
        "managed-wait-held:held"
      ]);
    });

    it("should resolve waiters when a managed fiber is cancelled", async () => {
      // plain pass: cancel settles before aborting the live closure.
      const agent = await freshAgent("managed-wait-cancel");
      const wait = agent.holdManagedIgnoringCancelAndWait(
        "ignore",
        "ignore-cancel-key"
      );
      let active = await agent.inspectManagedFiberByKey("ignore-cancel-key");
      for (let attempt = 0; attempt < 20 && active?.status !== "running"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        active = await agent.inspectManagedFiberByKey("ignore-cancel-key");
      }
      expect(active?.status).toBe("running");
      await expect(agent.cancelManagedFiber(active.fiberId, "stop")).resolves.toBe(true);
      await expect(wait).resolves.toMatchObject({
        accepted: true,
        status: "aborted",
        fiberId: active.fiberId
      });
      await agent.releaseIgnoredCancelManagedFiber();
      await agent.waitFor(50);
      await expect(agent.inspectManagedFiber(active.fiberId)).resolves.toMatchObject({
        status: "aborted",
        error: "stop"
      });
    });

    it("should return terminal error status when waiting fails", async () => {
      // plain pass: waitForCompletion returns error status and message.
      const agent = await freshAgent("managed-wait-error");
      await expect(
        agent.startManagedFailingAndWait("wait-error-key")
      ).resolves.toMatchObject({
        accepted: true,
        status: "error",
        error: "Managed wait failure"
      });
    });

    it("should cancel running managed fibers cooperatively", async () => {
      // plain pass: cancelFiber aborts the live signal and retains aborted.
      const agent = await freshAgent("managed-cancel");
      const fiberId = await agent.holdManaged("cancel-me", "cancel-key");
      await waitForFiberStatus(agent, fiberId, "running");
      await expect(agent.cancelManagedFiber(fiberId, "stop")).resolves.toBe(true);
      const aborted = await waitForFiberStatus(agent, fiberId, "aborted");
      expect(aborted.error).toBe("stop");
      await agent.waitFor(50);
      await expect(agent.inspectManagedFiber(fiberId)).resolves.toMatchObject({
        status: "aborted"
      });
    });

    it("should inspect, list, and delete terminal managed fibers", async () => {
      // plain pass: retained ledger inspection/list/delete.
      const agent = await freshAgent("managed-list");
      const result = await agent.startManaged("list", {
        idempotencyKey: "list-key"
      });
      await waitForFiberStatus(agent, result.fiberId, "completed");
      await expect(agent.inspectManagedFiberByKey("list-key")).resolves.toMatchObject({
        fiberId: result.fiberId,
        status: "completed"
      });
      const listed = await agent.listManagedFibers({
        status: ["completed"],
        name: "managed"
      });
      expect(listed.some((fiber) => fiber.fiberId === result.fiberId)).toBe(true);
      await expect(agent.deleteManagedFibers()).resolves.toBeGreaterThanOrEqual(1);
      await expect(agent.inspectManagedFiber(result.fiberId)).resolves.toBeNull();
    });

    it("should preserve interrupted fibers during default cleanup", async () => {
      // native fibers.test.ts "defaults to deleting settled rows and never
      // touches interrupted" and "deletes interrupted rows only when that
      // status is passed explicitly" cover the same cleanup contract.
      const agent = await freshAgent("managed-delete-default");
      const completed = await agent.startManaged("delete-completed", {
        idempotencyKey: "delete-completed-key"
      });
      await waitForFiberStatus(agent, completed.fiberId, "completed");
      await agent.insertInterruptedManagedFiber("delete-interrupted", "managed", {
        step: 1
      });
      await agent.triggerRecoveryCheck();
      await expect(agent.inspectManagedFiber("delete-interrupted")).resolves.toMatchObject({
        status: "interrupted"
      });
      await expect(agent.deleteManagedFibers()).resolves.toBe(1);
      await expect(agent.inspectManagedFiber(completed.fiberId)).resolves.toBeNull();
      await expect(agent.inspectManagedFiber("delete-interrupted")).resolves.toMatchObject({
        status: "interrupted"
      });
      await expect(agent.deleteInterruptedManagedFibers()).resolves.toBe(1);
      await expect(agent.inspectManagedFiber("delete-interrupted")).resolves.toBeNull();
    });

    it("should mark interrupted managed fibers during recovery", async () => {
      // plain pass: orphan managed run row marks its ledger interrupted before
      // invoking onFiberRecovered.
      const agent = await freshAgent("managed-recovery");
      await agent.insertInterruptedManagedFiber("managed-interrupted", "managed", {
        step: 1
      });
      await agent.triggerRecoveryCheck();
      const recovered = await agent.getRecoveredFibers();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        fiberId: "managed-interrupted",
        idempotencyKey: "key:managed-interrupted",
        metadata: { inserted: true },
        status: "interrupted"
      });
      await expect(agent.inspectManagedFiber("managed-interrupted")).resolves.toMatchObject({
        status: "interrupted",
        snapshot: { step: 1 }
      });
    });

    it("should recover pending managed ledger rows without run rows", async () => {
      // missing-feature: checkInterrupted() scans only `fiber:run:*`, so a
      // ledger-only pending row is invisible. This assertion intentionally
      // keeps the original expected behavior and fails against real rebuild.
      const agent = await freshAgent("managed-ledger-pending");
      await agent.insertManagedLedgerOnlyFiber(
        "managed-ledger-pending",
        "managed",
        "pending",
        { step: "pending" }
      );
      await agent.triggerRecoveryCheck();
      await expect(agent.getRecoveredFibers()).resolves.toHaveLength(1);
    });

    it("should recover running managed ledger rows without run rows", async () => {
      // missing-feature: same ledger-only invisibility as the pending case.
      const agent = await freshAgent("managed-ledger-running");
      await agent.insertManagedLedgerOnlyFiber(
        "managed-ledger-running",
        "managed-recovery-complete",
        "running",
        { step: "running" }
      );
      await agent.triggerRecoveryCheck();
      await expect(agent.inspectManagedFiber("managed-ledger-running")).resolves.toMatchObject({
        status: "completed",
        snapshot: { recovered: true }
      });
    });

    it("should wait for terminal status when recovery is already running", async () => {
      // missing-feature: duplicate waiters for a ledger-only row have no
      // in-memory waiter to join, so rebuild returns the retained running row.
      const agent = await freshAgent("managed-wait-recovery-running");
      await agent.insertManagedLedgerOnlyFiber(
        "managed-waiting-recovery",
        "managed-recovery-complete",
        "running",
        { step: "waiting" }
      );
      const result = await agent.startManagedAndWait(
        "duplicate",
        "key:managed-waiting-recovery"
      );
      expect(result).toMatchObject({
        accepted: false,
        status: "completed",
        fiberId: "managed-waiting-recovery"
      });
    });

    it("should not recover terminal managed fibers with stale run rows", async () => {
      // REAL BUG: checkInterrupted() still calls onFiberRecovered for stale
      // run rows whose managed ledger is already terminal.
      const agent = await freshAgent("managed-terminal-recovery");
      await agent.insertAbortedManagedFiberWithRun("managed-aborted", "managed", {
        step: 1
      });
      await agent.triggerRecoveryCheck();
      await expect(agent.getRecoveredFibers()).resolves.toHaveLength(0);
      await expect(agent.inspectManagedFiber("managed-aborted")).resolves.toMatchObject({
        status: "aborted",
        error: "cancelled",
        snapshot: { step: 1 }
      });
      await expect(agent.getRunningFiberCount()).resolves.toBe(0);
    });

    it("should apply successful managed recovery outcomes", async () => {
      // plain pass: onFiberRecovered result resolves interrupted managed rows.
      const agent = await freshAgent("managed-recovery-complete");
      await agent.insertInterruptedManagedFiber(
        "managed-complete",
        "managed-recovery-complete",
        { step: 1 }
      );
      await agent.triggerRecoveryCheck();
      await expect(agent.inspectManagedFiber("managed-complete")).resolves.toMatchObject({
        status: "completed",
        snapshot: { recovered: true }
      });
    });

    it("should resolve interrupted managed fibers outside recovery", async () => {
      // native fibers.test.ts "updates only interrupted rows and returns true".
      const agent = await freshAgent("managed-resolve");
      await agent.insertInterruptedManagedFiber("managed-resolve", "managed", {
        step: 1
      });
      await agent.triggerRecoveryCheck();
      await expect(agent.resolveManagedFiber("managed-resolve")).resolves.toBe(true);
      await expect(agent.inspectManagedFiber("managed-resolve")).resolves.toMatchObject({
        status: "completed",
        snapshot: { resolved: true }
      });
    });

    it("should mark managed fibers as errors when recovery throws", async () => {
      // divergence: rebuild keeps the run row for retry after hook failure
      // instead of terminalizing the managed ledger as error immediately.
      const agent = await freshAgent("managed-recovery-throws");
      await agent.insertInterruptedManagedFiber(
        "managed-throws",
        "managed-recovery-throws",
        { step: 1 }
      );
      await agent.triggerRecoveryCheck();
      await expect(agent.inspectManagedFiber("managed-throws")).resolves.toMatchObject({
        status: "error",
        error: "Recovery failed",
        snapshot: { step: 1 }
      });
    });

    it("should emit fiber recovery events when recovery fails", async () => {
      // divergence: rebuild emits detected/attempt/failed, but the failed
      // payload uses structured errors and no original `reason` field.
      const agent = await freshAgent("managed-recovery-events");
      await agent.insertInterruptedManagedFiber(
        "managed-events",
        "managed-recovery-throws",
        { step: 1 }
      );
      await agent.triggerRecoveryCheck();
      await expect(agent.getRecoveryEventTypes()).resolves.toEqual(
        expect.arrayContaining([
          "fiber:recovery:detected",
          "fiber:recovery:attempt",
          "fiber:recovery:failed"
        ])
      );
    });
  });
});
