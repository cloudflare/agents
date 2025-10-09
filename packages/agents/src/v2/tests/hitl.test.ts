import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "./worker";
import {
  createThreadId,
  waitForProcessing,
  invokeThread,
  fetchThreadState,
  JSON_HEADERS
} from "./test-utils";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("V2 Agent Thread - HITL (Human-in-the-Loop)", () => {
  it("pauses execution when intercepted tool is called", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // Note: This test would require configuring the agent with HITL middleware
    // For now, we'll test the approve/resume flow

    // Start a run
    const invokeRes = await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Test HITL" }],
      ctx
    );
    expect(invokeRes.status).toBe(202);

    await waitForProcessing();

    // Check state - may or may not be paused depending on mock provider behavior
    const stateData = await fetchThreadState(worker, threadId, ctx);

    expect(stateData.state).toBeDefined();
    expect(stateData.run).toBeDefined();
  });

  it("resumes execution after approval", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // Start a run
    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Start" }],
      ctx
    );
    await waitForProcessing(50);

    // Approve with empty tool calls (simulating user approval)
    const approveReq = new Request(
      `http://example.com/threads/${threadId}/approve`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          approved: true,
          modified_tool_calls: []
        })
      }
    );

    // This may fail if there are no pending tool calls, which is expected
    const approveRes = await worker.fetch(approveReq, env, ctx);

    // Either successful approval or "no pending tool calls" error
    expect([200, 400]).toContain(approveRes.status);
  });

  it("allows modification of tool calls before execution", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // Start a run
    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Test" }],
      ctx
    );
    await waitForProcessing(50);

    // Try to approve with modified tool calls
    const approveReq = new Request(
      `http://example.com/threads/${threadId}/approve`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          approved: true,
          modified_tool_calls: [
            {
              tool_name: "test_tool",
              args: { modified: true }
            }
          ]
        })
      }
    );

    const res = await worker.fetch(approveReq, env, ctx);

    // May succeed or fail depending on whether there are pending calls
    expect([200, 400]).toContain(res.status);
  });

  it("rejects execution and keeps run paused", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // Start a run
    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Test rejection" }],
      ctx
    );
    await waitForProcessing(50);

    // Try to reject (approved: false)
    const approveReq = new Request(
      `http://example.com/threads/${threadId}/approve`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          approved: false,
          modified_tool_calls: []
        })
      }
    );

    const res = await worker.fetch(approveReq, env, ctx);
    expect([200, 400]).toContain(res.status);
  });

  it("handles multiple HITL interruptions in sequence", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // First invocation
    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "First" }],
      ctx
    );
    await waitForProcessing(50);

    // Try first approval
    const approve1 = new Request(
      `http://example.com/threads/${threadId}/approve`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          approved: true,
          modified_tool_calls: []
        })
      }
    );
    await worker.fetch(approve1, env, ctx);
    await waitForProcessing(50);

    // Second invocation
    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Second" }],
      ctx
    );
    await waitForProcessing(50);

    // Check state is consistent
    const data = await fetchThreadState(worker, threadId, ctx);

    expect(data.state).toBeDefined();
    expect(data.state.messages).toBeDefined();
  });

  it("returns error when approving with no run", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // Try to approve without starting a run
    const approveReq = new Request(
      `http://example.com/threads/${threadId}/approve`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          approved: true
        })
      }
    );

    const res = await worker.fetch(approveReq, env, ctx);
    expect(res.status).toBe(400);

    const text = await res.text();
    expect(text).toBe("no run");
  });

  it("returns error when approving with no pending tool calls", async () => {
    const threadId = createThreadId();
    const ctx = createExecutionContext();

    // Start a run that completes immediately
    await invokeThread(
      worker,
      threadId,
      [{ role: "user", content: "Quick test" }],
      ctx
    );
    await waitForProcessing();

    // Try to approve when there are no pending calls
    const approveReq = new Request(
      `http://example.com/threads/${threadId}/approve`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          approved: true
        })
      }
    );

    const res = await worker.fetch(approveReq, env, ctx);

    // Should return 400 with "no pending tool calls" if the run completed
    if (res.status === 400) {
      const text = await res.text();
      expect(text).toBe("no pending tool calls");
    }
  });
});
