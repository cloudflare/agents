import { createExecutionContext } from "cloudflare:test";
import type {
  CallToolResult,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResultResponse
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  initializeStreamableHTTPServer,
  openStandaloneSSE,
  parseSSEData,
  sendPostRequest
} from "../shared/test-utils";

async function readOneFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<string> {
  const { value } = await reader.read();
  if (!value) throw new Error("SSE stream ended before a frame arrived");
  return new TextDecoder().decode(value);
}

/**
 * Regression tests for https://github.com/cloudflare/agents/issues/1490.
 *
 * Server-initiated MCP requests (elicitInput, createMessage, listRoots)
 * used to throw "Agent was not found in send" when issued from code with
 * no agent AsyncLocalStorage context on its call stack, such as a host-side
 * callback invoked via RPC from a Worker Loader child isolate. The test
 * tools simulate that by running `this.server.server.elicitInput(...)`
 * inside `agentContext.exit(...)`, which strips the store exactly like a
 * fresh entrypoint invocation does.
 */
describe("server-initiated sends outside the agent ALS context", () => {
  const baseUrl = "http://example.com/mcp";

  it("routes a request-scoped elicit (relatedRequestId) issued outside the context", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeStreamableHTTPServer(ctx);

    const toolCallMsg: JSONRPCMessage = {
      id: "outside-ctx-1",
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "elicitNameOutsideContext", arguments: {} }
    };

    const toolResponse = await sendPostRequest(
      ctx,
      baseUrl,
      toolCallMsg,
      sessionId
    );
    expect(toolResponse.status).toBe(200);

    const reader = toolResponse.body?.getReader();
    if (!reader) throw new Error("No reader available for POST stream");

    // Before the fix this frame never arrived: the transport threw
    // "Agent was not found in send" and the tool call errored out.
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

    expect(toolResult.id).toBe("outside-ctx-1");
    const result = toolResult.result as CallToolResult;
    expect(result.content).toEqual([
      { type: "text", text: "Outside-context elicit: Alice" }
    ]);
  });

  it("delivers a standalone elicit (no relatedRequestId) issued outside the context on the GET stream", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeStreamableHTTPServer(ctx);

    // Server-initiated requests without relatedRequestId go out on the
    // standalone GET stream (transport sendStandalone path).
    const standaloneReader = await openStandaloneSSE(ctx, sessionId, baseUrl);

    const toolCallMsg: JSONRPCMessage = {
      id: "outside-ctx-standalone-1",
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "elicitNameOutsideContextStandalone", arguments: {} }
    };

    const toolResponse = await sendPostRequest(
      ctx,
      baseUrl,
      toolCallMsg,
      sessionId
    );
    expect(toolResponse.status).toBe(200);

    const postReader = toolResponse.body?.getReader();
    if (!postReader) throw new Error("No reader available for POST stream");

    const elicitFrame = await readOneFrame(standaloneReader);
    const elicitRequest = parseSSEData(elicitFrame) as JSONRPCRequest;
    expect(elicitRequest.method).toBe("elicitation/create");

    const elicitResponse: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: elicitRequest.id,
      result: {
        action: "accept",
        content: { name: "Bob" }
      }
    } as unknown as JSONRPCMessage;

    const responsePost = await sendPostRequest(
      ctx,
      baseUrl,
      elicitResponse,
      sessionId
    );
    expect(responsePost.status).toBe(202);

    const toolResultFrame = await readOneFrame(postReader);
    const toolResult = parseSSEData(toolResultFrame) as JSONRPCResultResponse;

    expect(toolResult.id).toBe("outside-ctx-standalone-1");
    const result = toolResult.result as CallToolResult;
    expect(result.content).toEqual([
      { type: "text", text: "Standalone outside-context elicit: Bob" }
    ]);

    await standaloneReader.cancel();
  });
});
