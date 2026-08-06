import { describe, expect, it } from "vitest";
import {
  INPUT_CHUNK_CHARS,
  MAX_HARNESS_BYTES,
  applyHarnessEdits,
  buildHarnessOverview,
  emptyHarnessState,
  inputSource,
  normalizeHarnessApply,
  rollbackHarness,
  splitInput,
  stableId,
  truncateText,
  truncateUnknown
} from "../src/core";

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
    expect(chunks[0]).toHaveLength(INPUT_CHUNK_CHARS);
    expect(chunks.join("")).toBe(value);
  });

  it("accepts only named external sources", () => {
    expect(inputSource("task")).toBe("task");
    expect(inputSource("material")).toBe("material");
    expect(() => inputSource("history")).toThrow(/source must be/);
  });

  it("keeps text and structured observations inside their hard limit", () => {
    expect(truncateText("x".repeat(100), 40)).toHaveLength(40);
    const structured = truncateUnknown({ value: "x".repeat(100) }, 50);
    expect(typeof structured).toBe("string");
    expect((structured as string).length).toBeLessThanOrEqual(50);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(truncateUnknown(cyclic, 50)).toBe("[unserializable result]");
  });
});

describe("continual harness", () => {
  it("creates and updates entries with optimistic revisions", () => {
    const initial = emptyHarnessState();
    const create = normalizeHarnessApply({
      expectedRevision: 0,
      trigger: "the agent repeatedly misses citations",
      evidence: "messages 4 and 9 made unsupported claims",
      expectedOutcome: "answers distinguish sourced facts from inference",
      edits: [
        {
          action: "create",
          kind: "prompt",
          id: "evidence_policy",
          title: "Evidence policy",
          content: "Label inference and retain evidence handles.",
          path: "research",
          reason: "two observed citation failures"
        }
      ]
    });
    const first = applyHarnessEdits(initial, create, 100, "refine_1");
    expect(first.state.revision).toBe(1);
    expect(first.state.entries.prompt.evidence_policy.version).toBe(1);

    const update = normalizeHarnessApply({
      expectedRevision: 1,
      trigger: "tighten the evidence policy",
      evidence: "message 12 labels sources but not inference",
      expectedOutcome: "inferences are explicitly marked",
      edits: [
        {
          action: "update",
          kind: "prompt",
          id: "evidence_policy",
          title: "Evidence and inference policy",
          content: "Retain evidence handles and explicitly label inference.",
          path: "research",
          reason: "the first policy did not cover inference labels"
        }
      ]
    });
    const second = applyHarnessEdits(first.state, update, 200, "refine_2");
    expect(second.state.revision).toBe(2);
    expect(second.state.entries.prompt.evidence_policy.version).toBe(2);
    expect(buildHarnessOverview(second.state)).toContain(
      "Evidence and inference"
    );
    expect(() => applyHarnessEdits(second.state, update, 300, "stale")).toThrow(
      /revision conflict/
    );
  });

  it("requires skills to point at developer-promoted Code Mode snippets", () => {
    expect(() =>
      normalizeHarnessApply({
        expectedRevision: 0,
        trigger: "reuse a successful program",
        evidence: "execution exec_1 completed",
        expectedOutcome: "the program is discoverable",
        edits: [
          {
            action: "create",
            kind: "skill",
            title: "Map reduce",
            content: "Run a map-reduce program.",
            reason: "it worked once",
            reference: { type: "source-code", path: "map.ts" }
          }
        ]
      })
    ).toThrow(/developer-promoted Code Mode snippet/);

    expect(
      normalizeHarnessApply({
        expectedRevision: 0,
        trigger: "reuse a successful program",
        evidence: "execution exec_1 completed",
        expectedOutcome: "the program is discoverable",
        edits: [
          {
            action: "create",
            kind: "skill",
            title: "Map reduce",
            content: "Run a map-reduce program.",
            reason: "it worked once",
            reference: { type: "codemode-snippet", name: "map_reduce" }
          }
        ]
      }).edits[0].reference
    ).toEqual({ type: "codemode-snippet", name: "map_reduce" });
  });

  it("treats harness ids as own keys rather than object prototypes", () => {
    const initial = emptyHarnessState();
    expect(() =>
      applyHarnessEdits(
        initial,
        normalizeHarnessApply({
          expectedRevision: 0,
          trigger: "malformed inherited id",
          evidence: "the id came from untrusted model output",
          expectedOutcome: "prototype properties are never harness entries",
          edits: [
            {
              action: "update",
              kind: "memory",
              id: "__proto__",
              title: "Unsafe",
              content: "Must not resolve through Object.prototype.",
              reason: "exercise inherited-key handling"
            }
          ]
        }),
        100,
        "refine_proto"
      )
    ).toThrow(/missing harness entry/);

    const created = applyHarnessEdits(
      initial,
      normalizeHarnessApply({
        expectedRevision: 0,
        trigger: "valid prototype-named entry",
        evidence: "constructor is a valid user-facing label",
        expectedOutcome: "the entry is stored as an own property",
        edits: [
          {
            action: "create",
            kind: "memory",
            id: "constructor",
            title: "Constructor",
            content: "Stored safely as an own entry.",
            reason: "exercise own-key creation"
          }
        ]
      }),
      100,
      "refine_constructor"
    ).state;
    expect(Object.hasOwn(created.entries.memory, "constructor")).toBe(true);
    expect(created.entries.memory["constructor"].content).toContain("safely");
  });

  it("rolls back entries while keeping a monotonic audit revision", () => {
    const initial = emptyHarnessState();
    const changed = applyHarnessEdits(
      initial,
      normalizeHarnessApply({
        expectedRevision: 0,
        trigger: "remember a decision",
        evidence: "user selected depth one",
        expectedOutcome: "future turns default to depth one",
        edits: [
          {
            action: "create",
            kind: "memory",
            id: "depth",
            title: "Depth default",
            content: "Use depth one.",
            reason: "explicit user choice"
          }
        ]
      }),
      100,
      "refine_1"
    ).state;

    const rolledBack = rollbackHarness(
      changed,
      initial,
      0,
      "the preference was temporary",
      200,
      "rollback_1"
    );
    expect(rolledBack.revision).toBe(2);
    expect(rolledBack.entries.memory.depth).toBeUndefined();
    expect(rolledBack.refinements.at(-1)?.trigger).toBe(
      "rollback to revision 0"
    );
  });

  it("rejects a rollback whose merged snapshot exceeds the harness cap", () => {
    const current = emptyHarnessState();
    current.refinements.push({
      id: "large-history",
      revision: 1,
      trigger: "history",
      evidence: "y".repeat(Math.floor(MAX_HARNESS_BYTES * 0.5)),
      expectedOutcome: "bounded",
      changes: [],
      createdAt: 1
    });
    const target = emptyHarnessState();
    target.entries.memory.large = {
      id: "large",
      kind: "memory",
      title: "Large snapshot",
      content: "x".repeat(Math.floor(MAX_HARNESS_BYTES * 0.6)),
      path: "test",
      reference: {},
      arguments: {},
      metadata: {},
      source: "user",
      createdAt: 1,
      updatedAt: 1,
      version: 1
    };
    expect(() =>
      rollbackHarness(current, target, 0, "restore", 2, "rollback_large")
    ).toThrow(/harness limit/);
  });
});
