import { describe, expect, it } from "vitest";
import type { OutboxDeliveryContext } from "agents/chat";
import {
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
});
