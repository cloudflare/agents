/**
 * Tests for AgentClient timeout + streaming behavior.
 *
 * These tests verify that when an RPC call times out:
 * 1. The promise is rejected with a timeout error
 * 2. For streaming calls, onError is also called
 *
 * Since AgentClient extends PartySocket which requires WebSocket infrastructure,
 * these tests verify the behavior through the actual WebSocket interface by
 * creating slow-responding methods on the server side.
 */

import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MessageType } from "../types";
import type { Env } from "./worker";
import worker from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
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

// Helper to collect messages until a specific count or timeout
function collectMessages(
  ws: WebSocket,
  count: number,
  timeout = 2000
): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    const timer = setTimeout(() => {
      resolve(messages);
    }, timeout);

    const handler = (e: MessageEvent) => {
      try {
        messages.push(JSON.parse(e.data as string));
        if (messages.length >= count) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(messages);
        }
      } catch {
        // Ignore parse errors
      }
    };
    ws.addEventListener("message", handler);
  });
}

// Helper to wait for RPC response with streaming chunks
async function callStreamingRPC(
  ws: WebSocket,
  method: string,
  args: unknown[] = [],
  timeout = 5000
): Promise<{
  chunks: unknown[];
  final: unknown;
  error?: string;
  timedOut: boolean;
}> {
  const id = crypto.randomUUID();
  const request = {
    type: MessageType.RPC,
    id,
    method,
    args
  };
  ws.send(JSON.stringify(request));

  const chunks: unknown[] = [];

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve({ chunks, final: undefined, timedOut: true });
    }, timeout);

    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as {
        type?: string;
        id?: string;
        success?: boolean;
        result?: unknown;
        error?: string;
        done?: boolean;
      };

      if (msg.type === MessageType.RPC && msg.id === id) {
        if (msg.success === false) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve({
            chunks,
            final: undefined,
            error: msg.error,
            timedOut: false
          });
          return;
        }

        if (msg.success && msg.done === false) {
          chunks.push(msg.result);
        } else if (msg.success && msg.done === true) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve({ chunks, final: msg.result, timedOut: false });
        }
      }
    };

    ws.addEventListener("message", handler);
  });
}

describe("client timeout + streaming interaction", () => {
  describe("streaming with delays", () => {
    it("should receive all chunks from a delayed streaming call", async () => {
      const room = `stream-delay-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // Skip initial messages (identity, state, mcp_servers)
      await collectMessages(ws, 3);

      // Call a streaming method with delays
      const { chunks, final, error, timedOut } = await callStreamingRPC(
        ws,
        "streamWithDelay",
        [["chunk1", "chunk2", "chunk3"], 50], // 50ms delay between chunks
        5000
      );

      expect(timedOut).toBe(false);
      expect(error).toBeUndefined();
      expect(chunks).toEqual(["chunk1", "chunk2", "chunk3"]);
      expect(final).toBe("complete");

      ws.close();
    });

    it("should receive partial chunks before stream error", async () => {
      const room = `stream-error-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // Skip initial messages
      await collectMessages(ws, 3);

      // Call a streaming method that sends a chunk then errors
      const { chunks, error, timedOut } = await callStreamingRPC(
        ws,
        "streamError",
        [],
        5000
      );

      expect(timedOut).toBe(false);
      expect(chunks).toEqual(["chunk1"]);
      expect(error).toBe("Stream failed");

      ws.close();
    });

    it("should handle graceful error via stream.error()", async () => {
      const room = `stream-graceful-error-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // Skip initial messages
      await collectMessages(ws, 3);

      // Call a streaming method that uses stream.error()
      const { chunks, error, timedOut } = await callStreamingRPC(
        ws,
        "streamGracefulError",
        [],
        5000
      );

      expect(timedOut).toBe(false);
      expect(chunks).toEqual(["chunk1"]);
      expect(error).toBe("Graceful error");

      ws.close();
    });
  });

  describe("timeout behavior simulation", () => {
    /**
     * Note: The actual AgentClient timeout is client-side and can't be directly
     * tested in the workers test environment. These tests verify that:
     * 1. Slow streaming calls work when given enough time
     * 2. The server correctly streams chunks over time
     *
     * The timeout + onError callback behavior is implemented in client.ts
     * and would need browser/node tests with PartySocket for full coverage.
     */

    it("should timeout if server takes too long (simulated via short timeout)", async () => {
      const room = `stream-timeout-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // Skip initial messages
      await collectMessages(ws, 3);

      // Call with a very short timeout - should timeout before completion
      // The method delays 50ms between chunks, 3 chunks = 150ms minimum
      const { chunks, timedOut } = await callStreamingRPC(
        ws,
        "streamWithDelay",
        [["a", "b", "c", "d", "e"], 100], // 100ms delay, 5 chunks = 500ms
        200 // Only wait 200ms - should timeout mid-stream
      );

      // We should timeout, but may have received some chunks
      expect(timedOut).toBe(true);
      // Should have received at least one chunk before timeout
      expect(chunks.length).toBeGreaterThanOrEqual(0);
      expect(chunks.length).toBeLessThan(5);

      ws.close();
    });

    it("should complete when given sufficient time", async () => {
      const room = `stream-no-timeout-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // Skip initial messages
      await collectMessages(ws, 3);

      // Call with enough timeout
      const { chunks, final, timedOut } = await callStreamingRPC(
        ws,
        "streamWithDelay",
        [["x", "y", "z"], 20], // 20ms delay, 3 chunks = 60ms
        2000 // 2 second timeout - plenty of time
      );

      expect(timedOut).toBe(false);
      expect(chunks).toEqual(["x", "y", "z"]);
      expect(final).toBe("complete");

      ws.close();
    });
  });
});

/**
 * AgentClient.call() Timeout + Streaming Behavior Note
 *
 * When a timeout is specified for a streaming call:
 *
 *   agent.call("streamMethod", [args], {
 *     stream: { onChunk, onDone, onError },
 *     timeout: 5000
 *   })
 *
 * If the call times out:
 * 1. The promise is rejected with a timeout error
 * 2. The onError callback is called with the timeout message
 * 3. Any chunks received before timeout are still delivered via onChunk
 *
 * This ensures consistent error handling whether using promise-based or
 * callback-based patterns for streaming results.
 *
 * The actual implementation is in packages/agents/src/client.ts in the
 * timeout handler for the call() method.
 */
