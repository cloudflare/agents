import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  CallToolResult,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResultResponse
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { CodemodeMcp } from "../index";

const MCP_URL = "http://example.com/mcp";

function requestHeaders(sessionId?: string): Record<string, string> {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...(sessionId ? { "mcp-session-id": sessionId } : {})
  };
}

async function post(
  message: JSONRPCMessage,
  sessionId?: string
): Promise<Response> {
  return exports.default.fetch(
    new Request(MCP_URL, {
      method: "POST",
      headers: requestHeaders(sessionId),
      body: JSON.stringify(message)
    })
  );
}

async function initialize(
  capabilities: Record<string, unknown> = { elicitation: { form: {} } }
): Promise<string> {
  const response = await post({
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: {
      capabilities,
      clientInfo: { name: "example-test", version: "1.0.0" },
      protocolVersion: "2025-11-25"
    }
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  return sessionId as string;
}

function parseSse(chunk: Uint8Array): JSONRPCMessage {
  const text = new TextDecoder().decode(chunk);
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice(5);
  if (!data) throw new Error(`No MCP data frame in: ${text}`);
  return JSON.parse(data) as JSONRPCMessage;
}

async function readMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<JSONRPCMessage> {
  const { done, value } = await reader.read();
  if (done || !value) throw new Error("MCP response stream ended early");
  return parseSse(value);
}

function callTool(
  sessionId: string,
  id: string,
  name: string,
  args: Record<string, unknown>
): Promise<Response> {
  return post(
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args }
    },
    sessionId
  );
}

function toolJson(message: JSONRPCMessage): Record<string, unknown> {
  const result = (message as JSONRPCResultResponse).result as CallToolResult;
  const text = result.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") throw new Error("Missing text result");
  return JSON.parse(text.text) as Record<string, unknown>;
}

async function state(sessionId: string) {
  const id = env.CodemodeMcp.idFromName(sessionId);
  const stub = env.CodemodeMcp.get(id);
  return runInDurableObject(stub, (instance: CodemodeMcp) => instance.state);
}

describe("durable Code Mode MCP approvals", () => {
  it("searches operation-level permissions", async () => {
    const sessionId = await initialize();
    const response = await callTool(sessionId, "search-1", "search", {
      query: "create issue"
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response stream");

    expect(toolJson(await readMessage(reader))).toMatchObject({
      results: [
        {
          path: "work.create_issue",
          requiresApproval: true,
          kind: "method"
        }
      ]
    });
  });

  it("allows comments without elicitation", async () => {
    const sessionId = await initialize();
    const response = await callTool(sessionId, "comment-1", "execute", {
      code: `async () => {
        await work.comment_on_issue({ issueId: "ISSUE-1", body: "Looks good" });
        return await work.list_issues({});
      }`
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response stream");

    const result = toolJson(await readMessage(reader));
    expect(result).toMatchObject({
      status: "completed",
      calls: [
        expect.objectContaining({
          method: "comment_on_issue",
          requiresApproval: false,
          state: "applied"
        }),
        expect.objectContaining({
          method: "list_issues",
          state: "applied"
        })
      ]
    });
    expect(JSON.stringify(result)).toContain("Looks good");
    expect((await state(sessionId)).issues[0].comments).toEqual([
      { body: "Looks good" }
    ]);
  });

  it("elicits before a protected action, then resumes it exactly once", async () => {
    const sessionId = await initialize();
    const response = await callTool(sessionId, "create-1", "execute", {
      code: `async () => {
        await work.comment_on_issue({ issueId: "ISSUE-1", body: "Allowed before approval" });
        return await work.create_issue({ title: "Approved issue" });
      }`
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response stream");

    const elicitation = (await readMessage(reader)) as JSONRPCRequest;
    expect(elicitation).toMatchObject({
      method: "elicitation/create",
      params: {
        mode: "form",
        message: expect.stringContaining("work.create_issue")
      }
    });
    expect((await state(sessionId)).issues).toEqual([
      expect.objectContaining({
        id: "ISSUE-1",
        comments: [{ body: "Allowed before approval" }]
      })
    ]);

    const accepted = await post(
      {
        jsonrpc: "2.0",
        id: elicitation.id,
        result: { action: "accept", content: { approved: true } }
      } as JSONRPCMessage,
      sessionId
    );
    expect(accepted.status).toBe(202);

    const result = toolJson(await readMessage(reader));
    expect(result).toMatchObject({
      status: "completed",
      calls: [
        expect.objectContaining({
          method: "comment_on_issue",
          requiresApproval: false,
          state: "applied"
        }),
        expect.objectContaining({
          method: "create_issue",
          requiresApproval: true,
          state: "applied"
        })
      ]
    });
    expect((await state(sessionId)).issues).toEqual([
      expect.objectContaining({
        id: "ISSUE-1",
        comments: [{ body: "Allowed before approval" }]
      }),
      expect.objectContaining({ id: "ISSUE-2", title: "Approved issue" })
    ]);
  });

  it("elicits separately for sequential protected actions", async () => {
    const sessionId = await initialize();
    const response = await callTool(sessionId, "create-sequence", "execute", {
      code: `async () => {
        const issue = await work.create_issue({ title: "First approval" });
        const mergeRequest = await work.create_merge_request({ title: "Second approval" });
        return { issue, mergeRequest };
      }`
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response stream");

    const first = (await readMessage(reader)) as JSONRPCRequest;
    expect(first.params).toMatchObject({
      message: expect.stringContaining("work.create_issue")
    });
    await post(
      {
        jsonrpc: "2.0",
        id: first.id,
        result: { action: "accept", content: { approved: true } }
      } as JSONRPCMessage,
      sessionId
    );

    const second = (await readMessage(reader)) as JSONRPCRequest;
    expect(second.params).toMatchObject({
      message: expect.stringContaining("work.create_merge_request")
    });
    expect((await state(sessionId)).issues).toHaveLength(2);
    expect((await state(sessionId)).mergeRequests).toHaveLength(1);

    await post(
      {
        jsonrpc: "2.0",
        id: second.id,
        result: { action: "accept", content: { approved: true } }
      } as JSONRPCMessage,
      sessionId
    );

    expect(toolJson(await readMessage(reader))).toMatchObject({
      status: "completed"
    });
    expect((await state(sessionId)).issues).toHaveLength(2);
    expect((await state(sessionId)).mergeRequests).toHaveLength(2);
  });

  it("rejects a declined action without applying it", async () => {
    const sessionId = await initialize();
    const response = await callTool(sessionId, "create-2", "execute", {
      code: `async () => await work.create_merge_request({ title: "No thanks" })`
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response stream");

    const elicitation = (await readMessage(reader)) as JSONRPCRequest;
    const declined = await post(
      {
        jsonrpc: "2.0",
        id: elicitation.id,
        result: { action: "decline" }
      } as JSONRPCMessage,
      sessionId
    );
    expect(declined.status).toBe(202);

    expect(toolJson(await readMessage(reader))).toMatchObject({
      status: "rejected",
      action: "decline",
      calls: [
        expect.objectContaining({
          method: "create_merge_request",
          requiresApproval: true,
          state: "pending"
        })
      ]
    });
    expect((await state(sessionId)).mergeRequests).toHaveLength(1);
  });

  it("fails closed when the client cannot elicit", async () => {
    const sessionId = await initialize({});
    const response = await callTool(sessionId, "create-3", "execute", {
      code: `async () => await work.create_issue({ title: "Must not exist" })`
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response stream");

    expect(toolJson(await readMessage(reader))).toMatchObject({
      status: "error",
      error: expect.stringContaining("did not advertise form-mode elicitation")
    });
    expect((await state(sessionId)).issues).toHaveLength(1);
  });
});
