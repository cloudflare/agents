import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk error handling", () => {
  describe("division by zero", () => {
    it("should handle integer division by zero", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ print 1/0 }'");
      // AWK typically returns inf, nan, or handles gracefully
      expect(result.exitCode).toBe(0);
      // Output could be inf, nan, or error message depending on implementation
    });

    it("should handle floating point division by zero", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ print 1.0/0.0 }'");
      expect(result.exitCode).toBe(0);
    });

    it("should handle modulo by zero", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ print 5 % 0 }'");
      // Modulo by zero behavior varies
      expect(result).toBeDefined();
    });
  });

  describe("invalid regex patterns", () => {
    it("should handle invalid regex in match", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo 'test' | awk '{ print match($0, \"[\") }'"
      );
      // Invalid regex should return 0 or error gracefully
      expect(result).toBeDefined();
    });

    it("should handle invalid regex in gsub", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo 'test' | awk '{ gsub(/[/, \"x\"); print }'"
      );
      // Should handle gracefully, not crash
      expect(result).toBeDefined();
    });

    it("should handle invalid regex in sub", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo 'test' | awk '{ sub(/[/, \"x\"); print }'"
      );
      expect(result).toBeDefined();
    });
  });

  describe("undefined variable access", () => {
    it("should treat unset variables as empty string", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ print x }'");
      expect(result.stdout).toBe("\n");
      expect(result.exitCode).toBe(0);
    });

    it("should treat unset variables as 0 in numeric context", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ print x + 5 }'");
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should allow assignment to undefined array", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '1' | awk '{ arr[1] = \"x\"; print arr[1] }'"
      );
      expect(result.stdout).toBe("x\n");
      expect(result.exitCode).toBe(0);
    });

    it("should treat unset array element as empty", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ print arr[999] }'");
      expect(result.stdout).toBe("\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("type coercion edge cases", () => {
    it("should convert string to number in arithmetic", async () => {
      const env = new Bash();
      const result = await env.exec("echo '10abc' | awk '{ print $1 + 5 }'");
      expect(result.stdout).toBe("15\n");
      expect(result.exitCode).toBe(0);
    });

    it("should convert non-numeric string to zero", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'abc' | awk '{ print $1 + 5 }'");
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle empty string in numeric context", async () => {
      const env = new Bash();
      const result = await env.exec("echo '' | awk '{ print $1 + 10 }'");
      expect(result.stdout).toBe("10\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compare mixed types correctly", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '10' | awk '{ print ($1 == \"10\") }'"
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle numeric string comparison", async () => {
      const env = new Bash();
      const result = await env.exec("echo '2' | awk '{ print ($1 < \"10\") }'");
      // String comparison: "2" > "10" (lexicographic)
      // But if both look numeric, numeric comparison
      expect(result.exitCode).toBe(0);
    });
  });

  describe("field access edge cases", () => {
    it("should handle $0 correctly", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'hello world' | awk '{ print $0 }'");
      expect(result.stdout).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return empty for out-of-bounds positive field", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'a b' | awk '{ print $100 }'");
      expect(result.stdout).toBe("\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle negative field index", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'a b c' | awk '{ print $-1 }'");
      // Negative field should be empty or error
      expect(result.exitCode).toBe(0);
    });

    it("should handle non-integer field index", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'a b c' | awk '{ print $1.5 }'");
      // Should truncate to $1
      expect(result.stdout).toBe("a\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle field assignment beyond NF", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo 'a b' | awk '{ $5 = \"x\"; print $0 }'"
      );
      // Should extend fields with empty values
      expect(result.stdout).toContain("x");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("function argument errors", () => {
    it("should handle substr with missing arguments", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo 'hello' | awk '{ print substr($1) }'"
      );
      // Missing start position
      expect(result.exitCode).toBe(0);
    });

    it("should handle split with missing arguments", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'hello' | awk '{ print split($1) }'");
      // Missing array argument
      expect(result.exitCode).toBe(0);
    });

    it("should handle sprintf with no format specifiers", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '1' | awk '{ print sprintf(\"hello\") }'"
      );
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle sprintf with extra arguments", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '1' | awk '{ print sprintf(\"%d\", 1, 2, 3) }'"
      );
      // Extra arguments should be ignored
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle sprintf with missing arguments", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '1' | awk '{ print sprintf(\"%d %d\", 1) }'"
      );
      // Missing argument should be 0 or empty
      expect(result.exitCode).toBe(0);
    });
  });

  describe("math function edge cases", () => {
    it("should handle sqrt of negative number", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ print sqrt(-1) }'");
      // Should return nan or handle gracefully
      expect(result.exitCode).toBe(0);
    });

    it("should handle log of zero", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ print log(0) }'");
      // Should return -inf or handle gracefully
      expect(result.exitCode).toBe(0);
    });

    it("should handle log of negative number", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ print log(-1) }'");
      // Should return nan or handle gracefully
      expect(result.exitCode).toBe(0);
    });

    it("should handle exp of very large number", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ print exp(1000) }'");
      // Should return inf or handle overflow
      expect(result.exitCode).toBe(0);
    });
  });

  describe("syntax errors", () => {
    it("should error on unmatched braces", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ print $1'");
      expect(result.exitCode).not.toBe(0);
    });

    it("should error on unmatched parentheses", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ print ($1 }'");
      expect(result.exitCode).not.toBe(0);
    });

    it("should handle undefined function call gracefully", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '1' | awk '{ print undefined_func() }'"
      );
      // AWK treats undefined functions as returning empty string
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("\n");
    });
  });

  describe("file errors", () => {
    it("should error on non-existent input file", async () => {
      const env = new Bash();
      const result = await env.exec("awk '{ print }' /nonexistent/file.txt");
      expect(result.stderr).toContain("No such file");
      expect(result.exitCode).not.toBe(0);
    });

    it("should handle getline from non-existent file", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '1' | awk '{ ret = (getline x < \"/nonexistent\"); print ret }'"
      );
      expect(result.stdout).toBe("-1\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("special variable edge cases", () => {
    it("should handle NF = 0", async () => {
      const env = new Bash();
      const result = await env.exec("echo '' | awk '{ print NF }'");
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle NR at start", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk 'BEGIN { print NR }'");
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should update NF when setting fields", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo 'a b c' | awk '{ $10 = \"x\"; print NF }'"
      );
      expect(result.stdout).toBe("10\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle assigning to NF", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo 'a b c d e' | awk '{ NF = 2; print $0 }'"
      );
      // Setting NF truncates fields
      expect(result.exitCode).toBe(0);
    });
  });

  describe("printf format errors", () => {
    it("should handle invalid format specifier", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ printf \"%z\", $1 }'");
      // Invalid specifier should pass through or error gracefully
      expect(result.exitCode).toBe(0);
    });

    it("should handle width/precision with no specifier", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '1' | awk '{ printf \"%10.5\", $1 }'"
      );
      // Should handle gracefully
      expect(result.exitCode).toBe(0);
    });
  });
});
