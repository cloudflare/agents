import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  ContainerHarnessTestObject,
  ContainerRetryTestObject
} from "./worker";

function fresh(
  name: string = crypto.randomUUID()
): DurableObjectStub<ContainerHarnessTestObject> {
  return env.CONTAINER_HARNESS_TEST.getByName(name);
}

function freshRetry(
  name: string = crypto.randomUUID()
): DurableObjectStub<ContainerRetryTestObject> {
  return env.CONTAINER_RETRY_TEST.getByName(name);
}

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("ContainerHarness", () => {
  it("starts the container on the first prompt and answers through the daemon", async () => {
    const stub = fresh();
    expect((await stub.container()).running).toBe(false);

    const first = await stub.prompt("hello");
    expect(first).toMatchObject({
      status: "done",
      text: "echo: hello (turn 1)"
    });
    expect(first.messages).toEqual(["hello", "echo: hello (turn 1)"]);
    expect(await stub.pending()).toEqual([]);

    const container = await stub.container();
    expect(container).toMatchObject({
      running: true,
      starts: 1,
      // The idle stop (a minute) runs before the platform stop (plus a grace).
      inactivityTimeoutMs: 180_000
    });
    expect(container.env.CF_HARNESS_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(container.env.CF_HARNESS_PORT).toBe("8080");

    const second = await stub.prompt("again");
    expect(second.text).toBe("echo: again (turn 2)");
    expect((await stub.container()).starts).toBe(1);
  });

  it("keeps the transcript across eviction", async () => {
    const stub = fresh();
    await stub.prompt("one");
    await evictDurableObject(stub);
    expect(await stub.messages()).toEqual(["one", "echo: one (turn 1)"]);
    expect((await stub.prompt("two")).text).toBe("echo: two (turn 2)");
  });

  it("dedupes a submission by operation id", async () => {
    const stub = fresh();
    const receipt = await stub.submit("hello", { operationId: "op-1" });
    const again = await stub.submit("hello", { operationId: "op-1" });
    expect(receipt).toMatchObject({ operationId: "op-1", accepted: true });
    expect(again).toMatchObject({ operationId: "op-1", accepted: false });
    expect(await stub.wait("op-1")).toMatchObject({
      status: "done",
      text: "echo: hello (turn 1)"
    });
    expect(await stub.messages()).toEqual(["hello", "echo: hello (turn 1)"]);
  });

  it("answers follow-ups queued behind a running turn, in order", async () => {
    const stub = fresh();
    const slow = await stub.submit("slow 300 first");
    const one = await stub.submit("one");
    const two = await stub.submit("two");
    expect((await stub.wait(slow.operationId)).text).toBe(
      "echo: first (turn 1)"
    );
    expect((await stub.wait(one.operationId)).text).toBe("echo: one (turn 2)");
    expect((await stub.wait(two.operationId)).text).toBe("echo: two (turn 3)");
    expect(await stub.messages()).toEqual([
      "slow 300 first",
      "echo: first (turn 1)",
      "one",
      "echo: one (turn 2)",
      "two",
      "echo: two (turn 3)"
    ]);
  });

  it("folds a steer into the running turn", async () => {
    const stub = fresh();
    const slow = await stub.submit("slow 300 base");
    await stub.running(slow.operationId);
    const steer = await stub.submit("more", { whenBusy: "steer" });
    const [first, second] = await Promise.all([
      stub.wait(slow.operationId),
      stub.wait(steer.operationId)
    ]);
    expect(first.text).toBe("echo: base + more (turn 1)");
    expect(second.text).toBe(first.text);
  });

  it("aborts a running operation and keeps the session usable", async () => {
    const stub = fresh();
    const slow = await stub.submit("slow 5000 never");
    await stub.running(slow.operationId);
    expect(await stub.abort(slow.operationId)).toBe(true);
    expect(await stub.wait(slow.operationId)).toMatchObject({
      status: "unanswered",
      reason: "aborted"
    });
    expect((await stub.prompt("after")).text).toBe("echo: after (turn 1)");
  });

  it("withdraws every open operation of a session", async () => {
    const stub = fresh();
    const slow = await stub.submit("slow 5000 never");
    const queued = await stub.submit("queued");
    await stub.running(slow.operationId);
    expect(await stub.abort()).toBe(true);
    for (const receipt of [slow, queued]) {
      expect(await stub.wait(receipt.operationId)).toMatchObject({
        status: "unanswered",
        reason: "aborted"
      });
    }
    expect(await stub.busy()).toBe(false);
    expect((await stub.prompt("after")).text).toBe("echo: after (turn 1)");
  });

  it("reports an adapter's failure as unanswered", async () => {
    const stub = fresh();
    const result = await stub.prompt("fail out of tokens");
    expect(result).toMatchObject({
      status: "unanswered",
      reason: "out of tokens"
    });
  });

  it("streams events for a turn", async () => {
    const stub = fresh();
    const watching = stub.watch(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stub.submit("hello");
    expect(await watching).toEqual([
      "message",
      "operation-start",
      "text-delta",
      "message",
      "operation-end"
    ]);
  });

  it("delivers events that arrive between the snapshot and start()", async () => {
    const stub = fresh();
    expect(await stub.watchLate("hello")).toEqual([
      "message",
      "operation-start",
      "text-delta",
      "message",
      "operation-end"
    ]);
  });

  it("stops the container when idle and resumes the session in a new one", async () => {
    const stub = fresh();
    await stub.shortenIdle(50);
    expect((await stub.prompt("one")).text).toBe("echo: one (turn 1)");
    await until(async () => {
      await runDurableObjectAlarm(stub);
      return !(await stub.container()).running;
    }, "the idle stop");

    // The next prompt starts a new container. The adapter is restored from
    // what it persisted, so the session continues: this is turn 2.
    const next = await stub.prompt("two");
    expect(next.text).toBe("echo: two (turn 2)");
    expect(next.messages).toEqual([
      "one",
      "echo: one (turn 1)",
      "two",
      "echo: two (turn 2)"
    ]);
    expect((await stub.container()).starts).toBe(2);
  });

  it("settles a run lost with its container and resumes the session", async () => {
    const stub = fresh();
    expect((await stub.prompt("one")).text).toBe("echo: one (turn 1)");
    const slow = await stub.submit("slow 5000 lost");
    const queued = await stub.submit("queued");
    await stub.running(slow.operationId);

    await stub.crashContainer();
    expect(await stub.wait(slow.operationId)).toMatchObject({
      status: "unanswered",
      reason: "container_lost"
    });
    // The queued operation never reached the old container's adapter; it
    // runs in the new one, which resumed the session.
    expect((await stub.wait(queued.operationId)).text).toBe(
      "echo: queued (turn 2)"
    );
    expect((await stub.container()).starts).toBe(2);
  });

  it("runs a lost operation again with onContainerLost: retry", async () => {
    const stub = freshRetry();
    const slow = await stub.submit("slow 300 retried");
    await stub.running(slow.operationId);
    await stub.crashContainer();
    expect(await stub.wait(slow.operationId)).toMatchObject({
      status: "done",
      text: "echo: retried (turn 1)"
    });
    expect((await stub.container()).starts).toBe(2);
  });

  it("reattaches after the socket drops mid-run and replays what it missed", async () => {
    const stub = fresh();
    const slow = await stub.submit("slow 300 survived");
    await stub.running(slow.operationId);

    // The container finishes the turn with nobody attached; the wake
    // reattaches and replays the frames from its cursor.
    await stub.dropSockets();
    expect(await stub.wait(slow.operationId)).toMatchObject({
      status: "done",
      text: "echo: survived (turn 1)"
    });
    expect(await stub.messages()).toEqual([
      "slow 300 survived",
      "echo: survived (turn 1)"
    ]);
    expect((await stub.container()).starts).toBe(1);
  });

  it("adopts the running container after the object restarts", async () => {
    const name = crypto.randomUUID();
    let stub = fresh(name);
    expect((await stub.prompt("one")).text).toBe("echo: one (turn 1)");

    await abortAllDurableObjects();
    stub = fresh(name);
    // The same container, and the session still open in it: no restart and
    // no restore, and the object re-arms the container's idle timeout.
    expect((await stub.prompt("two")).text).toBe("echo: two (turn 2)");
    expect(await stub.container()).toMatchObject({
      starts: 1,
      // The idle stop (a minute) runs before the platform stop (plus a grace).
      inactivityTimeoutMs: 180_000
    });
  });

  it("wakes from its alarm after the object restarts with queued work", async () => {
    const name = crypto.randomUUID();
    let stub = fresh(name);
    await stub.prompt("warm");
    await stub.failStarts(true);
    await stub.crashContainer();
    const receipt = await stub.submit("queued");
    // The start fails, so the wake job backs off and stays due.
    await until(
      async () => (await stub.alarmTime()) !== null,
      "the wake job's retry"
    );

    await abortAllDurableObjects();
    stub = fresh(name);
    await stub.failStarts(false);
    await until(async () => {
      await runDurableObjectAlarm(stub);
      return (await stub.pending()).length === 0;
    }, "the alarm to run the queued work");
    expect((await stub.wait(receipt.operationId)).text).toBe(
      "echo: queued (turn 2)"
    );
  });

  it("gives up after repeated failed starts, and tries again on the next submit", async () => {
    const stub = fresh();
    await stub.failStarts(true);
    const receipt = await stub.submit("hello");
    await until(async () => {
      await runDurableObjectAlarm(stub);
      return (await stub.pending()).length === 0;
    }, "the start failures to give up");
    expect(await stub.wait(receipt.operationId)).toMatchObject({
      status: "unanswered",
      reason: "container_unavailable"
    });
    await stub.failStarts(false);
    expect((await stub.prompt("later")).text).toBe("echo: later (turn 1)");
  });

  it("counts failed starts durably, so an evicted object still gives up", async () => {
    const name = crypto.randomUUID();
    let stub = fresh(name);
    await stub.failStarts(true);
    const receipt = await stub.submit("hello");
    await until(async () => {
      await runDurableObjectAlarm(stub);
      return (await stub.container()).startAttempts >= 2;
    }, "two failed starts");
    // Evict between attempts: the count must survive in the wake job.
    await abortAllDurableObjects();
    stub = fresh(name);
    await until(async () => {
      await runDurableObjectAlarm(stub);
      return (await stub.pending()).length === 0;
    }, "the start failures to give up");
    expect(await stub.wait(receipt.operationId)).toMatchObject({
      status: "unanswered",
      reason: "container_unavailable"
    });
    // Five attempts in all, counted across the eviction (one in flight
    // when the object was aborted may not have reached `start()`).
    const { startAttempts } = await stub.container();
    expect(startAttempts).toBeGreaterThanOrEqual(4);
    expect(startAttempts).toBeLessThanOrEqual(5);
  });

  it("forks a session that continues the parent's history as a branch", async () => {
    const stub = fresh();
    await stub.prompt("one");
    await stub.prompt("two");
    const fork = await stub.forkSession("root");
    expect(await stub.messages(fork)).toEqual(await stub.messages());

    expect((await stub.prompt("restored?", fork)).text).toBe("2");
    expect((await stub.prompt("three", fork)).text).toBe(
      "echo: three (turn 3)"
    );
    // The parent is untouched.
    expect((await stub.prompt("three")).text).toBe("echo: three (turn 3)");
    expect(await stub.listSessions()).toEqual([
      { id: "root", busy: false },
      { id: fork, parent: "root", busy: false }
    ]);
  });

  it("creates independent sessions", async () => {
    const stub = fresh();
    const other = await stub.createSession();
    await stub.prompt("root one");
    expect((await stub.prompt("other one", other)).text).toBe(
      "echo: other one (turn 1)"
    );
    expect(await stub.messages(other)).toEqual([
      "other one",
      "echo: other one (turn 1)"
    ]);
  });

  it("resets a session to a new context with a handoff note", async () => {
    const stub = fresh();
    await stub.prompt("one");
    expect(await stub.reset("summary: said one")).toBeUndefined();
    expect(await stub.messages()).toEqual([]);
    const next = await stub.prompt("two");
    // The adapter started over (turn 1) and saw the note before the prompt.
    expect(next.text).toBe("echo: summary: said one\ntwo (turn 1)");
    expect(next.messages).toEqual(["two", next.text]);
  });

  it("refuses to reset a busy session", async () => {
    const stub = fresh();
    const slow = await stub.submit("slow 300 busy");
    expect(await stub.reset()).toMatch(/busy/);
    await stub.wait(slow.operationId);
  });

  it("applies the default model and changes it live", async () => {
    const stub = fresh();
    expect((await stub.prompt("model?")).text).toBe("small");
    await stub.setModel("large");
    expect((await stub.prompt("model?")).text).toBe("large");
    // A new container opens the session with the stored model.
    await stub.stopContainer();
    expect((await stub.prompt("model?")).text).toBe("large");
  });

  it("restores resume state larger than one message across several", async () => {
    const stub = fresh();
    // 60 entries of 10 kB: several persist frames out, several restore
    // messages back.
    expect((await stub.prompt("bulk 60")).text).toBe("stored");
    await stub.stopContainer();
    expect((await stub.prompt("restored?")).text).toBe("60");
  });

  it("returns not_found for an unknown operation", async () => {
    const stub = fresh();
    expect(await stub.wait("nope")).toMatchObject({
      status: "unanswered",
      reason: "not_found"
    });
  });
});
