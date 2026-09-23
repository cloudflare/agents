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
  effects?: {
    kind: string;
    recovery: string;
    status: string;
    externalId?: string;
  }[];
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

    // Pi must reach a terminal state of its own. A machine that settles
    // while pi still believes the operation is live would leak the
    // execution, so assert pi actually stopped rather than merely that it
    // did not succeed.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const piStatus = await stub.piResult(operationId);
      if (piStatus !== null) {
        expect(piStatus).not.toBe("completed");
        break;
      }
      if (Date.now() > deadline) throw new Error("pi never settled the abort");
      await runDurableObjectAlarm(stub);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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

  it("gives each pass its own effect identity", async () => {
    const stub = fresh();
    // Park at pass 3 so the next pass must be 4, not a repeat of 3. Reusing
    // an effect id would collide with the settled row from the earlier
    // pass, and the run would read that stale outcome instead of driving pi.
    const done = await stub.runMultiply(5, 1);
    const operationId = done.operationId;
    await stub.seedWaitingRun({ operationId, pass: 3 });
    await stub.resumeRun(operationId);

    const deadline = Date.now() + 10_000;
    for (;;) {
      const ids = await stub.effectExternalIds(operationId);
      if (ids.includes(`${operationId}:4`)) break;
      if (Date.now() > deadline) {
        throw new Error(`pass 4 never planned: ${JSON.stringify(ids)}`);
      }
      await runDurableObjectAlarm(stub);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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

/**
 * The recovery policy the machine commits for each drive pass.
 *
 * This is the contract that makes pi a *wrapped* runtime rather than a
 * replayed one. A pass marked `safe` would re-run the model after a crash
 * and `never` would abandon a recoverable operation, so the planned policy
 * is asserted directly on the durable effect row instead of being implied
 * by downstream behaviour.
 */
describe("PiHarness effect planning", () => {
  it("plans each drive pass as a reconcilable effect keyed by pi's id", async () => {
    const stub = fresh();
    const { operationId } = await stub.submitGated(11);

    const deadline = Date.now() + 10_000;
    let planned: NonNullable<MachineView["effects"]> = [];
    for (;;) {
      const snapshot = (await stub.machine(operationId)) as MachineView | null;
      planned = snapshot?.effects ?? [];
      if (planned.length > 0) break;
      if (Date.now() > deadline) {
        throw new Error(`no effect planned: ${JSON.stringify(snapshot)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(planned[0]).toMatchObject({
      kind: "pi-drive",
      // Recovery must consult pi, never repeat or abandon the request.
      recovery: "reconcile",
      // The external id is pi's own operation id plus the pass number, so
      // recovery can find the right execution to ask about.
      externalId: `${operationId}:0`
    });

    await stub.releaseGate();
  });
});

/**
 * Failure and startup repair.
 *
 * These cover the two paths a run takes when something goes wrong rather
 * than merely slowly: a drive pass that cannot settle, and a submission
 * whose machine run was never created because the object died between
 * `submit()`'s two durable writes.
 */
describe("PiHarness failure and repair", () => {
  async function settle(
    stub: DurableObjectStub<PiHarnessTestObject>,
    operationId: string,
    timeoutMs = 10_000
  ): Promise<MachineView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = (await stub.machine(operationId)) as MachineView | null;
      if (
        snapshot &&
        snapshot.status !== "running" &&
        snapshot.status !== "waiting" &&
        snapshot.status !== "paused"
      ) {
        return snapshot;
      }
      if (Date.now() > deadline) {
        throw new Error(`run stayed ${JSON.stringify(snapshot)}`);
      }
      await runDurableObjectAlarm(stub);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("settles the run when a drive pass cannot complete", async () => {
    const stub = fresh();
    const operationId = await stub.submitFailing();

    // The run must reach a terminal state rather than parking forever, and
    // the failure has to be visible on the machine, not just inside pi.
    const settled = await settle(stub, operationId);
    expect(["completed", "failed"]).toContain(settled.status);
    if (settled.status === "completed") {
      // Pi settled it as a failed operation; the machine reports that.
      expect(settled.result).toMatchObject({ status: "failed" });
    }
  });

  it("settles as failed when a drive pass could not run", async () => {
    const stub = fresh();
    const operationId = await stub.seedFailedPass();
    await stub.resumeRun(operationId);

    // The machine must turn the failed effect into a terminal operation
    // carrying pi's failure, not park waiting for a pass that will never
    // report.
    const settled = await settle(stub, operationId);
    expect(settled.status).toBe("completed");
    expect(settled.result).toMatchObject({
      operationId,
      status: "failed",
      error: { code: "drive_failed" }
    });
  });

  it("admits a submission whose machine run was never created", async () => {
    const stub = fresh();
    const operationId = await stub.seedOrphanedSubmission(6);
    // The intake row exists but no machine run does.
    expect(await stub.machine(operationId)).toBeNull();
    expect(await stub.pendingCount()).toBeGreaterThan(0);

    // Startup reconciliation must notice the orphan and admit it.
    await evictDurableObject(stub);
    await stub.messages();

    const settled = await settle(stub, operationId);
    expect(settled.status).toBe("completed");
    expect(await stub.piResult(operationId)).toBe("completed");
  });
});

/**
 * Lane fidelity across recovery.
 *
 * Every other test in this suite runs on the default lane, where a lookup
 * that loses track of the lane still resolves to the right one by accident.
 * These use a second lane so that a lane lost across an eviction is visible
 * as a wrong answer rather than a coincidentally correct one.
 */
describe("PiHarness multi-lane recovery", () => {
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

  it("reconciles an operation on a non-default lane after eviction", async () => {
    const stub = fresh();
    const { operationId } = await stub.submitGatedOnLane("research", 11);
    await waitForPhase(stub, operationId, "drive");

    // The lane lives in the durable checkpoint, which is what recovery
    // consults. Read it while the run is in flight: the checkpoint is
    // cleared once the run settles.
    expect(await stub.laneOf(operationId)).toBe("research");

    // Drop the object so recovery has to reconcile the in-flight effect
    // from durable state alone, with no process-local lane table.
    await evictDurableObject(stub);
    await stub.releaseGate();

    const settled = await waitForStatus(stub, operationId, "completed");
    expect(settled.status).toBe("completed");

    // Pi keys results by operation id session-wide, so the assertion that
    // matters is not which lane can read the record but that the operation
    // actually ran to completion on "research" rather than being lost or
    // reconciled against the wrong lane's live execution.
    expect(await stub.piResultOnLane("research", operationId)).toBe(
      "completed"
    );
  });

  it("cancels an operation on a non-default lane", async () => {
    const stub = fresh();
    const { operationId } = await stub.submitGatedOnLane("research", 12);
    await waitForPhase(stub, operationId, "drive");

    expect(await stub.abortOnLane("research", operationId)).toBe(true);
    const settled = await waitForStatus(stub, operationId, "cancelled");
    expect(settled.status).toBe("cancelled");
    await stub.releaseGate();

    // The abort has to reach pi on "research"; a cancel sent to the wrong
    // lane would leave this operation running there.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const piStatus = await stub.piResultOnLane("research", operationId);
      if (piStatus !== null) {
        expect(piStatus).not.toBe("completed");
        break;
      }
      if (Date.now() > deadline) throw new Error("pi never settled the abort");
      await runDurableObjectAlarm(stub);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
});
