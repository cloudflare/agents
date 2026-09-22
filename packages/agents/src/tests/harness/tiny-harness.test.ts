import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type Snapshot = {
  status: string;
  result?: string;
  error?: { message: string };
  gates?: Array<{ gateId: string; state: string }>;
};

type TestHarnessStub = DurableObjectStub & {
  submit(
    prompt: string,
    options?: { permissionTimeoutMs?: number }
  ): Promise<{ runId: string }>;
  inspect(runId: string): Promise<Snapshot | null>;
  result(runId: string): Promise<string | null>;
  streamState(runId: string): Promise<string | null>;
  transcript(runId: string): Promise<string[]>;
  abort(runId: string, reason?: string): Promise<boolean>;
  answerPermission(
    gateId: string,
    approved: boolean,
    eventId: string
  ): Promise<{ status: string }>;
  withdrawPermission(gateId: string): Promise<boolean>;
};

function createStub(): TestHarnessStub {
  return env.NativeHarnessObject.getByName(
    crypto.randomUUID()
  ) as unknown as TestHarnessStub;
}

async function waitFor(
  stub: TestHarnessStub,
  runId: string,
  status: string,
  timeoutMs = 5_000
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const snapshot = await stub.inspect(runId);
    if (snapshot?.status === status) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(`Native harness run ${runId} stayed ${snapshot?.status}`);
    }
    await runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("native test harness", () => {
  it("runs a model phase to completion", async () => {
    const stub = createStub();
    const receipt = await stub.submit("hello");

    await expect(
      waitFor(stub, receipt.runId, "completed")
    ).resolves.toMatchObject({
      result: "effect:hello"
    });
    await expect(stub.result(receipt.runId)).resolves.toBe("effect:hello");
    await expect(stub.streamState(receipt.runId)).resolves.toBe("completed");
    await expect(stub.transcript(receipt.runId)).resolves.toEqual([
      "effect:hello"
    ]);
  });

  it("parks an exec tool behind a permission gate", async () => {
    const stub = createStub();
    const receipt = await stub.submit("exec:ls");
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
    await expect(stub.transcript(receipt.runId)).resolves.toEqual([
      "effect:tool:exec:ls"
    ]);
  });

  it("does not run a denied tool", async () => {
    const stub = createStub();
    const receipt = await stub.submit("exec:rm");
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

  it("settles permission expiry and withdrawal", async () => {
    const stub = createStub();
    const expiring = await stub.submit("exec:expiry", {
      permissionTimeoutMs: 20
    });
    await expect(
      waitFor(stub, expiring.runId, "completed")
    ).resolves.toMatchObject({
      result: "expired"
    });

    const withdrawn = await stub.submit("exec:withdraw");
    const waiting = await waitFor(stub, withdrawn.runId, "waiting");
    const gate = waiting.gates?.[0];
    if (!gate) throw new Error("permission gate not found");
    expect(await stub.withdrawPermission(gate.gateId)).toBe(true);
    await expect(
      waitFor(stub, withdrawn.runId, "completed")
    ).resolves.toMatchObject({
      result: "withdrawn"
    });
  });

  it("records model and tool failures without terminal output", async () => {
    const stub = createStub();
    const model = await stub.submit("model-error");
    await expect(waitFor(stub, model.runId, "failed")).resolves.toMatchObject({
      error: { message: "model effect failed" }
    });
    await expect(stub.transcript(model.runId)).resolves.toEqual([]);
    await expect(stub.streamState(model.runId)).resolves.toBe("streaming");

    const tool = await stub.submit("exec:tool-error");
    const waiting = await waitFor(stub, tool.runId, "waiting");
    const gate = waiting.gates?.[0];
    if (!gate) throw new Error("permission gate not found");
    await stub.answerPermission(gate.gateId, true, `answer:${gate.gateId}`);
    await expect(waitFor(stub, tool.runId, "failed")).resolves.toMatchObject({
      error: { message: "tool effect failed" }
    });
    await expect(stub.transcript(tool.runId)).resolves.toEqual([]);
  });

  it("cancels while waiting for permission", async () => {
    const stub = createStub();
    const receipt = await stub.submit("exec:sleep");
    await waitFor(stub, receipt.runId, "waiting");

    expect(await stub.abort(receipt.runId, "user stopped")).toBe(true);
    await expect(
      waitFor(stub, receipt.runId, "cancelled")
    ).resolves.toBeTruthy();
  });
});
