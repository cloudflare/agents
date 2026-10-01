import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PiSessionView } from "../view";
import type { PiHarnessTestObject } from "./worker";

function fresh(
  name: string = crypto.randomUUID()
): DurableObjectStub<PiHarnessTestObject> {
  return env.PI_HARNESS_TEST.getByName(name);
}

describe("PiHarness on pi-durable", () => {
  it("answers a prompt with a tool call and keeps the transcript across eviction", async () => {
    const stub = fresh();
    const first = await stub.prompt("multiply 4");
    expect(first).toMatchObject({ status: "done", text: "tool said: 12" });
    expect(first.messages).toEqual(["multiply 4", "", "12", "tool said: 12"]);
    expect(await stub.pending()).toEqual([]);

    await evictDurableObject(stub);
    expect(await stub.messages()).toEqual(first.messages);

    const second = await stub.prompt("hello");
    expect(second).toMatchObject({ status: "done", text: "echo: hello" });
  });

  it("dedupes a submission by operation id", async () => {
    const stub = fresh();
    const receipt = await stub.submit("hello", { operationId: "op-1" });
    const again = await stub.submit("hello", { operationId: "op-1" });
    expect(receipt).toMatchObject({ operationId: "op-1", accepted: true });
    expect(again).toMatchObject({ operationId: "op-1", accepted: false });
    expect((await stub.wait("op-1")).status).toBe("done");
    expect(await stub.messages()).toEqual(["hello", "echo: hello"]);
  });

  it("answers follow-ups queued while a run is going, in order", async () => {
    const stub = fresh();
    const gate = await stub.submit("gate");
    await stub.gateStarted(1);
    const one = await stub.submit("one");
    const two = await stub.submit("two");
    await stub.release();
    expect((await stub.wait(gate.operationId)).text).toBe(
      "tool said: released after 1 runs"
    );
    expect((await stub.wait(one.operationId)).text).toBe("echo: one");
    expect((await stub.wait(two.operationId)).text).toBe("echo: two");
    const messages = await stub.messages();
    expect(messages.slice(-4)).toEqual([
      "one",
      "echo: one",
      "two",
      "echo: two"
    ]);
  });

  it("resumes a replay-safe tool after an eviction mid-call, woken by the wake job's alarm", async () => {
    const name = crypto.randomUUID();
    let stub = fresh(name);
    const receipt = await stub.submit("gate");
    await stub.gateStarted(1);
    // The wake job keeps a heartbeat while it waits on pi.
    expect(await stub.alarmTime()).not.toBeNull();

    // Graceful eviction waits for the in-flight step, which is the point of
    // the heartbeat, so crash the object instead.
    await abortAllDurableObjects();
    stub = fresh(name);
    // The alarm restarts the object; pi reopens and reruns the safe tool.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await stub.gateStarted(2);
    await stub.release();

    const result = await stub.wait(receipt.operationId);
    expect(result).toMatchObject({
      status: "done",
      text: "tool said: released after 2 runs"
    });
    expect(await stub.gateRuns()).toBe(2);
  });

  it("reports an unsafe tool interrupted by an eviction to the model instead of rerunning it", async () => {
    const name = crypto.randomUUID();
    let stub = fresh(name);
    const receipt = await stub.submit("gate-unsafe");
    await stub.gateStarted(1);
    await abortAllDurableObjects();
    stub = fresh(name);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const result = await stub.wait(receipt.operationId);
    expect(result.status).toBe("done");
    expect(result.text).toMatch(/^tool failed: /);
    expect(await stub.gateRuns()).toBe(1);
  });

  it("aborts the running work", async () => {
    const stub = fresh();
    const receipt = await stub.submit("gate");
    await stub.gateStarted(1);
    await stub.abort();
    const result = await stub.wait(receipt.operationId);
    expect(result.status).toBe("unanswered");
    expect(await stub.pending()).toEqual([]);
  });

  it("streams pi's events and folds them into the same view a late joiner gets", async () => {
    const stub = fresh();
    const watching = stub.watch();
    const receipt = await stub.submit("multiply 5");
    await stub.wait(receipt.operationId);
    const { view: folded, types } = await watching;
    const view = JSON.parse(folded) as PiSessionView;
    for (const type of [
      "run_start",
      "tool_execution_start",
      "tool_execution_end",
      "run_end"
    ]) {
      expect(types).toContain(type);
    }
    const late = JSON.parse(await stub.snapshotView()) as PiSessionView;
    expect(view.messages).toEqual(late.messages);
    expect(late.running).toBe(false);
  });

  it("parks the session's wake once pi is idle, leaving no alarm", async () => {
    const stub = fresh();
    const receipt = await stub.submit("hello");
    await stub.wait(receipt.operationId);
    let alarm = await stub.alarmTime();
    for (let i = 0; i < 50 && alarm !== null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      alarm = await stub.alarmTime();
    }
    expect(alarm).toBeNull();
    // The next submit wakes it again.
    expect((await stub.prompt("again")).text).toBe("echo: again");
  });

  it("keeps sessions separate", async () => {
    const stub = fresh();
    const other = await stub.createSession();
    await stub.prompt("root");
    await stub.prompt("side", other);
    expect(await stub.messages()).toEqual(["root", "echo: root"]);
    expect(await stub.messages(other)).toEqual(["side", "echo: side"]);
    expect((await stub.listSessions()).map((session) => session.id)).toEqual([
      "1",
      other
    ]);
  });
});
