import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  waitForQueueDrain,
  type QueueHarnessObject
} from "../capabilities/queue";
import type { Queue } from "../../queue";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";

/**
 * Capability-level Queue tests: the capability installed on a minimal real
 * Durable Object (`QueueHarnessObject`) whose only capability is the Queue.
 * Tests drive real Lifecycle startup, real storage, real platform alarms
 * (items are due immediately, so the test pool auto-fires them), and the
 * real diagnostics event sink — no fakes. Agent's queue methods are covered
 * by ../queue.test.ts.
 */

/** Queue events share the schedule diagnostics channel (see observability/diagnostics.ts). */
function captureQueueEvents(name: string) {
  return captureDiagnosticsEvents("agents:schedule", name);
}

describe("Queue capability", () => {
  it("pushes, reads, lists, and cancels items against the real alarm", async () => {
    const name = crypto.randomUUID();
    const stub = env.QueueHarnessObject.getByName(name);
    const capture = captureQueueEvents(name);

    try {
      await runInDurableObject(
        stub,
        async (instance: QueueHarnessObject, state) => {
          instance.hold();
          const before = Date.now();
          const item = await instance.queue.push("record", { value: "a" });
          expect(item.callback).toBe("record");
          expect(item.payload).toEqual({ value: "a" });
          expect(item.retry).toEqual({
            maxAttempts: 2,
            baseDelayMs: 1,
            maxDelayMs: 2
          });
          // Lifecycle armed the physical alarm for the item, due now.
          const alarm = await state.storage.getAlarm();
          expect(alarm as number).toBeGreaterThanOrEqual(before);
          expect(alarm as number).toBeLessThanOrEqual(Date.now() + 1_000);

          const second = await instance.queue.push("flaky", "later", {
            retry: { maxAttempts: 4 }
          });
          expect(second.retry).toEqual({
            maxAttempts: 4,
            baseDelayMs: 1,
            maxDelayMs: 2
          });

          expect(await instance.queue.get(item.id)).toEqual(item);
          expect(await instance.queue.list()).toEqual([item, second]);
          expect(await instance.queue.list({ callback: "flaky" })).toEqual([
            second
          ]);

          expect(await instance.queue.cancel(second.id)).toBe(true);
          expect(await instance.queue.cancel(second.id)).toBe(false);
          expect(await instance.queue.cancelAll("record")).toBe(1);
          expect(await instance.queue.list()).toEqual([]);
          instance.release();
        }
      );
      expect(capture.events.map((event) => event.type)).toEqual([
        "queue:create",
        "queue:create"
      ]);
    } finally {
      capture.stop();
    }
  });

  it("runs items in push order from the alarm, in host context", async () => {
    const stub = env.QueueHarnessObject.getByName(crypto.randomUUID());

    const ids = await runInDurableObject(
      stub,
      async (instance: QueueHarnessObject) => {
        instance.hold();
        const pushed = [];
        for (const value of ["a", "b", "c"]) {
          pushed.push((await instance.queue.push("record", { value })).id);
        }
        instance.release();
        return pushed;
      }
    );

    await runInDurableObject(stub, async (instance: QueueHarnessObject) => {
      await waitForQueueDrain(instance);
      expect(instance.invocations).toEqual([
        {
          callback: "record",
          payload: { value: "a" },
          itemId: ids[0],
          hadHostContext: true
        },
        {
          callback: "record",
          payload: { value: "b" },
          itemId: ids[1],
          hadHostContext: true
        },
        {
          callback: "record",
          payload: { value: "c" },
          itemId: ids[2],
          hadHostContext: true
        }
      ]);
    });
  });

  it("retries a failing callback before succeeding", async () => {
    const name = crypto.randomUUID();
    const stub = env.QueueHarnessObject.getByName(name);
    const capture = captureQueueEvents(name);

    try {
      const itemId = await runInDurableObject(
        stub,
        async (instance: QueueHarnessObject) => {
          instance.failuresBeforeSuccess = 1;
          return (await instance.queue.push("flaky", "payload")).id;
        }
      );

      await runInDurableObject(stub, async (instance: QueueHarnessObject) => {
        await waitForQueueDrain(instance);
        expect(instance.invocations).toEqual([
          {
            callback: "flaky",
            payload: "payload",
            itemId,
            hadHostContext: true
          }
        ]);
        expect(instance.callbackErrors).toEqual([]);
      });
      expect(
        capture.events.filter((event) => event.type === "queue:retry")
      ).toHaveLength(1);
    } finally {
      capture.stop();
    }
  });

  it("reports terminal callback errors and drops the item", async () => {
    const name = crypto.randomUUID();
    const stub = env.QueueHarnessObject.getByName(name);
    const capture = captureQueueEvents(name);

    try {
      await runInDurableObject(stub, async (instance: QueueHarnessObject) => {
        // Harness default is maxAttempts: 2; a callback that needs a third
        // attempt must exhaust.
        instance.failuresBeforeSuccess = 2;
        await instance.queue.push("flaky", "payload");
        await instance.queue.push("broken");
      });

      await runInDurableObject(stub, async (instance: QueueHarnessObject) => {
        await waitForQueueDrain(instance);
        expect(instance.invocations).toEqual([]);
        expect(instance.callbackErrors).toEqual([
          "flaky failure",
          "broken callback"
        ]);
      });
      const errors = capture.events.filter(
        (event) => event.type === "queue:error"
      );
      expect(errors).toHaveLength(2);
      expect(errors[0].payload).toMatchObject({
        callback: "flaky",
        attempts: 2
      });
    } finally {
      capture.stop();
    }
  });

  it("replaces an item pushed again with the same id, keeping its position", async () => {
    const stub = env.QueueHarnessObject.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance: QueueHarnessObject) => {
      instance.hold();
      await instance.queue.push("record", { value: "first" }, { id: "stable" });
      await instance.queue.push("record", { value: "later" });
      await instance.queue.push(
        "record",
        { value: "second" },
        { id: "stable" }
      );
      expect(await instance.queue.list()).toHaveLength(2);
      expect((await instance.queue.get("stable"))?.payload).toEqual({
        value: "second"
      });
      instance.release();
    });

    await runInDurableObject(stub, async (instance: QueueHarnessObject) => {
      await waitForQueueDrain(instance);
      // The replacement kept the original slot, ahead of the later push.
      expect(instance.invocations.map((entry) => entry.payload)).toEqual([
        { value: "second" },
        { value: "later" }
      ]);
    });
  });

  it("rejects unknown callbacks and invalid inputs", async () => {
    const stub = env.QueueHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: QueueHarnessObject) => {
      // Unknown names are a compile error on the typed map; erase the
      // handler typing to exercise the runtime rejection.
      const untyped = instance.queue as unknown as Queue;
      await expect(untyped.push("nope")).rejects.toThrow(
        'Unknown queue callback "nope"'
      );
      await expect(
        instance.queue.push(
          "record",
          { value: "x" },
          { retry: { maxAttempts: 0 } }
        )
      ).rejects.toThrow();
      await expect(
        instance.queue.push("record", { value: "x" }, { id: " " })
      ).rejects.toThrow("Queue item ids must be non-empty");
      expect(await instance.queue.list()).toEqual([]);
    });
  });

  it("migrates legacy cf_agents_queues rows into the job queue on start", async () => {
    const stub = env.QueueHarnessObject.getByName(crypto.randomUUID());

    await runInDurableObject(
      stub,
      async (instance: QueueHarnessObject, state) => {
        instance.hold();
        state.storage.sql.exec(`
          CREATE TABLE cf_agents_queues (
            id TEXT PRIMARY KEY NOT NULL,
            payload TEXT,
            callback TEXT,
            created_at INTEGER DEFAULT (unixepoch()),
            retry_options TEXT
          )`);
        state.storage.sql.exec(
          "INSERT INTO cf_agents_queues (id, payload, callback, retry_options) VALUES (?, ?, ?, ?)",
          "legacy-1",
          JSON.stringify({ value: "one" }),
          "record",
          JSON.stringify({ maxAttempts: 5 })
        );
        state.storage.sql.exec(
          "INSERT INTO cf_agents_queues (id, payload, callback) VALUES (?, ?, ?)",
          "legacy-2",
          JSON.stringify({ value: "two" }),
          "record"
        );

        await instance.lifecycle.start();

        const items = await instance.queue.list();
        expect(items.map((item) => item.id)).toEqual(["legacy-1", "legacy-2"]);
        expect(items[0].retry).toEqual({
          maxAttempts: 5,
          baseDelayMs: 1,
          maxDelayMs: 2
        });
        expect(
          state.storage.sql
            .exec(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='cf_agents_queues'"
            )
            .toArray()
        ).toEqual([]);
        instance.release();
      }
    );

    await runInDurableObject(stub, async (instance: QueueHarnessObject) => {
      await waitForQueueDrain(instance);
      expect(instance.invocations.map((entry) => entry.payload)).toEqual([
        { value: "one" },
        { value: "two" }
      ]);
    });
  });
});
