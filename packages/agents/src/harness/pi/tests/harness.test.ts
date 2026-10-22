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

/** Whether the alarm clears within a second, as a completed wake leaves it. */
async function alarmCleared(
  stub: DurableObjectStub<PiHarnessTestObject>
): Promise<boolean> {
  let alarm = await stub.alarmTime();
  for (let i = 0; i < 50 && alarm !== null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    alarm = await stub.alarmTime();
  }
  return alarm === null;
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

  it("evicts an object with nothing in flight once its wake has completed", async () => {
    const stub = fresh();
    expect((await stub.prompt("hello")).text).toBe("echo: hello");
    expect(await alarmCleared(stub)).toBe(true);
    const before = await stub.instance();

    expect((await evictWhenIdle(stub)).result).toBe("evicted");
    expect(await stub.instance()).not.toBe(before);
  });

  it("holds the object while a tool waits without I/O, so the tool runs once", async () => {
    const stub = fresh();
    const receipt = await stub.submit("hold");
    await stub.holdStarted(1);
    const instance = await stub.instance();

    // Nothing but the wake's wait keeps the object alive while the tool
    // waits.
    const eviction = await evictWhenIdle(stub);
    expect(eviction.result).toBe("kept");
    // The alarm firing does not move the work to a new instance.
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

  it("places an input as the entry the caller names, queued or not", async () => {
    const name = crypto.randomUUID();
    let stub = fresh(name);
    const scheduled = { kind: "app.scheduled", data: { job: "daily" } };
    const first = await stub.submit("hello", {
      operationId: "op-1",
      entry: scheduled
    });
    expect((await stub.wait(first.operationId)).text).toBe("echo: hello");
    const again = await stub.submit("hello", {
      operationId: "op-1",
      entry: scheduled
    });
    expect(again.accepted).toBe(false);

    // Queued behind a run, and across a crash while it waits.
    const gate = await stub.submit("gate");
    await stub.gateStarted(1);
    const approval = await stub.submit("approved: run the migration", {
      entry: { kind: "app.approval", data: { approved: true } }
    });
    await abortAllDurableObjects();
    stub = fresh(name);
    await runDurableObjectAlarm(stub);
    await stub.gateStarted(2);
    await stub.release();
    await stub.wait(gate.operationId);
    expect((await stub.wait(approval.operationId)).text).toBe(
      "echo: approved: run the migration"
    );

    const entries = await stub.entries();
    expect(entries.filter((entry) => entry.role === "user")).toEqual([
      {
        kind: "app.scheduled",
        data: '{"job":"daily"}',
        role: "user",
        text: "hello"
      },
      { kind: "pi.user", data: "null", role: "user", text: "gate" },
      {
        kind: "app.approval",
        data: '{"approved":true}',
        role: "user",
        text: "approved: run the migration"
      }
    ]);
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
    // The wake job keeps a heartbeat while it waits on pi's running work.
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

    // Each wait ends at the budget and steps the wake again, which starts
    // the next wait. Without the budget, one wait lasts the whole run.
    const start = await stub.wakeSteps();
    let steps = start;
    for (let i = 0; i < 100 && steps < start + 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      steps = await stub.wakeSteps();
    }
    expect(steps - start).toBeGreaterThanOrEqual(3);

    await stub.release();
    expect((await stub.wait(receipt.operationId)).text).toBe(
      "tool said: released after 1 runs"
    );
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

  it("completes the wake once pi is idle, leaving no alarm", async () => {
    const stub = fresh();
    const receipt = await stub.submit("hello");
    await stub.wait(receipt.operationId);
    expect(await alarmCleared(stub)).toBe(true);
    // The next submit wakes it again.
    expect((await stub.prompt("again")).text).toBe("echo: again");
  });

  it("sets the alarm for pi's sleeping retry, so the object can be evicted until then", async () => {
    const name = `retry:${crypto.randomUUID()}`;
    const stub = fresh(name);
    const receipt = await stub.submit("flaky");
    // The first generation fails as retryable; pi sleeps until its retry.
    let wake = await stub.piWake();
    for (let i = 0; i < 100 && wake.at === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      wake = await stub.piWake();
    }
    expect(wake).toEqual({ active: false, at: expect.any(Number) });
    // onWake moved the wake job to the retry, not the heartbeat.
    let alarm = await stub.alarmTime();
    for (let i = 0; i < 50 && alarm !== wake.at; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      alarm = await stub.alarmTime();
    }
    expect(alarm).toBe(wake.at);
    // pi holds no timer, so nothing keeps the object in memory.
    await evictDurableObject(stub);

    // The alarm restarts the object at the retry, and pi runs it.
    const result = await stub.wait(receipt.operationId);
    expect(result).toMatchObject({ status: "done", text: "echo: flaky" });
  });

  it("answers after a sleeping retry without onWake, on pi's own timer", async () => {
    const stub = fresh(`nowake:retry:${crypto.randomUUID()}`);
    const result = await stub.prompt("flaky");
    expect(result).toMatchObject({ status: "done", text: "echo: flaky" });
  });

  it.each(["park:", "nowake:park:"])(
    "shows a task pi's restart limit parked, and retry() resumes it (%s)",
    async (variant) => {
      const name = `${variant}${crypto.randomUUID()}`;
      let stub = fresh(name);
      const receipt = await stub.submit("gate");
      await stub.gateStarted(1);
      // Nothing is parked yet.
      expect(await stub.retry()).toBe(false);
      await abortAllDurableObjects();
      stub = fresh(name);
      await runDurableObjectAlarm(stub);
      let pending = await stub.pending();
      for (let i = 0; i < 100 && pending[0]?.status !== "parked"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        pending = await stub.pending();
      }
      expect(pending).toEqual([
        { operationId: receipt.operationId, session: "1", status: "parked" }
      ]);
      let jobs = await stub.wakeJobs();
      for (let i = 0; i < 100 && jobs.length > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        jobs = await stub.wakeJobs();
      }
      expect(jobs).toEqual([]);

      expect(await stub.retry()).toBe(true);
      // The retry wakes the harness again, so an eviction now recovers.
      expect(await stub.wakeJobs()).toEqual(["pi-wake"]);
      await stub.gateStarted(2);
      expect(await stub.pending()).toEqual([
        { operationId: receipt.operationId, session: "1", status: "running" }
      ]);
      await stub.release();
      expect(await stub.wait(receipt.operationId)).toMatchObject({
        status: "done",
        text: "tool said: released after 2 runs"
      });
      expect(await stub.pending()).toEqual([]);
    }
  );

  it("completes the wake, leaving no alarm, when pi's restart limit parks a task", async () => {
    const name = `park:${crypto.randomUUID()}`;
    let stub = fresh(name);
    await stub.submit("gate");
    await stub.gateStarted(1);
    await abortAllDurableObjects();
    stub = fresh(name);
    // The alarm restarts the object. pi parks the cut-off task instead of
    // running it again, so the wake has nothing to wait for.
    await runDurableObjectAlarm(stub);
    let jobs = await stub.wakeJobs();
    for (let i = 0; i < 100 && jobs.length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      jobs = await stub.wakeJobs();
    }
    expect(jobs).toEqual([]);
    expect(await stub.alarmTime()).toBeNull();
    expect(await stub.piWake()).toEqual({ active: false });
    expect(await stub.gateRuns()).toBe(1);
  });

  it("hands a per-session wake job from before Pi 1.4 over to the one wake", async () => {
    const stub = fresh();
    await stub.addLegacyWakeJob();
    expect(await stub.wakeJobs()).toContain("pi-wake:1");
    await runDurableObjectAlarm(stub);
    let jobs = await stub.wakeJobs();
    for (let i = 0; i < 100 && jobs.length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      jobs = await stub.wakeJobs();
    }
    // pi has nothing to do, so the one wake completed too.
    expect(jobs).toEqual([]);
    expect((await stub.prompt("hello")).text).toBe("echo: hello");
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

  it("reopens pi from what it committed after a storage error fails its Session", async () => {
    const stub = fresh();
    const first = await stub.prompt("hello");
    expect(first.text).toBe("echo: hello");

    // A commit hits the error, which fails pi's Session: the submit rejects,
    // with the error or with SessionFailed.
    expect(await stub.submitThroughStorageError("lost")).not.toBe("submitted");

    // The next call opens pi again, over what it had committed.
    const again = await stub.prompt("again");
    expect(again).toMatchObject({ status: "done", text: "echo: again" });
    expect(again.messages).toEqual([
      "hello",
      "echo: hello",
      "again",
      "echo: again"
    ]);
  });

  it("resumes a run a storage error interrupted, woken by the wake job", async () => {
    const stub = fresh();
    const receipt = await stub.submit("gate");
    await stub.gateStarted(1);

    // Fails pi's Session mid-run, which aborts the gate tool.
    expect(await stub.submitThroughStorageError("one")).not.toBe("submitted");

    // Nothing calls pi from here until the gate reruns: the wake job reopens
    // pi, which resumes the replay-safe tool. With onWake wired, the wake
    // job was sleeping on the failed pi until the wait budget, which pi no
    // longer ends by calling onWake; pi closing must end that sleep.
    await stub.gateStarted(2);
    await stub.release();
    expect(await stub.wait(receipt.operationId)).toMatchObject({
      status: "done",
      text: "tool said: released after 2 runs"
    });
  });

  it("opens pi again on the next call after dispose()", async () => {
    const stub = fresh();
    expect((await stub.prompt("hello")).text).toBe("echo: hello");
    await stub.dispose();
    const again = await stub.prompt("again");
    expect(again).toMatchObject({ status: "done", text: "echo: again" });
    expect(again.messages).toEqual([
      "hello",
      "echo: hello",
      "again",
      "echo: again"
    ]);
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
