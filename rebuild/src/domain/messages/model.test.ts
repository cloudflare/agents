import { describe, expect, it } from "vitest";
import {
  assistantMessage,
  isToolPart,
  textOf,
  toModelMessages,
  toolName,
  userMessage,
  type ChatMessage,
  type ToolPart,
} from "./model.js";

describe("userMessage / assistantMessage constructors", () => {
  it("userMessage builds a user ChatMessage with a single text part", () => {
    const msg = userMessage("hi there");
    expect(msg.role).toBe("user");
    expect(msg.parts).toEqual([{ type: "text", text: "hi there" }]);
    expect(typeof msg.id).toBe("string");
  });

  it("userMessage accepts an explicit id", () => {
    const msg = userMessage("hi", "msg_1");
    expect(msg.id).toBe("msg_1");
  });

  it("assistantMessage builds an assistant ChatMessage from parts", () => {
    const msg = assistantMessage([{ type: "text", text: "hello" }]);
    expect(msg.role).toBe("assistant");
    expect(msg.parts).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("textOf", () => {
  it("concatenates text parts", () => {
    const msg = assistantMessage([
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ]);
    expect(textOf(msg)).toBe("hello world");
  });

  it("ignores non-text parts", () => {
    const part: ToolPart = {
      type: "tool-search",
      toolCallId: "call_1",
      state: "output-available",
      output: { ok: true },
    };
    const msg = assistantMessage([{ type: "text", text: "hi" }, part]);
    expect(textOf(msg)).toBe("hi");
  });

  it("returns an empty string when there are no text parts", () => {
    expect(textOf(assistantMessage([]))).toBe("");
  });
});

describe("isToolPart / toolName", () => {
  it("isToolPart recognizes tool-* parts", () => {
    const part: ToolPart = {
      type: "tool-search",
      toolCallId: "call_1",
      state: "output-available",
      output: {},
    };
    expect(isToolPart(part)).toBe(true);
    expect(isToolPart({ type: "text", text: "hi" })).toBe(false);
  });

  it("toolName strips the tool- prefix", () => {
    const part: ToolPart = {
      type: "tool-search",
      toolCallId: "call_1",
      state: "output-available",
      output: {},
    };
    expect(toolName(part)).toBe("search");
  });
});

describe("toModelMessages", () => {
  it("converts a system message", () => {
    const messages: ChatMessage[] = [
      { id: "1", role: "system", parts: [{ type: "text", text: "be nice" }] },
    ];
    expect(toModelMessages(messages)).toEqual([{ role: "system", content: "be nice" }]);
  });

  it("converts a plain user text message", () => {
    const messages: ChatMessage[] = [userMessage("hello")];
    expect(toModelMessages(messages)).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("flows file parts into user content", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        role: "user",
        parts: [{ type: "file", mediaType: "image/png", data: "base64data" }],
      },
    ];
    expect(toModelMessages(messages)).toEqual([
      {
        role: "user",
        content: [{ type: "file", mediaType: "image/png", data: "base64data" }],
      },
    ]);
  });

  it("drops reasoning parts", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking..." },
          { type: "text", text: "the answer" },
        ],
      },
    ];
    const result = toModelMessages(messages);
    expect(result).toEqual([
      { role: "assistant", content: [{ type: "text", text: "the answer" }] },
    ]);
  });

  it("expands a settled tool call/result pair into assistant + tool messages", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [
          { type: "text", text: "let me check" },
          {
            type: "tool-search",
            toolCallId: "call_1",
            state: "output-available",
            input: { query: "weather" },
            output: { temp: 70 },
          },
        ],
      },
    ];
    const result = toModelMessages(messages);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool-call", toolCallId: "call_1", toolName: "search", input: { query: "weather" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_1", toolName: "search", output: { temp: 70 } },
        ],
      },
    ]);
  });

  it("marks output-error tool results as isError with errorText as output", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [
          {
            type: "tool-search",
            toolCallId: "call_1",
            state: "output-error",
            input: {},
            errorText: "boom",
          },
        ],
      },
    ];
    const result = toModelMessages(messages);
    expect(result[1]).toEqual({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_1", toolName: "search", output: "boom", isError: true },
      ],
    });
  });

  it("excludes tool parts still awaiting input or approval from model messages", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [
          { type: "text", text: "hold on" },
          { type: "tool-search", toolCallId: "call_1", state: "input-streaming", input: {} },
          { type: "tool-search", toolCallId: "call_2", state: "approval-requested", input: {} },
        ],
      },
    ];
    const result = toModelMessages(messages);
    expect(result).toEqual([
      { role: "assistant", content: [{ type: "text", text: "hold on" }] },
    ]);
  });

  it("omits empty messages with no convertible parts", () => {
    const messages: ChatMessage[] = [
      { id: "1", role: "assistant", parts: [{ type: "reasoning", text: "thinking" }] },
      userMessage("hi"),
    ];
    const result = toModelMessages(messages);
    expect(result).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("round-trips a full turn: user message, tool call, tool result, final text", () => {
    const messages: ChatMessage[] = [
      userMessage("what's the weather?"),
      {
        id: "2",
        role: "assistant",
        parts: [
          {
            type: "tool-weather",
            toolCallId: "call_1",
            state: "output-available",
            input: { city: "nyc" },
            output: { temp: 72 },
          },
        ],
      },
      assistantMessage([{ type: "text", text: "It's 72 degrees." }], "3"),
    ];
    const result = toModelMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ role: "user", content: [{ type: "text", text: "what's the weather?" }] });
    expect(result[1]).toMatchObject({ role: "assistant" });
    expect(result[2]).toMatchObject({ role: "tool" });
    expect(result[3]).toEqual({ role: "assistant", content: [{ type: "text", text: "It's 72 degrees." }] });
  });
});
