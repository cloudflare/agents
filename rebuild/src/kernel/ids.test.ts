import { describe, expect, it } from "vitest";
import { canonicalJson, defaultIdSource, stableHash, type IdSource } from "./ids.js";

describe("defaultIdSource.newId", () => {
  it("prefixes ids with the given prefix and an underscore", () => {
    const id = defaultIdSource.newId("req");
    expect(id.startsWith("req_")).toBe(true);
  });

  it("produces URL-safe ids", () => {
    const id = defaultIdSource.newId("req");
    expect(id).toMatch(/^req_[A-Za-z0-9_-]+$/);
  });

  it("produces distinct ids across calls", () => {
    const a = defaultIdSource.newId("req");
    const b = defaultIdSource.newId("req");
    expect(a).not.toBe(b);
  });
});

describe("a custom IdSource", () => {
  it("is injectable (e.g. deterministic counter for tests)", () => {
    let n = 0;
    const source: IdSource = {
      newId(prefix: string) {
        n += 1;
        return `${prefix}_${n}`;
      },
    };
    expect(source.newId("req")).toBe("req_1");
    expect(source.newId("req")).toBe("req_2");
  });
});

describe("canonicalJson", () => {
  it("sorts object keys", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  });

  it("produces stable output for nested objects regardless of key order", () => {
    const x = { a: 1, nested: { z: 1, y: 2 } };
    const y = { nested: { y: 2, z: 1 }, a: 1 };
    expect(canonicalJson(x)).toBe(canonicalJson(y));
  });

  it("is order-sensitive for arrays", () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("drops properties whose value is undefined", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe("stableHash", () => {
  it("is key-order independent", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });

  it("is deterministic across calls", () => {
    const value = { x: [1, 2, 3], y: "hello" };
    expect(stableHash(value)).toBe(stableHash(value));
  });

  it("produces distinct hashes for different values", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });

  it("is order-sensitive for arrays", () => {
    expect(stableHash([1, 2, 3])).not.toBe(stableHash([3, 2, 1]));
  });

  it("returns a hex string", () => {
    expect(stableHash({ a: 1 })).toMatch(/^[0-9a-f]+$/);
  });
});
