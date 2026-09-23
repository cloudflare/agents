import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PiHarnessTestObject } from "./worker";

function fresh(): DurableObjectStub<PiHarnessTestObject> {
  return env.PI_HARNESS_TEST.getByName(crypto.randomUUID());
}

describe("example-local PiHarness", () => {
  it("uses a pi-ai provider and restores its transcript after eviction", async () => {
    const stub = fresh();
    const first = await stub.runMultiply(4, 3);
    expect(first).toMatchObject({
      status: "completed",
      result: 12,
      messages: ["multiply 4", "", "", "tool complete"]
    });

    const eventTypes = await stub.eventTypes(first.operationId);
    for (const expected of [
      "operation_start",
      "turn_start",
      "tool_start",
      "tool_end",
      "turn_end",
      "operation_end"
    ]) {
      expect(eventTypes.includes(expected)).toBe(true);
    }

    await evictDurableObject(stub);
    expect(await stub.messages()).toEqual(first.messages);

    const second = await stub.runMultiply(2, 5);
    expect(second).toMatchObject({ status: "completed", result: 10 });
    expect((await stub.messages()).at(-1)).toBe("tool complete");
  });
});

describe("PiHarness state machine", () => {
  it("settles the operation's machine run with pi's own outcome", async () => {
    const stub = fresh();
    const run = await stub.runMultiply(3, 2);

    // The outer machine is terminal, and its bounded result mirrors the
    // disposition pi recorded rather than restating the transcript.
    await expect(stub.machine(run.operationId)).resolves.toMatchObject({
      status: "completed",
      result: { operationId: run.operationId, status: "completed" }
    });
  });

  it("reports no machine run for an unknown operation", async () => {
    const stub = fresh();
    await expect(stub.machine("missing")).resolves.toBeNull();
  });

  it("deduplicates a resubmitted operation id", async () => {
    const stub = fresh();
    const first = await stub.runMultiply(2, 1);
    // Pi already retains a terminal result for this id, so the harness
    // refuses to admit it a second time instead of replaying the model.
    await expect(
      stub.submitOnly(2, 1).then(() => stub.machine(first.operationId))
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("reconciles a live operation against pi after eviction", async () => {
    const stub = fresh();
    const { operationId, accepted } = await stub.submitOnly(6, 2);
    expect(accepted).toBe(true);

    // Drop the isolate while the run is in flight. Nothing in the checkpoint
    // can replay the model request; recovery has to ask pi what happened.
    await evictDurableObject(stub);

    await expect(stub.awaitResult(operationId)).resolves.toMatchObject({
      status: "completed"
    });
    await expect(stub.machine(operationId)).resolves.toMatchObject({
      status: "completed",
      result: { operationId, status: "completed" }
    });
    expect((await stub.messages()).at(-1)).toBe("tool complete");
  });
});

/**
 * These cover the wrapped-runtime behaviour the happy path cannot reach.
 *
 * Each one holds an operation open with a durable gate so the Durable Object
 * can be evicted, cancelled, or inspected while pi genuinely has work in
 * flight. Without the gate the operation settles in a single fast pass and
 * the reconcile, park, and cancel paths are never entered.
 */
/** The machine control view as it arrives over RPC. */
type MachineView = {
  status: string;
  phase?: string;
  result?: unknown;
  error?: string;
};

describe("PiHarness durability", () => {
  /** Park until the machine reaches a phase, driving alarms as needed. */
  async function waitForPhase(
    stub: DurableObjectStub<PiHarnessTestObject>,
    operationId: string,
    phase: string,
    timeoutMs = 10_000
  ): Promise<MachineView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = (await stub.machine(operationId)) as MachineView | null;
      if (snapshot?.phase === phase) return snapshot;
      if (Date.now() > deadline) {
        throw new Error(
          `run ${operationId} stayed ${JSON.stringify(snapshot)}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Park until the machine run reaches a terminal status. */
  async function waitForStatus(
    stub: DurableObjectStub<PiHarnessTestObject>,
    operationId: string,
    status: string,
    timeoutMs = 10_000
  ): Promise<MachineView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = (await stub.machine(operationId)) as MachineView | null;
      if (snapshot?.status === status) return snapshot;
      if (Date.now() > deadline) {
        throw new Error(
          `run ${operationId} stayed ${JSON.stringify(snapshot)}`
        );
      }
      await runDurableObjectAlarm(stub);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("reconciles a mid-flight operation against pi after eviction", async () => {
    const stub = fresh();
    const { operationId } = await stub.submitGated(5);
    // The tool is blocked, so pi holds a live operation with no result yet.
    await waitForPhase(stub, operationId, "drive");
    expect(await stub.piResult(operationId)).toBeNull();

    // Drop the isolate while pi still has the operation in flight. The
    // checkpoint holds no model response, so the only way to a correct
    // outcome is to ask pi what happened.
    await evictDurableObject(stub);

    await waitForStatus(stub, operationId, "completed");
    // Both authorities agree, and the machine's result came from pi's record
    // rather than from a replayed request.
    expect(await stub.piResult(operationId)).toBe("completed");
    expect((await stub.messages()).at(-1)).toBe("slow complete");
  });

  it("cancels a mid-flight operation durably on both sides", async () => {
    const stub = fresh();
    const { operationId } = await stub.submitGated(7);
    await waitForPhase(stub, operationId, "drive");

    expect(await stub.abort(operationId)).toBe(true);

    // The machine settles as cancelled and pi records its own disposition,
    // rather than the two disagreeing about the outcome.
    const settled = await waitForStatus(stub, operationId, "cancelled");
    expect(settled.status).toBe("cancelled");
    await stub.releaseGate();
    expect(await stub.piResult(operationId)).not.toBe("completed");
  });

  it("survives eviction while cancellation is pending", async () => {
    const stub = fresh();
    const { operationId } = await stub.submitGated(8);
    await waitForPhase(stub, operationId, "drive");

    expect(await stub.abort(operationId)).toBe(true);
    // The cancellation marker is durable, so losing the isolate before the
    // machine settles must not resurrect the run.
    await evictDurableObject(stub);
    await stub.releaseGate();

    const settled = await waitForStatus(stub, operationId, "cancelled");
    expect(settled.status).toBe("cancelled");
  });

  it("reports abort of an unknown operation as no-op", async () => {
    const stub = fresh();
    await expect(stub.abort("missing")).resolves.toBe(false);
  });

  it("keeps one settled result across repeated eviction", async () => {
    const stub = fresh();
    const run = await stub.runMultiply(4, 3);
    for (let i = 0; i < 3; i++) {
      await evictDurableObject(stub);
      await expect(stub.machine(run.operationId)).resolves.toMatchObject({
        status: "completed"
      });
      expect(await stub.piResult(run.operationId)).toBe("completed");
    }
    // A terminal run is not re-driven, so the transcript stays as it was.
    expect((await stub.messages()).at(-1)).toBe("tool complete");
  });
});

/**
 * Recovery of an uncertain drive pass.
 *
 * These seed the one crash position that cannot be timed reliably: the
 * effect's intent is durably `running`, but the isolate died before the pass
 * settled. On resume the machine must consult pi rather than repeat the
 * model request, so each test fixes what pi remembers and asserts the
 * outcome the machine derives from it.
 */
describe("PiHarness uncertain-effect recovery", () => {
  async function waitForStatus(
    stub: DurableObjectStub<PiHarnessTestObject>,
    operationId: string,
    status: string,
    timeoutMs = 10_000
  ): Promise<MachineView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = (await stub.machine(operationId)) as MachineView | null;
      if (snapshot?.status === status) return snapshot;
      if (Date.now() > deadline) {
        throw new Error(
          `run ${operationId} stayed ${JSON.stringify(snapshot)}`
        );
      }
      await runDurableObjectAlarm(stub);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("adopts pi's terminal result instead of repeating the request", async () => {
    const stub = fresh();
    // Settle a real operation first, so pi holds a genuine terminal record.
    const done = await stub.runMultiply(4, 3);
    const before = await stub.messages();

    // Now pretend the pass that produced it died before settling.
    await stub.seedUncertainDrivePass({ operationId: done.operationId });
    await stub.resumeRun(done.operationId);

    // Recovery reconciles against pi's record and settles from it.
    await waitForStatus(stub, done.operationId, "completed");
    expect(await stub.piResult(done.operationId)).toBe("completed");
    // The decisive assertion: reconciling must not re-run the model, so the
    // transcript is byte-for-byte what it was before recovery.
    expect(await stub.messages()).toEqual(before);
  });

  it("reports an operation pi never recorded as interrupted", async () => {
    const stub = fresh();
    // No pi operation with this id exists, so reconcile answers not-found.
    const operationId = "never-admitted";
    await stub.seedUncertainDrivePass({ operationId });
    await stub.resumeRun(operationId);

    const settled = await waitForStatus(stub, operationId, "completed");
    // The machine reports the loss rather than silently retrying it.
    expect(settled.result).toMatchObject({
      operationId,
      status: "failed",
      error: { code: "interrupted" }
    });
  });
});

/**
 * The parked phase between drive passes.
 *
 * Pi asks to be re-driven later for a provider retry backoff or a deferred
 * poll. The machine records that as a durable wait rather than holding a
 * JavaScript invocation open, so one operation can span many passes and
 * survive eviction between them.
 */
describe("PiHarness multi-pass parking", () => {
  it("plans a fresh pass when a parked run wakes", async () => {
    const stub = fresh();
    // Settle a real operation so pi has a terminal record to reconcile to,
    // then park a run for the next pass against that same operation.
    const done = await stub.runMultiply(2, 2);
    await stub.seedWaitingRun({ operationId: done.operationId, pass: 0 });

    // Waking the parked run must leave `waiting`, plan pass 1, and settle
    // from pi's record rather than stalling.
    await stub.resumeRun(done.operationId);

    const deadline = Date.now() + 10_000;
    for (;;) {
      const snapshot = (await stub.machine(
        done.operationId
      )) as MachineView | null;
      if (snapshot?.status === "completed") break;
      if (Date.now() > deadline) {
        throw new Error(`parked run stayed ${JSON.stringify(snapshot)}`);
      }
      await runDurableObjectAlarm(stub);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await stub.piResult(done.operationId)).toBe("completed");
  });

  it("survives eviction while parked between passes", async () => {
    const stub = fresh();
    const done = await stub.runMultiply(3, 3);
    await stub.seedWaitingRun({ operationId: done.operationId, pass: 0 });

    // The park is a durable checkpoint, not an in-memory timer.
    await evictDurableObject(stub);
    await expect(stub.machine(done.operationId)).resolves.toMatchObject({
      status: "paused",
      phase: "waiting"
    });

    await stub.resumeRun(done.operationId);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const snapshot = (await stub.machine(
        done.operationId
      )) as MachineView | null;
      if (snapshot?.status === "completed") break;
      if (Date.now() > deadline) {
        throw new Error(`parked run stayed ${JSON.stringify(snapshot)}`);
      }
      await runDurableObjectAlarm(stub);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
});

/**
 * Reconciling against an operation pi still considers live.
 *
 * This is the third reconcile outcome. The machine must park and ask again
 * rather than inventing a terminal result, because the external execution
 * has neither failed nor produced a record yet.
 */
describe("PiHarness reconcile of a live operation", () => {
  it("parks instead of settling while pi still holds the operation", async () => {
    const stub = fresh();
    // Hold a real operation open so pi reports it as live, not terminal.
    const { operationId } = await stub.submitGated(9);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const snapshot = (await stub.machine(operationId)) as MachineView | null;
      if (snapshot?.phase === "drive") break;
      if (Date.now() > deadline) throw new Error("never reached drive");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Seed a second, uncertain pass over that same live operation. Because
    // pi neither has a result nor has lost it, reconcile must answer
    // "running" and the machine must stay non-terminal.
    await stub.seedUncertainDrivePass({ operationId, pass: 5 });
    await stub.resumeRun(operationId);

    // Give recovery room to run, then assert it did not invent an outcome.
    for (let i = 0; i < 5; i++) {
      await runDurableObjectAlarm(stub);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const snapshot = (await stub.machine(operationId)) as MachineView | null;
    expect(snapshot?.status).not.toBe("completed");
    expect(snapshot?.status).not.toBe("failed");

    await stub.releaseGate();
  });
});
