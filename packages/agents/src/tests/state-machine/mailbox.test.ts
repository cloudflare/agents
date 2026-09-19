import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  Approval,
  backdateTaskWake,
  type TaskHarnessObject
} from "../capabilities/tasks";
import { TaskMailboxFullError } from "../../tasks";
import type { TaskChange, TaskRunSnapshot, TaskValue } from "../../tasks";

/** Poll one run until it reaches one of the given states. */
async function waitForState(
  tasks: { get(runId: string): Promise<TaskRunSnapshot<TaskValue> | null> },
  runId: string,
  states: ReadonlyArray<TaskRunSnapshot<TaskValue>["state"]>,
  timeoutMs = 5_000
): Promise<TaskRunSnapshot<TaskValue>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await tasks.get(runId);
    if (snapshot && states.includes(snapshot.state)) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(
        `Run ${runId} stuck in state "${snapshot?.state}" after ${timeoutMs}ms`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function mailboxRows(storage: DurableObjectStorage, runId: string): number {
  return storage.sql
    .exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cf_agents_task_mailbox WHERE run_id = ?",
      runId
    )
    .one().n;
}

describe("the mailbox", () => {
  it("buffers sends before the handler reaches receive and delivers them in order", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run(
          "inbox",
          {},
          { start: "queued" }
        );
        // Queued, so nothing has run: every send lands in the mailbox first.
        expect((await instance.tasks.send(receipt.runId, "a")).accepted).toBe(
          true
        );
        expect((await instance.tasks.send(receipt.runId, "b")).accepted).toBe(
          true
        );
        expect(mailboxRows(state.storage, receipt.runId)).toBe(2);

        backdateTaskWake(state.storage, receipt.runId);
        await instance.lifecycle.rearmAlarm();
        // Two items drain in one invocation, then the run parks on an
        // event-driven wait with no wake time.
        const parked = await waitForState(instance.tasks, receipt.runId, [
          "waiting"
        ]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.reason).toBe("mailbox");
        expect(parked.wakeAt).toBeUndefined();
        expect(mailboxRows(state.storage, receipt.runId)).toBe(0);
        const view = await instance.tasks.view(receipt.runId);
        expect(view?.checkpoint).toEqual({
          phase: "listen",
          seen: ["a", "b"],
          within: undefined
        });

        // A send to a parked reader wakes it.
        await instance.tasks.send(receipt.runId, "c");
        await instance.tasks.send(receipt.runId, "stop");
        const done = await waitForState(instance.tasks, receipt.runId, [
          "completed"
        ]);
        if (done.state !== "completed") throw new Error("unreachable");
        expect(done.result).toBe("a,b,c");
        expect((await instance.tasks.send(receipt.runId, "late")).reason).toBe(
          "terminal"
        );
      }
    );
  });

  it("applies requestId dedupe, drop, latest and withdraw", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run(
          "inbox",
          {},
          { start: "queued" }
        );
        const runId = receipt.runId;
        expect(
          await instance.tasks.send(runId, "x", { requestId: "req-1" })
        ).toEqual({ accepted: true, key: "req-1" });
        expect(
          await instance.tasks.send(runId, "x-again", { requestId: "req-1" })
        ).toEqual({ accepted: false, key: "req-1", reason: "duplicate" });
        expect(
          (await instance.tasks.send(runId, "y", { policy: "drop" })).reason
        ).toBe("dropped");
        expect(mailboxRows(state.storage, runId)).toBe(1);
        // `latest` replaces every unconsumed item of the same shape.
        await instance.tasks.send(runId, "z", { policy: "latest" });
        expect(mailboxRows(state.storage, runId)).toBe(1);
        expect(await instance.tasks.withdraw(runId, "req-1")).toBe(false);
        const view = await instance.tasks.view(runId);
        const [only] = view?.mailbox ?? [];
        expect(only?.payload).toBe("z");
        expect(await instance.tasks.withdraw(runId, only?.key ?? "")).toBe(
          true
        );
        expect(mailboxRows(state.storage, runId)).toBe(0);
        expect((await instance.tasks.send("nope", "x")).reason).toBe("unknown");
      }
    );
  });

  it("debounces the same requestId and delivers it once the window passes", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const receipt = await instance.tasks.run(
          "inbox",
          {},
          { start: "queued" }
        );
        await expect(
          instance.tasks.send(receipt.runId, "x", { policy: "debounce" })
        ).rejects.toThrow(/requestId/);
        for (const text of ["draft-1", "draft-2", "draft-3"]) {
          expect(
            (
              await instance.tasks.send(receipt.runId, text, {
                policy: "debounce",
                requestId: "typing",
                debounceMs: 60_000
              })
            ).accepted
          ).toBe(true);
        }
        // One hidden row, holding the latest payload at the first seq.
        const rows = state.storage.sql
          .exec<{ payload: string; seq: number; visible_after: number }>(
            "SELECT payload, seq, visible_after FROM cf_agents_task_mailbox WHERE run_id = ?",
            receipt.runId
          )
          .toArray();
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]?.payload ?? "null")).toBe("draft-3");
        expect(rows[0]?.seq).toBe(0);
        expect(rows[0]?.visible_after).toBeGreaterThan(Date.now());
        // Not yet visible: the handler parks past it.
        backdateTaskWake(state.storage, receipt.runId);
        await instance.lifecycle.rearmAlarm();
        const parked = await waitForState(instance.tasks, receipt.runId, [
          "waiting"
        ]);
        if (parked.state !== "waiting") throw new Error("unreachable");
        expect(parked.reason).toBe("mailbox");
        // The window passes: the debounced item is delivered.
        state.storage.sql.exec(
          "UPDATE cf_agents_task_mailbox SET visible_after = ? WHERE run_id = ?",
          Date.now() - 1,
          receipt.runId
        );
        await instance.tasks.send(receipt.runId, "stop");
        const done = await waitForState(instance.tasks, receipt.runId, [
          "completed"
        ]);
        if (done.state !== "completed") throw new Error("unreachable");
        expect(done.result).toBe("draft-3");
      }
    );
  });

  it("refuses a repeated requestId before latest can clear the original", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run(
        "inbox",
        {},
        { start: "queued" }
      );
      expect(
        (await instance.tasks.send(receipt.runId, "one", { requestId: "r1" }))
          .accepted
      ).toBe(true);
      expect(
        await instance.tasks.send(receipt.runId, "two", {
          requestId: "r1",
          policy: "latest"
        })
      ).toEqual({ accepted: false, key: "r1", reason: "duplicate" });
      const view = await instance.tasks.view(receipt.runId);
      expect(view?.mailbox.map((item) => item.payload)).toEqual(["one"]);
    });
  });

  it("refuses past the mailbox limit", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run(
        "inbox",
        {},
        { start: "queued" }
      );
      for (let i = 0; i < 1000; i++) {
        await instance.tasks.send(receipt.runId, `m${i}`);
      }
      await expect(
        instance.tasks.send(receipt.runId, "one more")
      ).rejects.toBeInstanceOf(TaskMailboxFullError);
    });
  }, 30_000);

  it("returns timedOut when a receive's within passes", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("inbox", { within: 60_000 });
      runId = receipt.runId;
      const parked = await waitForState(instance.tasks, runId, ["waiting"]);
      if (parked.state !== "waiting") throw new Error("unreachable");
      expect(parked.reason).toBe("mailbox");
      expect(parked.wakeAt).toBeGreaterThan(Date.now());
    });
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        backdateTaskWake(state.storage, runId);
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const done = await waitForState(instance.tasks, runId, ["completed"]);
      if (done.state !== "completed") throw new Error("unreachable");
      expect(done.result).toBe("timed-out");
    });
  });

  it("notifies watchers with the view on every change", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run(
        "inbox",
        {},
        { start: "queued" }
      );
      const changes: TaskChange[] = [];
      const stop = instance.tasks.watch(receipt.runId, (change) =>
        changes.push(change)
      );
      await instance.tasks.send(receipt.runId, "hello");
      expect(changes.map((change) => change.type)).toEqual(["mailbox"]);
      expect(changes[0]?.view.mailbox.map((item) => item.payload)).toEqual([
        "hello"
      ]);
      stop();
      await instance.tasks.send(receipt.runId, "unseen");
      expect(changes).toHaveLength(1);
    });
  });
});

describe("event waits on a durable function", () => {
  it("parks on waitForEvent, wakes on sendEvent, and memoizes the event", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("listener", {});
      const parked = await waitForState(instance.tasks, receipt.runId, [
        "waiting"
      ]);
      if (parked.state !== "waiting") throw new Error("unreachable");
      expect(parked.reason).toBe("event");
      // A message of another type does not satisfy the wait: the run is
      // re-dispatched and parks again on the same event.
      await instance.tasks.send(receipt.runId, "noise");
      const still = await waitForState(instance.tasks, receipt.runId, [
        "waiting"
      ]);
      if (still.state !== "waiting") throw new Error("unreachable");
      expect(still.reason).toBe("event");
      expect((await instance.tasks.view(receipt.runId))?.mailbox).toHaveLength(
        1
      );
      expect(
        (
          await instance.tasks.sendEvent(receipt.runId, {
            type: "approval",
            payload: { ok: true }
          })
        ).accepted
      ).toBe(true);
      const done = await waitForState(instance.tasks, receipt.runId, [
        "completed"
      ]);
      if (done.state !== "completed") throw new Error("unreachable");
      expect(done.result).toBe("approval:true:true");
    });
  });

  it("fails the run when the wait's timeout passes", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("listener", { timeout: 60_000 });
      runId = receipt.runId;
      await waitForState(instance.tasks, runId, ["waiting"]);
    });
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        backdateTaskWake(state.storage, runId, "go");
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const failed = await waitForState(instance.tasks, runId, ["failed"]);
      if (failed.state !== "failed") throw new Error("unreachable");
      expect(failed.error.name).toBe("StateMachineEventTimeoutError");
    });
  });
});

describe("asks", () => {
  it("parks on answers and completes when every ask is answered", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("approver", {});
      const parked = await waitForState(instance.tasks, receipt.runId, [
        "waiting"
      ]);
      if (parked.state !== "waiting") throw new Error("unreachable");
      expect(parked.reason).toBe("ask");
      const open = await instance.tasks.asks({
        runId: receipt.runId,
        state: "open"
      });
      expect(open.map((ask) => ask.question)).toEqual([
        { what: "first" },
        { what: "second" }
      ]);
      const [first, second] = open;
      if (!first || !second) throw new Error("unreachable");
      expect(first.askId.startsWith(`${receipt.runId}#`)).toBe(true);

      expect(await instance.tasks.answer(first.askId, Approval, "yes")).toEqual(
        { accepted: true }
      );
      expect(
        await instance.tasks.answer(first.askId, Approval, "again")
      ).toEqual({ accepted: false, reason: "duplicate" });
      // One of two answered: `all` re-reads and parks again.
      const still = await waitForState(instance.tasks, receipt.runId, [
        "waiting"
      ]);
      if (still.state !== "waiting") throw new Error("unreachable");
      expect(still.reason).toBe("ask");
      expect(
        await instance.tasks.asks({ runId: receipt.runId, state: "open" })
      ).toHaveLength(1);
      expect(await instance.tasks.withdrawAsk(second.askId)).toBe(true);
      const done = await waitForState(instance.tasks, receipt.runId, [
        "completed"
      ]);
      if (done.state !== "completed") throw new Error("unreachable");
      expect(done.result).toBe("yes+lapsed");
      expect(
        (await instance.tasks.asks({ runId: receipt.runId })).map(
          (ask) => ask.state
        )
      ).toEqual(["answered", "withdrawn"]);
      expect(
        (await instance.tasks.answer(second.askId, Approval, "late")).reason
      ).toBe("terminal");
    });
  });

  it("expires a batch at its expiry and hands the handler lapsed answers", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    let runId = "";
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("approver", {
        expiresIn: 60_000
      });
      runId = receipt.runId;
      const parked = await waitForState(instance.tasks, runId, ["waiting"]);
      if (parked.state !== "waiting") throw new Error("unreachable");
      expect(parked.wakeAt).toBeGreaterThan(Date.now());
    });
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        state.storage.sql.exec(
          "UPDATE cf_agents_task_asks SET expires_at = ? WHERE run_id = ?",
          Date.now() - 1,
          runId
        );
        backdateTaskWake(state.storage, runId);
        await instance.lifecycle.rearmAlarm();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const done = await waitForState(instance.tasks, runId, ["completed"]);
      if (done.state !== "completed") throw new Error("unreachable");
      expect(done.result).toBe("lapsed+lapsed");
      expect(
        (await instance.tasks.asks({ runId })).map((ask) => ask.state)
      ).toEqual(["expired", "expired"]);
    });
  });

  it("returns on the first answer under mode any", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      const receipt = await instance.tasks.run("approver", { mode: "any" });
      await waitForState(instance.tasks, receipt.runId, ["waiting"]);
      const [, second] = await instance.tasks.asks({ runId: receipt.runId });
      if (!second) throw new Error("unreachable");
      const handle = instance.tasks.at("approver", receipt.runId);
      expect(await handle.answer(second.askId, Approval, "ok")).toEqual({
        accepted: true
      });
      const done = await waitForState(instance.tasks, receipt.runId, [
        "completed"
      ]);
      if (done.state !== "completed") throw new Error("unreachable");
      expect(done.result).toBe("lapsed+ok");
    });
  });
});
