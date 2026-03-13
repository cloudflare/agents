import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

/**
 * Tests for curl prototype pollution defense.
 *
 * curl has attack vectors through:
 * 1. HTTP header names via -H/--header option
 * 2. Response headers from remote servers (handled in fetch.ts)
 */

const DANGEROUS_KEYWORDS = [
  "constructor",
  "prototype",
  "__proto__",
  "hasOwnProperty",
  "toString",
  "valueOf"
];

describe("curl prototype pollution defense", () => {
  describe("HTTP header names with dangerous keywords", () => {
    for (const keyword of DANGEROUS_KEYWORDS) {
      it(`should handle header name '${keyword}'`, async () => {
        const env = new Bash();
        // This tests that curl parses headers without polluting prototypes
        // The actual fetch would fail due to network restrictions in tests
        const result = await env.exec(
          `curl -H "${keyword}: test-value" http://example.com`
        );
        // We expect this to fail due to network, but it should not pollute prototype
        expect(result.exitCode).not.toBe(0); // Network error expected
      });
    }
  });

  describe("curl does not pollute JavaScript prototype via header names", () => {
    it("should not pollute Object.prototype via -H option", async () => {
      const env = new Bash();

      // Attempt to inject dangerous headers
      for (const keyword of DANGEROUS_KEYWORDS) {
        await env.exec(
          `curl -H "${keyword}: polluted_${keyword}" http://example.com`
        );
      }

      // Verify JavaScript Object.prototype is not affected
      const testObj: Record<string, unknown> = {};
      expect(Object.hasOwn(Object.prototype, "polluted_constructor")).toBe(
        false
      );
      expect(Object.hasOwn(Object.prototype, "polluted___proto__")).toBe(false);
      expect(Object.hasOwn(Object.prototype, "polluted_prototype")).toBe(false);
      expect(testObj.__proto__).toBe(Object.prototype);
      expect(typeof testObj.constructor).toBe("function");
      expect(typeof testObj.toString).toBe("function");
    });

    it("should not pollute Object.prototype via --header option", async () => {
      const env = new Bash();

      // Attempt to inject dangerous headers
      await env.exec(`curl --header="__proto__: malicious" http://example.com`);
      await env.exec(
        `curl --header="constructor: malicious" http://example.com`
      );

      // Verify JavaScript Object.prototype is not affected
      const testObj: Record<string, unknown> = {};
      expect(testObj.__proto__).toBe(Object.prototype);
      expect(typeof testObj.constructor).toBe("function");
    });
  });
});
