import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("column", () => {
  describe("table mode (-t)", () => {
    it("formats whitespace-delimited input as table", async () => {
      const bash = new Bash();
      const result = await bash.exec("printf 'a b c\\nd e f\\n' | column -t");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a  b  c\nd  e  f\n");
    });

    it("aligns columns based on maximum width", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'short long\\nlonger x\\n' | column -t"
      );
      expect(result.exitCode).toBe(0);
      // 'longer' is the longest in column 1, 'long' is longest in column 2
      expect(result.stdout).toBe("short   long\nlonger  x\n");
    });

    it("handles varying number of columns per row", async () => {
      const bash = new Bash();
      const result = await bash.exec("printf 'a b c\\nd e\\nf\\n' | column -t");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a  b  c\nd  e\nf\n");
    });

    it("handles file input", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "name age\nalice 30\nbob 25\n"
        }
      });
      const result = await bash.exec("column -t /test.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("name   age\nalice  30\nbob    25\n");
    });
  });

  describe("-s option (input separator)", () => {
    it("uses custom input delimiter", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'a,b,c\\nd,e,f\\n' | column -t -s ','"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a  b  c\nd  e  f\n");
    });

    it("handles colon separator", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'user:1000:home\\nroot:0:root\\n' | column -t -s ':'"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("user  1000  home\nroot  0     root\n");
    });
  });

  describe("-o option (output separator)", () => {
    it("uses custom output delimiter", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'a b c\\nd e f\\n' | column -t -o ' | '"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a | b | c\nd | e | f\n");
    });

    it("uses tab as output separator", async () => {
      const bash = new Bash();
      // Use $'...' to get actual tab character
      const result = await bash.exec(
        "printf 'a b\\nc d\\n' | column -t -o $'\\t'"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a\tb\nc\td\n");
    });
  });

  describe("-n option (no merge)", () => {
    it("preserves empty fields with -n", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'a,,c\\nd,e,f\\n' | column -t -s ',' -n"
      );
      expect(result.exitCode).toBe(0);
      // With -n, empty field between commas is preserved (5 spaces for empty field)
      expect(result.stdout).toBe("a     c\nd  e  f\n");
    });

    it("without -n, consecutive delimiters are merged", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'a,,c\\nd,e,f\\n' | column -t -s ','"
      );
      expect(result.exitCode).toBe(0);
      // Without -n, empty fields are removed
      expect(result.stdout).toBe("a  c\nd  e  f\n");
    });
  });

  describe("fill mode (default)", () => {
    it("arranges items into columns", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'a\\nb\\nc\\nd\\ne\\nf\\n' | column -c 20"
      );
      expect(result.exitCode).toBe(0);
      // Items should be arranged in columns fitting within 20 chars
      expect(result.stdout).toBe("a  b  c  d  e  f\n");
    });

    it("uses default width of 80", async () => {
      const bash = new Bash();
      const result = await bash.exec("printf 'a\\nb\\nc\\n' | column");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a  b  c\n");
    });

    it("handles single column when items are too wide", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'verylongword\\nanother\\n' | column -c 10"
      );
      expect(result.exitCode).toBe(0);
      // Items are too wide for 10 chars, so single column
      expect(result.stdout).toBe("verylongword\nanother\n");
    });
  });

  describe("edge cases", () => {
    it("handles empty input", async () => {
      const bash = new Bash();
      const result = await bash.exec("printf '' | column");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("handles whitespace-only input", async () => {
      const bash = new Bash();
      const result = await bash.exec("printf '   \\n   \\n' | column");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("reads from stdin with dash", async () => {
      const bash = new Bash();
      const result = await bash.exec("printf 'a b\\nc d\\n' | column -t -");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a  b\nc  d\n");
    });

    it("handles multiple files", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "x y\n",
          "/b.txt": "z w\n"
        }
      });
      const result = await bash.exec("column -t /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("x  y\nz  w\n");
    });
  });

  describe("error handling", () => {
    it("errors on unknown flag", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | column -z");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid option");
    });

    it("errors on missing file", async () => {
      const bash = new Bash();
      const result = await bash.exec("column /nonexistent");
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain(
        "no such file or directory"
      );
    });

    it("shows help with --help", async () => {
      const bash = new Bash();
      const result = await bash.exec("column --help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("column");
      expect(result.stdout).toContain("Usage");
    });
  });
});
