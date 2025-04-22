import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import worker, { type Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * Common test messages
 */
const TEST_MESSAGES = {
  initialize: {
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      clientInfo: { name: "test-client", version: "1.0" },
      protocolVersion: "2025-03-26",
      capabilities: {},
    },

    id: "init-1",
  } as JSONRPCMessage,

  toolsList: {
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
    id: "tools-1",
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
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  const request = new Request(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });

  return worker.fetch(request, env, ctx);
}

function expectErrorResponse(
  data: unknown,
  expectedCode: number,
  expectedMessagePattern: RegExp
): void {
  expect(data).toMatchObject({
    jsonrpc: "2.0",
    error: expect.objectContaining({
      code: expectedCode,
      message: expect.stringMatching(expectedMessagePattern),
    }),
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
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "test-client-2", version: "1.0" },
          protocolVersion: "2025-03-26",
        },
        id: "init-2",
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
      jsonrpc: "2.0",
      result: expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: "greet",
            description: "A simple greeting tool",
          }),
        ]),
      }),
      id: "tools-1",
    });
  });

  it("should call a tool and return the result", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeServer(ctx);

    const toolCallMessage: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "greet",
        arguments: {
          name: "Test User",
        },
      },
      id: "call-1",
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
      jsonrpc: "2.0",
      result: {
        content: [
          {
            type: "text",
            text: "Hello, Test User!",
          },
        ],
      },
      id: "call-1",
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
    const errorData = (await response.json()) as { id: null };
    expectErrorResponse(errorData, -32000, /Bad Request/);
    expect(errorData.id).toBeNull();
  });

  // should reject invalid session ID
  // should reject POST requests without proper Accept header
  // should reject unsupported Content-Type
  // should handle JSON-RPC batch notification messages with 202 response
  // should handle batch request messages with SSE stream for responses
  // should properly handle invalid JSON data
  // should return 400 error for invalid JSON-RPC messages
  // should reject requests to uninitialized server
  // should send response messages to the connection that sent the request

  it("allows for a connection to be established and returns an event with the session id", async () => {
    const ctx = createExecutionContext();

    const request = new Request("http://example.com/sse");
    const sseStream = await worker.fetch(request, env, ctx);

    const reader = sseStream.body?.getReader();
    const { done, value } = await reader!.read();
    const event = new TextDecoder().decode(value);

    // We are not done yet, we expect more events
    expect(done).toBe(false);

    const lines = event.split("\n");
    expect(lines[0]).toEqual("event: endpoint");
    expect(lines[1]).toMatch(/^data: \/sse\/message\?sessionId=.*$/);
  });

  it("allows the tools to be listed once a session is established", async () => {
    const ctx = createExecutionContext();

    const request = new Request("http://example.com/sse");
    const sseStream = await worker.fetch(request, env, ctx);

    const reader = sseStream.body?.getReader();
    let { done, value } = await reader!.read();
    const event = new TextDecoder().decode(value);

    // parse the session id from the event
    const lines = event.split("\n");
    const sessionId = lines[1].split("=")[1];
    expect(sessionId).toBeDefined();

    // send a message to the session to list the tools
    const toolsRequest = new Request(
      `http://example.com/sse/message?sessionId=${sessionId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: "1",
        }),
      }
    );

    const toolsResponse = await worker.fetch(toolsRequest, env, ctx);
    expect(toolsResponse.status).toBe(202);
    expect(toolsResponse.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await toolsResponse.text()).toBe("Accepted");

    ({ done, value } = await reader!.read());

    expect(done).toBe(false);
    const toolsEvent = new TextDecoder().decode(value);
    // We expect the following event:
    // event: message
    // data: {"jsonrpc":"2.0", ... lots of other stuff ...}
    const jsonResponse = JSON.parse(
      toolsEvent.split("\n")[1].replace("data: ", "")
    );

    expect(jsonResponse.jsonrpc).toBe("2.0");
    expect(jsonResponse.id).toBe("1");
    expect(jsonResponse.result.tools).toBeDefined();
    expect(jsonResponse.result.tools.length).toBe(1);
    expect(jsonResponse.result.tools[0]).toEqual({
      name: "greet",
      description: "A simple greeting tool",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name to greet",
          },
        },
        required: ["name"],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    });
  });

  it("allows a tool to be invoked once a session is established", async () => {
    const ctx = createExecutionContext();

    const request = new Request("http://example.com/sse");
    const sseStream = await worker.fetch(request, env, ctx);

    const reader = sseStream.body?.getReader();
    let { done, value } = await reader!.read();
    const event = new TextDecoder().decode(value);

    // parse the session id from the event
    const lines = event.split("\n");
    const sessionId = lines[1].split("=")[1];
    expect(sessionId).toBeDefined();

    // send a message to the session to list the tools
    const toolsRequest = new Request(
      `http://example.com/sse/message?sessionId=${sessionId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          id: "1",
          params: {
            name: "greet",
            arguments: { name: "Citizen" },
          },
        }),
      }
    );

    const toolsResponse = await worker.fetch(toolsRequest, env, ctx);
    expect(toolsResponse.status).toBe(202);
    expect(toolsResponse.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await toolsResponse.text()).toBe("Accepted");

    ({ done, value } = await reader!.read());

    expect(done).toBe(false);
    const toolsEvent = new TextDecoder().decode(value);
    const jsonResponse = JSON.parse(
      toolsEvent.split("\n")[1].replace("data: ", "")
    );

    expect(jsonResponse).toEqual({
      jsonrpc: "2.0",
      id: "1",
      result: {
        content: [
          {
            type: "text",
            text: "Hello, Citizen!",
          },
        ],
      },
    });
  });
});
