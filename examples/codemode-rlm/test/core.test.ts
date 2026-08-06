import { describe, expect, it } from "vitest";
import {
  INPUT_CHUNK_CHARS,
  applyHarnessUpdate,
  buildHarnessOverview,
  emptyHarnessState,
  inputSource,
  normalizeHarnessUpdate,
  splitInput,
  stableId,
  truncateText,
  truncateUnknown
} from "../src/core";
import { buildSystemPrompt } from "../src/prompts";

describe("external input helpers", () => {
  it("builds deterministic, tuple-safe identifiers", async () => {
    expect(await stableId("op", "root", "query", "key")).toBe(
      await stableId("op", "root", "query", "key")
    );
    expect(await stableId("op", "a\0b", "c")).not.toBe(
      await stableId("op", "a", "b\0c")
    );
  });

  it("chunks input without changing it", () => {
    const value = "x".repeat(INPUT_CHUNK_CHARS + 17);
    const chunks = splitInput(value);
    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(value);
  });

  it("accepts only external input sources", () => {
    expect(inputSource("task")).toBe("task");
    expect(inputSource("material")).toBe("material");
    expect(() => inputSource("history")).toThrow(/source must be/);
  });

  it("bounds text and structured output", () => {
    expect(truncateText("x".repeat(100), 40)).toHaveLength(40);
    expect(
      String(truncateUnknown({ value: "x".repeat(100) }, 50))
    ).toHaveLength(50);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(truncateUnknown(cyclic, 50)).toBe("[unserializable result]");
  });
});

describe("continual harness", () => {
  it("applies small typed updates with optimistic revisions", () => {
    const update = normalizeHarnessUpdate({
      expectedRevision: 0,
      reason: "answers repeatedly omit citations",
      evidence: "turns 2 and 4 made unsupported claims",
      upsert: [
        {
          id: "evidence",
          kind: "instruction",
          content: "Separate sourced facts from inference."
        },
        {
          id: "researcher",
          kind: "delegate",
          content:
            "Use a child when two source sets can be checked independently."
        }
      ]
    });
    const state = applyHarnessUpdate(emptyHarnessState(), update, 100);
    expect(state.revision).toBe(1);
    expect(state.entries).toHaveLength(2);
    expect(buildHarnessOverview(state)).toContain("Separate sourced facts");
    expect(() => applyHarnessUpdate(state, update, 200)).toThrow(
      /revision conflict/
    );
  });

  it("updates and removes entries without prototype-key behavior", () => {
    const first = applyHarnessUpdate(
      emptyHarnessState(),
      normalizeHarnessUpdate({
        expectedRevision: 0,
        reason: "remember a decision",
        evidence: "the user chose depth one",
        upsert: [
          { id: "constructor", kind: "memory", content: "Use depth one." }
        ]
      }),
      100
    );
    const second = applyHarnessUpdate(
      first,
      normalizeHarnessUpdate({
        expectedRevision: 1,
        reason: "the decision was temporary",
        evidence: "the user withdrew it",
        remove: ["constructor"]
      }),
      200
    );
    expect(second.entries).toEqual([]);
  });

  it("rejects empty or ambiguous updates", () => {
    expect(() =>
      normalizeHarnessUpdate({
        expectedRevision: 0,
        reason: "no-op",
        evidence: "none"
      })
    ).toThrow(/upsert or remove/);
    expect(() =>
      normalizeHarnessUpdate({
        expectedRevision: 0,
        reason: "ambiguous",
        evidence: "same id twice",
        upsert: [{ id: "same", kind: "memory", content: "one" }],
        remove: ["same"]
      })
    ).toThrow(/each id only once/);
  });
});

describe("runtime prompt", () => {
  it("advertises only connectors available to a child", () => {
    const prompt = buildSystemPrompt({
      mode: "think",
      depth: 1,
      maxDepth: 1,
      maxRlmCalls: 8,
      canDelegate: false,
      canUseHarness: false,
      harnessOverview: ""
    });
    expect(prompt).toContain("- context:");
    expect(prompt).toContain("- kernel:");
    expect(prompt).not.toContain("rlm.");
    expect(prompt).not.toContain("- harness:");
  });
});
