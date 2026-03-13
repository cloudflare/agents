import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

/**
 * Exhaustive tests for prototype pollution defense-in-depth.
 *
 * JavaScript prototype pollution occurs when attackers can inject properties like
 * "__proto__", "constructor", or "prototype" into objects, potentially modifying
 * the Object.prototype and affecting all objects in the application.
 *
 * These tests verify that jq operations safely handle these dangerous keys.
 */
describe("jq prototype pollution defense", () => {
  describe("direct field access with dangerous keys", () => {
    it("should safely access __proto__ as a regular key", async () => {
      const env = new Bash();
      // Accessing __proto__ should not return Object.prototype
      const result = await env.exec(
        `echo '{"__proto__": "safe"}' | jq '.__proto__'`
      );
      // Should return null (key ignored) or the literal value, but NOT Object methods
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("function");
    });

    it("should safely access constructor as a regular key", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{"constructor": "safe"}' | jq '.constructor'`
      );
      expect(result.exitCode).toBe(0);
      // Should not return the Object constructor function
      expect(result.stdout).not.toContain("function");
    });

    it("should safely access prototype as a regular key", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{"prototype": "safe"}' | jq '.prototype'`
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("object construction with dangerous keys", () => {
    it("should not pollute prototype when constructing object with __proto__", async () => {
      const env = new Bash();
      // Attempting to construct an object with __proto__ key should not pollute Object.prototype
      const result = await env.exec(
        `echo 'null' | jq '{("__proto__"): "polluted"}'`
      );
      expect(result.exitCode).toBe(0);
      // The result should be an empty object (dangerous key filtered out)
      expect(result.stdout.trim()).toBe("{}");
    });

    it("should not pollute prototype when constructing object with constructor", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo 'null' | jq '{("constructor"): "polluted"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
    });

    it("should not pollute prototype when constructing object with prototype", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo 'null' | jq '{("prototype"): "polluted"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
    });

    it("should construct normal keys correctly while filtering dangerous ones", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo 'null' | jq '{a: 1, ("__proto__"): 2, b: 3}'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ a: 1, b: 3 });
      expect(parsed.__proto__).not.toBe(2);
    });
  });

  describe("from_entries with dangerous keys", () => {
    it("should filter __proto__ in from_entries", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '[{"key":"__proto__","value":"polluted"},{"key":"safe","value":"ok"}]' | jq 'from_entries'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ safe: "ok" });
      // Note: "in" operator returns true for inherited properties, use hasOwnProperty
      expect(Object.hasOwn(parsed, "__proto__")).toBe(false);
    });

    it("should filter constructor in from_entries", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '[{"key":"constructor","value":"polluted"}]' | jq 'from_entries'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
    });

    it("should filter prototype in from_entries", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '[{"key":"prototype","value":"polluted"}]' | jq 'from_entries'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
    });

    it("should handle from_entries with name/Name/k variants for dangerous keys", async () => {
      const env = new Bash();
      // Test with 'name' variant
      const result1 = await env.exec(
        `echo '[{"name":"__proto__","value":"polluted"}]' | jq 'from_entries'`
      );
      expect(result1.stdout.trim()).toBe("{}");

      // Test with 'Name' variant
      const result2 = await env.exec(
        `echo '[{"Name":"constructor","value":"polluted"}]' | jq 'from_entries'`
      );
      expect(result2.stdout.trim()).toBe("{}");

      // Test with 'k' variant
      const result3 = await env.exec(
        `echo '[{"k":"prototype","v":"polluted"}]' | jq 'from_entries'`
      );
      expect(result3.stdout.trim()).toBe("{}");
    });
  });

  describe("with_entries with dangerous keys", () => {
    it("should filter __proto__ when renaming keys via with_entries", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{"a":1}' | jq 'with_entries(.key = "__proto__")'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
    });

    it("should filter constructor when transforming via with_entries", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{"a":1}' | jq 'with_entries(.key = "constructor")'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
    });
  });

  describe("setpath with dangerous keys", () => {
    it("should ignore setpath with __proto__", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{}' | jq 'setpath(["__proto__"]; "polluted")'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
    });

    it("should ignore setpath with constructor", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{}' | jq 'setpath(["constructor"]; "polluted")'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
    });

    it("should ignore setpath with nested dangerous key", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{"a":{}}' | jq 'setpath(["a","__proto__"]; "polluted")'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ a: {} });
    });

    it("should set safe keys while ignoring dangerous ones in same path", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{}' | jq 'setpath(["safe"]; "ok") | setpath(["__proto__"]; "bad")'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ safe: "ok" });
    });
  });

  describe("update operations with dangerous keys", () => {
    it("should ignore assignment to .__proto__", async () => {
      const env = new Bash();
      const result = await env.exec(`echo '{}' | jq '.__proto__ = "polluted"'`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
    });

    it("should ignore assignment to .constructor", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{}' | jq '.constructor = "polluted"'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
    });

    it("should ignore |= update with dangerous keys", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{}' | jq '.__proto__ |= . + "test"'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
    });

    it("should ignore += update with dangerous keys", async () => {
      const env = new Bash();
      const result = await env.exec(`echo '{}' | jq '.__proto__ += "test"'`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
    });

    it("should handle indexed assignment with dangerous string keys", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{}' | jq '.["__proto__"] = "polluted"'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
    });
  });

  describe("delete operations with dangerous keys", () => {
    it("should safely handle del(.__proto__)", async () => {
      const env = new Bash();
      const result = await env.exec(`echo '{"a":1}' | jq 'del(.__proto__)'`);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ a: 1 });
    });

    it("should safely handle del(.constructor)", async () => {
      const env = new Bash();
      const result = await env.exec(`echo '{"a":1}' | jq 'del(.constructor)'`);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ a: 1 });
    });

    it("should safely handle delpaths with dangerous keys", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{"a":1}' | jq 'delpaths([["__proto__"]])'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ a: 1 });
    });
  });

  describe("deep merge with dangerous keys", () => {
    it("should filter dangerous keys during object multiplication (deep merge)", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{"a":1}' | jq '. * {"__proto__": "polluted"}'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ a: 1 });
    });

    it("should handle nested dangerous keys in deep merge", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{"a":{"b":1}}' | jq '. * {"a": {"__proto__": "polluted"}}'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ a: { b: 1 } });
    });
  });

  describe("fromstream with dangerous keys", () => {
    it("should filter dangerous keys when reconstructing from stream", async () => {
      const env = new Bash();
      // tostream produces path-value pairs, fromstream reconstructs
      // Manually craft a stream with dangerous key
      const result = await env.exec(
        `echo 'null' | jq 'fromstream(([["__proto__"], "polluted"], [[]]))'`
      );
      expect(result.exitCode).toBe(0);
      // Should be null or empty object, not an object with __proto__ set
      const output = result.stdout.trim();
      expect(output === "null" || output === "{}").toBe(true);
    });
  });

  describe("iterator update with dangerous keys", () => {
    it("should handle .[] = update when object has dangerous keys", async () => {
      const env = new Bash();
      // When iterating over values and updating, dangerous keys should be skipped
      const result = await env.exec(
        `echo '{"a":1,"__proto__":2}' | jq '.[] |= . + 10'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      // Only 'a' should be updated
      expect(parsed.a).toBe(11);
    });
  });

  describe("edge cases and combinations", () => {
    it("should handle multiple dangerous keys in single operation", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{}' | jq '{("__proto__"): 1, ("constructor"): 2, ("prototype"): 3, safe: 4}'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ safe: 4 });
    });

    it("should handle dangerous keys with special characters", async () => {
      const env = new Bash();
      // __proto__ with different casing should be allowed (only exact match is dangerous)
      const result = await env.exec(
        `echo '{}' | jq '{("__Proto__"): 1, ("__PROTO__"): 2}'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ __Proto__: 1, __PROTO__: 2 });
    });

    it("should handle chained operations with dangerous keys", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{"a":1}' | jq '. + {("__proto__"): 2} | . + {b: 3}'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ a: 1, b: 3 });
    });

    it("should preserve normal functionality with safe keys", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{}' | jq '{a: 1, b: 2, c: 3} | .d = 4 | del(.b)'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ a: 1, c: 3, d: 4 });
    });

    it("should handle reduce with potential dangerous key accumulation", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '["__proto__", "safe", "constructor"]' | jq 'reduce .[] as $k ({}; .[$k] = 1)'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ safe: 1 });
    });

    it("should handle complex nested path operations safely", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{"a":{"b":{}}}' | jq '.a.b.__proto__ = "polluted"'`
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ a: { b: {} } });
    });
  });

  describe("verify Object.prototype is not polluted", () => {
    it("should not have added properties to Object.prototype after all operations", async () => {
      const env = new Bash();
      // Run multiple pollution attempts
      await env.exec(`echo '{}' | jq '.__proto__.polluted = true'`);
      await env.exec(`echo '{}' | jq '{("__proto__"): {"test": true}}'`);
      await env.exec(
        `echo '[{"key":"__proto__","value":{"x":1}}]' | jq 'from_entries'`
      );

      // Now check that a fresh empty object doesn't have unexpected properties
      const result = await env.exec(`echo '{}' | jq 'keys'`);
      expect(result.exitCode).toBe(0);
      // Empty object should have no keys
      expect(result.stdout.trim()).toBe("[]");
    });
  });
});
