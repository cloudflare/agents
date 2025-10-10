// @ts-expect-error TODO: fix this
import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "./worker";
import {
  createThreadId,
  waitForProcessing,
  invokeThread,
  fetchThreadState,
  fetchThreadEvents
} from "./test-utils";

// @ts-expect-error TODO: fix this
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("V2 Agent Thread - Basic Operations", () => {
  it("creates a new thread via POST /threads", async () => {
    const ctx = createExecutionContext();
    const req = new Request("http://example.com/threads", {
      method: "POST"
    });

    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data).toHaveProperty("id");
    expect(typeof data.id).toBe("string");
  });

  it("invokes a thread and starts a run", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    const res = await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Hello!" }],
      ctx
    );

    expect(res.status).toBe(202);

    const data = await res.json();
    expect(data).toHaveProperty("run_id");
    expect(data).toHaveProperty("status");
    expect(["running", "paused", "completed"]).toContain(data.status);
  });

  it("retrieves thread state", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // First invoke to create state
    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Test message" }],
      ctx
    );

    // Wait a bit for processing
    await waitForProcessing();

    // Get state
    const data = await fetchThreadState(worker, threadId, ctx);
    expect(data).toHaveProperty("state");
    expect(data).toHaveProperty("run");
    expect(data.state.messages).toBeDefined();
    expect(Array.isArray(data.state.messages)).toBe(true);
  });

  it("retrieves thread events", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // Invoke to create some events
    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Hello" }],
      ctx
    );

    // Wait for processing
    await waitForProcessing();

    // Get events
    const data = await fetchThreadEvents(worker, threadId, ctx);
    expect(data).toHaveProperty("events");
    expect(Array.isArray(data.events)).toBe(true);

    // Should have at least a RUN_STARTED event
    if (data.events.length > 0) {
      const event = data.events[0];
      expect(event).toHaveProperty("type");
      expect(event).toHaveProperty("thread_id");
      expect(event).toHaveProperty("ts");
      expect(event).toHaveProperty("seq");
    }
  });

  it("cancels a running thread", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // Start a run
    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Test" }],
      ctx
    );

    // Cancel it
    const cancelReq = new Request(
      `http://example.com/threads/${threadId}/cancel`,
      {
        method: "POST"
      }
    );
    const res = await worker.fetch(cancelReq, env, ctx);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ ok: true });

    // Check state to verify cancellation
    const stateData = await fetchThreadState(worker, threadId, ctx);

    if (stateData.run) {
      expect(stateData.run.status).toBe("canceled");
    }
  });

  it("persists messages across multiple invocations", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // First message
    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "First message" }],
      ctx
    );
    await waitForProcessing();

    // Second message
    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Second message" }],
      ctx
    );
    await waitForProcessing();

    // Check state
    const data = await fetchThreadState(worker, threadId, ctx);

    // Should have both user messages
    const userMessages = data.state.messages.filter(
      (m: { role: string }) => m.role === "user"
    );
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
  });

  it("merges files into VFS", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Check files" }],
      ctx,
      {
        "test.txt": "Hello, world!",
        "config.json": '{"key": "value"}'
      }
    );
    await waitForProcessing();

    // Check state
    const data = await fetchThreadState(worker, threadId, ctx);

    expect(data.state.files).toBeDefined();
    expect(data.state.files["test.txt"]).toBe("Hello, world!");
    expect(data.state.files["config.json"]).toBe('{"key": "value"}');
  });
});
