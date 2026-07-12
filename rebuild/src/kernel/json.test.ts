import { describe, expect, it } from "vitest";
import { jsonByteLength, normalizeJson, truncateForModel, tryNormalizeJson } from "./json.js";

describe("normalizeJson", () => {
  it("returns a deep copy detached from the original", () => {
    const original = { a: { b: 1 } };
    const copy = normalizeJson<typeof original>(original);
    copy.a.b = 2;
    expect(original.a.b).toBe(1);
  });

  it("drops functions", () => {
    const value = normalizeJson<{ a: number; fn?: unknown }>({ a: 1, fn: () => 1 });
    expect(value).toEqual({ a: 1 });
  });

  it("converts Dates to ISO strings", () => {
    const date = new Date("2020-01-01T00:00:00.000Z");
    const value = normalizeJson<{ d: string }>({ d: date as unknown as string });
    expect(value.d).toBe("2020-01-01T00:00:00.000Z");
  });

  it("throws on cyclic values", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj["self"] = obj;
    expect(() => normalizeJson(obj)).toThrow();
  });
});

describe("tryNormalizeJson", () => {
  it("returns ok:true with the normalized value on success", () => {
    const result = tryNormalizeJson({ a: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it("returns ok:false with an ErrorValue on cyclic input", () => {
    const obj: Record<string, unknown> = {};
    obj["self"] = obj;
    const result = tryNormalizeJson(obj);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.message).toBe("string");
    }
  });
});

describe("truncateForModel", () => {
  it("returns the original text untouched when under the limit", () => {
    const result = truncateForModel("hello", 100);
    expect(result).toEqual({ text: "hello", truncated: false });
  });

  it("truncates text over the limit and marks it truncated", () => {
    const longText = "a".repeat(1000);
    const result = truncateForModel(longText, 100);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(longText.length);
  });

  it("includes a trailing marker noting how much was elided", () => {
    const longText = "a".repeat(1000);
    const result = truncateForModel(longText, 100);
    expect(result.text).toMatch(/\d+/);
  });
});

describe("jsonByteLength", () => {
  it("counts ASCII bytes as 1 byte each", () => {
    expect(jsonByteLength("abc")).toBe(5); // includes quotes: "abc"
  });

  it("counts multibyte UTF-8 characters correctly", () => {
    const value = { text: "héllo" }; // é is 2 bytes in utf-8
    expect(jsonByteLength(value)).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
  });

  it("measures the serialized JSON size of an object", () => {
    const value = { a: "b" };
    expect(jsonByteLength(value)).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
  });
});
