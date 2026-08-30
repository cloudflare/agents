import { describe, expect, it } from "vitest";
import {
  normalizeWebChatRequest,
  WebChatChunkEncoder
} from "../adapters/web-protocol";

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

  it("rejects bodies without a user message", () => {
    expect(normalizeWebChatRequest({ messages: [] })).toBeNull();
  });
});

describe("WebChatChunkEncoder", () => {
  it("projects text, reasoning, and sources into AI SDK UI chunks", () => {
    const encoder = new WebChatChunkEncoder("turn-1");

    expect([
      ...encoder.push({ type: "reasoning", text: "Think" }),
      ...encoder.push({ type: "reasoning", text: "ing" }),
      ...encoder.push({
        type: "tool",
        name: "search",
        status: "completed"
      }),
      ...encoder.push({ type: "text", text: "Answer" }),
      ...encoder.push({
        type: "source",
        url: "https://example.com",
        title: "Example"
      }),
      ...encoder.finishPart()
    ]).toEqual([
      { type: "reasoning-start", id: "turn-1:reasoning:1" },
      {
        type: "reasoning-delta",
        id: "turn-1:reasoning:1",
        delta: "Think"
      },
      {
        type: "reasoning-delta",
        id: "turn-1:reasoning:1",
        delta: "ing"
      },
      { type: "reasoning-end", id: "turn-1:reasoning:1" },
      { type: "text-start", id: "turn-1:text:2" },
      { type: "text-delta", id: "turn-1:text:2", delta: "Answer" },
      { type: "text-end", id: "turn-1:text:2" },
      {
        type: "source-url",
        sourceId: "turn-1:source:1",
        url: "https://example.com",
        title: "Example"
      }
    ]);
  });
});
