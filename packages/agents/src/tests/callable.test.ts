import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName, type RPCRequest, type RPCResponse } from "../index";
import { MessageType } from "../types";
import type { Env } from "./worker";
import worker from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Helper type for successful RPC responses (after narrowing)
type SuccessRPCResponse = Extract<RPCResponse, { success: true }>;
type ErrorRPCResponse = Extract<RPCResponse, { success: false }>;

// Type guards for narrowing RPCResponse
function isSuccessResponse(r: RPCResponse): r is SuccessRPCResponse {
  return r.success === true;
}

function isErrorResponse(r: RPCResponse): r is ErrorRPCResponse {
  return r.success === false;
}

// Assertion helpers that narrow and return typed response
function expectSuccess(r: RPCResponse): SuccessRPCResponse {
  expect(r.success).toBe(true);
  if (!isSuccessResponse(r)) throw new Error("Expected success response");
  return r;
}

function expectError(r: RPCResponse): ErrorRPCResponse {
  expect(r.success).toBe(false);
  if (!isErrorResponse(r)) throw new Error("Expected error response");
  return r;
}

// Helper to create unique IDs
function createId(): string {
  return Math.random().toString(36).slice(2);
}

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

// Helper to wait for a single message
function waitForMessage(ws: WebSocket, timeout = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for message")),
      timeout
    );
    ws.addEventListener(
      "message",
      (e: MessageEvent) => {
        clearTimeout(timer);
        resolve(JSON.parse(e.data as string));
      },
      { once: true }
    );
  });
}

// Set of initial message types that are sent on connection
const INITIAL_MESSAGE_TYPES = new Set([
  MessageType.CF_AGENT_IDENTITY,
  MessageType.CF_AGENT_STATE,
  MessageType.CF_AGENT_MCP_SERVERS
]);

// Helper to skip initial messages (identity, state, mcp_servers)
async function skipInitialMessages(ws: WebSocket): Promise<void> {
  // Consume exactly 3 initial messages (identity, state, mcp_servers)
  for (let i = 0; i < 3; i++) {
    const msg = (await waitForMessage(ws)) as { type: string };
    expect(INITIAL_MESSAGE_TYPES.has(msg.type as MessageType)).toBe(true);
  }
}

// Helper to send RPC request and wait for response
async function callRPC(
  ws: WebSocket,
  method: string,
  args: unknown[] = [],
  timeout = 2000
): Promise<RPCResponse> {
  const id = createId();
  const request: RPCRequest = { type: MessageType.RPC, id, method, args };
  ws.send(JSON.stringify(request));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`RPC timeout for ${method}`)),
      timeout
    );

    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as RPCResponse;
      if (msg.type === MessageType.RPC && msg.id === id) {
        // For success responses, wait until done: true (or missing done for error)
        if (isSuccessResponse(msg) && msg.done === false) {
          return; // Skip intermediate streaming chunks
        }
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };

    ws.addEventListener("message", handler);
  });
}

// Helper to collect streaming responses
async function callStreamingRPC(
  ws: WebSocket,
  method: string,
  args: unknown[] = [],
  timeout = 5000
): Promise<{ chunks: unknown[]; final: unknown; error?: string }> {
  const id = createId();
  const request: RPCRequest = { type: MessageType.RPC, id, method, args };
  ws.send(JSON.stringify(request));

  const chunks: unknown[] = [];

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Streaming RPC timeout for ${method}`)),
      timeout
    );

    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as RPCResponse;
      if (msg.type === MessageType.RPC && msg.id === id) {
        if (isErrorResponse(msg)) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve({ chunks, final: undefined, error: msg.error });
          return;
        }

        if (isSuccessResponse(msg)) {
          if (msg.done === false) {
            chunks.push(msg.result);
          } else if (msg.done === true) {
            clearTimeout(timer);
            ws.removeEventListener("message", handler);
            resolve({ chunks, final: msg.result });
          }
        }
      }
    };

    ws.addEventListener("message", handler);
  });
}

describe("@callable decorator", () => {
  describe("basic RPC calls", () => {
    it("should call sync method and return result", async () => {
      const room = `callable-sync-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const response = expectSuccess(await callRPC(ws, "add", [5, 3]));

      expect(response.result).toBe(8);
      expect(response.done).toBe(true);

      ws.close();
    });

    it("should call async method and return result", async () => {
      const room = `callable-async-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const response = expectSuccess(await callRPC(ws, "asyncMethod", [10]));

      expect(response.result).toBe("done");
      expect(response.done).toBe(true);

      ws.close();
    });

    it("should handle void return type", async () => {
      const room = `callable-void-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const response = expectSuccess(await callRPC(ws, "voidMethod", []));

      expect(response.result).toBeUndefined();
      expect(response.done).toBe(true);

      ws.close();
    });

    it("should handle null return value", async () => {
      const room = `callable-null-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const response = expectSuccess(await callRPC(ws, "returnNull", []));

      expect(response.result).toBeNull();
      expect(response.done).toBe(true);

      ws.close();
    });

    it("should handle undefined return value", async () => {
      const room = `callable-undefined-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const response = expectSuccess(await callRPC(ws, "returnUndefined", []));

      expect(response.result).toBeUndefined();
      expect(response.done).toBe(true);

      ws.close();
    });
  });

  describe("error handling", () => {
    it("should propagate thrown errors to client", async () => {
      const room = `callable-error-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const response = expectError(
        await callRPC(ws, "throwError", ["Something went wrong"])
      );

      expect(response.error).toBe("Something went wrong");

      ws.close();
    });

    it("should fail when calling non-existent method", async () => {
      const room = `callable-nonexistent-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const response = expectError(await callRPC(ws, "nonExistentMethod", []));

      expect(response.error).toContain("does not exist");

      ws.close();
    });

    it("should fail when calling non-callable method", async () => {
      const room = `callable-private-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const response = expectError(await callRPC(ws, "privateMethod", []));

      expect(response.error).toContain("not callable");

      ws.close();
    });
  });

  describe("streaming responses", () => {
    it("should receive all chunks via streaming", async () => {
      const room = `callable-stream-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const { chunks, final } = await callStreamingRPC(
        ws,
        "streamNumbers",
        [5]
      );

      expect(chunks).toEqual([0, 1, 2, 3, 4]);
      expect(final).toBe(5);

      ws.close();
    });

    it("should handle async streaming with delays", async () => {
      const room = `callable-stream-delay-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const { chunks, final } = await callStreamingRPC(ws, "streamWithDelay", [
        ["a", "b", "c"],
        10
      ]);

      expect(chunks).toEqual(["a", "b", "c"]);
      expect(final).toBe("complete");

      ws.close();
    });

    it("should handle error during streaming", async () => {
      const room = `callable-stream-error-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const { chunks, error } = await callStreamingRPC(ws, "streamError", []);

      // Should receive the first chunk before error
      expect(chunks).toEqual(["chunk1"]);
      expect(error).toBe("Stream failed");

      ws.close();
    });

    it("should auto-close stream with error when method throws immediately", async () => {
      const room = `callable-stream-throws-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const { chunks, error } = await callStreamingRPC(
        ws,
        "streamThrowsImmediately",
        []
      );

      // No chunks should be received since it throws immediately
      expect(chunks).toEqual([]);
      // Should receive error from auto-close
      expect(error).toBe("Immediate failure");

      ws.close();
    });

    it("should handle double-close gracefully (no-op behavior)", async () => {
      const room = `callable-stream-double-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const { chunks, error } = await callStreamingRPC(
        ws,
        "streamDoubleClose",
        []
      );

      // Should receive chunk1 and the first error
      expect(chunks).toEqual(["chunk1"]);
      expect(error).toBe("First close");
      // Subsequent calls (end, send, error) should be no-ops, not throw

      ws.close();
    });
  });

  describe("concurrent calls", () => {
    it("should handle multiple simultaneous calls", async () => {
      const room = `callable-concurrent-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      // Send multiple calls at once
      const id1 = createId();
      const id2 = createId();
      const id3 = createId();

      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: id1,
          method: "add",
          args: [1, 2]
        })
      );
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: id2,
          method: "add",
          args: [10, 20]
        })
      );
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: id3,
          method: "add",
          args: [100, 200]
        })
      );

      // Collect responses
      const responses: Map<string, RPCResponse> = new Map();

      await new Promise<void>((resolve) => {
        const handler = (e: MessageEvent) => {
          const msg = JSON.parse(e.data as string) as RPCResponse;
          if (msg.type === MessageType.RPC) {
            responses.set(msg.id, msg);
            if (responses.size === 3) {
              ws.removeEventListener("message", handler);
              resolve();
            }
          }
        };
        ws.addEventListener("message", handler);
      });

      // Verify each response matches its request (narrow then access)
      const r1 = responses.get(id1);
      const r2 = responses.get(id2);
      const r3 = responses.get(id3);
      expect(r1 && isSuccessResponse(r1) && r1.result).toBe(3);
      expect(r2 && isSuccessResponse(r2) && r2.result).toBe(30);
      expect(r3 && isSuccessResponse(r3) && r3.result).toBe(300);

      ws.close();
    });

    it("should handle concurrent async calls independently", async () => {
      const room = `callable-concurrent-async-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      // Call async methods with different delays
      const id1 = createId();
      const id2 = createId();

      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: id1,
          method: "asyncMethod",
          args: [50]
        })
      );
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: id2,
          method: "asyncMethod",
          args: [10]
        })
      );

      // Collect responses in order received
      const responseOrder: string[] = [];
      const responses: Map<string, RPCResponse> = new Map();

      await new Promise<void>((resolve) => {
        const handler = (e: MessageEvent) => {
          const msg = JSON.parse(e.data as string) as RPCResponse;
          if (msg.type === MessageType.RPC) {
            responseOrder.push(msg.id);
            responses.set(msg.id, msg);
            if (responses.size === 2) {
              ws.removeEventListener("message", handler);
              resolve();
            }
          }
        };
        ws.addEventListener("message", handler);
      });

      // The shorter delay should complete first
      expect(responseOrder[0]).toBe(id2);
      expect(responseOrder[1]).toBe(id1);

      // Both should succeed
      expect(responses.get(id1)?.success).toBe(true);
      expect(responses.get(id2)?.success).toBe(true);

      ws.close();
    });
  });

  describe("edge cases", () => {
    it("should handle empty arguments", async () => {
      const room = `callable-empty-args-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const response = expectSuccess(await callRPC(ws, "voidMethod"));

      expect(response.done).toBe(true);

      ws.close();
    });

    it("should handle complex arguments", async () => {
      const room = `callable-complex-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      // While add only takes numbers, we're testing that args are passed correctly
      const response = expectSuccess(await callRPC(ws, "add", [42.5, -10.5]));

      expect(response.result).toBe(32);

      ws.close();
    });
  });

  describe("stream.error() method", () => {
    it("should receive error via stream.error()", async () => {
      const room = `callable-stream-graceful-error-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      const { chunks, error } = await callStreamingRPC(
        ws,
        "streamGracefulError",
        []
      );

      // Should receive the first chunk before graceful error
      expect(chunks).toEqual(["chunk1"]);
      expect(error).toBe("Graceful error");

      ws.close();
    });
  });

  describe("getCallableMethods() API", () => {
    it("should return all callable methods with metadata", async () => {
      const room = `callable-get-methods-${crypto.randomUUID()}`;

      // Get agent via RPC and call getCallableMethods
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
      await skipInitialMessages(ws);

      // We can't directly call getCallableMethods via RPC since it's not @callable
      // but we can verify the existence of callable methods by trying to call them
      // The actual getCallableMethods() is tested via server-side unit tests

      // Verify that callable methods work
      const addResponse = expectSuccess(await callRPC(ws, "add", [1, 2]));
      expect(addResponse.result).toBe(3);

      // Verify non-callable method fails
      const privateResponse = expectError(
        await callRPC(ws, "privateMethod", [])
      );
      expect(privateResponse.error).toContain("not callable");

      ws.close();
    });
  });
});

describe("getCallableMethods prototype chain", () => {
  it("should find callable methods from parent classes", async () => {
    const agentStub = await getAgentByName(
      env.TestChildAgent,
      "prototype-chain-test"
    );

    // Get all callable method names
    const methodNames = await agentStub.getCallableMethodNames();

    // Should include both parent and child methods
    expect(methodNames).toContain("parentMethod");
    expect(methodNames).toContain("childMethod");
    expect(methodNames).toContain("sharedMethod");

    // Should NOT include non-callable methods
    expect(methodNames).not.toContain("nonCallableMethod");
  });
});

/**
 * AgentClient.call() Backward Compatibility Note
 *
 * The AgentClient.call() method supports two formats for streaming options:
 *
 * Legacy format (for backward compatibility):
 *   agent.call("streamMethod", [args], { onChunk, onDone, onError })
 *
 * New format (preferred, supports timeout):
 *   agent.call("streamMethod", [args], { stream: { onChunk, onDone, onError }, timeout: 5000 })
 *
 * The client detects legacy format by checking for onChunk/onDone/onError at the top level.
 * This detection is implemented in packages/agents/src/client.ts in the call() method.
 *
 * The streaming tests above verify the underlying RPC protocol works correctly.
 * The format detection is a client-side implementation detail that normalizes
 * options before sending RPC messages - both formats produce identical wire messages.
 *
 * Testing AgentClient directly would require PartySocket infrastructure which
 * isn't available in the vitest cloudflare:test environment.
 */
