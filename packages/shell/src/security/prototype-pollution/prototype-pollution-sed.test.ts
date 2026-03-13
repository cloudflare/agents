/**
 * SED Prototype Pollution Prevention Tests
 *
 * Tests ensuring JavaScript prototype keywords are handled safely
 * as SED labels and branch targets.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

const DANGEROUS_KEYWORDS = [
  "constructor",
  "__proto__",
  "prototype",
  "hasOwnProperty",
  "toString",
  "valueOf"
];

describe("SED Prototype Pollution Prevention", () => {
  describe("Labels with Dangerous Names", () => {
    for (const keyword of DANGEROUS_KEYWORDS) {
      it(`should define label :${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | sed -e ':${keyword}' -e 'p' -e 'q'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("test");
      });

      it(`should branch to label :${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo -e "1\\n2\\n3" | sed -n ':${keyword}; p; n; b ${keyword}'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("1");
      });

      it(`should test-branch to label :${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "aaa" | sed ':${keyword}; s/a/b/; t ${keyword}; p' | tail -1
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("bbb\n");
      });
    }
  });

  describe("Multiple Labels with Dangerous Names", () => {
    it("should handle multiple dangerous labels", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "start" | sed -e ':constructor' -e ':__proto__' -e ':prototype' -e 'p' -e 'q'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("start");
    });

    it("should branch between dangerous labels", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "x" | sed -n '
          :constructor
          s/x/y/
          t __proto__
          b end
          :__proto__
          s/y/z/
          t prototype
          b end
          :prototype
          p
          :end
        '
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("z\n");
    });
  });

  describe("Labels in Loop Constructs", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should use :${keyword} in loop construct`, async () => {
        const bash = new Bash();
        // Simpler loop test that's more portable
        const result = await bash.exec(`
          echo "aaa" | sed ':${keyword}; s/a/b/; t ${keyword}'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("bbb\n");
      });

      it(`should use :${keyword} in substitution loop`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "xxxxx" | sed ':${keyword}; s/xx/X/; t ${keyword}'
        `);
        expect(result.exitCode).toBe(0);
        // Result contains X's after substitution loop
        expect(result.stdout).toMatch(/X/);
      });
    }
  });

  describe("Object.prototype Verification", () => {
    it("should not pollute Object.prototype after SED operations", async () => {
      const bash = new Bash();

      // Run multiple SED operations with dangerous labels
      await bash.exec(`
        echo "test" | sed -e ':constructor' -e ':__proto__' -e ':prototype' -e 'p' -e 'q'
      `);

      await bash.exec(`
        echo "x" | sed -n ':constructor; p; b constructor' | head -1
      `);

      // Verify Object.prototype is clean
      const testObj: Record<string, unknown> = {};
      expect(testObj.constructor).toBe(Object);
      expect(Object.hasOwn(Object.prototype, "test")).toBe(false);
      expect(Object.keys(Object.prototype).length).toBe(0);
    });
  });
});
