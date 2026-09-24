import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHarnessStub, waitFor } from "./test-harness";

describe("StateMachine effects", () => {
  it("executes a newly planned effect once", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startEffect("fresh", "safe");

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "effect:fresh" });
    expect(await stub.effectActivity()).toEqual({
      runs: ["fresh"],
      reconciles: []
    });
  });

  it("replays a safe uncertain effect with its durable input", async () => {
    const stub = createHarnessStub();
    const runId = await stub.seedEffectRecovery("safe", "safe");

    await expect(waitFor(stub, runId, ["completed"])).resolves.toMatchObject({
      result: "effect:safe"
    });
    expect(await stub.effectActivity()).toEqual({
      runs: ["safe"],
      reconciles: []
    });
  });

  it("does not replay a never effect", async () => {
    const stub = createHarnessStub();
    const runId = await stub.seedEffectRecovery("unsafe", "never");

    await expect(waitFor(stub, runId, ["completed"])).resolves.toMatchObject({
      result: "interrupted"
    });
    expect(await stub.effectActivity()).toEqual({ runs: [], reconciles: [] });
  });

  it("aborts an admitted effect when durable cancellation wins", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startEffect("block", "safe");
    const deadline = Date.now() + 5_000;
    for (;;) {
      const snapshot = await stub.runSnapshot(receipt.runId);
      if (snapshot?.effects?.some((effect) => effect.status === "running"))
        break;
      if (Date.now() > deadline) throw new Error("effect did not start");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await stub.cancelRun(receipt.runId, "cancel effect");
    await expect(
      waitFor(stub, receipt.runId, ["cancelled"])
    ).resolves.toMatchObject({
      error: { message: "cancel effect" }
    });
  });

  it("reconciles a queryable uncertain effect", async () => {
    const stub = createHarnessStub();
    const runId = await stub.seedEffectRecovery(
      "ignored",
      "reconcile",
      "done:remote"
    );

    await expect(waitFor(stub, runId, ["completed"])).resolves.toMatchObject({
      result: "reconciled:remote"
    });
    expect(await stub.effectActivity()).toEqual({
      runs: [],
      reconciles: ["done:remote"]
    });
  });
});

describe("StateMachine effect diagnostics", () => {
  it("explains an effect planned but not committed in the current phase", async () => {
    const message = await createHarnessStub().uncommittedEffectError();

    expect(message).toMatch(/planned in this phase but not committed/i);
    expect(message).toContain('"echo"');
    expect(message).toMatch(/transition/i);
    expect(message).toMatch(/effects\.run\(\)/);
  });
});

describe("StateMachine effects.run()", () => {
  it("commits and executes an effect in one phase", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startRunEffect({ value: "fresh" });

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "effect:fresh|attempt=1" });
    expect(await stub.effectRowsFor(receipt.runId)).toMatchObject([
      { revision: 0, status: "completed", attempt: 1 }
    ]);
  });

  it("assigns distinct deterministic identities to calls in one phase", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startMultiRun();

    await waitFor(stub, receipt.runId, ["completed"]);

    const rows = await stub.effectRowsFor(receipt.runId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.effect_id).not.toBe(rows[1]?.effect_id);
  });

  it("flushes mixed gate and effect builders together", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startMixedRun();

    await waitFor(stub, receipt.runId, ["completed"]);

    expect(await stub.effectRowsFor(receipt.runId)).toHaveLength(1);
    expect(await stub.gateRowsFor(receipt.runId)).toHaveLength(1);
  });
});

describe("StateMachine effect option validation", () => {
  it.each([
    [{ timeoutMs: 0 }, /timeoutMs must be a positive finite number/],
    [{ retries: { limit: 0 } }, /retry limit must be a positive integer/],
    [{ retries: { limit: 1.5 } }, /retry limit must be a positive integer/],
    [{ retries: { delay: -1 } }, /retry delay must be a non-negative/]
  ] as const)("rejects invalid options", async (options, message) => {
    const stub = createHarnessStub();
    const receipt = await stub.startRunEffect({
      value: "invalid",
      ...options
    });

    await expect(
      waitFor(stub, receipt.runId, ["failed"])
    ).resolves.toMatchObject({
      error: { message: expect.stringMatching(message) }
    });
  });
});

describe("StateMachine effects.run() recovery", () => {
  it("reuses a flushed completed effect after same-phase recovery", async () => {
    const stub = createHarnessStub();
    const runId = await stub.seedRunEffectRecovery("completed", "safe");

    await expect(waitFor(stub, runId, ["completed"])).resolves.toMatchObject({
      result: "effect:completed-safe|attempt=1"
    });
    expect(await stub.effectRowsFor(runId)).toHaveLength(1);
    expect(await stub.effectActivity()).toEqual({ runs: [], reconciles: [] });
  });

  it("does not re-execute a never effect that was running at recovery", async () => {
    const stub = createHarnessStub();
    const runId = await stub.seedRunEffectRecovery("running", "never");

    await expect(waitFor(stub, runId, ["completed"])).resolves.toMatchObject({
      result: "interrupted|attempt=1"
    });
    expect(await stub.effectRowsFor(runId)).toMatchObject([
      { status: "interrupted", attempt: 1 }
    ]);
    expect(await stub.effectActivity()).toEqual({ runs: [], reconciles: [] });
  });

  it("reuses the completed effect after a phase decision conflict", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startRunEffect({
      value: "once",
      kind: "conflict"
    });
    const deadline = Date.now() + 5_000;
    while (
      (await stub.effectRowsFor(receipt.runId))[0]?.status !== "completed"
    ) {
      if (Date.now() > deadline) throw new Error("effect did not complete");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "conflict:once|attempt=1" });
    expect(await stub.effectRowsFor(receipt.runId)).toHaveLength(1);
  });
});

describe("StateMachine effect timeout", () => {
  it("bounds a runtime that ignores its abort signal", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startRunEffect({
      value: "ignored",
      kind: "ignoring",
      timeoutMs: 25
    });

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({
      result: expect.stringMatching(/failed:.*timed out after 25ms.*attempt=1/)
    });
  });

  it("ignores a non-cooperative runtime that settles after timeout", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startRunEffect({
      value: "late",
      kind: "late",
      timeoutMs: 10
    });
    await waitFor(stub, receipt.runId, ["completed"]);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(await stub.effectRowsFor(receipt.runId)).toMatchObject([
      { status: "failed", attempt: 1 }
    ]);
  });

  it("does not retry a never effect after timeout", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startRunEffect({
      value: "never-timeout",
      kind: "ignoring",
      recovery: "never",
      timeoutMs: 25,
      retries: { limit: 3, delay: 0 }
    });

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({
      result: expect.stringMatching(/failed:.*timed out.*attempt=1/)
    });
    expect(await stub.effectRowsFor(receipt.runId)).toMatchObject([
      { status: "failed", attempt: 1 }
    ]);
  });

  it("bounds reconciliation attempts", async () => {
    const stub = createHarnessStub();
    const runId = await stub.seedReconcileTimeout(25);

    await expect(waitFor(stub, runId, ["failed"])).resolves.toMatchObject({
      error: { message: expect.stringMatching(/timed out after 25ms/) }
    });
  });

  it("clears a long timeout after a fast effect settles", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startRunEffect({
      value: "fast",
      timeoutMs: 120_000
    });
    await waitFor(stub, receipt.runId, ["completed"]);

    await evictDurableObject(stub);
  });
});

describe("StateMachine durable effect retries", () => {
  it("parks durably and resumes the same effect after eviction", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startRunEffect({
      value: "durable:1",
      kind: "flaky",
      retries: { limit: 2, delay: 75 }
    });

    const parked = await waitFor(stub, receipt.runId, ["waiting"]);
    const rows = await stub.effectRowsFor(receipt.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "retrying", attempt: 2 });
    expect(parked.wait?.timeoutAt).toBe(rows[0]?.retry_at);

    await evictDurableObject(stub);
    await new Promise((resolve) => setTimeout(resolve, 90));
    await runDurableObjectAlarm(stub);

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({ result: "flaky:ok:2|attempt=2" });
    expect(await stub.effectRowsFor(receipt.runId)).toHaveLength(1);
    expect(await stub.effectAttempts("durable:1")).toBe(2);
  });

  it("does not consume an attempt when woken before retryAt", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startRunEffect({
      value: "early:1",
      kind: "flaky",
      retries: { limit: 2, delay: 60_000 }
    });
    await waitFor(stub, receipt.runId, ["waiting"]);

    await stub.sendRetryWake(receipt.runId, "early-wake");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(await stub.effectAttempts("early:1")).toBe(1);
    expect(await stub.effectRowsFor(receipt.runId)).toMatchObject([
      { status: "retrying", attempt: 2 }
    ]);
  });

  it("settles failed when the retry budget is exhausted", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startRunEffect({
      value: "exhausted:10",
      kind: "flaky",
      retries: { limit: 2, delay: 0 }
    });

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({
      result: "failed:flaky attempt 2 failed|attempt=2"
    });
    expect(await stub.effectAttempts("exhausted:10")).toBe(2);
  });

  it("never retries recovery never after execution starts", async () => {
    const stub = createHarnessStub();
    const receipt = await stub.startRunEffect({
      value: "never:10",
      kind: "flaky",
      recovery: "never",
      retries: { limit: 3, delay: 0 }
    });

    await expect(
      waitFor(stub, receipt.runId, ["completed"])
    ).resolves.toMatchObject({
      result: "failed:flaky attempt 1 failed|attempt=1"
    });
    expect(await stub.effectAttempts("never:10")).toBe(1);
  });

  it.each([
    ["constant", 100, 100],
    ["linear", 100, 200],
    ["exponential", 100, 200]
  ] as const)(
    "stores the %s backoff deadline",
    async (backoff, delay, expectedSecondDelay) => {
      const stub = createHarnessStub();
      const before = Date.now();
      const receipt = await stub.startRunEffect({
        value: `${backoff}:2`,
        kind: "flaky",
        retries: { limit: 3, delay, backoff }
      });
      await waitFor(stub, receipt.runId, ["waiting"]);
      const first = (await stub.effectRowsFor(receipt.runId))[0]!;
      expect(first.retry_at).toBeGreaterThanOrEqual(before + delay);
      expect(first.retry_at).toBeLessThanOrEqual(Date.now() + delay + 100);

      await new Promise((resolve) => setTimeout(resolve, delay + 20));
      await runDurableObjectAlarm(stub);
      await waitFor(stub, receipt.runId, ["waiting"]);
      const second = (await stub.effectRowsFor(receipt.runId))[0]!;
      expect(second.retry_at).toBeGreaterThanOrEqual(
        first.retry_at! + expectedSecondDelay
      );
    }
  );
});
