import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OpenCodeHarnessTestObject } from "./worker";

/**
 * Resolve once the object has no alarm: its wakes have parked and the
 * harness has closed the idle OpenCode host, so the object can be evicted.
 */
async function settle(stub: DurableObjectStub<OpenCodeHarnessTestObject>) {
  for (let i = 0; i < 200; i++) {
    if ((await stub.alarmTime()) === null) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The object never parked");
}

/**
 * Whether the object has an alarm. The alarm reads as unset for a moment
 * while a job dispatches, so look a few times.
 */
async function alarmed(stub: DurableObjectStub<OpenCodeHarnessTestObject>) {
  for (let i = 0; i < 50; i++) {
    if ((await stub.alarmTime()) !== null) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function fresh(
  name: string = crypto.randomUUID()
): DurableObjectStub<OpenCodeHarnessTestObject> {
  return env.OPENCODE_HARNESS_TEST.getByName(name);
}

describe("OpenCodeHarness on OpenCode v2", () => {
  it("answers a prompt and keeps the transcript across eviction", async () => {
    const stub = fresh();
    const first = await stub.prompt("hello");
    expect(first).toMatchObject({ status: "done", text: "echo: hello" });
    expect(first.messages).toEqual(["hello", "echo: hello"]);
    expect(await stub.pending()).toEqual([]);

    await settle(stub);
    await evictDurableObject(stub);
    expect(await stub.messages()).toEqual(first.messages);

    const second = await stub.prompt("again");
    expect(second).toMatchObject({ status: "done", text: "echo: again" });
  });

  it("keeps OpenCode's tables under its prefix, beside the host's own", async () => {
    const stub = fresh();
    await stub.prompt("hello");
    const tables = await stub.tables();
    expect(tables).toContain("session");
    expect(tables).toContain("cf_agents_jobs");
    expect(tables).toContain("opencode_session_v2");
    expect(tables).toContain("opencode_session_message");
    const unprefixed = tables.filter(
      (name) =>
        !name.startsWith("opencode_") &&
        !name.startsWith("cf_") &&
        !name.startsWith("_cf_")
    );
    expect(unprefixed).toEqual(["session"]);
  });

  it("dedupes a submission by operation id", async () => {
    const stub = fresh();
    const receipt = await stub.submit("hello", { operationId: "op-1" });
    const again = await stub.submit("hello", { operationId: "op-1" });
    expect(receipt).toMatchObject({ operationId: "op-1", accepted: true });
    expect(again).toMatchObject({ operationId: "op-1", accepted: false });
    expect(await stub.wait("op-1")).toMatchObject({
      status: "done",
      text: "echo: hello"
    });
    expect(await stub.messages()).toEqual(["hello", "echo: hello"]);
  });

  it("answers follow-ups queued while a run is going, in order", async () => {
    const stub = fresh();
    const held = await stub.submit("hold");
    await stub.holdStarted(1);
    const one = await stub.submit("one");
    const two = await stub.submit("two");
    expect(await stub.pending()).toEqual([
      { operationId: held.operationId, session: "ses_root", status: "running" },
      { operationId: one.operationId, session: "ses_root", status: "queued" },
      { operationId: two.operationId, session: "ses_root", status: "queued" }
    ]);
    await stub.release();
    expect((await stub.wait(held.operationId)).text).toBe("echo: hold");
    expect((await stub.wait(one.operationId)).text).toBe("echo: one");
    expect((await stub.wait(two.operationId)).text).toBe("echo: two");
    expect((await stub.messages()).slice(-4)).toEqual([
      "one",
      "echo: one",
      "two",
      "echo: two"
    ]);
  });

  it("reports a failed model call as unanswered, with OpenCode's reason", async () => {
    const stub = fresh();
    const result = await stub.prompt("fail");
    expect(result.status).toBe("unanswered");
    expect(result.reason).toMatch(/scripted failure|failed/);
  });

  it("resumes a run after a crash mid-call, woken by the wake job's alarm", async () => {
    const name = crypto.randomUUID();
    let stub = fresh(name);
    const receipt = await stub.submit("hold");
    await stub.holdStarted(1);
    // The wake job keeps a heartbeat while it waits on OpenCode.
    expect(await alarmed(stub)).toBe(true);

    // Graceful eviction waits for the in-flight call, which is the point of
    // the heartbeat, so crash the object instead.
    await abortAllDurableObjects();
    stub = fresh(name);
    // The alarm restarts the object, unless it already fired on its own;
    // OpenCode boots and replays the turn.
    await runDurableObjectAlarm(stub);
    await stub.holdStarted(2);
    await stub.release();

    expect(await stub.wait(receipt.operationId)).toMatchObject({
      status: "done",
      text: "echo: hold"
    });
    expect(await stub.holdRuns()).toBe(2);
  });

  it("withdraws a queued operation, and aborts the running work", async () => {
    const stub = fresh();
    const held = await stub.submit("hold");
    await stub.holdStarted(1);
    const queued = await stub.submit("queued");
    expect(await stub.abort(queued.operationId)).toBe(true);
    expect(await stub.wait(queued.operationId)).toMatchObject({
      status: "unanswered",
      reason: "not_found"
    });

    expect(await stub.abort()).toBe(true);
    expect(await stub.wait(held.operationId)).toMatchObject({
      status: "unanswered",
      reason: "interrupted"
    });
    expect(await stub.pending()).toEqual([]);
  });

  it("streams OpenCode's events for the session, live deltas included", async () => {
    const stub = fresh();
    const types = await stub.watch("hello");
    for (const type of [
      "session.inbox.delivered",
      "session.execution.started",
      "session.text.delta",
      "session.execution.succeeded"
    ]) {
      expect(types).toContain(type);
    }
    const log = await stub.logTypes();
    expect(log).toContain("session.execution.succeeded");
    expect(log).not.toContain("session.text.delta");
  });

  it("parks the session's wake and closes OpenCode once idle, leaving no alarm", async () => {
    const stub = fresh();
    const receipt = await stub.submit("hello");
    await stub.wait(receipt.operationId);
    await settle(stub);
    // OpenCode's background timers are gone, so the object can be evicted.
    await evictDurableObject(stub);
    // The next submit wakes it again.
    expect((await stub.prompt("again")).text).toBe("echo: again");
  });

  it("answers every one of many submissions made to one session at once", async () => {
    const stub = fresh();
    const inputs = Array.from({ length: 8 }, (_, n) => `burst ${n}`);
    const receipts = await Promise.all(
      inputs.map((input) => stub.submit(input))
    );
    const results = await Promise.all(
      receipts.map((receipt) => stub.wait(receipt.operationId))
    );
    expect(results.map((result) => result.status)).toEqual(
      inputs.map(() => "done")
    );
    expect(await stub.pending()).toEqual([]);
  });

  it("recovers every session's run after a crash, from one alarm", async () => {
    const name = crypto.randomUUID();
    let stub = fresh(name);
    const sessions = [
      "ses_root",
      await stub.createSession(),
      await stub.createSession()
    ];
    const receipts = await Promise.all(
      sessions.map((session) => stub.submit("hold", { session }))
    );
    await stub.holdStarted(3);

    await abortAllDurableObjects();
    stub = fresh(name);
    // Run the wake alarm, unless it already fired on its own.
    await runDurableObjectAlarm(stub);
    await stub.holdStarted(6);
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

  it("keeps sessions separate, and forks one", async () => {
    const stub = fresh();
    const other = await stub.createSession();
    await stub.prompt("root");
    await stub.prompt("side", other);
    expect(await stub.messages()).toEqual(["root", "echo: root"]);
    expect(await stub.messages(other)).toEqual(["side", "echo: side"]);

    const fork = await stub.forkSession(other);
    expect(await stub.messages(fork)).toEqual(["side", "echo: side"]);
    const listed = await stub.listSessions();
    expect(listed.map((info) => info.id).sort()).toEqual(
      ["ses_root", other, fork].sort()
    );
    expect(listed.find((info) => info.id === fork)?.parent).toBe(other);
  });
});
