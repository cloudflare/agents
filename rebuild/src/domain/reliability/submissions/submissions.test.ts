import { describe, expect, it, vi } from "vitest";
import { createMemoryKeyValueStore } from "../../../adapters/memory/store.js";
import { createTestClock } from "../../../adapters/memory/clock.js";
import { createEventBus } from "../../../kernel/events.js";
import { defaultIdSource } from "../../../kernel/ids.js";
import { userMessage, type ChatMessage } from "../../messages/model.js";
import { createSubmissionService, type SubmissionService } from "./submissions.js";
import type { KeyValueStore } from "../../../ports/storage.js";

/**
 * A controllable fake for the injected `runSubmission` callback. Records the
 * order in which submissions actually start running, and lets the test
 * resolve/reject each one manually — the only way to prove FIFO ordering and
 * "accept happens before any inference" without relying on timing hacks.
 */
function fakeRunner() {
  const started: string[] = [];
  const pending = new Map<
    string,
    { resolve: (v: { kind: "completed" | "aborted" | "error"; error?: string }) => void; reject: (e: unknown) => void; signal: AbortSignal }
  >();

  const runSubmission = vi.fn(
    (record: { submissionId: string; messages: ChatMessage[] }, signal: AbortSignal) => {
      started.push(record.submissionId);
      return new Promise<{ kind: "completed" | "aborted" | "error"; error?: string }>((resolve, reject) => {
        pending.set(record.submissionId, { resolve, reject, signal });
      });
    }
  );

  function resolve(submissionId: string, outcome: { kind: "completed" | "aborted" | "error"; error?: string } = { kind: "completed" }) {
    const entry = pending.get(submissionId);
    if (!entry) throw new Error(`no pending run for ${submissionId}`);
    pending.delete(submissionId);
    entry.resolve(outcome);
  }

  function isAborted(submissionId: string): boolean {
    return pending.get(submissionId)?.signal.aborted ?? false;
  }

  return { runSubmission, started, resolve, isAborted };
}

function harness(overrides?: { store?: KeyValueStore; runner?: ReturnType<typeof fakeRunner> }) {
  const store = overrides?.store ?? createMemoryKeyValueStore();
  const clock = createTestClock(1_000);
  const bus = createEventBus({ agent: "test", name: "agent-1" }, () => clock.now());
  const runner = overrides?.runner ?? fakeRunner();
  const service = createSubmissionService({
    store,
    clock,
    ids: defaultIdSource,
    bus,
    runSubmission: runner.runSubmission,
  });
  return { store, clock, bus, runner, service };
}

async function flushMacrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createSubmissionService", () => {
  it("accept() returns before any inference happens", async () => {
    const { runner, service } = harness();

    const record = await service.submit([userMessage("hi")]);

    expect(record.accepted).toBe(true);
    expect(record.status).toBe("pending");
    expect(runner.started).toEqual([]);
    expect(runner.runSubmission).not.toHaveBeenCalled();
  });

  it("drains submissions in FIFO order, one at a time", async () => {
    const { runner, service } = harness();

    const r1 = await service.submit([userMessage("one")], { submissionId: "s1" });
    const r2 = await service.submit([userMessage("two")], { submissionId: "s2" });
    const r3 = await service.submit([userMessage("three")], { submissionId: "s3" });
    expect([r1.submissionId, r2.submissionId, r3.submissionId]).toEqual(["s1", "s2", "s3"]);

    await flushMacrotasks();
    expect(runner.started).toEqual(["s1"]);

    runner.resolve("s1");
    await flushMacrotasks();
    expect(runner.started).toEqual(["s1", "s2"]);

    runner.resolve("s2");
    await flushMacrotasks();
    expect(runner.started).toEqual(["s1", "s2", "s3"]);

    runner.resolve("s3");
    await flushMacrotasks();

    expect(service.inspect("s1")?.status).toBe("completed");
    expect(service.inspect("s2")?.status).toBe("completed");
    expect(service.inspect("s3")?.status).toBe("completed");
  });

  it("idempotent retry: same idempotencyKey returns the existing record with accepted:false", async () => {
    const { runner, service } = harness();

    const first = await service.submit([userMessage("hi")], { idempotencyKey: "key-1" });
    const second = await service.submit([userMessage("hi, again — should be ignored")], { idempotencyKey: "key-1" });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.submissionId).toBe(first.submissionId);

    await flushMacrotasks();
    // Only the original message set was ever run, exactly once.
    expect(runner.started).toEqual([first.submissionId]);
    expect(runner.runSubmission).toHaveBeenCalledTimes(1);
  });

  it("idempotent retry: same submissionId returns the existing record with accepted:false", async () => {
    const { service } = harness();
    const first = await service.submit([userMessage("hi")], { submissionId: "dup" });
    const second = await service.submit([userMessage("hi")], { submissionId: "dup" });
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.submissionId).toBe("dup");
  });

  it("throws ConflictError when submissionId and idempotencyKey identify different rows", async () => {
    const { service } = harness();
    await service.submit([userMessage("a")], { submissionId: "s1", idempotencyKey: "k1" });
    await service.submit([userMessage("b")], { submissionId: "s2", idempotencyKey: "k2" });

    await expect(
      service.submit([userMessage("c")], { submissionId: "s1", idempotencyKey: "k2" })
    ).rejects.toThrow();
  });

  it("rejects an empty message list", async () => {
    const { service } = harness();
    await expect(service.submit([])).rejects.toThrow();
  });

  it("rejects messages containing functions (not JSON-serializable)", async () => {
    const { service } = harness();
    const bad = userMessage("hi");
    (bad as unknown as { metadata: Record<string, unknown> }).metadata = { cb: () => 1 };
    await expect(service.submit([bad])).rejects.toThrow();
  });

  it("cancel(pending): flips to aborted and the message never runs", async () => {
    const { runner, service } = harness();
    const record = await service.submit([userMessage("hi")], { submissionId: "s1" });

    const cancelled = await service.cancel("s1", "changed my mind");
    expect(cancelled).toBe(true);
    expect(service.inspect("s1")?.status).toBe("aborted");

    await flushMacrotasks();
    expect(runner.started).toEqual([]);
    expect(record.status).toBe("pending"); // the originally returned snapshot is unaffected
  });

  it("cancel(running): aborts the in-flight signal and settles as aborted", async () => {
    const { runner, service } = harness();
    await service.submit([userMessage("hi")], { submissionId: "s1" });
    await flushMacrotasks();
    expect(runner.started).toEqual(["s1"]);

    const cancelled = await service.cancel("s1");
    expect(cancelled).toBe(true);
    expect(service.inspect("s1")?.status).toBe("aborted");
    expect(runner.isAborted("s1")).toBe(true);

    // Even if the fake later resolves as "completed", the aborted status must stick.
    runner.resolve("s1", { kind: "completed" });
    await flushMacrotasks();
    expect(service.inspect("s1")?.status).toBe("aborted");
  });

  it("cancel() on a settled submission is a no-op returning false", async () => {
    const { runner, service } = harness();
    await service.submit([userMessage("hi")], { submissionId: "s1" });
    await flushMacrotasks();
    runner.resolve("s1");
    await flushMacrotasks();
    expect(service.inspect("s1")?.status).toBe("completed");

    expect(await service.cancel("s1")).toBe(false);
  });

  it("cancel() on an unknown id returns false", async () => {
    const { service } = harness();
    expect(await service.cancel("nope")).toBe(false);
  });

  it("records an error outcome with the error message", async () => {
    const { runner, service } = harness();
    await service.submit([userMessage("hi")], { submissionId: "s1" });
    await flushMacrotasks();

    runner.resolve("s1", { kind: "error", error: "model exploded" });
    await flushMacrotasks();

    const info = service.inspect("s1");
    expect(info?.status).toBe("error");
    expect(info?.error).toBe("model exploded");
  });

  it("markAllPendingSkipped() flips only pending rows and returns the count", async () => {
    const { runner, service } = harness();
    await service.submit([userMessage("a")], { submissionId: "s1" });
    await service.submit([userMessage("b")], { submissionId: "s2" });
    await flushMacrotasks(); // s1 claimed -> running
    expect(runner.started).toEqual(["s1"]);

    const count = service.markAllPendingSkipped();
    expect(count).toBe(1);
    expect(service.inspect("s1")?.status).toBe("running"); // unaffected, already running
    expect(service.inspect("s2")?.status).toBe("skipped");
  });

  it("deleteSubmissions() defaults to settled statuses, excluding pending/running", async () => {
    const { runner, service } = harness();
    await service.submit([userMessage("a")], { submissionId: "s1" });
    await service.submit([userMessage("b")], { submissionId: "s2" });
    await flushMacrotasks();
    runner.resolve("s1");
    await flushMacrotasks();
    // s1 completed, s2 running (still in flight)

    const removed = service.deleteSubmissions();
    expect(removed).toBe(1);
    expect(service.inspect("s1")).toBeNull();
    expect(service.inspect("s2")).not.toBeNull();
  });

  it("deleteSubmissions() honors an explicit status filter and completedBefore", async () => {
    const { runner, clock, service } = harness();
    await service.submit([userMessage("a")], { submissionId: "s1" });
    await flushMacrotasks();
    runner.resolve("s1");
    await flushMacrotasks();

    const cutoff = clock.now();
    clock.advance(1000);

    await service.submit([userMessage("b")], { submissionId: "s2" });
    await flushMacrotasks();
    runner.resolve("s2");
    await flushMacrotasks();

    const removed = service.deleteSubmissions({ status: ["completed"], completedBefore: cutoff });
    expect(removed).toBe(0);

    clock.advance(1);
    const removedNow = service.deleteSubmissions({ status: ["completed"], completedBefore: clock.now() });
    expect(removedNow).toBe(2);
  });

  it("list() filters by status and honors limit", async () => {
    const { runner, service } = harness();
    await service.submit([userMessage("a")], { submissionId: "s1" });
    await service.submit([userMessage("b")], { submissionId: "s2" });
    await service.submit([userMessage("c")], { submissionId: "s3" });
    await flushMacrotasks();

    const pendingOnly = service.list({ status: ["pending"] });
    expect(pendingOnly.map((r) => r.submissionId)).toEqual(["s2", "s3"]);

    const limited = service.list({ limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it("inspect() returns null for an unknown id", () => {
    const { service } = harness();
    expect(service.inspect("nope")).toBeNull();
  });

  it("startup drain: a new service over the same store picks up leftover pending rows", async () => {
    vi.useFakeTimers();
    try {
      const store = createMemoryKeyValueStore();
      const runner1 = fakeRunner();
      const { service: service1 } = harness({ store, runner: runner1 });
      void service1; // constructed only to durably write the leftover row below

      await service1.submit([userMessage("leftover")], { submissionId: "s1" });

      // Simulate a process crash: drop every timer service1 scheduled without
      // ever letting them fire, so its drain never ran.
      vi.clearAllTimers();

      const runner2 = fakeRunner();
      const { service: service2 } = harness({ store, runner: runner2 });
      await vi.runOnlyPendingTimersAsync();

      expect(runner2.started).toEqual(["s1"]);
      runner2.resolve("s1");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(service2.inspect("s1")?.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drain() is re-entrant safe: concurrent calls run each submission exactly once", async () => {
    const { runner, service } = harness();
    await service.submit([userMessage("a")], { submissionId: "s1" });
    await service.submit([userMessage("b")], { submissionId: "s2" });

    const drain1 = service.drain();
    const drain2 = service.drain(); // should be a no-op while drain1 is active

    await flushMacrotasks();
    expect(runner.started).toEqual(["s1"]);
    runner.resolve("s1");
    await flushMacrotasks();
    expect(runner.started).toEqual(["s1", "s2"]);
    runner.resolve("s2");

    await Promise.all([drain1, drain2]);
    await flushMacrotasks();

    expect(runner.runSubmission).toHaveBeenCalledTimes(2);
    expect(service.inspect("s1")?.status).toBe("completed");
    expect(service.inspect("s2")?.status).toBe("completed");
  });
});
