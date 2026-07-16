/**
 * Ported from ORIGINAL Agents:
 * - packages/agents/src/tests/callable.test.ts
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `agents`/`MessageType` imports to `./compat.js`.
 * - Re-authored callable fixtures against rebuild `Think` + hostAgent.
 * - Dropped native-covered RPC dispatch/decorator behavior with pointers.
 * - Kept `stream.error()` and inherited callable discovery as
 *   [fidelity:adapter] probes.
 */
// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName, MessageType } from "./compat.js";
import type { TestP12ChildAgent } from "./fixtures/p12-callable-agents.js";

type RPCResponse =
  | {
      type: MessageType.RPC;
      id: string;
      success: true;
      result: unknown;
      done?: boolean;
    }
  | {
      type: MessageType.RPC;
      id: string;
      success: false;
      error: string;
      done?: boolean;
    };

const worker = (exports as { default: { fetch: typeof fetch } }).default;
const p12Env = env as unknown as {
  TestP12ChildAgent: DurableObjectNamespace<TestP12ChildAgent>;
};

function createId(): string {
  return Math.random().toString(36).slice(2);
}

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

async function drainInitialMessages(ws: WebSocket): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 75));
  ws.addEventListener("message", () => {});
}

async function callStreamingRPC(
  ws: WebSocket,
  method: string,
  args: unknown[] = [],
  timeout = 5000
): Promise<{ chunks: unknown[]; final: unknown; error?: string }> {
  const id = createId();
  ws.send(JSON.stringify({ type: MessageType.RPC, id, method, args }));

  const chunks: unknown[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Streaming RPC timeout for ${method}`)),
      timeout
    );
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as RPCResponse;
      if (msg.type !== MessageType.RPC || msg.id !== id) return;
      if (msg.success === false) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve({ chunks, final: undefined, error: msg.error });
        return;
      }
      if (msg.done === false) {
        chunks.push(msg.result);
      } else if (msg.done === true) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve({ chunks, final: msg.result });
      }
    };
    ws.addEventListener("message", handler);
  });
}

describe("@callable decorator (ported)", () => {
  describe("basic RPC calls", () => {
    it.skip("should call sync method and return result", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — non-streaming dispatch returns a success result frame.

    it.skip("should call async method and return result", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — dispatch awaits returned promises.

    it.skip("should ignore RPC error responses after the client disconnects", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — thrown callable errors are converted to error frames; transport closed-connection suppression is covered by adapter close handling.

    it.skip("should handle void return type", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — plain dispatch returns the method result with done true, including undefined.

    it.skip("should handle null return value", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — plain dispatch preserves returned values.

    it.skip("should handle undefined return value", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — plain dispatch preserves undefined results.
  });

  describe("error handling", () => {
    it.skip("should propagate thrown errors to client", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — thrown methods produce error frames and rpc:error.

    it.skip("should fail when calling non-existent method", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — unknown methods produce an error frame.

    it.skip("should fail when calling non-callable method", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — only scanned/decorated methods are registered.
  });

  describe("streaming responses", () => {
    it.skip("should receive all chunks via streaming", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — streaming dispatch sends chunks then final done.

    it.skip("should handle async streaming with delays", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — streaming dispatch awaits async methods.

    it.skip("should handle error during streaming", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — streaming methods that throw after partial sends end with error.

    it.skip("should auto-close stream with error when method throws immediately", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — streaming methods that throw before sending produce an error frame.

    it("should handle double-close gracefully (no-op behavior)", async () => {
      const room = `callable-stream-double-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-p12-callable-agent/${room}`);
      await drainInitialMessages(ws);

      const { chunks, error } = await callStreamingRPC(
        ws,
        "streamDoubleClose",
        []
      );

      expect(chunks).toEqual(["chunk1"]);
      expect(error).toBe("First close");
      ws.close();
    });
  });

  describe("concurrent calls", () => {
    it.skip("should handle multiple simultaneous calls", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — independent request ids and plain dispatch are covered at registry level.

    it.skip("should handle concurrent async calls independently", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — async dispatch independence is a registry behavior; adapter concurrency is outside the callable substrate.
  });

  describe("edge cases", () => {
    it.skip("should handle empty arguments", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — dispatch accepts an args array and calls methods with it.

    it.skip("should handle complex arguments", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — dispatch forwards args to methods.
  });

  describe("stream.error() method", () => {
    it("should receive error via stream.error()", async () => {
      const room = `callable-stream-graceful-error-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-p12-callable-agent/${room}`);
      await drainInitialMessages(ws);

      const { chunks, error } = await callStreamingRPC(
        ws,
        "streamGracefulError",
        []
      );

      expect(chunks).toEqual(["chunk1"]);
      expect(error).toBe("Graceful error");
      ws.close();
    });
  });

  describe("getCallableMethods() API", () => {
    it.skip("should return all callable methods with metadata", () => {});
    // dropped: native src/domain/runtime/rpc/callable.test.ts — callable metadata exposure is asserted on the registry.
  });
});

describe("getCallableMethods prototype chain (ported)", () => {
  it("should find callable methods from parent classes", async () => {
    const agentStub = await getAgentByName(
      p12Env.TestP12ChildAgent,
      `prototype-chain-test-${crypto.randomUUID()}`
    );

    const methodNames = await agentStub.getCallableMethodNames();

    expect(methodNames).toContain("parentMethod");
    expect(methodNames).toContain("childMethod");
    expect(methodNames).toContain("sharedMethod");
    expect(methodNames).not.toContain("nonCallableMethod");
  });
});
