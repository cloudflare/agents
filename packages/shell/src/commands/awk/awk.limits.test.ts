import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";
import { ExecutionLimitError } from "../../interpreter/errors";

/**
 * AWK Execution Limits Tests
 *
 * These tests verify that awk commands cannot cause runaway compute.
 * AWK programs should complete in bounded time regardless of input.
 *
 * IMPORTANT: All tests should complete quickly (<1s each).
 */

describe("AWK Execution Limits", () => {
  describe("infinite loop protection", () => {
    it("should protect against while(1) infinite loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { while(1) print "x" }'`
      );

      // Should not hang - awk should have iteration limits
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.exitCode).not.toBe(0);
    });

    it("should protect against for loop with always-true condition", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { for(i=0; 1; i++) print "x" }'`
      );

      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.exitCode).not.toBe(0);
    });

    it("should protect against for(;;) infinite loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { for(;;) print "x" }'`
      );

      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.exitCode).not.toBe(0);
    });

    it("should protect against do-while infinite loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { do { print "x" } while(1) }'`
      );

      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("recursion protection", () => {
    it("should protect against recursive function calls", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'function f() { f() } BEGIN { f() }'`
      );

      // Must hit our internal limit, not JS stack overflow
      expect(result.stderr).toContain("recursion depth exceeded");
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    });

    it("should protect against mutual recursion", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'function a() { b() } function b() { a() } BEGIN { a() }'`
      );

      // Must hit our internal limit, not JS stack overflow
      expect(result.stderr).toContain("recursion depth exceeded");
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    });
  });

  describe("output size limits", () => {
    it("should limit output from print in loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { for(i=0; i<1000000; i++) print "x" }'`
      );

      // Should hit iteration or output size limit before completing 1M iterations
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
      expect(result.stderr).toContain("exceeded");
    });

    it("should limit string concatenation growth", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { s="x"; for(i=0; i<30; i++) s=s s; print length(s) }'`
      );

      // Doubling 30 times would be 2^30 = 1GB, must hit string length limit
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
      expect(result.stderr).toContain("exceeded");
    });
  });

  describe("array limits", () => {
    it("should handle large array creation", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { for(i=0; i<100000; i++) a[i]=i; print length(a) }'`
      );

      // Should complete without hanging
      expect(result.exitCode).toBeDefined();
    });
  });

  describe("getline limits", () => {
    it("should not hang on getline in loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk '{ while((getline line < "/dev/zero") > 0) print line }'`
      );

      // Should either error or be handled safely
      expect(result.exitCode).toBeDefined();
    });
  });
});
