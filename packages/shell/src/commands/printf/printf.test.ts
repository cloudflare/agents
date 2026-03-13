import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("printf", () => {
  describe("basic format specifiers", () => {
    it("should format string with %s", async () => {
      const env = new Bash();
      const result = await env.exec('printf "Hello %s" world');
      expect(result.stdout).toBe("Hello world");
      expect(result.exitCode).toBe(0);
    });

    it("should format integer with %d", async () => {
      const env = new Bash();
      const result = await env.exec('printf "Number: %d" 42');
      expect(result.stdout).toBe("Number: 42");
      expect(result.exitCode).toBe(0);
    });

    it("should format float with %f", async () => {
      const env = new Bash();
      const result = await env.exec('printf "Value: %f" 3.14');
      // %f in bash uses 6 decimal places by default
      expect(result.stdout).toBe("Value: 3.140000");
      expect(result.exitCode).toBe(0);
    });

    it("should format hex with %x", async () => {
      const env = new Bash();
      const result = await env.exec('printf "Hex: %x" 255');
      expect(result.stdout).toBe("Hex: ff");
      expect(result.exitCode).toBe(0);
    });

    it("should format octal with %o", async () => {
      const env = new Bash();
      const result = await env.exec('printf "Octal: %o" 8');
      expect(result.stdout).toBe("Octal: 10");
      expect(result.exitCode).toBe(0);
    });

    it("should handle literal %% ", async () => {
      const env = new Bash();
      const result = await env.exec('printf "100%%"');
      expect(result.stdout).toBe("100%");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple arguments", async () => {
      const env = new Bash();
      const result = await env.exec('printf "%s is %d years old" Alice 30');
      expect(result.stdout).toBe("Alice is 30 years old");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("escape sequences", () => {
    it("should handle newline \\n", async () => {
      const env = new Bash();
      const result = await env.exec('printf "line1\\nline2"');
      expect(result.stdout).toBe("line1\nline2");
    });

    it("should handle tab \\t", async () => {
      const env = new Bash();
      const result = await env.exec('printf "col1\\tcol2"');
      expect(result.stdout).toBe("col1\tcol2");
    });

    it("should handle backslash \\\\", async () => {
      const env = new Bash();
      // 8 backslashes in source -> 4 in bash string -> 2 for printf -> 1 literal
      const result = await env.exec('printf "x\\\\\\\\y"');
      expect(result.stdout).toBe("x\\y");
    });

    it("should handle carriage return \\r", async () => {
      const env = new Bash();
      const result = await env.exec('printf "hello\\rworld"');
      expect(result.stdout).toBe("hello\rworld");
    });

    it("should handle octal escape sequences", async () => {
      const env = new Bash();
      const result = await env.exec('printf "\\101\\102\\103"');
      expect(result.stdout).toBe("ABC");
    });

    it("should handle escape character \\e for ANSI codes", async () => {
      const env = new Bash();
      const result = await env.exec('printf "\\e[31mred\\e[0m"');
      expect(result.stdout).toBe("\x1b[31mred\x1b[0m");
    });

    it("should handle \\E as alias for \\e", async () => {
      const env = new Bash();
      const result = await env.exec('printf "\\E[1mbold\\E[0m"');
      expect(result.stdout).toBe("\x1b[1mbold\x1b[0m");
    });

    it("should handle unicode \\u escape", async () => {
      const env = new Bash();
      const result = await env.exec('printf "\\u2764"');
      expect(result.stdout).toBe("❤");
    });

    it("should handle unicode \\U escape for emoji", async () => {
      const env = new Bash();
      const result = await env.exec('printf "\\U1F600"');
      expect(result.stdout).toBe("😀");
    });

    it("should handle hex escape \\x", async () => {
      const env = new Bash();
      const result = await env.exec('printf "\\x41\\x42\\x43"');
      expect(result.stdout).toBe("ABC");
    });
  });

  describe("width and precision", () => {
    it("should handle width specifier", async () => {
      const env = new Bash();
      const result = await env.exec('printf "%10s" "hi"');
      expect(result.stdout).toBe("        hi");
    });

    it("should handle precision for floats", async () => {
      const env = new Bash();
      const result = await env.exec('printf "%.2f" 3.14159');
      expect(result.stdout).toBe("3.14");
    });

    it("should handle zero-padding", async () => {
      const env = new Bash();
      const result = await env.exec('printf "%05d" 42');
      expect(result.stdout).toBe("00042");
    });

    it("should handle left-justify with -", async () => {
      const env = new Bash();
      const result = await env.exec('printf "%-10s|" "hi"');
      expect(result.stdout).toBe("hi        |");
    });
  });

  describe("error handling", () => {
    it("should error with no arguments", async () => {
      const env = new Bash();
      const result = await env.exec("printf");
      expect(result.stderr).toContain("usage");
      // Bash returns exit code 2 for usage errors
      expect(result.exitCode).toBe(2);
    });

    it("should handle missing arguments gracefully", async () => {
      const env = new Bash();
      const result = await env.exec('printf "%s %s" only');
      expect(result.stdout).toBe("only ");
      expect(result.exitCode).toBe(0);
    });

    it("should handle non-numeric for %d", async () => {
      // Bash returns exit 1 with warning and outputs 0
      const env = new Bash();
      const result = await env.exec('printf "%d" notanumber');
      expect(result.stdout).toBe("0");
      expect(result.stderr).toContain("invalid number");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("--help", () => {
    it("should display help", async () => {
      const env = new Bash();
      const result = await env.exec("printf --help");
      expect(result.stdout).toContain("printf");
      expect(result.stdout).toContain("FORMAT");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-v variable name validation", () => {
    it("should accept valid variable names", async () => {
      const env = new Bash();
      const result = await env.exec('printf -v myvar "%s" hello; echo $myvar');
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should accept array subscript with index", async () => {
      const env = new Bash();
      const result = await env.exec(
        "printf -v 'arr[0]' '%s' hello; echo ${arr[0]}"
      );
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should accept array subscript with @", async () => {
      const env = new Bash();
      const result = await env.exec(
        "printf -v 'arr[@]' '%s' hello; echo ${arr[@]}"
      );
      expect(result.exitCode).toBe(0);
    });

    it("should reject invalid variable names with special chars", async () => {
      const env = new Bash();
      const result = await env.exec("printf -v 'x[;rm -rf /]' '%s' hello");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("not a valid identifier");
    });

    it("should reject variable names with path traversal", async () => {
      const env = new Bash();
      const result = await env.exec("printf -v 'x[../../etc]' '%s' hello");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("not a valid identifier");
    });
  });
});
