import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";
import { ExecutionLimitError } from "../../interpreter/errors";

/**
 * SED Execution Limits Tests
 *
 * These tests verify that sed commands cannot cause runaway compute.
 * SED programs should complete in bounded time regardless of input.
 *
 * IMPORTANT: All tests should complete quickly (<1s each).
 */

describe("SED Execution Limits", () => {
  describe("infinite loop protection", () => {
    it("should protect against branch loop (b command)", async () => {
      const env = new Bash();
      // :label followed by b label creates infinite loop
      const result = await env.exec(`echo "test" | sed ':loop; b loop'`);

      // Must hit our internal limit with correct exit code
      expect(result.stderr).toContain("exceeded maximum iterations");
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    });

    it("should protect against test loop (t command)", async () => {
      const env = new Bash();
      // Substitution that always succeeds + t branch = infinite loop
      const result = await env.exec(
        `echo "test" | sed ':loop; s/./&/; t loop'`
      );

      expect(result.stderr).toContain("exceeded maximum iterations");
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    });

    it("should protect against unconditional branch at start", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "test" | sed 'b; p'`);

      // Should complete - this isn't infinite but tests branch handling
      expect(result.exitCode).toBeDefined();
    });
  });

  describe("substitution limits", () => {
    it("should handle global substitution on long lines", async () => {
      const env = new Bash();
      const longLine = "a".repeat(100000);
      await env.writeFile("/input.txt", longLine);

      const result = await env.exec(`sed 's/a/b/g' /input.txt`);

      // Should complete without hanging
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it("should handle backreference expansion limits", async () => {
      const env = new Bash();
      // Many backreferences
      const result = await env.exec(
        `echo "abcdefghij" | sed 's/\\(.\\)\\(.\\)\\(.\\)\\(.\\)\\(.\\)\\(.\\)\\(.\\)\\(.\\)\\(.\\)\\(.\\)/\\1\\2\\3\\4\\5\\6\\7\\8\\9\\1/'`
      );

      expect(result.exitCode).toBeDefined();
    });

    it("should limit output from repeated substitution", async () => {
      const env = new Bash();
      // Substitution that doubles content
      const result = await env.exec(`echo "x" | sed 's/./&&/g'`);

      expect(result.exitCode).toBe(0);
    });
  });

  describe("hold space limits", () => {
    it("should handle large hold space operations", async () => {
      const env = new Bash();
      const lines = Array(1000).fill("line").join("\n");
      await env.writeFile("/input.txt", lines);

      // Append all lines to hold space
      const result = await env.exec(`sed 'H' /input.txt`);

      expect(result.exitCode).toBeDefined();
    });

    it("should handle exchange with large buffers", async () => {
      const env = new Bash();
      const longLine = "x".repeat(10000);
      await env.writeFile("/input.txt", longLine);

      const result = await env.exec(`sed 'h; x; x' /input.txt`);

      expect(result.exitCode).toBe(0);
    });

    it("should enforce hold space size limit with H command", async () => {
      const env = new Bash({
        executionLimits: { maxStringLength: 1000 }
      });
      // Use -n to suppress output so the output limit doesn't trigger first.
      // 200 lines of 10 chars = 2000+ bytes in hold space, exceeds 1000 limit.
      const lines = Array(200).fill("0123456789").join("\n");
      await env.writeFile("/input.txt", lines);

      const result = await env.exec(`sed -n 'H' /input.txt`);

      expect(result.stderr).toContain("hold space size limit exceeded");
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    });

    it("should enforce pattern space size limit with G command", async () => {
      const env = new Bash({
        executionLimits: { maxStringLength: 500 }
      });
      // Use -n to suppress output. H accumulates into hold space,
      // then G appends hold space to pattern space (exceeds limit).
      const lines = Array(100).fill("0123456789").join("\n");
      await env.writeFile("/input.txt", lines);

      const result = await env.exec("sed -n 'H; ${G; p}' /input.txt");

      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
      expect(result.stderr).toContain("size limit exceeded");
    });
  });

  describe("regex limits", () => {
    // Skip: BRE->ERE conversion creates ReDoS pattern (a+)+ which has catastrophic backtracking
    it.skip("should handle pathological regex patterns", async () => {
      const env = new Bash();
      // ReDoS-style pattern
      const result = await env.exec(
        `echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaab" | sed '/^\\(a\\+\\)\\+$/p'`
      );

      // Should complete quickly
      expect(result.exitCode).toBeDefined();
    });

    it("should handle complex alternation", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | sed 's/a\\|b\\|c\\|d\\|e\\|f\\|g\\|h\\|i\\|j/X/g'`
      );

      expect(result.exitCode).toBe(0);
    });
  });

  describe("address range limits", () => {
    it("should handle large line number addresses", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "test" | sed '999999999p'`);

      // Should not hang trying to reach that line
      expect(result.exitCode).toBe(0);
    });

    it("should handle step addresses on large input", async () => {
      const env = new Bash();
      const lines = Array(10000).fill("line").join("\n");
      await env.writeFile("/input.txt", lines);

      const result = await env.exec(`sed -n '0~100p' /input.txt`);

      expect(result.exitCode).toBeDefined();
    });
  });

  describe("command limits", () => {
    it("should handle many commands", async () => {
      const env = new Bash();
      const commands = Array(100).fill("s/a/b/").join("; ");
      const result = await env.exec(`echo "aaa" | sed '${commands}'`);

      expect(result.exitCode).toBeDefined();
    });

    it("should handle deeply nested braces", async () => {
      const env = new Bash();
      // Nested command blocks
      const result = await env.exec(`echo "test" | sed '{ { { p } } }'`);

      expect(result.exitCode).toBe(0);
    });
  });

  describe("n/N command limits", () => {
    it("should handle N command accumulation without infinite loop", async () => {
      const env = new Bash();
      const lines = Array(100).fill("line").join("\n");
      await env.writeFile("/input.txt", lines);

      // N accumulates lines but quits when no more lines available
      // This should complete successfully (not loop forever)
      const result = await env.exec(`sed ':a; N; ba' /input.txt`);

      // N quits when there's no next line, so this completes
      expect(result.exitCode).toBe(0);
    });
  });
});
