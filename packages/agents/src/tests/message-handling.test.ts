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

// Helper to wait for a specific RPC response by ID
function waitForRPCResponse(
  ws: WebSocket,
  id: string,
  timeout = 2000
): Promise<{ id: string; success: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for RPC response ${id}`)),
      timeout
    );

    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as {
          type?: string;
          id?: string;
          success?: boolean;
          result?: unknown;
          error?: string;
        };
        if (msg.type === MessageType.RPC && msg.id === id) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(
            msg as {
              id: string;
              success: boolean;
              result?: unknown;
              error?: string;
            }
          );
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.addEventListener("message", handler);
  });
}

// Helper to collect messages with timeout
function collectMessages(
  ws: WebSocket,
  count: number,
  timeout = 2000
): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    const timer = setTimeout(() => {
      resolve(messages); // Return what we have instead of rejecting
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
        // Ignore parse errors for this test
      }
    };
    ws.addEventListener("message", handler);
  });
}

describe("message handling edge cases", () => {
  describe("identity message validation", () => {
    it("should receive valid identity message on connect", async () => {
      const room = `identity-valid-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // First message should be identity
      const identityMsg = (await waitForMessage(ws)) as {
        type: string;
        name: string;
        agent: string;
      };

      expect(identityMsg.type).toBe(MessageType.CF_AGENT_IDENTITY);
      expect(typeof identityMsg.name).toBe("string");
      expect(typeof identityMsg.agent).toBe("string");
      expect(identityMsg.name).toBe(room);
      expect(identityMsg.agent).toBe("test-callable-agent");

      ws.close();
    });

    it("should receive identity, state, and mcp_servers messages on connect", async () => {
      const room = `identity-all-messages-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // Collect initial messages (state may arrive 1-2 times depending on timing)
      const messages = await collectMessages(ws, 5);

      const types = messages.map((m: unknown) => (m as { type: string }).type);

      expect(types).toContain(MessageType.CF_AGENT_IDENTITY);
      expect(types).toContain(MessageType.CF_AGENT_STATE);
      expect(types).toContain(MessageType.CF_AGENT_MCP_SERVERS);

      ws.close();
    });

    it("should not send identity when sendIdentityOnConnect is false", async () => {
      const room = `no-identity-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-no-identity-agent/${room}`);

      // Collect messages - should NOT include identity
      const messages = await collectMessages(ws, 5, 1000);

      const types = messages.map((m: unknown) => (m as { type: string }).type);

      // Should have state and mcp_servers, but NOT identity
      expect(types).not.toContain(MessageType.CF_AGENT_IDENTITY);
      expect(types).toContain(MessageType.CF_AGENT_STATE);
      expect(types).toContain(MessageType.CF_AGENT_MCP_SERVERS);

      ws.close();
    });
  });

  describe("malformed message handling", () => {
    it("should ignore invalid JSON messages without crashing", async () => {
      const room = `malformed-json-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // Skip initial messages
      await collectMessages(ws, 3);

      // Send malformed JSON
      ws.send("this is not json {{{");
      ws.send("{incomplete json");
      ws.send("null");
      ws.send("undefined");

      // The connection should still be alive - try a valid RPC call
      const id = crypto.randomUUID();
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id,
          method: "add",
          args: [1, 2]
        })
      );

      // Should receive response - use waitForRPCResponse to filter for our specific response
      const response = await waitForRPCResponse(ws, id);
      expect(response.id).toBe(id);
      expect(response.success).toBe(true);

      ws.close();
    });

    it("should ignore messages with unknown type", async () => {
      const room = `unknown-type-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // Skip initial messages
      await collectMessages(ws, 3);

      // Send message with unknown type
      ws.send(JSON.stringify({ type: "UNKNOWN_MESSAGE_TYPE", data: "test" }));
      ws.send(JSON.stringify({ type: 999, data: "test" }));
      ws.send(JSON.stringify({ type: null, data: "test" }));

      // Connection should still work
      const id = crypto.randomUUID();
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id,
          method: "add",
          args: [5, 5]
        })
      );

      const response = await waitForRPCResponse(ws, id);
      expect(response.id).toBe(id);
      expect(response.success).toBe(true);
      expect(response.result).toBe(10);

      ws.close();
    });

    it("should handle RPC with missing required fields", async () => {
      const room = `malformed-rpc-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // Skip initial messages
      await collectMessages(ws, 3);

      // Send RPC without id
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          method: "add",
          args: [1, 2]
        })
      );

      // Send RPC without method
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: "test-id",
          args: [1, 2]
        })
      );

      // Valid RPC should still work
      const id = crypto.randomUUID();
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id,
          method: "add",
          args: [3, 4]
        })
      );

      const response = await waitForRPCResponse(ws, id);
      expect(response.id).toBe(id);
      expect(response.success).toBe(true);
      expect(response.result).toBe(7);

      ws.close();
    });

    it("should handle empty message gracefully", async () => {
      const room = `empty-message-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // Skip initial messages
      await collectMessages(ws, 3);

      // Send empty messages
      ws.send("");
      ws.send("{}");
      ws.send("[]");

      // Valid RPC should still work
      const id = crypto.randomUUID();
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id,
          method: "voidMethod",
          args: []
        })
      );

      const response = await waitForRPCResponse(ws, id);
      expect(response.id).toBe(id);
      expect(response.success).toBe(true);

      ws.close();
    });
  });

  describe("RPC message edge cases", () => {
    it("should handle RPC with null args without crashing", async () => {
      const room = `null-args-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // Skip initial messages
      await collectMessages(ws, 3);

      // Send RPC with null args - this is malformed
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: "null-args-id",
          method: "voidMethod",
          args: null
        })
      );

      // The server may not respond to malformed requests, but the connection
      // should still be alive for valid requests
      const validId = crypto.randomUUID();
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: validId,
          method: "add",
          args: [10, 20]
        })
      );

      const response = await waitForRPCResponse(ws, validId);
      expect(response.id).toBe(validId);
      expect(response.success).toBe(true);
      expect(response.result).toBe(30);

      ws.close();
    });

    it("should handle RPC with missing args without crashing", async () => {
      const room = `missing-args-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // Skip initial messages
      await collectMessages(ws, 3);

      // Send RPC without args field - JSON.stringify omits undefined values
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: "missing-args-id",
          method: "voidMethod"
        })
      );

      // The server may not respond to requests with missing args, but the
      // connection should still be alive for valid requests
      const validId = crypto.randomUUID();
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id: validId,
          method: "add",
          args: [7, 8]
        })
      );

      const response = await waitForRPCResponse(ws, validId);
      expect(response.id).toBe(validId);
      expect(response.success).toBe(true);
      expect(response.result).toBe(15);

      ws.close();
    });

    it("should handle RPC with extra unexpected fields", async () => {
      const room = `extra-fields-${crypto.randomUUID()}`;
      const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);

      // Skip initial messages
      await collectMessages(ws, 3);

      const id = crypto.randomUUID();
      ws.send(
        JSON.stringify({
          type: MessageType.RPC,
          id,
          method: "add",
          args: [1, 2],
          extraField: "should be ignored",
          nested: { foo: "bar" },
          timestamp: Date.now()
        })
      );

      const response = await waitForRPCResponse(ws, id);
      expect(response.id).toBe(id);
      expect(response.success).toBe(true);
      expect(response.result).toBe(3);

      ws.close();
    });
  });
});
