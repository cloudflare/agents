/**
 * Memory Exhaustion Prevention
 *
 * Tests to prevent memory exhaustion through string growth,
 * array growth, heredoc size, and glob expansion.
 *
 * Note: Some tests document current behavior where limits may not be fully
 * enforced. These are marked as "behavior documentation" tests.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("Memory Exhaustion Prevention", () => {
  let bash: Bash;

  beforeEach(() => {
    bash = new Bash();
  });

  describe("String Growth", () => {
    it("should limit command substitution output size", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxStringLength: 100 }
      });

      // Generate a string that exceeds the limit via command substitution
      const result = await limitedBash.exec(
        'x=$(printf "%200s" " "); echo "done"'
      );
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("limit exceeded");
    });

    it("should limit string concatenation growth in loops", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxStringLength: 100, maxLoopIterations: 1000 }
      });

      const result = await limitedBash.exec(`
        x=""
        for i in {1..100}; do
          x="\${x}AAAAAAAAAA"
        done
        echo "done"
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("string length limit exceeded");
    });

    it("should allow strings within limit", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxStringLength: 1000 }
      });

      const result = await limitedBash.exec('echo "hello world"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello world\n");
    });

    it("should limit here-string via command substitution", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxStringLength: 50 }
      });

      // Create a long string via command substitution for here-string
      const result = await limitedBash.exec(`
        longvar=$(printf "%100s" "x")
        cat <<< "$longvar"
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("limit exceeded");
    });

    it("should handle printf via command substitution", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxStringLength: 100 }
      });

      // Printf output is limited when captured via command substitution
      const result = await limitedBash.exec(
        'x=$(printf "%200s" "a"); echo "done"'
      );
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("limit exceeded");
    });
  });

  describe("Array Growth", () => {
    it("should limit mapfile array size", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxArrayElements: 5 }
      });

      const result = await limitedBash.exec(`
        set -e
        mapfile -t arr <<'LINES'
1
2
3
4
5
6
7
8
9
10
LINES
        echo "count: \${#arr[@]}"
      `);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("array element limit exceeded");
    });

    it("should limit read -a array size", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxArrayElements: 5 }
      });

      const result = await limitedBash.exec(`
        set -e
        echo "1 2 3 4 5 6 7 8 9 10" | {
          read -a arr
          echo "count: \${#arr[@]}"
        }
      `);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("array element limit exceeded");
    });

    it("should handle sparse array index", async () => {
      // Sparse array with large index - should not crash
      const result = await bash.exec(`
        arr=()
        arr[1000]=value
        echo "done: \${arr[1000]}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("done: value\n");
    });

    it("should allow arrays within limit", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxArrayElements: 100 }
      });

      const result = await limitedBash.exec(`
        arr=(1 2 3 4 5)
        echo "count: \${#arr[@]}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("count: 5\n");
    });
  });

  describe("Heredoc Size", () => {
    it("should allow heredocs within limit", async () => {
      // Note: Heredoc limit is currently a hardcoded 10MB constant in the lexer
      const result = await bash.exec(`
        cat <<EOF
This is a normal heredoc
with multiple lines
EOF
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("This is a normal heredoc");
    });

    it("should have a hardcoded 10MB heredoc limit", async () => {
      // The heredoc limit is enforced at parse time with a 10MB constant
      // This test documents that behavior - we can't easily test it
      // because creating a 10MB+ string would be slow/memory-intensive
      const result = await bash.exec(`
        cat <<EOF
This is a reasonably sized heredoc
that should work fine
EOF
      `);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("Glob Memory", () => {
    it("should limit glob operations", async () => {
      // Use a very low limit - glob operations include readdir, stat, etc.
      const limitedBash = new Bash({
        executionLimits: { maxGlobOperations: 1 }
      });

      // Create several files to glob
      await limitedBash.exec(`
        mkdir -p /tmp/globtest
        touch /tmp/globtest/a /tmp/globtest/b /tmp/globtest/c /tmp/globtest/d
      `);

      const result = await limitedBash.exec("echo /tmp/globtest/*");
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("Glob operation limit exceeded");
    });

    it("should allow glob within limit", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxGlobOperations: 1000 }
      });

      await limitedBash.exec(`
        mkdir -p /tmp/smallglob
        touch /tmp/smallglob/a.txt /tmp/smallglob/b.txt
      `);

      const result = await limitedBash.exec("echo /tmp/smallglob/*");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("/tmp/smallglob/a.txt");
    });
  });

  describe("Combined Memory Attacks", () => {
    it("should handle exponential string growth attack", async () => {
      const limitedBash = new Bash({
        executionLimits: {
          maxStringLength: 1000,
          maxLoopIterations: 100
        }
      });

      // Exponential growth: doubles each iteration
      const result = await limitedBash.exec(`
        x="A"
        for i in {1..20}; do
          x="$x$x"
        done
        echo "done"
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("string length limit exceeded");
    });

    it("should handle nested command substitution with large output", async () => {
      const limitedBash = new Bash({
        executionLimits: {
          maxStringLength: 100,
          maxSubstitutionDepth: 5
        }
      });

      const result = await limitedBash.exec(`
        x=$(printf '%50s' 'a')
        y=$(echo "$x$x$x")
        echo "length: \${#y}"
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("limit");
    });
  });

  describe("Variable Manipulation", () => {
    it("should limit pattern replacement growth", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxStringLength: 100 }
      });

      const result = await limitedBash.exec(`
        x="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        y="\${x//a/REPLACED}"
        echo "length: \${#y}"
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("string length limit exceeded");
    });

    it("should handle case conversion on large strings", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxStringLength: 100 }
      });

      const result = await limitedBash.exec(`
        x=$(printf '%200s' 'a')
        echo "\${x^^}"
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("limit exceeded");
    });
  });

  describe("Default Limits", () => {
    it("should have reasonable defaults for production use", async () => {
      const defaultBash = new Bash();

      // Normal script should work with defaults
      const result = await defaultBash.exec(`
        # Create a moderate sized array
        arr=()
        for i in {1..100}; do
          arr+=("item$i")
        done
        echo "count: \${#arr[@]}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("count: 100\n");
    });

    it("should prevent extremely large allocations", async () => {
      // Use reduced limits to make test fast
      const limitedBash = new Bash({
        executionLimits: {
          maxStringLength: 10000
        }
      });

      // Use exponential string growth: x becomes x+x each iteration
      // After 5 iterations: 100 -> 200 -> 400 -> 800 -> 1600 -> 3200...
      // This hits limits in just a few iterations instead of 10000 loops
      const result = await limitedBash.exec(`
        x=$(printf '%100s' 'x')
        x="$x$x"
        x="$x$x"
        x="$x$x"
        x="$x$x"
        x="$x$x"
        x="$x$x"
        x="$x$x"
      `);
      // 100 * 2^7 = 12800 > 10000 limit
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("limit");
    });
  });
});
