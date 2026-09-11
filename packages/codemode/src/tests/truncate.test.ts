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

  it("returns a bounded empty container when nothing can fit", () => {
    const out = truncateResult(
      { a: [1, 2, 3], b: { c: "x" } },
      { maxChars: 8 }
    );
    expect(out).toEqual({});
  });

  it("keeps a prefix that fits instead of dropping everything", () => {
    // A large first element beside tiny siblings: all three survive, the big
    // one carries the cut.
    const rows = truncateResult(
      [{ id: 1, note: "n".repeat(4000) }, { id: 2 }, { id: 3 }],
      { maxChars: 80 }
    ) as Record<string, unknown>[];
    expect(JSON.stringify(rows).length).toBeLessThanOrEqual(80);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);

    const mixed = truncateResult(["x".repeat(1000), 5], {
      maxChars: 60
    }) as unknown[];
    expect(JSON.stringify(mixed).length).toBeLessThanOrEqual(60);
    expect(mixed[1]).toBe(5);
    expect(mixed[0]).toContain("--- TRUNCATED ---");
  });

  it("keeps a long list of small records structural at the default budget", () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({
      id: i,
      name: `customer_${i}`,
      email: `a${i}@example.com`,
      status: "active"
    }));
    const out = truncateResult({ schema: "f", rows }) as {
      schema: string;
      rows: unknown[];
    };
    expect(typeof out).toBe("object");
    expect(out.schema).toBe("f");
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(24_000);
    expect(out.rows.length).toBeGreaterThan(100);
    expect(out.rows.slice(0, -1)).toEqual(rows.slice(0, out.rows.length - 1));
  });

  it("never lets a nested marker overshoot its slot", () => {
    const nested: Record<string, string> = {};
    for (let i = 0; i < 6; i++) nested["k".repeat(60) + i] = "v".repeat(200);
    const out = truncateResult(
      { small: "ok", nested, pad: "p".repeat(5000) },
      { maxChars: 400 }
    ) as Record<string, unknown>;
    expect(typeof out).toBe("object");
    expect(out.small).toBe("ok");
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(400);
  });

  it("does not shadow a real key named like the marker", () => {
    const out = truncateResult(
      {
        "--- TRUNCATED ---": "real",
        big: "b".repeat(5000),
        other: "o".repeat(5000)
      },
      { maxChars: 100 }
    ) as Record<string, unknown>;
    expect(out["--- TRUNCATED ---"]).toBe("real");
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(100);
  });

  it("bounds the omitted-key note and stays linear on wide objects", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++)
      wide[`property_number_${i}`] = "v".repeat(40);
    const started = performance.now();
    const out = truncateResult(wide, { maxChars: 300 }) as Record<
      string,
      unknown
    >;
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(typeof out).toBe("object");
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(300);
    expect(out["--- TRUNCATED ---"]).toContain("keys omitted");
  });

  it("honours the budget for any structured input", () => {
    let seed = 42;
    const rnd = () =>
      (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const gen = (depth: number): unknown => {
      const t = rnd();
      if (depth > 3 || t < 0.25) {
        return t < 0.1
          ? Math.floor(rnd() * 1e9)
          : "s\u00e9".repeat(Math.floor(rnd() * 150));
      }
      if (t < 0.6) {
        return Array.from({ length: Math.floor(rnd() * 12) }, () =>
          gen(depth + 1)
        );
      }
      const o: Record<string, unknown> = {};
      for (let i = 0; i < rnd() * 8; i++) o[`k${i}`] = gen(depth + 1);
      return o;
    };
    for (let i = 0; i < 2000; i++) {
      const value = gen(0);
      if (typeof value !== "object" || value === null) continue;
      const maxChars = 16 + Math.floor(rnd() * 600);
      const out = truncateResult(value, { maxChars });
      expect(typeof out).toBe("object");
      expect(JSON.stringify(out).length).toBeLessThanOrEqual(maxChars);
    }
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
