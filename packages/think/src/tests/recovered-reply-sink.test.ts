import { describe, expect, it } from "vitest";
import type { OutboxDeliveryContext } from "agents/internal";
import {
  fitRecoveredReply,
  migrateLegacyRecoveredReplies,
  recoveredReplySink,
  type RecoveredReplyPost
} from "../messengers/recovered-reply";

function context(store: { checkpoint?: unknown }): OutboxDeliveryContext {
  return {
    id: "d",
    sink: "s",
    key: "k",
    idempotencyKey: "i",
    version: 1,
    attempt: 1,
    checkpoint: store.checkpoint,
    saveCheckpoint: async (value) => {
      store.checkpoint = value;
    }
  };
}

describe("recovered reply sink", () => {
  it("spends no post when the messenger host cannot be reached", async () => {
    const posts: number[] = [];
    let reachable = false;
    const sink = recoveredReplySink(async () => {
      if (!reachable) throw new Error("parent lookup failed");
      return async (input: RecoveredReplyPost) => {
        posts.push(input.chunk);
        return { chunks: 1 };
      };
    });
    const reply = {
      messengerId: "fake",
      threadId: "t",
      partialText: "",
      outcome: "completed" as const,
      text: "answer"
    };
    const store: { checkpoint?: unknown } = {};

    await expect(sink.deliver(reply, context(store))).rejects.toThrow(
      "parent lookup failed"
    );
    expect(store.checkpoint).toBeUndefined();

    reachable = true;
    await sink.deliver(reply, context(store));
    expect(posts).toEqual([0]);
  });

  it("cuts a reply too long for one Outbox value", () => {
    const fitted = fitRecoveredReply({
      messengerId: "fake",
      threadId: "t",
      partialText: "p".repeat(1_200_000),
      outcome: "completed",
      text: "x".repeat(1_500_000)
    });
    const bytes = new TextEncoder().encode(JSON.stringify(fitted)).byteLength;
    expect(bytes).toBeLessThan(2 * 900_000 + 1_000);
    expect(fitted.text?.endsWith("…")).toBe(true);
  });

  it("migrates the other legacy replies when one cannot be stored", async () => {
    const records = new Map<string, unknown>([
      [
        "cf_think_messenger_recovery:bad",
        { messengerId: "f", threadId: "t", partialText: "" }
      ],
      [
        "cf_think_messenger_recovery:good",
        { messengerId: "f", threadId: "t", partialText: "" }
      ]
    ]);
    const storage = {
      list: async () => new Map(records),
      delete: async (key: string) => records.delete(key)
    } as unknown as DurableObjectStorage;
    const sent: string[] = [];
    await migrateLegacyRecoveredReplies(storage, async (_reply, incidentId) => {
      if (incidentId === "bad") throw new Error("too large");
      sent.push(incidentId);
    });
    expect(sent).toEqual(["good"]);
    expect([...records.keys()]).toEqual(["cf_think_messenger_recovery:bad"]);
  });
});
