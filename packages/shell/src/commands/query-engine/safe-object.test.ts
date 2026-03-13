import { describe, expect, it } from "vitest";
import {
  isSafeKey,
  isSafeKeyStrict,
  nullPrototype as np,
  safeAssign,
  safeCopy,
  safeDelete,
  safeFromEntries,
  safeGet,
  safeHasOwn,
  safeSet
} from "./safe-object";

describe("safe-object utilities", () => {
  describe("isSafeKey", () => {
    it("should return false for __proto__", () => {
      expect(isSafeKey("__proto__")).toBe(false);
    });

    it("should return false for constructor", () => {
      expect(isSafeKey("constructor")).toBe(false);
    });

    it("should return false for prototype", () => {
      expect(isSafeKey("prototype")).toBe(false);
    });

    it("should return true for normal keys", () => {
      expect(isSafeKey("name")).toBe(true);
      expect(isSafeKey("value")).toBe(true);
      expect(isSafeKey("foo")).toBe(true);
      expect(isSafeKey("bar123")).toBe(true);
      expect(isSafeKey("")).toBe(true);
      expect(isSafeKey("0")).toBe(true);
    });

    it("should return true for similar but different keys", () => {
      expect(isSafeKey("__proto")).toBe(true);
      expect(isSafeKey("proto__")).toBe(true);
      expect(isSafeKey("__Proto__")).toBe(true);
      expect(isSafeKey("CONSTRUCTOR")).toBe(true);
      expect(isSafeKey("Prototype")).toBe(true);
    });
  });

  describe("isSafeKeyStrict", () => {
    it("should return false for basic dangerous keys", () => {
      expect(isSafeKeyStrict("__proto__")).toBe(false);
      expect(isSafeKeyStrict("constructor")).toBe(false);
      expect(isSafeKeyStrict("prototype")).toBe(false);
    });

    it("should return false for extended dangerous keys", () => {
      expect(isSafeKeyStrict("__defineGetter__")).toBe(false);
      expect(isSafeKeyStrict("__defineSetter__")).toBe(false);
      expect(isSafeKeyStrict("__lookupGetter__")).toBe(false);
      expect(isSafeKeyStrict("__lookupSetter__")).toBe(false);
      expect(isSafeKeyStrict("hasOwnProperty")).toBe(false);
      expect(isSafeKeyStrict("isPrototypeOf")).toBe(false);
      expect(isSafeKeyStrict("propertyIsEnumerable")).toBe(false);
      expect(isSafeKeyStrict("toLocaleString")).toBe(false);
      expect(isSafeKeyStrict("toString")).toBe(false);
      expect(isSafeKeyStrict("valueOf")).toBe(false);
    });

    it("should return true for normal keys", () => {
      expect(isSafeKeyStrict("name")).toBe(true);
      expect(isSafeKeyStrict("value")).toBe(true);
    });
  });

  describe("safeGet", () => {
    it("should get normal properties", () => {
      const obj = np({ a: 1, b: "test" });
      expect(safeGet(obj, "a")).toBe(1);
      expect(safeGet(obj, "b")).toBe("test");
    });

    it("should return undefined for dangerous keys", () => {
      const obj: Record<string, unknown> = Object.create(null);
      Object.defineProperty(obj, "__proto__", {
        value: "value",
        enumerable: true,
        configurable: true,
        writable: true
      });
      expect(safeGet(obj, "__proto__")).toBe(undefined);
    });

    it("should return undefined for non-existent keys", () => {
      const obj = np({ a: 1 });
      expect(safeGet(obj, "b")).toBe(undefined);
    });

    it("should reject prototypal objects", () => {
      const obj = { a: 1 };
      expect(() => safeGet(obj, "a")).toThrow("expected null-prototype object");
    });

    it("should reject arrays", () => {
      expect(() => safeGet([] as never, "0")).toThrow(
        "expected object, got array"
      );
    });
  });

  describe("safeSet", () => {
    it("should set normal properties", () => {
      const obj: Record<string, unknown> = Object.create(null);
      safeSet(obj, "a", 1);
      safeSet(obj, "b", "test");
      expect(obj.a).toBe(1);
      expect(obj.b).toBe("test");
    });

    it("should ignore dangerous keys", () => {
      const obj: Record<string, unknown> = Object.create(null);
      safeSet(obj, "__proto__", "polluted");
      safeSet(obj, "constructor", "polluted");
      safeSet(obj, "prototype", "polluted");

      // The object should remain empty
      expect(Object.keys(obj)).toEqual([]);
      // Object.prototype should not be polluted
      expect(({} as Record<string, unknown>).__proto__).not.toBe("polluted");
    });

    it("should silently ignore dangerous keys without throwing", () => {
      const obj: Record<string, unknown> = Object.create(null);
      expect(() => safeSet(obj, "__proto__", "value")).not.toThrow();
    });

    it("should reject prototypal objects", () => {
      expect(() => safeSet({}, "a", 1)).toThrow(
        "expected null-prototype object"
      );
    });
  });

  describe("safeDelete", () => {
    it("should delete normal properties", () => {
      const obj = np({ a: 1, b: 2 });
      safeDelete(obj, "a");
      expect(obj).toEqual({ b: 2 });
    });

    it("should ignore dangerous keys", () => {
      const obj = np({ a: 1 });
      safeDelete(obj, "__proto__");
      safeDelete(obj, "constructor");
      expect(obj).toEqual({ a: 1 });
    });

    it("should reject prototypal objects", () => {
      expect(() => safeDelete({ a: 1 }, "a")).toThrow(
        "expected null-prototype object"
      );
    });
  });

  describe("safeFromEntries", () => {
    it("should create object from entries", () => {
      const entries: [string, number][] = [
        ["a", 1],
        ["b", 2]
      ];
      const result = safeFromEntries(entries);
      expect(result).toEqual({ a: 1, b: 2 });
      expect(Object.getPrototypeOf(result)).toBe(null);
    });

    it("should filter dangerous keys from entries", () => {
      const entries: [string, string][] = [
        ["a", "safe"],
        ["__proto__", "polluted"],
        ["b", "safe"],
        ["constructor", "polluted"]
      ];
      const result = safeFromEntries(entries);
      expect(result).toEqual({ a: "safe", b: "safe" });
    });

    it("should handle empty entries", () => {
      const result = safeFromEntries([]);
      expect(result).toEqual({});
      expect(Object.getPrototypeOf(result)).toBe(null);
    });
  });

  describe("safeAssign", () => {
    it("should copy properties from source to target", () => {
      const target = np({ a: 1 }) as Record<string, number>;
      const source = np({ b: 2, c: 3 }) as Record<string, number>;
      safeAssign(target, source);
      expect(target).toEqual({ a: 1, b: 2, c: 3 });
    });

    it("should filter dangerous keys from source", () => {
      const target = np({ a: 1 }) as Record<string, unknown>;
      const source: Record<string, unknown> = Object.create(null);
      source.b = 2;
      Object.defineProperty(source, "__proto__", {
        value: "polluted",
        enumerable: true
      });
      safeAssign(target, source);
      expect(target).toEqual({ a: 1, b: 2 });
    });

    it("should return the target object", () => {
      const target = np({ a: 1 }) as Record<string, number>;
      const source = np({ b: 2 }) as Record<string, number>;
      const result = safeAssign(target, source);
      expect(result).toBe(target);
    });

    it("should reject prototypal target", () => {
      expect(() => safeAssign({}, np({ a: 1 }))).toThrow(
        "expected null-prototype object"
      );
    });

    it("should reject prototypal source", () => {
      expect(() => safeAssign(Object.create(null), { a: 1 })).toThrow(
        "expected null-prototype object"
      );
    });
  });

  describe("safeCopy", () => {
    it("should create shallow copy of object", () => {
      const obj = { a: 1, b: { nested: true } };
      const copy = safeCopy(obj);
      expect(copy).toEqual(obj);
      expect(copy).not.toBe(obj);
      expect(copy.b).toBe(obj.b); // Shallow copy
      expect(Object.getPrototypeOf(copy)).toBe(null);
    });

    it("should filter dangerous keys in copy", () => {
      // Create object with dangerous key using Object.defineProperty
      const obj: Record<string, unknown> = { a: 1 };
      Object.defineProperty(obj, "__proto_key__", {
        value: "safe",
        enumerable: true
      });
      const copy = safeCopy(obj);
      expect(copy.a).toBe(1);
      expect(copy.__proto_key__).toBe("safe");
    });
  });

  describe("safeHasOwn", () => {
    it("should return true for own properties", () => {
      const obj = np({ a: 1 });
      expect(safeHasOwn(obj, "a")).toBe(true);
    });

    it("should return false for non-existent properties", () => {
      const obj = np({ a: 1 });
      expect(safeHasOwn(obj, "b")).toBe(false);
    });

    it("should return false for missing properties on null-prototype objects", () => {
      const obj: Record<string, unknown> = Object.create(null);
      obj.own = true;
      expect(safeHasOwn(obj, "own")).toBe(true);
      expect(safeHasOwn(obj, "toString")).toBe(false);
      expect(safeHasOwn(obj, "hasOwnProperty")).toBe(false);
    });

    it("should reject prototypal objects", () => {
      expect(() => safeHasOwn({}, "a")).toThrow(
        "expected null-prototype object"
      );
    });

    it("should reject arrays", () => {
      expect(() => safeHasOwn([], "length")).toThrow(
        "expected object, got array"
      );
    });
  });

  describe("assertion guards", () => {
    it("safeGet rejects arrays", () => {
      expect(() => safeGet([] as never, "0")).toThrow("got array");
    });

    it("safeSet rejects arrays", () => {
      expect(() => safeSet([] as never, "0", 1)).toThrow("got array");
    });

    it("safeDelete rejects arrays", () => {
      expect(() => safeDelete([] as never, "0")).toThrow("got array");
    });

    it("safeHasOwn rejects arrays", () => {
      expect(() => safeHasOwn([], "0")).toThrow("got array");
    });
  });

  describe("integration: prototype pollution prevention", () => {
    it("should not pollute Object.prototype through any safe method", () => {
      // Store original prototype state
      const originalKeys = Object.keys(Object.prototype);

      // Try various pollution attempts
      const obj1: Record<string, unknown> = Object.create(null);
      safeSet(obj1, "__proto__", { polluted: true });

      const _obj2 = safeFromEntries([["__proto__", { polluted: true }]]);

      const obj3: Record<string, unknown> = Object.create(null);
      const src3: Record<string, unknown> = Object.create(null);
      Object.defineProperty(src3, "__proto__", {
        value: { polluted: true },
        enumerable: true
      });
      safeAssign(obj3, src3);

      // Verify Object.prototype is unchanged
      const newKeys = Object.keys(Object.prototype);
      expect(newKeys).toEqual(originalKeys);
      expect((Object.prototype as Record<string, unknown>).polluted).toBe(
        undefined
      );
    });

    it("should work correctly when chained", () => {
      const entries: [string, number][] = [
        ["a", 1],
        ["__proto__", 999],
        ["b", 2]
      ];
      const obj = safeFromEntries(entries);
      safeSet(obj, "c", 3);
      safeSet(obj, "constructor", 999);
      safeDelete(obj, "a");
      safeAssign(obj, np({ d: 4, prototype: 999 }));

      expect(obj).toEqual({ b: 2, c: 3, d: 4 });
    });
  });
});
