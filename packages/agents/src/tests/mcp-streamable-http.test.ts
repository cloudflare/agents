import { createExecutionContext, env } from "cloudflare:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import worker, { type Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * Common test messages
 */
const TEST_MESSAGES = {
  initialize: {
    id: "init-1",
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0" },
      protocolVersion: "2025-03-26",
    },
  } as JSONRPCMessage,

  toolsList: {
    id: "tools-1",
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
  } as JSONRPCMessage,
};

/**
 * Helper to extract text from SSE response
 * Note: Can only be called once per response stream. For multiple reads,
 * get the reader manually and read multiple times.
 */
async function readSSEEvent(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  const { value } = await reader!.read();
  return new TextDecoder().decode(value);
}

/**
 * Helper to send JSON-RPC request
 */
async function sendPostRequest(
  ctx: ExecutionContext,
  baseUrl: string,
  message: JSONRPCMessage | JSONRPCMessage[],
  sessionId?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };

  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  const request = new Request(baseUrl, {
    body: JSON.stringify(message),
    headers,
    method: "POST",
  });

  return worker.fetch(request, env, ctx);
}

function expectErrorResponse(
  data: unknown,
  expectedCode: number,
  expectedMessagePattern: RegExp
): void {
  expect(data).toMatchObject({
    error: expect.objectContaining({
      code: expectedCode,
      message: expect.stringMatching(expectedMessagePattern),
    }),
    jsonrpc: "2.0",
  });
}

describe("McpAgent Streamable HTTP Transport", () => {
  const baseUrl = "http://example.com/mcp";

  async function initializeServer(ctx: ExecutionContext): Promise<string> {
    const response = await sendPostRequest(
      ctx,
      baseUrl,
      TEST_MESSAGES.initialize
    );

    expect(response.status).toBe(200);
    const newSessionId = response.headers.get("mcp-session-id");
    expect(newSessionId).toBeDefined();
    return newSessionId as string;
  }

  it("should initialize server and generate session ID", async () => {
    const ctx = createExecutionContext();

    const response = await sendPostRequest(
      ctx,
      baseUrl,
      TEST_MESSAGES.initialize
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("mcp-session-id")).toBeDefined();
  });

  it("should reject second initialization request", async () => {
    const ctx = createExecutionContext();

    // First initialize
    const sessionId = await initializeServer(ctx);
    expect(sessionId).toBeDefined();

    // Try second initialize
    const secondInitMessage = {
      ...TEST_MESSAGES.initialize,
      id: "second-init",
    };

    const response = await sendPostRequest(
      ctx,
      baseUrl,
      secondInitMessage,
      sessionId
    );

    expect(response.status).toBe(400);
    const errorData = await response.json();
    expectErrorResponse(
      errorData,
      -32600,
      /Initialization requests must not include a sessionId/
    );
  });

  // should reject batch initialization request
  it("should reject batch initialize request", async () => {
    const ctx = createExecutionContext();

    const batchInitMessages: JSONRPCMessage[] = [
      TEST_MESSAGES.initialize,
      {
        id: "init-2",
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client-2", version: "1.0" },
          protocolVersion: "2025-03-26",
        },
      },
    ];

    const response = await sendPostRequest(ctx, baseUrl, batchInitMessages);

    expect(response.status).toBe(400);
    const errorData = await response.json();
    expectErrorResponse(
      errorData,
      -32600,
      /Only one initialization request is allowed/
    );
  });

  it("should pandle post requests via sse response correctly", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeServer(ctx);

    const response = await sendPostRequest(
      ctx,
      baseUrl,
      TEST_MESSAGES.toolsList,
      sessionId
    );

    expect(response.status).toBe(200);

    // Read the SSE stream for the response
    const text = await readSSEEvent(response);

    // Parse the SSE event
    const eventLines = text.split("\n");
    const dataLine = eventLines.find((line) => line.startsWith("data:"));
    expect(dataLine).toBeDefined();

    const eventData = JSON.parse(dataLine!.substring(5));
    expect(eventData).toMatchObject({
      id: "tools-1",
      jsonrpc: "2.0",
      result: expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({
            description: "A simple greeting tool",
            name: "greet",
          }),
        ]),
      }),
    });
  });

  it("should call a tool and return the result", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeServer(ctx);

    const toolCallMessage: JSONRPCMessage = {
      id: "call-1",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          name: "Test User",
        },
        name: "greet",
      },
    };

    const response = await sendPostRequest(
      ctx,
      baseUrl,
      toolCallMessage,
      sessionId
    );
    expect(response.status).toBe(200);

    const text = await readSSEEvent(response);
    const eventLines = text.split("\n");
    const dataLine = eventLines.find((line) => line.startsWith("data:"));
    expect(dataLine).toBeDefined();

    const eventData = JSON.parse(dataLine!.substring(5));
    expect(eventData).toMatchObject({
      id: "call-1",
      jsonrpc: "2.0",
      result: {
        content: [
          {
            text: "Hello, Test User!",
            type: "text",
          },
        ],
      },
    });
  });

  // should reject requests without a valid session ID
  it("should reject requests without a valid session ID", async () => {
    const ctx = createExecutionContext();

    const response = await sendPostRequest(
      ctx,
      baseUrl,
      TEST_MESSAGES.toolsList
    );

    expect(response.status).toBe(400);
    const errorData = (await response.json()) as { id: string | number | null };
    expectErrorResponse(errorData, -32000, /Bad Request/);
    expect(errorData.id).toBeNull();
  });

  it("should reject invalid session ID", async () => {
    const ctx = createExecutionContext();

    // Now try with invalid session ID
    const response = await sendPostRequest(
      ctx,
      baseUrl,
      TEST_MESSAGES.toolsList,
      "invalid-session-id"
    );

    expect(response.status).toBe(404);
    const errorData = await response.json();
    expectErrorResponse(errorData, -32001, /Session not found/);
  });

  it("should reject POST requests without proper Accept header", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeServer(ctx);

    // Try POST without Accept: text/event-stream
    const request = new Request(baseUrl, {
      body: JSON.stringify(TEST_MESSAGES.toolsList),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json", // Missing text/event-stream
        "mcp-session-id": sessionId,
      },
      method: "POST",
    });
    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(406);
    const errorData = await response.json();

    expectErrorResponse(
      errorData,
      -32000,
      /Client must accept both application\/json and text\/event-stream/
    );
  });

  it("should reject unsupported Content-Type", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeServer(ctx);

    // Try POST with text/plain Content-Type
    const request = new Request(baseUrl, {
      body: "This is plain text",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "text/plain",
        "mcp-session-id": sessionId,
      },
      method: "POST",
    });
    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(415);
    const errorData = await response.json();
    expectErrorResponse(
      errorData,
      -32000,
      /Content-Type must be application\/json/
    );
  });

  it("should handle JSON-RPC batch notification messages with 202 response", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeServer(ctx);

    // Send batch of notifications (no IDs)
    const batchNotifications: JSONRPCMessage[] = [
      { jsonrpc: "2.0", method: "someNotification1", params: {} },
      { jsonrpc: "2.0", method: "someNotification2", params: {} },
    ];
    const response = await sendPostRequest(
      ctx,
      baseUrl,
      batchNotifications,
      sessionId
    );

    expect(response.status).toBe(202);
  });

  it("should handle batch request messages with SSE stream for responses", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeServer(ctx);

    // Send batch of requests
    const batchRequests: JSONRPCMessage[] = [
      { id: "req-1", jsonrpc: "2.0", method: "tools/list", params: {} },
      {
        id: "req-2",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { name: "BatchUser" }, name: "greet" },
      },
    ];
    const response = await sendPostRequest(
      ctx,
      baseUrl,
      batchRequests,
      sessionId
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body?.getReader();

    // The responses may come in any order or together in one chunk
    const { value: value1 } = await reader!.read();
    const text1 = new TextDecoder().decode(value1);
    const { value: value2 } = await reader!.read();
    const text2 = new TextDecoder().decode(value2);

    const combinedText = text1 + text2;

    // Check that both responses were sent on the same stream
    expect(combinedText).toContain('"id":"req-1"');
    expect(combinedText).toContain('"tools"'); // tools/list result
    expect(combinedText).toContain('"id":"req-2"');
    expect(combinedText).toContain("Hello, BatchUser"); // tools/call result
  });

  it("should properly handle invalid JSON data", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeServer(ctx);

    // Send invalid JSON
    const request = new Request(baseUrl, {
      body: "This is not valid JSON",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "mcp-session-id": sessionId,
      },
      method: "POST",
    });
    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    const errorData = await response.json();
    expectErrorResponse(errorData, -32700, /Parse error/);
  });

  it("should return 400 error for invalid JSON-RPC messages", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeServer(ctx);

    // Invalid JSON-RPC (missing required jsonrpc version)
    const invalidMessage = { id: 1, method: "tools/list", params: {} }; // missing jsonrpc version
    const response = await sendPostRequest(
      ctx,
      baseUrl,
      invalidMessage as JSONRPCMessage,
      sessionId
    );

    expect(response.status).toBe(400);
    const errorData = await response.json();
    expect(errorData).toMatchObject({
      error: expect.anything(),
      jsonrpc: "2.0",
    });
  });

  it("should send response messages to the connection that sent the request", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeServer(ctx);

    const message1: JSONRPCMessage = {
      id: "req-1",
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    };

    const message2: JSONRPCMessage = {
      id: "req-2",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: { name: "Connection2" },
        name: "greet",
      },
    };

    // Make two concurrent fetch connections for different requests
    const req1 = sendPostRequest(ctx, baseUrl, message1, sessionId);
    const req2 = sendPostRequest(ctx, baseUrl, message2, sessionId);

    // Get both responses
    const [response1, response2] = await Promise.all([req1, req2]);
    const reader1 = response1.body?.getReader();
    const reader2 = response2.body?.getReader();

    // Read responses from each stream (requires each receives its specific response)
    const { value: value1 } = await reader1!.read();
    const text1 = new TextDecoder().decode(value1);
    expect(text1).toContain('"id":"req-1"');
    expect(text1).toContain('"tools"'); // tools/list result

    const { value: value2 } = await reader2!.read();
    const text2 = new TextDecoder().decode(value2);
    expect(text2).toContain('"id":"req-2"');
    expect(text2).toContain("Hello, Connection2"); // tools/call result
  });

  it("should pass props to the agent", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeServer(ctx);

    const toolCallMessage: JSONRPCMessage = {
      id: "call-1",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {},
        name: "getPropsTestValue",
      },
    };

    const response = await sendPostRequest(
      ctx,
      baseUrl,
      toolCallMessage,
      sessionId
    );
    expect(response.status).toBe(200);

    const text = await readSSEEvent(response);
    const eventLines = text.split("\n");
    const dataLine = eventLines.find((line) => line.startsWith("data:"));
    expect(dataLine).toBeDefined();

    const eventData = JSON.parse(dataLine!.substring(5));
    expect(eventData).toMatchObject({
      id: "call-1",
      jsonrpc: "2.0",
      result: {
        content: [
          {
            text: "123",
            type: "text",
          },
        ],
      },
    });
  });
});
