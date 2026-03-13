import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";
import { ExecutionLimitError } from "../../interpreter/errors";

/**
 * JQ Execution Limits Tests
 *
 * These tests verify that jq commands cannot cause runaway compute.
 * JQ programs should complete in bounded time regardless of input.
 *
 * IMPORTANT: All tests should complete quickly (<1s each).
 */

describe("JQ Execution Limits", () => {
  describe("until loop protection", () => {
    it("should protect against infinite until loop", async () => {
      const env = new Bash();
      // until condition that never becomes true
      const result = await env.exec(`echo 'null' | jq 'until(false; .)'`);

      expect(result.stderr).toContain("too many iterations");
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    });

    it("should allow until that terminates", async () => {
      const env = new Bash();
      const result = await env.exec(`echo '0' | jq 'until(. >= 5; . + 1)'`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("5");
    });
  });

  describe("while loop protection", () => {
    it("should protect against infinite while loop", async () => {
      const env = new Bash();
      // while condition that's always true
      const result = await env.exec(`echo '0' | jq '[while(true; . + 1)]'`);

      expect(result.stderr).toContain("too many iterations");
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    });

    it("should allow while that terminates", async () => {
      const env = new Bash();
      const result = await env.exec(`echo '1' | jq '[while(. < 5; . + 1)]'`);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([1, 2, 3, 4]);
    });
  });

  describe("repeat protection", () => {
    it("should protect against infinite repeat", async () => {
      const env = new Bash();
      // repeat with identity produces infinite stream
      const result = await env.exec(
        `echo '1' | jq '[limit(100000; repeat(.))]'`
      );

      expect(result.stderr).toContain("too many iterations");
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    });

    it("should allow repeat that terminates naturally", async () => {
      const env = new Bash();
      // repeat with update that eventually returns empty stops
      const result = await env.exec(
        `echo '5' | jq -c '[limit(10; repeat(if . > 0 then . - 1 else empty end))]'`
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("[5,4,3,2,1,0]");
    });
  });

  describe("recurse protection", () => {
    it("should handle deep recursion with limit", async () => {
      const env = new Bash();
      // recurse that doesn't naturally terminate
      const result = await env.exec(
        `echo '{"a":{"a":{"a":{"a":{}}}}}' | jq '[limit(10; recurse(.a?))]'`
      );

      expect(result.exitCode).toBe(0);
    });
  });

  describe("range limits", () => {
    it("should handle large range with limit", async () => {
      const env = new Bash();
      const result = await env.exec(`jq -n '[limit(5; range(1000000))]'`);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([0, 1, 2, 3, 4]);
    });

    it("should cap range output to prevent memory exhaustion", async () => {
      const env = new Bash();
      // range(2000000) exceeds the 1M default cap
      const result = await env.exec(`jq -n '[range(2000000)] | length'`);

      expect(result.exitCode).toBe(0);
      // Should be capped at maxIterations * 100 (default 10000 * 100 = 1M)
      expect(Number(result.stdout.trim())).toBeLessThanOrEqual(1_000_000);
    });

    it("should cap range with start;end form", async () => {
      const env = new Bash();
      const result = await env.exec(`jq -n '[range(0; 2000000)] | length'`);

      expect(result.exitCode).toBe(0);
      expect(Number(result.stdout.trim())).toBeLessThanOrEqual(1_000_000);
    });

    it("should cap range with start;end;step form", async () => {
      const env = new Bash();
      const result = await env.exec(`jq -n '[range(0; 2000000; 1)] | length'`);

      expect(result.exitCode).toBe(0);
      expect(Number(result.stdout.trim())).toBeLessThanOrEqual(1_000_000);
    });

    it("should allow moderate ranges", async () => {
      const env = new Bash();
      // 50K elements should be fine (well under 1M)
      const result = await env.exec(`jq -n '[range(50000)] | length'`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("50000");
    });
  });
});
