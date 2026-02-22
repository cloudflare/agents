import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName } from "..";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("queue operations", () => {
  it("should process a successful queue item", async () => {
    const agentStub = await getAgentByName(
      env.TestQueueAgent,
      "queue-success-test"
    );

    await agentStub.enqueueSuccess("item1");

    // Wait for the flush to complete
    await agentStub.waitForFlush(500);

    const executed = await agentStub.getExecutedCallbacks();
    expect(executed).toContain("success:item1");

    // Queue should be empty after processing
    const queueLength = await agentStub.getQueueLength();
    expect(queueLength).toBe(0);
  });

  it("should dequeue a failing item and not block subsequent items", async () => {
    const agentStub = await getAgentByName(
      env.TestQueueAgent,
      "queue-failing-test"
    );

    await agentStub.resetExecutedCallbacks();

    // Enqueue a throwing item first
    await agentStub.enqueueThrowing("bad");

    // Wait for the flush to process
    await agentStub.waitForFlush(500);

    // The failing item should have been dequeued
    const queueLengthAfterFail = await agentStub.getQueueLength();
    expect(queueLengthAfterFail).toBe(0);

    // Now enqueue a successful item — it should not be blocked
    await agentStub.enqueueSuccess("good");

    // Wait for the flush to process
    await agentStub.waitForFlush(500);

    const executed = await agentStub.getExecutedCallbacks();
    expect(executed).toContain("success:good");

    // Queue should be empty
    const queueLength = await agentStub.getQueueLength();
    expect(queueLength).toBe(0);
  });

  it("should process items after a failing item in the same batch", async () => {
    const agentStub = await getAgentByName(
      env.TestQueueAgent,
      "queue-mixed-test"
    );

    await agentStub.resetExecutedCallbacks();

    // Enqueue a failing item, then a succeeding item
    await agentStub.enqueueThrowing("fail1");
    await agentStub.enqueueSuccess("ok1");

    // Wait for the flush to complete
    await agentStub.waitForFlush(500);

    // The successful callback should have been executed
    const executed = await agentStub.getExecutedCallbacks();
    expect(executed).toContain("success:ok1");

    // Both items should be dequeued (failing one is removed, not retried infinitely)
    const queueLength = await agentStub.getQueueLength();
    expect(queueLength).toBe(0);
  });
});
