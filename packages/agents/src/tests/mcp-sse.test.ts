import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker, { type Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("test", () => {
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
