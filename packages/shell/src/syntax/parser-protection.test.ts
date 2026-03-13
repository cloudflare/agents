import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";
import { parse } from "../parser/parser";

/**
 * Parser Protection Tests
 *
 * These tests verify that the parser itself cannot cause runaway compute.
 * Parser operations should complete in bounded time regardless of input.
 *
 * IMPORTANT: All tests should complete quickly (<1s each).
 * If any test times out, it indicates a parser vulnerability.
 */

describe("Parser Protection", () => {
  describe("input size limits", () => {
    it("should reject extremely long input", () => {
      // Parser should have a reasonable input size limit
      const longInput = `echo ${"x".repeat(2_000_000)}`;

      expect(() => parse(longInput)).toThrow();
    });

    it("should handle very long variable names gracefully", () => {
      const longVar = "a".repeat(100_000);
      const input = `${longVar}=value`;

      // Should either parse or throw, but not hang
      const start = Date.now();
      try {
        parse(input);
      } catch {
        // Expected to fail
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });

    it("should handle very long string literals gracefully", () => {
      const longStr = "x".repeat(500_000);
      const input = `echo "${longStr}"`;

      const start = Date.now();
      try {
        parse(input);
      } catch {
        // May fail due to size limits
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe("nesting depth limits", () => {
    it("should handle deeply nested parentheses", () => {
      const depth = 1000;
      const open = "(".repeat(depth);
      const close = ")".repeat(depth);
      const input = `echo ${open}test${close}`;

      const start = Date.now();
      try {
        parse(input);
      } catch {
        // Expected to fail due to nesting limits
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });

    it("should handle deeply nested braces", () => {
      const depth = 1000;
      const open = "{".repeat(depth);
      const close = "}".repeat(depth);
      const input = `echo ${open}test${close}`;

      const start = Date.now();
      try {
        parse(input);
      } catch {
        // Expected to fail due to nesting limits
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });

    it("should handle deeply nested command substitutions", () => {
      let input = "echo x";
      for (let i = 0; i < 100; i++) {
        input = `echo $(${input})`;
      }

      const start = Date.now();
      try {
        parse(input);
      } catch {
        // May fail due to nesting limits
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });

    it("should handle deeply nested arithmetic", () => {
      let expr = "1";
      for (let i = 0; i < 500; i++) {
        expr = `(${expr}+1)`;
      }
      const input = `echo $((${expr}))`;

      const start = Date.now();
      try {
        parse(input);
      } catch {
        // May fail due to nesting limits
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe("token count limits", () => {
    it("should handle many tokens gracefully", () => {
      // Many simple tokens
      const tokens = Array(50000).fill("x").join(" ");
      const input = `echo ${tokens}`;

      const start = Date.now();
      try {
        parse(input);
      } catch {
        // May fail due to token limits
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
    });

    it("should handle many semicolons gracefully", () => {
      const commands = Array(10000).fill("echo x").join("; ");

      const start = Date.now();
      try {
        parse(commands);
      } catch {
        // May fail due to limits
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
    });

    it("should handle many pipes gracefully", () => {
      const pipes = Array(1000).fill("cat").join(" | ");

      const start = Date.now();
      try {
        parse(pipes);
      } catch {
        // May fail due to limits
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe("pathological patterns", () => {
    it("should handle repeated brace patterns", () => {
      // Brace expansion can cause exponential growth
      const input = "echo {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}";

      const start = Date.now();
      try {
        parse(input);
      } catch {
        // Parser should handle this
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });

    it("should handle many redirections", () => {
      const redirects = Array(500).fill("> /dev/null").join(" ");
      const input = `echo test ${redirects}`;

      const start = Date.now();
      try {
        parse(input);
      } catch {
        // May fail
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });

    it("should handle alternating quotes", () => {
      const pattern = `"a"'b'`.repeat(10000);
      const input = `echo ${pattern}`;

      const start = Date.now();
      try {
        parse(input);
      } catch {
        // May fail
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe("execution after parsing", () => {
    it("should limit brace expansion during execution", async () => {
      const env = new Bash();
      // This parses fine but expansion could be exponential
      const result = await env.exec(
        "echo {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}{q,r}{s,t}"
      );

      // Should complete without hanging (expansion is limited)
      expect(result.exitCode).toBe(0);
    });

    it("should limit range expansion during execution", async () => {
      const env = new Bash();
      const result = await env.exec("echo {1..100000}");

      // Range expansion should be limited
      expect(result.exitCode).toBe(0);
      // Output should be truncated or limited
      expect(result.stdout.length).toBeLessThan(1_000_000);
    });
  });
});
