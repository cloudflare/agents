import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResultResponse
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import worker from "../worker";
import {
  initializeStreamableHTTPServer,
  sendPostRequest,
  openStandaloneSSE,
  readSSEEvent,
  parseSSEData,
  establishSSEConnection,
  establishRPCConnection
} from "../shared/test-utils";

async function readOneFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<string> {
  const { value } = await reader.read();
  return new TextDecoder().decode(value!);
}

function parseSSEFrame(text: string): unknown {
  const dataLine = text.split("\n").find((l: string) => l.startsWith("data:"));
  if (!dataLine) throw new Error("No data line in SSE frame");
  return JSON.parse(dataLine.substring(5));
}

/**
 * Tests for McpAgent.elicitInput() — our custom in-memory resolver path.
 * Uses the "elicitNameCustom" tool which calls this.elicitInput() directly.
 */
describe("McpAgent.elicitInput() in-memory resolver", () => {
  describe("Streamable HTTP", () => {
    const baseUrl = "http://example.com/mcp";

    it("should complete elicitation accept round-trip", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);
      const standaloneReader = await openStandaloneSSE(ctx, sessionId, baseUrl);

      // Call the custom elicitation tool (uses McpAgent.elicitInput)
      const toolCallMsg: JSONRPCMessage = {
        id: "custom-elicit-1",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "elicitNameCustom", arguments: {} }
      };

      const toolResponsePromise = sendPostRequest(
        ctx,
        baseUrl,
        toolCallMsg,
        sessionId
      );

      // Read the elicitation request from the standalone SSE stream
      const elicitFrame = await readOneFrame(standaloneReader);
      const elicitRequest = parseSSEData(elicitFrame) as JSONRPCRequest;

      expect(elicitRequest.method).toBe("elicitation/create");
      expect(elicitRequest.params).toMatchObject({
        message: "What is your name?",
        requestedSchema: expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            name: expect.objectContaining({ type: "string" })
          })
        })
      });

      // Our custom elicitInput generates IDs starting with "elicit_"
      const elicitRequestId = elicitRequest.id;
      expect(String(elicitRequestId).startsWith("elicit_")).toBe(true);

      // Send the accept response
      const elicitResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: elicitRequestId,
        result: {
          action: "accept",
          content: { name: "Alice" }
        }
      } as unknown as JSONRPCMessage;

      const responsePost = await sendPostRequest(
        ctx,
        baseUrl,
        elicitResponse,
        sessionId
      );
      expect(responsePost.status).toBe(202);

      // Read the tool call result
      const toolResponse = await toolResponsePromise;
      expect(toolResponse.status).toBe(200);
      const toolSseText = await readSSEEvent(toolResponse);
      const toolResult = parseSSEData(toolSseText) as JSONRPCResultResponse;

      expect(toolResult.id).toBe("custom-elicit-1");
      const result = toolResult.result as CallToolResult;
      expect(result.content).toEqual([
        { type: "text", text: "Custom elicit: Alice" }
      ]);

      await standaloneReader.cancel();
    });

    it("should route McpAgent.elicitInput through the originating POST stream without standalone SSE", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const toolCallMsg: JSONRPCMessage = {
        id: "custom-elicit-post-1",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "elicitNameCustom", arguments: {} }
      };

      const toolResponse = await sendPostRequest(
        ctx,
        baseUrl,
        toolCallMsg,
        sessionId
      );
      expect(toolResponse.status).toBe(200);

      const reader = toolResponse.body?.getReader();
      expect(reader).toBeTruthy();
      if (!reader) throw new Error("No reader available for POST stream");

      const elicitFrame = await readOneFrame(reader);
      const elicitRequest = parseSSEData(elicitFrame) as JSONRPCRequest;

      expect(elicitRequest.method).toBe("elicitation/create");
      expect(String(elicitRequest.id).startsWith("elicit_")).toBe(true);

      const elicitResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: elicitRequest.id,
        result: {
          action: "accept",
          content: { name: "Alice" }
        }
      } as unknown as JSONRPCMessage;

      const responsePost = await sendPostRequest(
        ctx,
        baseUrl,
        elicitResponse,
        sessionId
      );
      expect(responsePost.status).toBe(202);

      const toolResultFrame = await readOneFrame(reader);
      const toolResult = parseSSEData(toolResultFrame) as JSONRPCResultResponse;

      expect(toolResult.id).toBe("custom-elicit-post-1");
      const result = toolResult.result as CallToolResult;
      expect(result.content).toEqual([
        { type: "text", text: "Custom elicit: Alice" }
      ]);
    });

    it("should route SDK Server.elicitInput through the originating POST stream without standalone SSE", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const toolCallMsg: JSONRPCMessage = {
        id: "sdk-elicit-post-1",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "elicitName", arguments: {} }
      };

      const toolResponse = await sendPostRequest(
        ctx,
        baseUrl,
        toolCallMsg,
        sessionId
      );
      expect(toolResponse.status).toBe(200);

      const reader = toolResponse.body?.getReader();
      expect(reader).toBeTruthy();
      if (!reader) throw new Error("No reader available for POST stream");

      const elicitFrame = await readOneFrame(reader);
      const elicitRequest = parseSSEData(elicitFrame) as JSONRPCRequest;

      expect(elicitRequest.method).toBe("elicitation/create");

      const elicitResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: elicitRequest.id,
        result: {
          action: "accept",
          content: { name: "Alice" }
        }
      } as unknown as JSONRPCMessage;

      const responsePost = await sendPostRequest(
        ctx,
        baseUrl,
        elicitResponse,
        sessionId
      );
      expect(responsePost.status).toBe(202);

      const toolResultFrame = await readOneFrame(reader);
      const toolResult = parseSSEData(toolResultFrame) as JSONRPCResultResponse;

      expect(toolResult.id).toBe("sdk-elicit-post-1");
      const result = toolResult.result as CallToolResult;
      expect(result.content).toEqual([
        { type: "text", text: "You said your name is: Alice" }
      ]);
    });

    it("should keep concurrent elicitation requests on their own POST streams", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);

      const firstToolCall: JSONRPCMessage = {
        id: "custom-elicit-concurrent-1",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "elicitNameCustom", arguments: {} }
      };
      const secondToolCall: JSONRPCMessage = {
        id: "custom-elicit-concurrent-2",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "elicitNameCustom", arguments: {} }
      };

      const [firstResponse, secondResponse] = await Promise.all([
        sendPostRequest(ctx, baseUrl, firstToolCall, sessionId),
        sendPostRequest(ctx, baseUrl, secondToolCall, sessionId)
      ]);

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);

      const firstReader = firstResponse.body?.getReader();
      const secondReader = secondResponse.body?.getReader();
      expect(firstReader).toBeTruthy();
      expect(secondReader).toBeTruthy();
      if (!firstReader || !secondReader) {
        throw new Error("No reader available for POST stream");
      }

      const [firstElicitFrame, secondElicitFrame] = await Promise.all([
        readOneFrame(firstReader),
        readOneFrame(secondReader)
      ]);
      const firstElicit = parseSSEData(firstElicitFrame) as JSONRPCRequest;
      const secondElicit = parseSSEData(secondElicitFrame) as JSONRPCRequest;

      expect(firstElicit.method).toBe("elicitation/create");
      expect(secondElicit.method).toBe("elicitation/create");
      expect(firstElicit.id).not.toBe(secondElicit.id);

      const secondElicitResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: secondElicit.id,
        result: {
          action: "accept",
          content: { name: "Second" }
        }
      } as unknown as JSONRPCMessage;
      await sendPostRequest(ctx, baseUrl, secondElicitResponse, sessionId);

      const secondToolResultFrame = await readOneFrame(secondReader);
      const secondToolResult = parseSSEData(
        secondToolResultFrame
      ) as JSONRPCResultResponse;
      expect(secondToolResult.id).toBe("custom-elicit-concurrent-2");
      expect((secondToolResult.result as CallToolResult).content).toEqual([
        { type: "text", text: "Custom elicit: Second" }
      ]);

      const firstElicitResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: firstElicit.id,
        result: {
          action: "accept",
          content: { name: "First" }
        }
      } as unknown as JSONRPCMessage;
      await sendPostRequest(ctx, baseUrl, firstElicitResponse, sessionId);

      const firstToolResultFrame = await readOneFrame(firstReader);
      const firstToolResult = parseSSEData(
        firstToolResultFrame
      ) as JSONRPCResultResponse;
      expect(firstToolResult.id).toBe("custom-elicit-concurrent-1");
      expect((firstToolResult.result as CallToolResult).content).toEqual([
        { type: "text", text: "Custom elicit: First" }
      ]);
    });

    it("should handle elicitation cancel response", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);
      const standaloneReader = await openStandaloneSSE(ctx, sessionId, baseUrl);

      const toolCallMsg: JSONRPCMessage = {
        id: "custom-cancel-1",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "elicitNameCustom", arguments: {} }
      };

      const toolResponsePromise = sendPostRequest(
        ctx,
        baseUrl,
        toolCallMsg,
        sessionId
      );

      const elicitFrame = await readOneFrame(standaloneReader);
      const elicitRequest = parseSSEData(elicitFrame) as JSONRPCRequest;

      // Send cancel
      const cancelResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: elicitRequest.id,
        result: {
          action: "cancel",
          content: {}
        }
      } as unknown as JSONRPCMessage;

      await sendPostRequest(ctx, baseUrl, cancelResponse, sessionId);

      const toolResponse = await toolResponsePromise;
      expect(toolResponse.status).toBe(200);
      const toolSseText = await readSSEEvent(toolResponse);
      const toolResult = parseSSEData(toolSseText) as JSONRPCResultResponse;

      expect(toolResult.id).toBe("custom-cancel-1");
      const result = toolResult.result as CallToolResult;
      expect(result.content).toEqual([
        { type: "text", text: "Custom elicit cancelled" }
      ]);

      await standaloneReader.cancel();
    });

    it("should handle elicitation error response", async () => {
      const ctx = createExecutionContext();
      const sessionId = await initializeStreamableHTTPServer(ctx);
      const standaloneReader = await openStandaloneSSE(ctx, sessionId, baseUrl);

      const toolCallMsg: JSONRPCMessage = {
        id: "custom-error-1",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "elicitNameCustom", arguments: {} }
      };

      const toolResponsePromise = sendPostRequest(
        ctx,
        baseUrl,
        toolCallMsg,
        sessionId
      );

      const elicitFrame = await readOneFrame(standaloneReader);
      const elicitRequest = parseSSEData(elicitFrame) as JSONRPCRequest;

      // Send JSON-RPC error response — our code converts this to cancel
      const errorResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: elicitRequest.id,
        error: {
          code: -32000,
          message: "User declined"
        }
      } as unknown as JSONRPCMessage;

      await sendPostRequest(ctx, baseUrl, errorResponse, sessionId);

      const toolResponse = await toolResponsePromise;
      expect(toolResponse.status).toBe(200);
      const toolSseText = await readSSEEvent(toolResponse);
      const toolResult = parseSSEData(toolSseText) as JSONRPCResultResponse;

      expect(toolResult.id).toBe("custom-error-1");
      const result = toolResult.result as CallToolResult;
      // Error maps to cancel with error content
      expect(result.content).toEqual([
        { type: "text", text: "Custom elicit cancelled" }
      ]);

      await standaloneReader.cancel();
    });
  });

  describe("SSE Transport", () => {
    it("should complete elicitation round-trip via SSE", async () => {
      const ctx = createExecutionContext();
      const { sessionId, reader } = await establishSSEConnection(ctx);

      // Call the custom elicitation tool
      const toolCallMsg: JSONRPCMessage = {
        id: "custom-sse-1",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "elicitNameCustom", arguments: {} }
      };

      const toolRequest = new Request(
        `http://example.com/sse/message?sessionId=${sessionId}`,
        {
          body: JSON.stringify(toolCallMsg),
          headers: { "Content-Type": "application/json" },
          method: "POST"
        }
      );

      const toolPostResponse = await worker.fetch(toolRequest, env, ctx);
      expect(toolPostResponse.status).toBe(202);

      // Read the elicitation request from the SSE stream
      const { value: elicitValue } = await reader.read();
      const elicitText = new TextDecoder().decode(elicitValue);
      const elicitData = parseSSEFrame(elicitText) as JSONRPCRequest;

      expect(elicitData.method).toBe("elicitation/create");
      expect(String(elicitData.id).startsWith("elicit_")).toBe(true);

      // Send the elicitation response
      const elicitResponse: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: elicitData.id,
        result: {
          action: "accept",
          content: { name: "Bob" }
        }
      } as unknown as JSONRPCMessage;

      const responseRequest = new Request(
        `http://example.com/sse/message?sessionId=${sessionId}`,
        {
          body: JSON.stringify(elicitResponse),
          headers: { "Content-Type": "application/json" },
          method: "POST"
        }
      );

      const responsePostResult = await worker.fetch(responseRequest, env, ctx);
      expect(responsePostResult.status).toBe(202);

      // Read the tool result from the SSE stream
      const { value: resultValue } = await reader.read();
      const resultText = new TextDecoder().decode(resultValue);
      const resultData = parseSSEFrame(resultText) as JSONRPCResultResponse;

      expect(resultData.id).toBe("custom-sse-1");
      const result = resultData.result as CallToolResult;
      expect(result.content).toEqual([
        { type: "text", text: "Custom elicit: Bob" }
      ]);
    });
  });

  describe("RPC Transport", () => {
    it("should complete elicitation accept round-trip via RPC", async () => {
      const { connection } = await establishRPCConnection();

      // Override the elicitation handler to auto-accept with a name
      connection.handleElicitationRequest = async () => {
        return { action: "accept", content: { name: "Alice" } };
      };

      const result = await connection.client.callTool({
        name: "elicitNameCustom",
        arguments: {}
      });

      expect(result.content).toEqual([
        { type: "text", text: "Custom elicit: Alice" }
      ]);
    });

    it("should handle elicitation cancel response via RPC", async () => {
      const { connection } = await establishRPCConnection();

      connection.handleElicitationRequest = async () => {
        return { action: "cancel", content: {} };
      };

      const result = await connection.client.callTool({
        name: "elicitNameCustom",
        arguments: {}
      });

      expect(result.content).toEqual([
        { type: "text", text: "Custom elicit cancelled" }
      ]);
    });

    it("should handle elicitation decline response via RPC", async () => {
      const { connection } = await establishRPCConnection();

      connection.handleElicitationRequest = async () => {
        return { action: "decline", content: {} };
      };

      const result = await connection.client.callTool({
        name: "elicitNameCustom",
        arguments: {}
      });

      expect(result.content).toEqual([
        { type: "text", text: "Custom elicit cancelled" }
      ]);
    });
  });
});
