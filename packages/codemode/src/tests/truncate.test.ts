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

  it("keeps oversized structured values as valid JSON of the same shape", () => {
    const value = { items: Array.from({ length: 500 }, (_, i) => ({ i })) };
    const out = truncateResult(value, { maxChars: 120 }) as {
      items: unknown[];
    };
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(120);
    expect(Array.isArray(out.items)).toBe(true);
    expect(out.items.at(-1)).toMatch(/^--- TRUNCATED --- \d+ more items$/);
    expect(out.items.slice(0, -1)).toEqual(
      value.items.slice(0, out.items.length - 1)
    );
  });

  it("cuts the largest values first and leaves small siblings intact", () => {
    const value = {
      schema: "fixture_v1",
      count: 3,
      rows: [{ detail: "x".repeat(70_000) }, { detail: "small" }]
    };
    const out = truncateResult(value, { maxChars: 2_000 }) as typeof value;
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(2_000);
    expect(out.schema).toBe("fixture_v1");
    expect(out.count).toBe(3);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0].detail).toMatch(/^x+ --- TRUNCATED --- 70,000 chars$/);
    expect(out.rows[1].detail).toBe("small");
  });

  it("drops object entries largest-first only when values cannot share the budget", () => {
    const value = {
      id: "abc",
      blob: "b".repeat(5_000),
      text: "t".repeat(5_000),
      n: 1
    };
    // Room for the skeleton, both strings at a reasonable preview, and the id.
    const roomy = truncateResult(value, { maxChars: 400 }) as Record<
      string,
      unknown
    >;
    expect(Object.keys(roomy).sort()).toEqual(["blob", "id", "n", "text"]);
    expect(JSON.stringify(roomy).length).toBeLessThanOrEqual(400);

    // Not enough room for both strings: the largest goes, the rest survive.
    const tight = truncateResult(value, { maxChars: 110 }) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(tight).length).toBeLessThanOrEqual(110);
    expect(tight.id).toBe("abc");
    expect(tight.n).toBe(1);
    expect(tight["--- TRUNCATED ---"]).toMatch(/keys omitted: /);
  });

  it("recurses so a nested log of calls keeps every call but bounds each result", () => {
    const calls = Array.from({ length: 20 }, (_, i) => ({
      seq: i,
      method: "sql.query",
      result: { rows: Array.from({ length: 50 }, (_, r) => ({ r, i })) }
    }));
    const out = truncateResult(calls, { maxChars: 3_000 }) as typeof calls;
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(3_000);
    const kept = out.filter((c) => typeof c === "object");
    expect(kept.length).toBeGreaterThan(5);
    for (const call of kept) {
      expect(call.method).toBe("sql.query");
      expect(Array.isArray(call.result.rows)).toBe(true);
    }
  });

  it("falls back to a clipped serialization when even the skeleton cannot fit", () => {
    const out = truncateResult(
      { a: [1, 2, 3], b: { c: "x" } },
      { maxChars: 8 }
    );
    expect(typeof out).toBe("string");
    expect(out as string).toContain("--- TRUNCATED ---");
  });

  it("sees values the way they serialize", () => {
    const value = {
      when: new Date(0),
      gone: undefined,
      big: "z".repeat(1_000)
    };
    const out = truncateResult(value, { maxChars: 200 }) as Record<
      string,
      unknown
    >;
    expect(out.when).toBe("1970-01-01T00:00:00.000Z");
    expect("gone" in out).toBe(false);
    expect(typeof out.big).toBe("string");
  });

  it("leaves non-serializable values unchanged", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(truncateResult(cyclic, { maxChars: 1 })).toBe(cyclic);
    expect(truncateResult(undefined, { maxChars: 1 })).toBeUndefined();
  });
});
