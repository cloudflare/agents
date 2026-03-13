/**
 * Tests for security limits to prevent resource exhaustion attacks.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "./Shell";

describe("Security Limits", () => {
  let bash: Bash;

  beforeEach(() => {
    bash = new Bash();
  });

  describe("maxStringLength limit", () => {
    it("should enforce string length limit on command substitution", async () => {
      // Create a bash env with a very low string length limit
      const limitedBash = new Bash({
        executionLimits: { maxStringLength: 100 }
      });

      // Generate a string that exceeds the limit
      const result = await limitedBash.exec(
        'x=$(printf "%200s" " "); echo "done"'
      );
      expect(result.exitCode).toBe(126); // ExecutionLimitError exit code
      expect(result.stderr).toContain("limit exceeded");
    });

    it("should allow strings within the limit", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxStringLength: 1000 }
      });

      const result = await limitedBash.exec('echo "hello world"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello world\n");
    });
  });

  describe("maxArrayElements limit", () => {
    it("should enforce array element limit on mapfile", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxArrayElements: 5 }
      });

      // Try to read more lines than allowed using a heredoc
      // Use set -e to exit on first failure
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
LINES
echo "count: \${#arr[@]}"
      `);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("array element limit exceeded");
    });

    it("should allow arrays within the limit", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxArrayElements: 10 }
      });

      const result = await limitedBash.exec(`
mapfile -t arr <<'LINES'
1
2
3
LINES
echo "count: \${#arr[@]}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("count: 3");
    });
  });

  describe("maxSubstitutionDepth limit", () => {
    it("should enforce command substitution nesting limit", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxSubstitutionDepth: 3 }
      });

      // Create deeply nested command substitution
      const result = await limitedBash.exec(
        "echo $(echo $(echo $(echo $(echo too-deep))))"
      );
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain(
        "Command substitution nesting limit exceeded"
      );
    });

    it("should allow substitution within the limit", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxSubstitutionDepth: 5 }
      });

      const result = await limitedBash.exec("echo $(echo $(echo hello))");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\n");
    });
  });

  describe("maxGlobOperations limit", () => {
    it("should enforce glob operation limit", async () => {
      // A simple glob like /dir/* requires ~2 operations (entry + readdir)
      // Use limit of 1 to trigger failure on readdir
      const limitedBash = new Bash({
        executionLimits: { maxGlobOperations: 1 }
      });

      // Create some files to glob
      await limitedBash.exec(`
        mkdir -p /tmp/globtest
        touch /tmp/globtest/a /tmp/globtest/b /tmp/globtest/c
      `);

      // Try to glob - this should exceed the low limit on readdir
      const result = await limitedBash.exec("echo /tmp/globtest/*");
      expect(result.exitCode).toBe(126); // ExecutionLimitError exit code
      expect(result.stderr).toContain("Glob operation limit exceeded");
    });

    it("should allow glob operations within the limit", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxGlobOperations: 1000 }
      });

      // Create some files to glob
      await limitedBash.exec(`
        mkdir -p /tmp/globtest2
        touch /tmp/globtest2/a /tmp/globtest2/b /tmp/globtest2/c
      `);

      // Glob should work fine with reasonable limit
      const result = await limitedBash.exec("echo /tmp/globtest2/*");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("/tmp/globtest2/a");
    });
  });

  describe("heredoc size limit", () => {
    it("should allow normal heredocs", async () => {
      const result = await bash.exec(`
        cat <<EOF
        This is a normal heredoc
        with multiple lines
        EOF
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("This is a normal heredoc");
    });
  });

  describe("null byte validation in filesystem", () => {
    it("should reject paths with null bytes", async () => {
      const result = await bash.exec('cat "/etc\\x00/passwd"');
      expect(result.exitCode).not.toBe(0);
    });
  });
});
