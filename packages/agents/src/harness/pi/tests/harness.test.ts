import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PiHarnessTestObject } from "./worker";

function fresh(
  name: string = crypto.randomUUID()
): DurableObjectStub<PiHarnessTestObject> {
  return env.PI_HARNESS_TEST.getByName(name);
}

/**
 * Evict the object the way the runtime evicts an idle one: once nothing is
 * in flight. The pool never evicts an idle object by itself, so without
 * this a test cannot see work that only lives in memory being lost.
 *
 * `evictDurableObject` drains in-flight work first. Resolves "kept" if the
 * object is still holding work after `ms`; `evicted` then settles once
 * that work drains.
 */
async function evictWhenIdle(
  stub: DurableObjectStub<PiHarnessTestObject>,
  ms = 2_000
): Promise<{ result: "evicted" | "kept"; evicted: Promise<void> }> {
  const evicted = evictDurableObject(stub);
  const result = await Promise.race([
    evicted.then(() => "evicted" as const),
    new Promise<"kept">((resolve) => setTimeout(() => resolve("kept"), ms))
  ]);
  return { result, evicted };
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

  it("evicts an object with nothing in flight once its wake has parked", async () => {
    const stub = fresh();
    expect((await stub.prompt("hello")).text).toBe("echo: hello");
    let alarm = await stub.alarmTime();
    for (let i = 0; i < 50 && alarm !== null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      alarm = await stub.alarmTime();
    }
    const before = await stub.instance();

    expect((await evictWhenIdle(stub)).result).toBe("evicted");
    expect(await stub.instance()).not.toBe(before);
  });

  it("holds the object while a tool waits without I/O, so the tool runs once", async () => {
    const stub = fresh();
    const receipt = await stub.submit("hold");
    await stub.holdStarted(1);
    const instance = await stub.instance();

    // Nothing but the wake keeps the object alive while the tool waits.
    const eviction = await evictWhenIdle(stub);
    expect(eviction.result).toBe("kept");
    // Heartbeats find the same instance, so pi has nothing to resume.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.instance()).toBe(instance);

    expect(await stub.releaseHold()).toBe(true);
    expect(await stub.wait(receipt.operationId)).toMatchObject({
      status: "done",
      text: "tool said: held after 1 runs"
    });
    expect(await stub.holdRuns()).toBe(1);
    // With pi idle, the object drains and the eviction completes.
    await eviction.evicted;
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

  it("waits on a run longer than the wait budget across several wakes", async () => {
    const stub = fresh();
    // pi's work runs inside the alarm that started it, and alarms have a
    // 15 minute wall-time limit, so one wake never waits longer than this.
    await stub.setWaitBudget(100);
    const receipt = await stub.submit("gate");
    await stub.gateStarted(1);

    let waits = await stub.idleWaits();
    for (let i = 0; i < 100 && waits < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      waits = await stub.idleWaits();
    }
    expect(waits).toBeGreaterThanOrEqual(3);

    await stub.release();
    expect((await stub.wait(receipt.operationId)).text).toBe(
      "tool said: released after 1 runs"
    );
    expect(await stub.gateRuns()).toBe(1);
  });

  it("counts a memory-limit reset during the wake's wait against its breaker", async () => {
    const name = crypto.randomUUID();
    await fresh(name).failNextIdleWait(
      "Durable Object's isolate exceeded its memory limit and was reset."
    );
    await fresh(name).submit("gate");

    // The breaker resets the object once it records the strike.
    let strikes = 0;
    for (let i = 0; i < 100 && strikes === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      strikes = await fresh(name)
        .memoryLimitStrikes()
        .catch(() => 0);
    }
    expect(strikes).toBe(1);
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

  it("streams pi's events, and a late snapshot carries the same transcript", async () => {
    const stub = fresh();
    const watching = stub.watch();
    const receipt = await stub.submit("multiply 5");
    await stub.wait(receipt.operationId);
    const types = await watching;
    for (const type of [
      "snapshot",
      "run_start",
      "tool_execution_start",
      "tool_execution_end",
      "run_end"
    ]) {
      expect(types).toContain(type);
    }
    expect(await stub.snapshotTexts()).toEqual(await stub.messages());
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

  it("answers every one of many submissions made to one session at once", async () => {
    const stub = fresh();
    const inputs = Array.from({ length: 12 }, (_, n) => `burst ${n}`);
    const receipts = await Promise.all(
      inputs.map((input) => stub.submit(input))
    );
    const results = await Promise.all(
      receipts.map((receipt) => stub.wait(receipt.operationId))
    );
    expect(results.map((result) => result.text)).toEqual(
      inputs.map((input) => `echo: ${input}`)
    );
    // Each input is followed by its own answer, whatever order they ran in.
    const messages = await stub.messages();
    expect(messages).toHaveLength(inputs.length * 2);
    for (let i = 0; i < messages.length; i += 2) {
      expect(messages[i + 1]).toBe(`echo: ${messages[i]}`);
    }
    expect(await stub.pending()).toEqual([]);
  });

  it("recovers every session's run after a crash, from one alarm", async () => {
    const name = crypto.randomUUID();
    let stub = fresh(name);
    const sessions = [
      "1",
      await stub.createSession(),
      await stub.createSession()
    ];
    const receipts = await Promise.all(
      sessions.map((session) => stub.submit("gate", { session }))
    );
    await stub.gateStarted(3);

    await abortAllDurableObjects();
    stub = fresh(name);
    // Run the wake alarm, unless its 1s heartbeat already fired on its own
    // while the three gates started. The gate runs below prove the recovery.
    await runDurableObjectAlarm(stub);
    // Each session's safe tool runs again.
    await stub.gateStarted(6);
    await stub.release();

    const results = await Promise.all(
      receipts.map((receipt, i) => stub.wait(receipt.operationId, sessions[i]))
    );
    expect(results.map((result) => result.status)).toEqual([
      "done",
      "done",
      "done"
    ]);
    expect(await stub.pending()).toEqual([]);
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
