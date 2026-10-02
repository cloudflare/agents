import { describe, expect, it } from "vitest";
import { applyChunks } from "../apply-chunks";

describe("applyChunks", () => {
  it("keeps provider metadata from a part's start and end", () => {
    const message = applyChunks({ id: "m1", role: "assistant", parts: [] }, [
      { type: "reasoning-start", id: "r", providerMetadata: { a: 1 } },
      { type: "reasoning-delta", id: "r", delta: "thinking" },
      { type: "reasoning-end", id: "r", providerMetadata: { b: 2 } },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Hi" },
      { type: "text-end", id: "t" }
    ]);
    expect(message.parts).toEqual([
      { type: "reasoning", text: "thinking", providerMetadata: { a: 1, b: 2 } },
      { type: "text", text: "Hi" }
    ]);
  });
});
