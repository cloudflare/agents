import { describe, expect, it } from "vitest";
import { SessionBuilderImpl } from "./builder.js";

describe("SessionBuilderImpl", () => {
  it("withContext accumulates extra blocks in call order", () => {
    const b = new SessionBuilderImpl();
    b.withContext("notes").withContext("scratch", { description: "d", maxTokens: 100 });
    expect(b.extraBlocks).toEqual([{ label: "notes" }, { label: "scratch", description: "d", maxTokens: 100 }]);
  });

  it("withCachedPrompt sets baseMaxTokens", () => {
    const b = new SessionBuilderImpl();
    b.withCachedPrompt({ maxTokens: 500 });
    expect(b.baseMaxTokens).toBe(500);
  });

  it("onCompaction sets the compaction config with the summarize fn", () => {
    const b = new SessionBuilderImpl();
    const summarize = async (p: string) => p;
    b.onCompaction(summarize, { protectHead: 1 });
    expect(b.compaction).toMatchObject({ summarize, protectHead: 1 });
  });

  it("compactAfter sets compactAfterTokens, defaulting summarize when onCompaction wasn't called first", () => {
    const b = new SessionBuilderImpl();
    b.compactAfter(1000);
    expect(b.compaction?.compactAfterTokens).toBe(1000);
    expect(typeof b.compaction?.summarize).toBe("function");
  });

  it("compactAfter after onCompaction preserves the configured summarize", () => {
    const b = new SessionBuilderImpl();
    const summarize = async (p: string) => `S:${p}`;
    b.onCompaction(summarize).compactAfter(2000);
    expect(b.compaction?.summarize).toBe(summarize);
    expect(b.compaction?.compactAfterTokens).toBe(2000);
  });

  it("chains fluently, returning the same builder instance", () => {
    const b = new SessionBuilderImpl();
    expect(b.withContext("a")).toBe(b);
    expect(b.withCachedPrompt()).toBe(b);
  });
});
