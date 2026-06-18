import { describe, expect, it } from "vitest";
import {
  parseForCodemode,
  parseForStorage,
  stringifyForCodemode,
  stringifyForStorage
} from "../codec";

describe("transport codec", () => {
  it("round-trips binary values", () => {
    const value = {
      bytes: new Uint8Array([1, 2, 255]),
      nested: [{ buf: new Uint8Array([7]).buffer }]
    };
    const decoded = parseForCodemode(stringifyForCodemode(value)) as {
      bytes: Uint8Array;
      nested: [{ buf: ArrayBuffer }];
    };
    expect([...decoded.bytes]).toEqual([1, 2, 255]);
    expect([...new Uint8Array(decoded.nested[0].buf)]).toEqual([7]);
  });
});

describe("storage codec", () => {
  it("round-trips binary and bigint values", () => {
    const value = {
      big: 123456789012345678901234567890n,
      bytes: new Uint8Array([0, 128, 255]),
      plain: { a: 1, b: "two", c: null }
    };
    const stored = stringifyForStorage(value);
    expect(typeof stored).toBe("string");
    const decoded = parseForStorage(stored as string) as typeof value;
    expect(decoded.big).toBe(123456789012345678901234567890n);
    expect([...decoded.bytes]).toEqual([0, 128, 255]);
    expect(decoded.plain).toEqual({ a: 1, b: "two", c: null });
  });

  it("distinguishes undefined (no value) from a recorded null", () => {
    expect(stringifyForStorage(undefined)).toBeUndefined();
    expect(stringifyForStorage(null)).toBe("null");
    expect(parseForStorage(null)).toBeUndefined();
    expect(parseForStorage("null")).toBeNull();
  });

  it("throws on values a durable log cannot represent (cycles)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stringifyForStorage(cyclic)).toThrow();
  });
});
