import { describe, it, expect, vi } from "vitest";
import { streamLoop } from "../stream-loop";

async function* tokenStream(tokens: string[], delayMs = 0) {
  for (const token of tokens) {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    yield token;
  }
}

describe("streamLoop", () => {
  it("posts an initial message and returns the accumulated text", async () => {
    const postInitial = vi.fn().mockResolvedValue("msg_1");
    const editMessage = vi.fn().mockResolvedValue(undefined);

    const result = await streamLoop(tokenStream(["Hello", " ", "world"]), {
      postInitial,
      editMessage
    });

    expect(postInitial).toHaveBeenCalledOnce();
    expect(result.id).toBe("msg_1");
    expect(result.text).toBe("Hello world");
  });

  it("calls editMessage with accumulated text", async () => {
    const edits: string[] = [];
    const result = await streamLoop(tokenStream(["a", "b", "c"]), {
      postInitial: async () => "id",
      editMessage: async (_id, text) => {
        edits.push(text);
      },
      updateIntervalMs: 0
    });

    expect(result.text).toBe("abc");
    expect(edits[edits.length - 1]).toBe("abc");
  });

  it("handles an empty stream with fallback text", async () => {
    const editMessage = vi.fn();
    const result = await streamLoop(tokenStream([]), {
      postInitial: async () => "id",
      editMessage
    });

    expect(result.id).toBe("id");
    expect(result.text).toBe("");
    expect(editMessage).toHaveBeenCalledWith("id", "(no response)");
  });

  it("swallows edit errors gracefully", async () => {
    const editMessage = vi
      .fn()
      .mockRejectedValue(new Error("content unchanged"));

    const result = await streamLoop(tokenStream(["hello"]), {
      postInitial: async () => "id",
      editMessage,
      updateIntervalMs: 0
    });

    expect(result.text).toBe("hello");
  });
});
