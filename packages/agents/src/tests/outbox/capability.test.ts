import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { waitFor, type OutboxHarnessObject } from "../capabilities/outbox";
import { MAX_OUTBOX_PAYLOAD_BYTES } from "../../outbox";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";

/**
 * Capability-level Outbox tests: the Outbox installed on a minimal real
 * Durable Object whose only capability it is. Deliveries run from the real
 * platform alarm over real storage.
 */

function stubFor(name = crypto.randomUUID()) {
  return { name, stub: env.OutboxHarnessObject.getByName(name) };
}

async function drained(instance: OutboxHarnessObject): Promise<boolean> {
  return (await instance.outbox.list({ status: "pending" })).length === 0;
}

describe("Outbox capability", () => {
  it("delivers from the alarm in host context and deletes the row", async () => {
    const { name, stub } = stubFor();
    const capture = captureDiagnosticsEvents("agents:outbox", name);
    try {
      await runInDurableObject(stub, async (instance: OutboxHarnessObject) => {
        const delivery = await instance.outbox.send(
          "record",
          { value: "a" },
          { key: "k" }
        );
        expect(delivery).toMatchObject({
          sink: "record",
          key: "k",
          status: "pending",
          attempts: 0,
          payload: { value: "a" }
        });
        await waitFor(() => drained(instance));
        expect(instance.attempts).toEqual([
          {
            sink: "record",
            key: "k",
            payload: { value: "a" },
            attempt: 1,
            idempotencyKey: delivery.idempotencyKey,
            checkpoint: undefined,
            hadHostContext: true
          }
        ]);
        expect(await instance.outbox.get("record", "k")).toBeUndefined();
      });
      expect(capture.events.map((event) => event.type)).toEqual([
        "outbox:send",
        "outbox:deliver"
      ]);
    } finally {
      capture.stop();
    }
  });

  it("retries with backoff until the sink acknowledges, under one idempotency key", async () => {
    const { name, stub } = stubFor();
    const capture = captureDiagnosticsEvents("agents:outbox", name);
    try {
      await runInDurableObject(stub, async (instance: OutboxHarnessObject) => {
        instance.failures = 2;
        const delivery = await instance.outbox.send("record", { value: "a" });
        await waitFor(() => drained(instance));
        expect(instance.attempts.map((attempt) => attempt.attempt)).toEqual([
          1, 2, 3
        ]);
        expect(
          new Set(instance.attempts.map((attempt) => attempt.idempotencyKey))
        ).toEqual(new Set([delivery.idempotencyKey]));
        expect(instance.gaveUp).toEqual([]);
      });
      const retries = capture.events.filter(
        (event) => event.type === "outbox:retry"
      );
      expect(retries).toHaveLength(2);
      expect(retries[0].payload).toMatchObject({
        sink: "record",
        attempt: 1,
        error: "sink down"
      });
    } finally {
      capture.stop();
    }
  });

  it("gives up after the sink's attempts, keeps the failure, and retries it on request", async () => {
    const { name, stub } = stubFor();
    const capture = captureDiagnosticsEvents("agents:outbox", name);
    try {
      await runInDurableObject(stub, async (instance: OutboxHarnessObject) => {
        await instance.outbox.send("fragile", "x", { key: "f" });
        await waitFor(() => instance.gaveUp.length === 1);
        expect(instance.gaveUp).toEqual([
          { key: "f", payload: "x", error: "always down" }
        ]);
        const failed = await instance.outbox.get("fragile", "f");
        expect(failed).toMatchObject({
          status: "failed",
          attempts: 2,
          nextAt: null,
          lastError: "always down"
        });
        expect(await instance.outbox.list({ status: "failed" })).toHaveLength(
          1
        );

        expect(await instance.outbox.retry("fragile", "f")).toBe(true);
        await waitFor(() => instance.gaveUp.length === 2);
        expect(instance.attempts).toHaveLength(4);
        expect(
          new Set(instance.attempts.map((attempt) => attempt.idempotencyKey))
            .size
        ).toBe(1);

        expect(await instance.outbox.purge()).toBe(1);
        expect(await instance.outbox.list()).toEqual([]);
      });
      expect(
        capture.events.filter((event) => event.type === "outbox:give_up")
      ).toHaveLength(2);
    } finally {
      capture.stop();
    }
  });

  it("holds a value until a send of the same key releases it with the new value", async () => {
    const { stub } = stubFor();
    await runInDurableObject(stub, async (instance: OutboxHarnessObject) => {
      const held = await instance.outbox.send(
        "record",
        { value: "draft" },
        { key: "k", hold: true }
      );
      expect(held).toMatchObject({ status: "held", nextAt: null });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(instance.attempts).toEqual([]);

      const released = await instance.outbox.send(
        "record",
        { value: "final" },
        { key: "k" }
      );
      expect(released.id).toBe(held.id);
      expect(released.idempotencyKey).not.toBe(held.idempotencyKey);
      await waitFor(() => drained(instance));
      expect(instance.attempts.map((attempt) => attempt.payload)).toEqual([
        { value: "final" }
      ]);
    });
  });

  it("releases a held value once, with the value the update returns", async () => {
    const { stub } = stubFor();
    await runInDurableObject(stub, async (instance: OutboxHarnessObject) => {
      await instance.outbox.send(
        "record",
        { value: "draft" },
        { key: "k", hold: true }
      );
      const update = (held: { value: string }) => ({
        value: `${held.value}+final`
      });
      const releases = await Promise.all([
        instance.outbox.release("record", "k", update),
        instance.outbox.release("record", "k", update)
      ]);
      expect(releases.sort()).toEqual([false, true]);
      await waitFor(() => drained(instance));
      expect(instance.attempts.map((attempt) => attempt.payload)).toEqual([
        { value: "draft+final" }
      ]);
      expect(await instance.outbox.release("record", "k")).toBe(false);
    });
  });

  it("delivers a value replaced during an attempt after that attempt", async () => {
    const { stub } = stubFor();
    await runInDurableObject(stub, async (instance: OutboxHarnessObject) => {
      const parked = instance.hold();
      await instance.outbox.send("record", { value: "v1" }, { key: "k" });
      await parked;
      await instance.outbox.send("record", { value: "v2" }, { key: "k" });
      instance.release();
      await waitFor(
        async () =>
          instance.attempts.length === 2 &&
          (await instance.outbox.get("record", "k")) === undefined
      );
      expect(instance.attempts.map((attempt) => attempt.payload)).toEqual([
        { value: "v1" },
        { value: "v2" }
      ]);
    });
  });

  it("resumes a value delivered in steps from its checkpoint", async () => {
    const { stub } = stubFor();
    await runInDurableObject(stub, async (instance: OutboxHarnessObject) => {
      instance.failures = 1;
      await instance.outbox.send("steps", ["a", "b", "c"]);
      await waitFor(() => drained(instance));
      expect(instance.posts).toEqual(["a", "b", "c"]);
      expect(instance.attempts.map((attempt) => attempt.checkpoint)).toEqual([
        undefined,
        1
      ]);
    });
  });

  it("counts an attempt the isolate never finished, and gives up on it", async () => {
    const { stub } = stubFor();
    await runInDurableObject(stub, async (instance: OutboxHarnessObject) => {
      const delivery = await instance.outbox.send("fragile", "x", {
        key: "crash",
        hold: true
      });
      // What a dead isolate leaves behind: the second (last) attempt was
      // counted, and nothing reported back before its lease ran out.
      instance.sql(
        `UPDATE cf_agents_outbox
         SET status = 'pending', attempts = 2, first_attempt_at = ?, next_at = ?
         WHERE id = ?`,
        Date.now() - 1_000,
        Date.now() - 1,
        delivery.id
      );
      instance.sql(
        `INSERT INTO cf_agents_jobs (id, capability, fn, time, payload, retry_options)
         VALUES (?, 'outbox', 'deliver', ?, ?, ?)`,
        `outbox:${delivery.id}`,
        Date.now() - 1,
        JSON.stringify({ id: delivery.id }),
        JSON.stringify({ maxAttempts: 1 })
      );
      await instance.lifecycle.rearmAlarm();
      await waitFor(() => instance.gaveUp.length > 0);
      expect(instance.attempts).toEqual([]);
      expect(instance.gaveUp).toEqual([
        {
          key: "crash",
          payload: "x",
          error: "The delivery attempt was interrupted"
        }
      ]);
    });
  });

  it("creates no table until the first send", async () => {
    const { stub } = stubFor();
    await runInDurableObject(stub, async (instance: OutboxHarnessObject) => {
      const table = () =>
        instance.sql(
          "SELECT name FROM sqlite_master WHERE name = 'cf_agents_outbox'"
        );
      expect(await instance.outbox.list()).toEqual([]);
      expect(await instance.outbox.get("record", "k")).toBeUndefined();
      expect(await instance.outbox.cancel("record", "k")).toBe(false);
      expect(table()).toEqual([]);
      await instance.outbox.send("record", { value: "a" }, { hold: true });
      expect(table()).toHaveLength(1);
    });
  });

  it("cancels, lists by sink and status, and validates sends", async () => {
    const { stub } = stubFor();
    await runInDurableObject(stub, async (instance: OutboxHarnessObject) => {
      await instance.outbox.send(
        "record",
        { value: "a" },
        { key: "a", hold: true }
      );
      await instance.outbox.send("steps", ["x"], { key: "b", hold: true });
      expect(
        (await instance.outbox.list({ sink: "record" })).map((d) => d.key)
      ).toEqual(["a"]);
      expect(
        (await instance.outbox.list({ status: ["held"] })).map((d) => d.key)
      ).toEqual(["a", "b"]);
      expect(await instance.outbox.cancel("record", "a")).toBe(true);
      expect(await instance.outbox.cancel("record", "a")).toBe(false);
      expect((await instance.outbox.list()).map((d) => d.key)).toEqual(["b"]);

      await expect(instance.outbox.send("nope", 1)).rejects.toThrow(
        'Unknown Outbox sink "nope"'
      );
      await expect(
        instance.outbox.send("record", {
          value: "x".repeat(MAX_OUTBOX_PAYLOAD_BYTES)
        })
      ).rejects.toThrow("over");
      await expect(
        instance.outbox.send(
          "record",
          { value: "a" },
          { retry: { maxAttempts: 0 } }
        )
      ).rejects.toThrow("maxAttempts");
    });
  });
});
