/**
 * Ported from ORIGINAL Agents:
 * - packages/agents/src/tests/client-timeout.test.ts
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `MessageType` import to `./compat.js`.
 * - Binds original `/agents/test-callable-agent/{name}` route to an alias of
 *   Round A's callable streaming fixture.
 */
// @ts-nocheck
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MessageType } from "./compat.js";

const worker = (exports as { default: { fetch: typeof fetch } }).default;

async function connectWS(path: string): Promise<{ ws: WebSocket }> {
  const res = await worker.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

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
        // Ignore parse errors.
      }
    };
    ws.addEventListener("message", handler);
  });
}

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
  ws.send(
    JSON.stringify({
      type: MessageType.RPC,
      id,
      method,
      args
    })
  );

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

describe("client timeout + streaming interaction (ported)", () => {
  describe("streaming with delays", () => {
    it("should receive all chunks from a delayed streaming call", async () => {
      const room = `stream-delay-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      await collectMessages(ws, 3);

      const { chunks, final, error, timedOut } = await callStreamingRPC(
        ws,
        "streamWithDelay",
        [["chunk1", "chunk2", "chunk3"], 50],
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

      await collectMessages(ws, 3);

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

      await collectMessages(ws, 3);

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
    it("should timeout if server takes too long (simulated via short timeout)", async () => {
      const room = `stream-timeout-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      await collectMessages(ws, 3);

      const { chunks, timedOut } = await callStreamingRPC(
        ws,
        "streamWithDelay",
        [["a", "b", "c", "d", "e"], 100],
        200
      );

      expect(timedOut).toBe(true);
      expect(chunks.length).toBeGreaterThanOrEqual(0);
      expect(chunks.length).toBeLessThan(5);

      ws.close();
    });

    it("should complete when given sufficient time", async () => {
      const room = `stream-no-timeout-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      await collectMessages(ws, 3);

      const { chunks, final, timedOut } = await callStreamingRPC(
        ws,
        "streamWithDelay",
        [["x", "y", "z"], 20],
        2000
      );

      expect(timedOut).toBe(false);
      expect(chunks).toEqual(["x", "y", "z"]);
      expect(final).toBe("complete");

      ws.close();
    });
  });
});
