import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import type {
  CallToolResult,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResultResponse
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { TestCodemodeMcpAgent } from "../agents/mcp";
import {
  initializeStreamableHTTPServer,
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

async function getKeepAliveRefs(sessionId: string): Promise<number> {
  const id = env.TestCodemodeMcpAgent.idFromName(
    `streamable-http:${sessionId}`
  );
  const stub = env.TestCodemodeMcpAgent.get(id);
  return runInDurableObject(stub, (instance: TestCodemodeMcpAgent) => {
    return (
      instance as unknown as {
        _keepAliveRefs: number;
      }
    )._keepAliveRefs;
  });
}

describe("Codemode MCP request context", () => {
  const baseUrl = "http://example.com/codemode-mcp";

  it("completes an elicitation over the originating POST after Worker Loader RPC", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeStreamableHTTPServer(ctx, baseUrl);

    const toolCall: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: "codemode-call-1",
      method: "tools/call",
      params: {
        name: "execute",
        arguments: {
          code: `async () => codemode.request({
            method: "DELETE",
            path: "/protected"
          })`
        }
      }
    };

    const toolResponse = await sendPostRequest(
      ctx,
      baseUrl,
      toolCall,
      sessionId
    );
    expect(toolResponse.status).toBe(200);

    const reader = toolResponse.body?.getReader();
    if (!reader) throw new Error("No reader available for POST stream");

    const elicitRequest = parseSSEData(
      await readOneFrame(reader)
    ) as JSONRPCRequest;
    expect(elicitRequest).toMatchObject({
      method: "elicitation/create",
      params: { message: "Allow DELETE /protected?" }
    });

    // McpAgent.elicitInput holds a keepAlive lease while its in-memory
    // response resolver is pending. Without it, an unresolved Promise alone
    // would not prevent the Durable Object from hibernating.
    expect(await getKeepAliveRefs(sessionId)).toBe(1);

    const elicitResponse: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: elicitRequest.id,
      result: { action: "accept", content: { approved: true } }
    } as JSONRPCMessage;
    const response = await sendPostRequest(
      ctx,
      baseUrl,
      elicitResponse,
      sessionId
    );
    expect(response.status).toBe(202);

    const toolResult = parseSSEData(
      await readOneFrame(reader)
    ) as JSONRPCResultResponse;
    expect(toolResult.id).toBe("codemode-call-1");
    expect(toolResult.result as CallToolResult).toMatchObject({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { action: "accept", content: { approved: true } },
            null,
            2
          )
        }
      ]
    });

    await vi.waitFor(async () => {
      expect(await getKeepAliveRefs(sessionId)).toBe(0);
    });
  });
});
