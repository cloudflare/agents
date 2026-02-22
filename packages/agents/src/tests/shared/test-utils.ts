import { env } from "cloudflare:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "vitest";
import worker, { type Env } from "../worker";
import { MCPClientConnection } from "../../mcp/client-connection";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * Common test messages for MCP protocol testing
 */
export const TEST_MESSAGES = {
  initialize: {
    id: "init-1",
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {
        elicitation: { form: {} }
      },
      clientInfo: { name: "test-client", version: "1.0" },
      protocolVersion: "2025-03-26"
    }
  } as JSONRPCMessage,

  toolsList: {
    id: "tools-1",
    jsonrpc: "2.0",
    method: "tools/list",
    params: {}
  } as JSONRPCMessage,

  greetTool: {
    id: "greet-1",
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      arguments: { name: "Test User" },
      name: "greet"
    }
  } as JSONRPCMessage,

  propsTestTool: {
    id: "props-1",
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      arguments: {},
      name: "getPropsTestValue"
    }
  } as JSONRPCMessage
};

/**
 * Helper to extract text from SSE response
 * Note: Can only be called once per response stream. For multiple reads,
 * get the reader manually and read multiple times.
 */
export async function readSSEEvent(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  const { value } = await reader!.read();
  return new TextDecoder().decode(value);
}

/**
 * Helper to send JSON-RPC request via POST
 */
export async function sendPostRequest(
  ctx: ExecutionContext,
  baseUrl: string,
  message: JSONRPCMessage | JSONRPCMessage[],
  sessionId?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json"
  };

  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  const request = new Request(baseUrl, {
    body: JSON.stringify(message),
    headers,
    method: "POST"
  });

  return worker.fetch(request, env, ctx);
}

/**
 * Helper to validate JSON-RPC error responses
 */
export function expectErrorResponse(
  data: unknown,
  expectedCode: number,
  expectedMessagePattern: RegExp
): void {
  expect(data).toMatchObject({
    error: expect.objectContaining({
      code: expectedCode,
      message: expect.stringMatching(expectedMessagePattern)
    }),
    jsonrpc: "2.0"
  });
}

/**
 * Helper to parse SSE event data
 */
export function parseSSEData(sseText: string): unknown {
  const eventLines = sseText.split("\n");
  const dataLine = eventLines.find((line) => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error("No data line found in SSE event");
  }
  return JSON.parse(dataLine.substring(5));
}

/**
 * Helper to initialize server and get session ID for streamable HTTP
 */
export async function initializeStreamableHTTPServer(
  ctx: ExecutionContext,
  baseUrl = "http://example.com/mcp"
): Promise<string> {
  const response = await sendPostRequest(
    ctx,
    baseUrl,
    TEST_MESSAGES.initialize
  );

  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeDefined();
  return sessionId as string;
}

export async function initializeMCPClientConnection(
  baseUrl = "http://example.com/mcp",
  transportType: "auto" | "streamable-http" | "sse" | "rpc" = "auto",
  transportOptions?: Record<string, unknown>
) {
  return new MCPClientConnection(
    new URL(baseUrl),
    { name: "test-client", version: "1.0.0" },
    { transport: { type: transportType, ...transportOptions }, client: {} }
  );
}

/**
 * Helper to create RPC connection to TestMcpAgent
 */
export async function establishRPCConnection(): Promise<{
  connection: MCPClientConnection;
  sessionId: string;
}> {
  const name = crypto.randomUUID();

  const connection = await initializeMCPClientConnection(
    `rpc://${name}`,
    "rpc",
    { namespace: env.MCP_OBJECT, name }
  );

  await connection.init();

  return { connection, sessionId: `rpc:${name}` };
}

/**
 * Helper to establish SSE connection and get session ID
 */
export async function establishSSEConnection(
  ctx: ExecutionContext,
  baseUrl = "http://example.com/sse"
): Promise<{
  sessionId: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}> {
  const request = new Request(baseUrl);
  const sseStream = await worker.fetch(request, env, ctx);

  const reader = sseStream.body?.getReader();
  if (!reader) {
    throw new Error("No reader available");
  }
  const { value } = await reader.read();
  const event = new TextDecoder().decode(value);

  const lines = event.split("\n");
  const sessionId = lines[1].split("=")[1];
  expect(sessionId).toBeDefined();

  return { sessionId, reader };
}

/**
 * Helper to establish the standalone SSE connection for
 * server-sent requests and notifications with streaming HTTP
 */
export async function openStandaloneSSE(
  ctx: ExecutionContext,
  sessionId: string,
  baseUrl = "http://example.com/mcp"
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const request = new Request(`${baseUrl}?sessionId=${sessionId}`, {
    headers: {
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId
    },

    method: "GET"
  });
  const response = await worker.fetch(request, env, ctx);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(response.headers.get("mcp-session-id")).toBe(sessionId);

  const reader = response.body?.getReader();
  expect(reader).toBeTruthy();
  if (!reader) throw new Error("No reader available for standalone SSE");
  return reader;
}

/**
 * Read a single SSE event, or return null if nothing arrives within `ms`.
 * Used to assert that certain actions DO NOT produce messages on the stream.
 */
export async function readSSEEventWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms = 50
): Promise<string | null> {
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), ms)
  );
  const read = reader.read().then(({ done, value }) => {
    if (done || !value) return "";
    return new TextDecoder().decode(value);
  });
  const result = await Promise.race([read, timeout]);
  return result === null ? null : (result as string);
}

/**
 * Common test assertions for tool listing results
 */
export function expectValidToolsList(result: unknown): void {
  expect(result).toMatchObject({
    jsonrpc: "2.0",
    result: expect.objectContaining({
      tools: expect.arrayContaining([
        expect.objectContaining({
          description: "A simple greeting tool",
          name: "greet",
          inputSchema: expect.objectContaining({
            type: "object",
            properties: expect.objectContaining({
              name: expect.objectContaining({
                type: "string"
              })
            })
          })
        })
      ])
    })
  });
}

/**
 * Common test assertions for greet tool results
 */
export function expectValidGreetResult(
  result: unknown,
  expectedName: string
): void {
  expect(result).toMatchObject({
    jsonrpc: "2.0",
    result: {
      content: [
        {
          text: `Hello, ${expectedName}!`,
          type: "text"
        }
      ]
    }
  });
}

/**
 * Common test assertions for props test tool results
 */
export function expectValidPropsResult(result: unknown): void {
  expect(result).toMatchObject({
    jsonrpc: "2.0",
    result: {
      content: [
        {
          text: "123",
          type: "text"
        }
      ]
    }
  });
}
