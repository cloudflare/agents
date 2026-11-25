import { describe, expect, it } from "vitest";
import {
  applyChunkToParts,
  settleInterruptedPart,
  type MessagePart
} from "../message-builder";

describe("settleInterruptedPart", () => {
  it("closes a text or reasoning part left streaming", () => {
    expect(
      settleInterruptedPart({
        type: "text",
        text: "Partial",
        state: "streaming"
      })
    ).toEqual({ type: "text", text: "Partial", state: "done" });
    expect(
      settleInterruptedPart({
        type: "reasoning",
        text: "Hm",
        state: "streaming"
      })
    ).toEqual({ type: "reasoning", text: "Hm", state: "done" });
  });

  it("returns any other part as it is", () => {
    const done: MessagePart = { type: "text", text: "Done", state: "done" };
    const noState: MessagePart = { type: "text", text: "Plain" };
    const step: MessagePart = { type: "step-start" };
    expect(settleInterruptedPart(done)).toBe(done);
    expect(settleInterruptedPart(noState)).toBe(noState);
    expect(settleInterruptedPart(step)).toBe(step);
  });

  it("keeps a continuation's reasoning and text after the cut-off text", () => {
    const parts: MessagePart[] = [
      { type: "text", text: "Partial ", state: "streaming" } as MessagePart
    ].map(settleInterruptedPart);
    for (const chunk of [
      { type: "start-step" },
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "Thinking." },
      { type: "reasoning-end", id: "r" },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Answer." },
      { type: "text-end", id: "t" }
    ]) {
      applyChunkToParts(parts, chunk);
    }

    expect(
      parts.map((part) => [part.type, (part as { text?: string }).text])
    ).toEqual([
      ["text", "Partial "],
      ["step-start", undefined],
      ["reasoning", "Thinking."],
      ["text", "Answer."]
    ]);
    // Every part is closed, the cut-off one included.
    expect(
      parts
        .filter((part) => part.type !== "step-start")
        .every((part) => (part as { state?: string }).state === "done")
    ).toBe(true);
  });
});
