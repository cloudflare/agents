import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("sed advanced commands", () => {
  describe("N command (append next line)", () => {
    it("appends next line to pattern space (even line count)", async () => {
      const env = new Bash({
        // Use even number of lines so N always has a next line
        files: { "/test.txt": "line1\nline2\nline3\nline4\n" }
      });
      const result = await env.exec("sed 'N;s/\\n/ /' /test.txt");
      expect(result.stdout).toBe("line1 line2\nline3 line4\n");
    });

    it("auto-prints pattern space when N has no next line (odd line count)", async () => {
      const env = new Bash({
        files: { "/test.txt": "line1\nline2\nline3\n" }
      });
      // With 3 lines: N works on 1+2, then N on line3 has no next line
      // GNU sed auto-prints the pattern space before quitting
      const result = await env.exec("sed 'N;s/\\n/ /' /test.txt");
      expect(result.stdout).toBe("line1 line2\nline3\n");
    });

    it("joins pairs of lines", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\nc\nd\n" }
      });
      const result = await env.exec("sed 'N;s/\\n/,/' /test.txt");
      expect(result.stdout).toBe("a,b\nc,d\n");
    });
  });

  describe("y command (transliterate)", () => {
    it("transliterates lowercase to uppercase", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello world\n" }
      });
      const result = await env.exec(
        "sed 'y/abcdefghijklmnopqrstuvwxyz/ABCDEFGHIJKLMNOPQRSTUVWXYZ/' /test.txt"
      );
      expect(result.stdout).toBe("HELLO WORLD\n");
    });

    it("rotates characters", async () => {
      const env = new Bash({
        files: { "/test.txt": "abc\n" }
      });
      const result = await env.exec("sed 'y/abc/bca/' /test.txt");
      expect(result.stdout).toBe("bca\n");
    });

    it("handles escape sequences", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\tb\n" }
      });
      const result = await env.exec("sed 'y/\\t/ /' /test.txt");
      expect(result.stdout).toBe("a b\n");
    });
  });

  describe("= command (print line number)", () => {
    it("prints line numbers", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\nc\n" }
      });
      const result = await env.exec("sed '=' /test.txt");
      expect(result.stdout).toBe("1\na\n2\nb\n3\nc\n");
    });

    it("prints line number for specific address", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\nc\n" }
      });
      const result = await env.exec("sed '2=' /test.txt");
      expect(result.stdout).toBe("a\n2\nb\nc\n");
    });
  });

  describe("branching commands (b, t, :label)", () => {
    it("branch to end of script", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\nworld\n" }
      });
      // Branch unconditionally, skipping the delete command
      const result = await env.exec("sed 'b;d' /test.txt");
      expect(result.stdout).toBe("hello\nworld\n");
    });

    it("branch to label", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\nworld\n" }
      });
      // Branch to skip label, avoiding delete
      const result = await env.exec("sed 'b skip;d;:skip' /test.txt");
      expect(result.stdout).toBe("hello\nworld\n");
    });

    it("conditional branch on substitution", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\nworld\n" }
      });
      // If substitution happens, branch to end
      const result = await env.exec("sed 's/hello/HELLO/;t;d' /test.txt");
      expect(result.stdout).toBe("HELLO\n");
    });

    it("conditional branch to label", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\nworld\n" }
      });
      const result = await env.exec(
        "sed 's/hello/HELLO/;t done;s/world/WORLD/;:done' /test.txt"
      );
      // First line: substitution happens, branch to done (skip second s)
      // Second line: no match on first s, so second s executes
      expect(result.stdout).toBe("HELLO\nWORLD\n");
    });
  });

  describe("-f flag (script file)", () => {
    it("reads script from file", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "hello world\n",
          "/script.sed": "s/hello/HELLO/\ns/world/WORLD/\n"
        }
      });
      const result = await env.exec("sed -f /script.sed /test.txt");
      expect(result.stdout).toBe("HELLO WORLD\n");
    });

    it("ignores comments in script file", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "hello\n",
          "/script.sed": "# This is a comment\ns/hello/HELLO/\n"
        }
      });
      const result = await env.exec("sed -f /script.sed /test.txt");
      expect(result.stdout).toBe("HELLO\n");
    });

    it("combines -f and -e options", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "hello world\n",
          "/script.sed": "s/hello/HELLO/\n"
        }
      });
      const result = await env.exec(
        "sed -f /script.sed -e 's/world/WORLD/' /test.txt"
      );
      expect(result.stdout).toBe("HELLO WORLD\n");
    });

    it("reports error for missing script file", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\n" }
      });
      const result = await env.exec("sed -f /nonexistent.sed /test.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("couldn't open file");
    });
  });
});
