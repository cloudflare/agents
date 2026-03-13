/**
 * Output Size Limits
 *
 * Tests that AWK, sed, jq, and printf respect maxStringLength
 * to prevent memory exhaustion from large outputs.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";
import { ExecutionLimitError } from "../../interpreter/errors";

describe("Output Size Limits", () => {
  // Use a small maxStringLength to make tests fast
  const maxStringLength = 100;

  function createBash(): Bash {
    return new Bash({ executionLimits: { maxStringLength } });
  }

  describe("AWK output limits", () => {
    it("should limit output from print in loop", async () => {
      const bash = createBash();
      const result = await bash.exec(
        `echo "test" | awk 'BEGIN { for(i=0; i<100; i++) print "AAAAAAAAAA" }'`
      );

      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
      expect(result.stderr).toContain("limit exceeded");
    });

    it("should limit string concatenation growth", async () => {
      const bash = createBash();
      const result = await bash.exec(
        `echo "test" | awk 'BEGIN { s="x"; for(i=0; i<20; i++) s=s s; print s }'`
      );

      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
      expect(result.stderr).toContain("exceeded");
    });

    it("should cap sprintf width to prevent memory bombs", async () => {
      const bash = createBash();
      const result = await bash.exec(
        `echo "test" | awk 'BEGIN { printf "%100000s", "x" }'`
      );

      // Width is capped to 10000 so output is ~10000 chars, which exceeds our 100 byte limit
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
      expect(result.stderr).toContain("limit exceeded");
    });
  });

  describe("Sed output limits", () => {
    it("should limit output from sed processing many lines", async () => {
      const bash = createBash();
      // Generate input directly via stdin using echo and pipe
      const result = await bash.exec(
        `echo '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20' | sed 's/.*/AAAAAAAAAA/'`
      );

      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
      expect(result.stderr).toContain("limit exceeded");
    });
  });

  describe("Jq output limits", () => {
    it("should limit jq output for large arrays", async () => {
      const bash = createBash();
      // Create a JSON array with many elements
      const result = await bash.exec(
        `echo '[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]' | jq '[.[] | . * 1000000]'`
      );

      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
      expect(result.stderr).toContain("limit exceeded");
    });
  });

  describe("Printf output limits", () => {
    it("should limit printf output with large width", async () => {
      const bash = createBash();
      const result = await bash.exec(`printf '%200s' "x"`);

      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
      expect(result.stderr).toContain("limit exceeded");
    });
  });
});
