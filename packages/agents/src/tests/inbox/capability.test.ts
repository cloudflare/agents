import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Inbox } from "../../inbox";
import { eventually, type InboxHarnessObject } from "../capabilities/inbox";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";

/**
 * The Inbox installed on a minimal real Durable Object with a real
 * Lifecycle, real storage and real alarms (lane wakes are due at once, so
 * the test pool fires them).
 */

function harness() {
  return env.InboxHarnessObject.getByName(crypto.randomUUID());
}

describe("Inbox", () => {
  it("runs a request from the alarm, stores its result, and wakes waiters", async () => {
    const name = crypto.randomUUID();
    const stub = env.InboxHarnessObject.getByName(name);
    const capture = captureDiagnosticsEvents("agents:lifecycle", name);
    try {
      await runInDurableObject(stub, async (instance: InboxHarnessObject) => {
        const { request, accepted } = await instance.inbox.submit("echo", {
          value: "a"
        });
        expect(accepted).toBe(true);
        expect(request).toMatchObject({
          kind: "echo",
          lane: "echo",
          status: "pending",
          attempt: 0,
          policy: "queue",
          detached: false
        });
        // The submit returned before any handler ran.
        expect(instance.calls).toEqual([]);

        const done = await instance.inbox.wait(request.id);
        expect(done).toMatchObject({
          status: "completed",
          attempt: 1,
          result: { echoed: "a", attempt: 1 }
        });
        expect(done?.settledAt).toBeGreaterThanOrEqual(done!.createdAt);
        expect(instance.calls).toEqual([
          {
            id: request.id,
            kind: "echo",
            payload: { value: "a" },
            attempt: 1,
            merged: [],
            progress: undefined,
            hadHostContext: true
          }
        ]);
        expect(instance.statuses).toEqual([
          { id: request.id, status: "pending" },
          { id: request.id, status: "running" },
          { id: request.id, status: "completed" }
        ]);
        expect(instance.inbox.payload(request.id)).toEqual({ value: "a" });
        // Settled waits answer at once.
        expect(await instance.inbox.wait(request.id)).toEqual(done);
        expect(await instance.inbox.wait("nope")).toBeUndefined();
      });
      expect(
        capture.events
          .filter((event) => event.type.startsWith("inbox:"))
          .map((event) => [
            event.type,
            (event.payload as { status?: string }).status
          ])
      ).toEqual([
        ["inbox:submit", undefined],
        ["inbox:status", "pending"],
        ["inbox:status", "running"],
        ["inbox:status", "completed"]
      ]);
    } finally {
      capture.stop();
    }
  });

  it("treats a repeated submit with the same payload as the same request", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const first = await instance.inbox.submit(
          "echo",
          { value: "a" },
          { id: "r1", idempotencyKey: "k1", metadata: { from: "test" } }
        );
        expect(first.request.metadata).toEqual({ from: "test" });
        const byId = await instance.inbox.submit(
          "echo",
          { value: "a" },
          {
            id: "r1"
          }
        );
        expect(byId.accepted).toBe(false);
        expect(byId.request.id).toBe("r1");
        const byKey = await instance.inbox.submit(
          "echo",
          { value: "a" },
          {
            idempotencyKey: "k1"
          }
        );
        expect(byKey).toMatchObject({ accepted: false, request: { id: "r1" } });

        await expect(
          instance.inbox.submit(
            "echo",
            { value: "b" },
            { idempotencyKey: "k1" }
          )
        ).rejects.toThrow(/different payload/);
        await expect(
          instance.inbox.submit("fail", "x", { id: "r1" })
        ).rejects.toThrow(/different kind/);
        await instance.inbox.submit("echo", { value: "c" }, { id: "r2" });
        await expect(
          instance.inbox.submit(
            "echo",
            { value: "c" },
            {
              id: "r2",
              idempotencyKey: "k1"
            }
          )
        ).rejects.toThrow(/name different requests/);
        await expect(
          // @ts-expect-error not a registered kind
          instance.inbox.submit("missing", null)
        ).rejects.toThrow(/Unknown inbox kind/);
        instance.release();
        await instance.inbox.wait("r2");
        expect(instance.calls.map((call) => call.id)).toEqual(["r1", "r2"]);
      }
    );
  });

  it("runs one request at a time per lane, in order, and lanes side by side", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const a = await instance.inbox.submit("echo", { value: "a" });
        const b = await instance.inbox.submit("echo", { value: "b" });
        const other = await instance.inbox.submit(
          "echo",
          { value: "x" },
          { lane: "other" }
        );
        await eventually(() => instance.running.size === 2);
        expect([...instance.running].sort()).toEqual(
          [a.request.id, other.request.id].sort()
        );
        expect(instance.inbox.get(b.request.id)?.status).toBe("pending");
        expect(
          instance.inbox
            .list({ lane: "echo", order: "oldest" })
            .map((r) => [r.id, r.status])
        ).toEqual([
          [a.request.id, "running"],
          [b.request.id, "pending"]
        ]);
        instance.release();
        await instance.inbox.wait(b.request.id);
        expect(
          instance.calls
            .filter((call) => call.kind === "echo")
            .map((call) => call.payload)
        ).toEqual([{ value: "a" }, { value: "x" }, { value: "b" }]);
      }
    );
  });

  it("ends a request the way its handler says", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        const failed = await instance.inbox.submit("fail", "boom");
        expect(await instance.inbox.wait(failed.request.id)).toMatchObject({
          status: "error",
          error: "failed: boom"
        });
        for (const as of ["aborted", "skipped", "error"] as const) {
          const { request } = await instance.inbox.submit("settle", { as });
          expect(await instance.inbox.wait(request.id)).toMatchObject({
            status: as,
            error: "by handler"
          });
        }
      }
    );
  });

  it("leaves a detached request running until settle() ends it", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        const detached = await instance.inbox.submit("settle", {
          as: "detached"
        });
        const next = await instance.inbox.submit("settle", { as: "aborted" });
        // The lane moved on past the detached request.
        await instance.inbox.wait(next.request.id);
        expect(instance.inbox.get(detached.request.id)).toMatchObject({
          status: "running",
          detached: true
        });
        const waiting = instance.inbox.wait(detached.request.id);
        const { Inbox } = await import("../../inbox");
        expect(
          await instance.inbox.settle(detached.request.id, Inbox.completed(42))
        ).toBe(true);
        expect(await waiting).toMatchObject({
          status: "completed",
          result: 42
        });
        // Terminal is final.
        expect(
          await instance.inbox.settle(detached.request.id, Inbox.failed("late"))
        ).toBe(false);
        await expect(
          instance.inbox.settle(detached.request.id, Inbox.detached())
        ).rejects.toThrow(/terminal outcome/);
      }
    );
  });

  it("cancels a pending request before it runs and a running one through its signal", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        const running = await instance.inbox.submit("abortable", null);
        const pending = await instance.inbox.submit(
          "echo",
          { value: "never" },
          {
            lane: "abortable"
          }
        );
        await eventually(() => instance.calls.length === 1);

        expect(
          await instance.inbox.cancel(pending.request.id, "not needed")
        ).toMatchObject({
          previous: "pending",
          request: { status: "aborted", error: "not needed" }
        });
        expect(
          await instance.inbox.cancel(running.request.id, new Error("stop"))
        ).toMatchObject({
          previous: "running",
          request: { status: "aborted", error: "stop" }
        });
        // The handler threw once its signal aborted. That changed nothing.
        await eventually(
          () => !instance.inbox.list({ status: "running" }).length
        );
        expect(instance.inbox.get(running.request.id)).toMatchObject({
          status: "aborted",
          error: "stop"
        });
        expect(instance.calls.map((call) => call.kind)).toEqual(["abortable"]);
        expect(await instance.inbox.cancel(running.request.id)).toMatchObject({
          previous: "aborted"
        });
        expect(await instance.inbox.cancel("nope")).toBeUndefined();
      }
    );
  });

  it("clear() ends every open request of a lane skipped", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const a = await instance.inbox.submit("echo", { value: "a" });
        const b = await instance.inbox.submit("echo", { value: "b" });
        const other = await instance.inbox.submit(
          "echo",
          { value: "x" },
          {
            lane: "other"
          }
        );
        await eventually(() => instance.running.has(a.request.id));
        const ended = await instance.inbox.clear("echo", "reset");
        expect(ended.map((r) => [r.id, r.status, r.error])).toEqual([
          [a.request.id, "skipped", "reset"],
          [b.request.id, "skipped", "reset"]
        ]);
        instance.release();
        // A request after the clear runs once the old handler returned.
        const after = await instance.inbox.submit("echo", { value: "c" });
        expect(await instance.inbox.wait(after.request.id)).toMatchObject({
          status: "completed"
        });
        expect(instance.inbox.get(a.request.id)?.status).toBe("skipped");
        expect(await instance.inbox.wait(other.request.id)).toMatchObject({
          status: "completed"
        });
        expect(
          instance.calls.map(
            (call) => (call.payload as { value: string }).value
          )
        ).toEqual(["a", "x", "c"]);
      }
    );
  });

  it("drop skips a request that arrives while its lane is busy", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        const idle = await instance.inbox.submit(
          "echo",
          { value: "a" },
          {
            policy: "drop"
          }
        );
        expect(idle.request.status).toBe("pending");
        const busy = await instance.inbox.submit(
          "echo",
          { value: "b" },
          {
            policy: "drop"
          }
        );
        expect(busy.request).toMatchObject({
          status: "skipped",
          error: "dropped: the lane was busy"
        });
        await instance.inbox.wait(idle.request.id);
        expect(instance.calls.map((call) => call.payload)).toEqual([
          { value: "a" }
        ]);
      }
    );
  });

  it("latest skips overlapping requests a later one superseded, and names them", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const first = await instance.inbox.submit(
          "echo",
          { value: "a" },
          {
            policy: "latest"
          }
        );
        const queued = await instance.inbox.submit("echo", { value: "q" });
        const b = await instance.inbox.submit(
          "echo",
          { value: "b" },
          {
            policy: "latest"
          }
        );
        const c = await instance.inbox.submit(
          "echo",
          { value: "c" },
          {
            policy: "merge"
          }
        );
        instance.release();
        await instance.inbox.wait(c.request.id);
        expect(instance.inbox.get(first.request.id)?.status).toBe("completed");
        expect(instance.inbox.get(queued.request.id)?.status).toBe("completed");
        expect(instance.inbox.get(b.request.id)).toMatchObject({
          status: "skipped",
          error: "superseded"
        });
        expect(
          instance.calls.map((call) => [call.payload, call.merged])
        ).toEqual([
          [{ value: "a" }, []],
          [{ value: "q" }, []],
          [{ value: "c" }, [b.request.id]]
        ]);
      }
    );
  });

  it("debounce waits out its quiet period and a later request supersedes it", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const first = await instance.inbox.submit("echo", { value: "a" });
        const b = await instance.inbox.submit(
          "echo",
          { value: "b" },
          {
            policy: { debounceMs: 200 }
          }
        );
        instance.release();
        await instance.inbox.wait(first.request.id);
        // b waits out its quiet period at the front of the lane.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const c = await instance.inbox.submit(
          "echo",
          { value: "c" },
          {
            policy: { debounceMs: 100 }
          }
        );
        const started = Date.now();
        const done = await instance.inbox.wait(c.request.id);
        expect(done?.status).toBe("completed");
        expect(Date.now() - started).toBeGreaterThanOrEqual(80);
        expect(instance.inbox.get(b.request.id)).toMatchObject({
          status: "skipped",
          error: "superseded"
        });
        expect(instance.calls.map((call) => call.payload)).toEqual([
          { value: "a" },
          { value: "c" }
        ]);
      }
    );
  });

  it("runs an interrupted request again after a reset, then the requests behind it", async () => {
    const stub = harness();
    const ids = await runInDurableObject(
      stub,
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const a = await instance.inbox.submit("progress", { note: "a" });
        const b = await instance.inbox.submit(
          "echo",
          { value: "b" },
          {
            lane: "progress"
          }
        );
        await eventually(() => instance.running.has(a.request.id));
        return [a.request.id, b.request.id];
      }
    );
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: InboxHarnessObject) => {
      const done = await instance.inbox.wait(ids[1]);
      expect(done?.status).toBe("completed");
      expect(instance.inbox.get(ids[0])).toMatchObject({
        status: "completed",
        attempt: 2,
        // The second attempt read what the first one recorded.
        result: { note: "a", at: 1 },
        progress: { note: "a", at: 2 }
      });
      expect(instance.calls.map((call) => [call.id, call.attempt])).toEqual([
        [ids[0], 2],
        [ids[1], 1]
      ]);
    });
  });

  it("ends a request `error` once it was interrupted maxAttempts times", async () => {
    const stub = harness();
    const id = await runInDurableObject(
      stub,
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const { request } = await instance.inbox.submit("echo", { value: "a" });
        await eventually(() => instance.running.has(request.id));
        // A second interruption already happened.
        instance.interrupt(request.id);
        return request.id;
      }
    );
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: InboxHarnessObject) => {
      expect(await instance.inbox.wait(id)).toMatchObject({
        status: "error",
        error: "Interrupted 2 times",
        attempt: 2
      });
      expect(instance.calls).toEqual([]);
    });
  });

  it("reports a terminal status again after a reset cut its onStatus short", async () => {
    const stub = harness();
    const id = await runInDurableObject(
      stub,
      async (instance: InboxHarnessObject) => {
        const { request } = await instance.inbox.submit("echo", { value: "a" });
        await instance.inbox.wait(request.id);
        instance.forgetReport(request.id);
        return request.id;
      }
    );
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: InboxHarnessObject) => {
      // The wait holds until the replayed report returned.
      expect(instance.inbox.isSettled(id)).toBe(false);
      await instance.inbox.wait(id);
      expect(instance.statuses).toEqual([{ id, status: "completed" }]);
      expect(instance.inbox.isSettled(id)).toBe(true);
      expect(instance.calls).toEqual([]);
    });
  });

  it("imports records from another store and runs the open ones", async () => {
    const stub = harness();
    await runInDurableObject(stub, async (instance: InboxHarnessObject) => {
      expect(
        await instance.inbox.import({
          id: "old-done",
          kind: "echo",
          status: "completed",
          attempt: 1,
          payload: { value: "done" },
          result: { echoed: "done" },
          createdAt: 1,
          settledAt: 2
        })
      ).toBe(true);
      expect(
        await instance.inbox.import({
          id: "old-running",
          kind: "progress",
          lane: "echo",
          status: "running",
          attempt: 1,
          payload: { note: "r" },
          progress: { note: "r", at: 1 },
          createdAt: 3,
          startedAt: 3
        })
      ).toBe(true);
      expect(
        await instance.inbox.import({
          id: "old-pending",
          kind: "echo",
          status: "pending",
          attempt: 0,
          idempotencyKey: "k",
          payload: { value: "p" },
          createdAt: 4
        })
      ).toBe(true);
      expect(
        await instance.inbox.import({
          id: "old-pending",
          kind: "echo",
          status: "pending",
          attempt: 0,
          createdAt: 4
        })
      ).toBe(false);
      await instance.inbox.wait("old-pending");
      expect(instance.calls.map((call) => [call.id, call.attempt])).toEqual([
        ["old-running", 2],
        ["old-pending", 1]
      ]);
      // A terminal import is not reported again.
      expect(instance.statuses.some((s) => s.id === "old-done")).toBe(false);
      expect(instance.inbox.get("old-done")).toMatchObject({
        status: "completed",
        result: { echoed: "done" },
        settledAt: 2
      });
    });
  });

  it("keeps a payload and a result past the row limit", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        // Over 2 MB of UTF-8, with a surrogate pair on a piece boundary.
        const text = `${"x".repeat(499_999)}😀${"é".repeat(1_200_000)}`;
        const { request } = await instance.inbox.submit("big", text);
        expect(instance.inbox.payload(request.id)).toBe(text);
        const done = await instance.inbox.wait(request.id);
        expect(done?.status).toBe("completed");
        expect(done?.result).toBe(text);
        expect(instance.calls[0].payload).toBe(text.length);
        expect(instance.inbox.delete(request.id)).toBe(true);
        expect(instance.inbox.payload(request.id)).toBeUndefined();
      }
    );
  });

  it("keeps results until deleted or purged; open requests cannot be deleted", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        const a = await instance.inbox.submit("echo", { value: "a" });
        await instance.inbox.wait(a.request.id);
        instance.hold();
        const b = await instance.inbox.submit("echo", { value: "b" });
        expect(instance.inbox.delete(b.request.id)).toBe(false);
        const cutoff = Date.now() + 1;
        expect(instance.inbox.purgeBefore(cutoff, { status: "error" })).toBe(0);
        expect(instance.inbox.purgeBefore(cutoff, { lane: "other" })).toBe(0);
        expect(instance.inbox.purgeBefore(cutoff)).toBe(1);
        expect(instance.inbox.get(a.request.id)).toBeUndefined();
        expect(instance.inbox.get(b.request.id)?.status).not.toBe(undefined);
        instance.release();
        await instance.inbox.wait(b.request.id);
      }
    );
  });

  it("wait() resolves after the terminal onStatus returns, and times out with the record", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const { request } = await instance.inbox.submit("echo", { value: "a" });
        expect(
          await instance.inbox.wait(request.id, { timeoutMs: 20 })
        ).toMatchObject({ status: expect.stringMatching(/pending|running/) });
        const controller = new AbortController();
        const aborted = instance.inbox.wait(request.id, {
          signal: controller.signal
        });
        controller.abort(new Error("gave up"));
        await expect(aborted).rejects.toThrow("gave up");

        instance.slowStatus = 100;
        const waiting = instance.inbox.wait(request.id);
        instance.release();
        await eventually(
          () => instance.inbox.get(request.id)?.status === "completed"
        );
        // Terminal, but the hook has not returned: a new wait still waits.
        const late = instance.inbox.wait(request.id);
        const order: string[] = [];
        void waiting.then(() => order.push("waiter"));
        void late.then(() => order.push("late"));
        await waiting;
        await late;
        expect(order).toEqual(["waiter", "late"]);
        expect(instance.inbox.isSettled(request.id)).toBe(true);
        expect(instance.statuses.at(-1)).toEqual({
          id: request.id,
          status: "completed"
        });
      }
    );
  });

  it("holds a wait on every request a clear ended until its own report ran", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const a = await instance.inbox.submit("echo", { value: "a" });
        const b = await instance.inbox.submit("echo", { value: "b" });
        instance.slowStatus = 60;
        const clearing = instance.inbox.clear("echo");
        // b is skipped already; its report runs after a's.
        expect(instance.inbox.get(b.request.id)?.status).toBe("skipped");
        expect(instance.inbox.isSettled(b.request.id)).toBe(false);
        await instance.inbox.wait(b.request.id);
        expect(instance.statuses.filter((s) => s.status === "skipped")).toEqual(
          [
            { id: a.request.id, status: "skipped" },
            { id: b.request.id, status: "skipped" }
          ]
        );
        await clearing;
        instance.release();
      }
    );
  });

  it("keeps a wait on a record apart from a later record under the same id", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const first = await instance.inbox.submit(
          "echo",
          { value: "a" },
          {
            id: "reused",
            lane: "one"
          }
        );
        instance.slowStatus = 80;
        const cancelling = instance.inbox.cancel(first.request.id);
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Deleted while its report runs, then submitted again.
        expect(instance.inbox.delete("reused")).toBe(true);
        await instance.inbox.submit(
          "echo",
          { value: "b" },
          {
            id: "reused",
            lane: "two"
          }
        );
        const waiting = instance.inbox.wait("reused", { timeoutMs: 200 });
        await cancelling;
        expect((await waiting)?.status).toMatch(/pending|running/);
        instance.release();
      }
    );
  });

  it("wakes the waiters of a request deleted after it ended", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject, state) => {
        instance.hold();
        const { request } = await instance.inbox.submit(
          "echo",
          { value: "a" },
          {
            lane: "held"
          }
        );
        const waiting = instance.inbox.wait(request.id);
        // Ended by a write the inbox did not make, so nothing reported it.
        state.storage.sql.exec(
          "UPDATE cf_agents_inbox SET status = 'completed', settled_at = ? WHERE id = ?",
          Date.now(),
          request.id
        );
        expect(instance.inbox.delete(request.id)).toBe(true);
        expect(await waiting).toMatchObject({ status: "completed" });
        instance.release();
      }
    );
  });

  it("keeps a named inbox's rows apart, and drops them when it does not retain", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject, state) => {
        const main = await instance.inbox.submit(
          "echo",
          { value: "m" },
          {
            id: "same"
          }
        );
        const side = await instance.side.submit(
          "echo",
          { value: "s" },
          {
            id: "same"
          }
        );
        expect(main.accepted && side.accepted).toBe(true);
        expect(instance.side.list().map((r) => r.id)).toEqual(["same"]);
        const done = await instance.side.wait("same");
        expect(done).toMatchObject({
          status: "completed",
          result: { echoed: "s", local: null }
        });
        // Answered, then deleted.
        expect(instance.side.get("same")).toBeUndefined();
        await instance.inbox.wait("same");
        expect(instance.inbox.get("same")?.status).toBe("completed");
        const tables = state.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cf_agents_inbox%' ORDER BY name"
          )
          .toArray()
          .map((row) => row.name);
        expect(tables).toEqual([
          "cf_agents_inbox",
          "cf_agents_inbox__side",
          "cf_agents_inbox__side_parts",
          "cf_agents_inbox_parts"
        ]);
        for (const name of ["Bad", "chat_parts", "a-b"]) {
          expect(() => new Inbox({ name, handlers: {} })).toThrow(/lowercase/);
        }
      }
    );
  });

  it("hands a local value to the handler in the isolate that submitted it", async () => {
    const stub = harness();
    await runInDurableObject(stub, async (instance: InboxHarnessObject) => {
      instance.hold();
      const { request } = await instance.side.submit(
        "echo",
        { value: "a" },
        {
          id: "with-local",
          local: { callback: "kept in memory" }
        }
      );
      await eventually(() => instance.running.has(request.id));
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: InboxHarnessObject) => {
      // The next attempt runs from the record alone.
      const done = await instance.side.wait("with-local");
      expect(done).toMatchObject({
        status: "completed",
        attempt: 2,
        result: { echoed: "a", local: null }
      });
    });
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        const { request } = await instance.side.submit(
          "echo",
          { value: "b" },
          {
            local: { callback: "kept in memory" }
          }
        );
        expect(await instance.side.wait(request.id)).toMatchObject({
          result: { local: { callback: "kept in memory" } }
        });
      }
    );
  });

  it("holds a lane's requests from an earlier isolate while this isolate's run", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.side.hold("echo");
        expect(instance.side.isHeld("echo")).toBe(true);
        await instance.side.import({
          id: "earlier",
          kind: "echo",
          status: "pending",
          attempt: 0,
          payload: { value: "earlier" },
          createdAt: Date.now()
        });
        const { request } = await instance.side.submit(
          "echo",
          { value: "now" },
          {
            local: true
          }
        );
        expect(await instance.side.wait(request.id)).toMatchObject({
          status: "completed"
        });
        expect(instance.side.get("earlier")?.status).toBe("pending");
        instance.side.release("echo");
        expect(await instance.side.wait("earlier")).toMatchObject({
          status: "completed"
        });
        expect(
          instance.calls
            .filter((call) => call.kind === "side")
            .map((call) => (call.payload as { value: string }).value)
        ).toEqual(["now", "earlier"]);
      }
    );
  });

  it("does not let a cancelled handler's late return touch a later record under its id", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        await instance.inbox.submit(
          "echo",
          { value: "a" },
          {
            id: "reused",
            lane: "one"
          }
        );
        await eventually(() => instance.running.has("reused"));
        await instance.inbox.cancel("reused");
        expect(instance.inbox.delete("reused")).toBe(true);
        await instance.inbox.submit(
          "echo",
          { value: "b" },
          {
            id: "reused",
            lane: "two"
          }
        );
        await eventually(
          () =>
            instance.calls.filter((call) => call.id === "reused").length === 2
        );
        // The first handler resumes first.
        instance.release();
        expect(await instance.inbox.wait("reused")).toMatchObject({
          status: "completed",
          lane: "two",
          result: { echoed: "b" }
        });
      }
    );
  });

  it("keeps a payload and a result that each fit inline but not together", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        const text = "界".repeat(400_000);
        const { request } = await instance.inbox.submit("big", text);
        expect(await instance.inbox.wait(request.id)).toMatchObject({
          status: "completed",
          result: text
        });
        await expect(
          instance.inbox.submit(
            "echo",
            { value: "x" },
            {
              metadata: { big: "x".repeat(100_001) }
            }
          )
        ).rejects.toThrow(/metadata is limited/);
      }
    );
  });

  it("starts a request only after its pending report returned", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const a = await instance.inbox.submit("echo", { value: "a" });
        await eventually(() => instance.running.has(a.request.id));
        instance.slowPending = 80;
        const submitting = instance.inbox.submit("echo", { value: "b" });
        await new Promise((resolve) => setTimeout(resolve, 10));
        instance.release();
        const b = await submitting;
        await instance.inbox.wait(b.request.id);
        const at = (status: string) =>
          instance.statuses.findIndex(
            (entry) => entry.id === b.request.id && entry.status === status
          );
        expect(at("pending:done")).toBeGreaterThan(-1);
        expect(at("running")).toBeGreaterThan(at("pending:done"));
      }
    );
  });

  it("keeps a held lane's wake while its runner waits", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject, state) => {
        instance.side.hold("parked");
        await instance.side.import({
          id: "earlier",
          kind: "echo",
          lane: "parked",
          status: "pending",
          attempt: 0,
          payload: { value: "earlier" },
          createdAt: Date.now()
        });
        await instance.side.submit(
          "echo",
          { value: "now" },
          {
            lane: "parked",
            start: "now",
            local: true
          }
        );
        await eventually(
          () =>
            state.storage.sql
              .exec(
                "SELECT COUNT(*) AS n FROM cf_agents_jobs WHERE capability = 'inbox:side'"
              )
              .one().n === 1
        );
        expect(await state.storage.getAlarm()).not.toBeNull();
        instance.side.release("parked");
        await instance.side.wait("earlier");
      }
    );
  });

  it("gives the survivor its merged ids when the inbox keeps no records", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        await instance.side.submit("echo", { value: "a" });
        const b = await instance.side.submit(
          "echo",
          { value: "b" },
          {
            policy: "latest"
          }
        );
        const c = await instance.side.submit(
          "echo",
          { value: "c" },
          {
            policy: "merge"
          }
        );
        instance.release();
        const done = await instance.side.wait(c.request.id);
        expect(done?.result).toMatchObject({
          echoed: "c",
          merged: [b.request.id]
        });
        expect(instance.side.get(b.request.id)).toBeUndefined();
      }
    );
  });

  it("starts the lane in the calling invocation with start: now", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject, state) => {
        instance.hold();
        const { request } = await instance.inbox.submit(
          "echo",
          { value: "a" },
          { start: "now" }
        );
        await eventually(() => instance.running.has(request.id));
        // No wake due now was armed: the only alarm is the running lane's
        // heartbeat, 30 seconds out.
        expect((await state.storage.getAlarm()) as number).toBeGreaterThan(
          Date.now() + 20_000
        );
        instance.release();
        expect(await instance.inbox.wait(request.id)).toMatchObject({
          status: "completed"
        });
      }
    );
  });
});
