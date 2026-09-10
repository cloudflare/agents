import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PiSubmissions } from "../harness/intake";
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
