import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName, type RPCRequest, type RPCResponse } from "../index";
import { MessageType } from "../types";
import {
  genericObservability,
  subscribe,
  type ObservabilityEvent
} from "../observability";
import type { Env } from "./worker";
import worker from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// ── subscribe() helper ──────────────────────────────────────────────

describe("subscribe()", () => {
  it("should receive events published via genericObservability", () => {
    const received: ObservabilityEvent[] = [];
    const unsub = subscribe("rpc", (event) => {
      received.push(event);
    });

    genericObservability.emit({
      type: "rpc",
      payload: { method: "testMethod", streaming: false },
      timestamp: Date.now()
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("rpc");
    if (received[0].type === "rpc") {
      expect(received[0].payload.method).toBe("testMethod");
    }

    unsub();
  });

  it("should stop receiving events after unsubscribe", () => {
    const received: ObservabilityEvent[] = [];
    const unsub = subscribe("rpc", (event) => {
      received.push(event);
    });

    genericObservability.emit({
      type: "rpc",
      payload: { method: "before" },
      timestamp: Date.now()
    });

    unsub();

    genericObservability.emit({
      type: "rpc",
      payload: { method: "after" },
      timestamp: Date.now()
    });

    expect(received).toHaveLength(1);
    if (received[0].type === "rpc") {
      expect(received[0].payload.method).toBe("before");
    }
  });

  it("should only receive events for the subscribed channel", () => {
    const rpcEvents: ObservabilityEvent[] = [];
    const stateEvents: ObservabilityEvent[] = [];

    const unsubRpc = subscribe("rpc", (event) => rpcEvents.push(event));
    const unsubState = subscribe("state", (event) => stateEvents.push(event));

    genericObservability.emit({
      type: "rpc",
      payload: { method: "test" },
      timestamp: Date.now()
    });

    genericObservability.emit({
      type: "state:update",
      payload: {},
      timestamp: Date.now()
    });

    expect(rpcEvents).toHaveLength(1);
    expect(stateEvents).toHaveLength(1);
    expect(rpcEvents[0].type).toBe("rpc");
    expect(stateEvents[0].type).toBe("state:update");

    unsubRpc();
    unsubState();
  });
});

// ── Channel routing ─────────────────────────────────────────────────

describe("channel routing", () => {
  it("should route rpc:error to the rpc channel", () => {
    const received: ObservabilityEvent[] = [];
    const unsub = subscribe("rpc", (event) => received.push(event));

    genericObservability.emit({
      type: "rpc:error",
      payload: { method: "broken", error: "fail" },
      timestamp: Date.now()
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("rpc:error");

    unsub();
  });

  it("should route schedule:* and queue:* to the schedule channel", () => {
    const received: ObservabilityEvent[] = [];
    const unsub = subscribe("schedule", (event) => received.push(event));

    const scheduleTypes = [
      "schedule:create",
      "schedule:execute",
      "schedule:cancel",
      "schedule:retry",
      "schedule:error",
      "queue:retry",
      "queue:error"
    ] as const;

    for (const type of scheduleTypes) {
      genericObservability.emit({
        type,
        payload: { callback: "cb", id: "1" },
        timestamp: Date.now()
      } as ObservabilityEvent);
    }

    expect(received).toHaveLength(scheduleTypes.length);

    unsub();
  });

  it("should route workflow:* to the workflow channel", () => {
    const received: ObservabilityEvent[] = [];
    const unsub = subscribe("workflow", (event) => received.push(event));

    genericObservability.emit({
      type: "workflow:start",
      payload: { workflowId: "wf-1", workflowName: "test" },
      timestamp: Date.now()
    });

    genericObservability.emit({
      type: "workflow:approved",
      payload: { workflowId: "wf-1", reason: "lgtm" },
      timestamp: Date.now()
    });

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("workflow:start");
    expect(received[1].type).toBe("workflow:approved");

    unsub();
  });

  it("should route connect and destroy to the lifecycle channel", () => {
    const received: ObservabilityEvent[] = [];
    const unsub = subscribe("lifecycle", (event) => received.push(event));

    genericObservability.emit({
      type: "connect",
      payload: { connectionId: "conn-1" },
      timestamp: Date.now()
    });

    genericObservability.emit({
      type: "destroy",
      payload: {},
      timestamp: Date.now()
    });

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("connect");
    expect(received[1].type).toBe("destroy");

    unsub();
  });

  it("should route message:* to the message channel", () => {
    const received: ObservabilityEvent[] = [];
    const unsub = subscribe("message", (event) => received.push(event));

    genericObservability.emit({
      type: "message:request",
      payload: {},
      timestamp: Date.now()
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("message:request");

    unsub();
  });

  it("should route mcp:* to the mcp channel", () => {
    const received: ObservabilityEvent[] = [];
    const unsub = subscribe("mcp", (event) => received.push(event));

    genericObservability.emit({
      type: "mcp:client:connect",
      payload: { url: "http://test", transport: "sse", state: "connected" },
      timestamp: Date.now()
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("mcp:client:connect");

    unsub();
  });
});

// ── Error event emission (integration) ──────────────────────────────

// Helper to connect via WebSocket
async function connectWS(path: string) {
  const ctx = createExecutionContext();
  const req = new Request(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  const res = await worker.fetch(req, env, ctx);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws, ctx };
}

// Helper to skip initial messages (identity, state, mcp_servers)
async function skipInitialMessages(ws: WebSocket): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", () => resolve(), { once: true });
    });
  }
}

// Helper to send RPC and wait for response
async function callRPC(
  ws: WebSocket,
  method: string,
  args: unknown[] = []
): Promise<RPCResponse> {
  const id = Math.random().toString(36).slice(2);
  const request: RPCRequest = { type: MessageType.RPC, id, method, args };
  ws.send(JSON.stringify(request));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`RPC timeout for ${method}`)),
      2000
    );
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as RPCResponse;
      if (msg.type === MessageType.RPC && msg.id === id) {
        if (msg.success && (msg as { done?: boolean }).done === false) return;
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
  });
}

describe("error event emission", () => {
  it("should emit rpc:error when a callable method throws", async () => {
    const errors: ObservabilityEvent[] = [];
    const unsub = subscribe("rpc", (event) => {
      if (event.type === "rpc:error") {
        errors.push(event);
      }
    });

    const { ws } = await connectWS(
      `/agents/test-callable-agent/rpc-error-obs-${crypto.randomUUID()}`
    );
    await skipInitialMessages(ws);

    // Call a method that does not exist (privateMethod is not @callable)
    const response = await callRPC(ws, "privateMethod");
    expect(response.success).toBe(false);

    ws.close();
    unsub();

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].type).toBe("rpc:error");
    if (errors[0].type === "rpc:error") {
      expect(errors[0].payload.method).toBe("privateMethod");
    }
  });

  it("should emit queue:error when a queue callback fails", async () => {
    const errors: ObservabilityEvent[] = [];
    const unsub = subscribe("schedule", (event) => {
      if (event.type === "queue:error") {
        errors.push(event);
      }
    });

    const agentStub = await getAgentByName(
      env.TestQueueAgent,
      "queue-error-obs-test"
    );

    // Enqueue a throwing callback
    await agentStub.enqueueThrowing("fail");

    // Wait for the flush to complete
    await agentStub.waitForFlush(2000);

    unsub();

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].type).toBe("queue:error");
    if (errors[0].type === "queue:error") {
      expect(errors[0].payload.callback).toBe("throwingCallback");
      expect(errors[0].payload.error).toBeDefined();
    }
  });
});
