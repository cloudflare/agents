import { describe, it, expect } from "vitest";
import { truncateResponse, truncateResult } from "../truncate";

describe("truncateResponse", () => {
  it("returns short text unchanged", () => {
    expect(truncateResponse("hello")).toBe("hello");
  });

  it("truncates and appends a marker noting the original size", () => {
    const text = "x".repeat(100);
    const out = truncateResponse(text, { maxChars: 10 });
    expect(out.startsWith("x".repeat(10))).toBe(true);
    expect(out).toContain("--- TRUNCATED ---");
    expect(out.length).toBeLessThan(text.length + 200);
  });

  it("derives the char budget from a token budget", () => {
    // 2 tokens * 4 chars/token = 8 chars.
    const out = truncateResponse("y".repeat(50), { maxTokens: 2 });
    expect(out.startsWith("y".repeat(8))).toBe(true);
    expect(out).toContain("--- TRUNCATED ---");
  });
});

describe("truncateResult", () => {
  it("truncates string values directly", () => {
    const out = truncateResult("z".repeat(100), { maxChars: 10 });
    expect(typeof out).toBe("string");
    expect(out as string).toContain("--- TRUNCATED ---");
  });

  it("returns small structured values unchanged (same reference)", () => {
    const value = { a: 1, b: [2, 3] };
    expect(truncateResult(value, { maxChars: 1000 })).toBe(value);
  });

  it("serializes and truncates oversized structured values to a string", () => {
    const value = { items: Array.from({ length: 500 }, (_, i) => ({ i })) };
    const out = truncateResult(value, { maxChars: 50 });
    expect(typeof out).toBe("string");
    expect(out as string).toContain("--- TRUNCATED ---");
  });

  it("leaves non-serializable values unchanged", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(truncateResult(cyclic, { maxChars: 1 })).toBe(cyclic);
    expect(truncateResult(undefined, { maxChars: 1 })).toBeUndefined();
  });
});
