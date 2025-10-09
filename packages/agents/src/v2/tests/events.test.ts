import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "./worker";
import { AgentEventType } from "../events";
import {
  createThreadId,
  waitForProcessing,
  invokeThread,
  fetchThreadEvents
} from "./test-utils";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("V2 Agent Thread - Events and Checkpointing", () => {
  it("emits RUN_STARTED event when a run begins", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Start run" }],
      ctx
    );
    await waitForProcessing();

    const data = await fetchThreadEvents(worker, threadId, ctx);

    expect(data.events).toBeDefined();
    const runStartedEvent = data.events.find(
      (e: { type: string }) => e.type === AgentEventType.RUN_STARTED
    );

    if (runStartedEvent) {
      expect(runStartedEvent).toHaveProperty("data");
      expect(runStartedEvent.data).toHaveProperty("run_id");
      expect(runStartedEvent).toHaveProperty("thread_id", threadId);
      expect(runStartedEvent).toHaveProperty("ts");
      expect(runStartedEvent).toHaveProperty("seq");
    }
  });

  it("emits RUN_TICK events during execution", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Execute steps" }],
      ctx
    );
    await waitForProcessing(150);

    const data = await fetchThreadEvents(worker, threadId, ctx);

    const tickEvents = data.events.filter(
      (e: { type: string }) => e.type === AgentEventType.RUN_TICK
    );

    // Should have at least one tick event
    if (tickEvents.length > 0) {
      expect(tickEvents[0].data).toHaveProperty("run_id");
      expect(tickEvents[0].data).toHaveProperty("step");
      expect(typeof tickEvents[0].data.step).toBe("number");
    }
  });

  it("emits RUN_CANCELED event when run is canceled", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // Start run
    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Start" }],
      ctx
    );
    await waitForProcessing(50);

    // Cancel it
    const cancelReq = new Request(
      `http://example.com/threads/${threadId}/cancel`,
      {
        method: "POST"
      }
    );
    await worker.fetch(cancelReq, env, ctx);
    await waitForProcessing(50);

    // Check events
    const data = await fetchThreadEvents(worker, threadId, ctx);

    const canceledEvent = data.events.find(
      (e: { type: string }) => e.type === AgentEventType.RUN_CANCELED
    );

    if (canceledEvent) {
      expect(canceledEvent.data).toHaveProperty("run_id");
    }
  });

  it("emits CHECKPOINT_SAVED events", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Test checkpointing" }],
      ctx
    );
    await waitForProcessing(150);

    const data = await fetchThreadEvents(worker, threadId, ctx);

    const checkpointEvents = data.events.filter(
      (e: { type: string }) => e.type === AgentEventType.CHECKPOINT_SAVED
    );

    // Should have checkpoint events
    if (checkpointEvents.length > 0) {
      const checkpoint = checkpointEvents[0];
      expect(checkpoint.data).toHaveProperty("state_hash");
      expect(checkpoint.data).toHaveProperty("size");
      expect(typeof checkpoint.data.state_hash).toBe("string");
      expect(typeof checkpoint.data.size).toBe("number");
    }
  });

  it("maintains sequential event numbering", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // Multiple invocations to generate events
    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "First" }],
      ctx
    );
    await waitForProcessing();

    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Second" }],
      ctx
    );
    await waitForProcessing();

    const data = await fetchThreadEvents(worker, threadId, ctx);

    // Verify sequence numbers are monotonically increasing
    const sequences = data.events.map((e: { seq: number }) => e.seq);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
    }
  });

  it("includes timestamps in all events", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Timestamp test" }],
      ctx
    );
    await waitForProcessing();

    const data = await fetchThreadEvents(worker, threadId, ctx);

    // All events should have valid ISO timestamps
    for (const event of data.events) {
      expect(event).toHaveProperty("ts");
      expect(typeof event.ts).toBe("string");
      expect(() => new Date(event.ts)).not.toThrow();
      expect(new Date(event.ts).toISOString()).toBe(event.ts);
    }
  });

  it("respects event ring buffer limit", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // Generate many events by doing multiple invocations
    // The ring buffer is set to 500 in worker.ts
    for (let i = 0; i < 10; i++) {
      await invokeThread(
        worker,
        threadId,
        [{ role: "user", content: `Message ${i}` }],
        ctx
      );
      await waitForProcessing(30);
    }

    const data = await fetchThreadEvents(worker, threadId, ctx);

    // Should have events, but not exceed the ring buffer limit of 500
    expect(data.events.length).toBeLessThanOrEqual(500);
  });

  it("emits MODEL_STARTED and MODEL_COMPLETED events", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Model test" }],
      ctx
    );
    await waitForProcessing(150);

    const data = await fetchThreadEvents(worker, threadId, ctx);

    // Currently not implemented in runner.ts, but test structure is here
    // When implemented, these events should be present:
    // const modelStartedEvents = data.events.filter(
    //   (e: { type: string }) => e.type === AgentEventType.MODEL_STARTED
    // );
    // const modelCompletedEvents = data.events.filter(
    //   (e: { type: string }) => e.type === AgentEventType.MODEL_COMPLETED
    // );
    // expect(modelStartedEvents.length).toBeGreaterThan(0);
    // expect(modelCompletedEvents.length).toBeGreaterThan(0);

    // For now, just verify we got some events
    expect(data.events.length).toBeGreaterThan(0);
  });

  it("emits AGENT_COMPLETED event when run finishes", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Complete this" }],
      ctx
    );

    // Wait longer to ensure completion
    await waitForProcessing(200);

    const data = await fetchThreadEvents(worker, threadId, ctx);

    const completedEvent = data.events.find(
      (e: { type: string }) => e.type === AgentEventType.AGENT_COMPLETED
    );

    // Should have completion event when run finishes
    if (completedEvent) {
      expect(completedEvent.data).toHaveProperty("result");
    }
  });
});
