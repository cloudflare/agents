import { describe, expect, it } from "vitest";
import {
  dropLargeFileParts,
  evictToolOutputStrings
} from "../../sessions/eviction";
import type { SessionMessage } from "../../sessions/types";

function message(output: unknown): SessionMessage {
  return {
    id: "message",
    role: "assistant",
    parts: [
      {
        type: "tool-browser",
        toolName: "browser",
        toolCallId: "call-1",
        state: "output-available",
        input: {},
        output
      }
    ]
  };
}

describe("aged tool-output eviction", () => {
  it("preserves object and array shape while replacing large strings", async () => {
    const original = message({
      note: "small",
      frames: [{ image: "x".repeat(1000) }, { image: "small" }]
    });
    const stored: string[] = [];

    const result = await evictToolOutputStrings(
      original,
      1000,
      async (value, mediaType) => {
        stored.push(value);
        return {
          hash: "ab".repeat(32),
          path: "/attachments/sha256/ab",
          mediaType,
          bytes: value.length
        };
      }
    );

    expect(result).toMatchObject({ changed: true, parts: 1, bytes: 1000 });
    expect(stored).toEqual(["x".repeat(1000)]);
    const output = result.message.parts[0].output as {
      note: string;
      frames: Array<{ image: string }>;
    };
    expect(output.note).toBe("small");
    expect(output.frames[0].image).toContain("attachment:sha256:");
    expect(output.frames[1].image).toBe("small");
    expect(original.parts[0].output).toEqual({
      note: "small",
      frames: [{ image: "x".repeat(1000) }, { image: "small" }]
    });
  });

  it("handles dynamic tool parts and data URL media types", async () => {
    const original = message("unused");
    original.parts[0] = {
      ...original.parts[0],
      type: "dynamic-tool",
      output: { image: `data:image/png;base64,${"A".repeat(1000)}` }
    };
    const mediaTypes: string[] = [];

    const result = await evictToolOutputStrings(
      original,
      1000,
      async (value, mediaType) => {
        mediaTypes.push(mediaType);
        return {
          hash: "cd".repeat(32),
          path: "/attachments/sha256/cd",
          mediaType,
          bytes: value.length
        };
      }
    );

    expect(result.changed).toBe(true);
    expect(mediaTypes).toEqual(["image/png"]);
  });

  it("does not touch plain text parts or small tool values", async () => {
    const original: SessionMessage = {
      id: "small",
      role: "assistant",
      parts: [
        { type: "text", text: "x".repeat(2000) },
        {
          type: "tool-read",
          output: { value: "small" }
        }
      ]
    };

    const result = await evictToolOutputStrings(original, 1000, async () => {
      throw new Error("unexpected write");
    });

    expect(result.changed).toBe(false);
    expect(result.message).toBe(original);
  });

  it("drops file and tool payloads without writing when preservation is off", async () => {
    const fileMessage: SessionMessage = {
      id: "file",
      role: "user",
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          url: `data:image/png;base64,${"A".repeat(1000)}`
        }
      ]
    };
    const fileResult = dropLargeFileParts(fileMessage, 1000);
    expect(fileResult).toMatchObject({ changed: true, parts: 1 });
    expect(fileResult.message.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("[evicted image/png")
    });
    expect(fileResult.attachments).toEqual([]);

    const toolResult = await evictToolOutputStrings(
      message({ value: "x".repeat(1000) }),
      1000,
      null
    );
    expect(toolResult).toMatchObject({ changed: true, parts: 1 });
    expect(toolResult.attachments).toEqual([]);
    expect(JSON.stringify(toolResult.message)).not.toContain("preserved at");
  });

  it("stops at the nesting limit", async () => {
    let output: Record<string, unknown> = { value: "x".repeat(1000) };
    for (let index = 0; index < 10; index++) output = { nested: output };

    const original = message(output);
    const result = await evictToolOutputStrings(original, 1000, async () => {
      throw new Error("unexpected write");
    });

    expect(result.changed).toBe(false);
  });
});
