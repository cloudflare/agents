import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../messages/model.js";
import { applyOverlays, planCompaction, type CompactionConfig, type Overlay } from "./compaction.js";

function msg(id: string, text: string): ChatMessage {
  return { id, role: id.startsWith("u") ? "user" : "assistant", parts: [{ type: "text", text }] };
}

function toolMsg(id: string, state: "input-available" | "output-available", extra?: Partial<ChatMessage>): ChatMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-search",
        toolCallId: `call_${id}`,
        state,
        input: { q: "x" },
        ...(state === "output-available" ? { output: "result" } : {}),
      },
    ],
    ...extra,
  };
}

const baseConfig: CompactionConfig = {
  summarize: async () => "summary",
};

describe("planCompaction", () => {
  it("returns null when there are too few messages to compact", () => {
    const messages = [msg("u1", "hi"), msg("a1", "hello"), msg("u2", "bye")];
    expect(planCompaction(messages, { ...baseConfig, protectHead: 3, minTailMessages: 2 })).toBeNull();
  });

  it("protects the head: never includes the first protectHead messages in the plan", () => {
    const messages = Array.from({ length: 20 }, (_, i) => msg(`m${i}`, `text ${i} `.repeat(50)));
    const plan = planCompaction(messages, { ...baseConfig, protectHead: 3, tailTokenBudget: 1, minTailMessages: 2 });
    expect(plan).not.toBeNull();
    expect(plan!.from).toBe(3);
  });

  it("protects at least minTailMessages regardless of token budget", () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, "x".repeat(1000)));
    const plan = planCompaction(messages, {
      ...baseConfig,
      protectHead: 1,
      tailTokenBudget: 1, // tiny budget: only the floor should be protected
      minTailMessages: 3,
    });
    expect(plan).not.toBeNull();
    // Middle range is [from, to); tail is everything from `to` onward.
    expect(messages.length - plan!.to).toBe(3);
  });

  it("extends the tail further back while messages fit within tailTokenBudget", () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, "a".repeat(40))); // ~10 tokens each
    const plan = planCompaction(messages, {
      ...baseConfig,
      protectHead: 1,
      tailTokenBudget: 25, // fits about 2 messages worth beyond the floor
      minTailMessages: 1,
    });
    expect(plan).not.toBeNull();
    const tailCount = messages.length - plan!.to;
    expect(tailCount).toBeGreaterThan(1);
  });

  it("returns null when nothing is left to compact after protecting head and tail", () => {
    const messages = [msg("u1", "hi"), msg("a1", "hello"), msg("u2", "bye"), msg("a2", "later")];
    const plan = planCompaction(messages, { ...baseConfig, protectHead: 2, minTailMessages: 2 });
    expect(plan).toBeNull();
  });

  it("never leaves an unsettled tool call inside the compacted middle (tool-pair alignment)", () => {
    const messages = [
      msg("u0", "start"),
      msg("a0", "ok"),
      msg("m2", "pad".repeat(50)),
      toolMsg("m3", "input-available"), // unsettled tool call, would fall right at boundary
      msg("m4", "pad".repeat(50)),
      msg("m5", "pad".repeat(50)),
    ];
    const plan = planCompaction(messages, {
      ...baseConfig,
      protectHead: 2,
      tailTokenBudget: 30, // small budget so boundary would normally land right after m3
      minTailMessages: 1,
    });
    expect(plan).not.toBeNull();
    // The unsettled tool message (index 3) must not be part of the compacted
    // middle [from, to) — it must be pushed into the protected tail.
    expect(plan!.to).toBeLessThanOrEqual(3);
  });

  it("does not protect settled tool calls beyond normal budget rules", () => {
    const messages = [
      msg("u0", "start"),
      msg("a0", "ok"),
      toolMsg("m2", "output-available"),
      msg("m3", "pad".repeat(50)),
      msg("m4", "pad".repeat(50)),
    ];
    const plan = planCompaction(messages, {
      ...baseConfig,
      protectHead: 2,
      tailTokenBudget: 1,
      minTailMessages: 1,
    });
    expect(plan).not.toBeNull();
    expect(plan!.from).toBe(2);
  });

  it("respects a custom tokenCounter", () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, "short"));
    let calls = 0;
    const plan = planCompaction(messages, {
      ...baseConfig,
      protectHead: 1,
      minTailMessages: 1,
      tailTokenBudget: 100,
      tokenCounter: (msgs) => {
        calls++;
        return msgs.length * 1000; // force budget exhaustion immediately
      },
    });
    expect(calls).toBeGreaterThan(0);
    expect(plan).not.toBeNull();
    expect(messages.length - plan!.to).toBe(1); // only the floor protected
  });
});

describe("applyOverlays", () => {
  const messages = [msg("m0", "a"), msg("m1", "b"), msg("m2", "c"), msg("m3", "d"), msg("m4", "e")];

  it("returns messages unchanged when there are no overlays", () => {
    expect(applyOverlays(messages, [])).toEqual(messages);
  });

  it("replaces a range with a single synthetic assistant summary message", () => {
    const overlay: Overlay = { id: "c1", fromMessageId: "m1", toMessageId: "m2", summary: "b and c happened" };
    const result = applyOverlays(messages, [overlay]);
    expect(result.map((m) => m.id)).toEqual(["m0", "compaction_c1", "m3", "m4"]);
    const synthetic = result[1]!;
    expect(synthetic.role).toBe("assistant");
    expect(synthetic.parts).toEqual([{ type: "text", text: "b and c happened" }]);
  });

  it("applies multiple non-overlapping overlays", () => {
    const overlays: Overlay[] = [
      { id: "c1", fromMessageId: "m0", toMessageId: "m0", summary: "first" },
      { id: "c2", fromMessageId: "m3", toMessageId: "m4", summary: "last two" },
    ];
    const result = applyOverlays(messages, overlays);
    expect(result.map((m) => m.id)).toEqual(["compaction_c1", "m1", "m2", "compaction_c2"]);
  });

  it("later overlays supersede earlier ones on overlap", () => {
    const overlays: Overlay[] = [
      { id: "old", fromMessageId: "m0", toMessageId: "m2", summary: "old summary" },
      { id: "new", fromMessageId: "m1", toMessageId: "m3", summary: "new summary" },
    ];
    const result = applyOverlays(messages, overlays);
    // "new" wins for the overlapping range; "old" is dropped entirely since
    // its range intersects "new"'s range.
    expect(result.map((m) => m.id)).toEqual(["m0", "compaction_new", "m4"]);
    expect(result[1]!.parts).toEqual([{ type: "text", text: "new summary" }]);
  });

  it("skips an overlay whose message ids are no longer present", () => {
    const overlay: Overlay = { id: "gone", fromMessageId: "missing1", toMessageId: "missing2", summary: "x" };
    expect(applyOverlays(messages, [overlay])).toEqual(messages);
  });
});
