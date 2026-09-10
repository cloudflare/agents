import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_DISPOSITIONS, PiSubmissions } from "../harness/intake";
import type { PiExtensionsTestObject } from "./worker";

/**
 * `runInDurableObject`, typed for this example's objects.
 *
 * The pool constrains its instance to `DurableObject<Cloudflare.Env, {}>`,
 * which an object declared as `DurableObject<Env>` does not structurally
 * satisfy; the stub is the right object, so the cast stops here.
 */
function inObject<R>(
  callback: (
    instance: PiExtensionsTestObject,
    state: DurableObjectState
  ) => Promise<R>
): Promise<R> {
  const stub = env.PI_EXTENSIONS_TEST.getByName(crypto.randomUUID());
  return runInDurableObject(
    stub as unknown as Parameters<typeof runInDurableObject>[0],
    (instance, state) =>
      callback(instance as unknown as PiExtensionsTestObject, state)
  );
}

describe("out-of-band submissions are at most once", () => {
  it("runs a retried slash command once", async () => {
    const result = await inObject(async (instance) => {
      const operationId = crypto.randomUUID();
      const first = await instance.harness.submit(
        { kind: "prompt", prompt: "/note remember this" },
        { operationId }
      );
      // The same submission again: a client that never saw the first receipt.
      const second = await instance.harness.submit(
        { kind: "prompt", prompt: "/note remember this" },
        { operationId }
      );
      const entries = await instance.harness.getCustomEntries();
      return {
        first,
        second,
        notes: entries.filter((entry) => entry.customType === "test:note")
          .length
      };
    });

    expect(result.first).toMatchObject({ accepted: false, command: "note" });
    // The retry gets the first attempt's receipt back, not a second run.
    expect(result.second).toMatchObject({ accepted: false, command: "note" });
    expect(result.notes).toBe(1);
  });

  it("reports a retried handled input as handled without re-running it", async () => {
    const result = await inObject(async (instance) => {
      const operationId = crypto.randomUUID();
      const first = await instance.harness.submit(
        { kind: "prompt", prompt: "swallow this" },
        { operationId }
      );
      const second = await instance.harness.submit(
        { kind: "prompt", prompt: "swallow this" },
        { operationId }
      );
      const snapshot = await instance.harness.snapshot();
      return { first, second, queued: snapshot.queue.length };
    });

    expect(result.first).toMatchObject({ accepted: false, handled: true });
    expect(result.second).toMatchObject({ accepted: false, handled: true });
    expect(result.queued).toBe(0);
  });

  it("refuses a submission whose claim outlived its isolate", async () => {
    const result = await inObject(async (instance, state) => {
      // The durable trace an eviction between the claim and the handler's
      // return leaves behind. The handler may have run in part, so the retry
      // is answered rather than replayed.
      const operationId = crypto.randomUUID();
      const submissions = new PiSubmissions(state.storage);
      submissions.ensureTable();
      submissions.claim("default", operationId);

      const receipt = await instance.harness.submit(
        { kind: "prompt", prompt: "/note never runs" },
        { operationId }
      );
      const entries = await instance.harness.getCustomEntries();
      return {
        receipt,
        notes: entries.filter((entry) => entry.customType === "test:note")
          .length
      };
    });

    expect(result.receipt).toMatchObject({ accepted: false, handled: true });
    expect(result.notes).toBe(0);
  });

  it("still queues an ordinary prompt once the claim is released", async () => {
    const result = await inObject(async (instance) => {
      const operationId = crypto.randomUUID();
      const first = await instance.harness.submit(
        { kind: "prompt", prompt: "plain words" },
        { operationId }
      );
      const second = await instance.harness.submit(
        { kind: "prompt", prompt: "plain words" },
        { operationId }
      );
      return { first: first.accepted, second: second.accepted };
    });

    expect(result).toEqual({ first: true, second: false });
  });
});

describe("disposition retention", () => {
  /**
   * The dispositions are an idempotency window, not a log: without a bound
   * the table grows for the life of the session, one row per out-of-band
   * submission. A retry older than the window is treated as a new
   * submission, which is the trade the cap makes.
   */
  it("keeps only the newest window of dispositions", async () => {
    const result = await inObject(async (_instance, state) => {
      const submissions = new PiSubmissions(state.storage);
      submissions.ensureTable();
      const overflow = 25;
      for (let index = 0; index < MAX_DISPOSITIONS + overflow; index += 1) {
        const operationId = `op-${String(index).padStart(6, "0")}`;
        submissions.claim("default", operationId);
        submissions.settle(operationId, "handled");
      }
      const count = state.storage.sql
        .exec<{ rows: number }>(
          "SELECT COUNT(*) AS rows FROM cf_agents_pi_dispositions"
        )
        .one().rows;
      return {
        count,
        oldest: submissions.disposition("op-000000"),
        newest: submissions.disposition(
          `op-${String(MAX_DISPOSITIONS + overflow - 1).padStart(6, "0")}`
        )
      };
    });

    expect(result.count).toBe(MAX_DISPOSITIONS);
    expect(result.oldest).toBeUndefined();
    expect(result.newest).toMatchObject({ kind: "handled" });
  });
});
