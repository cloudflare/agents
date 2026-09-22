import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type Snapshot = {
  status: string;
  result?: string;
  gates?: Array<{ gateId: string; state: string }>;
};

type TinyStub = DurableObjectStub & {
  tinySubmit(prompt: string): Promise<{ runId: string }>;
  tinyInspect(runId: string): Promise<Snapshot | null>;
  tinyResult(runId: string): Promise<string | null>;
  tinyStreamState(runId: string): Promise<string | null>;
  tinyTranscript(runId: string): Promise<string[]>;
  tinyAbort(runId: string, reason?: string): Promise<boolean>;
  answerPermission(
    gateId: string,
    approved: boolean,
    eventId: string
  ): Promise<{ status: string }>;
};

function createStub(): TinyStub {
  return env.StateMachineHarnessObject.getByName(
    crypto.randomUUID()
  ) as unknown as TinyStub;
}

async function waitFor(
  stub: TinyStub,
  runId: string,
  status: string,
  timeoutMs = 5_000
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await stub.tinyInspect(runId);
    if (snapshot?.status === status) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(`Tiny harness run ${runId} stayed ${snapshot?.status}`);
    }
    await runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("native tiny harness", () => {
  it("runs a model phase to completion", async () => {
    const stub = createStub();
    const receipt = await stub.tinySubmit("hello");

    await expect(
      waitFor(stub, receipt.runId, "completed")
    ).resolves.toMatchObject({
      result: "effect:hello"
    });
    await expect(stub.tinyResult(receipt.runId)).resolves.toBe("effect:hello");
    await expect(stub.tinyStreamState(receipt.runId)).resolves.toBe(
      "completed"
    );
    await expect(stub.tinyTranscript(receipt.runId)).resolves.toEqual([
      "effect:hello"
    ]);
  });

  it("parks an exec tool behind a permission gate", async () => {
    const stub = createStub();
    const receipt = await stub.tinySubmit("exec:ls");
    const waiting = await waitFor(stub, receipt.runId, "waiting");
    const gate = waiting.gates?.[0];
    if (!gate) throw new Error("permission gate not found");

    await evictDurableObject(stub);
    await stub.answerPermission(gate.gateId, true, `answer:${gate.gateId}`);

    await expect(
      waitFor(stub, receipt.runId, "completed")
    ).resolves.toMatchObject({
      result: "effect:tool:exec:ls"
    });
    await expect(stub.tinyTranscript(receipt.runId)).resolves.toEqual([
      "effect:tool:exec:ls"
    ]);
  });

  it("does not run a denied tool", async () => {
    const stub = createStub();
    const receipt = await stub.tinySubmit("exec:rm");
    const waiting = await waitFor(stub, receipt.runId, "waiting");
    const gate = waiting.gates?.[0];
    if (!gate) throw new Error("permission gate not found");

    await stub.answerPermission(gate.gateId, false, `answer:${gate.gateId}`);
    await expect(
      waitFor(stub, receipt.runId, "completed")
    ).resolves.toMatchObject({
      result: "denied"
    });
  });

  it("cancels while waiting for permission", async () => {
    const stub = createStub();
    const receipt = await stub.tinySubmit("exec:sleep");
    await waitFor(stub, receipt.runId, "waiting");

    expect(await stub.tinyAbort(receipt.runId, "user stopped")).toBe(true);
    await expect(
      waitFor(stub, receipt.runId, "cancelled")
    ).resolves.toBeTruthy();
  });
});
