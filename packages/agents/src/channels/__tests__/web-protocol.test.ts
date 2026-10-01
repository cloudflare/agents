import { describe, expect, it } from "vitest";
import { normalizeWebChatRequest } from "../adapters/web-protocol";

describe("normalizeWebChatRequest", () => {
  it("normalizes the latest user message from an AI SDK request", () => {
    expect(
      normalizeWebChatRequest({
        model: "example",
        messages: [
          {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text: "First" }]
          },
          {
            id: "assistant-1",
            role: "assistant",
            parts: [{ type: "text", text: "Answer" }]
          },
          {
            id: "user-2",
            role: "user",
            parts: [
              { type: "text", text: "Hello " },
              { type: "file", url: "https://example.com/file" },
              { type: "text", text: "world" }
            ]
          }
        ]
      })
    ).toMatchObject({
      message: { id: "user-2", text: "Hello world" },
      body: { model: "example" }
    });
  });

  it("normalizes client tool schemas without retaining AI SDK field names", () => {
    expect(
      normalizeWebChatRequest({
        messages: [
          {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text: "Use the browser" }]
          }
        ],
        clientTools: [
          {
            name: "describeBrowser",
            description: "Describe this browser",
            parameters: {
              type: "object",
              properties: { prompt: { type: "string" } },
              required: ["prompt"]
            }
          },
          { name: "invalid-schema", parameters: "not-json-schema" },
          { description: "missing name" }
        ]
      })
    ).toMatchObject({
      message: {
        clientTools: [
          {
            name: "describeBrowser",
            description: "Describe this browser",
            inputSchema: {
              type: "object",
              properties: { prompt: { type: "string" } },
              required: ["prompt"]
            }
          },
          { name: "invalid-schema" }
        ]
      }
    });
  });

  it("normalizes legacy string content", () => {
    expect(
      normalizeWebChatRequest({
        messages: [{ id: "user-1", role: "user", content: "Hello" }]
      })
    ).toMatchObject({ message: { id: "user-1", text: "Hello" } });
  });

  it("rejects bodies without a user message", () => {
    expect(normalizeWebChatRequest({ messages: [] })).toBeNull();
  });

  it("rejects user messages without an id", () => {
    expect(
      normalizeWebChatRequest({
        messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }]
      })
    ).toBeNull();
  });
});
